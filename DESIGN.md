# context-fold — Design Note

Reversible in-session context compaction for CLI coding agents. Harness-agnostic core,
thin per-harness adapters. First target: the Pi/Willow agent (`@earendil-works/pi-*`).

> Companion docs in this repo:
> - `docs/accordion-port-spec.md` — implementation-ready extraction of Accordion's fold
>   mechanism (the code to port, function-by-function, with source line refs).
> - `docs/pi-api-surface.md` — the exact Pi extension API this depends on, verified against
>   the Willow fork.
> - Deeper rationale + the original code-lift kernel: `~/memory/borrow/borrow-manifest.md`,
>   section "Context Folding — Code Lifts".

---

## 1. Problem & scope

Long sessions — especially research — blow the context budget, and the default `/compact`
permanently rewrites old turns into lossy prose. We want to run sessions longer without that
loss.

**What this is:** an in-session context-window compactor. On each model call it replaces the
*content* of cold blocks with short digests **in the outgoing message array only**, leaving
the real session history untouched. Folding is instant and fully reversible — the agent can
pull any folded block back verbatim by its handle.

**What this is NOT:** durable cross-session memory. It never writes to `~/memory`. The
`autojournal` stack owns cross-session recall; context-fold owns the live
window. They are orthogonal layers and must coexist (both touch compaction — see §7).

**Why portable:** if it works, Jake wants it on CLI tools outside the Willow ecosystem. So
the fold engine has zero harness dependencies; each harness gets a small adapter.

---

## 2. Core principle (do not violate)

**"Context is a view, not a store."** Three rules inherited from Accordion, all enforced by
the mechanism, not by convention:

1. **Content substitution, never structural removal.** A folded block stays in the array and
   keeps its `callId`; only its rendered content is swapped. A `tool_call`/`tool_result` pair
   can therefore never orphan. (The only exceptions are whole-message group-collapse and
   group-drop, which are pair-balanced by a fixpoint — see port spec §1d.)
2. **Reversible by default.** Every folded block carries a deterministic `{#<code> FOLDED}`
   tag; the agent reads the code and calls `unfold`/`recall` to get the original back. No
   vector DB, no search index — the handle *is* the address and the original *is* in the
   session.
3. **Protected working tail.** The newest ~N tokens are never folded, so recent reasoning
   stays full-fidelity. The tail is never empty (the newest block is always protected).

---

## 3. Architecture — pure core + harness adapter

```
context-fold/
  src/
    core/                 # ZERO harness deps. Pure, portable, unit-testable in isolation.
      tokens.ts           # estTokens = ceil(len/4), BLOCK_OVERHEAD, clip, firstLine
      digest.ts           # {#code FOLDED} tag, foldCode (FNV-1a), per-kind digestBody  [port ~verbatim]
      contract.ts         # ConductorView, Command union, ViewBlock, ClampReason  [types only, pure]
      block.ts            # Block/Group model, linearize(), blockId(), isDurableId()
      apply.ts            # applyPlan(messages, ops, groups) — the orphan-safe rewrite  [load-bearing]
      policy/
        keel.ts           # deterministic Phase-1 policy: roots, relevance, score, ladder, budget
        model.ts          # (Phase 2) model-driven policy — calls a local model at epoch boundaries
    adapters/
      pi/
        index.ts          # default (pi) => {...} factory: mounts the context hook, unfold tool, storage
        hook.ts           # context-hook glue: AgentMessage[] <-> core Block[], call policy, applyPlan
        unfold-tool.ts    # registerTool({ name:"unfold", ... }) — recall by fold-code
        storage.ts        # ledger-as-storage: append fold/unfold entries, fold them back on read
  docs/                   # this design note + port spec + api surface
  tests/
```

**The seam:** the core speaks only its own `AgentMessage`-shaped block model and a
`conduct(view) → Command[]` policy interface. The Pi adapter converts Pi's `AgentMessage[]`
to/from core blocks and owns every Pi API call. A future adapter for another CLI implements
the same conversion against that tool's hook system; the core is untouched.

**Policy/mechanism split (keep even though it's one process):** the *mechanism* (`apply.ts` —
rewrite messages, heal orphans, enforce tail) is deterministic plumbing. The *policy*
(`policy/*` — which blocks are cold, how hard to compress) is the *decision*, and is the slot
where a model plugs in. This split is what lets us A/B a deterministic vs a model-driven
policy without touching the mechanism.

---

## 4. The per-turn fold pipeline (the `context` hook)

The Pi `context` hook fires before every model call, hands us a deep copy of the outgoing
`AgentMessage[]`, and the array we return is what actually gets sent (verified — see
`docs/pi-api-surface.md`). Per turn:

```
on "context" (messages, ctx):
  blocks   = linearize(messages)               # provider msgs -> typed Block[]
  protect  = protectedFromIndex(blocks, tailTarget)
  view     = buildView(blocks, protect, budget, contextWindow, liveTokens)
  cmds     = policy.conduct(view)              # Keel (det) or model policy; null = hold last plan
  {ops, groups} = lower(cmds)                  # Command[] -> FoldOp[] / GroupOp[]
  out      = applyPlan(messages, ops, groups)  # orphan-safe in-place rewrite
  return { messages: out }
```

**Epoch band (cost control, do not skip):** the policy does NOT re-fold every turn. It holds
while context ≤ ~0.9·cap, and only when it crosses that line folds down to ~0.7·cap in one
shot (≈20% hysteresis → at most one KV-cache miss per epoch, keeps the prefix warm). This is
what makes a *model* policy affordable: the model call happens a handful of times in a long
session, at epoch boundaries, never per-turn.

---

## 5. The policy slot — deterministic first, model as the experiment

- **Phase 1 — Keel deterministic (baseline).** Pure function of the view: entity-reachability
  (fold semantically-dead blocks first) → risk stickiness (keep paths/commands/decisions) →
  ACT-R cold score (kind-major: tool_result folds before thinking before text; user never
  folds) → fidelity ladder (Full → skeleton → trim → digest → group → drop). Zero model calls,
  zero GPU. Degrades byte-identically with no model link. Full algorithm in port spec §4.
- **Phase 2 — model-driven policy (the leverage).** A local Lemonade model perceives the cold
  zone at each epoch boundary and decides coldness / writes better digests. This is the
  shared-world version: *the model is in the deciding loop*, which a deterministic compactor
  structurally can't be. Whether it earns its inference cost is the experiment's hypothesis,
  not an assumption.

---

## 6. Reversibility & recall

- **Fold-tag:** `{#<code> FOLDED}`, `<code>` = 6-char base36 FNV-1a hash of the block's durable
  id (stateless, reproducible). Port `digest.ts` ~verbatim.
- **`unfold` tool:** registered via `pi.registerTool`, modeled on pi-blackhole's `recall.ts`
  dispatch pattern (`promptSnippet` + `promptGuidelines` teach the grammar). Agent passes a
  fold-code; we return the original block content. `recall` = return content as a tool result
  without changing standing context; `unfold` = re-expand it in the view next turn.
- **Cross-restart persistence (can defer past MVP):** store fold/unfold events as custom
  ledger entries (`pi.appendEntry("contextfold.fold.*", ...)`) and reconstruct by left-folding
  them — the exact event-sourced pattern from pi-blackhole's `foldLedger` (fold = "recorded",
  unfold = "tombstone"). Reversibility maps onto it naturally. **Shipped** — see §6b.

---

## 6a. L0 ingestion gate (shipped)

The per-turn pipeline (§4) folds blocks once they age past the budget. The **L0 gate** folds one
class of block *at ingestion*, before it is ever sent warm: a tool result larger than
`CONTEXTFOLD_L0_THRESHOLD` est-tokens. Rationale — a verbose flood (a 12k-token file read, a
pytest wall) has near-zero marginal value warm, yet costs its full weight on every subsequent turn
until Keel gets around to it. The gate collapses it to a pointer the moment it lands.

- **Seam (D10):** the `tool_result` hook OBSERVES only — it spools the raw payload and registers a
  born-fold, but never mutates the result. The session jsonl therefore keeps raw ground truth
  (trace-mining, `--export`, and post-hoc debugging are untouched). Substitution is view-only, in
  the existing `context` hook.
- **Spool:** `<sessionDir>/spool/<sessionId>/<code>.json` — a versioned, sha256-verified envelope
  per fold (atomic write, dedup aliases for identical payloads). Retention (Phase 6): at session
  start, SIBLING session spools with no file newer than `CONTEXTFOLD_SPOOL_RETAIN_DAYS` (default
  14; `0`/`off` = never delete) are removed whole-dir — aliases only point at siblings, so no
  dangling — and the current session's spool is never touched. A reaped spool degrades exactly
  like a missing one: resume drops the fold, recall throws the typed SpoolError.
- **Born-folded blocks (the deep cut):** the "every block starts warm" invariant Keel assumed is
  now "…unless the gate registry marks it born-folded." A born-folded block enters the view already
  a pointer: budget math charges its *pointer* weight, ranking still sees its *full* weight, and the
  fidelity ladder / hard-cap floor treat it as terminal (never re-digested). Isolated behind the
  gate registry; fail-open means a bug degrades to no-gating, not corruption.
- **Pointer:** a tool-aware digest (path/pattern/command + sizes), head + tail, every detected
  error/risk line verbatim (the rtk failure mode — a buried `ImportError` never reduces to a
  summary line), a spool locator, and one recall usage line. ≤400 est-tokens.
- **Recall:** the existing `recall` tool serves L0 codes from the spool — whole, or sliced by
  `grep=<term>` / `lines=<a-b>` (partial retrieval, so recall can't itself re-flood the context).
  A missing/corrupt spool returns an explicit error naming the path (D16).
- **Error policy (D7/D31):** error-shaped results (the `isError` flag or a lexical error hit) get a
  `CONTEXTFOLD_L0_ERRCAP`× higher threshold, so a short error is never folded away; a large one
  folds but keeps every error line.
- **Kill switch (D20):** `CONTEXTFOLD_L0` — unset/`0` inert, `1` all models, or a comma-separated
  model-id substring allowlist for per-model rollout.

## 6b. Fold-state persistence (shipped)

Keel's L2/L3 folds are re-derived from the view every turn, so they need no persistence. The gate
registry and the agent's unfold decisions are the only cross-turn state, and the `tool_result` hook
does not re-fire on resume — so they are event-sourced as custom entries
(`contextfold.fold`, `{kind:"gate"|"unfold"}`) and left-folded back on `session_start`. Each
restored pointer is revalidated against its spool file; a vanished spool drops the fold (the block
renders raw) rather than leaving a dead pointer.

---

## 7. Coexistence constraint (must verify in Phase 1)

context-fold drives the per-turn `context` hook. `autojournal` and any native
`/compact` also operate on context. The `context` hook is non-destructive and chains (multiple
handlers each see the prior's output), so per-turn folding should compose cleanly. But we must
confirm: (a) folding doesn't corrupt what autojournal reads, and (b) if native
`session_before_compact` still fires under pressure, our folded view and its destructive
summary don't fight. Decision for Phase 1: prefer keeping context-fold purely on the `context`
hook and letting it relieve pressure *before* `session_before_compact` ever triggers.

---

## 8. Critical invariants & gotchas (from the source extraction — full list in port spec)

1. **Orphan-prevention is a fixpoint, not one pass.** Removing one message can strand a
   tool-pair partner in another; iterate until stable (port spec §1d). This is the heart of
   provider-safety.
2. **Only durable ids may be folded.** Ids prefixed `u:`/`a:`/`r:`/`s:` are content-anchored
   and stable; positional `m<i>:…` ids re-point once folding makes the array non-append-only.
   `isDurableId` gate is separate from the kind-based `wireFoldable` gate — don't conflate.
3. **One summary message per contiguous RUN, not per group.** An interior straggler splits a
   group; charge one summary per surviving sub-run or budget accounting breaks.
4. **The engine is the sole author of the `{#code}` tag.** Strip any tag a policy supplies and
   prepend the authoritative one.
5. **Single disposition:** no block id in two commands (e.g. both `fold` and `group`).
6. **Token estimator is uniform `ceil(chars/4)+4`.** One swappable oracle in `tokens.ts`; Keel
   deliberately over-estimates group head cost — keep that conservatism.
7. **Pi import constraint:** import LLM/types helpers from `@earendil-works/pi-ai/compat`, not
   a separately-installed `pi-ai` (the loader injects bundled virtual modules; a foreign copy
   won't see the engine's model registry).

---

## 9. Build phases

### Phase 1 — deterministic MVP (next session)
Scaffold + port the pure core + wire the Pi adapter + deterministic Keel policy. No model calls.
Concrete steps:
1. `npm init`, TS config, jiti no-build setup, `package.json` `pi.extensions: ["./src/adapters/pi/index.ts"]`. Pin `@earendil-works/pi-*` peer dep to the fork's band (`>=0.80 <1.0`).
2. Port pure core: `tokens.ts`, `digest.ts` (verbatim), `contract.ts` (types), `block.ts`
   (`linearize`/`blockId`/`isDurableId`/`messageInfo`), `apply.ts` (`applyPlan` + the fixpoint).
3. Port `policy/keel.ts` Phase-1 only (roots/relevance/score/ladder/budget; no `complete`/`compress` paths).
4. Adapter: `hook.ts` (context hook ↔ core), `unfold-tool.ts`, minimal in-memory fold-state
   (ledger persistence optional this phase).
5. Unit tests on the core (orphan fixpoint, protected tail, digest determinism, single-disposition).

**Phase 1 success criteria (verifiable):**
- On a session driven past budget, cold blocks fold to digests and `liveTokens ≤ cap`.
- The agent can call `unfold <code>` and get the original block back verbatim.
- No orphaned tool pairs ever reach the provider (assert in a test with parallel tool calls).
- Runs clean in `pi -p --mode json` (headless) with no UI dependency.

### Phase 2 — model-driven policy
`policy/model.ts` calls the loaded Lemonade model at epoch boundaries. Call it **synchronously
inside the hook** (shares the main module's pi-ai instance → sees the provider registry, avoids
pi-blackhole's jiti-isolation trap), or plain `fetch` to Lemonade's OpenAI endpoint (KISS).

### Phase 3 — the experiment
Matrix: {native `/compact` · deterministic fold · model fold} × {GPT-5.5 driver · local Lemonade
driver}. The small local model is the canary for fold-tag confusion / token bloat.
- **Quality:** recall accuracy on a labeled question set probing early/mid/recent facts, after
  compaction. Win = fold beats native `/compact` at the same token budget.
- **Cost:** final context tokens, per-turn folding latency, model calls.
- Reuse the `/experiments` harness and the labeled-recall-set machinery from the autojournal A/B.

---

## 10. Open decisions (resolve as they come up; not blocking Phase 1)
- Ledger persistence of fold state in MVP, or defer to Phase 2? (Lean: defer; in-memory is fine
  for a single session.)
- Model-call transport in Phase 2: in-hook `complete()` vs plain `fetch`. (Lean: try `fetch`
  first for portability beyond Pi.)
- Tail target N and epoch band thresholds: start with Accordion's defaults (~20k tail, 0.9/0.7
  band), tune in Phase 3.

---

## Phase 1 kickoff prompt (paste into the fresh session)

> Build Phase 1 of context-fold (`~/library/jake/context-fold`) — a reversible in-session context compactor
> as a Pi/Willow agent extension. Read `~/library/jake/context-fold/DESIGN.md`,
> `~/library/jake/context-fold/docs/accordion-port-spec.md`, and `~/library/jake/context-fold/docs/pi-api-surface.md`
> first; the deterministic algorithm and exact Pi APIs are fully specified there. Re-clone
> Accordion at pinned commit `0c22434` (`git clone https://github.com/a-Fig/Accordion`) to copy
> `digest.ts`/`tokens.ts` and check the `applyPlan`/Keel source against the spec. Goal: the pure
> core (`src/core/*`) + a deterministic Keel policy + the Pi adapter (`context` hook + `unfold`
> tool), no model calls. Verify against the Phase 1 success criteria in DESIGN.md §9, including a
> unit test proving parallel tool-call pairs never orphan and a live `pi -p --mode json` run
> that folds under budget and unfolds on demand.
