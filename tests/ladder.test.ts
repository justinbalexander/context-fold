/*
 * ladder.test.ts — the Keel fidelity ladder's per-unit router (P4.2 of the L0 ingestion-gate
 * plan). Focus: L1 skeleton now that `trySkeleton` is un-stubbed — a code-file read routes to a
 * recoverable skeleton `replace`, while non-code blocks fall through to L2 (trim) / L3 (digest).
 */
import { describe, it, expect } from "vitest";
import { trySkeleton, tryTrim, digestLevel } from "../src/core/policy/ladder";
import { estTokens } from "../src/core/tokens";
import type { ViewBlock } from "../src/core/contract";

// ── Fixtures ────────────────────────────────────────────────────────────────────

/** A large, deterministic Python file: signatures survive skeletonization, bodies do not. */
function bigPython(): string {
	const lines: string[] = ["import math", "from typing import Dict, List", "", "API_CONSTANT = 42", ""];
	for (let c = 0; c < 4; c++) {
		lines.push(`class ArsenalModule${c}:`);
		lines.push(`    """Module ${c} — public surface kept, bodies elided."""`);
		for (let m = 0; m < 4; m++) {
			lines.push(`    def method_${c}_${m}(self, x: int, y: int) -> int:`);
			lines.push(`        """Compute thing ${c}.${m}."""`);
			for (let b = 0; b < 12; b++) {
				lines.push(`        body_local_${c}_${m}_${b} = x * ${b} + y  # filler body line`);
			}
			lines.push(`        return body_local_${c}_${m}_0`);
			lines.push("");
		}
	}
	return lines.join("\n");
}

/** A large TypeScript file with fat method bodies. */
function bigTypeScript(): string {
	const lines: string[] = [`import { readFileSync } from "node:fs";`, "", "export interface Contract {", "\tname: string;", "}", ""];
	for (let c = 0; c < 4; c++) {
		lines.push(`export class Widget${c} {`);
		for (let m = 0; m < 4; m++) {
			lines.push(`\tpublic method_${c}_${m}(x: number, y: number): number {`);
			for (let b = 0; b < 12; b++) lines.push(`\t\tconst body_local_${c}_${m}_${b} = x * ${b} + y;`);
			lines.push(`\t\treturn body_local_${c}_${m}_0;`);
			lines.push("\t}");
		}
		lines.push("}");
		lines.push("");
	}
	return lines.join("\n");
}

const PY = bigPython();
const TS = bigTypeScript();

// ── ViewBlock helpers ─────────────────────────────────────────────────────────

function toolResult(id: string, text: string, opts: { callId?: string; toolName?: string; isError?: boolean } = {}): ViewBlock {
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
		callId: opts.callId,
		toolName: opts.toolName ?? "read",
		isError: opts.isError,
		text,
	};
}

function toolCall(callId: string, text: string, toolName = "read"): ViewBlock {
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
		toolName,
		text,
	};
}

function callMap(...calls: ViewBlock[]): Map<string, ViewBlock> {
	const m = new Map<string, ViewBlock>();
	for (const c of calls) if (c.callId) m.set(c.callId, c);
	return m;
}

// ── L1 skeleton — code-file reads route to a recoverable replace ─────────────────

describe("trySkeleton (L1)", () => {
	it("skeletonizes a large Python code read into a recoverable replace", () => {
		const res = trySkeleton(
			toolResult("r:c1", PY, { callId: "c1" }),
			callMap(toolCall("c1", `read {"path":"arsenal.py"}`)),
			estTokens,
		);
		expect(res).not.toBeNull();
		expect(res!.command.kind).toBe("replace");
		const cmd = res!.command as Extract<NonNullable<typeof res>["command"], { kind: "replace" }>;
		expect(cmd.id).toBe("r:c1");
		expect(cmd.recoverable).toBe(true); // the {#code FOLDED} handle is baked by the host
		expect(cmd.content).toContain("code skeleton"); // the header
		expect(cmd.content).toContain("class ArsenalModule0"); // a kept signature
		expect(cmd.content).toContain("def method_3_3"); // a kept signature
		expect(cmd.content).not.toContain("body_local_0_0_5"); // an elided body local
		expect(res!.tokens).toBeLessThan(estTokens(PY)); // it actually shrinks the block
	});

	it("skeletonizes a large TypeScript code read", () => {
		const res = trySkeleton(
			toolResult("r:c1", TS, { callId: "c1" }),
			callMap(toolCall("c1", `read {"path":"widgets.ts"}`)),
			estTokens,
		);
		expect(res).not.toBeNull();
		const cmd = res!.command as Extract<NonNullable<typeof res>["command"], { kind: "replace" }>;
		expect(cmd.recoverable).toBe(true);
		expect(cmd.content).toContain("interface Contract");
		expect(cmd.content).toContain("class Widget0");
		expect(cmd.content).not.toContain("body_local_0_0_5");
	});

	it("returns null for a markdown read (classifier rejects — degrade to L2/L3)", () => {
		const md = ("# Title\n\nlots of plain prose here. ".repeat(400));
		const res = trySkeleton(
			toolResult("r:c1", md, { callId: "c1" }),
			callMap(toolCall("c1", `read {"path":"README.md"}`)),
			estTokens,
		);
		expect(res).toBeNull();
	});

	it("returns null for a non-tool_result block", () => {
		const text: ViewBlock = { ...toolResult("t1", PY, { callId: "c1" }), kind: "text", toolName: undefined };
		expect(trySkeleton(text, callMap(toolCall("c1", `read {"path":"arsenal.py"}`)), estTokens)).toBeNull();
	});

	it("returns null for a code read below MIN_SKELETON_TOKENS", () => {
		const tiny = "def f(x):\n    return x + 1\n";
		expect(trySkeleton(toolResult("r:c1", tiny, { callId: "c1" }), callMap(toolCall("c1", `read {"path":"a.py"}`)), estTokens)).toBeNull();
	});
});

// ── L2 / L3 fallbacks still work (ladder degrades cleanly when L1 declines) ───────

describe("ladder fallbacks", () => {
	it("tryTrim (L2) trims a long non-code prose result", () => {
		const prose = Array.from({ length: 200 }, (_, i) => `Prose line ${i} describing something in detail.`).join("\n");
		const res = tryTrim(toolResult("r:c1", prose, { callId: "c1" }), estTokens);
		expect(res).not.toBeNull();
		expect(res!.command.kind).toBe("replace");
		const cmd = res!.command as Extract<NonNullable<typeof res>["command"], { kind: "replace" }>;
		expect(cmd.recoverable).toBe(true);
		expect(res!.tokens).toBeLessThan(estTokens(prose));
	});

	it("digestLevel (L3) is the floor for any foldable block", () => {
		const b = toolResult("r:c1", PY, { callId: "c1" });
		const res = digestLevel(b);
		expect(res.command.kind).toBe("fold");
		expect((res.command as Extract<typeof res.command, { kind: "fold" }>).ids).toEqual(["r:c1"]);
		expect(res.tokens).toBe(b.foldedTokens);
	});
});
