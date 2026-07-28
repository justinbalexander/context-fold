/*
 * edges.ts — the reference graph for entity-reachability (mark-and-sweep relevance).
 *
 * A block is eligible to fold-first when it is UNREACHABLE from the roots (protected tail +
 * held + original task). Three bidirectional edge kinds, all derived from the pure view:
 *   1. CAUSAL — tool_call ↔ tool_result sharing a callId.
 *   2. MESSAGE — parts of the SAME assistant message (`a:<anchor>:p<j>` sharing the anchor).
 *   3. ENTITY — blocks whose text shares a distinctive identifier (rarity-guarded).
 *
 * Ported from Accordion `conductors/garbage-collector/edges.ts` (pinned commit 0c22434).
 */
import type { ViewBlock } from "../contract";
import { extractIdentifiers } from "./lexical";

/** The reference graph: block id → set of neighbor block ids. */
export interface RefGraph {
	adj: Map<string, Set<string>>;
}

/**
 * The shared-message key for the MESSAGE edge. Only assistant part ids (`a:<anchor>:p<j>`) share
 * a message — strip the `:p<j>` suffix so parts of the SAME message link. Every other id shape
 * (`u:`/`r:`/`s:`/positional) is a single-block message: return the full id so no edge forms.
 * (The naive "prefix before the first colon" chained every assistant part in the session into one
 * component, so reachability was a constant — the tier never ordered anything.)
 */
function messagePrefix(id: string): string {
	if (id.startsWith("a:")) {
		const m = /^(a:.+):p\d+$/.exec(id);
		if (m) return m[1];
	}
	return id;
}

/** Build the reference graph (causal + message + entity edges, all bidirectional, no self-loops). */
export function buildGraph(blocks: ViewBlock[]): RefGraph {
	const adj = new Map<string, Set<string>>();
	for (const b of blocks) adj.set(b.id, new Set<string>());

	const link = (a: string, b: string): void => {
		if (a === b) return;
		adj.get(a)?.add(b);
		adj.get(b)?.add(a);
	};

	// 1. CAUSAL — group by callId, chain members.
	const byCallId = new Map<string, string[]>();
	for (const b of blocks) {
		if (!b.callId) continue;
		const arr = byCallId.get(b.callId);
		if (arr) arr.push(b.id);
		else byCallId.set(b.callId, [b.id]);
	}
	for (const ids of byCallId.values()) for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i]);

	// 2. MESSAGE — group by id prefix, chain members.
	const byPrefix = new Map<string, string[]>();
	for (const b of blocks) {
		const p = messagePrefix(b.id);
		const arr = byPrefix.get(p);
		if (arr) arr.push(b.id);
		else byPrefix.set(p, [b.id]);
	}
	for (const ids of byPrefix.values()) for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i]);

	// 3. ENTITY — inverted index identifier → block ids; chain the rarity-kept groups.
	const threshold = Math.max(3, Math.floor(blocks.length * 0.25));
	const idToBlocks = new Map<string, string[]>();
	for (const b of blocks) {
		if (b.text === undefined) continue; // wire-shape view without full text → no entity edges
		for (const id of extractIdentifiers(b.text)) {
			const arr = idToBlocks.get(id);
			if (arr) arr.push(b.id);
			else idToBlocks.set(id, [b.id]);
		}
	}
	for (const ids of idToBlocks.values()) {
		if (ids.length <= 1 || ids.length > threshold) continue; // singleton or non-specific
		for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i]);
	}

	return { adj };
}

/** Mark every block reachable from `roots`. Iterative DFS (no stack overflow on long chains). */
export function markReachable(graph: RefGraph, roots: Iterable<string>): Set<string> {
	const marked = new Set<string>();
	const stack: string[] = [];
	for (const r of roots) stack.push(r);
	while (stack.length) {
		const id = stack.pop()!;
		if (marked.has(id)) continue;
		marked.add(id);
		const neigh = graph.adj.get(id);
		if (neigh) for (const n of neigh) if (!marked.has(n)) stack.push(n);
	}
	return marked;
}
