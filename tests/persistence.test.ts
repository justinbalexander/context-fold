/*
 * persistence.test.ts — event-sourced fold state across restarts.
 *
 * A fresh engine rebuilds the fold registry, frozen layers, and unfolds from custom session
 * entries. Legacy `kind:"spool"`/`kind:"gate"` records degrade to fold entries without a
 * fold-time sha256 (recall serves them unverified), and unknown kinds are ignored.
 */
import { describe, expect, it } from "vitest";
import {
	FOLD_CUSTOM_TYPE,
	recordFoldEntry,
	recordLayer,
	recordUnfold,
	restoreFoldState,
	type EntryAppender,
} from "../src/adapters/pi/persistence";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { LedgerReader, sha256Hex } from "../src/adapters/pi/ledger";
import { linearize, type AgentMessage } from "../src/core/block";
import { digest, foldCode } from "../src/core/digest";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { MapFoldRegistry, type FoldEntry } from "../src/core/fold-registry";
import { assistantWithCalls, toolResult, user } from "./helpers";

class FakeLedger implements EntryAppender {
	entries: { type: string; customType: string; data: unknown }[] = [];
	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ type: "custom", customType, data });
	}
}

function flood(tag: string): string {
	return Array.from({ length: 300 }, (_, i) => `row ${i}: ${tag} bulky tabular content spanning the terminal width for size`).join("\n");
}

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

function foldEntry(callId: string, content: string): FoldEntry {
	const blockId = `r:${callId}`;
	return {
		blockId,
		code: foldCode(blockId),
		tool: "read",
		isError: false,
		bytes: Buffer.byteLength(content, "utf8"),
		sha256: sha256Hex(content),
	};
}

/** A LedgerReader over a plain message array shaped like Pi's session entries. */
function readerOver(messages: AgentMessage[]): LedgerReader {
	return new LedgerReader(() => messages.map((m) => ({ type: "message", message: m })));
}

describe("fold record round-trip", () => {
	it("restores fold records, unfolds, and legacy spool/gate records", () => {
		const ledger = new FakeLedger();
		const first = foldEntry("c1", "alpha content");
		recordFoldEntry(ledger, first);
		// Legacy records carry spool baggage and no sha; restore keeps only ledger-relevant fields.
		ledger.appendEntry(FOLD_CUSTOM_TYPE, {
			kind: "gate",
			entry: { blockId: "r:c2", code: "bbb", tool: "read", isError: false, bytes: 2, spoolPath: "/x/bbb.json", dedupOf: "aaa" },
		});
		ledger.appendEntry(FOLD_CUSTOM_TYPE, {
			kind: "spool",
			entry: { blockId: "r:c3", code: "ccc", tool: "bash", isError: true, bytes: 3, spoolPath: "/x/ccc.json" },
		});
		recordUnfold(ledger, ["r:c1"]);

		const { foldEntries, unfoldedIds } = restoreFoldState(ledger.entries);
		expect(foldEntries.map((entry) => entry.blockId).sort()).toEqual(["r:c1", "r:c2", "r:c3"]);
		expect([...unfoldedIds]).toEqual(["r:c1"]);

		const byId = new Map(foldEntries.map((entry) => [entry.blockId, entry] as const));
		expect(byId.get("r:c1")!.sha256).toBe(first.sha256);
		expect(byId.get("r:c2")!.sha256).toBeUndefined();
		expect(byId.get("r:c2")).not.toHaveProperty("spoolPath");
		expect(byId.get("r:c2")).not.toHaveProperty("dedupOf");
		expect(byId.get("r:c3")!.isError).toBe(true);
	});

	it("keeps the latest record per block", () => {
		const ledger = new FakeLedger();
		const stale = { ...foldEntry("c1", "old"), tool: "old-tool" };
		recordFoldEntry(ledger, stale);
		const fresh = foldEntry("c1", "new content");
		recordFoldEntry(ledger, fresh);
		const { foldEntries } = restoreFoldState(ledger.entries);
		expect(foldEntries).toHaveLength(1);
		expect(foldEntries[0].sha256).toBe(fresh.sha256);
		expect(foldEntries[0].tool).toBe("read");
	});

	it("ignores unrelated custom entries and unknown kinds", () => {
		const entries = [
			{ type: "custom", customType: "someone.else", data: { kind: "fold" } },
			{ type: "custom", customType: FOLD_CUSTOM_TYPE, data: { kind: "mystery", entry: { blockId: "r:cz" } } },
		];
		expect(restoreFoldState(entries).foldEntries).toEqual([]);
	});
});

describe("resume restores folds and recall", () => {
	it("rebuilds frozen layers while every persisted handle still resolves from the ledger", () => {
		const a = flood("ALPHA");
		const b = flood("BETA");
		const messages = twoReadSession(a, b);
		const blocks = linearize(messages);
		const ledger = new FakeLedger();
		for (const [callId, content] of [["c1", a], ["c2", b]] as const) recordFoldEntry(ledger, foldEntry(callId, content));
		recordLayer(ledger, {
			seq: 1,
			entries: blocks
				.filter((block) => block.id === "r:c1" || block.id === "r:c2")
				.map((block) => ({ id: block.id, digestText: digest(block) })),
		});
		recordUnfold(ledger, ["r:c1"]);

		const restored = restoreFoldState(ledger.entries);
		const registry = new MapFoldRegistry();
		for (const entry of restored.foldEntries) registry.set(entry);
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { defaultContextWindow: 400_000 }, registry);
		engine.attachLedger(readerOver(messages));
		engine.restoreLayers(restored.layers);
		engine.restoreUnfolded(restored.unfoldedIds);

		const results = engine.process(messages, 400_000).filter((message) => message.role === "toolResult");
		const first = (results[0].content as { text: string }[])[0].text;
		const second = (results[1].content as { text: string }[])[0].text;
		expect(first).toContain("row 200:");
		expect(first).not.toContain("FOLDED");
		expect(second).toContain(`{#${foldCode("r:c2")} FOLDED}`);
		expect(b.startsWith(engine.resolveRecall([foldCode("r:c2")]).matches[0].text)).toBe(true);
	});

	it("degrades a legacy record to an unverified ledger read, and errors when the block is gone", () => {
		const content = flood("GAMMA");
		const messages = twoReadSession(content, flood("DELTA"));
		const ledger = new FakeLedger();
		ledger.appendEntry(FOLD_CUSTOM_TYPE, {
			kind: "spool",
			entry: { blockId: "r:c1", code: foldCode("r:c1"), tool: "read", isError: false, bytes: 42, spoolPath: "/gone/x.json" },
		});
		const restored = restoreFoldState(ledger.entries);
		const registry = new MapFoldRegistry();
		for (const entry of restored.foldEntries) registry.set(entry);
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { defaultContextWindow: 400_000 }, registry);

		// Block present in the ledger: served, but flagged unverified (no fold-time sha).
		engine.attachLedger(readerOver(messages));
		const served = engine.resolveRecall([foldCode("r:c1")]);
		expect(served.errors).toEqual([]);
		expect(content.startsWith(served.matches[0].text)).toBe(true);
		expect(served.matches[0].note).toContain("unverified");

		// Block absent from the ledger: a typed error naming the code, not a crash.
		engine.attachLedger(readerOver([user("unrelated session")]));
		const gone = engine.resolveRecall([foldCode("r:c1")]);
		expect(gone.matches).toEqual([]);
		expect(gone.errors[0].message).toContain("not found in the session ledger");
	});
});
