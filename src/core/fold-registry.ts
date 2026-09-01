/*
 * fold-registry.ts — serializable metadata for the exact content behind folded blocks.
 *
 * The adapter records one entry here when the pressure-driven ladder masks a block (and when
 * hard compaction removes a never-folded block from live history). The entry names the block's
 * durable id, its `{#code FOLDED}` handle, and a sha256 of the block text at fold time. Recall
 * re-locates the bytes in Pi's append-only session ledger by durable id and verifies them
 * against the recorded sha — the ledger is the durability floor; this store holds metadata only.
 * Pure core: the adapter owns the ledger read and rebuilds this registry on resume.
 */

/** One folded (or compacted-away) block. All fields are serializable for event-sourced persistence. */
export interface FoldEntry {
	/** Durable id of the folded block. */
	blockId: string;
	/** The 6-char fold code (= foldCode(blockId)); the pointer's {#code FOLDED} handle. */
	code: string;
	tool: string;
	isError: boolean;
	/** Byte length of the full folded content (UTF-8). */
	bytes: number;
	/** sha256 (hex) of the block text at fold time. Absent on a legacy record restored from a
	 *  pre-ledger session — recall serves the ledger bytes unverified and says so. */
	sha256?: string;
	/** For bash results: the tool's own full-output file; recall grep/lines prefer it. */
	fullOutputPath?: string;
}

/** In-memory registry, populated on fold and rebuilt from the session ledger on resume. */
export class MapFoldRegistry {
	private readonly byId = new Map<string, FoldEntry>();

	has(blockId: string): boolean {
		return this.byId.has(blockId);
	}
	get(blockId: string): FoldEntry | undefined {
		return this.byId.get(blockId);
	}
	set(entry: FoldEntry): void {
		this.byId.set(entry.blockId, entry);
	}
	/** Drop every entry when one Pi process switches sessions. */
	clear(): void {
		this.byId.clear();
	}
	get size(): number {
		return this.byId.size;
	}
	entries(): IterableIterator<FoldEntry> {
		return this.byId.values();
	}
}
