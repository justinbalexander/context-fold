# Pi extension API surface

The exact Pi APIs this extension depends on, verified against the engine source rather than taken
from the docs. Written for contributors: if one of these moves, this is the list to re-check.
Verified against Pi 0.80.x; the authoritative reference is `docs/extensions.md`,
`docs/compaction.md` and `examples/extensions/*` inside an installed
`@earendil-works/pi-coding-agent`.

## The make-or-break: per-turn context mutation

Hook named **`context`**. Fires before each LLM call, on a deep copy; the returned `messages`
array genuinely replaces what is sent. Confirmed in the engine, not just the docs:

- `pi-agent-core/dist/harness/agent-harness.js` wires it as `transformContext`:
  `const result = await emitHook({type:"context", messages:[...messages]}); return result?.messages ?? messages;`
- `pi-agent-core/dist/agent-loop.js` calls `transformContext` immediately before `convertToLlm`
  and the stream. It runs every assistant turn, on a copy, and never mutates persisted entries.
- **Handlers do NOT chain** (verified in `emitHook`, identical across Pi 0.80.2/0.82.1/0.83.0,
  contrary to an earlier revision of this document): every handler receives the *original* event,
  and the last non-`undefined` return wins. Handler order is `Set` insertion order = extension
  load order. Practical rule: this extension must be listed *after* any other context-rewriting
  extension in `settings.json` `packages`, or its folds are silently discarded. The same
  last-wins dispatch applies to every hook, including `session_before_compact` and
  `before_agent_start`. (Upstream composition of `context` hooks — folding each handler's
  returned messages into the next handler's event — would remove this constraint; not filed yet.)

```ts
interface ContextEvent       { type: "context"; messages: AgentMessage[]; }
interface ContextEventResult { messages?: AgentMessage[]; }
pi.on("context", async (e, ctx) => ({ messages: rewritten }));
```

## Everything else this extension uses

All of these fire headless.

| Need | API |
|---|---|
| Detect pressure | `ctx.getContextUsage()` → `{ contextWindow, tokens }` |
| Measured prompt-cache usage | `message.usage.{cacheRead,cacheWrite,input}` on `message_end` |
| Observe a tool result as it lands | `pi.on("tool_result", …)` — observe-only; never mutate |
| Hard-compaction summary / cancel | `pi.on("session_before_compact", …) → {compaction:{summary, firstKeptEntryId, tokensBefore}} \| {cancel:true}` |
| Inject teaching text | `pi.on("before_agent_start", …) → { systemPrompt }` |
| Agent-facing tool | `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters: Type.Object({…}), execute })` |
| Slash command | `pi.registerCommand(name, { description, handler })` |
| Footer status line (TUI) | `ctx.ui.setStatus(key, text)` — keyed slot on the footer's extension-status line; `undefined` clears. No-op stub in print/json modes, forwarded as an event in RPC mode. |
| Persist custom entry (NOT in LLM context) | `pi.appendEntry(type, data)` |
| Read entries back | `ctx.sessionManager.getEntries()`, filtered on `entry.type === "custom" && entry.customType === …` |
| Session paths | `ctx.sessionManager.getSessionDir()` / `.getSessionId()` |
| Out-of-band completion | `import { complete } from "@earendil-works/pi-ai/compat"` |

`StringEnum` for tool-parameter enums is imported from `@earendil-works/pi-ai`.

## Two hard constraints

1. **Import LLM and type helpers only from `@earendil-works/pi-ai/compat`.** Pi's loader injects
   bundled virtual modules; a separately installed `pi-ai` will not see the engine's model registry
   or auth. The same applies to `typebox` and the other `@earendil-works/*` packages — declare them
   as peer dependencies and never bundle a copy.
2. **Avoid isolated sub-workers for any model call.** Pi loads extensions through jiti with
   `moduleCache: false`. A call made from a separate isolated worker gets its own empty provider
   registry and will not see custom providers. Call synchronously inside the hook (the main module
   sees the registry), or use a plain `fetch` to an OpenAI-compatible URL.

## Headless notes

Every hook, tool and command above fires in `pi -p --mode json`. But `ctx.hasUI === false` and
`ctx.mode ∈ {"print","json"}`, so **guard every `ctx.ui.*` call** — this extension only ever
touches `ctx.ui` through optional chaining, in the display-only status command and the footer
status updater (both inert headless). `ctx.shutdown()`
is a no-op in print mode. Compaction still auto-fires on threshold and overflow headless, so
`session_before_compact` is reachable without an interactive `/compact`.

**The folding design must be fully autonomous — no `ui.confirm` anywhere on the automatic path.**
