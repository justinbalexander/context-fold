/*
 * persistence.test.ts — event-sourced fold state across restarts.
 *
 * Simulates a resume: session 1 folds + unfolds and appends ledger entries; a FRESH engine +
 * registry in "session 2" rebuilds state from those entries and reproduces the folded view, with
 * every pointer still resolving from the spool.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FOLD_CUSTOM_TYPE,
	recordGateFold,
	recordUnfold,
	restoreFoldState,
	revalidateSpools,
	type EntryAppender,
} from "../src/adapters/pi/persistence";
import { Gate, GATE_DEFAULTS, type GateConfig } from "../src/adapters/pi/gate";
import { SpoolStore } from "../src/adapters/pi/spool";
import { MapGateRegistry } from "../src/core/gate-registry";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { foldCode } from "../src/core/digest";
import { user, assistantWithCalls, toolResult } from "./helpers";
import type { AgentMessage } from "../src/core/block";

const ENABLED: GateConfig = { enabled: true, ...GATE_DEFAULTS };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cf-persist-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A fake session entry log that records appendEntry calls as CustomEntry-shaped objects. */
class FakeLedger implements EntryAppender {
	entries: { type: string; customType: string; data: unknown }[] = [];
	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ type: "custom", customType, data });
	}
}

function flood(tag: string): string {
	const lines = [];
	for (let i = 0; i < 300; i++) lines.push(`row ${i}: ${tag} bulky tabular content spanning the terminal width for size`);
	return lines.join("\n");
}

/** A two-read session used across both simulated runs. */
function twoReadSession(a: string, b: string): AgentMessage[] {
	return [
		user("read both files"),
		assistantWithCalls([{ id: "c1", name: "read" }], { text: "reading a" }),
		toolResult("c1", a),
		user("and the second"),
		assistantWithCalls([{ id: "c2", name: "read" }], { text: "reading b" }),
		toolResult("c2", b),
	];
}

describe("fold ledger round-trip", () => {
	it("restoreFoldState left-folds gate + unfold events (latest gate per block wins)", () => {
		const led = new FakeLedger();
		recordGateFold(led, { blockId: "r:c1", code: "aaa", fullTokens: 100, tool: "read", isError: false, bytes: 1, fullEstTokens: 90, spoolPath: "/x/aaa.json" });
		recordGateFold(led, { blockId: "r:c2", code: "bbb", fullTokens: 200, tool: "read", isError: false, bytes: 2, fullEstTokens: 180, spoolPath: "/x/bbb.json" });
		recordUnfold(led, ["r:c1"]);

		const { gateEntries, unfoldedIds } = restoreFoldState(led.entries);
		expect(gateEntries.map((e) => e.blockId).sort()).toEqual(["r:c1", "r:c2"]);
		expect([...unfoldedIds]).toEqual(["r:c1"]);
		expect(led.entries.every((e) => e.customType === FOLD_CUSTOM_TYPE)).toBe(true);
	});

	it("ignores unrelated custom entries", () => {
		const entries = [{ type: "custom", customType: "someone.else", data: { kind: "gate" } }];
		expect(restoreFoldState(entries).gateEntries).toEqual([]);
	});
});

describe("resume restores fold state and all pointers resolve", () => {
	it("a fresh engine rebuilds the folded view from the ledger; recall still works", () => {
		const a = flood("ALPHA");
		const b = flood("BETA");
		const msgs = twoReadSession(a, b);

		// ── Session 1: gate folds both reads; agent unfolds the first. Ledger captures it all. ──
		const reg1 = new MapGateRegistry();
		const store1 = new SpoolStore(dir);
		const led = new FakeLedger();
		const gate1 = new Gate(ENABLED, reg1, () => store1);
		for (const cid of ["c1", "c2"]) {
			const text = cid === "c1" ? a : b;
			gate1.observe({ toolName: "read", toolCallId: cid, input: { path: `/${cid}` }, isError: false, content: [{ type: "text", text }] });
			recordGateFold(led, reg1.get(`r:${cid}`)!);
		}
		const engine1 = new ContextFoldEngine(new FoldLadderPolicy(), { defaultContextWindow: 400_000 }, reg1);
		engine1.markUnfold([foldCode("r:c1")]);
		recordUnfold(led, ["r:c1"]);

		// ── Session 2 (resume): FRESH registry + engine, rebuild purely from the ledger. ──
		const reg2 = new MapGateRegistry();
		const { gateEntries, unfoldedIds } = restoreFoldState(led.entries);
		const { valid, dropped } = revalidateSpools(gateEntries);
		expect(dropped).toEqual([]); // both spools still on disk
		for (const e of valid) reg2.set(e);
		const engine2 = new ContextFoldEngine(new FoldLadderPolicy(), { defaultContextWindow: 400_000 }, reg2);
		engine2.restoreUnfolded(unfoldedIds);

		const out = engine2.process(msgs, 400_000);
		const results = out.filter((m) => m.role === "toolResult");
		const tr1 = (results[0].content as any)[0].text as string; // r:c1 — unfolded → full
		const tr2 = (results[1].content as any)[0].text as string; // r:c2 — still born-folded → pointer

		expect(tr1).toContain("row 200:"); // unfold restored: full content back
		expect(tr1).not.toContain("recall #");
		expect(tr2).toContain(`{#${foldCode("r:c2")} FOLDED}`); // fold restored: pointer
		expect(tr2).toContain("recall #");

		// And every restored pointer still resolves from the spool (whole recall is token-capped).
		const rec = engine2.resolveRecall([foldCode("r:c2")]);
		expect(b.startsWith(rec.matches[0].text)).toBe(true);
		expect(rec.matches[0].text.length).toBeGreaterThan(0);
	});

	it("revalidation drops a fold whose spool file has vanished (safe degrade)", () => {
		const a = flood("GAMMA");
		const reg = new MapGateRegistry();
		const store = new SpoolStore(dir);
		const led = new FakeLedger();
		const gate = new Gate(ENABLED, reg, () => store);
		gate.observe({ toolName: "read", toolCallId: "c1", input: {}, isError: false, content: [{ type: "text", text: a }] });
		recordGateFold(led, reg.get("r:c1")!);

		// Simulate the spool dir being cleaned between sessions.
		rmSync(dir, { recursive: true, force: true });

		const { gateEntries } = restoreFoldState(led.entries);
		const { valid, dropped } = revalidateSpools(gateEntries);
		expect(valid).toEqual([]);
		expect(dropped).toHaveLength(1);
		expect(dropped[0].code).toBe(foldCode("r:c1"));
	});
});
