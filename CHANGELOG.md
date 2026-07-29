# Changelog

Notable changes to context-fold.

## 0.1.0

First public release. context-fold was developed privately before this point, so this entry
describes what the package does rather than how it got here.

### What it does

- **The discrete fold ladder** — the folding policy. Fold events fire at thresholds (~45 % of the
  context window, 25 % when telemetry shows no live cache read has ever landed) and must save at
  least a ladder step (~12 %) to fire at all; crossing the absolute budget cap folds immediately.
  Between events the context is append-only, so the provider's prompt cache keeps hitting.
- **Prefix-stable frozen layers.** Each fold event's substitutions commit as a layer whose bytes
  never change again, persisted verbatim so a resumed session's context head is byte-identical to
  the one the provider already cached.
- **The L0 ingestion gate** (`CONTEXTFOLD_L0`, off by default). Large tool results are spooled to
  disk and enter the model's view already folded to a `{#code FOLDED}` pointer, so a flood never
  reaches full-fidelity context at all.
- **Reversible by design.** Folding rewrites only the outgoing copy of the conversation; the
  session history on disk is never touched. Any folded block comes back through `recall {code}`,
  `recall {code} grep=<term>`, or `recall {code} lines=<a-b>`. `unfold {code}` keeps it expanded.
- **`recall search=<term>`** — one sweep over every folded block, matching lines grouped by code,
  so a detail lost somewhere behind N pointers costs one call rather than N.
- **The seed index** (`docs/SEED_INDEX_SPEC.md`) — one deterministic record appended to
  `seed-index.jsonl` at every fold event: files touched, commands run, error lines in every
  spelling the lexicon knows, exact identifiers harvested from the masked output, first lines of
  user messages, and byte extents into the spool. Pure regex extraction: same input, byte-identical
  output.
- **Deterministic hard compaction** (`CONTEXTFOLD_COMPACT=det`, the default). When Pi's own
  compaction fires, the extension supplies a summary rendered verbatim from the seed index instead
  of an LLM rewrite. Every listed token is a lexical hook for `recall`. `native` restores Pi's stock
  behaviour.
- **`/fold-handoff`** — writes a seed for a fresh session: the deterministic index plus the goal you
  state on the command line. Nothing is injected into context; nothing fires on its own.
- **No model calls anywhere.** Every path in the package — folding, digests, compaction, the
  handoff seed — is deterministic. There is no hallucination surface because nothing is generated.
- **Fail-open throughout.** A gate, index, spool, or fold failure costs that piece of work and says
  so on stderr; it never costs the turn. `CONTEXTFOLD=0` disables the extension entirely.
- **Cache telemetry and the advisor.** Measured per-message `cacheRead`/`cacheWrite` drives cold
  detection (one stderr notice when an expected-warm turn reads zero cached tokens) and the
  `/context-fold` status command's flags.
- **Fold-cost accounting.** Cache telemetry attributes re-prefill to context-fold's own fold
  events, and `/context-fold` plus the `CONTEXTFOLD_DEBUG` line report both sides: tokens masked
  per turn against tokens the provider re-prefilled because the fold moved the prefix, plus the
  running net. The cost is charged to the single turn carrying the new bytes, since every later
  turn reads them back from cache. Measuring it needs a provider that reports cache *writes*; where
  they are unreported the status says so rather than showing a zero — "nothing was rewritten" and
  "this provider never says" are different facts.
- **Deferred L0 substitution** (`CONTEXTFOLD_L0_KEEP_RECENT`, default `0` = born-folded). Holds the
  newest N gate-registered blocks at full fidelity, folding them once stale, as a mitigation for
  recall churn. Experimental: its first live A/B did not support it, and the README records the
  reasoning and the open question that keep the flag alive.

### Behaviour worth knowing

- The error lexicon deliberately covers lowercase and tool-specific spellings — `failed`, `fatal`,
  `npm ERR!`, `Segmentation fault`, `Permission denied`, `✗`, tracebacks — because a test-runner
  wall that reports `isError=false` would otherwise fold at the normal threshold and drop its
  failure line. Detected risk lines are kept verbatim inside the pointer.
- Every recall surface clips and windows single enormous lines. A payload arriving as one 40 KB
  line would otherwise ride through the caps on an "always keep at least one line" rule and undo
  what folding saved.
- Token counts are estimates (~4 characters per token), not a per-model tokenizer, so every
  threshold is approximate.

### Evidence

Deterministic masking of stale tool output matches or beats LLM summarization on agentic coding
tasks at equal or lower cost ([The Complexity Trap](https://arxiv.org/abs/2508.21433),
[SWE-agent](https://arxiv.org/abs/2405.15793)), while LLM summaries measurably lose exactly what
matters — file and identifier trails are the weakest-preserved category even in good production
summarizers ([Factory.ai](https://factory.ai/news/evaluating-compression)) — and summaries can
fabricate instructions that then become post-compaction ground truth. For precise recall, retrieval
over raw stored history beats an in-context summary by a wide margin
([MemGPT](https://arxiv.org/abs/2310.08560),
[LongMemEval](https://arxiv.org/abs/2410.10813)), but grep only finds what lexically matches
([NoLiMa](https://arxiv.org/abs/2502.05167)) — which is why every fold emits a deterministic index
of exact tokens rather than a paraphrase.

A three-arm evaluation of the L0 ingestion gate found it near-inert where a capable model already
scopes its own reads, and decisive where a flood genuinely lands: a buried-error task went from
26,750 to 4,793 input tokens, a web-fetch task from 14,380 to 3,225. It saves most of the cost
where a flood lands and costs a few percent elsewhere — not a flat ratio. That is why it ships off
by default.

Fold thresholds were measured before settling on the defaults: folding *earlier* is worse. The
dominant cost is the number of fold events rather than the size of any one re-prefill, so a tighter
budget fired more events and spent more input tokens for fewer cache reads. Fidelity held at every
threshold, with planted risk lines preserved verbatim inside every folded digest.
