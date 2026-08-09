/*
 * core.test.ts — the load-bearing mechanism: digest determinism, the protected-tail walk-back,
 * and applyPlan's provider-safety (in-place substitution only, so tool pairs cannot orphan).
 */
import { describe, it, expect } from "vitest";
import { applyPlan } from "../src/core/apply";
import { foldCode, foldTag, digest, wireFoldable } from "../src/core/digest";
import { linearize } from "../src/core/block";
import type { FoldOp } from "../src/core/block";
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
		const out = applyPlan(messages, ops);
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
		const out = applyPlan(messages, ops);
		const asst = out.find((m) => m.role === "assistant")!;
		const callPart = (asst.content as any[]).find((p) => p.type === "toolCall");
		expect(callPart.name).toBe("read"); // untouched
		expect(isBalanced(out)).toBe(true);
	});

	it("keeps parallel tool pairs balanced when only some results fold", () => {
		// The historically dangerous shape: ONE assistant message with two parallel calls. Folding
		// content in place can never strand a partner, because the message count never moves — this
		// asserts that structural property on the shape that used to need an orphan fixpoint.
		const messages = [
			user("parallel work"),
			assistantWithCalls([{ id: "c1", name: "read" }, { id: "c2", name: "grep" }], { text: "doing both" }),
			toolResult("c1", "result one"),
			toolResult("c2", "result two"),
		];
		const out = applyPlan(messages, [{ id: "r:c1", digestText: "{#abc123 FOLDED} read → 1 line" }]);
		expect(isBalanced(out)).toBe(true);
		expect(out.length).toBe(messages.length); // no message added or removed
		expect(toolPairIds(out).results.has("c2")).toBe(true);
		const c2 = out.find((m) => m.role === "toolResult" && m.toolCallId === "c2")!;
		expect((c2.content as any)[0].text).toBe("result two"); // untouched
	});
});

describe("applyPlan — defense in depth", () => {
	it("refuses an op whose id resolves to more than one message (timestamp-anchor collision)", () => {
		// Two assistant messages with no responseId and the same millisecond timestamp compute the
		// same durable id; applying one op to both would overwrite A's conclusion with B's digest.
		const twin = (text: string) =>
			({ role: "assistant", timestamp: 777, content: [{ type: "text", text }] }) as unknown as ReturnType<typeof user>;
		const messages = [user("x"), twin("conclusion A"), twin("conclusion B"), assistantText("unique", "resp9")];
		const out = applyPlan(messages, [{ id: "a:t777:p0", digestText: "{#zzzzzz FOLDED} collided" }]);
		expect(out).toBe(messages); // ambiguous → untouched, same array by reference

		// A non-ambiguous op in the same plan still applies.
		const out2 = applyPlan(messages, [
			{ id: "a:t777:p0", digestText: "{#zzzzzz FOLDED} collided" },
			{ id: "a:resp9:p0", digestText: "{#yyyyyy FOLDED} unique folded" },
		]);
		expect((out2[1].content as any)[0].text).toBe("conclusion A");
		expect((out2[2].content as any)[0].text).toBe("conclusion B");
		expect((out2[3].content as any)[0].text).toContain("unique folded");
	});

	it("ignores non-durable ids and empty digests", () => {
		const messages = [user("x"), assistantText("hi")];
		const before = JSON.stringify(messages);
		const out = applyPlan(messages, [{ id: "m3:p0", digestText: "x" } as FoldOp, { id: "r:c1", digestText: "" } as FoldOp]);
		expect(out).toBe(messages); // identity fast-path: nothing safe to apply
		expect(JSON.stringify(messages)).toBe(before); // input never mutated
	});

	it("is pure: the input array and messages are never mutated", () => {
		const messages = [user("x"), assistantWithCalls([{ id: "c1", name: "read" }], { text: "t" }), bigResult("c1", 50)];
		const snapshot = JSON.stringify(messages);
		applyPlan(messages, [{ id: "r:c1", digestText: "{#aaa111 FOLDED} read → folded" }]);
		expect(JSON.stringify(messages)).toBe(snapshot);
	});
});

describe("opaque tool results (non-text parts)", () => {
	it("linearize marks a mixed image+text result opaque, and wireFoldable refuses it", () => {
		// Folding replaces the whole content array with one text block, so an image inside a mixed
		// result would silently vanish from the view, so the ladder must refuse it.
		const messages = [
			user("look at the page"),
			assistantWithCalls([{ id: "c1", name: "browser" }]),
			{
				role: "toolResult",
				toolCallId: "c1",
				content: [
					{ type: "text", text: "dom text ".repeat(300) },
					{ type: "image", data: "iVBORw0KGgo=" },
				],
			} as unknown as ReturnType<typeof user>,
		];
		const blocks = linearize(messages);
		const tr = blocks.find((b) => b.kind === "tool_result")!;
		expect(tr.opaque).toBe(true);
		expect(wireFoldable(tr)).toBe(false);
		// A text-only result stays foldable.
		const plain = linearize([user("x"), assistantWithCalls([{ id: "c2", name: "read" }]), toolResult("c2", "plain text")]);
		expect(plain.find((b) => b.kind === "tool_result")!.opaque).toBeUndefined();
	});
});
