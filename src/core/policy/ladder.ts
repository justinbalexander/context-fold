/*
 * ladder.ts — Keel's FIDELITY LADDER. Route a cold block to the compressor that fits its content
 * type, picking the shallowest level that meets budget:
 *
 *   L0 Full      — no change (roots / hot / protected).
 *   L1 Skeleton  — code-file read → structural skeleton (imports/types/signatures, bodies elided).
 *                  REVERSIBLE: `replace` with `recoverable:true` → the engine bakes the
 *                  `{#code FOLDED}` tag so the agent can unfold/recall the full source. Only fires
 *                  on blocks the classifier confirms are code-file reads; anything else (grep dump,
 *                  markdown, JSON, image) returns null and the ladder degrades L1→L2→L3 cleanly.
 *   L2 Trim      — long prose/thinking/non-code result → deterministic extractive excerpt
 *                  (~25%, head/tail + risk-flag lines + longest lines). REVERSIBLE.
 *   L3 Digest    — short engine per-kind digest (fold, no policy digest). Floor for any block.
 *   L4 Group / L5 Drop — owned by the budget floor (budget.ts), not this per-unit router.
 *
 * Pure & deterministic. Ported from Accordion `conductors/keel/ladder.ts` (commit 0c22434), with
 * the L1.5 Bear-2 path removed (Phase 3) — so `trySkeleton` returns the plain L1 result without
 * the `skeletonMeta` Bear-2 carried. The classifier + skeletonizer it calls are the ported
 * `src/core/skeleton/{classify,skeletonize}.ts` (same commit).
 */
import type { Command, ViewBlock } from "../contract";
import { classifyCodeRead } from "../skeleton/classify";
import { detectLang, skeletonize } from "../skeleton/skeletonize";
import { riskFlags } from "./ledger";

/** Don't skeletonize a read smaller than this (header/tag overhead wouldn't pay off). */
const MIN_SKELETON_TOKENS = 1500;
/** A skeleton must cost ≤ this fraction of the full block to be worth it. */
const MAX_SKELETON_RATIO = 0.6;

/** A trim must cost ≤ this fraction of the full block to be worth it. */
const MAX_TRIM_RATIO = 0.6;
/** Don't trim a block smaller than this. */
const MIN_TRIM_TOKENS = 600;
/** Extractive excerpt target — keep roughly this fraction of the original. */
const TRIM_TARGET_RATIO = 0.25;
/** Rough cost of the `{#code FOLDED}` tag + per-block overhead the host adds on top. */
const TAG_OVERHEAD_TOKENS = 10;

const ELL = "…";

export interface LevelResult {
	command: Command;
	/** Estimated tokens of the substitution (for budget projection). */
	tokens: number;
}

/** A token-counting function (host tokenizer or chars/4 fallback). */
export type CountTokens = (text: string) => number;

/**
 * L1 — skeletonize a code-file read into a recoverable `replace`. Returns null if the block
 * isn't a worthwhile code read: wrong kind, too small (< MIN_SKELETON_TOKENS), the classifier
 * rejects it (not a code-file read — grep dump, markdown, JSON, image), the skeletonizer finds
 * nothing to elide, or the skeleton wouldn't shrink the block enough (> MAX_SKELETON_RATIO). On
 * every null the ladder degrades cleanly to L2 (trim) / L3 (digest).
 *
 * Built exactly as upstream: header + skeleton body as the `replace` content, `recoverable:true`
 * so the engine prepends the authoritative `{#code FOLDED}` tag (this port supplies the BODY
 * only — the host owns the tag).
 */
export function trySkeleton(block: ViewBlock, callById: Map<string, ViewBlock>, count: CountTokens): LevelResult | null {
	if (block.kind !== "tool_result") return null;
	if (block.tokens < MIN_SKELETON_TOKENS) return null;
	// FAIL-OPEN: L1 is a pure fidelity optimization. A classifier/skeletonizer defect on hostile
	// input (unterminated strings, exotic syntax) must degrade this one block to L2/L3 — never
	// abort the whole fold pass (nothing above this catches; the context hook would lose the turn).
	try {
		const info = classifyCodeRead(block, callById);
		if (!info) return null;

		const lang = detectLang(info.path, info.source);
		const sk = skeletonize(info.source, lang);
		if (sk.elidedLines === 0) return null;

		const header = `⟨code skeleton · ${info.path ?? "file"} · ${sk.totalLines}L → ${sk.keptLines}L · ${sk.elidedLines} elided · call unfold for full source⟩`;
		const content = `${header}\n${sk.skeleton}`;
		const tokens = count(content) + TAG_OVERHEAD_TOKENS;
		const saved = block.tokens - tokens;
		if (saved <= 0 || tokens > block.tokens * MAX_SKELETON_RATIO) return null;

		return { command: { kind: "replace", id: block.id, content, recoverable: true }, tokens };
	} catch {
		return null;
	}
}

/**
 * L2 — deterministic extractive TRIM of a long prose/thinking/non-code result. Keeps the head,
 * the tail, and any risk-flag line unconditionally; fills the rest of the ~25% budget with the
 * longest remaining lines. REVERSIBLE (`recoverable:true`). Returns null if too small or it
 * wouldn't shrink enough.
 */
export function tryTrim(block: ViewBlock, count: CountTokens): LevelResult | null {
	if (block.text === undefined) return null;
	if (block.tokens < MIN_TRIM_TOKENS) return null;

	const content = buildTrim(block.text, block.turn);
	const tokens = count(content) + TAG_OVERHEAD_TOKENS;
	const saved = block.tokens - tokens;
	if (saved <= 0 || tokens > block.tokens * MAX_TRIM_RATIO) return null;

	return { command: { kind: "replace", id: block.id, content, recoverable: true }, tokens };
}

/** Build the deterministic extractive excerpt. Line-based, no NLP. */
function buildTrim(text: string, turn: number): string {
	const lines = text.split("\n");
	const n = lines.length;
	const budgetChars = Math.max(240, Math.floor(text.length * TRIM_TARGET_RATIO));

	if (n <= 4) {
		const clipped = text.length > budgetChars ? text.slice(0, budgetChars - 1).trimEnd() + ELL : text;
		return `⟦trim t${turn}⟧ ${clipped}`;
	}

	const keep = new Set<number>();
	let used = 0;
	const tryAdd = (i: number): void => {
		if (i < 0 || i >= n || keep.has(i)) return;
		const len = lines[i].length + 1;
		if (keep.size > 0 && used + len > budgetChars) return;
		keep.add(i);
		used += len;
	};

	// 1. Risk-bearing lines kept unconditionally (load-bearing identifiers).
	for (let i = 0; i < n; i++) {
		if (lines[i].length > 0 && riskFlags(lines[i]).length > 0) tryAdd(i);
	}
	// 2. Anchor head and tail.
	tryAdd(0);
	tryAdd(1);
	tryAdd(n - 1);
	tryAdd(n - 2);
	// 3. Fill remaining budget by longest line first (stable index tiebreak).
	const byLen = lines.map((line, i) => ({ i, len: line.length })).sort((a, b) => b.len - a.len || a.i - b.i);
	for (const { i } of byLen) {
		if (used >= budgetChars) break;
		tryAdd(i);
	}

	const order = [...keep].sort((a, b) => a - b);
	const parts: string[] = [];
	let prev = -1;
	for (const i of order) {
		if (prev >= 0 && i > prev + 1) parts.push(`⟪${ELL} ${i - prev - 1} more ${ELL}⟫`);
		parts.push(lines[i]);
		prev = i;
	}
	if (prev >= 0 && prev < n - 1) parts.push(`⟪${ELL}⟫`);
	const body = parts.join("\n");
	const capped = body.length > budgetChars ? body.slice(0, budgetChars - 3).trimEnd() + "..." : body;
	return `⟦trim t${turn}⟧ ${capped}`;
}

/**
 * L3 — DIGEST. Fold the block to the engine's per-kind digest (which already carries the
 * `{#code FOLDED}` recovery tag for foldable kinds). Returns a `fold` with no `digest` so the
 * host applies its own. `foldedTokens` is the host-supplied digest cost — no recompute needed.
 */
export function digestLevel(block: ViewBlock): LevelResult {
	return { command: { kind: "fold", ids: [block.id] }, tokens: block.foldedTokens };
}
