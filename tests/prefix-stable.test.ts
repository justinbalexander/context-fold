/*
 * prefix-stable.test.ts — Stage 2: frozen layers, oldest-first ranking, floor guard,
 * consolidation, unfold masking, and byte-exact persistence roundtrip.
 */
import { describe, expect, it } from "vitest";
import { ContextFoldEngine, type FrozenLayer } from "../src/adapters/pi/store";
import { PrefixStableKeel } from "../src/core/policy/prefix-stable";
import { KeelConductor } from "../src/core/policy/keel";
import { MapGateRegistry } from "../src/core/gate-registry";
import { restoreFoldState, recordLayer, recordLayerBreak, FOLD_CUSTOM_TYPE, type EntryLike } from "../src/adapters/pi/persistence";
import type { ViewBlock } from "../src/core/contract";
import type { AgentMessage } from "../src/core/block";
import { foldCode } from "../src/core/digest";
import { user, assistantWithCalls, bigResult } from "./helpers";

function engine(cfg: Record<string, unknown> = {}) {
	const e = new ContextFoldEngine(new PrefixStableKeel(), { tailTarget: 100, prefixStable: true, ...cfg }, null, null, new MapGateRegistry());
	const committed: FrozenLayer[] = [];
	const broken: number[] = [];
	e.onLayerCommit = (layer) => committed.push(layer);
	e.onLayerBreak = (seq) => broken.push(seq);
	return { e, committed, broken };
}

/** A session with `n` big tool results followed by a small tail exchange. */
function session(n: number, linesEach = 400): { messages: AgentMessage[]; callIds: string[] } {
	const messages: AgentMessage[] = [user("build the thing")];
	const callIds: string[] = [];
	for (let i = 0; i < n; i++) {
		const id = `c${i}`;
		callIds.push(id);
		messages.push(assistantWithCalls([{ id, name: "read" }]));
		messages.push(bigResult(id, linesEach));
	}
	messages.push(user("now the newest question"));
	return { messages, callIds };
}

function resultText(messages: AgentMessage[], callId: string): string {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const tr = m as { toolCallId?: string; content?: { type: string; text?: string }[] };
		if (tr.toolCallId === callId) return tr.content?.[0]?.text ?? "";
	}
	throw new Error(`no toolResult for ${callId}`);
}

describe("PrefixStableKeel ranking", () => {
	it("orders candidates strictly by conversation position, oldest first", () => {
		class Probe extends PrefixStableKeel {
			rankPublic(blocks: ViewBlock[], roots: Set<string>) {
				return this.rank(blocks, roots, { currentTurn: 10, recalls: new Map(), tailCallIds: new Set() });
			}
		}
		const mk = (id: string, order: number, extra: Partial<ViewBlock> = {}): ViewBlock => ({
			id,
			kind: "tool_result",
			turn: order,
			order,
			tokens: 1000,
			foldedTokens: 40,
			held: false,
			folded: false,
			protected: false,
			grouped: false,
			text: `content of ${id}`,
			...extra,
		});
		// Deliberately adversarial order: newest first in the array, a frozen block in between.
		const blocks = [mk("b3", 30), mk("b1", 10), mk("bf", 20, { frozen: true }), mk("b2", 25)];
		const ranked = new Probe().rankPublic(blocks, new Set());
		expect(ranked.map((r) => r.block.id)).toEqual(["b1", "b2", "b3"]); // frozen excluded, oldest first
	});
});

describe("frozen layers", () => {
	it("commits an epoch as a layer and re-emits byte-identical substitutions", () => {
		const { e, committed } = engine();
		const { messages, callIds } = session(3);
		const cw = 16_000; // budget 12k against ~15k live → digest folds, no groups

		const first = e.process(messages, cw);
		expect(committed.length).toBe(1);
		expect(committed[0].seq).toBe(1);
		expect(committed[0].entries.length).toBeGreaterThan(0);
		const frozenId = committed[0].entries[0].id;
		const frozenCall = frozenId.replace(/^r:/, "");
		const firstText = resultText(first, frozenCall);
		expect(firstText).toContain("FOLDED");

		const second = e.process(messages, cw);
		// No second layer for the same epoch, and the frozen bytes are identical.
		expect(committed.length).toBe(1);
		expect(resultText(second, frozenCall)).toBe(firstText);
		// Oldest-first: the earliest tool result is among the frozen ids.
		expect(committed[0].entries.map((x) => x.id)).toContain(`r:${callIds[0]}`);
	});

	it("keeps frozen substitutions applied when pressure drops", () => {
		const { e, committed } = engine();
		const { messages } = session(3);
		e.process(messages, 16_000);
		expect(committed.length).toBe(1);
		const frozenCall = committed[0].entries[0].id.replace(/^r:/, "");

		// Same session, huge window: keel returns [] but the frozen head must stay folded.
		const relaxed = e.process(messages, 10_000_000);
		expect(resultText(relaxed, frozenCall)).toContain("FOLDED");
	});

	it("an unfold masks a frozen id and renders it raw (deliberate prefix break)", () => {
		const { e, committed } = engine();
		const { messages } = session(3);
		e.process(messages, 16_000);
		const frozenId = committed[0].entries[0].id;
		const frozenCall = frozenId.replace(/^r:/, "");

		const res = e.markUnfold([foldCode(frozenId)]);
		expect(res.missing).toEqual([]);
		const after = e.process(messages, 10_000_000);
		expect(resultText(after, frozenCall)).toContain("line 0:"); // raw content back
	});

	it("consolidation breaks the oldest layer when the budget is unreachable, bounded", () => {
		const { e, committed, broken } = engine();
		const base = session(6, 400);
		e.process(base.messages, 20_000); // freeze an epoch
		expect(committed.length).toBe(1);

		// Shrink the window drastically: frozen digests + tail exceed the cap, the floor may not
		// touch frozen blocks, so the engine must break layer 1 and replan (groups now allowed).
		const squeezed = e.process(base.messages, 700);
		expect(broken).toEqual([1]);
		expect(squeezed).not.toBe(base.messages);
	});

	it("frozen bytes change only through an explicit, recorded layer break", () => {
		const { e, committed, broken } = engine();
		const grown = session(6, 400);
		e.process(grown.messages, 20_000);
		const layer1 = committed[0];
		// Squeeze the window. Two sanctioned outcomes: the frozen head still fits (bytes must be
		// identical), or it no longer can (a consolidation MUST be recorded before anything moves).
		const out = e.process(grown.messages, 6_000);
		if (broken.length === 0) {
			for (const entry of layer1.entries) {
				expect(resultText(out, entry.id.replace(/^r:/, ""))).toBe(entry.digestText);
			}
		} else {
			expect(broken).toEqual([layer1.seq]);
			// The deepened replan recommitted — the head is governed by a layer again, not adrift.
			expect(committed.length).toBeGreaterThan(1);
		}
	});
});

describe("persistence roundtrip", () => {
	it("layers survive record → restore byte-exactly, and layer-break removes one", () => {
		const entries: EntryLike[] = [];
		const appender = { appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }) };

		const { e, committed } = engine();
		const { messages } = session(3);
		const before = e.process(messages, 16_000);
		for (const layer of committed) recordLayer(appender, layer);
		const frozenCall = committed[0].entries[0].id.replace(/^r:/, "");
		const frozenText = resultText(before, frozenCall);

		// Fresh engine (resume): restore from the recorded entries only.
		const fresh = engine();
		const restored = restoreFoldState(entries);
		expect(restored.layers.length).toBe(1);
		fresh.e.restoreLayers(restored.layers);
		const after = fresh.e.process(messages, 10_000_000);
		expect(resultText(after, frozenCall)).toBe(frozenText);

		// A break record deletes the layer on restore.
		recordLayerBreak(appender, committed[0].seq);
		expect(restoreFoldState(entries).layers.length).toBe(0);
		expect(entries.every((x) => x.customType === FOLD_CUSTOM_TYPE)).toBe(true);
	});
});

describe("default path unchanged", () => {
	it("with the flag off, no layers commit and plain Keel behavior holds", () => {
		const e = new ContextFoldEngine(new KeelConductor(), { tailTarget: 100 }, null, null, new MapGateRegistry());
		let commits = 0;
		e.onLayerCommit = () => commits++;
		const { messages } = session(3);
		e.process(messages, 16_000);
		expect(commits).toBe(0);
	});
});
