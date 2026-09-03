# RuneSchool Harness

RuneSchool Harness is the standalone TypeScript runtime and terminal cockpit for coordinating LLM
agents in RuneSchool worlds. It connects to a hosted RuneSchool backend, provisions or attaches to
worlds, runs per-agent minds and deterministic reflexes, coordinates teams through a director and
coordinators, exposes a game-master admin persona, and records redacted JSONL traces.

## Status

This is an early `0.1.x` source-first package intended to run with Bun. The complete RuneSchool
harness and cockpit live in this repository and do not require a sibling monorepo checkout. The
package remains marked `private` to prevent accidental npm publication; that does not restrict use
of the public GitHub repository.

## What is included

- MCP provisioning and administration through `@modelcontextprotocol/sdk`
- Per-agent authenticated WebSocket links for RuneSchool commands and events
- A vendored RuneSchool client world model, event folding, snapshot differencing, and visibility
- OpenAI-compatible and deterministic mock model providers
- Per-agent wake policy, context compaction, tools, and SQLite memory
- Thirty task-oriented reflex behaviours, a sequence combinator, presets, and declarative rule actions
- Director, game-master admin, and team coordinator loops with mailboxes
- A local Unix-socket control plane, daemon workflow, and OpenTUI cockpit
- Thirteen grounding prompts and example phase scripts
- Secret-redacted, owner-only JSONL traces and a comprehensive test suite

Model-authored JavaScript is deliberately excluded: there is no reflex sandbox or authored-tool
runtime. Models can invoke only the tool and command surfaces exposed by the harness, and the
harness never evaluates model-generated code.

`WorldAdapter` remains exported as a small integration contract, but the normal integration path is
the built-in RuneSchool transport and runtime described below.

## Requirements and installation

- [Bun](https://bun.sh/) 1.3 or newer
- A reachable RuneSchool backend
- An OpenAI-compatible model endpoint, unless using the deterministic mock provider in tests

```sh
git clone https://github.com/spacemandev-git/runeschool-harness.git
cd runeschool-harness
bun install --frozen-lockfile
cp .env.example .env
```

Set the backend and model endpoint in `.env`; never put live credentials in a committed file:

```dotenv
ROUTER_API_BASE=https://your-router.example/v1
ROUTER_API_KEY=replace-with-your-router-key
ROUTER_MODEL=openai/gpt-5.5-pro
RUNESCHOOL_API_BACKEND=https://api.runeschool.dev
```

Run the complete verification suite with:

```sh
bun run check
```

`bun run check` runs strict TypeScript checking followed by the full test suite.

## Launch the cockpit

From the repository root:

```sh
bun run cockpit
```

The cockpit opens on the World tab and lists live backend instances followed by `+ scenario`
entries. Select a live instance and press `Enter` to attach a real `HarnessRuntime`, or select a
scenario and press `Enter` to provision it through MCP and attach. Press `r` on the World tab to
refresh. Backend failures are shown as connection errors; the cockpit does not substitute fake
world data.

The equivalent footer commands are shown in the built-in help:

```text
/world refresh
/world connect <instance>
/world scenario <scenario>
/world sandbox <json>
```

`/world sandbox <json>` sends the object to the backend's `create_sandbox_world` operation and
attaches the runtime. If the first player has a `spawnAt` tile, that tile becomes the default for
later agents. After a scenario or sandbox with a known default spawn is connected, add an agent
with:

```text
/spawn {"id":"hero","goal":"..."}
```

Attaching to an existing instance usually provides no known default spawn. In that case include an
explicit `spawn.at` tile (the director's `spawn_agent` schema documents the same agent spec):

```text
/spawn {"id":"hero","goal":"...","spawn":{"at":{"x":0,"z":0,"level":0}}}
```

Once connected, type ordinary text on the Director or Admin tab to chat with that persona, or use
`/admin <text>` from any tab. Until then, runtime commands report `connect to a RuneSchool instance
from the World tab first`.

## Shared hosted world

When the World tab connects to the instance returned by the backend's `GET /world/live` endpoint,
the cockpit detects it as the shared hosted world and uses the hosted join flow instead of MCP
`add_player`. The CLI selects the same path explicitly:

```sh
bun run start --hosted --agent bob="Duel alice"
```

Each harness agent signs in with its own Ed25519 identity. Private identity files are stored at
`data/identities/<agentId>.json`; keep them private because reconnecting with the same identity
reuses the same actor. Delete one agent's identity file when you intentionally want a fresh wallet
and actor for that agent.

The server assigns the actor's `wallet-…` tag and spawn tile, so configured `tag` and `spawn`
values are ignored. It also grants each new identity a one-time starter kit in the actor's bank.
No admin token is needed to join, but the admin persona cannot make world edits in this world.

Use `/model director <model>`, `/model agent-default <model>`, `/model coordinator <team> <model>`,
or `/model agent <agent> <model>` to change live model assignments. `/stop` stops the runtime and
leaves the cockpit open so another world can be selected. `/quit` stops the runtime and closes the
cockpit. Press `?` or enter `/help` for the complete key and command list.

## Run from the CLI

`bun run start` provisions or attaches to a RuneSchool world and starts the full runtime. The
default world is the `goblin-menace` scenario; the local control socket is served by default.
Examples from `bun run start --help`:

```sh
bun run start "Defeat three goblins"
bun run start --scenario arena-island --agent hero="Walk east" --headless
bun run start --sandbox lumbridge --agent miner --agent banker --team workers=miner,banker:"Gather ore"
bun run start --resume <worldId> --agent agent
bun run start --hosted --agent bob="Duel alice"
```

For a scenario, the first CLI agent binds to the scenario's first actor slot by default. The slot
and its spawn are resolved from the backend's scenario document; no local scenario JSON is needed.

Detached runs use the control plane and can be reopened from another terminal:

```sh
bun run start --daemon --scenario arena-island --agent hero="Survive"
bun run start attach latest
```

The attached cockpit's `q` and `/detach` actions detach without stopping the daemon. Other control
commands include `ps`, `stop`, and `logs`; scripted phases can drive a live run:

```sh
bun run start phases <script.json> --target latest
```

Example phase files are under `scripts/phases/`. By default, JSONL traces and control descriptors
are written under `<repo>/runs`, while SQLite agent memory is stored under `<repo>/data`. Both
directories are gitignored. Run `bun run start --help` for the complete flag reference.

## Environment

`loadHarnessEnvironment()` is the single environment reader. Bun loads `.env` automatically.

| Variable | Required | Default and use |
|---|---:|---|
| `ROUTER_API_BASE` | No | `http://127.0.0.1:8000/v1`; OpenAI-compatible endpoint |
| `ROUTER_API_KEY` | No | No default; bearer credential for endpoints that require one |
| `ROUTER_MODEL` | No | `openai/gpt-5.5-pro`; initial model for all roles |
| `RUNESCHOOL_API_BACKEND` | No | `http://127.0.0.1:7800`; RuneSchool backend base URL |
| `RUNESCHOOL_MCP_URL` | No | `${RUNESCHOOL_API_BACKEND}/mcp`; MCP endpoint used by the CLI |
| `RUNESCHOOL_UI_URL` | No | Derived by the CLI when unset; spectator UI origin |
| `AISCAPE_MCP_URL` | No | Legacy alias used only when `RUNESCHOOL_MCP_URL` is unset |
| `AISCAPE_UI_URL` | No | Legacy alias used only when `RUNESCHOOL_UI_URL` is unset |

The standalone `bun run cockpit` launcher uses `RUNESCHOOL_API_BACKEND` and derives its MCP and
spectator URLs from that backend. `bun run start` also accepts `--mcp-url` and `--ui-url` overrides.

## Model credentials

The default model provider is named `router`. `ROUTER_API_KEY` is optional for local endpoints
that do not require authentication. It is resolved only when the provider is constructed and is
never included in displayable runtime config. Code can read the non-secret endpoint settings with:

```ts
import { loadHarnessEnvironment } from "@runeschool/harness/environment";

const { runeschoolApiBackend } = loadHarnessEnvironment();
```

Custom model configuration can name API keys by environment variable:

```json
{
  "providers": {
    "provider": {
      "kind": "openai-compatible",
      "baseUrl": "https://provider.example/v1",
      "apiKeyEnv": "PROVIDER_API_KEY"
    }
  }
}
```

Literal credential-shaped headers are rejected. For providers that require a custom auth header,
use `headerEnv`, for example `{ "x-api-key": "PROVIDER_API_KEY" }`.

### Cockpit model selection

The cockpit accepts model slugs advertised by the configured router. Changes apply to subsequent
model calls and can be made independently for the director, each team coordinator, and each agent:

```text
/model director openai/gpt-5.5-pro
/model agent-default openai/gpt-5.5-mini
/model coordinator alpha anthropic/claude-sonnet-4.5
/model agent scout qwen/qwen3-coder
```

`agent-default` sets the fallback for newly created agents. Explicit per-agent configuration or a
later `/model agent <agent> <model>` assignment takes precedence. Validated selections are
persisted across cockpit restarts in
`$XDG_CONFIG_HOME/runeschool-harness/model-selections.json` (or
`~/.config/runeschool-harness/model-selections.json` when `XDG_CONFIG_HOME` is unset) and applied
to a live runtime after connection. An unreachable provider or unknown model leaves the existing
assignment unchanged.

## Source layout

| Path | Responsibility |
|---|---|
| `src/core/` | Public contracts for agents, actions, prompts, perception, runtime, and transport |
| `src/transport/` | MCP session, actor WebSocket/HTTP link, and RuneSchool definitions reader |
| `src/perception/` | SDK-backed world model, folding, differencing, visibility, and summaries |
| `src/runtime/` | `createHarnessRuntime`, agent runtimes, mailboxes, world reads, runtime view/commands, and traces |
| `src/admin/` | Operator-facing game-master persona and curated tools |
| `src/mind/`, `src/reflex/` | Agent deliberation and deterministic behaviours/rules |
| `src/director/` | Director and team coordinators |
| `src/models/`, `src/memory/` | Model registry/providers and SQLite memory |
| `src/control/` | Per-run Unix-socket control server and client |
| `src/cli/`, `src/main.ts` | Run, daemon, attach, ps, stop, logs, and phases CLI |
| `src/tui/` | Cockpit, World browser, launcher, screens, and model-selection persistence |
| `src/vendor/` | Vendored RuneSchool shared types, SDK, magic subset, and example-scenario names |
| `src/protocol.ts`, `src/world.ts` | `#protocol` and `#world` façades over vendored packages |
| `prompts/`, `scripts/phases/` | Grounding prompts and phase-script examples |

## Repository hygiene

Generated traces, databases, agent memory, control descriptors and sockets, logs, build output,
editor state, and all `.env*` files except `.env.example` are ignored. CI runs tests plus a
full-history secret scan. See [SECURITY.md](SECURITY.md) before connecting the harness to a real
service.

## License

Apache-2.0. See [LICENSE](LICENSE).
