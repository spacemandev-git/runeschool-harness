import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface WaitParams extends Readonly<Record<string, JsonValue>> { readonly ticks: number; }
function validate(value: unknown): ValidationResult {
  const valid = typeof value === 'object' && value !== null && !Array.isArray(value) && Number.isSafeInteger((value as Record<string, unknown>).ticks) && ((value as Record<string, unknown>).ticks as number) > 0;
  return valid ? { ok: true, errors: [] } : { ok: false, errors: [{ path: 'ticks', message: 'must be a positive integer' }] };
}
class WaitBehaviour implements Behaviour {
  readonly id = 'wait'; readonly params: WaitParams; private pulses = 0;
  constructor(params: WaitParams) { this.params = params; }
  private pulse(): BehaviourStatus { this.pulses++; return this.pulses >= this.params.ticks ? { state: 'done', summary: `waited ${this.params.ticks} ticks` } : { state: 'running', note: `${this.params.ticks - this.pulses} ticks left` }; }
  async start(_ctx: ReflexContext): Promise<BehaviourStatus> { return this.pulse(); }
  async step(_ctx: ReflexContext): Promise<BehaviourStatus> { return this.pulse(); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `wait (${Math.max(0, this.params.ticks - this.pulses)} ticks left)`; }
}
export const WAIT: BehaviourDefinition = { id: 'wait', description: 'Wait for a fixed number of engine pulses.', paramsSchema: { type: 'object', required: ['ticks'], properties: { ticks: { type: 'number', minimum: 1 } } }, validate, create: (params) => new WaitBehaviour(params as WaitParams) };
