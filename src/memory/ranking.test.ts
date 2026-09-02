import { describe, expect, test } from 'bun:test';
import { calculateRecallScore, normalizeBm25 } from './ranking.ts';

describe('memory ranking', () => {
  test('computes the specified weighted formula', () => {
    const result = calculateRecallScore({
      relevance: 0.8,
      ageDays: 7 * Math.log(2),
      importance: 0.6,
      distance: 5,
      radius: 10,
      sameLevel: true
    });
    expect(result.recency).toBeCloseTo(0.5, 10);
    expect(result.proximity).toBeCloseTo(0.5, 10);
    expect(result.score).toBeCloseTo((0.55 * 0.8) + (0.20 * 0.5) + (0.15 * 0.6) + (0.10 * 0.5), 10);
    expect(result.why).toEqual(['fts', 'recent', 'important', 'near']);
  });

  test('normalizes lower bm25 values as more relevant', () => {
    expect(normalizeBm25([-10, -5, 0])).toEqual([1, 0.5, 0]);
    expect(normalizeBm25([-1, -1])).toEqual([1, 1]);
  });

  test('gives no proximity across levels or outside the radius', () => {
    expect(calculateRecallScore({
      relevance: 0,
      ageDays: 0,
      importance: 0,
      distance: 1,
      radius: 10,
      sameLevel: false
    }).proximity).toBe(0);
    expect(calculateRecallScore({
      relevance: 0,
      ageDays: 0,
      importance: 0,
      distance: 11,
      radius: 10,
      sameLevel: true
    }).proximity).toBe(0);
  });
});
