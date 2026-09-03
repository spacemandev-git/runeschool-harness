/**
 * World-model vocabulary and client helpers. Backed by the vendored RuneSchool SDK in
 * `src/vendor/sdk` (percept views, event folding, delta diffing, visibility). Only the surface the
 * harness uses is re-exported; the SDK's bot-action helpers and REST client stay internal.
 */
import type { WorldView } from './vendor/sdk/percept.ts';

export type * from './vendor/sdk/percept.ts';
export type { DetailedPerceptDelta, RejectionOutcome, SequencedRejection } from './vendor/sdk/differ.ts';
export type { MutableWorldState } from './vendor/sdk/fold.ts';
export type {
  ActorAuthCredential,
  ClaimResult,
  ConnectOptions,
  CreateInstanceOptions,
  CreateInstanceResponse,
  EntityView,
  EventsResult,
  InstanceAuthCredentials,
  InstanceDetail,
  InstanceKind,
  InstanceSummary,
  WaitForOptions
} from './vendor/sdk/types.ts';
export { InstanceHandle } from './vendor/sdk/instanceHandle.ts';
export { CommandRejected, InstanceStream, WaitForTimeout } from './vendor/sdk/stream.ts';
export { createWorldModel, SdkWorldSource } from './vendor/sdk/worldModel.ts';
export {
  createMutableState,
  distanceBetween,
  estimatedTick,
  expireWalking,
  foldActionOutcome,
  foldEvent,
  snapshotFromState
} from './vendor/sdk/fold.ts';
export { diffSnapshots, rejectionFromOutcome } from './vendor/sdk/differ.ts';
export { isVisibleTo } from './vendor/sdk/visibility.ts';

/** A host integration implements this boundary and supplies its own commands and events. */
export interface WorldAdapter {
  readonly id: string;
  readonly commandTypes: readonly string[];
  createView(agentId: string, credentials: unknown): Promise<WorldView> | WorldView;
}
