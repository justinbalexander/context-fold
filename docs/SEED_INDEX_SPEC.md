# Seed index format (v1)

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
  measured failure mode), so every record carries offsets into durable
  on-disk artifacts.

## Transport

One JSONL file per session, append-only: one record per fold event (plus one
final record at hard compaction), at
`<sessionDir>/spool/<sessionId>/seed-index.jsonl`. Readers must tolerate
unknown extra fields and records with a higher `v` they do not understand.

A spool directory is not exclusively envelopes. Resolve artifacts by the paths
records actually name (`log.path`, and one `aliasOf` hop) rather than by
enumerating the directory, because context-fold keeps bookkeeping files
alongside the data: `.alive` is a liveness heartbeat its garbage collector
reads. Readers should ignore anything they do not recognize.

## Record shape

```json
{
  "v": 1,
  "kind": "fold-index",
  "harness": "pi-context-fold",
  "session": "<session id>",
  "seq": 3,
  "at": "2026-07-28T21:14:03.000Z",
  "trigger": "threshold | cap | compact",
  "usage": { "tokens": 91000, "contextWindow": 200000, "fraction": 0.455 },

  "files": ["src/adapters/pi/store.ts", "tests/ladder.test.ts"],
  "commands": ["npx vitest run tests/ladder.test.ts", "git diff --stat"],
  "errors": ["FAIL tests/ladder.test.ts > step advance", "npm ERR! code ELIFECYCLE"],
  "identifiers": ["RECALL_SLICE_TOKEN_CAP", "0x811c9dc5", "e2c70f2e"],
  "userMessages": [
    { "turn": 1, "firstLine": "rebuild the fold ladder with discrete events" }
  ],

  "spans": [
    {
      "blockId": "r:call_abc123",
      "code": "k3f9a2",
      "tool": "bash",
      "turn": 7,
      "log": { "path": "/…/spool/<sid>/k3f9a2.json", "byteStart": 0, "byteEnd": 48211, "lines": 1204 },
      "fullOutputPath": "/…/tool-output/call_abc123.txt"
    }
  ]
}
```

Field semantics:

- `seq`: the fold event's sequence number, monotonic per session (the
  frozen-layer seq). The file is append-only and never rewritten, so a reader
  resolving a seq that appears more than once takes the latest record for it.
  A line of the form `{ "v": 1, "kind": "fold-retract", "seq": 3, "at": "…" }`
  voids the `fold-index` records with that seq appended before it (a compaction
  that failed after its record was emitted); a record appended after the
  retraction may reuse the seq and stands on its own.
- `trigger`: why this fold fired.
- `files`: every path the folded span touched: tool inputs (read/edit/write
  targets) and path-shaped tokens inside outputs. Repo-relative when
  resolvable, absolute otherwise. Deduplicated, insertion order.
- `commands`: commands executed in the folded span (tool inputs of
  shell-class tools), verbatim, deduplicated.
- `errors`: error lines detected in folded output by the error lexicon,
  which covers lowercase `failed`/`failure`, `fatal`, `npm ERR!`,
  `Segmentation fault`, `Permission denied`, `✗`, tracebacks, and
  `error`-class markers. Verbatim lines, clipped ≤ 240 chars, deduplicated.
- `identifiers`: exact identifiers and numbers harvested from the folded
  blocks that recovery grep needs to lexically match: symbol-like tokens,
  hex/uuid-like tokens, dotted versions, sizeable numbers. Extraction biases
  toward tokens from *large tool outputs* (the summary-boundary-loss class),
  capped at 64 per record favoring rarer/longer tokens.
- `userMessages`: first line (≤ 200 chars) of each user message in the
  folded span, with turn number. User intent is never folded away silently.
- `spans`: the recovery pointers. Each names the durable artifact holding the
  folded content, and the extent of that content. `log.path` is the
  ground-truth store for the span, and `code` is the in-context recall handle.

  A span is not a byte range into a flat file: `log.path` is a spool
  envelope, a JSON object at
  `<spoolDir>/<code>.json` whose `content` field holds the folded text, with
  `sha256` over that text. `byteStart`/`byteEnd` are offsets within the
  decoded `content` string (so `byteStart` is 0 and `byteEnd` is the content's
  byte length) rather than offsets into the `.json` file, so parse the envelope,
  then slice.

  One envelope shape needs special handling: when two folded blocks had
  byte-identical content, the second is written as an alias: `content` is
  `""` and an `aliasOf` field names the code whose envelope holds the bytes.
  A reader that finds `aliasOf` follows exactly one hop to
  `<spoolDir>/<aliasOf>.json` and reads `content` there. Aliases never chain.

## Consumption contract

- A recall reader treats the union of records as the session's index: grep
  the `identifiers`/`errors`/`files` fields to choose spans, then pull whole
  spans (or scripted scans over them) rather than one pointer at a time.
- The index is ground truth extracted verbatim; any narrative a reader layers
  on top of it is the reader's own.
- Records are advisory for context reconstruction, so readers verify claims
  against the artifacts (`log.path`) before relying on them.
