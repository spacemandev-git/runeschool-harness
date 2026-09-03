/** Compact perception contracts shared by the SDK and harness. */
import type { EntityId, JsonValue, SimEvent, Tick, TileCoord } from '../shared/index.ts';

declare module './types.ts' {
  interface EntityView {
    readonly options?: readonly string[];
  }
}

export interface HpView { readonly current: number; readonly max: number; }

/** Event-folded status state. The server does not currently expose a status REST view. */
export interface StatusView {
  readonly poison?: { readonly severity: number };
  readonly boosts: Readonly<Record<string, number>>;
  readonly specialEnergy: number;
  readonly specialEnabled: boolean;
  readonly runEnergy: number;
  readonly weight: number;
  readonly runEnabled?: boolean;
  readonly skulledUntil?: Tick;
  readonly zoneTags: readonly string[];
  readonly wildernessLevel: number;
}

export type Activity =
  | { readonly kind: 'idle' }
  | { readonly kind: 'walking'; readonly dest: TileCoord; readonly since: Tick }
  | { readonly kind: 'fighting'; readonly target: EntityId; readonly since: Tick }
  | { readonly kind: 'gathering'; readonly node: string; readonly since: Tick }
  | { readonly kind: 'fishing'; readonly spot: EntityId; readonly since: Tick }
  | { readonly kind: 'producing'; readonly what: 'cooking' | 'smithing' | 'crafting' | 'firemaking'; readonly since: Tick }
  | { readonly kind: 'thieving'; readonly since: Tick }
  | { readonly kind: 'agility'; readonly since: Tick }
  | { readonly kind: 'dialogue'; readonly since: Tick };

export interface SelfView {
  readonly entity: EntityId;
  readonly tag: string;
  readonly displayName: string;
  readonly at: TileCoord;
  readonly hp: HpView;
  /** Present on SDK world-model snapshots; optional for backwards-compatible snapshot fixtures. */
  readonly status?: StatusView;
  readonly prayer?: { readonly points: number; readonly maxPoints: number; readonly active: readonly string[] };
  readonly combat: {
    readonly inCombat: boolean;
    readonly target?: EntityId;
    readonly attackedBy: readonly EntityId[];
    readonly style?: { readonly style: string; readonly attackStyle: string; readonly spell?: string };
    readonly autoRetaliate?: boolean;
    readonly bound?: boolean;
    readonly drains?: Readonly<Record<'attack' | 'strength' | 'defence' | 'magic', number>>;
  };
  readonly activity: Activity;
  readonly dead: boolean;
}

export interface InventorySlotView {
  readonly slot: number;
  readonly item: number;
  readonly name?: string;
  readonly amount: number;
}

export interface EquippedItemView { readonly item: number; readonly name?: string; readonly amount?: number; }
export interface SkillView { readonly level: number; readonly xp: number; }

export interface NearbyEntityView {
  readonly id: EntityId;
  readonly kind: 'player' | 'npc' | 'ground_item' | 'loc';
  readonly name?: string;
  readonly npc?: number;
  readonly loc?: number;
  readonly actorTag?: string;
  readonly options?: readonly string[];
  readonly at: TileCoord;
  /** Chebyshev distance from self; Infinity on another level. */
  readonly distance: number;
  readonly hp?: HpView;
  readonly engaging?: EntityId;
  readonly lastSeenTick: Tick;
}

export interface GroundItemView {
  readonly id: number;
  readonly item: number;
  readonly name?: string;
  readonly amount: number;
  readonly at: TileCoord;
  readonly distance: number;
  readonly owner?: EntityId;
}

export interface NodeView {
  readonly id: string;
  readonly at: TileCoord;
  readonly distance: number;
  readonly loc: number;
  readonly name?: string;
  readonly skill: string;
  readonly requiredLevel: number;
  readonly depleted: boolean;
}

export interface StationView {
  readonly id: string;
  readonly kind: string;
  readonly at: TileCoord;
  readonly distance: number;
  readonly name?: string;
}

export interface HeatSourceView {
  readonly kind: 'fire' | 'range';
  readonly id: string;
  readonly at: TileCoord;
  readonly distance: number;
}

export interface ObjectiveView {
  readonly id: string;
  readonly description: string;
  readonly outcome: 'win' | 'lose' | 'progress';
  readonly complete: boolean;
  readonly actorTag?: string;
  readonly progress: readonly {
    readonly path: string;
    readonly kind: string;
    readonly current: number;
    readonly target: number;
    readonly satisfied: boolean;
  }[];
}

export interface DialogueView {
  readonly active: boolean;
  readonly npc?: EntityId;
  readonly speaker?: string;
  readonly text?: string;
  readonly options?: readonly string[];
}

export interface TradeOfferView {
  readonly item: number;
  readonly amount: number;
}

/** Actor-relative player-trade state reconstructed from the trade event stream. */
export interface TradeView {
  readonly partner: EntityId;
  readonly stage: 'offer' | 'confirm';
  readonly ownOffer: readonly TradeOfferView[];
  readonly partnerOffer: readonly TradeOfferView[];
}

export interface ChatLine {
  readonly entity: EntityId;
  readonly name: string;
  readonly text: string;
  readonly channel: 'public' | 'pm' | 'clan';
  readonly to?: string;
  readonly clan?: string;
  readonly tick: Tick;
}

export interface QuestJournalEntry {
  readonly quest: string;
  readonly stage: number;
  readonly name: string;
  readonly complete: boolean;
  /** Present after a stage event; journal query events currently omit the authored milestone text. */
  readonly journal?: string;
}

export interface QuestView {
  readonly journal: readonly QuestJournalEntry[];
  readonly questPoints: number;
}

export interface SlayerView {
  readonly task?: string;
  readonly remaining: number;
}

export interface ClanView {
  readonly name: string;
  readonly owner: string;
  readonly members: readonly { readonly name: string; readonly rank: number }[];
}

export interface SocialView {
  readonly friends: readonly string[];
  readonly ignored: readonly string[];
  readonly clan?: ClanView;
}

export interface FarmingView {
  readonly patches: readonly {
    readonly id: string;
    readonly state: string;
    readonly crop?: number;
    readonly stage?: number;
  }[];
}

export interface HunterView {
  readonly traps: readonly {
    readonly id: EntityId;
    readonly kind: string;
    readonly state: 'armed' | 'caught' | 'collapsed';
  }[];
}

export interface FamiliarView {
  readonly id: EntityId;
  readonly pouch: number;
  readonly expiresAt: Tick;
}

export interface MinigameView {
  readonly game: string;
  readonly state: 'waiting' | 'starting' | 'running' | 'ended';
  readonly session?: string;
  /** Latest game-specific session event, including wave-5 progress details. */
  readonly event?: {
    readonly kind: string;
    readonly entity?: EntityId;
    readonly data?: JsonValue;
  };
}

export interface ClueView {
  readonly tier: 'easy' | 'medium' | 'hard';
  readonly step: number;
  readonly kind: 'map' | 'coordinate' | 'anagram' | 'emote' | 'cryptic';
  readonly text: string;
}

export interface RandomEventView {
  readonly event: string;
  readonly prompt?: string;
  readonly options?: readonly string[];
}

export interface DiaryView {
  readonly area: string;
  readonly level: 'easy' | 'medium' | 'hard';
  readonly done: number;
  readonly total: number;
}

export interface WorldSnapshot {
  readonly instanceId: string;
  readonly tick: Tick;
  readonly wallTime: number;
  readonly radius: number;
  readonly self: SelfView;
  readonly inventory: readonly InventorySlotView[];
  readonly inventoryFree: number;
  readonly equipment: Readonly<Record<string, EquippedItemView>>;
  readonly skills: Readonly<Record<string, SkillView>>;
  readonly nearby: readonly NearbyEntityView[];
  readonly groundItems: readonly GroundItemView[];
  readonly nodes: readonly NodeView[];
  readonly stations: readonly StationView[];
  readonly heatSources: readonly HeatSourceView[];
  readonly objectives: readonly ObjectiveView[];
  readonly won: boolean;
  readonly lost: boolean;
  readonly dialogue: DialogueView;
  readonly trade?: TradeView;
  /** Event-folded actor quest state. Query with `quest-journal` to seed the complete journal. */
  readonly quests?: QuestView;
  /** Event-folded active Slayer assignment. */
  readonly slayer?: SlayerView;
  /** Event-folded friends, ignores, and clan membership. */
  readonly social?: SocialView;
  /** Event-folded patches observed in the world, sorted by patch ID. */
  readonly farming?: FarmingView;
  /** Event-folded traps owned by self, sorted by entity ID. */
  readonly hunter?: HunterView;
  /** Event-folded active familiar owned by self. */
  readonly familiar?: FamiliarView;
  /** Current event-folded Summoning points. */
  readonly summoningPoints?: number;
  /** Event-folded lobby/session membership for self. */
  readonly minigame?: MinigameView;
  /** Event-folded active Treasure Trail step. */
  readonly clue?: ClueView;
  /** Event-folded active random event. */
  readonly randomEvent?: RandomEventView;
  /** Most recently queried achievement-diary tier. */
  readonly diary?: DiaryView;
  /** Most recent visible in-world chat lines, oldest first. */
  readonly chat: readonly ChatLine[];
  readonly lastEventSeq: number;
  readonly resyncedTick: Tick;
}

export interface RejectionView {
  readonly type: string;
  readonly code: string;
  readonly message: string;
  readonly tick: Tick;
  readonly source: string;
}

export interface PerceptDelta {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly fromTick: Tick;
  readonly toTick: Tick;
  readonly hp?: { readonly before: HpView; readonly after: HpView };
  readonly moved?: { readonly from: TileCoord; readonly to: TileCoord };
  readonly xpGained: readonly { readonly skill: string; readonly amount: number }[];
  readonly levelUps: readonly { readonly skill: string; readonly level: number }[];
  readonly itemsGained: readonly { readonly item: number; readonly name?: string; readonly amount: number }[];
  readonly itemsLost: readonly { readonly item: number; readonly name?: string; readonly amount: number }[];
  readonly entered: readonly NearbyEntityView[];
  readonly left: readonly { readonly id: EntityId; readonly name?: string }[];
  readonly deaths: readonly { readonly entity: EntityId; readonly name?: string; readonly killer?: EntityId; readonly isSelf: boolean }[];
  readonly damageTaken: number;
  readonly damageDealt: number;
  readonly groundItemsAppeared: readonly GroundItemView[];
  readonly dialogue?: DialogueView;
  readonly objectivesChanged: readonly ObjectiveView[];
  readonly rejections: readonly RejectionView[];
  readonly messages: readonly string[];
  readonly lines: readonly string[];
  readonly events: readonly SimEvent[];
}

export interface WorldView {
  readonly agentId: string;
  readonly entity: EntityId;
  snapshot(): WorldSnapshot;
  eventsSince(since: number): readonly SimEvent[];
  deltaSince(sinceSeq: number): PerceptDelta;
  checkpoint(): number;
  distanceTo(at: TileCoord): number;
  nameOf(kind: 'item' | 'npc' | 'loc', id: number): string | undefined;
}

export interface WorldModelOptions {
  readonly agentId?: string;
  readonly tag?: string;
  readonly radius?: number;
  readonly resyncIntervalMs?: number;
  readonly ringSize?: number;
  readonly now?: () => number;
  /** Optional name dictionary source; the default reads `/defs/names`. */
  readonly names?: () => Promise<{
    readonly items: Readonly<Record<string, string>>;
    readonly npcs: Readonly<Record<string, string>>;
    readonly locs?: Readonly<Record<string, string>>;
  }>;
  /** Integration hooks used by adapters; all are optional. */
  readonly onWarning?: (section: string, error: unknown) => void;
  readonly onEvent?: (event: SimEvent) => void;
  readonly onSnapshot?: (snapshot: WorldSnapshot) => void;
}

export interface AcceptedAction {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly tick: Tick;
  readonly ok: boolean;
}

export interface WorldModel extends WorldView {
  start(): Promise<void>;
  stop(): void;
  resync(): Promise<void>;
  noteAction(outcome: AcceptedAction): void;
  noteRejection(rejection: RejectionView): void;
  lastPulseEvents(): readonly SimEvent[];
}
