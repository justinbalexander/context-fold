/*
 * digest-writer.ts — the Phase-2 model-driven digest writer (portable, harness-agnostic).
 *
 * Keel still decides WHICH blocks are cold; this writer only produces a higher-quality digest
 * STRING for them. It calls an OpenAI-compatible chat endpoint (Lemonade by default) once per cold
 * block — one block per call is the robust format for small local models (the whole response IS the
 * digest; no fragile multi-block parsing). Calls run in parallel and are bounded per epoch.
 *
 * Every result is validated; anything empty/over-long/degenerate is dropped so the caller falls
 * back to the deterministic engine digest for that block. The writer therefore can only ever
 * IMPROVE digests, never break folding — model quality is a dial, not a dependency.
 *
 * Reversibility is unaffected: the caller prepends the authoritative `{#code FOLDED}` tag, so the
 * agent can still unfold/recall the ORIGINAL. The model text is only the human-readable body.
 */

/** One cold block to digest. `text` is the full original content. */
export interface DigestRequest {
	id: string;
	kind: string;
	toolName?: string;
	text: string;
}

export interface DigestWriterConfig {
	/** OpenAI-compatible base, e.g. "http://localhost:13305/api/v1". */
	baseUrl: string;
	/** Model id, e.g. "Qwen3-Coder-30B-A3B-Instruct-GGUF". */
	model: string;
	apiKey: string;
	/** Cap on cold blocks digested per epoch (bounds the model call count). */
	maxBlocks: number;
	/** Max output tokens per digest. */
	maxOutputTokens: number;
	/** Reject (→ fallback) a digest longer than this many chars. */
	maxDigestChars: number;
	/** Truncate a block's input text to this many chars (head+tail) before sending. */
	maxInputChars: number;
	/** Per-call timeout (ms). */
	timeoutMs: number;
	/**
	 * Max concurrent in-flight calls. A small local model served with a small context window splits
	 * its KV budget across only a few parallel slots, so bursting all maxBlocks at once overflows
	 * them (→ HTTP 400 → fallback). Keep this at/below the server's slot count, and leave room for
	 * the relevance judge that fires at the same epoch. Default 2 is safe for a ~4096-token window.
	 */
	concurrency: number;
	/**
	 * Disable hybrid-reasoning models' "thinking" pass (sends `chat_template_kwargs.enable_thinking
	 * = false`). REQUIRED for Qwen3.x thinking models on a digest job — otherwise they burn the whole
	 * output budget on hidden reasoning and return empty content. Harmless for non-thinking models.
	 */
	disableThinking: boolean;
}

export const DEFAULT_WRITER_CONFIG: Omit<DigestWriterConfig, "baseUrl" | "model"> = {
	apiKey: "sk-local",
	// Decode-bound (~35 tok/s on the 9B): an epoch fires up to maxBlocks digests with only ~2-3
	// server parallel slots, so block count drives epoch latency (8 blocks ≈ 3.5s background work).
	maxBlocks: 8,
	// Real digests self-stop at ~20-25 tokens; the cap only bounds the rare rambler.
	maxOutputTokens: 48,
	maxDigestChars: 400,
	// Kept well under the model's context cap (≈1500 in + system + output).
	maxInputChars: 6_000,
	timeoutMs: 30_000,
	// Safe for a ~4096-token window (server handles ~3 concurrent large prompts; the judge takes one).
	concurrency: 2,
	disableThinking: true,
};

const SYSTEM_PROMPT =
	"You compress one context block into a single terse line so a coding agent can recognize it " +
	"later and decide whether to unfold it. Keep exact identifiers verbatim: file paths, function " +
	"and variable names, commands, error strings, and numbers. Drop filler. Output ONLY the " +
	"one-line digest — no preamble, no quotes, no markdown.";

/** A model digest writer. Returns id → digest body (NO fold tag); omits any block it couldn't digest. */
export interface DigestWriter {
	write(blocks: DigestRequest[], signal?: AbortSignal): Promise<Map<string, string>>;
}

/** Minimal fetch shape so the writer is testable with an injected fetch. */
export type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** Build a fetch-based writer against an OpenAI-compatible chat endpoint. */
export function fetchDigestWriter(cfg: DigestWriterConfig, fetchImpl?: FetchLike): DigestWriter {
	const doFetch: FetchLike = fetchImpl ?? ((globalThis as any).fetch as FetchLike);
	const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;

	async function one(block: DigestRequest, signal?: AbortSignal): Promise<string | null> {
		const body: Record<string, unknown> = {
			model: cfg.model,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: renderBlock(block, cfg.maxInputChars) },
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
			if (!res.ok) return null;
			const json = await res.json();
			const raw = json?.choices?.[0]?.message?.content;
			return cleanDigest(typeof raw === "string" ? raw : "", block, cfg.maxDigestChars);
		} catch {
			return null; // network error / timeout / abort → fall back to deterministic digest
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onParentAbort);
		}
	}

	return {
		async write(blocks, signal) {
			const targets = blocks.slice(0, cfg.maxBlocks);
			const out = new Map<string, string>();
			// Process in waves of `concurrency` so a small-context server's parallel slots aren't
			// overrun (bursting all calls at once → HTTP 400 on a ~4096-token window).
			const width = Math.max(1, cfg.concurrency);
			for (let i = 0; i < targets.length; i += width) {
				const wave = targets.slice(i, i + width);
				const settled = await Promise.allSettled(wave.map((b) => one(b, signal)));
				settled.forEach((r, k) => {
					if (r.status === "fulfilled" && r.value) out.set(wave[k].id, r.value);
				});
			}
			return out;
		},
	};
}

// ── pure helpers (exported for tests) ────────────────────────────────────────

/** Render a block as the user-message body, truncating very long content head+tail. */
export function renderBlock(b: DigestRequest, maxInputChars: number): string {
	const head = `${b.kind}${b.toolName ? ` ${b.toolName}` : ""}: `;
	const text = truncateMiddle(b.text, maxInputChars);
	return head + text;
}

function truncateMiddle(s: string, max: number): string {
	if (s.length <= max) return s;
	const half = Math.floor((max - 20) / 2);
	// Don't split a surrogate pair at either cut (a lone surrogate can break JSON transport).
	let headEnd = half;
	const hc = s.charCodeAt(headEnd - 1);
	if (hc >= 0xd800 && hc <= 0xdbff) headEnd--;
	let tailStart = s.length - half;
	const tc = s.charCodeAt(tailStart);
	if (tc >= 0xdc00 && tc <= 0xdfff) tailStart++;
	return `${s.slice(0, headEnd)}\n…[${tailStart - headEnd} chars elided]…\n${s.slice(tailStart)}`;
}

/**
 * Clean + validate a model digest. Returns null (→ caller falls back) when the output is empty,
 * over-long, or a degenerate echo of the block header (a weak model just repeating the input).
 */
export function cleanDigest(raw: string, block: DigestRequest, maxChars: number): string | null {
	let s = raw.replace(/\s+/g, " ").trim();
	// Strip surrounding quotes/backticks a model sometimes wraps the line in.
	s = s.replace(/^["'`]+/, "").replace(/["'`]+$/, "").trim();
	if (s.length < 3) return null;
	if (s.length > maxChars) return null;
	// Reject a digest that is just the kind/toolName header echoed back with nothing learned.
	const headerEcho = `${block.kind}${block.toolName ? ` ${block.toolName}` : ""}`.toLowerCase();
	if (s.toLowerCase() === headerEcho || s.toLowerCase() === `${headerEcho} read`) return null;
	return s;
}
