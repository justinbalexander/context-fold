/*
 * core.test.ts — the load-bearing mechanism: digest determinism, the protected-tail walk-back,
 * and applyPlan's orphan-prevention fixpoint + single-disposition guarantee.
 */
import { describe, it, expect } from "vitest";
import { applyPlan } from "../src/core/apply";
import { foldCode, foldTag, digest } from "../src/core/digest";
import { linearize } from "../src/core/block";
import type { FoldOp, GroupOp } from "../src/core/block";
import { protectedFromIndex } from "../src/adapters/pi/store";
import { assistantWithCalls, toolResult, user, assistantText, bigResult, isBalanced, toolPairIds } from "./helpers";

describe("digest determinism", () => {
	it("foldCode is a stable 6-char base36 hash of the id", () => {
		expect(foldCode("r:c1")).toBe(foldCode("r:c1"));
		expect(foldCode("r:c1")).toMatch(/^[0-9a-z]{6}$/);
		expect(foldCode("r:c1")).not.toBe(foldCode("r:c2"));
	});
	it("foldable digests carry the {#code FOLDED} tag; the code matches the id", () => {
		const b = { id: "r:c1", kind: "tool_result" as const, text: "hello world", tokens: 3, toolName: "read", isError: false };
		const d = digest(b);
		expect(d.startsWith(foldTag("r:c1"))).toBe(true);
		expect(d).toContain(`{#${foldCode("r:c1")} FOLDED}`);
	});
});

describe("protectedFromIndex", () => {
	it("protects nothing when target is 0", () => {
		expect(protectedFromIndex([{ tokens: 10 }, { tokens: 10 }], 0)).toBe(2);
	});
	it("always protects the newest block when target>0, even if it alone exceeds the cap", () => {
		const blocks = [{ tokens: 10 }, { tokens: 10 }, { tokens: 9999 }];
		expect(protectedFromIndex(blocks, 100)).toBe(2); // only the last block
	});
	it("walks back to cover ~target tokens", () => {
		const blocks = [{ tokens: 50 }, { tokens: 50 }, { tokens: 50 }, { tokens: 50 }];
		// target 100, cap 125: last (50) <100, +50=100>=target → return index 2
		expect(protectedFromIndex(blocks, 100)).toBe(2);
	});
});

describe("applyPlan — in-place folds keep tool pairs", () => {
	it("folds a tool_result in place without orphaning its call", () => {
		const messages = [
			user("do the thing"),
			assistantWithCalls([{ id: "c1", name: "read" }], { text: "reading" }),
			toolResult("c1", "a".repeat(400)),
		];
		const ops: FoldOp[] = [{ id: "r:c1", digestText: "{#abc123 FOLDED} read → 1 line" }];
		const out = applyPlan(messages, ops, []);
		expect(isBalanced(out)).toBe(true);
		// The result content was substituted.
		const tr = out.find((m) => m.role === "toolResult")!;
		expect((tr.content as any)[0].text).toContain("FOLDED");
	});

	it("never folds a tool_call (would orphan its result)", () => {
		const messages = [
			user("x"),
			assistantWithCalls([{ id: "c1", name: "read" }]),
			toolResult("c1", "data"),
		];
		// Try to fold the assistant tool_call part by its id — applyPlan must ignore it.
		const blocks = linearize(messages);
		const callBlock = blocks.find((b) => b.kind === "tool_call")!;
		const ops: FoldOp[] = [{ id: callBlock.id, digestText: "{#zzzzzz FOLDED} should-not-apply" }];
		const out = applyPlan(messages, ops, []);
		const asst = out.find((m) => m.role === "assistant")!;
		const callPart = (asst.content as any[]).find((p) => p.type === "toolCall");
		expect(callPart.name).toBe("read"); // untouched
		expect(isBalanced(out)).toBe(true);
	});
});

describe("applyPlan — orphan-prevention fixpoint with parallel tool calls", () => {
	it("refuses a group that would strand a parallel tool-pair partner", () => {
		// One assistant msg with TWO parallel calls c1, c2; results for each.
		const messages = [
			user("parallel work"),
			assistantWithCalls([{ id: "c1", name: "read" }, { id: "c2", name: "grep" }], { text: "doing both" }),
			toolResult("c1", "result one"),
			toolResult("c2", "result two"),
		];
		// Group covers the assistant message + ONLY c1's result (c2's result left outside).
		// The assistant has calls {c1,c2}; grouping it requires BOTH results inside → c2 unbalanced
		// → assistant demoted → c1's result now stranded → cascade → nothing removable.
		const asstId = linearize(messages).find((b) => b.kind === "tool_call")!.id; // a:...:p1 (first call part)
		const group: GroupOp = {
			id: "g:test",
			memberIds: [asstId, "a:" + "x", "r:c1"], // imprecise members; the point is r:c2 is excluded
			summaryText: "summary",
		};
		const out = applyPlan(messages, [], [group]);
		// Whatever the engine decides, the output MUST stay balanced (no orphaned pair reaches the wire).
		expect(isBalanced(out)).toBe(true);
		// And c2's result must still be present (it could never be safely removed here).
		expect(toolPairIds(out).results.has("c2")).toBe(true);
	});

	it("removes a fully-balanced group (both calls AND both results inside)", () => {
		const messages = [
			user("setup"),
			assistantWithCalls([{ id: "c1", name: "read" }, { id: "c2", name: "grep" }]),
			toolResult("c1", "r1"),
			toolResult("c2", "r2"),
			user("now continue"),
			assistantText("done"),
		];
		const blocks = linearize(messages);
		// Members: the assistant's two tool_call parts + both tool_results — a whole balanced span.
		const memberIds = blocks
			.filter((b) => b.kind === "tool_call" || b.kind === "tool_result")
			.map((b) => b.id);
		const group: GroupOp = { id: "g:test", memberIds, summaryText: "{#grp000 FOLDED} group · 4 blocks" };
		const out = applyPlan(messages, [], [group]);
		expect(isBalanced(out)).toBe(true);
		// The two tool messages collapsed into one summary → no tool pairs remain.
		expect(toolPairIds(out).calls.size).toBe(0);
		expect(toolPairIds(out).results.size).toBe(0);
		// A synthetic summary message was inserted.
		expect(JSON.stringify(out)).toContain("group · 4 blocks");
	});

	it("drops a balanced group when summaryText is null (no message inserted)", () => {
		const messages = [
			user("setup"),
			assistantWithCalls([{ id: "c1", name: "read" }]),
			toolResult("c1", "r1"),
			user("continue"),
		];
		const blocks = linearize(messages);
		const memberIds = blocks.filter((b) => b.kind === "tool_call" || b.kind === "tool_result").map((b) => b.id);
		const out = applyPlan(messages, [], [{ id: "g:d", memberIds, summaryText: null }]);
		expect(isBalanced(out)).toBe(true);
		// The assistant message held ONLY the tool_call, so it is dropped too (whole-message,
		// balanced): [user, <call+result dropped>, user] → 2 messages, no summary inserted.
		expect(out.length).toBe(2);
		expect(out.every((m) => m.role === "user")).toBe(true);
	});
});

describe("applyPlan — defense in depth", () => {
	it("ignores non-durable ids and empty digests", () => {
		const messages = [user("x"), assistantText("hi")];
		const before = JSON.stringify(messages);
		const out = applyPlan(messages, [{ id: "m3:p0", digestText: "x" } as FoldOp, { id: "r:c1", digestText: "" } as FoldOp], []);
		expect(out).toBe(messages); // identity fast-path: nothing safe to apply
		expect(JSON.stringify(messages)).toBe(before); // input never mutated
	});

	it("is pure: the input array and messages are never mutated", () => {
		const messages = [user("x"), assistantWithCalls([{ id: "c1", name: "read" }], { text: "t" }), bigResult("c1", 50)];
		const snapshot = JSON.stringify(messages);
		applyPlan(messages, [{ id: "r:c1", digestText: "{#aaa111 FOLDED} read → folded" }], []);
		expect(JSON.stringify(messages)).toBe(snapshot);
	});
});
