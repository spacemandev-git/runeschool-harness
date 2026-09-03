import { describe, expect, test } from 'bun:test';
import type { ClientCommand, ServerEvent } from '#protocol';
import { createBus } from '../bus/index.ts';
import type { ActionIntent, ActorCredentials } from '../core/index.ts';
import { createActorLink } from './actorLink.ts';

class FakeWebSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  readonly commands: ClientCommand[] = [];
  readonly times: number[] = [];
  readonly lifecycle: string[] = [];
  readonly url: string;

  constructor(url: string, private readonly options: {
    readonly drop?: ReadonlySet<string>;
    readonly leaveOk?: boolean;
    readonly retained?: ServerEvent;
  } = {}) {
    super();
    this.url = url;
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
      if (options.retained !== undefined) this.receive(options.retained);
    });
  }

  send(raw: string): void {
    const command = JSON.parse(raw) as ClientCommand;
    this.commands.push(command);
    this.lifecycle.push(`send:${command.type}`);
    if (command.type !== 'claim') this.times.push(Date.now());
    if (this.options.drop?.has(command.type) === true) return;
    queueMicrotask(() => this.receive(command.type === 'claim'
      ? { id: command.id, ok: true, tick: 1, role: 'actor', entity: 7 }
      : {
          id: command.id,
          ok: command.type === 'leave' ? (this.options.leaveOk ?? true) : true,
          tick: this.commands.length
        }));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  close(): void {
    this.lifecycle.push('close');
    this.readyState = WebSocket.CLOSED;
    this.lifecycle.push('close-event');
    this.dispatchEvent(new CloseEvent('close', { code: 1000, reason: 'test closed' }));
  }

  asWebSocket(): WebSocket { return this as unknown as WebSocket; }
}

function credentials(): ActorCredentials {
  return {
    instanceId: 'inst', httpUrl: 'http://test/instances/inst',
    wsUrl: 'ws://test/instances/inst/stream?interest=1', tag: 'hero', entity: 7, token: 'secret'
  };
}

function intent(type: string, data: Readonly<Record<string, unknown>> = {}): ActionIntent {
  return { type, data, source: { kind: 'mind' } };
}

describe('createActorLink', () => {
  test('subscribes before open, claims first, correlates acknowledgements, unpacks batches, and bounds the ring', async () => {
    const retained: ServerEvent = { type: 'scenario-message', instance: 'inst', tick: 1, seq: 1, data: { text: 'ready' } };
    let socket: FakeWebSocket | undefined;
    const link = createActorLink(credentials(), createBus(), {
      ringSize: 2,
      webSocketFactory: (url) => (socket = new FakeWebSocket(url, { retained })).asWebSocket()
    });
    const seen: number[] = [];
    link.onEvent((event) => seen.push(event.seq));
    await link.connect();
    expect(socket?.url).toEndWith('?interest=1&since=0');
    expect(socket?.commands[0]).toMatchObject({ type: 'claim', data: { token: 'secret' } });
    expect(socket?.commands[1]).toMatchObject({ type: 'set-interest', enabled: true });
    const outcome = await link.submit(intent('walk', { dest: { x: 2, z: 3, level: 0 } }));
    expect(outcome.ok).toBe(true);
    expect(socket?.commands[2]).toMatchObject({ type: 'walk', data: { entity: 7 } });
    socket?.receive({
      type: 'event-batch',
      events: [2, 3].map((seq) => ({ type: 'scenario-message', instance: 'inst', tick: seq, seq, data: { text: String(seq) } }))
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(link.eventsSince(0).map((event) => event.seq)).toEqual([2, 3]);
    await link.close();
  });

  test('rejects invalid, admin, and harness-denied commands without sending', async () => {
    let socket: FakeWebSocket | undefined;
    const link = createActorLink(credentials(), createBus(), {
      webSocketFactory: (url) => (socket = new FakeWebSocket(url)).asWebSocket()
    });
    await link.connect();
    expect((await link.submit(intent('not-real'))).code).toBe('invalid_command');
    expect((await link.submit(intent('spawn'))).code).toBe('invalid_command');
    expect((await link.submit(intent('move'))).code).toBe('denied_command');
    expect(socket?.commands.map((command) => command.type)).toEqual(['claim', 'set-interest']);
    await link.close();
  });

  test('returns timeout outcomes and rate-limits queued commands in order', async () => {
    const timeoutLink = createActorLink(credentials(), createBus(), {
      commandTimeoutMs: 20,
      webSocketFactory: (url) => new FakeWebSocket(url, { drop: new Set(['walk']) }).asWebSocket()
    });
    await timeoutLink.connect();
    expect((await timeoutLink.submit(intent('walk'))).code).toBe('timeout');
    await timeoutLink.close();

    let socket: FakeWebSocket | undefined;
    const rateLink = createActorLink(credentials(), createBus(), {
      maxCommandsPerSecond: 2,
      webSocketFactory: (url) => (socket = new FakeWebSocket(url)).asWebSocket()
    });
    await rateLink.connect();
    const types = ['walk', 'run', 'attack', 'eat', 'bury'];
    await Promise.all(types.map((type) => rateLink.submit(intent(type))));
    expect(socket?.commands.slice(2).map((command) => command.type)).toEqual(types);
    expect(socket?.times.at(-1)! - socket!.times[0]!).toBeGreaterThanOrEqual(1_400);
    await rateLink.close();
  });

  test('sends leave before closing and bounds the wait for its result', async () => {
    let replyingSocket: FakeWebSocket | undefined;
    const replyingLink = createActorLink(credentials(), createBus(), {
      webSocketFactory: (url) => (replyingSocket = new FakeWebSocket(url, { leaveOk: false })).asWebSocket()
    });
    await replyingLink.connect();
    const replyStartedAt = Date.now();
    const replyingClose = replyingLink.close();
    expect(replyingLink.close()).toBe(replyingClose);
    await replyingClose;
    const replyElapsed = Date.now() - replyStartedAt;
    const leave = replyingSocket?.commands.find((command) => command.type === 'leave');
    expect(leave).toMatchObject({
      type: 'leave',
      instance: 'inst',
      data: {}
    });
    expect(leave?.id).toMatch(/^leave-\d+$/);
    expect(replyingSocket?.lifecycle.indexOf('send:leave')).toBeLessThan(
      replyingSocket?.lifecycle.indexOf('close-event') ?? -1
    );
    expect(replyElapsed).toBeLessThan(250);

    let silentSocket: FakeWebSocket | undefined;
    const silentLink = createActorLink(credentials(), createBus(), {
      webSocketFactory: (url) => (silentSocket = new FakeWebSocket(url, { drop: new Set(['leave']) })).asWebSocket()
    });
    await silentLink.connect();
    const silentStartedAt = Date.now();
    await silentLink.close();
    const silentElapsed = Date.now() - silentStartedAt;
    expect(silentSocket?.commands.find((command) => command.type === 'leave')).toMatchObject({
      instance: 'inst'
    });
    expect(silentSocket?.lifecycle.indexOf('send:leave')).toBeLessThan(
      silentSocket?.lifecycle.indexOf('close-event') ?? -1
    );
    expect(silentElapsed).toBeLessThan(500);
  });
});
