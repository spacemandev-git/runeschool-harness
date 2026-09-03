import type { Rule } from '../core/reflex.ts';

const MELEE_BASIC: readonly Rule[] = [
  { id: 'wake-on-death', priority: 200, when: { op: 'eq', ref: 'self.dead', value: true }, do: [{ kind: 'wake-mind', note: 'I died.' }], once: true },
  { id: 'eat-low-health', priority: 100, cooldownTicks: 3, when: { op: 'and', args: [{ op: 'lt', ref: 'self.hp.fraction', value: 0.5 }, { op: 'has-food' }] }, do: [{ kind: 'eat' }] },
  { id: 'retaliate-idle', priority: 90, when: { op: 'and', args: [{ op: 'gt', ref: 'self.attackedBy.count', value: 0 }, { op: 'eq', ref: 'self.activity', value: 'idle' }] }, do: [{ kind: 'retaliate' }] },
  { id: 'wake-on-dialogue-choice', priority: 80, cooldownTicks: 5, when: { op: 'eq', ref: 'dialogue.hasOptions', value: true }, do: [{ kind: 'wake-mind', note: 'Dialogue needs a choice.' }] }
];

export const REFLEX_PRESETS: Record<string, readonly Rule[]> = Object.freeze({
  'melee-basic': MELEE_BASIC,
  cautious: [...MELEE_BASIC, { id: 'flee-critical-health', priority: 150, cooldownTicks: 10, when: { op: 'lt', ref: 'self.hp.fraction', value: 0.3 }, do: [{ kind: 'flee' }, { kind: 'wake-mind', note: 'Fleeing at critical health.' }] }],
  skiller: [
    { id: 'wake-inventory-full', priority: 100, cooldownTicks: 20, when: { op: 'eq', ref: 'inventory.free', value: 0 }, do: [{ kind: 'wake-mind', note: 'Inventory is full.' }] },
    { id: 'eat-skilling', priority: 90, cooldownTicks: 3, when: { op: 'and', args: [{ op: 'lt', ref: 'self.hp.fraction', value: 0.4 }, { op: 'has-food' }] }, do: [{ kind: 'eat' }] }
  ],
  production: [
    { id: 'wake-fletching-stop', priority: 100, cooldownTicks: 2, when: { op: 'event', type: 'fletching-stopped', withinTicks: 1 }, do: [{ kind: 'wake-mind', note: 'Fletching stopped; inspect the reason and remaining inputs.' }] },
    { id: 'wake-herblore-stop', priority: 100, cooldownTicks: 2, when: { op: 'event', type: 'herblore-stopped', withinTicks: 1 }, do: [{ kind: 'wake-mind', note: 'Herblore stopped; inspect the reason and remaining inputs.' }] },
    { id: 'eat-production', priority: 90, cooldownTicks: 3, when: { op: 'and', args: [{ op: 'lt', ref: 'self.hp.fraction', value: 0.4 }, { op: 'has-food' }] }, do: [{ kind: 'eat' }] }
  ],
  trader: [
    { id: 'wake-trade-confirm', priority: 110, cooldownTicks: 2, when: { op: 'event', type: 'trade-stage', withinTicks: 1 }, do: [{ kind: 'wake-mind', note: 'Trade stage changed; re-check both offers before confirming.' }] },
    { id: 'wake-trade-end', priority: 100, cooldownTicks: 2, when: { op: 'or', args: [{ op: 'event', type: 'trade-completed', withinTicks: 1 }, { op: 'event', type: 'trade-declined', withinTicks: 1 }] }, do: [{ kind: 'wake-mind', note: 'Trade ended; verify the completion or decline reason.' }] }
  ],
  wilderness: [
    { id: 'flee-nearby-player', priority: 180, cooldownTicks: 20,
      when: { op: 'nearby', kind: 'player', radius: 8 },
      do: [{ kind: 'start-behaviour', behaviour: 'flee-wilderness', params: { radius: 8, run: true } }] },
    { id: 'wake-on-skull', priority: 170, cooldownTicks: 20,
      when: { op: 'event', type: 'skulled', withinTicks: 1 },
      do: [{ kind: 'wake-mind', note: 'Skulled: death now keeps no carried items.' }] }
  ],
  adventurer: [
    { id: 'wake-quest-complete', priority: 130, cooldownTicks: 2,
      when: { op: 'event', type: 'quest-complete', withinTicks: 1 },
      do: [{ kind: 'wake-mind', note: 'Quest completed; inspect the journal, rewards, and next objective.' }] },
    { id: 'wake-slayer-complete', priority: 120, cooldownTicks: 2,
      when: { op: 'event', type: 'slayer-complete', withinTicks: 1 },
      do: [{ kind: 'wake-mind', note: 'Slayer task completed; inspect points and choose the next assignment or reward.' }] },
    { id: 'wake-travel-denied', priority: 110, cooldownTicks: 5,
      when: { op: 'event', type: 'travel-denied', withinTicks: 1 },
      do: [{ kind: 'wake-mind', note: 'Travel was denied; inspect the route requirement and replan.' }] }
  ],
  'wave-four': [
    { id: 'wake-crop-grown', priority: 130, cooldownTicks: 5,
      when: { op: 'event', type: 'patch-changed', withinTicks: 1 },
      do: [{ kind: 'wake-mind', note: 'A farming patch changed; inspect whether a crop is ready to harvest.' }] },
    { id: 'wake-familiar-dismissed', priority: 120, cooldownTicks: 5,
      when: { op: 'event', type: 'familiar-dismissed', withinTicks: 1 },
      do: [{ kind: 'wake-mind', note: 'The active familiar was dismissed or expired; inspect pouch and points.' }] },
    { id: 'wake-minigame-ended', priority: 110, cooldownTicks: 2,
      when: { op: 'event', type: 'minigame-ended', withinTicks: 1 },
      do: [{ kind: 'wake-mind', note: 'The minigame ended; inspect scores, winner, rewards, and next goal.' }] }
  ],
  'wave-five': [
    { id: 'answer-random-event', priority: 180, cooldownTicks: 2,
      when: { op: 'event', type: 'random-event-started', withinTicks: 1 },
      do: [{ kind: 'start-behaviour', behaviour: 'random-event-responder', params: {}, replace: true }] },
    { id: 'wake-clue-step', priority: 130, cooldownTicks: 2,
      when: { op: 'event', type: 'clue-step', withinTicks: 1 },
      do: [{ kind: 'wake-mind', note: 'A clue step is available; inspect its kind, text, equipment, and configured route.' }] },
    { id: 'wake-diary-complete', priority: 120, cooldownTicks: 2,
      when: { op: 'event', type: 'diary-complete', withinTicks: 1 },
      do: [{ kind: 'wake-mind', note: 'An achievement diary tier completed; query progress and choose the next task.' }] }
  ]
});
