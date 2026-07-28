/*
 * score.ts — ACT-R cold-score ranking (Anderson & Schooler power-law of forgetting).
 *
 * Each block has an activation level based on when it was created and recalled; it decays:
 *
 *   B = ln( Σ max(T - t_i, floor)^(-d) )
 *
 * `coldScore` is LOWER = COLDER = fold-first: prior[kind] + B + pairWarmthBonus. Kind-major by
 * design: the prior gaps (8) exceed the realistic activation spread, so with no recalls the
 * ordering is tool_result → thinking → text (tool_call/user effectively never fold).
 *
 * Ported from Accordion `conductors/cold-score/score.ts` (pinned commit 0c22434).
 */
import type { ViewBlock } from "../contract";

/** Kinds that may be folded to a digest — `tool_call` / `user` are never folded. */
export const FOLDABLE_KINDS: ReadonlySet<ViewBlock["kind"]> = new Set<ViewBlock["kind"]>([
	"text",
	"thinking",
	"tool_result",
]);

export interface ScoreCtx {
	/** The current turn number (highest turn in the session). */
	currentTurn: number;
	/** Map of block id → array of turns at which it was recalled. Order-independent. */
	recalls: ReadonlyMap<string, readonly number[]>;
	/** callIds found in the protected tail — a block sharing one gets a warmth bonus. */
	tailCallIds: ReadonlySet<string>;
}

export const SCORE_CONFIG = {
	priors: { tool_result: 0, thinking: 8, text: 16, tool_call: 24, user: 32 } as Record<string, number>,
	decay: { tool_result: 0.9, thinking: 0.7, text: 0.5 } as Record<string, number>,
	pairWarmthBonus: 4,
	recallFloorTurns: 1,
};

/** ACT-R base-level activation for a single block. */
export function activation(b: ViewBlock, ctx: ScoreCtx): number {
	const d = SCORE_CONFIG.decay[b.kind] ?? 0.6;
	const floor = SCORE_CONFIG.recallFloorTurns;
	const T = ctx.currentTurn;
	// Filter out recall events with t > currentTurn — out-of-order turns must not grant
	// freshness weight to a block that hasn't actually been recalled yet.
	const rawEvents: number[] = [b.turn, ...(ctx.recalls.get(b.id) ?? [])];
	const events = rawEvents.filter((t) => t <= T);
	if (!events.length) events.push(b.turn <= T ? b.turn : T);
	let sum = 0;
	for (const t of events) {
		const age = Math.max(T - t, floor);
		sum += Math.pow(age, -d);
	}
	if (sum <= 0) return -10; // very cold
	return Math.log(sum);
}

/** Cold score for a candidate block. LOWER = colder = fold first. */
export function coldScore(b: ViewBlock, ctx: ScoreCtx): number {
	const prior = SCORE_CONFIG.priors[b.kind] ?? 24;
	const act = activation(b, ctx);
	const warmth = b.callId && ctx.tailCallIds.has(b.callId) ? SCORE_CONFIG.pairWarmthBonus : 0;
	return prior + act + warmth;
}

/** Sort fold candidates ascending by coldScore (coldest first), ties broken by order (oldest first). */
export function sortCandidates(cands: ViewBlock[], ctx: ScoreCtx): ViewBlock[] {
	return [...cands].sort((a, b) => {
		const sa = coldScore(a, ctx);
		const sb = coldScore(b, ctx);
		if (sa !== sb) return sa - sb;
		return a.order - b.order;
	});
}
