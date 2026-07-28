# Accordion Context-Folding — Portable Implementation Spec

Source: Accordion v0.1.2, pinned commit `0c22434`
(`git clone https://github.com/a-Fig/Accordion`). Paths below are under `app/src/lib/`
(engine + live) and `conductors/`. This is the implementation reference for context-fold's
pure core — the code to port, stripped of all Svelte/Tauri/browser coupling.

The whole system is one pure idea wearing a Svelte coat:

```
conduct(view: ConductorView) -> Command[]      // policy (a conductor decides)
applyPlan(messages, ops, groups) -> messages   // mechanism (the wire rewrites)
```

Folding is **content substitution, never structural removal**. A folded block stays in the
array and keeps its `callId`, so a `tool_call`/`tool_result` pair can never orphan. The only
deliberate exceptions are group-collapse and group-drop, both whole-message and pair-balanced.

There are two parallel implementations of the same fold algorithm in Accordion:
- `applyPlan` in `live/mapping.ts` — the real wire path that rewrites provider messages. **This
  is the part to port for a headless extension.**
- The `AccordionStore` derived state in `engine/store.svelte.ts` — a reactive *mirror* that
  exists only so the GUI's token accounting matches `applyPlan`. **Drop almost all of it.**

---

## 1. The fold / apply mechanism

### 1a. Svelte-coupled (drop) vs pure algorithm (port)
`store.svelte.ts` is 1667 lines but the Svelte coupling is shallow — almost entirely an
accounting mirror, not algorithm.

**Drop:** all `$state` fields (blocks/budget/protectTokens/groups/conductor/locks, lines
119-265); all `$derived.by` aggregates (`liveTokens` 662, `fullTokens` 668, `foldedCount` 674,
`groupAt` 683, `groupWire` 695, `protectedFromIndex` 858, `protectedTokens` 891) — reimplement
as plain functions; the `version++`/`decisionJournal`/`setStatus`/`onHumanOverride` UI feed
(1233-1360); the reactive conductor lifecycle (`attach`/`detach`/`reconcileLocks`/`syncLocks`/
`buildHost`/`conductorEpoch`/`requestConductorRerun`, 320-631) — keep only "build view → call
conduct → apply commands"; the WebSocket/RemoteRunner transport; Tauri/Bear-2 compressor.

**Port:** `messageKey(id)` (65-71, strips assistant-part suffix so all parts of a message share
a key); `protectedFromIndex` walk-back (858-880); `runConductor` pass shape (946-1000);
`applyCommands`+`substOne`+`liveOne`+`groupCmd` (1091-1186, the clamp-and-apply floor);
`classifyGroup` fixpoint (752-837); the digest functions (§2); the `wireFoldable` gate.

### 1b. `applyPlan` — the load-bearing function
`live/mapping.ts:304` `applyPlan(messages, ops: FoldOp[], groups: GroupOp[]) -> messages`.
Already pure (imports only `estTokens`/`BLOCK_OVERHEAD` + its protocol types). Returns a new
array (touched messages cloned, untouched passed by reference).

The conductor speaks `Command[]`; the live layer lowers those into two wire op types:
- `FoldOp { id, digestText }` — in-place content substitution for one block.
- `GroupOp { memberIds, summaryText }` — collapse a contiguous run; `summaryText: null` = DROP.

```
applyPlan(messages, ops, groups):
  # Defense in depth — never trust caller shape (mapping.ts:311-324)
  safeOps    = ops    where o.id is string & isDurableId(o.id) & o.digestText non-empty string
  safeGroups = groups where memberIds all strings, len>=1,
                            summaryText === null OR (string & non-whitespace)
  if no safeOps and no safeGroups: return messages         # identity fast-path
  byId = Map(safeOps by id)

  # ── Phase A: which whole MESSAGES may each group remove ──
  owner[0..n] = null
  infos[i] = messageInfo(messages[i], i)   # {ids, calls[], results[], hasNonDurable}
  for i: if infos[i].ids non-empty and not infos[i].hasNonDurable
         and every id maps to the SAME group g: owner[i] = g
  repeat until stable:                      # orphan-prevention fixpoint (§1d)
     calls   = union infos[i].calls   over owned i
     results = union infos[i].results over owned i
     for each owned i:
        if any infos[i].calls   not in results OR
           any infos[i].results not in calls: owner[i] = null   # straggler

  # ── Phase B: build output ──
  out = []; i = 0
  while i < n:
     g = owner[i]
     if g:
        j = i+1; while owner[j] === g: j++   # maximal run owned by the SAME group object
        if g.summaryText === null: pass       # DROP
        else:
           role = messages[i].role==="assistant" ? "assistant" : "user"
           out.push({ role, content:[{type:"text", text:g.summaryText}] })   # ONE summary msg
        i = j
     else:
        out.push(foldOne(messages[i], i, byId)); i++   # in-place substitution
  return changed ? out : messages
```

`foldOne` (mapping.ts:243-273), kind-guarded in-place substitution:
- `assistant`: for each part whose `blockId(m,i,j)` has a FoldOp, replace its `text`/`thinking`
  with the digest. **`tool_call` parts and any other kind are never folded.** Clones parts lazily.
- `toolResult`: replace `content` with `[{type:"text", text:digestText}]`, keep
  `toolCallId`/`toolName`/`isError`.
- `user`/other: never folded.

### 1c. One summary per contiguous RUN (not per group)
A group is a contiguous run snapped to whole messages. An interior straggler (§1d) splits the
run; Phase B emits **one summary per surviving sub-run**. Token accounting must mirror this:
charge `summaryTok` to the first block of each run, 0 to the rest.

### 1d. The tool_call/tool_result orphan-prevention fixpoint
Provider-safety core. One pass is not enough — demoting one message can orphan a tool-pair
partner elsewhere. (mapping.ts:354-371, mirrored in `classifyGroup` store:799-817):

> Start with every member message removable. Repeatedly compute the callIds called and results
> emitted **by currently-removable messages only**. Demote (keep live) any removable message
> holding a `tool_call` whose callId is not in the removable results, OR a `tool_result` whose
> callId is not in the removable calls. Repeat until no change.

Needs >1 pass e.g. when an assistant message has parallel tool calls, one result inside the
group and one outside: the assistant message can't be removed (unbalanced call), which strands
the result whose call is now outside, cascading until stable.

**Durability gate:** a message containing any positional (non-durable) id is never
group-removable — starts as a straggler.

### 1e. Protected-tail walk-back
`protectedFromIndex` (store:858-880), `PROTECT_OVERFLOW_CAP = 1.25` (store:46):
```
protectedFromIndex(blocks, target):
  if blocks empty: return 0
  if target === 0: return blocks.length         # protection off, all foldable
  cap = target * 1.25
  sum = blocks[last].tokens                      # newest block ALWAYS protected if target>0
  if sum >= target: return last
  for i from last-1 down to 0:
     next = sum + blocks[i].tokens
     if next > cap: return i+1                   # adding this older block overflows the cap
     sum = next
     if sum >= target: return i
  return 0
```
Protection is absolute: `substOne` refuses to fold a protected block; `healProtected`
force-unfolds anything the tail grew over; the newest block is never left unprotected.

### 1f. The conductor pass — `runConductor` (store:946-1000, exposed as `refold()`)
```
1. pruneProtectedGroups()             # drop groups that now reach the tail
2. protectedFrom = protectedFromIndex # compute once per pass
3. healProtected(protectedFrom)       # force-unfold manual folds inside the tail
4. clearConductorState()              # reset to baseline; human overrides survive
5. view = buildView(protectedFrom)    # pure ConductorView (§3)
6. cmds = conductor.conduct(view) ?? lastCmds   # null => HOLD, reuse last batch
7. reports = applyCommands(cmds)      # clamp each command to provider-validity
```
`substOne` (store:1119-1154) is the single fold floor: rejects unknown-id / human-override /
grouped / protected / not-foldable; for recoverable subst it strips any leading tag the
conductor supplied and prepends the authoritative `foldTag(id)` — **the engine is the sole tag
author.**

---

## 2. The digest / fold-tag — `engine/digest.ts` (already pure — port ~verbatim)

Tag format `{#<code> FOLDED}`, e.g. `{#3f9a2c FOLDED}`.

```ts
function foldCode(id: string): string {            // FNV-1a 32-bit -> base36, 6 chars
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}
function foldTag(id: string): string { return `{#${foldCode(id)} FOLDED}`; }
```
Collisions handled by unfolding every block sharing a code (cheap, harmless).

`wireFoldable(b)` (digest.ts:54): `FOLDABLE_KINDS.has(b.kind)`, where
`FOLDABLE_KINDS = {text, thinking, tool_result}` (digest.ts:34). KIND-only — `user`/`tool_call`
never fold. (Durable-id is a *separate* wire-emit gate, not part of foldability.)

`digest(b)` (digest.ts:104): foldable kinds → `${foldTag(b.id)} ${digestBody(b)}`; non-foldable
→ `digestBody(b)` (no tag — never sent folded, so no dangling handle).

`digestBody(b)` per kind (digest.ts:114-139): user → `"…"` clip 100; text → clip 120; thinking
→ `thought · ~<estTokens> tok · <firstLine 80>`; tool_call → `<toolName>(<args 70>)`;
tool_result → `<name> → <isError?"error":"<N> lines">, ~<b.tokens> tok · <firstLine 60>`.

`digestTokens(b)` = `estTokens(digest(b)) + BLOCK_OVERHEAD`. Group digest:
`groupDigest(group, members)` (digest.ts:198) → `foldTag(group.id) + "group · <N> blocks · …"`.

Helpers (`tokens.ts`): `estTokens(s)=ceil(s.length/4)`, `BLOCK_OVERHEAD=4`, `clip`, `firstLine`.
The crude ~4-chars/token estimator is the single token oracle — swap in one place if you have a
real tokenizer.

---

## 3. The conductor contract — `conductors/contract/conductor.ts` (pure — port as-is)

Header explicitly forbids Svelte/`$state`/Node/Tauri; defines its kind union locally; zero
engine deps.

`ViewBlock` (54-72): `{ id, messageKey?, kind, turn, order, tokens, foldedTokens, toolName?,
callId?, isError?, held, folded, protected, grouped, text?, preview? }`. `foldedTokens` = digest
size for foldable kinds, full `tokens` for non-foldable (so `foldedTokens < tokens` naturally
skips user/tool_call). `held/folded/protected/grouped` fold host policy into plain bools.

`ConductorView` (84-97): `{ blocks: ViewBlock[], budget, contextWindow: number|null, liveTokens,
protectedFromIndex, protectTokens }`. `liveTokens` is the baseline to fold *down from*.

`Command` union (111-196):
- `FoldCommand { kind:"fold", ids[], digest? }` — collapse to digest; no digest → host per-kind.
- `ReplaceCommand { kind:"replace", id, content, recoverable? }` — 1:1 subst; `content:""` →
  host folds to standard digest; `recoverable:true` → host prepends `{#code FOLDED}`.
- `GroupCommand { kind:"group", ids[], digest? }` — collapse run to ONE summary; `undefined` →
  default recap, `null`/`""` → DROP (no message), non-empty string → verbatim (not recoverable).
- `RestoreCommand { kind:"restore", ids[] }` / `PinCommand { kind:"pin", ids[] }`.

Each `conduct()` return is the *complete desired state*; host resets to baseline then applies
the whole batch. `[]` = clear to raw; `null` = HOLD (reuse last batch).

`ClampReason` (214-233): `unknown-id | human-override | grouped | invalid-group | protected |
not-foldable | noop`. Host returns one `ClampReport` per non-verbatim command, never throws.

Locks (`LockName` 35): `human-steering | agent-unfold | tail-size`. Empty `locks` =
collaborative (overrides win — the default we want). `ConductorHost` (415-439): `can(cap)`,
`complete(req)`, `compress?`, `countTokens`, `digestOf(id)`, `setStatus`, `requestRerun`.
Capabilities `complete|countTokens|digest|compress` — always gate on `can()`.

---

## 4. The deterministic Keel policy — `conductors/keel/` (collaborative, no locks)

Pure function of view + pruned instance memory. Phase-2 LLM and Phase-3 Bear-2 paths are
optional upgrades gated on `host.can("complete"/"compress")`; **with no model link the behavior
is byte-identical to the Phase-1 core. Implement Phase 1 only and you have a complete, model-free
policy.**

### 4a. Per-pass pipeline (`conduct`, keel.ts:284-506)
```
0. prune recalls/cooldowns of ids no longer in view; T = max turn; updateWarmth(blocks, T)
1. if liveTokens <= budget: clear plan, return []         # under budget → raw
2. roots   = identifyRoots(blocks)                        # never-fold set (§4b)
3. ranked  = rankCandidates(blocks, roots)                # cold->hot order (§4c)
4. EPOCH gate: cap=min(budget, contextWindow??budget); high=0.9*cap, low=0.7*cap
   project HELD plan forward; if it still fits 0.9*cap and budget: re-emit lastPlan (HOLD)
5. EPOCH replan: target=min(0.7*cap, budget)
   for cand in ranked (coldest first):
       if projected <= target: break
       routed = route(block)                              # fidelity ladder (§4d)
       record replace|fold; projected -= (block.tokens - routed.tokens)
6. hardCapFloor(...): GUARANTEE projected <= cap (force-fold -> force-group -> drop)
7. EMIT replaces ++ one fold ++ groups; strip any id swept into a group (SINGLE DISPOSITION)
```

### 4b. Roots — never-fold (`roots.ts:40`)
`identifyRoots(view)` = every `user` block ∪ every `protected` ∪ every `held`. Read per pass
from live flags (no permanent keep-live state — that would cause cross-pass drift). Fact-density
is a soft stickiness signal, not a hard root.

### 4c. Scoring & ordering (`relevance.ts` + `cold-score/score.ts`)
`rankCandidates` filters to foldable candidates, sorts by a 3-level key:
1. **Entity reachability** (`garbage-collector/edges.ts`): bidirectional reference graph —
   causal (tool_call↔tool_result same callId), message (same id-prefix), entity (shared rare
   identifier). `markReachable` from roots; **unreachable blocks fold first** (semantically dead).
2. **Risk stickiness** (`ledger.ts:118` `riskFlags`): fewer flags fold first; paths/commands/
   values/decisions are stickier.
3. **ACT-R cold score** (`score.ts:120`): `prior[kind] + activation + pairWarmthBonus`. Priors
   `{tool_result:0, thinking:8, text:16, tool_call:24, user:32}`, gaps of 8 > realistic
   activation spread → **kind-major ordering** (tool_result folds first).
   `activation = ln(Σ max(T - t_i,1)^(-decay[kind]))`; decay `{tool_result:0.9, thinking:0.7,
   text:0.5}`. Tiebreak: oldest `order` first (byte-stable).
ACT-R warmth (`updateWarmth`, keel.ts:735): scan protected-tail text for identifiers, record a
recall turn on foldable blocks they reference (≤4/turn, 5-turn cooldown). Cross-pass instance
memory, pruned each pass.

### 4d. Fidelity ladder (`ladder.ts`, `route` keel.ts:524)
- **L0 Full** — roots/hot/protected (never routed).
- **L1 Skeleton** — code-file tool_result ≥1500 tok → imports/types/signatures, bodies elided.
  `replace(recoverable:true)`, must shrink ≤0.6×.
- **L1.5 Bear-2** — Phase 3 comment/docstring squeeze via `host.compress`; inert without it.
- **L2 Trim** — long prose/thinking ≥600 tok → deterministic extractive excerpt (~25%, head/tail
  + risk-flag lines + longest lines). `replace(recoverable:true)`, ≤0.6×.
- **L3 Digest** — `fold` with no digest → engine per-kind digest (with tag). Floor for any block.
- **L4 Group** — contiguous run → one `group` (default recap). Non-recoverable.
- **L5 Drop** — `group(digest:null)`, last resort, owned by the floor.
L1/L2 are reversible (agent keeps the unfold handle); L4/L5 are not.

### 4e. Budget guarantee (`budget.ts`)
`effectiveCap = min(budget, contextWindow ?? budget)`. `EPOCH_BAND {high:0.9, low:0.7}` (hold
≤0.9·cap, fold to 0.7·cap on crossing → ≤1 KV-cache miss per epoch). `hardCapFloor` (121):
monotone 3-stage last resort guaranteeing `projected ≤ cap` — force-fold biggest reducible →
force-group oldest run → drop oldest run (irreversible, always surfaced). Always terminates.
**Honest invariant** (keel.ts:765): if the irreducible floor (roots + tail) alone exceeds cap,
fold everything allowed and announce "over budget" rather than falsely claim success.

### 4f. Capability gating
No `complete` → ladder falls through to digest; no `compress` → skip L1.5; no `countTokens` →
`ceil(len/4)`. All degrade to deterministic Phase 1.

---

## 5. Block model — `live/mapping.ts` + `engine/types.ts`

`linearize(messages) -> WireBlock[]` (mapping.ts:117): pure, deterministic. One assistant
message explodes into per-part blocks (thinking/text/each tool_call); user, tool_result, summary
each → one block. `order` = global 0-based counter; `turn` increments on each user message.
Tokens = `estTokens(text) + BLOCK_OVERHEAD`.

`blockId(m, i, partIndex?)` (mapping.ts:64) — durable, content-anchored, position-independent:
user → `u:<timestamp>`; assistant part j → `a:<responseId ?? "t"+timestamp>:p<j>`; tool_result →
`r:<toolCallId>`; summary → `s:<timestamp>`; fallback (anchor missing) → positional
`m<i>:…` (NOT durable). `isDurableId(id)` (mapping.ts:96): prefix `u:`/`a:`/`r:`/`s:`. **Only
durable ids may be folded.**

`Block` (types.ts:30-70): immutable `{ id, kind, turn, order, text, tokens, toolName?, callId?,
model?, isError? }` + mutable fold state `{ override:"pinned"|"folded"|"unfolded"|null,
autoFolded, by, subst? }`. `kind ∈ {user,text,thinking,tool_call,tool_result}`. `callId` =
provider-safety pairing key. `subst` = conductor-substituted content (distinct from human
`override`).

`Group` (types.ts:91-110): engine overlay. `{ id:"g:<firstMemberDurableId>", memberIds[], folded,
by?, digest? }`. Contiguous, non-overlapping, flat, ≥1 member, entirely older than the tail.
`digest`: undefined→recap, null/""→drop, string→verbatim.

---

## Gotchas (do not trip on these)

1. **Two copies of the orphan fixpoint** in Accordion (`applyPlan` Phase A is authoritative;
   `classifyGroup` mirrors it for GUI accounting). Implement it **once** in `apply.ts`.
2. **WeakMap digest caches have no invalidation** (digest.ts:95, an explicit tripwire). Sound
   only because committed block content is never mutated in place. If you ever mutate a
   committed block's `text`/`tokens`, clear both caches.
3. **Charge one summary per RUN, not per group** (§1c) or budget accounting under-counts.
4. **Durable-id gate is wire-emit only, NOT foldability.** `wireFoldable` is kind-only.
5. **Single disposition:** no id in two commands. Keel strips regrouped ids from fold/replace.
6. **`subst:""` is wire-invalid** — fold to the engine digest instead (means "smallest
   wire-safe form," not "send empty").
7. **The engine is the sole `{#code}` tag author** — strip any policy-supplied tag, prepend the
   authoritative one.
8. **`protectedFromIndex` always protects the newest block when target>0**, even if it alone
   exceeds the 1.25× cap — the tail is never empty.
9. **ACT-R "current turn" is the MAX turn**, not the last block's turn (robust to resync).
10. **Uniform `ceil(chars/4)+4` estimator.** Keel's `groupHeadCost` deliberately over-estimates —
    keep that conservatism or the floor's monotonicity weakens.

---

## Minimal headless core to reimplement
`tokens.ts` (4 fns) + `digest.ts` (whole file) + `contract.ts` (types) + `block.ts`
(`linearize`/`blockId`/`isDurableId`/`messageInfo`/`applyPlan`) + Keel Phase-1
(`roots`/`relevance`/`score`/`ledger`/`ladder`/`budget`/`edges`). The store reduces to: hold
blocks, compute `protectedFromIndex`, build `ConductorView`, call `conduct`, lower `Command[]` →
`FoldOp[]`/`GroupOp[]`, call `applyPlan`.
