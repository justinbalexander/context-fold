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

Done 2026-07-30 (see git history for the full original text of each item):

1. **Runtime wire watchdog** — `CacheTelemetry` arms a baseline at each masking fold and flags
   the fold if the next turn's `cacheRead` reads the whole pre-fold prompt back; once-per-session
   stderr warning, `/context-fold` flag, footer warning. Tests in `cache-telemetry.test.ts`,
   `advisor.test.ts`, `extension-hooks.test.ts`.
2. **README "Known integrations" section** — codex continuation deferral, last-wins load-order
   rule, double-load failure mode.
3. **e2e wire assertion** — `e2e-ladder.sh` check (e) parses the session JSONL and asserts the
   first layer commit is followed by a shrunken provider-reported prompt.
4. **`docs/pi-api-surface.md` corrected** — chaining claim replaced with the real last-wins
   contract and the load-last rule.

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
