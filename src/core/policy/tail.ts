/*
 * tail.ts — small shared view helpers: the protected-tail text window (the identifier source for
 * ACT-R warmth) and the session's "current turn". Extracted from Accordion
 * `conductors/cold-score/cold-score.ts` (pinned commit 0c22434).
 */
import type { ViewBlock } from "../contract";

/** Cap on the tail text scanned for identifiers (~32k chars). */
const TAIL_TEXT_CAP = 32_000;

/** Concatenate the protected-tail text, newest-walking, capped — the identifier source for warmth. */
export function buildTailText(blocks: ViewBlock[]): string {
	let text = "";
	for (let i = blocks.length - 1; i >= 0 && text.length < TAIL_TEXT_CAP; i--) {
		const b = blocks[i];
		if (!b.protected) break; // walked past the protected tail
		if (b.text !== undefined) text = b.text + "\n" + text;
	}
	return text;
}

/**
 * The policy's notion of "now" — the HIGHEST turn across the blocks (0 for empty). Deliberately
 * the max, not the last block's turn: robust to a resync that appends an older-turn block.
 */
export function currentTurn(blocks: ViewBlock[]): number {
	let t = 0;
	for (const b of blocks) if (b.turn > t) t = b.turn;
	return t;
}
