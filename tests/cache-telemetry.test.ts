/*
 * cache-telemetry.test.ts — the pure cache accounting: ratios, ring bound, reset, dirty input.
 */
import { describe, expect, it } from "vitest";
import { CacheTelemetry } from "../src/adapters/pi/cache-telemetry";

describe("CacheTelemetry", () => {
	it("computes per-turn and aggregate hit ratios", () => {
		const t = new CacheTelemetry();
		t.record({ input: 1000, output: 50, cacheRead: 0, cacheWrite: 1000, totalTokens: 2050 });
		t.record({ input: 100, output: 50, cacheRead: 900, cacheWrite: 100, totalTokens: 1150 });
		const s = t.snapshot();
		expect(s.turns).toBe(2);
		expect(s.lastHitRatio).toBeCloseTo(0.9);
		// Aggregate: 900 / (900 + 1100)
		expect(s.hitRatio).toBeCloseTo(0.45);
		expect(s.totals.cacheWrite).toBe(1100);
	});

	it("returns null ratios before any input-side tokens exist", () => {
		const t = new CacheTelemetry();
		expect(t.snapshot().hitRatio).toBeNull();
		expect(t.snapshot().lastHitRatio).toBeNull();
		t.record({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
		expect(t.snapshot().lastHitRatio).toBeNull();
		expect(t.snapshot().hitRatio).toBeNull();
	});

	it("treats missing/garbage usage fields as zero", () => {
		const t = new CacheTelemetry();
		t.record({ input: Number.NaN, cacheRead: -5 } as never);
		t.record(null);
		const s = t.snapshot();
		expect(s.turns).toBe(2);
		expect(s.totals.input).toBe(0);
		expect(s.totals.cacheRead).toBe(0);
	});

	it("bounds the ring while totals keep accumulating", () => {
		const t = new CacheTelemetry();
		for (let i = 0; i < 75; i++) t.record({ input: 1, output: 0, cacheRead: 1, cacheWrite: 0, totalTokens: 2 });
		const s = t.snapshot();
		expect(s.ring.length).toBe(50);
		expect(s.turns).toBe(75);
		expect(s.totals.input).toBe(75);
	});

	it("reset clears everything", () => {
		const t = new CacheTelemetry();
		t.record({ input: 10, output: 1, cacheRead: 5, cacheWrite: 2, totalTokens: 18 });
		t.reset();
		const s = t.snapshot();
		expect(s.turns).toBe(0);
		expect(s.last).toBeNull();
		expect(s.totals.cacheRead).toBe(0);
	});

	it("statusLine reads sanely", () => {
		const t = new CacheTelemetry();
		expect(t.statusLine()).toBe("cache: no usage yet");
		t.record({ input: 100, output: 10, cacheRead: 12_300, cacheWrite: 600, totalTokens: 13_010 });
		expect(t.statusLine()).toBe("cache read 12.3k/wr 600 (hit 99%, last 99%)");
	});
});
