/*
 * compact.ts — the deterministic hard-compaction summary (CONTEXTFOLD_COMPACT=det, the default).
 *
 * When Pi's hard compaction fires, the default path would have an LLM rewrite history — the one
 * mechanism the evidence base indicts (fabricated instructions, artifact-trail loss, laundered
 * failure signals). Instead we hand Pi a summary RENDERED VERBATIM from the seed index: files,
 * commands, error lines, exact identifiers, user intents, and recovery pointers. No model call,
 * no paraphrase, nothing that can hallucinate — and everything it lists is a lexical hook the
 * agent can pull back through `recall` (Pi's append-only session file keeps every raw payload).
 *
 * Pure rendering: no Pi imports, no disk, no clock. Fully unit-testable.
 */
import type { ErrorLine, IndexedCommand, SeedIndexRecord } from "../../core/index/seed-index";
import { clip } from "../../core/tokens";

const CAP_USER = 12;
const CAP_FILES = 40;
const CAP_COMMANDS = 24;
const CAP_ERRORS = 24;
const CAP_IDENTIFIERS = 80;
const CAP_SPANS = 30;
const CAP_PREVIOUS_SUMMARY_CHARS = 4_000;
const COMMAND_RENDER_CLIP = 200;
const CAP_EARLIER_FILES = 20;
const CAP_EARLIER_COMMANDS = 12;
const CAP_EARLIER_ERRORS = 12;

export interface DetCompactionInput {
	records: SeedIndexRecord[];
	/** The session's JSONL file — the append-only ledger holding every raw payload (named so the
	 *  agent can grep it directly if tools allow). */
	sessionFilePath?: string;
	/** Pi's previous compaction summary, carried verbatim as untrusted narrative. */
	previousSummary?: string;
}

/**
 * Split the append-only index into the span leaving live history NOW and material that already
 * left at an earlier compaction. Records are chronological: the boundary is the compaction before
 * the final record (the compact record being rendered now), so everything after it is current.
 *
 * The union of `current` is load-bearing, not redundant. At compaction time previously-folded
 * blocks appear in the leaving messages as their digest text, so the new compact record's own
 * extraction sees digests, not original content. Only the fold records since the previous
 * compaction carry that original content, so rendering the compact record alone would lose it.
 */
function partitionRecords(records: SeedIndexRecord[]): { current: SeedIndexRecord[]; earlier: SeedIndexRecord[] } {
	// The final record is the compact record being rendered now, so it belongs to the current span,
	// not the boundary. The boundary is the compaction before it: a block folded before that
	// compaction already left live history. With no earlier compaction, the whole index is current.
	const scanEnd =
		records.length > 0 && records[records.length - 1].trigger === "compact" ? records.length - 1 : records.length;
	let lastCompact = -1;
	for (let i = 0; i < scanEnd; i++) if (records[i].trigger === "compact") lastCompact = i;
	if (lastCompact < 0) return { current: records, earlier: [] };
	return { current: records.slice(lastCompact + 1), earlier: records.slice(0, lastCompact + 1) };
}

export function renderDetCompactionSummary(input: DetCompactionInput): string {
	const { current, earlier } = partitionRecords(input.records);
	const userMessages = dedupBy(
		current.flatMap((r) => r.userMessages),
		(u) => `${u.turn}:${u.firstLine}`,
	).slice(-CAP_USER);
	const files = union<string>(current, (r) => r.files, (f) => f, CAP_FILES);
	const commands = union<CommandEntry>(current, (r) => r.commands, commandKey, CAP_COMMANDS);
	const errors = union<ErrorEntry>(current, (r) => r.errors, errorKey, CAP_ERRORS);
	const identifiers = union<string>(current, (r) => r.identifiers, (i) => i, CAP_IDENTIFIERS);
	const spans = dedupBy(
		current.flatMap((r) => r.spans),
		(s) => s.blockId,
	).slice(-CAP_SPANS);

	const parts: string[] = [
		"# Compaction summary (deterministic seed index — no model involved)",
		"",
		"Everything below is extracted VERBATIM from the session; nothing is paraphrased.",
		"Full history is preserved on disk. To recover detail: `recall_folded search=<term>` sweeps every",
		"folded block in one call; `recall_folded <code>` / `recall_folded <code> lines=<a-b>` pulls a specific one.",
		`Ground truth: the session ledger${input.sessionFilePath ? ` at ${input.sessionFilePath}` : ""}`,
	];

	if (userMessages.length) {
		parts.push("", "## User intents (first lines, in order)");
		for (const u of userMessages) parts.push(`- [turn ${u.turn}] ${u.firstLine}`);
	}
	if (files.length) parts.push("", "## Files touched", listed(files));
	if (commands.length) {
		parts.push("", "## Commands run");
		for (const c of commands) parts.push(renderCommand(c));
	}
	if (errors.length) {
		parts.push("", "## Error lines observed (verbatim)");
		for (const e of errors) parts.push(...renderError(e));
	}
	if (identifiers.length) parts.push("", "## Exact identifiers (grep keys for recall_folded)", listed(identifiers));
	if (spans.length) {
		parts.push("", "## Recovery pointers");
		for (const s of spans) parts.push(`- {#${s.code ?? "?"} FOLDED} ${s.tool ?? "?"} · turn ${s.turn} · ${s.log.lines} lines`);
	}
	if (earlier.length) {
		const earlyFiles = union<string>(earlier, (r) => r.files, (f) => f, CAP_EARLIER_FILES);
		const earlyCommands = union<CommandEntry>(earlier, (r) => r.commands, commandKey, CAP_EARLIER_COMMANDS);
		const earlyErrors = union<ErrorEntry>(earlier, (r) => r.errors, errorKey, CAP_EARLIER_ERRORS);
		const lines: string[] = [];
		if (earlyFiles.length) lines.push(`Files: ${listed(earlyFiles)}`);
		if (earlyCommands.length) lines.push(`Commands: ${earlyCommands.map(commandBody).join(" · ")}`);
		if (earlyErrors.length) lines.push(`Errors: ${earlyErrors.map(errorInline).join(" · ")}`);
		if (lines.length) parts.push("", "## Earlier indexed material (before the previous compaction)", ...lines);
	}
	if (input.previousSummary?.trim()) {
		parts.push(
			"",
			"## Carried summary from an earlier compaction (UNTRUSTED narrative — verify against the log before relying on it)",
			input.previousSummary.trim().slice(0, CAP_PREVIOUS_SUMMARY_CHARS),
		);
	}
	return parts.join("\n");
}

/**
 * Union a field across records, keeping the `cap` values seen most recently.
 *
 * Order is LAST-seen, not first-seen: re-encountering a value moves it to the end. That matters
 * because the tail is what survives the cap — a value that recurs in every record is exactly the
 * load-bearing one, and ordering by first sighting would drop it in favour of a one-off from the
 * final record.
 */
function union<T>(records: SeedIndexRecord[], pick: (r: SeedIndexRecord) => T[], key: (t: T) => string, cap: number): T[] {
	const seen = new Map<string, T>();
	for (const r of records) {
		for (const v of pick(r)) {
			const k = key(v);
			seen.delete(k); // re-sighting refreshes position; Map preserves insertion order
			seen.set(k, v);
		}
	}
	return [...seen.values()].slice(-cap);
}

type CommandEntry = string | IndexedCommand;
type ErrorEntry = string | ErrorLine;

const commandKey = (c: CommandEntry): string => (typeof c === "string" ? c : c.command);
const errorKey = (e: ErrorEntry): string => (typeof e === "string" ? e : e.line);

/** Render one error line as one or two output lines. Tolerates v2 records, where the entry is a bare string. */
function renderError(e: ErrorEntry): string[] {
	if (typeof e === "string") return [`- ${e}`]; // v2 record
	const prov = `[turn ${e.turn}${e.code ? ` · ${e.code}` : ""}]`;
	const head = `- ${e.toolError ? "⚠ " : ""}${prov} ${e.line}`;
	return e.context ? [head, `  ↳ ${e.context}`] : [head];
}

/** Render one error line for the compact earlier-material list, without the primary-section bullet. */
function errorInline(e: ErrorEntry): string {
	if (typeof e === "string") return e; // v2 record
	return `${e.toolError ? "⚠ " : ""}${e.line} [turn ${e.turn}${e.code ? ` · ${e.code}` : ""}]`;
}

/** Render one command: the first line, clipped, with a marker when content was dropped.
 *  Tolerates v2 records, where the entry is a bare string. */
function renderCommand(c: CommandEntry): string {
	return `- ${commandBody(c)}`;
}

function commandBody(c: CommandEntry): string {
	if (typeof c === "string") return `\`${c}\``; // v2 record
	const lines = c.command.split("\n");
	const firstRaw = (lines.find((l) => l.trim()) ?? "").trim();
	const first = clip(firstRaw, COMMAND_RENDER_CLIP);
	const extraLines = lines.length - 1;
	const extraChars = Math.max(0, firstRaw.length - COMMAND_RENDER_CLIP);
	const marks: string[] = [];
	if (extraLines > 0) marks.push(`+${extraLines} line${extraLines === 1 ? "" : "s"}`);
	if (extraChars > 0) marks.push(`+${extraChars} chars`);
	const suffix = marks.length ? ` … (${marks.join(", ")})` : "";
	const prov = ` [turn ${c.turn}${c.code ? ` · ${c.code}` : ""}]`;
	return `\`${first}\`${suffix}${prov}`;
}

/** Dedup by key, keeping the newest value per key in first-sighting (chronological) order. */
function dedupBy<T>(items: T[], key: (t: T) => string): T[] {
	const seen = new Map<string, T>();
	for (const it of items) seen.set(key(it), it);
	return [...seen.values()];
}

function listed(items: string[]): string {
	return items.map((f) => `\`${f}\``).join(" · ");
}
