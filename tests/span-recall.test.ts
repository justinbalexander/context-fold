/*
 * span-recall.test.ts — the churn guard (HANDOFF_REBUILD §6): recovering identifiers scattered
 * across N folded pointers must cost fewer calls than N. One `search` sweep covers every folded
 * block — L0 born-folded pointers and ladder-frozen masks alike — with line numbers that agree
 * with the per-code `lines=` slice path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { MapGateRegistry } from "../src/core/gate-registry";
import { Gate, GATE_DEFAULTS } from "../src/adapters/pi/gate";
import { SpoolStore } from "../src/adapters/pi/spool";
import type { AgentMessage } from "../src/core/block";
import { user, assistantWithCalls, toolResult } from "./helpers";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** N big results, each hiding one planted needle line mid-output. */
function needledSession(n: number): { messages: AgentMessage[]; needles: string[] } {
	const messages: AgentMessage[] = [user("collect the shard capacities")];
	const needles: string[] = [];
	for (let i = 0; i < n; i++) {
		const needle = `SHARD_CAP_${i}=${40_000 + i * 7}`;
		needles.push(needle);
		const lines = Array.from({ length: 400 }, (_, j) => `row ${j}: ${"z".repeat(40)}`);
		lines[200 + i] = `    ${needle} (planted)`;
		messages.push(assistantWithCalls([{ id: `c${i}`, name: "read" }]));
		messages.push(toolResult(`c${i}`, lines.join("\n"), "read"));
	}
	messages.push(user("now the newest question"));
	return { messages, needles };
}

describe("span recall (churn guard)", () => {
	it("one search call recovers needles from all N ladder-frozen pointers (1 call < N)", () => {
		dir = mkdtempSync(join(tmpdir(), "contextfold-span-"));
		const e = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, new MapGateRegistry());
		const { messages, needles } = needledSession(5);
		e.process(messages, { contextWindow: 40_000, tokens: null }); // ~25k live → ~0.63 ≥ 0.45 → fold event

		const sweep = e.searchFolded("SHARD_CAP_");
		expect(sweep.hits.length).toBe(5); // every pointer answered in ONE call
		const returned = sweep.hits.flatMap((h) => h.lines).join("\n");
		for (const needle of needles) expect(returned).toContain(needle);
	});

	it("search line numbers agree with the per-code lines= slice", () => {
		dir = mkdtempSync(join(tmpdir(), "contextfold-span-"));
		const e = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, new MapGateRegistry());
		const { messages } = needledSession(5);
		e.process(messages, { contextWindow: 40_000, tokens: null });
		const sweep = e.searchFolded("SHARD_CAP_0");
		expect(sweep.hits.length).toBe(1);
		const [lineNo] = sweep.hits[0].lines[0].split(":");
		const { matches } = e.resolveRecall([sweep.hits[0].code], { lines: `${lineNo}-${lineNo}` });
		expect(matches[0].text).toContain("SHARD_CAP_0");
	});

	it("covers L0 born-folded pointers too (gate + registry path)", () => {
		dir = mkdtempSync(join(tmpdir(), "contextfold-span-"));
		const registry = new MapGateRegistry();
		const spool = new SpoolStore(dir);
		const gate = new Gate({ enabled: true, ...GATE_DEFAULTS }, registry, () => spool);
		const { messages, needles } = needledSession(3);

		// Feed the gate as tool results land (the tool_result hook path).
		for (const m of messages) {
			const tr = m as { role?: string; toolCallId?: string; toolName?: string; isError?: boolean; content?: { type: string; text?: string }[] };
			if (tr.role !== "toolResult") continue;
			gate.observe({
				toolName: tr.toolName ?? "read",
				toolCallId: tr.toolCallId!,
				input: {},
				isError: !!tr.isError,
				content: tr.content ?? [],
			});
		}
		expect(registry.size).toBe(3);

		const e = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, registry);
		e.process(messages, { contextWindow: 10_000_000, tokens: null }); // huge window: only L0 pointers fold
		const sweep = e.searchFolded("SHARD_CAP_");
		expect(sweep.hits.length).toBe(3);
		const returned = sweep.hits.flatMap((h) => h.lines).join("\n");
		for (const needle of needles) expect(returned).toContain(needle);
	});

	it("caps the sweep and says how to narrow", () => {
		dir = mkdtempSync(join(tmpdir(), "contextfold-span-"));
		const e = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, new MapGateRegistry());
		// Every line matches → the sweep must clip, not flood.
		const messages: AgentMessage[] = [user("flood")];
		for (let i = 0; i < 6; i++) {
			messages.push(assistantWithCalls([{ id: `f${i}`, name: "read" }]));
		messages.push(toolResult(`f${i}`, Array.from({ length: 500 }, (_, j) => `match line ${j}`).join("\n"), "read"));
		}
		messages.push(user("tail"));
		e.process(messages, { contextWindow: 18_000, tokens: null });
		const sweep = e.searchFolded("match line");
		const totalLines = sweep.hits.reduce((n, h) => n + h.lines.length, 0);
		expect(totalLines).toBeLessThan(500 * 6);
		expect(sweep.note).toContain("narrow");
	});

	it("counts recall churn for the yellow flag", () => {
		dir = mkdtempSync(join(tmpdir(), "contextfold-span-"));
		const e = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, new MapGateRegistry());
		const { messages } = needledSession(5);
		e.process(messages, { contextWindow: 40_000, tokens: null });
		const sweep = e.searchFolded("SHARD_CAP_0");
		e.resolveRecall([sweep.hits[0].code]);
		e.resolveRecall([sweep.hits[0].code]);
		e.resolveRecall([sweep.hits[0].code]);
		expect(e.recallStats.calls).toBeGreaterThanOrEqual(4);
		expect(e.recallStats.maxPerCode).toBe(3);
	});
});
