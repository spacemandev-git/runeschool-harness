/**
 * Action contracts: how anything in the harness sends a command as the agent's character.
 */
import type { CommandResult, Tick } from '#protocol';

/**
 * Actor commands the harness never lets an agent send even though the sim's `ActorCommand` union
 * allows them. `move` is a no-pathing teleport intended for authoring/tests; agents must `walk`/`run`.
 * Sinks reject these with `code: 'denied_command'`.
 */
export const AGENT_DENIED_COMMANDS: readonly string[] = Object.freeze(['move']);

/** Who produced an action. Used for arbitration, the TUI, and the trace. */
export type ActionSource =
  | { readonly kind: 'mind' }
  | { readonly kind: 'reflex'; readonly id: string }
  | { readonly kind: 'behaviour'; readonly id: string; readonly instance: string }
  | { readonly kind: 'coordinator'; readonly team: string }
  | { readonly kind: 'operator' };

/** A command without `entity`; the sink injects the agent's entity id. */
export interface ActionIntent {
  /** One of `ACTOR_COMMAND_TYPES` from `@runeschool/shared` (never an admin command). */
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly source: ActionSource;
  /** Short free-text justification, surfaced in the TUI/trace. */
  readonly reason?: string;
}

export interface ActionOutcome {
  readonly intent: ActionIntent;
  /** Acknowledged (accepted for execution) — not completed. */
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly details?: CommandResult['details'];
  readonly tick: Tick;
  readonly sentAt: number;
}

/** Where intents go. Implemented by the transport layer's ActorLink and by test fakes. */
export interface ActionSink {
  submit(intent: ActionIntent): Promise<ActionOutcome>;
}
