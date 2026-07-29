/*
 * index-store.ts — seed-index emission at fold events (docs/SEED_INDEX_SPEC.md).
 *
 * On every fold event the adapter (1) spools each masked block's full text — the C-layer
 * durability floor: even a below-gate-threshold observation that folds out of view has a
 * sha256-verified on-disk copy — and (2) appends one deterministic index record to
 * `<spoolDir>/seed-index.jsonl`. The JSONL is append-only and IS the persistence: resume just
 * keeps appending under later seqs, and `latest record per seq wins` is the consumer contract.
 *
 * Fail-open like every sibling: an index/spool failure costs the record, never the turn.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractIndex, buildIndexRecord, type IndexBlock, type IndexSpan, type SeedIndexRecord } from "../../core/index/seed-index";
import { foldCode } from "../../core/digest";
import { BLOCK_OVERHEAD } from "../../core/tokens";
import type { WireBlock } from "../../core/block";
import type { FoldEventReport } from "./store";
import type { SpoolStore } from "./spool";
import type { GateEntry, GateRegistry } from "../../core/gate-registry";

export const INDEX_FILENAME = "seed-index.jsonl";
export const INDEX_HARNESS = "pi-context-fold";

export class SeedIndexStore {
	private ensured = false;
	constructor(private readonly dir: string) {}

	get path(): string {
		return join(this.dir, INDEX_FILENAME);
	}

	append(record: SeedIndexRecord): void {
		if (!this.ensured) {
			mkdirSync(dirname(this.path), { recursive: true });
			this.ensured = true;
		}
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
	}

	/** All parseable records, file order. Tolerates junk lines and unknown higher versions. */
	readAll(): SeedIndexRecord[] {
		if (!existsSync(this.path)) return [];
		const out: SeedIndexRecord[] = [];
		for (const line of readFileSync(this.path, "utf8").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const rec = JSON.parse(t) as SeedIndexRecord;
				if (rec && rec.kind === "fold-index" && Array.isArray(rec.spans)) out.push(rec);
			} catch {
				/* junk line — skip */
			}
		}
		return out;
	}
}

/**
 * Handle one engine fold event: spool the masked blocks (skipping any the L0 gate already owns),
 * build spans, extract the index fields, and append the record. Deterministic except for `now`.
 */
export function emitFoldIndex(
	event: FoldEventReport,
	deps: {
		spool: SpoolStore;
		registry: GateRegistry;
		index: SeedIndexStore;
		sessionId: string;
		now?: number;
	},
): { record: SeedIndexRecord; newEntries: GateEntry[] } {
	const byId = new Map(event.blocks.map((b) => [b.id, b] as const));
	const masked: WireBlock[] = [];
	for (const id of event.maskedIds) {
		const b = byId.get(id);
		if (b) masked.push(b);
	}

	const spans: IndexSpan[] = [];
	const newEntries: GateEntry[] = [];
	for (const b of masked) {
		const gateEntry = deps.registry.get(b.id);
		if (gateEntry) {
			// Already gate-spooled — point at the existing envelope, don't duplicate.
			spans.push({
				blockId: b.id,
				code: gateEntry.code,
				tool: gateEntry.tool,
				turn: b.turn,
				log: { path: gateEntry.spoolPath, byteStart: 0, byteEnd: gateEntry.bytes, lines: countLines(b.text) },
				fullOutputPath: gateEntry.fullOutputPath,
			});
			continue;
		}
		try {
			const code = foldCode(b.id);
			const res = deps.spool.write({
				blockId: b.id,
				code,
				tool: b.toolName ?? b.kind,
				input: undefined,
				isError: b.isError ?? false,
				content: b.text,
				now: deps.now,
			});
			spans.push({
				blockId: b.id,
				code,
				tool: b.toolName ?? b.kind,
				turn: b.turn,
				log: {
					path: deps.spool.pathFor(code),
					byteStart: 0,
					byteEnd: res.envelope.bytes,
					lines: countLines(b.text),
				},
			});
			// Register the spooled mask so recall-by-code survives HARD compaction (once Pi removes
			// the raw message from history, the snapshot path is gone; the registry + spool is the
			// durable route). In the live view the frozen layer's bytes still win — the engine skips
			// frozen ids when substituting pointers.
			const entry: GateEntry = {
				blockId: b.id,
				code,
				fullTokens: b.tokens + BLOCK_OVERHEAD,
				tool: b.toolName ?? b.kind,
				input: undefined,
				isError: b.isError ?? false,
				bytes: res.envelope.bytes,
				fullEstTokens: res.envelope.estTokens,
				spoolPath: deps.spool.pathFor(code),
				dedupOf: res.dedupOf,
			};
			deps.registry.set(entry);
			newEntries.push(entry);
		} catch {
			// Fold-code collision or disk trouble: the span is lost but the record still carries the
			// lexical fields, and recall-from-snapshot still works — degrade, don't abort.
		}
	}

	const record = buildIndexRecord(
		{
			harness: INDEX_HARNESS,
			session: deps.sessionId,
			seq: event.seq,
			at: new Date(deps.now ?? Date.now()).toISOString(),
			trigger: event.trigger,
			usage: {
				tokens: Math.round(event.usage.tokens),
				contextWindow: event.usage.contextWindow,
				fraction: Math.round(event.usage.fraction * 1000) / 1000,
			},
		},
		extractIndex({ masked: masked as unknown as IndexBlock[], all: event.blocks as unknown as IndexBlock[] }),
		spans,
	);
	deps.index.append(record);
	return { record, newEntries };
}

/**
 * Emit the FINAL index record at hard compaction: the whole span being summarized is about to
 * leave live history, so index it all (Pi's session JSONL keeps the raw entries; spooled blocks
 * additionally carry spans here). Returns the record for the det-summary renderer.
 */
export function emitCompactIndex(
	blocks: WireBlock[],
	deps: {
		registry: GateRegistry;
		index: SeedIndexStore;
		sessionId: string;
		tokensBefore: number;
		contextWindow: number | null;
		now?: number;
	},
): SeedIndexRecord {
	const masked = blocks.filter((b) => b.kind !== "user");
	const spans: IndexSpan[] = [];
	for (const b of masked) {
		const e = deps.registry.get(b.id);
		if (!e) continue;
		spans.push({
			blockId: b.id,
			code: e.code,
			tool: e.tool,
			turn: b.turn,
			log: { path: e.spoolPath, byteStart: 0, byteEnd: e.bytes, lines: countLines(b.text) },
			fullOutputPath: e.fullOutputPath,
		});
	}
	const seq = deps.index.readAll().reduce((m, r) => Math.max(m, r.seq), 0) + 1;
	const cw = deps.contextWindow ?? 0;
	const record = buildIndexRecord(
		{
			harness: INDEX_HARNESS,
			session: deps.sessionId,
			seq,
			at: new Date(deps.now ?? Date.now()).toISOString(),
			trigger: "compact",
			usage: {
				tokens: deps.tokensBefore,
				contextWindow: cw,
				fraction: cw > 0 ? Math.round((deps.tokensBefore / cw) * 1000) / 1000 : 0,
			},
		},
		extractIndex({ masked: masked as unknown as IndexBlock[], all: blocks as unknown as IndexBlock[] }),
		spans,
	);
	deps.index.append(record);
	return record;
}

function countLines(s: string): number {
	if (!s) return 0;
	let n = 1;
	for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
	return n;
}
