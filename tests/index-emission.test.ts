/*
 * index-emission.test.ts — the adapter's fold-event → seed-index pipeline: masked blocks get
 * fold records (sha256 anchored to the block text), spans carry the extent and fold-time sha,
 * the JSONL record carries the planted mid-output identifiers, and resume keeps appending
 * instead of rewriting.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { MapFoldRegistry } from "../src/core/fold-registry";
import { sha256Hex } from "../src/adapters/pi/ledger";
import { SeedIndexStore, emitFoldIndex } from "../src/adapters/pi/index-store";
import { linearize, type AgentMessage } from "../src/core/block";
import { user, assistantText, assistantWithCalls, bigResult, toolResult } from "./helpers";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
	dir = mkdtempSync(join(tmpdir(), "contextfold-index-"));
	const registry = new MapFoldRegistry();
	const index = new SeedIndexStore(dir);
	const e = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, registry);
	e.onFoldEvent = (ev) => emitFoldIndex(ev, { registry, index, sessionId: "s-test", now: 1_722_200_000_000 });
	return { e, registry, index };
}

function bigSession(): AgentMessage[] {
	const messages: AgentMessage[] = [user("find the capacity limit in the dump")];
	for (let i = 0; i < 7; i++) {
		messages.push(assistantWithCalls([{ id: `c${i}`, name: "read" }]));
		messages.push(bigResult(`c${i}`, 400));
	}
	// One result with planted mid-output facts (the summary-boundary probe class).
	messages.push(assistantWithCalls([{ id: "cx", name: "bash", args: { cmd: "npx vitest run" } }]));
	const lines = Array.from({ length: 300 }, (_, i) => `row ${i}: ${"y".repeat(40)}`);
	lines[150] = "    CAP_X9_LIMIT=52418 assigned to shard 3f9a2c7e11d04b22";
	lines[171] = "  2 passed, 1 failed";
	messages.push(toolResult("cx", lines.join("\n"), "bash"));
	messages.push(assistantText("finished reading", "after-cx"));
	messages.push(user("now the newest question"));
	return messages;
}

describe("seed-index emission at fold events", () => {
	it("writes one record per event with spans whose sha256 anchors the masked block text", () => {
		const { e, index } = setup();
		const messages = bigSession();
		e.process(messages, { contextWindow: 80_000, tokens: null });

		const records = index.readAll();
		expect(records.length).toBe(1);
		const rec = records[0];
		expect(rec.harness).toBe("pi-context-fold");
		expect(rec.session).toBe("s-test");
		expect(rec.trigger).toBe("threshold");
		expect(rec.spans.length).toBeGreaterThan(0);

		// Every span's sha256 verifies against the source block text, and its extent matches.
		const byId = new Map(linearize(messages).map((b) => [b.id, b] as const));
		for (const span of rec.spans) {
			const block = byId.get(span.blockId);
			expect(block).toBeDefined();
			expect(span.sha256).toBe(sha256Hex(block!.text));
			expect(span.log.bytes).toBe(Buffer.byteLength(block!.text, "utf8"));
		}
	});

	it("carries planted mid-output identifiers and lowercase-failed errors (index fidelity)", () => {
		const { e, index } = setup();
		e.process(bigSession(), { contextWindow: 80_000, tokens: null });
		const rec = index.readAll()[0];
		expect(rec.identifiers).toContain("CAP_X9_LIMIT");
		expect(rec.identifiers).toContain("52418");
		expect(rec.identifiers).toContain("3f9a2c7e11d04b22");
		expect(rec.errors).toContain("2 passed, 1 failed");
		expect(rec.commands.some((c) => c.includes("npx vitest run"))).toBe(true);
		expect(rec.userMessages[0].firstLine).toContain("capacity limit");
	});

	it("a masked block's registry entry names its extent and fold-time sha", () => {
		const { e, registry, index } = setup();
		const messages = bigSession();
		e.process(messages, { contextWindow: 80_000, tokens: null });
		const rec = index.readAll()[0];
		const span = rec.spans.find((s) => s.blockId === "r:cx");
		expect(span).toBeDefined();
		const entry = registry.get("r:cx");
		expect(entry).toBeDefined();
		const text = linearize(messages).find((b) => b.id === "r:cx")!.text;
		expect(entry!.sha256).toBe(sha256Hex(text));
		expect(text.split("\n").length).toBe(span!.log.lines);
	});

	it("appends across events — earlier records are never rewritten", () => {
		const { e, index } = setup();
		const messages = bigSession();
		e.process(messages, { contextWindow: 80_000, tokens: null });
		const afterFirst = index.readAll().length;

		for (let i = 20; i < 28; i++) {
			messages.splice(messages.length - 1, 0, assistantWithCalls([{ id: `c${i}`, name: "read" }]), bigResult(`c${i}`, 400));
		}
		e.process(messages, { contextWindow: 80_000, tokens: null });
		const records = index.readAll();
		expect(records.length).toBeGreaterThan(afterFirst);
		expect(records[0].seq).toBe(1); // first record intact
	});

	it("publishes registry entries only after index and fold-record persistence succeed", () => {
		dir = mkdtempSync(join(tmpdir(), "contextfold-index-"));
		const registry = new MapFoldRegistry();
		const index = new SeedIndexStore(dir);
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, registry);
		let event: Parameters<typeof emitFoldIndex>[0] | undefined;
		engine.onFoldEvent = (candidate) => {
			event = candidate;
			return false;
		};
		engine.process(bigSession(), { contextWindow: 80_000, tokens: null });
		expect(event).toBeDefined();

		const unavailableIndex = new SeedIndexStore(join(dir, "unavailable-index"));
		unavailableIndex.append = () => {
			throw new Error("index unavailable");
		};
		expect(() =>
			emitFoldIndex(event!, { registry, index: unavailableIndex, sessionId: "s-test" }),
		).toThrow("index unavailable");
		expect(registry.size).toBe(0);

		expect(() =>
			emitFoldIndex(event!, {
				registry,
				index,
				sessionId: "s-test",
				persistEntry: () => {
					throw new Error("ledger unavailable");
				},
			}),
		).toThrow("ledger unavailable");
		expect(registry.size).toBe(0);

		const persisted: string[] = [];
		emitFoldIndex(event!, {
			registry,
			index,
			sessionId: "s-test",
			persistEntry: (entry) => persisted.push(entry.blockId),
		});
		expect(registry.size).toBeGreaterThan(0);
		expect(persisted.length).toBe(registry.size);
	});
});
