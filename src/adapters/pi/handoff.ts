/*
 * handoff.ts — `/fold-handoff`: the A-layer as an EXPLICIT OPT-IN, never automatic.
 *
 * Produces a handoff seed for a fresh session: the deterministic seed index first (ground truth,
 * same renderer as det compaction), the user's stated goal, and — only when a model is reachable —
 * a narrative summary clearly marked untrusted. The degradation warning leads the file: the
 * evidence base (JetBrains, Self-Compacting, Factory.ai probes, claude-code #46602) is that
 * summaries lose exactly the details that matter, so the narrative is a convenience layered on
 * a deterministic floor, not the floor itself.
 *
 * The seed is WRITTEN TO DISK in the session directory and its path reported — nothing is
 * injected into context, nothing fires on its own.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderDetCompactionSummary } from "./compact";
import type { SeedIndexStore } from "./index-store";

const WARNING = [
	"> ⚠ Model summaries degrade context (measured): exact identifiers, error strings, and",
	"> buried numbers are the first casualties, and a summary can even fabricate. The",
	"> deterministic index below is ground truth extracted verbatim; treat any narrative",
	"> section as untrusted and verify its claims against the index, spool, and repo.",
].join("\n");

/** Assemble the handoff seed (pure). `narrative` is the optional model-written section. */
export function buildHandoffSeed(opts: {
	goal: string;
	indexBody: string;
	narrative: string | null;
	at: string;
}): string {
	const parts = [
		`# Session handoff seed — ${opts.at}`,
		"",
		WARNING,
		"",
		"## Goal for the next session",
		opts.goal.trim() || "(not stated — set one before starting the new session)",
		"",
		opts.indexBody,
	];
	if (opts.narrative) {
		parts.push("", "## Narrative summary (model-written, UNTRUSTED — verify before relying on it)", opts.narrative.trim());
	} else {
		parts.push("", "_No model narrative (none configured/reachable). The deterministic seed above is the recommended form._");
	}
	return parts.join("\n");
}

interface HandoffCtx {
	ui?: { notify?(msg: string, level?: string): void };
	model?: unknown;
	modelRegistry?: {
		getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; env?: unknown; error?: string }>;
	};
	sessionManager: {
		getSessionDir(): string;
		getSessionId(): string;
		getEntries(): unknown[];
	};
}

export function registerHandoffCommand(
	pi: ExtensionAPI,
	deps: { indexFor(ctx: HandoffCtx): SeedIndexStore; spoolDirFor(ctx: HandoffCtx): string },
): void {
	pi.registerCommand("fold-handoff", {
		description:
			"Write a handoff seed for a fresh session: deterministic seed index + optional model summary (opt-in, with degradation warning). Usage: /fold-handoff <goal for the next session>",
		handler: async (args, cmdCtx) => {
			const ctx = cmdCtx as unknown as HandoffCtx;
			const notify = (msg: string, level = "info") => ctx.ui?.notify?.(msg, level);
			try {
				const index = deps.indexFor(ctx);
				const indexBody = renderDetCompactionSummary({
					records: index.readAll(),
					spoolDir: deps.spoolDirFor(ctx),
				});
				const narrative = await tryNarrative(ctx);
				const seed = buildHandoffSeed({
					goal: typeof args === "string" ? args : "",
					indexBody,
					narrative,
					at: new Date().toISOString(),
				});
				const out = join(ctx.sessionManager.getSessionDir(), `handoff-${ctx.sessionManager.getSessionId()}.md`);
				writeFileSync(out, seed, "utf8");
				notify(
					`handoff seed written: ${out}\nReview it, start a fresh session (/new), and paste or reference it there.${narrative ? "" : " (deterministic only — no model narrative)"}`,
					"info",
				);
			} catch (err) {
				notify(`fold-handoff failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

/** One model-written narrative, using the SESSION's active model — or null on any failure.
 *  Never throws, never blocks the deterministic seed. */
async function tryNarrative(ctx: HandoffCtx): Promise<string | null> {
	try {
		if (!ctx.model || !ctx.modelRegistry) return null;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) return null;
		// Lazy imports keep the deterministic path free of model machinery (and make the whole
		// narrative feature degrade to null when the compat surface is unavailable, e.g. in tests).
		// The published type surface lags the runtime exports (the loader injects bundled virtual
		// modules), so the shapes are asserted structurally and guarded before use.
		const [compatMod, agentMod] = await Promise.all([
			import("@earendil-works/pi-ai/compat") as Promise<unknown>,
			import("@earendil-works/pi-coding-agent") as Promise<unknown>,
		]);
		const { complete } = compatMod as {
			complete?: (model: unknown, req: unknown, opts: unknown) => Promise<unknown>;
		};
		const { convertToLlm, serializeConversation } = agentMod as {
			convertToLlm?: (messages: unknown) => unknown;
			serializeConversation?: (messages: unknown) => string;
		};
		if (!complete || !convertToLlm || !serializeConversation) return null;
		const messages = (ctx.sessionManager.getEntries() as { type?: string; message?: unknown }[])
			.filter((e) => e.type === "message" && e.message)
			.map((e) => e.message);
		if (messages.length === 0) return null;
		const conversation = serializeConversation(convertToLlm(messages)).slice(-100_000);
		const response = await complete(
			ctx.model,
			{
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text:
									"Summarize this session for a handoff to a fresh session: goals, decisions and their rationale, " +
									"current state, blockers, and next steps. Keep exact file paths, commands, error strings, and " +
									"identifiers VERBATIM — never paraphrase them.\n\n<conversation>\n" +
									conversation +
									"\n</conversation>",
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env as never, maxTokens: 4096 },
		);
		const text = (response as { content?: { type: string; text?: string }[] }).content
			?.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("\n");
		return text?.trim() ? text.trim() : null;
	} catch {
		return null;
	}
}
