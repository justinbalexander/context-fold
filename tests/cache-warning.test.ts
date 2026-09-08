import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, InputEvent, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { SavedSettings } from "../src/adapters/pi/config";
import { CacheWarning } from "../src/adapters/pi/cache-warning";

const NOW = Date.UTC(2026, 8, 5, 12);
const MINUTE = 60_000;
function assistant(at = NOW - 31 * MINUTE, provider = "openai", model = "test") {
	return { role: "assistant", provider, model, timestamp: at, stopReason: "stop", usage: { input: 5_000, cacheRead: 79_000, cacheWrite: 0, output: 1_000 } };
}
function fixture() {
	let settings: SavedSettings = {};
	let entries = [{ type: "message", timestamp: new Date(NOW - 31 * MINUTE).toISOString(), message: assistant() }];
	const ui = { notify: vi.fn(), select: vi.fn().mockResolvedValue("Keep draft"), setEditorText: vi.fn(), getEditorText: vi.fn().mockReturnValue("") };
	const context = {
		hasUI: true, mode: "tui", model: { provider: "openai", id: "test" },
		isIdle: vi.fn().mockReturnValue(true),
		getContextUsage: vi.fn().mockReturnValue({ tokens: 85_000, contextWindow: 200_000 }),
		sessionManager: { getSessionId: () => "s1", getBranch: () => entries }, ui,
	};
	const ctx = context as unknown as ExtensionContext;
	const warning = new CacheWarning(() => settings);
	return { warning, ctx, context, ui, settings: (value: SavedSettings) => settings = value, entries: (value: typeof entries) => entries = value };
}
const input = (text = "continue with /tmp/pi-clipboard.png"): InputEvent => ({ type: "input", text, source: "interactive" });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("cache inactivity warning", () => {
	it("warns on resume before input and once per idle interval", () => {
		const f = fixture();
		f.warning.restore(f.ctx);
		expect(f.ui.notify).toHaveBeenCalledWith("cache may have expired: ~85k tok may rebill. Consider /fold-handoff", "warning");
		f.warning.refresh(f.ctx);
		vi.advanceTimersByTime(60 * MINUTE);
		expect(f.ui.notify).toHaveBeenCalledTimes(1);
		f.warning.dispose();
	});

	it("arms from successful activity and rearms after another response", () => {
		const f = fixture();
		f.entries([]);
		f.warning.observe(assistant(NOW) as MessageEndEvent["message"]);
		f.warning.refresh(f.ctx);
		vi.advanceTimersByTime(30 * MINUTE - 1);
		expect(f.ui.notify).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(f.ui.notify).toHaveBeenCalledTimes(1);
		f.warning.observe(assistant(Date.now()) as MessageEndEvent["message"]);
		f.warning.refresh(f.ctx);
		vi.advanceTimersByTime(30 * MINUTE);
		expect(f.ui.notify).toHaveBeenCalledTimes(2);
		f.warning.dispose();
	});

	it("does not refresh the cache clock on tools, errors, or aborted responses", () => {
		const f = fixture();
		f.entries([{ type: "message", timestamp: new Date(NOW).toISOString(), message: assistant(NOW) }]);
		f.warning.restore(f.ctx);
		vi.advanceTimersByTime(29 * MINUTE);
		for (const message of [{ role: "toolResult" }, { ...assistant(Date.now()), stopReason: "error" }, { ...assistant(Date.now()), stopReason: "aborted" }]) {
			f.warning.observe(message as MessageEndEvent["message"]);
		}
		vi.advanceTimersByTime(MINUTE);
		expect(f.ui.notify).toHaveBeenCalledTimes(1);
		f.warning.dispose();
	});

	it("uses the completion entry timestamp rather than the response start timestamp", () => {
		const f = fixture();
		f.entries([{ type: "message", timestamp: new Date(NOW).toISOString(), message: assistant() }]);
		f.warning.restore(f.ctx);
		expect(f.ui.notify).not.toHaveBeenCalled();
		f.warning.dispose();
	});

	it("uses selected-provider settings live and keeps model activity separate", () => {
		const f = fixture();
		f.settings({ providerCacheIdleMinutes: { openai: 60, custom: 10 } });
		f.warning.restore(f.ctx);
		expect(f.ui.notify).not.toHaveBeenCalled();
		f.context.model = { provider: "custom", id: "test" };
		f.warning.observe(assistant(NOW - 11 * MINUTE, "custom") as MessageEndEvent["message"], NOW - 11 * MINUTE);
		f.warning.refresh(f.ctx);
		expect(f.ui.notify).toHaveBeenCalledTimes(1);
		f.context.model = { provider: "openai", id: "other" };
		f.warning.refresh(f.ctx);
		expect(f.ui.notify).toHaveBeenLastCalledWith("cache unverified: ~85k tok may rebill. Consider /fold-handoff", "warning");
		f.warning.dispose();
	});

	it("handles null usage using the latest known context, but honors a compacted small context", () => {
		const f = fixture();
		f.context.getContextUsage.mockReturnValue({ tokens: null, contextWindow: 200_000 } as never);
		f.warning.restore(f.ctx);
		expect(f.ui.notify).toHaveBeenCalledTimes(1);
		f.context.getContextUsage.mockReturnValue({ tokens: 19_999, contextWindow: 200_000 });
		f.warning.restore(f.ctx);
		expect(f.ui.notify).toHaveBeenCalledTimes(1);
		f.warning.dispose();
	});

	it("estimates the retained context after compaction instead of reusing old usage", () => {
		const f = fixture();
		f.context.getContextUsage.mockReturnValue({ tokens: null, contextWindow: 200_000 } as never);
		Object.assign(f.context.sessionManager, { buildContextEntries: () => [{ role: "user", content: "small handoff" }] });
		f.warning.restore(f.ctx);
		expect(f.ui.notify).not.toHaveBeenCalled();
		f.warning.dispose();
	});

	it("caps long timers without a one-millisecond retry loop", () => {
		const f = fixture();
		f.settings({ cacheIdleMinutes: 100_000 });
		f.warning.restore(f.ctx);
		vi.advanceTimersByTime(2_147_483_647);
		expect(f.ui.notify).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		f.warning.dispose();
	});

	it("does not notify while busy; rechecks at settlement and stops on shutdown", () => {
		const f = fixture();
		f.context.isIdle.mockReturnValue(false);
		f.warning.restore(f.ctx);
		expect(f.ui.notify).not.toHaveBeenCalled();
		f.context.isIdle.mockReturnValue(true);
		f.warning.refresh(f.ctx);
		expect(f.ui.notify).toHaveBeenCalledTimes(1);
		f.warning.observe(assistant(NOW) as MessageEndEvent["message"]);
		f.warning.refresh(f.ctx);
		f.warning.dispose();
		vi.advanceTimersByTime(60 * MINUTE);
		expect(f.ui.notify).toHaveBeenCalledTimes(1);
	});

	it("disables timer and confirmation per provider, and is noninteractive-safe", async () => {
		const f = fixture();
		f.settings({ providerCacheIdleMinutes: { openai: 0 }, confirmColdPrompt: "on" });
		f.warning.restore(f.ctx);
		expect(await f.warning.input(input(), f.ctx)).toEqual({ action: "continue" });
		expect(f.ui.select).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		f.settings({ confirmColdPrompt: "on" });
		f.context.hasUI = false;
		f.warning.restore(f.ctx);
		expect(await f.warning.input(input(), f.ctx)).toEqual({ action: "continue" });
		expect(f.ui.notify).not.toHaveBeenCalled();
		f.warning.dispose();
	});
});

describe("optional input confirmation", () => {
	it("is off by default, bypasses automation and streaming, and otherwise gates before sending", async () => {
		const f = fixture();
		f.warning.restore(f.ctx);
		expect(await f.warning.input(input(), f.ctx)).toEqual({ action: "continue" });
		f.settings({ confirmColdPrompt: "on" });
		for (const event of [{ ...input(), source: "extension" as const }, { ...input(), source: "rpc" as const }, { ...input(), streamingBehavior: "steer" as const }]) {
			expect(await f.warning.input(event, f.ctx)).toEqual({ action: "continue" });
		}
		expect(f.ui.select).not.toHaveBeenCalled();
		expect(await f.warning.input(input(), f.ctx)).toEqual({ action: "handled" });
		expect(f.ui.setEditorText).toHaveBeenCalledWith("continue with /tmp/pi-clipboard.png");
		f.ui.select.mockResolvedValue("Send anyway");
		expect(await f.warning.input(input(), f.ctx)).toEqual({ action: "continue" });
		f.warning.dispose();
	});

	it("preserves structured images across cancellation and an edited resubmission", async () => {
		const f = fixture();
		f.settings({ confirmColdPrompt: "on" });
		f.warning.restore(f.ctx);
		const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
		expect(await f.warning.input({ ...input(), images }, f.ctx)).toEqual({ action: "handled" });
		f.ui.select.mockResolvedValue("Send anyway");
		expect(await f.warning.input(input("edited draft"), f.ctx)).toEqual({ action: "transform", text: "edited draft", images });
		expect(await f.warning.input(input("unrelated next prompt"), f.ctx)).toEqual({ action: "continue" });
		f.warning.dispose();
	});

	it("clears retained images on session navigation and supports explicitly discarding them", async () => {
		const f = fixture();
		f.settings({ confirmColdPrompt: "on" });
		f.warning.restore(f.ctx);
		const event = { ...input(), images: [{ type: "image" as const, data: "aA==", mimeType: "image/png" }] };
		await f.warning.input(event, f.ctx);
		f.warning.discardImages(f.ctx);
		f.ui.select.mockResolvedValue("Send anyway");
		expect(await f.warning.input(input(), f.ctx)).toEqual({ action: "continue" });
		f.ui.select.mockResolvedValue(undefined);
		await f.warning.input(event, f.ctx);
		f.warning.restore(f.ctx);
		f.ui.select.mockResolvedValue("Send anyway");
		expect(await f.warning.input(input(), f.ctx)).toEqual({ action: "continue" });
		f.warning.dispose();
	});

	it("does not send an old prompt after navigation while the confirmation is open", async () => {
		const f = fixture();
		f.settings({ confirmColdPrompt: "on" });
		f.warning.restore(f.ctx);
		let answer!: (value: string) => void;
		f.ui.select.mockImplementation(() => new Promise(resolve => answer = resolve));
		const pending = f.warning.input(input(), f.ctx);
		f.warning.restore(f.ctx);
		answer("Send anyway");
		expect(await pending).toEqual({ action: "handled" });
		f.warning.dispose();
	});

	it("never sends an explicitly cancelled prompt even if editor restoration fails", async () => {
		const f = fixture();
		f.settings({ confirmColdPrompt: "on" });
		f.warning.restore(f.ctx);
		f.ui.setEditorText.mockImplementation(() => { throw new Error("editor unavailable"); });
		expect(await f.warning.input(input(), f.ctx)).toEqual({ action: "handled" });
		f.warning.dispose();
	});

	it("fails open when the UI or session API throws", async () => {
		const f = fixture();
		f.settings({ confirmColdPrompt: "on" });
		f.warning.restore(f.ctx);
		f.ui.select.mockRejectedValue(new Error("UI unavailable"));
		expect(await f.warning.input(input(), f.ctx)).toEqual({ action: "continue" });
		f.context.getContextUsage.mockImplementation(() => { throw new Error("usage unavailable"); });
		expect(() => f.warning.refresh(f.ctx)).not.toThrow();
		f.warning.dispose();
	});
});
