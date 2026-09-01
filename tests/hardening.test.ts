/*
 * hardening.test.ts — adapter-level regressions: error-lexicon coverage, fold-code collision
 * safety, and the lines= re-flood cap.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MapFoldRegistry } from "../src/core/fold-registry";
import { LedgerReader, sha256Hex } from "../src/adapters/pi/ledger";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { SeedIndexStore, emitFoldIndex, recordCompactedBlocks } from "../src/adapters/pi/index-store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { foldCode } from "../src/core/digest";
import { categorize } from "../src/core/policy/ledger";
import { linearize, type AgentMessage } from "../src/core/block";
import { user, assistantText, assistantWithCalls, toolResult } from "./helpers";
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cf-hardening-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A LedgerReader over a plain message array shaped like Pi's session entries. */
function readerOver(messages: AgentMessage[]): LedgerReader {
	return new LedgerReader(() => messages.map((m) => ({ type: "message", message: m })));
}

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

});

/** Two REAL colliding durable ids (birthday search over the 36^6 code space, <100ms). */
function collidingIds(): [string, string] {
	const seen = new Map<string, string>();
	for (let i = 0; ; i++) {
		const id = `r:call_${i.toString(36)}`;
		const c = foldCode(id);
		const prev = seen.get(c);
		if (prev !== undefined) return [prev, id];
		seen.set(c, id);
	}
}

describe("fold-code collision guard", () => {
	it("record-at-compaction refuses to give a second block another block's code", () => {
		const [a, b] = collidingIds();
		const registry = new MapFoldRegistry();
		const messages: AgentMessage[] = [
			user("both"),
			assistantWithCalls([{ id: a.slice(2), name: "read" }, { id: b.slice(2), name: "read" }]),
			toolResult(a.slice(2), "first payload"),
			toolResult(b.slice(2), "second payload"),
		];
		const { added, skippedIds } = recordCompactedBlocks(linearize(messages), { registry });
		expect(added.map((e) => e.blockId)).toEqual([a]); // collider skipped, original intact
		expect(skippedIds).toEqual([b]); // and reported, so the caller can announce it
		expect(registry.get(a)!.sha256).toBe(sha256Hex("first payload"));
		expect(registry.get(b)).toBeUndefined();
	});

	it("a collision drops only the colliding block — folding continues for everything else", () => {
		const [a, b] = collidingIds();

		const registry = new MapFoldRegistry();
		const index = new SeedIndexStore(join(dir, "index"));
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { defaultContextWindow: 20_000, tailTarget: 100 }, registry);
		// Wired exactly as adapters/pi/index.ts wires it: droppedIds flow back to the engine.
		engine.onFoldEvent = (ev) => {
			const { droppedIds } = emitFoldIndex(ev, { registry, index, sessionId: "t", persistEntry: () => {} });
			return droppedIds.length ? droppedIds : true;
		};
		engine.onLayerCommit = () => true;

		const big = (marker: string) =>
			Array.from({ length: 600 }, (_, i) => `row ${i}: bulk content for pressure ${"x".repeat(30)}`).join("\n") + `\n${marker}`;

		// Turn 1: block A folds and records normally under the shared code.
		const turn1: AgentMessage[] = [
			user("first"),
			assistantWithCalls([{ id: a.slice(2), name: "read" }]),
			toolResult(a.slice(2), big("A-marker")),
			assistantText("done A"),
			user("next"),
		];
		expect(JSON.stringify(engine.process(turn1, 20_000))).toContain("FOLDED");

		// Turn 2: colliding block B arrives alongside an innocent block C. B is dropped (raw),
		// C folds — the event survives.
		const turn2: AgentMessage[] = [
			...turn1,
			assistantWithCalls([{ id: b.slice(2), name: "read" }, { id: "c_innocent", name: "read" }]),
			toolResult(b.slice(2), big("B-marker")),
			toolResult("c_innocent", big("C-marker")),
			assistantText("done B C"),
			user("go on"),
		];
		const out2 = JSON.stringify(engine.process(turn2, 20_000));
		expect(out2).toContain("B-marker"); // collider stays raw
		expect(out2).not.toContain("C-marker"); // innocent block folded

		// Turn 3: folding still works for new blocks; the collider stays held, not retried forever.
		const turn3: AgentMessage[] = [
			...turn2,
			assistantWithCalls([{ id: "d_later", name: "read" }]),
			toolResult("d_later", big("D-marker")),
			assistantText("done D"),
			user("more"),
		];
		const out3 = JSON.stringify(engine.process(turn3, 20_000));
		expect(out3).not.toContain("D-marker"); // later folds proceed
		expect(out3).toContain("B-marker"); // collider still raw, still delivered
	});
});

describe("recall lines= is capped (no re-flood path)", () => {
	it("an unbounded range comes back token-capped with a paging note", () => {
		const flood = Array.from({ length: 800 }, (_, i) => `row ${i}: bulky line for the lines-cap scenario ${"y".repeat(40)}`).join("\n");
		const reg = new MapFoldRegistry();
		const code = foldCode("r:cL");
		reg.set({ blockId: "r:cL", code, tool: "read", isError: false, bytes: Buffer.byteLength(flood, "utf8"), sha256: sha256Hex(flood) });
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { defaultContextWindow: 400_000 }, reg);
		engine.attachLedger(
			readerOver([user("go"), assistantWithCalls([{ id: "cL", name: "read" }]), toolResult("cL", flood)]),
		);

		const { matches } = engine.resolveRecall([code], { lines: "1-999999" });
		expect(matches).toHaveLength(1);
		expect(matches[0].text.length).toBeLessThan(flood.length / 3); // capped, not the whole flood
		expect(matches[0].note).toContain("narrow");

		const malformed = engine.resolveRecall([code], { lines: "banana" });
		expect(malformed.matches[0].text).toBe(""); // malformed spec no longer dumps everything
		expect(malformed.matches[0].note).toContain("malformed");
	});
});
