import type { EntityId, SimEvent, Tick, TileCoord } from '#protocol';

export interface HpView { readonly current: number; readonly max: number; }

export interface Activity {
  readonly kind: string;
  readonly dest?: TileCoord;
  readonly since?: Tick;
  readonly action?: string;
  readonly [key: string]: unknown;
}

export interface SelfView {
  readonly entity: EntityId;
  readonly tag: string;
  readonly displayName: string;
  readonly at: TileCoord;
  readonly hp: HpView;
  readonly combat: {
    readonly inCombat: boolean;
    readonly target?: EntityId;
    readonly attackedBy: readonly EntityId[];
    readonly [key: string]: unknown;
  };
  readonly activity: Activity;
  readonly dead: boolean;
  readonly prayer?: { readonly points: number; readonly maxPoints: number; readonly active: readonly string[] };
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
  readonly kind: 'player' | 'npc' | 'object' | 'resource' | string;
  readonly name?: string;
  readonly at: TileCoord;
  readonly distance: number;
  readonly hp?: HpView;
  readonly lastSeenTick: Tick;
  readonly [key: string]: unknown;
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
  readonly name?: string;
  readonly depleted: boolean;
  readonly [key: string]: unknown;
}

export interface StationView {
  readonly id: string;
  readonly kind: string;
  readonly at: TileCoord;
  readonly distance: number;
  readonly name?: string;
}

export interface HeatSourceView {
  readonly kind: string;
  readonly id: string;
  readonly at: TileCoord;
  readonly distance: number;
}

export interface ObjectiveView {
  readonly id: string;
  readonly description: string;
  readonly outcome: 'win' | 'lose' | 'progress';
  readonly complete: boolean;
  readonly progress?: readonly {
    readonly path: string;
    readonly kind: string;
    readonly current: number;
    readonly target: number;
    readonly satisfied: boolean;
  }[];
}

export interface DialogueView {
  readonly active: boolean;
  readonly speaker?: string;
  readonly text?: string;
  readonly options?: readonly string[];
}

export interface ChatLine {
  readonly entity: EntityId;
  readonly name: string;
  readonly text: string;
  readonly channel: string;
  readonly tick: Tick;
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
  readonly chat: readonly ChatLine[];
  readonly lastEventSeq: number;
  readonly resyncedTick: Tick;
  readonly extensions?: Readonly<Record<string, unknown>>;
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
  nameOf(kind: string, id: number): string | undefined;
}

/** A private integration implements this boundary and supplies its own commands and events. */
export interface WorldAdapter {
  readonly id: string;
  readonly commandTypes: readonly string[];
  createView(agentId: string, credentials: unknown): Promise<WorldView> | WorldView;
}
