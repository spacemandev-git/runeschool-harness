import type { InstanceId } from './ids.ts';
import type { Tick } from './coords.ts';

/**
 * Wire protocol v0 (web-native; see ADR-0002).
 * REST = control plane (instance lifecycle, scenario upload, snapshots).
 * WebSocket = game plane. All WS frames are JSON envelopes below (binary frames
 * may be added later behind the same type field).
 */

/** Server -> client. Ordered per instance by `seq`; `tick` is the sim tick it was emitted on. */
export interface ServerEvent<TType extends string = string, TData = unknown> {
  readonly type: TType;
  readonly instance: InstanceId;
  readonly tick: Tick;
  readonly seq: number;
  readonly data: TData;
}

/** Client -> server. `id` is client-chosen for ack correlation. */
export interface ClientCommand<TType extends string = string, TData = unknown> {
  readonly type: TType;
  readonly instance: InstanceId;
  readonly id: string;
  readonly data: TData;
}

/**
 * Server ack/nack for a ClientCommand.
 *
 * `ok: true` means ACCEPTED, not completed. Multi-tick actions resolve later via
 * events; see docs/features/server-api.md.
 *
 * `error` is the stable machine-readable code (never changes without a version
 * bump). `message` and `details` exist so an LLM policy can self-correct without
 * a lookup table: a nack for `too_far` should say how far and what the limit is.
 */
export interface CommandResult {
  readonly id: string;
  readonly ok: boolean;
  /** Machine-readable rejection reason when ok=false (e.g. 'unreachable', 'invalid_target'). */
  readonly error?: string;
  /** Human/LLM-readable explanation when ok=false. Required for every nack. */
  readonly message?: string;
  /** Structured operands behind `message`, e.g. { distance: 7, maxDistance: 1 }. */
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  readonly tick: Tick;
}
