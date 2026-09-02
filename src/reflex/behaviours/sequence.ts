import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface SequenceStep extends Readonly<Record<string, JsonValue>> { readonly behaviour: string; readonly params: Readonly<Record<string, JsonValue>>; }
interface SequenceParams extends Readonly<Record<string, JsonValue>> { readonly steps: readonly SequenceStep[]; }
type Resolver = (id: string) => BehaviourDefinition | undefined;
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function makeSequenceDefinition(resolveDefinition: Resolver): BehaviourDefinition {
  function validate(value: unknown): ValidationResult {
    const errors: { path: string; message: string }[] = [];
    if (!obj(value) || !Array.isArray(value.steps) || value.steps.length === 0) return { ok: false, errors: [{ path: 'steps', message: 'must be a non-empty array' }] };
    value.steps.forEach((step, index) => {
      if (!obj(step) || typeof step.behaviour !== 'string' || !obj(step.params)) { errors.push({ path: `steps.${index}`, message: 'must contain behaviour and params' }); return; }
      const definition = resolveDefinition(step.behaviour);
      if (definition === undefined) errors.push({ path: `steps.${index}.behaviour`, message: 'unknown behaviour' });
      else for (const error of definition.validate(step.params).errors) errors.push({ path: `steps.${index}.params.${error.path}`, message: error.message });
    });
    return { ok: errors.length === 0, errors };
  }
  class SequenceBehaviour implements Behaviour {
    readonly id = 'sequence'; readonly params: SequenceParams; private index = 0; private child?: Behaviour;
    constructor(params: SequenceParams) { this.params = params; }
    private build(): Behaviour | undefined { const step = this.params.steps[this.index]; const definition = step === undefined ? undefined : resolveDefinition(step.behaviour); this.child = definition?.create(step!.params); return this.child; }
    private async begin(ctx: ReflexContext): Promise<BehaviourStatus> {
      const child = this.build(); if (child === undefined) return { state: 'done', summary: `completed ${this.index} steps` };
      return this.handle(ctx, await child.start(ctx));
    }
    private async handle(ctx: ReflexContext, status: BehaviourStatus): Promise<BehaviourStatus> {
      if (status.state === 'running') return { state: 'running', note: `step ${this.index + 1}: ${this.child!.describe()}` };
      const finished = this.child!;
      await finished.stop(ctx, status.state);
      this.child = undefined;
      if (status.state === 'failed') return status;
      this.index++;
      if (this.index >= this.params.steps.length) return { state: 'done', summary: `completed ${this.index} steps` };
      return this.begin(ctx);
    }
    start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.begin(ctx); }
    async step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.child === undefined ? this.begin(ctx) : this.handle(ctx, await this.child.step(ctx)); }
    async stop(ctx: ReflexContext, why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> { if (this.child !== undefined) await this.child.stop(ctx, why); }
    describe(): string { return `sequence ${this.index + 1}/${this.params.steps.length}: ${this.child?.describe() ?? 'starting'}`.slice(0, 80); }
  }
  return { id: 'sequence', description: 'Run child behaviours in order and fail fast.', paramsSchema: { type: 'object', required: ['steps'], properties: { steps: { type: 'array', minItems: 1, items: { type: 'object', required: ['behaviour', 'params'] } } } }, validate, create: (params) => new SequenceBehaviour(params as SequenceParams) };
}
