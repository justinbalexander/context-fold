/*
 * gate-dedup.test.ts — probing the e2e-gate (c) flake class: a LARGE DUPLICATE result under
 * model thrash (same payload cat'd twice, retries, interleaved sessions) must still fold to a
 * pointer and recall through its alias envelope.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderConductor } from "../src/core/policy/fold-ladder";
import { MapGateRegistry } from "../src/core/gate-registry";
import { Gate, GATE_DEFAULTS } from "../src/adapters/pi/gate";
import { SpoolStore, readEnvelopeAt } from "../src/adapters/pi/spool";
import type { AgentMessage } from "../src/core/block";
import { user, assistantWithCalls, toolResult } from "./helpers";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BIG = Array.from({ length: 900 }, (_, i) => `line ${i}: routine filler to exceed the fold threshold comfortably`).join("\n");

function observe(gate: Gate, callId: string, text = BIG) {
	return gate.observe({ toolName: "exec", toolCallId: callId, input: { cmd: "cat report.log" }, isError: false, content: [{ type: "text", text }] });
}

describe("duplicate flood folding", () => {
	it("the second identical flood folds as a dedup alias and both render as pointers", () => {
		dir = mkdtempSync(join(tmpdir(), "contextfold-dedup-"));
		const registry = new MapGateRegistry();
		const spool = new SpoolStore(dir);
		const gate = new Gate({ enabled: true, ...GATE_DEFAULTS }, registry, () => spool);

		const first = observe(gate, "call-1");
		const second = observe(gate, "call-2");
		expect(first.folded).toBe(true);
		expect(second.folded).toBe(true);
		expect(second.dedupOf).toBe(first.code);

		// Both blocks substitute to pointers in the view.
		const messages: AgentMessage[] = [
			user("read it twice"),
			assistantWithCalls([{ id: "call-1", name: "exec" }]),
			toolResult("call-1", BIG, "exec"),
			assistantWithCalls([{ id: "call-2", name: "exec" }]),
			toolResult("call-2", BIG, "exec"),
			user("tail"),
		];
		const e = new ContextFoldEngine(new FoldLadderConductor(), { tailTarget: 100, prefixStable: true }, null, null, registry);
		const out = e.process(messages, { contextWindow: 10_000_000, tokens: null });
		const texts = out
			.filter((m) => (m as { role?: string }).role === "toolResult")
			.map((m) => ((m as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n"));
		expect(texts).toHaveLength(2);
		for (const t of texts) {
			expect(t).toContain("FOLDED}");
			expect(t.length).toBeLessThan(3000);
		}

		// The alias resolves to the original content byte-exact.
		const dupEntry = registry.get("r:call-2")!;
		expect(readEnvelopeAt(dupEntry.spoolPath).content).toBe(BIG);
	});

	it("a retry that rewrites the SAME call's content re-spools without corrupting dedup", () => {
		dir = mkdtempSync(join(tmpdir(), "contextfold-dedup-"));
		const registry = new MapGateRegistry();
		const spool = new SpoolStore(dir);
		const gate = new Gate({ enabled: true, ...GATE_DEFAULTS }, registry, () => spool);

		expect(observe(gate, "call-1").folded).toBe(true);
		const changed = BIG.replace("line 5:", "line 5 CHANGED:");
		expect(observe(gate, "call-1", changed).folded).toBe(true); // retry, new bytes
		// A later duplicate of the ORIGINAL bytes must not alias to the rewritten envelope.
		const third = observe(gate, "call-3");
		expect(third.folded).toBe(true);
		const e3 = registry.get("r:call-3")!;
		expect(readEnvelopeAt(e3.spoolPath).content).toBe(BIG);
	});
});
