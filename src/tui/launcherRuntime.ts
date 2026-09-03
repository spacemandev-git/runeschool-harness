import type { ModelRegistry } from '../core/model.ts';
import type { ModelSelection, RuntimeCommands, RuntimeView } from '../core/runtime.ts';
import { applyModelSelection, validateAndApplyModelSelection } from '../models/selection.ts';
import type { BackendInstanceSummary } from './worldDirectory.ts';

export interface WorldBrowserRuntime {
  readonly view: RuntimeView;
  readonly commands: RuntimeCommands;
  connect(instance: BackendInstanceSummary): void;
}

export function createWorldBrowserRuntime(options: {
  readonly backendUrl: string;
  readonly models: ModelRegistry;
  readonly onStop: () => void | Promise<void>;
  readonly onModelSelected?: (selection: ModelSelection) => void | Promise<void>;
  readonly initialModelSelections?: readonly ModelSelection[];
  readonly now?: () => number;
  readonly pid?: number;
}): WorldBrowserRuntime {
  const startedAt = (options.now ?? Date.now)();
  const pid = options.pid ?? process.pid;
  let activeInstance: BackendInstanceSummary | undefined;
  const coordinatorModels = new Map<string, string>();
  const agentModels = new Map<string, string>();
  for (const selection of options.initialModelSelections ?? []) {
    applyModelSelection(options.models, selection);
    if (selection.role === 'coordinator') coordinatorModels.set(selection.team, selection.model.trim());
    else if (selection.role === 'agent') agentModels.set(selection.agent, selection.model.trim());
  }

  const unavailable = async (): Promise<never> => {
    throw new Error(activeInstance === undefined
      ? 'connect to a RuneSchool instance from the World tab first'
      : 'the selected backend instance is not an attached harness runtime');
  };

  const view: RuntimeView = {
    runId: `cockpit-${pid}`,
    startedAt,
    get instance() {
      const instance = activeInstance;
      if (instance === undefined) return undefined;
      return {
        id: instance.id,
        httpUrl: `${options.backendUrl}/instances/${encodeURIComponent(instance.id)}`,
        kind: instance.kind,
        tick: instance.tick,
      };
    },
    agents: () => [],
    teams: () => [],
    agentSnapshot: () => undefined,
    agentReflexes: () => undefined,
    agentTranscript: () => [],
    directorTranscript: () => [],
    adminTranscript: () => [],
    coordinatorTranscript: () => [],
    usage: () => options.models.usage(),
    config: () => ({
      backend: options.backendUrl,
      mode: 'world-browser',
      models: {
        director: options.models.resolve('director').model,
        admin: options.models.resolve('admin').model,
        agentDefault: options.models.resolve('agent').model,
        coordinators: Object.fromEntries(coordinatorModels),
        agents: Object.fromEntries(agentModels),
      },
    }),
  };

  const setModel = async (selection: ModelSelection): Promise<void> => {
    await validateAndApplyModelSelection(options.models, selection);
    await options.onModelSelected?.(selection);
    if (selection.role === 'coordinator') coordinatorModels.set(selection.team, selection.model.trim());
    else if (selection.role === 'agent') agentModels.set(selection.agent, selection.model.trim());
  };

  const commands: RuntimeCommands = {
    directorSay: unavailable,
    adminSay: unavailable,
    agentSay: unavailable,
    coordinatorSay: unavailable,
    setAgentGoal: unavailable,
    pauseAgent() { throw new Error('no harness agent is connected'); },
    resumeAgent() { throw new Error('no harness agent is connected'); },
    agentCommand: unavailable,
    spawnAgent: unavailable,
    setModel,
    async stop() { await options.onStop(); },
  };

  return {
    view,
    commands,
    connect(instance) { activeInstance = instance; },
  };
}
