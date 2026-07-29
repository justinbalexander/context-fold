# context-fold — build history & evidence log

## Phase 7 — the rebuild ✅ (2026-07-28)

Redesign per `docs/HANDOFF_REBUILD_2026-07-28.md` (evidence: the compaction literature review +
the Sol campaign verdict that demoted the full Keel ladder): B/C/A layered compaction with the
**discrete fold ladder** as the new default (`CONTEXTFOLD_MODE=ladder`), continuous Keel demoted
to `CONTEXTFOLD_MODE=keel`.

- **B** — threshold-triggered fold events (45 % / 12 % step / cold branch 25 % / cap emergency)
  masking stale observations into prefix-stable frozen layers; consolidation merges layer
  records past `CONTEXTFOLD_MAX_LAYERS` byte-neutrally.
- **C** — deterministic seed index (`docs/SEED_INDEX_SPEC.md`, shared spec with Evoker) emitted
  at every fold; masked blocks spooled + registered so recall survives resume AND hard
  compaction; `recall search=<term>` span-sweeps every folded block in one call (churn guard).
- **A** — opt-in only: `/fold-handoff` (deterministic seed + untrusted narrative + degradation
  warning); `session_before_compact` answers Pi's hard compaction with a deterministic
  index-rendered summary (`CONTEXTFOLD_COMPACT=det`) — the automatic path never calls a model.
- Advisor: measured-cacheRead cold detection + the price-agnostic reset yellow flag
  (input-token equivalents) in `/context-fold` status.
- **e2e-gate (c) flake ROOT-CAUSED and fixed** — it was never the dedup path (verified sound,
  `tests/gate-dedup.test.ts`): a one-enormous-line payload rode through every recall cap on the
  "always keep at least one line" rule; a live `recall lines=2-2` returned a 40KB line. All
  recall surfaces now clip/window huge lines (`tests/recall-reflood.test.ts`).
- Verification: 236 unit/integration tests + typecheck green; all four live gates ALL PASS
  (`e2e-gate`, `e2e-resume`, `e2e-cache` at 99.4 % measured hit on the local backend, and the
  new `e2e-ladder` — fold event, index emission, byte-stable head, buried-value recall).
- Release readiness: LICENSE (MIT), external-audience README with the honest post-review
  framing, estate-specific references scrubbed from code/scripts, package .gitignore.
  Extraction to a standalone repo + naming remain owner decisions.

The phase-by-phase build record: what shipped when, the eval results that drove each decision,
and the adversarial-review findings. The README describes the CURRENT end-to-end behavior;
this file is where the evidence and the story live. Roadmap ("Next") is in the README.

## Phase 1 — deterministic MVP ✅ (verified against `DESIGN.md` §9)

- Pure core (`src/core/*`): tokens, digest, contract, block model, orphan-safe `applyPlan`.
- Deterministic **Keel** policy (`src/core/policy/*`): roots → relevance (entity-reachability +
  risk stickiness + ACT-R cold score) → fidelity ladder → epoch band → hard-cap floor. Zero model
  calls.
- Pi adapter (`src/adapters/pi/*`): the `context` hook, the `unfold`/`recall` tools, an in-memory
  fold-state store.
- Live `willow -p --mode json` headless run folds under budget with no UI dependency.

## Phase 2 — model-driven digests ✅ (rep 1 of the staged plan)

A local model writes higher-quality digests for the cold zone. **Keel still decides which blocks
are cold** (deterministic, proven) — the model only supplies a better *string*, so it slots in at
the wire-lowering step with the same `{#code}` tag and same reversibility, and degrades to the
deterministic digest on any model failure. A clean A/B for the Phase-3 experiment.

- `src/core/model/digest-writer.ts`: a portable, `fetch`-based, OpenAI-compatible writer. One block
  per call (robust for small models), parallel + bounded per epoch, with validate + per-block
  fallback. The model can only ever *improve* digests, never break folding.
- Wired into the engine async (fire-and-cache at epoch boundaries, **never blocks the agent's
  turn**); model digests apply only to **L3 folds** (the deepest cold zone — L1/L2 skeleton/trim
  keep their reversible deterministic forms). Off by default; enabled by `CONTEXTFOLD_MODEL`.
- **Default model: `Qwen3.5-4B-MTP-GGUF`** — benchmarked against Qwen3.5-9B and Qwen3-Coder-30B for
  this task: **3.3× faster decode** (~116 tok/s via multi-token prediction), **identical digest
  quality** (100% buried-identifier retention), 3.4 GB (light to keep permanently loaded). The
  1B-class models (LFM2-1.2B, Llama-3.2-1B) are too weak (they echo headers); Qwen3.x are
  hybrid-reasoning models that MUST run with thinking disabled (the extension does this by default).
- Verified live: the real writer against Lemonade returns fact-dense digests preserving exact
  identifiers, and a live `willow` run applied a model digest to a fold across turns (`model=1/2`).

**27 tests** (orphan fixpoint, protected tail, digest determinism, single-disposition, fold-under-
budget, recall verbatim, unfold roundtrip, model-digest validation/fallback, engine model-digest
application, model-off == Phase-1-identical; + 1 opt-in live Lemonade test).

## Phase 2 rep 2 — model decides coldness ✅

`ModelConductor` extends Keel: a local relevance judge marks cold candidates as "keep warm" (still
relevant to current work) and those fold **last**. The model is in the deciding loop but **cannot
break correctness** — the orphan-safe mechanism, hard-cap floor, and protected tail are unchanged,
so the budget guarantee holds even if the model keeps too much (the floor folds keep-warm blocks as
a last resort). Async fire-and-cache at epoch boundaries; off unless `CONTEXTFOLD_COLDNESS=1`.

## Phase 3 — the experiment ✅

`src/experiments/recall-eval.ts` + `tests/recall-eval.test.ts` (opt-in: `CONTEXTFOLD_EVAL=1`). A
long over-budget session with 6 facts planted **mid-block**, compacted three ways to the **same**
budget, then measured for fact retention and driver-model recall. Live result (Qwen3.5-9B, 27.5k
session → 8k budget):

| arm | tokens | retention | recall |
|---|---|---|---|
| truncate *(native-compact proxy)* | 7391 | 50% | 33% |
| det-fold | 7897 | 50% | 33% |
| **model-fold** | 7938 | **100%** | **83%** |

**Read this table as a MECHANISM DEMO, not a measured effect size** (adversarial review,
2026-07-04): it is one live run (n=1, never re-run after the default writer moved from the 9B to
the 4B-MTP), the recall column is not asserted by the test, and the mid-block fact-planting is a
scenario the deterministic L3 digest *structurally* cannot keep — so the gap direction is real and
by-construction, but the specific percentages are not a repeatable finding. What it demonstrates:
model digests carry mid-block identifiers that first-line deterministic digests drop. Caveat:
det-fold ties truncate on this *one-shot* metric only because its edge is **reversibility** (the
agent can `unfold` to recover any fact — truncation destroys it), which a no-tools Q&A can't
capture. The actionable finding it surfaced — teach the deterministic L3 digest to keep risk-flag
lines — shipped in Phase 4.

```bash
CONTEXTFOLD_EVAL=1 npx vitest run tests/recall-eval.test.ts   # live experiment, prints the table
```

## Phase 4 — L0 ingestion gate + open items ✅ (shipped 2026-07-04)

Large tool results are spooled and born-folded to a pointer at ingestion (DESIGN §6a), recoverable
whole / by grep / by line range; fold state survives resume (§6b); the L1 skeletonizer and L3
risk-line retention are done. A 3-arm × 2-model A/B eval
(`~/experiments/l0-gate-eval/RESULTS.md`) decided default-on **per model**:

| model | flood B/A | parity | buried-error kill probe | verdict |
|---|---|---|---|---|
| **Qwen3.6-35B** | **0.29** | ✓ | 3/3 clean | **enabled** (`CONTEXTFOLD_L0=Qwen3.6`) |
| gpt-5.5 | 0.91 | ✓ | 2/2 clean | opt-in (recall churn on many-file hunts) |

Headline finding: capable models grep/scope around grep-friendly floods (so the gate is near-inert,
no regression), and the gate wins big where a flood truly lands — qwen `buried-error` 26,750 → 4,793
input tokens (B/A 0.18), `web-fetch` 14,380 → 3,225 (0.22). Proven live end-to-end by
`scripts/e2e-gate.sh` (a 64KB read folds 12,810 → 397 and the agent recalls a buried line it never
saw raw) and `scripts/e2e-resume.sh` (fold survives a restart).

## Phase 5 — adversarial-review hardening ✅ (2026-07-04)

A five-way adversarial review (`REVIEW-2026-07-04.md`) found three reproduced criticals in the
Phase 1–4 build despite a green 103-test suite. All blocking and major findings are fixed:

- **Budget floor rebuilt message-aligned.** Stages 2/3 (group/drop) now build runs at provider-
  message granularity with tool pairs balanced up front — booking only savings `applyPlan` will
  actually honor. The review's repro (120 read-exchanges, cap 6000) went from **46,069 tokens
  shipped while telemetry claimed under-budget** to 4,569 shipped with an honest claim of 5,977.
  Group summaries' `{#code}` handles now resolve via `recall`/`unfold` (L4 reversibility).
- **Skeletonizer crash + hang classes closed.** The mask-length invariant holds on unterminated
  strings (truncated reads, Rust lifetimes — `'static` is now lexed as code), the truncation-note
  stripper is linear (was ~O(n³): 8.6s at 4k trailing spaces → 0.2ms), semicolon-less style no
  longer desyncs brace depth, and `trySkeleton` is fail-open — a defect degrades one block to
  L2/L3 instead of aborting the fold pass.
- **Recall can't re-flood.** Whole-result recall and `lines=` are token-capped (~2000, the gate
  threshold) with paging notes; `grep`/`lines=` read the same haystack so line numbers agree.
- **Error lexicon widened** (lowercase `failed`, `fatal`, `npm ERR!`, `Segmentation fault`,
  `Permission denied`, `✗`, …) — a test-runner wall with `isError=false` now gets the errCap
  threshold and its failure line rides the pointer verbatim.
- **Kill switches:** `CONTEXTFOLD=0` master switch (whole extension inert); `CONTEXTFOLD_L0` is
  honored on resume and re-resolved per turn (allowlist is case-insensitive; stray numeric tokens
  ignored); session switches in one process reset per-session state.
- **Accounting honesty:** model digests are priced into every projection (the model can no longer
  push the wire past what the floor proved, and tag-shaped model output is stripped — the engine
  stays the sole `{#code FOLDED}` author); the tail target clamps to half the budget (a 20k tail
  no longer disables folding on small context windows); born-folded pointers weigh their pointer
  size in tail protection; the entity-reachability tier actually orders candidates (the old
  message-prefix bug marked the whole session reachable); pointer digests hold their ≤400-token
  budget on risk-free long-line floods; spool writes refuse cross-block fold-code collisions.

## Phase 6 — spool retention + L1 risk-line retention ✅ (2026-07-04)

The two deferred items from the Phase-5 review, closed:

- **Spool GC.** At `session_start` the extension reaps whole sibling session-spool dirs whose
  newest file is older than `CONTEXTFOLD_SPOOL_RETAIN_DAYS` (default 14; `0`/`off` disables).
  Directory granularity keeps dedup aliases safe (they only ever point at siblings in the same
  dir), the current session's dir is never touched, and a reaped spool degrades exactly like a
  missing one always did: resume drops those folds ("dropped N (missing spool)") and a recall
  fails with the typed SpoolError. Fail-open throughout. Verified live: a planted 30-day-old
  spool dir is reaped at session start while a fresh sibling survives.
- **L1 skeleton risk-line retention.** The skeletonizer now keeps risk-flag body lines IN PLACE
  inside elided bodies — `TODO`/`FIXME`/`XXX`/`HACK` (matched on the original line; comment
  content is blanked in the mask) and `throw`/`raise`/`panic!`/`todo!`/`unimplemented!` (matched
  on the mask, so string contents can't trigger) — capped at 4 lines per body, 200 chars per
  line, interleaved with exact gap markers. Same guarantee the L2 trim gives prose: a buried
  failure signal never vanishes into an elision marker. This is a deliberate second,
  code-specific detector — the ledger's tool-output detector would match nearly every assignment
  in source code.
- **Fixed in passing:** brace-body `elidedLines` were double-counted (a 4-line body reported
  `8 elided` in the skeleton header); counts are now honest.

