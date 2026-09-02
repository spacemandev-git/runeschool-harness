import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../bus/index.ts';
import { createSqliteMemoryFactory } from './sqliteStore.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memory-store-'));
  directories.push(directory);
  return directory;
}

describe('SQLite memory store', () => {
  test('creates the schema and persists through a fresh factory', async () => {
    const directory = temporaryDirectory();
    const factory = createSqliteMemoryFactory({ dataDir: directory, now: () => 100 });
    const store = factory.open('alice', 'run-one');
    await store.remember({ kind: 'semantic', text: '  Goblins drop bones.  ', tags: ['Drops', 'drops'] });
    store.close();

    const path = join(directory, 'agents', 'alice', 'memory.sqlite');
    const database = new Database(path, { readonly: true });
    const objects = database.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE name IN ('memories', 'memories_fts', 'memories_ai', 'memories_ad', 'memories_au', 'meta')"
    ).all().map(({ name }) => name).sort();
    expect(objects).toEqual(['memories', 'memories_ad', 'memories_ai', 'memories_au', 'memories_fts', 'meta']);
    expect(database.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()?.value)
      .toBe('1');
    expect(database.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode)
      .toBe('wal');
    database.close();

    const reopened = createSqliteMemoryFactory({ dataDir: directory, now: () => 200 })
      .open('alice', 'run-two');
    const hits = await reopened.recall({ text: 'goblins' });
    expect(hits[0]?.record).toMatchObject({
      text: 'Goblins drop bones.', tags: ['drops'], runId: 'run-one'
    });
    reopened.close();
  });

  test('blends relevance, recency, importance, and proximity', async () => {
    const directory = temporaryDirectory();
    let clock = 0;
    const store = createSqliteMemoryFactory({ dataDir: directory, now: () => clock })
      .open('ranker', 'run');

    await store.remember({ kind: 'semantic', text: 'goblin ' + 'filler '.repeat(80), importance: 0.5 });
    await store.remember({ kind: 'semantic', text: 'goblin', importance: 0.5 });
    let hits = await store.recall({ text: 'goblin' });
    expect(hits[0]?.record.text).toBe('goblin');

    await store.remember({ kind: 'episodic', text: 'same memory', tags: ['old'], importance: 0.5 });
    clock = 30 * 86_400_000;
    await store.remember({ kind: 'episodic', text: 'same memory', tags: ['new'], importance: 0.5 });
    hits = await store.recall({ text: 'same' });
    expect(hits[0]?.record.tags).toEqual(['new']);

    await store.remember({
      kind: 'spatial', text: 'bank location', importance: 0.5, at: { x: 100, z: 100, level: 0 }
    });
    await store.remember({
      kind: 'spatial', text: 'bank location', importance: 0.5, at: { x: 200, z: 200, level: 0 }
    });
    hits = await store.recall({ text: 'bank location', near: { at: { x: 101, z: 100, level: 0 }, radius: 10 } });
    expect(hits[0]?.record.at).toEqual({ x: 100, z: 100, level: 0 });

    await store.remember({ kind: 'semantic', text: 'importance tie', importance: 0 });
    await store.remember({ kind: 'semantic', text: 'importance tie', importance: 1 });
    hits = await store.recall({ text: 'importance tie' });
    expect(hits[0]?.record.importance).toBe(1);
    store.close();
  });

  test('filters by kinds and all tags, sanitizes FTS, and supports empty queries', async () => {
    const store = createSqliteMemoryFactory({ dataDir: temporaryDirectory(), now: () => 1_000 })
      .open('filterer', 'run');
    await store.remember({ kind: 'semantic', text: 'goblin weakness', tags: ['combat', 'goblin'] });
    await store.remember({ kind: 'episodic', text: 'goblin encounter', tags: ['combat'] });
    await store.remember({ kind: 'journal', text: 'most recent journal', tags: ['summary'] });

    expect((await store.recall({ text: 'goblin', kinds: ['semantic'] })).map((hit) => hit.record.kind))
      .toEqual(['semantic']);
    expect((await store.recall({ text: 'goblin', tags: ['COMBAT', 'GOBLIN'] })).map((hit) => hit.record.kind))
      .toEqual(['semantic']);
    expect((await store.recall({ text: 'goblin " * ( NEAR' }))).toHaveLength(2);
    expect((await store.recall({ text: '' }))).toHaveLength(3);
    expect((await store.recall({ text: '" * ( NEAR', limit: 1 }))[0]?.record.text)
      .toBe('most recent journal');
    store.close();
  });

  test('bumps recall metadata and supports update, recent, forget, and count', async () => {
    let clock = 50;
    const bus = createBus();
    const store = createSqliteMemoryFactory({ dataDir: temporaryDirectory(), now: () => clock, bus })
      .open('mutable', 'run');
    const first = await store.remember({ kind: 'semantic', text: 'first', importance: -1 });
    clock = 60;
    const second = await store.remember({ kind: 'episodic', text: 'second', importance: 2 });
    expect(first.importance).toBe(0);
    expect(second.importance).toBe(1);
    expect(await store.count()).toBe(2);

    const updated = await store.update(first.id, { text: 'updated first', tags: ['ONE', 'one'] });
    expect(updated).toMatchObject({ text: 'updated first', tags: ['one'] });
    const hits = await store.recall({ text: 'updated' });
    expect(hits[0]?.record).toMatchObject({ recallCount: 1, lastRecalledAt: 60 });
    expect((await store.recent(5, ['semantic']))[0]).toMatchObject({ recallCount: 1 });
    expect(await store.forget(second.id)).toBe(true);
    expect(await store.forget(second.id)).toBe(false);
    expect(await store.count()).toBe(1);
    expect(bus.history({ prefix: 'agent.memory' }).map((event) => event.type)).toHaveLength(5);
    store.close();
  });

  test('rejects invalid ids and refcounts repeated opens', async () => {
    const factory = createSqliteMemoryFactory({ dataDir: temporaryDirectory() });
    expect(() => factory.open('../escape', 'run')).toThrow('Invalid agentId');
    const first = factory.open('shared', 'run');
    const second = factory.open('shared', 'run');
    expect(first).toBe(second);
    first.close();
    expect(await second.count()).toBe(0);
    second.close();
    const third = factory.open('shared', 'run-next');
    expect(third).not.toBe(first);
    third.close();
  });
});
