/*
 * hook-latency.test.ts — what does a context-fold turn actually COST the user?
 *
 * Two cost paths, very different:
 *   • SYNCHRONOUS (every turn): linearize → conduct → lower → applyPlan. Pure CPU, no model. This
 *     is the only thing added to a turn's latency. Measured here on a large context.
 *   • ASYNCHRONOUS (epoch boundaries): the digest writer + relevance judge. Fired and NOT awaited —
 *     `process()` returns immediately while the model works in the background (`engine.busy`).
 *
 * Run: CONTEXTFOLD_BENCH=1 npx vitest run tests/hook-latency.test.ts
 */
import { describe, it, expect } from "vitest";
import { buildSession, tokensOf } from "../src/experiments/recall-eval";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { KeelConductor } from "../src/core/policy/keel";
import { ModelConductor } from "../src/core/policy/model";
import type { DigestWriter } from "../src/core/model/digest-writer";
import type { RelevanceJudge } from "../src/core/model/relevance-judge";
import type { AgentMessage } from "../src/core/block";
import { user, assistantWithCalls, bigResult } from "./helpers";

/** Small (<600 tok) results so cold blocks fold at L3 (digest) — the model-call candidate level. */
function foldSession(n: number): AgentMessage[] {
	const out: AgentMessage[] = [user("start")];
	for (let i = 0; i < n; i++) {
		out.push(user(`step ${i}`));
		out.push(assistantWithCalls([{ id: `c${i}`, name: "read" }], { text: `reading ${i}` }));
		out.push(bigResult(`c${i}`, 34));
	}
	return out;
}

const BENCH = process.env.CONTEXTFOLD_BENCH === "1";

/** A writer/judge that take a realistic ~4s but resolve in the background — to prove they don't block. */
const slowWriter: DigestWriter = {
	async write(blocks) {
		await new Promise((r) => setTimeout(r, 4000));
		return new Map(blocks.map((b) => [b.id, `model digest ${b.id}`]));
	},
};
const slowJudge: RelevanceJudge = {
	async judge() {
		await new Promise((r) => setTimeout(r, 2000));
		return new Set();
	},
};

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

describe.skipIf(!BENCH)("hook latency", () => {
	it("synchronous fold cost per turn on a large context", () => {
		const { messages } = buildSession(120); // big, deeply over budget
		const cw = 200_000;
		const tokens = tokensOf(messages);
		const engine = new ContextFoldEngine(new KeelConductor(), { budgetFraction: 0.4, defaultContextWindow: cw });

		// Warm caches, then time the synchronous per-turn work.
		engine.process(messages, cw);
		const times: number[] = [];
		for (let i = 0; i < 7; i++) {
			const t = performance.now();
			engine.process(messages, cw);
			times.push(performance.now() - t);
		}
		// eslint-disable-next-line no-console
		console.log(`\n  context: ${tokens} tokens, ${messages.length} messages`);
		// eslint-disable-next-line no-console
		console.log(`  synchronous fold per turn: median ${median(times).toFixed(1)}ms  (min ${Math.min(...times).toFixed(1)}, max ${Math.max(...times).toFixed(1)})\n`);
		expect(median(times)).toBeLessThan(500); // a fold turn adds well under half a second of CPU
	});

	it("the model calls do NOT block process() — it returns while the model works in the background", async () => {
		const messages = foldSession(20); // small results → L3 folds → real model-call candidates
		const cw = 8_000;
		const engine = new ContextFoldEngine(new ModelConductor(), { budgetFraction: 0.5, tailTarget: 800, defaultContextWindow: cw }, slowWriter, slowJudge);

		const t = performance.now();
		engine.process(messages, cw); // fires the 4s writer + 2s judge, must return immediately
		const sync = performance.now() - t;

		// eslint-disable-next-line no-console
		console.log(`\n  process() returned in ${sync.toFixed(1)}ms while a 4s writer + 2s judge run in the background`);
		// eslint-disable-next-line no-console
		console.log(`  engine.busy = ${engine.busy} (model work still in flight)\n`);
		expect(sync).toBeLessThan(500); // returned in ms, NOT 4000ms
		expect(engine.busy).toBe(true); // the model work is happening in the background
	});
});
