import { describe, expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import type { AgentHandle, HarnessEventMap, MemoryStore, MindDeps, ModelConfig } from '../core/index.ts';
import { createCoordinator } from '../director/coordinator.ts';
import { createAgentMind } from '../mind/agentMind.ts';
import { assistantText, createMockProvider } from '../models/mock.ts';
import { createModelRegistry } from '../models/registry.ts';
import { createPromptLibrary } from '../prompts/index.ts';
import { createReflexEngine, FakeView, makeSnapshot } from '../reflex/index.ts';
import { createMailboxes } from './mailbox.ts';
import { withModelRequestContent } from './orchestrator.ts';

function memory(agentId: string): MemoryStore {
  return {
    agentId,
    async remember(input) {
      return { id: 1, agentId, kind: input.kind, text: input.text, tags: input.tags ?? [], importance: input.importance ?? 0.5, runId: 'run-privacy', createdAt: 0, recallCount: 0 };
    },
    async recall() { return []; }, async forget() { return false; }, async update() { return undefined; },
    async recent() { return []; }, async count() { return 0; }, close() {}
  };
}

function modelConfig(): ModelConfig {
  const spec = { provider: 'mock', model: 'privacy-model' };
  return { providers: { mock: { kind: 'mock' } }, roles: {
    director: spec, admin: spec, coordinator: spec, agent: spec, summarizer: spec
  } };
}

describe('model context privacy', () => {
  test('model request content is absent when tracing is disabled', async () => {
    const bus = createBus(); const mock = createMockProvider(); mock.enqueue(assistantText('ok'));
    const models = createModelRegistry(modelConfig(), { bus, providers: { mock } });
    const untraced = withModelRequestContent(models, bus, false);
    await untraced.models.chat('agent', { messages: [{ role: 'system', content: 'hidden by default' }] }, { agentId: 'alice' });
    const request = bus.history().find((event) => event.type === 'model.request');
    expect(request?.data).not.toHaveProperty('content');
  });

  test('agent contexts stay isolated while coordinator prompts intentionally expose member goals', async () => {
    const bus = createBus();
    const mock = createMockProvider();
    mock.respondWith(() => true, assistantText('ack'));
    const baseModels = createModelRegistry(modelConfig(), { bus, providers: { mock } });
    const traced = withModelRequestContent(baseModels, bus, true);
    const prompts = createPromptLibrary();
    const boxes = createMailboxes(bus);
    const requests: HarnessEventMap['model.request'][] = [];
    bus.on('model.request', (event) => { requests.push(event.data); });

    const identities = [
      { id: 'alice', persona: 'ALICE_PERSONA_ONLY', goal: 'ALICE_GOAL_ONLY' },
      { id: 'bob', persona: 'BOB_PERSONA_ONLY', goal: 'BOB_GOAL_ONLY' }
    ] as const;
    const minds = identities.map(({ id, persona, goal }) => {
      const view = new FakeView(makeSnapshot({ self: { tag: id, displayName: id } }), id);
      const deps: MindDeps = {
        agentId: id, spec: { id, persona }, view,
        sink: { async submit(intent) { return { intent, ok: true, tick: 0, sentAt: 0 }; } },
        commandTypes: [],
        reflexes: createReflexEngine({ agentId: id, bus }), memory: memory(id), models: traced.models,
        prompts, bus, mailbox: boxes.forRecipient(id, id), worldContext: {}, worldReads: { async scan() { return []; } },
        wake: { minIntervalMs: 0, heartbeatMs: 60_000, hpAlertFraction: 0.5, maxTurns: 1, maxToolCallsPerWake: 2 },
        context: { maxPromptTokens: 20_000, compactAtTokens: 18_000, keepTurns: 2, recallLimit: 0 },
        onFinished() {}, setState() {}
      };
      return { id, goal, mind: createAgentMind(deps), view };
    });

    for (const entry of minds) await entry.mind.setGoal(entry.goal, 'operator');
    const aliceRequests = requests.filter((request) => request.role === 'agent' && request.agentId === 'alice');
    const bobRequests = requests.filter((request) => request.role === 'agent' && request.agentId === 'bob');
    expect(aliceRequests.length).toBeGreaterThanOrEqual(1);
    expect(bobRequests.length).toBeGreaterThanOrEqual(1);
    const aliceText = JSON.stringify(aliceRequests.map((request) => request.content));
    const bobText = JSON.stringify(bobRequests.map((request) => request.content));
    expect(aliceText).toContain('ALICE_PERSONA_ONLY');
    expect(aliceText).toContain('ALICE_GOAL_ONLY');
    expect(aliceText).not.toContain('BOB_PERSONA_ONLY');
    expect(aliceText).not.toContain('BOB_GOAL_ONLY');
    expect(bobText).toContain('BOB_PERSONA_ONLY');
    expect(bobText).toContain('BOB_GOAL_ONLY');
    expect(bobText).not.toContain('ALICE_PERSONA_ONLY');
    expect(bobText).not.toContain('ALICE_GOAL_ONLY');

    const handles = identities.map(({ id, persona, goal }, index) => ({
      id, spec: { id, team: 'red', persona, goal }, tag: id, entity: index + 1, team: 'red', state: 'idle', goal,
      view: minds[index]!.view, reflexes: createReflexEngine({ agentId: id }), mind: minds[index]!.mind,
      memory: memory(id), mailbox: boxes.forRecipient(id, id), async setGoal() {}, pause() {}, resume() {},
      summary: () => `${id}: idle; goal ${goal}`
    })) as unknown as AgentHandle[];
    const coordinator = createCoordinator({ id: 'red', mission: 'coordinate', agents: ['alice', 'bob'] }, {
      agents: () => handles, models: traced.models, prompts, bus, mailboxes: boxes
    });
    for (let index = 0; index < 100 && !requests.some((request) => request.role === 'coordinator'); index++) await Bun.sleep(1);
    const coordinatorText = JSON.stringify(requests.find((request) => request.role === 'coordinator')?.content);
    expect(coordinatorText).toContain('ALICE_GOAL_ONLY');
    expect(coordinatorText).toContain('BOB_GOAL_ONLY');
    expect(coordinatorText).not.toContain('ALICE_PERSONA_ONLY');
    expect(coordinatorText).not.toContain('BOB_PERSONA_ONLY');

    coordinator.dispose();
    await Promise.all(minds.map((entry) => entry.mind.dispose()));
    traced.dispose();
  });
});
