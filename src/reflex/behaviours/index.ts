import type { BehaviourDefinition } from '../../core/reflex.ts';
import { BANK_RUN } from './bankRun.ts';
import { FIGHT } from './fight.ts';
import { FISH_LOOP } from './fishLoop.ts';
import { GATHER_LOOP } from './gatherLoop.ts';
import { HERBLORE_LOOP } from './herbloreLoop.ts';
import { INTERACT } from './interact.ts';
import { LOOT } from './loot.ts';
import { makeSequenceDefinition } from './sequence.ts';
import { TALK } from './talk.ts';
import { TRADE } from './trade.ts';
import { USE_ITEM_ON } from './useItemOn.ts';
import { WAIT } from './wait.ts';
import { WALK_TO } from './walkTo.ts';
import { FLETCH_LOOP } from './fletchLoop.ts';
import { DRINK_WHEN } from './drinkWhen.ts';
import { FLEE_WILDERNESS } from './fleeWilderness.ts';
import { RUNECRAFT_LOOP } from './runecraftLoop.ts';
import { SPECIAL_ATTACK } from './specialAttack.ts';
import { QUEST_STEP } from './questStep.ts';
import { SLAYER_LOOP } from './slayerLoop.ts';
import { TRAVEL_TO } from './travelTo.ts';
import { CHAT } from './chat.ts';
import { COURSE_LOOP } from './courseLoop.ts';
import { FAMILIAR_KEEPER } from './familiarKeeper.ts';
import { FARM_RUN } from './farmRun.ts';
import { MINIGAME_JOIN } from './minigameJoin.ts';
import { TRAP_LOOP } from './trapLoop.ts';
import { CLUE_SOLVER } from './clueSolver.ts';
import { RANDOM_EVENT_RESPONDER } from './randomEventResponder.ts';
import { MINIGAME_LOOP } from './minigameLoop.ts';
import { DIARY_TRACKER } from './diaryTracker.ts';

const definitions = new Map<string, BehaviourDefinition>();
for (const definition of [WALK_TO, INTERACT, USE_ITEM_ON, FIGHT, SPECIAL_ATTACK, DRINK_WHEN, FLEE_WILDERNESS, RUNECRAFT_LOOP, QUEST_STEP, SLAYER_LOOP, TRAVEL_TO, CHAT, FARM_RUN, TRAP_LOOP, FAMILIAR_KEEPER, COURSE_LOOP, MINIGAME_JOIN, CLUE_SOLVER, RANDOM_EVENT_RESPONDER, MINIGAME_LOOP, DIARY_TRACKER, GATHER_LOOP, FISH_LOOP, FLETCH_LOOP, HERBLORE_LOOP, LOOT, BANK_RUN, TRADE, TALK, WAIT]) definitions.set(definition.id, definition);
const SEQUENCE = makeSequenceDefinition((id) => definitions.get(id));
definitions.set(SEQUENCE.id, SEQUENCE);

export const BUILTIN_BEHAVIOURS: readonly BehaviourDefinition[] = Object.freeze([
  WALK_TO, INTERACT, USE_ITEM_ON, FIGHT, SPECIAL_ATTACK, DRINK_WHEN, FLEE_WILDERNESS, RUNECRAFT_LOOP,
  QUEST_STEP, SLAYER_LOOP, TRAVEL_TO, CHAT,
  FARM_RUN, TRAP_LOOP, FAMILIAR_KEEPER, COURSE_LOOP, MINIGAME_JOIN,
  CLUE_SOLVER, RANDOM_EVENT_RESPONDER, MINIGAME_LOOP, DIARY_TRACKER,
  GATHER_LOOP, FISH_LOOP, FLETCH_LOOP, HERBLORE_LOOP,
  LOOT, BANK_RUN, TRADE, TALK, SEQUENCE, WAIT
]);

export { BANK_RUN, CHAT, CLUE_SOLVER, COURSE_LOOP, DIARY_TRACKER, DRINK_WHEN, FAMILIAR_KEEPER, FARM_RUN, FIGHT, FISH_LOOP, FLEE_WILDERNESS, FLETCH_LOOP, GATHER_LOOP, HERBLORE_LOOP, INTERACT, LOOT, MINIGAME_JOIN, MINIGAME_LOOP, QUEST_STEP, RANDOM_EVENT_RESPONDER, RUNECRAFT_LOOP, SEQUENCE, SLAYER_LOOP, SPECIAL_ATTACK, TALK, TRAP_LOOP, TRADE, TRAVEL_TO, USE_ITEM_ON, WAIT, WALK_TO };
