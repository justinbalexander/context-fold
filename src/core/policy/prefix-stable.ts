/*
 * prefix-stable.ts — the cache-aware ranking (CONTEXTFOLD_PREFIX_STABLE=1).
 *
 * Prompt-prefix caching is positional: any byte change invalidates everything after it, so a
 * fold that rewrites an EARLY block forfeits the warm cache for the whole conversation below —
 * measured at 0% retention for a head-rewriting fold vs 66–71% when the head stays byte-stable
 * (Evoker E13, 2026-07-28). Keel's coldest-first ranking correlates with oldest-first and so
 * preferentially rewrites the head. This subclass flips the designed `rank()` seam: fold the
 * OLDEST unfrozen candidates first, so the mutation frontier hugs the frozen boundary and every
 * committed layer extends the byte-stable prefix monotonically. The ladder and hard-cap floor
 * are unchanged — budget safety is ranking-independent — and risk lines survive because every
 * fidelity level carries them, not because of where a block ranks.
 */
import { KeelConductor } from "./keel";
import type { ViewBlock } from "../contract";
import type { ScoreCtx } from "./score";
import { rankCandidates, type RankedCandidate } from "./relevance";

export class PrefixStableKeel extends KeelConductor {
	override readonly id: string = "prefix-stable";
	override readonly label: string = "Prefix-stable Keel";

	protected override rank(blocks: ViewBlock[], roots: Set<string>, ctx: ScoreCtx): RankedCandidate[] {
		const ranked = rankCandidates(blocks, roots, ctx);
		// Same candidate set and metadata; position decides. Ties cannot occur (order is unique).
		ranked.sort((a, b) => a.block.order - b.block.order);
		return ranked;
	}
}
