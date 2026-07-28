# Pi Extension API Surface (verified)

Originally verified against the Willow fork of Pi 0.80.2 (fork retired 2026-07-10; the fork's
extension API was byte-identical to upstream). The live harness is stock upstream Pi from npm —
build against upstream Pi 0.80.x extension docs with confidence.

## Locations (stock npm install)
- CLI: `/home/willow/.local/bin/pi` → `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`
- Package root: `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/` (version `0.80.6`)
- Runtime engine packages: `<package root>/node_modules/@earendil-works/{pi-agent-core,
  pi-ai, pi-tui}`. `@earendil-works/pi-coding-agent` itself
  exports `ExtensionAPI` from `dist/core/extensions/`.
- Authoritative docs: `<package root>/docs/extensions.md` (large), `docs/compaction.md`,
  and `examples/extensions/*` — especially `custom-compaction.ts`, `summarize.ts`,
  `trigger-compact.ts`, `handoff.ts`.

## The make-or-break: per-turn context mutation — CONFIRMED
Hook named **`context`**. Fires before each LLM call, on a deep copy; the returned `messages`
array genuinely replaces what is sent. Verified in the engine, not just docs:
- `pi-agent-core/dist/harness/agent-harness.js:339-341` wires it as `transformContext`:
  `const result = await emitHook({type:"context", messages:[...messages]}); return result?.messages ?? messages;`
- `pi-agent-core/dist/agent-loop.js:175-186` calls `transformContext` immediately before
  `convertToLlm` + stream. Runs every assistant turn, on a copy, never mutates persisted entries.
- Multiple `context` handlers chain (each sees the prior's output): `runner.js:685-705`.

```ts
// types: dist/core/extensions/types.d.ts:483, :743, :827
interface ContextEvent       { type: "context"; messages: AgentMessage[]; }
interface ContextEventResult { messages?: AgentMessage[]; }
pi.on("context", async (e, ctx) => ({ messages: rewritten }));   // docs/extensions.md:620
```

## Other capabilities (all fire headless)
| Need | API | Ref |
|---|---|---|
| Detect pressure | `ctx.getContextUsage()` | extensions.md:989 |
| Hard-compaction summary / cancel | `pi.on("session_before_compact", …) → {compaction:{summary, firstKeptEntryId, tokensBefore}} \| {cancel:true}` | extensions.md:434; examples/custom-compaction.ts |
| Trigger compaction | `ctx.compact({customInstructions,onComplete,onError})` | extensions.md:1000 |
| Agent-facing tool | `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters: Type.Object({...}), execute(id,params,signal,onUpdate,ctx) })` | extensions.md:1288 |
| Slash command | `pi.registerCommand(name, { description, handler })` | extensions.md:1443 |
| Persist custom entry | `pi.appendEntry(type, data)` (NOT in LLM context) | extensions.md:1390 |
| Read entries back | `ctx.sessionManager.getEntries()` → filter `entry.type==="custom" && entry.customType===…` | extensions.md:932 |
| Bookmark entry | `pi.setLabel(entryId, label)` (survives restart) | extensions.md:1426 |
| Find a specific model | `ctx.modelRegistry.find(provider, modelId)` | model-registry.d.ts:61 |
| Auth for a model | `ctx.modelRegistry.getApiKeyAndHeaders(model)` | model-registry.d.ts:72 |
| Out-of-band completion | `import { complete } from "@earendil-works/pi-ai/compat"` | compat.d.ts:62 |
| Register local endpoint (Lemonade) | `pi.registerProvider(name, { baseUrl, api, models })` | extensions.md:1613 |

`StringEnum` for tool param enums is imported from `@earendil-works/pi-ai`.

## Targeting the local Lemonade model (Phase 2)
`~/.pi/agent/settings.json` uses `defaultProvider: ollama`. Either `find("ollama", "<id>")`, or
register a dedicated Lemonade provider via `pi.registerProvider("lemonade", {baseUrl, api,
models})` and target that. Run the folding policy out-of-band, independent of the session's
active model. Pass `ctx.signal` so the policy call aborts with the turn.

## Two hard constraints
1. **Import LLM/types helpers only from `@earendil-works/pi-ai/compat`** (the loader injects
   bundled virtual modules; the willow loader aliases the pi-ai root → compat). A separately
   installed `pi-ai` won't see the engine's model registry / auth.
2. **jiti isolation (Phase 2 only):** Pi loads extensions via jiti with `moduleCache:false`. If
   the folding-policy model call runs in a *separate isolated sub-worker* (the way pi-blackhole's
   consolidation agents do), that worker gets its own empty pi-ai provider registry and won't see
   custom providers. Avoid by calling the model **synchronously inside the hook** (main module →
   sees the registry), or talk to Lemonade with a plain `fetch` to its OpenAI-compatible URL
   (KISS, no registry dependency). pi-blackhole's `Symbol.for("pi-blackhole:provider-streams")`
   bridge (`src/om/provider-stream.ts`, 17 lines) is the workaround if isolated workers are ever
   needed.

## Headless (`pi -p --mode json`) notes
All the above hooks/tools/completions fire in headless print/json mode (same AgentSession +
harness + agent-loop). But `ctx.hasUI === false` and `ctx.mode ∈ {"print","json"}` — guard every
`ctx.ui.*` call (no-op or throws). `ctx.shutdown()` is a no-op in print mode. Compaction still
auto-fires on `threshold`/`overflow` headless, so `session_before_compact` is reachable without
an interactive `/compact`. **The folding design must be fully autonomous — no `ui.confirm`.**

## Fork divergence (historical — fork retired 2026-07-10)
`WILLOW_FORK.md` (in the archived fork): only package metadata (name, `willow` bin, `piConfig.name=willow`,
`configDir=.willow`) + a cosmetic TUI patch + the pi-ai-root→compat loader alias + the upstream
0.80.1→0.80.2 sync. **No willow-specific changes to `ContextEvent`/`transformContext`,
`session_before_compact`, `registerTool/Command`, `appendEntry`, or the model registry.**
