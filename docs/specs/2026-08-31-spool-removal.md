# spool-removal

Date: 2026-08-31   Status: done

## Problem

The S4 prototype (pi-api-review-followups, Open questions) proved the spool redundant as a
durability floor: raw tool results survive hard compaction, resume, and re-compaction in
`sessionManager.getEntries()`, and Pi's own docstring states the contract outright ("The session
is append-only... Entries cannot be modified or deleted"). The spool therefore duplicates Pi's
ledger byte for byte, and everything built around that duplication — sha envelopes, per-session
directories, retention GC, the `.alive` heartbeat, dedup aliasing — is carrying cost for a
guarantee Pi already gives us. It also carries two documented known issues (the GC race against
quiet-but-live sessions, and the 24-hour recall cliff) that deletion removes outright.

This is a redesign of frozen-invariant machinery (DESIGN.md §5, §8), not a trim: the spool is
today's commit precondition and recovery route. This spec replaces that route with a
ledger-backed one and then deletes the apparatus.

## Outcome

Five verifiable claims:

1. `recall_folded` and `unfold` resolve a folded block from `getEntries()` — live, after resume,
   and after hard compaction — with the block's content verified against a sha256 recorded at
   fold time, and no `spool/` directory anywhere on disk.
2. Blocks that never folded but leave live history at compaction keep their `{#code}` pointers
   in the deterministic summary, resolving through the same ledger route.
3. A `/fold-handoff` seed names the parent session file in its header; codes referenced in the
   seed are provenance in the child session, not live handles.
4. A pre-redesign session resumes fail-open: legacy `spool`/`gate` records resolve through the
   ledger by block id where the block is present (unverified, and recall says so), and report
   unavailable where it is not. No crash, no silent token creep.
5. `spool.ts`, `retention.ts`, the heartbeat, `CONTEXTFOLD_SPOOL_RETAIN_DAYS`, and dedup
   aliasing are gone, along with both spool-GC known issues in README.

## Non-goals

- **Cross-session recall parity.** Verified from Pi source (`session-manager.js:647` resets
  `fileEntries` to a fresh header; `getEntries()` never traverses `parentSession`): lineage does
  not carry entries, and we do not parse the parent JSONL to compensate. The seed's parent-path
  header is the whole cross-session story.
- **Keeping legacy spool files readable.** Clean break per owner ruling: no `readEnvelopeAt`,
  no revalidation pass. Old *records* degrade gracefully (claim 4); old *files* are inert bytes
  the user may delete.
- **A migration tool for old sessions.** Nothing is published yet; only local sessions exist.
- **Changing recall's caps, slicing, or the `fullOutputPath` preference.** The read route
  changes; the budget discipline and haystack rules do not.

## Decisions

Owner rulings from the grilling:

- **Durability floor is Pi's ledger**, reached through `getEntries()`. The spool is removed, not
  retained read-only.
- **Cross-session handoff is path-only.** Probe first was the ruling; the probe was answered
  from source (no lineage traversal), so path-only applies. The seed header names the parent
  session JSONL once.
- **Compacted never-folded blocks keep codes, index-only.** Compaction still assigns codes and
  appends index records and fold records; only the file write disappears.
- **Legacy sessions get a clean break** with fail-open degradation, not compatibility code.
- **Verification bar**: full units on the ledger read path plus one real-session e2e
  (compaction → resume → recall). Fork/tree/headless answered from Pi source, escalating to a
  paid probe only where the source is ambiguous.
- **Sequencing**: this lands before the public GitHub + npm release.

Agent calls, stated here:

- **Lookup is by durable block id; integrity is a recorded sha256.** Block ids are
  identity-anchored (`r:<toolCallId>`, `a:<responseId>:p<n>`), not content hashes, so locating a
  block means re-linearizing `getEntries()` messages with the same `blockId` formula and
  matching ids. The fold record gains `sha256` (of the block text at fold time); recall verifies
  the located text against it and reports a mismatch as a typed error, exactly as a corrupt
  envelope reads today. Ledger linearization is cached per session and invalidated by entry
  count, so recall does not re-walk the file on every call.
- **The fold record replaces the spool record.** `kind:"fold"` custom entries carry what
  `SpoolEntry` carried minus `spoolPath` and `dedupOf`, plus `sha256`. The registry
  (`spool-registry.ts` renamed to `fold-registry.ts`) keeps its latest-per-block semantics.
  Dedup aliasing is deleted: the ledger is one copy by construction.
- **Legacy `spool`/`gate` records restore as fold records without a sha.** They already carry
  `blockId`, `code`, `tool`; recall serves them from the ledger with an "unverified (legacy
  record)" note. This is ~10 lines in `restoreFoldState`, not a compatibility layer.
- **`seed-index.jsonl` moves to `<sessionDir>/context-fold/<sessionId>/`** and stays an on-disk
  JSONL: it is the machine-readable artifact SEED_INDEX_SPEC publishes and the handoff seed's
  source, and external tools can read it without parsing Pi's session format. Handoff seeds
  write beside it. No GC: the directory is append-only text measured in kilobytes, the same
  retention posture as Pi's own session files. SEED_INDEX_SPEC bumps to v2: `spans[].log`
  loses `path`/`byteStart`/`byteEnd` (they addressed spool files) and keeps `bytes` and
  `lines`; a `sha256` field is added per span.
- **Commit precondition shrinks, posture unchanged.** A fold event commits only after the fold
  record and index record are durably appended; either failing rejects the event and the turn
  goes out raw. Same two-phase shape as today with the file write deleted.
- **Golden expectations**: fold output bytes are unchanged (digest text never referenced the
  spool), so `golden-pipeline` hashes hold; `persistence` and `index-emission` goldens move
  intentionally with the new record shapes.

## Seams under test

- Ledger read path (`tests/recall-ledger.test.ts`, replacing `recall-spool.test.ts`): resolve by
  code from a fake `getEntries()`, sha match and mismatch, grep/lines against the full-output
  file with ledger fallback, whole-recall caps, block absent from ledger → typed error naming
  the code.
- Fold record round-trip (`tests/persistence.test.ts`): `kind:"fold"` replay, latest-per-block,
  legacy `spool`/`gate` degradation to unverified fold records, unknown kinds ignored.
- Compaction pointers (`tests/compact.test.ts`, `tests/index-emission.test.ts`): never-folded
  leaving blocks get codes, index spans, and fold records; the det summary renders their
  pointers; recall resolves them post-compaction from the ledger fake.
- Handoff header (`tests/handoff.test.ts`): seed names the parent session file;
  `buildHandoffSeed` stays pure.
- Deletion is total (`tests/extension-load.test.ts` or a small assertion): no `spool/` directory
  is created by a full fold → compact → resume cycle in the hook-level harness, and
  `CONTEXTFOLD_SPOOL_RETAIN_DAYS` is unreferenced.
- E2E (`scripts/e2e-*.sh` family, one run): real session, cheap model — fold, hard compaction,
  quit, resume, `recall_folded` returns the original bytes.

## Slices

- [x] S1 Ledger read path: `resolveFromLedger` (linearize `getEntries()`, durable-id match,
      sha verify, existing caps/slicing); registry entry gains `sha256`, loses
      `spoolPath`/`dedupOf`; recall/search/unfold routes switch over behind the existing
      typed-error surface.
- [x] S2 Write path: fold events append `kind:"fold"` records (no file writes); compaction
      assigns codes index-only; `restoreFoldState` replays new records and degrades legacy
      ones; commit precondition is record + index only. (Landed with S1 in one commit: the
      registry shape and the record shape are one contract, and a spool-writing intermediate
      would have been throwaway.)
- [x] S3 Deletion and relocation: remove `spool.ts`, `retention.ts`, heartbeat, GC, env var,
      dedup; move `seed-index.jsonl` and handoff seeds to `<sessionDir>/context-fold/<id>/`;
      seed header gains the parent session path.
- [x] S4 Docs: DESIGN.md §5 (ledger-backed recovery) and §8 (invariants recast), README
      (known issues pruned, recovery section rewritten), SEED_INDEX_SPEC v2, ADR 0002
      superseding spool-backed recovery (cites the S4 verdict and Pi's append-only contract),
      CHANGELOG entry.
- [x] S5 Verification: unit suite green; one e2e resume probe run and its result recorded
      below; fork/tree/headless survival answered from Pi source with citations in
      `docs/pi-api-surface.md`, paid probe only if the source left ambiguity.

## Open questions

- E2E resume probe result (filled by S5): **ALL PASS**, 2026-08-31, `scripts/e2e-compact-resume.sh`
  against openai-codex/gpt-5.6-sol. One session: fold event (cap), then real threshold hard
  compaction answered by the det summary (15,310 tok summarized, no model), quit, resume
  (restored 3 fold entries, 1 layer), and `recall_folded` recovered the planted phrase
  `periwinkle-astrolabe-7` from the session ledger with both source files deleted. No `spool/`
  directory anywhere on disk; seed index at `context-fold/<sid>/seed-index.jsonl`. Two probe
  notes: folding itself keeps provider usage below a compaction threshold (the probe needs a
  second raw first-delivery read to cross it), and project-level settings are ignored in an
  untrusted directory (the probe carries its compaction override in a temp agent dir).
- Fork/tree/headless survival findings (filled by S5, from Pi source 0.84.4, citations in
  `docs/pi-api-surface.md`): a fork COPIES every non-header entry into the new file
  (`forkFrom`), so recall resolves copied spans and restored fold records verify against them;
  `getEntries()` returns the whole tree, so blocks on abandoned branches still resolve;
  `newSession({parentSession})` carries nothing (path-only handoff confirmed); `persist:false`
  sessions serve recall in-process from the in-memory entry list and nothing survives exit — the
  durable route exists exactly where Pi keeps a session file. No ambiguity remained, so no
  additional paid probe was needed for these.
