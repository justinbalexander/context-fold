# context-fold — architecture

As built, describing the shipped 0.3.x behavior. `README.md` is the user-facing
document; this file is for contributors and covers structure, invariants, and the reasoning
behind them.

## 1. Core idea

The design was derived independently but ends up close to native Claude Code compaction. I have
not stress-tested Anthropic models extensively inside Pi, so treat any comparison between the two
as untested.

1. **Avoid Destructive Editing.** A folded block stays in the outgoing
   message array and keeps its `callId`; only its rendered content is swapped, and the message
   count never moves. A `tool_call`/`tool_result` pair therefore *cannot* orphan. This both
   preserves the stable prefix and retains proper history.

2. **Reversible by default.** Every folded block carries a deterministic `{#<code> FOLDED}` tag.
   The agent reads the code and calls `recall_folded`/`unfold` to get the original back.

3. **Protected working tail.** The newest ~N tokens never fold, so recent reasoning stays at full
   fidelity. The tail is never empty — the newest block is always protected.

The session file is never modified.

---

## 2. Layout — pure core, thin adapter

```
src/
  core/                    # No Pi dependencies; adaptable to any harness
    tokens.ts              # estTokens = ceil(len/4), BLOCK_OVERHEAD, clip, firstLine, safeSlice
    digest.ts              # the {#code FOLDED} tag, foldCode (FNV-1a), per-kind digests
    contract.ts            # PolicyView / FoldCommand / ViewBlock
    block.ts               # the WireBlock model, linearize(), blockId(), isDurableId()
    apply.ts               # applyPlan(messages, ops)
    spool-registry.ts      # folded block id → exact-content spool location
    index/seed-index.ts    # deterministic extraction of the seed index record
    policy/
      fold-ladder.ts       # the shipped fold policy
      ledger.ts            # the error/risk lexicon
  adapters/pi/             # every Pi API call and all disk I/O
    index.ts               # the extension entry point: hooks, tools, commands
    store.ts               # the engine
    spool.ts               # sha256-verified fold envelopes on disk
    index-store.ts         # seed-index.jsonl emission
    persistence.ts         # event-sourced fold state
    compact.ts             # the deterministic hard-compaction summary
    handoff.ts             # /fold-handoff - writes a deterministic seed for a fresh session
    advisor.ts             # cold detection and the reset yellow flag
    cache-telemetry.ts     # measured cacheRead/cacheWrite accounting
    retention.ts           # spool GC
    unfold-tool.ts         # the recall_folded / unfold tools
    config.ts              # CONTEXTFOLD_* env parsing
```

The core speaks only its own `AgentMessage`-shaped block model and a
`conduct(view) → FoldCommand[]` policy interface. The Pi adapter converts Pi's `AgentMessage[]`
to and from core blocks and owns every Pi API call. An adapter for another harness implements the
same conversion against that tool's hooks; the core is untouched.

**Policy/mechanism split:** `policy/fold-ladder.ts` decides *what and when* to fold — it is the
policy. `apply.ts` performs the rewrite — it is the mechanism, and it has no opinion about timing.
Keeping them apart is what lets fold timing change without touching the rewrite.

---

## 3. The per-turn pipeline

Pi's `context` hook fires before every model call, hands over a deep copy of the outgoing
`AgentMessage[]`, and the array returned is what actually gets sent. Per turn:

```
on "context" (messages, ctx):
  blocks   = linearize(messages)                  # provider messages → typed Block[]
  frozen   = computeFrozenOps(blocks)             # committed layer bytes (every turn)
  view     = buildView(blocks, protect, budget, …)
  cmds     = policy.conduct(view)                 # the fold ladder; [] = nothing to do
  ops      = lower(cmds, blocks, protect)         # FoldCommand[] → FoldOp[]
  commit(ops)                                     # freeze as a layer, emit the seed index
  return applyPlan(messages, merge(frozen, ops))
```

Frozen bytes outrank any late policy op for the same id.

---

## 4. Why discrete fold events

Between fold events the context is append-only. Any mutation of history moves bytes and
invalidates the provider's prompt-cache suffix, so masking is batched at chosen boundaries where
that invalidation is paid once, and each event's substitutions are committed as a frozen layer
whose bytes never change again. The head of the context therefore stays byte-identical turn over
turn, which is what keeps prefix caches warm.

A fold event fires when both hold: usage is past the first-fold threshold (by default at 45 % of
the window, or 25 % when telemetry shows the session has never had a live cache read), and the
maskable mass is worth at least one ladder step (~12 % of the window). Crossing the budget cap is
an urgent event regardless of ladder position.

Tool results after the latest assistant response are first-delivery results: that assistant issued
their calls, and no provider request has received their output yet. They are held regardless of
tail size or budget pressure. Parallel results are held together. Once a later assistant response
exists, they become ordinary ladder candidates.

A committed layer is only ever released by an explicit `unfold`, never by the engine deciding to
re-plan. An unfold deliberately breaks and re-prefills the prefix once; later turns keep that raw
block byte-identical.

Layers accumulate for the life of the session. Nothing scans them per turn, the engine keeps a
flat `id → digestText` map and the newest seq, so there is no bound to enforce and no reason to
merge them.

---

## 5. Spool-backed recovery

Fresh tool results always reach the model at full fidelity. When the ladder later commits a fold,
the adapter writes each masked block to
`<sessionDir>/spool/<sessionId>/<code>.json`: a versioned, sha256-verified envelope written
atomically, with dedup aliases for identical payloads. The frozen digest carries the authoritative
`{#code FOLDED}` handle. `recall_folded` reads the envelope whole or through bounded grep/line slices;
`unfold` restores the live block on the next turn.

The spool and seed-index record are commit preconditions. The engine prepares a layer, the adapter
spools and indexes every masked block, and only then does the engine freeze and apply its bytes. A
durability failure (disk, index, or layer persistence) rejects the entire event and sends that turn
raw. A fold-code collision is the one per-block exception: the code space is `hash mod 36^6`, so
two durable ids can rarely share a code, and the second is a permanent per-id condition — that
block alone is dropped from the event, held raw for the session, and announced on stderr, while
the rest of the event commits. The spool is therefore the durability floor after hard compaction
removes the raw message from live history, not an arrival-time masking policy. At hard compaction
itself, every foldable block leaving live history that never folded is spooled then (per-block
fail-open), so the recall route covers the entire compacted span, not only the blocks earlier
fold events happened to reach.

## 6. Fold-state persistence

Spool locations, agent unfold decisions, and committed layers are event-sourced as custom entries
(`contextfold.fold`) and replayed on `session_start`. Each restored location is revalidated against
its spool file. Legacy `kind:"gate"` records remain readable so handles from sessions created before
the arrival-time gate's removal still resolve.

Retention: at session start, sibling session spools whose newest file is older than
`CONTEXTFOLD_SPOOL_RETAIN_DAYS` (default 24 hours — a spool is a working artifact, not an archive;
Pi's session JSONL keeps the raw payload regardless) are removed whole-directory. A second pass
applies the same window to sibling *workspace* spool roots, since a workspace's own sweep only
runs when a session starts there again — without it an abandoned workspace would retain its last
spools forever. Dedup aliases only ever point at siblings in the same directory, so nothing
dangles, and the current session's spool is never touched.

Freshness is measured by the newest file mtime in the directory, which on its own would judge a
*live* session by when it last folded. A session that folded early and then ran quietly for longer
than the retention window would be reaped by a freshly started sibling. Each session therefore
refreshes a `.alive` heartbeat file in its own spool directory from the `context` hook, throttled
to at most once an hour, so liveness is recorded independently of folding activity. The remaining
edge is a session whose process is stopped (SIGSTOP, a suspended terminal) for longer than the
window — it stops heartbeating and can still be reaped.

---

## 7. Failure posture

Every hook is fail-open with a bounded blast radius, and every degradation is announced on stderr
rather than swallowed. A failure should be visible, never silent.

| failure | cost |
|---|---|
| fold pass throws | that one turn's context goes out raw |
| spool, seed-index, or layer persistence throws | that fold event is rejected; the turn goes out raw |
| fold-code collision on one block | that block alone stays raw for the session; the rest of the event folds |
| deterministic compaction throws | Pi's own compaction runs instead |
| resume restore throws | prior folds render raw this session |
| spool missing or corrupt (at restore or mid-session) | a live block still resolves from raw history, through the same recall caps and slices; only a block that also left live history errors |

`CONTEXTFOLD=0` disables the extension entirely for one session — the escape hatch for testing or
for isolating a suspected fold-related problem.

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

## 9. Provenance

The pure core is derived from [Accordion](https://github.com/a-Fig/Accordion) (pinned commit
`0c22434`) — `digest.ts` and `tokens.ts` close to verbatim, `applyPlan` and the block model
adapted — stripped of all Svelte/Tauri/browser coupling and hardened since. The discrete fold
ladder, seed index, spool-backed recovery, and advisor layers are original to this project.
