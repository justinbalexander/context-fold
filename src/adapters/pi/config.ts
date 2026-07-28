/*
 * config.ts — CONTEXTFOLD_* env parsing for FoldConfig. Kept import-light (no Pi types) so
 * tests can exercise the parsing without loading the extension entry point.
 */
import type { FoldConfig } from "./store";

export function configFromEnv(): Partial<FoldConfig> {
	const cfg: Partial<FoldConfig> = {};
	const frac = Number(process.env.CONTEXTFOLD_BUDGET_FRACTION);
	if (Number.isFinite(frac) && frac > 0 && frac <= 1) cfg.budgetFraction = frac;
	const rawCap = process.env.CONTEXTFOLD_BUDGET_CAP;
	if (rawCap !== undefined) {
		const cap = rawCap === "off" ? 0 : Number(rawCap);
		if (Number.isFinite(cap) && cap >= 0) cfg.absoluteTokenCap = cap;
	}
	const tail = Number(process.env.CONTEXTFOLD_TAIL);
	if (Number.isFinite(tail) && tail >= 0) cfg.tailTarget = tail;
	if (process.env.CONTEXTFOLD_DEBUG === "1" || process.env.CONTEXTFOLD_DEBUG === "true") cfg.debug = true;
	return cfg;
}
