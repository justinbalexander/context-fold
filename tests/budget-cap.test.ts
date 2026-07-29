/*
 * budget-cap.test.ts — the absolute budget cap: budget = min(absoluteTokenCap, fraction × cw).
 * The cap exists because attention lossiness is absolute, not window-relative; without it a
 * 1M-window model would not fold until 750k tokens.
 */
import { describe, expect, it } from "vitest";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { MapGateRegistry } from "../src/core/gate-registry";
import { configFromEnv } from "../src/adapters/pi/config";
import { user } from "./helpers";

function engine(cfg: Record<string, unknown> = {}) {
	return new ContextFoldEngine(new FoldLadderPolicy(), cfg, new MapGateRegistry());
}

const msgs = [user("hello")];

describe("absolute budget cap", () => {
	it("binds on a large window: 1M × 0.75 is capped to 200k", () => {
		expect(engine().viewFor(msgs, 1_000_000).budget).toBe(200_000);
	});

	it("yields to the fraction on a small window: 200k × 0.75 = 150k", () => {
		expect(engine().viewFor(msgs, 200_000).budget).toBe(150_000);
	});

	it("keeps the null-window fallback behavior unchanged", () => {
		expect(engine().viewFor(msgs, null).budget).toBe(150_000);
	});

	it("cap 0 disables the ceiling entirely", () => {
		expect(engine({ absoluteTokenCap: 0 }).viewFor(msgs, 1_000_000).budget).toBe(750_000);
	});

	it("a custom cap below the fraction result binds", () => {
		expect(engine({ absoluteTokenCap: 60_000 }).viewFor(msgs, 200_000).budget).toBe(60_000);
	});
});

describe("CONTEXTFOLD_BUDGET_CAP env parsing", () => {
	function withEnv(value: string | undefined, fn: () => void) {
		const prev = process.env.CONTEXTFOLD_BUDGET_CAP;
		if (value === undefined) delete process.env.CONTEXTFOLD_BUDGET_CAP;
		else process.env.CONTEXTFOLD_BUDGET_CAP = value;
		try {
			fn();
		} finally {
			if (prev === undefined) delete process.env.CONTEXTFOLD_BUDGET_CAP;
			else process.env.CONTEXTFOLD_BUDGET_CAP = prev;
		}
	}

	it("accepts a number", () => {
		withEnv("120000", () => expect(configFromEnv().absoluteTokenCap).toBe(120_000));
	});

	it("accepts 0 and 'off' as disabled", () => {
		withEnv("0", () => expect(configFromEnv().absoluteTokenCap).toBe(0));
		withEnv("off", () => expect(configFromEnv().absoluteTokenCap).toBe(0));
	});

	it("ignores garbage and negatives (default stays)", () => {
		withEnv("banana", () => expect(configFromEnv().absoluteTokenCap).toBeUndefined());
		withEnv("-5", () => expect(configFromEnv().absoluteTokenCap).toBeUndefined());
		withEnv(undefined, () => expect(configFromEnv().absoluteTokenCap).toBeUndefined());
	});
});
