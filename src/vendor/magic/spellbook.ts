import type { SkillName, TileCoord } from '../shared/index.ts';
import { RUNE_IDS } from './runes.ts';

export type RuneCost = { readonly item: number; readonly amount: number };
export type Spellbook = 'modern' | 'ancient';
export type SpellTarget = 'entity' | 'self' | 'item' | 'ground-item';
export type SpellKind =
  | 'combat' | 'curse' | 'bind' | 'teleport' | 'alchemy' | 'superheat'
  | 'enchant' | 'convert-bones' | 'telegrab' | 'charge';
export type DrainSkill = 'attack' | 'strength' | 'defence' | 'magic';
export interface SpellGfx {
  readonly anim?: number;
  readonly cast?: number;
  readonly projectile?: number;
  readonly impact?: number;
}
interface SpellBase {
  readonly id: SpellId;
  readonly name: string;
  readonly level: number;
  /** Flat magic XP on every accepted cast. */
  readonly xp: number;
  readonly runes: readonly RuneCost[];
  readonly target: SpellTarget;
  readonly kind: SpellKind;
  /** Item ids, any one of which must be in the weapon slot. */
  readonly requiredWeapons?: readonly number[];
  readonly requiredSkills?: readonly { readonly skill: SkillName; readonly level: number }[];
  readonly gfx: SpellGfx;
  /** Short one-line description for UI/tooltips. */
  readonly description: string;
}
export interface CombatSpellDef extends SpellBase {
  readonly kind: 'combat';
  readonly target: 'entity';
  readonly baseMaxHit: number;
  /** Attack-roll multiplier ported from 2009scape SpellType.java. */
  readonly accuracyMod: number;
  /** Element for elemental spells; used by clients for colouring. */
  readonly element?: 'air' | 'water' | 'earth' | 'fire';
  readonly tier?: 'strike' | 'bolt' | 'blast' | 'wave';
  readonly undeadOnly?: true;
  /** Ancient combat effects applied on an accurate impact. */
  readonly freezeTicks?: number;
  readonly attackDrainPercent?: number;
  readonly healPercentOfDamage?: number;
  readonly poisonSeverity?: number;
  /** Applied on an accurate impact. */
  readonly onHit?:
    | { readonly kind: 'drain'; readonly skill: DrainSkill; readonly percent: number }
    | { readonly kind: 'drain-prayer'; readonly amount: number };
}
export interface CurseSpellDef extends SpellBase {
  readonly kind: 'curse';
  readonly target: 'entity';
  /** Attack-roll multiplier ported from 2009scape SpellType.java. */
  readonly accuracyMod: number;
  readonly effect: { readonly kind: 'drain'; readonly skill: DrainSkill; readonly percent: number };
}
export interface BindSpellDef extends SpellBase {
  readonly kind: 'bind';
  readonly target: 'entity';
  /** Attack-roll multiplier ported from 2009scape SpellType.java. */
  readonly accuracyMod: number;
  readonly freezeTicks: number;
  readonly baseMaxHit: number;
}
export interface TeleportSpellDef extends SpellBase {
  readonly kind: 'teleport';
  readonly target: 'self';
  readonly destination: TileCoord;
  readonly cooldownTicks?: number;
}
export interface AlchemySpellDef extends SpellBase {
  readonly kind: 'alchemy';
  readonly target: 'item';
  readonly ratio: number;
  readonly delayTicks: number;
}
export interface SuperheatSpellDef extends SpellBase { readonly kind: 'superheat'; readonly target: 'item' }
export interface EnchantSpellDef extends SpellBase {
  readonly kind: 'enchant';
  readonly target: 'item';
  readonly products: readonly { readonly from: number; readonly to: number }[];
}
export interface ConvertBonesSpellDef extends SpellBase {
  readonly kind: 'convert-bones';
  readonly target: 'self';
  readonly product: number;
  readonly bones: readonly number[];
}
export interface TelegrabSpellDef extends SpellBase {
  readonly kind: 'telegrab';
  readonly target: 'ground-item';
  readonly range: number;
}
export interface ChargeSpellDef extends SpellBase {
  readonly kind: 'charge';
  readonly target: 'self';
  readonly durationTicks: number;
}
export type SpellDef = CombatSpellDef | CurseSpellDef | BindSpellDef | TeleportSpellDef
  | AlchemySpellDef | SuperheatSpellDef | EnchantSpellDef | ConvertBonesSpellDef
  | TelegrabSpellDef | ChargeSpellDef;
export type EntitySpellDef = CombatSpellDef | CurseSpellDef | BindSpellDef;

export type SpellId =
  | 'wind-strike' | 'water-strike' | 'earth-strike' | 'fire-strike'
  | 'wind-bolt' | 'water-bolt' | 'earth-bolt' | 'fire-bolt'
  | 'wind-blast' | 'water-blast' | 'earth-blast' | 'fire-blast'
  | 'wind-wave' | 'water-wave' | 'earth-wave' | 'fire-wave'
  | 'confuse' | 'weaken' | 'curse' | 'vulnerability' | 'enfeeble' | 'stun'
  | 'bind' | 'snare' | 'entangle'
  | 'crumble-undead' | 'iban-blast' | 'magic-dart'
  | 'saradomin-strike' | 'claws-of-guthix' | 'flames-of-zamorak'
  | 'home-teleport' | 'varrock-teleport' | 'lumbridge-teleport' | 'falador-teleport'
  | 'camelot-teleport' | 'ardougne-teleport' | 'watchtower-teleport'
  | 'trollheim-teleport' | 'ape-atoll-teleport'
  | 'bones-to-bananas' | 'bones-to-peaches' | 'charge'
  | 'low-alchemy' | 'high-alchemy' | 'superheat-item'
  | 'enchant-sapphire' | 'enchant-emerald' | 'enchant-ruby'
  | 'enchant-diamond' | 'enchant-dragonstone' | 'enchant-onyx'
  | 'telekinetic-grab'
  | 'smoke-rush' | 'shadow-rush' | 'blood-rush' | 'ice-rush'
  | 'smoke-blitz' | 'shadow-blitz' | 'blood-blitz' | 'ice-blitz';

const { air: AIR, water: WATER, earth: EARTH, fire: FIRE, mind: MIND, body: BODY,
  chaos: CHAOS, death: DEATH, nature: NATURE, law: LAW, cosmic: COSMIC,
  blood: BLOOD, soul: SOUL } = RUNE_IDS;

const r = (...entries: readonly (readonly [number, number])[]): readonly RuneCost[] =>
  Object.freeze(entries.map(([item, amount]) => Object.freeze({ item, amount })));
const gfx = (anim?: number, cast?: number, projectile?: number, impact?: number): SpellGfx =>
  Object.freeze({ ...(anim === undefined ? {} : { anim }), ...(cast === undefined ? {} : { cast }),
    ...(projectile === undefined ? {} : { projectile }), ...(impact === undefined ? {} : { impact }) });
const products = (...entries: readonly (readonly [number, number])[]) => Object.freeze(
  entries.map(([from, to]) => Object.freeze({ from, to }))
);
const destination = (x: number, z: number, level: number): TileCoord => Object.freeze({ x, z, level });

const elementals: readonly CombatSpellDef[] = Object.freeze(([
  // Gfx/runes ported from 2009scape AirSpell.java, WaterSpell.java, EarthSpell.java and FireSpell.java.
  { id: 'wind-strike', name: 'Wind Strike', level: 1, xp: 5.5, runes: r([MIND, 1], [AIR, 1]), target: 'entity', kind: 'combat', baseMaxHit: 2, accuracyMod: 1, element: 'air', tier: 'strike', gfx: gfx(711, 90, 91, 92), description: 'A basic air spell that strikes one target.' },
  { id: 'water-strike', name: 'Water Strike', level: 5, xp: 7.5, runes: r([MIND, 1], [WATER, 1], [AIR, 1]), target: 'entity', kind: 'combat', baseMaxHit: 4, accuracyMod: 1, element: 'water', tier: 'strike', gfx: gfx(711, 93, 94, 95), description: 'A basic water spell that strikes one target.' },
  { id: 'earth-strike', name: 'Earth Strike', level: 9, xp: 9.5, runes: r([MIND, 1], [EARTH, 2], [AIR, 1]), target: 'entity', kind: 'combat', baseMaxHit: 6, accuracyMod: 1, element: 'earth', tier: 'strike', gfx: gfx(711, 96, 97, 98), description: 'A basic earth spell that strikes one target.' },
  { id: 'fire-strike', name: 'Fire Strike', level: 13, xp: 11.5, runes: r([MIND, 1], [FIRE, 3], [AIR, 2]), target: 'entity', kind: 'combat', baseMaxHit: 8, accuracyMod: 1, element: 'fire', tier: 'strike', gfx: gfx(711, 99, 100, 101), description: 'A basic fire spell that strikes one target.' },
  { id: 'wind-bolt', name: 'Wind Bolt', level: 17, xp: 13.5, runes: r([CHAOS, 1], [AIR, 2]), target: 'entity', kind: 'combat', baseMaxHit: 9, accuracyMod: 1.1, element: 'air', tier: 'bolt', gfx: gfx(711, 117, 118, 119), description: 'An air bolt that damages one target.' },
  { id: 'water-bolt', name: 'Water Bolt', level: 23, xp: 16.5, runes: r([CHAOS, 1], [WATER, 2], [AIR, 2]), target: 'entity', kind: 'combat', baseMaxHit: 10, accuracyMod: 1.1, element: 'water', tier: 'bolt', gfx: gfx(711, 120, 121, 122), description: 'A water bolt that damages one target.' },
  { id: 'earth-bolt', name: 'Earth Bolt', level: 29, xp: 19.5, runes: r([CHAOS, 1], [EARTH, 3], [AIR, 2]), target: 'entity', kind: 'combat', baseMaxHit: 11, accuracyMod: 1.1, element: 'earth', tier: 'bolt', gfx: gfx(711, 123, 124, 125), description: 'An earth bolt that damages one target.' },
  { id: 'fire-bolt', name: 'Fire Bolt', level: 35, xp: 22.5, runes: r([CHAOS, 1], [FIRE, 4], [AIR, 3]), target: 'entity', kind: 'combat', baseMaxHit: 12, accuracyMod: 1.1, element: 'fire', tier: 'bolt', gfx: gfx(711, 126, 127, 128), description: 'A fire bolt that damages one target.' },
  { id: 'wind-blast', name: 'Wind Blast', level: 41, xp: 25.5, runes: r([DEATH, 1], [AIR, 3]), target: 'entity', kind: 'combat', baseMaxHit: 13, accuracyMod: 1.2, element: 'air', tier: 'blast', gfx: gfx(711, 132, 133, 134), description: 'A powerful air blast against one target.' },
  { id: 'water-blast', name: 'Water Blast', level: 47, xp: 28.5, runes: r([DEATH, 1], [WATER, 3], [AIR, 3]), target: 'entity', kind: 'combat', baseMaxHit: 14, accuracyMod: 1.2, element: 'water', tier: 'blast', gfx: gfx(711, 135, 136, 137), description: 'A powerful water blast against one target.' },
  { id: 'earth-blast', name: 'Earth Blast', level: 53, xp: 31.5, runes: r([DEATH, 1], [EARTH, 4], [AIR, 3]), target: 'entity', kind: 'combat', baseMaxHit: 15, accuracyMod: 1.2, element: 'earth', tier: 'blast', gfx: gfx(711, 138, 139, 140), description: 'A powerful earth blast against one target.' },
  { id: 'fire-blast', name: 'Fire Blast', level: 59, xp: 34.5, runes: r([DEATH, 1], [FIRE, 5], [AIR, 4]), target: 'entity', kind: 'combat', baseMaxHit: 16, accuracyMod: 1.2, element: 'fire', tier: 'blast', gfx: gfx(711, 129, 130, 131), description: 'A powerful fire blast against one target.' },
  { id: 'wind-wave', name: 'Wind Wave', level: 62, xp: 36, runes: r([BLOOD, 1], [AIR, 5]), target: 'entity', kind: 'combat', baseMaxHit: 17, accuracyMod: 1.3, element: 'air', tier: 'wave', gfx: gfx(711, 158, 159, 160), description: 'A high-level wave of air against one target.' },
  { id: 'water-wave', name: 'Water Wave', level: 65, xp: 37.5, runes: r([BLOOD, 1], [WATER, 7], [AIR, 5]), target: 'entity', kind: 'combat', baseMaxHit: 18, accuracyMod: 1.3, element: 'water', tier: 'wave', gfx: gfx(711, 161, 162, 163), description: 'A high-level wave of water against one target.' },
  { id: 'earth-wave', name: 'Earth Wave', level: 70, xp: 40, runes: r([BLOOD, 1], [EARTH, 7], [AIR, 5]), target: 'entity', kind: 'combat', baseMaxHit: 19, accuracyMod: 1.3, element: 'earth', tier: 'wave', gfx: gfx(711, 164, 165, 166), description: 'A high-level wave of earth against one target.' },
  { id: 'fire-wave', name: 'Fire Wave', level: 75, xp: 42.5, runes: r([BLOOD, 1], [FIRE, 7], [AIR, 5]), target: 'entity', kind: 'combat', baseMaxHit: 20, accuracyMod: 1.3, element: 'fire', tier: 'wave', gfx: gfx(711, 155, 156, 157), description: 'A high-level wave of fire against one target.' }
] satisfies CombatSpellDef[]).map((spell) => Object.freeze(spell)));

// Accuracy modifiers are ported from 2009scape SpellType.java.
const curses: readonly CurseSpellDef[] = Object.freeze(([
  { id: 'confuse', name: 'Confuse', level: 3, xp: 13, runes: r([BODY, 1], [EARTH, 2], [WATER, 3]), target: 'entity', kind: 'curse', accuracyMod: 1.15, effect: { kind: 'drain', skill: 'attack', percent: 0.05 }, gfx: gfx(716, 102, 103, 104), description: 'Reduces a target’s Attack by five percent.' },
  { id: 'weaken', name: 'Weaken', level: 11, xp: 21, runes: r([BODY, 1], [EARTH, 2], [WATER, 3]), target: 'entity', kind: 'curse', accuracyMod: 1.15, effect: { kind: 'drain', skill: 'strength', percent: 0.05 }, gfx: gfx(716, 105, 106, 107), description: 'Reduces a target’s Strength by five percent.' },
  { id: 'curse', name: 'Curse', level: 19, xp: 29, runes: r([BODY, 1], [EARTH, 3], [WATER, 2]), target: 'entity', kind: 'curse', accuracyMod: 1.15, effect: { kind: 'drain', skill: 'defence', percent: 0.05 }, gfx: gfx(716, 108, 109, 110), description: 'Reduces a target’s Defence by five percent.' },
  { id: 'vulnerability', name: 'Vulnerability', level: 66, xp: 76, runes: r([SOUL, 1], [EARTH, 5], [WATER, 5]), target: 'entity', kind: 'curse', accuracyMod: 1.25, effect: { kind: 'drain', skill: 'defence', percent: 0.1 }, gfx: gfx(729, 167, 168, 169), description: 'Reduces a target’s Defence by ten percent.' },
  { id: 'enfeeble', name: 'Enfeeble', level: 73, xp: 83, runes: r([SOUL, 1], [EARTH, 8], [WATER, 8]), target: 'entity', kind: 'curse', accuracyMod: 1.25, effect: { kind: 'drain', skill: 'strength', percent: 0.1 }, gfx: gfx(729, 170, 171, 172), description: 'Reduces a target’s Strength by ten percent.' },
  { id: 'stun', name: 'Stun', level: 80, xp: 90, runes: r([SOUL, 1], [EARTH, 12], [WATER, 12]), target: 'entity', kind: 'curse', accuracyMod: 1.25, effect: { kind: 'drain', skill: 'attack', percent: 0.1 }, gfx: gfx(729, 173, 174, 107), description: 'Reduces a target’s Attack by ten percent.' }
] satisfies CurseSpellDef[]).map((spell) => Object.freeze({ ...spell, effect: Object.freeze(spell.effect) })));

const binds: readonly BindSpellDef[] = Object.freeze(([
  // Ported from 2009scape BindSpell.java.
  { id: 'bind', name: 'Bind', level: 20, xp: 30, runes: r([NATURE, 2], [EARTH, 3], [WATER, 3]), target: 'entity', kind: 'bind', accuracyMod: 1.1, freezeTicks: 9, baseMaxHit: 0, gfx: gfx(710, 177, 178, 181), description: 'Holds a target in place for nine ticks.' },
  { id: 'snare', name: 'Snare', level: 50, xp: 60, runes: r([NATURE, 3], [EARTH, 4], [WATER, 4]), target: 'entity', kind: 'bind', accuracyMod: 1.2, freezeTicks: 17, baseMaxHit: 3, gfx: gfx(710, 177, 178, 180), description: 'Damages and holds a target for seventeen ticks.' },
  { id: 'entangle', name: 'Entangle', level: 79, xp: 89, runes: r([NATURE, 4], [EARTH, 5], [WATER, 5]), target: 'entity', kind: 'bind', accuracyMod: 1.3, freezeTicks: 25, baseMaxHit: 5, gfx: gfx(710, 177, 178, 179), description: 'Damages and holds a target for twenty-five ticks.' }
] satisfies BindSpellDef[]).map((spell) => Object.freeze(spell)));

const otherCombat: readonly CombatSpellDef[] = Object.freeze(([
  { id: 'crumble-undead', name: 'Crumble Undead', level: 39, xp: 24.5, runes: r([EARTH, 2], [AIR, 2], [CHAOS, 1]), target: 'entity', kind: 'combat', accuracyMod: 1.2, baseMaxHit: 15, undeadOnly: true, gfx: gfx(724, 145, 146, 147), description: 'A specialised attack that can only target the undead.' },
  { id: 'iban-blast', name: 'Iban Blast', level: 50, xp: 60.5, runes: r([FIRE, 5], [DEATH, 1]), target: 'entity', kind: 'combat', accuracyMod: 1.4, baseMaxHit: 25, requiredWeapons: Object.freeze([1409]), gfx: gfx(708, 87, 88, 89), description: 'A powerful blast cast through Iban’s staff.' },
  { id: 'magic-dart', name: 'Magic Dart', level: 50, xp: 30, runes: r([DEATH, 1], [MIND, 4]), target: 'entity', kind: 'combat', accuracyMod: 1.15, baseMaxHit: 0, requiredWeapons: Object.freeze([4170]), requiredSkills: Object.freeze([{ skill: 'slayer' as const, level: 55 }]), gfx: gfx(1576, undefined, 330, 331), description: 'A Slayer staff spell whose damage scales with Magic.' },
  { id: 'saradomin-strike', name: 'Saradomin Strike', level: 60, xp: 35, runes: r([BLOOD, 2], [FIRE, 2], [AIR, 4]), target: 'entity', kind: 'combat', accuracyMod: 1.2, baseMaxHit: 20, requiredWeapons: Object.freeze([2415]), onHit: { kind: 'drain-prayer', amount: 1 }, gfx: gfx(811, undefined, undefined, 76), description: 'Calls Saradomin’s power and drains one Prayer point.' },
  { id: 'claws-of-guthix', name: 'Claws of Guthix', level: 60, xp: 35, runes: r([BLOOD, 2], [FIRE, 1], [AIR, 4]), target: 'entity', kind: 'combat', accuracyMod: 1.2, baseMaxHit: 20, requiredWeapons: Object.freeze([2416]), onHit: { kind: 'drain', skill: 'defence', percent: 0.05 }, gfx: gfx(811, undefined, undefined, 77), description: 'Calls Guthix’s power and lowers Defence on impact.' },
  { id: 'flames-of-zamorak', name: 'Flames of Zamorak', level: 60, xp: 35, runes: r([BLOOD, 2], [FIRE, 4], [AIR, 1]), target: 'entity', kind: 'combat', accuracyMod: 1.2, baseMaxHit: 20, requiredWeapons: Object.freeze([2417]), onHit: { kind: 'drain', skill: 'magic', percent: 0.05 }, gfx: gfx(811, undefined, undefined, 78), description: 'Calls Zamorak’s power and lowers Magic on impact.' }
] satisfies CombatSpellDef[]).map((spell) => Object.freeze({ ...spell, ...(spell.onHit === undefined ? {} : { onHit: Object.freeze(spell.onHit) }) })));

const BONES = Object.freeze([526, 2530, 3187, 2859, 528, 3179, 3180, 3181, 3182, 3183, 3185, 3186, 530, 532, 3125, 4812, 3123, 534, 6812, 536, 4830, 4832, 6729, 4834, 3127, 3128, 3129, 3130, 3131, 3132, 3133]);
const teleportGfx = gfx(8939, 1576);

const selfSpells: readonly SpellDef[] = Object.freeze(([
  // Destinations/runes ported from 2009scape ModernListeners.kt.
  { id: 'home-teleport', name: 'Home Teleport', level: 1, xp: 0, runes: r(), target: 'self', kind: 'teleport', destination: destination(3222, 3218, 0), cooldownTicks: 3000, gfx: teleportGfx, description: 'Teleports home to Lumbridge with a long cooldown.' },
  { id: 'varrock-teleport', name: 'Varrock Teleport', level: 25, xp: 35, runes: r([FIRE, 1], [AIR, 3], [LAW, 1]), target: 'self', kind: 'teleport', destination: destination(3213, 3424, 0), gfx: teleportGfx, description: 'Teleports the caster to central Varrock.' },
  { id: 'lumbridge-teleport', name: 'Lumbridge Teleport', level: 31, xp: 41, runes: r([EARTH, 1], [AIR, 3], [LAW, 1]), target: 'self', kind: 'teleport', destination: destination(3221, 3219, 0), gfx: teleportGfx, description: 'Teleports the caster to Lumbridge.' },
  { id: 'falador-teleport', name: 'Falador Teleport', level: 37, xp: 47, runes: r([WATER, 1], [AIR, 3], [LAW, 1]), target: 'self', kind: 'teleport', destination: destination(2965, 3378, 0), gfx: teleportGfx, description: 'Teleports the caster to Falador.' },
  { id: 'camelot-teleport', name: 'Camelot Teleport', level: 45, xp: 55.5, runes: r([AIR, 5], [LAW, 1]), target: 'self', kind: 'teleport', destination: destination(2758, 3478, 0), gfx: teleportGfx, description: 'Teleports the caster to Camelot.' },
  { id: 'ardougne-teleport', name: 'Ardougne Teleport', level: 51, xp: 61, runes: r([WATER, 2], [LAW, 2]), target: 'self', kind: 'teleport', destination: destination(2662, 3307, 0), gfx: teleportGfx, description: 'Teleports the caster to Ardougne.' },
  { id: 'watchtower-teleport', name: 'Watchtower Teleport', level: 58, xp: 68, runes: r([EARTH, 2], [LAW, 2]), target: 'self', kind: 'teleport', destination: destination(2549, 3112, 0), gfx: teleportGfx, description: 'Teleports the caster to the Watchtower.' },
  { id: 'trollheim-teleport', name: 'Trollheim Teleport', level: 61, xp: 68, runes: r([FIRE, 2], [LAW, 2]), target: 'self', kind: 'teleport', destination: destination(2891, 3678, 0), gfx: teleportGfx, description: 'Teleports the caster to Trollheim.' },
  { id: 'ape-atoll-teleport', name: 'Ape Atoll Teleport', level: 64, xp: 74, runes: r([FIRE, 2], [WATER, 2], [LAW, 2], [1963, 1]), target: 'self', kind: 'teleport', destination: destination(2795, 2798, 1), gfx: teleportGfx, description: 'Teleports the caster to Ape Atoll.' },
  { id: 'bones-to-bananas', name: 'Bones to Bananas', level: 15, xp: 25, runes: r([EARTH, 2], [WATER, 2], [NATURE, 1]), target: 'self', kind: 'convert-bones', product: 1963, bones: BONES, gfx: gfx(722, 141), description: 'Converts every carried bone into a banana.' },
  { id: 'bones-to-peaches', name: 'Bones to Peaches', level: 60, xp: 65, runes: r([EARTH, 4], [WATER, 4], [NATURE, 2]), target: 'self', kind: 'convert-bones', product: 6883, bones: BONES, gfx: gfx(722, 141), description: 'Converts every carried bone into a peach.' },
  { id: 'charge', name: 'Charge', level: 80, xp: 180, runes: r([FIRE, 3], [BLOOD, 3], [AIR, 3]), target: 'self', kind: 'charge', durationTicks: 700, gfx: gfx(811, 6), description: 'Empowers god spells for seven hundred ticks.' }
] satisfies SpellDef[]).map((spell) => Object.freeze(spell)));

const itemSpells: readonly SpellDef[] = Object.freeze(([
  // Alchemy/superheat data ported from 2009scape ModernListeners.kt.
  { id: 'low-alchemy', name: 'Low Level Alchemy', level: 21, xp: 31, runes: r([FIRE, 3], [NATURE, 1]), target: 'item', kind: 'alchemy', ratio: 0.4, delayTicks: 5, gfx: gfx(9623, 763), description: 'Converts one item into forty percent of its value in coins.' },
  { id: 'high-alchemy', name: 'High Level Alchemy', level: 55, xp: 65, runes: r([FIRE, 5], [NATURE, 1]), target: 'item', kind: 'alchemy', ratio: 0.6, delayTicks: 5, gfx: gfx(9631, 1691), description: 'Converts one item into sixty percent of its value in coins.' },
  { id: 'superheat-item', name: 'Superheat Item', level: 43, xp: 53, runes: r([FIRE, 4], [NATURE, 1]), target: 'item', kind: 'superheat', gfx: gfx(725, 148), description: 'Smelts a carried ore into its matching bar.' },
  // Jewellery tables ported from 2009scape EnchantSpell.kt.
  { id: 'enchant-sapphire', name: 'Lvl-1 Enchant', level: 7, xp: 17.5, runes: r([COSMIC, 1], [WATER, 1]), target: 'item', kind: 'enchant', products: products([1637, 2550], [1656, 3853], [1694, 1727], [11072, 11074], [6899, 6902], [6898, 6902], [6900, 6902], [6901, 6902], [6903, 6902]), gfx: gfx(712, 114), description: 'Enchants sapphire jewellery.' },
  { id: 'enchant-emerald', name: 'Lvl-2 Enchant', level: 27, xp: 37, runes: r([COSMIC, 1], [AIR, 3]), target: 'item', kind: 'enchant', products: products([1639, 2552], [1658, 5521], [1696, 1729], [11076, 11079], [6899, 6902], [6898, 6902], [6900, 6902], [6901, 6902], [6903, 6902]), gfx: gfx(712, 114), description: 'Enchants emerald jewellery.' },
  { id: 'enchant-ruby', name: 'Lvl-3 Enchant', level: 49, xp: 59, runes: r([COSMIC, 1], [FIRE, 5]), target: 'item', kind: 'enchant', products: products([1641, 2568], [1660, 11194], [1698, 1725], [11085, 11088], [6899, 6902], [6898, 6902], [6900, 6902], [6901, 6902], [6903, 6902]), gfx: gfx(712, 114), description: 'Enchants ruby jewellery.' },
  { id: 'enchant-diamond', name: 'Lvl-4 Enchant', level: 57, xp: 67, runes: r([COSMIC, 1], [EARTH, 10]), target: 'item', kind: 'enchant', products: products([1643, 2570], [1662, 11090], [1700, 1731], [11092, 11095], [6899, 6902], [6898, 6902], [6900, 6902], [6901, 6902], [6903, 6902]), gfx: gfx(712, 114), description: 'Enchants diamond jewellery.' },
  { id: 'enchant-dragonstone', name: 'Lvl-5 Enchant', level: 68, xp: 78, runes: r([COSMIC, 1], [WATER, 15], [EARTH, 15]), target: 'item', kind: 'enchant', products: products([1645, 2572], [1664, 11113], [1702, 1704], [11115, 11126], [6899, 6902], [6898, 6902], [6900, 6902], [6901, 6902], [6903, 6902]), gfx: gfx(712, 114), description: 'Enchants dragonstone jewellery.' },
  { id: 'enchant-onyx', name: 'Lvl-6 Enchant', level: 87, xp: 97, runes: r([COSMIC, 1], [FIRE, 20], [EARTH, 20]), target: 'item', kind: 'enchant', products: products([6575, 6583], [6577, 11128], [6581, 6585], [11130, 11133], [6899, 6902], [6898, 6902], [6900, 6902], [6901, 6902], [6903, 6902]), gfx: gfx(712, 114), description: 'Enchants onyx jewellery.' }
] satisfies SpellDef[]).map((spell) => Object.freeze(spell)));

const groundSpells: readonly TelegrabSpellDef[] = Object.freeze(([
  // Ported from 2009scape TelekineticGrabSpell.java.
  { id: 'telekinetic-grab', name: 'Telekinetic Grab', level: 33, xp: 43, runes: r([AIR, 1], [LAW, 1]), target: 'ground-item', kind: 'telegrab', range: 10, gfx: gfx(2310, 142, 143, 144), description: 'Picks up a visible ground item from up to ten tiles away.' }
] satisfies TelegrabSpellDef[]).map((spell) => Object.freeze(spell)));

/** The eight single-target Rush and Blitz spells supported from Ancient Magicks. */
export const ANCIENT_SPELLS: readonly CombatSpellDef[] = Object.freeze(([
  // Levels, XP, runes, and gfx are ported from 2009scape's rev-530 ancient spell classes.
  { id: 'smoke-rush', name: 'Smoke Rush', level: 50, xp: 30, runes: r([DEATH, 2], [CHAOS, 2], [FIRE, 1], [AIR, 1]), target: 'entity', kind: 'combat', baseMaxHit: 13, accuracyMod: 1.1, poisonSeverity: 2, gfx: gfx(1978, undefined, 384, 385), description: 'Poisons one target with severity two.' },
  { id: 'shadow-rush', name: 'Shadow Rush', level: 52, xp: 31, runes: r([SOUL, 1], [DEATH, 2], [CHAOS, 2], [AIR, 1]), target: 'entity', kind: 'combat', baseMaxHit: 14, accuracyMod: 1.1, attackDrainPercent: 0.1, gfx: gfx(1978, undefined, 378, 379), description: 'Drains one target’s Attack by ten percent.' },
  { id: 'blood-rush', name: 'Blood Rush', level: 56, xp: 33, runes: r([BLOOD, 1], [DEATH, 2], [CHAOS, 2]), target: 'entity', kind: 'combat', baseMaxHit: 15, accuracyMod: 1.1, healPercentOfDamage: 0.25, gfx: gfx(1978, undefined, 372, 373), description: 'Heals the caster for one quarter of damage dealt.' },
  { id: 'ice-rush', name: 'Ice Rush', level: 58, xp: 34, runes: r([DEATH, 2], [CHAOS, 2], [WATER, 2]), target: 'entity', kind: 'combat', baseMaxHit: 16, accuracyMod: 1.1, freezeTicks: 8, gfx: gfx(1978, undefined, 360, 361), description: 'Freezes one target in place for eight ticks.' },
  { id: 'smoke-blitz', name: 'Smoke Blitz', level: 74, xp: 42, runes: r([BLOOD, 2], [DEATH, 2], [FIRE, 2], [AIR, 2]), target: 'entity', kind: 'combat', baseMaxHit: 23, accuracyMod: 1.3, poisonSeverity: 4, gfx: gfx(1978, undefined, 389, 388), description: 'Poisons one target with severity four.' },
  { id: 'shadow-blitz', name: 'Shadow Blitz', level: 76, xp: 43, runes: r([SOUL, 2], [BLOOD, 2], [DEATH, 2], [AIR, 2]), target: 'entity', kind: 'combat', baseMaxHit: 24, accuracyMod: 1.3, attackDrainPercent: 0.15, gfx: gfx(1978, undefined, undefined, 382), description: 'Drains one target’s Attack by fifteen percent.' },
  { id: 'blood-blitz', name: 'Blood Blitz', level: 80, xp: 45, runes: r([BLOOD, 4], [DEATH, 2]), target: 'entity', kind: 'combat', baseMaxHit: 25, accuracyMod: 1.3, healPercentOfDamage: 0.25, gfx: gfx(1978, undefined, 374, 375), description: 'Heals the caster for one quarter of damage dealt.' },
  { id: 'ice-blitz', name: 'Ice Blitz', level: 82, xp: 46, runes: r([BLOOD, 2], [DEATH, 2], [WATER, 3]), target: 'entity', kind: 'combat', baseMaxHit: 26, accuracyMod: 1.3, freezeTicks: 25, gfx: gfx(1978, 366, undefined, 367), description: 'Freezes one target in place for twenty-five ticks.' }
] satisfies CombatSpellDef[]).map((spell) => Object.freeze(spell)));

const modernListed: readonly SpellDef[] = [
  ...elementals, ...curses, ...binds, ...otherCombat, ...selfSpells, ...itemSpells, ...groundSpells
];

/** Complete revision-530 modern spellbook, level ordered with stable source-order ties. */
export const MODERN_SPELLBOOK: readonly SpellDef[] = Object.freeze(
  modernListed.map((spell, index) => ({ spell, index }))
    .sort((left, right) => left.spell.level - right.spell.level || left.index - right.index)
    .map(({ spell }) => spell)
);

/** All implemented spells across both selectable spellbooks. */
export const SPELLBOOK: readonly SpellDef[] = Object.freeze(
  [...MODERN_SPELLBOOK, ...ANCIENT_SPELLS]
    .map((spell, index) => ({ spell, index }))
    .sort((left, right) => left.spell.level - right.spell.level || left.index - right.index)
    .map(({ spell }) => spell)
);

export const SPELL_BY_ID: ReadonlyMap<SpellId, SpellDef> = new Map(
  SPELLBOOK.map((spell) => [spell.id, spell])
);

export const COMBAT_SPELLS: readonly EntitySpellDef[] = Object.freeze(
  SPELLBOOK.filter(isEntitySpell)
);

/** The original sixteen elemental combat spells, in compatibility order. */
export const MODERN_SPELLS: readonly CombatSpellDef[] = elementals;

const ANCIENT_IDS: ReadonlySet<SpellId> = new Set(ANCIENT_SPELLS.map((spell) => spell.id));

export function spellbookFor(spell: SpellDef | SpellId): Spellbook {
  const id = typeof spell === 'string' ? spell : spell.id;
  return ANCIENT_IDS.has(id) ? 'ancient' : 'modern';
}

export function spellsForBook(book: Spellbook): readonly SpellDef[] {
  return book === 'ancient' ? ANCIENT_SPELLS : MODERN_SPELLBOOK;
}

export function spellById(id: string): SpellDef | undefined {
  return SPELL_BY_ID.get(id as SpellId);
}

export function isEntitySpell(spell: SpellDef): spell is EntitySpellDef {
  return spell.target === 'entity';
}
