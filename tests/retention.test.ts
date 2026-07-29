/*
 * retention.test.ts — spool GC: age-based reaping of per-session spool dirs.
 * The safety properties under test: only dirs past the window die, never the current session's,
 * freshness is judged by the newest FILE inside (not the dir), and everything fails open.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spoolRetainMsFromEnv, sweepSpools, SPOOL_RETAIN_DAYS_DEFAULT } from "../src/adapters/pi/retention";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // fixed clock for every sweep

let root: string;

/** Create a session spool dir with one envelope file, both stamped `ageDays` old. */
function sessionDir(name: string, ageDays: number, files: string[] = ["abc123.json"]): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const t = new Date(NOW - ageDays * DAY);
	for (const f of files) {
		const p = join(dir, f);
		writeFileSync(p, JSON.stringify({ v: 1, code: f.replace(/\.json$/, "") }));
		utimesSync(p, t, t);
	}
	utimesSync(dir, t, t);
	return dir;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cf-retention-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.CONTEXTFOLD_SPOOL_RETAIN_DAYS;
});

describe("sweepSpools", () => {
	it("reaps dirs past the window and keeps fresh ones", () => {
		const old = sessionDir("old-session", 30);
		const fresh = sessionDir("fresh-session", 2);
		const res = sweepSpools(root, "current-session", 14 * DAY, NOW);
		expect(res.reaped).toEqual(["old-session"]);
		expect(res.kept).toBe(1);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it("never touches the current session's dir, whatever its age", () => {
		const current = sessionDir("current-session", 400);
		const res = sweepSpools(root, "current-session", 14 * DAY, NOW);
		expect(res.reaped).toEqual([]);
		expect(existsSync(current)).toBe(true);
	});

	it("judges freshness by the newest file inside, not the dir mtime", () => {
		// Dir stamped ancient, but one envelope written recently — an actively-used spool stays.
		const dir = sessionDir("active-old", 30, ["stale.json"]);
		const freshFile = join(dir, "fresh.json");
		writeFileSync(freshFile, "{}");
		const t = new Date(NOW - 1 * DAY);
		utimesSync(freshFile, t, t);
		const res = sweepSpools(root, "current", 14 * DAY, NOW);
		expect(res.reaped).toEqual([]);
		expect(existsSync(dir)).toBe(true);
	});

	it("reaps an empty dir by its own mtime", () => {
		const dir = join(root, "empty-old");
		mkdirSync(dir);
		const t = new Date(NOW - 30 * DAY);
		utimesSync(dir, t, t);
		const res = sweepSpools(root, "current", 14 * DAY, NOW);
		expect(res.reaped).toEqual(["empty-old"]);
		expect(existsSync(dir)).toBe(false);
	});

	it("retainMs 0 disables the sweep entirely", () => {
		const old = sessionDir("old-session", 400);
		const res = sweepSpools(root, "current", 0, NOW);
		expect(res.reaped).toEqual([]);
		expect(existsSync(old)).toBe(true);
	});

	it("a missing spool root is a no-op, not a throw", () => {
		const res = sweepSpools(join(root, "does-not-exist"), "current", 14 * DAY, NOW);
		expect(res).toEqual({ reaped: [], kept: 0 });
	});

	it("ignores stray plain files in the spool root", () => {
		const stray = join(root, "stray.txt");
		writeFileSync(stray, "not a session dir");
		const t = new Date(NOW - 30 * DAY);
		utimesSync(stray, t, t);
		const res = sweepSpools(root, "current", 14 * DAY, NOW);
		expect(res.reaped).toEqual([]);
		expect(existsSync(stray)).toBe(true);
	});

	it("a dir exactly at the boundary is kept (strictly-older-than semantics)", () => {
		sessionDir("boundary", 14);
		const res = sweepSpools(root, "current", 14 * DAY, NOW);
		expect(res.reaped).toEqual([]);
		expect(res.kept).toBe(1);
	});
});

describe("spoolRetainMsFromEnv", () => {
	it("defaults to SPOOL_RETAIN_DAYS_DEFAULT days when unset", () => {
		expect(spoolRetainMsFromEnv()).toBe(SPOOL_RETAIN_DAYS_DEFAULT * DAY);
	});
	it("0 / off / false disable GC", () => {
		for (const v of ["0", "off", "OFF", "false"]) {
			process.env.CONTEXTFOLD_SPOOL_RETAIN_DAYS = v;
			expect(spoolRetainMsFromEnv()).toBe(0);
		}
	});
	it("a numeric value sets the window in days", () => {
		process.env.CONTEXTFOLD_SPOOL_RETAIN_DAYS = "7";
		expect(spoolRetainMsFromEnv()).toBe(7 * DAY);
	});
	it("garbage falls back to the default (never accidentally 0)", () => {
		for (const v of ["banana", "-3", "NaN", ""]) {
			process.env.CONTEXTFOLD_SPOOL_RETAIN_DAYS = v;
			expect(spoolRetainMsFromEnv()).toBe(SPOOL_RETAIN_DAYS_DEFAULT * DAY);
		}
	});
});
