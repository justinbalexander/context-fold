# context-fold

Deterministic, reversible context compaction for the [Pi coding agent](https://github.com/earendil-works/pi).
Long agentic sessions stay under budget by **folding stale content out of the model's view — never
out of the session** — with every fold reversible, every fold indexed, and no LLM anywhere in the
automatic path.

Three layers, applied in this order:

- **Deterministic observation masking.** At discrete fold events, stale tool outputs collapse to
  short reversible pointers; user intent, assistant conclusions, and the record of actions stay
  verbatim. Zero model calls, zero hallucination risk.
- **An always-on reversibility floor.** Everything masked is spooled to disk (sha256-verified), a
  deterministic **seed index** (files, commands, error lines, exact identifiers) is emitted at every
  fold, and the agent gets span-capable `recall` over all of it.
- **LLM summarization, opt-in only, never automatic.** `/fold-handoff` writes a handoff seed for a
  fresh session — deterministic index first, model narrative clearly marked untrusted, with a
  degradation warning up front.

## Why deterministic

The published evidence is consistent: deterministic masking of stale tool output matches or beats
LLM summarization on agentic coding tasks at equal or lower cost
([The Complexity Trap](https://arxiv.org/abs/2508.21433), [SWE-agent](https://arxiv.org/abs/2405.15793),
[Anthropic's context editing](https://claude.com/blog/context-management)), while LLM summaries
measurably lose exactly what matters — file/identifier trails are the weakest-preserved category
even in good production summarizers ([Factory.ai](https://factory.ai/news/evaluating-compression)),
~40 % of summary-induced answer changes are degradations
([Self-Compacting Agents](https://arxiv.org/pdf/2606.23525)), and summaries can fabricate
instructions that become post-compaction "ground truth"
([claude-code #46602](https://github.com/anthropics/claude-code/issues/46602)). For precise recall,
retrieval over raw stored history beats an in-context summary by a wide margin
([MemGPT](https://arxiv.org/abs/2310.08560), [LongMemEval](https://arxiv.org/abs/2410.10813)) —
but grep only finds what lexically matches ([NoLiMa](https://arxiv.org/abs/2502.05167)), which is
why every fold emits a deterministic index of exact tokens rather than a paraphrase.

## What it does

### Big tool results fold the moment they land (the L0 ingestion gate)

With `CONTEXTFOLD_L0` enabled, every tool result is observed as it lands (observe-only — the
session file keeps the raw payload). A result over ~2000 est-tokens is **spooled** to a
sha256-verified envelope and **born-folded**: the view shows a ≤400-token pointer carrying the
`{#code FOLDED}` recovery tag, a tool-aware summary, head + tail, and **every detected error/risk
line verbatim**. Error-shaped results get 4× threshold headroom, so a short error never folds away.

### Discrete fold events

Between fold events, context is **append-only** — rewriting history invalidates the provider's
prompt-cache suffix, so mutations are batched where that cost is paid once:

- First fold when usage crosses ~45 % of the context window (25 % when telemetry shows the
  session has never had a live cache read — no prefix worth protecting).
- A fold event masks stale `tool_result`/`thinking` blocks outside the protected tail to their
  deterministic digests (risk lines kept verbatim), and commits them as a **frozen layer** whose
  bytes never change again — the context head stays byte-identical turn over turn, which is what
  keeps prefix caches warm.
- Each further event needs at least a ladder step (~12 % of window) of maskable mass; crossing
  the absolute budget cap (`min(200k, 0.75 × window)`) folds immediately.
- Past `CONTEXTFOLD_MAX_LAYERS`, layer records merge (bookkeeping only — bytes untouched).

When everything maskable is already folded and the context is still over budget, the extension
says so rather than churning — the protected tail and user turns are the floor, and re-planning
would only reproduce byte-identical digests at the cost of a cache re-prefill.

### The seed index

Every fold event appends one deterministic record to `seed-index.jsonl` in the session spool dir
(spec: `docs/SEED_INDEX_SPEC.md`): files touched, commands run, error lines in every spelling the
lexicon knows (lowercase `failed`, `npm ERR!`, …), exact identifiers/numbers harvested from the
masked output (the class summaries drop), first lines of user messages, and byte-extent spans
into the spool. Extraction is pure regex — same input, byte-identical output.

### Getting detail back

- `recall search=<term>` — **one sweep over every folded block**, matching lines grouped by code.
  This is the recall-churn killer: a detail lost somewhere behind N pointers costs one call, not N.
- `recall <code>` / `grep=<term>` / `lines=<a-b>` — whole or partial retrieval, token-capped so a
  recall can never re-flood what folding saved.
- `unfold <code>` — sticky re-expansion (a deliberate one-point prefix break).

Recall works live, after resume, and **after hard compaction** — masked content resolves from the
spool even once the raw message left history.

### Hard compaction never summarizes with a model

When Pi's own compaction fires, the extension (default `CONTEXTFOLD_COMPACT=det`) supplies a
**deterministic summary rendered verbatim from the seed index** — user intents, files, commands,
error lines, identifiers, recovery pointers — instead of an LLM rewrite. Every listed token is a
lexical hook for `recall`. `CONTEXTFOLD_COMPACT=native` restores Pi's stock behavior.

### Cold sessions and the reset yellow flag

Measured prompt-cache telemetry (per-message `cacheRead`/`cacheWrite`) drives two advisories, in
price-agnostic **input-token equivalents** (fee *ratios* are near-constant across vendors:
cache read ≈ 0.1× input):

- **Cold detection** — an expected-warm turn that read zero cached tokens gets one stderr notice
  with the re-billed size and a `/new` suggestion.
- **`/context-fold` status** — fold position (usage %, next fold threshold), cache hit ratios,
  and yellow flags: second forced compaction, irreducible context past half the window, cold with
  a large carry ("a reset is economically free right now"), and recall churn. Advisory only —
  nothing blocks.

## Guarantees

- **History is never mutated.** Folding exists only in the per-call outgoing copy; the session
  file keeps every raw payload.
- **Nothing is destroyed.** Ground truth lives in the session file and the spool; every `{#code}`
  handle resolves through `recall`/`unfold` until spool GC ages it out (default 14 days).
- **Tool pairs cannot orphan.** Folding is in-place content substitution and never changes the
  message count, so a `tool_call` can never lose its `tool_result`. Structural, not policed.
- **Failure signals survive compression** at every fidelity level — the error lexicon is
  deliberately broad and any-case.
- **The automatic path is model-free.** No LLM call ever fires without an explicit opt-in.
- **Fail-open, bounded blast radius.** A defect costs one result's folding, one block's fidelity,
  or one turn's folding — never the turn itself. `CONTEXTFOLD=0` disables everything per session.
- **Deterministic core.** The pure core has no clock, no randomness, no I/O; all disk I/O lives
  in the adapter.

## Install

```bash
# Try it for one session, without installing:
pi -e npm:context-fold

# Install persistently:
pi install npm:context-fold

# Enable the ingestion gate (all models, or a comma-separated model-substring allowlist):
export CONTEXTFOLD_L0=1
```

From a clone, point Pi at the checkout instead: `pi -e /path/to/context-fold`.

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `CONTEXTFOLD` | _(on)_ | Master kill switch: `0`/`off` = the extension registers nothing this session. |
| `CONTEXTFOLD_FOLD_AT` | `0.45` | First fold when usage ≥ this fraction of the context window. |
| `CONTEXTFOLD_FOLD_STEP` | `0.12` | A fold event must save at least this fraction of the window (spaces events). |
| `CONTEXTFOLD_COLD_FOLD_AT` | `0.25` | First-fold threshold when no live cache read has ever been observed. |
| `CONTEXTFOLD_MAX_LAYERS` | `2` | Merge frozen-layer records past this count (bytes untouched). `0` = unbounded. |
| `CONTEXTFOLD_BUDGET_FRACTION` | `0.75` | Budget = this fraction of the context window… |
| `CONTEXTFOLD_BUDGET_CAP` | `200000` | …capped at this absolute ceiling (attention degrades at absolute depth). `0`/`off` disables. |
| `CONTEXTFOLD_TAIL` | `20000` | Protected-tail target — the newest ~N tokens never fold (clamped to half the budget). |
| `CONTEXTFOLD_COMPACT` | `det` | Hard-compaction answer: `det` = deterministic seed-index summary; `native` = Pi stock. |
| `CONTEXTFOLD_RECON_TOKENS` | `18000` | Reconstruction estimate used by the reset yellow flag (input-token equivalents). |
| `CONTEXTFOLD_L0` | _(off)_ | Ingestion gate: `1` = all models; comma-separated substrings = per-model allowlist; unset/`0` = inert. |
| `CONTEXTFOLD_L0_THRESHOLD` | `2000` | est-token size above which a result is spooled + born-folded. |
| `CONTEXTFOLD_L0_MINSAVE` | `0.5` | Minimum fraction the pointer must save to bother folding. |
| `CONTEXTFOLD_L0_ERRCAP` | `4` | Threshold multiplier for error-shaped results. |
| `CONTEXTFOLD_SPOOL_RETAIN_DAYS` | `14` | Spool GC window at session start. `0`/`off` = never delete. |
| `CONTEXTFOLD_DEBUG` | off | One-line fold/cache summary to stderr each turn. |
| `CONTEXTFOLD_DUMP` | _(unset)_ | Debug/e2e seam: write each turn's outgoing (folded) view to this JSON path. |

## Verification

```bash
npm install && npm run typecheck && npm test   # unit + integration suite

scripts/e2e-ladder.sh   # live: fold event fires, index emitted, head byte-stable, buried value recalled
scripts/e2e-gate.sh     # live: L0 gate folds a real flood; agent recovers a buried line via recall
scripts/e2e-resume.sh   # live: folds survive a session restart
```

The live scripts drive real Pi sessions and need provider auth (override the defaults with
`E2E_PROVIDER`/`E2E_MODEL`).

## Develop

```bash
npm install
npm run typecheck
npm test
```

The core (`src/core/*`) has zero harness dependencies; the Pi adapter (`src/adapters/pi/*`) owns
all I/O and hook wiring. Architecture notes are in `DESIGN.md`, the index format in
`docs/SEED_INDEX_SPEC.md`, the Pi APIs this leans on in `docs/pi-api-surface.md`, the record of
what shipped and why in `CHANGELOG.md`, and the publish checklist in `RELEASING.md`.

There is no build step: Pi loads the TypeScript source directly through jiti, so the package
ships `src/` as-is and installs no dependencies of its own.

`typebox` and the `@earendil-works/*` packages are peer dependencies that Pi injects at runtime —
never bundle a copy.

## Provenance & license

MIT. The pure core is ported from [Accordion](https://github.com/a-Fig/Accordion) (pinned commit
`0c22434`), stripped of UI coupling and hardened since; the discrete fold ladder, the L0 ingestion
gate, the seed index, and the advisor layers are original to this project.
