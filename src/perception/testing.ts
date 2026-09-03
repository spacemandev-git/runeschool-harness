import type { CommandResult, JsonValue, ServerEvent, SimEvent, SimEventMap, SimEventType } from '#protocol';
import type { ActionIntent, ActionOutcome, ActorCredentials, ActorLink, LinkState, WorldSnapshot } from '../core/index.ts';

const BASE_SNAPSHOT: WorldSnapshot = {
  instanceId: 'inst-test',
  tick: 10,
  wallTime: 6_000,
  radius: 15,
  self: {
    entity: 1,
    tag: 'hero',
    displayName: 'Hero',
    at: { x: 100, z: 100, level: 0 },
    hp: { current: 10, max: 10 },
    combat: { inCombat: false, attackedBy: [] },
    activity: { kind: 'idle' },
    dead: false
  },
  inventory: [],
  inventoryFree: 28,
  equipment: {},
  skills: {},
  nearby: [],
  groundItems: [],
  nodes: [],
  stations: [],
  heatSources: [],
  objectives: [],
  won: false,
  lost: false,
  dialogue: { active: false },
  chat: [],
  lastEventSeq: 0,
  resyncedTick: 10
};

export function makeSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    ...BASE_SNAPSHOT,
    ...overrides,
    self: overrides.self ?? BASE_SNAPSHOT.self,
    inventory: overrides.inventory ?? BASE_SNAPSHOT.inventory,
    equipment: overrides.equipment ?? BASE_SNAPSHOT.equipment,
    skills: overrides.skills ?? BASE_SNAPSHOT.skills,
    nearby: overrides.nearby ?? BASE_SNAPSHOT.nearby,
    groundItems: overrides.groundItems ?? BASE_SNAPSHOT.groundItems,
    nodes: overrides.nodes ?? BASE_SNAPSHOT.nodes,
    stations: overrides.stations ?? BASE_SNAPSHOT.stations,
    heatSources: overrides.heatSources ?? BASE_SNAPSHOT.heatSources,
    objectives: overrides.objectives ?? BASE_SNAPSHOT.objectives,
    dialogue: overrides.dialogue ?? BASE_SNAPSHOT.dialogue,
    chat: overrides.chat ?? BASE_SNAPSHOT.chat
  };
}

export function eventOf<T extends SimEventType>(
  type: T,
  data: SimEventMap[T],
  options: { readonly seq?: number; readonly tick?: number } = {}
): Extract<SimEvent, { readonly type: T }> {
  return {
    type,
    data,
    seq: options.seq ?? 1,
    tick: options.tick ?? 10
  } as Extract<SimEvent, { readonly type: T }>;
}

export const movedEvent = (
  entity: number,
  from = { x: 100, z: 100, level: 0 },
  to = { x: 101, z: 100, level: 0 },
  seq = 1,
  tick = 10
): Extract<SimEvent, { type: 'moved' }> => eventOf('moved', { entity, from, to, running: false }, { seq, tick });

export const hitEvent = (
  attacker: number,
  target: number,
  damage: number,
  hpAfter: number,
  seq = 1,
  tick = 10
): Extract<SimEvent, { type: 'hit' }> => eventOf('hit', {
  attacker, target, damage, hpAfter, style: 'melee', attackStyle: 'accurate'
}, { seq, tick });

export const diedEvent = (
  entity: number,
  killer?: number,
  seq = 1,
  tick = 10
): Extract<SimEvent, { type: 'died' }> => eventOf('died', {
  entity,
  ...(killer === undefined ? {} : { killer })
}, { seq, tick });

export class FakeActorLink implements ActorLink {
  readonly credentials: ActorCredentials;
  state: LinkState = 'closed';
  lastSeq = 0;
  lastTick = 0;
  readonly submitted: ActionIntent[] = [];
  readonly raw: { type: string; data: Readonly<Record<string, unknown>> }[] = [];
  readonly gets: string[] = [];
  private readonly eventListeners = new Set<(event: ServerEvent) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly ring: ServerEvent[] = [];
  private readonly responses = new Map<string, JsonValue>();

  constructor(credentials: Partial<ActorCredentials> = {}) {
    this.credentials = {
      instanceId: 'inst-test',
      httpUrl: 'http://test/instances/inst-test',
      wsUrl: 'ws://test/instances/inst-test/stream',
      tag: 'hero',
      entity: 1,
      token: 'test-token',
      ...credentials
    };
  }

  set(path: string, value: JsonValue): void { this.responses.set(path, value); }
  async connect(): Promise<void> { this.state = 'open'; }
  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }
  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }
  emit(event: SimEvent): void {
    const serverEvent = { ...event, instance: this.credentials.instanceId } as ServerEvent;
    this.ring.push(serverEvent);
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    this.lastTick = Math.max(this.lastTick, event.tick);
    for (const listener of this.eventListeners) listener(serverEvent);
  }
  eventsSince(seq: number): readonly ServerEvent[] { return this.ring.filter((event) => event.seq > seq); }
  async submit(intent: ActionIntent): Promise<ActionOutcome> {
    this.submitted.push(intent);
    return { intent, ok: true, tick: this.lastTick, sentAt: Date.now() };
  }
  async sendRaw(type: string, data: Readonly<Record<string, unknown>>): Promise<CommandResult> {
    this.raw.push({ type, data });
    return { id: `fake-${this.raw.length}`, ok: true, tick: this.lastTick };
  }
  async get(path: string): Promise<JsonValue> {
    this.gets.push(path);
    const value = this.responses.get(path);
    if (value === undefined) throw new Error(`No fake response for ${path}`);
    return value;
  }
  async close(): Promise<void> {
    this.state = 'closed';
    for (const listener of this.closeListeners) listener('fake closed');
  }
}
