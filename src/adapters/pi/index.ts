/*
 * index.ts — the context-fold Pi/Willow extension entry point.
 *
 * Wires the deterministic Keel policy into Pi's per-turn `context` hook: before every model call
 * Pi hands us a deep copy of the outgoing message array; we replace the content of cold blocks
 * with short reversible digests and return it. The real session history is never touched — folding
 * lives only in the outgoing copy. The agent pulls any folded block back with the `unfold`/`recall`
 * tools by its `{#<code> FOLDED}` handle.
 *
 * Phases (all opt-in via env; default install is the deterministic Phase-1 path):
 *   • CONTEXTFOLD_MODEL=<id|1>   — Phase 2 rep 1: a local model writes the cold-zone digests.
 *   • CONTEXTFOLD_COLDNESS=1     — Phase 2 rep 2: the model also decides which cold blocks stay warm.
 * Fully autonomous (no UI prompts) — runs identically headless.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage as CoreAgentMessage } from "../../core/block";
import type { Conductor } from "../../core/contract";
import { KeelConductor } from "../../core/policy/keel";
import { ModelConductor } from "../../core/policy/model";
import { ContextFoldEngine, type FoldConfig } from "./store";
import { registerFoldTools } from "./unfold-tool";
import { fetchDigestWriter, DEFAULT_WRITER_CONFIG, type DigestWriter } from "../../core/model/digest-writer";
import { fetchRelevanceJudge, DEFAULT_JUDGE_CONFIG, type RelevanceJudge } from "../../core/model/relevance-judge";
import { MapGateRegistry } from "../../core/gate-registry";
import { Gate, gateConfigFromEnv, gateModelIdentity } from "./gate";
import { SpoolStore } from "./spool";
import { recordGateFold, recordUnfold, restoreFoldState, revalidateSpools } from "./persistence";
import { spoolRetainMsFromEnv, sweepSpools } from "./retention";
import { CacheTelemetry } from "./cache-telemetry";

// Qwen3.5-4B-MTP: benchmarked against the 9B for this task — 3.3× faster decode (~116 tok/s via
// multi-token prediction), identical digest quality (100% buried-identifier retention), and lighter
// to keep permanently loaded (3.4 GB). Hybrid-reasoning, so thinking is disabled by default.
const DEFAULT_MODEL = "Qwen3.5-4B-MTP-GGUF";

// ≤6 lines. Teaches the L0 pointer contract; positive framing (says when to reach for recall).
const L0_TEACHING = [
	"Context note: large tool results in your context may appear folded to a short `{#<code> FOLDED}` pointer that keeps the head, tail, and any error/risk lines. The full result is preserved on disk.",
	"When you need detail a pointer does not show, call `recall {code}` for the whole result, or `recall {code} grep=<term>` / `recall {code} lines=<a-b>` to pull just the slice you need.",
	"Reach for `unfold {code}` when you want a folded result kept expanded across your next turns.",
].join("\n");

import { configFromEnv } from "./config";
export { configFromEnv };

/** Shared model connection from env, or null when no model is configured (pure Phase 1). */
function modelConnFromEnv(): { baseUrl: string; model: string; apiKey: string; disableThinking: boolean } | null {
	const raw = process.env.CONTEXTFOLD_MODEL?.trim();
	// COLDNESS implies a model even if CONTEXTFOLD_MODEL is just a flag; both default to DEFAULT_MODEL.
	const coldness = process.env.CONTEXTFOLD_COLDNESS === "1" || process.env.CONTEXTFOLD_COLDNESS === "true";
	if (!raw && !coldness) return null;
	const model = !raw || raw === "1" || raw === "on" || raw === "true" ? DEFAULT_MODEL : raw;
	const baseUrl = process.env.CONTEXTFOLD_MODEL_URL?.trim() || "http://localhost:13305/api/v1";
	const apiKey = process.env.CONTEXTFOLD_MODEL_KEY?.trim() || DEFAULT_WRITER_CONFIG.apiKey;
	// Thinking is OFF by default (the default model is a hybrid reasoning model). CONTEXTFOLD_MODEL_THINK=1 re-enables.
	const think = process.env.CONTEXTFOLD_MODEL_THINK === "1" || process.env.CONTEXTFOLD_MODEL_THINK === "true";
	return { baseUrl, model, apiKey, disableThinking: !think };
}

export default function contextFold(pi: ExtensionAPI): void {
	// MASTER kill switch: CONTEXTFOLD=0/off/false disables the whole extension — no hooks, no
	// tools, no folding — without touching the install symlink. The one-session escape hatch for
	// a live folding incident (CONTEXTFOLD_L0 gates only the ingestion gate).
	const master = process.env.CONTEXTFOLD?.trim().toLowerCase();
	if (master === "0" || master === "off" || master === "false") {
		process.stderr.write("[context-fold] disabled by CONTEXTFOLD=0 — no folding this session\n");
		return;
	}
	const conn = modelConnFromEnv();
	const wantDigests = !!process.env.CONTEXTFOLD_MODEL?.trim() && !!conn;
	const wantColdness = (process.env.CONTEXTFOLD_COLDNESS === "1" || process.env.CONTEXTFOLD_COLDNESS === "true") && !!conn;

	const maxBlocks = Number(process.env.CONTEXTFOLD_MODEL_MAXBLOCKS);
	const concurrency = Number(process.env.CONTEXTFOLD_MODEL_CONCURRENCY);
	const writer: DigestWriter | null = wantDigests
		? fetchDigestWriter({
				...DEFAULT_WRITER_CONFIG,
				...conn!,
				maxBlocks: Number.isFinite(maxBlocks) && maxBlocks > 0 ? maxBlocks : DEFAULT_WRITER_CONFIG.maxBlocks,
				concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : DEFAULT_WRITER_CONFIG.concurrency,
			})
		: null;
	const judge: RelevanceJudge | null = wantColdness ? fetchRelevanceJudge({ ...DEFAULT_JUDGE_CONFIG, ...conn! }) : null;
	const policy: Conductor = wantColdness ? new ModelConductor() : new KeelConductor();

	// ── L0 ingestion gate: registry (shared with the engine) + lazy per-session spool store ──────
	const registry = new MapGateRegistry();
	const engine = new ContextFoldEngine(policy, configFromEnv(), writer, judge, registry);

	const debug = process.env.CONTEXTFOLD_DEBUG === "1" || process.env.CONTEXTFOLD_DEBUG === "true";
	const dumpPath = process.env.CONTEXTFOLD_DUMP?.trim() || null;
	const telemetry = new CacheTelemetry();

	let spool: SpoolStore | null = null;
	let spoolKey = "";
	let activeModelIdentity = "unknown";
	let activeGate = false;
	const resolveGate = (model: { id?: string; name?: string; provider?: string } | undefined) => {
		activeModelIdentity = gateModelIdentity(model) ?? "unknown";
		const cfg = gateConfigFromEnv(activeModelIdentity === "unknown" ? undefined : activeModelIdentity);
		activeGate = cfg.enabled;
		return cfg;
	};
	const spoolFor = (ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string } }): SpoolStore => {
		const dir = join(ctx.sessionManager.getSessionDir(), "spool", ctx.sessionManager.getSessionId());
		if (!spool || spoolKey !== dir) {
			spool = new SpoolStore(dir);
			spoolKey = dir;
		}
		return spool;
	};

	// On resume, rebuild the gate registry + unfold set from the session's event-sourced fold ledger
	// (the tool_result hook does not re-fire for results already in history). Revalidate each spool.
	// Keyed by SESSION ID: a session switch inside one process re-restores for the new session and
	// clears the previous session's registry (stale codes must never serve another session's spool).
	let restoredFor = "";
	pi.on("session_start", (_event, ctx) => {
		resolveGate(ctx.model);
		const sid = ctx.sessionManager.getSessionId();
		if (restoredFor === sid) return;
		const isSwitch = restoredFor !== "";
		restoredFor = sid;

		// Spool GC (Phase 6): reap sibling session spools past the retention window. Independent
		// of the restore below — the sweep never touches this session's dir, and the restore only
		// judges this session's own entries.
		const retainMs = spoolRetainMsFromEnv();
		if (retainMs > 0) {
			try {
				const swept = sweepSpools(join(ctx.sessionManager.getSessionDir(), "spool"), sid, retainMs);
				if (debug && swept.reaped.length) {
					process.stderr.write(`[context-fold] spool-gc: reaped ${swept.reaped.length} stale session spool dir(s)\n`);
				}
			} catch (err) {
				process.stderr.write(`[context-fold] spool-gc failed (skipped): ${err instanceof Error ? err.message : String(err)}\n`);
			}
		}

		try {
			if (isSwitch) {
				registry.clear();
				engine.resetForSession();
				telemetry.reset();
			}
			const { gateEntries, unfoldedIds } = restoreFoldState(ctx.sessionManager.getEntries() as unknown as { customType?: string; data?: unknown }[]);
			if (gateEntries.length === 0 && unfoldedIds.size === 0) return;
			const { valid, dropped } = revalidateSpools(gateEntries);
			for (const e of valid) registry.set(e);
			engine.restoreUnfolded(unfoldedIds);
			if (debug) process.stderr.write(`[context-fold] resume: restored ${valid.length} L0 folds, ${unfoldedIds.size} unfolds${dropped.length ? `, dropped ${dropped.length} (missing spool)` : ""}\n`);
		} catch (err) {
			// Fail-open: a restore failure just means prior folds render raw this session — but say so,
			// or the only symptom is silent token creep.
			process.stderr.write(`[context-fold] resume restore failed (folds render raw): ${err instanceof Error ? err.message : String(err)}\n`);
		}
	});

	// OBSERVE-ONLY (D10): spool + register large tool results as they land; never mutate the result
	// (the session jsonl keeps the raw payload — the view-only `context` hook does the substitution).
	pi.on("tool_result", (event, ctx) => {
		const cfg = resolveGate(ctx.model);
		if (!cfg.enabled) return; // kill switch off / model not in the allowlist → fully inert
		try {
			const gate = new Gate(cfg, registry, () => spoolFor(ctx));
			const decision = gate.observe({
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				input: event.input,
				isError: event.isError,
				content: event.content as ReadonlyArray<{ type: string; text?: string }>,
				fullOutputPath: (event as { details?: { fullOutputPath?: string } }).details?.fullOutputPath,
			});
			if (decision.folded) {
				const entry = registry.get(`r:${event.toolCallId}`);
				if (entry) recordGateFold(pi, entry); // event-source the fold for resume (P3.1)
				if (debug) {
					const dup = decision.dedupOf ? ` dedup=#${decision.dedupOf}` : "";
					process.stderr.write(`[context-fold] l0-fold #${decision.code} tool=${event.toolName} ${decision.inTokens}→${decision.outTokens}${dup}\n`);
				}
			}
		} catch (err) {
			// Fail-open: never let the gate break a tool result — but a persistent failure (unwritable
			// spool dir, full disk) must be visible, or every fold silently degrades to no-gating.
			process.stderr.write(`[context-fold] gate error (result flows raw): ${err instanceof Error ? err.message : String(err)}\n`);
		}
	});

	// Teaching text (D40): ≤6 lines telling the agent what the {#code FOLDED} pointers are and how to
	// recall from them. Injected only when the gate is active for the current model, so it is charged
	// to the gated arms and never taxes a baseline run. Positive framing (states when to recall).
	pi.on("before_agent_start", (event, ctx) => {
		if (!resolveGate(ctx.model).enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${L0_TEACHING}` };
	});

	// OBSERVE-ONLY cache telemetry: every finalized assistant message carries real provider
	// usage (cacheRead/cacheWrite). The per-turn hit ratio is the measured signal for whether
	// folding kept the prefix warm — it collapses on the turn after a head-rewriting fold.
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; usage?: Record<string, number> };
		if (message.role !== "assistant" || !message.usage) return;
		telemetry.record(message.usage);
		if (debug) process.stderr.write(`[context-fold] ${telemetry.statusLine()}\n`);
		if (dumpPath) {
			// e2e seam, sibling of the view dump: never change the CONTEXTFOLD_DUMP payload
			// itself (e2e-gate.sh parses it as a message array).
			try {
				writeFileSync(`${dumpPath}.telemetry.json`, JSON.stringify(telemetry.snapshot()), "utf8");
			} catch {
				/* dump is best-effort */
			}
		}
	});

	// The make-or-break hook: rewrite the outgoing context before each model call.
	pi.on("context", (event, ctx) => {
		try {
			// Re-resolve the L0 kill switch per turn against the ACTIVE model: an allowlist change or
			// a mid-session model switch takes effect immediately, and a resumed session with the gate
			// off renders prior folds raw instead of substituting pointers (D20).
			engine.setGateActive(resolveGate(ctx.model).enabled);
			const usage = ctx.getContextUsage();
			const messages = engine.process(event.messages as unknown as CoreAgentMessage[], {
				contextWindow: usage?.contextWindow ?? null,
				tokens: usage?.tokens ?? null,
			});
			// The cast is the documented harness seam (core/block.ts): the core's structural AgentMessage
			// models exactly the fields the bridge reads, and Pi's real AgentMessage satisfies it.
			if (dumpPath) {
				// e2e seam: dump the outgoing view so the harness can assert the pointer replaced the payload.
				try {
					writeFileSync(dumpPath, JSON.stringify(messages), "utf8");
				} catch {
					/* dump is best-effort */
				}
			}
			return { messages: messages as unknown as typeof event.messages };
		} catch (err) {
			// Fail-open like the sibling hooks: an engine defect costs this turn's folding (context
			// goes out raw), never the turn itself. The host also catches, but degrade locally and say so.
			process.stderr.write(`[context-fold] fold pass failed (context sent raw): ${err instanceof Error ? err.message : String(err)}\n`);
			return { messages: event.messages };
		}
	});

	registerFoldTools(pi, engine, (ids) => recordUnfold(pi, ids));

	// A display-only status command (no-op safe in headless mode — pure text).
	pi.registerCommand("context-fold", {
		description: "Report automatic context-fold status (this does not manually trigger a pass).",
		handler: async (_args, cmdCtx) => {
			const s = engine.status;
			const state = s?.text ? s.text : "idle (under budget)";
			const line = `context-fold (automatic): ${state} · L0 ${activeGate ? "on" : "off"} · model ${activeModelIdentity} · ${telemetry.statusLine()}`;
			cmdCtx.ui?.notify?.(line, "info");
		},
	});
}
