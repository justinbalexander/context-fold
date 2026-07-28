/*
 * relevance.ts — Keel's fold-candidate RANKING. Produces the cold→hot ordered list (index 0 =
 * fold first). Three deterministic signals compose, in priority order:
 *   1. ENTITY REACHABILITY — unreachable-from-roots blocks are semantically dead → fold first.
 *   2. RISK STICKINESS — a block carrying load-bearing facts folds later within its tier.
 *   3. ACT-R COLD SCORE — power-law forgetting; ties broken by conversation order (oldest first).
 *
 * Candidates EXCLUDE roots and anything the host won't fold (held/protected/grouped/non-foldable
 * kind / wouldn't shrink). Ported from Accordion `conductors/keel/relevance.ts` (commit 0c22434).
 */
import type { ViewBlock } from "../contract";
import { buildGraph, markReachable } from "./edges";
import { coldScore, FOLDABLE_KINDS, type ScoreCtx } from "./score";
import { riskFlags } from "./ledger";

export interface RankedCandidate {
	block: ViewBlock;
	reachable: boolean;
	riskCount: number;
	cold: number;
}

/** Rank the fold candidates coldest-first (index 0 = fold first). */
export function rankCandidates(view: ViewBlock[], roots: Set<string>, ctx: ScoreCtx): RankedCandidate[] {
	const marked = markReachable(buildGraph(view), roots);

	const candidates = view.filter(
		(b) =>
			!roots.has(b.id) &&
			!b.held &&
			!b.protected &&
			!b.grouped &&
			!b.bornFolded && // L0 pointers are terminal — never re-digested by a deeper rung
			!b.frozen && // committed prefix-stable layers are byte-fixed — never re-ranked
			b.foldedTokens < b.tokens &&
			FOLDABLE_KINDS.has(b.kind),
	);

	const ranked: RankedCandidate[] = candidates.map((block) => ({
		block,
		reachable: marked.has(block.id),
		riskCount: block.text !== undefined ? riskFlags(block.text).length : 0,
		cold: coldScore(block, ctx),
	}));

	ranked.sort((a, b) => {
		if (a.reachable !== b.reachable) return a.reachable ? 1 : -1; // unreachable first
		if (a.riskCount !== b.riskCount) return a.riskCount - b.riskCount; // fewer risk flags first
		if (a.cold !== b.cold) return a.cold - b.cold; // coldest first
		return a.block.order - b.block.order; // stable tiebreak: oldest first
	});

	return ranked;
}
