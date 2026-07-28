/*
 * retention.ts — spool GC: the retention policy the extension never had.
 *
 * The spool grows without bound on a 24/7 box (one dir per session, one envelope per fold;
 * nothing ever deletes). This sweep runs once per session at `session_start` and removes WHOLE
 * per-session spool directories whose newest file is older than the retention window.
 *
 * Directory granularity is what makes deletion safe: dedup aliases only ever point at sibling
 * envelopes in the SAME directory, so removing a whole dir can never dangle an alias. And the
 * missing-spool path already fails the right way — resume revalidation drops folds whose spool
 * vanished (they render raw), and a recall on a reaped code throws the typed SpoolError
 * (fail-explicit, D16). GC introduces no new failure mode; it just makes that path reachable
 * by age.
 *
 * The CURRENT session's dir is never touched, whatever its age. Everything here is fail-open:
 * an unreadable entry is kept, a failed delete is skipped — the sweep must never break a session
 * over housekeeping.
 */
import { readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

/** Default retention window: two weeks of resumability, bounded disk on a 24/7 box. */
export const SPOOL_RETAIN_DAYS_DEFAULT = 14;
const DAY_MS = 86_400_000;

/**
 * Resolve CONTEXTFOLD_SPOOL_RETAIN_DAYS to a retention window in ms. `0`/`off`/`false` disables
 * GC entirely (returns 0); unset or unparsable → the default.
 */
export function spoolRetainMsFromEnv(): number {
	const raw = process.env.CONTEXTFOLD_SPOOL_RETAIN_DAYS?.trim().toLowerCase();
	if (raw === "0" || raw === "off" || raw === "false") return 0;
	const n = Number(raw);
	const days = raw && Number.isFinite(n) && n > 0 ? n : SPOOL_RETAIN_DAYS_DEFAULT;
	return days * DAY_MS;
}

export interface SweepResult {
	/** Session ids whose spool dirs were deleted. */
	reaped: string[];
	/** Session spool dirs left in place (fresh, current, or unreadable-kept). */
	kept: number;
}

/**
 * Sweep `<spoolRoot>/<sessionId>/` dirs, deleting any (other than `keepSessionId`'s) whose
 * newest contained file is older than `retainMs`. Freshness is the newest file mtime inside the
 * dir — an actively-appended old session stays; an empty dir ages by its own mtime.
 */
export function sweepSpools(spoolRoot: string, keepSessionId: string, retainMs: number, now = Date.now()): SweepResult {
	const result: SweepResult = { reaped: [], kept: 0 };
	if (retainMs <= 0) return result;

	let entries: Dirent[];
	try {
		entries = readdirSync(spoolRoot, { withFileTypes: true });
	} catch {
		return result; // no spool yet — nothing to do
	}

	for (const ent of entries) {
		if (!ent.isDirectory()) continue;
		if (ent.name === keepSessionId) {
			result.kept++;
			continue;
		}
		const dir = join(spoolRoot, ent.name);
		try {
			let newest = statSync(dir).mtimeMs;
			for (const f of readdirSync(dir)) {
				try {
					const m = statSync(join(dir, f)).mtimeMs;
					if (m > newest) newest = m;
				} catch {
					// raced delete of one file — judge by what remains
				}
			}
			if (now - newest > retainMs) {
				rmSync(dir, { recursive: true, force: true });
				result.reaped.push(ent.name);
			} else {
				result.kept++;
			}
		} catch {
			result.kept++; // unreadable/undeletable → keep, never break the session over GC
		}
	}
	return result;
}
