import { describe, expect, test } from 'bun:test';
import type { AgentHandle, MemoryStore, ModelConfig } from '../core/index.ts';
import { createBus } from '../bus/index.ts';
import { assistantText, assistantToolCall, createMockProvider, createModelRegistry } from '../models/index.ts';
import { createPromptLibrary } from '../prompts/index.ts';
import { FakeView } from '../reflex/testing.ts';
import { createMailboxes } from '../runtime/mailbox.ts';
import { createCoordinator } from './coordinator.ts';

describe('coordinator', () => {
  test('initial mission assigns a goal and reports to the director', async () => {
    const bus = createBus(); const mock = createMockProvider();
    mock.enqueue(assistantToolCall('assign_goal', { agent: 'hero', goal: 'walk east' }, 'a'));
    mock.enqueue(assistantToolCall('report_to_director', { text: 'assigned' }, 'b'));
    mock.enqueue(assistantText('done'));
    const spec = { provider: 'mock', model: 'm' };
    const config: ModelConfig = { providers: { mock: { kind: 'mock' } }, roles: { director: spec, coordinator: spec, agent: spec, summarizer: spec, admin: spec } };
    const models = createModelRegistry(config, { bus, providers: { mock } });
    const goals: string[] = [];
    const agent = {
      id: 'hero', spec: { id: 'hero', team: 'red' }, tag: 'hero', entity: 1, team: 'red', state: 'idle',
      view: new FakeView(), reflexes: { state: () => ({ rules: [], queue: [] }) },
      mind: {}, memory: {} as MemoryStore, mailbox: {}, goal: undefined,
      async setGoal(goal: string) { goals.push(goal); }, pause() {}, resume() {}, summary: () => 'hero: idle'
    } as unknown as AgentHandle;
    const boxes = createMailboxes(bus);
    const coordinator = createCoordinator({ id: 'red', mission: 'advance', agents: ['hero'] }, {
      agents: () => [agent], models, prompts: createPromptLibrary(), bus, mailboxes: boxes
    });
    for (let index = 0; index < 100 && bus.history({ prefix: 'team.report' }).length === 0; index++) await Bun.sleep(1);
    expect(goals).toEqual(['walk east']);
    expect(bus.history({ prefix: 'team.report' })[0]?.data).toEqual({ teamId: 'red', text: 'assigned' });
    expect(boxes.drain('director')[0]?.text).toBe('assigned');
    coordinator.dispose();
  });
});
