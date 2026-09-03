/**
 * Grounding prompts. Markdown files under `prompts/` loaded by `src/prompts/index.ts`.
 * Names are closed so the mind/director/coordinator can reference them without string guessing.
 */
export type PromptName =
  | 'world-basics'        // what RuneSchool is, ticks, coordinates, levels, entity/ground-item ids
  | 'commands'            // every actor command with payload shape, timing class, common nacks
  | 'combat'              // styles, hp/food, prayer, retaliation, disengage, death
  | 'skilling'            // gathering, fishing, cooking, firemaking, smithing, crafting, thieving, agility
  | 'economy'             // inventory/equipment/bank/shops, ground items, give vs drop
  | 'dialogue-and-quests' // talk/dialogue-advance, scenario objectives, triggers
  | 'navigation'          // walk/run, doors/climb, region scan, distances, being adjacent
  | 'reflex-authoring'    // the rule DSL + behaviour catalogue and when to use each
  | 'social-games'        // voting, alliances, secrecy, notices, elimination, and team outcomes
  | 'agent-system'        // the agent mind's system prompt frame (placeholders: {{identity}} {{goal}} ...)
  | 'coordinator-system'  // coordinator frame
  | 'director-system'     // director frame
  | 'admin-system';       // admin (game-master) frame: world authoring over the run's instance

export interface PromptLibrary {
  get(name: PromptName): string;
  /** Substitute `{{key}}` placeholders; missing keys throw. */
  render(name: PromptName, vars: Readonly<Record<string, string>>): string;
  list(): readonly PromptName[];
}
