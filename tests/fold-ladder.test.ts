/*
 * fold-ladder.test.ts — the discrete fold ladder (CONTEXTFOLD_MODE=ladder default path):
 * threshold crossing, step spacing, cold branch, cap emergency, byte-stable layers,
 * consolidation merge, and fold-event reporting.
 */
import { describe, expect, it } from "vitest";
import { ContextFoldEngine, type FoldEventReport, type FrozenLayer } from "../src/adapters/pi/store";
import { FoldLadderConductor, LADDER_DEFAULTS } from "../src/core/policy/fold-ladder";
import { MapGateRegistry } from "../src/core/gate-registry";
import type { AgentMessage } from "../src/core/block";
import { user, assistantWithCalls, bigResult, toolResult, isBalanced } from "./helpers";

function ladderEngine(cfg: Record<string, unknown> = {}, ladderCfg = LADDER_DEFAULTS) {
	const policy = new FoldLadderConductor(ladderCfg);
	const e = new ContextFoldEngine(policy, { tailTarget: 100, prefixStable: true, ...cfg }, null, null, new MapGateRegistry());
	const committed: FrozenLayer[] = [];
	const broken: number[] = [];
	const events: FoldEventReport[] = [];
	e.onLayerCommit = (layer) => committed.push(layer);
	e.onLayerBreak = (seq) => broken.push(seq);
	e.onFoldEvent = (ev) => events.push(ev);
	return { e, policy, committed, broken, events };
}

function session(n: number, linesEach = 400): { messages: AgentMessage[]; callIds: string[] } {
	const messages: AgentMessage[] = [user("build the thing")];
	const callIds: string[] = [];
	for (let i = 0; i < n; i++) {
		const id = `c${i}`;
		callIds.push(id);
		messages.push(assistantWithCalls([{ id, name: "read" }]));
		messages.push(bigResult(id, linesEach));
	}
	messages.push(user("now the newest question"));
	return { messages, callIds };
}

function resultText(messages: AgentMessage[], callId: string): string {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const tr = m as { toolCallId?: string; content?: { type: string; text?: string }[] };
		if (tr.toolCallId === callId) return tr.content?.[0]?.text ?? "";
	}
	throw new Error(`no toolResult for ${callId}`);
}

describe("discrete fold events", () => {
	it("below the first-fold threshold the context goes out untouched (append-only between events)", () => {
		const { e, committed } = ladderEngine();
		const { messages } = session(3); // ~15k live
		const out = e.process(messages, { contextWindow: 80_000, tokens: null }); // ~0.19 of window
		expect(out).toBe(messages);
		expect(committed.length).toBe(0);
	});

	it("crossing the threshold fires ONE fold event: observations mask, intent and actions stay", () => {
		const { e, committed, events } = ladderEngine();
		const { messages, callIds } = session(8); // ~39k live
		const out = e.process(messages, { contextWindow: 80_000, tokens: null }); // ~0.49 ≥ 0.45

		expect(committed.length).toBe(1);
		expect(events.length).toBe(1);
		expect(events[0].trigger).toBe("threshold");
		expect(events[0].maskedIds.length).toBeGreaterThan(0);
		expect(isBalanced(out)).toBe(true);

		// Oldest observation masked to a reversible pointer digest…
		expect(resultText(out, callIds[0])).toContain("FOLDED");
		// …while user intent survives verbatim.
		const users = out.filter((m) => (m as { role?: string }).role === "user");
		expect(users.length).toBe(2);
	});

	it("a fresh fold cannot re-fire next turn: frozen bytes hold and no second layer commits", () => {
		const { e, committed } = ladderEngine();
		const { messages, callIds } = session(8);
		const first = e.process(messages, { contextWindow: 80_000, tokens: null });
		const firstText = resultText(first, callIds[0]);
		const second = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(committed.length).toBe(1);
		expect(resultText(second, callIds[0])).toBe(firstText);
	});

	it("step spacing: over the threshold but with too little maskable mass, no event fires", () => {
		const { e, committed } = ladderEngine();
		// A huge (unmaskable) user brief + one small observation: fraction ≥ 0.45, savings ≪ step.
		const messages: AgentMessage[] = [
			user("brief: " + "requirements ".repeat(12_000)), // ~39k tokens of user intent
			assistantWithCalls([{ id: "c0", name: "read" }]),
			bigResult("c0", 150), // ~2k — under the 0.12 × 80k step
			user("go"),
		];
		const out = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(out).toBe(messages);
		expect(committed.length).toBe(0);
	});

	it("cold branch: with no live cache read there is no prefix to protect — folds from 25 %", () => {
		const { e, policy, committed } = ladderEngine();
		const { messages } = session(6); // ~29k live → 0.29 of 100k
		policy.setCold(true);
		e.process(messages, { contextWindow: 100_000, tokens: null });
		expect(committed.length).toBe(1);

		// Same session, warm: 0.29 < 0.45 → no event.
		const warm = ladderEngine();
		warm.policy.setCold(false);
		warm.e.process(session(6).messages, { contextWindow: 100_000, tokens: null });
		expect(warm.committed.length).toBe(0);
	});

	it("crossing the budget cap is an emergency event regardless of the ladder position", () => {
		const { e, committed, events } = ladderEngine({ absoluteTokenCap: 10_000 });
		const { messages } = session(3); // ~15k live > 10k cap; 0.075 of a 200k window
		e.process(messages, { contextWindow: 200_000, tokens: null });
		expect(committed.length).toBe(1);
		expect(events[0].trigger).toBe("cap");
	});

	it("provider-reported usage drives the fraction when present", () => {
		const { e, committed } = ladderEngine();
		const { messages } = session(8); // estimator says ~0.49 of 80k
		// Provider says the context is actually tiny — trust it, no fold.
		const out = e.process(messages, { contextWindow: 80_000, tokens: 8_000 });
		expect(out).toBe(messages);
		expect(committed.length).toBe(0);
	});
});

describe("consolidation merge", () => {
	it("exceeding maxLayers merges layer records into one without touching digest bytes", () => {
		const { e, committed, broken, events } = ladderEngine({ maxLayers: 1 });
		const base = session(8);
		const first = e.process(base.messages, { contextWindow: 80_000, tokens: null });
		expect(committed.length).toBe(1);
		const firstFrozen = committed[0].entries[0];
		const firstText = resultText(first, firstFrozen.id.replace(/^r:/, ""));

		// Grow the session past the threshold again (new observations accumulate).
		const grown = { messages: [...base.messages] };
		for (let i = 8; i < 16; i++) {
			grown.messages.push(assistantWithCalls([{ id: `c${i}`, name: "read" }]));
			grown.messages.push(bigResult(`c${i}`, 400));
		}
		grown.messages.push(user("keep going"));
		const second = e.process(grown.messages, { contextWindow: 80_000, tokens: null });

		// Second event committed, then the merge: old seq broken, ONE merged layer re-committed.
		expect(broken.length).toBeGreaterThan(0);
		const merged = committed[committed.length - 1];
		expect(merged.entries.map((x) => x.id)).toContain(firstFrozen.id);
		expect(events.some((ev) => ev.trigger === "consolidation")).toBe(true);
		// The merge is bookkeeping only: the first layer's bytes are unchanged in the view.
		expect(resultText(second, firstFrozen.id.replace(/^r:/, ""))).toBe(firstText);
	});
});

describe("reversibility", () => {
	it("recall and unfold still resolve a ladder-masked block", () => {
		const { e, committed } = ladderEngine();
		const { messages } = session(8);
		e.process(messages, { contextWindow: 80_000, tokens: null });
		const frozenId = committed[0].entries[0].id;
		const code = frozenId.replace(/^r:/, "");

		const { matches, missing } = e.resolveRecall([codeOf(frozenId)]);
		expect(missing).toEqual([]);
		expect(matches[0].text).toContain("line 0:");

		e.markUnfold([codeOf(frozenId)]);
		const after = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(resultText(after, code)).toContain("line 0:");
	});
});

// local: avoid importing digest just for the code helper
import { foldCode } from "../src/core/digest";
function codeOf(id: string): string {
	return foldCode(id);
}
