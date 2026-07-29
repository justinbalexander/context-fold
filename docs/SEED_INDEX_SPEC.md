# Seed index — shared spec (v1)

The seed index is the deterministic, lexical bridge back into a session's full
history after context has been folded, compacted, or the session has ended.

It is written as a **spec, not an internal detail**, so that other emitters
(another harness's built-in compaction, a session-log indexer) can produce the
same shape and the same recovery tooling — `/recall`-style reconstruction
skills, journal synthesis — can read all of them. This document is the contract;
`src/core/index/seed-index.ts` is one implementation of it.

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

- `seq` — the fold event's sequence number (monotonic per session; for the Pi
  extension it is the frozen-layer seq). The file is append-only and never
  rewritten, so a consumer resolving a seq that appears more than once takes the
  latest record for it.
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
- `spans` — the recovery pointers. Each names the durable artifact holding the
  folded content, and the extent of that content. `log.path` is the emitter's
  ground-truth store for the span; `code` is the in-context recall handle when
  the emitter has one.

  How to read a span depends on what the emitter's store is, so consumers must
  look at the artifact rather than assume a byte range into a flat file. For
  this extension `log.path` is a **spool envelope**: a JSON object at
  `<spoolDir>/<code>.json` whose `content` field holds the folded text, with
  `sha256` over that text. `byteStart`/`byteEnd` are offsets **within the
  decoded `content` string** (so `byteStart` is 0 and `byteEnd` is the content's
  byte length), *not* offsets into the `.json` file — parse the envelope, then
  slice. Another emitter might point at a plain session log, where the offsets
  would address the file directly.

  One envelope shape needs special handling: when two folded blocks had
  byte-identical content, the second is written as an **alias** — `content` is
  `""` and an `aliasOf` field names the code whose envelope holds the bytes.
  A consumer that finds `aliasOf` follows exactly one hop to
  `<spoolDir>/<aliasOf>.json` and reads `content` there. Aliases never chain.

## Consumption contract

- A `/recall`-style skill treats the union of records as the session's index:
  grep the `identifiers`/`errors`/`files` fields to choose spans, then pull
  **whole spans** (or scripted scans over them), not one pointer at a time.
- Journal synthesis may read all fields but must treat any narrative it adds
  as its own; the index itself is ground truth extracted verbatim.
- Records are advisory for context reconstruction — consumers verify claims
  against the artifacts (`log.path`) before relying on them.
