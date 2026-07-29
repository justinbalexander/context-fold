/*
 * config.ts — CONTEXTFOLD_* env parsing. Kept import-light (no Pi types) so tests can exercise
 * the parsing without loading the extension entry point.
 */
import type { FoldConfig } from "./store";
import { LADDER_DEFAULTS, type LadderConfig } from "../../core/policy/fold-ladder";

/** Which folding policy drives the session. `ladder` is the rebuild default; `keel` is the
 *  original continuous conductor, kept as a documented legacy/experimental path. */
export type FoldMode = "ladder" | "keel";

/** How the extension answers Pi's hard compaction (`session_before_compact`). */
export type CompactMode = "det" | "native";

export interface AdapterConfig {
	mode: FoldMode;
	ladder: LadderConfig;
	/** Reconstruction cost estimate for the reset yellow flag, in input-token equivalents. */
	reconTokens: number;
	compact: CompactMode;
}

export const ADAPTER_DEFAULTS: AdapterConfig = {
	mode: "ladder",
	ladder: LADDER_DEFAULTS,
	reconTokens: 18_000,
	compact: "det",
};

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
	const stable = process.env.CONTEXTFOLD_PREFIX_STABLE?.trim().toLowerCase();
	if (stable === "1" || stable === "true" || stable === "on") cfg.prefixStable = true;
	const layers = Number(process.env.CONTEXTFOLD_MAX_LAYERS);
	if (Number.isFinite(layers) && layers >= 0) cfg.maxLayers = Math.floor(layers);
	if (process.env.CONTEXTFOLD_DEBUG === "1" || process.env.CONTEXTFOLD_DEBUG === "true") cfg.debug = true;
	return cfg;
}

function fracEnv(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

export function adapterConfigFromEnv(): AdapterConfig {
	const rawMode = process.env.CONTEXTFOLD_MODE?.trim().toLowerCase();
	const mode: FoldMode = rawMode === "keel" ? "keel" : "ladder";
	const ladder: LadderConfig = {
		foldAt: fracEnv("CONTEXTFOLD_FOLD_AT", LADDER_DEFAULTS.foldAt),
		foldStep: fracEnv("CONTEXTFOLD_FOLD_STEP", LADDER_DEFAULTS.foldStep),
		coldFoldAt: fracEnv("CONTEXTFOLD_COLD_FOLD_AT", LADDER_DEFAULTS.coldFoldAt),
	};
	const recon = Number(process.env.CONTEXTFOLD_RECON_TOKENS);
	const reconTokens = Number.isFinite(recon) && recon > 0 ? Math.floor(recon) : ADAPTER_DEFAULTS.reconTokens;
	const compact: CompactMode = process.env.CONTEXTFOLD_COMPACT?.trim().toLowerCase() === "native" ? "native" : "det";
	return { mode, ladder, reconTokens, compact };
}
