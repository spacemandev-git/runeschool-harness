import { expect, test } from 'bun:test';
import { createBus } from '../../bus/index.ts';
import { createFakeRuntime } from './fakeRuntime.ts';

test('fake runtime is deterministic for a seed', async () => {
  const first = createFakeRuntime(createBus(), { seed: 42 });
  const second = createFakeRuntime(createBus(), { seed: 42 });
  first.start();
  second.start();
  await Bun.sleep(650);
  first.stop();
  second.stop();
  expect(first.view.agents()).toEqual(second.view.agents());
  expect(first.view.agentSnapshot('hero')).toEqual(second.view.agentSnapshot('hero'));
});

test('pauseAgent is reflected in agents()', () => {
  const fake = createFakeRuntime(createBus(), { seed: 1 });
  fake.commands.pauseAgent('hero');
  expect(fake.view.agents().find((agent) => agent.id === 'hero')?.state).toBe('paused');
});

test('model selections are reflected in runtime views', async () => {
  const fake = createFakeRuntime(createBus(), { seed: 1 });
  await fake.commands.setModel?.({ role: 'director', model: 'director-two' });
  await fake.commands.setModel?.({ role: 'coordinator', team: 'alpha', model: 'coordinator-two' });
  await fake.commands.setModel?.({ role: 'agent', agent: 'hero', model: 'agent-two' });

  expect(fake.view.config()).toMatchObject({
    models: { director: 'director-two', coordinators: { alpha: 'coordinator-two' } }
  });
  expect(fake.view.teams()[0]?.coordinatorModel).toBe('coordinator-two');
  expect(fake.view.agents().find((agent) => agent.id === 'hero')?.model).toBe('agent-two');
});
