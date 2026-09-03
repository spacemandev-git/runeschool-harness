import type { AcceptedAction, Activity, TradeOfferView, TradeView, WorldSnapshot } from './percept.ts';
import type {
  DialogueView,
  GroundItemView,
  HeatSourceView,
  NearbyEntityView,
  NodeView,
  ObjectiveView,
  SelfView
} from './percept.ts';
import type { JsonValue, SimEvent, TileCoord } from '../shared/index.ts';

export interface MutableWorldState {
  instanceId: string;
  radius: number;
  self: SelfView;
  inventory: WorldSnapshot['inventory'];
  inventoryFree: number;
  equipment: WorldSnapshot['equipment'];
  skills: WorldSnapshot['skills'];
  nearby: WorldSnapshot['nearby'];
  groundItems: WorldSnapshot['groundItems'];
  nodes: WorldSnapshot['nodes'];
  stations: WorldSnapshot['stations'];
  heatSources: WorldSnapshot['heatSources'];
  objectives: WorldSnapshot['objectives'];
  won: boolean;
  lost: boolean;
  dialogue: DialogueView;
  trade?: TradeView;
  quests: NonNullable<WorldSnapshot['quests']>;
  slayer: NonNullable<WorldSnapshot['slayer']>;
  social: NonNullable<WorldSnapshot['social']>;
  farming: NonNullable<WorldSnapshot['farming']>;
  hunter: NonNullable<WorldSnapshot['hunter']>;
  familiar?: NonNullable<WorldSnapshot['familiar']>;
  summoningPoints: number;
  minigame?: NonNullable<WorldSnapshot['minigame']>;
  clue?: NonNullable<WorldSnapshot['clue']>;
  randomEvent?: NonNullable<WorldSnapshot['randomEvent']>;
  diary?: NonNullable<WorldSnapshot['diary']>;
  chat: WorldSnapshot['chat'];
  lastEventSeq: number;
  resyncedTick: number;
  anchorTick: number;
  anchorTime: number;
  messages: string[];
  inventoryDirty: boolean;
  equipmentDirty: boolean;
  lastSelfMovedTick: number;
  /** Zone IDs are needed because `zone-left` does not repeat the entered tags. */
  statusZones: Map<string, readonly string[]>;
}

const DEFAULT_STATUS = Object.freeze({
  boosts: Object.freeze({}) as Readonly<Record<string, number>>,
  specialEnergy: 100,
  specialEnabled: false,
  runEnergy: 100,
  weight: 0,
  zoneTags: Object.freeze([]) as readonly string[],
  wildernessLevel: 0
});

function statusOf(self: SelfView): NonNullable<SelfView['status']> {
  return self.status ?? DEFAULT_STATUS;
}

function wildernessLevel(at: TileCoord, tags: readonly string[]): number {
  if (!tags.includes('wilderness')) return 0;
  const base = at.z >= 6400 ? 9920 : 3520;
  return Math.max(1, Math.floor((at.z - base) / 8) + 1);
}

function setStatus(
  state: MutableWorldState,
  update: (status: NonNullable<SelfView['status']>) => NonNullable<SelfView['status']>
): void {
  state.self = { ...state.self, status: update(statusOf(state.self)) };
}

function withoutPoison(status: NonNullable<SelfView['status']>): NonNullable<SelfView['status']> {
  const { poison: _poison, ...rest } = status;
  return rest;
}

function withoutSkull(status: NonNullable<SelfView['status']>): NonNullable<SelfView['status']> {
  const { skulledUntil: _skulledUntil, ...rest } = status;
  return rest;
}

function refreshZoneStatus(state: MutableWorldState): void {
  const tags = [...new Set([...state.statusZones.values()].flat())].sort();
  setStatus(state, (status) => ({
    ...status,
    zoneTags: tags,
    wildernessLevel: wildernessLevel(state.self.at, tags)
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tile(value: unknown): TileCoord | undefined {
  return isRecord(value)
    && typeof value.x === 'number'
    && typeof value.z === 'number'
    && typeof value.level === 'number'
    ? { x: value.x, z: value.z, level: value.level }
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function distanceBetween(left: TileCoord, right: TileCoord): number {
  if (left.level !== right.level) return Number.POSITIVE_INFINITY;
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.z - right.z));
}

export function createMutableState(snapshot: WorldSnapshot): MutableWorldState {
  return {
    instanceId: snapshot.instanceId,
    radius: snapshot.radius,
    self: snapshot.self,
    inventory: snapshot.inventory,
    inventoryFree: snapshot.inventoryFree,
    equipment: snapshot.equipment,
    skills: snapshot.skills,
    nearby: snapshot.nearby,
    groundItems: snapshot.groundItems,
    nodes: snapshot.nodes,
    stations: snapshot.stations,
    heatSources: snapshot.heatSources,
    objectives: snapshot.objectives,
    won: snapshot.won,
    lost: snapshot.lost,
    dialogue: snapshot.dialogue,
    ...(snapshot.trade === undefined ? {} : { trade: snapshot.trade }),
    quests: snapshot.quests ?? { journal: [], questPoints: 0 },
    slayer: snapshot.slayer ?? { remaining: 0 },
    social: snapshot.social ?? { friends: [], ignored: [] },
    farming: snapshot.farming ?? { patches: [] },
    hunter: snapshot.hunter ?? { traps: [] },
    ...(snapshot.familiar === undefined ? {} : { familiar: snapshot.familiar }),
    summoningPoints: snapshot.summoningPoints ?? 0,
    ...(snapshot.minigame === undefined ? {} : { minigame: snapshot.minigame }),
    ...(snapshot.clue === undefined ? {} : { clue: snapshot.clue }),
    ...(snapshot.randomEvent === undefined ? {} : { randomEvent: snapshot.randomEvent }),
    ...(snapshot.diary === undefined ? {} : { diary: snapshot.diary }),
    chat: snapshot.chat,
    lastEventSeq: snapshot.lastEventSeq,
    resyncedTick: snapshot.resyncedTick,
    anchorTick: snapshot.tick,
    anchorTime: snapshot.wallTime,
    messages: [],
    inventoryDirty: false,
    equipmentDirty: false,
    lastSelfMovedTick: snapshot.tick,
    statusZones: new Map()
  };
}

export function estimatedTick(state: MutableWorldState, now: number): number {
  return state.anchorTick + Math.max(0, Math.floor((now - state.anchorTime) / 600));
}

export function expireWalking(state: MutableWorldState, tick: number): void {
  if (state.self.activity.kind === 'walking' && tick - state.lastSelfMovedTick >= 5) {
    state.self = { ...state.self, activity: { kind: 'idle' } };
  }
}

export function snapshotFromState(state: MutableWorldState, now: number): WorldSnapshot {
  const tick = estimatedTick(state, now);
  expireWalking(state, tick);
  return {
    instanceId: state.instanceId,
    tick,
    wallTime: now,
    radius: state.radius,
    self: state.self,
    inventory: state.inventory,
    inventoryFree: state.inventoryFree,
    equipment: state.equipment,
    skills: state.skills,
    nearby: state.nearby,
    groundItems: state.groundItems,
    nodes: state.nodes,
    stations: state.stations,
    heatSources: state.heatSources,
    objectives: state.objectives,
    won: state.won,
    lost: state.lost,
    dialogue: state.dialogue,
    ...(state.trade === undefined ? {} : { trade: state.trade }),
    quests: state.quests,
    slayer: state.slayer,
    social: state.social,
    farming: state.farming,
    hunter: state.hunter,
    ...(state.familiar === undefined ? {} : { familiar: state.familiar }),
    summoningPoints: state.summoningPoints,
    ...(state.minigame === undefined ? {} : { minigame: state.minigame }),
    ...(state.clue === undefined ? {} : { clue: state.clue }),
    ...(state.randomEvent === undefined ? {} : { randomEvent: state.randomEvent }),
    ...(state.diary === undefined ? {} : { diary: state.diary }),
    chat: state.chat,
    lastEventSeq: state.lastEventSeq,
    resyncedTick: state.resyncedTick
  };
}

function nearbyIndex(state: MutableWorldState, entity: number): number {
  return state.nearby.findIndex((candidate) => candidate.id === entity);
}

function updateNearby(state: MutableWorldState, entity: number, update: (view: NearbyEntityView) => NearbyEntityView): void {
  const index = nearbyIndex(state, entity);
  if (index < 0) return;
  const next = state.nearby.slice();
  next[index] = update(next[index]!);
  state.nearby = next;
}

function removeNearby(state: MutableWorldState, entity: number): void {
  state.nearby = state.nearby.filter((candidate) => candidate.id !== entity);
}

function setAt(state: MutableWorldState, entity: number, at: TileCoord, tick: number): void {
  if (entity === state.self.entity) {
    const activity = state.self.activity.kind === 'walking'
      && distanceBetween(at, state.self.activity.dest) === 0
      ? { kind: 'idle' as const }
      : state.self.activity;
    state.self = { ...state.self, at, activity };
    const status = statusOf(state.self);
    state.self = {
      ...state.self,
      status: { ...status, wildernessLevel: wildernessLevel(at, status.zoneTags) }
    };
    state.lastSelfMovedTick = tick;
    return;
  }
  updateNearby(state, entity, (view) => ({
    ...view,
    at,
    distance: distanceBetween(state.self.at, at),
    lastSeenTick: tick
  }));
  state.nearby = state.nearby.filter((view) => view.distance <= state.radius);
}

function setIdle(state: MutableWorldState, entity: unknown): void {
  if (entity === state.self.entity) state.self = { ...state.self, activity: { kind: 'idle' } };
}

function setHp(state: MutableWorldState, entity: number, current: number): void {
  if (entity === state.self.entity) {
    state.self = { ...state.self, hp: { ...state.self.hp, current } };
  } else {
    updateNearby(state, entity, (view) => view.hp === undefined
      ? view
      : { ...view, hp: { ...view.hp, current } });
  }
}

function setEngaging(state: MutableWorldState, attacker: number, target: number): void {
  updateNearby(state, attacker, (view) => ({ ...view, engaging: target }));
}

function clearEngagements(state: MutableWorldState, entity: number): void {
  state.nearby = state.nearby.map((view) => view.engaging === entity
    ? { ...view, engaging: undefined }
    : view);
  const attackedBy = state.self.combat.attackedBy.filter((candidate) => candidate !== entity);
  const targeted = state.self.combat.target === entity;
  state.self = {
    ...state.self,
    combat: {
      ...state.self.combat,
      attackedBy,
      ...(targeted ? { target: undefined, inCombat: attackedBy.length > 0 } : {})
    }
  };
}

function addInventoryAtSlot(state: MutableWorldState, slot: number, item: number, amount: number): void {
  const next = state.inventory.filter((entry) => entry.slot !== slot);
  next.push({ slot, item, amount });
  next.sort((left, right) => left.slot - right.slot);
  state.inventory = next;
  state.inventoryFree = Math.max(0, 28 - next.length);
}

function removeInventoryAtSlot(state: MutableWorldState, slot: number, item: number, amount: number): void {
  const existing = state.inventory.find((entry) => entry.slot === slot && entry.item === item);
  if (existing === undefined) return;
  state.inventory = existing.amount <= amount
    ? state.inventory.filter((entry) => entry !== existing)
    : state.inventory.map((entry) => entry === existing ? { ...entry, amount: entry.amount - amount } : entry);
  state.inventoryFree = Math.max(0, 28 - state.inventory.length);
}

function markItemDirty(state: MutableWorldState, equipment = false): void {
  state.inventoryDirty = true;
  if (equipment) state.equipmentDirty = true;
}

function updateObjective(state: MutableWorldState, id: string, outcome: ObjectiveView['outcome']): void {
  const found = state.objectives.find((objective) => objective.id === id);
  const updated: ObjectiveView = found === undefined
    ? { id, description: id, outcome, complete: true, progress: [] }
    : { ...found, complete: true };
  state.objectives = found === undefined
    ? [...state.objectives, updated]
    : state.objectives.map((objective) => objective.id === id ? updated : objective);
}

function addHeatSource(state: MutableWorldState, source: HeatSourceView): void {
  state.heatSources = [...state.heatSources.filter((candidate) => candidate.id !== source.id), source]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function setNodeDepleted(state: MutableWorldState, id: string, depleted: boolean): void {
  state.nodes = state.nodes.map((node): NodeView => node.id === id ? { ...node, depleted } : node);
}

function dataOf(event: SimEvent): Record<string, unknown> {
  return event.data as unknown as Record<string, unknown>;
}

function tradeOffer(value: unknown): readonly TradeOfferView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TradeOfferView[] => {
    if (!isRecord(entry)) return [];
    const item = number(entry.item);
    const amount = number(entry.amount);
    return item === undefined || amount === undefined ? [] : [{ item, amount }];
  }).sort((left, right) => left.item - right.item);
}

function actorInTrade(state: MutableWorldState, a: unknown, b: unknown): number | undefined {
  const left = number(a);
  const right = number(b);
  if (left === state.self.entity) return right;
  if (right === state.self.entity) return left;
  return undefined;
}

/** Pure reducer: all effects are contained in the supplied mutable state. */
export function foldEvent(state: MutableWorldState, event: SimEvent): void {
  state.lastEventSeq = Math.max(state.lastEventSeq, event.seq);
  state.anchorTick = Math.max(state.anchorTick, event.tick);
  expireWalking(state, event.tick);
  const data = dataOf(event);
  const entity = number(data.entity);

  switch (event.type) {
    case 'entity-spawned': {
      if (entity === undefined) break;
      const at = tile(data.at);
      if (at === undefined) break;
      if (entity === state.self.entity) {
        state.self = {
          ...state.self,
          at,
          ...(string(data.name) === undefined ? {} : { displayName: string(data.name)! })
        };
        break;
      }
      const distance = distanceBetween(state.self.at, at);
      if (distance > state.radius) break;
      const hp = isRecord(data.hp) && number(data.hp.current) !== undefined && number(data.hp.max) !== undefined
        ? { current: number(data.hp.current)!, max: number(data.hp.max)! }
        : undefined;
      const view: NearbyEntityView = {
        id: entity,
        kind: data.kind === 'player' || data.kind === 'npc' || data.kind === 'ground_item' || data.kind === 'loc'
          ? data.kind : 'npc',
        ...(string(data.name) === undefined ? {} : { name: string(data.name) }),
        ...(number(data.npc) === undefined ? {} : { npc: number(data.npc) }),
        ...(number(data.loc) === undefined ? {} : { loc: number(data.loc) }),
        at,
        distance,
        ...(hp === undefined ? {} : { hp }),
        lastSeenTick: event.tick
      };
      state.nearby = [...state.nearby.filter((candidate) => candidate.id !== entity), view]
        .sort((left, right) => left.distance - right.distance || left.id - right.id);
      break;
    }
    case 'entity-renamed':
      if (entity !== undefined && typeof data.name === 'string') {
        updateNearby(state, entity, (view) => ({ ...view, name: data.name as string }));
      }
      break;
    case 'entity-despawned':
      if (entity !== undefined) {
        removeNearby(state, entity);
        clearEngagements(state, entity);
        state.hunter = { traps: state.hunter.traps.filter((trap) => trap.id !== entity) };
      }
      break;
    case 'moved':
      if (entity !== undefined) {
        const at = tile(data.to);
        if (at !== undefined) setAt(state, entity, at, event.tick);
      }
      break;
    case 'teleported':
    case 'climbed':
      if (entity !== undefined) {
        const at = tile(data.to);
        if (at !== undefined) setAt(state, entity, at, event.tick);
      }
      break;
    case 'entity-moved':
      if (entity !== undefined) {
        const at = tile(data.at);
        if (at !== undefined) setAt(state, entity, at, event.tick);
      }
      break;
    case 'move-blocked':
    case 'move-rejected':
      setIdle(state, entity);
      break;
    case 'hit': {
      const attacker = number(data.attacker);
      const target = number(data.target);
      const hpAfter = number(data.hpAfter);
      if (attacker === undefined || target === undefined) break;
      if (hpAfter !== undefined) setHp(state, target, hpAfter);
      setEngaging(state, attacker, target);
      if (target === state.self.entity) {
        const attackedBy = [...new Set([...state.self.combat.attackedBy, attacker])].sort((a, b) => a - b);
        state.self = { ...state.self, combat: { ...state.self.combat, attackedBy, inCombat: true } };
      }
      if (attacker === state.self.entity) {
        state.self = { ...state.self, combat: { ...state.self.combat, target, inCombat: true } };
      }
      break;
    }
    case 'damaged': {
      const health = number(data.health);
      if (entity !== undefined && health !== undefined) setHp(state, entity, health);
      break;
    }
    case 'died': {
      if (entity === undefined) break;
      if (entity === state.self.entity) {
        state.self = {
          ...state.self,
          status: withoutPoison(statusOf(state.self)),
          dead: true,
          activity: { kind: 'idle' },
          combat: { ...state.self.combat, inCombat: false, target: undefined, attackedBy: [] }
        };
      } else removeNearby(state, entity);
      clearEngagements(state, entity);
      break;
    }
    case 'poisoned':
      if (entity === state.self.entity && number(data.severity) !== undefined) {
        setStatus(state, (status) => ({ ...status, poison: { severity: number(data.severity)! } }));
      }
      break;
    case 'poison-damage':
      if (entity === state.self.entity && number(data.severity) !== undefined) {
        const severity = Math.max(0, number(data.severity)! - 1);
        setStatus(state, (status) => severity === 0 ? withoutPoison(status) : { ...status, poison: { severity } });
      }
      break;
    case 'poison-cured':
      if (entity === state.self.entity) setStatus(state, withoutPoison);
      break;
    case 'stat-boosted':
    case 'stat-restored':
      if (entity === state.self.entity && string(data.skill) !== undefined
        && number(data.current) !== undefined && number(data.base) !== undefined) {
        const skill = string(data.skill)!;
        const delta = number(data.current)! - number(data.base)!;
        setStatus(state, (status) => {
          const boosts = { ...status.boosts };
          if (delta === 0) delete boosts[skill]; else boosts[skill] = delta;
          return { ...status, boosts };
        });
      }
      break;
    case 'special-energy':
      if (entity === state.self.entity && number(data.energy) !== undefined) {
        setStatus(state, (status) => ({ ...status, specialEnergy: number(data.energy)! }));
      }
      break;
    case 'special-toggled':
      if (entity === state.self.entity && typeof data.enabled === 'boolean') {
        setStatus(state, (status) => ({ ...status, specialEnabled: data.enabled as boolean }));
      }
      break;
    case 'run-energy':
      if (entity === state.self.entity && number(data.energy) !== undefined && number(data.weight) !== undefined) {
        setStatus(state, (status) => ({
          ...status,
          runEnergy: number(data.energy)!,
          weight: number(data.weight)!
        }));
      }
      break;
    case 'run-toggled':
      if (entity === state.self.entity && typeof data.enabled === 'boolean') {
        setStatus(state, (status) => ({ ...status, runEnabled: data.enabled as boolean }));
      }
      break;
    case 'skulled':
      if (entity === state.self.entity && number(data.until) !== undefined) {
        setStatus(state, (status) => ({ ...status, skulledUntil: number(data.until)! }));
      }
      break;
    case 'skull-expired':
      if (entity === state.self.entity) setStatus(state, withoutSkull);
      break;
    case 'zone-entered':
      if (entity === state.self.entity && string(data.zone) !== undefined && Array.isArray(data.tags)) {
        state.statusZones.set(string(data.zone)!, data.tags.filter((tag): tag is string => typeof tag === 'string'));
        refreshZoneStatus(state);
      }
      break;
    case 'zone-left':
      if (entity === state.self.entity && string(data.zone) !== undefined) {
        state.statusZones.delete(string(data.zone)!);
        refreshZoneStatus(state);
      }
      break;
    case 'items-lost-on-death':
      if (entity === state.self.entity) markItemDirty(state, true);
      break;
    case 'patch-changed': {
      const id = string(data.patch);
      const patchState = string(data.state);
      if (id === undefined || patchState === undefined) break;
      const patch = {
        id,
        state: patchState,
        ...(number(data.crop) === undefined ? {} : { crop: number(data.crop)! }),
        ...(number(data.stage) === undefined ? {} : { stage: number(data.stage)! })
      };
      state.farming = {
        patches: [...state.farming.patches.filter((candidate) => candidate.id !== id), patch]
          .sort((left, right) => left.id.localeCompare(right.id))
      };
      break;
    }
    case 'trap-laid':
      if (entity === state.self.entity && number(data.trap) !== undefined && string(data.kind) !== undefined) {
        const id = number(data.trap)!;
        state.hunter = {
          traps: [...state.hunter.traps.filter((trap) => trap.id !== id), {
            id, kind: string(data.kind)!, state: 'armed' as const
          }].sort((left, right) => left.id - right.id)
        };
      }
      break;
    case 'trap-caught':
    case 'trap-collapsed':
      if (entity === state.self.entity && number(data.trap) !== undefined) {
        const id = number(data.trap)!;
        state.hunter = {
          traps: state.hunter.traps.map((trap) => trap.id === id
            ? { ...trap, state: event.type === 'trap-caught' ? 'caught' as const : 'collapsed' as const }
            : trap)
        };
      }
      break;
    case 'familiar-summoned':
      if (entity === state.self.entity && number(data.familiar) !== undefined
        && number(data.pouch) !== undefined && number(data.expiresAt) !== undefined) {
        state.familiar = {
          id: number(data.familiar)!, pouch: number(data.pouch)!, expiresAt: number(data.expiresAt)!
        };
      }
      break;
    case 'familiar-dismissed':
      if (entity === state.self.entity) delete state.familiar;
      break;
    case 'summoning-points':
      if (entity === state.self.entity && number(data.points) !== undefined) {
        state.summoningPoints = number(data.points)!;
      }
      break;
    case 'minigame-lobby': {
      if (!Array.isArray(data.players) || string(data.game) === undefined || string(data.state) === undefined) break;
      const member = data.players.some((player) => isRecord(player) && number(player.entity) === state.self.entity);
      if (!member) break;
      const minigameState = string(data.state)!;
      if (minigameState === 'waiting' || minigameState === 'starting'
        || minigameState === 'running' || minigameState === 'ended') {
        const existing = state.minigame;
        state.minigame = {
          game: string(data.game)!, state: minigameState,
          ...(existing !== undefined && existing.game === data.game && existing.session !== undefined
            ? { session: existing.session } : {})
        };
      }
      break;
    }
    case 'minigame-started':
      if (Array.isArray(data.players) && data.players.some((player) => number(player) === state.self.entity)
        && string(data.game) !== undefined && string(data.session) !== undefined) {
        state.minigame = { game: string(data.game)!, state: 'running', session: string(data.session)! };
      }
      break;
    case 'minigame-event':
      if (state.minigame !== undefined && string(data.game) === state.minigame.game
        && string(data.session) === state.minigame.session && string(data.kind) !== undefined) {
        state.minigame = {
          ...state.minigame,
          event: {
            kind: string(data.kind)!,
            ...(number(data.entity) === undefined ? {} : { entity: number(data.entity)! }),
            ...(data.data === undefined ? {} : { data: data.data as JsonValue })
          }
        };
      }
      break;
    case 'minigame-ended':
      if (state.minigame !== undefined && string(data.game) === state.minigame.game
        && (state.minigame.session === undefined || string(data.session) === state.minigame.session)) {
        state.minigame = {
          game: state.minigame.game, state: 'ended',
          ...(string(data.session) === undefined ? {} : { session: string(data.session)! })
        };
      }
      break;
    case 'clue-step':
      if (entity === state.self.entity && string(data.tier) !== undefined
        && number(data.step) !== undefined && string(data.kind) !== undefined && string(data.text) !== undefined) {
        const tier = string(data.tier)!;
        const kind = string(data.kind)!;
        if ((tier === 'easy' || tier === 'medium' || tier === 'hard')
          && (kind === 'map' || kind === 'coordinate' || kind === 'anagram'
            || kind === 'emote' || kind === 'cryptic')) {
          state.clue = { tier, step: number(data.step)!, kind, text: string(data.text)! };
        }
      }
      break;
    case 'clue-advanced':
      // The advance event has no next kind/text. Clear the completed step until the
      // following clue-step event supplies a coherent replacement (or no event for a casket).
      if (entity === state.self.entity) delete state.clue;
      break;
    case 'clue-complete':
      if (entity === state.self.entity) delete state.clue;
      break;
    case 'random-event-started':
      if (entity === state.self.entity && string(data.event) !== undefined) {
        state.randomEvent = {
          event: string(data.event)!,
          ...(string(data.prompt) === undefined ? {} : { prompt: string(data.prompt)! }),
          ...(Array.isArray(data.options)
            ? { options: data.options.filter((option): option is string => typeof option === 'string') }
            : {})
        };
      }
      break;
    case 'random-event-ended':
      if (entity === state.self.entity
        && (state.randomEvent === undefined || string(data.event) === state.randomEvent.event)) {
        delete state.randomEvent;
      }
      break;
    case 'diary-progress':
      if (entity === state.self.entity && string(data.area) !== undefined && string(data.level) !== undefined
        && number(data.done) !== undefined && number(data.total) !== undefined) {
        const level = string(data.level)!;
        if (level === 'easy' || level === 'medium' || level === 'hard') {
          state.diary = {
            area: string(data.area)!, level,
            done: number(data.done)!, total: number(data.total)!
          };
        }
      }
      break;
    case 'diary-complete':
      if (entity === state.self.entity && state.diary !== undefined
        && string(data.area) === state.diary.area && string(data.level) === state.diary.level) {
        state.diary = { ...state.diary, done: state.diary.total };
      }
      break;
    case 'respawned': {
      if (entity === state.self.entity) {
        const at = tile(data.at);
        state.self = { ...state.self, dead: false, ...(at === undefined ? {} : { at }) };
      }
      break;
    }
    case 'target-lost': {
      const attacker = number(data.attacker);
      if (attacker === state.self.entity) {
        state.self = { ...state.self, combat: { ...state.self.combat, target: undefined, inCombat: false } };
      }
      break;
    }
    case 'retaliate-set':
      if (entity === state.self.entity && typeof data.enabled === 'boolean') {
        state.self = { ...state.self, combat: { ...state.self.combat, autoRetaliate: data.enabled } };
      }
      break;
    case 'spell-effect': {
      const target = number(data.target);
      if (target !== state.self.entity) break;
      if (data.effect === 'bind') {
        state.self = { ...state.self, combat: { ...state.self.combat, bound: true } };
      } else if (data.effect === 'drain'
        && (data.skill === 'attack' || data.skill === 'strength'
          || data.skill === 'defence' || data.skill === 'magic')) {
        const drains = state.self.combat.drains ?? { attack: 0, strength: 0, defence: 0, magic: 0 };
        const amount = number(data.amount);
        if (amount !== undefined) {
          state.self = {
            ...state.self,
            combat: { ...state.self.combat, drains: { ...drains, [data.skill]: drains[data.skill] + amount } }
          };
        }
      }
      break;
    }
    case 'unbound':
      if (entity === state.self.entity) {
        state.self = { ...state.self, combat: { ...state.self.combat, bound: false } };
      }
      break;
    case 'spell-cast':
      break;
    case 'ate':
      if (entity === state.self.entity && isRecord(data.hp)
        && number(data.hp.current) !== undefined && number(data.hp.max) !== undefined) {
        state.self = { ...state.self, hp: { current: number(data.hp.current)!, max: number(data.hp.max)! } };
      }
      break;
    case 'xp-gained':
      if (entity === state.self.entity && typeof data.skill === 'string' && number(data.totalXp) !== undefined) {
        const previous = state.skills[data.skill] ?? { level: 1, xp: 0 };
        state.skills = { ...state.skills, [data.skill]: { ...previous, xp: number(data.totalXp)! } };
      }
      break;
    case 'level-up':
      if (entity === state.self.entity && typeof data.skill === 'string' && number(data.level) !== undefined) {
        const previous = state.skills[data.skill] ?? { level: 1, xp: 0 };
        state.skills = { ...state.skills, [data.skill]: { ...previous, level: number(data.level)! } };
      }
      break;
    case 'item-added':
    case 'item-removed': {
      if (entity !== state.self.entity) break;
      const slot = number(data.slot);
      const item = number(data.item);
      const amount = number(data.amount);
      if (slot === undefined || item === undefined || amount === undefined) markItemDirty(state);
      else if (event.type === 'item-added') addInventoryAtSlot(state, slot, item, amount);
      else removeInventoryAtSlot(state, slot, item, amount);
      break;
    }
    case 'items-dropped':
      if (entity === state.self.entity) markItemDirty(state);
      break;
    case 'equipped':
    case 'unequipped': {
      if (entity !== state.self.entity) break;
      const slot = string(data.slot);
      const item = number(data.item);
      const amount = number(data.amount);
      if (slot === undefined || item === undefined || amount === undefined) markItemDirty(state, true);
      else {
        const equipment = { ...state.equipment };
        if (event.type === 'equipped') equipment[slot] = { item, amount };
        else delete equipment[slot];
        state.equipment = equipment;
      }
      break;
    }
    case 'ground-item-spawned': {
      const id = number(data.id);
      const item = number(data.item);
      const amount = number(data.amount);
      const at = tile(data.at);
      if (id === undefined || item === undefined || amount === undefined || at === undefined) break;
      const distance = distanceBetween(state.self.at, at);
      if (distance > state.radius) break;
      const ground: GroundItemView = {
        id, item, amount, at, distance,
        ...(number(data.owner) === undefined ? {} : { owner: number(data.owner) })
      };
      state.groundItems = [...state.groundItems.filter((candidate) => candidate.id !== id), ground]
        .sort((left, right) => left.distance - right.distance || left.id - right.id);
      break;
    }
    case 'ground-item-picked-up':
    case 'ground-item-despawned': {
      const id = number(data.id);
      if (id !== undefined) state.groundItems = state.groundItems.filter((item) => item.id !== id);
      break;
    }
    case 'ground-item-revealed': {
      const id = number(data.id);
      if (id !== undefined) state.groundItems = state.groundItems.map((item) => item.id === id
        ? { ...item, owner: undefined } : item);
      break;
    }
    case 'trade-opened': {
      const partner = actorInTrade(state, data.a, data.b);
      if (partner !== undefined) state.trade = { partner, stage: 'offer', ownOffer: [], partnerOffer: [] };
      break;
    }
    case 'trade-updated': {
      const partner = number(data.partner);
      if (entity !== state.self.entity && partner !== state.self.entity) break;
      const other = entity === state.self.entity ? partner : entity;
      if (other === undefined) break;
      const prior = state.trade?.partner === other
        ? state.trade
        : { partner: other, stage: 'offer' as const, ownOffer: [], partnerOffer: [] };
      state.trade = entity === state.self.entity
        ? { ...prior, ownOffer: tradeOffer(data.offer) }
        : { ...prior, partnerOffer: tradeOffer(data.offer) };
      break;
    }
    case 'trade-stage': {
      const partner = actorInTrade(state, data.a, data.b);
      if (partner !== undefined && (data.stage === 'offer' || data.stage === 'confirm')) {
        const prior = state.trade?.partner === partner
          ? state.trade
          : { partner, stage: 'offer' as const, ownOffer: [], partnerOffer: [] };
        state.trade = { ...prior, stage: data.stage };
      }
      break;
    }
    case 'trade-completed': {
      if (actorInTrade(state, data.a, data.b) !== undefined) delete state.trade;
      break;
    }
    case 'trade-declined': {
      if (entity === state.self.entity || number(data.partner) === state.self.entity) delete state.trade;
      break;
    }
    case 'chat': {
      if (entity === undefined || typeof data.name !== 'string' || typeof data.text !== 'string'
        || (data.channel !== 'public' && data.channel !== 'pm' && data.channel !== 'clan')) break;
      const channel: 'public' | 'pm' | 'clan' = data.channel;
      state.chat = [...state.chat, {
        entity,
        name: data.name,
        text: data.text,
        channel,
        ...(typeof data.to === 'string' ? { to: data.to } : {}),
        ...(typeof data.clan === 'string' ? { clan: data.clan } : {}),
        tick: event.tick
      }].slice(-20);
      break;
    }
    case 'quest-journal': {
      if (entity !== state.self.entity || !Array.isArray(data.quests) || number(data.questPoints) === undefined) break;
      const journal = data.quests.flatMap((entry) => {
        if (!isRecord(entry) || string(entry.quest) === undefined || string(entry.name) === undefined
          || number(entry.stage) === undefined || typeof entry.complete !== 'boolean') return [];
        return [{
          quest: string(entry.quest)!,
          stage: number(entry.stage)!,
          name: string(entry.name)!,
          complete: entry.complete as boolean
        }];
      });
      state.quests = { journal, questPoints: number(data.questPoints)! };
      break;
    }
    case 'quest-stage': {
      if (entity !== state.self.entity || string(data.quest) === undefined || number(data.stage) === undefined) break;
      const quest = string(data.quest)!;
      const prior = state.quests.journal.find((entry) => entry.quest === quest);
      const entry = {
        quest,
        stage: number(data.stage)!,
        name: prior?.name ?? quest,
        complete: prior?.complete ?? false,
        ...(string(data.journal) === undefined ? {} : { journal: string(data.journal)! })
      };
      state.quests = {
        ...state.quests,
        journal: [...state.quests.journal.filter((candidate) => candidate.quest !== quest), entry]
          .sort((left, right) => left.quest.localeCompare(right.quest))
      };
      break;
    }
    case 'quest-complete': {
      if (entity !== state.self.entity || string(data.quest) === undefined || number(data.questPoints) === undefined) break;
      const quest = string(data.quest)!;
      const prior = state.quests.journal.find((entry) => entry.quest === quest);
      const completed = {
        quest,
        stage: prior?.stage ?? 0,
        name: prior?.name ?? quest,
        complete: true,
        ...(prior?.journal === undefined ? {} : { journal: prior.journal })
      };
      state.quests = {
        questPoints: state.quests.questPoints + number(data.questPoints)!,
        journal: [...state.quests.journal.filter((entry) => entry.quest !== quest), completed]
          .sort((left, right) => left.quest.localeCompare(right.quest))
      };
      break;
    }
    case 'slayer-assigned':
      if (entity === state.self.entity && string(data.task) !== undefined && number(data.amount) !== undefined) {
        state.slayer = { task: string(data.task)!, remaining: number(data.amount)! };
      }
      break;
    case 'slayer-kill':
      if (entity === state.self.entity && string(data.task) !== undefined && number(data.remaining) !== undefined) {
        state.slayer = { task: string(data.task)!, remaining: number(data.remaining)! };
      }
      break;
    case 'slayer-complete':
      if (entity === state.self.entity) state.slayer = { remaining: 0 };
      break;
    case 'friends-updated':
      if (entity === state.self.entity && Array.isArray(data.friends) && Array.isArray(data.ignored)) {
        state.social = {
          ...state.social,
          friends: data.friends.filter((name): name is string => typeof name === 'string'),
          ignored: data.ignored.filter((name): name is string => typeof name === 'string')
        };
      }
      break;
    case 'clan-updated': {
      if (entity !== state.self.entity) break;
      if (data.clan === undefined) {
        const { clan: _clan, ...social } = state.social;
        state.social = social;
        break;
      }
      if (!isRecord(data.clan) || string(data.clan.name) === undefined
        || string(data.clan.owner) === undefined || !Array.isArray(data.clan.members)) break;
      const members = data.clan.members.flatMap((member) => !isRecord(member)
        || string(member.name) === undefined || number(member.rank) === undefined
        ? [] : [{ name: string(member.name)!, rank: number(member.rank)! }]);
      state.social = {
        ...state.social,
        clan: { name: string(data.clan.name)!, owner: string(data.clan.owner)!, members }
      };
      break;
    }
    case 'node-depleted':
    case 'node-respawned':
      if (typeof data.node === 'string') setNodeDepleted(state, data.node, event.type === 'node-depleted');
      break;
    case 'fire-lit': {
      const at = tile(data.at);
      if (at !== undefined && distanceBetween(state.self.at, at) <= state.radius) {
        addHeatSource(state, { kind: 'fire', id: `fire-${event.seq}`, at, distance: distanceBetween(state.self.at, at) });
      }
      break;
    }
    case 'fire-expired': {
      const id = string(data.id);
      const at = tile(data.at);
      state.heatSources = state.heatSources.filter((source) =>
        (id === undefined || source.id !== id)
        && (at === undefined || distanceBetween(source.at, at) !== 0));
      break;
    }
    case 'gather-stopped':
    case 'fishing-stopped':
    case 'firemaking-stopped':
    case 'cooking-stopped':
    case 'smelt-failed':
    case 'smithing-stopped':
    case 'crafting-stopped':
    case 'pickpocket-failed':
    case 'stall-caught':
    case 'obstacle-failed':
      setIdle(state, entity);
      break;
    case 'dialogue-started':
      if (entity === state.self.entity) {
        state.dialogue = { active: true };
        state.self = { ...state.self, activity: { kind: 'dialogue', since: event.tick } };
      }
      break;
    case 'dialogue-node':
      if (entity === state.self.entity) {
        const kind = string(data.kind);
        state.dialogue = {
          active: true,
          ...(number(data.npc) === undefined ? {} : { npc: number(data.npc) }),
          ...(string(data.speakerTag) === undefined ? {} : { speaker: string(data.speakerTag) }),
          ...(string(data.text) === undefined && string(data.prompt) === undefined
            ? {} : { text: string(data.text) ?? string(data.prompt) }),
          ...(kind === 'choice' && Array.isArray(data.options)
            ? { options: data.options.filter((option): option is string => typeof option === 'string') }
            : {})
        };
        state.self = { ...state.self, activity: { kind: 'dialogue', since: event.tick } };
      }
      break;
    case 'dialogue-ended':
      if (entity === state.self.entity) {
        state.dialogue = { active: false };
        state.self = { ...state.self, activity: { kind: 'idle' } };
      }
      break;
    case 'objective-complete':
      if (typeof data.objective === 'string'
        && (data.actorTag === undefined || data.actorTag === state.self.tag)
        && (data.outcome === 'win' || data.outcome === 'lose' || data.outcome === 'progress')) {
        updateObjective(state, data.objective, data.outcome);
      }
      break;
    case 'scenario-won':
      state.won = true;
      if (typeof data.objective === 'string') updateObjective(state, data.objective, 'win');
      break;
    case 'scenario-lost':
      state.lost = true;
      if (typeof data.objective === 'string') updateObjective(state, data.objective, 'lose');
      break;
    case 'scenario-message':
      if (typeof data.text === 'string') {
        state.messages.push(data.text);
        if (state.messages.length > 256) state.messages.splice(0, state.messages.length - 256);
      }
      break;
    case 'prayer-toggled':
      if (entity === state.self.entity && typeof data.prayer === 'string' && typeof data.active === 'boolean') {
        const prior = state.self.prayer ?? { points: 0, maxPoints: 0, active: [] };
        const active = data.active
          ? [...new Set([...prior.active, data.prayer])].sort()
          : prior.active.filter((prayer) => prayer !== data.prayer);
        state.self = { ...state.self, prayer: { ...prior, active } };
      }
      break;
    case 'prayer-points':
      if (entity === state.self.entity && number(data.points) !== undefined) {
        const prior = state.self.prayer ?? { points: 0, maxPoints: 0, active: [] };
        state.self = { ...state.self, prayer: { ...prior, points: number(data.points)! } };
      }
      break;
    case 'prayers-depleted':
      if (entity === state.self.entity) {
        const prior = state.self.prayer ?? { points: 0, maxPoints: 0, active: [] };
        state.self = { ...state.self, prayer: { ...prior, points: 0, active: [] } };
      }
      break;
    default:
      break;
  }
}

function actionNumber(data: Readonly<Record<string, unknown>>, key: string): number | undefined {
  return number(data[key]);
}

export function foldActionOutcome(state: MutableWorldState, outcome: AcceptedAction): void {
  if (!outcome.ok) return;
  const { type, data } = outcome;
  const since = outcome.tick;
  let activity: Activity | undefined;
  if (type === 'walk' || type === 'run') {
    const dest = tile(data.dest);
    if (dest !== undefined) {
      activity = { kind: 'walking', dest, since };
      state.lastSelfMovedTick = since;
    }
  } else if (type === 'attack' || type === 'cast') {
    const target = actionNumber(data, 'target');
    if (target !== undefined) activity = { kind: 'fighting', target, since };
  } else if (type === 'gather') {
    const node = string(data.node);
    if (node !== undefined) activity = { kind: 'gathering', node, since };
  } else if (type === 'fish') {
    const spot = actionNumber(data, 'spot');
    if (spot !== undefined) activity = { kind: 'fishing', spot, since };
  } else if (type === 'cook') activity = { kind: 'producing', what: 'cooking', since };
  else if (type === 'smelt' || type === 'smith') activity = { kind: 'producing', what: 'smithing', since };
  else if (type === 'craft') activity = { kind: 'producing', what: 'crafting', since };
  else if (type === 'light') activity = { kind: 'producing', what: 'firemaking', since };
  else if (type === 'pickpocket' || type === 'steal-stall') activity = { kind: 'thieving', since };
  else if (type === 'traverse') activity = { kind: 'agility', since };
  else if (type === 'talk') activity = { kind: 'dialogue', since };
  else if (type === 'disengage' || type.startsWith('stop-')) activity = { kind: 'idle' };
  if (type === 'set-style') {
    const style = string(data.style);
    const attackStyle = string(data.attackStyle);
    if (style !== undefined && attackStyle !== undefined) {
      const spell = string(data.spell);
      state.self = {
        ...state.self,
        combat: {
          ...state.self.combat,
          style: { style, attackStyle, ...(spell === undefined ? {} : { spell }) }
        }
      };
    }
  } else if (type === 'cast') {
    const spell = string(data.spell);
    if (spell !== undefined) {
      state.self = {
        ...state.self,
        combat: { ...state.self.combat, style: { style: 'magic', attackStyle: 'cast', spell } }
      };
    }
  } else if (type === 'special' && typeof data.enabled === 'boolean') {
    setStatus(state, (status) => ({ ...status, specialEnabled: data.enabled as boolean }));
  } else if (type === 'set-run' && typeof data.enabled === 'boolean') {
    setStatus(state, (status) => ({ ...status, runEnabled: data.enabled as boolean }));
  }
  if (activity !== undefined) state.self = { ...state.self, activity };
}
