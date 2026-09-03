import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelSelectionStore, defaultModelSelectionPath } from './modelSelectionStore.ts';

test('model selection path follows XDG_CONFIG_HOME', () => {
  expect(defaultModelSelectionPath({ XDG_CONFIG_HOME: '/config' }, '/home/test'))
    .toBe('/config/runeschool-harness/model-selections.json');
  expect(defaultModelSelectionPath({}, '/home/test'))
    .toBe('/home/test/.config/runeschool-harness/model-selections.json');
});

test('model selection store persists the latest selection for every target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-model-selections-'));
  const path = join(directory, 'nested', 'models.json');
  const store = createModelSelectionStore(path);
  try {
    expect(await store.load()).toEqual([]);
    await store.save({ role: 'director', model: 'director-one' });
    await store.save({ role: 'agent-default', model: 'agent-default' });
    await store.save({ role: 'agent', agent: 'scout', model: 'scout-model' });
    await store.save({ role: 'director', model: 'director-two' });

    expect(await store.load()).toEqual([
      { role: 'agent-default', model: 'agent-default' },
      { role: 'agent', agent: 'scout', model: 'scout-model' },
      { role: 'director', model: 'director-two' },
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('model selection store reports malformed persisted state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-model-selections-'));
  const path = join(directory, 'models.json');
  try {
    await writeFile(path, '{broken', 'utf8');
    await expect(createModelSelectionStore(path).load()).rejects.toThrow(
      `could not read persisted model selections at ${path}`
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
