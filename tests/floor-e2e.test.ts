/*
 * floor-e2e.test.ts — regression tests for the 2026-07-04 review criticals.
 *
 * The load-bearing one: a tool-heavy session under real budget pressure must actually shrink on
 * the wire, stay pair-balanced, and report telemetry that matches the wire (REVIEW §1 — the old
 * floor booked group savings applyPlan refused, shipped 7.7× cap, and claimed under-budget).
 */
import { describe, it, expect } from "vitest";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { KeelConductor } from "../src/core/policy/keel";
import { hardCapFloor } from "../src/core/policy/budget";
import { buildGraph, markReachable } from "../src/core/policy/edges";
import { linearize } from "../src/core/block";
import type { AgentMessage } from "../src/core/block";
import type { ViewBlock } from "../src/core/contract";
import { pointerDigest } from "../src/core/digest";
import { estTokens } from "../src/core/tokens";

let ts = 1_000;
const nextTs = () => ts++;
function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: nextTs() };
}
function assistantWithCalls(calls: { id: string; name: string }[], opts: { text?: string; thinking?: string } = {}): AgentMessage {
	const content: any[] = [];
	if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking });
	if (opts.text) content.push({ type: "text", text: opts.text });
	for (const c of calls) content.push({ type: "toolCall", id: c.id, name: c.name, arguments: {} });
	return { role: "assistant", content, responseId: `r${nextTs()}`, model: "test", timestamp: nextTs() };
}
function toolResult(toolCallId: string, text: string): AgentMessage {
	return { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: nextTs() };
}
function bigResult(toolCallId: string, lines: number): AgentMessage {
	const body = Array.from({ length: lines }, (_, i) => `line ${i}: ${"x".repeat(40)}`).join("\n");
	return toolResult(toolCallId, body);
}
function liveTokensOf(messages: AgentMessage[]): number {
	return linearize(messages).reduce((n, b) => n + b.tokens, 0);
}
function isBalanced(messages: AgentMessage[]): boolean {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const m of messages) {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const p of m.content as any[]) if (p?.type === "toolCall" && p.id) calls.add(p.id);
		} else if (m.role === "toolResult" && m.toolCallId) results.add(m.toolCallId);
	}
	for (const c of calls) if (!results.has(c)) return false;
	for (const r of results) if (!calls.has(r)) return false;
	return true;
}

function toolHeavySession(n: number): AgentMessage[] {
	const msgs: AgentMessage[] = [user("start")];
	for (let i = 0; i < n; i++) {
		msgs.push(user(`step ${i}`));
		msgs.push(assistantWithCalls([{ id: `c${i}`, name: "read" }], { text: `reading file number ${i}` }));
		msgs.push(bigResult(`c${i}`, 34)); // ~360 est-tokens each
	}
	msgs.push(user("summarize"));
	return msgs;
}

describe("hard-cap floor under tool-heavy pressure (REVIEW §1)", () => {
	it("wire lands at/near cap, pairs balanced, telemetry matches the wire", () => {
		const CW = 8_000; // budget/cap = 6000
		const msgs = toolHeavySession(120);
		const engine = new ContextFoldEngine(new KeelConductor(), { budgetFraction: 0.75, tailTarget: 800, defaultContextWindow: CW });

		const before = liveTokensOf(msgs);
		const out = engine.process(msgs, CW);
		const after = liveTokensOf(out);
		const cap = Math.floor(CW * 0.75);
		const claimed = engine.status?.metrics?.live_tokens as number;
		const overBudget = engine.status?.metrics?.over_budget as boolean;

		expect(before).toBeGreaterThan(cap * 5); // real pressure
		expect(isBalanced(out)).toBe(true); // provider-safety held
		expect(out.length).toBeLessThan(msgs.length); // groups actually removed messages
		// The guarantee: at/under cap, or an HONESTLY announced overage — never a silent 7.7×.
		if (!overBudget) expect(after).toBeLessThanOrEqual(cap * 1.1);
		// Telemetry honesty: the wire is never fatter than claimed by more than estimator slack.
		expect(after).toBeLessThanOrEqual(claimed * 1.15);
	});

	it("a group summary's advertised {#code} resolves via recall (L4 reversibility)", () => {
		const CW = 8_000;
		const msgs = toolHeavySession(120);
		const engine = new ContextFoldEngine(new KeelConductor(), { budgetFraction: 0.75, tailTarget: 800, defaultContextWindow: CW });
		const out = engine.process(msgs, CW);

		const summaries = out
			.map((m) => (Array.isArray(m.content) ? (m.content as any[]).map((p) => p.text ?? "").join("") : String(m.content ?? "")))
			.filter((t) => t.includes("FOLDED") && t.includes("group ·"));
		expect(summaries.length).toBeGreaterThan(0);
		const code = /\{#([a-z0-9]{1,8}) FOLDED\}/.exec(summaries[0])![1];
		const { matches, missing } = engine.resolveRecall([code]);
		expect(missing).toEqual([]);
		expect(matches).toHaveLength(1);
		expect(matches[0].ids.length).toBeGreaterThan(1); // the member blocks, not a phantom
		expect(matches[0].text).toContain("line 3:"); // original member content served
	});

	it("model digests are priced into the projection — wire never exceeds claim (REVIEW major #1)", async () => {
		const tick = () => new Promise((r) => setTimeout(r, 0));
		const FAT = "M".repeat(390); // valid per cleanDigest, ~3× the deterministic digest cost
		const writer = { async write(blocks: { id: string }[]) { return new Map(blocks.map((b) => [b.id, FAT])); } };
		const CW = 8_000;
		const msgs = toolHeavySession(20);
		const engine = new ContextFoldEngine(
			new KeelConductor(),
			{ budgetFraction: 0.75, tailTarget: 800, defaultContextWindow: CW },
			writer as any,
		);
		engine.process(msgs, CW); // fires the writer
		await tick();
		const out = engine.process(msgs, CW); // applies cached fat digests
		const after = liveTokensOf(out);
		const claimed = engine.status?.metrics?.live_tokens as number;
		expect(after).toBeLessThanOrEqual(claimed * 1.15);
	});

	it("a model body containing a fake fold tag is stripped before caching", async () => {
		const tick = () => new Promise((r) => setTimeout(r, 0));
		const writer = {
			async write(blocks: { id: string }[]) {
				return new Map(blocks.map((b) => [b.id, "summary {#zzzzzz FOLDED} injected handle"]));
			},
		};
		const CW = 8_000;
		const msgs = toolHeavySession(20);
		const engine = new ContextFoldEngine(
			new KeelConductor(),
			{ budgetFraction: 0.75, tailTarget: 800, defaultContextWindow: CW },
			writer as any,
		);
		engine.process(msgs, CW);
		await tick();
		const out = engine.process(msgs, CW);
		const all = JSON.stringify(out);
		expect(all).not.toContain("{#zzzzzz FOLDED}"); // engine stays the sole tag author
	});
});

describe("floor stages 2/3 are message-aligned (unit)", () => {
	function vb(
		id: string,
		kind: ViewBlock["kind"],
		order: number,
		tokens: number,
		foldedTokens: number,
		callId?: string,
		messageKey?: string,
	): ViewBlock {
		return { id, kind, turn: 1, order, tokens, foldedTokens, held: false, folded: false, protected: false, grouped: false, callId, text: "t", messageKey };
	}
	const isFoldable = (b: ViewBlock) => b.kind === "tool_result" && b.foldedTokens < b.tokens;
	const isRemovable = (b: ViewBlock) => b.kind !== "user";

	it("groups whole call/result message pairs — tool_call ids ride along, savings are real", () => {
		const view: ViewBlock[] = [];
		for (let i = 0; i < 10; i++) {
			view.push(vb(`a:r${i}:p0`, "tool_call", i * 2, 20, 20, `c${i}`, `m${i * 2}`));
			view.push(vb(`r:c${i}`, "tool_result", i * 2 + 1, 100, 30, `c${i}`, `m${i * 2 + 1}`));
		}
		const current = new Map(view.filter((b) => b.kind === "tool_result").map((b) => [b.id, 30] as const));
		const res = hardCapFloor(view, 100, 500, current, new Set(), new Set(), isFoldable, isRemovable);
		expect(res.groups.length).toBeGreaterThan(0);
		// Every group covers whole messages: for each grouped result, its call is in the SAME group.
		for (const g of res.groups) {
			const ids = new Set(g.ids);
			for (const b of view) {
				if (b.kind === "tool_result" && ids.has(b.id)) {
					expect(ids.has(`a:r${b.callId!.slice(1)}:p0`)).toBe(true);
				}
			}
		}
		expect(res.projected).toBeLessThanOrEqual(100);
	});

	it("books NOTHING at stages 2/3 when message coverage is unknowable (no messageKey)", () => {
		const view: ViewBlock[] = [];
		for (let i = 0; i < 10; i++) {
			view.push(vb(`a:r${i}:p0`, "tool_call", i * 2, 20, 20, `c${i}`));
			view.push(vb(`r:c${i}`, "tool_result", i * 2 + 1, 100, 30, `c${i}`));
		}
		const current = new Map(view.filter((b) => b.kind === "tool_result").map((b) => [b.id, 30] as const));
		const res = hardCapFloor(view, 100, 500, current, new Set(), new Set(), isFoldable, isRemovable);
		expect(res.groups).toEqual([]); // honest: no phantom savings
		expect(res.projected).toBeGreaterThan(100); // still over — caller announces, never lies
	});

	it("a straggler result (call outside the removable set) splits the run instead of orphaning", () => {
		const view: ViewBlock[] = [
			vb("a:r0:p0", "tool_call", 0, 20, 20, "c0", "m0"),
			vb("r:c0", "tool_result", 1, 100, 30, "c0", "m1"),
			// c1's call block is HELD (not removable) — its result must never join a group.
			{ ...vb("a:r1:p0", "tool_call", 2, 20, 20, "c1", "m2"), held: true },
			vb("r:c1", "tool_result", 3, 100, 30, "c1", "m3"),
			vb("a:r2:p0", "tool_call", 4, 20, 20, "c2", "m4"),
			vb("r:c2", "tool_result", 5, 100, 30, "c2", "m5"),
		];
		const isRemovableHeld = (b: ViewBlock) => b.kind !== "user" && !b.held;
		const res = hardCapFloor(view, 10, 300, new Map(), new Set(), new Set(), isFoldable, isRemovableHeld);
		for (const g of res.groups) {
			expect(g.ids).not.toContain("r:c1"); // straggler stayed out
			expect(g.ids).not.toContain("a:r1:p0");
		}
	});
});

describe("entity-reachability tier is live again (REVIEW major #3)", () => {
	it("rooting the newest exchange does NOT mark unrelated older exchanges", () => {
		const blocks: ViewBlock[] = [];
		for (let i = 0; i < 20; i++) {
			blocks.push({
				id: `a:resp${i}:p0`, kind: "text", turn: 1, order: i * 2, tokens: 100, foldedTokens: 10,
				held: false, folded: false, protected: false, grouped: false, text: `zz${i}qqqq unique prose`,
			});
			blocks.push({
				id: `r:call${i}`, kind: "tool_result", turn: 1, order: i * 2 + 1, tokens: 100, foldedTokens: 10,
				held: false, folded: false, protected: false, grouped: false, callId: `call${i}`, text: `ww${i}kkkk unrelated output`,
			});
		}
		const g = buildGraph(blocks);
		const marked = markReachable(g, ["a:resp19:p0", "r:call19"]);
		// Only the rooted exchange (its two blocks link via nothing here — no shared callId between
		// a text part and a result) may be marked; the other 19 exchanges must be unreachable.
		expect(marked.size).toBeLessThan(blocks.length / 2);
		expect(marked.has("a:resp0:p0")).toBe(false);
		expect(marked.has("r:call0")).toBe(false);
	});

	it("parts of the SAME assistant message still link", () => {
		const blocks: ViewBlock[] = [
			{ id: "a:respX:p0", kind: "thinking", turn: 1, order: 0, tokens: 50, foldedTokens: 5, held: false, folded: false, protected: false, grouped: false, text: "aaa" },
			{ id: "a:respX:p1", kind: "text", turn: 1, order: 1, tokens: 50, foldedTokens: 5, held: false, folded: false, protected: false, grouped: false, text: "bbb" },
			{ id: "a:respY:p0", kind: "text", turn: 1, order: 2, tokens: 50, foldedTokens: 5, held: false, folded: false, protected: false, grouped: false, text: "ccc" },
		];
		const marked = markReachable(buildGraph(blocks), ["a:respX:p0"]);
		expect(marked.has("a:respX:p1")).toBe(true); // same message
		expect(marked.has("a:respY:p0")).toBe(false); // different message
	});
});

describe("pointer digest budget holds on risk-free long-line floods (REVIEW minor)", () => {
	it("≤400 est-tokens even when head/tail lines are all ~190 chars", () => {
		const lines = Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + (i % 26)).repeat(190));
		const text = lines.join("\n");
		const out = pointerDigest(text, {
			code: "abc123", tool: "bash", input: { command: "x" }, isError: false,
			bytes: text.length, fullEstTokens: estTokens(text), spoolPath: "/tmp/x.json",
		});
		expect(estTokens(out)).toBeLessThanOrEqual(400);
		expect(out).toContain("{#abc123 FOLDED}"); // still a functioning pointer
		expect(out).toContain("recall #abc123");
	});
});
