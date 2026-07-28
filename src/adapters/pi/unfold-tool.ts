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
	codes: Type.Array(Type.String(), {
		description: "One or more fold codes from {#<code> FOLDED} tags in your context (bare code or the full tag).",
	}),
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
			"Return the ORIGINAL content of one or more folded context blocks, identified by the short " +
			"code in their {#<code> FOLDED} tag. Read-only: the blocks stay folded in your standing " +
			"context. For a large folded result (an L0 pointer), pass grep=<term> or lines=<a-b> to pull " +
			"just the slice you need instead of the whole thing — the full text is on disk in the spool.",
		promptSnippet: "recall({codes, grep?, lines?}) — read folded content whole, or by grep/line-range, without un-folding it.",
		promptGuidelines: [
			"When you see a {#<code> FOLDED} marker and need original detail, call recall with that code.",
			"For a big folded result, prefer recall {code} grep=<term> or lines=<a-b> to fetch only the part you need.",
			"recall is a one-shot read; the block stays folded. Use unfold to keep the whole block expanded.",
		],
		parameters: RECALL_PARAMS,
		async execute(_toolCallId, params) {
			const { matches, missing, errors } = engine.resolveRecall(params.codes, { grep: params.grep, lines: params.lines });
			const body = matches.map((m) => `=== ${m.code} (${m.label})${m.note ? ` — ${m.note}` : ""} ===\n${m.text}`).join("\n\n");
			const header = summarize(matches, missing, errors);
			const text = matches.length ? `${header}\n\n${body}` : header || "No codes provided.";
			return {
				content: [{ type: "text", text }],
				details: { recalled: matches.map((m) => m.code), missing, errors: errors.map((e) => e.code) },
			};
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
			onUnfold?.(matches.flatMap((m) => m.ids)); // persist the unfold so it survives resume (P3.1)
			const text = matches.length
				? `${summarize(matches, missing)}\n\nExpanded ${matches.length} block(s); full content returns on your next turn.`
				: summarize(matches, missing) || "No codes provided.";
			return { content: [{ type: "text", text }], details: { unfolded: matches.map((m) => m.code), missing } };
		},
	});
}
