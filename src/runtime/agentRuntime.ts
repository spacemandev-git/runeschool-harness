import { ACTOR_COMMAND_TYPES, TICK_MILLIS, type JsonValue, type ServerEvent } from '#protocol';
import { AGENT_DENIED_COMMANDS } from '../core/actions.ts';
import type {
  ActionIntent, ActorCredentials, ActorLink, AgentHandle, AgentSpec, DefsReader, HarnessBus,
  McpSession, MemoryStoreFactory, MindDeps, MindFactory, ModelRegistry, PromptLibrary, ReflexContext,
  ReflexEngine, WorldView
} from '../core/index.ts';
import { PULSE_MILLIS } from '../core/index.ts';
import { createWorldModel, type WorldModel } from '../perception/index.ts';
import { createReflexEngine, REFLEX_PRESETS } from '../reflex/index.ts';
import { createActorLink, createDefsReader, serverBaseUrlOf } from '../transport/index.ts';
import type { Mailboxes } from './mailbox.ts';
import { createWorldReads } from './worldReads.ts';

const DEFAULT_WAKE = {
  minIntervalMs: 3_000, heartbeatMs: 45_000, hpAlertFraction: 0.5,
  maxTurns: 0, maxToolCallsPerWake: 12
} as const;
const DEFAULT_CONTEXT = {
  maxPromptTokens: 24_000, compactAtTokens: 18_000, keepTurns: 6, recallLimit: 6
} as const;
const MCP_READ_TOOLS = new Set(['get_instance', 'search_assets', 'get_asset', 'list_equipment']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface AgentRuntime extends AgentHandle {
  readonly link: ActorLink;
  readonly model: WorldModel;
  readonly finishedResult?: { readonly success: boolean; readonly summary: string };
  readonly paused: boolean;
  setTeam(team: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  pulseNow(): Promise<void>;
}

export interface AgentRuntimeDeps {
  readonly runId: string;
  readonly spec: AgentSpec;
  readonly credentials: ActorCredentials;
  readonly worldContext: JsonValue;
  readonly bus: HarnessBus;
  readonly models: ModelRegistry;
  readonly prompts: PromptLibrary;
  readonly memoryFactory: MemoryStoreFactory;
  readonly mindFactory: MindFactory;
  readonly mailboxes: Mailboxes;
  readonly mcp: McpSession;
  readonly now?: () => number;
  readonly canMessage?: MindDeps['canMessage'];
  readonly createLink?: (credentials: ActorCredentials, bus: HarnessBus, options: { agentId: string }) => ActorLink;
  readonly createDefs?: (baseUrl: string) => DefsReader;
  readonly createModel?: (options: Parameters<typeof createWorldModel>[0]) => WorldModel;
  readonly createReflexes?: (options: { agentId: string; bus: HarnessBus }) => ReflexEngine;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const now = deps.now ?? Date.now;
  let assignedTeam = deps.spec.team;
  const runtimeSpec: AgentSpec = { ...deps.spec, get team() { return assignedTeam; } };
  const link = (deps.createLink ?? createActorLink)(deps.credentials, deps.bus, { agentId: deps.spec.id });
  const defs = (deps.createDefs ?? createDefsReader)(serverBaseUrlOf(deps.credentials.httpUrl));
  const model = (deps.createModel ?? createWorldModel)({
    agentId: deps.spec.id, tag: deps.credentials.tag, entity: deps.credentials.entity,
    link, defs, bus: deps.bus, now
  });
  const reflexes = (deps.createReflexes ?? createReflexEngine)({ agentId: deps.spec.id, bus: deps.bus });
  const memory = deps.memoryFactory.open(deps.spec.id, deps.runId);
  const mailbox = deps.mailboxes.forRecipient(deps.spec.id, deps.spec.id);
  let state: AgentHandle['state'] = 'provisioning';
  let goal = deps.spec.goal;
  let paused = false;
  let blindPause = false;
  let stateBeforePause: AgentHandle['state'] = 'idle';
  let stopping = false;
  let started = false;
  let finishedResult: { success: boolean; summary: string } | undefined;
  let pulseTimer: ReturnType<typeof setInterval> | undefined;
  let pulseBusy = false;
  let pulseCount = 0;
  let pulseCheckpoint = 0;
  let unregisterMailbox: (() => void) | undefined;
  let unsubscribeEvent: (() => void) | undefined;
  let unsubscribeClose: (() => void) | undefined;

  const readTools = Object.fromEntries(deps.mcp.tools().filter((tool) => MCP_READ_TOOLS.has(tool.name)).map((tool) => [
    tool.name,
    {
      description: `MCP: ${tool.description ?? tool.name}`,
      inputSchema: tool.inputSchema,
      call: (args: Readonly<Record<string, unknown>>) => deps.mcp.call(tool.name, args)
    }
  ]));

  function setState(next: AgentHandle['state'], detail?: string): void {
    if (state === next && detail === undefined) return;
    state = next;
    deps.bus.emit('agent.state', { agentId: deps.spec.id, state: next, ...(detail === undefined ? {} : { detail }) });
  }

  const mindDeps: MindDeps = {
    agentId: deps.spec.id,
    spec: runtimeSpec,
    view: model,
    sink: link,
    commandTypes: ACTOR_COMMAND_TYPES,
    deniedCommandTypes: AGENT_DENIED_COMMANDS,
    pulseMs: TICK_MILLIS,
    reflexes,
    memory,
    models: deps.models,
    prompts: deps.prompts,
    bus: deps.bus,
    mailbox,
    ...(deps.canMessage === undefined ? {} : { canMessage: deps.canMessage }),
    worldContext: deps.worldContext,
    worldReads: createWorldReads(link, defs, model),
    mcpReadTools: readTools,
    wake: { ...DEFAULT_WAKE, ...deps.spec.wake },
    context: { ...DEFAULT_CONTEXT, ...deps.spec.context },
    onFinished(success, summary): void {
      if (finishedResult !== undefined) return;
      finishedResult = { success, summary };
      setState('finished', summary);
      deps.bus.emit('agent.finished', { agentId: deps.spec.id, success, summary });
    },
    setState(next, detail): void {
      if (finishedResult !== undefined || stopping) return;
      if (paused && next !== 'dead' && next !== 'errored') return;
      setState(next, detail);
    }
  };
  const mind = deps.mindFactory(mindDeps);

  function receive(event: ServerEvent): void {
    const data = isRecord(event.data) ? event.data : {};
    if (data.entity !== deps.credentials.entity) return;
    if (event.type === 'died') {
      setState('dead');
      void mind.wake('salient-event', 'you died');
    } else if (event.type === 'respawned' && finishedResult === undefined) {
      if (paused) stateBeforePause = 'idle';
      setState(paused ? 'paused' : 'idle');
    }
  }

  async function pulseNow(): Promise<void> {
    if (pulseBusy || stopping) {
      if (pulseBusy) deps.bus.emit('log', { level: 'debug', scope: `agent:${deps.spec.id}`, message: 'Skipped overlapping reflex pulse' });
      return;
    }
    pulseBusy = true;
    try {
      const pulseEvents = model.lastPulseEvents();
      const ctx: ReflexContext = {
        agentId: deps.spec.id,
        view: model,
        tick: model.snapshot().tick,
        pulseEvents,
        act: (async (intent: Omit<ActionIntent, 'source'>) => {
          const supplied = intent as ActionIntent;
          const full: ActionIntent = 'source' in supplied
            ? supplied : { ...intent, source: { kind: 'reflex', id: 'runtime' } };
          return await link.submit(full);
        }) as ReflexContext['act'],
        wakeMind(reason, note): void { void mind.wake(reason, note); },
        log(line): void { deps.bus.emit('agent.reflex', { agentId: deps.spec.id, line, state: reflexes.state() }); }
      };
      await reflexes.pulse(ctx);
      pulseCount++;
      const delta = model.deltaSince(pulseCheckpoint);
      if (delta.lines.length > 0) deps.bus.emit('agent.delta', { agentId: deps.spec.id, delta });
      pulseCheckpoint = model.checkpoint();
      if (pulseCount % 5 === 0) deps.bus.emit('agent.snapshot', { agentId: deps.spec.id, snapshot: model.snapshot() });
    } finally { pulseBusy = false; }
  }

  const runtime: AgentRuntime = {
    id: deps.spec.id,
    spec: runtimeSpec,
    tag: deps.credentials.tag,
    entity: deps.credentials.entity,
    get team() { return assignedTeam; },
    get state() { return state; },
    get goal() { return goal; },
    get finishedResult() { return finishedResult; },
    get paused() { return paused; },
    view: model,
    reflexes,
    mind,
    memory,
    mailbox,
    link,
    model,
    async start(): Promise<void> {
      if (started) return;
      const preset = deps.spec.reflexPreset;
      const rules = preset === undefined ? [] : REFLEX_PRESETS[preset];
      if (preset !== undefined && rules === undefined) throw new Error(`Unknown reflex preset '${preset}' for agent '${deps.spec.id}'`);
      for (const rule of [...(rules ?? []), ...(deps.spec.rules ?? [])]) {
        const validation = reflexes.installRule(rule);
        if (!validation.ok) throw new Error(`Invalid reflex rule '${rule.id}' for agent '${deps.spec.id}': ${validation.errors.map((entry) => `${entry.path} ${entry.message}`).join('; ')}`);
      }
      unsubscribeEvent = link.onEvent(receive);
      unsubscribeClose = link.onClose((reason) => {
        if (!stopping) setState('errored', reason);
      });
      unregisterMailbox = deps.mailboxes.register(deps.spec.id, (from, text) => mind.say(from, text));
      await link.connect();
      await model.start();
      pulseCheckpoint = model.checkpoint();
      started = true;
      setState('idle');
      pulseTimer = (deps.setInterval ?? globalThis.setInterval)(() => { void pulseNow(); }, PULSE_MILLIS);
      // Fire-and-forget: setGoal applies the goal synchronously but its promise resolves only
      // after the first full mind turn. Awaiting here serializes the orchestrator's spawn loop
      // behind minutes of model latency on slow reasoning models, so later agents never boot.
      if (goal !== undefined) void mind.setGoal(goal, 'config');
    },
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      if (pulseTimer !== undefined) (deps.clearInterval ?? globalThis.clearInterval)(pulseTimer);
      pulseTimer = undefined;
      unregisterMailbox?.();
      unsubscribeEvent?.();
      unsubscribeClose?.();
      await mind.dispose();
      model.stop();
      await link.close();
      memory.close();
    },
    pulseNow,
    setTeam(team): void {
      assignedTeam = team;
    },
    async setGoal(nextGoal, from): Promise<void> {
      goal = nextGoal;
      await mind.setGoal(nextGoal, from);
    },
    pause(reason, opts): void {
      if (paused || finishedResult !== undefined) return;
      paused = true;
      blindPause = opts?.blind === true;
      stateBeforePause = state;
      setState('paused', reason);
    },
    resume(): void {
      if (!paused || finishedResult !== undefined) return;
      paused = false;
      setState(stateBeforePause === 'dead' ? 'dead' : 'idle');
      const wasBlind = blindPause;
      blindPause = false;
      void mind.wake('resumed', wasBlind ? 'resumed (blind)' : undefined);
    },
    summary(): string {
      let snapshot;
      const shownGoal = deps.spec.privateGoal === true ? '(private)' : goal ?? 'none';
      try { snapshot = model.snapshot(); } catch { return `${deps.spec.id}: ${state}; goal=${shownGoal}`; }
      const at = snapshot.self.at;
      const behaviour = reflexes.state().behaviour?.description ?? 'none';
      return `${deps.spec.id}: ${state}; hp ${snapshot.self.hp.current}/${snapshot.self.hp.max}; at (${at.x},${at.z},${at.level}); ${snapshot.self.activity.kind}; behaviour ${behaviour}; goal ${shownGoal}`;
    }
  };
  return runtime;
}
