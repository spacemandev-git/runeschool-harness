import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../bus/index.ts';
import { CONTROL_COMMAND_METHODS } from '../core/control.ts';
import type { ModelSelection, RuntimeView } from '../core/runtime.ts';
import { createFakeRuntime } from '../tui/fake/fakeRuntime.ts';
import { connectControl } from './client.ts';
import { createControlServer } from './server.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-control-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitFor(assertion: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for control state');
    await Bun.sleep(10);
  }
}

describe('control server and client', () => {
  test('replays and streams events, caches views, round-trips commands, and redacts secrets', async () => {
    const logDir = await temporaryDirectory();
    const serverBus = createBus();
    const fake = createFakeRuntime(serverBus, { seed: 7 });
    const view: RuntimeView = {
      ...fake.view,
      config: () => ({ fake: true, token: 'super-secret-token', nested: { api_key: 'another-secret' } }),
    };
    const controlCalls: string[] = [];
    const commands = {
      ...fake.commands,
      async removeAgent(agentId: string) { controlCalls.push(`remove:${agentId}`); return { removed: true }; },
      setModel(selection: ModelSelection) {
        controlCalls.push(`selection:${selection.role}:${selection.model}`);
      },
      setAgentModel(agentId: string, role: string, spec: { model?: string }) {
        controlCalls.push(`model:${agentId}:${role}:${spec.model ?? ''}`);
      },
      async createTeam(id: string) { controlCalls.push(`team:${id}`); }
    };
    serverBus.emit('log', { level: 'info', scope: 'test', message: 'retained history' });
    const server = await createControlServer({
      runId: fake.view.runId,
      logDir,
      mcpUrl: 'http://127.0.0.1:7780/mcp?token=url-secret',
      view,
      commands,
      bus: serverBus,
    });

    try {
      expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
      const client = await connectControl(server.descriptor, { pollMs: 30 });
      try {
        expect(client.view.runId).toBe(fake.view.runId);
        expect(client.view.startedAt).toBe(fake.view.startedAt);
        expect(client.view.instance).toEqual(fake.view.instance);
        expect(client.view.agents()).toEqual(fake.view.agents());
        expect(client.view.teams()).toEqual(fake.view.teams());
        expect(client.view.usage()).toEqual(fake.view.usage());
        expect(client.view.config()).toEqual({
          fake: true,
          token: '[REDACTED]',
          nested: { api_key: '[REDACTED]' },
        });
        expect(client.descriptor.mcpUrl).not.toContain('url-secret');

        await waitFor(() => client.bus.history().some((event) =>
          event.type === 'log' && event.data.message === 'retained history'));

        let liveMessage = '';
        const unsubscribe = client.bus.on('log', (event) => { liveMessage = event.data.message; });
        serverBus.emit('log', { level: 'info', scope: 'test', message: 'live event' });
        await waitFor(() => liveMessage === 'live event');
        unsubscribe();

        expect(client.view.agentSnapshot('hero')).toBeUndefined();
        await waitFor(() => client.view.agentSnapshot('hero')?.self.tag === 'hero');

        await client.commands.setAgentGoal('hero', 'Test the control plane');
        expect(fake.view.agents().find((agent) => agent.id === 'hero')?.goal).toBe('Test the control plane');
        await expect(client.commands.setAgentGoal('missing', 'fail')).rejects.toThrow('unknown agent: missing');
        expect(await client.commands.removeAgent!('hero', 'done')).toEqual({ removed: true });
        await client.commands.setModel({ role: 'coordinator', team: 'alpha', model: 'team-model' });
        client.commands.setAgentModel!('hero', 'agent', { model: 'rival' });
        await client.commands.createTeam!('red', 'win', ['hero']);
        await waitFor(() => controlCalls.length === 4);
        expect(controlCalls).toEqual([
          'remove:hero', 'selection:coordinator:team-model', 'model:hero:agent:rival', 'team:red'
        ]);
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
      fake.stop();
    }
  }, 10_000);

  test('server close sends its reason and removes the socket and descriptor', async () => {
    const logDir = await temporaryDirectory();
    const bus = createBus();
    const fake = createFakeRuntime(bus, { seed: 8 });
    const server = await createControlServer({
      runId: fake.view.runId, logDir, mcpUrl: 'http://localhost/mcp',
      view: fake.view, commands: fake.commands, bus,
    });
    const client = await connectControl(server.socketPath, { pollMs: 30 });

    await server.close('done');

    expect(await client.closed).toBe('done');
    expect(await Bun.file(server.socketPath).exists()).toBe(false);
    expect(await Bun.file(server.descriptorPath).exists()).toBe(false);
    fake.stop();
  });

  test('control allow-list includes dynamic agent and team operations', () => {
    expect(CONTROL_COMMAND_METHODS).toEqual(expect.arrayContaining([
      'removeAgent', 'setModel', 'setAgentModel', 'createTeam'
    ]));
  });

  test('client detach leaves the run serving another client', async () => {
    const logDir = await temporaryDirectory();
    const bus = createBus();
    const fake = createFakeRuntime(bus, { seed: 9 });
    const server = await createControlServer({
      runId: fake.view.runId, logDir, mcpUrl: 'http://localhost/mcp',
      view: fake.view, commands: fake.commands, bus,
    });

    try {
      const first = await connectControl(server.descriptor);
      await first.close();
      expect(await first.closed).toBe('detached');

      const second = await connectControl(server.descriptor);
      expect(second.view.agents()).toEqual(fake.view.agents());
      await second.close();
      expect(await second.closed).toBe('detached');
    } finally {
      await server.close();
      fake.stop();
    }
  });

  test('run.finish streams before automatic shutdown', async () => {
    const logDir = await temporaryDirectory();
    const bus = createBus();
    const fake = createFakeRuntime(bus, { seed: 10 });
    const server = await createControlServer({
      runId: fake.view.runId, logDir, mcpUrl: 'http://localhost/mcp',
      view: fake.view, commands: fake.commands, bus,
    });
    const client = await connectControl(server.descriptor);

    bus.emit('run.finish', { runId: fake.view.runId, summary: 'complete', ok: true });

    expect(await client.closed).toBe('run closed');
    expect(client.bus.history().at(-1)?.type).toBe('run.finish');
    await server.close();
    expect(await Bun.file(server.socketPath).exists()).toBe(false);
    expect(await Bun.file(server.descriptorPath).exists()).toBe(false);
    fake.stop();
  });

  test('rejects a message sent before hello with policy code 1008', async () => {
    const logDir = await temporaryDirectory();
    const bus = createBus();
    const fake = createFakeRuntime(bus, { seed: 11 });
    const server = await createControlServer({
      runId: fake.view.runId, logDir, mcpUrl: 'http://localhost/mcp',
      view: fake.view, commands: fake.commands, bus,
    });

    try {
      const code = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`ws+unix://${server.socketPath}:/`);
        socket.addEventListener('open', () => { socket.send(JSON.stringify({ type: 'ping' })); });
        socket.addEventListener('close', (event) => { resolve(event.code); });
        socket.addEventListener('error', () => { reject(new Error('raw control socket failed')); });
      });
      expect(code).toBe(1008);
    } finally {
      await server.close();
      fake.stop();
    }
  });
});
