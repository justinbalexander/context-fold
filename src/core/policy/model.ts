/*
 * model.ts — ModelConductor (Phase 2 rep 2): the model decides COLDNESS.
 *
 * Extends the deterministic Keel with one override: a local model marks some cold candidates as
 * "keep warm" (still relevant to what the agent is working on right now), and those fold LAST —
 * only if the deterministic hard-cap floor still demands it. The model is genuinely in the
 * deciding loop (it chooses what stays in full fidelity), yet it CANNOT break correctness: the
 * orphan-safe mechanism, the budget floor, and the protected tail are all unchanged. If the model
 * keeps too much, the floor still guarantees the budget (folding keep-warm blocks as a last
 * resort) and the honest invariant surfaces any true overage.
 *
 * The keep-warm set is supplied by the adapter (which runs the async relevance judge at epoch
 * boundaries and caches the result) via `setKeepWarm` before each `conduct` pass. With an empty
 * set — no model link, or the judge hasn't answered yet — behavior is byte-identical to Keel.
 */
import { KeelConductor } from "./keel";
import type { ViewBlock } from "../contract";
import type { ScoreCtx } from "./score";
import { rankCandidates, type RankedCandidate } from "./relevance";

/** A conductor whose relevance judgment the adapter can update between passes. */
export interface RelevanceAware {
	setKeepWarm(ids: ReadonlySet<string>): void;
}

export function isRelevanceAware(p: unknown): p is RelevanceAware {
	return typeof (p as RelevanceAware | null)?.setKeepWarm === "function";
}

export class ModelConductor extends KeelConductor implements RelevanceAware {
	readonly id: string = "keel-model";
	readonly label: string = "Keel + model coldness";

	private keepWarm: ReadonlySet<string> = new Set();

	/** The adapter injects the model's latest "keep warm" judgment before each conduct pass. */
	setKeepWarm(ids: ReadonlySet<string>): void {
		this.keepWarm = ids;
	}

	protected rank(blocks: ViewBlock[], roots: Set<string>, ctx: ScoreCtx): RankedCandidate[] {
		const base = rankCandidates(blocks, roots, ctx);
		if (this.keepWarm.size === 0) return base;
		// Stable partition: model-cold first (fold these), model-keep last (fold only under floor
		// pressure). The relative order inside each group is preserved from the deterministic ranking.
		const cold: RankedCandidate[] = [];
		const warm: RankedCandidate[] = [];
		for (const c of base) (this.keepWarm.has(c.block.id) ? warm : cold).push(c);
		return [...cold, ...warm];
	}
}
