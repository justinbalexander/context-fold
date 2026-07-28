/*
 * persistence.ts — event-sourced fold state across restarts (DESIGN.md §6).
 *
 * The gate's cross-turn state — which tool results are born-folded, and which folds the agent has
 * unfolded — lives only in memory during a session. Keel's own L2/L3 folds are re-derived from the
 * view every turn, so they need nothing here; but a born-folded block is registered from the
 * `tool_result` hook, which does NOT re-fire on resume (the result is already in history, not
 * re-executed). So we persist the gate registry and unfold decisions as custom session entries and
 * left-fold them back on load — the pi-blackhole `foldLedger` pattern.
 *
 * Custom entries don't enter LLM context; they exist purely to reconstruct state (CustomEntry docs).
 */
import { readEnvelopeAt, SpoolError } from "./spool";
import type { GateEntry } from "../../core/gate-registry";

/** The customType tag for every context-fold state entry. */
export const FOLD_CUSTOM_TYPE = "contextfold.fold";

/** One event on the fold ledger. `gate` = a born-fold happened; `unfold` = the agent expanded folds. */
export type FoldRecord = { kind: "gate"; entry: GateEntry } | { kind: "unfold"; ids: string[] };

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

/** Record that a tool result was born-folded (so it can be restored on resume). */
export function recordGateFold(pi: EntryAppender, entry: GateEntry): void {
	pi.appendEntry(FOLD_CUSTOM_TYPE, { kind: "gate", entry } satisfies FoldRecord);
}

/** Record that the agent unfolded one or more blocks (sticky across resume). */
export function recordUnfold(pi: EntryAppender, ids: string[]): void {
	if (ids.length) pi.appendEntry(FOLD_CUSTOM_TYPE, { kind: "unfold", ids } satisfies FoldRecord);
}

/**
 * Left-fold the session's context-fold entries into the restored state: the latest gate entry per
 * block wins, and every unfolded id accumulates. Pure — no disk, deterministic in entry order.
 */
export function restoreFoldState(entries: EntryLike[]): { gateEntries: GateEntry[]; unfoldedIds: Set<string> } {
	const byBlock = new Map<string, GateEntry>();
	const unfoldedIds = new Set<string>();
	for (const e of entries) {
		if (e.customType !== FOLD_CUSTOM_TYPE) continue;
		const rec = e.data as FoldRecord | undefined;
		if (!rec || typeof rec !== "object") continue;
		if (rec.kind === "gate" && rec.entry?.blockId) byBlock.set(rec.entry.blockId, rec.entry);
		else if (rec.kind === "unfold" && Array.isArray(rec.ids)) for (const id of rec.ids) unfoldedIds.add(id);
	}
	return { gateEntries: [...byBlock.values()], unfoldedIds };
}

/**
 * Revalidate restored gate entries against their spool files (D16): a fold whose spool is missing or
 * corrupt is DROPPED from the registry — the block then renders raw (safe degradation) rather than
 * showing a pointer that can't resolve. Returns the survivors and a report of what was dropped.
 */
export function revalidateSpools(entries: GateEntry[]): {
	valid: GateEntry[];
	dropped: { code: string; path: string; reason: string }[];
} {
	const valid: GateEntry[] = [];
	const dropped: { code: string; path: string; reason: string }[] = [];
	for (const e of entries) {
		try {
			readEnvelopeAt(e.spoolPath);
			valid.push(e);
		} catch (err) {
			dropped.push({ code: e.code, path: e.spoolPath, reason: err instanceof SpoolError ? err.message : String(err) });
		}
	}
	return { valid, dropped };
}
