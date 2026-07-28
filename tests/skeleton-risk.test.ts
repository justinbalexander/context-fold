/*
 * skeleton-risk.test.ts — L1 risk-line retention (Phase 6): a throw/raise/TODO buried in an
 * elided body survives IN PLACE in the skeleton, the way the L2 trim keeps risk lines in prose.
 * Also pins the elidedLines double-count fix (a 4-line brace body used to report 8 elided).
 */
import { describe, it, expect } from "vitest";
import { skeletonize } from "../src/core/skeleton/skeletonize";
import { trySkeleton } from "../src/core/policy/ladder";
import { estTokens } from "../src/core/tokens";
import type { ViewBlock } from "../src/core/contract";

describe("brace-language risk retention", () => {
	const src = [
		"export function f(a: number): number {",
		"  const x = a + 1;",
		"  // TODO: handle negative a",
		"  if (x < 0) throw new Error(`bad input ${x}`);",
		'  const s = "never throw here";',
		"  return x;",
		"}",
	].join("\n");

	it("retains TODO and throw lines in place with correct gap markers", () => {
		const r = skeletonize(src, "ts");
		const lines = r.skeleton.split("\n");
		expect(lines).toEqual([
			"export function f(a: number): number {",
			"  /* … 1 line */",
			"  // TODO: handle negative a",
			"  if (x < 0) throw new Error(`bad input ${x}`);",
			"/* … 2 lines */ }",
		]);
		// Counts honest: 5 body lines, 2 retained → 3 elided.
		expect(r.totalLines).toBe(7);
		expect(r.elidedLines).toBe(3);
		expect(r.keptLines).toBe(lines.length);
	});

	it('a "throw" inside a string literal does NOT trigger retention', () => {
		const r = skeletonize(src, "ts");
		expect(r.skeleton).not.toContain("never throw here");
	});

	it("member access and identifier tails do not trigger (.throw, rethrow)", () => {
		const s = [
			"function g() {",
			"  api.throw();",
			"  const rethrowCount = 1;",
			"  return rethrowCount;",
			"}",
		].join("\n");
		const r = skeletonize(s, "ts");
		expect(r.skeleton).toBe("function g() { /* … 3 lines */ }");
	});

	it("risk-free bodies keep the compact one-line collapse, with honest counts (double-count fix)", () => {
		const s = [
			"export function f(a: number): number {",
			"  const x = a + 1;",
			"  const y = x * 2;",
			"  const z = y - 3;",
			"  return z;",
			"}",
		].join("\n");
		const r = skeletonize(s, "ts");
		expect(r.skeleton).toBe("export function f(a: number): number { /* … 4 lines */ }");
		expect(r.elidedLines).toBe(4); // was 8 before the fix
		expect(r.keptLines).toBe(1);
	});

	it("caps retention at 4 risk lines per body", () => {
		const body = Array.from({ length: 7 }, (_, i) => `  if (a === ${i}) throw new Error("case ${i}");`);
		const s = ["function h(a: number) {", ...body, "}"].join("\n");
		const r = skeletonize(s, "ts");
		const retained = r.skeleton.split("\n").filter((l) => l.includes("throw new Error"));
		expect(retained).toHaveLength(4);
		expect(r.skeleton).toContain("/* … 3 lines */"); // the 3 uncapped throws stay elided
	});

	it("balanced one-line bodies are kept whole, failure signals included", () => {
		const s = [
			"function boom(): never { throw new Error('always'); }",
			"function calm(): number { return 42; }",
		].join("\n");
		const r = skeletonize(s, "ts");
		expect(r.skeleton).toContain("throw new Error('always')");
		expect(r.skeleton).toContain("function calm(): number { return 42; }");
	});

	it("rust panic! is retained; a lifetime apostrophe does not break it", () => {
		const s = [
			"fn parse<'a>(input: &'a str) -> &'a str {",
			"    let mut out = input;",
			"    if out.is_empty() { panic!(\"empty input\"); }",
			"    out",
			"}",
		].join("\n");
		const r = skeletonize(s, "rust");
		expect(r.skeleton).toContain("panic!");
	});

	it("survives an unterminated body (EOF flush carries retained risk lines)", () => {
		const s = [
			"function truncated(a: number) {",
			"  const x = a;",
			"  throw new Error('kept even when the close brace never arrives');",
			"  const y = x;",
		].join("\n");
		const r = skeletonize(s, "ts");
		expect(r.skeleton).toContain("throw new Error('kept even when the close brace never arrives')");
		expect(r.skeleton.trimEnd().endsWith("}")).toBe(true);
		expect(r.elidedLines).toBe(2);
	});
});

describe("python risk retention", () => {
	it("retains raise and FIXME lines in place between `...` stubs", () => {
		const s = [
			"def g(a):",
			'    """Doc."""',
			"    x = a + 1",
			"    # FIXME: off by one",
			"    if x < 0:",
			"        raise ValueError(f'bad {x}')",
			"    return x",
		].join("\n");
		const r = skeletonize(s, "python");
		const lines = r.skeleton.split("\n");
		expect(lines).toEqual([
			"def g(a):",
			'    """Doc."""',
			"    ...  # … 1 line",
			"    # FIXME: off by one",
			"    ...  # … 1 line",
			"        raise ValueError(f'bad {x}')",
			"    ...  # … 1 line",
		]);
		expect(r.elidedLines).toBe(3);
	});

	it('a "raise" inside a string does NOT trigger retention', () => {
		const s = [
			"def h(a):",
			'    msg = "we never raise here"',
			"    x = a * 2",
			"    y = x + 1",
			"    return y",
		].join("\n");
		const r = skeletonize(s, "python");
		expect(r.skeleton).not.toContain("never raise here");
		expect(r.skeleton).toContain("...  # … 4 lines");
	});

	it("clips a pathological risk line", () => {
		const s = ["def k(a):", `    raise ValueError("${"x".repeat(500)}")`, "    return a"].join("\n");
		const r = skeletonize(s, "python");
		const riskLine = r.skeleton.split("\n").find((l) => l.includes("raise ValueError"));
		expect(riskLine).toBeDefined();
		expect(riskLine!.length).toBeLessThanOrEqual(200);
		expect(riskLine!.endsWith("…")).toBe(true);
	});
});

describe("trySkeleton end-to-end", () => {
	function toolResult(id: string, text: string, callId: string): ViewBlock {
		return {
			id,
			kind: "tool_result",
			turn: 1,
			order: 1,
			tokens: estTokens(text),
			foldedTokens: 30,
			held: false,
			folded: false,
			protected: false,
			grouped: false,
			callId,
			toolName: "read",
			text,
		};
	}
	function toolCall(callId: string, path: string): ViewBlock {
		return {
			id: `call:${callId}`,
			kind: "tool_call",
			turn: 1,
			order: 0,
			tokens: 20,
			foldedTokens: 20,
			held: false,
			folded: false,
			protected: false,
			grouped: false,
			callId,
			toolName: "read",
			text: JSON.stringify({ path }),
		};
	}

	it("the L1 replace carries retained risk lines through to the skeleton content", () => {
		// A file big enough to clear MIN_SKELETON_TOKENS, with one buried throw.
		const lines: string[] = [`import { x } from "./x";`, ""];
		for (let c = 0; c < 6; c++) {
			lines.push(`export function fn_${c}(a: number, b: number): number {`);
			for (let b = 0; b < 30; b++) lines.push(`  const local_${c}_${b} = a * ${b} + b;`);
			if (c === 3) lines.push(`  throw new Error("buried failure signal ${c}");`);
			lines.push(`  return local_${c}_0;`);
			lines.push("}");
			lines.push("");
		}
		const src = lines.join("\n");
		const call = toolCall("c1", "/tmp/big.ts");
		const block = toolResult("r:c1", src, "c1");
		const res = trySkeleton(block, new Map([["c1", call]]), estTokens);
		expect(res).not.toBeNull();
		const content = (res!.command as { content: string }).content;
		expect(content).toContain('throw new Error("buried failure signal 3")');
		// Still a real skeleton: filler body lines are gone and it pays for itself.
		expect(content).not.toContain("local_2_15");
		expect(res!.tokens).toBeLessThan(block.tokens * 0.6);
	});
});
