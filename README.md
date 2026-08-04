# context-fold
Note: I will be slowly cleaning up my documentation as I come across things I don't like; consider it half LLM written and half cleaned up and properly edited.

Deterministic, reversible context compaction for the [Pi coding agent](https://github.com/earendil-works/pi).
Long agentic sessions stay under budget by folding stale content (long chains of tool calls) out of the model's view. 
Every fold is reversible, indexed, and done deterministically. The core product is intended to be harness agnostic
and can be adapted to other coding harnesses with some work.

**Requirements:** Node ≥ 22.19.0 and Pi ≥ 0.80.

```bash
pi install npm:context-fold
```

## The idea

In short context management is annoying and I know plenty of people who are too lazy to summarize and handoff to new
sessions and they let context grow unmanaged right up until they smash the /compact command at some point. This system was
derived via iterative research over various compacting methodologies and represents an attempt at economically optimizing
context over long sessions and eating as few cache read hits as possible until you decide to end the session or the work is complete. 

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

## the system in short

**1. Ingestion: the L0 gate.** *(opt-in, `CONTEXTFOLD_L0`)* The moment a tool result lands, if it
is over ~2000 estimated tokens it is spooled to disk and enters the model's view already folded to
a pointer. This is the only stage that can act on a result before the model ever reads it. (Note: this 
is off by default until I can do more testing on what proper thresholds are for cutoff as of right now
the results are mixed on how useful it actually is)

**2. Per-turn: the fold ladder.** *(always on)* Once usage crosses ~45 % of the context window,
a fold event masks stale `tool_result` and `thinking` blocks. User intent, assistant conclusions,
and the record of every action are never touched. (Note: this threshold is also a moving target and may
be adjusted if I am able to determine a sane default that optimizes the initial cache write hit vs the amount of times
you might compact over the course of a session.)

**3. The floor.** Eventually you will reach a point where no more tool calls can be masked, at that 
 point context-fold says so rather than churning. What remains is the irreducible floor, context-fold cannot compress past it.

**4. Hard compaction.** *Pi* default compaction decides when this fires. By default
(`CONTEXTFOLD_COMPACT=det`) context-fold intercepts it and hands Pi a summary rendered verbatim
from a session derived seed index, so Pi's LLM summarization never runs. Set `CONTEXTFOLD_COMPACT=native` to
opt back into Pi's stock behaviour.

At this stage the raw messages do leave live context — that is what compaction is. What survives
is the index, the spool, and Pi's session file, all on disk and all reachable through `recall`. So
the loss is bounded and reversible rather than lossy and final. 

There is no paraphrase step and nothing that can hallucinate. The tool should warn you after a hard compaction occurs 
more than once and it's highly suggested to run a handoff long before this happens when you are at a definable task finish line.

**5. Handoff.** *(manual, `/fold-handoff`)* Writes a seed file for starting a fresh session: the
same verbatim index plus the goal you state. 

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
  the absolute budget cap (`min(200k, 0.75 × window)`) folds immediately. (Note: the threshold is a moving target just like previously flagged values.)

### The L0 ingestion gate (Note: I may change this term at some point, it was a random vibeslop term that I just didn't get rid of)

With `CONTEXTFOLD_L0` enabled, every tool result is observed as it lands, so the
session file keeps the raw payload. A result over ~2000 estimated tokens is spooled to a
verified envelope and born folded: the view shows a ≤400-token pointer carrying the
`{#code FOLDED}` recovery tag, a tool-aware summary, head and tail, and every detected error or
risk line verbatim. Error-shaped results get 4× threshold headroom, so a short error never folds
away.

**Why it ships off, and when to turn it on.** A three-arm evaluation found the gate near-inert
where a capable model already scopes its own reads, and decisive where a flood genuinely lands: a
buried-error task went from 26,750 to 4,793 input tokens, a web-fetch task from 14,380 to 3,225.
It saves most of the cost where a flood lands and costs a few percent elsewhere. Turn it on if
your sessions read large files, run chatty build or test commands, or fetch web pages. Leave it
off if your agent already reads narrowly or you will be paying the pointer overhead for nothing.

**Deferred substitution (`CONTEXTFOLD_L0_KEEP_RECENT`).** The gate's known failure mode is recall churn: born-folding on arrival means a model that reads several files gets 
pointers back and must recall them, and the extra turns can out-cost the per-turn saving. Holding the
newest N registered blocks warm is the obvious mitigation, and its first live A/B did **not** support
it. On a task where every masked payload was needed again, the gate cost 141 % of the no-gate control
and deferral did not recover that. Churn turned out to be driven by the model needing *all* the masked
content, which an arrival-time policy cannot predict. It is retained deliberately for more testing

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
- **`/context-fold` status** — fold position (usage %, the next-fold gauge), cache hit ratios, and
  flags: folds committed but not observed on the wire, a second forced compaction, irreducible
  context past half the window, cold with a large carry, and recall churn. Advisory only; nothing
  blocks.
- **Footer status line (TUI)** — a persistent one-line summary in Pi's footer (`⧉ context-fold ×3
  · ~41k tok masked · next fold: 3.1k/9.6k maskable · cache avg 66%`), updated as fold events
  fire. Purely visual: nothing is added to the transcript or the model's context, and headless
  modes are unaffected. The middle segment is the ladder's trigger gauge, and it shows whichever
  fold condition is actually binding: below the entry threshold it names it (`next fold at 45%
  ctx`); once usage is past the threshold — permanently satisfied from then on — it tracks
  maskable mass toward the next fold step (`next fold: 3.1k/9.6k maskable`); and when nothing
  maskable remains it says `no more folds possible` (with an `(over budget)` warning variant when
  the irreducible tail/roots exceed the budget). `cache avg` is the whole-session cache hit
  ratio, unlike Pi's `CH`, which is the last turn only.
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
- **Images are invisible to the budget math.** A tool result carrying non-text parts (screenshots,
  rendered pages) is never folded — neither by the gate nor the ladder, so nothing is ever lost —
  but its real token cost is not counted either. Image-heavy sessions read as further from the fold
  threshold than they are, so folding starts later than it should.
- **The tool names are generic.** The extension registers `recall` and `unfold` as global tools.
  If another extension registers the same names, one will shadow the other.
- **Tested against two Pi minors and one model family.** Pi 0.80.10 and 0.82.1, primarily with
  `gpt-5.6-sol` via the openai-codex provider. Other providers should work — the extension only
  reads Pi's usage numbers and message shapes — but this has not been broadly exercised.
- **Folding changes what the model sees.** A pointer is not the payload. Agents handle this well
  in practice (the teaching text explains the contract), but if you see an agent confused by a
  `{#code FOLDED}` marker, `CONTEXTFOLD=0` turns everything off for a session.
- **This is a 0.1.0.** The on-disk formats are versioned but not yet frozen.

## Known integrations

Findings from running context-fold beside other Pi extensions. The common theme: a fold can be
committed and correct locally yet still be discarded or deferred downstream, which is why the
extension now watches provider usage for exactly that (see the wire watchdog note below).

- **`@howaboua/pi-codex-conversion` defers folds to user-turn boundaries.** Its cached WebSocket
  continuation answers a mid-chain prefix change by sending only the pending tool output as a
  delta against the server-held previous response, so a fold's rewrite of older history stays
  local for the rest of that tool chain. At the next user message there is no pending tool
  output, the changed prefix forces a full resend, and provider-reported input drops all at once.
  Folding still works — recall, the spool, and compaction are unaffected — but a long autonomous
  tool chain can approach the provider's context limit before any fold takes effect on the wire.
- **Pi `context` hooks do not chain: load order decides.** Every handler receives the original
  event and the last non-`undefined` return wins (verified in Pi 0.80–0.83). Two extensions
  rewriting `context` are mutually destructive: list context-fold *after* any other
  context-rewriting extension in `settings.json` `packages` so its folds are the surviving
  rewrite. The same last-wins rule applies to `session_before_compact` and `before_agent_start`.
- **Do not load the package twice.** `pi install npm:context-fold` plus a `-e npm:context-fold`
  flag registers `recall`/`unfold` twice and fails loudly at load with a tool-name conflict.
  Installed or `-e`, pick one.

**The wire watchdog.** Because every one of these failure modes is invisible in the extension's
own output, the telemetry checks the outcome instead: a fold that masked tokens strictly shrinks
the outgoing prompt, so if the next turn's provider usage reads the whole pre-fold prompt back
from cache, the rewrite provably never reached the wire. When that happens the extension warns
once per session on stderr and raises a flag in `/context-fold` and the footer status line.

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
| `CONTEXTFOLD_L0_KEEP_RECENT` | `0` | Deferred substitution: hold the newest N gate-registered blocks at full fidelity and fold them only once stale. `0` = born-folded (cheapest per turn); non-zero trades those tokens against recall round trips. Spooling is unaffected, so held blocks stay recallable. Retained as an experiment — see the deferred-substitution note under *The L0 ingestion gate* before removing it. |
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
