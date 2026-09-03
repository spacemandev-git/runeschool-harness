import type { WakePolicyConfig } from '../core/agent.ts';
import type { PerceptDelta } from '../core/percept.ts';
import type { WakeReason } from '../core/types.ts';
import type { DetailedPerceptDelta } from '../perception/differ.ts';

export interface SaliencePrevious {
  readonly won?: boolean;
  readonly lost?: boolean;
}

/** Return a single deduplicated salience reason when a delta crosses an attention boundary. */
export function salientReasons(
  delta: PerceptDelta,
  config: WakePolicyConfig,
  _prev: SaliencePrevious = {}
): WakeReason[] {
  const hpCrossed = delta.hp !== undefined
    && (delta.hp.before.max <= 0 ? 0 : delta.hp.before.current / delta.hp.before.max) > config.hpAlertFraction
    && (delta.hp.after.max <= 0 ? 0 : delta.hp.after.current / delta.hp.after.max) <= config.hpAlertFraction;
  const outcomeChanged = delta.events.some((event) => event.type === 'scenario-won' || event.type === 'scenario-lost');
  const socialGameChanged = delta.events.some((event) => event.type === 'actor-eliminated' || event.type === 'poll-closed');
  const details = (delta as DetailedPerceptDelta)._details;
  const combatStatusChanged = delta.events.some((event) => {
    const data = event.data as unknown as Record<string, unknown>;
    const target = typeof data.target === 'number' ? data.target : undefined;
    const targetsSelf = target !== undefined
      && (details === undefined || details.nearbyNames[String(target)] === undefined);
    return targetsSelf && (event.type === 'dragonfire'
      || (event.type === 'spell-effect' && data.effect === 'bind'));
  });
  const salient = delta.deaths.some((death) => death.isSelf)
    || hpCrossed
    || delta.dialogue?.options !== undefined
    || delta.objectivesChanged.length > 0
    || outcomeChanged
    || socialGameChanged
    || combatStatusChanged
    || delta.messages.length > 0
    || delta.events.some((event) => event.type === 'chat')
    || delta.rejections.some((rejection) => rejection.source === 'mind')
    || delta.entered.some((entity) => entity.kind === 'player');
  return salient ? ['salient-event'] : [];
}
