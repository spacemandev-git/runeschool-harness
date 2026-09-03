import type { EntityId, EntityKind, ItemConfigId, LocConfigId, NpcConfigId } from './ids.ts';
import type { TileCoord } from './coords.ts';
import type { JsonValue } from './sim.ts';

/**
 * The full v0 command set as a discriminated union (see ADR-0019).
 *
 * Generated from the dispatch switch in apps/server/src/instances.ts and the
 * command table in docs/features/server-api.md. `SimCommand` is the wire
 * envelope minus transport fields, i.e. what the simulation itself consumes;
 * `ClientCommand` in protocol.ts wraps one of these with `instance` and `id`.
 *
 * Keep this in sync with the dispatch switch. `packages/sim` owns an exhaustive
 * test asserting every case in the switch has a variant here and vice versa.
 */

// ---------------------------------------------------------------------------
// Enumerations used by command payloads
// ---------------------------------------------------------------------------

export const COMBAT_STYLES = ['melee', 'range', 'magic'] as const;
export type CombatStyleName = (typeof COMBAT_STYLES)[number];

export const ATTACK_STYLES = [
  'accurate', 'aggressive', 'controlled', 'defensive',
  'range-accurate', 'rapid', 'longrange',
  'cast', 'defensive-cast'
] as const;
export type AttackStyleName = (typeof ATTACK_STYLES)[number];

export const SPELLBOOKS = ['modern', 'ancient'] as const;
export type SpellbookName = (typeof SPELLBOOKS)[number];

export const EQUIPMENT_SLOTS = [
  'head', 'cape', 'neck', 'weapon', 'body', 'shield',
  'legs', 'hands', 'feet', 'ring', 'ammo'
] as const;
export type EquipmentSlotName = (typeof EQUIPMENT_SLOTS)[number];

export const PRAYER_IDS = [
  'thick-skin', 'burst-of-strength', 'clarity-of-thought', 'sharp-eye', 'mystic-will',
  'rock-skin', 'superhuman-strength', 'improved-reflexes', 'hawk-eye', 'mystic-lore',
  'steel-skin', 'ultimate-strength', 'incredible-reflexes',
  'protect-from-magic', 'protect-from-missiles', 'protect-from-melee',
  'eagle-eye', 'mystic-might', 'chivalry', 'piety', 'smite'
] as const;
export type PrayerId = (typeof PRAYER_IDS)[number];

export const FISHING_OPTIONS = ['net', 'bait', 'lure', 'pike-bait'] as const;
export type FishingOption = (typeof FISHING_OPTIONS)[number];

export const FARM_ACTIONS = [
  'rake', 'plant', 'compost', 'water', 'harvest', 'check-health', 'clear', 'pay', 'inspect'
] as const;
export type FarmAction = (typeof FARM_ACTIONS)[number];

export const HUNT_ACTIONS = ['lay-trap', 'check-trap', 'dismantle', 'net', 'catch', 'track'] as const;
export type HuntAction = (typeof HUNT_ACTIONS)[number];

export const SUMMON_ACTIONS = [
  'summon', 'dismiss', 'renew', 'call', 'special', 'store', 'withdraw', 'infuse'
] as const;
export type SummonAction = (typeof SUMMON_ACTIONS)[number];

export const MINIGAME_ACTIONS = [
  'join', 'leave', 'ready', 'stake', 'accept', 'decline', 'forfeit'
] as const;
export type MinigameAction = (typeof MINIGAME_ACTIONS)[number];

export const CLUE_ACTIONS = ['read', 'dig', 'emote', 'answer', 'open-casket'] as const;
export type ClueAction = (typeof CLUE_ACTIONS)[number];
export type ClueTier = 'easy' | 'medium' | 'hard';

export const CHAMPION_ACTIONS = ['challenge', 'accept'] as const;
export type ChampionAction = (typeof CHAMPION_ACTIONS)[number];

export const RANDOM_EVENT_ACTIONS = ['respond', 'dismiss'] as const;
export type RandomEventAction = (typeof RANDOM_EVENT_ACTIONS)[number];

export type ClimbDirection = 'up' | 'down';

/** One of the 16 modern elemental spells; see packages/combat MODERN_SPELLS. */
export type SpellId = string;

export type HeatSourceKind = 'fire' | 'range';

export type GeOfferKind = 'buy' | 'sell';
export type GeOfferStatus = 'open' | 'completed' | 'aborted';

export const GE_SLOTS = 6;
export const GE_CLERK_NPCS: readonly number[] = Object.freeze([6528, 6529, 6530, 6531, 6532]);
export const COINS_ITEM_ID = 995;

// ---------------------------------------------------------------------------
// Command variants
// ---------------------------------------------------------------------------

export interface Cmd<TType extends string, TData> {
  readonly type: TType;
  readonly data: TData;
}

export type InteractTarget =
  | { readonly kind: 'npc'; readonly id: EntityId }
  | { readonly kind: 'player'; readonly id: EntityId }
  | { readonly kind: 'ground-item'; readonly id: number }
  | { readonly kind: 'loc'; readonly at: TileCoord; readonly loc: LocConfigId };

export type InteractCommand = Cmd<'interact', {
  readonly entity: EntityId;
  readonly target: InteractTarget;
  readonly option: string;
}>;
export type UseItemOnCommand = Cmd<'use-item-on', {
  readonly entity: EntityId;
  readonly slot: number;
  readonly target: InteractTarget;
}>;

/* -- movement -------------------------------------------------------------- */
export type WalkCommand = Cmd<'walk', { readonly entity: EntityId; readonly dest: TileCoord }>;
export type RunCommand = Cmd<'run', { readonly entity: EntityId; readonly dest: TileCoord }>;
export type SetRunCommand = Cmd<'set-run', { readonly entity: EntityId; readonly enabled: boolean }>;
/** Direct teleport-style placement; no pathfinding. */
export type MoveCommand = Cmd<'move', { readonly entity: EntityId; readonly at: TileCoord }>;
export type ClimbCommand = Cmd<'climb', {
  readonly entity: EntityId;
  readonly at: TileCoord;
  readonly direction?: ClimbDirection;
}>;
/**
 * Toggle a map-placed door leaf: opens a closed door, closes an open one. `at` and `loc` identify
 * the leaf's *original* map placement (see `DoorLeaf`). The actor must be within Chebyshev 1 of
 * the leaf's current tile on the same level. Double doors toggle together.
 */
export type OpenDoorCommand = Cmd<'open-door', {
  readonly entity: EntityId;
  readonly at: TileCoord;
  readonly loc: LocConfigId;
}>;
export type TraverseCommand = Cmd<'traverse', {
  readonly entity: EntityId;
  readonly course: string;
  readonly obstacle: number;
}>;

/* -- combat ---------------------------------------------------------------- */
export type AttackCommand = Cmd<'attack', { readonly entity: EntityId; readonly target: EntityId }>;
export type DisengageCommand = Cmd<'disengage', { readonly entity: EntityId }>;
export type CastCommand = Cmd<'cast', {
  readonly entity: EntityId;
  readonly target: EntityId;
  readonly spell: SpellId;
}>;
/** Switch spellbooks immediately; altar/quest requirements are intentionally deferred. */
export type SwitchSpellbookCommand = Cmd<'switch-spellbook', {
  readonly entity: EntityId;
  readonly book: SpellbookName;
}>;
/**
 * Cast a self-targeted modern spell: teleports, Bones to Bananas/Peaches, Home Teleport.
 * Resolves on the tick it is applied (teleports emit `teleported` immediately).
 */
export type CastSelfCommand = Cmd<'cast-self', {
  readonly entity: EntityId;
  readonly spell: SpellId;
}>;
/** Cast a spell on one inventory slot: Low/High Alchemy, Superheat Item, Enchant Lvl-1..6 Jewellery. */
export type CastOnItemCommand = Cmd<'cast-on-item', {
  readonly entity: EntityId;
  readonly spell: SpellId;
  readonly slot: number;
}>;
/** Cast a spell on a ground item: Telekinetic Grab. */
export type CastOnGroundCommand = Cmd<'cast-on-ground', {
  readonly entity: EntityId;
  readonly spell: SpellId;
  readonly groundItem: number;
}>;
export type SetStyleCommand = Cmd<'set-style', {
  readonly entity: EntityId;
  readonly style: CombatStyleName;
  readonly attackStyle: AttackStyleName;
  readonly spell?: SpellId;
}>;
export type SetRetaliateCommand = Cmd<'set-retaliate', { readonly entity: EntityId; readonly enabled: boolean }>;
export type PrayCommand = Cmd<'pray', { readonly entity: EntityId; readonly prayer: PrayerId }>;
export type BuryCommand = Cmd<'bury', { readonly entity: EntityId; readonly item: ItemConfigId }>;
export type EatCommand = Cmd<'eat', { readonly entity: EntityId; readonly item: ItemConfigId }>;
export type DrinkCommand = Cmd<'drink', { readonly entity: EntityId; readonly item: ItemConfigId }>;
export type SpecialCommand = Cmd<'special', { readonly entity: EntityId; readonly enabled: boolean }>;

/* -- runecrafting, zones, and graves -------------------------------------- */
export type CraftRunesCommand = Cmd<'craft-runes', {
  readonly entity: EntityId;
  readonly altar: { readonly at: TileCoord; readonly loc: LocConfigId };
}>;
export type EnterRuinCommand = Cmd<'enter-ruin', {
  readonly entity: EntityId;
  readonly ruin: { readonly at: TileCoord; readonly loc: LocConfigId };
}>;
export type FillPouchCommand = Cmd<'fill-pouch', {
  readonly entity: EntityId;
  readonly pouch: ItemConfigId;
}>;
export type EmptyPouchCommand = Cmd<'empty-pouch', {
  readonly entity: EntityId;
  readonly pouch: ItemConfigId;
}>;
export type BlessGraveCommand = Cmd<'bless-grave', {
  readonly entity: EntityId;
  readonly grave: EntityId;
}>;

/* -- gathering and production ---------------------------------------------- */
export type GatherCommand = Cmd<'gather', { readonly entity: EntityId; readonly node: string }>;
export type StopGatherCommand = Cmd<'stop-gather', { readonly entity: EntityId }>;
export type FishCommand = Cmd<'fish', {
  readonly entity: EntityId;
  readonly spot: EntityId;
  readonly option: FishingOption;
}>;
export type StopFishCommand = Cmd<'stop-fish', { readonly entity: EntityId }>;
export type LightCommand = Cmd<'light', { readonly entity: EntityId; readonly log: ItemConfigId }>;
export type CookCommand = Cmd<'cook', {
  readonly entity: EntityId;
  readonly item: ItemConfigId;
  readonly target: { readonly kind: HeatSourceKind; readonly id: string };
}>;
export type StopCookCommand = Cmd<'stop-cook', { readonly entity: EntityId }>;
export type SmeltCommand = Cmd<'smelt', { readonly entity: EntityId; readonly bar: ItemConfigId }>;
export type SmithCommand = Cmd<'smith', { readonly entity: EntityId; readonly product: ItemConfigId }>;
export type StopSmithCommand = Cmd<'stop-smith', { readonly entity: EntityId }>;
export type CraftCommand = Cmd<'craft', { readonly entity: EntityId; readonly product: ItemConfigId }>;
export type StopCraftCommand = Cmd<'stop-craft', { readonly entity: EntityId }>;
export type FletchCommand = Cmd<'fletch', {
  readonly entity: EntityId;
  readonly product: ItemConfigId;
  readonly amount?: number;
}>;
export type StopFletchCommand = Cmd<'stop-fletch', { readonly entity: EntityId }>;
export type CleanHerbCommand = Cmd<'clean-herb', {
  readonly entity: EntityId;
  readonly item: ItemConfigId;
  readonly amount?: number;
}>;
export type MakePotionCommand = Cmd<'make-potion', {
  readonly entity: EntityId;
  readonly product: ItemConfigId;
  readonly amount?: number;
}>;
export type StopHerbloreCommand = Cmd<'stop-herblore', { readonly entity: EntityId }>;
export type PickpocketCommand = Cmd<'pickpocket', { readonly entity: EntityId; readonly npc: EntityId }>;
export type StealStallCommand = Cmd<'steal-stall', { readonly entity: EntityId; readonly stall: string }>;

/* -- farming, hunter, summoning, and minigames --------------------------- */
export type FarmCommand = Cmd<'farm', {
  readonly entity: EntityId;
  readonly patch: { readonly at: TileCoord; readonly loc: LocConfigId };
  readonly action: FarmAction;
  readonly item?: ItemConfigId;
}>;
export type HuntCommand = Cmd<'hunt', {
  readonly entity: EntityId;
  readonly action: HuntAction;
  readonly target?: InteractTarget;
  readonly item?: ItemConfigId;
}>;
export type SummonCommand = Cmd<'summon', {
  readonly entity: EntityId;
  readonly action: SummonAction;
  readonly item?: ItemConfigId;
  readonly slot?: number;
  readonly amount?: number;
  readonly scroll?: ItemConfigId;
}>;
export type ProspectCommand = Cmd<'prospect', { readonly entity: EntityId; readonly node: string }>;
export type MinigameCommand = Cmd<'minigame', {
  readonly entity: EntityId;
  readonly action: MinigameAction;
  readonly game: string;
  readonly options?: Readonly<Record<string, JsonValue>>;
}>;

/* -- activities ---------------------------------------------------------- */
export type ClueCommand = Cmd<'clue', {
  readonly entity: EntityId;
  readonly action: ClueAction;
  readonly item?: ItemConfigId;
  readonly answer?: string;
  readonly emote?: string;
}>;
export type DiaryCommand = Cmd<'diary', { readonly entity: EntityId; readonly area?: string }>;
export type ChampionCommand = Cmd<'champion', {
  readonly entity: EntityId;
  readonly action: ChampionAction;
  readonly scroll?: ItemConfigId;
}>;
export type RandomEventCommand = Cmd<'random-event', {
  readonly entity: EntityId;
  readonly action: RandomEventAction;
  readonly answer?: string;
  readonly choice?: number;
}>;

/** Cast or clear this actor's ballot in an open scenario poll. */
export type VoteCommand = Cmd<'vote', {
  readonly entity: EntityId;
  readonly poll: string;
  readonly target: EntityId | null;
}>;

/* -- items, economy -------------------------------------------------------- */
export type EquipCommand = Cmd<'equip', { readonly entity: EntityId; readonly slot: number }>;
export type UnequipCommand = Cmd<'unequip', { readonly entity: EntityId; readonly slot: EquipmentSlotName }>;
/** Drop the complete stack held in one inventory slot onto the actor's tile. */
export type DropCommand = Cmd<'drop', { readonly entity: EntityId; readonly slot: number }>;
export type GiveCommand = Cmd<'give', {
  readonly entity: EntityId;
  readonly item: ItemConfigId;
  readonly amount: number;
}>;
export type PickupCommand = Cmd<'pickup', { readonly entity: EntityId; readonly groundItem: number }>;
export type ShopViewCommand = Cmd<'shop-view', { readonly entity: EntityId; readonly npc: EntityId }>;
export type ShopBuyCommand = Cmd<'shop-buy', {
  readonly entity: EntityId;
  readonly npc: EntityId;
  readonly item: ItemConfigId;
  readonly amount: number;
}>;
export type ShopSellCommand = Cmd<'shop-sell', {
  readonly entity: EntityId;
  readonly npc: EntityId;
  readonly item: ItemConfigId;
  readonly amount: number;
}>;
export type GeViewCommand = Cmd<'ge-view', {
  readonly entity: EntityId;
  readonly npc: EntityId;
}>;
export type GePriceCommand = Cmd<'ge-price', {
  readonly entity: EntityId;
  readonly item: ItemConfigId;
}>;
export type GeOfferCommand = Cmd<'ge-offer', {
  readonly entity: EntityId;
  readonly npc: EntityId;
  readonly kind: GeOfferKind;
  readonly item: ItemConfigId;
  readonly quantity: number;
  readonly price: number;
}>;
export type GeAbortCommand = Cmd<'ge-abort', {
  readonly entity: EntityId;
  readonly npc: EntityId;
  readonly slot: number;
}>;
export type GeCollectCommand = Cmd<'ge-collect', {
  readonly entity: EntityId;
  readonly npc: EntityId;
  readonly slot: number;
  readonly noted?: boolean;
}>;
export type BankDepositCommand = Cmd<'bank-deposit', {
  readonly entity: EntityId;
  readonly item: ItemConfigId;
  readonly amount: number;
}>;
export type BankWithdrawCommand = Cmd<'bank-withdraw', {
  readonly entity: EntityId;
  readonly item: ItemConfigId;
  readonly amount: number;
  readonly noted?: boolean;
}>;
export type TradeRequestCommand = Cmd<'trade-request', {
  readonly entity: EntityId;
  readonly target: EntityId;
}>;
export type TradeOfferCommand = Cmd<'trade-offer', {
  readonly entity: EntityId;
  readonly slot: number;
  readonly amount: number;
}>;
export type TradeRemoveCommand = Cmd<'trade-remove', {
  readonly entity: EntityId;
  readonly item: ItemConfigId;
  readonly amount: number;
}>;
export type TradeAcceptCommand = Cmd<'trade-accept', { readonly entity: EntityId }>;
export type TradeDeclineCommand = Cmd<'trade-decline', { readonly entity: EntityId }>;

/* -- dialogue -------------------------------------------------------------- */
export type TalkCommand = Cmd<'talk', { readonly entity: EntityId; readonly dialogue: string }>;
export type DialogueAdvanceCommand = Cmd<'dialogue-advance', {
  readonly entity: EntityId;
  readonly choice?: number;
}>;
export type TalkToCommand = Cmd<'talk-to', { readonly entity: EntityId; readonly npc: EntityId }>;
export type QuestJournalCommand = Cmd<'quest-journal', { readonly entity: EntityId }>;

/* -- slayer --------------------------------------------------------------- */
export type SlayerTaskCommand = Cmd<'slayer-task', { readonly entity: EntityId; readonly master: EntityId }>;
export type SlayerRewardCommand = Cmd<'slayer-reward', {
  readonly entity: EntityId;
  readonly master: EntityId;
  readonly reward: string;
}>;

/* -- transport ------------------------------------------------------------ */
export const TRAVEL_NETWORKS = [
  'fairy-ring', 'ship', 'charter', 'glider', 'spirit-tree', 'canoe', 'jewellery', 'tablet'
] as const;
export type TravelNetwork = (typeof TRAVEL_NETWORKS)[number];
export type TravelCommand = Cmd<'travel', {
  readonly entity: EntityId;
  readonly network: TravelNetwork;
  readonly from?: { readonly at: TileCoord; readonly loc: LocConfigId };
  readonly code?: string;
  readonly destination?: string;
  readonly item?: ItemConfigId;
}>;

/* -- social --------------------------------------------------------------- */
export type SayCommand = Cmd<'say', { readonly entity: EntityId; readonly text: string }>;
export type PmCommand = Cmd<'pm', { readonly entity: EntityId; readonly to: string; readonly text: string }>;
export type FriendCommand = Cmd<'friend', {
  readonly entity: EntityId;
  readonly name: string;
  readonly action: 'add' | 'remove' | 'ignore' | 'unignore';
}>;
export type ClanCommand = Cmd<'clan', {
  readonly entity: EntityId;
  readonly action: 'create' | 'join' | 'leave' | 'kick' | 'rank' | 'chat';
  readonly name?: string;
  readonly member?: string;
  readonly rank?: number;
  readonly text?: string;
}>;

/* -- lifecycle (admin) ----------------------------------------------------- */
export type StepCommand = Cmd<'step', { readonly ticks: number }>;
export type StopCommand = Cmd<'stop', Record<string, never>>;
export type EndCommand = Cmd<'end', { readonly reason: string }>;
export type SpawnCommand = Cmd<'spawn', {
  readonly kind: EntityKind;
  readonly at: TileCoord;
  readonly npc?: NpcConfigId;
  readonly loc?: LocConfigId;
  readonly item?: ItemConfigId;
  readonly amount?: number;
}>;
export type DespawnCommand = Cmd<'despawn', { readonly entity: EntityId }>;

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

/** Commands an ordinary actor may issue. This is the RL action space. */
export type ActorCommand =
  | WalkCommand | RunCommand | SetRunCommand | MoveCommand | ClimbCommand | OpenDoorCommand | TraverseCommand
  | AttackCommand | DisengageCommand | CastCommand | SwitchSpellbookCommand | SetStyleCommand
  | CastSelfCommand | CastOnItemCommand | CastOnGroundCommand
  | SetRetaliateCommand | PrayCommand | BuryCommand | EatCommand | DrinkCommand | SpecialCommand
  | CraftRunesCommand | EnterRuinCommand | FillPouchCommand | EmptyPouchCommand | BlessGraveCommand
  | GatherCommand | StopGatherCommand | FishCommand | StopFishCommand
  | LightCommand | CookCommand | StopCookCommand
  | SmeltCommand | SmithCommand | StopSmithCommand
  | CraftCommand | StopCraftCommand | FletchCommand | StopFletchCommand
  | CleanHerbCommand | MakePotionCommand | StopHerbloreCommand
  | PickpocketCommand | StealStallCommand
  | FarmCommand | HuntCommand | SummonCommand | ProspectCommand | MinigameCommand
  | ClueCommand | DiaryCommand | ChampionCommand | RandomEventCommand
  | VoteCommand
  | EquipCommand | UnequipCommand | DropCommand | GiveCommand | PickupCommand
  | InteractCommand | UseItemOnCommand
  | ShopViewCommand | ShopBuyCommand | ShopSellCommand
  | GeViewCommand | GePriceCommand | GeOfferCommand | GeAbortCommand | GeCollectCommand
  | BankDepositCommand | BankWithdrawCommand
  | TradeRequestCommand | TradeOfferCommand | TradeRemoveCommand | TradeAcceptCommand | TradeDeclineCommand
  | TalkCommand | DialogueAdvanceCommand | TalkToCommand | QuestJournalCommand
  | SlayerTaskCommand | SlayerRewardCommand | TravelCommand
  | SayCommand | PmCommand | FriendCommand | ClanCommand;

/** Commands gated to the admin role under AISCAPE_AUTH=1. */
export type AdminCommand = StepCommand | StopCommand | EndCommand | SpawnCommand | DespawnCommand;

export type SimCommand = ActorCommand | AdminCommand;

export type SimCommandType = SimCommand['type'];

export type CommandOf<TType extends SimCommandType> = Extract<SimCommand, { type: TType }>;

// ---------------------------------------------------------------------------
// Metadata used by action spaces and env tooling
// ---------------------------------------------------------------------------

/**
 * INSTANT   — resolves fully on the tick it is applied.
 * MULTI_TICK— starts an ongoing action a system resolves over later ticks.
 * MODE      — sets a persistent flag; no immediate world change.
 *
 * An action space that assumes one command per env step should prefer INSTANT
 * and MODE commands, or hold MULTI_TICK actions across several ticks.
 */
export type CommandTiming = 'INSTANT' | 'MULTI_TICK' | 'MODE';

export const COMMAND_TIMING: Readonly<Record<SimCommandType, CommandTiming>> = {
  walk: 'MULTI_TICK',
  run: 'MULTI_TICK',
  'set-run': 'MODE',
  move: 'INSTANT',
  climb: 'INSTANT',
  'open-door': 'INSTANT',
  traverse: 'MULTI_TICK',
  attack: 'MULTI_TICK',
  disengage: 'INSTANT',
  cast: 'MULTI_TICK',
  'switch-spellbook': 'INSTANT',
  'cast-self': 'INSTANT',
  'cast-on-item': 'INSTANT',
  'cast-on-ground': 'INSTANT',
  'set-style': 'MODE',
  'set-retaliate': 'MODE',
  pray: 'MODE',
  bury: 'INSTANT',
  eat: 'INSTANT',
  drink: 'INSTANT',
  special: 'MODE',
  'craft-runes': 'MULTI_TICK',
  'enter-ruin': 'INSTANT',
  'fill-pouch': 'INSTANT',
  'empty-pouch': 'INSTANT',
  'bless-grave': 'INSTANT',
  gather: 'MULTI_TICK',
  'stop-gather': 'INSTANT',
  fish: 'MULTI_TICK',
  'stop-fish': 'INSTANT',
  light: 'MULTI_TICK',
  cook: 'MULTI_TICK',
  'stop-cook': 'INSTANT',
  smelt: 'MULTI_TICK',
  smith: 'MULTI_TICK',
  'stop-smith': 'INSTANT',
  craft: 'MULTI_TICK',
  'stop-craft': 'INSTANT',
  fletch: 'MULTI_TICK',
  'stop-fletch': 'INSTANT',
  'clean-herb': 'MULTI_TICK',
  'make-potion': 'MULTI_TICK',
  'stop-herblore': 'INSTANT',
  pickpocket: 'MULTI_TICK',
  'steal-stall': 'MULTI_TICK',
  farm: 'MULTI_TICK',
  hunt: 'MULTI_TICK',
  summon: 'MULTI_TICK',
  prospect: 'INSTANT',
  minigame: 'INSTANT',
  clue: 'INSTANT',
  diary: 'INSTANT',
  champion: 'INSTANT',
  'random-event': 'INSTANT',
  vote: 'INSTANT',
  equip: 'INSTANT',
  unequip: 'INSTANT',
  drop: 'INSTANT',
  give: 'INSTANT',
  pickup: 'INSTANT',
  interact: 'MULTI_TICK',
  'use-item-on': 'MULTI_TICK',
  'shop-view': 'INSTANT',
  'shop-buy': 'INSTANT',
  'shop-sell': 'INSTANT',
  'ge-view': 'INSTANT',
  'ge-price': 'INSTANT',
  'ge-offer': 'INSTANT',
  'ge-abort': 'INSTANT',
  'ge-collect': 'INSTANT',
  'bank-deposit': 'INSTANT',
  'bank-withdraw': 'INSTANT',
  'trade-request': 'INSTANT',
  'trade-offer': 'INSTANT',
  'trade-remove': 'INSTANT',
  'trade-accept': 'INSTANT',
  'trade-decline': 'INSTANT',
  talk: 'INSTANT',
  'talk-to': 'INSTANT',
  'dialogue-advance': 'INSTANT',
  'quest-journal': 'INSTANT',
  'slayer-task': 'INSTANT',
  'slayer-reward': 'INSTANT',
  travel: 'MULTI_TICK',
  say: 'INSTANT',
  pm: 'INSTANT',
  friend: 'INSTANT',
  clan: 'INSTANT',
  step: 'INSTANT',
  stop: 'INSTANT',
  end: 'INSTANT',
  spawn: 'INSTANT',
  despawn: 'INSTANT'
};

export const ADMIN_COMMAND_TYPES: readonly SimCommandType[] =
  Object.freeze(['despawn', 'end', 'spawn', 'step', 'stop'] as SimCommandType[]);

const ADMIN_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(ADMIN_COMMAND_TYPES);

/** The RL action space: every command an ordinary actor may issue, sorted. */
export const ACTOR_COMMAND_TYPES: readonly SimCommandType[] = Object.freeze(
  (Object.keys(COMMAND_TIMING) as SimCommandType[])
    .filter((type) => !ADMIN_COMMAND_TYPE_SET.has(type))
    .sort()
);

// ---------------------------------------------------------------------------
// Rejection codes
// ---------------------------------------------------------------------------

/**
 * Every rejection code the simulation can return. Stable: codes are part of the
 * public contract and never change meaning without a protocol version bump.
 * Grouped by cause so action spaces and reward functions can classify failures
 * (a malformed action is a policy bug; `too_far` is a legitimate world signal).
 */
export const NACK_MALFORMED = [
  'invalid_command', 'invalid_data', 'invalid_json', 'binary_not_supported',
  'instance_mismatch', 'unknown_command', 'internal_error',
  'invalid_attack', 'invalid_attack_style', 'invalid_bank_deposit', 'invalid_bank_withdraw',
  'invalid_bury', 'invalid_cast', 'invalid_cast_self', 'invalid_cast_on_item',
  'invalid_cast_on_ground', 'invalid_choice', 'invalid_climb', 'invalid_cook',
  'invalid_craft', 'invalid_despawn', 'invalid_dialogue_advance', 'invalid_disengage',
  'invalid_drop', 'invalid_eat', 'invalid_equip', 'invalid_fish', 'invalid_fletch',
  'invalid_gather', 'invalid_give',
  'invalid_inventory_slot', 'invalid_light', 'invalid_move', 'invalid_option',
  'invalid_pickpocket', 'invalid_pickup', 'invalid_pray', 'invalid_reason',
  'invalid_set_retaliate', 'invalid_set_style', 'invalid_shop_buy', 'invalid_shop_sell',
  'invalid_shop_view', 'invalid_smelt', 'invalid_smith', 'invalid_spawn', 'invalid_spell',
  'invalid_steal_stall', 'invalid_stop_cook', 'invalid_stop_craft', 'invalid_stop_fish',
  'invalid_stop_gather', 'invalid_stop_smith', 'invalid_talk', 'invalid_target',
  'invalid_ticks', 'invalid_traverse', 'invalid_unequip', 'invalid_actor', 'invalid_open_door',
  'invalid_ge_view', 'invalid_ge_price', 'invalid_ge_offer', 'invalid_ge_abort', 'invalid_ge_collect',
  'invalid_interact', 'invalid_use_item_on',
  'invalid_trade_request', 'invalid_trade_offer', 'invalid_trade_remove', 'invalid_trade_accept',
  'invalid_trade_decline', 'invalid_stop_fletch', 'invalid_clean_herb', 'invalid_make_potion',
  'invalid_stop_herblore', 'invalid_special', 'invalid_drink', 'invalid_set_run',
  'invalid_craft_runes', 'invalid_enter_ruin', 'invalid_fill_pouch', 'invalid_empty_pouch',
  'invalid_bless_grave', 'invalid_talk_to', 'invalid_quest_journal',
  'invalid_slayer_task', 'invalid_slayer_reward', 'invalid_travel', 'invalid_say',
  'invalid_pm', 'invalid_friend', 'invalid_clan', 'invalid_farm', 'invalid_hunt',
  'invalid_summon', 'invalid_prospect', 'invalid_minigame', 'invalid_clue',
  'invalid_diary', 'invalid_champion', 'invalid_random_event', 'invalid_switch_spellbook'
] as const;

export const NACK_AUTH = [
  'not_authorized', 'invalid_token', 'rate_limited', 'instance_ended', 'realtime_running'
] as const;

export const NACK_UNKNOWN_REFERENT = [
  'not_found', 'unknown_entity', 'unknown_config_id', 'unknown_cookable', 'unknown_course',
  'unknown_dialogue', 'unknown_loc', 'unknown_log', 'unknown_node', 'unknown_obstacle',
  'unknown_prayer', 'unknown_recipe', 'unknown_spell', 'unknown_stall', 'unknown_target',
  'no_scenario', 'no_shop', 'no_stats', 'no_world', 'no_prayer',
  'no_heat_source', 'no_destination', 'no_bank_nearby', 'ambiguous_climb', 'unknown_door',
  'no_exchange', 'no_offer', 'no_poll'
] as const;

/** Legitimate world feedback: the action was well-formed but the world said no. */
export const NACK_WORLD = [
  'too_far', 'not_adjacent', 'unreachable', 'same_entity', 'busy', 'stunned', 'eliminated',
  'depleted', 'stall_empty', 'tile_occupied', 'eat_cooldown', 'level_too_low',
  'no_points', 'no_runes', 'inventory_full', 'bank_full', 'shop_full',
  'not_enough_space', 'insufficient_bank', 'insufficient_funds', 'insufficient_stock',
  'missing_bait', 'missing_hammer', 'missing_item', 'missing_log', 'missing_materials',
  'missing_raw', 'missing_tinderbox', 'missing_tool', 'missing_ingredient',
  'empty_slot', 'not_bones', 'not_edible', 'not_equipped', 'not_equippable',
  'not_owner', 'not_stocked', 'not_tradeable', 'cannot_sell_currency',
  'trade_busy', 'trade_pending', 'no_trade', 'trade_declined', 'trade_full', 'invalid_product',
  'choice_required', 'spell_requires_magic',
  /* magic */
  'wrong_spell_target', 'wrong_spellbook', 'requires_weapon', 'not_alchemisable', 'not_enchantable',
  'not_superheatable', 'not_convertible', 'teleport_cooldown', 'bound',
  'exchange_full', 'offer_not_open', 'nothing_to_collect', 'price_too_high', 'not_noteable',
  'special_energy', 'no_special', 'not_poisoned', 'immune', 'no_altar', 'wrong_talisman',
  'pouch_full', 'pouch_empty', 'pouch_degraded', 'single_combat', 'wilderness_level',
  'safe_zone', 'not_in_wilderness', 'out_of_energy',
  'no_handler', 'unknown_option',
  'no_dialogue', 'quest_locked', 'quest_requirements', 'no_task', 'task_active',
  'slayer_level', 'insufficient_points', 'unknown_destination', 'locked_destination',
  'no_fare', 'no_charges', 'unknown_player', 'ignored', 'no_clan', 'clan_exists',
  'clan_rank', 'muted', 'text_too_long',
  'patch_state', 'wrong_patch', 'no_seed', 'patch_dead', 'trap_limit', 'no_trap',
  'trap_empty', 'hunter_level', 'no_familiar', 'familiar_active', 'summoning_points',
  'familiar_full', 'wrong_obelisk', 'no_lobby', 'lobby_full', 'not_ready',
  'game_in_progress', 'stake_mismatch',
  'no_clue', 'wrong_location', 'wrong_emote', 'wrong_answer', 'no_event',
  'event_active', 'diary_locked', 'no_scroll', 'not_eligible', 'poll_closed'
] as const;

export type NackCategory = 'malformed' | 'auth' | 'unknown-referent' | 'world';

const NACK_CATEGORY = new Map<string, NackCategory>([
  ...NACK_MALFORMED.map((code) => [code, 'malformed'] as const),
  ...NACK_AUTH.map((code) => [code, 'auth'] as const),
  ...NACK_UNKNOWN_REFERENT.map((code) => [code, 'unknown-referent'] as const),
  ...NACK_WORLD.map((code) => [code, 'world'] as const)
]);

export function nackCategory(code: string): NackCategory | undefined {
  return NACK_CATEGORY.get(code);
}
