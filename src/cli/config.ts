import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentSpec, RunConfig, TeamId, WorldSelection } from '../core/index.ts';
import { loadHarnessEnvironment } from '../environment.ts';

export const HELP = `RuneSchool multi-agent harness

Usage (from the repository root):
  bun run start "Defeat three goblins"
  bun run start --scenario arena-island --agent hero="Walk east" --headless
  bun run start --sandbox lumbridge --agent miner --agent banker --team workers=miner,banker:"Gather ore"
  bun run start --resume <worldId> --agent agent
  bun run start --attach join.json --agent hero@hero
  bun run start --daemon --scenario arena-island --agent hero="Survive"   # then: bun run start attach latest

World (choose at most one; default --scenario goblin-menace):
  --scenario <name>       Start a scenario
  --sandbox <query>       Create a sandbox from a region search
  --resume <worldId>      Resume a saved world
  --attach <json-file>    Attach using {instanceId,httpUrl,wsUrl,actors[],adminToken?}
  --seed <n>              World seed (default: 1)
  --pvp                   Enable PvP for new scenario/sandbox worlds

Agents and teams:
  --agent <id>[=<goal>]   Add an agent; id may be id@actor-tag (repeatable)
  --agents <json-file>    Merge {agents: AgentSpec[], teams?, channels?, traceModelMessages?}
  --team <id>=<a,b>:<mission>  Create a team (repeatable)
  --channels <policy>     Agent messaging: open or team-only (default: open)
  --preset <name>         Default reflex preset (default: melee-basic)
  --director <text>       Initial director instruction
  --admin <text>          Initial admin instruction

Operation:
  --headless              Print compact events instead of opening the cockpit
  --daemon                Start detached (implies --headless --serve and keep-alive)
  --no-serve              Do not expose the run for remote control (default: serve)
  --keep-alive            Disable the headless idle-exit timer
  --run-id <id>           Stable run id (lowercase letters, digits, and hyphens)
  --auto-director         Wake the director automatically (default in headless mode)
  --model-config <path>   Model registry JSON
  --trace-model-messages Include redacted serialized prompts in model.request events
  --mcp-url <url>         MCP endpoint (default: RUNESCHOOL_API_BACKEND + /mcp)
  --ui-url <url>          Spectator UI origin
  --log-dir <path>        JSONL trace directory (default: <repo>/runs)
  --data-dir <path>       Persistent memory directory (default: <repo>/data)
  --max-run-ms <n>        Hard headless run timeout
  --idle-exit-ms <n>      Terminal inactivity before headless exit (default: 15000)
  --help, -h              Show this help

Control:
  attach [runId|latest] [--log-dir <path>]  Attach a cockpit; q detaches
  ps [--prune] [--log-dir <path>]           List runs and optionally remove stale descriptors
  stop [runId|latest] [--log-dir <path>]    Gracefully stop a run
  logs [runId|latest] [-f] [--log-dir <path>]  Show the daemon log (last 40 lines)
  phases <script.json> [--target latest|<runId>] [--log-dir <path>]  Drive scripted phases

Environment:
  ROUTER_API_BASE, ROUTER_API_KEY, ROUTER_MODEL, RUNESCHOOL_API_BACKEND,
  RUNESCHOOL_MCP_URL, RUNESCHOOL_UI_URL
`;

export const PHASES_HELP = `Usage:
  bun run start phases <script.json> [--log-dir <path>] [--target latest|<runId>]

Drive a running harness with a validated phase script. Tick durations use the instance HTTP API
when available and fall back to wall-clock time; millisecond durations always use wall-clock time.
`;

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
type Env = Record<string, string | undefined>;
type TeamSpec = { readonly id: TeamId; readonly mission: string; readonly agents: readonly string[] };
export type HarnessSubcommand =
  | { readonly name: 'attach'; readonly target: string; readonly logDir: string }
  | { readonly name: 'ps'; readonly prune: boolean; readonly logDir: string }
  | { readonly name: 'stop'; readonly target: string; readonly logDir: string }
  | { readonly name: 'logs'; readonly target: string; readonly follow: boolean; readonly logDir: string }
  | { readonly name: 'phases'; readonly scriptPath: string; readonly target: string; readonly logDir: string };
export type ParsedRunConfig = RunConfig & { readonly autoDirector: boolean; readonly daemon: boolean };
export type ParsedConfig = ParsedRunConfig | { readonly subcommand: HarnessSubcommand } | { readonly help: string };

function nonempty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
function validId(value: unknown, name: string): string {
  const text = nonempty(value, name);
  if (!ID.test(text)) throw new Error(`${name} '${text}' must match ${ID.source}`);
  return text;
}
function integer(value: string, name: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  return result;
}
function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function readJson(path: string, name: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) { throw new Error(`${name} '${path}': ${error instanceof Error ? error.message : String(error)}`); }
}
function validateAgent(value: unknown, name: string): AgentSpec {
  const raw = record(value, name);
  const id = validId(raw.id, `${name}.id`);
  const tag = raw.tag === undefined ? undefined : validId(raw.tag, `${name}.tag`);
  const team = raw.team === undefined ? undefined : validId(raw.team, `${name}.team`);
  if (raw.goal !== undefined && typeof raw.goal !== 'string') throw new Error(`${name}.goal must be a string`);
  if (raw.privateGoal !== undefined && typeof raw.privateGoal !== 'boolean') throw new Error(`${name}.privateGoal must be a boolean`);
  return { ...raw, id, ...(tag === undefined ? {} : { tag }), ...(team === undefined ? {} : { team }) } as unknown as AgentSpec;
}
function validateTeam(value: unknown, name: string): TeamSpec {
  const raw = record(value, name);
  const id = validId(raw.id, `${name}.id`);
  const mission = nonempty(raw.mission, `${name}.mission`);
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) throw new Error(`${name}.agents must be a non-empty array`);
  return { id, mission, agents: raw.agents.map((agent, index) => validId(agent, `${name}.agents[${index}]`)) };
}
function trimUrl(value: string): string { return value.replace(/\/+$/, ''); }

export function deriveUiUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  if (url.hostname === 'api.runeschool.dev') return 'https://runeschool.dev';
  if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return 'http://localhost:5300';
  return url.origin;
}

function cliAgent(raw: string): AgentSpec {
  const separator = raw.indexOf('=');
  const identity = separator < 0 ? raw : raw.slice(0, separator);
  const goal = separator < 0 ? undefined : raw.slice(separator + 1).trim();
  const at = identity.indexOf('@');
  const id = validId(at < 0 ? identity : identity.slice(0, at), '--agent id');
  const tag = at < 0 ? undefined : validId(identity.slice(at + 1), '--agent tag');
  return { id, ...(tag === undefined ? {} : { tag }), ...(goal === undefined || goal.length === 0 ? {} : { goal }) };
}

function cliTeam(raw: string): TeamSpec {
  const equals = raw.indexOf('=');
  const colon = raw.indexOf(':', equals + 1);
  if (equals <= 0 || colon < 0) throw new Error('--team must have the form <id>=<agent,agent>:<mission>');
  const id = validId(raw.slice(0, equals), '--team id');
  const agents = raw.slice(equals + 1, colon).split(',').filter(Boolean).map((agent) => validId(agent.trim(), '--team agent'));
  if (agents.length === 0) throw new Error('--team requires at least one agent');
  return { id, agents, mission: nonempty(raw.slice(colon + 1), '--team mission') };
}

function parseSubcommand(argv: readonly string[], commandIndex: number): { readonly subcommand: HarnessSubcommand } {
  const name = argv[commandIndex] as HarnessSubcommand['name'];
  let logDir = resolve(import.meta.dir, '../../runs');
  let target = 'latest';
  let targetSeen = false;
  let prune = false;
  let follow = false;
  let scriptPath: string | undefined;
  for (let index = commandIndex + 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') continue;
    if (arg === '--log-dir') {
      const value = argv[++index];
      if (value === undefined) throw new Error('--log-dir requires a value');
      logDir = value;
    } else if (name === 'phases' && arg === '--target') {
      const value = argv[++index];
      if (value === undefined) throw new Error('--target requires a value');
      target = value;
    } else if (name === 'ps' && arg === '--prune') prune = true;
    else if (name === 'logs' && (arg === '-f' || arg === '--follow')) follow = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown ${name} option: ${arg}`);
    else if (name === 'ps') throw new Error(`ps does not accept a run id: ${arg}`);
    else if (name === 'phases' && scriptPath !== undefined) throw new Error('phases accepts only one script path');
    else if (name === 'phases') scriptPath = arg;
    else if (targetSeen) throw new Error(`${name} accepts only one run id`);
    else { target = arg; targetSeen = true; }
  }
  if (name === 'ps') return { subcommand: { name, prune, logDir } };
  if (target !== 'latest' && !RUN_ID.test(target)) throw new Error(`run id '${target}' must match ${RUN_ID.source}`);
  if (name === 'phases') {
    if (scriptPath === undefined) throw new Error('phases requires <script.json>');
    return { subcommand: { name, scriptPath, target, logDir } };
  }
  if (name === 'logs') return { subcommand: { name, target, follow, logDir } };
  return { subcommand: { name, target, logDir } };
}

export function parseRunConfig(argv: readonly string[], env: Env = process.env): ParsedConfig {
  const commandIndex = argv.findIndex((arg) => arg !== '--' && !arg.startsWith('-'));
  if (commandIndex >= 0 && argv[commandIndex] === 'phases' && argv.slice(commandIndex + 1).some((arg) => arg === '--help' || arg === '-h')) {
    return { help: PHASES_HELP };
  }
  if (commandIndex >= 0 && ['attach', 'ps', 'stop', 'logs', 'phases'].includes(argv[commandIndex]!)) {
    return parseSubcommand(argv, commandIndex);
  }
  let world: WorldSelection = { kind: 'scenario', name: 'goblin-menace', seed: 1 };
  let worldFlag: string | undefined;
  let seed = 1;
  let pvp = false;
  let headless = false;
  let daemon = false;
  let serve = true;
  let keepAlive = false;
  let runId: string | undefined;
  let daemonLogPath: string | undefined;
  let idleExitExplicit = false;
  let autoDirectorFlag = false;
  let directorPrompt: string | undefined;
  let adminPrompt: string | undefined;
  let modelConfigPath: string | undefined;
  let channels: 'open' | 'team-only' = 'open';
  let traceModelMessages = false;
  const environment = loadHarnessEnvironment(env);
  let mcpUrl = environment.runeschoolMcpUrl;
  let uiUrl = environment.runeschoolUiUrl;
  let logDir = resolve(import.meta.dir, '../../runs');
  let dataDir = resolve(import.meta.dir, '../../data');
  let maxRunMs: number | undefined;
  let idleExitMs: number | undefined;
  let preset = 'melee-basic';
  const agents: AgentSpec[] = [];
  const teams: TeamSpec[] = [];
  const positional: string[] = [];

  const choose = (flag: string): void => {
    if (worldFlag !== undefined && worldFlag !== flag) throw new Error(`${worldFlag} and ${flag} are mutually exclusive`);
    worldFlag = flag;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') return { help: HELP };
    const next = (): string => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--scenario') { choose(arg); world = { kind: 'scenario', name: nonempty(next(), arg), seed }; }
    else if (arg === '--sandbox') { choose(arg); world = { kind: 'sandbox', query: nonempty(next(), arg), seed }; }
    else if (arg === '--resume') { choose(arg); world = { kind: 'resume', worldId: nonempty(next(), arg) }; }
    else if (arg === '--attach') {
      choose(arg);
      const path = next(); const raw = record(readJson(path, '--attach'), '--attach');
      if (!Array.isArray(raw.actors)) throw new Error('--attach.actors must be an array');
      const instanceId = nonempty(raw.instanceId, '--attach.instanceId');
      const httpUrl = nonempty(raw.httpUrl, '--attach.httpUrl'); const wsUrl = nonempty(raw.wsUrl, '--attach.wsUrl');
      const adminToken = raw.adminToken === undefined ? undefined : nonempty(raw.adminToken, '--attach.adminToken');
      world = {
        kind: 'attach', instanceId, httpUrl, wsUrl,
        ...(adminToken === undefined ? {} : { adminToken }),
        actors: raw.actors.map((value, actorIndex) => {
          const actor = record(value, `--attach.actors[${actorIndex}]`);
          return {
            instanceId, httpUrl, wsUrl,
            tag: validId(actor.tag, `--attach.actors[${actorIndex}].tag`),
            entity: integer(String(actor.entity), `--attach.actors[${actorIndex}].entity`),
            token: nonempty(actor.token, `--attach.actors[${actorIndex}].token`)
          };
        })
      };
    }
    else if (arg === '--seed') seed = integer(next(), arg);
    else if (arg === '--pvp') pvp = true;
    else if (arg === '--agent') agents.push(cliAgent(next()));
    else if (arg === '--agents') {
      const path = next(); const raw = record(readJson(path, '--agents'), '--agents');
      if (!Array.isArray(raw.agents)) throw new Error('--agents file must contain an agents array');
      agents.push(...raw.agents.map((agent, agentIndex) => validateAgent(agent, `agents[${agentIndex}]`)));
      if (raw.teams !== undefined) {
        if (!Array.isArray(raw.teams)) throw new Error('--agents teams must be an array');
        teams.push(...raw.teams.map((team, teamIndex) => validateTeam(team, `teams[${teamIndex}]`)));
      }
      if (raw.channels !== undefined) {
        if (raw.channels !== 'open' && raw.channels !== 'team-only') throw new Error('--agents channels must be open or team-only');
        channels = raw.channels;
      }
      if (raw.traceModelMessages !== undefined) {
        if (typeof raw.traceModelMessages !== 'boolean') throw new Error('--agents traceModelMessages must be a boolean');
        traceModelMessages = raw.traceModelMessages;
      }
    }
    else if (arg === '--team') teams.push(cliTeam(next()));
    else if (arg === '--channels') {
      const policy = next();
      if (policy !== 'open' && policy !== 'team-only') throw new Error('--channels must be open or team-only');
      channels = policy;
    }
    else if (arg === '--preset') preset = nonempty(next(), arg);
    else if (arg === '--director') directorPrompt = nonempty(next(), arg);
    else if (arg === '--admin') adminPrompt = nonempty(next(), arg);
    else if (arg === '--headless') headless = true;
    else if (arg === '--daemon') daemon = true;
    else if (arg === '--no-serve') serve = false;
    else if (arg === '--serve') serve = true;
    else if (arg === '--keep-alive') keepAlive = true;
    else if (arg === '--run-id') {
      runId = nonempty(next(), arg);
      if (!RUN_ID.test(runId)) throw new Error(`--run-id '${runId}' must match ${RUN_ID.source}`);
    }
    else if (arg === '--daemon-log') daemonLogPath = nonempty(next(), arg);
    else if (arg === '--auto-director') autoDirectorFlag = true;
    else if (arg === '--model-config') modelConfigPath = next();
    else if (arg === '--trace-model-messages') traceModelMessages = true;
    else if (arg === '--mcp-url') mcpUrl = next();
    else if (arg === '--ui-url') uiUrl = next();
    else if (arg === '--log-dir') logDir = next();
    else if (arg === '--data-dir') dataDir = next();
    else if (arg === '--max-run-ms') maxRunMs = integer(next(), arg);
    else if (arg === '--idle-exit-ms') { idleExitMs = integer(next(), arg, true); idleExitExplicit = true; }
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }

  if (positional.length > 0) {
    if (agents.length > 0) throw new Error('A positional goal cannot be combined with --agent or --agents');
    agents.push({ id: 'agent', goal: positional.join(' ') });
  }
  if (world.kind === 'scenario') world = { ...world, seed, ...(pvp ? { pvp: true } : {}) };
  else if (world.kind === 'sandbox') world = { ...world, seed, ...(pvp ? { pvp: true } : {}) };
  else if (pvp) throw new Error('--pvp is only valid with --scenario or --sandbox');
  if (world.kind === 'sandbox' && agents.length === 0) throw new Error('--sandbox requires at least one agent');

  const ids = new Set<string>(); const tags = new Set<string>();
  let normalized = agents.map((agent, index): AgentSpec => {
    if (ids.has(agent.id)) throw new Error(`Duplicate agent id '${agent.id}'`);
    ids.add(agent.id);
    let tag = agent.tag;
    let useExistingSlot = agent.useExistingSlot;
    if (index === 0 && world.kind === 'scenario' && useExistingSlot === undefined) {
      useExistingSlot = true;
    }
    const unresolvedScenarioSlot = index === 0 && world.kind === 'scenario'
      && useExistingSlot === true && tag === undefined;
    if (!unresolvedScenarioSlot) tag ??= agent.id;
    if (tag !== undefined) {
      if (tags.has(tag)) throw new Error(`Duplicate agent tag '${tag}'`);
      tags.add(tag);
    }
    return {
      ...agent,
      ...(tag === undefined ? {} : { tag }),
      ...(useExistingSlot === undefined ? {} : { useExistingSlot }),
      reflexPreset: agent.reflexPreset ?? preset
    };
  });
  const teamIds = new Set<string>(); const assigned = new Map<string, string>();
  for (const team of teams) {
    if (teamIds.has(team.id)) throw new Error(`Duplicate team id '${team.id}'`);
    teamIds.add(team.id);
    for (const agent of team.agents) {
      if (!ids.has(agent)) throw new Error(`Team '${team.id}' references unknown agent '${agent}'`);
      const previous = assigned.get(agent);
      if (previous !== undefined && previous !== team.id) throw new Error(`Agent '${agent}' belongs to both '${previous}' and '${team.id}'`);
      assigned.set(agent, team.id);
    }
  }
  normalized = normalized.map((agent) => {
    const team = assigned.get(agent.id) ?? agent.team;
    if (agent.team !== undefined && assigned.get(agent.id) !== undefined && agent.team !== assigned.get(agent.id)) {
      throw new Error(`Agent '${agent.id}' has conflicting team assignments`);
    }
    return team === undefined ? agent : { ...agent, team };
  });

  mcpUrl = trimUrl(mcpUrl); new URL(mcpUrl);
  const resolvedUiUrl = trimUrl(uiUrl ?? deriveUiUrl(mcpUrl)); new URL(resolvedUiUrl);
  if (daemon) {
    headless = true;
    serve = true;
    if (!idleExitExplicit) keepAlive = true;
  }
  runId ??= `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return {
    runId, mcpUrl, uiUrl: resolvedUiUrl, world, agents: normalized,
    ...(teams.length === 0 ? {} : { teams }),
    ...(directorPrompt === undefined ? {} : { directorPrompt }),
    ...(adminPrompt === undefined ? {} : { adminPrompt }),
    headless, logDir, dataDir, serve, keepAlive, channels, traceModelMessages,
    ...(daemonLogPath === undefined ? {} : { daemonLogPath }),
    ...(modelConfigPath === undefined ? {} : { modelConfigPath }),
    ...(headless ? { idleExitMs: idleExitMs ?? 15_000 } : idleExitMs === undefined ? {} : { idleExitMs }),
    ...(maxRunMs === undefined ? {} : { maxRunMs }),
    autoDirector: autoDirectorFlag || headless,
    daemon
  };
}
