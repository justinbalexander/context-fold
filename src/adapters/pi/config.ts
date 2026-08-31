/*
 * config.ts — the knob table and CONTEXTFOLD_* resolution. Kept import-light (no Pi types) so
 * tests can exercise the parsing without loading the extension entry point.
 *
 * Every user-facing setting is one KnobSpec row: its env var, its saved-settings key, its
 * validation, and its default all live here, so the env parser, the settings file, and the
 * /context-fold config menu cannot drift apart. Precedence per knob: default < saved file < env.
 */
import type { FoldConfig } from "./store";
import { LADDER_DEFAULTS, type LadderConfig } from "../../core/policy/fold-ladder";

/** How the extension answers Pi's hard compaction (`session_before_compact`). */
export type CompactMode = "det" | "native";

export type KnobValue = number | CompactMode;

/** Settings persisted by the /context-fold config menu (same keys in the JSON file). */
export interface SavedSettings {
	foldAt?: number;
	foldStep?: number;
	coldFoldAt?: number;
	budgetFraction?: number;
	budgetCap?: number;
	tail?: number;
	compact?: CompactMode;
	reconTokens?: number;
	spoolRetainDays?: number;
}

export type KnobKey = keyof SavedSettings;

export interface KnobSpec {
	readonly key: KnobKey;
	readonly env: string;
	readonly label: string;
	/** One-line meaning shown in the menu's edit prompt. */
	readonly hint: string;
	readonly def: KnobValue;
	/** Present → the menu offers a pick list instead of free numeric input. */
	readonly choices?: readonly string[];
	/** False → a change only takes effect at the next session start. */
	readonly live: boolean;
	parse(raw: string): KnobValue | undefined;
	format(v: KnobValue): string;
}

const fraction = (raw: string): number | undefined => {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined;
};
const nonNegative = (raw: string): number | undefined => {
	if (raw === "") return undefined; // Number("") is 0, and blank is not a spelling of zero
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const plain = (v: KnobValue): string => String(v);
const offOrNumber = (v: KnobValue): string => (v === 0 ? "off" : String(v));

export const KNOBS: readonly KnobSpec[] = [
	{
		key: "foldAt",
		env: "CONTEXTFOLD_FOLD_AT",
		label: "Fold threshold",
		hint: "first fold when usage reaches this fraction of the context window (0–1]",
		def: LADDER_DEFAULTS.foldAt,
		live: true,
		parse: fraction,
		format: plain,
	},
	{
		key: "foldStep",
		env: "CONTEXTFOLD_FOLD_STEP",
		label: "Fold step",
		hint: "a fold event must save at least this fraction of the window (0–1]",
		def: LADDER_DEFAULTS.foldStep,
		live: true,
		parse: fraction,
		format: plain,
	},
	{
		key: "coldFoldAt",
		env: "CONTEXTFOLD_COLD_FOLD_AT",
		label: "Cold fold threshold",
		hint: "first-fold threshold when no live cache read has been observed (0–1]",
		def: LADDER_DEFAULTS.coldFoldAt,
		live: true,
		parse: fraction,
		format: plain,
	},
	{
		key: "budgetFraction",
		env: "CONTEXTFOLD_BUDGET_FRACTION",
		label: "Budget fraction",
		hint: "fold down toward this fraction of the context window (0–1]",
		def: 0.75,
		live: true,
		parse: fraction,
		format: plain,
	},
	{
		key: "budgetCap",
		env: "CONTEXTFOLD_BUDGET_CAP",
		label: "Budget cap",
		hint: "absolute token ceiling on the budget; 'off' or 0 disables",
		def: 200_000,
		live: true,
		parse: (raw) => (raw === "off" ? 0 : nonNegative(raw)),
		format: offOrNumber,
	},
	{
		key: "tail",
		env: "CONTEXTFOLD_TAIL",
		label: "Protected tail",
		hint: "the newest ~N tokens never fold (clamped to half the budget)",
		def: 20_000,
		live: true,
		parse: nonNegative,
		format: plain,
	},
	{
		key: "compact",
		env: "CONTEXTFOLD_COMPACT",
		label: "Hard compaction",
		hint: "det = deterministic seed-index summary; native = Pi's stock LLM summary",
		def: "det",
		choices: ["det", "native"],
		live: true,
		parse: (raw) => {
			const m = raw.toLowerCase();
			return m === "det" || m === "native" ? m : undefined;
		},
		format: plain,
	},
	{
		key: "reconTokens",
		env: "CONTEXTFOLD_RECON_TOKENS",
		label: "Reconstruction estimate",
		hint: "input-token cost assumed for rebuilding context after /new (reset flag)",
		def: 18_000,
		live: true,
		parse: (raw) => {
			const n = Number(raw);
			return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
		},
		format: plain,
	},
	{
		key: "spoolRetainDays",
		env: "CONTEXTFOLD_SPOOL_RETAIN_DAYS",
		label: "Spool retention",
		hint: "days before session-start GC deletes old spools; 'off' or 0 keeps forever",
		def: 1,
		live: false,
		parse: (raw) => {
			const m = raw.toLowerCase();
			if (m === "0" || m === "off" || m === "false") return 0;
			const n = Number(m);
			return Number.isFinite(n) && n > 0 ? n : undefined;
		},
		format: offOrNumber,
	},
];

export function knob(key: KnobKey): KnobSpec {
	const spec = KNOBS.find((s) => s.key === key);
	if (!spec) throw new Error(`unknown knob: ${key}`);
	return spec;
}

export type KnobSource = "default" | "saved" | "env";

export interface ResolvedKnob {
	value: KnobValue;
	source: KnobSource;
}

/** Effective value for one knob: env (when set and valid) over saved file over default. */
export function resolveKnob(spec: KnobSpec, saved: SavedSettings = {}): ResolvedKnob {
	const raw = process.env[spec.env];
	if (raw !== undefined) {
		const v = spec.parse(raw.trim());
		if (v !== undefined) return { value: v, source: "env" };
	}
	const s = saved[spec.key];
	if (s !== undefined) return { value: s, source: "saved" };
	return { value: spec.def, source: "default" };
}

/**
 * Revalidate a settings-file payload with the same rules as env parsing; unknown keys and
 * invalid values are dropped silently (fail-open — a hand-edited file never breaks a session).
 */
export function parseSavedSettings(json: unknown): SavedSettings {
	if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
	const out: Record<string, KnobValue> = {};
	for (const spec of KNOBS) {
		const v = (json as Record<string, unknown>)[spec.key];
		if (typeof v !== "string" && typeof v !== "number") continue;
		const parsed = spec.parse(String(v).trim());
		if (parsed !== undefined) out[spec.key] = parsed;
	}
	return out as SavedSettings;
}

/** How the extension answers Pi's hard compaction, plus the other adapter-level settings. */
export interface AdapterConfig {
	ladder: LadderConfig;
	/** Reconstruction cost estimate for the reset yellow flag, in input-token equivalents. */
	reconTokens: number;
	compact: CompactMode;
}

export const ADAPTER_DEFAULTS: AdapterConfig = {
	ladder: LADDER_DEFAULTS,
	reconTokens: 18_000,
	compact: "det",
};

export function configFromEnv(saved: SavedSettings = {}): Partial<FoldConfig> {
	const cfg: Partial<FoldConfig> = {};
	const frac = resolveKnob(knob("budgetFraction"), saved);
	if (frac.source !== "default") cfg.budgetFraction = frac.value as number;
	const cap = resolveKnob(knob("budgetCap"), saved);
	if (cap.source !== "default") cfg.absoluteTokenCap = cap.value as number;
	const tail = resolveKnob(knob("tail"), saved);
	if (tail.source !== "default") cfg.tailTarget = tail.value as number;
	if (process.env.CONTEXTFOLD_DEBUG === "1" || process.env.CONTEXTFOLD_DEBUG === "true") cfg.debug = true;
	return cfg;
}

export function adapterConfigFromEnv(saved: SavedSettings = {}): AdapterConfig {
	const ladder: LadderConfig = {
		foldAt: resolveKnob(knob("foldAt"), saved).value as number,
		foldStep: resolveKnob(knob("foldStep"), saved).value as number,
		coldFoldAt: resolveKnob(knob("coldFoldAt"), saved).value as number,
	};
	const reconTokens = resolveKnob(knob("reconTokens"), saved).value as number;
	const compact = resolveKnob(knob("compact"), saved).value as CompactMode;
	return { ladder, reconTokens, compact };
}
