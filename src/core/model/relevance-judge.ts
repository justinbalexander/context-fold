/*
 * relevance-judge.ts — the Phase-2 rep-2 model relevance judge (portable, harness-agnostic).
 *
 * Given what the agent is working on right now (the protected-tail text) and a list of older
 * cold-zone blocks that are about to be folded, the model returns which of them are STILL RELEVANT
 * and should be kept in full ("keep warm"). One call per epoch — the whole candidate list goes in
 * one prompt (each is just a one-line preview), so it is cheap.
 *
 * Output is parsed leniently (numbers, comma/space separated) and validated to in-range indices;
 * any junk or a failed call yields an EMPTY keep set, which makes the conductor behave exactly like
 * deterministic Keel. The judge can therefore only ever ADD protection, never break folding.
 */

export interface JudgeCandidate {
	id: string;
	kind: string;
	toolName?: string;
	/** A one-line preview of the block (first non-blank line, clipped). */
	preview: string;
}

export interface RelevanceJudgeConfig {
	baseUrl: string;
	model: string;
	apiKey: string;
	/** Cap on candidates judged per call. */
	maxCandidates: number;
	/** Truncate the "current work" tail text to this many chars. */
	maxTailChars: number;
	maxOutputTokens: number;
	timeoutMs: number;
	/** Disable hybrid-reasoning thinking (see digest-writer). */
	disableThinking: boolean;
}

export const DEFAULT_JUDGE_CONFIG: Omit<RelevanceJudgeConfig, "baseUrl" | "model"> = {
	apiKey: "sk-local",
	maxCandidates: 24,
	// The judge's output is just a list of numbers (~1.8s, ~27 tok); a small cap keeps it snappy.
	maxTailChars: 3_000,
	maxOutputTokens: 64,
	timeoutMs: 30_000,
	disableThinking: true,
};

const SYSTEM_PROMPT =
	"You decide which OLD context blocks are still relevant to what a coding agent is working on " +
	"RIGHT NOW, so they stay in full while the rest are compressed. Be selective — keep a block only " +
	"if its exact content is likely needed for the current work (same files, symbols, errors, or " +
	"task). Reply with ONLY the numbers of the blocks to keep, comma-separated (e.g. \"2, 5, 6\"). " +
	"If none are clearly relevant, reply exactly \"none\".";

export interface RelevanceJudge {
	/** Returns the subset of candidate ids to KEEP WARM (still relevant). Empty on any failure. */
	judge(tailText: string, candidates: JudgeCandidate[], signal?: AbortSignal): Promise<Set<string>>;
}

import type { FetchLike } from "./digest-writer";
export type { FetchLike };

export function fetchRelevanceJudge(cfg: RelevanceJudgeConfig, fetchImpl?: FetchLike): RelevanceJudge {
	const doFetch: FetchLike = fetchImpl ?? ((globalThis as any).fetch as FetchLike);
	const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;

	return {
		async judge(tailText, candidates, signal) {
			const list = candidates.slice(0, cfg.maxCandidates);
			if (list.length === 0) return new Set();

			const body: Record<string, unknown> = {
				model: cfg.model,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: buildPrompt(tailText, list, cfg.maxTailChars) },
				],
				max_tokens: cfg.maxOutputTokens,
				temperature: 0,
				stream: false,
			};
			if (cfg.disableThinking) body.chat_template_kwargs = { enable_thinking: false };

			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
			const onParentAbort = () => ctrl.abort();
			signal?.addEventListener("abort", onParentAbort);
			try {
				const res = await doFetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
					body: JSON.stringify(body),
					signal: ctrl.signal,
				});
				if (!res.ok) return new Set();
				const json = await res.json();
				const raw = json?.choices?.[0]?.message?.content;
				return parseKeep(typeof raw === "string" ? raw : "", list);
			} catch {
				return new Set();
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onParentAbort);
			}
		},
	};
}

// ── pure helpers (exported for tests) ────────────────────────────────────────

export function buildPrompt(tailText: string, candidates: JudgeCandidate[], maxTailChars: number): string {
	const tail = tailText.length > maxTailChars ? "…" + tailText.slice(-maxTailChars) : tailText;
	const lines = candidates.map((c, i) => `[${i + 1}] ${c.kind}${c.toolName ? ` ${c.toolName}` : ""}: ${c.preview}`);
	return [
		"CURRENT WORK (most recent context):",
		tail || "(none)",
		"",
		"OLDER BLOCKS (compression candidates):",
		...lines,
		"",
		`Which of blocks 1–${candidates.length} are still relevant to the current work? Numbers only, or "none".`,
	].join("\n");
}

/** Parse a lenient "2, 5, 6" / "none" reply into the kept candidate ids (in-range indices only). */
export function parseKeep(raw: string, candidates: JudgeCandidate[]): Set<string> {
	const out = new Set<string>();
	// A reply that LEADS with "none" is a negative even when an explanation with digits follows
	// ("None. Blocks 1-3 were already compressed") — don't let the digit scan invert it.
	if (/^\s*["'`]?\s*none\b/i.test(raw)) return out;
	if (/\bnone\b/i.test(raw) && !/\d/.test(raw)) return out;
	// Take only the part after the last newline-free run of numbers? No — just scan all integers,
	// but ignore obviously-out-of-range ones. A thinking-leak with huge numbers is filtered by range.
	for (const m of raw.matchAll(/\d+/g)) {
		const n = Number(m[0]);
		if (n >= 1 && n <= candidates.length) out.add(candidates[n - 1].id);
	}
	return out;
}
