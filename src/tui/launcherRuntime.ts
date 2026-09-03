import type { TileCoord } from '#protocol';
import type { AdminFactory } from '../core/admin.ts';
import type { MindFactory } from '../core/agent.ts';
import type { HarnessBus } from '../core/bus.ts';
import type { MemoryStoreFactory } from '../core/memory.ts';
import type { ModelRegistry } from '../core/model.ts';
import type { PromptLibrary } from '../core/prompts.ts';
import type { ModelSelection, RunConfig, RuntimeCommands, RuntimeView } from '../core/runtime.ts';
import type { HostedWorldClient } from '../core/transport.ts';
import { applyModelSelection, validateAndApplyModelSelection } from '../models/selection.ts';
import {
  createHarnessRuntime,
  type HarnessRuntime,
  type HarnessRuntimeDeps,
} from '../runtime/orchestrator.ts';
import type { BackendInstanceSummary } from './worldDirectory.ts';

export interface CockpitLauncherOptions {
  readonly backendUrl: string;
  readonly mcpUrl: string;
  readonly uiUrl: string;
  readonly bus: HarnessBus;
  readonly models: ModelRegistry;
  readonly prompts: PromptLibrary;
  readonly memoryFactory: MemoryStoreFactory;
  readonly mindFactory: MindFactory;
  readonly adminFactory: AdminFactory;
  readonly hostedWorld?: HostedWorldClient;
  readonly logDir: string;
  readonly dataDir: string;
  readonly initialModelSelections?: readonly ModelSelection[];
  readonly onModelSelected?: (selection: ModelSelection) => void | Promise<void>;
  readonly onStop: () => void | Promise<void>;
  readonly now?: () => number;
  readonly createRuntime?: (config: RunConfig, deps: HarnessRuntimeDeps) => HarnessRuntime;
}

export interface CockpitLauncher {
  readonly view: RuntimeView;
  readonly commands: RuntimeCommands;
  connect(instance: BackendInstanceSummary, options?: { readonly defaultSpawn?: TileCoord }): Promise<void>;
  spawnScenario(scenarioId: string): Promise<string>;
  current(): HarnessRuntime | undefined;
  stop(reason: string): Promise<void>;
}

const UNCONNECTED = 'connect to a RuneSchool instance from the World tab first';

function websocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/stream`;
  return url.toString();
}

export function createCockpitLauncher(options: CockpitLauncherOptions): CockpitLauncher {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const createRuntime = options.createRuntime ?? createHarnessRuntime;
  let active: HarnessRuntime | undefined;
  const coordinatorModels = new Map<string, string>();
  const agentModels = new Map<string, string>();

  for (const selection of options.initialModelSelections ?? []) {
    applyModelSelection(options.models, selection);
    if (selection.role === 'coordinator') coordinatorModels.set(selection.team, selection.model.trim());
    else if (selection.role === 'agent') agentModels.set(selection.agent, selection.model.trim());
  }

  const unconnectedConfig = () => ({
    backend: options.backendUrl,
    mcpUrl: options.mcpUrl,
    mode: 'cockpit',
    models: {
      director: options.models.resolve('director').model,
      admin: options.models.resolve('admin').model,
      agentDefault: options.models.resolve('agent').model,
      coordinators: Object.fromEntries(coordinatorModels),
      agents: Object.fromEntries(agentModels),
    },
  });

  const view: RuntimeView = {
    get runId() { return active?.view.runId ?? `cockpit-${process.pid}`; },
    get startedAt() { return active?.view.startedAt ?? startedAt; },
    get instance() { return active?.view.instance; },
    agents: () => active?.view.agents() ?? [],
    teams: () => active?.view.teams() ?? [],
    agentSnapshot: (id) => active?.view.agentSnapshot(id),
    agentReflexes: (id) => active?.view.agentReflexes(id),
    agentTranscript: (id) => active?.view.agentTranscript(id) ?? [],
    directorTranscript: () => active?.view.directorTranscript() ?? [],
    adminTranscript: () => active?.view.adminTranscript() ?? [],
    coordinatorTranscript: (team) => active?.view.coordinatorTranscript(team) ?? [],
    usage: () => active?.view.usage() ?? options.models.usage(),
    config: () => active?.view.config() ?? unconnectedConfig(),
  };

  const liveCommands = (): RuntimeCommands => {
    if (active === undefined) throw new Error(UNCONNECTED);
    return active.commands;
  };

  const stop = async (reason: string): Promise<void> => {
    const runtime = active;
    active = undefined;
    if (runtime !== undefined) await runtime.commands.stop(reason);
  };

  const setModel = async (selection: ModelSelection): Promise<void> => {
    await validateAndApplyModelSelection(options.models, selection);
    await options.onModelSelected?.(selection);
    if (selection.role === 'coordinator') coordinatorModels.set(selection.team, selection.model.trim());
    else if (selection.role === 'agent') agentModels.set(selection.agent, selection.model.trim());
    await active?.commands.setModel(selection);
  };

  const commands: RuntimeCommands = {
    async directorSay(text) { await liveCommands().directorSay(text); },
    async adminSay(text) { await liveCommands().adminSay(text); },
    async agentSay(agentId, text) { await liveCommands().agentSay(agentId, text); },
    async coordinatorSay(team, text) { await liveCommands().coordinatorSay(team, text); },
    async setAgentGoal(agentId, goal) { await liveCommands().setAgentGoal(agentId, goal); },
    pauseAgent(agentId, reason, pauseOptions) { liveCommands().pauseAgent(agentId, reason, pauseOptions); },
    resumeAgent(agentId) { liveCommands().resumeAgent(agentId); },
    async agentCommand(agentId, type, data) { return await liveCommands().agentCommand(agentId, type, data); },
    async spawnAgent(spec) { await liveCommands().spawnAgent(spec); },
    setModel,
    stop,
  };

  const runtimeDeps = (): HarnessRuntimeDeps => ({
    bus: options.bus,
    models: options.models,
    prompts: options.prompts,
    memoryFactory: options.memoryFactory,
    mindFactory: options.mindFactory,
    adminFactory: options.adminFactory,
    ...(options.hostedWorld === undefined ? {} : { hostedWorld: options.hostedWorld }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const activate = async (config: RunConfig): Promise<HarnessRuntime> => {
    await stop('switch world');
    const runtime = createRuntime(config, runtimeDeps());
    try {
      await runtime.start();
    } catch (error) {
      active = undefined;
      throw error;
    }
    active = runtime;
    void runtime.stopped.then(async () => {
      if (active !== runtime) return;
      active = undefined;
      await options.onStop();
    });
    return runtime;
  };

  const baseConfig = (): Omit<RunConfig, 'world'> => ({
    runId: `cockpit-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`,
    mcpUrl: options.mcpUrl,
    uiUrl: options.uiUrl,
    agents: [],
    headless: false,
    serve: false,
    keepAlive: true,
    logDir: options.logDir,
    dataDir: options.dataDir,
    channels: 'open',
  });

  return {
    view,
    commands,
    async connect(instance, connectOptions) {
      let hosted = false;
      try {
        const status = await options.hostedWorld?.status();
        hosted = status?.instanceId === instance.id;
      } catch {
        // Hosted-world discovery is optional; ordinary attachment remains available.
      }
      if (hosted) {
        await activate({
          ...baseConfig(),
          world: { kind: 'hosted', backendUrl: options.backendUrl },
        });
        return;
      }
      const httpUrl = `${options.backendUrl}/instances/${encodeURIComponent(instance.id)}`;
      await activate({
        ...baseConfig(),
        world: {
          kind: 'attach',
          instanceId: instance.id,
          httpUrl,
          wsUrl: websocketUrl(httpUrl),
          actors: [],
          ...(connectOptions?.defaultSpawn === undefined ? {} : { defaultSpawn: connectOptions.defaultSpawn }),
        },
      });
    },
    async spawnScenario(scenarioId) {
      const runtime = await activate({
        ...baseConfig(),
        world: { kind: 'scenario', name: scenarioId, seed: 1 },
      });
      const instanceId = runtime.view.instance?.id;
      if (instanceId !== undefined) return instanceId;
      await stop('scenario did not provision an instance');
      throw new Error(`scenario '${scenarioId}' started without a provisioned instance`);
    },
    current: () => active,
    stop,
  };
}
