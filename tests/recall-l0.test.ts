/*
 * recall-l0.test.ts — spool-backed recall for L0 (gate) folds.
 *
 * Covers byte integrity, partial retrieval via grep/lines, the
 * missing/corrupt error surface, and the kill switch's second half (a prior spool stays recallable
 * with the gate off).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, rmSync as removeFile } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Gate, GATE_DEFAULTS, type GateConfig } from "../src/adapters/pi/gate";
import { SpoolStore } from "../src/adapters/pi/spool";
import { MapGateRegistry } from "../src/core/gate-registry";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderConductor } from "../src/core/policy/fold-ladder";
import { foldCode } from "../src/core/digest";
import { user, assistantWithCalls, toolResult } from "./helpers";
import type { AgentMessage } from "../src/core/block";

const ENABLED: GateConfig = { enabled: true, ...GATE_DEFAULTS };
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cf-recall-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Distinctive flood with a known buried line and enough bulk to clear the fold threshold. */
function floodWith(buried: string): string {
	const lines: string[] = [];
	for (let i = 0; i < 300; i++) lines.push(`row ${i}: ordinary tabular content spanning the width of the terminal for bulk`);
	lines.push(buried);
	for (let i = 300; i < 600; i++) lines.push(`row ${i}: further ordinary tabular content to keep the payload large`);
	return lines.join("\n");
}

function engineWith(reg: MapGateRegistry): ContextFoldEngine {
	return new ContextFoldEngine(new FoldLadderConductor(), { defaultContextWindow: 400_000 }, reg);
}

function foldOne(content: string, callId = "c1", tool = "read", input: unknown = { path: "/x/y.log" }, fullOutputPath?: string) {
	const reg = new MapGateRegistry();
	const store = new SpoolStore(dir);
	const gate = new Gate(ENABLED, reg, () => store);
	const d = gate.observe({ toolName: tool, toolCallId: callId, input, isError: false, content: [{ type: "text", text: content }], fullOutputPath });
	expect(d.folded).toBe(true);
	return { reg, code: d.code! };
}

describe("L0 recall — byte integrity within the re-flood cap ", () => {
	it("a big flood recall is CAPPED: byte-exact prefix + a nudge to slice (recall can't re-flood)", () => {
		const content = floodWith("BURIED: the load-bearing value is 7788");
		const { reg, code } = foldOne(content);
		const engine = engineWith(reg);

		const { matches, missing, errors } = engine.resolveRecall([code]);
		expect(missing).toEqual([]);
		expect(errors).toEqual([]);
		expect(matches).toHaveLength(1);
		// Capped: a prefix of the original, well under the flood's ~11k tokens, with a paging note.
		expect(content.startsWith(matches[0].text)).toBe(true);
		expect(matches[0].text.length).toBeLessThan(content.length / 2);
		expect(matches[0].note).toContain("lines=");
		// The buried line stays reachable through partial retrieval.
		const sliced = engine.resolveRecall([code], { grep: "load-bearing value" });
		expect(sliced.matches[0].text).toContain("BURIED: the load-bearing value is 7788");
	});

	it("an under-cap result recalls byte-identical, sha256-matching the spool", () => {
		const content = ["short result with a", "BURIED: small value 42", "few lines"].join("\n");
		const reg = new MapGateRegistry();
		const store = new SpoolStore(dir);
		// Below the fold threshold — write to the spool directly so recall reads a small envelope.
		store.write({ blockId: "r:cSmall", code: foldCode("r:cSmall"), tool: "read", input: {}, isError: false, content });
		reg.set({
			blockId: "r:cSmall", code: foldCode("r:cSmall"), fullTokens: 30, tool: "read", input: {},
			isError: false, bytes: content.length, fullEstTokens: 25, spoolPath: store.pathFor(foldCode("r:cSmall")),
		});
		const engine = engineWith(reg);
		const { matches } = engine.resolveRecall([foldCode("r:cSmall")]);
		expect(matches[0].text).toBe(content);
		expect(sha(matches[0].text)).toBe(sha(content));
	});

	it("recalls several folds, each a byte-exact CAPPED prefix of its own payload", () => {
		const reg = new MapGateRegistry();
		const store = new SpoolStore(dir);
		const gate = new Gate(ENABLED, reg, () => store);
		const contents: Record<string, string> = {};
		const codes: string[] = [];
		for (let i = 0; i < 3; i++) {
			const text = floodWith(`BURIED marker unique ${i} value ${i * 111}`);
			const cid = `call${i}`;
			gate.observe({ toolName: "read", toolCallId: cid, input: { path: `/f${i}` }, isError: false, content: [{ type: "text", text }] });
			const code = foldCode(`r:${cid}`);
			contents[code] = text;
			codes.push(code);
		}
		const engine = engineWith(reg);
		const { matches } = engine.resolveRecall(codes);
		expect(matches).toHaveLength(3);
		for (const m of matches) expect(contents[m.code].startsWith(m.text)).toBe(true);
	});
});

describe("L0 recall — partial retrieval", () => {
	it("grep returns only matching lines with 1-based numbers", () => {
		const content = floodWith("BURIED: the load-bearing value is 7788");
		const { reg, code } = foldOne(content);
		const engine = engineWith(reg);

		const { matches } = engine.resolveRecall([code], { grep: "load-bearing value" });
		expect(matches[0].text).toContain("BURIED: the load-bearing value is 7788");
		expect(matches[0].text).toMatch(/^301: BURIED/); // the buried line is at index 300 → line 301
		expect(matches[0].text).not.toContain("row 0:"); // non-matching lines excluded
	});

	it("line-range returns exactly that slice, numbered", () => {
		const content = floodWith("BURIED here");
		const { reg, code } = foldOne(content);
		const engine = engineWith(reg);

		const { matches } = engine.resolveRecall([code], { lines: "2-4" });
		const out = matches[0].text.split("\n");
		expect(out).toHaveLength(3);
		expect(out[0]).toBe("2: row 1: ordinary tabular content spanning the width of the terminal for bulk");
		expect(out[2].startsWith("4: row 3:")).toBe(true);
	});

	it("grep with no matches reports it without dumping the payload", () => {
		const content = floodWith("BURIED here");
		const { reg, code } = foldOne(content);
		const engine = engineWith(reg);
		const { matches } = engine.resolveRecall([code], { grep: "no such string anywhere zzz" });
		expect(matches[0].text).toBe("");
		expect(matches[0].note).toMatch(/no lines match/);
	});
});

describe("L0 recall — the missing-spool failure surface", () => {
	it("names the path when the spool file is gone", () => {
		const content = floodWith("BURIED here");
		const { reg, code } = foldOne(content);
		const entry = reg.get(`r:c1`)!;
		removeFile(entry.spoolPath, { force: true }); // simulate a lost spool file

		const engine = engineWith(reg);
		const { matches, errors } = engine.resolveRecall([code]);
		expect(matches).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain(entry.spoolPath);
	});
});

describe("prior spool stays recallable with the gate off", () => {
	it("recall works from registry+spool regardless of the kill switch", () => {
		const content = floodWith("BURIED prior-session value 9001");
		// Fold happened earlier (gate was on); the spool + registry entry persist.
		const { reg, code } = foldOne(content);

		// Now the gate is OFF for the current session — recall must still resolve from disk.
		const disabledGate = new Gate({ enabled: false, ...GATE_DEFAULTS }, reg, () => new SpoolStore(dir));
		expect(disabledGate.observe({ toolName: "read", toolCallId: "cX", input: {}, isError: false, content: [{ type: "text", text: content }] }).reason).toBe("disabled");

		const engine = engineWith(reg);
		const { matches } = engine.resolveRecall([code]);
		expect(content.startsWith(matches[0].text)).toBe(true); // capped prefix — spool still serves
		expect(matches[0].text).toContain("row 0:");
	});
});
