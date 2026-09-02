import type { SimEvent } from '#protocol';
import type { ActionIntent, ActionOutcome } from '../core/actions.ts';
import type { ReflexContext } from '../core/reflex.ts';
import type { PerceptDelta, SelfView, WorldSnapshot, WorldView } from '../core/percept.ts';
import type { WakeReason } from '../core/types.ts';
import { chebyshev } from './geometry.ts';

type SelfOverrides = Partial<Omit<SelfView, 'at' | 'hp' | 'combat'>> & {
  readonly at?: Partial<SelfView['at']>; readonly hp?: Partial<SelfView['hp']>;
  readonly combat?: Partial<SelfView['combat']>;
};
export type SnapshotOverrides = Partial<Omit<WorldSnapshot, 'self'>> & { readonly self?: SelfOverrides };

export function makeSnapshot(overrides: SnapshotOverrides = {}): WorldSnapshot {
  const baseSelf: SelfView = {
    entity: 1, tag: 'agent', displayName: 'Agent', at: { x: 3200, z: 3200, level: 0 },
    hp: { current: 10, max: 10 }, combat: { inCombat: false, attackedBy: [] }, activity: { kind: 'idle' }, dead: false
  };
  const selfOverrides = overrides.self ?? {};
  const self: SelfView = {
    ...baseSelf, ...selfOverrides,
    at: { ...baseSelf.at, ...selfOverrides.at }, hp: { ...baseSelf.hp, ...selfOverrides.hp },
    combat: { ...baseSelf.combat, ...selfOverrides.combat }
  };
  const base: WorldSnapshot = {
    instanceId: 'test-instance', tick: 0, wallTime: 0, radius: 15, self,
    inventory: [], inventoryFree: 28, equipment: {}, skills: {}, nearby: [], groundItems: [],
    nodes: [], stations: [], heatSources: [], objectives: [], won: false, lost: false,
    dialogue: { active: false }, chat: [], lastEventSeq: 0, resyncedTick: 0
  };
  return { ...base, ...overrides, self };
}

export class FakeView implements WorldView {
  readonly agentId: string; readonly entity: number; private current: WorldSnapshot; private events: SimEvent[] = [];
  constructor(snapshot: WorldSnapshot = makeSnapshot(), agentId = 'test-agent') { this.current = snapshot; this.agentId = agentId; this.entity = snapshot.self.entity; }
  snapshot(): WorldSnapshot { return this.current; }
  setSnapshot(snapshot: WorldSnapshot): void { this.current = snapshot; }
  patch(overrides: SnapshotOverrides): void { this.current = makeSnapshot({ ...this.current, ...overrides, self: { ...this.current.self, ...overrides.self } }); }
  inject(...events: SimEvent[]): void { this.events.push(...events); }
  eventsSince(since: number): readonly SimEvent[] { return this.events.filter((event) => event.seq > since); }
  deltaSince(sinceSeq: number): PerceptDelta {
    const events = this.eventsSince(sinceSeq);
    return { fromSeq: sinceSeq, toSeq: events.at(-1)?.seq ?? sinceSeq, fromTick: 0, toTick: this.current.tick, xpGained: [], levelUps: [], itemsGained: [], itemsLost: [], entered: [], left: [], deaths: [], damageTaken: 0, damageDealt: 0, groundItemsAppeared: [], objectivesChanged: [], rejections: [], messages: [], lines: [], events };
  }
  checkpoint(): number { return this.current.lastEventSeq; }
  distanceTo(at: SelfView['at']): number { return chebyshev(this.current.self.at, at); }
  nameOf(_kind: 'item' | 'npc' | 'loc', _id: number): string | undefined { return undefined; }
}

type ScriptedOutcome = Partial<Omit<ActionOutcome, 'intent'>>;
export class FakeContext implements ReflexContext {
  readonly agentId: string; readonly view: FakeView; intents: ActionIntent[] = []; logs: string[] = [];
  wakes: { reason: WakeReason; note: string }[] = []; private outcomes: ScriptedOutcome[] = []; private events: SimEvent[] = [];
  constructor(snapshot: WorldSnapshot = makeSnapshot(), agentId = 'test-agent') { this.agentId = agentId; this.view = new FakeView(snapshot, agentId); }
  get tick(): number { return this.view.snapshot().tick; }
  get pulseEvents(): readonly SimEvent[] { return this.events; }
  act(intent: Omit<ActionIntent, 'source'>): Promise<ActionOutcome> {
    const received = intent as ActionIntent;
    const full: ActionIntent = received.source === undefined ? { ...intent, source: { kind: 'behaviour', id: 'test', instance: 'test#0' } } : received;
    this.intents.push(full);
    const scripted = this.outcomes.shift() ?? {};
    return Promise.resolve({ intent: full, ok: scripted.ok ?? true, tick: scripted.tick ?? this.tick, sentAt: scripted.sentAt ?? 0, ...(scripted.code === undefined ? {} : { code: scripted.code }), ...(scripted.message === undefined ? {} : { message: scripted.message }), ...(scripted.details === undefined ? {} : { details: scripted.details }) });
  }
  script(...outcomes: ScriptedOutcome[]): this { this.outcomes.push(...outcomes); return this; }
  inject(...events: SimEvent[]): this { this.events.push(...events); this.view.inject(...events); return this; }
  clearEvents(): void { this.events = []; }
  wakeMind(reason: WakeReason, note: string): void { this.wakes.push({ reason, note }); }
  log(line: string): void { this.logs.push(line); }
  advance(ticks = 1): void {
    const current = this.view.snapshot();
    this.view.setSnapshot({ ...current, tick: current.tick + ticks, wallTime: current.wallTime + ticks * 600 });
    this.events = [];
  }
  setSnapshot(snapshot: WorldSnapshot): void { this.view.setSnapshot(snapshot); }
}

export function makeEvent<T extends SimEvent['type']>(type: T, data: Extract<SimEvent, { type: T }>['data'], tick = 0, seq = 1): Extract<SimEvent, { type: T }> {
  return { type, data, tick, seq } as Extract<SimEvent, { type: T }>;
}
