/**
 * Action contracts: how anything in the harness sends a command as the agent's character.
 */
import type { CommandResult, Tick } from '#protocol';

/**
 * Commands denied in every adapter. Adapters can add their own denied commands through `MindDeps`.
 */
export const AGENT_DENIED_COMMANDS: readonly string[] = Object.freeze([]);

/** Who produced an action. Used for arbitration, the TUI, and the trace. */
export type ActionSource =
  | { readonly kind: 'mind' }
  | { readonly kind: 'reflex'; readonly id: string }
  | { readonly kind: 'behaviour'; readonly id: string; readonly instance: string }
  | { readonly kind: 'coordinator'; readonly team: string }
  | { readonly kind: 'operator' };

/** A command without `entity`; the sink injects the agent's entity id. */
export interface ActionIntent {
  /** A command advertised by the active world adapter. */
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
