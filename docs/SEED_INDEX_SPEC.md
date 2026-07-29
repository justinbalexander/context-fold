# Seed index — shared spec (v1)

The seed index is the deterministic, lexical bridge back into a session's full
history after context has been folded, compacted, or the session has ended. It
is a **spec shared across harnesses** (Evoker's engine-owned substrate and the
context-fold Pi extension emit the same shape), consumed by `/recall`-style
reconstruction skills and journal synthesis — not an internal detail of any
one implementation.

Design constraints it answers:

- Grep requires lexical match (NoLiMa): recovery tooling can only find what is
  indexed verbatim, so extraction is **deterministic only** — no model calls,
  no paraphrase.
- The classes every summarization arm measurably drops must be first-class:
  exact identifiers/numbers that appear only inside large tool output
  (summary-boundary loss), and error strings including the lowercase forms
  (`failed`, `npm ERR!`, `fatal`, `Segmentation fault`, `Permission denied`).
- Recall must work in **spans**, not per-pointer paging (recall churn is the
  measured failure mode), so every record carries offsets into durable
  on-disk artifacts.

## Transport

One JSONL file per session, append-only: one record per fold event (plus one
final record at hard compaction / session end when the emitter supports it).
Location is emitter-owned; the Pi extension writes
`<sessionDir>/spool/<sessionId>/seed-index.jsonl`. Consumers must tolerate
unknown extra fields and records with a higher `v` they do not understand.

## Record shape

```json
{
  "v": 1,
  "kind": "fold-index",
  "harness": "pi-context-fold",
  "session": "<session id>",
  "seq": 3,
  "at": "2026-07-28T21:14:03.000Z",
  "trigger": "threshold | consolidation | cap | compact",
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

- `seq` — the fold event's sequence number (monotonic per session; for the Pi
  extension it is the frozen-layer seq). A consolidation record replaces the
  merged records' seqs going forward but earlier records are never rewritten
  (append-only file; latest record per seq wins).
- `trigger` — why this fold fired.
- `files` — every path the folded span touched: tool inputs (read/edit/write
  targets) and path-shaped tokens inside outputs. Repo-relative when the
  emitter can resolve it, absolute otherwise. Deduplicated, insertion order.
- `commands` — commands executed in the folded span (tool inputs of
  shell-class tools), verbatim, deduplicated.
- `errors` — error lines detected in folded output by the shared lexicon.
  The lexicon MUST cover lowercase `failed`/`failure`, `fatal`, `npm ERR!`,
  `Segmentation fault`, `Permission denied`, `✗`, tracebacks, and
  `error`-class markers. Verbatim lines, clipped ≤ 240 chars, deduplicated.
- `identifiers` — exact identifiers and numbers harvested from the folded
  blocks that recovery grep needs to lexically match: symbol-like tokens,
  hex/uuid-like tokens, dotted versions, sizeable numbers. Emitters SHOULD
  bias toward tokens from *large tool outputs* (the summary-boundary-loss
  class) and cap per record (Pi: ≤ 64) favoring rarer/longer tokens.
- `userMessages` — first line (≤ 200 chars) of each user message in the
  folded span, with turn number. User intent is never folded away silently.
- `spans` — the recovery pointers. Each names the durable artifact holding
  the folded content and byte/line extent inside it. `log.path` is the
  emitter's ground-truth store for that span (Evoker: the session log;
  Pi extension: the sha256-verified spool envelope's content file — offsets
  address the raw content, not the JSON envelope). `code` is the in-context
  recall handle when the emitter has one.

## Consumption contract

- A `/recall`-style skill treats the union of records as the session's index:
  grep the `identifiers`/`errors`/`files` fields to choose spans, then pull
  **whole spans** (or scripted scans over them), not one pointer at a time.
- Journal synthesis may read all fields but must treat any narrative it adds
  as its own; the index itself is ground truth extracted verbatim.
- Records are advisory for context reconstruction — consumers verify claims
  against the artifacts (`log.path`) before relying on them.
