/*
 * budget.ts — Keel's EPOCH MODEL + HARD-CAP FLOOR.
 *
 *   EPOCH HOLD BAND. cap = min(budget, contextWindow ?? budget). While projected ≤ 0.9·cap, HOLD
 *   the fold set unchanged (byte-stable prefix → warm KV cache). When projection crosses 0.9·cap,
 *   fold down to 0.7·cap in one deliberate cache-miss, then hold. ~20% hysteresis ⇒ ≤1 miss/epoch.
 *
 *   HARD-CAP FLOOR. The last resort after the reversible ladder. A monotone deterministic loop
 *   over three stages on the running digest residue: force-fold biggest reducible → force-GROUP
 *   oldest run → DROP oldest run. Always terminates ≤ cap whenever the foldable content can
 *   achieve it; if the irreducible floor (roots + tail) alone exceeds cap, it reduces everything
 *   it can and the caller announces "over budget".
 *
 *   STAGES 2/3 ARE MESSAGE-ALIGNED. applyPlan can only remove WHOLE messages whose every emitted
 *   block id sits in one group and whose tool pairs are balanced inside the removal set. The floor
 *   therefore builds candidate runs at message granularity (via ViewBlock.messageKey), includes
 *   every block of each chosen message — tool_call ids too; grouping removes the pair together,
 *   which is exactly what keeps it provider-safe — and pair-balances each run BEFORE booking its
 *   savings. A run the applier would demote is never booked, so `projected` is an honest
 *   projection of the wire, not an optimistic one.
 *
 * Ported from Accordion `conductors/keel/budget.ts` (pinned commit 0c22434); stages 2/3 rebuilt
 * message-aligned after the phantom-savings defect (REVIEW-2026-07-04 §1).
 */
import type { ViewBlock, GroupCommand } from "../contract";
import { isDurableId } from "../block";

/** The hysteresis band as fractions of the effective cap. */
export const EPOCH_BAND = {
	high: 0.9, // cross this (projected) → open an epoch
	low: 0.7, // an epoch folds down to roughly here
};

/** The effective cap: the smaller of the budget and the model's context window.
 *  The budget arrives pre-capped by the adapter (`frame()` applies
 *  min(absoluteTokenCap, fraction × window)); this stays the single place the
 *  policy re-clamps it against the window so the floor proves the same number. */
export function effectiveCap(budget: number, contextWindow: number | null): number {
	return Math.min(budget, contextWindow ?? budget);
}

export interface FloorResult {
	/** Ids to force-fold to the engine digest. */
	foldIds: string[];
	/** Ladder-substituted ids DOWNGRADED to a plain fold (the caller drops their `replace`). */
	downgraded: string[];
	/** Group commands (force-group reversible, or DROP with digest:null) to append. */
	groups: GroupCommand[];
	/** Ids hard-dropped (irreversible) — surfaced via status, never silent. */
	dropped: string[];
	/** Ids that ended up inside a GROUP/DROP run — the caller MUST strip these from every
	 *  fold/replace so each block carries EXACTLY ONE disposition. */
	regrouped: string[];
	/** Projected live tokens after the floor (≤ cap whenever achievable). */
	projected: number;
}

/**
 * A CONSERVATIVE upper bound on the surviving group HEAD cost. We over-estimate every component
 * so the result is provably ≥ the store's real head cost (over-counting only makes the floor
 * fold/drop slightly MORE — keeping the loop monotone and the guarantee sound).
 */
function groupHeadCost(run: ViewBlock[]): number {
	let totalTok = 0;
	let lo = Infinity;
	let hi = -Infinity;
	let hasUser = false;
	const kinds = new Set<string>();
	for (const b of run) {
		totalTok += b.tokens;
		if (b.turn < lo) lo = b.turn;
		if (b.turn > hi) hi = b.turn;
		kinds.add(b.kind);
		if (b.kind === "user") hasUser = true;
	}
	let chars = 64;
	chars += String(run.length).length;
	chars += String(Math.max(0, totalTok)).length;
	chars += String(Math.max(0, isFinite(hi) ? hi : 0)).length * 2;
	// "999 results, " is 13 chars — 14 per kind stays a provable ceiling without the old 24/kind
	// slack that had a 100-group session claiming ~2k tokens of head cost that never materialized.
	chars += kinds.size * 14;
	if (hasUser) chars += 80;
	return Math.ceil(chars / 4) + 8;
}

/** One provider message as the floor sees it: its blocks, in view order. */
interface MsgGroup {
	key: string;
	blocks: ViewBlock[];
	removable: boolean;
}

/**
 * Fold the view into ordered messages via `messageKey` (blocks sharing a key are contiguous by
 * construction — linearize emits in message order). A message is REMOVABLE only when every one of
 * its blocks is durable, non-excluded, and passes `isRemovable` — mirroring applyPlan's
 * whole-message + durable guard, so a run of removable messages is one the applier accepts.
 * A block with no messageKey gets a synthetic solo key but is never removable (the floor cannot
 * prove message coverage for it).
 */
function toMessages(view: ViewBlock[], excluded: Set<string>, isRemovable: (b: ViewBlock) => boolean): MsgGroup[] {
	const msgs: MsgGroup[] = [];
	let cur: MsgGroup | null = null;
	let solo = 0;
	for (const b of view) {
		const key = b.messageKey ?? `solo#${solo++}`;
		if (!cur || cur.key !== key) {
			cur = { key, blocks: [], removable: b.messageKey !== undefined };
			msgs.push(cur);
		}
		cur.blocks.push(b);
		if (!isDurableId(b.id) || excluded.has(b.id) || !isRemovable(b)) cur.removable = false;
	}
	return msgs;
}

/**
 * Split a contiguous run of removable messages into PAIR-BALANCED sub-runs: every tool_call's
 * result and every tool_result's call must sit inside the same sub-run (matching applyPlan's
 * fixpoint, computed per run — conservative: never books more than the applier removes). Straggler
 * messages split the run; the survivors re-check until stable.
 */
function balancedSubruns(run: MsgGroup[]): MsgGroup[][] {
	let runs = [run];
	for (let changed = true; changed; ) {
		changed = false;
		const next: MsgGroup[][] = [];
		for (const r of runs) {
			const calls = new Set<string>();
			const results = new Set<string>();
			for (const g of r) {
				for (const b of g.blocks) {
					if (!b.callId) continue;
					if (b.kind === "tool_call") calls.add(b.callId);
					else if (b.kind === "tool_result") results.add(b.callId);
				}
			}
			const straggler = (g: MsgGroup): boolean =>
				g.blocks.some(
					(b) =>
						(b.kind === "tool_call" && b.callId !== undefined && !results.has(b.callId)) ||
						(b.kind === "tool_result" && b.callId !== undefined && !calls.has(b.callId)),
				);
			let cur: MsgGroup[] = [];
			for (const g of r) {
				if (straggler(g)) {
					changed = true;
					if (cur.length) next.push(cur);
					cur = [];
				} else {
					cur.push(g);
				}
			}
			if (cur.length) next.push(cur);
		}
		runs = next;
	}
	return runs;
}

/**
 * Run the monotone hard-cap floor — the budget GUARANTEE (conditional on the irreducible floor
 * fitting). `projected` is the live-token projection after the reversible ladder. `currentTokens`
 * maps every block id to its CURRENT contribution. `laddered` is the set of ids the ladder
 * substituted via `replace`. `excluded` is the hard root set. `isFoldable` gates stage-1 digest
 * deepening; `isRemovable` gates stage-2/3 whole-message group/drop membership.
 */
export function hardCapFloor(
	view: ViewBlock[],
	cap: number,
	projected: number,
	currentTokens: Map<string, number>,
	laddered: Set<string>,
	excluded: Set<string>,
	isFoldable: (b: ViewBlock) => boolean,
	isRemovable: (b: ViewBlock) => boolean,
): FloorResult {
	const foldIds: string[] = [];
	const downgraded: string[] = [];
	const groups: GroupCommand[] = [];
	const dropped: string[] = [];
	const regrouped: string[] = [];

	const forcedFold = new Set<string>();
	const contribution = (b: ViewBlock): number =>
		forcedFold.has(b.id) ? b.foldedTokens : currentTokens.get(b.id) ?? b.tokens;

	// Stage 1: deepen the biggest reducible block to its engine digest. Reversible. Repeat.
	for (;;) {
		if (projected <= cap) break;
		let best: ViewBlock | null = null;
		let bestSaving = 0;
		for (const b of view) {
			if (forcedFold.has(b.id) || excluded.has(b.id)) continue;
			if (!isFoldable(b)) continue;
			const saving = contribution(b) - b.foldedTokens;
			if (saving > bestSaving) {
				best = b;
				bestSaving = saving;
			}
		}
		if (!best || bestSaving <= 0) break;
		forcedFold.add(best.id);
		if (laddered.has(best.id)) downgraded.push(best.id);
		else foldIds.push(best.id);
		projected -= bestSaving;
	}

	if (projected <= cap) return { foldIds, downgraded, groups, dropped, regrouped, projected };

	// Stages 2/3 share the message model. `spent` marks message keys already committed to a group
	// or already tried and found unusable — either way the search advances (monotone, terminates).
	const messages = toMessages(view, excluded, isRemovable);

	/** The oldest balanced run of ≥ minMsgs unspent removable messages, or null. */
	const oldestBalancedRun = (spent: Set<string>, minMsgs: number): MsgGroup[] | null => {
		let raw: MsgGroup[] = [];
		const flush = (): MsgGroup[] | null => {
			if (!raw.length) return null;
			const candidates = balancedSubruns(raw);
			for (const sub of candidates) if (sub.length >= minMsgs) return sub;
			// Nothing usable in this raw run — mark it all tried so the search moves past it.
			for (const g of raw) spent.add(g.key);
			raw = [];
			return null;
		};
		for (const g of messages) {
			if (g.removable && !spent.has(g.key)) {
				raw.push(g);
			} else if (raw.length) {
				const found = flush();
				if (found) return found;
			}
		}
		return flush();
	};

	// Stage 2: still over → force-GROUP the oldest balanced run (default digest — reversible).
	{
		const spent = new Set<string>();
		for (;;) {
			if (projected <= cap) break;
			const run = oldestBalancedRun(spent, 2);
			if (!run) break;
			for (const g of run) spent.add(g.key); // committed → monotone
			const blocks = run.flatMap((g) => g.blocks);
			let runLive = 0;
			for (const b of blocks) runLive += contribution(b);
			const saving = runLive - groupHeadCost(blocks);
			if (saving <= 0) continue;
			groups.push({ kind: "group", ids: blocks.map((b) => b.id) });
			for (const b of blocks) regrouped.push(b.id);
			projected -= saving;
		}
	}

	// Stage 3 (last resort): still over → DROP the oldest balanced run (group digest:null).
	{
		const grouped = new Set(regrouped);
		const spent = new Set<string>();
		// A message already committed to a stage-2 group is spent for stage 3 too.
		for (const g of messages) if (g.blocks.some((b) => grouped.has(b.id))) spent.add(g.key);
		for (;;) {
			if (projected <= cap) break;
			const run = oldestBalancedRun(spent, 1);
			if (!run) break;
			for (const g of run) spent.add(g.key);
			const blocks = run.flatMap((g) => g.blocks);
			let runLive = 0;
			for (const b of blocks) {
				runLive += contribution(b);
				dropped.push(b.id);
				regrouped.push(b.id);
			}
			groups.push({ kind: "group", ids: blocks.map((b) => b.id), digest: null });
			projected -= runLive; // dropped content contributes nothing
			if (runLive <= 0) break; // guard against a zero-saving stall
		}
	}

	return { foldIds, downgraded, groups, dropped, regrouped, projected };
}
