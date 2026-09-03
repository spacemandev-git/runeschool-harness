import type { NpcConfigId } from './ids.ts';
import type { JsonValue } from './sim.ts';

/**
 * Declarative reward terms (see ADR-0020).
 *
 * Lives in its own module because BOTH the env layer (which evaluates terms)
 * and the scenario DSL (where a task may ship its own default rubric) reference
 * it. Keeping it here avoids a circular import between `env.ts` and
 * `scenario.ts`.
 *
 * Terms are pure data. Evaluation semantics are owned by `@runeschool/env`:
 * `condition-progress` scores the DELTA in summed current/target fractions so it
 * is dense and bounded; `event` counts attributed occurrences with an optional
 * per-episode cap; `illegal-action` fires only for `malformed`/`world` nacks,
 * never `auth`; `tick-cost` applies once per env step.
 */
export type RewardTerm =
  | { readonly kind: 'objective'; readonly id?: string; readonly outcome?: 'win' | 'lose' | 'progress'; readonly weight: number }
  | { readonly kind: 'condition-progress'; readonly objective?: string; readonly weight: number }
  | { readonly kind: 'event'; readonly event: string; readonly weight: number; readonly cap?: number; readonly attributedOnly?: boolean }
  | { readonly kind: 'xp'; readonly skill?: string; readonly weight: number }
  | { readonly kind: 'damage-dealt'; readonly weight: number }
  | { readonly kind: 'damage-taken'; readonly weight: number }
  | { readonly kind: 'item'; readonly item: number; readonly weight: number }
  | { readonly kind: 'kill'; readonly npc?: NpcConfigId; readonly weight: number }
  | { readonly kind: 'tick-cost'; readonly weight: number }
  | { readonly kind: 'illegal-action'; readonly weight: number }
  | { readonly kind: 'terminal'; readonly onWin: number; readonly onLose: number; readonly onTruncate?: number }
  | { readonly kind: 'potential'; readonly of: RewardTerm; readonly gamma: number }
  | { readonly kind: 'custom'; readonly ref: string; readonly config?: JsonValue };
