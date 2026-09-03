import { STAFF_RUNES } from './runes.ts';
import { ANCIENT_SPELLS, MODERN_SPELLS, type Spellbook, type SpellId } from './spellbook.ts';

export const STAFF_WEAPON_INTERFACE = 1;

export function isStaff(weaponInterface: number | undefined): boolean {
  return weaponInterface === STAFF_WEAPON_INTERFACE;
}

const OTHER_STAVES = new Set([1379, 1389, 1391, 1409, 2415, 2416, 2417, 4170, 4675]);
const ELEMENTAL_IDS = Object.freeze(MODERN_SPELLS.map((spell) => spell.id));
const ANCIENT_IDS = Object.freeze(ANCIENT_SPELLS.map((spell) => spell.id));
export const ANCIENT_STAFF = 4675;

export function autocastableSpells(
  weapon: number | undefined,
  book: Spellbook = 'modern'
): readonly SpellId[] {
  if (weapon === undefined || (!STAFF_RUNES.has(weapon) && !OTHER_STAVES.has(weapon))) return [];
  if (book === 'ancient') return ANCIENT_IDS;
  return weapon === 4170
    ? Object.freeze([...ELEMENTAL_IDS, 'crumble-undead', 'magic-dart'] as SpellId[])
    : ELEMENTAL_IDS;
}
