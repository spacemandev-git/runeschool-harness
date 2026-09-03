import type { JsonValue } from '#protocol';
import type {
  ActorCredentials, AddPlayerRequest, Admin, AdminFactory, AgentHandle, AgentSpec, ChatMessage, DefsReader,
  HarnessBus, McpSession, MemoryStoreFactory, MindFactory, ModelRegistry, PromptLibrary, ProvisionedWorld, RunConfig,
  LiveRuntimeCommands, RuntimeView, TeamId
} from '../core/index.ts';
import { createCoordinator, createDirector, type Coordinator, type Director } from '../director/index.ts';
import { createDefsReader, createMcpSession, serverBaseUrlOf } from '../transport/index.ts';
import { createAgentRuntime, type AgentRuntime } from './agentRuntime.ts';
import { createMailboxes } from './mailbox.ts';
import { createJsonlTrace } from './trace.ts';
import { createRuntimeSurface, type RuntimeTeamRecord } from './view.ts';

export interface HarnessRuntime {
  readonly view: RuntimeView;
  readonly commands: LiveRuntimeCommands;
  start(): Promise<void>;
  readonly stopped: Promise<{ readonly reason: string }>;
  agents(): readonly AgentHandle[];
}

export interface HarnessRuntimeDeps {
  readonly bus: HarnessBus;
  readonly models: ModelRegistry;
  readonly prompts: PromptLibrary;
  readonly memoryFactory: MemoryStoreFactory;
  readonly mindFactory: MindFactory;
  readonly adminFactory?: AdminFactory;
  readonly mcp?: McpSession;
  readonly now?: () => number;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
function playerRequest(spec: AgentSpec): AddPlayerRequest {
  return {
    tag: spec.tag ?? spec.id,
    ...(spec.displayName === undefined ? {} : { displayName: spec.displayName }),
    ...(spec.spawn?.at === undefined ? {} : { spawnAt: spec.spawn.at }),
    ...(spec.spawn?.stats === undefined ? {} : { stats: spec.spawn.stats }),
    ...(spec.spawn?.inventory === undefined ? {} : { inventory: spec.spawn.inventory }),
    ...(spec.spawn?.equipment === undefined ? {} : { equipment: spec.spawn.equipment })
  };
}

function serializedMessages(messages: readonly ChatMessage[]): readonly { role: string; content: string; name?: string }[] {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    ...('name' in message && message.name !== undefined ? { name: message.name } : {})
  }));
}

/** Add opt-in request content to registry events without changing provider/accounting behavior. */
export function withModelRequestContent(models: ModelRegistry, bus: HarnessBus, enabled: boolean): {
  readonly models: ModelRegistry;
  dispose(): void;
} {
  if (!enabled) return { models, dispose() {} };
  const pending: { role: Parameters<ModelRegistry['chat']>[0]; agentId?: string; messages: readonly ChatMessage[] }[] = [];
  const unsubscribe = bus.on('model.request', (event) => {
    const active = pending.findLast((entry) => entry.role === event.data.role && entry.agentId === event.data.agentId);
    if (active === undefined) return;
    (event.data as { content?: readonly { role: string; content: string; name?: string }[] }).content = serializedMessages(active.messages);
  });
  return {
    models: {
      resolve: (role, agentId) => models.resolve(role, agentId),
      setRoleOverride: (role, spec) => models.setRoleOverride(role, spec),
      clearRoleOverride: (role) => models.clearRoleOverride(role),
      setOverride: (agentId, role, spec) => models.setOverride(agentId, role, spec),
      clearOverride: (agentId, role) => models.clearOverride(agentId, role),
      chat(role, request, options) {
        pending.push({ role, ...(options?.agentId === undefined ? {} : { agentId: options.agentId }), messages: request.messages });
        try { return models.chat(role, request, options); } finally { pending.pop(); }
      },
      usage: () => models.usage(),
      providers: () => models.providers()
    },
    dispose: unsubscribe
  };
}

export function createHarnessRuntime(config: RunConfig, deps: HarnessRuntimeDeps): HarnessRuntime {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const mcp = deps.mcp ?? createMcpSession(config.mcpUrl, deps.bus);
  const traced = withModelRequestContent(deps.models, deps.bus, config.traceModelMessages === true);
  const trace = createJsonlTrace(deps.bus, config.logDir, config.runId);
  const mailboxes = createMailboxes(deps.bus, now);
  const agentRuntimes: AgentRuntime[] = [];
  const teamRecords: RuntimeTeamRecord[] = [];
  let world: ProvisionedWorld | undefined;
  let defs: DefsReader | undefined;
  let director: Director | undefined;
  let admin: Admin | undefined;
  let started = false;
  let stopping: Promise<void> | undefined;
  let stopResolve!: (value: { reason: string }) => void;
  const stopped = new Promise<{ reason: string }>((resolve) => { stopResolve = resolve; });
  const unregister: (() => void)[] = [];
  const removingAgents = new Set<string>();

  const canMessage = (from: string, to: string): boolean => {
    if (config.channels !== 'team-only') return true;
    if (to === 'director' || to === 'admin' || to.startsWith('coordinator:')) return true;
    const sender = agentRuntimes.find((agent) => agent.id === from);
    if (sender === undefined) return true;
    const recipient = agentRuntimes.find((agent) => agent.id === to);
    return sender.team !== undefined && recipient?.team === sender.team;
  };
  mailboxes.installPolicy((from, to) => canMessage(from, to));

  const autoDirector = (config as RunConfig & { readonly autoDirector?: boolean }).autoDirector ?? config.headless;
  const watchUrl = (): string | undefined => world === undefined ? undefined
    : `${config.uiUrl}/#/runs/${encodeURIComponent(world.instanceId)}`;
  const redactAdminToken = (text: string): string => world?.adminToken === undefined || world.adminToken.length === 0
    ? text : text.replaceAll(world.adminToken, '[REDACTED]');
  const closeDefs = (): void => {
    const reader = defs as (DefsReader & { readonly close?: () => void }) | undefined;
    reader?.close?.();
    defs = undefined;
  };

  async function credentialsFor(spec: AgentSpec): Promise<ActorCredentials> {
    if (world === undefined) throw new Error('World is not provisioned');
    const tag = spec.tag ?? spec.id;
    const existing = config.world.kind === 'scenario' && spec.useExistingSlot === true && spec.tag === undefined
      ? world.actors[0]
      : world.actors.find((actor) => actor.tag === tag);
    if (config.world.kind === 'scenario' && spec.useExistingSlot === true) {
      if (existing === undefined) throw new Error(`Agent '${spec.id}' requested existing actor slot '${tag}', but it was not provisioned`);
      return existing;
    }
    if (config.world.kind === 'sandbox') {
      if (existing !== undefined) return existing;
      return await mcp.addPlayer(world.instanceId, playerRequest(spec));
    }
    if ((config.world.kind === 'resume' || config.world.kind === 'attach') && existing !== undefined) return existing;
    return await mcp.addPlayer(world.instanceId, playerRequest(spec));
  }

  async function spawnAgent(spec: AgentSpec): Promise<void> {
    if (!ID.test(spec.id)) throw new Error(`Agent id '${spec.id}' must match ${ID.source}`);
    const tag = spec.tag ?? spec.id;
    if (!ID.test(tag)) throw new Error(`Agent tag '${tag}' must match ${ID.source}`);
    if (agentRuntimes.some((agent) => agent.id === spec.id)) throw new Error(`Duplicate agent id '${spec.id}'`);
    if (agentRuntimes.some((agent) => agent.tag === tag)) throw new Error(`Duplicate agent tag '${tag}'`);
    const credentials = await credentialsFor(spec);
    if (agentRuntimes.some((agent) => agent.tag === credentials.tag)) {
      throw new Error(`Duplicate agent tag '${credentials.tag}'`);
    }
    const runtime = createAgentRuntime({
      runId: config.runId, spec, credentials, worldContext: world?.context ?? null,
      bus: deps.bus, models: traced.models, prompts: deps.prompts, memoryFactory: deps.memoryFactory,
      mindFactory: deps.mindFactory, mailboxes, mcp, now, canMessage
    });
    agentRuntimes.push(runtime);
    deps.bus.emit('agent.spawned', {
      agentId: spec.id, tag: runtime.tag, entity: runtime.entity,
      ...(spec.team === undefined ? {} : { team: spec.team }), displayName: spec.displayName ?? spec.id,
      ...(spec.privateGoal === undefined ? {} : { privateGoal: spec.privateGoal }),
      ...(spec.privateGoal === true || spec.persona === undefined ? {} : { persona: spec.persona }),
      ...(spec.privateGoal === true || spec.goal === undefined ? {} : { goal: spec.goal })
    });
    await runtime.start();
  }

  async function removeAgent(agentId: string, reason?: string): Promise<{ readonly removed: boolean }> {
    const runtime = agentRuntimes.find((agent) => agent.id === agentId);
    if (runtime === undefined || removingAgents.has(agentId)) return { removed: false };
    removingAgents.add(agentId);
    try {
      await runtime.stop();
      const index = agentRuntimes.indexOf(runtime);
      if (index >= 0) agentRuntimes.splice(index, 1);
      for (const team of teamRecords) {
        const memberIndex = team.agents.indexOf(agentId);
        if (memberIndex >= 0) team.agents.splice(memberIndex, 1);
      }
      deps.bus.emit('agent.removed', { agentId, ...(reason === undefined ? {} : { reason }) });
      return { removed: true };
    } finally {
      removingAgents.delete(agentId);
    }
  }

  async function createTeam(id: TeamId, mission: string, agents: readonly string[]): Promise<void> {
    if (!ID.test(id)) throw new Error(`Team id '${id}' must match ${ID.source}`);
    if (teamRecords.some((team) => team.id === id)) throw new Error(`Duplicate team id '${id}'`);
    if (new Set(agents).size !== agents.length) throw new Error(`Team '${id}' contains duplicate agents`);
    for (const agent of agents) {
      const member = agentRuntimes.find((entry) => entry.id === agent);
      if (member === undefined) throw new Error(`Unknown agent '${agent}' in team '${id}'`);
      if (member.team !== undefined && member.team !== id) throw new Error(`Agent '${agent}' already belongs to team '${member.team}'`);
      member.setTeam(id);
    }
    const record: RuntimeTeamRecord = { id, mission, agents: agents.slice() };
    teamRecords.push(record);
    deps.bus.emit('team.created', { teamId: id, agents, mission });
    const coordinator = createCoordinator(record, {
      agents: () => agentRuntimes, models: traced.models, prompts: deps.prompts, bus: deps.bus, mailboxes
    });
    record.coordinator = coordinator;
    unregister.push(mailboxes.register(`coordinator:${id}`, () => coordinator.notify()));
  }

  async function stop(reason: string): Promise<void> {
    stopping ??= (async () => {
      for (const cleanup of unregister.splice(0)) cleanup();
      director?.dispose();
      admin?.dispose();
      closeDefs();
      for (const team of teamRecords) team.coordinator?.dispose();
      const results = await Promise.allSettled(agentRuntimes.map((agent) => agent.stop()));
      await Promise.allSettled([mcp.close()]);
      const failed = agentRuntimes.some((agent) => agent.finishedResult?.success === false
        || agent.state === 'dead' || agent.state === 'errored') || results.some((result) => result.status === 'rejected');
      deps.bus.emit('run.finish', { runId: config.runId, summary: reason, ok: !failed });
      traced.dispose();
      trace.close();
      stopResolve({ reason });
    })();
    return stopping;
  }

  let surface!: ReturnType<typeof createRuntimeSurface>;
  surface = createRuntimeSurface({
    config, startedAt, models: traced.models, agents: () => agentRuntimes, teams: () => teamRecords,
    director: () => director, admin: () => admin, world: () => world, watchUrl, spawnAgent, removeAgent, createTeam, stop,
    async directorSay(text) {
      if (director === undefined) throw new Error('Director is not started');
      await director.say(text);
    },
    async adminSay(text) {
      if (admin === undefined) throw new Error('admin persona is not configured for this run');
      await admin.say(text);
    },
    async coordinatorSay(team, text) {
      const coordinator = teamRecords.find((entry) => entry.id === team)?.coordinator;
      if (coordinator === undefined) throw new Error(`Unknown team '${team}'`);
      await coordinator.say(text);
    },
    async agentSay(agent, text) {
      if (!agentRuntimes.some((entry) => entry.id === agent)) throw new Error(`Unknown agent '${agent}'`);
      mailboxes.send('operator', agent, text);
    }
  });

  unregister.push(deps.bus.on('team.report', (event) => {
    const team = teamRecords.find((entry) => entry.id === event.data.teamId);
    if (team !== undefined) team.lastReport = event.data.text;
  }));

  return {
    view: surface.view,
    commands: surface.commands,
    stopped,
    agents: () => agentRuntimes,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      deps.bus.emit('run.start', { runId: config.runId, config: surface.view.config() });
      try {
        await mcp.connect();
        const players = config.world.kind === 'sandbox'
          ? config.agents.map(playerRequest)
          : config.world.kind === 'scenario'
            ? config.agents.filter((agent) => agent.useExistingSlot !== true).map(playerRequest)
            : [];
        world = await mcp.provision(config.world, players);
        defs = createDefsReader(serverBaseUrlOf(world.httpUrl));
        deps.bus.emit('world.provisioned', {
          instanceId: world.instanceId, httpUrl: world.httpUrl, wsUrl: world.wsUrl,
          kind: world.kind, ...(watchUrl() === undefined ? {} : { watchUrl: watchUrl() })
        });
        for (const spec of config.agents) {
          const declaredTeam = config.teams?.find((team) => team.agents.includes(spec.id))?.id;
          if (spec.team !== undefined && declaredTeam !== undefined && spec.team !== declaredTeam) {
            throw new Error(`Agent '${spec.id}' has conflicting team assignments '${spec.team}' and '${declaredTeam}'`);
          }
          await spawnAgent(declaredTeam === undefined || spec.team !== undefined ? spec : { ...spec, team: declaredTeam });
        }
        for (const team of config.teams ?? []) await createTeam(team.id, team.mission, team.agents);
        director = createDirector({
          runtime: {
            view: surface.view, commands: surface.commands, createTeam,
            watchUrl
          },
          mcp, models: traced.models, prompts: deps.prompts, bus: deps.bus, config, mailboxes,
          autoWake: autoDirector
        });
        unregister.push(mailboxes.register('director', () => director?.notify()));
        if (deps.adminFactory !== undefined) {
          admin = deps.adminFactory({
            world, mcp, defs, view: surface.view, models: traced.models, prompts: deps.prompts, bus: deps.bus,
            drainInbound: () => mailboxes.drain('admin'),
            reportToDirector: (text) => mailboxes.send('admin', 'director', text),
            autoWake: autoDirector
          });
          unregister.push(mailboxes.register('admin', () => admin?.notify()));
        }
      } catch (error) {
        deps.bus.emit('run.error', {
          error: redactAdminToken(error instanceof Error ? error.message : String(error)),
          ...(error instanceof Error && error.stack !== undefined ? { stack: redactAdminToken(error.stack) } : {})
        });
        await stop('startup error');
        throw error;
      }
    }
  };
}
