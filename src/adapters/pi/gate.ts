/*
 * gate.ts — the L0 ingestion gate decision, run from Pi's `tool_result` hook.
 *
 * OBSERVE-ONLY: this never mutates the tool result. It looks at a result as it lands, decides
 * whether it is large enough to spool, and — if so — writes the raw payload to the spool and records
 * a born-folded entry in the gate registry. The session jsonl keeps the raw result verbatim (we
 * return nothing to the hook), so trace-mining and post-hoc debugging are unaffected. The actual
 * substitution (raw → pointer) happens later, view-only, in the `context` hook (store.ts).
 *
 * Fail-open: any error here degrades to "not folded" and the raw result flows through.
 */
import { estTokens, BLOCK_OVERHEAD } from "../../core/tokens";
import { foldCode, pointerDigestTokens, type PointerMeta } from "../../core/digest";
import { categorize } from "../../core/policy/ledger";
import type { GateRegistry } from "../../core/gate-registry";
import type { SpoolStore } from "./spool";

export interface GateConfig {
	/** Resolved from CONTEXTFOLD_L0 (+ per-model match). When false the gate is fully inert. */
	enabled: boolean;
	/** est-token fold threshold (CONTEXTFOLD_L0_THRESHOLD, default 2000). */
	threshold: number;
	/** Minimum pointer savings fraction to bother folding (CONTEXTFOLD_L0_MINSAVE, default 0.5). */
	minSave: number;
	/** Threshold multiplier for error-shaped results (CONTEXTFOLD_L0_ERRCAP, default 4). */
	errCap: number;
}

export const GATE_DEFAULTS = { threshold: 2000, minSave: 0.5, errCap: 4 } as const;

export interface GateModelDescriptor {
	id?: string;
	name?: string;
	provider?: string;
}

/**
 * Build the searchable identity used by a per-model allowlist. Dynamic provider aliases often
 * have an opaque id such as `current`; their human-readable name carries the actual backend model.
 * Include all three stable fields, so an allowlist entry still matches a provider whose id is an
 * opaque alias (`some-backend/current`) but whose name identifies the real checkpoint.
 */
export function gateModelIdentity(model: GateModelDescriptor | undefined): string | undefined {
	if (!model) return undefined;
	const identity = [model.provider, model.id, model.name]
		.map((part) => part?.trim())
		.filter((part): part is string => !!part)
		.join(" ");
	return identity || undefined;
}

/**
 * Resolve the ingestion-gate kill switch: unset/"0" → off; "1" → on for all models; a comma-separated list of
 * model-identity substrings → on iff the active provider/id/name identity matches one. Prior spools stay recallable
 * regardless (that path never consults this).
 */
export function resolveGateEnabled(env: string | undefined, modelIdentity: string | undefined): boolean {
	const v = env?.trim();
	if (!v || v === "0") return false;
	if (v === "1") return true;
	// Substring matching is CASE-INSENSITIVE (`qwen` must match `Qwen3.6-…`), and bare numeric
	// tokens are dropped: in a list like "1,qwen" the "1" is a stray flag, and as a substring it
	// would match nearly every model id ("gpt-5.1", "Qwen3.5-4B", …).
	const subs = v
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0 && !/^\d+$/.test(s));
	if (subs.length === 0) return false;
	if (!modelIdentity) return false;
	const id = modelIdentity.toLowerCase();
	return subs.some((s) => id.includes(s));
}

function numEnv(name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
	const n = Number(process.env[name]);
	if (!Number.isFinite(n)) return fallback;
	if (opts.min !== undefined && n < opts.min) return fallback;
	if (opts.max !== undefined && n > opts.max) return fallback;
	return n;
}

/** Read the gate config from the environment, resolving the kill switch against the active model. */
export function gateConfigFromEnv(modelId: string | undefined): GateConfig {
	return {
		enabled: resolveGateEnabled(process.env.CONTEXTFOLD_L0, modelId),
		threshold: numEnv("CONTEXTFOLD_L0_THRESHOLD", GATE_DEFAULTS.threshold, { min: 1 }),
		minSave: numEnv("CONTEXTFOLD_L0_MINSAVE", GATE_DEFAULTS.minSave, { min: 0, max: 1 }),
		errCap: numEnv("CONTEXTFOLD_L0_ERRCAP", GATE_DEFAULTS.errCap, { min: 1 }),
	};
}

/** The tool_result surface the gate observes (a subset of Pi's ToolResultEvent). */
export interface ToolResultObservation {
	toolName: string;
	toolCallId: string;
	input: unknown;
	isError: boolean;
	content: ReadonlyArray<{ type: string; text?: string }>;
	/** Bash results: the tool's own full-output file. */
	fullOutputPath?: string;
}

export type GateReason =
	| "folded"
	| "disabled"
	| "exempt-tool"
	| "non-text"
	| "empty"
	| "below-threshold"
	| "min-save"
	| "error";

export interface GateDecision {
	folded: boolean;
	reason: GateReason;
	/** Present when reason="error", so the adapter can surface persistent spool failures. */
	error?: string;
	code?: string;
	inTokens?: number;
	outTokens?: number;
	dedupOf?: string;
}

/** Tools whose output must never be gated — folding a recall/unfold would recurse. */
const EXEMPT_TOOLS = new Set(["recall", "unfold"]);

/**
 * The gate. Holds the resolved config, the registry it populates, and a lazy accessor for the
 * per-session spool store (so an inert gate never touches disk, and the session dir is resolved
 * only when a fold actually happens).
 */
export class Gate {
	constructor(
		private readonly cfg: GateConfig,
		private readonly registry: GateRegistry,
		private readonly getSpool: () => SpoolStore,
	) {}

	get enabled(): boolean {
		return this.cfg.enabled;
	}

	/** Decide and (on a fold) spool + register. Observe-only w.r.t. the tool result itself. */
	observe(o: ToolResultObservation): GateDecision {
		if (!this.cfg.enabled) return { folded: false, reason: "disabled" };
		if (EXEMPT_TOOLS.has(o.toolName)) return { folded: false, reason: "exempt-tool" };
		// A result carrying any non-text (image/binary) block passes through untouched — folding
		// a tool_result collapses ALL its content to one text block, which would drop the image.
		if (o.content.some((b) => b.type !== "text")) return { folded: false, reason: "non-text" };

		const text = o.content
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text as string)
			.join("\n");
		if (!text.trim()) return { folded: false, reason: "empty" };

		const inTokens = estTokens(text);
		// Error-shaped = the isError flag OR a lexical error hit. Error-shaped results get a much
		// higher threshold (errCap×) so a short error is never folded away.
		const errorShaped = o.isError || categorize(text).errors.length > 0;
		const threshold = errorShaped ? this.cfg.threshold * this.cfg.errCap : this.cfg.threshold;
		if (inTokens < threshold) return { folded: false, reason: "below-threshold", inTokens };

		const blockId = `r:${o.toolCallId}`;
		const code = foldCode(blockId);

		try {
			const spool = this.getSpool();
			// Project the pointer size for the MINSAVE guard (no disk write — pathFor is pure).
			const projMeta: PointerMeta = {
				code,
				tool: o.toolName,
				input: o.input,
				isError: o.isError,
				bytes: Buffer.byteLength(text, "utf8"),
				fullEstTokens: inTokens,
				spoolPath: spool.pathFor(code),
				fullOutputPath: o.fullOutputPath,
			};
			const outTokens = pointerDigestTokens(text, projMeta);
			// Skip folding unless the pointer saves ≥ minSave of the full weight (no negative folds).
			if (inTokens <= 0 || (inTokens - outTokens) / inTokens < this.cfg.minSave) {
				return { folded: false, reason: "min-save", inTokens, outTokens };
			}

			const res = spool.write({
				blockId,
				code,
				tool: o.toolName,
				input: o.input,
				isError: o.isError,
				content: text,
				fullOutputPath: o.fullOutputPath,
			});
			this.registry.set({
				blockId,
				code,
				fullTokens: inTokens + BLOCK_OVERHEAD,
				tool: o.toolName,
				input: o.input,
				isError: o.isError,
				bytes: res.envelope.bytes,
				fullEstTokens: res.envelope.estTokens,
				spoolPath: spool.pathFor(code),
				fullOutputPath: o.fullOutputPath,
				dedupOf: res.dedupOf,
			});
			return { folded: true, reason: "folded", code, inTokens, outTokens, dedupOf: res.dedupOf };
		} catch (err) {
			// Fail-open: a spool/registry error leaves the raw result untouched in the view.
			return { folded: false, reason: "error", inTokens, error: err instanceof Error ? err.message : String(err) };
		}
	}
}
