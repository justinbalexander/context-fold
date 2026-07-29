# context-fold — architecture

How the extension is built and why, at the level a contributor needs before changing it. The
README describes the behaviour; this describes the machine. `docs/SEED_INDEX_SPEC.md` specifies
the on-disk index format, and `docs/pi-api-surface.md` records the Pi extension API this depends
on.

---

## 1. The core principle

**Context is a view, not a store.** Three rules, enforced by the mechanism rather than by
convention:

1. **Content substitution, never structural removal.** A folded block stays in the outgoing
   message array and keeps its `callId`; only its rendered content is swapped, and the message
   count never moves. A `tool_call`/`tool_result` pair therefore *cannot* orphan — the guarantee
   is structural, not policed.
2. **Reversible by default.** Every folded block carries a deterministic `{#<code> FOLDED}` tag.
   The agent reads the code and calls `recall`/`unfold` to get the original back. No vector store,
   no search index: the handle *is* the address, and the original is in the session file and the
   spool.
3. **Protected working tail.** The newest ~N tokens never fold, so recent reasoning stays at full
   fidelity. The tail is never empty — the newest block is always protected.

The session file is never modified. Folding exists only in the per-call outgoing copy that Pi's
`context` hook hands over.

---

## 2. Layout — pure core, thin adapter

```
src/
  core/                    # ZERO harness dependencies. Pure, portable, unit-testable in isolation.
    tokens.ts              # estTokens = ceil(len/4), BLOCK_OVERHEAD, clip, firstLine, safeSlice
    digest.ts              # the {#code FOLDED} tag, foldCode (FNV-1a), per-kind and pointer digests
    contract.ts            # PolicyView / FoldCommand / ViewBlock — types only, pure
    block.ts               # the WireBlock model, linearize(), blockId(), isDurableId()
    apply.ts               # applyPlan(messages, ops) — the wire rewrite
    gate-registry.ts       # id → born-folded pointer entry (the L0 gate's registry)
    index/seed-index.ts    # deterministic extraction of the seed index record
    policy/
      fold-ladder.ts       # the shipped policy: when a fold event fires and what it masks
      ledger.ts            # the error/risk lexicon — what must survive at every fidelity level
  adapters/pi/             # every Pi API call and all disk I/O lives here
    index.ts               # the extension entry point: hooks, tools, commands
    store.ts               # the engine — view construction, frozen layers, recall, lowering
    gate.ts                # the L0 ingestion gate decision
    spool.ts               # sha256-verified fold envelopes on disk
    index-store.ts         # seed-index.jsonl emission
    persistence.ts         # event-sourced fold state (survives resume)
    compact.ts             # the deterministic hard-compaction summary
    handoff.ts             # /fold-handoff — writes a deterministic seed for a fresh session
    advisor.ts             # cold detection and the reset yellow flag
    cache-telemetry.ts     # measured cacheRead/cacheWrite accounting
    retention.ts           # spool GC
    unfold-tool.ts         # the recall / unfold tools
    config.ts              # CONTEXTFOLD_* env parsing
```

**The seam:** the core speaks only its own `AgentMessage`-shaped block model and a
`conduct(view) → FoldCommand[]` policy interface. The Pi adapter converts Pi's `AgentMessage[]`
to and from core blocks and owns every Pi API call. An adapter for another harness implements the
same conversion against that tool's hooks; the core is untouched.

**Policy/mechanism split:** the *mechanism* (`apply.ts` — rewrite messages, enforce the tail) is
deterministic plumbing. The *policy* (`policy/fold-ladder.ts` — when to fold and what) is the
decision. Keeping them apart is what lets the fold timing change without touching the rewrite.

---

## 3. The per-turn pipeline (the `context` hook)

Pi's `context` hook fires before every model call, hands over a deep copy of the outgoing
`AgentMessage[]`, and the array returned is what actually gets sent. Per turn:

```
on "context" (messages, ctx):
  blocks   = linearize(messages)                  # provider messages → typed Block[]
  gate     = computeGatePointers(blocks)          # L0 born-folded pointers (every turn)
  frozen   = computeFrozenOps(blocks)             # committed layer bytes (every turn)
  view     = buildView(blocks, protect, budget, …)
  cmds     = policy.conduct(view)                 # the fold ladder; [] = nothing to do
  ops      = lower(cmds, blocks, protect)         # FoldCommand[] → FoldOp[]
  commit(ops)                                     # freeze as a layer, emit the seed index
  return applyPlan(messages, merge(gate, frozen, ops))
```

The merge order is **gate > frozen > policy**: the gate owns its ids outright, and a frozen id's
bytes outrank any late policy op for it.

---

## 4. Why discrete fold events

Between fold events the context is **append-only**. Any mutation of history moves bytes and
invalidates the provider's prompt-cache suffix, so masking is batched at chosen boundaries where
that invalidation is paid once, and each event's substitutions are committed as a **frozen layer**
whose bytes never change again. The head of the context therefore stays byte-identical turn over
turn, which is what keeps prefix caches warm.

A fold event fires when both hold: usage is past the first-fold threshold (~45 % of the window,
or 25 % when telemetry shows the session has never had a live cache read — with no warm prefix
there is nothing to protect), and the maskable mass is worth at least one ladder step (~12 % of
the window). Crossing the absolute budget cap is an emergency event with no minimum.

A committed layer is only ever released by an explicit agent `unfold` (a deliberate single-point
prefix break) — never by the engine deciding to re-plan, which would re-prefill the cache to
reproduce byte-identical digests. When everything maskable is already frozen and the context is
still over budget, the engine says so rather than churning.

Layers accumulate for the life of the session. Nothing scans them per turn — the engine keeps a
flat `id → digestText` map and the newest seq — so there is no bound to enforce and no reason to
merge them.

---

## 5. The L0 ingestion gate

The ladder folds blocks once they age past a threshold. The **L0 gate** folds one class of block
*at ingestion*, before it is ever sent warm: a tool result larger than `CONTEXTFOLD_L0_THRESHOLD`
est-tokens. A verbose flood (a 12k-token file read, a test-runner wall) has near-zero marginal
value warm, yet costs its full weight on every subsequent turn.

- **Observe-only seam.** The `tool_result` hook spools the raw payload and registers a born-fold,
  but never mutates the result. The session file keeps raw ground truth. Substitution is view-only,
  in the `context` hook.
- **Spool.** `<sessionDir>/spool/<sessionId>/<code>.json` — a versioned, sha256-verified envelope
  per fold, written atomically, with dedup aliases for identical payloads.
- **Born-folded blocks are terminal.** Such a block enters the view already a pointer: budget math
  charges its *pointer* weight, and the ladder never re-folds it.
- **The pointer** carries a tool-aware digest (path/pattern/command plus sizes), head and tail, and
  **every detected error/risk line verbatim** — a buried `ImportError` never reduces to a summary
  line. Capped at ~400 est-tokens.
- **Error policy.** Error-shaped results (the `isError` flag or a lexical error hit) get a
  `CONTEXTFOLD_L0_ERRCAP`× higher threshold, so a short error is never folded away; a large one
  folds but keeps every error line.
- **Deferred substitution** (`CONTEXTFOLD_L0_KEEP_RECENT`, experimental, default `0`). The newest
  N registered blocks render warm and take their pointer only once newer registrations push them
  out of the hold-out set. The set is keyed on array position (not the token tail), so it stays
  deterministic turn over turn; spooling and recall are unaffected. See the README for the A/B
  evidence and the open question that keeps this flag alive.

## 6. Fold-state persistence

The `tool_result` hook does not re-fire for results already in history, so the gate registry, the
agent's unfold decisions and the committed layers are event-sourced as custom entries
(`contextfold.fold`) and left-folded back on `session_start`. Each restored pointer is revalidated
against its spool file; a vanished spool drops the fold (the block renders raw) rather than leaving
a dead pointer.

Retention: at session start, sibling session spools whose newest file is older than
`CONTEXTFOLD_SPOOL_RETAIN_DAYS` are removed whole-directory. Dedup aliases only ever point at
siblings in the same directory, so nothing dangles, and the current session's spool is never
touched.

---

## 7. Failure posture

Every hook is fail-open with a bounded blast radius, and every degradation is announced on stderr
rather than swallowed — the failure mode to avoid is silent token creep.

| failure | cost |
|---|---|
| gate throws | that one result flows raw |
| fold pass throws | that one turn's context goes out raw |
| seed-index emission throws | that one index record is lost |
| deterministic compaction throws | Pi's own compaction runs instead |
| resume restore throws | prior folds render raw this session |
| spool missing or corrupt | that fold drops; recall returns a typed error naming the path |

`CONTEXTFOLD=0` disables the extension entirely for a session — the escape hatch for a live
incident, with no need to touch the install.

---

## 8. Invariants — do not break these

1. **Only durable ids may be folded.** Ids prefixed `u:`/`a:`/`r:`/`s:` are content-anchored and
   stable; positional `m<i>:…` ids re-point once folding makes the array non-append-only. The
   `isDurableId` gate is separate from the kind-based `wireFoldable` gate — do not conflate them.
2. **The engine is the sole author of the `{#code}` tag.** Strip any tag a policy supplies and
   prepend the authoritative one.
3. **Single disposition.** No block id in two ops.
4. **A block's token cost is uniform `ceil(chars/4) + 4`** (`estTokens` plus `BLOCK_OVERHEAD`),
   one swappable oracle in `tokens.ts`.
5. **Frozen bytes are immutable** for the life of the layer. Only an explicit unfold or a recorded
   layer break releases one.
6. **Risk lines survive every fidelity level.** The error lexicon is deliberately broad and
   any-case; a failure signal that vanishes into an elision marker is the bug this project exists
   to prevent.
7. **No model call anywhere**, on any path. Folding, digests, compaction and the handoff seed are
   all deterministic, so nothing this extension produces can be a paraphrase or a fabrication.
8. **Never vendor `typebox` or the `@earendil-works/*` packages** — Pi injects bundled virtual
   modules at runtime, so a separately installed copy would not be the one the engine uses.
   Declare them as peer dependencies.

---

## 9. Scope

**What this is:** an in-session context-window compactor. On each model call it replaces the
*content* of stale blocks with short digests **in the outgoing message array only**.

**What this is not:** durable cross-session memory. It owns the live window; a journalling or
memory layer owns cross-session recall. They are orthogonal and must coexist — both touch
compaction, so context-fold stays on the `context` hook and relieves pressure *before*
`session_before_compact` would otherwise fire.

---

## 10. Provenance

The pure core is ported from [Accordion](https://github.com/a-Fig/Accordion) (pinned commit
`0c22434`) — `digest.ts` and `tokens.ts` close to verbatim, `applyPlan` and the block model
adapted — stripped of all Svelte/Tauri/browser coupling and hardened since. The discrete fold
ladder, the L0 ingestion gate, the seed index, the spool, and the advisor layers are original to
this project. MIT throughout.
