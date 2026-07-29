# Changelog

Notable changes to context-fold. Dates are the date the work landed.

## Unreleased

First release candidate. The project was developed privately before this point; the entries below
are the record of what shipped and what the evidence said, not a release history.

### Removed

- **The legacy `CONTEXTFOLD_MODE=keel` folding mode** and everything reachable only through it —
  the continuous conductor, the fidelity ladder, the code skeletonizer, the entity-reachability and
  ACT-R ranking, and the hard-cap budget floor. An isolated evaluation had already found the full
  ladder costly and unstable as a default (recall-churn loops at roughly twenty times the cost of
  the L0 gate alone), and the discrete fold ladder replaced it as the shipped policy. Env vars
  removed with it: `CONTEXTFOLD_MODE`, `CONTEXTFOLD_PREFIX_STABLE` (the ladder is always
  prefix-stable, so the flag had one live value).
- **Opt-in local-model digests and the coldness judge** (`CONTEXTFOLD_MODEL`,
  `CONTEXTFOLD_COLDNESS` and the `CONTEXTFOLD_MODEL_*` family). These applied only in keel mode:
  in ladder mode a fold's bytes freeze at commit, so a late async model digest could never ship.
  A mechanism demo had shown model digests preserve mid-block identifiers that first-line
  deterministic digests structurally drop — a real effect, but n=1 and never load-bearing.
- **The group-collapse and group-drop path.** Only keel's budget floor ever emitted a `group`
  command. Its removal makes provider-safety structural: `applyPlan` now performs in-place content
  substitution only, so no message is added or removed and a tool pair cannot orphan. The
  orphan-prevention fixpoint went with the thing it protected.
- **The consolidation-break loop**, which un-froze the oldest layer and re-planned harder. That
  meant something when re-planning could escalate to keel's floor; with the deterministic ladder it
  reproduces byte-identical digests, so a break could only spend one cache re-prefill to buy
  nothing. The engine now reports over-budget honestly. The consolidation *merge*
  (`CONTEXTFOLD_MAX_LAYERS` bookkeeping) is unchanged.

### Added

- **The discrete fold ladder** as the folding policy. Fold events fire at thresholds (~45 % of the
  window, 25 % when telemetry shows no live cache read has ever landed) and must save at least a
  ladder step (~12 %) to fire at all; crossing the absolute budget cap folds immediately. Each
  event's substitutions commit as a **frozen layer** whose bytes never change again, so the context
  head stays byte-identical turn over turn and prefix caches keep hitting.
- **The seed index** (`docs/SEED_INDEX_SPEC.md`): one deterministic record appended to
  `seed-index.jsonl` at every fold event — files touched, commands run, error lines in every
  spelling the lexicon knows, exact identifiers harvested from the masked output, first lines of
  user messages, and byte-extent spans into the spool. Pure regex extraction: same input,
  byte-identical output.
- **`recall search=<term>`** — one sweep over every folded block, matching lines grouped by code.
  The recall-churn fix: a detail lost somewhere behind N pointers costs one call, not N.
- **Deterministic hard compaction** (`CONTEXTFOLD_COMPACT=det`, the default). When Pi's own
  compaction fires, the extension supplies a summary rendered verbatim from the seed index instead
  of an LLM rewrite. Every listed token is a lexical hook for `recall`. `native` restores Pi's
  stock behaviour.
- **`/fold-handoff`** — the only LLM path in the package, and it never fires automatically. Writes
  a handoff seed for a fresh session: deterministic index first, model narrative clearly marked
  untrusted, degradation warning up front.
- **Cache telemetry and the advisor.** Measured per-message `cacheRead`/`cacheWrite` drives cold
  detection (one stderr notice when an expected-warm turn reads zero cached tokens) and the
  `/context-fold` status command's yellow flags, in price-agnostic input-token equivalents.
- **`tests/extension-load.test.ts`** — drives the real entry point through a stub `ExtensionAPI`,
  so a broken import or a throw during registration fails in CI rather than in a first session.

### Fixed

- **Recall could re-flood the context.** A payload arriving as one enormous line rode through every
  recall cap on the "always keep at least one line" rule — a live `recall lines=2-2` once returned
  a 40 KB line and undid what the gate had saved. All recall surfaces now clip and window single
  huge lines. This was the root cause of a long-standing live e2e flake that had been misattributed
  to the result-dedup path; dedup was verified sound separately.
- **The budget floor booked savings `applyPlan` then refused.** Group and drop runs were built
  without checking that whole messages were removable, so telemetry claimed under-budget while the
  wire shipped 7.7× the cap. Rebuilt message-aligned. (The floor has since been removed entirely
  with keel.)
- **Skeletonizer crash and hang classes.** The mask-length invariant held on unterminated strings,
  the truncation-note stripper went from ~O(n³) (8.6 s at 4k trailing spaces) to linear, and
  semicolon-less style no longer desynced brace depth. (Removed with keel.)
- **The error lexicon missed real failure spellings** — lowercase `failed`, `fatal`, `npm ERR!`,
  `Segmentation fault`, `Permission denied`, `✗`. A test-runner wall with `isError=false` folded at
  the normal threshold and its failure line dropped out of the pointer, which is the exact failure
  mode the project exists to prevent.
- **`CONTEXTFOLD_L0` was not honoured on resume** and did not re-resolve per turn, so a resumed
  session still substituted pointers with the gate off.
- **The tail target did not clamp against the budget**, so a 20k tail disabled folding entirely on
  any context window under ~27k.
- **Spool writes could collide** across blocks sharing a fold code; they are now refused.
- **Session switches inside one process** left the previous session's registry live, risking
  cross-session code collisions.

### Evidence

The design follows published work rather than intuition: deterministic masking of stale tool
output matches or beats LLM summarization on agentic coding tasks at equal or lower cost
([The Complexity Trap](https://arxiv.org/abs/2508.21433),
[SWE-agent](https://arxiv.org/abs/2405.15793)), while LLM summaries measurably lose exactly what
matters — file and identifier trails are the weakest-preserved category even in good production
summarizers ([Factory.ai](https://factory.ai/news/evaluating-compression)) — and summaries can
fabricate instructions that become post-compaction ground truth. For precise recall, retrieval over
raw stored history beats an in-context summary by a wide margin
([MemGPT](https://arxiv.org/abs/2310.08560),
[LongMemEval](https://arxiv.org/abs/2410.10813)), but grep only finds what lexically matches
([NoLiMa](https://arxiv.org/abs/2502.05167)) — which is why every fold emits a deterministic index
of exact tokens rather than a paraphrase.

A three-arm evaluation of the L0 ingestion gate found it near-inert where a capable model already
scopes its own reads, and decisive where a flood genuinely lands: a buried-error task went from
26,750 to 4,793 input tokens, a web-fetch task from 14,380 to 3,225. The honest framing is "saves
most of the cost where a flood lands, costs a few percent elsewhere" — not a flat ratio.
