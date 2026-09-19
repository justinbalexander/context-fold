/*
 * seed-index.test.ts — index-fidelity tests: identifiers planted MID tool-output (the
 * summary-boundary class that measurably gets dropped by LLM summarizers) must appear
 * verbatim in the emitted index, error lines must survive in every lexicon spelling, and
 * extraction must be deterministic.
 */
import { describe, expect, it } from "vitest";
import { linearize } from "../src/core/block";
import { extractIndex, buildIndexRecord } from "../src/core/index/seed-index";
import { foldCode } from "../src/core/digest";
import type { WireBlock } from "../src/core/block";
import { user, assistantWithCalls, toolResult } from "./helpers";

function blocksOf(messages: Parameters<typeof linearize>[0]): WireBlock[] {
	return linearize(messages) as unknown as WireBlock[];
}

/** A flood with load-bearing facts buried in the middle — nowhere near head or tail. */
function burying(lines: number, planted: string[]): string {
	const body = Array.from({ length: lines }, (_, i) => `line ${i}: ${"x".repeat(40)}`);
	planted.forEach((p, j) => {
		body[Math.floor(lines / 2) + j * 7] = p;
	});
	return body.join("\n");
}

function fixture() {
	const flood = burying(600, [
		"    capacity: CAP_X9_LIMIT=52418 (do not exceed)",
		"    request id 3f9a2c7e11d04b22 assigned",
		"    pinned toolchain 3.14.159-rc2",
	]);
	const errWall = [
		"test summary:",
		"  12 passed, 3 failed",
		"npm ERR! code ELIFECYCLE",
		"warning: something minor",
		"Segmentation fault (core dumped) in worker 4",
	].join("\n");
	const messages = [
		user("rebuild the fold ladder with discrete events"),
		assistantWithCalls([{ id: "c1", name: "bash", args: { cmd: "npx vitest run tests/ladder.test.ts" } }]),
		toolResult("c1", errWall, "bash"),
		user("now check the capacity table in the big dump"),
		assistantWithCalls([{ id: "c2", name: "read", args: { path: "src/adapters/pi/store.ts" } }]),
		toolResult("c2", flood, "read"),
	];
	const all = blocksOf(messages);
	const masked = all.filter((b) => b.kind === "tool_result");
	return { all, masked };
}

/** Two result blocks that both match the error lexicon: a 3-line isError block and a 30-line
 *  non-error flood. The isError lines must win the capped slots. */
function flaggedErrorFixture() {
	const flagged = Array.from({ length: 3 }, (_, i) => `flagged error ${i}`);
	const plain = Array.from({ length: 30 }, (_, i) => `plain error ${i}`);
	const messages = [
		user("ordering probe"),
		assistantWithCalls([{ id: "ok", name: "read" }]),
		toolResult("ok", plain.join("\n"), "read", false),
		assistantWithCalls([{ id: "bad", name: "read" }]),
		toolResult("bad", flagged.join("\n"), "read", true),
	];
	const all = blocksOf(messages);
	const masked = all.filter((b) => b.kind === "tool_result");
	return { all, masked, flagged, plain };
}

describe("seed-index extraction", () => {
	it("keeps identifiers planted mid-tool-output (summary-boundary probe class)", () => {
		const { all, masked } = fixture();
		const idx = extractIndex({ masked, all });
		expect(idx.identifiers).toContain("CAP_X9_LIMIT");
		expect(idx.identifiers).toContain("52418");
		expect(idx.identifiers).toContain("3f9a2c7e11d04b22");
		expect(idx.identifiers).toContain("3.14.159-rc2");
	});

	it("carries whole error lines in every lexicon spelling (lowercase failed, npm ERR!, segfault)", () => {
		const { all, masked } = fixture();
		const idx = extractIndex({ masked, all });
		expect(idx.errors.map((e) => e.line)).toContain("12 passed, 3 failed");
		expect(idx.errors.map((e) => e.line)).toContain("npm ERR! code ELIFECYCLE");
		expect(idx.errors.map((e) => e.line)).toContain("Segmentation fault (core dumped) in worker 4");
	});

	it("indexes shell commands from paired tool_calls and user first lines across the span", () => {
		const { all, masked } = fixture();
		const idx = extractIndex({ masked, all });
		expect(idx.commands.some((c) => c.command.includes("npx vitest run tests/ladder.test.ts"))).toBe(true);
		expect(idx.userMessages.map((u) => u.firstLine)).toEqual([
			"rebuild the fold ladder with discrete events",
			"now check the capacity table in the big dump",
		]);
	});

	it("indexes path-shaped tokens as files", () => {
		const { all, masked } = fixture();
		const idx = extractIndex({ masked, all });
		expect(idx.files.some((f) => f.includes("tests/ladder.test.ts"))).toBe(true);
	});

	it("is deterministic: same input ⇒ byte-identical output", () => {
		const { all, masked } = fixture();
		const a = extractIndex({ masked, all });
		const b = extractIndex({ masked, all });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("caps every field and dedups", () => {
		const noisy = Array.from({ length: 400 }, (_, i) => `VAL_TOKEN_${i} = ${100000 + i}`).join("\n");
		const messages = [
			user("noise"),
			assistantWithCalls([{ id: "n1", name: "bash", args: { cmd: "true" } }]),
			toolResult("n1", noisy, "bash"),
		];
		const all = blocksOf(messages);
		const masked = all.filter((b) => b.kind === "tool_result");
		const idx = extractIndex({ masked, all });
		expect(idx.identifiers.length).toBeLessThanOrEqual(64);
		expect(new Set(idx.identifiers).size).toBe(idx.identifiers.length);
	});

	it("assembles a complete v3 record", () => {
		const { all, masked } = fixture();
		const rec = buildIndexRecord(
			{
				harness: "pi-context-fold",
				session: "s1",
				seq: 1,
				at: "2026-07-28T00:00:00.000Z",
				trigger: "threshold",
				usage: { tokens: 90000, contextWindow: 200000, fraction: 0.45 },
			},
			extractIndex({ masked, all }),
			[
				{
					blockId: masked[0].id,
					code: "abc123",
					tool: "bash",
					turn: masked[0].turn,
					log: { bytes: 100, lines: 5 },
					sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
				},
			],
		);
		expect(rec.v).toBe(3);
		expect(rec.kind).toBe("fold-index");
		expect(rec.spans).toHaveLength(1);
		expect(rec.errors.length).toBeGreaterThan(0);
	});

	it("orders tool-flagged error lines before lexicon-only lines when the cap is tight", () => {
		const { all, masked, flagged } = flaggedErrorFixture();
		const idx = extractIndex({ masked, all });
		expect(idx.errors.length).toBe(24); // the cap, still full
		expect(idx.errors.slice(0, 3).map((e) => e.line)).toEqual(flagged);
		expect(idx.errors.slice(0, 3).every((e) => e.toolError === true)).toBe(true);
		expect(idx.errors.slice(3).every((e) => e.toolError === undefined)).toBe(true);
	});

	it("isError-first ordering is deterministic across runs", () => {
		const { all, masked } = flaggedErrorFixture();
		expect(JSON.stringify(extractIndex({ masked, all }))).toBe(JSON.stringify(extractIndex({ masked, all })));
	});

	it("stamps errors with the source block's turn and foldCode", () => {
		const { all, masked } = fixture();
		const idx = extractIndex({ masked, all });
		const err = idx.errors.find((e) => e.line === "npm ERR! code ELIFECYCLE");
		const source = masked.find((b) => b.text.includes("npm ERR! code ELIFECYCLE"))!;
		expect(err).toBeDefined();
		expect(err!.turn).toBe(source.turn);
		expect(err!.code).toBe(foldCode(source.id));
		expect(err!.code).toMatch(/^[a-z0-9]{8}$/);
	});

	it("captures the follow-on context line, and omits it when the marker line is last", () => {
		const { all, masked } = fixture();
		const idx = extractIndex({ masked, all });
		const err = idx.errors.find((e) => e.line === "npm ERR! code ELIFECYCLE");
		expect(err!.context).toBe("warning: something minor");

		const messages = [
			user("tail marker"),
			assistantWithCalls([{ id: "t1", name: "read" }]),
			toolResult("t1", "clean output\nfailed at the last line", "read"),
		];
		const a2 = blocksOf(messages);
		const m2 = a2.filter((b) => b.kind === "tool_result");
		const last = extractIndex({ masked: m2, all: a2 }).errors.find((e) => e.line === "failed at the last line");
		expect(last).toBeDefined();
		expect(last!.context).toBeUndefined();
	});

	it("stamps commands with the paired result block's turn and foldCode", () => {
		const { all, masked } = fixture();
		const idx = extractIndex({ masked, all });
		const cmd = idx.commands.find((c) => c.command.includes("npx vitest run"));
		const result = masked.find((b) => b.id === "r:c1")!;
		expect(cmd).toBeDefined();
		expect(cmd!.turn).toBe(result.turn);
		expect(cmd!.code).toBe(foldCode(result.id));
	});

	it("stamps harvested `$ …` commands with the containing block's turn and foldCode", () => {
		const messages = [
			user("harvest"),
			assistantWithCalls([{ id: "h1", name: "read" }]),
			toolResult("h1", "some output\n$ make test\n$ git status", "read"),
		];
		const all = blocksOf(messages);
		const masked = all.filter((b) => b.kind === "tool_result");
		const cmd = extractIndex({ masked, all }).commands.find((c) => c.command === "make test");
		expect(cmd).toBeDefined();
		expect(cmd!.turn).toBe(masked[0].turn);
		expect(cmd!.code).toBe(foldCode(masked[0].id));
	});

	it("stores a full multi-line shell command, not its first line", () => {
		const cmd = "python - <<'PY'\nprint('a')\nprint('b')\nPY";
		const call: WireBlock = {
			id: "a:resp:p0", kind: "tool_call", turn: 4, order: 0,
			text: `bash ${cmd}`, tokens: 10, toolName: "bash", callId: "m1",
		};
		const result: WireBlock = {
			id: "r:m1", kind: "tool_result", turn: 4, order: 1,
			text: "done", tokens: 1, toolName: "bash", callId: "m1",
		};
		const idx = extractIndex({ masked: [result], all: [call, result] });
		expect(idx.commands.map((c) => c.command)).toEqual([cmd]);
	});

	it("stores an 8100-char command at the 8000-char hard cap", () => {
		const cmd = "echo " + "x".repeat(8095);
		expect(cmd.length).toBe(8100);
		const call: WireBlock = {
			id: "a:resp:p0", kind: "tool_call", turn: 4, order: 0,
			text: `bash ${cmd}`, tokens: 10, toolName: "bash", callId: "m1",
		};
		const result: WireBlock = {
			id: "r:m1", kind: "tool_result", turn: 4, order: 1,
			text: "done", tokens: 1, toolName: "bash", callId: "m1",
		};
		const idx = extractIndex({ masked: [result], all: [call, result] });
		expect(idx.commands[0].command).toBe(cmd.slice(0, 8000));
	});
});
