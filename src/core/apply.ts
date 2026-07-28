/*
 * apply.ts — the load-bearing fold-plan applier.
 *
 *   applyPlan(messages, ops, groups) → messages   (the wire rewrites; provider-safe)
 *
 * Content substitution, never structural removal: a folded block stays in the array and keeps
 * its callId, so a tool_call/tool_result pair can never orphan. The only exceptions are
 * group-collapse and group-drop — both whole-message and pair-balanced via the fixpoint below.
 *
 * Returns a NEW array (touched messages cloned; untouched passed by reference). Pure: the
 * caller's array is never mutated. Ported from Accordion `live/mapping.ts:applyPlan`/`foldOne`
 * (pinned commit 0c22434).
 */
import type { AgentMessage, FoldOp, GroupOp } from "./block";
import { blockId, isDurableId, messageInfo } from "./block";

/**
 * Apply one message's in-place FoldOps. Returns the same message by reference when nothing
 * folds; clones lazily otherwise. Kind-guarded so a mis-mapped id can never fold the wrong part:
 * tool_call and any other kind are never folded.
 */
function foldOne(m: AgentMessage, i: number, byId: Map<string, FoldOp>, mark: () => void): AgentMessage {
	if (m.role === "assistant" && Array.isArray(m.content)) {
		let parts: any[] | null = null; // lazily cloned only if we actually fold
		(m.content as any[]).forEach((b, j) => {
			const op = byId.get(blockId(m, i, j));
			if (!op || !op.digestText) return;
			if (b?.type === "text") {
				parts ??= (m.content as any[]).slice();
				parts[j] = { ...b, text: op.digestText };
			} else if (b?.type === "thinking") {
				parts ??= (m.content as any[]).slice();
				parts[j] = { ...b, thinking: op.digestText };
			}
			// tool_call or any other kind → ignored (never fold / id mis-map)
		});
		if (parts) {
			mark();
			return { ...m, content: parts };
		}
		return m;
	}
	if (m.role === "toolResult") {
		const op = byId.get(blockId(m, i));
		if (op && op.digestText) {
			mark();
			return { ...m, content: [{ type: "text", text: op.digestText }] as any };
		}
		return m;
	}
	return m; // user / other: never folded
}

/**
 * Apply a fold plan to the messages and return a NEW array. Two op kinds:
 *
 *   • FoldOp  — in-place content substitution, kind-guarded.
 *   • GroupOp — range collapse: remove a contiguous run of WHOLE messages and insert ONE
 *     synthetic summary (or, with summaryText null, insert nothing — DROP). Two independent
 *     guards, re-derived here defensively: whole+durable, and balanced tool pairs to a fixpoint.
 *
 * On ANY doubt a message passes through untouched; the output is never structurally invalid
 * (no orphaned tool pair, no emptied message).
 */
export function applyPlan(messages: AgentMessage[], ops: FoldOp[], groups: GroupOp[] = []): AgentMessage[] {
	// Defense in depth: refuse any op whose id is NOT durable or whose digest is empty, and any
	// group with no summary/members. Cannot trust the caller's SHAPE, not just values.
	const safeOps = (ops ?? []).filter(
		(o) => o && typeof o.id === "string" && isDurableId(o.id) && typeof o.digestText === "string" && o.digestText,
	);
	const safeGroups = (groups ?? []).filter(
		(g) =>
			g &&
			Array.isArray(g.memberIds) &&
			g.memberIds.length &&
			g.memberIds.every((m) => typeof m === "string") &&
			(g.summaryText === null || (typeof g.summaryText === "string" && g.summaryText.trim())),
	);
	if (!safeOps.length && !safeGroups.length) return messages;

	const byId = new Map(safeOps.map((o) => [o.id, o] as const));

	// ── Phase A: decide which whole messages each group may remove ───────────────
	const owner: (GroupOp | null)[] = new Array(messages.length).fill(null);
	if (safeGroups.length) {
		const memberToGroup = new Map<string, GroupOp>();
		for (const g of safeGroups) for (const id of g.memberIds) if (isDurableId(id)) memberToGroup.set(id, g);
		const infos = messages.map((m, i) => messageInfo(m, i));
		// Initial: a message all of whose emitted ids are durable and members of ONE group.
		for (let i = 0; i < messages.length; i++) {
			const info = infos[i];
			if (!info.ids.length || info.hasNonDurable) continue;
			let g: GroupOp | null = null;
			let ok = true;
			for (const id of info.ids) {
				const gg = memberToGroup.get(id);
				if (!gg || (g && gg !== g)) {
					ok = false;
					break;
				}
				g = gg;
			}
			if (ok && g) owner[i] = g;
		}
		// Fixpoint: keep a removal only if its tool pairs are fully inside the removal set. One
		// pass is not enough — demoting one message can orphan a tool-pair partner elsewhere.
		for (let changedSet = true; changedSet; ) {
			changedSet = false;
			const calls = new Set<string>();
			const results = new Set<string>();
			for (let i = 0; i < messages.length; i++) {
				if (!owner[i]) continue;
				for (const c of infos[i].calls) calls.add(c);
				for (const c of infos[i].results) results.add(c);
			}
			for (let i = 0; i < messages.length; i++) {
				if (!owner[i]) continue;
				const info = infos[i];
				if (info.calls.some((c) => !results.has(c)) || info.results.some((c) => !calls.has(c))) {
					owner[i] = null; // straggler: a tool-pair half is outside → keep this message live
					changedSet = true;
				}
			}
		}
	}

	// ── Phase B: build the output — collapse runs, fold survivors in place ────────
	let changed = false;
	const mark = () => {
		changed = true;
	};
	const out: AgentMessage[] = [];
	for (let i = 0; i < messages.length; ) {
		const g = owner[i];
		if (g) {
			// Consume the maximal consecutive run owned by the SAME group. A group split by an
			// interior straggler yields one entry per surviving sub-run.
			let j = i + 1;
			while (j < messages.length && owner[j] === g) j++;
			if (g.summaryText === null) {
				changed = true; // DROP: consume the run and push nothing
			} else {
				const role = messages[i].role === "assistant" ? "assistant" : "user";
				out.push({ role, content: [{ type: "text", text: g.summaryText }] } as AgentMessage);
				changed = true;
			}
			i = j;
			continue;
		}
		out.push(foldOne(messages[i], i, byId, mark));
		i++;
	}
	return changed ? out : messages;
}
