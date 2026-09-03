import type { PerceptDelta, RejectionView, WorldSnapshot } from './percept.ts';
import type { GroundItemView, NearbyEntityView, ObjectiveView } from './percept.ts';
import type { SimEvent } from '../shared/index.ts';

export interface RejectionOutcome {
  readonly intent: {
    readonly type: string;
    readonly source: {
      readonly kind: string;
      readonly id?: string;
      readonly team?: string;
    };
  };
  readonly code?: string;
  readonly message?: string;
  readonly tick: number;
}

export interface SequencedRejection {
  readonly seq: number;
  readonly rejection: RejectionView;
}

interface InternalDeltaDetails {
  readonly beforeSelfAt: WorldSnapshot['self']['at'];
  readonly afterSelfAt: WorldSnapshot['self']['at'];
  readonly nearbyNames: Readonly<Record<string, string>>;
}

export type DetailedPerceptDelta = PerceptDelta & { readonly _details?: InternalDeltaDetails };

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function itemTotals(snapshot: WorldSnapshot): Map<number, { amount: number; name?: string }> {
  const totals = new Map<number, { amount: number; name?: string }>();
  for (const slot of snapshot.inventory) {
    const prior = totals.get(slot.item);
    totals.set(slot.item, {
      amount: (prior?.amount ?? 0) + slot.amount,
      ...(slot.name ?? prior?.name) === undefined ? {} : { name: slot.name ?? prior?.name }
    });
  }
  return totals;
}

function eventData(event: SimEvent): Record<string, unknown> {
  return event.data as unknown as Record<string, unknown>;
}

function sourceOf(outcome: RejectionOutcome): string {
  const source = outcome.intent.source;
  if (source.kind === 'mind' || source.kind === 'operator') return source.kind;
  if (source.kind === 'coordinator') return `coordinator:${source.team}`;
  return `${source.kind}:${source.id}`;
}

export function rejectionFromOutcome(outcome: RejectionOutcome): RejectionView {
  return {
    type: outcome.intent.type,
    code: outcome.code ?? 'rejected',
    message: outcome.message ?? 'Command rejected',
    tick: outcome.tick,
    source: sourceOf(outcome)
  };
}

export function diffSnapshots(
  before: WorldSnapshot,
  after: WorldSnapshot,
  events: readonly SimEvent[],
  rejections: readonly RejectionView[] = []
): PerceptDelta {
  const beforeNearby = new Map(before.nearby.map((view) => [view.id, view]));
  const afterNearby = new Map(after.nearby.map((view) => [view.id, view]));
  const entered: NearbyEntityView[] = after.nearby.filter((view) => !beforeNearby.has(view.id));
  const left = before.nearby
    .filter((view) => !afterNearby.has(view.id))
    .map(({ id, name }) => ({ id, ...(name === undefined ? {} : { name }) }));

  const beforeItems = itemTotals(before);
  const afterItems = itemTotals(after);
  const itemIds = [...new Set([...beforeItems.keys(), ...afterItems.keys()])].sort((a, b) => a - b);
  const itemsGained: PerceptDelta['itemsGained'][number][] = [];
  const itemsLost: PerceptDelta['itemsLost'][number][] = [];
  for (const item of itemIds) {
    const old = beforeItems.get(item);
    const current = afterItems.get(item);
    const change = (current?.amount ?? 0) - (old?.amount ?? 0);
    const name = current?.name ?? old?.name;
    if (change > 0) itemsGained.push({ item, amount: change, ...(name === undefined ? {} : { name }) });
    if (change < 0) itemsLost.push({ item, amount: -change, ...(name === undefined ? {} : { name }) });
  }

  const deaths: PerceptDelta['deaths'][number][] = [];
  let damageTaken = 0;
  let damageDealt = 0;
  const xp = new Map<string, number>();
  const levelUps: PerceptDelta['levelUps'][number][] = [];
  const messages: string[] = [];
  for (const event of events) {
    const data = eventData(event);
    if (event.type === 'died' && typeof data.entity === 'number') {
      const known = data.entity === before.self.entity
        ? { name: before.self.displayName }
        : beforeNearby.get(data.entity) ?? afterNearby.get(data.entity);
      deaths.push({
        entity: data.entity,
        ...(known?.name === undefined ? {} : { name: known.name }),
        ...(typeof data.killer === 'number' ? { killer: data.killer } : {}),
        isSelf: data.entity === before.self.entity
      });
    } else if (event.type === 'hit' && typeof data.attacker === 'number'
      && typeof data.target === 'number' && typeof data.damage === 'number') {
      if (data.target === before.self.entity) damageTaken += data.damage;
      if (data.attacker === before.self.entity) damageDealt += data.damage;
    } else if (event.type === 'xp-gained' && data.entity === before.self.entity
      && typeof data.skill === 'string' && typeof data.amount === 'number') {
      xp.set(data.skill, (xp.get(data.skill) ?? 0) + data.amount);
    } else if (event.type === 'level-up' && data.entity === before.self.entity
      && typeof data.skill === 'string' && typeof data.level === 'number') {
      levelUps.push({ skill: data.skill, level: data.level });
    } else if (event.type === 'scenario-message' && typeof data.text === 'string') {
      messages.push(data.text);
    }
  }

  const beforeObjectives = new Map(before.objectives.map((objective) => [objective.id, objective]));
  const objectivesChanged: ObjectiveView[] = after.objectives.filter((objective) => {
    const old = beforeObjectives.get(objective.id);
    return old === undefined || old.complete !== objective.complete || !same(old.progress, objective.progress);
  });
  const beforeGround = new Set(before.groundItems.map((item) => item.id));
  const groundItemsAppeared: GroundItemView[] = after.groundItems.filter((item) => !beforeGround.has(item.id));
  const nearbyNames = Object.fromEntries([...before.nearby, ...after.nearby]
    .filter((view): view is NearbyEntityView & { name: string } => view.name !== undefined)
    .map((view) => [String(view.id), view.name]));

  const delta: DetailedPerceptDelta = {
    fromSeq: before.lastEventSeq,
    toSeq: after.lastEventSeq,
    fromTick: before.tick,
    toTick: after.tick,
    ...(same(before.self.hp, after.self.hp) ? {} : { hp: { before: before.self.hp, after: after.self.hp } }),
    ...(same(before.self.at, after.self.at) ? {} : { moved: { from: before.self.at, to: after.self.at } }),
    xpGained: [...xp].sort(([left], [right]) => left.localeCompare(right))
      .map(([skill, amount]) => ({ skill, amount })),
    levelUps,
    itemsGained,
    itemsLost,
    entered,
    left,
    deaths,
    damageTaken,
    damageDealt,
    groundItemsAppeared,
    ...(same(before.dialogue, after.dialogue) ? {} : { dialogue: after.dialogue }),
    objectivesChanged,
    rejections,
    messages,
    lines: [],
    events,
    _details: { beforeSelfAt: before.self.at, afterSelfAt: after.self.at, nearbyNames }
  };
  return delta;
}

