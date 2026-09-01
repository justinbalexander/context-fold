/*
 * ledger.ts — the ledger read route behind recall.
 *
 * Pi's session is append-only ("Entries cannot be modified or deleted" — SessionManager docs),
 * so the raw payload of every folded block survives hard compaction and resume in
 * `sessionManager.getEntries()`. Recall re-locates a block by re-linearizing the ledger's
 * message entries with the same durable-id formula that named it at fold time, then verifies
 * the text against the sha256 the fold recorded. No copy of the content is kept anywhere else.
 *
 * Linearization is cached and invalidated by entry count — appends are the only mutation the
 * ledger permits, so a stable count means a stable block map.
 */
import { createHash } from "node:crypto";
import { linearize, type AgentMessage, type WireBlock } from "../../core/block";

export function sha256Hex(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex");
}

/** The one shape read off a session entry (SessionMessageEntry: `{type:"message", message}`). */
export interface LedgerEntryLike {
	type?: string;
	message?: unknown;
}

/** What the engine needs from the ledger: durable block id → the block's full text. */
export interface LedgerLookup {
	blockById(id: string): { text: string } | undefined;
}

export class LedgerReader implements LedgerLookup {
	private cache: { count: number; byId: Map<string, WireBlock> } | null = null;

	constructor(private readonly getEntries: () => LedgerEntryLike[]) {}

	blockById(id: string): WireBlock | undefined {
		const entries = this.getEntries();
		if (!this.cache || this.cache.count !== entries.length) {
			const messages: AgentMessage[] = [];
			for (const e of entries) {
				if (e?.type === "message" && e.message && typeof e.message === "object") {
					messages.push(e.message as AgentMessage);
				}
			}
			// Latest-per-id wins (a retried tool call re-records under the same durable id); the
			// Map insertion order of linearize is chronological, so later entries overwrite.
			const byId = new Map<string, WireBlock>();
			for (const b of linearize(messages)) byId.set(b.id, b);
			this.cache = { count: entries.length, byId };
		}
		return this.cache.byId.get(id);
	}
}
