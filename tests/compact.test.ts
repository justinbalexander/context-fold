/*
 * compact.test.ts — the deterministic hard-compaction summary (A never automatic): rendering,
 * the final "compact" index record, and the guarantee that ladder-masked content stays
 * recallable AFTER compaction removes the raw messages from live history.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderConductor } from "../src/core/policy/fold-ladder";
import { MapGateRegistry } from "../src/core/gate-registry";
import { SpoolStore } from "../src/adapters/pi/spool";
import { SeedIndexStore, emitFoldIndex, emitCompactIndex } from "../src/adapters/pi/index-store";
import { renderDetCompactionSummary } from "../src/adapters/pi/compact";
import { linearize, type WireBlock } from "../src/core/block";
import type { AgentMessage } from "../src/core/block";
import { user, assistantWithCalls, bigResult, toolResult } from "./helpers";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
	dir = mkdtempSync(join(tmpdir(), "contextfold-compact-"));
	const registry = new MapGateRegistry();
	const spool = new SpoolStore(dir);
	const index = new SeedIndexStore(dir);
	const e = new ContextFoldEngine(new FoldLadderConductor(), { tailTarget: 100, prefixStable: true }, null, null, registry);
	e.onFoldEvent = (ev) => emitFoldIndex(ev, { spool, registry, index, sessionId: "s-compact", now: 1_722_200_000_000 });
	return { e, registry, spool, index };
}

function needled(): { messages: AgentMessage[]; needle: string } {
	const needle = "CAP_X9_LIMIT=52418";
	const messages: AgentMessage[] = [user("dig through the dumps")];
	for (let i = 0; i < 7; i++) {
		messages.push(assistantWithCalls([{ id: `c${i}`, name: "read" }]));
		messages.push(bigResult(`c${i}`, 400));
	}
	const lines = Array.from({ length: 300 }, (_, j) => `r${j}: ${"q".repeat(40)}`);
	lines[144] = `   ${needle} (planted)`;
	messages.push(assistantWithCalls([{ id: "cx", name: "read" }]));
	messages.push(toolResult("cx", lines.join("\n"), "read"));
	messages.push(user("newest question"));
	return { messages, needle };
}

describe("recall survives hard compaction", () => {
	it("a ladder-masked block resolves from the spool once its raw message left history", () => {
		const { e, index } = setup();
		const { messages, needle } = needled();
		e.process(messages, { contextWindow: 80_000, tokens: null }); // fold event → spool + registry

		const rec = index.readAll()[0];
		const span = rec.spans.find((s) => s.blockId === "r:cx");
		expect(span).toBeDefined();

		// Simulate post-compaction history: the old messages are GONE from the array Pi sends.
		const postCompact: AgentMessage[] = [user("fresh start after compaction")];
		e.process(postCompact, { contextWindow: 80_000, tokens: null }); // snapshot no longer has r:cx

		const { matches, missing, errors } = e.resolveRecall([span!.code!], { grep: "CAP_X9_LIMIT" });
		expect(missing).toEqual([]);
		expect(errors).toEqual([]);
		expect(matches[0].text).toContain(needle);
	});
});

describe("compact index record + deterministic summary", () => {
	it("emitCompactIndex indexes the whole leaving span and the renderer carries it verbatim", () => {
		const { e, registry, index } = setup();
		const { messages, needle } = needled();
		e.process(messages, { contextWindow: 80_000, tokens: null });

		// Hard compaction fires: everything except the newest exchange is summarized away.
		const leaving = messages.slice(0, -1);
		const blocks = linearize(leaving) as unknown as WireBlock[];
		const rec = emitCompactIndex(blocks, {
			registry,
			index,
			sessionId: "s-compact",
			tokensBefore: 40_000,
			contextWindow: 80_000,
			now: 1_722_200_100_000,
		});
		expect(rec.trigger).toBe("compact");
		expect(rec.identifiers).toContain("CAP_X9_LIMIT");
		expect(rec.spans.length).toBeGreaterThan(0); // spooled blocks carry recovery pointers

		const summary = renderDetCompactionSummary({
			records: index.readAll(),
			spoolDir: dir,
			previousSummary: "Earlier narrative summary.",
		});
		expect(summary).toContain("deterministic seed index — no model involved");
		expect(summary).toContain("CAP_X9_LIMIT");
		expect(summary).toContain("recall search=");
		expect(summary).toContain("dig through the dumps");
		expect(summary).toContain("UNTRUSTED");
		expect(summary).toContain("Earlier narrative summary.");
		// Recovery pointers name real codes.
		expect(summary).toMatch(/\{#[a-z0-9]{1,8} FOLDED\}/);
	});

	it("renders a usable (if sparse) summary even with no records", () => {
		dir = mkdtempSync(join(tmpdir(), "contextfold-compact-"));
		const summary = renderDetCompactionSummary({ records: [], spoolDir: dir });
		expect(summary).toContain("deterministic seed index");
		expect(summary).toContain(dir);
	});
});
