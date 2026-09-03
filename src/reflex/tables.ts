import { COMBINATION_RUNES, RUNE_IDS } from '../vendor/magic/index.ts';

export const FOOD_HEAL: Readonly<Record<number, number>> = Object.freeze({
  315: 3, 2140: 3, 2142: 3, 2309: 5, 347: 5, 325: 4, 319: 1,
  333: 7, 351: 8, 329: 9, 361: 10, 379: 12, 373: 14, 1895: 4, 1901: 5
});

export const BONES: ReadonlySet<number> = new Set([526, 2530, 528, 530, 532, 3125, 534, 536, 6812, 6729]);

export function isFood(item: number): boolean {
  return FOOD_HEAL[item] !== undefined;
}

export function isBones(item: number): boolean {
  return BONES.has(item);
}

export const RUNE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  [RUNE_IDS.air]: 'Air rune',
  [RUNE_IDS.water]: 'Water rune',
  [RUNE_IDS.earth]: 'Earth rune',
  [RUNE_IDS.fire]: 'Fire rune',
  [RUNE_IDS.mind]: 'Mind rune',
  [RUNE_IDS.body]: 'Body rune',
  [RUNE_IDS.chaos]: 'Chaos rune',
  [RUNE_IDS.death]: 'Death rune',
  [RUNE_IDS.nature]: 'Nature rune',
  [RUNE_IDS.law]: 'Law rune',
  [RUNE_IDS.cosmic]: 'Cosmic rune',
  [RUNE_IDS.blood]: 'Blood rune',
  [RUNE_IDS.soul]: 'Soul rune',
  [COMBINATION_RUNES[0]!.item]: 'Lava rune',
  [COMBINATION_RUNES[1]!.item]: 'Steam rune',
  [COMBINATION_RUNES[2]!.item]: 'Mist rune',
  [COMBINATION_RUNES[3]!.item]: 'Dust rune',
  [COMBINATION_RUNES[4]!.item]: 'Smoke rune',
  [COMBINATION_RUNES[5]!.item]: 'Mud rune'
});

export function isRune(item: number): boolean {
  return RUNE_NAMES[item] !== undefined;
}
