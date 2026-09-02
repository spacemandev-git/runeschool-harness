export const theme = {
  ink: '#111816',
  paper: '#dbe8e4',
  paperMuted: '#91aaa4',
  teal: '#35d0ba',
  tealDim: '#247f74',
  damage: '#ff5b5b',
  warning: '#e5b85c',
  command: '#65d7ff',
  combat: '#ff5b5b',
  skills: '#e5b85c',
  loot: '#7fdb8b',
  dialogue: '#c792ea',
  world: '#91aaa4',
  border: '#31534d',
} as const;

export function hpMeter(current: number, max: number, width = 10): string {
  const cells = Math.max(0, Math.floor(width));
  const fraction = max > 0 ? Math.min(1, Math.max(0, current / max)) : 0;
  const filled = Math.round(fraction * cells);
  return `[${'█'.repeat(filled)}${'░'.repeat(cells - filled)}]`;
}

const COMMAND_KINDS = new Set(['command', 'command-sent', 'command-accepted', 'command-rejected']);
const COMBAT_KINDS = new Set(['combat', 'damage', 'death', 'damaged', 'died', 'hit', 'respawned', 'retaliate-set', 'swing', 'target-lost']);
const SKILL_KINDS = new Set([
  'buried', 'burnt', 'cooked', 'cooking-stopped', 'course-completed', 'crafted',
  'crafting-stopped', 'fire-expired', 'fire-lit', 'firemaking-stopped', 'fished',
  'fishing-stopped', 'gather-stopped', 'gathered', 'level-up', 'node-depleted',
  'node-respawned', 'objective', 'objective-complete', 'obstacle-completed',
  'obstacle-failed', 'pickpocket-failed', 'pickpocketed', 'prayer-points',
  'prayer-toggled', 'prayers-depleted', 'scenario-lost', 'scenario-won', 'skills',
  'smelt-failed', 'smelted', 'smithed', 'smithing-stopped', 'stall-caught',
  'stall-respawned', 'stall-theft', 'xp', 'xp-gained',
]);
const LOOT_KINDS = new Set([
  'ate', 'equipped', 'ground-item-despawned', 'ground-item-picked-up',
  'ground-item-revealed', 'ground-item-spawned', 'ge-collected', 'ge-offer-aborted',
  'ge-offer-filled', 'ge-offer-placed', 'ge-price', 'ge-viewed', 'heal', 'item-added',
  'item-removed', 'items-dropped', 'loot', 'shop-bought', 'shop-sold', 'shop-viewed',
  'unequipped',
]);
const DIALOGUE_KINDS = new Set(['dialogue', 'dialogue-ended', 'dialogue-node', 'dialogue-started']);

export function eventKindColor(kind: string): string {
  if (COMMAND_KINDS.has(kind) || kind === 'agent.action') return theme.command;
  if (COMBAT_KINDS.has(kind) || kind.includes('damage') || kind.includes('attack')) return theme.combat;
  if (SKILL_KINDS.has(kind) || kind.includes('xp') || kind.includes('level')) return theme.skills;
  if (LOOT_KINDS.has(kind)) return theme.loot;
  if (DIALOGUE_KINDS.has(kind) || kind.includes('dialogue') || kind === 'agent.message') return theme.dialogue;
  return theme.world;
}
