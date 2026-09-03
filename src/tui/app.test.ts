import { expect, test } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createBus } from '../bus/index.ts';
import { createCockpit } from './app.ts';
import { HELP_TEXT } from './keymap.ts';
import { createFakeRuntime } from './fake/fakeRuntime.ts';

process.env.XDG_DATA_HOME = '/tmp/opentui-cockpit-tests';

test('cockpit mounts, navigates, submits, commands, stops, and resizes', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const bus = createBus();
  const fake = createFakeRuntime(bus, { seed: 1 });
  let directorCalls = 0;
  let adminCalls = 0;
  let stopCalls = 0;
  const commands = {
    ...fake.commands,
    async directorSay(text: string) { directorCalls += 1; await fake.commands.directorSay(text); },
    async adminSay(text: string) { adminCalls += 1; await fake.commands.adminSay(text); },
    async stop(reason: string) { stopCalls += 1; await fake.commands.stop(reason); },
  };
  const cockpit = createCockpit({ view: fake.view, commands, bus, renderer: setup.renderer, refreshMs: 20 });
  fake.start();
  const running = cockpit.start();
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain('run run-fake-1 · inst inst-fake');

  setup.mockInput.pressTab({ shift: true });
  setup.mockInput.pressKey('3');
  await setup.waitForFrame((frame) => frame.includes('hp [meter]'));
  expect(setup.captureCharFrame()).toContain('hero');

  setup.mockInput.pressKey('4');
  await setup.waitForFrame((frame) => frame.includes('percept · hero'));
  expect(setup.captureCharFrame()).toContain('Hero · hero');

  cockpit.selectTab('Director');
  setup.mockInput.pressTab();
  await setup.mockInput.typeText('hello cockpit');
  setup.mockInput.pressEnter();
  await Bun.sleep(350);
  await setup.waitForFrame((frame) => frame.includes('Director echo: hello cockpit'));
  expect(directorCalls).toBe(1);

  cockpit.selectTab('Admin');
  await setup.mockInput.typeText('spawn two goblins');
  setup.mockInput.pressEnter();
  await Bun.sleep(350);
  await setup.waitForFrame((frame) => frame.includes('Admin echo: spawn two goblins'));
  expect(adminCalls).toBe(1);

  cockpit.selectTab('Agents');
  await setup.mockInput.typeText('/pause hero');
  setup.mockInput.pressEnter();
  await Bun.sleep(30);
  expect(fake.view.agents().find((agent) => agent.id === 'hero')?.state).toBe('paused');
  await setup.waitForFrame((frame) => frame.includes('paused'));

  await setup.mockInput.typeText('/model director openai/director-model');
  setup.mockInput.pressEnter();
  await setup.mockInput.typeText('/model coordinator alpha openai/coordinator-model');
  setup.mockInput.pressEnter();
  await setup.mockInput.typeText('/model agent hero openai/agent-model');
  setup.mockInput.pressEnter();
  await Bun.sleep(30);
  expect(fake.view.config()).toMatchObject({
    models: {
      director: 'openai/director-model',
      coordinators: { alpha: 'openai/coordinator-model' }
    }
  });
  expect(fake.view.teams()[0]?.coordinatorModel).toBe('openai/coordinator-model');
  expect(fake.view.agents().find((agent) => agent.id === 'hero')?.model).toBe('openai/agent-model');

  await setup.mockInput.typeText('/admin heal hero');
  setup.mockInput.pressEnter();
  await Bun.sleep(350);
  expect(adminCalls).toBe(2);
  cockpit.selectTab('Admin');
  await setup.waitForFrame((frame) => frame.includes('Admin echo: heal hero'));

  setup.resize(80, 24);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain('RuneSchool cockpit');

  setup.mockInput.pressCtrlC();
  setup.mockInput.pressCtrlC();
  await Bun.sleep(20);
  expect(stopCalls).toBe(1);
  await running;
  fake.stop();
});

test('every tab renders at compact dimensions', async () => {
  for (const [width, height] of [[120, 40], [80, 24]] as const) {
    const setup = await createTestRenderer({ width, height });
    const bus = createBus();
    const fake = createFakeRuntime(bus, { seed: 3 });
    const cockpit = createCockpit({ view: fake.view, commands: fake.commands, bus, renderer: setup.renderer });
    const running = cockpit.start();
    for (const name of ['Director', 'Admin', 'Agents', 'Agent', 'World', 'Trace', 'Help']) {
      cockpit.selectTab(name);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain('RuneSchool cockpit');
    }
    await cockpit.stop();
    await running;
  }
});

test('q twice and /quit stop an owning cockpit', async () => {
  for (const useQuitCommand of [false, true]) {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const bus = createBus();
    const fake = createFakeRuntime(bus);
    let stopCalls = 0;
    const commands = { ...fake.commands, async stop(reason: string) { stopCalls += 1; await fake.commands.stop(reason); } };
    const cockpit = createCockpit({ view: fake.view, commands, bus, renderer: setup.renderer });
    const running = cockpit.start();
    if (useQuitCommand) {
      await setup.mockInput.typeText('/quit');
      setup.mockInput.pressEnter();
    } else {
      setup.mockInput.pressTab({ shift: true });
      setup.mockInput.pressKey('q');
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain('press q again within 2s to stop the run and exit');
      setup.mockInput.pressKey('q');
    }
    await Bun.sleep(30);
    expect(stopCalls).toBe(1);
    await running;
  }
});

test('attached q and /detach detach without stopping the run', async () => {
  for (const useDetachCommand of [false, true]) {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const bus = createBus();
    const fake = createFakeRuntime(bus);
    let stopCalls = 0;
    let detachCalls = 0;
    const commands = { ...fake.commands, async stop(reason: string) { stopCalls += 1; await fake.commands.stop(reason); } };
    const cockpit = createCockpit({ view: fake.view, commands, bus, renderer: setup.renderer, attached: true, onDetach: () => { detachCalls += 1; } });
    const running = cockpit.start();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('attached');
    if (useDetachCommand) {
      await setup.mockInput.typeText('/detach');
      setup.mockInput.pressEnter();
    } else {
      setup.mockInput.pressTab({ shift: true });
      setup.mockInput.pressKey('q');
    }
    await Bun.sleep(30);
    expect(detachCalls).toBe(1);
    expect(stopCalls).toBe(0);
    await running;
    fake.stop();
  }
});

test('help text lists lifecycle and model-selection commands', () => {
  expect(HELP_TEXT).toContain('q');
  expect(HELP_TEXT).toContain('/quit');
  expect(HELP_TEXT).toContain('/detach');
  expect(HELP_TEXT).toContain('/model director <model>');
  expect(HELP_TEXT).toContain('/model coordinator <team> <model>');
  expect(HELP_TEXT).toContain('/model agent <agent> <model>');
});
