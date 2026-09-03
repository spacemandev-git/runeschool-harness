# Architecture

RuneSchool Harness is a standalone client runtime for a hosted RuneSchool server. Both launch
surfaces construct the same live orchestration layer: `bun run start` builds a run directly, while
`bun run cockpit` waits for the operator to connect to or provision a world from the World tab.

## Runtime data flow

```text
cockpit / CLI
      │
      v
createHarnessRuntime (orchestrator)
      │
      ├── MCP session ──> provision/resume/attach world; add_player; admin tools
      │                         │
      │                         └── actor/admin credentials (memory only)
      │
      ├── one agent runtime per actor
      │       │
      │       ├── actor link ── WebSocket claim, commands, acknowledgements, events
      │       │                    + HTTP reads
      │       │
      │       ├── vendored SDK fold + snapshot differ + visibility
      │       │                    │
      │       │                    v
      │       ├────────────── world model / percept deltas
      │       │                    │
      │       ├── mind + memory ───┼──> ActionSink (actor link) ──> RuneSchool server
      │       └── reflex engine ───┘
      │
      ├── director + admin + team coordinators <──> mailboxes
      ├── RuntimeView / LiveRuntimeCommands <──> cockpit or control client
      └── event bus ──> cockpit, control stream, JSONL trace
```

The orchestrator connects an MCP session, provisions the selected scenario or sandbox (or resumes
or attaches to an existing instance), and obtains actor credentials. For server-bundled example
scenarios, it first retrieves the scenario document so the first actor slot and default spawn are
resolved by the backend rather than a local JSON file. Agents without an existing credential are
created with MCP `add_player`. The director's self-describing `spawn_agent` tool creates agents in
the connected world; attached existing instances generally require an explicit
`spawn.at: { x, z, level }` tile because they provide no recorded default spawn.

The shared hosted world takes a separate path. The orchestrator reads `GET /world/live` rather
than provisioning through MCP, while an MCP connection remains optional for the director's
read-only passthrough tools. For each agent, the hosted client performs this sequence:

```text
load/create per-agent Ed25519 identity
      │
      v
/auth/challenge ──> sign exact challenge ──> /auth/verify (kind: agent)
      │
      v
one-use session token ──> POST /world/live/join ──> actor credentials
      │
      v
actor WebSocket link ──> claim actor token
```

The join endpoint mints or reuses one actor per public key and assigns its tag and spawn tile.
Consequently `spawn_agent` works without `tag` or `spawn` in this world and never calls MCP
`add_player`. The hosted world has no admin token, so admin world-edit operations are unavailable.

Each agent owns an actor link. The link opens the instance WebSocket, claims the actor with its
token, subscribes to events, rate-limits commands, and matches acknowledgements to pending actions.
On shutdown it sends a `leave` command, waits briefly for the acknowledgement, and then closes the socket.
It also performs scoped HTTP reads. Incoming events feed the vendored SDK world model, which folds
state, applies visibility, creates snapshots, and computes deltas. The compatibility layer in
`src/perception` adds summaries and rejection information used by the agent mind and reflex engine.

The mind chooses deliberate tool calls using its snapshot, recent deltas, prompts, and SQLite
memory. The reflex engine evaluates validated declarative rules and built-in behaviours on a fixed
pulse. Both submit `ActionIntent` objects to the actor link, which is the live `ActionSink`.

## Supervision and communication

The director plans the run, creates and steers teams, and delegates world changes to the admin.
Each team coordinator receives reports from its members and can send instructions back. The admin
is a separate game-master persona with curated tools and a restricted set of MCP operations for
changing the world. In-process mailboxes route operator, agent, director, admin, and coordinator
messages. Runs can use open messaging or `team-only`, which blocks cross-team agent messages while
retaining supervisor routes.

`RuntimeView` is the read surface consumed by the cockpit and control clients. It exposes agent and
team summaries, transcripts, snapshots, usage, the active instance, and a redacted configuration.
`LiveRuntimeCommands` provides chat, goal and pause controls, raw allow-listed actor commands,
dynamic agent/team operations, model selection, and graceful shutdown. The config view includes
the resolved director, admin, default-agent, coordinator, and per-agent model assignments.

## Control and observability

CLI runs serve a local Unix-socket control plane by default. Its owner-only descriptor lets
`attach`, `ps`, `stop`, `logs`, and `phases` locate a run. An attached cockpit receives a snapshot,
replayed bus events, live events, and the allow-listed command surface. Socket traffic and config
views are redacted before transmission. The control plane is local and unauthenticated, so its
descriptor directory and socket must remain private to one trusted machine account.

Every module emits JSON-serialisable events onto the shared bus. A per-run JSONL trace subscribes
to that bus, recursively redacts credential-shaped fields, URLs, bearer values, and known secret
environment values, and creates its file with mode `0600`. Model request content is omitted unless
`--trace-model-messages` is explicitly enabled; redaction remains defense in depth.

## Modules

| Module | Responsibility |
|---|---|
| `src/core/` | Public contracts for the runtime, transport, minds, actions, reflexes, prompts, and perception |
| `src/transport/` | MCP lifecycle/provisioning, hosted-world sign-in/join, identity storage, actor WebSocket and HTTP transport, definitions reader |
| `src/perception/` | SDK world-model wrapper, event/outcome folding, snapshot differencing, visibility, summaries |
| `src/runtime/` | Orchestrator, credential resolution, per-agent runtime, runtime view/commands, mailboxes, reads, tracing |
| `src/admin/` | Game-master persona, MCP tool filtering, name resolution, and token-safe reporting |
| `src/mind/` | Agent turns, tools, wake policy, prompt construction, compaction, salience |
| `src/reflex/` | Declarative DSL, engine, presets, rule actions, magic tables, and built-in behaviours |
| `src/director/` | Director and team coordinator loops and tools |
| `src/models/`, `src/memory/` | Router-backed model registry and per-agent SQLite memory |
| `src/control/` | Unix-socket server/client and owner-only run descriptors |
| `src/cli/`, `src/main.ts` | Interactive, headless, daemon, control, and phase-script entry points |
| `src/tui/` | Cockpit screens, World directory/launcher, command handling, persisted model selections |
| `src/vendor/` | RuneSchool shared protocol, SDK, magic subset, and example-scenario name catalogue |

## Vendored packages and façades

The standalone package carries the RuneSchool dependencies that previously required a sibling
monorepo checkout:

| Vendored path | Contents |
|---|---|
| `src/vendor/shared/` | Wire types, simulation commands/events, IDs, scenario types, and constants |
| `src/vendor/sdk/` | Client world model, event folding, snapshots, differencing, and visibility |
| `src/vendor/magic/` | Runes, spellbook, and autocast data; the engine-dependent magic system is omitted |
| `src/vendor/scenario/examples.ts` | Names of scenarios bundled by the server |

Harness modules use two import façades. `#protocol` maps to `src/protocol.ts` and exposes the
curated shared wire vocabulary. `#world` maps to `src/world.ts` and exposes the SDK world-model
surface plus the brief exported `WorldAdapter` contract. Direct vendor imports are limited to the
few magic/scenario modules recorded in the repository conventions.

## Security boundary

The RuneSchool server is authoritative. It must authenticate identities and validate the command
name, payload, target entity, and permissions for every request, regardless of checks performed by
the harness. The harness adds a client-side boundary: actor actions must appear in
`ACTOR_COMMAND_TYPES`, admin command types are rejected on actor links, and `move` is explicitly
denied by `AGENT_DENIED_COMMANDS`. The raw operator command path applies the same actor allow-list
and `move` denial.

Model output, prompts, memory, events, tool arguments, and peer messages are all untrusted.
Actor/admin tokens are held only by live transport/runtime objects and are removed or redacted from
trace events and displayable config. Hosted authentication session tokens are used for the join
request once and discarded. Per-agent Ed25519 private keys stay in the identity store and are never
logged; actor tokens returned by the join flow receive the same redaction as other actor tokens.
The reflex DSL is declarative and closed; the harness never evaluates model-authored JavaScript.
