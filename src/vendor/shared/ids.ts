/** Opaque instance identifier (ULID-style string, assigned by the instance manager). */
export type InstanceId = string;

/**
 * Runtime entity id, unique within one instance for the entity's lifetime.
 * Positive integers; never reused within an instance run.
 */
export type EntityId = number;

/** Config-space ids from the 530 cache / 2009scape configs. */
export type ItemConfigId = number;
export type NpcConfigId = number;
export type LocConfigId = number; // scenery/"object" definitions

export type EntityKind = 'player' | 'npc' | 'ground_item' | 'loc' | 'grave';

/** The 24 skills, ordered by 2009scape's canonical skill ids (Skills.java). */
export const SKILLS = [
  'attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic',
  'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting',
  'smithing', 'mining', 'herblore', 'agility', 'thieving', 'slayer', 'farming',
  'runecrafting', 'hunter', 'construction', 'summoning'
] as const;

export type SkillName = (typeof SKILLS)[number];
