/*
 * settings.test.ts — the saved-settings file (roundtrip, fail-open reads) and the /context-fold
 * config menu loop (edit, validate, clear, env shadowing) against a scripted fake UI.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadSavedSettings,
	removeSavedSetting,
	runSettingsMenu,
	settingsFilePath,
	settingsReport,
	writeSavedSetting,
	type MenuUi,
} from "../src/adapters/pi/settings";
import type { SavedSettings } from "../src/adapters/pi/config";

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cf-settings-"));
	file = join(dir, "context-fold.json");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.CONTEXTFOLD_TAIL;
});

describe("settings file", () => {
	it("resolves under PI_CODING_AGENT_DIR when set", () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent";
		expect(settingsFilePath()).toBe("/tmp/custom-agent/context-fold.json");
	});

	it("missing or corrupt file loads as {}", () => {
		expect(loadSavedSettings(file)).toEqual({});
		writeFileSync(file, "{nope");
		expect(loadSavedSettings(file)).toEqual({});
	});

	it("write/remove roundtrip, revalidated on read", () => {
		writeSavedSetting("foldAt", 0.6, file);
		writeSavedSetting("compact", "native", file);
		expect(loadSavedSettings(file)).toEqual({ foldAt: 0.6, compact: "native" });
		removeSavedSetting("foldAt", file);
		expect(loadSavedSettings(file)).toEqual({ compact: "native" });
		// Invalid values in the file are dropped, not trusted.
		writeFileSync(file, JSON.stringify({ foldAt: 7, compact: "native" }));
		expect(loadSavedSettings(file)).toEqual({ compact: "native" });
	});
});

/** Scripted UI: each step answers the next dialog; select answers match options by prefix. */
function scriptedUi(steps: (string | undefined)[]): MenuUi & { notices: string[] } {
	const notices: string[] = [];
	return {
		notices,
		select: async (_title, options) => {
			const want = steps.shift();
			if (want === undefined) return undefined;
			return options.find((o) => o.startsWith(want));
		},
		input: async () => steps.shift(),
		notify: (message, level) => notices.push(`${level}: ${message}`),
	};
}

describe("runSettingsMenu", () => {
	const applied: SavedSettings[] = [];
	const apply = (s: SavedSettings) => applied.push(s);
	beforeEach(() => applied.splice(0));

	it("edits a numeric knob: persists, live-applies, reports", async () => {
		const ui = scriptedUi(["Budget fraction", "0.5", "Done"]);
		await runSettingsMenu(ui, apply, file);
		expect(loadSavedSettings(file)).toEqual({ budgetFraction: 0.5 });
		expect(applied).toEqual([{ budgetFraction: 0.5 }]);
		expect(ui.notices).toEqual(["info: Budget fraction → 0.5 (applied)"]);
	});

	it("rejects an invalid value without writing", async () => {
		const ui = scriptedUi(["Protected tail", "-3", "Done"]);
		await runSettingsMenu(ui, apply, file);
		expect(loadSavedSettings(file)).toEqual({});
		expect(applied).toEqual([]);
		expect(ui.notices[0]).toMatch(/^error: Protected tail/);
	});

	it("choice knobs pick from a list; 'reset to default' clears a saved value", async () => {
		const ui = scriptedUi(["Hard compaction", "native", "Hard compaction", "reset to default", "Done"]);
		await runSettingsMenu(ui, apply, file);
		expect(applied).toEqual([{ compact: "native" }, {}]);
		expect(loadSavedSettings(file)).toEqual({});
	});

	it("'default' in a numeric prompt clears the saved value", async () => {
		writeSavedSetting("tail", 5_000, file);
		const ui = scriptedUi(["Protected tail", "default", "Done"]);
		await runSettingsMenu(ui, apply, file);
		expect(loadSavedSettings(file)).toEqual({});
	});

	it("warns when an env var shadows the saved value", async () => {
		process.env.CONTEXTFOLD_TAIL = "1000";
		const ui = scriptedUi(["Protected tail", "30000", "Done"]);
		await runSettingsMenu(ui, apply, file);
		expect(loadSavedSettings(file)).toEqual({ tail: 30_000 });
		expect(ui.notices[0]).toMatch(/^warning: Saved, but CONTEXTFOLD_TAIL overrides/);
	});

	it("Esc on the top menu exits cleanly", async () => {
		const ui = scriptedUi([undefined]);
		await runSettingsMenu(ui, apply, file);
		expect(applied).toEqual([]);
	});
});

describe("settingsReport", () => {
	it("tags non-default sources and next-session knobs", () => {
		process.env.CONTEXTFOLD_TAIL = "1000";
		const report = settingsReport({ foldAt: 0.6 });
		expect(report).toContain("Fold threshold: 0.6 (saved)");
		expect(report).toContain("Protected tail: 1000 (env)");
		expect(report).toContain("Spool retention: 1 [next session]");
	});
});
