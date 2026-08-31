# pi-api-review-followups

Date: 2026-08-31   Status: draft

## Problem

A prompt-construction review of the Pi API surface found four gaps. The spool envelope has a
`fullOutputPath` read path (`store.ts:458`) that nothing ever populates, and both spool-write
sites pass `input: undefined`, so recall grep answers from the truncated content when the tool's
own full-output file exists on disk. The `session_before_compact` handler counts and commits
side effects (advisor counter, seed-index compact record, spool-at-compaction) before the
compaction is known to succeed, so a cancelled or failed compaction still trips the advisor's
"second forced compaction" flag and leaves a phantom recovery map. Cache telemetry spans model
switches, blending measurements from incompatible caches. And `/fold-handoff` ends in "run
`/new` and paste" when `ctx.newSession({setup, withSession})` can seed the replacement session
directly. Behind all of this sits a bigger unverified claim: if raw tool results survive hard
compaction and resume in `sessionManager.getEntries()`, the spool/heartbeat/GC apparatus
(~600 lines) may duplicate Pi's own ledger.

## Outcome

Four verifiable claims, one per slice:

1. A folded bash result whose session recorded a `fullOutputPath` answers `recall_folded`
   grep/line reads from that full output file, and the spool envelope carries the tool call's
   typed input.
2. A cancelled or failed compaction leaves the advisor's compaction count unchanged and the
   seed index reconciled (no phantom compact record in later summaries or handoff seeds).
3. A model switch mid-session resets cache telemetry; the first post-switch status line reports
   a fresh segment, and `everWarm` correctly re-arms cold-start detection.
4. Confirming `/fold-handoff` lands the user in a replacement session with the seed already in
   context as a persisted user message, agent idle, old session file intact.

Plus one recorded verdict: the spool-redundancy prototype answers "do raw tool results survive
hard compaction, resume, and re-compaction in `getEntries()`?" with evidence, written into this
spec's Open questions.

## Non-goals

- **The spool redesign itself.** Even a clean "yes" verdict only opens a future spec; the spool
  also backs cross-session handoff reads and sha-verified bounded recall, so removal is a
  design conversation, not a deletion. Frozen invariants stay frozen until that spec exists.
- **Per-model telemetry segments.** Reset was chosen over segmentation: the new model's cache
  is genuinely cold, and the advisory status line doesn't justify segment bookkeeping.
- **Two-phase commit for compaction side effects.** Spool-at-compaction writes stay in
  `session_before_compact` (content still in live history on failure; GC reaps the spare
  files). Only the counter moves and the index record gets reconciled.
- **Auto-kickoff after handoff switch.** The replacement session lands idle; no tokens are
  spent until the user acts. The goal is already inside the seed.
- **Fork//tree/headless survival matrix for the prototype.** Compaction + resume +
  re-compaction is the agreed bar; the extended matrix runs only if a redesign spec happens.

## Decisions

Owner rulings from the grilling:

- Item 1 ships as a **prototype slice only** (S4); redesign deferred to its own spec.
- Prototype runs as a **real Pi session on a cheap model** (spend pre-authorized), no synthetic
  scaffolding detour.
- Prototype evidence bar: **compaction + resume + re-compaction**, all three in `getEntries()`.
- Handoff: **confirm, then switch** — seed file written as today, then `ui.confirm`; yes →
  `newSession()`, no or headless → today's behavior unchanged.
- Handoff landing: **seeded and idle** — `setup()` injects the seed as a persisted user
  message, no `sendUserMessage` kickoff.
- Telemetry: **reset on model change**, not segmented.
- Compaction events: **counter + reconcile record** — count on `session_compact`, reconcile the
  seed-index record on `session_compact_failed`, announce on stderr.

Agent calls, stated here:

- `fullOutputPath` is read generically from `message.details.fullOutputPath` (string-typed)
  during linearize, not via a new `tool_result` hook — `details` is persisted in the session
  JSONL, so this survives resume for free. Typed `input` comes from the paired `toolCall`.
  Both thread through the wire block into `spool.write` and the seed-index record. The core
  stays pure: these are data fields, not effects.
- Telemetry reset fires only on an actual model change (`previousModel` present and different)
  and not on `source: "restore"`, which precedes a fresh telemetry object anyway.
- Seed-index reconciliation appends a retraction record (the JSONL stays append-only); the
  renderer skips retracted compact records. `ensureLayerSeqAtLeast` is not unwound — a skipped
  seq is harmless.
- `newSession` passes `parentSession`; every `ctx.ui.*` touch stays behind optional chaining
  per the headless posture.
- Prototype artifacts live in `$PI_SCRATCHPAD` / `scripts/` scratch, are not committed, and the
  verdict (with the evidence trail's location) lands in Open questions below. An ADR is written
  only if the verdict starts a redesign spec.

## Seams under test

- `spool.write` payload and envelope round-trip (`tests/recall-spool.test.ts` is prior art) —
  envelope carries `input` and `fullOutputPath`; `store.ts` recall grep prefers the full-output
  file and falls back to spool content when it is missing.
- `CacheTelemetry.reset` wiring (`tests/cache-telemetry.test.ts`) — pure-class behavior plus
  hook wiring in `tests/extension-hooks.test.ts`.
- Compaction lifecycle (`tests/extension-hooks.test.ts`, `tests/index-emission.test.ts`) —
  simulate `session_before_compact` → `session_compact_failed` and assert counter and rendered
  summary; then the success path.
- `buildHandoffSeed` stays pure and untouched (`tests/handoff.test.ts`); the confirm/switch
  path gets a hook-level test with a stubbed `newSession`, and one manual `pi -e` check before
  release.

## Slices

- [ ] S1 Recall fidelity: thread typed `input` and `details.fullOutputPath` from linearize
      through spool envelopes and seed-index records; recall grep answers from the full-output
      file when present.
- [ ] S2 Telemetry correctness: `session_compact`/`session_compact_failed` own the compaction
      count and index reconciliation; `model_select` resets cache telemetry on a real model
      change.
- [ ] S3 Handoff switch: `/fold-handoff` writes the seed, confirms, and seeds a replacement
      session via `newSession({parentSession, setup})`, landing idle; headless and "no" paths
      keep today's behavior.
- [ ] S4 Spool-redundancy prototype (throwaway): real session, cheap model; verify raw tool
      results in `getEntries()` after hard compaction, after resume, and after a second
      compaction; record the verdict below. Code is discarded.

## Open questions

- Spool-redundancy verdict (filled by S4): _pending_. A "yes" opens a redesign spec that must
  also answer cross-session handoff reads and bounded recall before touching the spool;
  a "no" closes item 1 permanently with the evidence cited here.
