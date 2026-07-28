/*
 * skeleton.test.ts — behavioural tests for the ported code-skeleton modules (classify +
 * skeletonize), P4.1 of the L0 ingestion-gate plan.
 *
 * Ported from Accordion `app/src/lib/engine/conductor.code-skeleton.test.ts` (pinned commit
 * 0c22434), adapted: Accordion drove the assertions through its `CodeSkeletonConductor` +
 * `AccordionStore`; this port has neither (the skeletonizer is wired straight into Keel's
 * fidelity ladder — see tests/ladder.test.ts). So the same fixtures and behavioural claims are
 * exercised directly against `classifyCodeRead` and `skeletonize`, which is where the behaviour
 * actually lives.
 */
import { describe, it, expect } from "vitest";
import { classifyCodeRead } from "../src/core/skeleton/classify";
import { detectLang, skeletonize } from "../src/core/skeleton/skeletonize";
import type { ViewBlock } from "../src/core/contract";

// ── Fixtures (ported from the Accordion suite) ──────────────────────────────────

/** A sizeable, deterministic Python file: 4 classes × 4 methods, fat bodies. Its method
 *  SIGNATURES (method_c_m) must survive skeletonization; its body locals (body_local_*) must
 *  not. ~250 lines / ~2.7k tokens. */
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

/** A sizeable TypeScript file: interfaces + classes with fat method bodies. Signatures survive,
 *  body locals elided. */
function bigTypeScript(): string {
	const lines: string[] = [
		`import { readFileSync } from "node:fs";`,
		`import type { Foo } from "./foo";`,
		"",
		"export interface Contract {",
		"\tname: string;",
		"\tvalue: number;",
		"}",
		"",
	];
	for (let c = 0; c < 4; c++) {
		lines.push(`export class Widget${c} {`);
		for (let m = 0; m < 4; m++) {
			lines.push(`\tpublic method_${c}_${m}(x: number, y: number): number {`);
			for (let b = 0; b < 12; b++) {
				lines.push(`\t\tconst body_local_${c}_${m}_${b} = x * ${b} + y; // filler body line`);
			}
			lines.push(`\t\treturn body_local_${c}_${m}_0;`);
			lines.push("\t}");
		}
		lines.push("}");
		lines.push("");
	}
	return lines.join("\n");
}

/** A sizeable markdown README — prose, NOT code. Must never be classified as a code read. */
function bigMarkdown(): string {
	const lines: string[] = ["# Arsenal Bot", "", "Strategy notes for the battleship variant.", ""];
	for (let i = 0; i < 80; i++) {
		lines.push(`## Section ${i}`, "");
		lines.push(`This section describes behaviour number ${i} in plain prose. `.repeat(4));
		lines.push("");
	}
	return lines.join("\n");
}

const PY = bigPython();
const TS = bigTypeScript();
const MD = bigMarkdown();

// ── ViewBlock helpers ───────────────────────────────────────────────────────────

function toolResult(id: string, text: string, opts: { callId?: string; toolName?: string; isError?: boolean } = {}): ViewBlock {
	return {
		id,
		kind: "tool_result",
		turn: 1,
		order: 1,
		tokens: Math.ceil(text.length / 4),
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

// ── 1. classifyCodeRead — precision-critical gating ─────────────────────────────

describe("classifyCodeRead", () => {
	it("accepts a large Python code-file read and returns cleaned source + path", () => {
		const info = classifyCodeRead(
			toolResult("r:c1", PY, { callId: "c1" }),
			callMap(toolCall("c1", `read {"path":"arsenal.py"}`)),
		);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("arsenal.py");
		expect(info!.source).toContain("class ArsenalModule0");
	});

	it("accepts a TypeScript code-file read", () => {
		const info = classifyCodeRead(
			toolResult("r:c1", TS, { callId: "c1" }),
			callMap(toolCall("c1", `read {"path":"widgets.ts"}`)),
		);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("widgets.ts");
	});

	it("rejects a markdown read (prose, not code)", () => {
		const info = classifyCodeRead(
			toolResult("r:c1", MD, { callId: "c1" }),
			callMap(toolCall("c1", `read {"path":"README.md"}`)),
		);
		expect(info).toBeNull();
	});

	it("rejects an error result", () => {
		const info = classifyCodeRead(
			toolResult("r:c1", PY, { callId: "c1", isError: true }),
			callMap(toolCall("c1", `read {"path":"arsenal.py"}`)),
		);
		expect(info).toBeNull();
	});

	it("rejects a grep dump (wrong tool family)", () => {
		const info = classifyCodeRead(
			toolResult("r:c1", PY, { callId: "c1", toolName: "grep" }),
			callMap(toolCall("c1", `grep {"pattern":"def"}`, "grep")),
		);
		expect(info).toBeNull();
	});

	it("accepts a single-file `cat FILE.py` shell dump", () => {
		const info = classifyCodeRead(
			toolResult("r:c1", PY, { callId: "c1", toolName: "bash" }),
			callMap(toolCall("c1", `bash {"command":"cat arsenal.py"}`, "bash")),
		);
		expect(info).not.toBeNull();
	});

	it("rejects a piped shell command (not a clean single-file dump)", () => {
		const info = classifyCodeRead(
			toolResult("r:c1", PY, { callId: "c1", toolName: "bash" }),
			callMap(toolCall("c1", `bash {"command":"cat arsenal.py | head"}`, "bash")),
		);
		expect(info).toBeNull();
	});

	it("strips `cat -n` line-number prefixes from the cleaned source", () => {
		const numbered = PY.split("\n").map((l, i) => `${String(i + 1).padStart(5)}\t${l}`).join("\n");
		const info = classifyCodeRead(
			toolResult("r:c1", numbered, { callId: "c1" }),
			callMap(toolCall("c1", `read {"path":"arsenal.py"}`)),
		);
		expect(info).not.toBeNull();
		expect(info!.source.split("\n")[0]).toBe("import math"); // prefix gone
	});
});

// ── 2. detectLang ───────────────────────────────────────────────────────────────

describe("detectLang", () => {
	it("maps extensions to languages", () => {
		expect(detectLang("arsenal.py", PY)).toBe("python");
		expect(detectLang("widgets.ts", TS)).toBe("ts");
		expect(detectLang("Main.java", "class Main {}")).toBe("java");
	});

	it("sniffs the language from content when the path is missing", () => {
		expect(detectLang(undefined, PY)).toBe("python");
		expect(detectLang(undefined, TS)).toBe("ts");
	});
});

// ── 3. skeletonize — signatures survive, bodies elided ──────────────────────────

describe("skeletonize", () => {
	it("keeps Python signatures + docstrings and elides method bodies", () => {
		const sk = skeletonize(PY, "python");
		expect(sk.elidedLines).toBeGreaterThan(0);
		expect(sk.keptLines).toBeLessThanOrEqual(sk.totalLines);
		expect(sk.skeleton).toContain("class ArsenalModule0");
		expect(sk.skeleton).toContain("def method_3_3"); // a kept signature
		expect(sk.skeleton).not.toContain("body_local_0_0_5"); // an elided body local
	});

	it("keeps TypeScript signatures + interfaces and elides method bodies", () => {
		const sk = skeletonize(TS, "ts");
		expect(sk.elidedLines).toBeGreaterThan(0);
		expect(sk.skeleton).toContain("interface Contract");
		expect(sk.skeleton).toContain("class Widget0");
		expect(sk.skeleton).toContain("method_3_3"); // a kept signature
		expect(sk.skeleton).not.toContain("body_local_0_0_5"); // an elided body local
	});

	it("is deterministic — same input yields byte-identical output", () => {
		expect(skeletonize(PY, "python").skeleton).toBe(skeletonize(PY, "python").skeleton);
		expect(skeletonize(TS, "ts").skeleton).toBe(skeletonize(TS, "ts").skeleton);
	});

	it("returns a valid degenerate skeleton for empty input", () => {
		expect(skeletonize("", "ts")).toEqual({ skeleton: "", totalLines: 0, keptLines: 0, elidedLines: 0 });
	});
});
