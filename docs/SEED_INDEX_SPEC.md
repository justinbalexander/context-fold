# Seed index format (v3)

The seed index is the deterministic, lexical bridge back into a session's full
history after context has been folded, compacted, or the session has ended.

This document is the contract for the records context-fold writes and reads;
`src/core/index/seed-index.ts` implements the extraction. Recovery tooling
outside the extension may read the file too, so the shape is documented
precisely rather than treated as an internal detail.

Design constraints it answers:

- Grep requires lexical match (NoLiMa). Recovery tooling can only find what is
  indexed verbatim, so extraction is deterministic only, with no model calls
  and no paraphrase.
- The classes every summarization arm measurably drops must be first-class:
  exact identifiers/numbers that appear only inside large tool output
  (summary-boundary loss), and error strings including the lowercase forms
  (`failed`, `npm ERR!`, `fatal`, `Segmentation fault`, `Permission denied`).
- Recall must work in spans rather than per-pointer paging (recall churn is the
  measured failure mode), so every record carries recovery pointers into the
  durable ground truth.

## Ground truth

The full content behind a span lives in the Pi session file itself, an
append-only JSONL whose entries are never modified or deleted. A reader
recovers a span's content by finding the session entry whose message carries
the span's anchor (`r:<toolCallId>` names a `toolResult` message's
`toolCallId`; `a:<responseId>:p<n>` names part *n* of the assistant message
with that `responseId`) and verifying the text against the span's `sha256`.
The index itself carries only metadata.

## Transport

One JSONL file per session, append-only: one record per fold event (plus one
final record at hard compaction), at
`<sessionDir>/context-fold/<sessionId>/seed-index.jsonl`. Handoff seeds are
written beside it. Readers must tolerate unknown extra fields and records with
a higher `v` they do not understand.

## Record shape

```json
{
  "v": 3,
  "kind": "fold-index",
  "harness": "pi-context-fold",
  "session": "<session id>",
  "seq": 3,
  "at": "2026-07-28T21:14:03.000Z",
  "trigger": "threshold | cap | compact",
  "usage": { "tokens": 91000, "contextWindow": 200000, "fraction": 0.455 },

  "files": ["src/adapters/pi/store.ts", "tests/ladder.test.ts"],
  "commands": [
    { "command": "npx vitest run tests/ladder.test.ts", "turn": 7, "code": "k3f9a2b7" }
  ],
  "errors": [
    { "line": "npm ERR! code ELIFECYCLE", "context": "npm ERR! Test failed.", "turn": 7, "code": "k3f9a2b7", "toolError": true },
    { "line": "12 passed, 3 failed", "turn": 7, "code": "9x2m71c3" }
  ],
  "identifiers": ["RECALL_SLICE_TOKEN_CAP", "0x811c9dc5", "e2c70f2e"],
  "userMessages": [
    { "turn": 1, "firstLine": "rebuild the fold ladder with discrete events" }
  ],

  "spans": [
    {
      "blockId": "r:call_abc123",
      "code": "k3f9a2b7",
      "tool": "bash",
      "turn": 7,
      "log": { "bytes": 48211, "lines": 1204 },
      "sha256": "…64 hex chars over the block text…",
      "fullOutputPath": "/…/tool-output/call_abc123.txt"
    }
  ]
}
```

Field semantics:

- `seq`: the fold event's sequence number, monotonic per session (the
  frozen-layer seq). The file is append-only and never rewritten, so a reader
  resolving a seq that appears more than once takes the latest record for it.
  A line of the form `{ "v": 2, "kind": "fold-retract", "seq": 3, "at": "…" }`
  voids the `fold-index` records with that seq appended before it (a compaction
  that failed after its record was emitted); a record appended after the
  retraction may reuse the seq and stands on its own.
- `trigger`: why this fold fired.
- `files`: every path the folded span touched: tool inputs (read/edit/write
  targets) and path-shaped tokens inside outputs. Repo-relative when
  resolvable, absolute otherwise. Deduplicated, insertion order.
- `commands`: commands executed in the folded span (tool inputs of
  shell-class tools), verbatim, deduplicated by the stored command text. Each entry
  is an `IndexedCommand`: `command` is the command text, `turn` is the turn of the
  paired result block (or of the call when it has none), and `code` is the paired
  result block's fold code when a result block is present. The command is stored
  whole, hard-capped at 8000 chars to bound pathological inputs (a pasted file).
  Rendering into the deterministic summary clips the first non-empty line to 200
  chars and appends a `… (+N lines, +M chars)` marker when content was dropped, so a
  clipped command is distinguishable from a complete one.
- `errors`: error lines detected in folded output by the error lexicon,
  which covers lowercase `failed`/`failure`, `fatal`, `npm ERR!`,
  `Segmentation fault`, `Permission denied`, `✗`, tracebacks, and
  `error`-class markers. Each entry is an `ErrorLine`: `line` is the verbatim
  marker line, clipped ≤ 240 chars; `context` is the following non-empty line,
  trimmed and clipped ≤ 240 chars, when one exists (the cause usually follows
  the marker); `turn` is the source block's turn; `code` is the source block's
  fold code; and `toolError: true` marks a line from a `tool_result` block that
  carried pi's `isError` flag. Lines from tool-flagged blocks are emitted first,
  so a failure the tool itself reported wins a capped slot over a line that
  merely mentions an error word. Entries are deduplicated by `line`; the
  first sighting wins, so provenance and context come from the earliest
  occurrence.
- `identifiers`: exact identifiers and numbers harvested from the folded
  blocks that recovery grep needs to lexically match: symbol-like tokens,
  hex/uuid-like tokens, dotted versions, sizeable numbers. Extraction biases
  toward tokens from *large tool outputs* (the summary-boundary-loss class),
  capped at 64 per record favoring rarer/longer tokens.
- `userMessages`: first line (≤ 200 chars) of each user message in the
  folded span, with turn number. User intent is never folded away silently.
- `spans`: the recovery pointers. Each names a folded block by its durable
  `blockId` (the anchor into the session ledger; see Ground truth), its
  in-context recall handle `code`, and the extent of its content: `log.bytes`
  is the UTF-8 byte length of the block text and `log.lines` its line count.
  `sha256` is the hex sha256 of the block text at fold time; a reader verifies
  the re-located ledger text against it before trusting the bytes. A span
  restored from a pre-v2 record may lack `sha256`, in which case the content
  is served unverified. `fullOutputPath`, when present, names the tool's own
  full-output file (e.g. a truncated bash result), which holds *more* than the
  block text.

## Changes from v2

- The record is `v: 3`.
- `errors` and `commands` are arrays of provenance objects, not bare strings.
  `errors: ErrorLine[]` carries `line`, optional `context`, `turn`, optional
  `code`, and optional `toolError`; `commands: IndexedCommand[]` carries
  `command`, `turn`, and optional `code`.
- Error extraction emits lines from tool-flagged (`isError`) result blocks
  first, and captures the following non-empty line as `context`.
- Commands are stored whole (hard cap 8000) and clipped only when rendered into
  the deterministic summary. A `… (+N lines, +M chars)` marker follows a clipped
  command.
- v2 records remain valid input: renderers normalize bare-string `errors` and
  `commands` entries, and the tolerance rules above are unchanged.

## Changes from v1

v1 spans carried `log.path`/`log.byteStart`/`log.byteEnd` addressing a
per-session spool of sha256-verified content envelopes. The spool duplicated
Pi's append-only ledger byte for byte and is removed; spans now anchor into
the session file directly, `log` keeps `bytes` and `lines`, and the envelope's
sha moved onto the span as `sha256`. The file also moved from
`<sessionDir>/spool/<sessionId>/` to `<sessionDir>/context-fold/<sessionId>/`.
Readers of old sessions may still encounter v1 records and spool files; the
records remain readable under the tolerance rules above, and the spool files
are inert.

## Consumption contract

- A recall reader treats the union of records as the session's index: grep
  the `identifiers`/`errors`/`files` fields to choose spans, then pull whole
  spans (or scripted scans over them) rather than one pointer at a time.
- The index is ground truth extracted verbatim; any narrative a reader layers
  on top of it is the reader's own.
- Records are advisory for context reconstruction, so readers verify claims
  against the session ledger (via `blockId` and `sha256`) before relying on
  them.
