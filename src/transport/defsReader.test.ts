import { describe, expect, test } from 'bun:test';
import { createDefsReader, serverBaseUrlOf } from './defsReader.ts';

describe('createDefsReader', () => {
  test('normalises and memoises names and regions', async () => {
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async (input) => {
      requests += 1;
      return Response.json(String(input).includes('/defs/names')
        ? { items: { 1: 'One', bad: 2 }, npcs: { 2: 'Goblin' }, locs: {} }
        : { regionId: 12 });
    }) as typeof fetch;
    try {
      const reader = createDefsReader('http://test');
      expect(await reader.names()).toEqual({ items: { 1: 'One' }, npcs: { 2: 'Goblin' } });
      await reader.names();
      expect(await reader.region(12)).toEqual({ regionId: 12 });
      await reader.region(12);
      expect(requests).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('derives the server base from join URLs', () => {
    expect(serverBaseUrlOf('http://host:1/instances/inst-1')).toBe('http://host:1');
  });
});

