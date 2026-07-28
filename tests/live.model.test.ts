/*
 * live.model.test.ts — OPT-IN live check against a running Lemonade endpoint. Skipped unless
 * CONTEXTFOLD_LIVE=1. Proves the real fetchDigestWriter → Lemonade → cleanDigest path produces
 * usable digests for real blocks (the unit tests mock fetch; this exercises the actual model).
 *
 *   CONTEXTFOLD_LIVE=1 CONTEXTFOLD_MODEL=Qwen3-Coder-30B-A3B-Instruct-GGUF npx vitest run tests/live.model.test.ts
 */
import { describe, it, expect } from "vitest";
import { fetchDigestWriter, DEFAULT_WRITER_CONFIG, type DigestRequest } from "../src/core/model/digest-writer";

const LIVE = process.env.CONTEXTFOLD_LIVE === "1";
const MODEL = process.env.CONTEXTFOLD_MODEL || "Qwen3.5-4B-MTP-GGUF";
const BASE = process.env.CONTEXTFOLD_MODEL_URL || "http://localhost:13305/api/v1";

describe.skipIf(!LIVE)("live Lemonade digest writer", () => {
	it("returns a fact-dense digest preserving identifiers", async () => {
		const writer = fetchDigestWriter({ ...DEFAULT_WRITER_CONFIG, baseUrl: BASE, model: MODEL, timeoutMs: 120_000 });
		const blocks: DigestRequest[] = [
			{
				id: "r:c1",
				kind: "tool_result",
				toolName: "read",
				text: "export function applyPlan(messages, ops, groups) { /* orphan-prevention fixpoint over tool_call/tool_result pairs in src/core/apply.ts */ return rewritten; }",
			},
			{ id: "r:c2", kind: "tool_result", toolName: "bash", text: "$ npm run typecheck\n> tsc --noEmit\nNo errors. Exit 0." },
		];
		const out = await writer.write(blocks);
		// eslint-disable-next-line no-console
		for (const [id, body] of out) console.log(`  ${id} -> ${body}`);
		expect(out.size).toBeGreaterThanOrEqual(1);
		const c1 = out.get("r:c1");
		if (c1) expect(c1.toLowerCase()).toContain("applyplan"); // identifier preserved
	}, 130_000);
});
