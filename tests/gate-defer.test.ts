/*
 * gate-defer.test.ts — deferred L0 substitution (CONTEXTFOLD_L0_KEEP_RECENT / gateKeepRecent).
 *
 * The gate's measured failure mode is recall churn: born-folding on arrival means a model that
 * reads many files gets N pointers and then recalls them one by one, and the extra turns can cost
 * more than the per-turn saving. Deferral holds the newest N registered blocks at full fidelity so
 * a result is usable on the turn it was asked for, and the pointer arrives once the block is stale.
 *
 * The payload is spooled on arrival either way, so a held block stays recallable and still survives
 * hard compaction — deferral changes only what the view renders.
 */
import { describe, expect, it } from "vitest";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { MapGateRegistry, type GateEntry } from "../src/core/gate-registry";
import { estTokens, BLOCK_OVERHEAD } from "../src/core/tokens";
import { user, assistantWithCalls, toolResult, isBalanced } from "./helpers";
import type { AgentMessage } from "../src/core/block";

/** Plain prose with no risk flags, so pointers stay small. */
function flood(lines: number, marker = "quick brown fox"): string {
	return Array.from({ length: lines }, (_, i) => `${marker} jumps over the lazy dog on afternoon ${i}`).join("\n");
}

function register(gate: MapGateRegistry, callId: string, content: string): void {
	const blockId = `r:${callId}`;
	const entry: GateEntry = {
		blockId,
		code: `code-${callId}`,
		fullTokens: estTokens(content) + BLOCK_OVERHEAD,
		tool: "read",
		input: { path: `/x/${callId}.log` },
		isError: false,
		bytes: Buffer.byteLength(content, "utf8"),
		fullEstTokens: estTokens(content),
		spoolPath: `/sessions/s/spool/s/code-${callId}.json`,
	};
	gate.set(entry);
}

/** One user turn then a call/result pair per id, oldest first. */
function session(ids: string[], content: string): AgentMessage[] {
	const msgs: AgentMessage[] = [user("read the big logs")];
	for (const id of ids) {
		msgs.push(assistantWithCalls([{ id, name: "read" }], { text: "reading" }));
		msgs.push(toolResult(id, content));
	}
	return msgs;
}

/** Rendered tool-result texts, oldest first. */
function results(out: AgentMessage[]): string[] {
	return out
		.filter((m) => m.role === "toolResult")
		.map((m) => (m.content as Array<{ text?: string }>)[0].text ?? "");
}

const CONTENT = flood(400);

describe("deferred L0 substitution", () => {
	it("holds the newest registered block warm and folds the older ones", () => {
		const gate = new MapGateRegistry();
		for (const id of ["c1", "c2", "c3"]) register(gate, id, CONTENT);
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100, gateKeepRecent: 1 }, gate);

		const out = engine.process(session(["c1", "c2", "c3"], CONTENT), 400_000);
		const r = results(out);
		expect(r).toHaveLength(3);
		expect(r[0]).toContain("FOLDED");
		expect(r[1]).toContain("FOLDED");
		expect(r[2]).not.toContain("FOLDED");
		expect(r[2]).toBe(CONTENT);
		expect(isBalanced(out)).toBe(true);
	});

	it("folds a held block once a newer registered block arrives", () => {
		const gate = new MapGateRegistry();
		for (const id of ["c1", "c2"]) register(gate, id, CONTENT);
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100, gateKeepRecent: 1 }, gate);

		const first = results(engine.process(session(["c1", "c2"], CONTENT), 400_000));
		expect(first[1]).not.toContain("FOLDED");

		register(gate, "c3", CONTENT);
		const second = results(engine.process(session(["c1", "c2", "c3"], CONTENT), 400_000));
		expect(second[1]).toContain("FOLDED");
		expect(second[2]).not.toContain("FOLDED");
	});

	it("default config stays born-folded — every registered block is a pointer at once", () => {
		const gate = new MapGateRegistry();
		for (const id of ["c1", "c2"]) register(gate, id, CONTENT);
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, gate);
		for (const r of results(engine.process(session(["c1", "c2"], CONTENT), 400_000))) {
			expect(r).toContain("FOLDED");
		}
	});

	it("holding more blocks than exist leaves everything warm", () => {
		const gate = new MapGateRegistry();
		for (const id of ["c1", "c2"]) register(gate, id, CONTENT);
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100, gateKeepRecent: 5 }, gate);
		for (const r of results(engine.process(session(["c1", "c2"], CONTENT), 400_000))) {
			expect(r).not.toContain("FOLDED");
		}
	});

	it("a held block's full weight is charged to the budget, not pointer weight", () => {
		const gate = new MapGateRegistry();
		for (const id of ["c1", "c2"]) register(gate, id, CONTENT);
		const held = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100, gateKeepRecent: 1 }, gate);
		const born = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, gate);
		const msgs = session(["c1", "c2"], CONTENT);
		// Deferral leaves real tokens in the view, so the held view is strictly heavier.
		expect(held.viewFor(msgs, 400_000).liveTokens).toBeGreaterThan(born.viewFor(msgs, 400_000).liveTokens);
	});

	it("excludes a held block from the span-recall sweep (its content is already warm)", () => {
		const gate = new MapGateRegistry();
		for (const id of ["c1", "c2"]) register(gate, id, CONTENT);
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100, gateKeepRecent: 1 }, gate);
		engine.process(session(["c1", "c2"], CONTENT), 400_000);
		// Only the folded block is swept; sweeping the warm one would duplicate what the model reads.
		expect(engine.searchFolded("quick brown fox").scanned).toBe(1);
	});
});
