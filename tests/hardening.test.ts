/*
 * hardening.test.ts — adapter-level regressions from the 2026-07-04 review:
 * error-lexicon coverage the spool collision guard, kill-switch pointer
 * suppression, and the lines= re-flood cap.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gate, GATE_DEFAULTS, type GateConfig } from "../src/adapters/pi/gate";
import { SpoolStore, SpoolError } from "../src/adapters/pi/spool";
import { MapGateRegistry } from "../src/core/gate-registry";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { foldCode, pointerDigest, collectRiskLines } from "../src/core/digest";
import { categorize } from "../src/core/policy/ledger";
import type { AgentMessage } from "../src/core/block";

const ENABLED: GateConfig = { enabled: true, ...GATE_DEFAULTS };
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cf-hardening-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("error lexicon covers real failure spellings", () => {
	const spellings = [
		"3 failed | 12 passed (15)",
		"fatal: not a git repository",
		"npm ERR! code ELIFECYCLE",
		"Segmentation fault (core dumped)",
		"Permission denied (publickey)",
		"✗ should compute the sum",
		"Aborted (signal 6)",
	];
	for (const line of spellings) {
		it(`detects: "${line}"`, () => {
			expect(categorize(line).errors.length).toBeGreaterThan(0);
		});
	}

	it("a test-runner wall with isError=false gets the errCap threshold (never folds small)", () => {
		// ~2500 est-tokens of output whose only failure signal is a lowercase "failed" summary.
		const filler = Array.from({ length: 150 }, (_, i) => `  ✓ case ${i} renders the widget correctly and matches`).join("\n");
		const text = `${filler}\n Tests  3 failed | 147 passed (150)\n`;
		const gate = new Gate(ENABLED, new MapGateRegistry(), () => new SpoolStore(dir));
		const d = gate.observe({ toolName: "bash", toolCallId: "cT", input: {}, isError: false, content: [{ type: "text", text }] });
		expect(d.folded).toBe(false); // errCap (4×2000) not reached — the failure stays warm
		expect(d.reason).toBe("below-threshold");
	});

	it("when a big error-shaped result DOES fold, the failure line rides the pointer", () => {
		const filler = Array.from({ length: 900 }, (_, i) => `  ✓ case ${i} renders the widget correctly and matches snapshot`).join("\n");
		const text = `${filler}\n Tests  3 failed | 897 passed (900)\n`;
		const risk = collectRiskLines(text, { maxLines: 40, maxChars: 1200 });
		expect(risk.some((l) => l.includes("3 failed"))).toBe(true);
		const out = pointerDigest(text, {
			code: "t3st01", tool: "bash", input: { command: "npx vitest run" }, isError: false,
			bytes: text.length, fullEstTokens: 9000, spoolPath: "/tmp/x.json",
		});
		expect(out).toContain("3 failed");
	});
});

describe("spool collision guard", () => {
	it("refuses to overwrite another block's envelope under the same code", () => {
		const store = new SpoolStore(dir);
		store.write({ blockId: "r:AAA", code: "col111", tool: "read", input: {}, isError: false, content: "first payload" });
		expect(() =>
			store.write({ blockId: "r:BBB", code: "col111", tool: "read", input: {}, isError: false, content: "second payload" }),
		).toThrow(SpoolError);
		expect(store.read("col111").content).toBe("first payload"); // original intact
	});

	it("same block re-spooled with new content overwrites cleanly and drops the stale dedup key", () => {
		const store = new SpoolStore(dir);
		store.write({ blockId: "r:AAA", code: "col222", tool: "read", input: {}, isError: false, content: "v1 content" });
		store.write({ blockId: "r:AAA", code: "col222", tool: "read", input: {}, isError: false, content: "v2 content" });
		expect(store.read("col222").content).toBe("v2 content");
		// A later identical-to-v1 payload must NOT alias to the rewritten file.
		const r = store.write({ blockId: "r:CCC", code: "col333", tool: "read", input: {}, isError: false, content: "v1 content" });
		expect(r.dedupOf).toBeUndefined();
		expect(store.read("col333").content).toBe("v1 content");
	});
});

describe("kill switch controls pointer substitution, not recallability", () => {
	function foldOne(content: string): { reg: MapGateRegistry; code: string } {
		const reg = new MapGateRegistry();
		const gate = new Gate(ENABLED, reg, () => new SpoolStore(dir));
		const d = gate.observe({ toolName: "read", toolCallId: "cK", input: { path: "/big" }, isError: false, content: [{ type: "text", text: content }] });
		expect(d.folded).toBe(true);
		return { reg, code: d.code! };
	}
	const flood = Array.from({ length: 600 }, (_, i) => `row ${i}: bulk content for the kill switch scenario x`).join("\n");
	const msgs: AgentMessage[] = [
		{ role: "user", content: "go", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "cK", name: "read", arguments: {} }], responseId: "rK", timestamp: 2 },
		{ role: "toolResult", toolCallId: "cK", toolName: "read", content: [{ type: "text", text: flood }], timestamp: 3 },
		{ role: "user", content: "next", timestamp: 4 },
	];

	it("gate active → pointer substitutes; gate off → raw renders; recall works either way", () => {
		const { reg, code } = foldOne(flood);
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { defaultContextWindow: 400_000 }, reg);

		engine.setGateActive(true);
		let out = engine.process(msgs, 400_000);
		let tr = (out.find((m) => m.role === "toolResult")!.content as any)[0].text as string;
		expect(tr).toContain(`{#${code} FOLDED}`);

		engine.setGateActive(false); // resumed session, kill switch off 
		out = engine.process(msgs, 400_000);
		tr = (out.find((m) => m.role === "toolResult")!.content as any)[0].text as string;
		expect(tr).toContain("row 200:"); // raw content back
		expect(tr).not.toContain("FOLDED");

		const rec = engine.resolveRecall([code]); // prior spool still recallable (gate.ts:33 promise)
		expect(rec.matches).toHaveLength(1);
	});
});

describe("recall lines= is capped (no re-flood path)", () => {
	it("an unbounded range comes back token-capped with a paging note", () => {
		const flood = Array.from({ length: 800 }, (_, i) => `row ${i}: bulky line for the lines-cap scenario ${"y".repeat(40)}`).join("\n");
		const reg = new MapGateRegistry();
		const gate = new Gate(ENABLED, reg, () => new SpoolStore(dir));
		const d = gate.observe({ toolName: "read", toolCallId: "cL", input: { path: "/big" }, isError: false, content: [{ type: "text", text: flood }] });
		expect(d.folded).toBe(true);
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { defaultContextWindow: 400_000 }, reg);

		const { matches } = engine.resolveRecall([d.code!], { lines: "1-999999" });
		expect(matches).toHaveLength(1);
		expect(matches[0].text.length).toBeLessThan(flood.length / 3); // capped, not the whole flood
		expect(matches[0].note).toContain("narrow");

		const malformed = engine.resolveRecall([d.code!], { lines: "banana" });
		expect(malformed.matches[0].text).toBe(""); // malformed spec no longer dumps everything
		expect(malformed.matches[0].note).toContain("malformed");
	});
});
