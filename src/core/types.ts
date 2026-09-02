/**
 * Harness-wide identifiers and small shared enums.
 *
 * Everything in `harness/src/core/` is a CONTRACT: types and interfaces only, no runtime logic.
 * Builders implement these in sibling modules and must not edit this directory.
 */

/** Stable, human-chosen agent identity (also the memory directory name). `^[a-z0-9][a-z0-9-]{0,31}$`. */
export type AgentId = string;
/** Team identity, same character rules as {@link AgentId}. */
export type TeamId = string;
/** Agent-to-agent mailbox routing policy for a run. */
export type ChannelPolicy = 'open' | 'team-only';
/** Options applied while an agent mind is paused. */
export interface PauseOptions { readonly blind?: boolean; }
/** One harness process invocation. Format: `run-<ISO timestamp with : and . replaced by ->`. */
export type RunId = string;

/** Which LLM a call is made on behalf of. Resolved to a provider + model slug by the ModelRegistry. */
export type ModelRole = 'director' | 'admin' | 'coordinator' | 'agent' | 'summarizer';

/** Agent lifecycle. Transitions are owned by the runtime; other modules only read it. */
export type AgentState =
  | 'provisioning' // MCP add_player / claim in flight
  | 'idle'         // connected, no goal or waiting for the next wake
  | 'thinking'     // an LLM call for this agent's mind is in flight
  | 'acting'       // a behaviour is running and the mind is asleep
  | 'paused'       // operator/coordinator paused: reflexes still run, mind does not wake
  | 'dead'         // the character died; runtime decides whether to respawn/resume
  | 'finished'     // mind called finish(); no further wakes
  | 'errored';

/** Why a mind is being woken. Coalesced by the wake policy into one LLM turn. */
export type WakeReason =
  | 'goal-assigned'
  | 'behaviour-finished'
  | 'behaviour-failed'
  | 'reflex-fired'
  | 'salient-event'
  | 'message'
  | 'operator'
  | 'heartbeat'
  | 'resumed';

/** Approximate token counter shared by context management and usage reporting. */
export interface TokenEstimator {
  /** Rough token count; implementations may use chars/4 or a tokenizer. Must be fast. */
  estimate(text: string): number;
}
