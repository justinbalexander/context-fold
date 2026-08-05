/*
 * index.ts — the context-fold Pi extension entry point.
 *
 * Wires the folding policy into Pi's per-turn `context` hook: before every model call Pi hands
 * us a deep copy of the outgoing message array; we replace the content of stale blocks with
 * short reversible digests and return it. The real session history is never touched — folding
 * lives only in the outgoing copy. The agent pulls any folded block back with the
 * `unfold`/`recall` tools by its `{#<code> FOLDED}` handle.
 *
 * The policy is the discrete fold ladder: fold events mask stale observations into prefix-stable
 * frozen layers, with a deterministic seed index emitted at every event. No model call ever fires
 * on the automatic path. Fully autonomous (no UI prompts) — runs identically headless.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage as CoreAgentMessage } from "../../core/block";
import { FoldLadderPolicy } from "../../core/policy/fold-ladder";
import { ContextFoldEngine } from "./store";
import { SeedIndexStore, emitFoldIndex, emitCompactIndex } from "./index-store";
import { renderDetCompactionSummary } from "./compact";
import { registerHandoffCommand } from "./handoff";
import { linearize, type WireBlock } from "../../core/block";
import { registerFoldTools } from "./unfold-tool";
import { MapGateRegistry } from "../../core/gate-registry";
import { Gate, gateConfigFromEnv, gateModelIdentity } from "./gate";
import { SpoolStore } from "./spool";
import { recordGateFold, recordLayer, recordUnfold, restoreFoldState, revalidateSpools } from "./persistence";
import { spoolRetainMsFromEnv, sweepSpools, touchHeartbeat } from "./retention";
import { CacheTelemetry, k } from "./cache-telemetry";
import { advise } from "./advisor";

// ≤6 lines. Teaches the L0 pointer contract; positive framing (says when to reach for recall).
const L0_TEACHING = [
	"Context note: large or stale tool results in your context may appear folded to a short `{#<code> FOLDED}` pointer that keeps the head, tail, and any error/risk lines. The full result is preserved on disk.",
	"Looking for a detail but unsure which folded block holds it? `recall search=<term>` sweeps EVERY folded block in one call — prefer it over recalling pointers one by one.",
	"When you need detail from a specific pointer, call `recall {code}` for the whole result, or `recall {code} grep=<term>` / `recall {code} lines=<a-b>` for just the slice you need.",
	"Reach for `unfold {code}` when you want a folded result kept expanded across your next turns.",
].join("\n");

import { adapterConfigFromEnv, configFromEnv } from "./config";
export { adapterConfigFromEnv, configFromEnv };

export default function contextFold(pi: ExtensionAPI): void {
	// MASTER kill switch: CONTEXTFOLD=0/off/false disables the whole extension — no hooks, no
	// tools, no folding — without touching the install symlink. The one-session escape hatch for
	// a live folding incident (CONTEXTFOLD_L0 gates only the ingestion gate).
	const master = process.env.CONTEXTFOLD?.trim().toLowerCase();
	if (master === "0" || master === "off" || master === "false") {
		process.stderr.write("[context-fold] disabled by CONTEXTFOLD=0 — no folding this session\n");
		return;
	}
	const acfg = adapterConfigFromEnv();
	const foldCfg = configFromEnv();
	const ladderPolicy = new FoldLadderPolicy(acfg.ladder);

	// ── L0 ingestion gate: registry (shared with the engine) + lazy per-session spool store ──────
	const registry = new MapGateRegistry();
	const engine = new ContextFoldEngine(ladderPolicy, foldCfg, registry);
	engine.onLayerCommit = (layer) => recordLayer(pi, layer);

	const debug = process.env.CONTEXTFOLD_DEBUG === "1" || process.env.CONTEXTFOLD_DEBUG === "true";
	const dumpPath = process.env.CONTEXTFOLD_DUMP?.trim() || null;
	const telemetry = new CacheTelemetry();

	// ── advisory state (display-only; nothing here gates a turn) ─────────────────────────────────
	let compactions = 0;
	let lastContextWindow: number | null = null;
	let wasCold = false;
	let warnedWireDeferral = false;
	// True when Pi couldn't report a token count this turn (post-compaction window) and the ladder
	// fell back to its chars÷4 liveTokens estimate — /context-fold marks its usage % with `~` there.
	let ctxUsageIsEstimate = false;
	const buildAdvisory = () => {
		const t = telemetry.snapshot();
		const m = engine.status?.metrics ?? {};
		const carried = t.last
			? t.last.cacheRead + t.last.input
			: typeof m.live_tokens === "number"
				? m.live_tokens
				: null;
		return advise({
			turns: t.turns,
			everWarm: t.everWarm,
			lastCacheRead: t.last?.cacheRead ?? 0,
			lastInput: t.last?.input ?? 0,
			carriedTokens: carried,
			contextWindow: lastContextWindow,
			irreducibleFloor: typeof m.irreducible_floor === "number" ? m.irreducible_floor : null,
			reconTokens: acfg.reconTokens,
			recallCalls: engine.recallStats.calls,
			maxRecallsPerCode: engine.recallStats.maxPerCode,
			compactions,
			wireDeferredFolds: t.wireDeferredFolds,
		});
	};

	// The trigger gauge: render whichever ladder condition is actually binding, so the line stays
	// meaningful in every state. Below the entry threshold that IS the threshold ("next fold at
	// 45% ctx"); at or past it the usage gate is permanently satisfied and the real trigger is
	// maskable mass reaching one ladder step, so the gauge tracks that instead — counting up from
	// 0 right after a fold, since interim emptiness refills as new observations land. "No more
	// folds possible" is reserved for the terminal state where the irreducible floor is over
	// budget. Everything comes from the ladder's published metrics (env-configured, cold-branch
	// aware) — never re-derived or hard-coded here.
	const foldGauge = (m: Record<string, unknown>): string | null => {
		if (m.over_budget === true) return "⚠ no more folds possible (over budget)";
		if (typeof m.usage_fraction !== "number" || typeof m.fold_at !== "number") return null;
		if (m.usage_fraction < m.fold_at) return `next fold at ${Math.round(m.fold_at * 100)}% ctx`;
		if (typeof m.maskable_tokens !== "number" || typeof m.step_tokens !== "number") return null;
		return `next fold: ${k(m.maskable_tokens)}/${k(m.step_tokens)} maskable`;
	};

	// Persistent footer status: one keyed line in Pi's footer (TUI renders it below the stats
	// line; headless modes stub setStatus to a no-op). Updated per turn rather than flashed per
	// event — the numbers ticking up ARE the fold notification, with no transcript pollution.
	const updateFooter = (hctx: { ui?: { setStatus?: (key: string, text: string | undefined) => void } }) => {
		const setStatus = hctx.ui?.setStatus?.bind(hctx.ui);
		if (!setStatus) return;
		const s = telemetry.snapshot();
		const parts = [
			s.foldEvents === 0 ? "⧉ context-fold idle" : `⧉ context-fold ×${s.foldEvents} · ~${k(s.foldSavedTokens)} tok masked`,
		];
		const gauge = foldGauge(engine.status?.metrics ?? {});
		if (gauge) parts.push(gauge);
		if (s.hitRatio !== null) parts.push(`cache avg ${Math.round(s.hitRatio * 100)}%`);
		if (s.wireDeferredFolds > 0) parts.push("⚠ folds not on wire");
		setStatus("context-fold", parts.join(" · "));
	};

	let spool: SpoolStore | null = null;
	let spoolKey = "";
	let indexStore: SeedIndexStore | null = null;
	let indexKey = "";
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
	const indexFor = (ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string } }): SeedIndexStore => {
		const dir = join(ctx.sessionManager.getSessionDir(), "spool", ctx.sessionManager.getSessionId());
		if (!indexStore || indexKey !== dir) {
			indexStore = new SeedIndexStore(dir);
			indexKey = dir;
		}
		return indexStore;
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

		// Spool GC: reap sibling session spools past the retention window. Independent
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

		if (isSwitch) {
			registry.clear();
			engine.resetForSession();
			telemetry.reset();
			// Closure-held advisory state is per-session too — stale values would make the new
			// session's first /context-fold report the old session's compactions or cold streak.
			compactions = 0;
			wasCold = false;
			lastContextWindow = null;
			warnedWireDeferral = false;
			ctxUsageIsEstimate = false;
		}
		updateFooter(ctx);

		// Seq continuity across resume: a compact index record claims max(index)+1, and restoring
		// layers alone would floor the engine below it — the next fold event would then reuse that
		// seq and shadow the compaction recovery map (the JSONL contract is latest-per-seq wins).
		// Runs AFTER the switch reset (which zeroes the floor) and regardless of whether any fold
		// ledger exists — a compact record can exist without one.
		try {
			engine.ensureLayerSeqAtLeast(indexFor(ctx).readAll().reduce((m, r) => Math.max(m, r.seq), 0));
		} catch (err) {
			process.stderr.write(`[context-fold] seed-index seq floor skipped: ${err instanceof Error ? err.message : String(err)}\n`);
		}

		try {
			const { gateEntries, unfoldedIds, layers } = restoreFoldState(ctx.sessionManager.getEntries() as unknown as { customType?: string; data?: unknown }[]);
			if (gateEntries.length === 0 && unfoldedIds.size === 0 && layers.length === 0) return;
			const { valid, dropped } = revalidateSpools(gateEntries);
			for (const e of valid) registry.set(e);
			engine.restoreUnfolded(unfoldedIds);
			// Layers restore byte-verbatim — the persisted substitution bytes are replayed rather
			// than recomputed, so a resumed session's context head is byte-identical to the one
			// the provider already cached.
			engine.restoreLayers(layers);
			if (debug)
				process.stderr.write(
					`[context-fold] resume: restored ${valid.length} L0 folds, ${unfoldedIds.size} unfolds, ${layers.length} layers${dropped.length ? `, dropped ${dropped.length} (missing spool)` : ""}\n`,
				);
		} catch (err) {
			// Fail-open: a restore failure just means prior folds render raw this session — but say so,
			// or the only symptom is silent token creep.
			process.stderr.write(`[context-fold] resume restore failed (folds render raw): ${err instanceof Error ? err.message : String(err)}\n`);
		}
	});

	// OBSERVE-ONLY: spool + register large tool results as they land; never mutate the result
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
				if (entry) recordGateFold(pi, entry); // event-source the fold for resume
				if (debug) {
					const dup = decision.dedupOf ? ` dedup=#${decision.dedupOf}` : "";
					process.stderr.write(`[context-fold] l0-fold #${decision.code} tool=${event.toolName} ${decision.inTokens}→${decision.outTokens}${dup}\n`);
				}
			} else if (decision.reason === "error") {
				// Unlike a one-off fold miss, an unavailable spool can silently disable L0 for the
				// rest of the session. Keep the turn fail-open, but make that degraded state visible.
				process.stderr.write(`[context-fold] gate error (result flows raw): ${decision.error ?? "spool write failed"}\n`);
			}
		} catch (err) {
			// Fail-open: never let the gate break a tool result — but a persistent failure (unwritable
			// spool dir, full disk) must be visible, or every fold silently degrades to no-gating.
			process.stderr.write(`[context-fold] gate error (result flows raw): ${err instanceof Error ? err.message : String(err)}\n`);
		}
	});

	// Teaching text: ≤6 lines telling the agent what the {#code FOLDED} pointers are and how to
	// recall from them. Injected only when the gate is active for the current model, so it is charged
	// to the gated arms and never taxes a baseline run. Positive framing (states when to recall).
	pi.on("before_agent_start", (event, ctx) => {
		if (!resolveGate(ctx.model).enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${L0_TEACHING}` };
	});

	// OBSERVE-ONLY cache telemetry: every finalized assistant message carries real provider
	// usage (cacheRead/cacheWrite). The per-turn hit ratio is the measured signal for whether
	// folding kept the prefix warm — it collapses on the turn after a head-rewriting fold.
	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; usage?: Record<string, number> };
		if (message.role !== "assistant" || !message.usage) return;
		telemetry.record(message.usage);
		updateFooter(ctx);
		// Wire watchdog: a fold committed, yet this turn read the whole pre-fold prompt back from
		// cache — the rewrite never reached the provider. Once per session, not per turn.
		if (!warnedWireDeferral && telemetry.snapshot().wireDeferredFolds > 0) {
			warnedWireDeferral = true;
			process.stderr.write(
				"[context-fold] fold committed but not observed on the wire — another extension or the transport is bypassing it (pi-codex-conversion's continuation defers folds to the next user turn)\n",
			);
		}
		if (debug) {
			// The fold-cost half belongs on stderr too, not only in the interactive status command:
			// headless `-p` runs are where fold cost actually gets measured, and there is no command
			// to invoke there.
			const foldCost = telemetry.foldCostLine();
			process.stderr.write(`[context-fold] ${telemetry.statusLine()}${foldCost ? ` · ${foldCost}` : ""}\n`);
		}
		// Cold-session notification: one line at the START of a cold streak, never per-turn nagging.
		const adv = buildAdvisory();
		if (adv.coldNow && !wasCold) {
			const t = telemetry.snapshot();
			const carried = t.last ? t.last.cacheRead + t.last.input : 0;
			if (carried >= 20_000)
				process.stderr.write(
					`[context-fold] session cold — this turn re-billed ~${Math.round(carried / 1000)}k tok as fresh input; consider /new (reconstruction ≈ ${Math.round(acfg.reconTokens / 1000)}k tok via the seed index)\n`,
				);
		}
		wasCold = adv.coldNow;
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
			// Liveness for the GC sweep: mark this session's spool as belonging to a running session,
			// so a quiet-but-live session is not reaped by a sibling's session_start sweep. Throttled
			// internally to once an hour and inert until this session has actually spooled something.
			touchHeartbeat(join(ctx.sessionManager.getSessionDir(), "spool", ctx.sessionManager.getSessionId()));
			// Re-resolve the L0 kill switch per turn against the ACTIVE model: an allowlist change or
			// a mid-session model switch takes effect immediately, and a resumed session with the gate
			// off renders prior folds raw instead of substituting pointers.
			engine.setGateActive(resolveGate(ctx.model).enabled);
			lastContextWindow = ctx.getContextUsage()?.contextWindow ?? lastContextWindow;
			// Ladder cold branch: no live cache read observed after a few turns ⇒ there is no warm
			// prefix to protect, so the ladder folds earlier and more freely (measured, not assumed).
			const t = telemetry.snapshot();
			ladderPolicy.setCold(t.turns >= 3 && t.totals.cacheRead === 0);
			// Fold-event → seed-index emission. Bound per turn so the emitter sees this ctx's stores.
			engine.onFoldEvent = (foldEvent) => {
				// Arm the cache accounting first: the fold's re-prefill cost lands on the very next
				// turn's cacheWrite, and it must be attributed even if index emission then throws.
				const saved = engine.status?.metrics?.tokens_saved;
				telemetry.noteFoldEvent(typeof saved === "number" ? saved : 0);
				try {
					const { record: rec, newEntries } = emitFoldIndex(foldEvent, {
						spool: spoolFor(ctx),
						registry,
						index: indexFor(ctx),
						sessionId: ctx.sessionManager.getSessionId(),
					});
					// Event-source the ladder's spool registrations like L0 folds, so recall-by-code
					// survives resume AND hard compaction (which removes the raw message from history).
					for (const entry of newEntries) recordGateFold(pi, entry);
					if (debug)
						process.stderr.write(
							`[context-fold] seed-index seq=${rec.seq} (${rec.trigger}): ${rec.spans.length} spans, ${rec.identifiers.length} ids, ${rec.errors.length} errors\n`,
						);
				} catch (err) {
					// Fail-open: a lost index record never costs the fold or the turn.
					process.stderr.write(`[context-fold] seed-index emission failed: ${err instanceof Error ? err.message : String(err)}\n`);
				}
			};
			const usage = ctx.getContextUsage();
			ctxUsageIsEstimate = usage?.tokens == null;
			const messages = engine.process(event.messages as unknown as CoreAgentMessage[], {
				contextWindow: usage?.contextWindow ?? null,
				tokens: usage?.tokens ?? null,
			});
			// The cast is the documented harness seam (core/block.ts): the core's structural AgentMessage
			// models exactly the fields the bridge reads, and Pi's real AgentMessage satisfies it.
			updateFooter(ctx); // reflect a fold committed this turn (and the fresh trigger gauge)
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

	// HARD COMPACTION (the hard floor): the automatic path NEVER summarizes with a model. With
	// CONTEXTFOLD_COMPACT=det (default) we hand Pi a deterministic summary rendered verbatim from
	// the seed index — no hallucination surface, every listed token a lexical hook for recall —
	// after emitting one final "compact" index record for the span leaving live history.
	// CONTEXTFOLD_COMPACT=native leaves Pi's own compaction untouched. Fail-open: any error here
	// falls through to Pi's default behavior.
	pi.on("session_before_compact", (event, ctx) => {
		compactions++;
		if (acfg.compact !== "det") return;
		try {
			const prep = (event as { preparation: { messagesToSummarize: unknown[]; turnPrefixMessages: unknown[]; tokensBefore: number; firstKeptEntryId: string; previousSummary?: string } }).preparation;
			const index = indexFor(ctx);
			const blocks = linearize(prep.messagesToSummarize as unknown as CoreAgentMessage[]) as unknown as WireBlock[];
			const compactRecord = emitCompactIndex(blocks, {
				registry,
				index,
				sessionId: ctx.sessionManager.getSessionId(),
				tokensBefore: prep.tokensBefore,
				contextWindow: lastContextWindow,
			});
			// The compact record claimed a seq; the next fold event must start past it.
			engine.ensureLayerSeqAtLeast(compactRecord.seq);
			const summary = renderDetCompactionSummary({
				records: index.readAll(),
				spoolDir: join(ctx.sessionManager.getSessionDir(), "spool", ctx.sessionManager.getSessionId()),
				previousSummary: prep.previousSummary,
			});
			if (debug)
				process.stderr.write(`[context-fold] det compaction: ${prep.tokensBefore} tok summarized deterministically (no model)\n`);
			return { compaction: { summary, firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore } };
		} catch (err) {
			process.stderr.write(
				`[context-fold] det compaction failed (falling back to Pi default): ${err instanceof Error ? err.message : String(err)}\n`,
			);
			return;
		}
	});

	registerFoldTools(pi, engine, (ids) => recordUnfold(pi, ids));
	registerHandoffCommand(pi, {
		indexFor: (hctx) => indexFor(hctx as Parameters<typeof indexFor>[0]),
		spoolDirFor: (hctx) => join(hctx.sessionManager.getSessionDir(), "spool", hctx.sessionManager.getSessionId()),
	});

	// A display-only status command (no-op safe in headless mode — pure text).
	pi.registerCommand("context-fold", {
		description: "Report context-fold status: fold position, cache health, and the reset yellow flag.",
		handler: async (_args, cmdCtx) => {
			const s = engine.status;
			const m = s?.metrics ?? {};
			const state = s?.text ? s.text : "idle (under budget)";
			const gauge = foldGauge(m);
			const pos =
				typeof m.usage_fraction === "number"
					? ` · usage ${ctxUsageIsEstimate ? "~" : ""}${Math.round((m.usage_fraction as number) * 100)}%${gauge ? ` (${gauge})` : ""}`
					: "";
			const adv = buildAdvisory();
			const lines = [
				`context-fold: ${state}${pos} · L0 ${activeGate ? "on" : "off"} · model ${activeModelIdentity}`,
				`${telemetry.statusLine()}${adv.coldNow ? " · COLD" : ""}${adv.paybackTurns !== null ? ` · reset pays back in ~${adv.paybackTurns} warm turns` : ""}`,
				// Both sides of folding, not just the savings — see CacheTelemetry.foldCostLine.
				...(telemetry.foldCostLine() ? [telemetry.foldCostLine() as string] : []),
				...adv.flags.map((f) => `⚑ ${f}`),
			];
			cmdCtx.ui?.notify?.(lines.join("\n"), adv.flags.length ? "warning" : "info");
		},
	});
}
