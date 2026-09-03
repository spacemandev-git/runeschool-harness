import type {
  EntityId,
  EntityKind,
  ScenarioMeta,
  ServerEvent,
  TileCoord
} from '../shared/index.ts';

export interface CreateInstanceOptions {
  readonly seed: number;
  readonly scenario?: unknown;
  readonly scenarioId?: string;
  readonly continueFrom?: string;
  readonly realtime?: boolean;
  /** `'sandbox'` populates `regions` (default Lumbridge) with its real NPC population. */
  readonly kind?: 'sandbox';
  /** Sandbox-only: base-world 530 region ids. Defaults to `[12850]`. */
  readonly regions?: readonly number[];
  readonly pvp?: boolean;
}

/**
 * What a running instance actually contains.
 * - `sandbox` — a populated world region with its real NPC population, no objectives.
 * - `scenario` — a scenario document with objectives and scripted spawns.
 * - `blank`   — no map: an empty kernel, created by omitting both `kind` and `scenario`.
 */
export type InstanceKind = 'sandbox' | 'scenario' | 'blank';

export interface InstanceSummary {
  readonly id: string;
  readonly tick: number;
  readonly state: 'running' | 'ended';
  readonly entityCount: number;
  readonly realtime: boolean;
  readonly kind: InstanceKind;
  readonly pvp: boolean;
}

export interface InstanceDetail extends InstanceSummary {
  readonly scenario?: ScenarioMeta;
}

export interface ActorAuthCredential {
  readonly tag: string;
  readonly entity: EntityId;
  readonly token: string;
}

export interface InstanceAuthCredentials {
  readonly admin: string;
  readonly actors: readonly ActorAuthCredential[];
}

export interface CreateInstanceResponse extends InstanceDetail {
  readonly auth: InstanceAuthCredentials;
}

export interface RuneSchoolOptions {
  readonly adminToken?: string;
}

export interface ConnectOptions {
  readonly token?: string;
}

export interface ClaimResult {
  readonly id: string;
  readonly ok: true;
  readonly tick: number;
  readonly role: 'actor' | 'admin';
  readonly entity?: EntityId;
}

export interface EntityView {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly at: TileCoord;
  readonly loc?: number;
  readonly name?: string;
}

export interface EventsResult {
  readonly events: readonly ServerEvent[];
  readonly dropped: number;
}

export interface DestroyResult {
  readonly id: string;
  readonly state: 'ended';
}

export interface WaitForOptions {
  readonly timeoutMs?: number;
}
