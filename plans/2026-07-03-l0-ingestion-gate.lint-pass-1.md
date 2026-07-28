# Lint pass 1 — FAIL (material findings)

Verdict basis: all cited code anchors check out (store.ts:194/224/237, ladder.ts:50, ledger categories, DESIGN.md §6, Accordion pin `0c22434`, `tool_result`/`context` hooks, `supportsUsageInStreaming:false`, `fullOutputPath`), but the eval-task location claim is wrong, two success criteria are unevaluable/unowned as written, and the ship-decision mechanism doesn't exist in the verified settings surface.

## (a) Material findings

1. **MATERIAL — Contracts §Eval tasks / P0.1.** The "6 reused rtk-trial tasks (`create-file`, `edit-config`, `fix-bug`, `multi-file`, `read-answer`, `test-driven`)" are **not in rtk-trial**. `~/experiments/rtk-trial/tasks/` contains only `git-heavy` and `test-verbose`; the 6 named tasks live at `~/willow-control-plane/testbench/agentic-tasks/` (rtk-trial's `run.py` pulls from both, `BENCH_TASKS` constant). An executor following "reuse the 6 rtk-trial tasks verbatim" copies the wrong directory or stalls. Fix: pin the real path and state copy-vs-reference.
2. **MATERIAL — Success criterion 10.** "≥4/5 runs" matches no run count the plan produces: N=3 reps → 3 runs per task per model, 6 pooled. And "sweep tasks" is never enumerated (which of the 10 count? `wide-grep`? `big-read`? there is no git-archaeology task at all despite outboard naming it as a primary target). Criterion is unevaluable as written. Fix: name the sweep tasks and restate the threshold against N=3×2.
3. **MATERIAL — P6.2 / D26.** "Default-on per model that passed → `CONTEXTFOLD_L0=1` in the willow profile" has no mechanism. Verified: `~/.willow/agent/settings.json` has no `env` key and no per-model profile facility; `CONTEXTFOLD_L0` is a process env var, global to a session. If gpt-5.5 passes and Qwen fails (the plan's own risk section predicts exactly this split), P6.2 cannot be enacted. Fix: specify the mechanism (e.g. extension checks active model id against a config allowlist) or downgrade to a global on/off decision rule.
4. **MATERIAL — Phase 2 verification.** "Extend `scripts/e2e-gate.sh`" has no owning packet: none of P2.1–P2.3 lists that file in Files. The phase's verification artifact is never built under packet rules. Fix: add it to P2.2's file set and verification.
5. **MATERIAL — Success criterion 11 (kill switch).** No packet owns it. P1.3 handles the env-off skip inline, but "no spool writes, no pointers, prior spools still recallable" is asserted nowhere as a runnable test. Fix: name it in `tests/gate.test.ts` (inertness) and `tests/recall-l0.test.ts` (old-spool recall) scopes.
6. **MATERIAL — P0.1 arm provisioning underpinned.** Two unpinned test-infra items with no prior pattern to copy (rtk-trial and testbench both ran local-only with `--no-extensions -e`): (a) how gpt-5.5/`openai-codex` authenticates inside an isolated `WILLOW_CODING_AGENT_DIR` (copy `auth.json`? OAuth state?); (b) how context-fold loads per arm — `packages` entry in the arm's settings.json, symlink into `extensions/`, or `-e` flag. Fix: pin both in Contracts.
7. **MINOR-note-only — :8001 model provisioning.** Contract pins `Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf` at :8001, but the live models.json shows :8001 currently serving Qwen-AgentWorld-35B via Lemonade. No step says how to get the pinned model loaded.
8. **MINOR-note-only — buried-error task design.** "Agent applies the fix implied by that line" is an undefined check.py predicate (install the package? fix an import? create a module?). Also, with native caps kept (D29), bash tail-caps at 50KB — an error "mid-payload" of ~100KB sits right at the truncation boundary and can vanish for *all* arms. P0.3's arm-A-must-pass gate catches this eventually, but the constraint (error line must survive native truncation) should be stated.
9. **MINOR-note-only — D17/D18 vs P1.1 dedup.** "Return existing code on hash hit" conflicts with codes being FNV-1a of the block's durable id: does the duplicate block keep its own code mapped to the shared envelope (D18's "identical to {#code}" implies yes), or reuse the first code? Either reading is implementable; pick one.

## (b) Fresh-executor dry-run — questions I would have to ask

Anchor check first: store.ts:224 (`liveTokens += b.tokens`) ✓, :237 (`folded: false`) ✓, resolve() at 194–218 ✓ (plan says 194–219, close enough), ladder.ts:50 `trySkeleton` stub ✓, `estTokens` in tokens.ts ✓, ledger.ts categories exactly as listed ✓, DESIGN.md §6 = Reversibility & recall with `pi.appendEntry`/`foldLedger` ✓, Accordion `0c22434` pinned in DESIGN.md:229 and port-spec:3 ✓, `supportsUsageInStreaming: False` at testbench `adapters/agentic.py:75` ✓, bash `fullOutputPath` in willow dist `core/bash-executor.js` ✓, `tool_result` + `context` hooks in dist `extensions/types.d.ts:669,851` ✓. One drift: `agent-loop.js finalizeExecutedToolCall` (D10) is not in the willow-coding-agent dist under that name — it's in `@earendil-works/pi-agent-core` under the pi-coding-agent install. The harness *fact* is restated in Handoff notes, so no stall.

Questions a fresh session must ask:

- **P0.1:** (1) The 6 tasks aren't in rtk-trial/tasks — do you mean `~/willow-control-plane/testbench/agentic-tasks`, and copy or reference in place? (2) How do arm agent dirs get `openai-codex` credentials — copy `~/.willow/agent/auth.json` into each template? (3) Load context-fold per arm via `packages` in the arm's settings.json or `-e`? (arm A needs the extension loaded but gate off — is baseline folding active in arm A or is the extension fully idle?)
- **P0.2:** none — the three-way ordered fallback with a documented outcome is executable as written.
- **P0.3:** (4) buried-error: what is the concrete fix the check.py predicate verifies? (5) Where must the ImportError line sit so the native 50KB bash tail doesn't delete it for every arm? (6) web-fetch: which port for the http.server fixture?
- **P1.1:** (7) Which pi API yields sessionId/encodedCwd for spool-path resolution — `ctx.sessionManager` exposes entries, but the session *file path* getter isn't in `docs/pi-api-surface.md`? (8) The D17/D18 dedup-code question above.
- **P1.2:** (9) Who defines the gate-registry type and where does it live (core or adapter)? P1.2 depends-on-none yet consumes "the gate registry," while P1.3 creates `gate.ts` — I'd define the interface in core and ask if that's intended.
- **P1.3:** (10) Does `CONTEXTFOLD_DEBUG` already dump the next-turn outgoing view that e2e-gate.sh must assert on (index.ts:36 only sets `cfg.debug`), or does this packet add that dump?
- **P1.4:** none — files, budget, and the rtk ImportError fixture are fully specified.

## (c) Coverage cross-check — choices with no decision row

1. **Pointer digest budget numbers** (≤400 est-tokens, first 8 + last 8 lines, 40-risk-line cap) — Contracts only; these directly drive MINSAVE math and eval overhead, never grilled.
2. **Task-set selection** — choosing the 6 testbench tasks and silently dropping rtk-trial's own `git-heavy`/`test-verbose` (flood-type tasks, and outboard's stated target is git archaeology) has no D row; D25 covers arm/model/rep counts only.
3. **Criterion 10's compliance bar** (≥4/5, C<B on sweep tasks) — D33 decides compliance is *measured*, not what threshold ships.
4. **Per-model rollout mechanism** — D26 states the policy; the enactment mechanism (finding 3) was never decided.
5. **Phase 4 regression bar** (100%/83% baseline as hard floor) — verification threshold with no D row.
6. **Teaching-text ≤6-line cap** (P2.3) — number appears only in the packet.

## Minor notes (non-blocking)

- Self-containment, goal verifiability, rejection rows, parked-item reasons/owners, and scope boundary all pass. Run-count arithmetic is consistent (3×2×10×3 = 180 matches the risk section); threshold 2000 est-tokens ≈ 8KB and 50KB→~12.5k est-tokens both check out.
- Parallel-ok claims verified: P1.1/P1.2/P1.4 file sets are disjoint; P3.1 vs P4.x disjoint; P2.3 vs P2.1/P2.2 disjoint (index.ts overlap with P1.3 is across a phase boundary, fine).
- P0.2's "llama-server behind :8001" — it's Lemonade-managed; naming only, the fallback procedure works either way.
- Smoke and full runs on gpt-5.5 spend real API tokens; no budget line anywhere (Jake may not care, but the plan is otherwise cost-meticulous about the 70% gate).
