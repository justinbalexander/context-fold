/*
 * contract.ts — the policy ⇄ mechanism contract.
 *
 * A "policy" (conductor) is an interchangeable context-management strategy. The whole contract
 * is the shape of one pure idea:
 *
 *     conduct(view) → Command[]
 *
 * The host hands the policy a read-only VIEW of the context; the policy replies with COMMANDS
 * describing the context it wants. The host clamps those to the one floor it enforces —
 * provider-validity, "the message must always stay sendable" — applies them, and reports back
 * anything it had to clamp.
 *
 * Pure, serializable data and types only. Zero engine/harness dependency — the block kind union
 * is mirrored locally. Ported from Accordion `conductors/contract/conductor.ts` (commit 0c22434),
 * trimmed to the surface this port uses.
 */

/** The block kinds, mirrored so this contract has zero engine dependency. */
export type ConductorBlockKind = "user" | "text" | "thinking" | "tool_call" | "tool_result";

/** JSON-shaped telemetry payloads a policy may attach to display-only status. */
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

/** One block as every policy sees it — pure serializable data. */
export interface ViewBlock {
	id: string;
	/** Stable provider-message grouping key. Blocks with the same key snap together in groups. */
	messageKey?: string;
	kind: ConductorBlockKind;
	turn: number;
	order: number;
	tokens: number; // full token cost
	/** Token cost if folded — digest size for a foldable kind, full tokens for a non-foldable kind. */
	foldedTokens: number;
	toolName?: string;
	callId?: string;
	isError?: boolean;
	held: boolean; // a human/agent override owns this block
	folded: boolean; // currently rendered folded in the view
	/**
	 * Born folded by the L0 ingestion gate: this block entered the view already collapsed to a
	 * pointer digest. It is TERMINAL — the fidelity ladder and hard-cap floor never touch it (its
	 * `foldedTokens` is the pointer weight the budget already counts), but ranking still sees its
	 * full `tokens` so relevance stays honest.
	 */
	bornFolded?: boolean;
	/**
	 * Frozen by a committed prefix-stable layer: this block's substitution bytes are fixed for
	 * the session (they extend the byte-stable head that keeps the provider's prompt cache warm).
	 * TERMINAL like `bornFolded` — never re-ranked, re-laddered, grouped, or dropped; only an
	 * explicit agent unfold (which deliberately breaks the prefix at one point) or an engine
	 * consolidation epoch releases it.
	 */
	frozen?: boolean;
	protected: boolean; // inside the protected working tail
	grouped: boolean; // member of a folded group (host owns it)
	text?: string; // full content
	preview?: string; // one-line taste
}

/**
 * A read-only view of the context the policy reasons over. `liveTokens` is the baseline the
 * policy folds down FROM (the host has cleared the previous pass). `protectedFromIndex` /
 * `protectTokens` surface the host's protected working tail as policy.
 */
export interface ConductorView {
	/** Every block, in conversation order. */
	blocks: ViewBlock[];
	/** Token budget for the live context window. */
	budget: number;
	/** The model's total context window as reported by the host, or null if unknown. */
	contextWindow: number | null;
	/** Live token cost at the moment the view is built — the baseline to fold down from. */
	liveTokens: number;
	/** Pi's current usage estimate, anchored by the provider's last reported token count. */
	reportedTokens?: number;
	/** The real model-window threshold corresponding to `budgetFraction`. */
	reportedBudget?: number;
	/** Index of the first block in the host's protected working tail. `blocks.length` ⇒ no tail. */
	protectedFromIndex: number;
	/** The protected-tail token target driving `protectedFromIndex`. */
	protectTokens: number;
}

/**
 * The command vocabulary. Every command is CONTENT SUBSTITUTION, never structural removal — a
 * block is never spliced out, only its content changes, and the message count never moves. That
 * rule makes broken states unrepresentable: a tool_call/tool_result pair can never orphan.
 *
 * Each `conduct()` return is the policy's COMPLETE desired state; the host resets to baseline
 * then applies the batch. `[]` = clear to raw; `null` = HOLD (reuse last batch).
 */
export type Command = FoldCommand | ReplaceCommand;

/** Collapse blocks to a digest. No `digest` → host per-kind digest (with the recoverable tag). */
export interface FoldCommand {
	kind: "fold";
	ids: string[];
	digest?: string;
}

/**
 * Substitute a block's content with arbitrary text the policy chose. The block stays in place
 * (callId/pairing intact). `content: ""` → host folds to the standard digest (smallest wire-safe
 * form). `recoverable:true` → host prepends the `{#code FOLDED}` tag so the agent can unfold to
 * the ORIGINAL. The policy supplies the BODY only; the host owns the tag.
 */
export interface ReplaceCommand {
	kind: "replace";
	id: string;
	content: string;
	recoverable?: boolean;
}

// ─── Host capabilities & ledger telemetry ────────────────────────────────────

/** Optional services the host MAY offer. Always call `host.can(id)` before depending on one. */
export type HostCapabilityId = "countTokens" | "digest";

/** Host services available to an in-process policy. Optional ones are gated on `can()`. */
export interface ConductorHost {
	/** Is `capability` available right now? */
	can(capability: HostCapabilityId): boolean;
	/** Synchronous token estimate for `text`, using the host's tokenizer. */
	countTokens(text: string): number;
	/** The engine's per-kind folded digest for block `id`, or `null` if unknown. */
	digestOf(id: string): string | null;
	/** Surface display-only status to the human; `null` clears it. */
	setStatus(text: string | null, metrics?: Record<string, number | string | boolean>, details?: JSONValue): void;
	/** Ask the host to re-run `conduct()` after async work completes. */
	requestRerun(): void;
}

/**
 * A context-management strategy. The host calls `conduct()` whenever the context changes.
 *  - `Command[]` — the complete desired state; the host resets to baseline and applies it.
 *  - `[]` — explicitly clear to raw.
 *  - `null` — HOLD: reuse the last non-null batch.
 * `conduct()` MUST be synchronous and side-effect-free with respect to the view.
 */
export interface Conductor {
	readonly id: string;
	readonly label: string;
	attach?(host: ConductorHost): void;
	detach?(): void;
	conduct(view: ConductorView): Command[] | null;
}
