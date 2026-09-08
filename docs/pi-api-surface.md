# Pi extension API surface

This reference lists the Pi APIs that context-fold depends on, verified against the engine source
in Pi 0.83.0 and 0.84.1. Contributors should re-check these APIs when upgrading Pi. The authoritative
references are `docs/extensions.md`, `docs/compaction.md`, and `examples/extensions/*` inside an
installed `@earendil-works/pi-coding-agent`.

The session-ledger findings below were verified against Pi 0.84.4. Their line numbers refer to
`dist/core/session-manager.js` in that build.

## The session ledger as recall's durability floor

Recall re-locates folded blocks in `sessionManager.getEntries()`. It depends on these properties,
each verified in the engine source:

- **Append-only.** The class doc states "The session is append-only" and entries are never
  mutated or removed. `_appendEntry` pushes to `fileEntries`, and navigation through `branch()`
  or `resetLeaf()` only moves the leaf pointer. As the source states, "Existing entries are not
  modified or deleted" (session-manager.js:979, 1030–1041).
- **Whole-tree reads.** `getEntries()` returns every in-memory entry minus the header rather
  than only the active branch (session-manager.js:982–984). A block on an abandoned branch
  therefore still resolves. Hard compaction appends a compaction entry and removes nothing.
- **A fork copies the ledger.** `SessionManager.forkFrom` writes a new header and then copies
  every non-header entry from the source file, including messages and custom entries
  (session-manager.js:1270–1275). Recall in a forked session resolves the copied spans, and the
  restored fold records verify against the copied messages.
- **`newSession({parentSession})` carries nothing.** It resets `fileEntries` to a fresh header
  (session-manager.js:652–661) and no reader traverses `parentSession`. Cross-session handoff is
  therefore path-only. The `/fold-handoff` seed names the parent session file, and its codes
  identify provenance rather than live handles.
- **`persist: false` (in-memory embeddings) still serves recall in-process.**
  `SessionManager.inMemory` sets no file, but `_appendEntry` populates `fileEntries` regardless
  of persistence (session-manager.js:726–761, 1226–1228), so `getEntries()` answers normally for
  the life of the process. Nothing survives exit because there is no file. The durable route
  exists exactly where Pi keeps a session file.

## Per-turn context mutation

The `context` hook fires before each LLM call on a deep copy. Its returned `messages` array
replaces what Pi sends. The engine and docs confirm the following:

- `pi-agent-core/dist/harness/agent-harness.js` wires it as `transformContext`:
  `const result = await emitHook({type:"context", messages:[...messages]}); return result?.messages ?? messages;`
- `pi-agent-core/dist/agent-loop.js` calls `transformContext` immediately before `convertToLlm`
  and the stream. It runs every assistant turn, on a copy, and never mutates persisted entries.
- **Current Pi chains handlers as middleware.** In both verified versions,
  `ExtensionRunner.emitContext()` passes each returned message array into the next handler's event,
  so context-fold and another context rewriter both survive. `emitBeforeAgentStart()`,
  `emitMessageEnd()`, and `emitToolResult()` use the same transform-chain model for their respective
  payloads.
- **Older builds used last-wins dispatch.** Every handler received the original event and the last
  non-`undefined` return won. On a build that predates transform chaining, context-fold must load
  after another context rewriter. Check the installed `ExtensionRunner` rather than inferring this
  behavior from a version not listed above.
- `session_before_compact` is not a transform chain in Pi 0.84. The last non-cancel result is still
  selected, while `{ cancel: true }` short-circuits.

```ts
interface ContextEvent       { type: "context"; messages: AgentMessage[]; }
interface ContextEventResult { messages?: AgentMessage[]; }
pi.on("context", async (e, ctx) => ({ messages: rewritten }));
```

### Collision surface

| Hook | context-fold returns | Pi 0.83.0 / 0.84.1 | Legacy last-wins build |
|---|---|---|---|
| `context` | rewritten messages, every turn | Chained | **High:** last context rewriter wins |
| `session_before_compact` | deterministic compaction summary | **High:** last non-cancel strategy wins | **High:** last strategy wins |
| `message_end` | nothing | Observe-only | Observe-only |

Tool-name and command-name conflicts (`recall_folded`, `unfold`, `/context-fold`) are different. They fail
loudly at load rather than silently, so they need no mitigation beyond knowing to expect them.

## Everything else this extension uses

All of these fire headless.

| Need | API |
|---|---|
| Detect pressure | `ctx.getContextUsage()` → `{ contextWindow, tokens }` |
| Measured prompt-cache usage | `message.usage.{cacheRead,cacheWrite,input}` on `message_end` |
| Resume cache-age estimate | `ctx.sessionManager.getBranch()` → successful assistant entries, using entry completion timestamps and provider/model identity |
| Recheck or stop cache timers | `session_start`, `session_tree`, `model_select`, `session_compact`, `agent_start`, `agent_settled`, `session_shutdown` |
| Optional pre-request confirmation | `pi.on("input", …)` with interactive source → `ctx.ui.select`; `handled` consumes a cancelled prompt before model/auth/compaction work |
| Draft restoration | `ctx.ui.setEditorText(text)` plus `ctx.ui.notify` to request a render; retained structured images return via `input` → `transform` on resubmission |
| Know the agent loop is actually idle | `pi.on("agent_settled", …)`, which fires after retries, compaction, and queued continuations finish |
| Hard-compaction summary / cancel | `pi.on("session_before_compact", …) → {compaction:{summary, firstKeptEntryId, tokensBefore}} \| {cancel:true}` |
| Compaction actually completed (count it, settle the index record) | `pi.on("session_compact", …)` |
| Compaction failed/aborted after preparation (retract the compact record) | `pi.on("session_compact_failed", …)` postdates 0.84.1. On older engines the handler never fires, so context-fold registers it through a plain-string cast and leaves the premature record in place |
| Model changed mid-session (restart the cache-telemetry segment) | `pi.on("model_select", …)` → `{ model, previousModel?, source: "set" \| "cycle" \| "restore" }` |
| Agent-facing tool | `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters: Type.Object({…}), execute })` |
| Slash command | `pi.registerCommand(name, { description, handler })` |
| Footer status line (TUI) | `ctx.ui.setStatus(key, text)`, a keyed slot on the footer's extension-status line where `undefined` clears. No-op stub in print/json modes, forwarded as an event in RPC mode. |
| Persist custom entry (NOT in LLM context) | `pi.appendEntry(type, data)` |
| Read entries back | `ctx.sessionManager.getEntries()`, filtered on `entry.type === "custom" && entry.customType === …` |
| Session paths | `ctx.sessionManager.getSessionDir()` / `.getSessionId()` / `.getSessionFile()` |
| Seed a replacement session (`/fold-handoff` confirm path) | `ctx.newSession({ parentSession, setup })` on the command context; `setup(sm)` appends the seed as a persisted user message and no `withSession` work is scheduled, so the new session opens idle |
| Out-of-band completion | `import { complete } from "@earendil-works/pi-ai/compat"` |

`StringEnum` for tool-parameter enums is imported from `@earendil-works/pi-ai`.

## Two hard constraints

1. **Import LLM and type helpers only from `@earendil-works/pi-ai/compat`.** Pi's loader injects
   bundled virtual modules, so a separately installed `pi-ai` will not see the engine's model
   registry or auth. The same applies to `typebox` and the other `@earendil-works/*` packages, which
   are declared as peer dependencies rather than bundled.
2. **Avoid isolated sub-workers for any model call.** Pi loads extensions through jiti with
   `moduleCache: false`. A call made from a separate isolated worker gets its own empty provider
   registry and will not see custom providers. Call synchronously inside the hook (the main module
   sees the registry), or use a plain `fetch` to an OpenAI-compatible URL.

## Headless notes

The hooks, tools, and commands above are available in `pi -p --mode json`, but UI calls need
headless guards. Cache prediction and send confirmation require an interactive TUI. The command
and settings menus require `ctx.hasUI`; headless calls use the status or effective-settings path
instead. Observed cold-input notices use stderr headlessly. The footer updater and user-invoked
`/fold-handoff` confirmation also guard UI access.

`ctx.shutdown()` is a no-op in print mode. Compaction still auto-fires on threshold and overflow
headlessly, so `session_before_compact` is reachable without an interactive `/compact`.

The folding design must be fully autonomous, so nothing on the automatic path calls `ui.confirm`.
