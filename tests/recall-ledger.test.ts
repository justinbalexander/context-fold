/*
 * recall-ledger.test.ts — exact, bounded recovery from the session ledger.
 *
 * Covers byte integrity against the fold-time sha256, grep/line slices, missing-block and
 * sha-mismatch errors, and recovery after hard compaction removes a folded block from the live
 * snapshot (the ledger keeps it — Pi's session is append-only).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { LedgerReader, sha256Hex } from "../src/adapters/pi/ledger";
import { foldCode } from "../src/core/digest";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { MapFoldRegistry } from "../src/core/fold-registry";
import type { AgentMessage } from "../src/core/block";
import { assistantText, assistantWithCalls, toolResult, user } from "./helpers";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function floodWith(buried: string): string {
	const lines: string[] = [];
	for (let i = 0; i < 300; i++) lines.push(`row ${i}: ordinary tabular content spanning the width of the terminal for bulk`);
	lines.push(buried);
	for (let i = 300; i < 600; i++) lines.push(`row ${i}: further ordinary tabular content to keep the payload large`);
	return lines.join("\n");
}

function engineWith(registry: MapFoldRegistry): ContextFoldEngine {
	return new ContextFoldEngine(new FoldLadderPolicy(), { defaultContextWindow: 400_000, tailTarget: 100 }, registry);
}

/** A LedgerReader over a plain message array shaped like Pi's session entries. */
function readerOver(messages: AgentMessage[]): LedgerReader {
	return new LedgerReader(() => messages.map((m) => ({ type: "message", message: m })));
}

/** A session whose ledger holds `content` as the result of call `callId` (plus surrounding turns). */
function sessionWith(callId: string, content: string): AgentMessage[] {
	return [
		user("read it"),
		assistantWithCalls([{ id: callId, name: "read" }]),
		toolResult(callId, content),
		assistantText("finished reading", `after-${callId}`),
		user("tail"),
	];
}

function foldOne(
	content: string,
	callId = "c1",
	opts: { fullOutputPath?: string; sha256?: string | null } = {},
): { registry: MapFoldRegistry; code: string; ledger: LedgerReader } {
	const registry = new MapFoldRegistry();
	const blockId = `r:${callId}`;
	const code = foldCode(blockId);
	registry.set({
		blockId,
		code,
		tool: "read",
		isError: false,
		bytes: Buffer.byteLength(content, "utf8"),
		...(opts.sha256 === null ? {} : { sha256: opts.sha256 ?? sha256Hex(content) }),
		fullOutputPath: opts.fullOutputPath,
	});
	return { registry, code, ledger: readerOver(sessionWith(callId, content)) };
}

describe("ledger recall — byte integrity within the re-flood cap", () => {
	it("returns a byte-exact prefix and keeps buried detail reachable through grep", () => {
		const content = floodWith("BURIED: the load-bearing value is 7788");
		const { registry, code, ledger } = foldOne(content);
		const engine = engineWith(registry);
		engine.attachLedger(ledger);

		const { matches, missing, errors } = engine.resolveRecall([code]);
		expect(missing).toEqual([]);
		expect(errors).toEqual([]);
		expect(matches[0].label).toContain("ledger");
		expect(content.startsWith(matches[0].text)).toBe(true);
		expect(matches[0].text.length).toBeLessThan(content.length / 2);
		expect(matches[0].note).toContain("lines=");
		expect(matches[0].note).not.toContain("unverified"); // sha matched
		expect(engine.resolveRecall([code], { grep: "load-bearing value" }).matches[0].text).toContain("7788");
	});

	it("returns an under-cap result byte-identically", () => {
		const content = ["short result with a", "BURIED: small value 42", "few lines"].join("\n");
		const { registry, code, ledger } = foldOne(content, "small");
		const engine = engineWith(registry);
		engine.attachLedger(ledger);
		const text = engine.resolveRecall([code]).matches[0].text;
		expect(text).toBe(content);
		expect(sha(text)).toBe(sha(content));
	});

	it("recalls several independent fold entries", () => {
		const registry = new MapFoldRegistry();
		const messages: AgentMessage[] = [user("read them")];
		const contents: Record<string, string> = {};
		for (let i = 0; i < 3; i++) {
			const blockId = `r:call${i}`;
			const code = foldCode(blockId);
			const content = floodWith(`BURIED marker unique ${i} value ${i * 111}`);
			messages.push(assistantWithCalls([{ id: `call${i}`, name: "read" }]), toolResult(`call${i}`, content));
			registry.set({ blockId, code, tool: "read", isError: false, bytes: Buffer.byteLength(content, "utf8"), sha256: sha256Hex(content) });
			contents[code] = content;
		}
		const engine = engineWith(registry);
		engine.attachLedger(readerOver(messages));
		const { matches } = engine.resolveRecall(Object.keys(contents));
		expect(matches).toHaveLength(3);
		for (const match of matches) expect(contents[match.code].startsWith(match.text)).toBe(true);
	});
});

describe("ledger recall — partial retrieval", () => {
	it("grep returns only matching lines with 1-based numbers", () => {
		const content = floodWith("BURIED: the load-bearing value is 7788");
		const { registry, code, ledger } = foldOne(content);
		const engine = engineWith(registry);
		engine.attachLedger(ledger);
		const match = engine.resolveRecall([code], { grep: "load-bearing value" }).matches[0];
		expect(match.text).toMatch(/^301: BURIED/);
		expect(match.text).not.toContain("row 0:");
	});

	it("line-range returns exactly that numbered slice", () => {
		const content = floodWith("BURIED here");
		const { registry, code, ledger } = foldOne(content);
		const engine = engineWith(registry);
		engine.attachLedger(ledger);
		const out = engine.resolveRecall([code], { lines: "2-4" }).matches[0].text.split("\n");
		expect(out).toHaveLength(3);
		expect(out[0]).toBe("2: row 1: ordinary tabular content spanning the width of the terminal for bulk");
		expect(out[2]).toMatch(/^4: row 3:/);
	});

	it("reports an empty grep without dumping the payload", () => {
		const { registry, code, ledger } = foldOne(floodWith("BURIED here"));
		const engine = engineWith(registry);
		engine.attachLedger(ledger);
		const match = engine.resolveRecall([code], { grep: "no such string anywhere zzz" }).matches[0];
		expect(match.text).toBe("");
		expect(match.note).toMatch(/no lines match/);
	});
});

describe("ledger recall — failure and compaction surfaces", () => {
	it("a never-folded block's code does not resolve — recall serves folded content only", () => {
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { defaultContextWindow: 1_000_000, tailTarget: 100 }, new MapFoldRegistry());
		const messages = sessionWith("c9", floodWith("NEVER-FOLDED"));
		engine.attachLedger(readerOver(messages));
		engine.process(messages, 1_000_000); // far under threshold: nothing folds
		const code = foldCode("r:c9");
		expect(engine.resolveRecall([code]).missing).toEqual([code]);
		const un = engine.markUnfold([code]);
		expect(un.matches).toEqual([]);
		expect(un.missing).toEqual([code]);
	});

	it("errors with a typed message naming the code when the block is absent from the ledger", () => {
		const { registry, code } = foldOne(floodWith("BURIED here"));
		const engine = engineWith(registry);
		engine.attachLedger(readerOver([user("a different history")]));
		const { matches, errors } = engine.resolveRecall([code]);
		expect(matches).toEqual([]);
		expect(errors[0].code).toBe(code);
		expect(errors[0].message).toContain(`#${code}`);
		expect(errors[0].message).toContain("not found in the session ledger");
	});

	it("errors on a sha mismatch when the block left live history", () => {
		const content = floodWith("BURIED here");
		const { registry, code, ledger } = foldOne(content, "c1", { sha256: sha256Hex("different bytes entirely") });
		const engine = engineWith(registry);
		engine.attachLedger(ledger);
		const { matches, errors } = engine.resolveRecall([code]);
		expect(matches).toEqual([]);
		expect(errors[0].message).toContain("failed the fold-time sha256 check");
	});

	it("falls back to the live snapshot, bounded, when the ledger cannot serve a live block", () => {
		const content = floodWith("BURIED: still live 6363");
		const { registry, code } = foldOne(content);
		const engine = engineWith(registry);
		// No ledger attached and the registry entry cannot verify — but the block is still live.
		const messages = sessionWith("c1", content);
		engine.process(messages, 20_000); // block is in the snapshot and folds

		const whole = engine.resolveRecall([code]);
		expect(whole.errors).toEqual([]); // DESIGN §7: a live block still resolves
		expect(whole.matches).toHaveLength(1);
		expect(whole.matches[0].note).toContain("live history");
		expect(whole.matches[0].text.length).toBeLessThan(content.length / 2); // still capped

		const sliced = engine.resolveRecall([code], { grep: "still live" });
		expect(sliced.matches[0].text).toContain("6363"); // grep honored on the fallback too
	});

	it("live-history recall honors grep and the whole-recall cap (restored layer without a fold entry)", () => {
		// Resume-degraded shape: frozen layer restored, no registry entry for the block.
		const registry = new MapFoldRegistry();
		const engine = engineWith(registry);
		const blockId = "r:c1";
		const code = foldCode(blockId);
		engine.restoreLayers([{ seq: 1, entries: [{ id: blockId, digestText: `{#${code} FOLDED} read → folded` }] }]);
		const content = floodWith("BURIED: entry-less needle 9494");
		engine.process(sessionWith("c1", content), 20_000);

		const whole = engine.resolveRecall([code]);
		expect(content.startsWith(whole.matches[0].text)).toBe(true); // verbatim prefix…
		expect(whole.matches[0].text.length).toBeLessThan(content.length / 2); // …not a re-flood
		expect(whole.matches[0].note).toContain("lines=");

		const sliced = engine.resolveRecall([code], { grep: "entry-less needle" });
		expect(sliced.matches[0].text).toContain("9494");
		expect(sliced.matches[0].text).not.toContain("row 0:"); // grep no longer ignored
	});

	it("recalls and searches a folded block after hard compaction removes it from the snapshot", () => {
		const content = floodWith("BURIED: the compacted needle is 4242");
		const { registry, code, ledger } = foldOne(content);
		const engine = engineWith(registry);
		engine.attachLedger(ledger);
		// Never processed: the block is absent from the live snapshot, exactly as after compaction.
		expect(content.startsWith(engine.resolveRecall([code]).matches[0].text)).toBe(true);
		const result = engine.searchFolded("compacted needle");
		expect(result.scanned).toBe(1);
		expect(result.hits[0].code).toBe(code);
		expect(result.hits[0].lines[0]).toContain("4242");
		expect(result.hits[0].label).toContain("compacted");
	});

	it("does not double-scan a folded block still present in the snapshot", () => {
		const content = floodWith("BURIED: the live needle is 5151");
		const { registry, ledger } = foldOne(content);
		const engine = engineWith(registry);
		engine.attachLedger(ledger);
		engine.process(sessionWith("c1", content), 20_000);
		const result = engine.searchFolded("live needle");
		expect(result.scanned).toBe(1);
		expect(result.hits).toHaveLength(1);
	});
});
