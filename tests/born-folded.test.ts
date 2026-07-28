/*
 * born-folded.test.ts — the L0 gate's born-folded block state in the pure core (P1.2).
 *
 * A registered block enters the view already collapsed to a pointer digest, regardless of budget.
 * Criterion 6: the budget counts it at POINTER weight while ranking still sees its FULL weight; the
 * fidelity ladder never re-folds it (terminal); unfolding restores the full block.
 */
import { describe, it, expect } from "vitest";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { KeelConductor } from "../src/core/policy/keel";
import { MapGateRegistry, type GateEntry } from "../src/core/gate-registry";
import { foldCode, foldTag } from "../src/core/digest";
import { estTokens, BLOCK_OVERHEAD } from "../src/core/tokens";
import { user, assistantWithCalls, toolResult, isBalanced, liveTokensOf } from "./helpers";
import type { AgentMessage } from "../src/core/block";

/** A flood of plain prose lines that carry NO risk flags (so the pointer stays small). */
function flood(lines: number): string {
	return Array.from({ length: lines }, (_, i) => `the quick brown fox jumps over the lazy dog on afternoon ${i}`).join("\n");
}

/** Register the tool-result block `r:<callId>` as born-folded in `gate` and return its code. */
function register(gate: MapGateRegistry, callId: string, content: string, tool = "read", input: unknown = { path: "/x/y.log" }): string {
	const blockId = `r:${callId}`;
	const code = foldCode(blockId);
	const entry: GateEntry = {
		blockId,
		code,
		fullTokens: estTokens(content) + BLOCK_OVERHEAD,
		tool,
		input,
		isError: false,
		bytes: Buffer.byteLength(content, "utf8"),
		fullEstTokens: estTokens(content),
		spoolPath: `/sessions/s/spool/s/${code}.json`,
	};
	gate.set(entry);
	return code;
}

function session(content: string): AgentMessage[] {
	return [user("read the big log"), assistantWithCalls([{ id: "c1", name: "read" }], { text: "reading" }), toolResult("c1", content)];
}

describe("born-folded blocks (L0 gate)", () => {
	it("folds a registered result to a pointer even when far under budget", () => {
		const content = flood(400);
		const gate = new MapGateRegistry();
		const code = register(gate, "c1", content);
		const engine = new ContextFoldEngine(new KeelConductor(), { tailTarget: 100 }, null, null, gate);

		// Huge context window → the policy has nothing to fold; only the gate acts.
		const out = engine.process(session(content), 400_000);
		const tr = out.find((m) => m.role === "toolResult")!;
		const text = (tr.content as any)[0].text as string;

		expect(text.startsWith(foldTag("r:c1"))).toBe(true);
		expect(text).toContain(`recall #${code}`);
		expect(estTokens(text)).toBeLessThan(estTokens(content) * 0.5); // it genuinely shrank
		expect(isBalanced(out)).toBe(true);
	});

	it("criterion 6: budget counts pointer weight; ranking sees full weight", () => {
		const content = flood(400);
		const gate = new MapGateRegistry();
		register(gate, "c1", content);
		const withGate = new ContextFoldEngine(new KeelConductor(), { tailTarget: 100 }, null, null, gate);
		const withoutGate = new ContextFoldEngine(new KeelConductor(), { tailTarget: 100 }, null, null, new MapGateRegistry());

		const msgs = session(content);
		const gv = withGate.viewFor(msgs, 400_000);
		const cv = withoutGate.viewFor(msgs, 400_000);

		const born = gv.blocks.find((b) => b.id === "r:c1")!;
		const control = cv.blocks.find((b) => b.id === "r:c1")!;

		expect(born.bornFolded).toBe(true);
		expect(born.folded).toBe(true);
		// Ranking still sees the FULL weight.
		expect(born.tokens).toBe(control.tokens);
		expect(born.tokens).toBeGreaterThan(estTokens(content) * 0.9);
		// Budget is charged the POINTER weight, far below full.
		expect(born.foldedTokens).toBeLessThan(born.tokens * 0.5);
		// Live budget total reflects the pointer weight, not the full block.
		expect(gv.liveTokens).toBeLessThan(cv.liveTokens);
		expect(cv.liveTokens - gv.liveTokens).toBeGreaterThan(born.tokens * 0.4);
	});

	it("is terminal: the policy never re-folds a born-folded block", () => {
		// Over-budget session: born-folded block + a second big foldable result the policy must fold.
		const content = flood(400);
		const gate = new MapGateRegistry();
		const code = register(gate, "c1", content);
		const msgs: AgentMessage[] = [
			user("do work"),
			assistantWithCalls([{ id: "c1", name: "read" }], { text: "one" }),
			toolResult("c1", content),
			user("more"),
			assistantWithCalls([{ id: "c2", name: "read" }], { text: "two" }),
			toolResult("c2", flood(400)),
		];
		const engine = new ContextFoldEngine(new KeelConductor(), { tailTarget: 200, defaultContextWindow: 8_000 }, null, null, gate);
		const out = engine.process(msgs, 8_000);

		const tr1 = out.filter((m) => m.role === "toolResult")[0];
		const text1 = (tr1.content as any)[0].text as string;
		// r:c1 is the GATE pointer (has a recall usage line), not Keel's generic digest.
		expect(text1).toContain(`recall #${code}`);
		expect(isBalanced(out)).toBe(true);
	});

	it("unfold overrides born-folded: the full block returns", () => {
		const content = flood(400);
		const gate = new MapGateRegistry();
		const code = register(gate, "c1", content);
		const engine = new ContextFoldEngine(new KeelConductor(), { tailTarget: 100 }, null, null, gate);

		// First pass folds it; then the agent unfolds it.
		const msgs = session(content);
		engine.process(msgs, 400_000);
		engine.markUnfold([code]);
		const out = engine.process(msgs, 400_000);

		const tr = out.find((m) => m.role === "toolResult")!;
		const text = (tr.content as any)[0].text as string;
		expect(text).toContain("afternoon 200"); // a middle line only present in the FULL content
		expect(text).not.toContain("recall #"); // no pointer this turn
	});
});
