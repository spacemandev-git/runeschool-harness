/**
 * Public wire vocabulary. Backed by the vendored RuneSchool shared package in `src/vendor/shared`;
 * this module re-exports the curated subset the harness relies on.
 */
export type {
  JsonValue,
  EntityId,
  EntityKind,
  InstanceId,
  Tick,
  TileCoord,
  CommandResult,
  ClientCommand,
  ServerEvent,
  SimEvent,
  SimEventMap,
  SimEventType,
  SimCommandType,
  InteractTarget,
  TravelNetwork,
  FishingOption,
  ScenarioDoc,
  ScenarioMeta,
  SkillName
} from './vendor/shared/index.ts';
export {
  ACTOR_COMMAND_TYPES,
  ADMIN_COMMAND_TYPES,
  TRAVEL_NETWORKS,
  FISHING_OPTIONS,
  TICK_MILLIS,
  SIM_EVENT_TYPES,
  COMMAND_TIMING,
  eventActor,
  nackCategory
} from './vendor/shared/index.ts';
