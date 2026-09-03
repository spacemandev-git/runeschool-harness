import type { JsonValue, ServerEvent, SimEvent, TileCoord } from '../shared/index.ts';
import type { InstanceHandle } from './instanceHandle.ts';
import type { InstanceStream } from './stream.ts';
import type { ReconnectingStream } from './supervisor.ts';
import type {
  AcceptedAction,
  EquippedItemView,
  GroundItemView,
  HeatSourceView,
  InventorySlotView,
  NearbyEntityView,
  NodeView,
  ObjectiveView,
  PerceptDelta,
  RejectionView,
  SkillView,
  StationView,
  WorldModel,
  WorldModelOptions,
  WorldSnapshot
} from './percept.ts';
import {
  createMutableState,
  distanceBetween,
  foldActionOutcome,
  foldEvent,
  snapshotFromState,
  type MutableWorldState
} from './fold.ts';
import { diffSnapshots } from './differ.ts';
import { isVisibleTo } from './visibility.ts';

interface Checkpoint {
  readonly snapshot: WorldSnapshot;
  readonly rejectionCursor: number;
}

interface RecordedRejection {
  readonly seq: number;
  readonly rejection: RejectionView;
}

type Names = {
  readonly items: Readonly<Record<string, string>>;
  readonly npcs: Readonly<Record<string, string>>;
  readonly locs?: Readonly<Record<string, string>>;
};

/** REST source used by the SDK world model. */
export class SdkWorldSource {
  constructor(private readonly handle: InstanceHandle) {}

  read(path: string): Promise<JsonValue> {
    if (path === '') return this.handle.info() as Promise<unknown> as Promise<JsonValue>;
    if (path === '/entities') {
      return this.handle.entities().then((entities) => ({ entities })) as Promise<JsonValue>;
    }
    return this.handle.request(path);
  }

  names(): Promise<Names> {
    return this.handle.requestRoot('/defs/names');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown, key: string): readonly unknown[] {
  if (!isRecord(value) || !Array.isArray(value[key])) throw new TypeError(`response missing array '${key}'`);
  return value[key];
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function tile(value: unknown): TileCoord | undefined {
  return isRecord(value) && finite(value.x) !== undefined && finite(value.z) !== undefined
    && finite(value.level) !== undefined
    ? { x: finite(value.x)!, z: finite(value.z)!, level: finite(value.level)! }
    : undefined;
}

function hp(value: unknown): { readonly current: number; readonly max: number } | undefined {
  return isRecord(value) && finite(value.current) !== undefined && finite(value.max) !== undefined
    ? { current: finite(value.current)!, max: finite(value.max)! }
    : undefined;
}

function emptySnapshot(
  instanceId: string,
  entity: number,
  tag: string,
  radius: number,
  now: number
): WorldSnapshot {
  return {
    instanceId,
    tick: 0,
    wallTime: now,
    radius,
    self: {
      entity,
      tag,
      displayName: tag,
      at: { x: 0, z: 0, level: 0 },
      hp: { current: 0, max: 0 },
      status: {
        boosts: {}, specialEnergy: 100, specialEnabled: false,
        runEnergy: 100, weight: 0, zoneTags: [], wildernessLevel: 0
      },
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
    quests: { journal: [], questPoints: 0 },
    slayer: { remaining: 0 },
    social: { friends: [], ignored: [] },
    chat: [],
    lastEventSeq: 0,
    resyncedTick: 0
  };
}

function eventFromServer(value: unknown): SimEvent | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.seq !== 'number'
    || typeof value.tick !== 'number' || !('data' in value)) return undefined;
  return value as unknown as SimEvent;
}

function objective(value: unknown): ObjectiveView | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.description !== 'string'
    || (value.outcome !== 'win' && value.outcome !== 'lose' && value.outcome !== 'progress')
    || typeof value.complete !== 'boolean') return undefined;
  const progress = Array.isArray(value.progress) ? value.progress.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.path !== 'string' || typeof candidate.kind !== 'string'
      || finite(candidate.current) === undefined || finite(candidate.target) === undefined
      || typeof candidate.satisfied !== 'boolean') return [];
    return [{
      path: candidate.path,
      kind: candidate.kind,
      current: finite(candidate.current)!,
      target: finite(candidate.target)!,
      satisfied: candidate.satisfied
    }];
  }) : [];
  return {
    id: value.id,
    description: value.description,
    outcome: value.outcome,
    complete: value.complete,
    ...(typeof value.actorTag === 'string' ? { actorTag: value.actorTag } : {}),
    progress
  };
}

export function createWorldModel(
  handle: InstanceHandle,
  stream: InstanceStream | ReconnectingStream,
  entity: number,
  options: WorldModelOptions = {}
): WorldModel {
  const agentId = options.agentId ?? String(entity);
  const tag = options.tag ?? agentId;
  const radius = options.radius ?? 15;
  const intervalMs = options.resyncIntervalMs ?? 5_000;
  const ringSize = Math.max(1, Math.floor(options.ringSize ?? 4_096));
  const now = options.now ?? Date.now;
  const source = new SdkWorldSource(handle);
  let state: MutableWorldState = createMutableState(emptySnapshot(handle.id, entity, tag, radius, now()));
  let names: Names = { items: {}, npcs: {} };
  let started = false;
  let resyncing = false;
  let pendingResync: Promise<void> | undefined;
  let queuedEvents: SimEvent[] = [];
  let ring: SimEvent[] = [];
  let checkpoints: Checkpoint[] = [];
  let rejections: RecordedRejection[] = [];
  let pulseSeq = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let dirtyTimer: ReturnType<typeof setTimeout> | undefined;
  let eventIterator: AsyncIterator<ServerEvent> | undefined;
  let eventPump: Promise<void> | undefined;

  function log(section: string, error: unknown): void {
    options.onWarning?.(section, error);
  }

  function nameOf(kind: 'item' | 'npc' | 'loc', id: number): string | undefined {
    if (kind === 'item') return names.items[String(id)];
    if (kind === 'npc') return names.npcs[String(id)];
    return names.locs?.[String(id)];
  }

  function knownEntities(): ReadonlySet<number> {
    return new Set(state.nearby.map((candidate) => candidate.id));
  }

  function appendVisible(event: SimEvent): void {
    ring.push(event);
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
    if (resyncing) queuedEvents.push(event);
    else {
      foldEvent(state, event);
      state.anchorTime = now();
      scheduleDirtyRefresh();
    }
    options.onEvent?.(event);
  }

  function receive(candidate: unknown): void {
    const event = eventFromServer(candidate);
    if (event === undefined) {
      log('event', 'invalid server event shape');
      return;
    }
    if (!isVisibleTo(event, { entity: entity, tag: tag, at: state.self.at }, radius, knownEntities())) return;
    appendVisible(event);
  }

  function parseInventory(value: JsonValue): readonly InventorySlotView[] {
    return asArray(value, 'slots').flatMap((candidate, slot): InventorySlotView[] => {
      if (candidate === null) return [];
      if (!isRecord(candidate) || finite(candidate.item) === undefined || finite(candidate.amount) === undefined) {
        throw new TypeError(`invalid inventory slot ${slot}`);
      }
      const item = finite(candidate.item)!;
      return [{ slot, item, name: nameOf('item', item), amount: finite(candidate.amount)! }];
    });
  }

  function parseEquipment(value: JsonValue): Readonly<Record<string, EquippedItemView>> {
    const entries = asArray(value, 'slots').map((candidate): [string, EquippedItemView] => {
      if (!isRecord(candidate) || typeof candidate.slot !== 'string' || finite(candidate.item) === undefined) {
        throw new TypeError('invalid equipment slot');
      }
      const item = finite(candidate.item)!;
      return [candidate.slot, {
        item,
        ...(nameOf('item', item) === undefined ? {} : { name: nameOf('item', item) }),
        ...(finite(candidate.amount) === undefined ? {} : { amount: finite(candidate.amount) })
      }];
    });
    return Object.fromEntries(entries);
  }


  function read(path: string): Promise<JsonValue> {
    return source.read(path);
  }

  function readNames(): Promise<Names> {
    return options.names?.() ?? source.names();
  }

  async function targetedRefresh(): Promise<void> {
    const entityPath = `/entities/${encodeURIComponent(String(entity))}`;
    const [inventoryResult, equipmentResult] = await Promise.allSettled([
      read(`${entityPath}/inventory`),
      read(`${entityPath}/equipment`)
    ]);
    if (inventoryResult.status === 'fulfilled') {
      try {
        const inventory = parseInventory(inventoryResult.value);
        state.inventory = inventory;
        state.inventoryFree = Math.max(0, asArray(inventoryResult.value, 'slots').length - inventory.length);
        state.inventoryDirty = false;
      } catch (error) { log('inventory', error); }
    } else log('inventory', inventoryResult.reason);
    if (equipmentResult.status === 'fulfilled') {
      try {
        state.equipment = parseEquipment(equipmentResult.value);
        state.equipmentDirty = false;
      } catch (error) { log('equipment', error); }
    } else log('equipment', equipmentResult.reason);
  }

  function scheduleDirtyRefresh(): void {
    if (!state.inventoryDirty && !state.equipmentDirty) return;
    if (dirtyTimer !== undefined) clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(() => {
      dirtyTimer = undefined;
      void targetedRefresh();
    }, 600);
  }

  function applyEntities(value: JsonValue, tick: number): void {
    const entries = asArray(value, 'entities');
    const selfEntry = entries.find((candidate) => isRecord(candidate) && candidate.id === entity);
    if (!isRecord(selfEntry)) throw new TypeError(`entity ${entity} missing from entity list`);
    const selfAt = tile(selfEntry.at);
    if (selfAt === undefined) throw new TypeError(`entity ${entity} has invalid position`);
    state.self = {
      ...state.self,
      at: selfAt,
      ...(typeof selfEntry.name === 'string' ? { displayName: selfEntry.name } : {}),
      ...(hp(selfEntry.hp) === undefined ? {} : { hp: hp(selfEntry.hp)! }),
      dead: false
    };
    const prior = new Map(state.nearby.map((entry) => [entry.id, entry]));
    state.nearby = entries.flatMap((candidate): NearbyEntityView[] => {
      if (!isRecord(candidate) || candidate.id === entity || finite(candidate.id) === undefined) return [];
      const at = tile(candidate.at);
      if (at === undefined) return [];
      const distance = distanceBetween(selfAt, at);
      if (distance > radius) return [];
      const id = finite(candidate.id)!;
      const old = prior.get(id);
      const kind = candidate.kind === 'player' || candidate.kind === 'npc'
        || candidate.kind === 'ground_item' || candidate.kind === 'loc' ? candidate.kind : 'npc';
      const npc = finite(candidate.npc);
      const loc = finite(candidate.loc);
      const suppliedName = typeof candidate.name === 'string' ? candidate.name : undefined;
      const resolvedName = suppliedName ?? (npc === undefined
        ? loc === undefined ? undefined : nameOf('loc', loc)
        : nameOf('npc', npc));
      return [{
        id,
        kind,
        ...(resolvedName === undefined ? {} : { name: resolvedName }),
        ...(npc === undefined ? {} : { npc }),
        ...(loc === undefined ? {} : { loc }),
        ...(Array.isArray(candidate.options)
          ? { options: candidate.options.filter((option): option is string => typeof option === 'string') }
          : {}),
        ...(old?.actorTag === undefined ? {} : { actorTag: old.actorTag }),
        at,
        distance,
        ...(hp(candidate.hp) === undefined ? {} : { hp: hp(candidate.hp)! }),
        ...(old?.engaging === undefined ? {} : { engaging: old.engaging }),
        lastSeenTick: tick
      }];
    }).sort((left, right) => left.distance - right.distance || left.id - right.id);
  }

  function applyGround(value: JsonValue): void {
    state.groundItems = asArray(value, 'items').flatMap((candidate): GroundItemView[] => {
      if (!isRecord(candidate) || finite(candidate.id) === undefined || finite(candidate.item) === undefined
        || finite(candidate.amount) === undefined) return [];
      const at = tile(candidate.at);
      if (at === undefined) return [];
      const distance = distanceBetween(state.self.at, at);
      if (distance > radius) return [];
      const item = finite(candidate.item)!;
      return [{
        id: finite(candidate.id)!,
        item,
        ...(nameOf('item', item) === undefined ? {} : { name: nameOf('item', item) }),
        amount: finite(candidate.amount)!,
        at,
        distance,
        ...(finite(candidate.owner) === undefined ? {} : { owner: finite(candidate.owner) })
      }];
    }).sort((left, right) => left.distance - right.distance || left.id - right.id);
  }

  function applyNodes(value: JsonValue): void {
    state.nodes = asArray(value, 'nodes').flatMap((candidate): NodeView[] => {
      if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.skill !== 'string'
        || finite(candidate.requiredLevel) === undefined || typeof candidate.depleted !== 'boolean') return [];
      const at = tile(candidate.at);
      if (at === undefined) return [];
      const distance = distanceBetween(state.self.at, at);
      if (distance > radius) return [];
      const loc = finite(candidate.loc) ?? 0;
      return [{
        id: candidate.id,
        at,
        distance,
        loc,
        ...(loc === 0 || nameOf('loc', loc) === undefined ? {} : { name: nameOf('loc', loc) }),
        skill: candidate.skill,
        requiredLevel: finite(candidate.requiredLevel)!,
        depleted: candidate.depleted
      }];
    }).sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
  }

  function applyStations(value: JsonValue): void {
    state.stations = asArray(value, 'stations').flatMap((candidate): StationView[] => {
      if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.kind !== 'string') return [];
      const at = tile(candidate.at);
      if (at === undefined) return [];
      const distance = distanceBetween(state.self.at, at);
      if (distance > radius) return [];
      return [{ id: candidate.id, kind: candidate.kind, at, distance, name: candidate.kind }];
    }).sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
  }

  function applyHeatSources(value: JsonValue): void {
    state.heatSources = asArray(value, 'sources').flatMap((candidate): HeatSourceView[] => {
      if (!isRecord(candidate) || (candidate.kind !== 'fire' && candidate.kind !== 'range')
        || typeof candidate.id !== 'string') return [];
      const at = tile(candidate.at);
      if (at === undefined) return [];
      const distance = distanceBetween(state.self.at, at);
      if (distance > radius) return [];
      return [{ kind: candidate.kind, id: candidate.id, at, distance }];
    }).sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
  }

  function applySkills(value: JsonValue): void {
    if (!isRecord(value) || !isRecord(value.skills)) throw new TypeError("response missing object 'skills'");
    const parsed: Record<string, SkillView> = {};
    for (const [skill, candidate] of Object.entries(value.skills)) {
      if (!isRecord(candidate) || finite(candidate.level) === undefined || finite(candidate.xp) === undefined) continue;
      parsed[skill] = { level: finite(candidate.level)!, xp: finite(candidate.xp)! };
    }
    state.skills = parsed;
  }

  function applyPrayer(value: JsonValue): void {
    if (!isRecord(value) || finite(value.points) === undefined || finite(value.maxPoints) === undefined
      || !Array.isArray(value.active)) throw new TypeError('invalid prayer response');
    state.self = {
      ...state.self,
      prayer: {
        points: finite(value.points)!,
        maxPoints: finite(value.maxPoints)!,
        active: value.active.filter((entry): entry is string => typeof entry === 'string').sort()
      }
    };
  }

  function applyObjectives(value: JsonValue): void {
    if (!isRecord(value)) throw new TypeError('invalid objectives response');
    state.objectives = asArray(value, 'objectives').flatMap((candidate) => {
      const parsed = objective(candidate);
      return parsed === undefined ? [] : [parsed];
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (typeof value.won === 'boolean') state.won = value.won;
    if (typeof value.lost === 'boolean') state.lost = value.lost;
  }

  async function performResync(): Promise<void> {
    resyncing = true;
    queuedEvents = [];
    const entityPath = `/entities/${encodeURIComponent(String(entity))}`;
    const paths = [
      '', '/entities', '/ground-items', '/nodes', '/stations', '/heat-sources',
      `${entityPath}/inventory`, `${entityPath}/equipment`, `${entityPath}/skills`,
      `${entityPath}/prayer`, `/objectives?actor=${encodeURIComponent(tag)}`
    ] as const;
    const [responses, namesResult] = await Promise.all([
      Promise.allSettled(paths.map((path) => read(path))),
      readNames().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      )
    ]);
    if (namesResult.ok) names = namesResult.value;
    else log('defs/names', namesResult.error);

    const tickResult = responses[0];
    let resyncTick = state.anchorTick;
    if (tickResult?.status === 'fulfilled') {
      if (isRecord(tickResult.value) && finite(tickResult.value.tick) !== undefined) {
        resyncTick = finite(tickResult.value.tick)!;
        state.resyncedTick = resyncTick;
        state.anchorTick = Math.max(state.anchorTick, resyncTick);
      } else log('instance', "response missing numeric 'tick'");
    } else if (tickResult !== undefined) log('instance', tickResult.reason);

    const apply = (index: number, section: string, update: (value: JsonValue) => void): void => {
      const result = responses[index];
      if (result === undefined) return;
      if (result.status === 'rejected') { log(section, result.reason); return; }
      try { update(result.value); } catch (error) { log(section, error); }
    };
    apply(1, 'entities', (value) => applyEntities(value, resyncTick));
    apply(2, 'ground-items', applyGround);
    apply(3, 'nodes', applyNodes);
    apply(4, 'stations', applyStations);
    apply(5, 'heat-sources', applyHeatSources);
    apply(6, 'inventory', (value) => {
      state.inventory = parseInventory(value);
      state.inventoryFree = Math.max(0, asArray(value, 'slots').length - state.inventory.length);
      state.inventoryDirty = false;
    });
    apply(7, 'equipment', (value) => { state.equipment = parseEquipment(value); state.equipmentDirty = false; });
    apply(8, 'skills', applySkills);
    apply(9, 'prayer', applyPrayer);
    apply(10, 'objectives', applyObjectives);
    state.anchorTime = now();

    const pending = queuedEvents;
    queuedEvents = [];
    resyncing = false;
    for (const event of pending) foldEvent(state, event);
    if (pending.length > 0) state.anchorTime = now();
    scheduleDirtyRefresh();
    options.onSnapshot?.(snapshotFromState(state, now()));
  }

  const model: WorldModel = {
    agentId: agentId,
    entity: entity,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      eventIterator = stream[Symbol.asyncIterator]();
      eventPump = (async () => {
        while (started && eventIterator !== undefined) {
          const next = await eventIterator.next();
          if (next.done) break;
          receive(next.value);
        }
      })().catch((error: unknown) => {
        if (started) log('stream', error);
      });
      await model.resync();
      checkpoints = [{ snapshot: model.snapshot(), rejectionCursor: rejections.length }];
      if (intervalMs > 0) timer = setInterval(() => { void model.resync(); }, intervalMs);
    },
    stop(): void {
      if (!started) return;
      started = false;
      void eventIterator?.return?.();
      eventIterator = undefined;
      eventPump = undefined;
      if (timer !== undefined) clearInterval(timer);
      if (dirtyTimer !== undefined) clearTimeout(dirtyTimer);
      timer = undefined;
      dirtyTimer = undefined;
    },
    resync(): Promise<void> {
      pendingResync ??= performResync().catch((error) => log('resync', error)).finally(() => {
        pendingResync = undefined;
        resyncing = false;
      });
      return pendingResync;
    },
    snapshot(): WorldSnapshot {
      return snapshotFromState(state, now());
    },
    eventsSince(since: number): readonly SimEvent[] {
      return ring.filter((event) => event.seq > since);
    },
    deltaSince(seq: number): PerceptDelta {
      const eligible = checkpoints.filter((entry) => entry.snapshot.lastEventSeq <= seq);
      const baseline = eligible.at(-1) ?? checkpoints[0] ?? {
        snapshot: model.snapshot(),
        rejectionCursor: rejections.length
      };
      const after = model.snapshot();
      const events = ring.filter((event) => event.seq > baseline.snapshot.lastEventSeq);
      const rejected = rejections.slice(baseline.rejectionCursor).map((entry) => entry.rejection);
      const structured = diffSnapshots(baseline.snapshot, after, events, rejected);
      return structured;
    },
    checkpoint(): number {
      const snapshot = model.snapshot();
      checkpoints.push({ snapshot, rejectionCursor: rejections.length });
      if (checkpoints.length > 16) checkpoints.splice(0, checkpoints.length - 16);
      return snapshot.lastEventSeq;
    },
    distanceTo(at: TileCoord): number {
      return distanceBetween(state.self.at, at);
    },
    nameOf,
    noteAction(outcome: AcceptedAction): void {
      foldActionOutcome(state, outcome);
    },
    noteRejection(rejection: RejectionView): void {
      rejections.push({ seq: state.lastEventSeq, rejection });
      if (rejections.length > ringSize) rejections = rejections.slice(-ringSize);
    },
    lastPulseEvents(): readonly SimEvent[] {
      const events = ring.filter((event) => event.seq > pulseSeq);
      pulseSeq = state.lastEventSeq;
      return events;
    }
  };
  return model;
}
