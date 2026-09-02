/**
 * The "nervous system": deterministic, per-pulse reactions and multi-tick behaviours that run
 * without an LLM in the loop. The mind installs, parameterises, and removes them through tools.
 *
 * Two layers:
 *  1. Rule DSL ({@link Rule}) — declarative JSON `when` → `do`, evaluated every pulse by the engine.
 *  2. Behaviours ({@link Behaviour}) — stateful procedures stepped every pulse until done/failed.
 */
import type { JsonValue, Tick } from '#protocol';
import type { ActionIntent, ActionOutcome } from './actions.ts';
import type { WorldView } from './percept.ts';
import type { WakeReason } from './types.ts';

/** Duration of one engine pulse in ms. Equals the game tick (600 ms). */
export const PULSE_MILLIS = 600;

// ---------------------------------------------------------------------------------------------
// Rule DSL
// ---------------------------------------------------------------------------------------------

/**
 * Dotted paths the DSL may reference. Implementations resolve them against a {@link WorldSnapshot}.
 * The list is closed so authoring prompts can enumerate it; unknown paths are a validation error.
 */
export type RefPath =
  | 'self.hp.current' | 'self.hp.max' | 'self.hp.fraction'
  | 'self.prayer.points' | 'self.prayer.fraction'
  | 'self.inCombat' | 'self.attackedBy.count' | 'self.dead'
  | 'self.bound' | 'self.autocast'
  | 'self.activity' // string: Activity.kind
  | 'self.at.x' | 'self.at.z' | 'self.at.level'
  | 'inventory.free' | 'inventory.used'
  | 'nearby.npcs.count' | 'nearby.players.count' | 'groundItems.count'
  | 'dialogue.active' | 'dialogue.hasOptions'
  | 'objectives.won' | 'objectives.lost'
  | 'tick';

export type Literal = number | string | boolean;

export type Expr =
  | { readonly op: 'and' | 'or'; readonly args: readonly Expr[] }
  | { readonly op: 'not'; readonly arg: Expr }
  | { readonly op: 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne'; readonly ref: RefPath; readonly value: Literal }
  | { readonly op: 'has-item'; readonly item: number | string; readonly min?: number }
  | { readonly op: 'skill-at-least'; readonly skill: string; readonly level: number }
  | { readonly op: 'nearby'; readonly kind: 'npc' | 'player' | 'ground_item' | 'node' | 'station'; readonly name?: string; readonly radius?: number; readonly min?: number }
  | { readonly op: 'event'; readonly type: string; readonly withinTicks?: number }
  | { readonly op: 'behaviour-running'; readonly id?: string }
  | { readonly op: 'true' } | { readonly op: 'false' };

export type RuleAction =
  | { readonly kind: 'command'; readonly type: string; readonly data: Readonly<Record<string, JsonValue>> }
  | { readonly kind: 'start-behaviour'; readonly behaviour: string; readonly params: Readonly<Record<string, JsonValue>>; readonly replace?: boolean }
  | { readonly kind: 'stop-behaviour'; readonly id?: string }
  | { readonly kind: 'wake-mind'; readonly note: string }
  | { readonly kind: 'note'; readonly text: string };

export interface Rule {
  /** `^[a-z0-9][a-z0-9-]{0,47}$`, unique per agent. */
  readonly id: string;
  readonly description?: string;
  /** Higher fires first within a pulse. Ties break by id. */
  readonly priority: number;
  readonly when: Expr;
  readonly do: readonly RuleAction[];
  /** Minimum pulses between firings. Default 1. */
  readonly cooldownTicks?: number;
  /** Fire at most once, then disable. */
  readonly once?: boolean;
  readonly enabled?: boolean;
}

/** Result of validating a rule or behaviour parameter object; errors use dotted paths. */
export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly { readonly path: string; readonly message: string }[];
}

// ---------------------------------------------------------------------------------------------
// Behaviours
// ---------------------------------------------------------------------------------------------

export type BehaviourStatus =
  | { readonly state: 'running'; readonly note?: string }
  | { readonly state: 'done'; readonly summary: string }
  | { readonly state: 'failed'; readonly reason: string; readonly retryable: boolean };

/** What a behaviour or rule action may touch. No direct socket, no LLM. */
export interface ReflexContext {
  readonly agentId: string;
  readonly view: WorldView;
  readonly tick: Tick;
  /** Send a command now. Resolves with the ack; multi-tick effects arrive as events. */
  act(intent: Omit<ActionIntent, 'source'>): Promise<ActionOutcome>;
  /** Events since the previous pulse, already visibility-filtered. */
  readonly pulseEvents: readonly import('#protocol').SimEvent[];
  /** Ask the mind to wake with a note (coalesced by the wake policy). */
  wakeMind(reason: WakeReason, note: string): void;
  /** Append a line to the agent's reflex log (TUI + trace). */
  log(line: string): void;
}

export interface Behaviour {
  readonly id: string;
  readonly params: Readonly<Record<string, JsonValue>>;
  /** Called once when started. May issue the first command. */
  start(ctx: ReflexContext): Promise<BehaviourStatus>;
  /** Called every pulse while running. Must be cheap and must not block on the network beyond `act`. */
  step(ctx: ReflexContext): Promise<BehaviourStatus>;
  /** Called when stopped externally or when status leaves `running`. */
  stop(ctx: ReflexContext, why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void>;
  /** One-line human description of current progress for the TUI/mind. */
  describe(): string;
}

export interface BehaviourDefinition {
  readonly id: string;
  readonly description: string;
  /** JSON Schema for `params`; exposed to the mind as a tool parameter schema. */
  readonly paramsSchema: JsonValue;
  validate(params: unknown): ValidationResult;
  create(params: Readonly<Record<string, JsonValue>>): Behaviour;
}

// ---------------------------------------------------------------------------------------------
// Engine surface (implemented by reflex/engine.ts; consumed by mind + runtime + TUI)
// ---------------------------------------------------------------------------------------------

export interface RunningBehaviourInfo {
  readonly instance: string;
  readonly id: string;
  readonly params: Readonly<Record<string, JsonValue>>;
  readonly startedTick: Tick;
  readonly description: string;
}

export interface ReflexEngineState {
  readonly rules: readonly (Rule & { readonly lastFiredTick?: Tick; readonly fireCount: number })[];
  readonly behaviour?: RunningBehaviourInfo;
  readonly queue: readonly RunningBehaviourInfo[];
}

export interface ReflexEngine {
  /** Validate then install/replace a rule. */
  installRule(rule: Rule): ValidationResult;
  removeRule(id: string): boolean;
  setRuleEnabled(id: string, enabled: boolean): boolean;
  listBehaviours(): readonly BehaviourDefinition[];
  /** Start a behaviour; `replace` stops the current one, otherwise it is queued. Returns the instance id. */
  startBehaviour(id: string, params: Readonly<Record<string, JsonValue>>, options?: { readonly replace?: boolean }): Promise<{ readonly ok: true; readonly instance: string } | { readonly ok: false; readonly errors: ValidationResult['errors'] }>;
  stopBehaviour(instance?: string): Promise<boolean>;
  state(): ReflexEngineState;
  /** Run one pulse: evaluate rules by priority, then step the active behaviour. */
  pulse(ctx: ReflexContext): Promise<void>;
}
