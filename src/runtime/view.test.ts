import { describe, expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import type { ModelConfig, ModelProvider, RunConfig } from '../core/index.ts';
import { createMockProvider } from '../models/mock.ts';
import { createModelRegistry } from '../models/registry.ts';
import type { AgentRuntime } from './agentRuntime.ts';
import { createRuntimeSurface, type RuntimeSurfaceState, type RuntimeTeamRecord } from './view.ts';

function modelConfig(): ModelConfig {
  const spec = { provider: 'mock', model: 'base-model' };
  return {
    providers: { mock: { kind: 'mock' } },
    roles: { director: spec, admin: spec, coordinator: spec, agent: spec, summarizer: spec }
  };
}

function runConfig(): RunConfig {
  return {
    runId: 'run-view', mcpUrl: 'http://mcp.test', uiUrl: 'http://ui.test',
    world: { kind: 'resume', worldId: 'world-1' }, agents: [{ id: 'alice' }],
    headless: false, logDir: './runs', dataDir: './data'
  };
}

function setup() {
  const provider: ModelProvider = {
    ...createMockProvider({ id: 'mock' }),
    async listModels() { return ['base-model', 'director-model', 'alice-model', 'red-model']; }
  };
  const models = createModelRegistry(modelConfig(), {
    bus: createBus(), providers: { mock: provider }
  });
  const agents = [{ id: 'alice' }] as unknown as readonly AgentRuntime[];
  const teams: readonly RuntimeTeamRecord[] = [{
    id: 'red', mission: 'test the runtime surface', agents: ['alice']
  }];
  const state: RuntimeSurfaceState = {
    config: runConfig(), startedAt: 100, models,
    agents: () => agents, teams: () => teams,
    director: () => undefined, admin: () => undefined, world: () => undefined,
    watchUrl: () => undefined,
    async spawnAgent() {}, async removeAgent() { return { removed: false }; },
    async createTeam() {}, async stop() {}, async directorSay() {}, async adminSay() {},
    async coordinatorSay() {}, async agentSay() {}
  };
  return { models, ...createRuntimeSurface(state) };
}

describe('runtime surface model selection', () => {
  test('validates and applies director models and rejects unknown agent ids', async () => {
    const { commands, models } = setup();

    await commands.setModel({ role: 'director', model: 'director-model' });
    expect(models.resolve('director').model).toBe('director-model');

    await expect(commands.setModel({
      role: 'agent', agent: 'missing', model: 'alice-model'
    })).rejects.toThrow("Unknown agent 'missing'");
    expect(models.resolve('agent', 'missing').model).toBe('base-model');
  });

  test('reports role defaults and target-specific models in config', () => {
    const { models, view } = setup();
    models.setOverride('alice', 'agent', { model: 'alice-model' });
    models.setOverride('red', 'coordinator', { model: 'red-model' });

    expect(view.config()).toMatchObject({
      models: {
        director: 'base-model',
        admin: 'base-model',
        agentDefault: 'base-model',
        coordinators: { red: 'red-model' },
        agents: { alice: 'alice-model' }
      }
    });
  });
});
