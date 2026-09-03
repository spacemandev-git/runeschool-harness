# RuneSchool Harness

RuneSchool Harness is a source-first TypeScript toolkit for coordinating LLM agents in simulated
worlds. It provides model routing, per-agent minds and memory, deterministic reflexes, team
coordination, a local control plane, JSONL traces, and a terminal cockpit. A host application
supplies the world adapter and its command set.

This repository is the reusable harness extracted from RuneSchool. It deliberately contains no
game server, proprietary scenarios or prompts, production data, cloud deployment configuration, or
live credentials.

## Status

This is an early `0.1.x` extraction intended for source-based consumption with Bun. Its public API
will evolve while the adapter boundary is exercised outside the original application. The package
is marked `private` so it cannot be published to npm accidentally; that does not restrict use of the
public GitHub repository.

## What is included

- Adapter-neutral world, command, event, and runtime contracts
- OpenAI-compatible and deterministic mock model providers
- Per-agent wake policy, context compaction, tools, and SQLite memory
- Validated declarative reflex rules and deterministic behaviours
- Director and coordinator loops
- Local Unix-socket control server/client and OpenTUI cockpit
- Secret-redacted, owner-only JSONL tracing
- Fake world/runtime helpers and a comprehensive test suite

The old authored-JavaScript tool is intentionally not included. Models can select only command
names advertised by the host adapter; the harness does not evaluate model-generated code.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer

```sh
git clone https://github.com/spacemandev-git/runeschool-harness.git
cd runeschool-harness
bun install --frozen-lockfile
bun run check
```

`bun run check` runs strict TypeScript checking and the full test suite.

## Launch the cockpit

From the repository root, launch the terminal cockpit:

```sh
bun run cockpit
```

The cockpit reads `RUNESCHOOL_API_BACKEND` from `.env`, opens on the World tab, and queries that
backend for running instances and saved scenarios. Select a running instance and press `Enter` to
connect, or select a `+` scenario entry and press `Enter` to spawn and connect to a new instance.
If the backend is unavailable, the World tab displays the connection error; it does not fall back
to fake data. Press `r` to retry.

The same actions are available from the footer:

```text
/world refresh
/world connect inst-10
/world scenario goblin-ambush
/world sandbox {"name":"training","regions":[12850],"players":[{"tag":"hero"}]}
```

Custom sandbox JSON is passed to the backend's `create_sandbox_world` tool and must satisfy its
schema. Press `?` to open the full key and command reference. To exit, press `q` twice or `Ctrl+C`
twice within two seconds.

## Adapter boundary

A host owns authentication, transport, and the source of world truth. It implements `WorldAdapter`
and supplies `WorldView`, `ActionSink`, and the set of commands that an agent may call:

```ts
import type { ActionSink, WorldAdapter, WorldView } from "@runeschool/harness";

const adapter: WorldAdapter = {
  id: "my-simulation",
  commandTypes: ["walk", "inspect", "recover"],
  createView(agentId, credentials): WorldView {
    return connectReadOnlyView(agentId, credentials);
  },
};

const sink: ActionSink = {
  async submit(intent) {
    return sendValidatedCommand(intent);
  },
};
```

The adapter remains responsible for authorization and server-side command validation. Treat the
LLM, prompts, memory, tool arguments, events, and other agents as untrusted input.

Useful entry points are:

- `@runeschool/harness/core` — public contracts
- `@runeschool/harness/environment` — generic router and RuneSchool backend environment settings
- `@runeschool/harness/models` — model config and providers
- `@runeschool/harness/memory` — SQLite memory
- `@runeschool/harness/mind` — agent deliberation loop
- `@runeschool/harness/reflex` — validated rules and behaviours
- `@runeschool/harness/control` — local control plane
- `@runeschool/harness/director` — multi-agent coordination
- `@runeschool/harness/tui` — terminal cockpit and fake runtime
- `@runeschool/harness/testing` — test helpers

## Model credentials

Copy `.env.example` to `.env` and provide any OpenAI-compatible endpoint. Bun loads `.env`
automatically; other hosts can inject the same variables through their secret manager:

```dotenv
ROUTER_API_BASE=https://your-router.example/v1
ROUTER_API_KEY=replace-with-your-router-key
ROUTER_MODEL=openai/gpt-5.6-sol
RUNESCHOOL_API_BACKEND=http://127.0.0.1:7800
```

The default model provider is named `router`. `ROUTER_API_KEY` is optional for local endpoints
that do not require authentication. It is resolved only when the provider is constructed and is
never included in displayable runtime config. A host can read the non-secret endpoint settings,
including the RuneSchool server base URL, with:

```ts
import { loadHarnessEnvironment } from "@runeschool/harness/environment";

const { runeschoolApiBackend } = loadHarnessEnvironment();
```

Custom model configuration can still name API keys by environment variable:

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

The terminal cockpit accepts model slugs from the configured router. Changes apply to subsequent
model calls and can be made independently for the director, each team coordinator, and each agent:

```text
/model director openai/gpt-5.5-pro
/model coordinator alpha anthropic/claude-sonnet-4.5
/model agent scout qwen/qwen3-coder
```

A host wires the cockpit command to its model registry with `applyModelSelection`:

```ts
import { applyModelSelection } from "@runeschool/harness/models";

const commands = {
  // ...the rest of RuntimeCommands
  setModel(selection) {
    applyModelSelection(models, selection);
  },
};
```

## Repository boundaries

Generated traces, databases, agent memory, control sockets, logs, build output, editor state, and
all `.env*` files except `.env.example` are ignored. CI runs tests plus a full-history secret scan.
See [SECURITY.md](SECURITY.md) before connecting the harness to a real service.

## License

Apache-2.0. See [LICENSE](LICENSE).
