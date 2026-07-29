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
import type { AgentMessage, FoldOp, GroupOp, Group, WireBlock } from "../../core/block";
import { linearize, isDurableId, wireToBlock } from "../../core/block";
import { applyPlan } from "../../core/apply";
import { digest, wireFoldable, foldCode, foldTag, groupDigest, pointerDigest, substTokens, type PointerMeta } from "../../core/digest";
import { estTokens, firstLine, BLOCK_OVERHEAD } from "../../core/tokens";
import { MapGateRegistry, type GateRegistry, type GateEntry } from "../../core/gate-registry";
import { readEnvelopeAt, SpoolError } from "./spool";
import { readFileSync } from "node:fs";
import type { DigestWriter, DigestRequest } from "../../core/model/digest-writer";
import type { RelevanceJudge, JudgeCandidate } from "../../core/model/relevance-judge";
import { isRelevanceAware } from "../../core/policy/model";

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
	 * Prefix-stable folding (Stage 2): commit each epoch's substitutions as a frozen layer whose
	 * bytes never change again, so the context head stays byte-identical across turns and the
	 * provider's prompt cache keeps re-hitting it. Always on in ladder mode (the adapter forces
	 * it); opt-in for keel mode.
	 */
	prefixStable: boolean;
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
	prefixStable: false,
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
	/** Emitted group summaries: fold code → member block ids, so a group's advertised {#code} tag
	 *  actually resolves via recall/unfold (reversibility for L4 force-group). */
	private readonly groupCodes = new Map<string, string[]>();
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

	// ── Phase 2: model-driven digests (async, fire-and-cache; null = pure Phase-1 path) ─────────
	private readonly writer: DigestWriter | null;
	/** id → model-written digest body (no tag). Applied to fold ops when present; stale-safe by id. */
	private readonly modelDigests = new Map<string, string>();
	/** Signature of the last cold zone we dispatched a writer batch for (avoid refiring the same zone). */
	private lastColdSig = "";
	/** One writer batch in flight at a time. */
	private inflight = false;
	/** How many fold ops used a model digest last pass (debug/telemetry). */
	private lastModelUsed = 0;

	// ── Phase 2 rep 2: model-decided coldness (relevance judge, async-cached) ───────────────────
	private readonly judge: RelevanceJudge | null;
	/** Model's latest "keep warm" judgment (block ids kept in full). Injected into the policy each pass. */
	private keepWarm = new Set<string>();
	private lastJudgeSig = "";
	private judgeInflight = false;

	// ── L0 ingestion gate: registry of born-folded blocks (recall reads the spool by entry path) ──
	private readonly gate: GateRegistry;

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

	constructor(
		policy: Conductor,
		cfg: Partial<FoldConfig> = {},
		writer: DigestWriter | null = null,
		judge: RelevanceJudge | null = null,
		gate: GateRegistry = new MapGateRegistry(),
	) {
		this.cfg = { ...DEFAULT_CONFIG, ...cfg };
		this.policy = policy;
		this.writer = writer;
		this.judge = judge;
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

	/** True while an async model call (digest writer or relevance judge) is in flight. */
	get busy(): boolean {
		return this.inflight || this.judgeInflight;
	}

	/** Enable/disable L0 pointer substitution (the adapter resolves the per-model kill switch). */
	setGateActive(active: boolean): void {
		this.gateActive = active;
	}

	/** Reset per-session state (session switch in one process): unfolds, caches, group registry. */
	resetForSession(): void {
		this.unfolded.clear();
		this.snapshot = new Map();
		this.groupCodes.clear();
		this.detCache.clear();
		this.modelDigests.clear();
		this.keepWarm = new Set();
		this.lastColdSig = "";
		this.lastJudgeSig = "";
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
		if (!this.cfg.prefixStable || this.frozenById.size === 0) return out;
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
		this.pruneModelDigests(blocks);

		// ── L0 GATE: born-folded pointers ────────────────────────────────────────
		// Registered blocks enter the view already folded to a pointer digest (unless the agent has
		// unfolded them). These ops apply EVERY turn regardless of budget pressure — the whole point of
		// the gate is that a flood never reaches full-fidelity context in the first place.
		const gatePointers = this.computeGatePointers(blocks);
		const frame = normalizeContextFrame(context);

		// Consolidation loop: normally one pass. When the plan is still over budget, layers exist,
		// and the irreducible floor is not the cause, deliberately break the OLDEST layer — one
		// full cache re-prefill at a chosen boundary — and replan. Bounded by the layer count.
		for (let attempt = 0; ; attempt++) {
			const frozenOps = this.computeFrozenOps(blocks);
			const { cw, budget, tailTarget, protectFrom } = this.frame(blocks, frame.contextWindow, gatePointers, frozenOps);
			const view = this.buildView(blocks, protectFrom, budget, cw, tailTarget, gatePointers, frozenOps, frame.tokens);

			// Phase 2 rep 2: inject the model's cached "keep warm" judgment into a relevance-aware policy
			// (ModelConductor). Empty when no judge / not yet answered → deterministic behavior.
			if (this.judge && isRelevanceAware(this.policy)) {
				this.pruneKeepWarm(blocks);
				this.policy.setKeepWarm(this.keepWarm);
			}

			const cmds = this.policy.conduct(view);

			let ops: FoldOp[] = [];
			let groups: GroupOp[] = [];
			if (cmds != null && cmds.length > 0) {
				// Phase 2: the deterministic fold-command ids ARE the cold zone. Dispatch the model writer
				// (digests) and the relevance judge (coldness) for them — async, non-blocking. Their results
				// apply on a later turn. Keel's mechanism is untouched; the model only supplies string + order.
				const foldIds = collectFoldIds(cmds);
				this.maybeFireWriter(foldIds, blocks);
				this.maybeFireJudge(foldIds, blocks, protectFrom);
				const lowered = this.lower(cmds, blocks, protectFrom);
				ops = lowered.ops;
				groups = lowered.groups;
			}

			if (this.cfg.prefixStable) {
				const overBudget = this.lastStatus?.metrics?.over_budget === true;
				const irreducible = Number(this.lastStatus?.metrics?.irreducible_floor ?? 0);
				const cap = Number(this.lastStatus?.metrics?.cap ?? 0);
				if (overBudget && this.frozenLayers.length > 0 && attempt < this.frozenLayers.length + 1 && !(cap > 0 && irreducible > cap)) {
					const broken = this.frozenLayers.shift()!;
					this.rebuildFrozenIndex();
					this.onLayerBreak?.(broken.seq);
					process.stderr.write(
						`[context-fold] consolidation: broke layer ${broken.seq} (${broken.entries.length} blocks) — one deliberate cache re-prefill\n`,
					);
					continue;
				}
				// Commit this epoch's substitutions as a new frozen layer — but never on a group turn
				// (groups rewrite structure; freezing alongside one would fix bytes that just moved).
				if (groups.length === 0 && ops.length > 0) {
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
			}

			// Merge order = gate > frozen > policy: the gate owns its ids outright; a frozen id's bytes
			// outrank any late policy op for it (defense in depth — candidates already exclude frozen).
			const allOps = mergeOpsById(gatePointers, mergeOpsById(frozenOps, ops));
			if (allOps.length === 0 && groups.length === 0) return messages; // nothing to fold → send unchanged

			if (this.cfg.debug) {
				const model = this.writer ? ` digest=${this.lastModelUsed}/${ops.length}${this.inflight ? " (writing…)" : ""}` : "";
				const warm = this.judge ? ` keepWarm=${this.keepWarm.size}${this.judgeInflight ? " (judging…)" : ""}` : "";
				const l0 = gatePointers.size ? ` l0=${gatePointers.size}` : "";
				const fz = frozenOps.size ? ` frozen=${frozenOps.size}` : "";
				process.stderr.write(
					`[context-fold] ${ops.length} folds, ${groups.length} groups${l0}${fz}, live=${view.liveTokens} budget=${budget}${model}${warm} ${this.lastStatus?.text ?? ""}\n`,
				);
			}

			return applyPlan(messages, allOps, groups);
		}
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
			const groupIds = this.groupCodes.get(code);
			if (groupIds) {
				const hits = groupIds.map((id) => this.snapshot.get(id)).filter((b): b is WireBlock => !!b);
				if (hits.length) {
					matches.push({
						code,
						label: `group · ${hits.length} block${hits.length === 1 ? "" : "s"}`,
						ids: hits.map((b) => b.id),
						text: hits.map((b) => b.text).join("\n\n"),
					});
					continue;
				}
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
			// A group summary's code resolves to (and unfolds) all of its member blocks.
			const groupIds = this.groupCodes.get(code);
			const hits = groupIds
				? groupIds.map((id) => this.snapshot.get(id)).filter((b): b is WireBlock => !!b)
				: byCode.get(code);
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
			// every other block starts warm at full weight. A cached MODEL digest is priced here
			// too — it is what lowering will actually ship, so every projection (epoch band, floor,
			// HOLD) sees the true wire cost, and the model can never push the wire past what the
			// floor proved (the old accounting priced the shorter deterministic digest and went
			// blind to the difference).
			const modelBody = born || frozen ? undefined : this.modelDigests.get(b.id);
			const foldedTokens = born
				? substTokens(pointer)
				: frozen
					? substTokens(frozenText)
					: foldable
						? modelBody !== undefined
							? substTokens(`${foldTag(b.id)} ${modelBody}`)
							: this.detDigestTokens(b)
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
				grouped: false, // no human groups in Phase 1
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
	 * `{#code FOLDED}` tag. Single disposition: groups claim their members first; a fold/replace on
	 * a grouped (or protected, or held, or already-emitted) id is dropped. Defense in depth — the
	 * policy already enforces these, but the wire re-checks so a bad command can never corrupt context.
	 */
	private lower(commands: Command[], blocks: WireBlock[], protectFrom: number): { ops: FoldOp[]; groups: GroupOp[] } {
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
		const groups: GroupOp[] = [];
		const groupedIds = new Set<string>();
		const opIds = new Set<string>();
		let modelUsed = 0;

		// Pass 1: group commands claim their members.
		for (const cmd of commands) {
			if (cmd.kind !== "group") continue;
			const members = cmd.ids
				.map((id) => byId.get(id))
				.filter(
					(b): b is WireBlock =>
						!!b &&
						isDurableId(b.id) &&
						!protectedAt(b.id) &&
						!this.unfolded.has(b.id) &&
						!groupedIds.has(b.id) &&
						!this.frozenById.has(b.id),
				);
			if (members.length === 0) continue;
			const groupId = `g:${members[0].id}`;
			const group: Group = { id: groupId, memberIds: members.map((m) => m.id), folded: true };
			let summaryText: string | null;
			if (cmd.digest === undefined) summaryText = groupDigest(group, members);
			else if (cmd.digest === null || cmd.digest === "") summaryText = null; // DROP
			else summaryText = cmd.digest; // verbatim
			groups.push({ id: groupId, memberIds: group.memberIds, summaryText });
			for (const m of members) groupedIds.add(m.id);
			// Register the summary's advertised {#code} handle so recall/unfold can resolve it back to
			// the member blocks (reversibility for L4 — the summary is the only place the member codes
			// were erased from, so its own code must answer for them).
			this.groupCodes.set(foldCode(groupId), group.memberIds);
		}

		// Pass 2: fold / replace (skip anything a group already claimed).
		for (const cmd of commands) {
			if (cmd.kind === "fold") {
				for (const id of cmd.ids) {
					if (groupedIds.has(id) || opIds.has(id) || !canFold(id)) continue;
					const b = byId.get(id)!;
					// Phase 2: a cached model digest replaces the deterministic engine digest STRING for
					// this fold — same fold decision, same authoritative {#code} tag, same reversibility.
					const modelBody = this.modelDigests.get(id);
					let digestText: string;
					if (modelBody) {
						digestText = `${foldTag(id)} ${modelBody}`;
						modelUsed++;
					} else if (cmd.digest) {
						digestText = authoritativeTag(id, cmd.digest);
					} else {
						digestText = this.detDigest(b);
					}
					ops.push({ id, digestText });
					opIds.add(id);
				}
			} else if (cmd.kind === "replace") {
				const id = cmd.id;
				if (groupedIds.has(id) || opIds.has(id) || !canFold(id)) continue;
				const b = byId.get(id)!;
				let digestText: string;
				if (cmd.content === "") digestText = this.detDigest(b); // smallest wire-safe form
				else if (cmd.recoverable) digestText = `${foldTag(id)} ${stripLeadingTag(cmd.content)}`;
				else digestText = cmd.content;
				ops.push({ id, digestText });
				opIds.add(id);
			}
			// restore / pin: no-op on the wire — the block stays live by not being folded.
		}

		this.lastModelUsed = modelUsed;
		return { ops, groups };
	}

	/**
	 * Phase 2: dispatch the model digest writer for the current cold zone (the deterministic
	 * fold-command ids). Fire-and-cache, NON-BLOCKING — `process()` returns this turn using whatever
	 * digests are already cached; the resolved digests apply on a later turn. Only one batch in
	 * flight, and only when the cold zone changed (so a stable session makes no repeat calls).
	 */
	private maybeFireWriter(foldIds: string[], blocks: WireBlock[]): void {
		if (!this.writer || foldIds.length === 0 || this.inflight) return;
		const byId = new Map(blocks.map((b) => [b.id, b] as const));
		// Only foldable blocks we don't already have a model digest for. Frozen ids are excluded:
		// their bytes are committed, so a late-arriving model digest could never ship for them.
		const pending = foldIds.filter((id) => {
			const b = byId.get(id);
			return !!b && wireFoldable(b) && !this.modelDigests.has(id) && !this.frozenById.has(id);
		});
		if (pending.length === 0) return;
		const sig = [...pending].sort().join("\0");
		if (sig === this.lastColdSig) return; // already dispatched this exact cold zone
		this.lastColdSig = sig;

		const reqs: DigestRequest[] = pending.map((id) => {
			const b = byId.get(id)!;
			return { id, kind: b.kind, toolName: b.toolName, text: b.text };
		});
		this.inflight = true;
		void this.writer.write(reqs).then(
			(map) => {
				for (const [id, body] of map) {
					// The engine is the SOLE author of {#code FOLDED} tags: strip any tag-shaped text the
					// model emitted ANYWHERE in the body, or a weak model could inject phantom unfold
					// handles into context. Empty after stripping → deterministic fallback.
					const clean = body.replace(/\{#[a-z0-9]{1,8}\s+FOLDED\}/gi, "").replace(/\s+/g, " ").trim();
					if (clean.length >= 3) this.modelDigests.set(id, clean);
				}
				if (map.size === 0) this.lastColdSig = ""; // total failure → allow a retry at the next epoch
				this.inflight = false;
			},
			() => {
				this.lastColdSig = ""; // network/parse failure → keep deterministic digests, retry later
				this.inflight = false;
			},
		);
	}

	/** Drop cached state for blocks no longer in the session (bounds memory). */
	private pruneModelDigests(blocks: WireBlock[]): void {
		if (this.modelDigests.size === 0 && this.detCache.size === 0 && this.groupCodes.size === 0) return;
		const present = new Set(blocks.map((b) => b.id));
		for (const id of [...this.modelDigests.keys()]) if (!present.has(id)) this.modelDigests.delete(id);
		for (const id of [...this.detCache.keys()]) if (!present.has(id)) this.detCache.delete(id);
		for (const [code, ids] of [...this.groupCodes]) if (!ids.some((id) => present.has(id))) this.groupCodes.delete(code);
	}

	/**
	 * Phase 2 rep 2: dispatch the relevance judge for the current cold zone (the about-to-fold
	 * blocks). Fire-and-cache, NON-BLOCKING — the resulting keep-warm set reorders the NEXT pass's
	 * ranking (model-kept blocks fold last). One call per changed cold zone; the deterministic floor
	 * still guarantees the budget regardless of what the model keeps.
	 */
	private maybeFireJudge(foldIds: string[], blocks: WireBlock[], protectFrom: number): void {
		if (!this.judge || foldIds.length === 0 || this.judgeInflight) return;
		const sig = [...foldIds].sort().join("\0");
		if (sig === this.lastJudgeSig) return; // already judged this exact cold zone
		this.lastJudgeSig = sig;

		const byId = new Map(blocks.map((b) => [b.id, b] as const));
		const candidates: JudgeCandidate[] = foldIds
			.map((id) => byId.get(id))
			.filter((b): b is WireBlock => !!b)
			.map((b) => ({ id: b.id, kind: b.kind, toolName: b.toolName, preview: firstLine(b.text, 100) }));
		if (candidates.length === 0) return;

		// "Current work" = the protected-tail text (what the agent is actively reasoning over).
		const tailText = blocks
			.filter((b) => b.order >= protectFrom)
			.map((b) => b.text)
			.join("\n");

		this.judgeInflight = true;
		void this.judge.judge(tailText, candidates).then(
			(keep) => {
				this.keepWarm = keep;
				this.judgeInflight = false;
			},
			() => {
				this.judgeInflight = false; // failure → keep the previous (or empty) judgment
			},
		);
	}

	/** Drop keep-warm ids for blocks no longer present (bounds memory; stale-safe). */
	private pruneKeepWarm(blocks: WireBlock[]): void {
		if (this.keepWarm.size === 0) return;
		const present = new Set(blocks.map((b) => b.id));
		let changed = false;
		for (const id of this.keepWarm) if (!present.has(id)) changed = true;
		if (changed) this.keepWarm = new Set([...this.keepWarm].filter((id) => present.has(id)));
	}
}

/** Return the 1-based inclusive line range `a-b` of `content` (partial recall), token-capped. */
function sliceByLines(content: string, spec: string, source: string): { text: string; note?: string } {
	const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(spec);
	const lines = content.split("\n");
	if (!m) return { text: "", note: `malformed lines="${spec}" (want "start-end", e.g. lines=40-80) — nothing returned` };
	const a = Math.max(1, parseInt(m[1], 10));
	const b = Math.min(lines.length, parseInt(m[2], 10));
	if (a > b) return { text: "", note: `empty range ${a}-${b} (${source} has ${lines.length} lines)` };
	// Token-cap the slice: lines= must stay PARTIAL retrieval (an unbounded range would hand the
	// whole flood back and undo the gate's savings in one call).
	const kept: string[] = [];
	let tokens = 0;
	for (let i = a - 1; i < b; i++) {
		const numbered = `${i + 1}: ${lines[i]}`;
		tokens += estTokens(numbered) + 1;
		if (kept.length > 0 && tokens > RECALL_WHOLE_TOKEN_CAP) break;
		kept.push(numbered);
	}
	const last = a + kept.length - 1;
	const note =
		last < b
			? `lines ${a}-${last} of ${a}-${b} requested (${source}, ~${RECALL_WHOLE_TOKEN_CAP} tok cap) — narrow the range or grep`
			: `lines ${a}-${b} of ${lines.length} (${source})`;
	return { text: kept.join("\n"), note };
}

/** Cap a whole-result recall so one call can never re-flood what the gate saved. */
function capWholeRecall(content: string): { text: string; note?: string } {
	if (estTokens(content) <= RECALL_WHOLE_TOKEN_CAP) return { text: content };
	const lines = content.split("\n");
	const kept: string[] = [];
	let tokens = 0;
	for (const l of lines) {
		tokens += estTokens(l) + 1;
		if (kept.length > 0 && tokens > RECALL_WHOLE_TOKEN_CAP) break;
		kept.push(l);
	}
	return {
		text: kept.join("\n"),
		note: `result is ~${estTokens(content)} tok; showing lines 1-${kept.length} of ${lines.length} (~${RECALL_WHOLE_TOKEN_CAP} tok cap) — use lines=<a-b> or grep=<term> for the rest`,
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
		if (linesArr[i].toLowerCase().includes(needle)) hits.push(`${i + 1}: ${linesArr[i]}`);
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

/** Collect the ids targeted by `fold` commands — the deterministic-digest cold zone. */
function collectFoldIds(commands: Command[]): string[] {
	const ids: string[] = [];
	for (const cmd of commands) if (cmd.kind === "fold") ids.push(...cmd.ids);
	return ids;
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
