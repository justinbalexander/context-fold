/*
 * gate.test.ts — the L0 gate decision + wiring (P1.3).
 *
 * Covers the fold-decision matrix, the D20 kill-switch resolution, the end-to-end
 * observe→spool→register→substitute path, and criterion 11's inertness guarantee.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gate, resolveGateEnabled, gateConfigFromEnv, gateModelIdentity, GATE_DEFAULTS, type GateConfig, type ToolResultObservation } from "../src/adapters/pi/gate";
import { SpoolStore } from "../src/adapters/pi/spool";
import { MapGateRegistry } from "../src/core/gate-registry";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderConductor } from "../src/core/policy/fold-ladder";
import { foldCode } from "../src/core/digest";
import { user, assistantWithCalls, toolResult } from "./helpers";
import type { AgentMessage } from "../src/core/block";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cf-gate-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const ENABLED: GateConfig = { enabled: true, ...GATE_DEFAULTS };

function bigText(lines: number): string {
	return Array.from({ length: lines }, (_, i) => `plain narrative line ${i} recounting the afternoon in unremarkable detail`).join("\n");
}
function obs(text: string, over: Partial<ToolResultObservation> = {}): ToolResultObservation {
	return { toolName: "read", toolCallId: "c1", input: { path: "/x/y.log" }, isError: false, content: [{ type: "text", text }], ...over };
}
function newGate(cfg: GateConfig, reg = new MapGateRegistry(), store = new SpoolStore(dir)) {
	return { gate: new Gate(cfg, reg, () => store), reg, store };
}

describe("resolveGateEnabled (D20 kill switch)", () => {
	it("is off when unset or 0", () => {
		expect(resolveGateEnabled(undefined, "gpt-5.5")).toBe(false);
		expect(resolveGateEnabled("0", "gpt-5.5")).toBe(false);
		expect(resolveGateEnabled("", "gpt-5.5")).toBe(false);
	});
	it("is on for all models when 1", () => {
		expect(resolveGateEnabled("1", "anything")).toBe(true);
		expect(resolveGateEnabled("1", undefined)).toBe(true);
	});
	it("matches a comma-separated model-id substring allowlist (case-insensitive)", () => {
		expect(resolveGateEnabled("gpt-5.5,qwen", "openai/gpt-5.5")).toBe(true);
		expect(resolveGateEnabled("gpt-5.5,qwen", "Qwen3.6-35B")).toBe(true); // case-insensitive substring
		expect(resolveGateEnabled("Qwen", "qwen3.6-35b-a3b")).toBe(true);
		expect(resolveGateEnabled("gpt-5.5", undefined)).toBe(false); // no model → no match
	});
	it("drops bare numeric tokens (a stray '1' must not match every model id)", () => {
		expect(resolveGateEnabled("1,qwen", "gpt-5.1")).toBe(false); // "1" ignored, "qwen" no match
		expect(resolveGateEnabled("1,qwen", "Qwen3.5-4B")).toBe(true); // "qwen" still matches
	});
	it("matches the backend name carried by an opaque dynamic-provider alias", () => {
		const identity = gateModelIdentity({
			provider: "lemonade-current",
			id: "current",
			name: "Currently loaded on Lemonade: Qwen3.6-35B-A3B-Q8",
		});
		expect(identity).toContain("lemonade-current current");
		expect(resolveGateEnabled("Qwen3.6", identity)).toBe(true);
	});
});

describe("gateConfigFromEnv numeric parsing", () => {
	it("falls back to defaults on absent/invalid values", () => {
		const cfg = gateConfigFromEnv(undefined);
		expect(cfg.threshold).toBe(GATE_DEFAULTS.threshold);
		expect(cfg.minSave).toBe(GATE_DEFAULTS.minSave);
		expect(cfg.errCap).toBe(GATE_DEFAULTS.errCap);
	});
});

describe("gate fold decision matrix", () => {
	it("folds a large result and spools + registers it", () => {
		const { gate, reg, store } = newGate(ENABLED);
		const text = bigText(400);
		const d = gate.observe(obs(text));
		expect(d.folded).toBe(true);
		expect(d.code).toBe(foldCode("r:c1"));
		expect(reg.has("r:c1")).toBe(true);
		expect(existsSync(store.pathFor(d.code!))).toBe(true);
		expect(store.read(d.code!).content).toBe(text);
	});

	it("skips a result below the threshold", () => {
		const { gate, reg } = newGate(ENABLED);
		const d = gate.observe(obs("just a short line or two\nnothing big"));
		expect(d.folded).toBe(false);
		expect(d.reason).toBe("below-threshold");
		expect(reg.size).toBe(0);
	});

	it("exempts an error-shaped result below errCap× threshold (D7)", () => {
		const { gate } = newGate(ENABLED);
		// ~2500 tokens: over the base threshold but under errCap×threshold (8000).
		const text = "ImportError: No module named 'frobnicate'\n" + bigText(160);
		const d = gate.observe(obs(text, { isError: true }));
		expect(d.folded).toBe(false);
		expect(d.reason).toBe("below-threshold");
	});

	it("folds an error-shaped result once it exceeds errCap× threshold, keeping the error line", () => {
		const { gate, store } = newGate(ENABLED);
		const text = "ImportError: No module named 'frobnicate'\n" + bigText(700);
		const d = gate.observe(obs(text, { isError: true }));
		expect(d.folded).toBe(true);
		expect(store.read(d.code!).content).toContain("ImportError: No module named 'frobnicate'");
	});

	it("never gates recall/unfold output (D12)", () => {
		const { gate } = newGate(ENABLED);
		expect(gate.observe(obs(bigText(400), { toolName: "recall" })).reason).toBe("exempt-tool");
		expect(gate.observe(obs(bigText(400), { toolName: "unfold" })).reason).toBe("exempt-tool");
	});

	it("passes through a result carrying a non-text block (D12)", () => {
		const { gate } = newGate(ENABLED);
		const d = gate.observe(obs(bigText(400), { content: [{ type: "text", text: bigText(400) }, { type: "image" } as any] }));
		expect(d.folded).toBe(false);
		expect(d.reason).toBe("non-text");
	});

	it("carries fullOutputPath into the registry (D30)", () => {
		const { gate, reg } = newGate(ENABLED);
		gate.observe(obs(bigText(400), { toolName: "bash", input: { command: "git log" }, fullOutputPath: "/tmp/full.txt" }));
		expect(reg.get("r:c1")?.fullOutputPath).toBe("/tmp/full.txt");
	});
});

// ── criterion 11: kill switch inertness ────────────────────────────────────────
function floodSession(text: string): AgentMessage[] {
	return [user("read the log"), assistantWithCalls([{ id: "c1", name: "read" }], { text: "reading" }), toolResult("c1", text)];
}

describe("criterion 11 — kill-switch inertness", () => {
	it("writes nothing, registers nothing, and leaves the view byte-identical to baseline when disabled", () => {
		const text = bigText(600);
		const reg = new MapGateRegistry();
		const store = new SpoolStore(dir);
		const gate = new Gate({ enabled: false, ...GATE_DEFAULTS }, reg, () => store);

		const d = gate.observe(obs(text));
		expect(d.folded).toBe(false);
		expect(d.reason).toBe("disabled");
		expect(reg.size).toBe(0);
		expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0); // no spool files written

		// The engine's outgoing view is byte-identical to a plain (never-gated) engine — feed BOTH the
		// same message array (the fixture builder stamps fresh timestamps each call).
		const msgs = floodSession(text);
		const withEmptyReg = new ContextFoldEngine(new FoldLadderConductor(), { defaultContextWindow: 400_000 }, reg);
		const baseline = new ContextFoldEngine(new FoldLadderConductor(), { defaultContextWindow: 400_000 }, new MapGateRegistry());
		const a = withEmptyReg.process(msgs, 400_000);
		const b = baseline.process(msgs, 400_000);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("observe→substitute integration", () => {
	it("registers a fold that the context hook then renders as a pointer", () => {
		const text = bigText(600);
		const reg = new MapGateRegistry();
		const store = new SpoolStore(dir);
		const gate = new Gate(ENABLED, reg, () => store);
		gate.observe(obs(text));

		const engine = new ContextFoldEngine(new FoldLadderConductor(), { defaultContextWindow: 400_000 }, reg);
		const out = engine.process(floodSession(text), 400_000);
		const tr = out.find((m) => m.role === "toolResult")!;
		const rendered = (tr.content as any)[0].text as string;
		expect(rendered).toContain(`{#${foldCode("r:c1")} FOLDED}`);
		expect(rendered).toContain("recall #");
	});
});
