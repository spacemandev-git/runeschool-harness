/** JSON-safe values accepted by every harness boundary. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type EntityId = number;
export type Tick = number;

export interface TileCoord {
  readonly x: number;
  readonly z: number;
  readonly level: number;
}

export interface CommandResult {
  readonly ok?: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly details?: JsonValue;
  readonly tick?: Tick;
  readonly [key: string]: JsonValue | undefined;
}

/** Adapter-neutral event envelope. World adapters own the event vocabulary. */
export interface SimEvent {
  readonly type: string;
  readonly tick: Tick;
  readonly seq: number;
  readonly data: JsonValue;
}

export type ServerEvent = SimEvent;
