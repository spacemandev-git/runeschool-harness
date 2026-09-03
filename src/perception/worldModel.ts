import type { ServerEvent, SimEvent, TileCoord } from '#protocol';
import {
  createWorldModel as createSdkWorldModel,
  rejectionFromOutcome,
  type InstanceHandle,
  type InstanceStream,
  type PerceptDelta,
  type RejectionView,
  type WorldSnapshot,
  type WorldView
} from '#world';
import type {
  ActionOutcome,
  ActorLink,
  DefsReader,
  HarnessBus
} from '../core/index.ts';
import { renderDeltaLines } from './summarizer.ts';

export interface WorldModelOptions {
  readonly agentId: string;
  readonly tag: string;
  readonly entity: number;
  readonly link: ActorLink;
  readonly defs: DefsReader;
  readonly bus: HarnessBus;
  readonly radius?: number;
  readonly resyncIntervalMs?: number;
  readonly ringSize?: number;
  readonly now?: () => number;
}

export interface WorldModel extends WorldView {
  start(): Promise<void>;
  stop(): void;
  resync(): Promise<void>;
  checkpoint(): number;
  noteRejection(outcome: ActionOutcome): void;
  lastPulseEvents(): readonly SimEvent[];
}

class ActorLinkStream implements AsyncIterable<ServerEvent> {
  constructor(private readonly link: ActorLink) {}

  [Symbol.asyncIterator](): AsyncIterator<ServerEvent> {
    const queued: ServerEvent[] = [];
    const pending: Array<(result: IteratorResult<ServerEvent>) => void> = [];
    let done = false;
    const unsubscribe = this.link.onEvent((event) => {
      const resolve = pending.shift();
      if (resolve === undefined) queued.push(event);
      else resolve({ done: false, value: event });
    });
    return {
      next(): Promise<IteratorResult<ServerEvent>> {
        const event = queued.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => pending.push(resolve));
      },
      return(): Promise<IteratorResult<ServerEvent>> {
        if (!done) {
          done = true;
          unsubscribe();
          for (const resolve of pending.splice(0)) resolve({ done: true, value: undefined });
        }
        return Promise.resolve({ done: true, value: undefined });
      }
    };
  }
}

/** Harness compatibility adapter around the SDK-owned state model. */
export function createWorldModel(options: WorldModelOptions): WorldModel {
  const handle = {
    id: options.link.credentials.instanceId,
    info: () => options.link.get(''),
    async entities(): Promise<readonly never[]> {
      const value = await options.link.get('/entities');
      const record = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
      return (Array.isArray(record.entities) ? record.entities : []) as unknown as readonly never[];
    },
    request: (path: string) => options.link.get(path),
    requestRoot: (path: string) => options.link.get(path)
  } as unknown as InstanceHandle;
  const stream = new ActorLinkStream(options.link) as unknown as InstanceStream;
  const sdk = createSdkWorldModel(handle, stream, options.entity, {
    agentId: options.agentId,
    tag: options.tag,
    radius: options.radius,
    resyncIntervalMs: options.resyncIntervalMs,
    ringSize: options.ringSize,
    now: options.now,
    names: () => options.defs.names(),
    onWarning(section, error): void {
      options.bus.emit('log', {
        level: 'warn',
        scope: `world-model:${options.agentId}`,
        message: `Perception refresh failed for ${section}; keeping previous value`,
        data: { error: error instanceof Error ? error.message : String(error) }
      });
    },
    onEvent(event): void {
      options.bus.emit('agent.events', { agentId: options.agentId, events: [event] });
    },
    onSnapshot(snapshot): void {
      options.bus.emit('agent.snapshot', { agentId: options.agentId, snapshot });
    }
  });
  let unsubscribeAction: (() => void) | undefined;

  const model: WorldModel = {
    agentId: options.agentId,
    entity: options.entity,
    async start(): Promise<void> {
      unsubscribeAction ??= options.bus.on('agent.action', (event) => {
        if (event.data.agentId !== options.agentId) return;
        const outcome = event.data.outcome;
        sdk.noteAction({
          type: outcome.intent.type,
          data: outcome.intent.data,
          tick: outcome.tick,
          ok: outcome.ok
        });
      });
      await sdk.start();
    },
    stop(): void {
      unsubscribeAction?.();
      unsubscribeAction = undefined;
      sdk.stop();
    },
    resync: () => sdk.resync(),
    snapshot: () => sdk.snapshot(),
    eventsSince: (since) => sdk.eventsSince(since),
    deltaSince(since): PerceptDelta {
      const delta = sdk.deltaSince(since);
      return { ...delta, lines: renderDeltaLines(delta, sdk.nameOf) };
    },
    checkpoint: () => sdk.checkpoint(),
    distanceTo: (at: TileCoord) => sdk.distanceTo(at),
    nameOf: (kind, id) => sdk.nameOf(kind, id),
    noteRejection(outcome): void {
      if (outcome.ok) return;
      sdk.noteRejection(rejectionFromOutcome(outcome) as RejectionView);
    },
    lastPulseEvents: () => sdk.lastPulseEvents()
  };
  return model;
}
