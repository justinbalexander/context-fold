/*
 * pointer-digest.test.ts — the born-folded L0 pointer digest + L3 risk-line retention.
 *
 * The load-bearing case: a pytest-style flood with a mid-payload ImportError (the failure the
 * gate exists to prevent). The error line must survive verbatim in BOTH the L0 pointer and the L3
 * aging digest — never reduced to a one-line summary.
 */
import { describe, it, expect } from "vitest";
import { pointerDigest, pointerDigestTokens, digest, collectRiskLines, POINTER_TOKEN_BUDGET, type PointerMeta } from "../src/core/digest";
import { estTokens } from "../src/core/tokens";

const IMPORT_ERROR = "ImportError: No module named 'frobnicate'";

/** ~pytest output: a wall of passing lines with one buried ImportError, then a summary. */
function pytestFlood(): string {
	const lines: string[] = ["============================= test session starts =============================="];
	for (let i = 0; i < 400; i++) lines.push(`tests/test_widget_${i}.py::test_case_${i} PASSED                              [ ${i}%]`);
	lines.push("tests/test_core.py::test_import FAILED");
	lines.push("    from app.core import frobnicate");
	lines.push("E   " + IMPORT_ERROR);
	for (let i = 0; i < 200; i++) lines.push(`tests/test_more_${i}.py::test_x_${i} PASSED`);
	lines.push("=========================== 1 failed, 600 passed ===========================");
	return lines.join("\n");
}

function metaFor(text: string, overrides: Partial<PointerMeta> = {}): PointerMeta {
	return {
		code: "abc123",
		tool: "read",
		input: { path: "/repo/test.log" },
		isError: false,
		bytes: Buffer.byteLength(text, "utf8"),
		fullEstTokens: estTokens(text),
		spoolPath: "/sessions/x/spool/s/abc123.json",
		...overrides,
	};
}

describe("L0 pointer digest", () => {
	it("carries the {#code FOLDED} tag and a recall usage line", () => {
		const text = pytestFlood();
		const p = pointerDigest(text, metaFor(text));
		expect(p.startsWith("{#abc123 FOLDED}")).toBe(true);
		expect(p).toContain("recall #abc123");
		expect(p).toContain("grep=");
		expect(p).toContain("lines=");
	});

	it("retains the buried ImportError line verbatim", () => {
		const text = pytestFlood();
		const p = pointerDigest(text, metaFor(text));
		expect(p).toContain(IMPORT_ERROR);
	});

	it("keeps the budget even when the grep pattern or read path is enormous", () => {
		// The summary line is the one pointer part the budget loops never trim, so unclipped
		// interpolation here is a budget breach with no recourse (it then freezes permanently).
		const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
		const hugePattern = "alternation|".repeat(700); // ~8.4k chars
		const g = pointerDigest(text, metaFor(text, { tool: "grep", input: { pattern: hugePattern } }));
		expect(estTokens(g)).toBeLessThanOrEqual(POINTER_TOKEN_BUDGET);
		const hugePath = "/deep".repeat(1200); // 6k chars
		const r = pointerDigest(text, metaFor(text, { tool: "read", input: { path: hugePath } }));
		expect(estTokens(r)).toBeLessThanOrEqual(POINTER_TOKEN_BUDGET);
	});

	it("shows every line of a short-but-wide result, with no elision marker", () => {
		// 9-16 lines: head+tail would overlap, so the tail is the remainder — nothing may vanish
		// silently between head and tail, and no "…" may claim something did.
		const text = Array.from({ length: 12 }, (_, i) => `entry ${i + 1}: value_${i + 1}`).join("\n");
		const p = pointerDigest(text, metaFor(text));
		for (const probe of ["entry 9", "entry 10", "entry 11", "entry 12"]) expect(p).toContain(probe);
		expect(p).not.toContain("\n…\n");
		// A genuinely long result still elides, with the marker present.
		const flood = pytestFlood();
		expect(pointerDigest(flood, metaFor(flood))).toContain("\n…\n");
	});

	it("respects the ≤400 est-token budget even on a huge flood", () => {
		const text = pytestFlood();
		const p = pointerDigest(text, metaFor(text));
		expect(estTokens(p)).toBeLessThanOrEqual(POINTER_TOKEN_BUDGET);
		expect(pointerDigestTokens(text, metaFor(text))).toBeGreaterThan(0);
	});

	it("shrinks the payload substantially (the whole point of the gate)", () => {
		const text = pytestFlood();
		const p = pointerDigest(text, metaFor(text));
		expect(estTokens(p)).toBeLessThan(estTokens(text) * 0.5);
	});

	it("is tool-aware: read shows the path, grep shows the pattern, bash shows the command", () => {
		const text = "line a\nline b\nline c";
		expect(pointerDigest(text, metaFor(text, { tool: "read", input: { path: "/x/y.ts" } }))).toContain("/x/y.ts");
		expect(pointerDigest(text, metaFor(text, { tool: "grep", input: { pattern: "TODO" } }))).toContain("TODO");
		expect(pointerDigest(text, metaFor(text, { tool: "bash", input: { command: "git log --oneline" } }))).toContain("git log");
	});

	it("notes a dedup hit when dedupOf is set", () => {
		const text = "dup body";
		const p = pointerDigest(text, metaFor(text, { dedupOf: "orig99" }));
		expect(p).toContain("identical to #orig99");
	});

	it("marks the '+N more' hint when risk lines exceed the pointer cap", () => {
		// Many distinct error lines → some retained, the rest summarized as "+N more".
		const lines: string[] = [];
		for (let i = 0; i < 80; i++) lines.push(`Error: failure number ${i} in module_${i}`);
		const text = lines.join("\n");
		const p = pointerDigest(text, metaFor(text));
		expect(p).toMatch(/\+\d+ more — recall #abc123 grep=/);
	});
});

describe("L3 aging digest risk-line retention", () => {
	it("keeps the ImportError verbatim in the standard fold digest (not just a summary line)", () => {
		const text = pytestFlood();
		const b = { id: "r:c1", kind: "tool_result" as const, text, tokens: estTokens(text), toolName: "read", isError: false };
		const d = digest(b);
		expect(d.startsWith("{#")).toBe(true);
		expect(d).toContain(IMPORT_ERROR);
	});

	it("stays bounded on a risk-free result (no bloat)", () => {
		const text = Array.from({ length: 50 }, (_, i) => `plain output line ${i} nothing special here`).join("\n");
		const b = { id: "r:c2", kind: "tool_result" as const, text, tokens: estTokens(text), toolName: "read", isError: false };
		const d = digest(b);
		expect(estTokens(d)).toBeLessThan(150);
	});
});

describe("collectRiskLines", () => {
	it("puts error lines first and dedups", () => {
		const text = ["config: value=42", "Error: boom", "config: value=42", "path/to/file.ts"].join("\n");
		const lines = collectRiskLines(text, { maxLines: 10, maxChars: 1000 });
		expect(lines[0]).toBe("Error: boom");
		expect(lines.filter((l) => l === "config: value=42").length).toBe(1);
	});
});

describe("pointer digest budget holds on risk-free long-line floods", () => {
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
