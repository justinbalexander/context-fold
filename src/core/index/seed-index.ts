/*
 * seed-index.ts — the deterministic seed index emitted at every fold event.
 *
 * The index is the lexical bridge back into folded content (spec: docs/SEED_INDEX_SPEC.md).
 * Grep-based recovery can only find what is indexed VERBATIM, so extraction is pure regex work —
 * no model calls, no paraphrase, same input ⇒ byte-identical output. First-class fields are
 * exactly the classes summarization measurably drops: exact identifiers/numbers buried in large
 * tool outputs (summary-boundary loss) and error strings in every spelling the shared lexicon
 * knows (lowercase `failed`, `npm ERR!`, …).
 *
 * Pure core: no disk, no Date (the caller supplies `at`), no harness imports.
 */
import { ERROR_MARKER_SOURCE, errorMarkerRe } from "../policy/ledger";
import { firstLine, safeSlice } from "../tokens";
import { foldCode } from "../digest";
import type { WireBlock } from "../block";

/** One recovery pointer: names a folded block in the session ledger and its extent (spec §spans). */
export interface IndexSpan {
	blockId: string;
	/** The in-context recall handle ({#code FOLDED}). */
	code?: string;
	tool?: string;
	turn: number;
	log: { bytes: number; lines: number };
	/** sha256 (hex) of the block text at fold time — what recall verifies the ledger bytes against. */
	sha256?: string;
	fullOutputPath?: string;
}

/** A verbatim error-shaped line with provenance and (when present) the following line. */
export interface ErrorLine {
	/** The marker line, trimmed, ≤ ERROR_CLIP (240) chars. */
	line: string;
	/** The line immediately after the marker line, trimmed, ≤ ERROR_CLIP, when non-empty.
	 *  The cause usually follows the marker (the line after `Traceback`, the `npm ERR!` detail). */
	context?: string;
	/** Turn of the source block. */
	turn: number;
	/** foldCode of the source block — a recall handle (only foldable blocks are masked, so it resolves). */
	code?: string;
	/** True when the source tool_result block carried pi's `isError` flag. */
	toolError?: boolean;
}

/** A shell-class command with provenance. */
export interface IndexedCommand {
	command: string;
	turn: number;
	/** foldCode of the source block: the paired tool_result for a shell call, or the block a
	 *  harvested `$ …` line came from. */
	code?: string;
}

export interface SeedIndexRecord {
	v: number;
	kind: "fold-index";
	harness: string;
	session: string;
	seq: number;
	at: string;
	trigger: "threshold" | "cap" | "compact";
	usage: { tokens: number; contextWindow: number; fraction: number };
	files: string[];
	commands: IndexedCommand[];
	errors: ErrorLine[];
	identifiers: string[];
	userMessages: { turn: number; firstLine: string }[];
	spans: IndexSpan[];
}

// Per-record caps (spec: deduplicated, insertion/salience order, bounded).
const MAX_FILES = 32;
const MAX_COMMANDS = 24;
const MAX_ERRORS = 24;
const MAX_IDENTIFIERS = 64;
const ERROR_CLIP = 240;
const USER_FIRST_LINE_CLIP = 200;
/** Hard bound on a STORED command — bounds pathological inputs (pasted files) without
 *  destroying normal multi-line commands. Rendering clips to COMMAND_RENDER_CLIP. */
const COMMAND_STORE_CLIP = 8000;

/** Tool names treated as shell executors: their call args are indexed verbatim as commands. */
const SHELL_TOOLS = new Set(["bash", "shell", "sh", "cmd", "exec", "run", "terminal", "run_command"]);

export interface ExtractInput {
	/** The blocks being masked by this fold event (content leaving the live view). */
	masked: WireBlock[];
	/** Every block in the session view this turn — used to pair tool_calls and find user turns. */
	all: WireBlock[];
}

export type ExtractedIndex = Pick<SeedIndexRecord, "files" | "commands" | "errors" | "identifiers" | "userMessages">;

/**
 * Deterministically extract the index fields for one fold event. Files/commands come from the
 * masked blocks plus their paired tool_call blocks; identifiers are harvested from the masked
 * output itself (biased to the largest blocks — the summary-boundary-loss class); user first
 * lines cover the turn range the fold spans (user intent never folds away silently).
 */
export function extractIndex(input: ExtractInput): ExtractedIndex {
	const { masked, all } = input;
	const out: ExtractedIndex = { files: [], commands: [], errors: [], identifiers: [], userMessages: [] };
	if (masked.length === 0) return out;

	const callsById = new Map<string, WireBlock>();
	for (const b of all) if (b.kind === "tool_call" && b.callId) callsById.set(b.callId, b);
	const pairedCalls: WireBlock[] = [];
	for (const b of masked) {
		if (b.kind === "tool_result" && b.callId) {
			const call = callsById.get(b.callId);
			if (call) pairedCalls.push(call);
		}
	}

	// files: path-shaped tokens from masked content and the paired call args.
	const files = new Dedup(MAX_FILES);
	for (const b of [...pairedCalls, ...masked]) harvestPaths(b.text, files);
	out.files = files.values();

	// commands: shell-class tool_call args verbatim (full, hard-capped), then `$ `-prefixed lines
	// and tool-invocation-shaped lines inside masked output.
	const commands = new DedupKeyed<IndexedCommand>(MAX_COMMANDS, (c) => c.command);
	for (const call of pairedCalls) {
		if (!SHELL_TOOLS.has((call.toolName ?? "").toLowerCase())) continue;
		// tool_call block text is "<toolName> <args…>" (block.ts bridge) — index the args.
		const args = call.text.replace(/^\S+\s*/, "");
		if (!args.trim()) continue;
		// Provenance points at the RESULT block (foldable, recallable), not the call (never folded).
		const result = masked.find((b) => b.kind === "tool_result" && b.callId === call.callId);
		commands.add({
			command: safeSlice(args.trim(), COMMAND_STORE_CLIP),
			turn: result?.turn ?? call.turn,
			...(result ? { code: foldCode(result.id) } : {}),
		});
	}
	for (const b of masked) harvestCommands(b, commands);
	out.commands = commands.values();

	// errors: WHOLE lines carrying a marker from the shared lexicon, clipped ≤240 (grep-friendly —
	// the ledger's 60-char snippets are for display; recovery wants the full line).
	const errors = new DedupKeyed<ErrorLine>(MAX_ERRORS, (e) => e.line);
	const marker = errorMarkerRe();
	// Two passes in one ordered list: tool-flagged error blocks first. Their lines win the capped
	// slots — a failure the tool itself reported outranks a line that merely mentions "error".
	const ordered = [...masked.filter((b) => b.isError), ...masked.filter((b) => !b.isError)];
	for (const b of ordered) {
		const lines = b.text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const t = lines[i].trim();
			if (!t || !marker.test(t)) continue;
			const next = i + 1 < lines.length ? lines[i + 1].trim() : "";
			errors.add({
				line: safeSlice(t, ERROR_CLIP),
				...(next ? { context: safeSlice(next, ERROR_CLIP) } : {}),
				turn: b.turn,
				code: foldCode(b.id),
				...(b.isError ? { toolError: true } : {}),
			});
		}
	}
	out.errors = errors.values();

	// identifiers: exact symbols/hex/versions/numbers from masked content, largest blocks first
	// (a flood is where the buried-identifier class lives), rarer/longer tokens preferred.
	out.identifiers = harvestIdentifiers([...masked].sort((a, b) => b.tokens - a.tokens || a.order - b.order));

	// user first lines across the fold's turn range.
	let minTurn = Infinity;
	let maxTurn = -Infinity;
	for (const b of masked) {
		if (b.turn < minTurn) minTurn = b.turn;
		if (b.turn > maxTurn) maxTurn = b.turn;
	}
	for (const b of all) {
		if (b.kind === "user" && b.turn >= minTurn && b.turn <= maxTurn) {
			const line = firstLine(b.text, USER_FIRST_LINE_CLIP);
			if (line) out.userMessages.push({ turn: b.turn, firstLine: line });
		}
	}
	out.userMessages.sort((a, b) => a.turn - b.turn);

	return out;
}

/** Assemble a complete record from the extracted fields plus the event envelope (pure). */
export function buildIndexRecord(
	envelope: Omit<SeedIndexRecord, "v" | "kind" | keyof ExtractedIndex | "spans">,
	extracted: ExtractedIndex,
	spans: IndexSpan[],
): SeedIndexRecord {
	return { v: 3, kind: "fold-index", ...envelope, ...extracted, spans };
}

// ── extraction internals ─────────────────────────────────────────────────────

/** Bounded insertion-ordered dedup set for string values. */
class Dedup {
	private readonly seen = new Set<string>();
	private readonly list: string[] = [];
	constructor(private readonly cap: number) {}
	add(v: string): void {
		const t = v.trim();
		if (!t || this.seen.has(t) || this.list.length >= this.cap) return;
		this.seen.add(t);
		this.list.push(t);
	}
	values(): string[] {
		return this.list;
	}
}

/** Bounded insertion-ordered dedup set, keyed. First sighting wins (order and entry). */
class DedupKeyed<T> {
	private readonly seen = new Set<string>();
	private readonly list: T[] = [];
	constructor(private readonly cap: number, private readonly key: (v: T) => string) {}
	add(v: T): void {
		const k = this.key(v).trim();
		if (!k || this.seen.has(k) || this.list.length >= this.cap) return;
		this.seen.add(k);
		this.list.push(v);
	}
	values(): T[] {
		return this.list;
	}
}

// Path shapes: extension-bearing filenames anywhere, and slash-joined segments (abs or relative).
const FILE_EXT_RE =
	/\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|css|svelte|rs|py|go|java|rb|yml|yaml|toml|sh|env|log|conf|cfg|txt|sql|proto|lock|zig|c|h|cpp|hpp)\b/g;
const PATH_RE = /(?:^|[\s"'`(=])((?:\/|\.{1,2}\/|~\/)?[\w@.-]+(?:\/[\w.@-]+)+)/gm;

function harvestPaths(text: string, into: Dedup): void {
	for (const m of text.matchAll(PATH_RE)) into.add(m[1].replace(/[.,;:'"`)]+$/, ""));
	for (const m of text.matchAll(FILE_EXT_RE)) into.add(m[0]);
}

const DOLLAR_LINE_RE = /^\s*\$\s+(.+)$/gm;
const TOOL_CMD_RE =
	/\b(?:npm|npx|pnpm|yarn|bun|node|git|docker|kubectl|make|cargo|zig|go|python3?|pytest|deno|uv|gh|rg|fd|curl)\s+\S[^\n]{0,120}/g;

function harvestCommands(b: WireBlock, into: DedupKeyed<IndexedCommand>): void {
	for (const m of b.text.matchAll(DOLLAR_LINE_RE))
		into.add({ command: safeSlice(m[1], COMMAND_STORE_CLIP), turn: b.turn, code: foldCode(b.id) });
	for (const m of b.text.matchAll(TOOL_CMD_RE))
		into.add({ command: safeSlice(m[0].trim(), COMMAND_STORE_CLIP), turn: b.turn, code: foldCode(b.id) });
}

// Identifier shapes for lexical recovery: code symbols with an interior capital/underscore/digit,
// hex/uuid-ish tokens, dotted versions, and standalone numbers big enough to be load-bearing.
const SYMBOL_RE = /\b[A-Za-z_$][\w$]{3,}\b/g;
const HEXISH_RE = /\b(?:0x[0-9a-fA-F]{4,}|[0-9a-f]{8,}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/g;
const VERSION_RE = /\b\d+\.\d+(?:\.\d+)+[\w.-]*\b/g;
const NUMBER_RE = /\b\d{4,}\b/g;

const SYMBOL_STOPWORDS = new Set([
	"true", "false", "null", "undefined", "return", "const", "import", "export",
	"async", "await", "function", "string", "number", "boolean", "object", "array",
	"void", "never", "type", "interface", "class", "extends", "implements",
	"this", "self", "super", "new", "throw", "catch", "error", "from", "with",
]);

// A word marked by the error lexicon is already carried whole in `errors` — don't spend
// identifier slots re-listing "Error"/"FAILED" class tokens.
const ERROR_WORD_RE = new RegExp(`^${ERROR_MARKER_SOURCE}$`);

function harvestIdentifiers(blocks: WireBlock[]): string[] {
	// value → [length, insertion index]; final order = longer first, then first-seen.
	const seen = new Map<string, number>();
	let n = 0;
	const add = (tok: string): void => {
		if (!seen.has(tok)) seen.set(tok, n++);
	};
	for (const b of blocks) {
		for (const m of b.text.matchAll(HEXISH_RE)) add(m[0]);
		for (const m of b.text.matchAll(VERSION_RE)) add(m[0]);
		for (const m of b.text.matchAll(SYMBOL_RE)) {
			const tok = m[0];
			if (SYMBOL_STOPWORDS.has(tok.toLowerCase())) continue;
			if (!/[A-Z_$0-9]/.test(tok.slice(1))) continue; // plain lowercase word → not an identifier
			if (ERROR_WORD_RE.test(tok)) continue;
			add(tok);
		}
		for (const m of b.text.matchAll(NUMBER_RE)) add(m[0]);
	}
	return [...seen.entries()]
		.sort((a, b) => b[0].length - a[0].length || a[1] - b[1])
		.slice(0, MAX_IDENTIFIERS)
		.map(([v]) => v);
}
