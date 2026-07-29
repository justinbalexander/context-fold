# context-fold rebuild handoff — seeded 2026-07-28

Status: DESIGN SEED for a dedicated rebuild session. Goal set by Jake:
rebuild context-fold for Pi (Claude Code as a stretch, see §5) so it has
**feature parity with Evoker's built-in compaction**, and bring it to a
state releasable to the Pi community. Publishing itself is owner-gated;
build to release-readiness, do not publish.

## Read first, in order

1. `~/projects/evoker/documentation/HANDOFF_COMPACTION_UX.md` — the
   ratified layered strategy (B/C/A) and policy rulings this rebuild
   implements. The rebuild is the *extension-side twin* of that packet.
2. `~/projects/evoker/documentation/COMPACTION_LITERATURE_2026-07-28.md`
   — the published evidence for the design.
3. `docs/HISTORY.md` + `REVIEW-2026-07-04.md` (this repo) — what the
   original build proved and what its review demoted.
4. `~/memory/wiki/platform/gpt-5-6-sol-context-management.md` — the
   verdict that killed the full Keel ladder ("do not globally reinstall
   the original full context-fold extension"; L0 $0.068 vs full Keel
   ~$1.471 with 17-recall loops).
5. `docs/pi-api-surface.md` (this repo) — the Pi extension API surface,
   incl. per-message `cacheRead`/`cacheWrite` telemetry.

## 1. Framing: redesign, not revival

This is not "turn the old ladder back on." The evidence (local corpus +
literature, converging) settled the architecture:

- **KEEP** from the existing codebase: the L0 ingestion gate (the one
  arm that won its eval), byte-exact sha256 spool + `recall`/`unfold`,
  risk-line retention at every fidelity level, budget accounting
  (`CONTEXTFOLD_BUDGET_CAP`, min(200k, fraction × window)), prefix-stable
  frozen layers + cache telemetry (Stage 1b/2, 2026-07-28), fail-open
  posture, `e2e-gate.sh` / `e2e-resume.sh` / `e2e-cache.sh`.
- **DROP**: the full Keel ladder as a default path (unstable, costly,
  recall-churn); model-written digests as anything but an explicit
  opt-in (the Phase-3 "win" was demoted to a mechanism demo, p≈0.09–0.12,
  and the shipped default was already deterministic); any automatic LLM
  summarization.
- **ADD** (the parity gap vs Evoker): discrete fold events with the
  threshold ladder (first fold ~40–50% window, +10–15% increments,
  consolidation at >2 layers, hard floor stop-and-ask); deterministic
  **seed index** emitted at every fold; span-based recall (not
  per-pointer paging — churn is the measured failure mode); opt-in
  summary as *handoff seed* with degradation warning; cold-session
  detection from Pi's cache telemetry; the price-agnostic reset yellow
  flag in input-token equivalents.

## 2. Shared spec: the seed index

The index format must be a **spec shared with Evoker** (and consumed by
`/recall` and autojournal), not an internal detail. Contents per fold:
files touched, commands run, error strings (lexicon must cover lowercase
`failed`/`npm ERR!` — a review finding), exact identifiers/numbers from
large tool outputs (the summary-boundary-loss class every arm dropped in
the Sol campaign), first lines of user messages, and byte offsets into
the on-disk log for span recall. Deterministic extraction only — grep
requires lexical match (NoLiMa), so the index is the lexical bridge.
Coordinate this spec with the autojournal design session (engine owns
substrate; extension/journal synthesis consumes it).

## 3. Parity matrix to build against

| capability | Evoker built-in | Pi extension (this rebuild) |
|---|---|---|
| B masking at discrete folds | engine | extension rewrites history via Pi API |
| C log + index + span recall | engine-owned substrate | extension-owned spool (exists) + new index |
| opt-in A w/ warning | TUI postframe prompt | extension prompt / command |
| threshold ladder | `ev.compaction_policy` | env/config, same defaults |
| cold detection | usage + catalog TTL | Pi `cacheRead` per message |
| effort barrier | `/new` keybind + gate | out of scope (harness-owned) |
| reset yellow flag | context meter | `/context-fold` status output |

Same defaults, same spec, same names wherever the harness allows —
parity is the point; divergences get documented, not improvised.

## 4. Release readiness (build now; publishing is Jake's gate)

- Extraction: context-fold is the only tracked package in the
  `~/projects/extensions` monorepo (neighbors deliberately untracked,
  one vendors a likely-retired tree). Community release almost certainly
  means extracting to a standalone repo with clean history — **owner
  decision** on extraction and naming; prepare for it, don't do it.
- Scrub estate specifics: no willow paths, no probe-key references, no
  journal/wiki links in shipped docs; sane `.gitignore`.
- License + README rewrite for an external audience (the current README's
  quantitative claims were demoted by review — the public README must
  carry the honest framing: deterministic reversible folding, evidence
  links, model digests opt-in).
- Known flake to fix or document: e2e-gate (c) dedup-path failure under
  model thrash (large duplicate result rendered unfolded).

## 5. Claude Code (stretch)

Claude Code exposes no API for rewriting live history, so B-layer folding
cannot be ported there. What ports is the **C layer**: a skill/hook pair
— session-log grep (the JSONL already exists) + `/recall`-style
reconstruction + index emission via hooks. Frame it as "context-fold
recall for Claude Code," not full parity. Do not block the Pi release
on it.

## 6. Verification

- Existing gates stay green: `e2e-gate.sh`, `e2e-resume.sh`,
  `e2e-cache.sh` (byte-identical folded head across turns/processes;
  measured on local lemonade, ~99% cacheRead hit).
- New: an index-fidelity test (planted identifiers mid-tool-output must
  appear in the emitted index — the summary-boundary probe class), and a
  churn guard (span recall over N pointers must cost fewer calls than N).
- The Evoker replay-fork A/B eval (5 arms, see HANDOFF_COMPACTION_UX §Open
  items) doubles as this rebuild's quality gate where applicable; the
  extension should be one of the runnable arms if feasible.
- Default-flip criteria from the 2026-07-28 cache work still stand:
  ≥3 winning e2e-cache runs + one real work session before
  `CONTEXTFOLD_PREFIX_STABLE` flips on by default.
