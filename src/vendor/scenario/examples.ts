/** Names of the example scenarios bundled with the RuneSchool server (`get_example_scenario`). */
export const EXAMPLE_SCENARIO_NAMES = [
  'goblin-ambush',
  'gather-and-deliver',
  'goblin-menace',
  'goblin-menace-2',
  'arena-island',
  'dragon-ladder',
  'ashfall-crater',
  'ashfall-karamja-caldera',
  'ashfall-lumbridge-fields',
  'impostor-of-falador',
  'draynor-games',
  'manhunt-gielinor',
  'long-night-ardougne',
  'charter-six-cities',
  'four-beacons'
] as const;

export type ExampleScenarioName = (typeof EXAMPLE_SCENARIO_NAMES)[number];
