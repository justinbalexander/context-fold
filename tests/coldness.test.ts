/*
 * coldness.test.ts — Phase 2 rep 2: the relevance judge (parse/validate), the ModelConductor
 * ranking (keep-warm blocks fold last but the floor can still fold them), and the engine applying
 * a cached judgment across turns.
 */
import { describe, it, expect } from "vitest";
import { parseKeep, buildPrompt, fetchRelevanceJudge, DEFAULT_JUDGE_CONFIG, type JudgeCandidate, type FetchLike } from "../src/core/model/relevance-judge";
import { ModelConductor, isRelevanceAware } from "../src/core/policy/model";
import { KeelConductor } from "../src/core/policy/keel";
import type { ConductorView, ViewBlock, Command } from "../src/core/contract";

const cands: JudgeCandidate[] = [
	{ id: "r:a", kind: "tool_result", preview: "alpha" },
	{ id: "r:b", kind: "tool_result", preview: "beta" },
	{ id: "r:c", kind: "tool_result", preview: "gamma" },
];

describe("relevance judge parsing", () => {
	it("parses a comma/space list into in-range ids", () => {
		expect([...parseKeep("1, 3", cands)]).toEqual(["r:a", "r:c"]);
		expect([...parseKeep("keep blocks 2 and 3", cands)]).toEqual(["r:b", "r:c"]);
	});
	it("treats 'none' (no digits) as empty", () => {
		expect(parseKeep("none", cands).size).toBe(0);
		expect(parseKeep("None of them are relevant.", cands).size).toBe(0);
	});
	it("filters out-of-range indices (e.g. a thinking leak with huge numbers)", () => {
		expect([...parseKeep("2, 99, 1000", cands)]).toEqual(["r:b"]);
	});
	it("buildPrompt lists candidates 1-based and includes the tail", () => {
		const p = buildPrompt("working on alpha.ts", cands, 4000);
		expect(p).toContain("[1] tool_result: alpha");
		expect(p).toContain("[3] tool_result: gamma");
		expect(p).toContain("working on alpha.ts");
	});
});

describe("fetchRelevanceJudge with a mock fetch", () => {
	it("returns the kept ids and sends enable_thinking=false when disableThinking", async () => {
		let sentBody: any = null;
		const mock: FetchLike = async (_url, init) => {
			sentBody = JSON.parse(init.body);
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "1, 3" } }] }) };
		};
		const judge = fetchRelevanceJudge({ ...DEFAULT_JUDGE_CONFIG, baseUrl: "http://x/api/v1", model: "M" }, mock);
		const keep = await judge.judge("tail", cands);
		expect([...keep]).toEqual(["r:a", "r:c"]);
		expect(sentBody.chat_template_kwargs).toEqual({ enable_thinking: false });
	});
	it("returns empty set on endpoint error (→ deterministic)", async () => {
		const mock: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
		const judge = fetchRelevanceJudge({ ...DEFAULT_JUDGE_CONFIG, baseUrl: "http://x/api/v1", model: "M" }, mock);
		expect((await judge.judge("t", cands)).size).toBe(0);
	});
});

// ── ModelConductor ranking ───────────────────────────────────────────────────

function tr(i: number): ViewBlock {
	return {
		id: `r:c${i}`,
		kind: "tool_result",
		turn: i + 1,
		order: i,
		tokens: 1000,
		foldedTokens: 30,
		held: false,
		folded: false,
		protected: false,
		grouped: false,
		text: `block number ${i} plain prose with no shared identifiers`,
	};
}

function viewOf(n: number, budget: number, cap: number): ConductorView {
	const blocks = Array.from({ length: n }, (_, i) => tr(i));
	const liveTokens = blocks.reduce((s, b) => s + b.tokens, 0);
	return { blocks, budget, contextWindow: cap, liveTokens, protectedFromIndex: n, protectTokens: 0 };
}

/** All ids named by fold/replace/group commands. */
function foldedIds(cmds: Command[]): Set<string> {
	const ids = new Set<string>();
	for (const c of cmds) {
		if (c.kind === "fold" || c.kind === "group") c.ids.forEach((id) => ids.add(id));
		else if (c.kind === "replace") ids.add(c.id);
	}
	return ids;
}

describe("ModelConductor keep-warm ranking", () => {
	it("is relevance-aware", () => {
		expect(isRelevanceAware(new ModelConductor())).toBe(true);
		expect(isRelevanceAware(new KeelConductor())).toBe(false);
	});

	it("folds keep-warm blocks LAST — they survive when others meet the budget", () => {
		// 6 blocks × 1000 = 6000 live, cap/budget 5000, target 0.7·cap=3500. Folding 3 blocks
		// (→ ~3090) meets target, so 3 of 6 survive. Keep-warm the 2 OLDEST (which Keel would fold
		// first); they must move to the back and survive.
		const view = viewOf(6, 5000, 5000);
		const c = new ModelConductor();
		c.setKeepWarm(new Set(["r:c0", "r:c1"]));
		const folded = foldedIds(c.conduct(view));
		expect(folded.has("r:c0")).toBe(false); // kept-warm, survived
		expect(folded.has("r:c1")).toBe(false);
		expect(folded.size).toBeGreaterThanOrEqual(3); // others folded to meet budget
	});

	it("the hard-cap floor still folds keep-warm blocks when budget demands it", () => {
		// Keep ALL 6 warm but budget forces folding ~3 anyway → the floor overrides the model.
		const view = viewOf(6, 5000, 5000);
		const c = new ModelConductor();
		c.setKeepWarm(new Set(["r:c0", "r:c1", "r:c2", "r:c3", "r:c4", "r:c5"]));
		const folded = foldedIds(c.conduct(view));
		expect(folded.size).toBeGreaterThanOrEqual(3); // safety floor wins over the model
	});

	it("with an empty keep-warm set, matches deterministic Keel exactly", () => {
		const view = viewOf(6, 5000, 5000);
		const model = foldedIds(new ModelConductor().conduct(viewOf(6, 5000, 5000)));
		const keel = foldedIds(new KeelConductor().conduct(view));
		expect([...model].sort()).toEqual([...keel].sort());
	});
});
