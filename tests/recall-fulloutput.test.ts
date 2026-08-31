/*
 * recall-fulloutput.test.ts — S1 of docs/specs/2026-08-31-pi-api-review-followups.md.
 *
 * A toolResult message that carries `details.fullOutputPath` (bash's truncation escape hatch,
 * persisted in the session JSONL) must thread that path — and the paired tool call's typed
 * input — through linearize, the spool envelope, the registry entry, and the seed-index span,
 * so recall grep/lines answer from the tool's own full-output file instead of the truncated
 * content. Expected values are independent literals, never recomputed the way the code does.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linearize, type AgentMessage } from "../src/core/block";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { MapSpoolRegistry } from "../src/core/spool-registry";
import { SpoolStore, readEnvelopeAt } from "../src/adapters/pi/spool";
import { SeedIndexStore, emitFoldIndex } from "../src/adapters/pi/index-store";
import { foldCode } from "../src/core/digest";
import { user, assistantText, assistantWithCalls, bigResult, toolResult } from "./helpers";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

/** A bash-shaped toolResult whose details name a full-output file. */
function bashResult(toolCallId: string, text: string, fullOutputPath: string): AgentMessage {
	const m = toolResult(toolCallId, text, "bash");
	(m as AgentMessage & { details?: unknown }).details = { truncation: { truncated: true }, fullOutputPath };
	return m;
}

describe("linearize carries typed input and details.fullOutputPath (pure)", () => {
	it("tool_result block gets the paired call's arguments and the details path", () => {
		const messages: AgentMessage[] = [
			user("run the suite"),
			assistantWithCalls([{ id: "cb1", name: "bash", args: { command: "npx vitest run", timeout: 60 } }]),
			bashResult("cb1", "truncated tail only", "/tmp/pi-bash-cb1.log"),
		];
		const result = linearize(messages).find((b) => b.kind === "tool_result");
		expect(result).toBeDefined();
		expect(result!.input).toEqual({ command: "npx vitest run", timeout: 60 });
		expect(result!.fullOutputPath).toBe("/tmp/pi-bash-cb1.log");
	});

	it("a details object without a string fullOutputPath sets neither garbage nor a path", () => {
		const messages: AgentMessage[] = [
			user("q"),
			assistantWithCalls([{ id: "cb2", name: "bash" }]),
			{ ...toolResult("cb2", "ok", "bash"), details: { fullOutputPath: 42 } } as AgentMessage,
		];
		const result = linearize(messages).find((b) => b.kind === "tool_result");
		expect(result!.fullOutputPath).toBeUndefined();
	});
});

describe("fold event threads input + fullOutputPath to envelope, registry, span, and recall", () => {
	function setup() {
		const d = mkdtempSync(join(tmpdir(), "contextfold-fullout-"));
		dir = d;
		const registry = new MapSpoolRegistry();
		const spool = new SpoolStore(d);
		const index = new SeedIndexStore(d);
		const e = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, registry);
		e.onFoldEvent = (ev) => emitFoldIndex(ev, { spool, registry, index, sessionId: "s-fullout", now: 1_722_200_000_000 });
		return { e, registry, index, dir: d };
	}

	/** Enough pressure to fold, with one bash result carrying a real full-output file. */
	function sessionWithFullOutput(fullPath: string): AgentMessage[] {
		const messages: AgentMessage[] = [user("hunt the needle")];
		for (let i = 0; i < 7; i++) {
			messages.push(assistantWithCalls([{ id: `c${i}`, name: "read" }]));
			messages.push(bigResult(`c${i}`, 400));
		}
		messages.push(assistantWithCalls([{ id: "cbash", name: "bash", args: { command: "make bench" } }]));
		const truncated = Array.from({ length: 300 }, (_, i) => `kept line ${i}: ${"z".repeat(40)}`).join("\n");
		messages.push(bashResult("cbash", truncated, fullPath));
		messages.push(assistantText("done", "after-bash"));
		messages.push(user("next question"));
		return messages;
	}

	it("envelope + registry + span carry the metadata, and grep answers from the full-output file", () => {
		const { e, registry, index, dir: d } = setup();
		// The full-output file holds a needle the truncated (spooled) content does NOT contain.
		const fullPath = join(mkdtempSync(join(tmpdir(), "contextfold-fulloutlog-")), "pi-bash-cbash.log");
		writeFileSync(fullPath, ["head line", "NEEDLE_ONLY_IN_FULL_OUTPUT=77", "tail line"].join("\n"), "utf8");

		e.process(sessionWithFullOutput(fullPath), { contextWindow: 80_000, tokens: null });

		const code = foldCode("r:cbash");
		const env = readEnvelopeAt(join(d, `${code}.json`));
		expect(env.input).toEqual({ command: "make bench" });
		expect(env.fullOutputPath).toBe(fullPath);

		expect(registry.get("r:cbash")?.fullOutputPath).toBe(fullPath);

		const span = index
			.readAll()
			.flatMap((r) => r.spans)
			.find((s) => s.blockId === "r:cbash");
		expect(span?.fullOutputPath).toBe(fullPath);

		const { matches, missing, errors } = e.resolveRecall([code], { grep: "NEEDLE_ONLY_IN_FULL_OUTPUT" });
		expect(missing).toEqual([]);
		expect(errors).toEqual([]);
		expect(matches[0].text).toContain("NEEDLE_ONLY_IN_FULL_OUTPUT=77");
		expect(matches[0].note).toContain("full output");
	});
});
