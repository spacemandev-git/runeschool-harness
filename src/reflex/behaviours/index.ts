import type { BehaviourDefinition } from '../../core/reflex.ts';
import { makeSequenceDefinition } from './sequence.ts';
import { WAIT } from './wait.ts';
import { WALK_TO } from './walkTo.ts';

const definitions = new Map<string, BehaviourDefinition>([
  [WAIT.id, WAIT],
  [WALK_TO.id, WALK_TO]
]);

export const SEQUENCE = makeSequenceDefinition((id) => definitions.get(id));
definitions.set(SEQUENCE.id, SEQUENCE);

export const BUILTIN_BEHAVIOURS: readonly BehaviourDefinition[] = Object.freeze([...definitions.values()]);

export { WAIT, WALK_TO };
