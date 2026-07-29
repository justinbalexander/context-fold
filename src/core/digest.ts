/*
 * digest.ts — what a folded block collapses to.
 *
 * Deterministic, per-kind. Each kind keeps a different essence when folded: a tool_call keeps
 * WHAT it did, a tool_result keeps only its shape and a taste of WHAT it saw. No LLM here —
 * these are structured digests so behaviour is reproducible and debuggable.
 *
 * Every digest carries a leading `{#<code> FOLDED}` tag. This is the engine's source-of-truth
 * string: it is the exact text the agent receives in place of the folded content. The agent
 * reads the short `code` from the tag and calls `unfold`/`recall` with it to pull the block
 * back to full content. The code is a 6-char base36 FNV-1a hash of the block's durable id —
 * stateless and globally stable (same block → same code, every session).
 *
 * Ported ~verbatim from Accordion `engine/digest.ts` (pinned commit 0c22434); only the type
 * imports were retargeted to this port's block model.
 */
import type { BlockKind, DigestBlock } from "./block";
import { estTokens, clip, firstLine, safeSlice, BLOCK_OVERHEAD } from "./tokens";
import { categorize } from "./policy/ledger";

/**
 * Kinds the wire can actually fold and send. A `tool_call` is never folded (it would orphan its
 * result) and a `user` block (intent) is never folded. ONLY these kinds get a `{#code FOLDED}`
 * tag — so the agent is never shown a handle for a block it can't actually unfold.
 */
export const FOLDABLE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(["text", "thinking", "tool_result"]);

/**
 * The ONE foldability predicate, shared by the view and the wire: a block may be folded iff its
 * KIND is foldable. KIND ONLY — deliberately content- and id-independent. The durable-id guard
 * (`isDurableId`) is a separate wire-emit concern, NOT part of foldability.
 */
export function wireFoldable(b: DigestBlock): boolean {
	return FOLDABLE_KINDS.has(b.kind);
}

/** Short, stable handle for a block, derived purely from its durable id (FNV-1a → base36, 6 chars). */
export function foldCode(id: string): string {
	let h = 0x811c9dc5; // FNV-1a 32-bit
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

/** The folded-block marker the agent sees and passes back to `unfold`, e.g. `{#3f9a2c FOLDED}`. */
export function foldTag(id: string): string {
	return `{#${foldCode(id)} FOLDED}`;
}

/**
 * Per-block memo of the (immutable) digest string.
 *
 * TRIPWIRE: there is no invalidation. Sound ONLY because a committed block's content fields are
 * never mutated in place. If a future feature mutates an existing block's `text`/`tokens`, it
 * MUST clear this cache for that block.
 */
const digestCache = new WeakMap<DigestBlock, string>();

/**
 * The full folded representation. Foldable kinds get the `{#<code> FOLDED}` tag followed by the
 * per-kind body; non-foldable kinds (user / tool_call) get the body alone — they are never sent
 * folded, so tagging them would show a handle the agent can never use.
 */
export function digest(b: DigestBlock): string {
	const cached = digestCache.get(b);
	if (cached !== undefined) return cached;
	const body = digestBody(b);
	const out = FOLDABLE_KINDS.has(b.kind) ? `${foldTag(b.id)} ${body}` : body;
	digestCache.set(b, out);
	return out;
}

/** The per-kind essence kept when a block is folded (without the tag). */
function digestBody(b: DigestBlock): string {
	switch (b.kind) {
		case "user":
			return "“" + clip(b.text, 100) + "”";
		case "text":
			return clip(b.text, 120);
		case "thinking": {
			const tok = estTokens(b.text);
			const gist = firstLine(b.text, 80);
			return `thought · ~${tok} tok${gist ? " · " + gist : ""}`;
		}
		case "tool_call":
			return `${b.toolName ?? "tool"}(${clip(b.text.replace(/^\S+\s*/, ""), 70)})`;
		case "tool_result": {
			const name = b.toolName ?? "result";
			if (!b.text.trim()) return `${name} → ${b.isError ? "error" : "empty"}`;
			const lines = b.text.split("\n").filter((l) => l.trim()).length;
			const tag = b.isError ? "error" : `${lines} line${lines === 1 ? "" : "s"}`;
			const peek = firstLine(b.text, 60);
			const head = `${name} → ${tag}, ~${b.tokens} tok${peek ? " · " + peek : ""}`;
			// L3 risk-line retention: a folded result never reduces a load-bearing error/risk line to a
			// one-line summary. Keep the detected risk lines verbatim, tightly
			// capped and errors-first, so a buried ImportError survives the aging fold.
			const risk = collectRiskLines(b.text, { maxLines: L3_RISK_LINES, maxChars: L3_RISK_CHARS });
			return risk.length ? `${head}\n${risk.join("\n")}` : head;
		}
		default:
			return clip(b.text, 80);
	}
}

/**
 * Token cost of substituted content (a gate pointer or a frozen layer's bytes). The text varies
 * per block and per session, so it is NOT cached on the block. Same estimate + per-block overhead
 * as a digest.
 */
export function substTokens(content: string): number {
	return estTokens(content) + BLOCK_OVERHEAD;
}

// ── L0 ingestion gate: risk-line retention + tool-aware pointer digests ─────────

/** L3 (aging) risk-line caps — tight, so a routine result grows only a little. */
const L3_RISK_LINES = 6;
const L3_RISK_CHARS = 400;
/** Per-line clip for retained risk lines (bounds one pathological line). */
const RISK_LINE_CLIP = 200;

/**
 * Is a single line risk-bearing, and does it carry an ERROR/traceback? Uses the ledger's
 * `categorize` harvester — the single detector shared by the gate, the pointer and the digest.
 */
function lineRisk(line: string): { risk: boolean; error: boolean } {
	const c = categorize(line);
	const error = c.errors.length > 0;
	const risk = error || c.exact_values.length > 0 || c.decisions.length > 0 || c.commands.length > 0 || c.paths.length > 0;
	return { risk, error };
}

/**
 * Collect the verbatim lines of `text` that carry a risk flag, deduped, errors first, then other
 * risk lines — capped by both line count and total characters.
 */
export function collectRiskLines(text: string, opts: { maxLines: number; maxChars: number }): string[] {
	const errors: string[] = [];
	const others: string[] = [];
	const seen = new Set<string>();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || seen.has(line)) continue;
		const { risk, error } = lineRisk(line);
		if (!risk) continue;
		seen.add(line);
		(error ? errors : others).push(line.length > RISK_LINE_CLIP ? safeSlice(line, RISK_LINE_CLIP - 1) + "…" : line);
	}
	const out: string[] = [];
	let chars = 0;
	for (const line of [...errors, ...others]) {
		if (out.length >= opts.maxLines) break;
		if (out.length > 0 && chars + line.length > opts.maxChars) break;
		out.push(line);
		chars += line.length + 1;
	}
	return out;
}

/** Count how many distinct lines of `text` carry any risk flag (for the "+N more" pointer hint). */
export function countRiskLines(text: string): number {
	const seen = new Set<string>();
	let n = 0;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || seen.has(line)) continue;
		if (lineRisk(line).risk) {
			seen.add(line);
			n++;
		}
	}
	return n;
}

/** Metadata a born-folded L0 pointer needs, beyond the block's own full text. */
export interface PointerMeta {
	/** The fold code (= foldCode(blockId)); the pointer's {#code FOLDED} handle. */
	code: string;
	tool: string;
	/** The tool's input arguments, for the tool-aware one-line summary. */
	input?: unknown;
	isError: boolean;
	/** Byte length of the full spooled content. */
	bytes: number;
	/** estTokens of the full spooled content (the weight this pointer removed from the view). */
	fullEstTokens: number;
	/** Absolute spool path (so the pointer is self-locating for debugging). */
	spoolPath: string;
	/** Bash results: the tool's own full-output file, also searched by recall-grep. */
	fullOutputPath?: string;
	/** When set, this payload was identical to an earlier fold. */
	dedupOf?: string;
}

/** Pointer digest budget: ≤400 est-tokens total . */
export const POINTER_TOKEN_BUDGET = 400;
const POINTER_HEAD_LINES = 8;
const POINTER_TAIL_LINES = 8;
const POINTER_RISK_LINES = 40;
const POINTER_LINE_CLIP = 200;

function clipLine(s: string): string {
	const t = s.replace(/\t/g, "  ");
	return t.length > POINTER_LINE_CLIP ? safeSlice(t, POINTER_LINE_CLIP - 1) + "…" : t;
}

/** A short, tool-aware one-liner describing WHAT was folded (read: path+lines; grep: pattern; …). */
function toolSummary(text: string, meta: PointerMeta): string {
	const lineCount = text.split("\n").length;
	const kb = (meta.bytes / 1024).toFixed(meta.bytes >= 10240 ? 0 : 1);
	const size = `${lineCount} lines, ${kb}KB (~${meta.fullEstTokens} tok)`;
	const input = (meta.input ?? {}) as Record<string, unknown>;
	const errTag = meta.isError ? " [error]" : "";
	switch (meta.tool) {
		case "read": {
			const path = typeof input.path === "string" ? input.path : "";
			return `read ${path}${errTag} — ${size}`.trim();
		}
		case "grep": {
			const pat = typeof input.pattern === "string" ? input.pattern : "";
			return `grep ${JSON.stringify(pat)}${errTag} — ${size}`;
		}
		case "bash": {
			const cmd = typeof input.command === "string" ? clip(input.command, 80) : "";
			return `bash ${cmd}${errTag} — ${size}`;
		}
		case "find":
		case "ls": {
			return `${meta.tool}${errTag} — ${size}`;
		}
		default: {
			const args = clip(JSON.stringify(input), 80);
			return `${meta.tool} ${args}${errTag} — ${size}`;
		}
	}
}

/**
 * The born-folded L0 POINTER: a deterministic, tool-aware digest that stands in for a large tool
 * result in the model's view. Head + tail + every detected risk line (up to 40) survive verbatim;
 * the full content is on disk in the spool, recoverable whole, by grep, or by line range. Carries
 * the authoritative `{#code FOLDED}` tag so the agent can recall it. Budget ≤400 est-tokens; risk
 * lines are trimmed first if the budget is tight.
 */
export function pointerDigest(text: string, meta: PointerMeta): string {
	const tag = `{#${meta.code} FOLDED}`;
	const lines = text.split("\n");
	const summary = toolSummary(text, meta);

	const head = lines.slice(0, POINTER_HEAD_LINES).map(clipLine);
	const tail = lines.length > POINTER_HEAD_LINES + POINTER_TAIL_LINES ? lines.slice(-POINTER_TAIL_LINES).map(clipLine) : [];

	const totalRisk = countRiskLines(text);
	let risk = collectRiskLines(text, { maxLines: POINTER_RISK_LINES, maxChars: 1200 });

	const usage = `full content on disk — \`recall #${meta.code}\` for all of it, \`recall #${meta.code} grep=<term>\` or \`lines=<a-b>\` for a slice.`;
	const dedupNote = meta.dedupOf ? ` (identical to #${meta.dedupOf})` : "";

	const build = (riskLines: string[]): string => {
		const parts: string[] = [`${tag} ${summary}${dedupNote}`];
		if (head.length) parts.push("head:", ...head);
		if (tail.length) parts.push("…", "tail:", ...tail);
		if (riskLines.length) {
			parts.push(`risk lines (${totalRisk}):`, ...riskLines);
			if (totalRisk > riskLines.length) parts.push(`[+${totalRisk - riskLines.length} more — recall #${meta.code} grep=<term>]`);
		}
		parts.push(usage);
		return parts.join("\n");
	};

	// Enforce the token budget by trimming risk lines first (head/tail/usage are load-bearing) —
	// then head/tail lines: long risk-free lines alone can blow the budget, and the ≤400 contract
	// must hold on every input, not just risk-heavy ones. Keep ≥3 lines each so the pointer stays
	// recognizable.
	let out = build(risk);
	while (estTokens(out) > POINTER_TOKEN_BUDGET && risk.length > 0) {
		risk = risk.slice(0, risk.length - 1);
		out = build(risk);
	}
	while (estTokens(out) > POINTER_TOKEN_BUDGET && tail.length > 3) {
		tail.pop();
		out = build(risk);
	}
	while (estTokens(out) > POINTER_TOKEN_BUDGET && head.length > 3) {
		head.pop();
		out = build(risk);
	}
	return out;
}

/** Token weight of a pointer digest (for born-folded budget accounting). */
export function pointerDigestTokens(text: string, meta: PointerMeta): number {
	return estTokens(pointerDigest(text, meta)) + BLOCK_OVERHEAD;
}
