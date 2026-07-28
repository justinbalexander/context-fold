# Lint pass 2 — PASS

Anchor re-checks performed this pass: `getSessionFile/getSessionDir/getSessionId` on `ReadonlySessionManager` (session-manager.d.ts:136) confirmed; `getSessionDir()` returns the `<agentDir>/sessions/<encoded-cwd>/` directory by default (session-manager.js:629, path builder at :225), so the two Contracts spool-path spellings agree; `finalizeExecutedToolCall` confirmed present in `@earendil-works/pi-agent-core/dist/agent-loop.js` inside the willow install; task source dirs and `ctx.model` per the trusted facts. No stale "180"/"10 tasks"/"rtk-trial tasks" text survives anywhere in the plan (grep-verified).

## Fix verification — finding-by-finding status

**Material findings 1–6:**

1. **Eval-task source paths — CLOSED.** Contracts §Eval tasks now pins the 6 tasks to `~/willow-control-plane/testbench/agentic-tasks/` with explicit "copy into the eval repo, do not reference in place", the 2 flood tasks to `~/experiments/rtk-trial/tasks/`; D36 records the correction and P0.1 steps repeat both source paths inline ("rtk-trial itself only holds `git-heavy`/`test-verbose`").
2. **Criterion 10 unevaluable — CLOSED.** Criterion 10 restated as "≥2 of 3 reps per model per task" on named sweep tasks (`git-heavy`, `test-verbose`), matching N=3; D37 locks the bar and the tasks now exist in the suite (D36 adds them), Contracts labels them "criterion 10's sweep tasks", P6.1 runs the trace check.
3. **Per-model rollout mechanism — CLOSED.** D20 defines the comma-separated model-id-substring allowlist matched against `ctx.model.id` (types.d.ts:222, verified exposed), D38 pins enactment as a `~/.bashrc` export with the settings.json no-env-facility fact stated, and P6.2 steps enact exactly that per gate outcome with a runnable `grep CONTEXTFOLD_L0 ~/.bashrc` verification.
4. **e2e-gate.sh Phase-2 ownership — CLOSED.** P2.2's Files now lists `scripts/e2e-gate.sh`, its Steps say "Extend `scripts/e2e-gate.sh` per the Phase 2 verification", and its Verification runs the script.
5. **Criterion 11 unowned — CLOSED.** Criterion 11 names owners inline (inertness → `tests/gate.test.ts`/P1.3; prior-spool recall → `tests/recall-l0.test.ts`/P2.1); P1.3 steps include "env unset → zero spool writes, empty registry, view byte-identical to baseline" and P2.1 steps include the prior-session recall-with-gate-off test.
6. **Arm provisioning unpinned — CLOSED.** New Contracts §Arm provisioning pins both open questions: auth via `auth.json` copy from `~/.willow/agent/`, extension load via `extensions/context-fold` symlink per arm template, plus the arm-A semantics pass-1's dry-run asked about (extension loaded, baseline L2/L3 folding ACTIVE, no `CONTEXTFOLD_L0`); P0.1 steps reference the section.

**Minor findings 7–9:**

7. **:8001 model provisioning — CLOSED.** Contracts §Eval models adds "load the pinned GGUF via Lemonade and verify with `curl http://127.0.0.1:8001/v1/models` (the port currently serves a different model; :8001 is shared)".
8. **Buried-error predicate + truncation — PARTIALLY CLOSED.** The predicate half is closed: P0.3 now defines fixture (wrong import in a named source file, one load-bearing `ImportError` line) and check.py predicate (import line corrected). The truncation half only relocated: the fix reasons about the bash 50KB *tail* cap, but delivery "as an on-disk file the agent must read" runs into the read tool's own 50KB/2000-line *head* cap (stated in the plan's own Handoff notes), and "mid-file" of ~100KB sits at that boundary just as before. Non-blocking: it was minor-note-only, and P0.3's arm-A-must-solve verification gate still catches a broken fixture at build time. See minor notes.
9. **D18 dedup ambiguity — CLOSED.** P1.1 steps pick one reading explicitly: duplicate block keeps its own fold code, store maps it to the first code's envelope file (written once), caller told it's a dedup hit so the digest appends "identical to {#firstCode}".

**Coverage cross-check items 1–6:**

1. Pointer digest budget — **CLOSED** (D35, numbers still in Contracts, with the ≥80%-savings sizing rationale).
2. Task-set selection — **CLOSED** (D36 decides the 6+2+4 composition and explicitly re-adds `git-heavy`/`test-verbose` with the outboard-target rationale).
3. Criterion 10 compliance bar — **CLOSED** (D37).
4. Rollout mechanism — **CLOSED** (D20 + D38).
5. Phase 4 regression bar — **CLOSED** (D39, hard floor blocking P4.2).
6. Teaching-text cap — **CLOSED** (D40, charged to arms B/C).

## New issues introduced by the edits

None material. Cross-checks run on the changed sections:

- **Run/task arithmetic consistent everywhere:** D25 (12 tasks) = D36 (12 tasks, 216 runs) = P6.1 (3×2×12×3 = 216) = Risks (216 total, 108 gpt-5.5) = Phase 0 scope/done-when (12) = P0.1 ("the 8 reused tasks"). Criterion 1's "4 flood-heavy tasks" is pinned in Contracts ("= the 4 new flood tasks"), disambiguating D26's looser "flood tasks" now that D36 also calls git-heavy/test-verbose flood tasks.
- **Packet file sets still support the parallel-ok claims:** P1.2's new `src/core/gate-registry.ts` is claimed by no other packet (P1.3 consumes the interface without listing the file); P1.1/P1.2/P1.4 remain disjoint. The new `scripts/e2e-gate.sh` overlap (P1.3 creates, P2.2 extends) and `tests/recall-l0.test.ts` overlap (P2.1, P2.2) are both sequential via declared depends-on chains, not parallel.
- **D20/D26/D38/P6.2 chain is coherent:** unset/0/1/allowlist semantics in D20 match the Contracts env-var line, criterion 11's "unset = inert", P1.3's skip logic, and P6.2's three enactment branches.
- **D10's corrected anchor is accurate in substance:** `finalizeExecutedToolCall` verified in `@earendil-works/pi-agent-core` within the willow install (see minor note on "dist" wording).

## Minor notes (non-blocking)

- **Buried-error read-cap boundary (finding 8 residue):** state the constraint positively in P0.3 — e.g. "place the ImportError line so it survives the read tool's 50KB/2000-line window, or size the log so one capped read contains it." Also note that if the line is *only* reachable via grep, the clue arrives in a small ungated payload and the task stops probing fold-away-detail — the error should sit inside the large gated read for the probe to bite.
- **D10 wording:** `finalizeExecutedToolCall` lives in `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` under the willow install — "vendored into willow's dist" should say "shipped in willow's node_modules"; findable either way.
- **Spool-layout literal vs `--session-dir`:** eval runs use `willow -p --session-dir <dir>` (Contracts §Headless drive), under which `getSessionDir()` returns the custom dir — spools land at `<custom-dir>/spool/<sessionId>/`, not the literal `~/.willow/agent/sessions/<encodedCwd>/...` path. Behavior is coherent since resolution is API-derived; e2e scripts should assert the API-derived path, and the Spool-layout line could note it shows the default case.
- **Arm-A env hygiene after ship:** once P6.2 exports `CONTEXTFOLD_L0` from `~/.bashrc`, any eval *rerun*'s arm A inherits it. Arm provisioning's "no `CONTEXTFOLD_L0` in env" should become "run.py explicitly unsets/empties it in arm A's launch env." First full run is unaffected (P6.1 precedes P6.2).
