# 0002: Pi's session ledger is the durability floor; the spool is removed

Date: 2026-08-31
Status: accepted

## Context

Since 0.1.0 every committed fold wrote the masked block's raw payload to a per-session spool of
sha256-verified envelopes, and recall read from that spool after hard compaction removed the raw
message from live history. The spool brought a retinue: atomic writes, dedup aliasing, envelope
revalidation on resume, retention GC with a liveness heartbeat, and two documented known issues
(the GC race against a quiet-but-live session, and the recall cliff when the retention window
aged a spool out).

A paid prototype settled the question the spool answered by assumption: raw tool results survive
hard compaction, resume, and re-compaction in `sessionManager.getEntries()`. Pi's own contract
states it outright: the session is append-only, and entries cannot be modified or deleted. The
spool therefore duplicated Pi's ledger byte for byte.

## Decision

Recall's durability floor is Pi's session ledger, reached through `getEntries()`. A fold records
metadata only: the block's durable id, its fold code, its byte extent, and a sha256 of the block
text at fold time. Recall re-locates the block by re-linearizing the ledger's message entries
with the same durable-id formula and verifies the text against the recorded sha. The spool, its
retention GC, the heartbeat, the `CONTEXTFOLD_SPOOL_RETAIN_DAYS` knob, and dedup aliasing are
deleted. Legacy sessions get a clean break: old `spool`/`gate` records degrade to unverified
ledger reads where the block is present, and report unavailable where it is not; old spool files
are inert bytes.

Cross-session handoff is path-only. Pi's lineage does not carry entries into a child session
(`getEntries()` never traverses `parentSession`), so a handoff seed names the parent session file
in its header and codes in the seed are provenance, not live handles.

## Consequences

Easier: the commit precondition shrinks to two appends (fold record, index record); both spool-GC
known issues disappear rather than being mitigated; the extension writes kilobytes of append-only
text instead of a second copy of every large tool result; the seed index and handoff seeds move
to `<sessionDir>/context-fold/<sessionId>/` with the same retention posture as Pi's own session
files. Harder: recall now depends on Pi honoring its append-only contract and on durable-id
recomputation staying in lockstep with `blockId` (DESIGN.md §8 invariant 1); a sha mismatch or a
missing block is a typed error rather than a file to inspect. Supersedes the spool-backed
recovery design described in DESIGN.md §5 before this change; SEED_INDEX_SPEC bumps to v2.
