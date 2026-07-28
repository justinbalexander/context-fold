# Phase 6 — spool retention + L1 risk-line retention

The two deferred items from the 2026-07-04 adversarial review (README "Next"). Both are
self-contained; the remaining Next items (gpt-5.5 churn, agentic-unfold arm, Wave-4a retrieval)
are experiments sequenced elsewhere and stay queued.

## 1. Spool retention policy (spool GC)

**Problem.** The extension never deletes spool files; cleanup is unowned. Fine at today's volume,
unbounded on a 24/7 box.

**Design.** Age-based GC at directory granularity, run once per session at `session_start`.

- New `src/adapters/pi/retention.ts`: `sweepSpools(spoolRoot, keepSessionId, retainMs, now?)` —
  for each `<spoolRoot>/<sid>` dir other than the current session's, find the newest file mtime
  inside; if older than the retention window, `rmSync` the whole dir. Per-dir fail-open.
- Directory granularity is what makes this safe: dedup aliases only ever point at siblings in the
  same dir, so whole-dir deletion can never dangle an alias.
- A resumed session whose spool was reaped already degrades correctly: `revalidateSpools` drops
  those folds ("dropped N (missing spool)") and renders them raw; a recall on a reaped code throws
  the typed SpoolError (fail-explicit, D16). No new failure mode — GC just makes the existing
  missing-spool path reachable by age.
- Env: `CONTEXTFOLD_SPOOL_RETAIN_DAYS`, default 14. `0`/`off` disables GC entirely.
- Wire into `index.ts` `session_start` before the fold-state restore (order-independent; the sweep
  never touches the current session). Debug line when anything is reaped; stderr line on failure.

**Success criteria.** Tests: reaps only dirs past the window; never the current session's dir;
freshness judged by newest file inside; `0` disables; unreadable entries skipped fail-open.
Existing suite stays green.

## 2. L1 skeleton risk-line retention

**Problem.** The skeletonizer elides callable bodies wholesale — a `throw`, `raise`, `panic!`, or
`TODO/FIXME` buried in a body vanishes from the skeleton, while L2's trim keeps such lines
unconditionally.

**Design.** Retain risk-flag body lines in place during body elision, in `skeletonize.ts` (module
stays self-contained — this is a CODE-risk detector, not the ledger's tool-output detector; the
ledger's `exact_values` bucket would match nearly every assignment in source code).

- `isRiskBodyLine(origLine, maskLine)`: `TODO|FIXME|XXX|HACK` matched on the ORIGINAL line
  (comment content is blanked in the mask); `throw`/`raise`/`panic!`/`todo!`/`unimplemented!`/
  `unreachable!` matched on the MASK (so string contents can't trigger).
- Brace languages: while eliding a body, collect up to 4 risk lines (200-char clip). At the body
  close, no risk lines → today's single-line collapse, byte-identical. With risk lines → multi-line
  form: held signature, then gap markers (`/* … N lines */`) interleaved with the verbatim risk
  lines, then the close. Depth tracking is untouched (retention affects output only, no desync
  surface). Inline one-line bodies keep the whole line verbatim when risky instead of `{ … }`.
- Python: same interleave with `...  # … N lines` stubs in the body-elision walk.
- Fix in passing (same code path): brace-body `elidedLines` are double-counted (per-line `+= 1`
  during elision AND `+= nLines` at close) — the header over-reports and kept+elided can exceed
  totalLines. Verify with a repro before fixing; add a counts-honesty assertion to the tests.

**Success criteria.** Tests: TS body retains `throw` + `TODO` lines in place with correct gap
counts; per-body cap enforced; `throw` inside a string literal NOT retained; Python `raise`
retained; risk-free bodies byte-identical to current output; kept+elided ≤ totalLines everywhere;
`trySkeleton` end-to-end carries the retained lines. Full suite + typecheck green.

## 3. Docs

README: move the two shipped items out of "Next", add Phase 6 section, env-table row for
`CONTEXTFOLD_SPOOL_RETAIN_DAYS`, one retention sentence in the L0 section. DESIGN.md: retention
line next to the §Spool contract.
