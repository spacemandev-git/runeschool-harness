import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface QuestStepParams {
  readonly npc: number;
  readonly choices?: readonly number[];
  readonly maxNodes?: number;
  readonly timeoutTicks?: number;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (!positive(value.npc)) errors.push({ path: 'npc', message: 'must be a positive entity id' });
  if (value.choices !== undefined && (!Array.isArray(value.choices)
    || value.choices.some((choice) => !Number.isSafeInteger(choice) || choice < 0))) {
    errors.push({ path: 'choices', message: 'must be non-negative choice indexes' });
  }
  if (value.maxNodes !== undefined && !positive(value.maxNodes)) errors.push({ path: 'maxNodes', message: 'must be a positive integer' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

class QuestStepBehaviour implements Behaviour {
  readonly id = 'quest-step';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: QuestStepParams;
  private startedTick?: number;
  private dialogue?: string;
  private nodes = 0;
  private choiceIndex = 0;

  constructor(params: QuestStepParams) {
    this.config = params;
    this.params = params as unknown as Readonly<Record<string, JsonValue>>;
  }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 100)) {
      return { state: 'failed', reason: 'timeout', retryable: true };
    }
    for (const event of ctx.pulseEvents) {
      if (event.type === 'dialogue-started' && event.data.entity === ctx.view.entity) this.dialogue = event.data.dialogue;
      if (event.type === 'dialogue-ended' && event.data.entity === ctx.view.entity
        && (this.dialogue === undefined || event.data.dialogue === this.dialogue)) {
        return { state: 'done', summary: `quest dialogue ${event.data.dialogue} ended` };
      }
    }
    if (initial) {
      const outcome = await ctx.act({ type: 'talk-to', data: { npc: this.config.npc } });
      return outcome.ok
        ? { state: 'running', note: `talking to entity#${this.config.npc}` }
        : { state: 'failed', reason: outcome.code ?? outcome.message ?? 'talk-to rejected', retryable: false };
    }
    const node = [...ctx.pulseEvents].reverse().find((event) =>
      event.type === 'dialogue-node' && event.data.entity === ctx.view.entity);
    if (node === undefined || node.type !== 'dialogue-node') return { state: 'running', note: `${this.nodes} dialogue nodes` };
    this.dialogue = node.data.dialogue;
    if (++this.nodes > (this.config.maxNodes ?? 30)) {
      return { state: 'failed', reason: 'maximum dialogue nodes exceeded', retryable: false };
    }
    let choice: number | undefined;
    if (node.data.kind === 'choice') {
      choice = this.config.choices?.[this.choiceIndex++] ?? 0;
      if (choice >= node.data.options.length) {
        return { state: 'failed', reason: `choice ${choice} is unavailable`, retryable: false };
      }
    }
    const outcome = await ctx.act({
      type: 'dialogue-advance',
      data: choice === undefined ? {} : { choice }
    });
    return outcome.ok
      ? { state: 'running', note: `${this.nodes} dialogue nodes` }
      : { state: 'failed', reason: outcome.code ?? outcome.message ?? 'dialogue advance rejected', retryable: false };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `quest-step npc#${this.config.npc} (${this.nodes}/${this.config.maxNodes ?? 30} nodes)`.slice(0, 80); }
}

export const QUEST_STEP: BehaviourDefinition = {
  id: 'quest-step',
  description: 'Talk to an NPC and advance its quest dialogue, selecting authored choices or the first option.',
  paramsSchema: {
    type: 'object', required: ['npc'], additionalProperties: false,
    properties: {
      npc: { type: 'integer', minimum: 1 },
      choices: { type: 'array', items: { type: 'integer', minimum: 0 } },
      maxNodes: { type: 'integer', minimum: 1, default: 30 },
      timeoutTicks: { type: 'integer', minimum: 1, default: 100 }
    }
  },
  validate,
  create: (params) => new QuestStepBehaviour(params as unknown as QuestStepParams)
};
