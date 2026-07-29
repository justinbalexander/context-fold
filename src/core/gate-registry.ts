/*
 * gate-registry.ts — the L0 ingestion gate's registry of born-folded blocks.
 *
 * When the gate decides a tool result is too big, it spools the raw payload (adapter side) and
 * records one entry here, keyed by the result's durable block id (`r:<toolCallId>`). From then on
 * the block enters the model-facing view ALREADY folded to a pointer digest — "born folded" — with
 * two distinct weights the policy must keep straight:
 *   • its POINTER weight (what actually costs tokens in the wire), charged to the budget;
 *   • its FULL weight (what it would cost warm), reported so the policy's accounting of what the
 *     block really costs stays honest.
 *
 * This is PURE core: the registry holds only serializable metadata (enough to render the pointer,
 * locate the spool file, and rebuild on resume). The adapter owns the disk I/O and populates it.
 */

/** One born-folded block. All fields are serializable so the registry can be event-sourced. */
export interface GateEntry {
	/** Durable block id of the folded tool result (`r:<toolCallId>`). */
	blockId: string;
	/** The 6-char fold code (= foldCode(blockId)); the pointer's {#code FOLDED} handle. */
	code: string;
	/** Full-fidelity token weight (estTokens(content)+overhead) — what this block would cost warm. */
	fullTokens: number;
	tool: string;
	/** The tool's input arguments, for the tool-aware pointer summary. */
	input?: unknown;
	isError: boolean;
	/** Byte length of the full spooled content. */
	bytes: number;
	/** estTokens of the full spooled content. */
	fullEstTokens: number;
	/** Absolute spool file path (self-locating pointer; recall reads from here). */
	spoolPath: string;
	/** Bash results: the tool's own full-output file, also searched by recall-grep. */
	fullOutputPath?: string;
	/** Set when this payload was identical to an earlier fold. */
	dedupOf?: string;
}

/** The gate's block registry. A plain keyed store; the adapter wires disk + persistence around it. */
export interface GateRegistry {
	has(blockId: string): boolean;
	get(blockId: string): GateEntry | undefined;
	set(entry: GateEntry): void;
	readonly size: number;
	entries(): IterableIterator<GateEntry>;
}

/** The default in-memory registry. Populated live and rebuilt from the session ledger on resume. */
export class MapGateRegistry implements GateRegistry {
	private readonly byId = new Map<string, GateEntry>();

	has(blockId: string): boolean {
		return this.byId.has(blockId);
	}
	get(blockId: string): GateEntry | undefined {
		return this.byId.get(blockId);
	}
	set(entry: GateEntry): void {
		this.byId.set(entry.blockId, entry);
	}
	/** Drop every entry (session switch within one process — stale codes must not cross sessions). */
	clear(): void {
		this.byId.clear();
	}
	get size(): number {
		return this.byId.size;
	}
	entries(): IterableIterator<GateEntry> {
		return this.byId.values();
	}
}
