# TODO — extension-conflict work after the 0.1.0 probe finding

Context: a 2026-07-30 live probe showed fold layers committing, indexing and spooling correctly
while provider-reported input never dropped mid-chain. Root cause was not in this extension
(verified by replaying the probe session's messages through `ContextFoldEngine.process`): with
`@howaboua/pi-codex-conversion` installed, its cached WebSocket continuation answers a fold's
prefix change by sending only the pending tool output as a delta, deferring the folded prefix
until the next user-turn boundary. Separately, Pi's hook dispatch (`emitHook`, identical in
0.80.2/0.82.1/0.83.0) never chained: every handler receives the original event and the last
non-`undefined` return wins, so two extensions rewriting the same hook are mutually destructive
by load order. Evidence: `~/memory/inbox/2026-07-30_033517_willow_context-fold-delayed-by-codex-
websocket-continuation.md` and `…_035434_willow_pi-context-hook-handlers-do-not-chain.md`.

## 1. Runtime watchdog: detect folds that never reach the wire (highest value)

The one defense that covers every downstream discard mechanism — hook clobbering, transport
deferral, future Pi changes — because it measures the outcome instead of guessing at causes.
We already have the ingredients: `CacheTelemetry` records per-turn `cacheRead`/`input`, and the
engine knows when a layer committed. If a fold event committed on turn N and turn N+1 reports
`cacheRead` at or above turn N's total input, the prefix was provably not rewritten on the wire.
Emit one stderr warning + a `/context-fold` status flag ("folds committed but not observed on the
wire — another extension or the transport is bypassing them"). Debounce: warn once per session.

## 2. README "known integrations" section (ships the truth to users)

The package is published; anyone running it beside pi-codex-conversion gets silently deferred
folds. Document: (a) the codex continuation deferral and its user-turn-boundary behavior,
(b) Pi's last-wins hook semantics and the load-order consequence (context-fold should be listed
*after* any other context-rewriting extension in `settings.json` `packages`), (c) the
double-load failure mode (`pi install` + `-e` → recall/unfold tool-name conflict).

## 3. e2e: assert the wire, not just the dump

`e2e-ladder.sh` check (c) reads `CONTEXTFOLD_DUMP` — the extension's own output — which is why
this was invisible. Add a check that parses the session JSONL after the run and asserts the
first fold event is followed by a turn whose `cacheRead` drops and whose total input shrinks.
That is the assertion the probe had to do by hand.

## 4. Correct `docs/pi-api-surface.md`

The "multiple context handlers chain" claim was never true in any inspected Pi version. Replace
with the real contract (same event to every handler, last non-`undefined` result wins, Set
insertion order = load order) and the practical rule: this extension must load last among
context rewriters until upstream composes hooks.

## 5. Upstream issues (owner decision on tone/venue before filing)

- **Pi (`pi-agent-core`)**: propose composing `context` hooks — fold each handler's returned
  messages into the next handler's event, matching what `emitBeforeProviderRequest` already
  does for stream options. Cite the doc/behavior mismatch.
- **pi-codex-conversion**: report the deferral with the probe evidence; propose a fold-aware
  continuation (full resend when the prefix changed, rather than pending-tool-output delta),
  or an opt-out.

## 6. Hook-collision audit (done 2026-07-30 — keep current as extensions are added)

Pi hooks that are last-wins and what this extension does on them:

| Hook | context-fold returns | Collision risk |
|---|---|---|
| `context` | messages, every turn | **High** — any other context rewriter (pi-codex-conversion does) |
| `session_before_compact` | det compaction summary | **High** — pi-codex-conversion also handles compaction; loser's strategy silently ignored |
| `before_agent_start` | appended systemPrompt (gate on) | Medium — another prompt-appender's text or ours is dropped |
| `tool_call` | nothing | None (observe-only for us) |
| `tool_result` | nothing | Low — another extension returning a *patch* could make the spooled payload diverge from what history keeps |

Installed-extension scan (willow, 2026-07-30): `autojournal` registers only session-lifecycle
hooks — no overlap. `pi-codex-conversion` (currently removed locally) collides on `context`,
`session_before_compact`, `before_agent_start`, plus the transport-level continuation deferral.
Tool-name conflicts (`recall`, `unfold`, `context-fold` command) fail loudly at load — no action
needed beyond the README note.

## Local (willow, not repo work)

- Decide whether to reinstall `pi-codex-conversion` for daily codex sessions (its adapter
  features vs. deferred folding) once items 1–2 land or upstream moves.
