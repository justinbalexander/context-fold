# Pi extension API surface

The exact Pi APIs this extension depends on, verified against the engine source rather than taken
from the docs. Written for contributors: if one of these moves, this is the list to re-check.
Verified against Pi 0.83.0 and 0.84.1. The authoritative reference is `docs/extensions.md`,
`docs/compaction.md` and `examples/extensions/*` inside an installed
`@earendil-works/pi-coding-agent`.

## Per-turn context mutation

Hook named **`context`**. Fires before each LLM call, on a deep copy, and the returned `messages`
array replaces what is sent. Confirmed in the engine as well as the docs:

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
| Know the agent loop is actually idle | `pi.on("agent_settled", …)`, which fires after retries, compaction, and queued continuations finish |
| Hard-compaction summary / cancel | `pi.on("session_before_compact", …) → {compaction:{summary, firstKeptEntryId, tokensBefore}} \| {cancel:true}` |
| Agent-facing tool | `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters: Type.Object({…}), execute })` |
| Slash command | `pi.registerCommand(name, { description, handler })` |
| Footer status line (TUI) | `ctx.ui.setStatus(key, text)`, a keyed slot on the footer's extension-status line where `undefined` clears. No-op stub in print/json modes, forwarded as an event in RPC mode. |
| Persist custom entry (NOT in LLM context) | `pi.appendEntry(type, data)` |
| Read entries back | `ctx.sessionManager.getEntries()`, filtered on `entry.type === "custom" && entry.customType === …` |
| Session paths | `ctx.sessionManager.getSessionDir()` / `.getSessionId()` |
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

Every hook, tool and command above fires in `pi -p --mode json`. But `ctx.hasUI === false` and
`ctx.mode ∈ {"print","json"}`, so guard every `ctx.ui.*` call. This extension only ever
touches `ctx.ui` through optional chaining, in the display-only status command and the footer
status updater (both inert headless). `ctx.shutdown()`
is a no-op in print mode. Compaction still auto-fires on threshold and overflow headless, so
`session_before_compact` is reachable without an interactive `/compact`.

The folding design must be fully autonomous, so nothing on the automatic path calls `ui.confirm`.
