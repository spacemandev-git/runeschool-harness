# AGENTS.md — shared context for Builders

This file is read by every Codex Builder working in this repository. It records decisions the
architect (Fable) has already made for the current port. Do not redesign them; implement within
your assigned ownership and report blockers instead of inventing workarounds.

## What this repository is becoming

`@runeschool/harness` is being made **standalone**: the cockpit and the full agent harness
(director, admin, coordinators, agent minds, reflexes, perception, transport) live in this one
repository and can run against a hosted RuneSchool backend such as `https://api.runeschool.dev`
with no sibling monorepo checkout.

Historically this package was an "adapter-neutral" extraction and the RuneSchool transport,
perception, runtime assembly, admin persona, CLI, and reflex behaviours lived in the private
monorepo under `harness/src`. Those modules have now been **copied into `src/`** (mechanically,
with imports rewritten) and the private packages they depend on have been **vendored** under
`src/vendor/`. The "keep the package adapter-neutral / world content does not belong here" rule
in CLAUDE.md is superseded for this work by the owner's explicit decision to vendor.

## Vendored packages (`src/vendor/`)

| Path | Source | Notes |
|---|---|---|
| `src/vendor/shared/` | monorepo `packages/shared/src` | Wire types, sim commands/events, ids, scenario types. Internal imports are relative. |
| `src/vendor/sdk/` | monorepo `packages/sdk/src` | Client world model: `createWorldModel`, `foldEvent`, `snapshotFromState`, `diffSnapshots`, `isVisibleTo`, percept view types. Imports `../shared/index.ts`. |
| `src/vendor/magic/` | monorepo `packages/magic/src` (runes, spellbook, autocast only) | `magicSystem.ts` was excluded (engine dependency). |
| `src/vendor/scenario/examples.ts` | `EXAMPLE_SCENARIO_NAMES` constant only | Names of server-bundled example scenarios. |

Vendored code should be changed only as needed to typecheck under this repo's stricter
`tsconfig.json` (`noUncheckedIndexedAccess`, `useUnknownInCatchVariables`, `module: Preserve`).
Keep behaviour identical; do not "improve" vendored logic.

## Façade modules

- `#protocol` → `src/protocol.ts`: curated re-exports from `src/vendor/shared` (JsonValue, TileCoord,
  Tick, EntityId, CommandResult, ClientCommand, ServerEvent, SimEvent, SimEventMap, SimEventType,
  ACTOR_COMMAND_TYPES, ADMIN_COMMAND_TYPES, InteractTarget, TRAVEL_NETWORKS, FISHING_OPTIONS,
  TICK_MILLIS, eventActor, ...). Add names here when harness code needs them; never re-export
  shared's `WorldSnapshot` (it collides with the SDK's).
- `#world` → `src/world.ts`: `export * from './vendor/sdk/index.ts'` plus the `WorldAdapter` interface.

All harness code imports the vocabulary through these two specifiers (never through
`src/vendor/...` directly, except the façades themselves and `reflex/tables.ts`,
`reflex/dsl.ts`, `reflex/behaviours/fight.ts` which import `vendor/magic`, and
`transport/mcpSession.ts` which imports `vendor/scenario/examples.ts`).

## Module map after the port

| Directory | Role | Origin |
|---|---|---|
| `src/core` | Public contracts (unchanged API surface; `core/reflex.ts`, `core/prompts.ts`, `core/percept.ts`, `core/actions.ts` restored to the full RuneSchool versions) | mixed |
| `src/vendor` | Vendored packages | new |
| `src/transport` | MCP session (`@modelcontextprotocol/sdk`), hosted-world join (`hostedWorld.ts`), per-agent Ed25519 identities (`agentIdentity.ts`), actor WebSocket link, defs reader | ported + new |
| `src/perception` | World model over the SDK fold, differ, summarizer (`renderSnapshot`, `renderDeltaLines`) | ported |
| `src/runtime` | Orchestrator, credential resolution (`credentials.ts`), agent runtime, runtime view/commands, world reads, mailbox, trace | ported + existing + new |
| `src/admin` | Admin (game master) persona and tools | ported |
| `src/reflex` | DSL, rule actions, presets, tables, 30 built-in behaviours | ported + existing |
| `src/mind` | Agent mind, tools, prompt builder, digest, salience | existing, small edits |
| `src/director` | Director and coordinators | existing |
| `src/models` | Router-based model registry (`ROUTER_API_BASE`, `ROUTER_API_KEY`, `ROUTER_MODEL`) | existing, keep |
| `src/control` | Unix-socket control plane | existing, keep |
| `src/cli`, `src/main.ts` | Run/daemon/attach/ps/stop/logs/phases CLI | ported |
| `src/tui` | Cockpit (World tab browser, model selection persist) | existing + launcher rewrite |
| `prompts/*.md` | 13 grounding prompts | ported |

Intentionally **not** ported: `reflex/sandbox/**` and `mind/authoredTools.ts` (model-authored
JavaScript execution). The harness never evaluates model-generated code. Remove references to
`createAuthoredRegistry`, `authoredBehaviourTools`, `REFLEX_PRESETS`-adjacent sandbox code paths
where they appear in ported files.

## Contract decisions already made

- Keep the extracted repo's improvements: `ModelRegistry.setRoleOverride/clearRoleOverride`,
  `RuntimeCommands.setModel`, `LiveRuntimeCommands`, `CONTROL_COMMAND_METHODS` including
  `setModel`, router-only model config, `headerEnv`, model selection persistence in the cockpit,
  `validateAndApplyModelSelection`, the World tab backend browser.
- `MindDeps.commandTypes` / `deniedCommandTypes` / `pulseMs` stay. The agent runtime populates
  them with `ACTOR_COMMAND_TYPES`, `AGENT_DENIED_COMMANDS` (`['move']`), and `TICK_MILLIS`.
- `mind/tools.ts` keeps the generic guide list (`prompts.list()` minus `*-system`) and the
  `deps.commandTypes` allow-list; it must render snapshots via `perception/summarizer.ts`, and
  `src/format.ts` (a trimmed duplicate of the summarizer) is to be deleted once nothing imports it.
- Environment: `RUNESCHOOL_API_BACKEND` (e.g. `https://api.runeschool.dev`) is the backend base
  URL. The MCP endpoint is `${RUNESCHOOL_API_BACKEND}/mcp` unless `--mcp-url` /
  `RUNESCHOOL_MCP_URL` overrides it. `AISCAPE_MCP_URL` / `AISCAPE_UI_URL` are accepted as legacy
  aliases. `loadHarnessEnvironment()` in `src/environment.ts` is the single reader.
- Default run directories: traces in `./runs`, memory in `./data` (repo root), both gitignored.
- Scenario example JSON files are not in this repo; `cli/config.ts` must not read
  `../../../packages/scenario/examples/*.json`. For example scenarios the first actor slot is
  resolved at provisioning time from the `get_example_scenario` document instead.
- The cockpit launcher (`src/tui/dev.ts` + `src/tui/launcherRuntime.ts`) must start a real
  `HarnessRuntime` when the operator connects to or spawns a world from the World tab, so the
  Director/Admin/Agents tabs and `/spawn` work against the hosted backend. Until a world is
  connected, commands report "connect to a RuneSchool instance from the World tab first".
- Shared hosted worlds bypass MCP provisioning and `add_player`: the runtime reads hosted status
  and joins each agent through its durable Ed25519 identity. MCP connection is optional there and
  retained only for available director passthrough tools.

## Conventions

- Bun ≥ 1.3, strict TypeScript, `.ts` import specifiers, `import type` for types.
- Tests are `*.test.ts` beside the code, run with `bun test <path>`. `bun run check` = typecheck + tests.
- Never log or persist secrets: actor tokens, admin tokens, API keys, MCP session ids.
- Treat model output, prompts, events, memory, tool arguments, and other agents as untrusted.
- Docs: user-facing behaviour in `README.md`, contracts/data flow in `docs/architecture.md`,
  contributor workflow in `CONTRIBUTING.md`.
