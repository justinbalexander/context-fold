import type { ExtensionContext, InputEvent, InputEventResult, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { knob, resolveKnob, type SavedSettings } from "./config";
import { estTokens } from "../../core/tokens";

const modelKey = (provider: string, model: string): string => JSON.stringify([provider, model]);

/** Notifications belong to Pi's renderer while interactive; stderr is only for headless use. */
export function notifyCacheWarning(ctx: ExtensionContext, text: string): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(text, "warning");
		else process.stderr.write(`${text}\n`);
	} catch {}
}

/** Cache age is an advisory estimate, independent of folding and measured cache-miss telemetry. */
export class CacheWarning {
	private activity = new Map<string, number>();
	private warned = new Map<string, number | undefined>();
	private carriedTokens = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private epoch = 0;
	private retainedImages: InputEvent["images"];

	constructor(private readonly settings: () => SavedSettings) {}

	private failed(ctx: ExtensionContext, error: unknown): void {
		notifyCacheWarning(ctx, `Cache advisory unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}

	pause(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.pause();
		this.epoch++;
		this.retainedImages = undefined;
	}

	/** The active branch excludes recent requests from abandoned branches. Entries mark completion. */
	restore(ctx: ExtensionContext): void {
		this.dispose();
		this.activity.clear();
		this.warned.clear();
		this.carriedTokens = 0;
		try {
			for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
				if (entry.type === "message") this.observe(entry.message, Date.parse(entry.timestamp));
			}
			this.refresh(ctx);
		} catch (error) { this.failed(ctx, error); }
	}

	observe(message: MessageEndEvent["message"], at = Date.now()): void {
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "pending") return;
		if (!message.provider || !message.model || !message.usage || !Number.isFinite(at) || at > Date.now()) return;
		const u = message.usage;
		const tokens = u.input + u.cacheRead + u.cacheWrite + u.output;
		if (!Number.isFinite(tokens) || tokens <= 0) return;
		const key = modelKey(message.provider, message.model);
		this.activity.set(key, at);
		this.carriedTokens = tokens;
		this.warned.delete(key);
	}

	private forecast(ctx: ExtensionContext) {
		if (!ctx.model) return;
		const minutes = resolveKnob(knob("cacheIdleMinutes"), this.settings(), ctx.model.provider).value as number;
		if (minutes === 0) return;
		let tokens = ctx.getContextUsage()?.tokens;
		if (tokens == null) {
			// Pi marks usage unknown after compaction. Estimate the retained context rather than
			// recycling the pre-compaction usage that may have been orders of magnitude larger.
			const entries = ctx.sessionManager.buildContextEntries?.();
			tokens = entries ? estTokens(JSON.stringify(entries)) : this.carriedTokens;
		}
		if (tokens < 20_000) return;
		const key = modelKey(ctx.model.provider, ctx.model.id);
		const at = this.activity.get(key);
		const remaining = at === undefined ? 0 : at + minutes * 60_000 - Date.now();
		const state = at === undefined ? "cache unverified" : "cache may have expired";
		return { key, at, remaining, text: `${state}: ~${Math.round(tokens / 1000)}k tok may rebill. Consider /fold-handoff` };
	}

	refresh(ctx: ExtensionContext): void {
		this.pause();
		try {
			if (!ctx.hasUI || (ctx.mode && ctx.mode !== "tui") || !ctx.isIdle()) return;
			const risk = this.forecast(ctx);
			if (!risk) return;
			if (risk.remaining > 0) {
				// Node truncates larger delays to 1 ms; a long user-configured timeout must not spin.
				this.timer = setTimeout(() => this.refresh(ctx), Math.min(risk.remaining, 2_147_483_647));
				this.timer.unref();
			} else if (!this.warned.has(risk.key) || this.warned.get(risk.key) !== risk.at) {
				notifyCacheWarning(ctx, risk.text);
				this.warned.set(risk.key, risk.at);
			}
		} catch (error) { this.failed(ctx, error); }
	}

	discardImages(ctx: ExtensionContext): void {
		this.retainedImages = undefined;
		try { ctx.ui.notify("Retained draft images discarded.", "info"); } catch {}
	}

	async input(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
		if (!ctx.hasUI || (ctx.mode && ctx.mode !== "tui") || event.source !== "interactive" || event.streamingBehavior) return { action: "continue" };
		const retained = this.retainedImages;
		const images = retained ? [...retained, ...(event.images ?? [])].filter((image, index, all) =>
			all.findIndex(other => other.data === image.data && other.mimeType === image.mimeType) === index,
		) : event.images;
		const proceed = (): InputEventResult => {
			this.retainedImages = undefined;
			return retained ? { action: "transform", text: event.text, images } : { action: "continue" };
		};
		const epoch = this.epoch;
		try {
			const risk = this.forecast(ctx);
			if (!risk || risk.remaining > 0 || resolveKnob(knob("confirmColdPrompt"), this.settings()).value !== "on") return proceed();
			const selectedModel = ctx.model && modelKey(ctx.model.provider, ctx.model.id);
			const choice = await ctx.ui.select(risk.text, ["Keep draft", "Send anyway"]);
			if (epoch !== this.epoch || selectedModel !== (ctx.model && modelKey(ctx.model.provider, ctx.model.id))) {
				notifyCacheWarning(ctx, "Session or model changed; prompt not sent.");
				return { action: "handled" };
			}
			if (choice === "Send anyway") return proceed();
			this.retainedImages = images;
			try { ctx.ui.setEditorText(event.text); } catch {
				notifyCacheWarning(ctx, `Prompt not sent; editor restore failed. Draft: ${event.text}`);
			}
			// setEditorText changes the buffer without requesting a Pi render. The notice also
			// makes retained structured images visible; clipboard image paths are already text.
			notifyCacheWarning(ctx, images?.length
				? `${images.length} image(s) kept for your next prompt in this session. /context-fold discard-images clears them.`
				: "Draft kept; prompt not sent.");
			return { action: "handled" };
		} catch (error) {
			this.failed(ctx, error);
			return proceed();
		}
	}
}
