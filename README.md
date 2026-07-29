# context-fold

Deterministic, reversible context compaction for the [Pi coding agent](https://github.com/earendil-works/pi).
Long agentic sessions stay under budget by folding stale content out of the model's view — never
out of the session. Every fold is reversible, every fold is indexed, and no model is ever called
to do it.

**Requirements:** Node ≥ 22.19.0 and Pi ≥ 0.80. No build step and no runtime dependencies.

```bash
pi install npm:context-fold
```

## The idea

When a session runs long, something has to leave the model's context. The usual answer is to have
an LLM summarize the old part. That trades a token problem for an accuracy problem: the summary is
a paraphrase, and the details it drops are disproportionately the ones you needed.

context-fold takes the other route. Stale tool output is replaced with a short, deterministic
pointer, and the full text stays on disk. Nothing is rewritten, nothing is invented, and the agent
can pull any of it back on demand with `recall`. The context gets smaller; the session does not
get lossier.

## Why deterministic

The published evidence points the same way from several directions.

Deterministic masking of stale tool output matches or beats LLM summarization on agentic coding
tasks, at equal or lower cost ([The Complexity Trap](https://arxiv.org/abs/2508.21433),
[SWE-agent](https://arxiv.org/abs/2405.15793),
[Anthropic's context editing](https://claude.com/blog/context-management)).

LLM summaries lose exactly what matters. File and identifier trails are the weakest-preserved
category even in good production summarizers
([Factory.ai](https://factory.ai/news/evaluating-compression)). In one fixed-interval math
experiment, 40.4 % of post-summary answer-state transitions went from correct to wrong—even
though summarization was net positive overall
([Self-Compacting Agents](https://arxiv.org/abs/2606.23525)). A summary can also fabricate
instructions that then become post-compaction "ground truth"
([claude-code #46602](https://github.com/anthropics/claude-code/issues/46602)).

For precise recall, retrieval over raw stored history beats an in-context summary by a wide margin
([MemGPT](https://arxiv.org/abs/2310.08560), [LongMemEval](https://arxiv.org/abs/2410.10813)).
But grep only finds what lexically matches ([NoLiMa](https://arxiv.org/abs/2502.05167)) — which is
why every fold emits a deterministic index of exact tokens rather than a paraphrase.

## How the stages fit together

Compaction happens in stages, and it matters which one you are in. In the shipped default, none of
them calls a model.

**1. Ingestion — the L0 gate.** *(opt-in, `CONTEXTFOLD_L0`)* The moment a tool result lands, if it
is over ~2000 estimated tokens it is spooled to disk and enters the model's view already folded to
a pointer. This is the only stage that can act on a result before the model ever reads it.

**2. Per-turn — the fold ladder.** *(always on)* Once usage crosses ~45 % of the context window,
a fold event masks stale `tool_result` and `thinking` blocks. User intent, assistant conclusions,
and the record of every action are never touched.

**3. The floor.** When everything maskable is already masked, context-fold says so rather than
churning. What remains — user turns, the protected tail, anything you deliberately unfolded — is
the irreducible floor. context-fold cannot compress past it, and does not pretend to.

**4. Hard compaction.** *Pi* decides when this fires, not context-fold. By default
(`CONTEXTFOLD_COMPACT=det`) context-fold intercepts it and hands Pi a summary rendered verbatim
from the seed index, so Pi's LLM summarization never runs. Set `CONTEXTFOLD_COMPACT=native` to
opt back into Pi's stock behaviour.

At this stage the raw messages do leave live context — that is what compaction is. What survives
is the index, the spool, and Pi's session file, all on disk and all reachable through `recall`. So
the loss is bounded and reversible rather than lossy and final. There is no paraphrase step and
nothing that can hallucinate.

**5. Handoff.** *(manual, `/fold-handoff`)* Writes a seed file for starting a fresh session: the
same verbatim index plus the goal you state. Nothing is injected into context; nothing fires on
its own.

## What it does

### Discrete fold events

Between fold events the context is append-only. Rewriting history invalidates the provider's
prompt-cache suffix, so mutations are batched at points where that cost is paid once:

- First fold when usage crosses ~45 % of the context window (25 % when telemetry shows the session
  has never had a live cache read, since there is no warm prefix worth protecting).
- A fold event masks stale `tool_result`/`thinking` blocks outside the protected tail to their
  deterministic digests, keeping detected risk lines verbatim, and commits them as a *frozen layer*
  whose bytes never change again. The context head stays byte-identical turn over turn, which is
  what keeps prefix caches warm.
- Each further event needs at least a ladder step (~12 % of the window) of maskable mass. Crossing
  the absolute budget cap (`min(200k, 0.75 × window)`) folds immediately.

### The L0 ingestion gate

With `CONTEXTFOLD_L0` enabled, every tool result is observed as it lands — observe-only, so the
session file keeps the raw payload. A result over ~2000 estimated tokens is spooled to a
sha256-verified envelope and born folded: the view shows a ≤400-token pointer carrying the
`{#code FOLDED}` recovery tag, a tool-aware summary, head and tail, and every detected error or
risk line verbatim. Error-shaped results get 4× threshold headroom, so a short error never folds
away.

**Why it ships off, and when to turn it on.** A three-arm evaluation found the gate near-inert
where a capable model already scopes its own reads, and decisive where a flood genuinely lands: a
buried-error task went from 26,750 to 4,793 input tokens, a web-fetch task from 14,380 to 3,225.
It saves most of the cost where a flood lands and costs a few percent elsewhere. Turn it on if
your sessions read large files, run chatty build or test commands, or fetch web pages. Leave it
off if your agent already reads narrowly — you would be paying the pointer overhead for nothing.

The ladder alone cannot cover this case: it fires only at 45 % of the window and never touches the
protected tail, and a result that just landed is in that tail. The gate is the only stage that
acts at ingestion.

**Deferred substitution (`CONTEXTFOLD_L0_KEEP_RECENT`), and why it is still here.** The gate's known
failure mode is recall churn: born-folding on arrival means a model that reads several files gets
pointers back and must recall them, and the extra turns can out-cost the per-turn saving. Holding the
newest N registered blocks warm is the obvious mitigation, and its first live A/B did **not** support
it — on a task where every masked payload was needed again, the gate cost 141 % of the no-gate control
and deferral did not recover that. Churn turned out to be driven by the model needing *all* the masked
content, which an arrival-time policy cannot predict.

It is retained deliberately rather than reverted. That A/B was one adversarial shape at one run per
arm, and model recall-batching variance (three codes in one call in one arm, split across calls in
another) swamped the arms. The open question is whether a larger hold-out earns its keep on genuinely
chunky tool results, which is the next thing to test. Setting it to `0` is exactly the shipped
behaviour, so the flag costs nothing unset — do not remove it as dead weight without re-running that
comparison.

### The seed index

Every fold event appends one deterministic record to `seed-index.jsonl` in the session spool
directory (spec: `docs/SEED_INDEX_SPEC.md`): files touched, commands run, error lines in every
spelling the lexicon knows (lowercase `failed`, `npm ERR!`, …), exact identifiers and numbers
harvested from the masked output, first lines of user messages, and byte-extent spans into the
spool. Extraction is pure regex — same input, byte-identical output.

### Getting detail back

- `recall search=<term>` — one sweep over every folded block, with matching lines grouped by code.
  A detail lost somewhere behind N pointers costs one call, not N.
- `recall <code>`, with optional `grep=<term>` or `lines=<a-b>` — whole or partial retrieval,
  token-capped so a recall can never re-flood what folding saved.
- `unfold <code>` — sticky re-expansion. The block stays expanded and is never re-masked.

Recall works live, after resume, and after hard compaction: masked content resolves from the spool
even once the raw message has left history.

### Cold sessions and the reset flag

Measured prompt-cache telemetry (per-message `cacheRead`/`cacheWrite`) drives two advisories, in
price-agnostic input-token equivalents (fee *ratios* are near-constant across vendors: cache read
≈ 0.1× input).

- **Cold detection** — an expected-warm turn that read zero cached tokens gets one stderr notice
  with the re-billed size and a `/new` suggestion.
- **`/context-fold` status** — fold position (usage %, next fold threshold), cache hit ratios, and
  flags: a second forced compaction, irreducible context past half the window, cold with a large
  carry, and recall churn. Advisory only; nothing blocks.
- **Fold cost accounting** — once a fold event has fired, the status reports *both* sides: tokens
  masked per turn against tokens the provider re-prefilled because the fold moved the prefix, plus
  the running net. A fold rewrites history from the earliest masked block forward, so that
  re-prefill is a real cost this extension causes, and reporting only the savings would be
  dishonest accounting. It is charged to the single turn carrying the new bytes, because every
  later turn reads them back from cache. The cost side needs a provider that reports cache *writes*:
  Anthropic and Bedrock Converse do, while the Codex route reports cached reads only and Pi
  hardcodes Google's write to zero. Where writes are unreported the line says so instead of showing
  a zero — "nothing was rewritten" and "this provider never says" are different facts.

## Guarantees

- **History is never mutated.** Folding exists only in the per-call outgoing copy; the session
  file keeps every raw payload.
- **Nothing is destroyed.** Ground truth lives in the session file and the spool. Every `{#code}`
  handle resolves through `recall`/`unfold` until spool GC ages it out (default 14 days).
- **Tool pairs cannot orphan.** Folding is in-place content substitution and never changes the
  message count, so a `tool_call` can never lose its `tool_result`. Structural, not policed.
- **Failure signals survive compression** at every fidelity level — the error lexicon is
  deliberately broad and any-case.
- **No model is ever called.** Folding, digests, compaction, and the handoff seed are all
  deterministic. Nothing this extension produces is a paraphrase.
- **Fail-open, bounded blast radius.** A defect costs one result's folding, one block's fidelity,
  or one turn's folding — never the turn itself. `CONTEXTFOLD=0` disables everything per session.
- **Deterministic core.** The pure core has no clock, no randomness, and no I/O; all disk I/O
  lives in the adapter.

## Limitations

- **Token counts are estimates.** The estimator is a uniform ~4-characters-per-token heuristic, not
  a per-model tokenizer, so every threshold in the table below is approximate. It drives budget
  decisions well enough; do not read it as billing truth.
- **The tool names are generic.** The extension registers `recall` and `unfold` as global tools.
  If another extension registers the same names, one will shadow the other.
- **Tested against two Pi minors and one model family.** Pi 0.80.10 and 0.82.1, primarily with
  `gpt-5.6-sol` via the openai-codex provider. Other providers should work — the extension only
  reads Pi's usage numbers and message shapes — but this has not been broadly exercised.
- **Folding changes what the model sees.** A pointer is not the payload. Agents handle this well
  in practice (the teaching text explains the contract), but if you see an agent confused by a
  `{#code FOLDED}` marker, `CONTEXTFOLD=0` turns everything off for a session.
- **This is a 0.1.0.** The on-disk formats are versioned but not yet frozen.

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
| `CONTEXTFOLD_BUDGET_FRACTION` | `0.75` | Budget = this fraction of the context window… |
| `CONTEXTFOLD_BUDGET_CAP` | `200000` | …capped at this absolute ceiling (attention degrades at absolute depth). `0`/`off` disables. |
| `CONTEXTFOLD_TAIL` | `20000` | Protected-tail target — the newest ~N tokens never fold (clamped to half the budget). |
| `CONTEXTFOLD_COMPACT` | `det` | Hard-compaction answer: `det` = deterministic seed-index summary; `native` = Pi stock. |
| `CONTEXTFOLD_RECON_TOKENS` | `18000` | Reconstruction estimate used by the reset flag (input-token equivalents). |
| `CONTEXTFOLD_L0` | _(off)_ | Ingestion gate: `1` = all models; comma-separated substrings = per-model allowlist; unset/`0` = inert. |
| `CONTEXTFOLD_L0_THRESHOLD` | `2000` | est-token size above which a result is spooled + born-folded. |
| `CONTEXTFOLD_L0_MINSAVE` | `0.5` | Minimum fraction the pointer must save to bother folding. |
| `CONTEXTFOLD_L0_KEEP_RECENT` | `0` | Deferred substitution: hold the newest N gate-registered blocks at full fidelity and fold them only once stale. `0` = born-folded (cheapest per turn); non-zero trades those tokens against recall round trips. Spooling is unaffected, so held blocks stay recallable. Retained as an experiment — see the note below before removing it. |
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

The live scripts drive real Pi sessions and need provider auth plus `python3`. They load the
working copy explicitly, so they test the checkout rather than an installed build. Override the
model with `E2E_PROVIDER` / `E2E_MODEL`.

## Develop

```bash
npm install
npm run typecheck
npm test
```

The core (`src/core/*`) has zero harness dependencies; the Pi adapter (`src/adapters/pi/*`) owns
all I/O and hook wiring. Architecture notes are in `DESIGN.md`, the index format in
`docs/SEED_INDEX_SPEC.md`, and the Pi APIs this leans on in `docs/pi-api-surface.md`.

There is no build step: Pi loads the TypeScript source directly through jiti, so the package ships
`src/` as-is and installs no dependencies of its own.

`typebox` and `@earendil-works/pi-coding-agent` are declared as optional peer dependencies. Pi
injects them at runtime — never bundle a copy.

## Provenance & license

MIT. The pure core is ported from [Accordion](https://github.com/a-Fig/Accordion) (pinned commit
`0c22434`), stripped of UI coupling and hardened since; the discrete fold ladder, the L0 ingestion
gate, the seed index, and the advisor layers are original to this project.
