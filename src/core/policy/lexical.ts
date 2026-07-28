/*
 * lexical.ts — extract identifiers from the protected tail and match them against older folded
 * blocks (the ACT-R warmth signal). If the agent is currently working with a path/symbol/quoted
 * string that appears in an older block, that block is probably relevant and stays warm.
 *
 * Ported from Accordion `conductors/cold-score/lexical.ts` (pinned commit 0c22434).
 */
import type { ViewBlock } from "../contract";

const STOPWORDS = new Set([
	"true", "false", "null", "undefined", "return", "const", "import", "export",
	"async", "await", "function", "string", "number", "boolean", "object", "array",
	"void", "never", "type", "interface", "class", "extends", "implements",
	"this", "self", "super", "new", "throw", "catch", "error", "from", "with",
]);

const MIN_SYMBOL_LEN = 4;
const QUOTED_MIN = 3;
const QUOTED_MAX = 80;
const MAX_IDENTIFIERS = 200;

/** Extract a set of identifiers (paths, code symbols, quoted strings) from a tail text string. */
export function extractIdentifiers(tailText: string): Set<string> {
	const candidates = new Map<string, number>(); // value → length (for sorting)

	// 1. Quoted strings (backtick, double-quote, single-quote).
	const quotedRe = /`([^`]{3,80})`|"([^"\n]{3,80})"|'([^'\n]{3,80})'/g;
	let m: RegExpExecArray | null;
	while ((m = quotedRe.exec(tailText)) !== null) {
		const inner = (m[1] ?? m[2] ?? m[3]).trim();
		if (inner.length >= QUOTED_MIN && inner.length <= QUOTED_MAX && !STOPWORDS.has(inner.toLowerCase())) {
			candidates.set(inner, inner.length);
		}
	}

	// 2. File paths.
	const pathRe = /(?:[A-Za-z]:[\\/]|\.\.?[\\/]|[\\/])?[\w@.-]+(?:[\\/][\w.@-]+)+/g;
	while ((m = pathRe.exec(tailText)) !== null) {
		const raw = m[0].replace(/^[^\w@./\\A-Z]+|[^)\w/\\]+$/g, "").replace(/[.,;:'"`)]+$/, "");
		if (raw.length >= QUOTED_MIN && !STOPWORDS.has(raw.toLowerCase())) {
			candidates.set(raw, raw.length);
		}
	}

	// 3. Code identifiers (camelCase, snake_case, PascalCase, SCREAMING_CASE).
	const symbolRe = /\b[A-Za-z_$][\w$]{3,}\b/g;
	while ((m = symbolRe.exec(tailText)) !== null) {
		const tok = m[0];
		if (tok.length < MIN_SYMBOL_LEN) continue;
		if (STOPWORDS.has(tok.toLowerCase())) continue;
		const rest = tok.slice(1);
		if (!/[A-Z_$0-9]/.test(rest)) continue; // plain lowercase word → skip
		candidates.set(tok, tok.length);
	}

	const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
	return new Set(sorted.slice(0, MAX_IDENTIFIERS).map(([k]) => k));
}

/**
 * Match extracted identifiers against candidate blocks → Map block.id → first matching identifier
 * (case-sensitive substring against b.text). RARITY GUARD: an identifier matching more than
 * max(3, 25% of candidates) is dropped (common token, not a signal).
 */
export function matchBlocks(ids: Set<string>, candidates: ViewBlock[]): Map<string, string> {
	if (!ids.size || !candidates.length) return new Map();
	const threshold = Math.max(3, Math.floor(candidates.length * 0.25));

	const idToBlocks = new Map<string, string[]>();
	for (const id of ids) {
		const matched: string[] = [];
		for (const b of candidates) {
			if (b.text !== undefined && b.text.includes(id)) matched.push(b.id);
		}
		if (matched.length > 0 && matched.length <= threshold) idToBlocks.set(id, matched);
	}

	const result = new Map<string, string>();
	for (const [identifier, blockIds] of idToBlocks) {
		for (const bid of blockIds) if (!result.has(bid)) result.set(bid, identifier);
	}
	return result;
}
