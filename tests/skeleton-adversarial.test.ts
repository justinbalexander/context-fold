/*
 * skeleton-adversarial.test.ts — hostile-input regressions for the L1 skeletonizer
 * (REVIEW-2026-07-04 §2/§3: mask-length crash, regex hang, no-semicolon depth desync,
 * Rust lifetimes, fail-open at the ladder).
 */
import { describe, it, expect } from "vitest";
import { classifyCodeRead } from "../src/core/skeleton/classify";
import { skeletonize, maskSource, MASK_OPTS } from "../src/core/skeleton/skeletonize";
import { trySkeleton } from "../src/core/policy/ladder";
import type { ViewBlock } from "../src/core/contract";

function toolResult(id: string, text: string, opts: { callId?: string; toolName?: string } = {}): ViewBlock {
	return {
		id, kind: "tool_result", turn: 1, order: 1,
		tokens: Math.ceil(text.length / 4), foldedTokens: 30,
		held: false, folded: false, protected: false, grouped: false,
		callId: opts.callId, toolName: opts.toolName ?? "read", text,
	};
}
function toolCall(callId: string, text: string, toolName = "read"): ViewBlock {
	return {
		id: `call:${callId}`, kind: "tool_call", turn: 1, order: 0,
		tokens: 20, foldedTokens: 20, held: false, folded: false, protected: false, grouped: false,
		callId, toolName, text,
	};
}
function callMap(...calls: ViewBlock[]): Map<string, ViewBlock> {
	const m = new Map<string, ViewBlock>();
	for (const c of calls) if (c.callId) m.set(c.callId, c);
	return m;
}
const count = (t: string) => Math.ceil(t.length / 4);

describe("mask length invariant (the crash class)", () => {
	it("unterminated quote to EOF keeps mask.length === src.length", () => {
		const src = 'const s = "abc\n';
		expect(maskSource(src, MASK_OPTS.ts).length).toBe(src.length);
	});
	it("unterminated backtick to EOF keeps the invariant", () => {
		const src = "const t = `tpl\nmore\n";
		expect(maskSource(src, MASK_OPTS.ts).length).toBe(src.length);
	});
	it("skeletonize survives a truncated read that cuts a string", () => {
		expect(() => skeletonize('const s = "abc\nconst t = 1\n', "ts")).not.toThrow();
	});
	it("rust lifetimes are code, not strings — no crash, bodies still elide", () => {
		const body = Array.from({ length: 30 }, (_, i) => `    let secret_${i} = compute(${i});`).join("\n");
		const src = `pub fn name() -> &'static str {\n${body}\n    "x"\n}\n\npub fn second(a: u32) -> u32 {\n${body}\n    a\n}\n`;
		const sk = skeletonize(src, "rust");
		expect(sk.elidedLines).toBeGreaterThan(0);
		expect(sk.skeleton).not.toContain("secret_5"); // bodies genuinely elided, mask intact
		expect(sk.skeleton).toContain("pub fn second"); // both signatures survive
	});
	it("emoji, CRLF, unterminated comment/string, unterminated triple-quote: no throw", () => {
		const hostile = `export function greet(): string {\r\n  const s = "héllo 🎉🎉";\r\n  return s;\r\n}\r\n/* unterminated\nconst x = "unterminated\nfunction tail() {\n  return 1;\n}`;
		expect(() => skeletonize(hostile, "ts")).not.toThrow();
		expect(() => skeletonize("def f():\n    s = '''never closed\n    x = 1", "python")).not.toThrow();
	});
});

describe("truncation-note stripper is linear (the hang class)", () => {
	it("classifyCodeRead stays fast on huge trailing whitespace runs", () => {
		const code = `export function f(x: number): number {\n  const y = x + 1;\n  return y;\n}\n`;
		const t0 = performance.now();
		for (const k of [1000, 4000, 16000]) {
			classifyCodeRead(
				toolResult("r:c1", code + " ".repeat(k), { callId: "c1" }),
				callMap(toolCall("c1", `read {"path":"f.ts"}`)),
			);
		}
		expect(performance.now() - t0).toBeLessThan(500); // was 8.6s at k=4000 alone
	});
	it("still strips a genuine trailing truncation note", () => {
		const body = Array.from(
			{ length: 30 },
			(_, i) => `export function fn_${i}(x: number): number {\n  const y = x + ${i};\n  return y;\n}`,
		).join("\n");
		const src = `${body}\n… (truncated)`;
		const info = classifyCodeRead(
			toolResult("r:c1", src, { callId: "c1" }),
			callMap(toolCall("c1", `read {"path":"f.ts"}`)),
		);
		expect(info).not.toBeNull();
		expect(info!.source).not.toContain("truncated");
	});
});

describe("semicolon-less style (the depth-desync class)", () => {
	it("interface members survive a bare call statement inside a block", () => {
		const src = [
			`import { log } from "./log"`,
			``,
			`if (dev) {`,
			`  log(hello)`,
			`}`,
			``,
			`export interface Keep {`,
			`  mustSurvive: string`,
			`}`,
			``,
			`function real() {`,
			`  const secret = 1`,
			`  return secret`,
			`}`,
		].join("\n");
		const sk = skeletonize(src, "ts");
		expect(sk.skeleton).toContain("mustSurvive"); // contract member kept whole
		expect(sk.skeleton).not.toContain("const secret"); // real body still elided
	});
});

describe("ladder fail-open (defense in depth)", () => {
	it("a skeletonizer throw degrades the block to null, never propagates", () => {
		// A block whose classify/skeletonize path is fed a hostile payload must at worst decline.
		const hostile = 'pub fn f() -> &\'static str {\n    "x"\n}\n' + 'const s = "unterminated\n';
		const block = toolResult("r:c1", hostile.repeat(200), { callId: "c1" });
		expect(() => trySkeleton(block, callMap(toolCall("c1", `read {"path":"x.rs"}`)), count)).not.toThrow();
	});
	it("a skeleton that would GROW is declined (guard held)", () => {
		const lines: string[] = ["import os", ""];
		for (let i = 0; i < 400; i++) {
			lines.push(`def fn_${i}(a, b):`);
			lines.push(`    pass`);
		}
		const src = lines.join("\n");
		const res = trySkeleton(toolResult("r:c1", src, { callId: "c1" }), callMap(toolCall("c1", `read {"path":"m.py"}`)), count);
		expect(res).toBeNull();
	});
});
