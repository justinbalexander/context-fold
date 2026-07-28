/*
 * recall-eval.test.ts — Phase-3 experiment runner. OPT-IN: skipped unless CONTEXTFOLD_EVAL=1
 * (it drives the live Lemonade model for the model-fold arm and the recall Q&A).
 *
 *   CONTEXTFOLD_EVAL=1 npx vitest run tests/recall-eval.test.ts
 *
 * Always-on (no model) sanity for the deterministic + truncate arms runs under CONTEXTFOLD_EVAL too;
 * the model-fold arm and the driver recall need the endpoint.
 */
import { describe, it, expect } from "vitest";
import {
	buildSession, truncateToBudget, detFold, modelFold, retention, tokensOf, contextText, driveRecall,
	type ArmResult, type ModelConn, type PlantedFact,
} from "../src/experiments/recall-eval";
import type { AgentMessage } from "../src/core/block";

const EVAL = process.env.CONTEXTFOLD_EVAL === "1";
const CONN: ModelConn = {
	baseUrl: process.env.CONTEXTFOLD_MODEL_URL || "http://localhost:13305/api/v1",
	model: process.env.CONTEXTFOLD_MODEL_ID || "Qwen3.5-4B-MTP-GGUF",
	apiKey: "sk-local",
	disableThinking: true,
};

const CW = 20_000;
const FRAC = 0.4;
const BUDGET = Math.floor(CW * FRAC);

async function recallScore(messages: AgentMessage[], facts: PlantedFact[]): Promise<number> {
	const ctx = contextText(messages);
	let correct = 0;
	for (const f of facts) {
		const ans = await driveRecall(ctx, f.question, CONN);
		if (ans.toLowerCase().includes(f.expected.toLowerCase())) correct++;
	}
	return correct / facts.length;
}

describe.skipIf(!EVAL)("Phase 3 recall experiment", () => {
	it("compares truncate vs deterministic fold vs model fold at the same budget", async () => {
		const { messages, facts } = buildSession(30);
		const baseTokens = tokensOf(messages);
		// eslint-disable-next-line no-console
		console.log(`\nsession: ${baseTokens} tokens, budget ${BUDGET} (cw ${CW} × ${FRAC}), ${facts.length} facts\n`);

		const arms: { arm: string; messages: AgentMessage[] }[] = [
			{ arm: "truncate", messages: truncateToBudget(messages, BUDGET) },
			{ arm: "det-fold", messages: detFold(messages, CW, FRAC) },
			{ arm: "model-fold", messages: await modelFold(messages, CW, FRAC, CONN) },
		];

		const results: ArmResult[] = [];
		for (const a of arms) {
			const ret = retention(a.messages, facts);
			const recall = await recallScore(a.messages, facts);
			results.push({ arm: a.arm, tokens: tokensOf(a.messages), retention: ret.score, recall });
		}

		// eslint-disable-next-line no-console
		console.log("arm         tokens   retention   recall");
		for (const r of results) {
			// eslint-disable-next-line no-console
			console.log(`${r.arm.padEnd(11)} ${String(r.tokens).padStart(6)}   ${(r.retention * 100).toFixed(0).padStart(7)}%   ${((r.recall ?? 0) * 100).toFixed(0).padStart(5)}%`);
		}

		const byArm = Object.fromEntries(results.map((r) => [r.arm, r]));
		// All arms compacted to roughly the same budget.
		for (const r of results) expect(r.tokens).toBeLessThanOrEqual(BUDGET * 1.3);
		// The hypothesis: the model arm retains the most facts in-context.
		expect(byArm["model-fold"].retention).toBeGreaterThanOrEqual(byArm["truncate"].retention);
		expect(byArm["model-fold"].retention).toBeGreaterThanOrEqual(byArm["det-fold"].retention - 0.001);
	}, 600_000);
});

// A no-model structural sanity check that runs in the normal suite (proves the harness builds a
// valid over-budget session and both deterministic arms compact under budget).
describe("recall-eval harness (no model)", () => {
	it("builds an over-budget session and the deterministic arms compact under budget", () => {
		const { messages, facts } = buildSession(30);
		expect(facts.length).toBe(6);
		expect(tokensOf(messages)).toBeGreaterThan(BUDGET);
		expect(tokensOf(truncateToBudget(messages, BUDGET))).toBeLessThanOrEqual(BUDGET);
		const det = detFold(messages, CW, FRAC);
		expect(tokensOf(det)).toBeLessThanOrEqual(BUDGET * 1.3);
		// Every planted fact is present in the FULL session (sanity for the needles).
		const full = contextText(messages);
		for (const f of facts) expect(full).toContain(f.needle);
	});
});
