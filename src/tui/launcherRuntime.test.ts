import { expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import type { ModelProvider } from '../core/model.ts';
import type { LiveRuntimeCommands, RunConfig, RuntimeView } from '../core/runtime.ts';
import { loadModelConfig } from '../models/config.ts';
import { createMockProvider } from '../models/mock.ts';
import { createModelRegistry } from '../models/registry.ts';
import type { HarnessRuntime, HarnessRuntimeDeps } from '../runtime/orchestrator.ts';
import { createCockpitLauncher, type CockpitLauncherOptions } from './launcherRuntime.ts';

const NOW = Date.UTC(2026, 8, 2, 12, 34, 56, 789);

function instance(id: string, kind = 'sandbox') {
  return { id, kind, tick: 9, state: 'running', entityCount: 2, realtime: true, pvp: false };
}

function harness() {
  const bus = createBus();
  const config = loadModelConfig(undefined, {
    ROUTER_API_BASE: 'http://router.example/v1',
    ROUTER_MODEL: 'initial/model',
    RUNESCHOOL_API_BACKEND: 'http://game.example',
  });
  const router: ModelProvider = {
    ...createMockProvider({ id: 'router' }),
    async listModels() {
      return ['initial/model', 'saved-director', 'saved-agent', 'openai/director-model'];
    },
  };
  const models = createModelRegistry(config, { bus, env: {}, providers: { router } });
  const configs: RunConfig[] = [];
  const runtimes: Array<{
    runtime: HarnessRuntime;
    directorMessages: string[];
    modelSelections: unknown[];
    stopReasons: string[];
  }> = [];

  const createRuntime = (runConfig: RunConfig, _deps: HarnessRuntimeDeps): HarnessRuntime => {
    configs.push(runConfig);
    const directorMessages: string[] = [];
    const modelSelections: unknown[] = [];
    const stopReasons: string[] = [];
    let resolveStopped!: (result: { readonly reason: string }) => void;
    const stopped = new Promise<{ readonly reason: string }>((resolve) => { resolveStopped = resolve; });
    const provisionedId = runConfig.world.kind === 'scenario'
      ? `scenario-${runConfig.world.name}`
      : runConfig.world.kind === 'attach'
        ? runConfig.world.instanceId
        : 'other';
    const view: RuntimeView = {
      runId: runConfig.runId,
      startedAt: NOW,
      instance: {
        id: provisionedId,
        httpUrl: `http://game.example/instances/${provisionedId}`,
        watchUrl: `http://ui.example/#/runs/${provisionedId}`,
        kind: runConfig.world.kind,
        tick: 42,
      },
      agents: () => [],
      teams: () => [],
      agentSnapshot: () => undefined,
      agentReflexes: () => undefined,
      agentTranscript: () => [],
      directorTranscript: () => [{ role: 'assistant', content: 'live' }],
      adminTranscript: () => [],
      coordinatorTranscript: () => [],
      usage: () => [],
      config: () => ({ live: true, world: runConfig.world.kind }),
    };
    const commands: LiveRuntimeCommands = {
      async directorSay(text) { directorMessages.push(text); },
      async adminSay() {},
      async agentSay() {},
      async coordinatorSay() {},
      async setAgentGoal() {},
      pauseAgent() {},
      resumeAgent() {},
      async agentCommand() { return { ok: true }; },
      async spawnAgent() {},
      async removeAgent() { return { removed: true }; },
      setModel(selection) { modelSelections.push(selection); },
      setAgentModel() {},
      async createTeam() {},
      async stop(reason) {
        stopReasons.push(reason);
        resolveStopped({ reason });
      },
    };
    const runtime: HarnessRuntime = {
      view,
      commands,
      async start() {},
      stopped,
      agents: () => [],
    };
    runtimes.push({ runtime, directorMessages, modelSelections, stopReasons });
    return runtime;
  };

  const saved: string[] = [];
  const options: CockpitLauncherOptions = {
    backendUrl: 'https://game.example/api',
    mcpUrl: 'https://game.example/api/mcp',
    uiUrl: 'https://ui.example',
    bus,
    models,
    prompts: {
      get() { return ''; },
      render() { return ''; },
      list() { return []; },
    },
    memoryFactory: { open() { throw new Error('not used'); } },
    mindFactory() { throw new Error('not used'); },
    adminFactory() { throw new Error('not used'); },
    logDir: '/tmp/cockpit-runs',
    dataDir: '/tmp/cockpit-data',
    now: () => NOW,
    createRuntime,
    onModelSelected(selection) { saved.push(`${selection.role}:${selection.model}`); },
    onStop() {},
  };
  return { configs, models, options, runtimes, saved };
}

test('launcher exposes an unconnected view and rejects live commands before a world is selected', async () => {
  const setup = harness();
  const launcher = createCockpitLauncher({
    ...setup.options,
    initialModelSelections: [
      { role: 'director', model: 'saved-director' },
      { role: 'agent-default', model: 'saved-agent' },
      { role: 'agent', agent: 'scout', model: 'saved-agent' },
    ],
  });

  expect(launcher.view.runId).toBe(`cockpit-${process.pid}`);
  expect(launcher.view.instance).toBeUndefined();
  expect(launcher.view.agents()).toEqual([]);
  expect(launcher.view.config()).toEqual({
    backend: 'https://game.example/api',
    mcpUrl: 'https://game.example/api/mcp',
    mode: 'cockpit',
    models: {
      director: 'saved-director',
      admin: 'initial/model',
      agentDefault: 'saved-agent',
      coordinators: {},
      agents: { scout: 'saved-agent' },
    },
  });
  await expect(launcher.commands.directorSay('hello')).rejects.toThrow(
    'connect to a RuneSchool instance from the World tab first',
  );
  expect(() => launcher.commands.pauseAgent('scout')).toThrow(
    'connect to a RuneSchool instance from the World tab first',
  );
});

test('connect builds an attach config and delegates through the stable runtime surface', async () => {
  const setup = harness();
  const launcher = createCockpitLauncher(setup.options);
  const stableView = launcher.view;
  const stableCommands = launcher.commands;

  await launcher.connect(instance('inst/a'));

  expect(launcher.view).toBe(stableView);
  expect(launcher.commands).toBe(stableCommands);
  expect(setup.configs[0]).toEqual({
    runId: 'cockpit-2026-09-02T12-34-56-789Z',
    mcpUrl: 'https://game.example/api/mcp',
    uiUrl: 'https://ui.example',
    world: {
      kind: 'attach',
      instanceId: 'inst/a',
      httpUrl: 'https://game.example/api/instances/inst%2Fa',
      wsUrl: 'wss://game.example/api/instances/inst%2Fa/stream',
      actors: [],
    },
    agents: [],
    headless: false,
    serve: false,
    keepAlive: true,
    logDir: '/tmp/cockpit-runs',
    dataDir: '/tmp/cockpit-data',
    channels: 'open',
  });
  expect(launcher.current()).toBe(setup.runtimes[0]?.runtime);
  expect(launcher.view.instance?.id).toBe('inst/a');
  expect(launcher.view.directorTranscript()).toEqual([{ role: 'assistant', content: 'live' }]);
  expect(launcher.view.config()).toEqual({ live: true, world: 'attach' });
  await launcher.commands.directorSay('hello live runtime');
  expect(setup.runtimes[0]?.directorMessages).toEqual(['hello live runtime']);
});

test('scenario provisioning and sandbox attachment carry the intended configs and stop the prior runtime', async () => {
  const setup = harness();
  const launcher = createCockpitLauncher(setup.options);

  await launcher.connect(instance('first'));
  expect(await launcher.spawnScenario('goblin-ambush')).toBe('scenario-goblin-ambush');
  expect(setup.runtimes[0]?.stopReasons).toEqual(['switch world']);
  expect(setup.configs[1]?.world).toEqual({ kind: 'scenario', name: 'goblin-ambush', seed: 1 });

  const defaultSpawn = { x: 3210, z: 3420, level: 0 };
  await launcher.connect(instance('sandbox-created'), { defaultSpawn });
  expect(setup.runtimes[1]?.stopReasons).toEqual(['switch world']);
  expect(setup.configs[2]?.world).toEqual({
    kind: 'attach',
    instanceId: 'sandbox-created',
    httpUrl: 'https://game.example/api/instances/sandbox-created',
    wsUrl: 'wss://game.example/api/instances/sandbox-created/stream',
    actors: [],
    defaultSpawn,
  });
});

test('model selection is validated, persisted, and forwarded to a live runtime', async () => {
  const setup = harness();
  const launcher = createCockpitLauncher(setup.options);

  await launcher.commands.setModel?.({ role: 'director', model: 'openai/director-model' });
  expect(setup.saved).toEqual(['director:openai/director-model']);
  expect(launcher.view.config()).toMatchObject({ models: { director: 'openai/director-model' } });

  await launcher.connect(instance('model-world'));
  await launcher.commands.setModel?.({ role: 'director', model: 'saved-director' });
  expect(setup.runtimes[0]?.modelSelections).toEqual([{ role: 'director', model: 'saved-director' }]);
  await expect(launcher.commands.setModel?.({ role: 'director', model: 'missing/model' }))
    .rejects.toThrow("model 'missing/model' is not available from provider 'router'");
  expect(setup.saved).toEqual(['director:openai/director-model', 'director:saved-director']);
});

test('stop clears the live runtime and returns the launcher to its unconnected state', async () => {
  const setup = harness();
  const launcher = createCockpitLauncher(setup.options);
  await launcher.connect(instance('stop-world'));

  await launcher.stop('operator');

  expect(setup.runtimes[0]?.stopReasons).toEqual(['operator']);
  expect(launcher.current()).toBeUndefined();
  expect(launcher.view.instance).toBeUndefined();
  await expect(launcher.commands.spawnAgent({ id: 'hero' })).rejects.toThrow(
    'connect to a RuneSchool instance from the World tab first',
  );
});
