import type { EntityId, EntityKind, ItemConfigId, LocConfigId, NpcConfigId, SkillName } from './ids.ts';
import type { TileCoord, Tick } from './coords.ts';
import type { DoorState } from './doors.ts';
import type { JsonValue } from './sim.ts';
import type {
  AttackStyleName,
  CombatStyleName,
  ClimbDirection,
  EquipmentSlotName,
  GeOfferKind,
  GeOfferStatus,
  PrayerId,
  SpellId,
  InteractTarget,
  FarmAction,
  ClueTier
} from './simCommands.ts';

/**
 * The full simulation event catalogue as a typed map (see ADR-0019).
 *
 * Every event the simulation can emit, with its exact payload. Previously
 * `ServerEvent.data` was `unknown`, which made the event stream unusable as a
 * world-model prediction target and forced every consumer to re-derive shapes
 * from prose.
 *
 * `SimEventMap` is the single source of truth; `SimEvent` is the discriminated
 * union over it. packages/sim owns an exhaustive test asserting every `emit()`
 * call site in the monorepo has a matching entry here.
 *
 * Events are also the natural sparse factorization of a state delta: predicting
 * "which of these fired, with what operands" is far better conditioned than
 * regressing raw WorldState.
 */

export type GroundItemId = number;

/** Slot layout used by equip/unequip events. */
export type EquipSlotName = EquipmentSlotName;

export interface ShopStockView {
  readonly item: ItemConfigId;
  readonly amount: number;
  readonly baseAmount: number;
  readonly buyPrice: number;
  readonly sellPrice: number;
}

export interface GeCollectItem {
  readonly item: ItemConfigId;
  readonly amount: number;
}

export interface GeOfferView {
  readonly slot: number;
  readonly kind: GeOfferKind;
  readonly item: ItemConfigId;
  readonly quantity: number;
  readonly price: number;
  readonly filled: number;
  readonly coinsMoved: number;
  readonly status: GeOfferStatus;
  readonly placedTick: number;
  readonly collect: readonly GeCollectItem[];
}

export interface GeView {
  readonly entity: EntityId;
  readonly slots: readonly (GeOfferView | null)[];
}

// ---------------------------------------------------------------------------
// Sub-shapes for events whose payload varies
// ---------------------------------------------------------------------------

/**
 * NOTE (serialization hazard): the melee path in packages/combat defines
 * `style`/`attackStyle` as NON-ENUMERABLE when attackStyle is 'accurate', so
 * they vanish from the JSON wire payload while remaining present in-process.
 * packages/sim normalizes this: both fields are always enumerable on the
 * SimEvent stream. Do not reintroduce the non-enumerable form; it makes the
 * in-process and serialized event logs differ, which breaks replay equality.
 */
export type HitEvent =
  | {
      readonly attacker: EntityId;
      readonly target: EntityId;
      readonly damage: number;
      readonly hpAfter: number;
      readonly style: CombatStyleName;
      readonly attackStyle: AttackStyleName;
    }
  | {
      readonly attacker: EntityId;
      readonly target: EntityId;
      readonly damage: number;
      readonly hpAfter: number;
      readonly style: CombatStyleName;
      readonly attackStyle: AttackStyleName;
      /** Projectile/spell flight time in ticks. */
      readonly delay: number;
      readonly spell?: SpellId;
      readonly splash?: boolean;
    };

export type SwingEvent =
  | {
      readonly attacker: EntityId;
      readonly target: EntityId;
      readonly style: CombatStyleName;
      readonly attackStyle: AttackStyleName;
    }
  | {
      readonly attacker: EntityId;
      readonly target: EntityId;
      readonly style: 'range' | 'magic';
      readonly attackStyle: AttackStyleName;
      readonly delay: number;
      readonly spell?: SpellId;
    };

export type DialogueNodeEvent =
  | {
      readonly entity: EntityId;
      readonly dialogue: string;
      readonly nodeId: string;
      readonly kind: 'npc';
      readonly speakerTag: string;
      readonly text: string;
    }
  | {
      readonly entity: EntityId;
      readonly dialogue: string;
      readonly nodeId: string;
      readonly kind: 'player';
      readonly text: string;
    }
  | {
      readonly entity: EntityId;
      readonly dialogue: string;
      readonly nodeId: string;
      readonly kind: 'choice';
      readonly prompt?: string;
      readonly options: readonly string[];
    };

export type SimErrorEvent =
  | { readonly name: string; readonly message: string }
  | {
      readonly source: 'scenario-engine';
      readonly code: 'trigger-cascade-depth';
      readonly depth: number;
    };

export type CraftingStopReason = 'done' | 'out_of_materials' | 'inventory_full' | 'level_too_low';
export type SmithingStopReason = 'out_of_materials' | 'inventory_full';

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export interface SimEventMap {
  /* -- engine ------------------------------------------------------------- */
  /** Heartbeat; emitted only when tick % 100 === 0. Not a per-step marker. */
  'tick': Record<string, never>;
  'instance-ended': { readonly reason: string };
  /**
   * A chunk (one 64x64 map square) began simulating because a player entered it or its
   * activation ring. Clients use this to stream that region's terrain in. See ADR 0027.
   */
  'chunk-activated': {
    readonly regionId: number;
    readonly baseX: number;
    readonly baseZ: number;
    /** Thawed NPC entities restored with this chunk. */
    readonly npcs: number;
  };
  /** A chunk stopped simulating; its NPCs are frozen, not destroyed. Clients may unload it. */
  'chunk-deactivated': { readonly regionId: number; readonly baseX: number; readonly baseZ: number };
  'error': SimErrorEvent;

  /* -- entities ----------------------------------------------------------- */
  'entity-spawned': {
    readonly entity: EntityId;
    readonly kind: EntityKind;
    readonly at: TileCoord;
    readonly npc?: NpcConfigId;
    readonly loc?: LocConfigId;
    readonly fishingOptions?: readonly string[];
    readonly options?: readonly string[];
    readonly name?: string;
  };
  'entity-renamed': { readonly entity: EntityId; readonly name: string };
  'entity-despawned': { readonly entity: EntityId };
  'entity-moved': { readonly entity: EntityId; readonly at: TileCoord };

  /* -- movement ----------------------------------------------------------- */
  'moved': {
    readonly entity: EntityId;
    readonly from: TileCoord;
    readonly to: TileCoord;
    readonly running: boolean;
  };
  'move-blocked': { readonly entity: EntityId; readonly at: TileCoord; readonly dest: TileCoord };
  'move-rejected': { readonly entity: EntityId; readonly dest: TileCoord };
  'teleported': { readonly entity: EntityId; readonly from: TileCoord; readonly to: TileCoord };
  'climbed': {
    readonly entity: EntityId;
    readonly loc: LocConfigId;
    readonly from: TileCoord;
    readonly to: TileCoord;
    readonly direction: ClimbDirection;
  };
  /**
   * One or two door leaves changed state (a double door emits both leaves in one event).
   * `open` is the resulting state. `entity` is the actor who toggled it, or absent when the
   * server auto-closed the door after its timeout.
   */
  'door-changed': {
    readonly entity?: EntityId;
    readonly open: boolean;
    readonly leaves: readonly DoorState[];
  };

  /* -- combat ------------------------------------------------------------- */
  'swing': SwingEvent;
  'swing-blocked': {
    readonly attacker: EntityId;
    readonly target: EntityId;
    readonly reason: 'line-of-sight';
  };
  'hit': HitEvent;
  'dragonfire': {
    readonly attacker: EntityId;
    readonly target: EntityId;
    readonly damage: number;
    readonly mitigated: readonly ('shield' | 'antifire' | 'prayer')[];
  };
  'bolt-proc': {
    readonly attacker: EntityId;
    readonly target: EntityId;
    readonly bolt: ItemConfigId;
    readonly effect: 'opal' | 'sapphire' | 'emerald' | 'ruby' | 'diamond' | 'dragonstone' | 'onyx';
  };
  'damaged': { readonly entity: EntityId; readonly amount: number; readonly health: number };
  /** `killer` is absent for non-combat deaths. */
  'died': { readonly entity: EntityId; readonly killer?: EntityId };
  'actor-eliminated': {
    readonly entity: EntityId;
    readonly actorTag: string;
    readonly tick: Tick;
    readonly killer?: EntityId;
  };
  /** A dead player actor re-entered the world under its original entity id. */
  'respawned': { readonly entity: EntityId; readonly at: TileCoord };
  'target-lost': { readonly attacker: EntityId; readonly target: EntityId };
  'retaliate-set': { readonly entity: EntityId; readonly enabled: boolean };
  'poisoned': { readonly entity: EntityId; readonly severity: number; readonly source?: EntityId };
  'poison-damage': { readonly entity: EntityId; readonly damage: number; readonly severity: number };
  'poison-cured': { readonly entity: EntityId; readonly reason: 'cured' | 'expired' };
  'special-energy': { readonly entity: EntityId; readonly energy: number };
  'special-toggled': { readonly entity: EntityId; readonly enabled: boolean };
  'special-attack': {
    readonly attacker: EntityId;
    readonly target: EntityId;
    readonly weapon: ItemConfigId;
    readonly special: string;
    readonly energyCost: number;
  };

  /* -- magic -------------------------------------------------------------- */
  /**
   * A non-combat spell resolved successfully (teleport, alchemy, enchant, superheat,
   * bones conversion, telekinetic grab). Combat casts emit `swing`/`hit` instead.
   * `xp` is the magic XP awarded. Item/ground-item targets are echoed when present.
   */
  'spell-cast': {
    readonly entity: EntityId;
    readonly spell: SpellId;
    readonly xp: number;
    readonly item?: ItemConfigId;
    readonly groundItem?: number;
  };
  'alchemised': {
    readonly entity: EntityId;
    readonly spell: SpellId;
    readonly item: ItemConfigId;
    readonly coins: number;
  };
  'enchanted': {
    readonly entity: EntityId;
    readonly spell: SpellId;
    readonly item: ItemConfigId;
    readonly product: ItemConfigId;
  };
  'bones-converted': {
    readonly entity: EntityId;
    readonly spell: SpellId;
    readonly product: ItemConfigId;
    readonly amount: number;
  };
  /**
   * A curse landed. `drain` lowers the target's current combat level by `amount` for `skill`;
   * `bind` freezes movement for `ticks`.
   */
  'spell-effect':
    | {
        readonly attacker: EntityId;
        readonly target: EntityId;
        readonly spell: SpellId;
        readonly effect: 'drain';
        readonly skill: 'attack' | 'strength' | 'defence' | 'magic';
        readonly amount: number;
      }
    | {
        readonly attacker: EntityId;
        readonly target: EntityId;
        readonly spell: SpellId;
        readonly effect: 'drain-prayer';
        readonly amount: number;
      }
    | {
        readonly attacker: EntityId;
        readonly target: EntityId;
        readonly spell: SpellId;
        readonly effect: 'bind';
        readonly ticks: number;
      };
  /** A bind/snare/entangle expired and the entity may move again. */
  'unbound': { readonly entity: EntityId };

  /* -- prayer ------------------------------------------------------------- */
  'prayer-toggled': { readonly entity: EntityId; readonly prayer: PrayerId; readonly active: boolean };
  'prayer-points': { readonly entity: EntityId; readonly points: number };
  'prayers-depleted': { readonly entity: EntityId };
  'buried': { readonly entity: EntityId; readonly item: ItemConfigId; readonly xp: number };

  /* -- skills / xp -------------------------------------------------------- */
  /**
   * Emitted by SkillState and, when CombatSystemOptions.awardXp !== false, by
   * CombatSystem's own ledger. A host wiring both double-emits; packages/sim
   * asserts exactly one emitter is active.
   */
  'xp-gained': {
    readonly entity: EntityId;
    readonly skill: SkillName;
    readonly amount: number;
    readonly totalXp: number;
  };
  'level-up': { readonly entity: EntityId; readonly skill: SkillName; readonly level: number };
  'stat-boosted': {
    readonly entity: EntityId;
    readonly skill: SkillName;
    readonly delta: number;
    readonly current: number;
    readonly base: number;
  };
  'stat-restored': {
    readonly entity: EntityId;
    readonly skill: SkillName;
    readonly current: number;
    readonly base: number;
  };

  /* -- gathering ---------------------------------------------------------- */
  'gathered': {
    readonly entity: EntityId;
    readonly node: string;
    readonly item: ItemConfigId;
    readonly xp: number;
  };
  'gather-stopped': {
    readonly entity: EntityId;
    readonly node: string;
    readonly reason: 'not_adjacent' | 'missing_tool' | 'depleted' | 'inventory_full';
  };
  'node-depleted': { readonly node: string };
  'node-respawned': { readonly node: string };

  /* -- fishing ------------------------------------------------------------ */
  'fished': {
    readonly entity: EntityId;
    readonly spot: NpcConfigId;
    readonly item: ItemConfigId;
    readonly xp: number;
  };
  'fishing-stopped': {
    readonly entity: EntityId;
    readonly spot: NpcConfigId;
    readonly reason: 'missing_bait' | 'inventory_full';
  };

  /* -- firemaking / cooking ----------------------------------------------- */
  'fire-lit': {
    readonly entity: EntityId;
    readonly at: TileCoord;
    readonly xp: number;
    readonly expiresAtTick: Tick;
  };
  'fire-expired': { readonly id: string; readonly at: TileCoord };
  'firemaking-stopped': {
    readonly entity: EntityId;
    readonly at: TileCoord;
    readonly reason: 'tile_occupied';
  };
  'cooked': { readonly entity: EntityId; readonly item: ItemConfigId; readonly xp: number };
  'burnt': { readonly entity: EntityId; readonly item: ItemConfigId };
  'cooking-stopped': {
    readonly entity: EntityId;
    readonly raw: ItemConfigId;
    readonly reason: 'done' | 'inventory_full';
  };
  'ate': {
    readonly entity: EntityId;
    readonly item: ItemConfigId;
    readonly heal: number;
    readonly hp: { readonly current: number; readonly max: number };
  };
  'drank': {
    readonly entity: EntityId;
    readonly item: ItemConfigId;
    readonly product?: ItemConfigId;
  };

  /* -- run energy, zones, and death ------------------------------------- */
  'run-energy': { readonly entity: EntityId; readonly energy: number; readonly weight: number };
  'run-toggled': { readonly entity: EntityId; readonly enabled: boolean };
  'skulled': { readonly entity: EntityId; readonly until: Tick };
  'skull-expired': { readonly entity: EntityId };
  'zone-entered': { readonly entity: EntityId; readonly zone: string; readonly tags: string[] };
  'zone-left': { readonly entity: EntityId; readonly zone: string };
  'items-lost-on-death': {
    readonly entity: EntityId;
    readonly kept: readonly { readonly item: ItemConfigId; readonly amount: number }[];
    readonly dropped: readonly { readonly item: ItemConfigId; readonly amount: number }[];
    readonly killer?: EntityId;
  };
  'grave-spawned': {
    readonly entity: EntityId;
    readonly owner: EntityId;
    readonly at: TileCoord;
    readonly expiresAt: Tick;
  };
  'grave-expired': { readonly entity: EntityId; readonly owner: EntityId };

  /* -- runecrafting ------------------------------------------------------ */
  'runes-crafted': {
    readonly entity: EntityId;
    readonly rune: ItemConfigId;
    readonly amount: number;
    readonly xp: number;
  };
  'ruin-entered': { readonly entity: EntityId; readonly altar: string };
  'pouch-filled': { readonly entity: EntityId; readonly pouch: ItemConfigId; readonly essence: number };
  'pouch-emptied': { readonly entity: EntityId; readonly pouch: ItemConfigId; readonly essence: number };

  /* -- smithing ----------------------------------------------------------- */
  'smelted': { readonly entity: EntityId; readonly bar: ItemConfigId; readonly xp: number };
  'smelt-failed': { readonly entity: EntityId; readonly bar: ItemConfigId };
  'smithed': {
    readonly entity: EntityId;
    readonly product: ItemConfigId;
    readonly quantity: number;
    readonly xp: number;
  };
  'smithing-stopped': { readonly entity: EntityId; readonly reason: SmithingStopReason };

  /* -- crafting ----------------------------------------------------------- */
  'crafted': {
    readonly entity: EntityId;
    readonly product: ItemConfigId;
    readonly quantity: number;
    readonly xp: number;
  };
  'crafting-stopped': { readonly entity: EntityId; readonly reason: CraftingStopReason };

  /* -- fletching / herblore ----------------------------------------------- */
  'fletched': {
    readonly entity: EntityId;
    readonly product: ItemConfigId;
    readonly amount: number;
    readonly xp: number;
  };
  'fletching-stopped': { readonly entity: EntityId; readonly reason: string };
  'herb-cleaned': {
    readonly entity: EntityId;
    readonly herb: ItemConfigId;
    readonly product: ItemConfigId;
    readonly xp: number;
  };
  'potion-made': { readonly entity: EntityId; readonly product: ItemConfigId; readonly xp: number };
  'herblore-stopped': { readonly entity: EntityId; readonly reason: string };

  /* -- thieving ----------------------------------------------------------- */
  'pickpocketed': { readonly entity: EntityId; readonly npc: NpcConfigId; readonly xp: number };
  'pickpocket-failed': {
    readonly entity: EntityId;
    readonly npc: NpcConfigId;
    readonly damage: number;
    readonly stunTicks: number;
  };
  'stall-theft': {
    readonly entity: EntityId;
    readonly stall: string;
    readonly item: ItemConfigId;
    readonly xp: number;
  };
  'stall-caught': { readonly entity: EntityId; readonly stall: string };
  'stall-respawned': { readonly stall: string };

  /* -- agility ------------------------------------------------------------ */
  'obstacle-completed': {
    readonly entity: EntityId;
    readonly course: string;
    readonly obstacle: number;
    readonly xp: number;
  };
  'obstacle-failed': {
    readonly entity: EntityId;
    readonly course: string;
    readonly obstacle: number;
    readonly damage: number;
  };
  'course-completed': { readonly entity: EntityId; readonly course: string; readonly xp: number };

  /* -- items -------------------------------------------------------------- */
  'item-added': {
    readonly entity: EntityId;
    readonly item: ItemConfigId;
    /** Amount actually added after capacity clamping. */
    readonly amount: number;
    readonly overflow: number;
  };
  'item-removed': { readonly entity: EntityId; readonly item: ItemConfigId; readonly amount: number };
  'items-dropped': {
    readonly entity: EntityId;
    readonly items: readonly { readonly item: ItemConfigId; readonly amount: number }[];
  };
  'equipped': { readonly entity: EntityId; readonly item: ItemConfigId; readonly slot: EquipSlotName };
  'unequipped': { readonly entity: EntityId; readonly item: ItemConfigId; readonly slot: EquipSlotName };

  /* -- ground items ------------------------------------------------------- */
  'ground-item-spawned': {
    readonly id: GroundItemId;
    readonly item: ItemConfigId;
    readonly amount: number;
    readonly at: TileCoord;
    /** Killer for loot drops; the only actor link between a kill and its loot. */
    readonly owner: EntityId | undefined;
  };
  'ground-item-picked-up': {
    readonly entity: EntityId;
    readonly id: GroundItemId;
    readonly item: ItemConfigId;
    readonly amount: number;
  };
  'ground-item-revealed': { readonly id: GroundItemId };
  'ground-item-despawned': { readonly id: GroundItemId };
  'interacted': {
    readonly entity: EntityId;
    readonly target: InteractTarget;
    readonly option: string;
    readonly handler: string;
  };
  'item-used': {
    readonly entity: EntityId;
    readonly item: ItemConfigId;
    readonly target: InteractTarget;
    readonly handler: string;
  };

  /* -- shops -------------------------------------------------------------- */
  'shop-viewed': {
    readonly title: string;
    readonly currency: ItemConfigId;
    readonly stock: readonly ShopStockView[];
    readonly playerStock: readonly ShopStockView[];
  };
  'shop-bought': {
    readonly entity: EntityId;
    readonly item: ItemConfigId;
    readonly amount: number;
    readonly total: number;
  };
  'shop-sold': {
    readonly entity: EntityId;
    readonly item: ItemConfigId;
    readonly amount: number;
    readonly total: number;
  };

  /* -- Grand Exchange ----------------------------------------------------- */
  'ge-viewed': GeView;
  'ge-price': { readonly entity: EntityId; readonly item: ItemConfigId; readonly guidePrice: number };
  'ge-offer-placed': { readonly entity: EntityId; readonly offer: GeOfferView };
  'ge-offer-filled': {
    readonly entity: EntityId;
    readonly slot: number;
    readonly item: ItemConfigId;
    readonly amount: number;
    readonly price: number;
    readonly filled: number;
    readonly quantity: number;
    readonly completed: boolean;
  };
  'ge-offer-aborted': { readonly entity: EntityId; readonly slot: number };
  'ge-collected': {
    readonly entity: EntityId;
    readonly slot: number;
    readonly items: readonly GeCollectItem[];
    readonly freed: boolean;
  };

  /* -- trade -------------------------------------------------------------- */
  'trade-requested': { readonly entity: EntityId; readonly target: EntityId };
  'trade-opened': { readonly a: EntityId; readonly b: EntityId };
  'trade-updated': {
    readonly entity: EntityId;
    readonly partner: EntityId;
    readonly offer: readonly { readonly item: ItemConfigId; readonly amount: number }[];
  };
  'trade-stage': {
    readonly a: EntityId;
    readonly b: EntityId;
    readonly stage: 'offer' | 'confirm';
  };
  'trade-completed': {
    readonly a: EntityId;
    readonly b: EntityId;
    readonly aGave: readonly { readonly item: ItemConfigId; readonly amount: number }[];
    readonly bGave: readonly { readonly item: ItemConfigId; readonly amount: number }[];
  };
  'trade-declined': {
    readonly entity: EntityId;
    readonly partner: EntityId;
    readonly reason: 'declined' | 'walked_away' | 'inventory_full' | 'disconnected';
  };

  /* -- dialogue ----------------------------------------------------------- */
  'dialogue-started': { readonly entity: EntityId; readonly dialogue: string };
  'dialogue-node': DialogueNodeEvent;
  'dialogue-ended': { readonly entity: EntityId; readonly dialogue: string };

  /* -- quests ------------------------------------------------------------- */
  'quest-stage': {
    readonly entity: EntityId;
    readonly quest: string;
    readonly stage: number;
    readonly journal: string;
  };
  'quest-complete': { readonly entity: EntityId; readonly quest: string; readonly questPoints: number };
  'quest-journal': {
    readonly entity: EntityId;
    readonly quests: readonly {
      readonly quest: string;
      readonly stage: number;
      readonly name: string;
      readonly complete: boolean;
    }[];
    readonly questPoints: number;
  };
  'flag-set': {
    readonly entity: EntityId;
    readonly flag: string;
    readonly value: boolean | number | string;
  };

  /* -- slayer ------------------------------------------------------------- */
  'slayer-assigned': {
    readonly entity: EntityId;
    readonly master: EntityId;
    readonly task: string;
    readonly npcs: readonly number[];
    readonly amount: number;
  };
  'slayer-kill': { readonly entity: EntityId; readonly task: string; readonly remaining: number };
  'slayer-complete': {
    readonly entity: EntityId;
    readonly task: string;
    readonly points: number;
    readonly streak: number;
  };
  'slayer-rewarded': { readonly entity: EntityId; readonly reward: string; readonly cost: number };

  /* -- transport ---------------------------------------------------------- */
  'travelled': {
    readonly entity: EntityId;
    readonly network: 'fairy-ring' | 'ship' | 'charter' | 'glider' | 'spirit-tree' | 'canoe' | 'jewellery' | 'tablet';
    readonly from: TileCoord;
    readonly to: TileCoord;
    readonly destination: string;
  };
  'travel-denied': {
    readonly entity: EntityId;
    readonly network: 'fairy-ring' | 'ship' | 'charter' | 'glider' | 'spirit-tree' | 'canoe' | 'jewellery' | 'tablet';
    readonly reason: string;
  };

  /* -- social ------------------------------------------------------------- */
  'chat': {
    readonly entity: EntityId;
    readonly name: string;
    readonly text: string;
    readonly channel: 'public' | 'pm' | 'clan';
    readonly to?: string;
    readonly clan?: string;
  };
  'friends-updated': {
    readonly entity: EntityId;
    readonly friends: readonly string[];
    readonly ignored: readonly string[];
  };
  'clan-updated': {
    readonly entity: EntityId;
    readonly clan?: {
      readonly name: string;
      readonly owner: string;
      readonly members: readonly { readonly name: string; readonly rank: number }[];
    };
  };

  /* -- farming ----------------------------------------------------------- */
  'patch-changed': {
    readonly entity?: EntityId;
    readonly patch: string;
    readonly at: TileCoord;
    readonly state: string;
    readonly crop?: ItemConfigId;
    readonly stage?: number;
    readonly diseased?: boolean;
    readonly dead?: boolean;
  };
  farmed: {
    readonly entity: EntityId;
    readonly patch: string;
    readonly action: FarmAction;
    readonly item?: ItemConfigId;
    readonly xp: number;
  };
  harvested: {
    readonly entity: EntityId;
    readonly patch: string;
    readonly item: ItemConfigId;
    readonly amount: number;
    readonly xp: number;
  };

  /* -- hunter ------------------------------------------------------------ */
  'trap-laid': { readonly entity: EntityId; readonly trap: EntityId; readonly kind: string };
  'trap-caught': { readonly entity: EntityId; readonly trap: EntityId; readonly catch: ItemConfigId };
  'trap-collapsed': { readonly entity: EntityId; readonly trap: EntityId };
  hunted: { readonly entity: EntityId; readonly item: ItemConfigId; readonly xp: number };

  /* -- summoning --------------------------------------------------------- */
  'familiar-summoned': {
    readonly entity: EntityId;
    readonly familiar: EntityId;
    readonly pouch: ItemConfigId;
    readonly expiresAt: Tick;
  };
  'familiar-dismissed': {
    readonly entity: EntityId;
    readonly familiar: EntityId;
    readonly reason: string;
  };
  'summoning-points': { readonly entity: EntityId; readonly points: number; readonly max: number };
  'familiar-special': {
    readonly entity: EntityId;
    readonly familiar: EntityId;
    readonly scroll: ItemConfigId;
    readonly effect: string;
  };
  'bob-updated': {
    readonly entity: EntityId;
    readonly familiar: EntityId;
    readonly items: readonly { readonly item: ItemConfigId; readonly amount: number }[];
  };

  /* -- breadth and minigames -------------------------------------------- */
  prospected: { readonly entity: EntityId; readonly node: string; readonly ore: ItemConfigId };
  'minigame-lobby': {
    readonly game: string;
    readonly players: readonly { readonly entity: EntityId; readonly ready: boolean }[];
    readonly state: 'waiting' | 'starting' | 'running' | 'ended';
  };
  'minigame-started': {
    readonly game: string;
    readonly session: string;
    readonly players: readonly EntityId[];
  };
  'minigame-ended': {
    readonly game: string;
    readonly session: string;
    readonly winner?: EntityId;
    readonly scores: readonly { readonly entity: EntityId; readonly score: number }[];
  };
  'minigame-event': {
    readonly game: string;
    readonly session: string;
    readonly entity?: EntityId;
    readonly kind: string;
    readonly data?: JsonValue;
  };
  'duel-stake': {
    readonly a: EntityId;
    readonly b: EntityId;
    readonly aStake: readonly { readonly item: ItemConfigId; readonly amount: number }[];
    readonly bStake: readonly { readonly item: ItemConfigId; readonly amount: number }[];
    readonly rules: readonly string[];
  };

  /* -- activities -------------------------------------------------------- */
  'clue-step': {
    readonly entity: EntityId;
    readonly tier: ClueTier;
    readonly step: number;
    readonly kind: 'map' | 'coordinate' | 'anagram' | 'emote' | 'cryptic';
    readonly text: string;
  };
  'clue-advanced': { readonly entity: EntityId; readonly tier: ClueTier; readonly step: number };
  'clue-complete': {
    readonly entity: EntityId;
    readonly tier: ClueTier;
    readonly rewards: readonly { readonly item: ItemConfigId; readonly amount: number }[];
  };
  'diary-progress': {
    readonly entity: EntityId;
    readonly area: string;
    readonly level: 'easy' | 'medium' | 'hard';
    readonly done: number;
    readonly total: number;
    readonly tasks: readonly { readonly id: string; readonly text: string; readonly done: boolean }[];
  };
  'diary-complete': {
    readonly entity: EntityId;
    readonly area: string;
    readonly level: 'easy' | 'medium' | 'hard';
  };
  'random-event-started': {
    readonly entity: EntityId;
    readonly event: string;
    readonly prompt?: string;
    readonly options?: readonly string[];
  };
  'random-event-ended': {
    readonly entity: EntityId;
    readonly event: string;
    readonly outcome: 'success' | 'failure' | 'dismissed' | 'timeout';
    readonly reward?: readonly { readonly item: ItemConfigId; readonly amount: number }[];
  };
  'shooting-star': { readonly at: TileCoord; readonly size: number; readonly stage: number };
  'champion-challenged': { readonly entity: EntityId; readonly champion: string };
  'champion-defeated': { readonly entity: EntityId; readonly champion: string };

  /* -- scenario ----------------------------------------------------------- */
  'scenario-event': {
    readonly name: string;
    readonly source: 'dialogue' | 'trigger';
    /** Present only on the dialogue path; trigger emits are unattributed. */
    readonly entity?: EntityId;
  };
  'scenario-teleported': { readonly entity: EntityId; readonly to: TileCoord };
  'scenario-message': { readonly text: string };
  /** A targeted scenario message visible to its recipient. */
  'scenario-notice': { readonly entity: EntityId; readonly text: string };
  'vote-cast': { readonly entity: EntityId; readonly poll: string; readonly target: EntityId | null };
  'vote-tally': {
    readonly poll: string;
    readonly counts: readonly { readonly target: EntityId; readonly votes: number }[];
    readonly abstentions: number;
    readonly eligible: number;
  };
  'poll-opened': {
    readonly poll: string;
    readonly eligible: readonly EntityId[];
    readonly closesAtTick?: number;
  };
  'poll-closed': {
    readonly poll: string;
    readonly winner: EntityId | null;
    readonly reason: 'quorum' | 'timeout' | 'trigger';
  };
  'trigger-fired': { readonly trigger: string };
  'cinematic-started': { readonly cinematic: string };
  'objective-complete': {
    readonly objective: string;
    readonly outcome: 'win' | 'lose' | 'progress';
    /** Scopes by actor TAG, not EntityId. */
    readonly actorTag?: string;
    /** Scopes by scenario team when present. */
    readonly team?: string;
  };
  'team-won': { readonly team: string; readonly objective: string };
  'team-lost': { readonly team: string; readonly objective: string };
  'scenario-won': { readonly objective: string };
  'scenario-lost': { readonly objective: string };
}

export type SimEventType = keyof SimEventMap & string;

/** Discriminated union over the whole catalogue. */
export type SimEvent = {
  [T in SimEventType]: {
    readonly type: T;
    readonly tick: Tick;
    readonly seq: number;
    readonly data: SimEventMap[T];
  };
}[SimEventType];

// ---------------------------------------------------------------------------
// Actor attribution
// ---------------------------------------------------------------------------

/**
 * Which field, if any, names the actor an event should be credited to. Reward
 * functions and per-actor observation filters read this table instead of
 * hard-coding field names.
 *
 * 'actorTag' means the event scopes by scenario actor tag, not entity id.
 * 'none' means the event is unattributed (world-level).
 */
export type AttributionField = 'entity' | 'attacker' | 'killer' | 'owner' | 'actorTag' | 'none';

export const EVENT_ATTRIBUTION: Readonly<Record<SimEventType, AttributionField>> = {
  tick: 'none',
  'instance-ended': 'none',
  'chunk-activated': 'none',
  'chunk-deactivated': 'none',
  error: 'none',
  'entity-spawned': 'entity',
  'entity-renamed': 'entity',
  'entity-despawned': 'entity',
  'entity-moved': 'entity',
  moved: 'entity',
  'move-blocked': 'entity',
  'move-rejected': 'entity',
  teleported: 'entity',
  climbed: 'entity',
  'door-changed': 'entity',
  swing: 'attacker',
  'swing-blocked': 'attacker',
  hit: 'attacker',
  dragonfire: 'attacker',
  'bolt-proc': 'attacker',
  damaged: 'entity',
  died: 'killer',
  'actor-eliminated': 'entity',
  respawned: 'entity',
  'target-lost': 'attacker',
  'retaliate-set': 'entity',
  poisoned: 'entity',
  'poison-damage': 'entity',
  'poison-cured': 'entity',
  'special-energy': 'entity',
  'special-toggled': 'entity',
  'special-attack': 'attacker',
  'spell-cast': 'entity',
  alchemised: 'entity',
  enchanted: 'entity',
  'bones-converted': 'entity',
  'spell-effect': 'attacker',
  unbound: 'entity',
  'prayer-toggled': 'entity',
  'prayer-points': 'entity',
  'prayers-depleted': 'entity',
  buried: 'entity',
  'xp-gained': 'entity',
  'level-up': 'entity',
  'stat-boosted': 'entity',
  'stat-restored': 'entity',
  gathered: 'entity',
  'gather-stopped': 'entity',
  'node-depleted': 'none',
  'node-respawned': 'none',
  fished: 'entity',
  'fishing-stopped': 'entity',
  'fire-lit': 'entity',
  'fire-expired': 'none',
  'firemaking-stopped': 'entity',
  cooked: 'entity',
  burnt: 'entity',
  'cooking-stopped': 'entity',
  ate: 'entity',
  drank: 'entity',
  'run-energy': 'entity',
  'run-toggled': 'entity',
  skulled: 'entity',
  'skull-expired': 'entity',
  'zone-entered': 'entity',
  'zone-left': 'entity',
  'items-lost-on-death': 'entity',
  'grave-spawned': 'owner',
  'grave-expired': 'owner',
  'runes-crafted': 'entity',
  'ruin-entered': 'entity',
  'pouch-filled': 'entity',
  'pouch-emptied': 'entity',
  smelted: 'entity',
  'smelt-failed': 'entity',
  smithed: 'entity',
  'smithing-stopped': 'entity',
  crafted: 'entity',
  'crafting-stopped': 'entity',
  fletched: 'entity',
  'fletching-stopped': 'entity',
  'herb-cleaned': 'entity',
  'potion-made': 'entity',
  'herblore-stopped': 'entity',
  pickpocketed: 'entity',
  'pickpocket-failed': 'entity',
  'stall-theft': 'entity',
  'stall-caught': 'entity',
  'stall-respawned': 'none',
  'obstacle-completed': 'entity',
  'obstacle-failed': 'entity',
  'course-completed': 'entity',
  'item-added': 'entity',
  'item-removed': 'entity',
  'items-dropped': 'entity',
  equipped: 'entity',
  unequipped: 'entity',
  'ground-item-spawned': 'owner',
  'ground-item-picked-up': 'entity',
  'ground-item-revealed': 'none',
  'ground-item-despawned': 'none',
  interacted: 'entity',
  'item-used': 'entity',
  'shop-viewed': 'none',
  'shop-bought': 'entity',
  'shop-sold': 'entity',
  'ge-viewed': 'entity',
  'ge-price': 'entity',
  'ge-offer-placed': 'entity',
  'ge-offer-filled': 'entity',
  'ge-offer-aborted': 'entity',
  'ge-collected': 'entity',
  'trade-requested': 'entity',
  'trade-opened': 'none',
  'trade-updated': 'entity',
  'trade-stage': 'none',
  'trade-completed': 'none',
  'trade-declined': 'entity',
  'dialogue-started': 'entity',
  'dialogue-node': 'entity',
  'dialogue-ended': 'entity',
  'quest-stage': 'entity',
  'quest-complete': 'entity',
  'quest-journal': 'entity',
  'flag-set': 'entity',
  'slayer-assigned': 'entity',
  'slayer-kill': 'entity',
  'slayer-complete': 'entity',
  'slayer-rewarded': 'entity',
  travelled: 'entity',
  'travel-denied': 'entity',
  chat: 'entity',
  'friends-updated': 'entity',
  'clan-updated': 'entity',
  'patch-changed': 'none',
  farmed: 'entity',
  harvested: 'entity',
  'trap-laid': 'entity',
  'trap-caught': 'entity',
  'trap-collapsed': 'entity',
  hunted: 'entity',
  'familiar-summoned': 'entity',
  'familiar-dismissed': 'entity',
  'summoning-points': 'entity',
  'familiar-special': 'entity',
  'bob-updated': 'entity',
  prospected: 'entity',
  'minigame-lobby': 'none',
  'minigame-started': 'none',
  'minigame-ended': 'none',
  'minigame-event': 'none',
  'duel-stake': 'none',
  'clue-step': 'entity',
  'clue-advanced': 'entity',
  'clue-complete': 'entity',
  'diary-progress': 'entity',
  'diary-complete': 'entity',
  'random-event-started': 'entity',
  'random-event-ended': 'entity',
  'shooting-star': 'none',
  'champion-challenged': 'entity',
  'champion-defeated': 'entity',
  'scenario-event': 'entity',
  'scenario-teleported': 'entity',
  'scenario-message': 'none',
  'scenario-notice': 'entity',
  'vote-cast': 'entity',
  'vote-tally': 'none',
  'poll-opened': 'none',
  'poll-closed': 'none',
  'trigger-fired': 'none',
  'cinematic-started': 'none',
  'objective-complete': 'actorTag',
  'team-won': 'none',
  'team-lost': 'none',
  'scenario-won': 'none',
  'scenario-lost': 'none'
};

export const SIM_EVENT_TYPES: readonly SimEventType[] =
  Object.freeze((Object.keys(EVENT_ATTRIBUTION) as SimEventType[]).slice().sort());

/** Resolve the entity an event should be credited to, if any. */
export function eventActor(event: { readonly type: string; readonly data: unknown }): number | undefined {
  const field = EVENT_ATTRIBUTION[event.type as SimEventType];
  if (field === undefined || field === 'none' || field === 'actorTag') return undefined;
  const data = event.data as Record<string, unknown> | null;
  const value = data?.[field];
  return typeof value === 'number' ? value : undefined;
}
