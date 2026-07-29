/*
 * unfold-tool.test.ts — the agent-facing reversibility surface.
 *
 * These two tools are the entire contract between the agent and a folded block: everything the
 * model can do about a `{#code FOLDED}` pointer goes through `recall` or `unfold`. The tests drive
 * the registered `execute` functions the way Pi does, rather than calling the engine directly, so
 * the parameter handling (search vs codes, the grep fallback, the empty call) is covered too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { MapGateRegistry } from "../src/core/gate-registry";
import { foldCode } from "../src/core/digest";
import { Gate, GATE_DEFAULTS } from "../src/adapters/pi/gate";
import { SpoolStore } from "../src/adapters/pi/spool";
import { registerFoldTools } from "../src/adapters/pi/unfold-tool";
import type { AgentMessage } from "../src/core/block";
import { user, assistantWithCalls, bigResult, toolResult } from "./helpers";

let spoolDir: string;
beforeEach(() => {
	spoolDir = mkdtempSync(join(tmpdir(), "cf-tools-"));
});
afterEach(() => {
	rmSync(spoolDir, { recursive: true, force: true });
});

/**
 * A spool-backed L0 fold plus the registered tools. Partial retrieval (grep/lines) reads the
 * spool, so it is the gate path — a ladder mask with no spool entry resolves whole from memory.
 */
function gateFolded(): { tools: Map<string, StubTool>; code: string } {
	const registry = new MapGateRegistry();
	const store = new SpoolStore(spoolDir);
	const gate = new Gate({ enabled: true, ...GATE_DEFAULTS }, registry, () => store);
	const decision = gate.observe({
		toolName: "read",
		toolCallId: "c0",
		input: { path: "/x/y.log" },
		isError: false,
		content: [{ type: "text", text: needleBody() }],
	});
	expect(decision.folded).toBe(true);

	const engine = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, registry);
	engine.process([user("go"), assistantWithCalls([{ id: "c0", name: "read" }]), toolResult("c0", needleBody())], {
		contextWindow: 200_000,
		tokens: null,
	});

	const tools = new Map<string, StubTool>();
	registerFoldTools({ registerTool: (t: StubTool) => tools.set(t.name, t) } as never, engine, () => {});
	return { tools, code: decision.code! };
}

interface StubTool {
	name: string;
	execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
}

/** A folded session plus the registered tools, wired exactly as the extension wires them. */
function foldedSession(): { tools: Map<string, StubTool>; engine: ContextFoldEngine; messages: AgentMessage[]; unfoldedIds: string[] } {
	const engine = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, new MapGateRegistry());
	const messages: AgentMessage[] = [user("build the thing")];
	for (let i = 0; i < 8; i++) {
		messages.push(assistantWithCalls([{ id: `c${i}`, name: "read" }]));
		messages.push(i === 0 ? toolResult(`c${i}`, needleBody()) : bigResult(`c${i}`, 400));
	}
	messages.push(user("now the newest question"));
	engine.process(messages, { contextWindow: 80_000, tokens: null });

	const tools = new Map<string, StubTool>();
	const unfoldedIds: string[] = [];
	registerFoldTools({ registerTool: (t: StubTool) => tools.set(t.name, t) } as never, engine, (ids) => unfoldedIds.push(...ids));
	return { tools, engine, messages, unfoldedIds };
}

/** A result body with one distinctive line buried in bulk, big enough to be masked. */
function needleBody(): string {
	const lines = Array.from({ length: 400 }, (_, i) => `line ${i}: ${"filler ".repeat(6)}`);
	lines[199] = "line 199: the SPECIFIC_NEEDLE_XYZ value is 8931";
	return lines.join("\n");
}

/** The fold code of the first masked block (the one carrying the needle). */
function needleCode(): string {
	return foldCode("r:c0");
}

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join("\n");

describe("recall tool", () => {
	it("returns a folded block's original content without unfolding it", async () => {
		const { tools, engine, messages } = foldedSession();
		const res = await tools.get("recall")!.execute("t1", { codes: [needleCode()] });

		expect(text(res)).toContain("SPECIFIC_NEEDLE_XYZ");
		expect((res.details as { recalled: string[] }).recalled).toEqual([needleCode()]);

		// Read-only: the block is still folded in the next outgoing view.
		const after = engine.process(messages, { contextWindow: 80_000, tokens: null });
		const block = after.find((m) => (m as { toolCallId?: string }).toolCallId === "c0") as { content: { text: string }[] };
		expect(block.content[0].text).toContain("FOLDED");
	});

	it("slices a spool-backed fold with grep instead of returning the whole result", async () => {
		const { tools, code } = gateFolded();
		const res = await tools.get("recall")!.execute("t1", { codes: [code], grep: "SPECIFIC_NEEDLE_XYZ" });
		const body = text(res);

		expect(body).toContain("SPECIFIC_NEEDLE_XYZ");
		expect(body).not.toContain("line 5: "); // non-matching bulk stayed out
	});

	it("search sweeps every folded block in one call, grouped by code", async () => {
		const { tools } = foldedSession();
		const res = await tools.get("recall")!.execute("t1", { search: "line 199" });
		const body = text(res);

		expect(body).toContain(`=== ${needleCode()}`);
		expect((res.details as { searched: string }).searched).toBe("line 199");
		// Grouped output names more than one folded block — that is the point of a sweep.
		expect(body.match(/^=== /gm)?.length).toBeGreaterThan(1);
	});

	it("with codes AND search but no grep, search becomes the slice term", async () => {
		const { tools, code } = gateFolded();
		const res = await tools.get("recall")!.execute("t1", { codes: [code], search: "SPECIFIC_NEEDLE_XYZ" });
		const body = text(res);

		expect(body).toContain("SPECIFIC_NEEDLE_XYZ");
		expect(body).not.toContain("line 5: "); // routed to grep, not returned whole
	});

	it("says what to do when called with neither codes nor search", async () => {
		const { tools } = foldedSession();
		const res = await tools.get("recall")!.execute("t1", {});
		expect(text(res)).toContain("search=<term>");
	});

	it("reports an unknown code as missing rather than failing", async () => {
		const { tools } = foldedSession();
		const res = await tools.get("recall")!.execute("t1", { codes: ["zzzzzz"] });

		expect(text(res)).toContain("no folded block with that code");
		expect((res.details as { missing: string[] }).missing).toEqual(["zzzzzz"]);
	});

	it("accepts the full {#code FOLDED} tag, not just the bare code", async () => {
		const { tools } = foldedSession();
		const res = await tools.get("recall")!.execute("t1", { codes: [`{#${needleCode()} FOLDED}`] });
		expect(text(res)).toContain("SPECIFIC_NEEDLE_XYZ");
	});
});

describe("unfold tool", () => {
	it("expands the block from the next turn on, and reports the ids for persistence", async () => {
		const { tools, engine, messages, unfoldedIds } = foldedSession();
		const res = await tools.get("unfold")!.execute("t1", { codes: [needleCode()] });

		// The content is NOT echoed this turn — it arrives via the next context hook.
		expect(text(res)).toContain("next turn");
		expect(text(res)).not.toContain("SPECIFIC_NEEDLE_XYZ");
		// The block ids are handed to the caller so the unfold survives resume.
		expect(unfoldedIds).toEqual(["r:c0"]);

		const after = engine.process(messages, { contextWindow: 80_000, tokens: null });
		const block = after.find((m) => (m as { toolCallId?: string }).toolCallId === "c0") as { content: { text: string }[] };
		expect(block.content[0].text).toContain("SPECIFIC_NEEDLE_XYZ");
	});

	it("an unfolded block is never re-masked by a later fold event", async () => {
		const { tools, engine, messages } = foldedSession();
		await tools.get("unfold")!.execute("t1", { codes: [needleCode()] });

		// Squeeze hard: renewed pressure must not undo a deliberate agent decision.
		const after = engine.process(messages, { contextWindow: 12_000, tokens: null });
		const block = after.find((m) => (m as { toolCallId?: string }).toolCallId === "c0") as { content: { text: string }[] };
		expect(block.content[0].text).toContain("SPECIFIC_NEEDLE_XYZ");
	});

	it("reports an unknown code as missing and persists nothing", async () => {
		const { tools, unfoldedIds } = foldedSession();
		const res = await tools.get("unfold")!.execute("t1", { codes: ["zzzzzz"] });

		expect(text(res)).toContain("no folded block with that code");
		expect(unfoldedIds).toEqual([]);
	});
});
