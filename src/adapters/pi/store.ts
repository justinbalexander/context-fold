/*
 * store.ts — the headless host/store glue for the Pi adapter.
 *
 * This is the small piece Accordion did in Svelte, reduced to plain functions (port spec
 * §"Minimal headless core to reimplement"): hold blocks, compute `protectedFromIndex`, build the
 * `ConductorView`, call `conduct`, lower `Command[]` → `FoldOp[]`/`GroupOp[]`, call `applyPlan`.
 *
 * It owns the only mutable session state in Phase 1: the set of agent-unfolded block ids (sticky
 * "held" — protected from re-folding) and a per-turn snapshot of the linearized blocks (so the
 * unfold/recall tool can resolve a fold-code back to its block). No durable ledger this phase.
 */
import type { Command, ConductorHost, ConductorView, HostCapabilityId, JSONValue, ViewBlock } from "../../core/contract";
import type { Conductor } from "../../core/contract";
import type { AgentMessage, FoldOp, WireBlock } from "../../core/block";
import { linearize, isDurableId, wireToBlock } from "../../core/block";
import { applyPlan } from "../../core/apply";
import { digest, wireFoldable, foldCode, foldTag, pointerDigest, substTokens, type PointerMeta } from "../../core/digest";
import { estTokens, safeSlice, BLOCK_OVERHEAD } from "../../core/tokens";
import { MapGateRegistry, type GateRegistry, type GateEntry } from "../../core/gate-registry";
import { readEnvelopeAt, SpoolError } from "./spool";
import { readFileSync } from "node:fs";

/** The newest block is always protected (target>0); adding an older block may not overflow this. */
const PROTECT_OVERFLOW_CAP = 1.25;

const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface FoldConfig {
	/** Fraction of the context window to fold down toward (the policy's `budget`). */
	budgetFraction: number;
	/**
	 * Absolute token ceiling on the fold budget regardless of context window; 0 disables.
	 * Attention lossiness is absolute, not window-relative: a 1M-window model does not read
	 * token 600k any better than a 272k one, so the budget is min(cap, fraction × window).
	 */
	absoluteTokenCap: number;
	/** Protected-tail token target — the newest ~N tokens are never folded. */
	tailTarget: number;
	/** Fallback context window when the host can't report one. */
	defaultContextWindow: number;
	/**
	 * Consolidation bound on committed layers: a commit that would exceed this merges all layer
	 * RECORDS into one (bookkeeping only — digest bytes are unchanged, so the warm prefix is
	 * preserved for free). 0 disables the bound.
	 */
	maxLayers: number;
	/** Emit a one-line fold summary to stderr each turn. */
	debug: boolean;
}

export const DEFAULT_CONFIG: FoldConfig = {
	budgetFraction: 0.75,
	absoluteTokenCap: 200_000,
	tailTarget: 20_000,
	defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
	maxLayers: 2,
	debug: false,
};

/** What the engine reports after committing a fold event's frozen layer (index emission seam). */
export interface FoldEventReport {
	/** The committed layer's seq (post-consolidation when a merge fired). */
	seq: number;
	/** Why the policy folded (ladder: "threshold" | "cap"; consolidation merges report separately). */
	trigger: "threshold" | "cap" | "consolidation";
	/** Ids masked by THIS event (empty for a pure consolidation merge). */
	maskedIds: string[];
	/** Every block in this turn's view, full content — the extractor's span input. */
	blocks: WireBlock[];
	usage: { tokens: number; contextWindow: number; fraction: number };
}

/** One committed prefix-stable layer (persisted verbatim; see persistence.ts). */
export interface FrozenLayer {
	seq: number;
	entries: { id: string; digestText: string }[];
}

/** Host context accounting. `tokens` is provider-anchored when Pi has a valid prior response. */
export interface ContextFrame {
	contextWindow: number | null;
	tokens: number | null;
}

type ContextFrameInput = number | null | ContextFrame;

function normalizeContextFrame(input: ContextFrameInput): ContextFrame {
	return typeof input === "number" || input === null
		? { contextWindow: input, tokens: null }
		: input;
}

/** Walk back from the newest block, protecting the newest ~`target` tokens (≤1.25× overflow cap). */
export function protectedFromIndex(blocks: { tokens: number }[], target: number): number {
	const n = blocks.length;
	if (n === 0) return 0;
	if (target === 0) return n; // protection off, all foldable
	const cap = target * PROTECT_OVERFLOW_CAP;
	let sum = blocks[n - 1].tokens; // newest block ALWAYS protected if target>0
	if (sum >= target) return n - 1;
	for (let i = n - 2; i >= 0; i--) {
		const next = sum + blocks[i].tokens;
		if (next > cap) return i + 1; // adding this older block overflows the cap
		sum = next;
		if (sum >= target) return i;
	}
	return 0;
}

/** One recall/unfold match: a fold-code resolved to one or more blocks. */
export interface CodeMatch {
	code: string;
	label: string;
	ids: string[];
	text: string;
	/** A recall-side note (dedup origin, slice/truncation nudge). */
	note?: string;
}

/** A recall failure that names the offending spool path (D16), surfaced to the agent, never thrown. */
export interface CodeError {
	code: string;
	message: string;
}

/** Partial-retrieval options for L0 recall (ignored for in-memory folds). */
export interface RecallOptions {
	/** Return only lines matching this term (case-insensitive substring), with line numbers. */
	grep?: string;
	/** Return only lines in this 1-based inclusive range, e.g. "40-80". */
	lines?: string;
}

/** Cap a recall slice to roughly the pointer budget before nudging the agent to narrow the query. */
const RECALL_SLICE_TOKEN_CAP = 500;
/** Cap a cross-fold search sweep (span recall) — generous enough to cover many pointers at once,
 *  small enough that one sweep can't re-flood what folding saved. */
const SEARCH_TOKEN_CAP = 1000;

/** One folded block's hits from a cross-fold search sweep. */
export interface SearchHit {
	code: string;
	label: string;
	/** Matching lines, `<lineNo>: <text>` numbered against the block's full content. */
	lines: string[];
}
/**
 * Cap on a WHOLE-result recall (no grep/lines). Matches the gate's default fold threshold: recall
 * never hands back more warm tokens than the gate would have let through unfolded, so one recall
 * call can't re-flood the context the gate just saved (DESIGN §6a's partial-retrieval promise).
 */
const RECALL_WHOLE_TOKEN_CAP = 2000;

export class ContextFoldEngine {
	private readonly cfg: FoldConfig;
	private readonly policy: Conductor;

	/** Agent-unfolded block ids — held (protected from re-folding) for the rest of the session. */
	private readonly unfolded = new Set<string>();
	/** Per-turn snapshot: durable id → wire block (full content), for the unfold/recall tool. */
	private snapshot = new Map<string, WireBlock>();
	/** Cross-turn deterministic digest cache (id + text length → digest/tokens). linearize recreates
	 *  block objects every turn, so the WeakMap caches in digest.ts never hit across turns — without
	 *  this the full risk-line regex sweep re-runs over every foldable block on every model call. */
	private readonly detCache = new Map<string, { len: number; digest: string; tokens: number }>();
	/** L0 pointer substitution on/off for the ACTIVE model (the adapter re-resolves the CONTEXTFOLD_L0
	 *  allowlist each turn). Restored gate entries stay recallable regardless — this only gates the
	 *  view substitution, so turning the kill switch off renders prior folds raw again (D20). */
	private gateActive = true;
	/** Last status the policy published (display-only). */
	private lastStatus: { text: string | null; metrics?: Record<string, number | string | boolean>; details?: JSONValue } | null = null;

	private readonly host: ConductorHost;

	// ── L0 ingestion gate: registry of born-folded blocks (recall reads the spool by entry path) ──
	private readonly gate: GateRegistry;

	// ── recall-churn accounting (display-only; feeds the reset yellow flag) ──────────────────────
	/** Total recall/search tool invocations this session. */
	private recallCallCount = 0;
	/** Per-code recall counts — a code recalled again and again is the measured churn signature. */
	private readonly recallByCode = new Map<string, number>();

	// ── Stage 2: prefix-stable frozen layers ─────────────────────────────────────────────────────
	/** Committed layers, oldest first. Substitution bytes are fixed; unfold masks per id at render. */
	private frozenLayers: FrozenLayer[] = [];
	/** Derived id → frozen digestText (rebuilt on commit/break/restore). */
	private frozenById = new Map<string, string>();
	/** Adapter callback: persist a committed layer (event-sourced, like gate folds). */
	onLayerCommit: ((layer: FrozenLayer) => void) | null = null;
	/** Adapter callback: persist a consolidation break. */
	onLayerBreak: ((seq: number) => void) | null = null;
	/** Adapter callback: a fold event committed — emit the seed index (spool + JSONL). */
	onFoldEvent: ((event: FoldEventReport) => void) | null = null;

	constructor(policy: Conductor, cfg: Partial<FoldConfig> = {}, gate: GateRegistry = new MapGateRegistry()) {
		this.cfg = { ...DEFAULT_CONFIG, ...cfg };
		this.policy = policy;
		this.gate = gate;
		this.host = {
			can: (c: HostCapabilityId) => c === "countTokens",
			countTokens: (text: string) => estTokens(text),
			digestOf: (id: string) => {
				const b = this.snapshot.get(id);
				return b ? this.detDigest(b) : null;
			},
			setStatus: (text, metrics, details) => {
				this.lastStatus = { text, metrics, details };
			},
			requestRerun: () => {
				/* Phase 1 is fully synchronous — no async rerun. */
			},
		};
		this.policy.attach?.(this.host);
	}

	get status() {
		return this.lastStatus;
	}

	/** The gate registry — the adapter's tool_result handler registers born-folded blocks here. */
	get gateRegistry(): GateRegistry {
		return this.gate;
	}

	/** Enable/disable L0 pointer substitution (the adapter resolves the per-model kill switch). */
	setGateActive(active: boolean): void {
		this.gateActive = active;
	}

	/** Reset per-session state (session switch in one process): unfolds and per-block caches. */
	resetForSession(): void {
		this.recallCallCount = 0;
		this.recallByCode.clear();
		this.unfolded.clear();
		this.snapshot = new Map();
		this.detCache.clear();
		this.frozenLayers = [];
		this.frozenById = new Map();
	}

	/** Restore committed layers on session resume (event-sourced; bytes verbatim). */
	restoreLayers(layers: FrozenLayer[]): void {
		this.frozenLayers = [...layers].sort((a, b) => a.seq - b.seq);
		this.rebuildFrozenIndex();
	}

	private rebuildFrozenIndex(): void {
		this.frozenById = new Map();
		for (const layer of this.frozenLayers) for (const e of layer.entries) this.frozenById.set(e.id, e.digestText);
	}

	/** Frozen substitutions for blocks present this turn (skipping agent unfolds — an unfold is a
	 *  deliberate single-point prefix break and the block stays held, never re-frozen). */
	private computeFrozenOps(blocks: WireBlock[]): Map<string, string> {
		const out = new Map<string, string>();
		if (this.frozenById.size === 0) return out;
		for (const b of blocks) {
			const digestText = this.frozenById.get(b.id);
			if (digestText === undefined || this.unfolded.has(b.id)) continue;
			out.set(b.id, digestText);
		}
		return out;
	}

	/**
	 * The per-turn pipeline. Takes the outgoing message array (a deep copy pi already made) and the
	 * host-reported context window; returns the rewritten array to send. Pure with respect to the
	 * input (applyPlan clones touched messages); mutates only this engine's instance memory.
	 */
	process(messages: AgentMessage[], context: ContextFrameInput): AgentMessage[] {
		const blocks = linearize(messages);
		// Refresh the snapshot for the unfold/recall tool (full content — folding never mutates it).
		this.snapshot = new Map(blocks.map((b) => [b.id, b] as const));
		this.pruneCaches(blocks);

		// ── L0 GATE: born-folded pointers ────────────────────────────────────────
		// Registered blocks enter the view already folded to a pointer digest (unless the agent has
		// unfolded them). These ops apply EVERY turn regardless of budget pressure — the whole point of
		// the gate is that a flood never reaches full-fidelity context in the first place.
		const gatePointers = this.computeGatePointers(blocks);
		const frame = normalizeContextFrame(context);

		const frozenOps = this.computeFrozenOps(blocks);
		const { cw, budget, tailTarget, protectFrom } = this.frame(blocks, frame.contextWindow, gatePointers, frozenOps);
		const view = this.buildView(blocks, protectFrom, budget, cw, tailTarget, gatePointers, frozenOps, frame.tokens);

		const cmds = this.policy.conduct(view);

		const ops: FoldOp[] = cmds != null && cmds.length > 0 ? this.lower(cmds, blocks, protectFrom) : [];

		// Commit this fold event's substitutions as a new frozen layer.
		if (ops.length > 0) {
			const entries = ops
				.filter((op) => !gatePointers.has(op.id) && !this.frozenById.has(op.id))
				.map((op) => ({ id: op.id, digestText: op.digestText }));
			if (entries.length > 0) {
				const layer: FrozenLayer = { seq: (this.frozenLayers[this.frozenLayers.length - 1]?.seq ?? 0) + 1, entries };
				this.frozenLayers.push(layer);
				for (const e of entries) this.frozenById.set(e.id, e.digestText);
				this.onLayerCommit?.(layer);
				if (this.cfg.debug)
					process.stderr.write(`[context-fold] layer ${layer.seq} committed (${entries.length} blocks frozen)\n`);

				// Fold-event report → the adapter emits the seed index for what just left the view.
				const usage = {
					tokens: frame.tokens ?? view.liveTokens,
					contextWindow: cw,
					fraction: cw > 0 ? (frame.tokens ?? view.liveTokens) / cw : 0,
				};
				const rawTrigger = this.lastStatus?.metrics?.trigger;
				const trigger = rawTrigger === "cap" ? "cap" : "threshold";
				this.onFoldEvent?.({ seq: layer.seq, trigger, maskedIds: entries.map((e) => e.id), blocks, usage });

				// Consolidation bound: too many layer records → merge them into ONE record under the
				// newest seq. Digest bytes are untouched (the warm prefix survives); only the
				// bookkeeping collapses. Event-sourced as breaks + a re-commit (latest seq wins).
				if (this.cfg.maxLayers > 0 && this.frozenLayers.length > this.cfg.maxLayers) {
					const merged: FrozenLayer = {
						seq: layer.seq,
						entries: this.frozenLayers.flatMap((l) => l.entries),
					};
					for (const l of this.frozenLayers) if (l.seq !== merged.seq) this.onLayerBreak?.(l.seq);
					this.frozenLayers = [merged];
					this.rebuildFrozenIndex();
					this.onLayerCommit?.(merged);
					this.onFoldEvent?.({ seq: merged.seq, trigger: "consolidation", maskedIds: [], blocks, usage });
					if (this.cfg.debug)
						process.stderr.write(
							`[context-fold] consolidation merge: ${merged.entries.length} frozen blocks now one layer (seq ${merged.seq})\n`,
						);
				}
			}
		}

		// Merge order = gate > frozen > policy: the gate owns its ids outright; a frozen id's bytes
		// outrank any late policy op for it (defense in depth — candidates already exclude frozen).
		const allOps = mergeOpsById(gatePointers, mergeOpsById(frozenOps, ops));
		if (allOps.length === 0) return messages; // nothing to fold → send unchanged

		if (this.cfg.debug) {
			const l0 = gatePointers.size ? ` l0=${gatePointers.size}` : "";
			const fz = frozenOps.size ? ` frozen=${frozenOps.size}` : "";
			process.stderr.write(
				`[context-fold] ${ops.length} folds${l0}${fz}, live=${view.liveTokens} budget=${budget} ${this.lastStatus?.text ?? ""}\n`,
			);
		}

		return applyPlan(messages, allOps);
	}

	/** Born-folded pointer text per registered block id (skipping any the agent has unfolded).
	 *  Empty when the kill switch is off for the active model (D20) — restored entries then render
	 *  raw from history while staying recallable through the registry. */
	private computeGatePointers(blocks: WireBlock[]): Map<string, string> {
		const out = new Map<string, string>();
		if (!this.gateActive || this.gate.size === 0) return out;
		for (const b of blocks) {
			const e = this.gate.get(b.id);
			if (!e || this.unfolded.has(b.id)) continue;
			// A FROZEN id renders its committed layer bytes, not a pointer: ladder-masked blocks are
			// registered (spool-backed recall must survive hard compaction), but their in-view form is
			// owned by the frozen layer — swapping in a pointer here would silently move frozen bytes.
			if (this.frozenById.has(b.id)) continue;
			out.set(b.id, pointerDigest(b.text, pointerMetaOf(e)));
		}
		return out;
	}

	/** Inspection seam (tests/debug): the ConductorView this turn, incl. born-folded accounting. */
	viewFor(messages: AgentMessage[], context: ContextFrameInput): ConductorView {
		const blocks = linearize(messages);
		const gatePointers = this.computeGatePointers(blocks);
		const frozenOps = this.computeFrozenOps(blocks);
		const frame = normalizeContextFrame(context);
		const { cw, budget, tailTarget, protectFrom } = this.frame(blocks, frame.contextWindow, gatePointers, frozenOps);
		return this.buildView(blocks, protectFrom, budget, cw, tailTarget, gatePointers, frozenOps, frame.tokens);
	}

	/**
	 * Per-turn budget frame. The tail target is CLAMPED to half the budget — an unclamped default
	 * (20k) against a small context window would protect everything and permanently disable folding.
	 * Protection walks RENDERED weights: a born-folded block occupies only its pointer's tokens, so
	 * it must not absorb the tail allowance at full weight.
	 */
	private frame(
		blocks: WireBlock[],
		contextWindow: number | null,
		gatePointers: Map<string, string>,
		frozenOps: Map<string, string> = new Map(),
	): { cw: number; budget: number; tailTarget: number; protectFrom: number } {
		const cw = contextWindow ?? this.cfg.defaultContextWindow;
		const cap = this.cfg.absoluteTokenCap > 0 ? this.cfg.absoluteTokenCap : Infinity;
		const budget = Math.min(cap, Math.floor(cw * this.cfg.budgetFraction));
		const tailTarget = Math.min(this.cfg.tailTarget, Math.floor(budget / 2));
		const rendered = blocks.map((b) => {
			const p = gatePointers.get(b.id) ?? frozenOps.get(b.id);
			return { tokens: p !== undefined ? substTokens(p) : b.tokens };
		});
		return { cw, budget, tailTarget, protectFrom: protectedFromIndex(rendered, tailTarget) };
	}

	/**
	 * Resolve fold-codes → ORIGINAL content (recall: read-only, no fold-state change). L0 (gate)
	 * codes are served from the SPOOL — whole, or sliced by `grep`/`lines` (partial retrieval, so
	 * recall never has to dump a whole flood back into context). A missing/corrupt spool becomes a
	 * D16 error naming the path, surfaced to the agent rather than thrown. Non-gate folds (Keel L2/L3)
	 * resolve from the in-memory snapshot; grep/lines are ignored for them.
	 */
	resolveRecall(codes: string[], opts: RecallOptions = {}): { matches: CodeMatch[]; missing: string[]; errors: CodeError[] } {
		this.recallCallCount++;
		for (const raw of codes) {
			const c = normalizeCode(raw);
			this.recallByCode.set(c, (this.recallByCode.get(c) ?? 0) + 1);
		}
		const snapByCode = this.snapshotByCode();
		const gateByCode = new Map<string, GateEntry>();
		for (const e of this.gate.entries()) gateByCode.set(e.code, e);

		const matches: CodeMatch[] = [];
		const missing: string[] = [];
		const errors: CodeError[] = [];

		for (const raw of codes) {
			const code = normalizeCode(raw);
			const entry = gateByCode.get(code);
			if (entry) {
				try {
					const { text, note } = this.recallFromSpool(entry, opts);
					const dedupNote = entry.dedupOf ? `identical to #${entry.dedupOf}` : "";
					matches.push({
						code,
						label: `${entry.tool} · L0 spool`,
						ids: [entry.blockId],
						text,
						note: [dedupNote, note].filter(Boolean).join(" · ") || undefined,
					});
				} catch (e) {
					const path = e instanceof SpoolError ? e.path : entry.spoolPath;
					errors.push({ code, message: `recall unavailable — spool file for #${code} could not be read (${path})` });
				}
				continue;
			}
			const hits = snapByCode.get(code);
			if (!hits || hits.length === 0) {
				missing.push(raw);
				continue;
			}
			matches.push({ code, label: labelFor(hits), ids: hits.map((b) => b.id), text: hits.map((b) => b.text).join("\n\n") });
		}
		return { matches, missing, errors };
	}

	/**
	 * Read an L0 fold's content from the spool and slice it. grep and lines= read the SAME haystack
	 * (the tool's full-output file when readable, else the spool — D30), so a grep hit's line number
	 * is always a valid input for a lines= follow-up. Whole recall is token-capped: recall must never
	 * re-flood the context the gate saved (DESIGN §6a partial-retrieval promise).
	 */
	private recallFromSpool(entry: GateEntry, opts: RecallOptions): { text: string; note?: string } {
		const spooled = readEnvelopeAt(entry.spoolPath).content;
		if (opts.lines || opts.grep) {
			let haystack = spooled;
			let source = "spool";
			if (entry.fullOutputPath) {
				try {
					haystack = readFileSync(entry.fullOutputPath, "utf8");
					source = "full output";
				} catch {
					/* fall back to spool content */
				}
			}
			if (opts.lines) return sliceByLines(haystack, opts.lines, source);
			return grepContent(haystack, opts.grep as string, source);
		}
		return capWholeRecall(spooled);
	}

	/**
	 * SPAN RECALL: one sweep over EVERY currently-folded block's full content (born-folded L0
	 * pointers and frozen ladder masks alike), returning matching lines grouped by fold code.
	 * This is the anti-churn primitive — recovering identifiers scattered across N pointers costs
	 * one call, not N probing recalls. Line numbers agree with `recall {code} lines=<a-b>` so a
	 * follow-up slice is always valid. Token-capped like every recall surface.
	 */
	searchFolded(term: string): { hits: SearchHit[]; scanned: number; note: string } {
		this.recallCallCount++;
		const needle = term.toLowerCase();
		const hits: SearchHit[] = [];
		let scanned = 0;
		let tokens = 0;
		let truncated = false;

		const blocks = [...this.snapshot.values()].sort((a, b) => a.order - b.order);
		for (const b of blocks) {
			const gateEntry = this.gate.get(b.id);
			const folded = (gateEntry !== undefined && this.gateActive) || this.frozenById.has(b.id);
			if (!folded || this.unfolded.has(b.id)) continue;
			scanned++;
			const code = gateEntry?.code ?? foldCode(b.id);
			const lines: string[] = [];
			const all = b.text.split("\n");
			for (let i = 0; i < all.length; i++) {
				const idx = all[i].toLowerCase().indexOf(needle);
				if (idx === -1) continue;
				// Match-centered window — the single-huge-line guard applies to the sweep too.
				const numbered = `${i + 1}: ${clipLineTo(all[i], GREP_LINE_CHAR_CAP, idx)}`;
				tokens += estTokens(numbered) + 1;
				if (tokens > SEARCH_TOKEN_CAP && (hits.length > 0 || lines.length > 0)) {
					truncated = true;
					break;
				}
				lines.push(numbered);
			}
			if (lines.length) hits.push({ code, label: labelFor([b]), lines });
			if (truncated) break;
		}
		const total = hits.reduce((n, h) => n + h.lines.length, 0);
		const note = truncated
			? `capped at ~${SEARCH_TOKEN_CAP} tok — narrow the term, or follow up with recall {code} lines=<a-b>`
			: `${total} matching line${total === 1 ? "" : "s"} across ${hits.length} of ${scanned} folded blocks`;
		return { hits, scanned, note };
	}

	/** Recall-churn accounting for the reset yellow flag (display-only). */
	get recallStats(): { calls: number; maxPerCode: number } {
		let max = 0;
		for (const n of this.recallByCode.values()) if (n > max) max = n;
		return { calls: this.recallCallCount, maxPerCode: max };
	}

	private snapshotByCode(): Map<string, WireBlock[]> {
		const byCode = new Map<string, WireBlock[]>();
		for (const b of this.snapshot.values()) {
			const c = foldCode(b.id);
			const arr = byCode.get(c);
			if (arr) arr.push(b);
			else byCode.set(c, [b]);
		}
		return byCode;
	}

	/** Mark fold-codes' blocks unfolded (held). They expand in the view on the next turn. */
	markUnfold(codes: string[]): { matches: CodeMatch[]; missing: string[] } {
		const res = this.resolve(codes);
		for (const m of res.matches) for (const id of m.ids) this.unfolded.add(id);
		return res;
	}

	/** Restore the agent's unfold decisions on session resume (event-sourced, P3.1). */
	restoreUnfolded(ids: Iterable<string>): void {
		for (const id of ids) this.unfolded.add(id);
	}

	// ── internals ──────────────────────────────────────────────────────────────

	private resolve(codes: string[]): { matches: CodeMatch[]; missing: string[] } {
		const byCode = new Map<string, WireBlock[]>();
		for (const b of this.snapshot.values()) {
			const c = foldCode(b.id);
			const arr = byCode.get(c);
			if (arr) arr.push(b);
			else byCode.set(c, [b]);
		}
		const matches: CodeMatch[] = [];
		const missing: string[] = [];
		for (const raw of codes) {
			const code = normalizeCode(raw);
			const hits = byCode.get(code);
			if (!hits || hits.length === 0) {
				missing.push(raw);
				continue;
			}
			matches.push({
				code,
				label: labelFor(hits),
				ids: hits.map((b) => b.id),
				text: hits.map((b) => b.text).join("\n\n"),
			});
		}
		return { matches, missing };
	}

	private buildView(
		blocks: WireBlock[],
		protectFrom: number,
		budget: number,
		contextWindow: number,
		tailTarget: number,
		gatePointers: Map<string, string>,
		frozenOps: Map<string, string>,
		reportedTokens: number | null,
	): ConductorView {
		let liveTokens = 0;
		const viewBlocks: ViewBlock[] = blocks.map((b, i) => {
			const pointer = gatePointers.get(b.id);
			const born = pointer !== undefined;
			const frozenText = born ? undefined : frozenOps.get(b.id);
			const frozen = frozenText !== undefined;
			const foldable = wireFoldable(b);
			// Born-folded blocks are charged at POINTER weight (criterion 6: budget math counts the
			// pre-folded block at digest weight); frozen blocks at their committed layer bytes;
			// every other block starts warm at full weight.
			const foldedTokens = born
				? substTokens(pointer)
				: frozen
					? substTokens(frozenText)
					: foldable
						? this.detDigestTokens(b)
						: b.tokens;
			liveTokens += born || frozen ? foldedTokens : b.tokens;
			return {
				id: b.id,
				messageKey: b.messageKey,
				kind: b.kind,
				turn: b.turn,
				order: b.order,
				tokens: b.tokens, // FULL weight — ranking always sees a born-folded block's true cost
				foldedTokens,
				toolName: b.toolName,
				callId: b.callId,
				isError: b.isError,
				held: this.unfolded.has(b.id),
				folded: born || frozen, // born-folded/frozen render folded from turn 1; others cleared to baseline
				bornFolded: born,
				frozen,
				protected: i >= protectFrom,
				grouped: false,
				text: b.text,
			};
		});
		return {
			blocks: viewBlocks,
			budget,
			contextWindow,
			liveTokens,
			reportedTokens: reportedTokens ?? undefined,
			reportedBudget: reportedTokens === null ? undefined : budget,
			protectedFromIndex: protectFrom,
			protectTokens: tailTarget,
		};
	}

	/** Cross-turn cached deterministic digest for a block (id + text-length keyed; see detCache). */
	private detDigest(b: WireBlock): string {
		const hit = this.detCache.get(b.id);
		if (hit && hit.len === b.text.length) return hit.digest;
		const d = digest(b);
		this.detCache.set(b.id, { len: b.text.length, digest: d, tokens: estTokens(d) + BLOCK_OVERHEAD });
		return d;
	}

	private detDigestTokens(b: WireBlock): number {
		const hit = this.detCache.get(b.id);
		if (hit && hit.len === b.text.length) return hit.tokens;
		this.detDigest(b);
		return this.detCache.get(b.id)!.tokens;
	}

	/**
	 * Lower the policy's `Command[]` into wire ops. The engine is the SOLE author of the
	 * `{#code FOLDED}` tag. Single disposition: a fold/replace on a protected, held, frozen or
	 * already-emitted id is dropped. Defense in depth — the policy already enforces these, but the
	 * wire re-checks so a bad command can never corrupt context.
	 */
	private lower(commands: Command[], blocks: WireBlock[], protectFrom: number): FoldOp[] {
		const byId = new Map(blocks.map((b) => [b.id, b] as const));
		const protectedAt = (id: string): boolean => {
			const b = byId.get(id);
			return b !== undefined && b.order >= protectFrom;
		};
		const canFold = (id: string): boolean => {
			const b = byId.get(id);
			return !!b && isDurableId(id) && wireFoldable(b) && !protectedAt(id) && !this.unfolded.has(id) && !this.frozenById.has(id);
		};

		const ops: FoldOp[] = [];
		const opIds = new Set<string>();

		for (const cmd of commands) {
			if (cmd.kind === "fold") {
				for (const id of cmd.ids) {
					if (opIds.has(id) || !canFold(id)) continue;
					const b = byId.get(id)!;
					const digestText = cmd.digest ? authoritativeTag(id, cmd.digest) : this.detDigest(b);
					ops.push({ id, digestText });
					opIds.add(id);
				}
			} else if (cmd.kind === "replace") {
				const id = cmd.id;
				if (opIds.has(id) || !canFold(id)) continue;
				const b = byId.get(id)!;
				let digestText: string;
				if (cmd.content === "") digestText = this.detDigest(b); // smallest wire-safe form
				else if (cmd.recoverable) digestText = `${foldTag(id)} ${stripLeadingTag(cmd.content)}`;
				else digestText = cmd.content;
				ops.push({ id, digestText });
				opIds.add(id);
			}
		}

		return ops;
	}

	/** Drop cached digests for blocks no longer in the session (bounds memory). */
	private pruneCaches(blocks: WireBlock[]): void {
		if (this.detCache.size === 0) return;
		const present = new Set(blocks.map((b) => b.id));
		for (const id of [...this.detCache.keys()]) if (!present.has(id)) this.detCache.delete(id);
	}
}

/**
 * Clip one line to a character budget. THE single-huge-line guard: a payload that is one
 * enormous line (minified JS, JSONL, base64, a shell wrapper echoing a file as one string)
 * must not ride through any recall cap on an "always keep at least one line" rule — that is
 * exactly the re-flood hole (a live `recall lines=2-2` once returned a 40KB line and undid
 * everything the gate saved). When `around` is given the window CENTERS on it, so a grep
 * match deep inside the line stays visible.
 */
function clipLineTo(line: string, maxChars: number, around?: number): string {
	if (line.length <= maxChars) return line;
	if (around === undefined || around <= maxChars / 2) {
		return `${safeSlice(line, maxChars)}…[line clipped: ${line.length} chars — grep=<term> targets content inside it]`;
	}
	const start = Math.min(Math.max(0, around - Math.floor(maxChars / 2)), line.length - maxChars);
	return `[…chars ${start + 1}-${start + maxChars} of ${line.length}…] ${safeSlice(line.slice(start), maxChars)}…`;
}

/** Max chars a single kept line may occupy inside a capped recall (leaves cap headroom). */
const RECALL_LINE_CHAR_CAP = (RECALL_WHOLE_TOKEN_CAP - 200) * 4;
/** Grep/search hit lines are windows, not reads — keep them short and match-centered. */
const GREP_LINE_CHAR_CAP = 320;

/** Return the 1-based inclusive line range `a-b` of `content` (partial recall), token-capped. */
function sliceByLines(content: string, spec: string, source: string): { text: string; note?: string } {
	const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(spec);
	const lines = content.split("\n");
	if (!m) return { text: "", note: `malformed lines="${spec}" (want "start-end", e.g. lines=40-80) — nothing returned` };
	const a = Math.max(1, parseInt(m[1], 10));
	const b = Math.min(lines.length, parseInt(m[2], 10));
	if (a > b) return { text: "", note: `empty range ${a}-${b} (${source} has ${lines.length} lines)` };
	// Token-cap the slice: lines= must stay PARTIAL retrieval (an unbounded range would hand the
	// whole flood back and undo the gate's savings in one call). Every line is char-clipped too —
	// the cap must hold even when the "range" is one enormous line.
	const kept: string[] = [];
	let tokens = 0;
	let clipped = false;
	for (let i = a - 1; i < b; i++) {
		const body = clipLineTo(lines[i], RECALL_LINE_CHAR_CAP);
		if (body !== lines[i]) clipped = true;
		const numbered = `${i + 1}: ${body}`;
		tokens += estTokens(numbered) + 1;
		if (kept.length > 0 && tokens > RECALL_WHOLE_TOKEN_CAP) break;
		kept.push(numbered);
	}
	const last = a + kept.length - 1;
	const note =
		last < b || clipped
			? `lines ${a}-${last} of ${a}-${b} requested (${source}, ~${RECALL_WHOLE_TOKEN_CAP} tok cap${clipped ? ", long line clipped" : ""}) — narrow the range or grep`
			: `lines ${a}-${b} of ${lines.length} (${source})`;
	return { text: kept.join("\n"), note };
}

/** Cap a whole-result recall so one call can never re-flood what the gate saved. */
function capWholeRecall(content: string): { text: string; note?: string } {
	if (estTokens(content) <= RECALL_WHOLE_TOKEN_CAP) return { text: content };
	const lines = content.split("\n");
	const kept: string[] = [];
	let tokens = 0;
	let clipped = false;
	for (const l of lines) {
		const body = clipLineTo(l, RECALL_LINE_CHAR_CAP);
		if (body !== l) clipped = true;
		tokens += estTokens(body) + 1;
		if (kept.length > 0 && tokens > RECALL_WHOLE_TOKEN_CAP) break;
		kept.push(body);
	}
	// When a long line was clipped, say exactly what to do next — an agent that only sees
	// "…clipped" tends to stop; the unseen content is reachable ONLY through grep.
	const clipNote = clipped
		? " · LONG LINE CLIPPED: unseen content inside it is reachable only via recall {code} grep=<term> — grep for the exact token you need"
		: " — use lines=<a-b> or grep=<term> for the rest";
	return {
		text: kept.join("\n"),
		note: `result is ~${estTokens(content)} tok; showing lines 1-${kept.length} of ${lines.length} (~${RECALL_WHOLE_TOKEN_CAP} tok cap)${clipNote}`,
	};
}

/**
 * Grep `content` for a case-insensitive substring, returning matching lines with 1-based numbers,
 * capped at ~the pointer budget with a "narrow your query" nudge past the cap (so recall-grep
 * can't itself defeat the gate). The caller resolves WHICH haystack (full output vs spool) so
 * grep and lines= always share one numbering space (D30).
 */
function grepContent(haystack: string, term: string, source: string): { text: string; note?: string } {
	const needle = term.toLowerCase();
	const hits: string[] = [];
	const linesArr = haystack.split("\n");
	for (let i = 0; i < linesArr.length; i++) {
		const idx = linesArr[i].toLowerCase().indexOf(needle);
		if (idx === -1) continue;
		// Window huge lines AROUND the match — grep is for finding, and the found term must stay
		// visible even at char 30,000 of a one-line flood.
		hits.push(`${i + 1}: ${clipLineTo(linesArr[i], GREP_LINE_CHAR_CAP, idx)}`);
	}
	if (hits.length === 0) return { text: "", note: `no lines match "${term}" (searched ${source}, ${linesArr.length} lines)` };
	const kept: string[] = [];
	let tokens = 0;
	for (const h of hits) {
		tokens += estTokens(h) + 1;
		if (kept.length > 0 && tokens > RECALL_SLICE_TOKEN_CAP) break;
		kept.push(h);
	}
	const note =
		kept.length < hits.length
			? `${kept.length} of ${hits.length} matches for "${term}" (${source}) — narrow your query or use lines=<a-b>`
			: `${hits.length} match${hits.length === 1 ? "" : "es"} for "${term}" (${source})`;
	return { text: kept.join("\n"), note };
}

/** Build the pointer-digest metadata for a born-folded block from its gate registry entry. */
function pointerMetaOf(e: GateEntry): PointerMeta {
	return {
		code: e.code,
		tool: e.tool,
		input: e.input,
		isError: e.isError,
		bytes: e.bytes,
		fullEstTokens: e.fullEstTokens,
		spoolPath: e.spoolPath,
		fullOutputPath: e.fullOutputPath,
		dedupOf: e.dedupOf,
	};
}

/** Gate ops (born-folded pointers) first, then policy ops whose id the gate didn't already claim. */
function mergeOpsById(gatePointers: Map<string, string>, policyOps: FoldOp[]): FoldOp[] {
	const out: FoldOp[] = [];
	for (const [id, digestText] of gatePointers) out.push({ id, digestText });
	for (const op of policyOps) if (!gatePointers.has(op.id)) out.push(op);
	return out;
}

// ── small pure helpers ─────────────────────────────────────────────────────────

/** Strip a leading `{#code FOLDED}` tag (if any) from policy-supplied content. */
function stripLeadingTag(s: string): string {
	return s.replace(/^\s*\{#[a-z0-9]{1,8}\s+FOLDED\}\s*/i, "");
}

/** The engine is the sole tag author: strip any supplied tag and prepend the authoritative one. */
function authoritativeTag(id: string, supplied: string): string {
	return `${foldTag(id)} ${stripLeadingTag(supplied)}`;
}

/** Accept a bare code or a full `{#code FOLDED}` tag from the agent. */
function normalizeCode(raw: string): string {
	const m = /\{#([a-z0-9]{1,8})\s+FOLDED\}/i.exec(raw);
	if (m) return m[1].toLowerCase();
	return raw.trim().replace(/^#/, "").toLowerCase();
}

function labelFor(blocks: WireBlock[]): string {
	const b = blocks[0];
	const more = blocks.length > 1 ? ` (+${blocks.length - 1})` : "";
	const name = b.toolName ? ` ${b.toolName}` : "";
	return `${b.kind}${name} · turn ${b.turn}${more}`;
}

// wireToBlock kept reachable for adapters that want the richer Block shape.
export { wireToBlock };
