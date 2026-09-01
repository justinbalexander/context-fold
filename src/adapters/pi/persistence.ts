/*
 * persistence.ts — event-sourced fold state across restarts (DESIGN.md §6).
 *
 * Fold entries, agent unfolds, and committed frozen layers live in memory during a session, so
 * they are persisted as custom entries and replayed on resume. Legacy `kind:"spool"`/`kind:"gate"`
 * records (from sessions created before the spool's removal) degrade to fold entries without a
 * fold-time sha256: recall serves them from the ledger unverified and says so.
 *
 * Custom entries don't enter LLM context; they exist purely to reconstruct state (CustomEntry docs).
 */
import type { FoldEntry } from "../../core/fold-registry";

/** The customType tag for every context-fold state entry. */
export const FOLD_CUSTOM_TYPE = "contextfold.fold";

/** One committed prefix-stable layer: substitution BYTES are persisted verbatim, because a
 *  byte-exact head across resume is the whole point — recomputing digests after a code change
 *  would silently shift the cached prefix. Custom entries never enter LLM context, so the cost
 *  is disk only. */
export interface FrozenLayerRecord {
	seq: number;
	entries: { id: string; digestText: string }[];
}

/** One event on the fold ledger. `spool` and `gate` are legacy pre-redesign records whose entries
 * carried spool-file paths; only their ledger-relevant fields are restored. Unknown kinds are
 * ignored on restore. */
export type FoldRecord =
	| { kind: "fold"; entry: FoldEntry }
	| { kind: "spool"; entry: FoldEntry }
	| { kind: "gate"; entry: FoldEntry }
	| { kind: "unfold"; ids: string[] }
	| { kind: "layer"; layer: FrozenLayerRecord };

/** The subset of the pi API this module uses (kept minimal so it is trivially fakeable in tests). */
export interface EntryAppender {
	appendEntry(customType: string, data?: unknown): void;
}

/** The shape of a session entry we read back (CustomEntry: `{type,customType,data}`). */
export interface EntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/** Record the fold entry (ledger location + fold-time sha) for a newly folded block. */
export function recordFoldEntry(pi: EntryAppender, entry: FoldEntry): void {
	pi.appendEntry(FOLD_CUSTOM_TYPE, { kind: "fold", entry } satisfies FoldRecord);
}

/** Record that the agent unfolded one or more blocks (sticky across resume). */
export function recordUnfold(pi: EntryAppender, ids: string[]): void {
	if (ids.length) pi.appendEntry(FOLD_CUSTOM_TYPE, { kind: "unfold", ids } satisfies FoldRecord);
}

/** Record a committed prefix-stable layer (byte-exact resume). */
export function recordLayer(pi: EntryAppender, layer: FrozenLayerRecord): void {
	if (layer.entries.length) pi.appendEntry(FOLD_CUSTOM_TYPE, { kind: "layer", layer } satisfies FoldRecord);
}

/** Pick only the fields the registry knows from a persisted entry: a legacy record carries extra
 *  baggage (spoolPath, dedupOf, input) that must not ride back in, and its sha256 is absent —
 *  which is exactly how recall knows to report the block unverified. */
function toFoldEntry(raw: FoldEntry & { sha256?: unknown; fullOutputPath?: unknown }): FoldEntry {
	return {
		blockId: raw.blockId,
		code: raw.code,
		tool: raw.tool,
		isError: !!raw.isError,
		bytes: typeof raw.bytes === "number" ? raw.bytes : 0,
		...(typeof raw.sha256 === "string" ? { sha256: raw.sha256 } : {}),
		...(typeof raw.fullOutputPath === "string" ? { fullOutputPath: raw.fullOutputPath } : {}),
	};
}

/**
 * Left-fold the session's context-fold entries into the restored state: the latest fold entry per
 * block wins, and every unfolded id accumulates. Pure — no disk, deterministic in entry order.
 */
export function restoreFoldState(entries: EntryLike[]): {
	foldEntries: FoldEntry[];
	unfoldedIds: Set<string>;
	layers: FrozenLayerRecord[];
} {
	const byBlock = new Map<string, FoldEntry>();
	const unfoldedIds = new Set<string>();
	const layersBySeq = new Map<number, FrozenLayerRecord>();
	for (const e of entries) {
		if (e.customType !== FOLD_CUSTOM_TYPE) continue;
		const rec = e.data as FoldRecord | undefined;
		if (!rec || typeof rec !== "object") continue;
		if ((rec.kind === "fold" || rec.kind === "spool" || rec.kind === "gate") && rec.entry?.blockId)
			byBlock.set(rec.entry.blockId, toFoldEntry(rec.entry));
		else if (rec.kind === "unfold" && Array.isArray(rec.ids)) for (const id of rec.ids) unfoldedIds.add(id);
		else if (rec.kind === "layer" && rec.layer && typeof rec.layer.seq === "number" && Array.isArray(rec.layer.entries))
			layersBySeq.set(rec.layer.seq, rec.layer);
	}
	const layers = [...layersBySeq.values()].sort((a, b) => a.seq - b.seq);
	return { foldEntries: [...byBlock.values()], unfoldedIds, layers };
}
