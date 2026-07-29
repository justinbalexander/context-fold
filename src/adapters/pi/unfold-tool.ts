/*
 * unfold-tool.ts — the agent-facing reversibility surface.
 *
 * Two tools, modeled on Accordion's `unfold`/`recall` split:
 *   • recall(codes) — return the ORIGINAL full content of folded blocks AS a tool result THIS
 *     turn, WITHOUT changing standing context (the blocks stay folded). A read, not a state change.
 *   • unfold(codes) — re-expand folded blocks in the view from the next turn on (sticky). The
 *     content reaches the model at the next `context` hook; we don't echo it here.
 *
 * The agent reads the short `code` from a `{#<code> FOLDED}` tag in its context and passes it back.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextFoldEngine, CodeMatch, CodeError } from "./store";

const CODES_PARAMS = Type.Object({
	codes: Type.Array(Type.String(), {
		description: "One or more fold codes from {#<code> FOLDED} tags in your context (bare code or the full tag).",
	}),
});

/** recall also takes optional partial-retrieval params — query a large folded result, don't dump it. */
const RECALL_PARAMS = Type.Object({
	codes: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Fold codes from {#<code> FOLDED} tags in your context (bare code or the full tag). Omit when using `search` to sweep every folded block at once.",
		}),
	),
	grep: Type.Optional(
		Type.String({
			description: "Return only lines containing this text (case-insensitive). Ideal for pulling one detail out of a large folded result.",
		}),
	),
	lines: Type.Optional(
		Type.String({
			description: 'Return only a line range, 1-based inclusive, e.g. "40-80".',
		}),
	),
	search: Type.Optional(
		Type.String({
			description:
				"Span search: grep EVERY folded block in one call (no codes needed) and get matching lines grouped by code. Use this instead of recalling pointers one by one.",
		}),
	),
});

function summarize(matches: CodeMatch[], missing: string[], errors: CodeError[] = []): string {
	const lines: string[] = [];
	for (const m of matches) lines.push(`✓ ${m.code} — ${m.label}${m.note ? ` · ${m.note}` : ""}`);
	for (const e of errors) lines.push(`⚠ ${e.code} — ${e.message}`);
	for (const code of missing) lines.push(`✗ ${code} — no folded block with that code`);
	return lines.join("\n");
}

export function registerFoldTools(pi: ExtensionAPI, engine: ContextFoldEngine, onUnfold?: (ids: string[]) => void): void {
	pi.registerTool({
		name: "recall",
		label: "Recall folded context",
		description:
			"Return the ORIGINAL content of folded context blocks. Two forms: (1) codes from " +
			"{#<code> FOLDED} tags — whole content, or sliced with grep=<term> / lines=<a-b>; " +
			"(2) search=<term> with no codes — ONE sweep over every folded block, returning matching " +
			"lines grouped by code. Read-only: blocks stay folded. Full text is on disk in the spool.",
		promptSnippet:
			"recall({codes?, grep?, lines?, search?}) — read folded content by code, or span-search ALL folded blocks in one call.",
		promptGuidelines: [
			"Looking for a detail but unsure which folded block holds it? Use recall search=<term> — one call sweeps everything folded.",
			"When you see a {#<code> FOLDED} marker and need that block, call recall with the code; add grep=<term> or lines=<a-b> to fetch only the part you need.",
			"recall is a one-shot read; the block stays folded. Use unfold to keep a block expanded.",
		],
		parameters: RECALL_PARAMS,
		async execute(_toolCallId, params) {
			type RecallDetails = { recalled?: string[]; missing?: string[]; errors?: string[]; searched?: string; hits?: string[] };
			const codes = params.codes ?? [];
			if (params.search && codes.length === 0) {
				const { hits, note } = engine.searchFolded(params.search);
				const body = hits.map((h) => `=== ${h.code} (${h.label}) ===\n${h.lines.join("\n")}`).join("\n\n");
				const text = hits.length
					? `search "${params.search}" — ${note}\n\n${body}`
					: `search "${params.search}" — no matching lines in any folded block (${note})`;
				const details: RecallDetails = { searched: params.search, hits: hits.map((h) => h.code) };
				return { content: [{ type: "text" as const, text }], details };
			}
			if (codes.length === 0) {
				const details: RecallDetails = {};
				return {
					content: [{ type: "text" as const, text: "No codes provided (pass codes, or search=<term> to sweep all folded blocks)." }],
					details,
				};
			}
			// codes + search but no grep: treat search as the slice term for those codes.
			const grep = params.grep ?? params.search;
			const { matches, missing, errors } = engine.resolveRecall(codes, { grep, lines: params.lines });
			const body = matches.map((m) => `=== ${m.code} (${m.label})${m.note ? ` — ${m.note}` : ""} ===\n${m.text}`).join("\n\n");
			const header = summarize(matches, missing, errors);
			const text = matches.length ? `${header}\n\n${body}` : header || "No codes provided.";
			const details: RecallDetails = { recalled: matches.map((m) => m.code), missing, errors: errors.map((e) => e.code) };
			return { content: [{ type: "text" as const, text }], details };
		},
	});

	pi.registerTool({
		name: "unfold",
		label: "Unfold context",
		description:
			"Re-expand one or more folded context blocks back to full content, identified by the short " +
			"code in their {#<code> FOLDED} tag. The full content returns to your context from your next " +
			"turn on (sticky). Use recall instead for a one-time read.",
		promptSnippet: "unfold({codes}) — permanently re-expand folded blocks back to full content.",
		promptGuidelines: [
			"Call unfold with a {#<code> FOLDED} code when you need a folded block's full content for ongoing work.",
			"The expanded content appears on your next turn, not this one.",
		],
		parameters: CODES_PARAMS,
		async execute(_toolCallId, params) {
			const { matches, missing } = engine.markUnfold(params.codes);
			onUnfold?.(matches.flatMap((m) => m.ids)); // persist the unfold so it survives resume
			const text = matches.length
				? `${summarize(matches, missing)}\n\nExpanded ${matches.length} block(s); full content returns on your next turn.`
				: summarize(matches, missing) || "No codes provided.";
			return { content: [{ type: "text", text }], details: { unfolded: matches.map((m) => m.code), missing } };
		},
	});
}
