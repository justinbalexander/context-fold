/*
 * compact-render.test.ts — Change C: the deterministic summary describes the span leaving live
 * history NOW, not the whole session. Records after the previous compaction render as primary
 * sections; records before it render as the earlier-material section, at halved caps.
 */
import { describe, expect, it } from "vitest";
import { renderDetCompactionSummary } from "../src/adapters/pi/compact";
import type { SeedIndexRecord } from "../src/core/index/seed-index";

function record(overrides: Partial<SeedIndexRecord>): SeedIndexRecord {
	return {
		v: 3,
		kind: "fold-index",
		harness: "pi-context-fold",
		session: "s-test",
		seq: 1,
		at: "2026-09-18T00:00:00.000Z",
		trigger: "threshold",
		usage: { tokens: 1, contextWindow: 2, fraction: 0.5 },
		files: [],
		commands: [],
		errors: [],
		identifiers: [],
		userMessages: [],
		spans: [],
		...overrides,
	};
}

const EARLIER_HEADER = "## Earlier indexed material (before the previous compaction)";

describe("summary scoping — partition at the previous compaction", () => {
	const records = [
		record({
			seq: 1,
			trigger: "threshold",
			files: ["old-a.ts", "old-b.ts"],
			commands: [{ command: "old-command", turn: 1 }],
			errors: [{ line: "old error line", turn: 1 }],
		}),
		record({ seq: 2, trigger: "compact", files: ["compact1-file.ts"] }),
		record({
			seq: 3,
			trigger: "threshold",
			files: ["new-c.ts"],
			commands: [{ command: "new-command", turn: 9 }],
			errors: [{ line: "new error line", turn: 9 }],
		}),
		record({ seq: 4, trigger: "compact", files: ["compact2-file.ts"] }),
	];

	it("primary sections render only material at/after the previous compaction", () => {
		const summary = renderDetCompactionSummary({ records });
		const primary = summary.split(EARLIER_HEADER)[0];
		expect(primary).toContain("new-c.ts");
		expect(primary).toContain("compact2-file.ts");
		expect(primary).toContain("new-command");
		expect(primary).toContain("new error line");
		expect(primary).not.toContain("old-a.ts");
		expect(primary).not.toContain("compact1-file.ts");
		expect(primary).not.toContain("old-command");
		expect(primary).not.toContain("old error line");
	});

	it("material from before the previous compaction renders under the earlier header", () => {
		const summary = renderDetCompactionSummary({ records });
		const earlier = summary.slice(summary.indexOf(EARLIER_HEADER));
		expect(earlier).toContain("old-a.ts");
		expect(earlier).toContain("old-b.ts");
		expect(earlier).toContain("compact1-file.ts");
		expect(earlier).toContain("old-command");
		expect(earlier).toContain("old error line");
		expect(earlier).not.toContain("new-c.ts");
		expect(earlier).not.toContain("compact2-file.ts");
	});

	it("the current span unions fold records with the new compact record (digest-only compact record is not enough)", () => {
		// At compaction the previously-folded block appears in the leaving span as digest text, so the
		// compact record's own extraction carries only the digest. The fold record since the previous
		// compaction carries the original file name; both must render in the primary sections.
		const summary = renderDetCompactionSummary({
			records: [
				record({ seq: 1, trigger: "compact", files: ["previous-compact.ts"] }),
				record({ seq: 2, trigger: "threshold", files: ["folded-original.ts"] }),
				record({ seq: 3, trigger: "compact", files: ["digest-text.ts"] }),
			],
		});
		const primary = summary.split(EARLIER_HEADER)[0];
		expect(primary).toContain("folded-original.ts");
		expect(primary).toContain("digest-text.ts");
		expect(primary).not.toContain("previous-compact.ts");
		expect(summary.slice(summary.indexOf(EARLIER_HEADER))).toContain("previous-compact.ts");
	});
});

describe("summary scoping — handoff path and ordering", () => {
	it("no compact records ⇒ no earlier-material section", () => {
		const summary = renderDetCompactionSummary({
			records: [
				record({ seq: 1, trigger: "threshold", files: ["a.ts"] }),
				record({ seq: 2, trigger: "threshold", files: ["b.ts"] }),
			],
		});
		expect(summary).not.toContain(EARLIER_HEADER);
		expect(summary).toContain("a.ts");
		expect(summary).toContain("b.ts");
	});

	it("previousSummary renders after the earlier-material section", () => {
		const summary = renderDetCompactionSummary({
			records: [
				record({ seq: 1, trigger: "threshold", files: ["old.ts"] }),
				record({ seq: 2, trigger: "compact", files: ["new.ts"] }),
			],
			previousSummary: "Carried narrative.",
		});
		expect(summary.indexOf(EARLIER_HEADER)).toBeLessThan(summary.indexOf("UNTRUSTED"));
		expect(summary).toContain("Carried narrative.");
	});

	it("empty sections are omitted, including the earlier header when it has nothing to show", () => {
		const summary = renderDetCompactionSummary({
			records: [
				record({ seq: 1, trigger: "compact" }),
				record({ seq: 2, trigger: "threshold" }),
			],
		});
		expect(summary).not.toContain("## Files touched");
		expect(summary).not.toContain("## Commands run");
		expect(summary).not.toContain("## Error lines observed");
		expect(summary).not.toContain(EARLIER_HEADER);
	});
});
