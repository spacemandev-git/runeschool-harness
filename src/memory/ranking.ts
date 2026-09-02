export interface RecallScoreInput {
  readonly relevance: number;
  readonly ageDays: number;
  readonly importance: number;
  readonly distance?: number;
  readonly radius?: number;
  readonly sameLevel?: boolean;
}

export interface RecallScore {
  readonly score: number;
  readonly relevance: number;
  readonly recency: number;
  readonly importance: number;
  readonly proximity: number;
  readonly why: readonly string[];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function normalizeBm25(values: readonly number[]): readonly number[] {
  if (values.length === 0) return [];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (minimum === maximum) return values.map(() => 1);
  return values.map((value) => clamp01((maximum - value) / (maximum - minimum)));
}

export function calculateRecallScore(input: RecallScoreInput): RecallScore {
  const relevance = clamp01(input.relevance);
  const recency = Math.exp(-Math.max(0, input.ageDays) / 7);
  const importance = clamp01(input.importance);
  let proximity = 0;
  if (input.sameLevel === true && input.distance !== undefined && input.radius !== undefined) {
    if (input.radius <= 0) proximity = input.distance === 0 ? 1 : 0;
    else proximity = 1 - Math.min(1, Math.max(0, input.distance) / input.radius);
  }
  const why: string[] = [];
  if (relevance >= 0.2) why.push('fts');
  if (recency >= 0.2) why.push('recent');
  if (importance >= 0.2) why.push('important');
  if (proximity >= 0.2) why.push('near');
  return {
    score: (0.55 * relevance) + (0.20 * recency) + (0.15 * importance) + (0.10 * proximity),
    relevance,
    recency,
    importance,
    proximity,
    why
  };
}
