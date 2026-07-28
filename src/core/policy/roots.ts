/*
 * roots.ts — Keel's ROOT SET: blocks held at full fidelity regardless of age or score, excluded
 * from every fold-candidate list AND from the hard-cap floor. Roots are:
 *   1+2. Every user/spec message (the first is the original task; all are durable verbatim).
 *   3.   The protected working tail (host-absolute).
 *   4.   Any currently human/agent-held block, FOR AS LONG AS THE OVERRIDE STANDS.
 *
 * Read PER PASS from the live `held` flag — never accumulated, so an unpinned block becomes
 * foldable again the next pass (no cross-pass drift). Fact-source stickiness is a SOFT signal in
 * relevance.ts, not a hard root. Ported from Accordion `conductors/keel/roots.ts` (commit 0c22434).
 */
import type { ViewBlock } from "../contract";

export function identifyRoots(view: ViewBlock[]): Set<string> {
	const ids = new Set<string>();
	for (const b of view) {
		if (b.kind === "user") ids.add(b.id); // user/spec — also non-foldable on the wire
		if (b.protected || b.held) ids.add(b.id); // protected tail + currently-held
	}
	return ids;
}
