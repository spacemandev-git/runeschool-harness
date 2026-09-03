import type { ActionOutcome } from '../core/actions.ts';
import {
  foldActionOutcome as foldSdkActionOutcome,
  type MutableWorldState
} from '#world';

export {
  createMutableState,
  distanceBetween,
  estimatedTick,
  expireWalking,
  foldEvent,
  snapshotFromState
} from '#world';
export type { MutableWorldState } from '#world';

export function foldActionOutcome(state: MutableWorldState, outcome: ActionOutcome): void {
  foldSdkActionOutcome(state, {
    type: outcome.intent.type,
    data: outcome.intent.data,
    tick: outcome.tick,
    ok: outcome.ok
  });
}
