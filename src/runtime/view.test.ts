import { describe, expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import type { ModelConfig, ModelProvider, RecordingSummary, RunConfig } from '../core/index.ts';
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
    headless: false, logDir: './runs', dataDir: './data',
    recording: {
      resolution: { width: 1920, height: 1080 }, targets: [{ kind: 'overview' }],
    },
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
  const recordings: RecordingSummary[] = [{
    id: 'overview', target: { kind: 'overview' }, resolution: { width: 1920, height: 1080 },
    state: 'recording', startedAt: 101,
  }];
  const recordingCalls: string[] = [];
  const state: RuntimeSurfaceState = {
    config: runConfig(), startedAt: 100, models,
    agents: () => agents, teams: () => teams,
    director: () => undefined, admin: () => undefined, world: () => undefined,
    watchUrl: () => undefined,
    async spawnAgent() {}, async removeAgent() { return { removed: false }; },
    async createTeam() {}, async stop() {}, async directorSay() {}, async adminSay() {},
    async coordinatorSay() {}, async agentSay() {},
    recordings: () => recordings,
    async startRecording(request) { recordingCalls.push(`start:${request.resolution.width}`); return recordings; },
    async stopRecording(id) { recordingCalls.push(`stop:${id ?? 'all'}`); return recordings; },
  };
  return { models, recordings, recordingCalls, ...createRuntimeSurface(state) };
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
      recording: {
        resolution: { width: 1920, height: 1080 }, targets: [{ kind: 'overview' }],
      },
      models: {
        director: 'base-model',
        admin: 'base-model',
        agentDefault: 'base-model',
        coordinators: { red: 'red-model' },
        agents: { alice: 'alice-model' }
      }
    });
  });

  test('exposes recording summaries and delegates recording commands', async () => {
    const { commands, recordingCalls, recordings, view } = setup();

    expect(view.recordings?.()).toEqual(recordings);
    expect(await commands.startRecording({
      resolution: { width: 1920, height: 1080 }, targets: [{ kind: 'overview' }],
    })).toEqual(recordings);
    expect(await commands.stopRecording('overview')).toEqual(recordings);
    expect(recordingCalls).toEqual(['start:1920', 'stop:overview']);
  });
});
