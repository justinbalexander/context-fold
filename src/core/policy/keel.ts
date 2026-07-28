/*
 * keel.ts — the Keel conductor (Phase 1: deterministic, model-free).
 *
 * "Preserve the load-bearing structure of the agent's own work, reversibly compress everything
 * else, never destroy anything the agent can't get back." A PURE function of the view plus
 * instance memory (ACT-R recalls / per-block cooldown / the held epoch plan), pruned each pass.
 *
 * Per-pass synchronous pipeline:
 *   0. Bookkeeping — prune stale ids; update ACT-R warmth from the protected tail.
 *   1. Under budget → raw ([]).
 *   2. ROOTS — user/spec + protected + currently-held (never folded).
 *   3. RELEVANCE — entity-reachability + risk stickiness + ACT-R cold order (coldest first).
 *   4. EPOCH gate — HOLD the stable fold set while projected ≤ 0.9·cap; else open an epoch.
 *   5. ROUTE + DEEPEN — fidelity ladder coldest-first down to 0.7·cap.
 *   6. HARD-CAP FLOOR — guarantee projected ≤ cap (force-fold → force-group → drop).
 *   7. EMIT — replaces ++ one fold ++ groups; strip regrouped ids (single disposition).
 *
 * COLLABORATIVE — no locks. Respects the protected tail and held blocks; human/agent overrides
 * always win. Ported from Accordion `conductors/keel/keel.ts` (pinned commit 0c22434), with the
 * Phase-2 LLM deep-digest and Phase-3 Bear-2 paths removed — those are upgrades gated on
 * host.can("complete"/"compress"); with no model link Keel was already byte-identical to this.
 */
import type { Command, Conductor, ConductorHost, ConductorView, ViewBlock } from "../contract";
import { FOLDABLE_KINDS, type ScoreCtx } from "./score";
import { extractIdentifiers, matchBlocks } from "./lexical";
import { buildTailText, currentTurn } from "./tail";
import { identifyRoots } from "./roots";
import { rankCandidates, type RankedCandidate } from "./relevance";
import { trySkeleton, tryTrim, digestLevel, type LevelResult, type CountTokens } from "./ladder";
import { harvestFacts } from "./ledger";
import { EPOCH_BAND, effectiveCap, hardCapFloor } from "./budget";

/** Warmth-scan hysteresis — rate-limit recall accumulation from the tail. */
const WARMTH_COOLDOWN_TURNS = 5;
const MAX_WARMTH_RECORDS_PER_TURN = 4;

export class KeelConductor implements Conductor {
	readonly id: string = "keel";
	readonly label: string = "Keel";

	private host: ConductorHost | null = null;

	// ── cross-pass instance memory (pruned each pass against current ids) ────────
	/** ACT-R recall history: block id → turns at which it was found referenced in the tail. */
	private recalls = new Map<string, number[]>();
	/** Per-block cooldown: block id → turn until which no new recall may be recorded. */
	private warmthCoolUntil = new Map<string, number>();
	/** The last emitted command batch (re-returned verbatim on the epoch HOLD). */
	private lastPlan: Command[] = [];
	/** id → emitted substitution tokens last pass — drives the cache-warm HOLD projection. */
	private lastEmittedTokens = new Map<string, number>();

	attach(host: ConductorHost): void {
		this.host = host;
		this.lastPlan = [];
		this.lastEmittedTokens = new Map();
	}

	detach(): void {
		this.host?.setStatus(null);
		this.host = null;
		this.recalls.clear();
		this.warmthCoolUntil.clear();
		this.lastPlan = [];
		this.lastEmittedTokens = new Map();
	}

	conduct(view: ConductorView): Command[] {
		const blocks = view.blocks;
		const byId = new Map(blocks.map((b) => [b.id, b]));

		// ── 0. Bookkeeping: prune stale ids ─────────────────────────────────────
		for (const id of [...this.recalls.keys()]) if (!byId.has(id)) this.recalls.delete(id);
		for (const id of [...this.warmthCoolUntil.keys()]) if (!byId.has(id)) this.warmthCoolUntil.delete(id);

		const T = currentTurn(blocks);
		this.updateWarmth(blocks, T);

		const reportedTokens = view.reportedTokens;
		const reportedBudget = view.reportedBudget;
		const hasReportedUsage = reportedTokens !== undefined && reportedBudget !== undefined;
		const reportedPressure = hasReportedUsage && reportedTokens > reportedBudget;

		// Projection with the held epoch fold set re-applied (the host clears every pass). This stays
		// estimator-based: Pi's reported usage already reflects the previous hook output, so using it
		// as the raw baseline here would subtract the held plan twice.
		let projectedHeld = view.liveTokens;
		let heldCount = 0;
		for (const [id, emitted] of this.lastEmittedTokens) {
			const b = byId.get(id);
			if (!b || b.folded || b.held || b.protected || b.grouped) continue;
			projectedHeld += emitted - b.tokens;
			heldCount++;
		}

		// ── 1. Under budget → raw. Provider-reported pressure overrides the local chars÷4 estimate. ──
		if (view.liveTokens <= view.budget && !reportedPressure && heldCount === 0) {
			this.lastPlan = [];
			this.lastEmittedTokens.clear();
			this.host?.setStatus(null);
			return [];
		}

		// ── 2. ROOTS ─────────────────────────────────────────────────────────────
		const roots = identifyRoots(blocks);

		// ── 3. RELEVANCE: ordered cold→hot candidate list ───────────────────────
		const tailCallIds = new Set<string>();
		for (const b of blocks) if (b.protected && b.callId) tailCallIds.add(b.callId);
		const ctx: ScoreCtx = { currentTurn: T, recalls: this.recalls, tailCallIds };
		const ranked = this.rank(blocks, roots, ctx);

		// ── 4. EPOCH gate ────────────────────────────────────────────────────────
		const baseCap = effectiveCap(view.budget, view.contextWindow);
		// Translate real provider pressure into the estimator's local units. `projectedHeld` models the
		// same held output that produced the reported usage, avoiding double-counting its savings.
		const calibratedCap = reportedPressure
			? Math.max(1, Math.floor((projectedHeld * reportedBudget) / reportedTokens))
			: baseCap;
		const cap = Math.min(baseCap, calibratedCap);
		const highTok = EPOCH_BAND.high * cap;
		const lowTok = EPOCH_BAND.low * cap;

		// HOLD while the held plan keeps us in band (≤ 0.9·cap) AND under hard budget.
		if (!reportedPressure && heldCount > 0 && projectedHeld <= highTok && projectedHeld <= view.budget && this.lastPlan.length > 0) {
			this.publishStatus(blocks, heldCount, 0, [], projectedHeld, view, /*held*/ true, 0, cap);
			return this.lastPlan;
		}

		// ── 5. EPOCH: route + deepen coldest-first to the low-water target ──
		const target = Math.min(lowTok, view.budget);

		const callById = new Map<string, ViewBlock>();
		for (const b of blocks) if (b.kind === "tool_call" && b.callId) callById.set(b.callId, b);
		const count: CountTokens = (text) =>
			this.host?.can("countTokens") ? this.host.countTokens(text) : Math.ceil(text.length / 4);

		let projected = view.liveTokens;
		const replaceById = new Map<string, Command>(); // id → ladder `replace` command
		const foldIds: string[] = [];
		const laddered = new Set<string>(); // ids the ladder substituted via `replace`
		const currentTokens = new Map<string, number>(); // id → current contribution (for the floor)
		const emitted = new Map<string, number>(); // id → emitted substitution tokens (for HOLD projection)

		for (const cand of ranked) {
			if (projected <= target) break;
			const b = cand.block;
			const routed = this.route(b, callById, count);
			if (!routed) continue;
			if (routed.command.kind === "replace") {
				replaceById.set(b.id, routed.command);
				laddered.add(b.id);
			} else {
				foldIds.push(b.id);
			}
			currentTokens.set(b.id, routed.tokens);
			emitted.set(b.id, routed.tokens);
			projected -= b.tokens - routed.tokens;
		}

		// ── 6. Hard-cap FLOOR — guarantee projected ≤ cap ──────────────────────────
		const isFoldableForFloor = (b: ViewBlock): boolean =>
			!b.held && !b.protected && !b.grouped && !b.bornFolded && b.foldedTokens < b.tokens && FOLDABLE_KINDS.has(b.kind);
		// Stage-2/3 whole-message removal: tool_call blocks ARE removable inside a group (the pair
		// leaves together — that's what keeps it provider-safe); user blocks never are, and roots are
		// excluded per-block by the floor itself.
		const isRemovableForFloor = (b: ViewBlock): boolean =>
			!b.held && !b.protected && !b.grouped && !b.bornFolded && b.kind !== "user";
		const floor = hardCapFloor(blocks, cap, projected, currentTokens, laddered, roots, isFoldableForFloor, isRemovableForFloor);

		for (const id of floor.foldIds) {
			foldIds.push(id);
			const b = byId.get(id);
			if (b) emitted.set(id, b.foldedTokens);
		}
		// Floor DOWNGRADES: a ladder `replace` deepened to a plain digest. Drop the replace, fold instead.
		for (const id of floor.downgraded) {
			replaceById.delete(id);
			laddered.delete(id);
			foldIds.push(id);
			const b = byId.get(id);
			if (b) emitted.set(id, b.foldedTokens);
		}
		projected = floor.projected;

		// SINGLE DISPOSITION: strip every regrouped id from both the fold list and the replace map.
		const regrouped = new Set(floor.regrouped);
		const finalFoldIds = foldIds.filter((id) => !regrouped.has(id));
		for (const id of regrouped) replaceById.delete(id);

		// ── 7. EMIT ──────────────────────────────────────────────────────────────
		const replaces = [...replaceById.values()];
		const cmds: Command[] = [...replaces];
		if (finalFoldIds.length) cmds.push({ kind: "fold", ids: finalFoldIds });
		for (const g of floor.groups) cmds.push(g);

		// Record emitted-token map for next pass's HOLD projection — but only when NO group/drop
		// fired (a group breaks byte-stability and re-grouping every pass is not a clean hold).
		this.lastEmittedTokens = floor.groups.length === 0 ? emitted : new Map();
		this.lastPlan = cmds;

		this.publishStatus(blocks, finalFoldIds.length, replaces.length, floor.dropped, projected, view, false, floor.groups.length, cap);
		return cmds;
	}

	/**
	 * Produce the cold→hot fold-candidate ranking. The deterministic Keel uses entity-reachability
	 * + risk + ACT-R cold score. A subclass (ModelConductor) overrides this to let a model reorder
	 * the candidates — the one seam where a model enters the *deciding* loop. The downstream ladder
	 * and hard-cap floor are unchanged, so budget safety is preserved regardless of the ranking.
	 */
	protected rank(blocks: ViewBlock[], roots: Set<string>, ctx: ScoreCtx): RankedCandidate[] {
		return rankCandidates(blocks, roots, ctx);
	}

	/**
	 * Route a block to its fidelity level: code read → Skeleton (L1, stubbed in Phase 1) → long
	 * prose/thinking/non-code result → Trim (L2) → Digest (L3, the floor for any foldable block).
	 */
	private route(b: ViewBlock, callById: Map<string, ViewBlock>, count: CountTokens): LevelResult {
		const sk = trySkeleton(b, callById, count);
		if (sk) return sk;
		const tr = tryTrim(b, count);
		if (tr) return tr;
		return digestLevel(b);
	}

	/** Update ACT-R recall warmth from the protected tail (continuous, rate-limited). */
	private updateWarmth(blocks: ViewBlock[], T: number): void {
		const tailText = buildTailText(blocks);
		const tailIds = extractIdentifiers(tailText);
		if (tailIds.size === 0) return;
		const cands = blocks.filter((b) => FOLDABLE_KINDS.has(b.kind) && !b.held && !b.protected && !b.grouped);
		let recorded = 0;
		for (const bid of matchBlocks(tailIds, cands).keys()) {
			if (recorded >= MAX_WARMTH_RECORDS_PER_TURN) break;
			if ((this.warmthCoolUntil.get(bid) ?? 0) > T) continue;
			const arr = this.recalls.get(bid);
			if (!arr) this.recalls.set(bid, [T]);
			else if (!arr.includes(T)) arr.push(T);
			this.warmthCoolUntil.set(bid, T + WARMTH_COOLDOWN_TURNS);
			recorded++;
		}
	}

	/** Surface the fidelity ladder + epoch + fact ledger + any drops to the human (display-only). */
	private publishStatus(
		blocks: ViewBlock[],
		folds: number,
		skeletonsAndTrims: number,
		dropped: string[],
		projected: number,
		view: ConductorView,
		held: boolean,
		groups = 0,
		cap = effectiveCap(view.budget, view.contextWindow),
	): void {
		if (!this.host) return;
		const saved = view.liveTokens - projected;
		// HONEST INVARIANT: Keel guarantees projected ≤ cap UNLESS the irreducible floor — every
		// user/spec + protected tail + held — alone exceeds cap. Those are host-absolute; Keel folds
		// everything it IS allowed to and announces the overage rather than falsely claiming budget.
		const over = projected > cap;
		const irreducible = this.irreducibleFloor(blocks);
		const parts: string[] = [];
		if (held) parts.push("hold");
		if (skeletonsAndTrims) parts.push(`${skeletonsAndTrims} trim`);
		if (folds) parts.push(`${folds} fold`);
		if (groups) parts.push(`${groups} grouped`);
		if (dropped.length) parts.push(`${dropped.length} DROPPED`);
		const head = parts.length ? parts.join(" + ") : "raw";
		const savedK = saved >= 1000 ? `${(saved / 1000).toFixed(1)}k` : `${Math.max(0, saved)}`;
		const overMsg = over
			? irreducible > cap
				? " · OVER BUDGET: protected tail/roots exceed cap"
				: " · still over budget"
			: "";
		this.host.setStatus(
			`${head} · saved ~${savedK} tok${overMsg}${dropped.length ? " · irreversible drop announced" : ""}`,
			{
				folds,
				groups,
				substitutions: skeletonsAndTrims,
				dropped: dropped.length,
				tokens_saved: saved,
				live_tokens: projected,
				budget: view.budget,
				cap,
				irreducible_floor: irreducible,
				over_budget: over,
				...(view.reportedTokens !== undefined && view.reportedBudget !== undefined
					? {
							reported_tokens: view.reportedTokens,
							reported_budget: view.reportedBudget,
							usage_calibrated: view.reportedTokens > view.reportedBudget,
						}
					: {}),
			},
			{
				factLedger: harvestFacts(blocks).map((f) => ({
					category: f.category,
					value: f.value,
					turn: f.turn ?? null,
					sourceId: f.sourceId ?? null,
				})),
			},
		);
	}

	/** The IRREDUCIBLE FLOOR: full-token sum of everything Keel can never fold (user + protected + held). */
	private irreducibleFloor(blocks: ViewBlock[]): number {
		let n = 0;
		for (const b of blocks) {
			if (b.kind === "user" || b.protected || b.held) n += b.tokens;
		}
		return n;
	}
}
