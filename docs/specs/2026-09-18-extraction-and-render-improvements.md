# Extraction and rendering improvements for the deterministic summary

**Status:** spec for implementation. Target: the `justinbalexander/context-fold` fork.
**Audience:** an implementing agent that has NOT seen the design discussion. Everything needed is
in this document plus the referenced source files.
**Date:** 2026-09-18

This document specifies seven changes to context-fold's seed-index extraction and summary
rendering, plus two small cross-cutting changes. Every change preserves the extension's core
invariants. Do not refactor beyond what is specified here.

---

## 0. What context-fold is (60-second orientation)

context-fold is a pi extension that does deterministic, reversible context compaction:

- Stale tool output and thinking blocks in the live view are replaced with small digests that
  start with a `{#<code> FOLDED}` tag. The raw content stays in pi's append-only session JSONL
  ("the ledger"). The agent can pull a block back with the `recall_folded` / `unfold` tools.
- At pi's hard compaction, the extension intercepts `session_before_compact` and returns a
  summary rendered **verbatim from the seed index** instead of an LLM paraphrase
  (`CONTEXTFOLD_COMPACT=det`, the default).
- The **seed index** is an append-only JSONL at
  `<sessionDir>/context-fold/<sessionId>/seed-index.jsonl`, one record per fold event plus one
  final record at hard compaction. It is produced by pure regex extraction — no model, no clock
  (the caller supplies timestamps), no randomness. Same input ⇒ byte-identical output.

Repo layout:

```
src/core/                    # pure; NO pi imports, NO I/O, NO Date, NO Math.random
  block.ts                   # WireBlock model, linearize(), blockId(), isDurableId()
  tokens.ts                  # estTokens, clip, firstLine, safeSlice, BLOCK_OVERHEAD
  digest.ts                  # per-kind digests, foldCode(), foldTag(), collectRiskLines()
  index/seed-index.ts        # extractIndex(), buildIndexRecord(), record shapes   ← CHANGED
  policy/fold-ladder.ts      # when/what to fold (DO NOT TOUCH)
  policy/ledger.ts           # ERROR_MARKER_SOURCE, errorMarkerRe(), categorize()
src/adapters/pi/             # all pi API calls and disk I/O
  index.ts                   # extension entry; session_before_compact handler
  index-store.ts             # emitFoldIndex(), emitCompactIndex(), recordCompactedBlocks()
  compact.ts                 # renderDetCompactionSummary()                        ← CHANGED
  store.ts                   # the engine; fold-op build; code resolution          ← CHANGED (dedup)
  settings.ts                # saved settings read/write                          ← CHANGED
  handoff.ts                 # /fold-handoff — also calls renderDetCompactionSummary
docs/SEED_INDEX_SPEC.md      # the record format contract                         ← CHANGED (v3)
tests/                       # vitest; one file per area
```

Test commands: `npm run test` (vitest), `npm run typecheck` (tsc --noEmit). There is no build
step — pi loads the TypeScript directly.

## 1. Invariants — read before changing anything

These are load-bearing. A change that violates one is wrong even if tests pass.

1. **Core purity.** `src/core/**` must not import pi APIs, do I/O, read the clock, or use
   randomness. All time values are passed in by the adapter.
2. **Determinism.** Same inputs ⇒ byte-identical outputs. This includes iteration order: build
   arrays in a defined order, never from unordered maps unless the order is pinned. When you
   sort, specify the full comparator (no ties left to chance).
3. **Never loosen a test to make it pass.** If a golden/determinism assertion fails after your
   change, the change is wrong or the expected value must be regenerated with justification in
   the commit message. Say which you did.
4. **Frozen layers never change.** Committed substitution bytes (`frozenById` in store.ts) are
   immutable for the session. All substitution text is computed once, at fold time.
5. **The `{#<code> FOLDED}` tag is the engine's source-of-truth string.** The agent reads the
   code from it and passes it back. `store.ts` resolves codes by exact match against the
   registry; the tag parse regex is `/\{#([a-z0-9]{1,8})\s+FOLDED\}/i` (store.ts, `parseCode`).
6. **The index is append-only.** Records are never rewritten. A `fold-retract` record voids a
   seq. Readers tolerate unknown fields and unknown `v` (see SEED_INDEX_SPEC.md §Transport).
7. **Fail-open.** Any error in the fold path sends the turn out raw. Any error in compaction
   falls back to pi's default. Per-block failures (code collision, persistence throw) drop that
   block only, announced on stderr.
8. **User intent is never folded, tool_calls are never folded** (folding a call would orphan its
   result).
9. **Persist order:** fold records first, index record second, in-memory registry last
   (emitFoldIndex). Never advertise a span whose fold record is not durable.

## 2. Background: why these changes

A user reviewing the deterministic compaction summary flagged two problems:

1. **"Error lines observed" is untrustworthy-looking.** It lists any line containing an
   error-shaped word — grep hits on the word `error`, test names containing `Error`, `0 failed`
   summaries — with no turn, no source, and no way to judge relevance. The broad lexicon is
   intentional (recall-biased: "a missed spelling is the failure mode"), but the section needs
   provenance and a quality signal so readers can triage.
2. **"Commands run" is not useful.** Commands are clipped to their first line and 200 chars *at
   extraction time*, so multi-line commands (heredocs, `&&` chains) are destroyed before the
   record is written, and a clipped command is indistinguishable from a complete one.

Three more issues were identified while reading the code:

3. The summary unions **all** records in the session (last-seen-wins with caps), so sections
   read like a random sample across the whole session rather than a description of the span
   that just left history.
4. Identical tool outputs (repeated reads of an unchanged file) fold independently; the spans
   already carry sha256, so duplicates are detectable for free.
5. Fold codes are 6 chars of base36 (birthday collisions plausible around ~46k blocks/session).

## 3. The changes

Each change lists: what to change, the reference implementation, edge cases, and tests. The
reference code is illustrative — match the surrounding style (tabs, naming) rather than copying
whitespace. Commit order is §6.

---

### Change A — Provenance on errors and commands; isError-first error ordering; error context line

**Files:** `src/core/index/seed-index.ts`, `src/adapters/pi/compact.ts`, `docs/SEED_INDEX_SPEC.md`,
`tests/seed-index.test.ts`.

This bundles three extraction-layer changes because they all touch the same record fields.

#### A.1 New record shapes (seed index v3)

In `seed-index.ts`, add and export:

```ts
/** A verbatim error-shaped line with provenance and (when present) the following line. */
export interface ErrorLine {
	/** The marker line, trimmed, ≤ ERROR_CLIP (240) chars. */
	line: string;
	/** The line immediately after the marker line, trimmed, ≤ ERROR_CLIP, when non-empty.
	 *  The cause usually follows the marker (the line after `Traceback`, the `npm ERR!` detail). */
	context?: string;
	/** Turn of the source block. */
	turn: number;
	/** foldCode of the source block — a recall handle (only foldable blocks are masked, so it resolves). */
	code?: string;
	/** True when the source tool_result block carried pi's `isError` flag. */
	toolError?: boolean;
}

/** A shell-class command with provenance. `command` is the FULL command (see Change B). */
export interface IndexedCommand {
	command: string;
	turn: number;
	/** foldCode of the paired tool_result block (undefined for harvested `$ …` lines with no pair). */
	code?: string;
}
```

Change `SeedIndexRecord`:

```ts
files: string[];               // unchanged
commands: IndexedCommand[];    // v3 (v2: string[])
errors: ErrorLine[];           // v3 (v2: string[])
identifiers: string[];         // unchanged
```

`buildIndexRecord` writes `v: 3`. Bump the literal.

`files` and `identifiers` stay bare strings: a path names itself, and identifiers are grep keys.
Do not add provenance to them — that is deliberately out of scope.

#### A.2 Keyed dedup

The existing `Dedup` class keys on the trimmed value itself. With object entries we need a key
function. Replace/extend with:

```ts
/** Bounded insertion-ordered dedup set, keyed. First sighting wins (order and entry). */
class DedupKeyed<T> {
	private readonly seen = new Set<string>();
	private readonly list: T[] = [];
	constructor(private readonly cap: number, private readonly key: (v: T) => string) {}
	add(v: T): void {
		const k = this.key(v).trim();
		if (!k || this.seen.has(k) || this.list.length >= this.cap) return;
		this.seen.add(k);
		this.list.push(v);
	}
	values(): T[] {
		return this.list;
	}
}
```

Keep the existing `Dedup` for `files` (string-valued) or migrate it to `DedupKeyed` with an
identity key — pick one, note it in the commit.

#### A.3 Error extraction: isError blocks first, then provenance + context

Current code (`extractIndex`, errors section):

```ts
const errors = new Dedup(MAX_ERRORS);
const marker = errorMarkerRe();
for (const b of masked) {
	for (const line of b.text.split("\n")) {
		const t = line.trim();
		if (t && marker.test(t)) errors.add(safeSlice(t, ERROR_CLIP));
	}
}
out.errors = errors.values();
```

Replace with:

```ts
const errors = new DedupKeyed<ErrorLine>(MAX_ERRORS, (e) => e.line);
const marker = errorMarkerRe();
// Two passes in one ordered list: tool-flagged error blocks first. Their lines win the capped
// slots — a failure the tool itself reported outranks a line that merely mentions "error".
const ordered = [...masked.filter((b) => b.isError), ...masked.filter((b) => !b.isError)];
for (const b of ordered) {
	const lines = b.text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		if (!t || !marker.test(t)) continue;
		const next = i + 1 < lines.length ? lines[i + 1].trim() : "";
		errors.add({
			line: safeSlice(t, ERROR_CLIP),
			...(next ? { context: safeSlice(next, ERROR_CLIP) } : {}),
			turn: b.turn,
			code: foldCode(b.id),
			...(b.isError ? { toolError: true } : {}),
		});
	}
}
out.errors = errors.values();
```

Notes:

- `foldCode` is already imported or importable from `../digest` — it is pure (FNV-1a of the block
  id), so provenance needs no registry access. Import it; do not pass codes in from the adapter.
- The `isError` flag exists on `tool_result` blocks only (`block.ts`: `isError: !!m.isError`).
  `[...filter, ...filter]` is a stable partition — deterministic.
- Dedup key is the marker line only. First sighting wins, so provenance/context is from the
  earliest occurrence. A repeated identical line from an isError block later does NOT upgrade an
  earlier sighting — acceptable, document in the test.
- The context line is captured even when it also matches the marker (it will be added again by
  its own iteration; dedup handles it).
- Cap semantics unchanged: 24 entries per record. A context line does not count as an entry.

#### A.4 Command extraction gets the same provenance

For shell-class calls (see Change B for the full-command part — do both together if easier, but
keep the commits separate):

```ts
const commands = new DedupKeyed<IndexedCommand>(MAX_COMMANDS, (c) => c.command);
for (const call of pairedCalls) {
	if (!SHELL_TOOLS.has((call.toolName ?? "").toLowerCase())) continue;
	const args = call.text.replace(/^\S+\s*/, "");
	if (!args.trim()) continue;
	// Provenance points at the RESULT block (foldable, recallable), not the call (never folded).
	const result = masked.find((b) => b.kind === "tool_result" && b.callId === call.callId);
	commands.add({
		command: args.trim(), // Change B: full, hard-capped
		turn: result?.turn ?? call.turn,
		...(result ? { code: foldCode(result.id) } : {}),
	});
}
for (const b of masked) harvestCommands(b, commands); // signature change: takes the block
out.commands = commands.values();
```

`harvestCommands` changes to take the block (needs `b.turn` and `foldCode(b.id)` for provenance):

```ts
function harvestCommands(b: WireBlock, into: DedupKeyed<IndexedCommand>): void {
	for (const m of b.text.matchAll(DOLLAR_LINE_RE))
		into.add({ command: safeSlice(m[1], COMMAND_STORE_CLIP), turn: b.turn, code: foldCode(b.id) });
	for (const m of b.text.matchAll(TOOL_CMD_RE))
		into.add({ command: safeSlice(m[0].trim(), COMMAND_STORE_CLIP), turn: b.turn, code: foldCode(b.id) });
}
```

Dedup key is the full command string. Note this changes dedup granularity vs today (today the
key is the clipped first line; two commands sharing a first line but differing later were one
entry — now they are two). That is the intended fix.

#### A.5 Rendering (compact.ts)

Renderers must tolerate v2 records (string entries) because existing sessions' index files are
v2. Normalize at render:

```ts
function renderError(e: string | ErrorLine): string[] {
	if (typeof e === "string") return [`- ${e}`]; // v2 record
	const prov = `[turn ${e.turn}${e.code ? ` · ${e.code}` : ""}]`;
	const head = `- ${e.toolError ? "⚠ " : ""}${prov} ${e.line}`;
	return e.context ? [head, `  ↳ ${e.context}`] : [head];
}
```

Section rendering pushes each returned line. Example output:

```
## Error lines observed (verbatim)
- ⚠ [turn 41 · k3f9a2] npm ERR! code ELIFECYCLE
  ↳ npm ERR! Test failed.  See above for more details.
- [turn 52 · 9x2m71] grep: error: unknown option
```

`⚠` marks `toolError` entries. Command rendering is Change B.

#### A.6 Tests (tests/seed-index.test.ts)

- Error line from an `isError` block appears before lexicon-only lines when the cap is tight
  (build >24 matching lines across two blocks, assert order).
- Provenance fields: turn and a 6-char code (8 after Change F) present; code equals
  `foldCode(block.id)`.
- Context line captured; absent when the marker line is the last line.
- isError-first ordering is stable (two runs, identical output — guards the determinism invariant).
- Command entries carry turn/code of the result block; a call whose result is not in `masked`
  gets `turn` of the call and no code.

---

### Change B — Store full commands; clip only at render with an explicit truncation marker

**Files:** `src/core/index/seed-index.ts`, `src/adapters/pi/compact.ts`, `docs/SEED_INDEX_SPEC.md`,
`tests/seed-index.test.ts`, plus a render test (new `tests/compact-render.test.ts` — see Change C).

**Rationale:** today `firstLine(args, COMMAND_CLIP=200)` runs inside `extractIndex` — the record
(the durable store) already contains only the fragment. The ledger keeps the full command, but
the index should too: it is append-only disk, cheap. Clip only when rendering into the summary
(in-context tokens are the scarce resource).

In `seed-index.ts`:

```ts
/** Hard bound on a STORED command — bounds pathological inputs (pasted files) without
 *  destroying normal multi-line commands. */
const COMMAND_STORE_CLIP = 8000;
```

- Shell-call path: `command: safeSlice(args.trim(), COMMAND_STORE_CLIP)` (no `firstLine`).
- Harvest path: keep the regexes' own bounds (`$`-lines: `safeSlice(m[1], COMMAND_STORE_CLIP)`;
  `TOOL_CMD_RE` keeps its `{0,120}` — harvested display echoes are short by nature).
- Remove `COMMAND_CLIP` (200) from extraction; it becomes a render constant.

In `compact.ts`:

```ts
const COMMAND_RENDER_CLIP = 200;

function renderCommand(c: string | IndexedCommand): string {
	if (typeof c === "string") return `- \`${c}\``; // v2 record
	const lines = c.command.split("\n");
	const firstRaw = (lines.find((l) => l.trim()) ?? "").trim();
	const first = clip(firstRaw, COMMAND_RENDER_CLIP);
	const extraLines = lines.length - 1;
	const extraChars = Math.max(0, firstRaw.length - COMMAND_RENDER_CLIP);
	const marks: string[] = [];
	if (extraLines > 0) marks.push(`+${extraLines} line${extraLines === 1 ? "" : "s"}`);
	if (extraChars > 0) marks.push(`+${extraChars} chars`);
	const suffix = marks.length ? ` … (${marks.join(", ")})` : "";
	const prov = ` [turn ${c.turn}${c.code ? ` · ${c.code}` : ""}]`;
	return `- \`${first}\`${suffix}${prov}`;
}
```

Notes:

- `extraChars` is approximate (`clip` collapses whitespace). It is an indicator, not accounting —
  that is fine, do not over-engineer exactness.
- The marker makes a clipped command visually distinct from a complete one: `- \`python - <<'PY'\` … (+14 lines) [turn 12 · 9x2m71]`.
- v2 string entries render exactly as before.

Tests: full multi-line command round-trips into the record (extract); render shows first line +
marker (render); an 8100-char command stores at 8000; v2 string entry renders unchanged.

---

### Change C — Scope the compaction summary to the span leaving history

**Files:** `src/adapters/pi/compact.ts`, new `tests/compact-render.test.ts`.

**Current behavior:** `renderDetCompactionSummary` unions ALL records in
`seed-index.jsonl` (last-seen-wins via `union()`, capped). Across a long session with several
compactions, sections are a sample of the whole session, not a description of what just left.

**CRITICAL SUBTLETY — read carefully before implementing.** The obvious fix ("render only the
new compact record") is WRONG. Here is why. At compaction time, previously-folded blocks appear
in the leaving messages as their substituted digest text (`{#code FOLDED} …`), so
`emitCompactIndex`'s extraction over the leaving span sees digests, not original content. The
original content of those blocks was extracted at their fold events and lives in the fold
records. The union with fold records is therefore load-bearing, not noise.

**The correct scoping rule** is a partition by compaction boundary: a block folded before the
previous compaction is no longer in live history (that compaction removed it), so its record is
"earlier material". Everything at/after the previous compaction boundary is the current span:

```ts
interface Partition {
	/** Records indexing the span leaving live history NOW: the new compact record plus every
	 *  fold record since the previous compaction. */
	current: SeedIndexRecord[];
	/** Records from before the previous compaction — their blocks already left live history. */
	earlier: SeedIndexRecord[];
}

function partitionRecords(records: SeedIndexRecord[]): Partition {
	let lastCompact = -1;
	records.forEach((r, i) => {
		if (r.trigger === "compact") lastCompact = i;
	});
	if (lastCompact < 0) return { current: records, earlier: [] };
	return { current: records.slice(lastCompact), earlier: records.slice(0, lastCompact) };
}
```

This works because records are appended in chronological order and compaction removes the live
history that earlier records index. Example: `fold1, fold2, compact1, fold3, fold4, compact2` ⇒
at compaction 2, `current = [fold3, fold4, compact2]`, `earlier = [fold1, fold2, compact1]`.

Rendering:

1. Render the primary sections from the union of `current` — same helpers, same caps as today.
   (`union()` and `dedupBy()` in compact.ts need to handle the new object shapes: key errors by
   `line`, commands by `command`; for v2 strings key by the string. Write small key adapters.)
2. If `earlier.length > 0`, append a section rendered the same way with halved caps:

```ts
const CAP_EARLIER_FILES = 20;
const CAP_EARLIER_COMMANDS = 12;
const CAP_EARLIER_ERRORS = 12;
```

```
## Earlier indexed material (before the previous compaction)
Files: `a.ts` · `b.ts`
Commands: `make test` [turn 3]
Errors: FATAL: out of memory [turn 5]
```

3. `previousSummary` handling unchanged (still carried at the end, still labelled untrusted).
4. Handoff (`handoff.ts`) calls the same renderer with all records. On a live session with no
   compaction yet, `earlier` is empty and output equals today's union — correct. After a
   compaction, the handoff seed shows the current span plus the earlier-material section —
   also correct.

Tests (new `tests/compact-render.test.ts`):

- Records `[foldA, compact1, foldB, compact2]` ⇒ primary sections contain only foldB/compact2
  material; foldA/compact1 material appears under the earlier-material header.
- No compact records ⇒ no earlier-material section (handoff path).
- `previousSummary` still rendered, after the earlier-material section.
- Empty sections are omitted (existing behavior — keep it).

---

### Change D — Turn ranges on section titles

**Files:** `src/adapters/pi/compact.ts`, `tests/compact-render.test.ts`.

The summary's only temporal axis is user intents. Give each section the turn range of the
spans in the records it was rendered from:

```ts
function turnRange(records: SeedIndexRecord[]): string {
	let min = Infinity;
	let max = -Infinity;
	for (const r of records)
		for (const s of r.spans) {
			if (s.turn < min) min = s.turn;
			if (s.turn > max) max = s.turn;
		}
	if (min > max) return "";
	return min === max ? ` (turn ${min})` : ` (turns ${min}–${max})`;
}
```

Apply to the primary section titles: `## Files touched (turns 12–52)`, `## Commands run (turns
12–52)`, `## Error lines observed (verbatim) (turns 12–52)` — hmm, that double parenthetical is
ugly; rename that section to `## Error lines (verbatim) (turns 12–52)`. Also apply to the
earlier-material header. This is approximate for files/identifiers (the range of the spans, not
of the specific item) — that is fine and worth a one-line code comment.

Test: a record set with spans at turns 3 and 52 produces `(turns 3–52)`; single-turn produces
`(turn 3)`; no spans produces no suffix.

---

### Change E — Dedup identical folded outputs to a pointer

**Files:** `src/adapters/pi/store.ts`, possibly `src/core/fold-registry.ts` (iteration helper),
`tests/engine.test.ts`.

**Rationale:** repeated reads of an unchanged file fold independently, each producing a full
digest. Fold entries already carry `sha256` (`foldEntryFor` in index-store.ts:
`sha256Hex(b.text)`), so identical bytes are detectable deterministically.

**Seam:** the engine builds fold ops at `store.ts` (~line 696):

```ts
ops.push({ id, digestText: this.detDigest(byId.get(id)!) });
```

Design (implement in the engine, at this seam):

```ts
// Deterministic duplicate detection. First occurrence (registry insertion order, then event
// order) keeps the full digest; later blocks with identical bytes fold to a pointer.
const shaOwner = new Map<string, string>(); // sha256 → code of first folded block with these bytes
for (const entry of registryEntries) {
	if (entry.sha256 && !shaOwner.has(entry.sha256)) shaOwner.set(entry.sha256, entry.code);
}
for (const b of newlyMaskedBlocks) {
	const sha = sha256Hex(b.text);
	const dup = shaOwner.get(sha);
	if (dup !== undefined) {
		ops.push({
			id: b.id,
			digestText: `${foldTag(b.id)} identical to {#${dup} FOLDED} — same bytes`,
		});
	} else {
		shaOwner.set(sha, foldCode(b.id));
		ops.push({ id: b.id, digestText: this.detDigest(b) });
	}
}
```

Rules and edge cases:

- `MapFoldRegistry` (`src/core/fold-registry.ts`) may lack iteration. If so, add a minimal
  `values(): FoldEntry[]` (or `entries()`) accessor. Keep it core-pure.
- The duplicate still gets its own fold entry and code (registered normally via emitFoldIndex)
  and is recallable by its own code — recall returns its own ledger bytes, which are identical.
  Do NOT skip registration; skipping it would make the dup's span unadvertised in the index.
- Only blocks being newly folded in this event are considered; blocks frozen in earlier events
  keep their frozen bytes (invariant 4). The registry covers earlier events, so cross-event
  duplicates are caught.
- Empty-text blocks: skip dedup when `b.text` is empty (sha of "" would dedup unrelated empties).
- The pointer digest is small (~60 chars) and committed once — consistent with the frozen-layer
  invariant.
- `sha256Hex` lives in `src/adapters/pi/ledger.ts`; the engine is adapter-side, so importing it
  is fine.

Tests (tests/engine.test.ts): two identical 3KB tool outputs in one fold event ⇒ second block's
substitution text is the pointer naming the first block's code; both codes recall; a third
non-identical output gets a full digest; identical outputs folded in SEPARATE events also dedup
(registry path).

---

### Change F — Widen fold codes to 8 chars

**Files:** `src/core/digest.ts`, `tests/core.test.ts`.

**Rationale:** `foldCode` returns 6 base36 chars (36⁶ ≈ 2.1×10⁹; birthday collisions become
plausible around ~46k folded blocks in a session). A collision drops a block from folding
(fail-open per block) and could misroute recall. 8 chars (36⁸ ≈ 2.8×10¹²) removes the concern
for ~2 extra in-context chars per folded block.

```ts
return (h >>> 0).toString(36).padStart(8, "0").slice(-8);
```

Already verified, no other code changes needed:

- The tag parse regex is `/\{#([a-z0-9]{1,8})\s+FOLDED\}/i` (store.ts `parseCode`) — already
  accepts 1–8 chars. Verify this is the only width-sensitive pattern:
  `grep -rn "FOLDED" src tests`.
- Code resolution is exact-match against registry codes — width-agnostic.
- **No migration.** Codes are per-session, generated at fold time and persisted in fold entries.
  A session resumed from 6-char entries keeps resolving those (exact match); new folds get
  8-char codes. Mixed widths within a session are safe.
- The collision-drop path in `emitFoldIndex`/`recordCompactedBlocks` is width-agnostic.

Tests: `foldCode` returns 8 base36 chars, zero-padded; two known ids produce distinct codes;
the parse regex accepts both 6- and 8-char tags (regression guard for resume).

---

### Change G — Preserve unknown keys when writing the settings file

**Files:** `src/adapters/pi/settings.ts`, `tests/settings.test.ts`.

**Bug:** `loadSavedSettings` runs the file through `parseSavedSettings`, which keeps only known
knob keys. `writeSavedSetting` loads that way and writes the result — so any unknown key in
`context-fold.json` (e.g. a user's `_comment`) is silently deleted on the next settings write.

Fix — preserve unknown keys verbatim through a write:

```ts
const KNOWN_KEYS = new Set<string>([...KNOBS.map((k) => k.key), "providerCacheIdleMinutes"]);

/** Raw file contents minus the keys we manage. Unknown keys (comments, forward-compat) are
 *  preserved verbatim across writes. */
function unknownKeys(path: string): Record<string, unknown> {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object") return {};
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(raw)) if (!KNOWN_KEYS.has(k)) out[k] = v;
		return out;
	} catch {
		return {};
	}
}
```

Then in `writeSavedSetting` and `removeSavedSetting`, write `{ ...unknownKeys(path), ...saved }`
instead of `saved`. Note the subtlety in `removeSavedSetting`: the removed known key must not be
resurrected from the unknown set — it cannot be, because known keys are excluded by
`KNOWN_KEYS`. Keep `writeSettings` unchanged (atomic temp+rename).

Known keys with invalid values are dropped by `parseSavedSettings` and stay dropped — that is
existing fail-open behavior, do not change it.

Test: file containing `{ "_comment": "hello", "foldAt": 0.9 }` — after `writeSavedSetting` and
after `removeSavedSetting`, the file still contains `_comment` and the knob change applied.

---

## 4. Seed index spec → v3

Update `docs/SEED_INDEX_SPEC.md`:

- Header: "Seed index format (v3)".
- Record shape: `commands: IndexedCommand[]`, `errors: ErrorLine[]` with field tables (mirror
  the doc comments in A.1).
- New section "Changes from v2": errors/commands became provenance objects; errors may carry
  `context` and `toolError`; commands are stored full (hard cap 8000) and clipped only at
  render; `v: 3`. Note explicitly: **v2 records remain valid input** — renderers normalize
  string entries — and the tolerance rules (unknown fields, unknown `v`) are unchanged.
- Add a "Changes from v1" → keep; add "Changes from v2" below it.

Also update `CHANGELOG.md` (new `## Unreleased` section, one bullet per change) and check
`README.md` for any rendered-summary examples that show the old section format.

## 5. Acceptance criteria

1. `npm run typecheck` and `npm run test` pass. No assertion was loosened to get there.
2. The extraction core remains pure: `grep -rn "Date\|Math.random\|node:" src/core` shows
   nothing new.
3. A v2 seed-index file renders without error (tolerance test).
4. The summary for a session with a previous compaction shows the current span in the primary
   sections and earlier material under its own header.
5. Multi-line commands survive extraction whole and render with a `… (+N lines)` marker.
6. Error entries carry `[turn N · code]`; `⚠` marks tool-flagged error blocks; a context line
   follows when present.
7. Two identical tool outputs fold to one full digest + one pointer; both recall.

## 6. Commit plan (implement in this order, one commit each)

1. `seed-index: provenance + isError-first errors + context lines` (Change A, incl. spec v3
   section and CHANGELOG)
2. `seed-index: store full commands, clip at render with truncation markers` (Change B)
3. `compact: scope summary to the current span` (Change C)
4. `compact: turn ranges on section titles` (Change D)
5. `engine: dedup identical folded outputs to a pointer` (Change E)
6. `digest: widen fold codes to 8 chars` (Change F)
7. `settings: preserve unknown keys on write` (Change G)

Run `npm run typecheck && npm run test` after every commit. Do not squash; the order tells the
story to the reviewer.

## 7. Explicit non-goals

- No changes to `policy/fold-ladder.ts` (fold timing/thresholds), `apply.ts`, or the frozen-layer
  machinery.
- No changes to the error lexicon (`ERROR_MARKER_SOURCE`) — breadth is intentional.
- No provenance on `files`/`identifiers`.
- No token-estimator work (`estTokens` stays chars÷4).
- No new configuration knobs. All behavior above is unconditional.
