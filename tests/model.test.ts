/*
 * model.test.ts — Phase 2: the model digest writer (validation, mock-fetch batch, graceful
 * fallback) and the engine applying a model digest to a fold while keeping it reversible.
 */
import { describe, it, expect } from "vitest";
import { cleanDigest, renderBlock, fetchDigestWriter, DEFAULT_WRITER_CONFIG, type FetchLike, type DigestRequest } from "../src/core/model/digest-writer";
import type { DigestWriter } from "../src/core/model/digest-writer";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { KeelConductor } from "../src/core/policy/keel";
import type { AgentMessage } from "../src/core/block";
import { foldCode } from "../src/core/digest";
import { user, assistantWithCalls, bigResult, isBalanced } from "./helpers";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("cleanDigest validation (→ fallback on bad output)", () => {
	const blk: DigestRequest = { id: "r:c1", kind: "tool_result", toolName: "read", text: "x" };
	it("accepts a good one-liner and strips wrapping quotes/whitespace", () => {
		expect(cleanDigest('  "src/foo.ts: parses config"  ', blk, 400)).toBe("src/foo.ts: parses config");
	});
	it("rejects empty, too-short, and over-long output", () => {
		expect(cleanDigest("", blk, 400)).toBeNull();
		expect(cleanDigest("ok", blk, 400)).toBeNull();
		expect(cleanDigest("x".repeat(401), blk, 400)).toBeNull();
	});
	it("rejects a degenerate header echo", () => {
		expect(cleanDigest("tool_result read", blk, 400)).toBeNull();
		expect(cleanDigest("tool_result read read", blk, 400)).toBeNull();
	});
});

describe("renderBlock", () => {
	it("truncates very long input head+tail", () => {
		const out = renderBlock({ id: "r:c1", kind: "tool_result", text: "a".repeat(5000) }, 1000);
		expect(out.length).toBeLessThan(1200);
		expect(out).toContain("chars elided");
	});
});

describe("fetchDigestWriter with a mock fetch", () => {
	const cfg = { ...DEFAULT_WRITER_CONFIG, baseUrl: "http://x/api/v1", model: "M" };

	it("returns a digest per block, drops failures, respects maxBlocks", async () => {
		const seen: string[] = [];
		const mock: FetchLike = async (_url, init) => {
			const body = JSON.parse(init.body);
			const userMsg = body.messages[1].content as string;
			seen.push(userMsg);
			// Fail any block mentioning "boom"; otherwise echo a digest.
			const fail = userMsg.includes("boom");
			return {
				ok: true,
				status: 200,
				json: async () => ({ choices: [{ message: { content: fail ? "" : `digest of ${userMsg.slice(0, 12)}` } }] }),
			};
		};
		const writer = fetchDigestWriter({ ...cfg, maxBlocks: 2 }, mock);
		const reqs: DigestRequest[] = [
			{ id: "r:a", kind: "tool_result", text: "alpha content" },
			{ id: "r:b", kind: "tool_result", text: "boom content" },
			{ id: "r:c", kind: "tool_result", text: "gamma content" }, // beyond maxBlocks=2 → never sent
		];
		const out = await writer.write(reqs);
		expect(seen.length).toBe(2); // maxBlocks respected
		expect(out.has("r:a")).toBe(true);
		expect(out.has("r:b")).toBe(false); // failed validation → dropped
		expect(out.has("r:c")).toBe(false); // beyond cap
	});

	it("returns an empty map (no throw) when the endpoint errors", async () => {
		const mock: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
		const writer = fetchDigestWriter(cfg, mock);
		const out = await writer.write([{ id: "r:a", kind: "tool_result", text: "x".repeat(50) }]);
		expect(out.size).toBe(0);
	});
});

// A deterministic in-process writer stub (no network) for the engine integration test.
function stubWriter(): DigestWriter {
	return {
		async write(blocks) {
			const m = new Map<string, string>();
			for (const b of blocks) m.set(b.id, `MODELDIGEST for ${b.id}`);
			return m;
		},
	};
}

const CW = 8_000;
const CONFIG = { budgetFraction: 0.75, tailTarget: 800, defaultContextWindow: CW };

// Medium results (~420 tok < the 600-tok trim threshold) so cold blocks fold at L3 (digest) —
// the level model digests target (L1 skeleton / L2 trim keep their reversible deterministic form).
function foldSession(n: number): AgentMessage[] {
	const out: AgentMessage[] = [user("start")];
	for (let i = 0; i < n; i++) {
		out.push(user(`step ${i}`));
		out.push(assistantWithCalls([{ id: `c${i}`, name: "read" }], { text: `reading ${i}` }));
		out.push(bigResult(`c${i}`, 34));
	}
	out.push(user("summarize"));
	return out;
}

describe("engine applies model digests to folds (reversible)", () => {
	it("uses the cached model digest on the next turn, keeping the {#code FOLDED} tag", async () => {
		const engine = new ContextFoldEngine(new KeelConductor(), CONFIG, stubWriter());
		const messages = foldSession(20);

		// Turn 1: fires the writer (async); this turn still uses deterministic digests.
		const out1 = engine.process(messages, CW);
		expect(JSON.stringify(out1)).not.toContain("MODELDIGEST");
		await tick(); // let the writer resolve and populate the cache

		// Turn 2: same cold zone → folds now carry the model digest, still tagged + balanced.
		const out2 = engine.process(messages, CW);
		const foldedTR = out2.find((m) => m.role === "toolResult" && (m.content as any)[0].text.includes("MODELDIGEST"));
		expect(foldedTR).toBeDefined();
		const text = (foldedTR!.content as any)[0].text as string;
		expect(text).toMatch(/^\{#[0-9a-z]{6} FOLDED\} MODELDIGEST for r:c\d+/); // tag preserved → reversible
		expect(isBalanced(out2)).toBe(true);

		// The recover handle still resolves to the ORIGINAL content (recall is read-only of the snapshot).
		const code = /\{#([0-9a-z]{6}) FOLDED\}/.exec(text)![1];
		const { matches } = engine.resolveRecall([code]);
		expect(matches[0].text).toContain("line 0:"); // original tool output, not the model digest
		void foldCode;
	});

	it("with no writer, output is identical to the deterministic Phase-1 path", () => {
		const messages = foldSession(20); // build once → same ids for both engines
		const a = new ContextFoldEngine(new KeelConductor(), CONFIG).process(messages, CW);
		const b = new ContextFoldEngine(new KeelConductor(), CONFIG, null).process(messages, CW);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(JSON.stringify(a)).not.toContain("MODELDIGEST");
	});
});
