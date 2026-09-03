import { expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import type { ModelProvider } from '../core/model.ts';
import { loadModelConfig } from '../models/config.ts';
import { createMockProvider } from '../models/mock.ts';
import { createModelRegistry } from '../models/registry.ts';
import { createWorldBrowserRuntime } from './launcherRuntime.ts';

test('world-browser runtime accepts and displays director model selections', async () => {
  const bus = createBus();
  const config = loadModelConfig(undefined, {
    ROUTER_API_BASE: 'http://router.example/v1',
    ROUTER_MODEL: 'initial/model',
    RUNESCHOOL_API_BACKEND: 'http://game.example',
  });
  const router: ModelProvider = {
    ...createMockProvider({ id: 'router' }),
    async listModels() { return ['initial/model', 'openai/director-model', 'openai/agent-default']; },
  };
  const models = createModelRegistry(config, { bus, env: {}, providers: { router } });
  let stopped = false;
  const saved: string[] = [];
  const runtime = createWorldBrowserRuntime({
    backendUrl: 'http://game.example', models, pid: 123, now: () => 456,
    onModelSelected(selection) { saved.push(`${selection.role}:${selection.model}`); },
    onStop() { stopped = true; },
  });

  expect(runtime.view.config()).toMatchObject({
    models: { director: 'initial/model', admin: 'initial/model', agentDefault: 'initial/model' }
  });
  await runtime.commands.setModel?.({ role: 'director', model: 'openai/director-model' });
  await runtime.commands.setModel?.({ role: 'agent-default', model: 'openai/agent-default' });
  expect(runtime.view.config()).toMatchObject({
    models: { director: 'openai/director-model', agentDefault: 'openai/agent-default' }
  });
  await expect(runtime.commands.setModel?.({ role: 'director', model: 'made-up/model' }))
    .rejects.toThrow("model 'made-up/model' is not available from provider 'router'");
  expect(runtime.view.config()).toMatchObject({ models: { director: 'openai/director-model' } });
  expect(saved).toEqual([
    'director:openai/director-model',
    'agent-default:openai/agent-default',
  ]);

  runtime.connect({
    id: 'inst-1', tick: 9, state: 'running', entityCount: 2,
    realtime: true, kind: 'sandbox', pvp: false,
  });
  expect(runtime.view.instance?.id).toBe('inst-1');
  await expect(runtime.commands.directorSay('hello')).rejects.toThrow('not an attached harness runtime');
  await runtime.commands.stop('test');
  expect(stopped).toBe(true);
});

test('world-browser runtime restores persisted model selections', () => {
  const bus = createBus();
  const config = loadModelConfig(undefined, {
    ROUTER_API_BASE: 'http://router.example/v1',
    ROUTER_MODEL: 'initial/model',
  });
  const models = createModelRegistry(config, { bus, env: {} });
  const runtime = createWorldBrowserRuntime({
    backendUrl: 'http://game.example', models,
    initialModelSelections: [
      { role: 'director', model: 'saved-director' },
      { role: 'agent-default', model: 'saved-agent-default' },
      { role: 'agent', agent: 'scout', model: 'saved-scout' },
    ],
    onStop() {},
  });

  expect(runtime.view.config()).toMatchObject({
    models: {
      director: 'saved-director',
      agentDefault: 'saved-agent-default',
      agents: { scout: 'saved-scout' },
    },
  });
  expect(models.resolve('agent', 'new-agent').model).toBe('saved-agent-default');
  expect(models.resolve('agent', 'scout').model).toBe('saved-scout');
});
