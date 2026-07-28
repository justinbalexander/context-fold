# context-fold

Reversible in-session context compaction for CLI coding agents. Harness-agnostic pure core + a
thin Pi/Willow adapter. It keeps a long agentic session under its token budget by **folding cold
content out of the model's view** — never out of the session — and gives the agent tools to pull
any folded detail back verbatim. See `DESIGN.md` for the rationale, `docs/HISTORY.md` for the
phase-by-phase build record and eval evidence, and `docs/` for the port spec + Pi API surface.

## Why

Two things kill long agentic sessions:

1. **Token floods.** One `read` of a 12k-token file or one pytest wall costs its full weight on
   *every subsequent turn* — long after its marginal value hit zero.
2. **Lossy compaction.** Native summarize-and-truncate destroys detail permanently, and the detail
   it destroys is exactly what mattered: the buried `ImportError`, the one line with the real
   config value. (The "rtk failure mode": a failure signal reduced to a summary line.)

context-fold's answer: **context is a view, not a store.** The session history stays complete on
disk; only the outgoing message array is compressed, every compression is tagged with a recovery
handle, and error/risk lines ride every compressed form verbatim.

## What it does, end to end

### 1. Big tool results fold the moment they land (the L0 ingestion gate)

When the gate is on for the active model (`CONTEXTFOLD_L0`), every tool result is observed as it
lands (observe-only — the result itself is never mutated, so the session jsonl keeps raw ground
truth). A result over `CONTEXTFOLD_L0_THRESHOLD` est-tokens (default 2000; error-shaped results
get 4× headroom so a short error is never folded away) is:

- **Spooled** — the raw payload is written to `<sessionDir>/spool/<sessionId>/<code>.json` as a
  sha256-verified envelope (atomic write; identical payloads dedup to a tiny alias file), and
- **Born-folded** — in the model's view it appears as a ≤400-token **pointer**: the
  `{#<code> FOLDED}` recovery tag, a tool-aware summary (path/pattern/command + sizes), the head +
  tail, and **every detected error/risk line verbatim** (up to 40).

The agent is taught the contract once per session: when the gate is active, ≤6 lines are appended
to the system prompt explaining the pointers and the `recall`/`unfold` tools.

### 2. Every turn, the outgoing view is folded to budget (Keel)

Before each model call, the `context` hook hands the extension a deep copy of the outgoing
messages. The deterministic **Keel** policy folds it to fit `budgetFraction` (default 0.75) of the
context window, protecting the newest ~`CONTEXTFOLD_TAIL` tokens (default 20k, clamped to half the
budget). Per pass:

1. **Under budget → do nothing** (the common case; a no-op pass is ~free).
2. **Roots** — the user's messages/spec, the protected tail, and anything the agent has explicitly
   unfolded are never touched.
3. **Relevance** — remaining blocks are ranked coldest-first: entity reachability from current
   work, risk stickiness (blocks carrying errors/values/decisions fold later), and an ACT-R
   recency/frequency score.
4. **Epoch hold** — while the projection stays comfortably under cap, the previous fold plan is
   re-emitted verbatim (stable views, warm provider cache). Pressure opens a new epoch.
5. **Fidelity ladder** — each cold block is routed to the *shallowest* level that pays (see table).
6. **Hard-cap floor** — if the ladder alone can't reach the cap, whole provider messages are
   grouped/dropped at message granularity with tool call/result pairs kept together, booking only
   savings the applier will actually honor. Telemetry reports what actually shipped.

The real session history is never modified; folding exists only in the outgoing copy.

### 3. The fidelity ladder

| level | applies to | becomes | reversible? |
|---|---|---|---|
| L0 full | roots, tail, held blocks | unchanged | — |
| L1 skeleton | large code-file reads | imports/types/signatures; bodies elided, with risk-flag body lines (`TODO`/`FIXME`, `throw`/`raise`/`panic!`) kept **in place** (≤4/body) | ✓ `{#code}` |
| L2 trim | long prose / non-code results | ~25% extractive excerpt: head + tail + **all risk lines** + longest lines | ✓ `{#code}` |
| L3 digest | any cold block (the floor for the ladder) | one-line per-kind digest + up to 6 risk lines verbatim | ✓ `{#code}` |
| L4 group | whole cold spans (budget floor only) | one group summary line | ✓ `{#code}` |
| L5 drop | last resort (budget floor only) | removed from the view | history + spool intact |

The invariant across every level: **a failure signal never reduces to a summary line.** The risk
detector is deliberately broad and any-case (`error`, lowercase `failed`, `fatal`, `npm ERR!`,
`Segmentation fault`, `Permission denied`, `✗`, stack traces, …).

### 4. Getting detail back (`recall` / `unfold`)

Every folded form carries a `{#<code> FOLDED}` handle. The agent (or you) can:

- `recall {code}` — the whole result (token-capped at ~2000 with paging notes, so a recall can
  never re-flood what folding saved);
- `recall {code} grep=<term>` / `recall {code} lines=<a-b>` — partial retrieval straight off the
  spool (grep and line slices share one numbering space);
- `unfold {code}` — expand a fold and *hold* it expanded across subsequent turns.

Recall is fail-explicit: a missing/corrupt spool file throws a typed error naming the path —
never silently wrong bytes.

### 5. Sessions: resume, switching, retention

- **Resume:** every gate fold is event-sourced into the session ledger. On `session_start` the
  registry is rebuilt and each spool file revalidated; folds whose spool vanished are dropped and
  render raw (visible in debug as "dropped N (missing spool)"). Session switches within one
  process reset all per-session state.
- **Retention (spool GC):** at session start, sibling session-spool dirs with no file newer than
  `CONTEXTFOLD_SPOOL_RETAIN_DAYS` (default 14) are deleted whole. The current session's spool is
  never touched; a reaped spool degrades exactly like a missing one. `0`/`off` disables GC.

### 6. Optional: a local model in the loop

Off by default; the deterministic path above is the shipped baseline. With `CONTEXTFOLD_MODEL`
set, a local model (default `Qwen3.5-4B-MTP-GGUF` via Lemonade) writes **better digest strings**
for L3 folds — it preserves mid-block identifiers a head-line digest structurally drops. With
`CONTEXTFOLD_COLDNESS=1` it also flags cold candidates "keep warm" so they fold last.

The model is never load-bearing: **Keel still decides what folds**, model calls run async
fire-and-cache at epoch boundaries (the synchronous fold pass is ~76ms even at 110k tokens; model
digests apply next turn), every digest is validated and priced into the budget projection,
tag-shaped output is stripped (the engine stays the sole `{#code}` author), and any failure falls
back to the deterministic digest.

The folding model only ever sees one ~2000-token block per call, so a small loaded context window
(4096) is plenty — but few server slots means the writer runs at low concurrency (default 2).
Raise `CONTEXTFOLD_MODEL_CONCURRENCY` if you load the model with a larger window.

## Guarantees

- **History is never mutated.** Folding exists only in the per-call outgoing copy; the session
  jsonl keeps every raw payload (trace-mining and post-hoc debugging see everything).
- **Nothing is destroyed.** Ground truth lives in the jsonl and the spool; every `{#code}` handle
  resolves through `recall`/`unfold` until spool GC ages it out.
- **Failure signals survive compression** at every level (pointer, skeleton, trim, digest).
- **Budget claims are honest.** The floor books only savings the applier will honor; model digests
  are priced in. (The Phase-5 review repro: 46,069 tokens shipped against a 6,000 cap with
  under-budget telemetry → 4,569 shipped with an honest claim.)
- **Fail-open, bounded blast radius.** A defect in the gate costs one result's folding; in the
  skeletonizer, one block's fidelity; in the fold pass, one turn's folding. Never the turn itself.
- **Kill switches:** `CONTEXTFOLD=0` disables the whole extension for a session without touching
  the install symlink; `CONTEXTFOLD_L0` gates the gate per model, re-resolved every turn and
  honored on resume. Prior spools stay recallable with everything off.
- **Deterministic core.** The pure core has no `Date`, no randomness, no I/O — same input,
  byte-identical output. All disk I/O lives in the adapter.

## Install & usage

```bash
# Load the extension into a Pi session:
pi -e /home/willow/projects/extensions/context-fold/src/adapters/pi/index.ts

# Or install via the self-built-tooling convention: a SYMLINK into ~/.pi/agent/extensions.
# NOTE dev == prod under a symlink: an edit in this repo is live in every new Pi session
# immediately. Keep main green; use CONTEXTFOLD=0 to disable a session without touching the link.
ln -sfn /home/willow/projects/extensions/context-fold ~/.pi/agent/extensions/context-fold
```

`/context-fold` reports fold status plus measured prompt-cache telemetry (session cacheRead/
cacheWrite totals and hit ratios, read from Pi's per-message provider usage). With
`CONTEXTFOLD_DUMP` set, a `<dump>.telemetry.json` sidecar carries the same numbers for e2e
assertions; `CONTEXTFOLD_DEBUG=1` prints the cache line each assistant turn.

Enable the L0 gate per model with the allowlist form, e.g.
`export CONTEXTFOLD_L0='Qwen3.6,gpt-5.6'` (current host rollout; gpt-5.5 remains excluded after its
Phase-4 eval wash in `docs/HISTORY.md`, while GPT 5.6 passed a live fold + partial-recall recovery
check). Pi is shell-launched, so an `export` in `~/.bashrc` is the rollout switch.
**Non-shell launch contexts** (cron, a service unit, an IDE that does not inherit your login
shell) must set `CONTEXTFOLD_L0` themselves — `~/.pi/agent/settings.json` has no env facility.

### Tuning (env vars)

| Var | Default | Meaning |
|---|---|---|
| `CONTEXTFOLD` | _(unset → on)_ | **Master kill switch.** `0`/`off`/`false` = the extension registers nothing this session. |
| `CONTEXTFOLD_BUDGET_FRACTION` | `0.75` | Fold to keep live tokens ≤ this fraction of the context window. |
| `CONTEXTFOLD_BUDGET_CAP` | `200000` | Absolute ceiling on the fold budget: `budget = min(cap, fraction × context window)`. Attention degrades at an absolute depth, so a 1M-window model still folds around 200k. `0`/`off` disables the ceiling. |
| `CONTEXTFOLD_TAIL` | `20000` | Protected-tail token target — the newest ~N tokens never fold. Clamped to half the budget. |
| `CONTEXTFOLD_DEBUG` | off | Set to `1` to print a one-line fold summary to stderr each turn. |
| `CONTEXTFOLD_MODEL` | _(unset → off)_ | Phase-2 digests. `1` = default model (`Qwen3.5-4B-MTP-GGUF`), or a model id. Unset = deterministic Phase 1. |
| `CONTEXTFOLD_COLDNESS` | off | `1` = Phase-2 rep 2: the model also decides which cold blocks stay warm (uses the same model conn). |
| `CONTEXTFOLD_MODEL_THINK` | off | `1` = leave hybrid-reasoning "thinking" ON (default OFF — required for Qwen3.x digests). |
| `CONTEXTFOLD_MODEL_URL` | `http://localhost:13305/api/v1` | OpenAI-compatible base URL (Lemonade). |
| `CONTEXTFOLD_MODEL_KEY` | `sk-local` | API key for the model endpoint. |
| `CONTEXTFOLD_MODEL_MAXBLOCKS` | `8` | Max cold blocks digested per epoch (bounds model calls). |
| `CONTEXTFOLD_MODEL_CONCURRENCY` | `2` | Max parallel digest calls. Keep ≤ the model server's parallel slots (a small context window has few). Raise it if you give the model a larger window. |
| `CONTEXTFOLD_L0` | _(unset → off)_ | The L0 ingestion gate. `1` = on for all models; a comma-separated list of model-identity substrings = on only when the active provider, id, or display name matches one (per-model rollout, including dynamic aliases such as `lemonade-current/current`). Unset/`0` = inert. |
| `CONTEXTFOLD_L0_THRESHOLD` | `2000` | est-token size above which a tool result is spooled and born-folded to a pointer. |
| `CONTEXTFOLD_L0_MINSAVE` | `0.5` | Minimum fraction the pointer must save vs the full result to bother folding. |
| `CONTEXTFOLD_L0_ERRCAP` | `4` | Threshold multiplier for error-shaped results — a short error is never folded away. |
| `CONTEXTFOLD_SPOOL_RETAIN_DAYS` | `14` | Spool GC window: at session start, sibling session spools with no file newer than this are deleted. `0`/`off` = never delete. |
| `CONTEXTFOLD_DUMP` | _(unset)_ | Debug/e2e seam: write each turn's outgoing (folded) view to this JSON path. |

## Status

Phases 1–6 shipped as of 2026-07-04 (`docs/HISTORY.md` has the full record and eval evidence):
deterministic folding core, optional model digests/coldness, the L0 ingestion gate with
spool/recall/resume, adversarial-review hardening, spool GC, and L1 risk-line retention.
164 tests + typecheck green; both live e2e scripts (`scripts/e2e-gate.sh`, `scripts/e2e-resume.sh`)
ALL PASS — a 64KB read folds 12,810 → ~400 tokens and the agent recovers a buried line via recall
it never saw raw, including across a session restart.

### Next

- gpt-5.5: reduce recall churn on many-file error hunts (arm C / outboard already recovers it — make it default there).
- An agentic willow arm that lets the agent `unfold` — to measure det-fold's reversibility edge.
- Wave-4a: a retrieval index over the spool (the envelope is already index-ready).

### Constraint from the warm-cache measurements (2026-07-06)

Local inference caches prompts by **prefix**: on the production Qwen3.6-35B a byte-stable
prefix re-sent every turn answers in ~0.16 s at any depth (26–219× vs cold prefill), but any
edit invalidates everything from the edit point down — and on this hybrid-SSM model no
llama.cpp flag (`--cache-reuse`, slot save/restore) can shift-reuse the tail past an edit.
Recompute costs ~1.1 s per 1k tokens of post-edit tail. **Design consequence for folding:
edits placed early in standing context forfeit the warm cache for the whole conversation
below them.** Prefer folding shapes that keep the head of the context byte-stable and mutate
as late (as close to the tail) as possible; a fold that rewrites an early message costs the
next turn a near-full re-prefill, which can exceed the tokens the fold saved. Numbers +
method: `~/library/jake/strix-testbench/parallelism/CAMPAIGN.md`, warm-cache lane section.

## Develop

```bash
npm install      # vitest + typescript + @types/node
npm run typecheck
npm test
```

The core has **zero** harness dependencies. The adapter typechecks against Willow's real
`ExtensionAPI` types via `tsconfig.json` path aliases (no Pi package install needed); at runtime
Willow's loader provides the bundled modules.

## Provenance

The pure core and Keel policy are ported from [Accordion](https://github.com/a-Fig/Accordion) at
pinned commit `0c22434`, stripped of all Svelte/Tauri/browser coupling. `digest.ts` and `tokens.ts`
are near-verbatim; the rest is faithful structural ports retargeted to this port's block model,
locally hardened since (see `docs/HISTORY.md`, Phase 5–6).
