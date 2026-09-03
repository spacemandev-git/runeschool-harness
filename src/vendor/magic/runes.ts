import type { RuneCost } from './spellbook.ts';

export const RUNE_IDS = Object.freeze({
  air: 556,
  water: 555,
  earth: 557,
  fire: 554,
  mind: 558,
  body: 559,
  chaos: 562,
  death: 560,
  nature: 561,
  law: 563,
  cosmic: 564,
  blood: 565,
  soul: 566
});

/** Ported from 2009scape CombinationRune.java; post-530 omni runes are intentionally omitted. */
export const COMBINATION_RUNES = Object.freeze([
  Object.freeze({ item: 4699, elements: Object.freeze([RUNE_IDS.fire, RUNE_IDS.earth]) }),
  Object.freeze({ item: 4694, elements: Object.freeze([RUNE_IDS.fire, RUNE_IDS.water]) }),
  Object.freeze({ item: 4695, elements: Object.freeze([RUNE_IDS.water, RUNE_IDS.air]) }),
  Object.freeze({ item: 4696, elements: Object.freeze([RUNE_IDS.air, RUNE_IDS.earth]) }),
  Object.freeze({ item: 4697, elements: Object.freeze([RUNE_IDS.fire, RUNE_IDS.air]) }),
  Object.freeze({ item: 4698, elements: Object.freeze([RUNE_IDS.earth, RUNE_IDS.water]) })
]);

/** Ported from 2009scape MagicStaff.java, with the non-530/erroneous ids removed. */
export const STAFF_RUNES: ReadonlyMap<number, readonly number[]> = new Map([
  [1381, [RUNE_IDS.air]], [1397, [RUNE_IDS.air]], [1405, [RUNE_IDS.air]],
  [1383, [RUNE_IDS.water]], [1395, [RUNE_IDS.water]], [1403, [RUNE_IDS.water]],
  [6562, [RUNE_IDS.water, RUNE_IDS.earth]], [6563, [RUNE_IDS.water, RUNE_IDS.earth]],
  [11736, [RUNE_IDS.water, RUNE_IDS.fire]], [11738, [RUNE_IDS.water, RUNE_IDS.fire]],
  [1385, [RUNE_IDS.earth]], [1399, [RUNE_IDS.earth]], [1407, [RUNE_IDS.earth]],
  [3053, [RUNE_IDS.earth, RUNE_IDS.fire]], [3054, [RUNE_IDS.earth, RUNE_IDS.fire]],
  [1387, [RUNE_IDS.fire]], [1393, [RUNE_IDS.fire]], [1401, [RUNE_IDS.fire]]
].map(([staff, runes]) => [staff as number, Object.freeze(runes as number[])]));

export type RuneCheck =
  | { readonly ok: true; readonly consume: readonly RuneCost[] }
  | { readonly ok: false; readonly missing: RuneCost };

/** Pure port of 2009scape SpellUtils.kt hasRunes: staffs, then combination runes, then basics. */
export function runeRequirements(
  costs: readonly RuneCost[],
  weapon: number | undefined,
  count: (item: number) => number
): RuneCheck {
  const remaining = new Map<number, number>();
  for (const cost of costs) {
    if (cost.amount <= 0) continue;
    remaining.set(cost.item, (remaining.get(cost.item) ?? 0) + cost.amount);
  }

  for (const rune of STAFF_RUNES.get(weapon ?? -1) ?? []) remaining.set(rune, 0);

  const consume = new Map<number, number>();
  for (const combo of COMBINATION_RUNES) {
    const maximumNeed = Math.max(0, ...combo.elements.map((rune) => remaining.get(rune) ?? 0));
    const amount = Math.min(Math.max(0, count(combo.item)), maximumNeed);
    if (amount <= 0) continue;
    consume.set(combo.item, amount);
    for (const rune of combo.elements) {
      remaining.set(rune, Math.max(0, (remaining.get(rune) ?? 0) - amount));
    }
  }

  for (const [item, amount] of remaining) {
    if (amount <= 0) continue;
    const held = Math.max(0, count(item));
    if (held < amount) return { ok: false, missing: { item, amount: amount - held } };
    consume.set(item, amount);
  }

  return {
    ok: true,
    consume: [...consume.entries()]
      .filter(([, amount]) => amount > 0)
      .sort(([left], [right]) => left - right)
      .map(([item, amount]) => Object.freeze({ item, amount }))
  };
}
