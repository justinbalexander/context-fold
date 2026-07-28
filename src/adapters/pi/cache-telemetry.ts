/*
 * cache-telemetry.ts — observe-only prompt-cache accounting from real provider usage.
 *
 * Pi hands every finalized assistant message a `usage` object carrying cacheRead/cacheWrite;
 * nothing in the extension consumed it before. This is the measured signal for whether the
 * fold layout is actually keeping the prefix warm: `input` here is the tokens the provider
 * re-prefilled this turn (Pi normalizes it exclusive of cached tokens), so the per-turn hit
 * ratio cacheRead / (cacheRead + input) collapsing right after a fold is the cost of a
 * head-rewriting fold, and staying high is prefix stability paying off.
 *
 * Pure and in-memory: no Pi imports, no persistence — fully unit-testable.
 */

export interface TurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface CacheTelemetrySnapshot {
	turns: number;
	last: TurnUsage | null;
	/** Per-turn hit ratio of the last turn, null before any turn or when the turn had no input side. */
	lastHitRatio: number | null;
	totals: TurnUsage;
	/** Session aggregate hit ratio, null until any input-side tokens exist. */
	hitRatio: number | null;
	/** The retained ring, oldest first (bounded). */
	ring: TurnUsage[];
}

const RING_LIMIT = 50;

function ratio(cacheRead: number, input: number): number | null {
	const denom = cacheRead + input;
	return denom > 0 ? cacheRead / denom : null;
}

export class CacheTelemetry {
	private ring: TurnUsage[] = [];
	private turns = 0;
	private totals: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

	/** Record one finalized assistant message's usage. Non-finite fields count as 0. */
	record(usage: Partial<TurnUsage> | null | undefined): void {
		const clean = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
		const turn: TurnUsage = {
			input: clean(usage?.input),
			output: clean(usage?.output),
			cacheRead: clean(usage?.cacheRead),
			cacheWrite: clean(usage?.cacheWrite),
			totalTokens: clean(usage?.totalTokens),
		};
		this.turns += 1;
		this.ring.push(turn);
		if (this.ring.length > RING_LIMIT) this.ring.shift();
		this.totals.input += turn.input;
		this.totals.output += turn.output;
		this.totals.cacheRead += turn.cacheRead;
		this.totals.cacheWrite += turn.cacheWrite;
		this.totals.totalTokens += turn.totalTokens;
	}

	reset(): void {
		this.ring = [];
		this.turns = 0;
		this.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	}

	snapshot(): CacheTelemetrySnapshot {
		const last = this.ring.length ? this.ring[this.ring.length - 1] : null;
		return {
			turns: this.turns,
			last,
			lastHitRatio: last ? ratio(last.cacheRead, last.input) : null,
			totals: { ...this.totals },
			hitRatio: ratio(this.totals.cacheRead, this.totals.input),
			ring: [...this.ring],
		};
	}

	/** One human line for the status command / debug stderr, e.g. `cache read 12.3k/wr 0.6k (hit 66%, last 71%)`. */
	statusLine(): string {
		const s = this.snapshot();
		if (s.turns === 0) return "cache: no usage yet";
		const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
		const pct = (r: number | null): string => (r === null ? "n/a" : `${Math.round(r * 100)}%`);
		return `cache read ${k(s.totals.cacheRead)}/wr ${k(s.totals.cacheWrite)} (hit ${pct(s.hitRatio)}, last ${pct(s.lastHitRatio)})`;
	}
}
