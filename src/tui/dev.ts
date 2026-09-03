import { resolve } from 'node:path';
import type { JsonValue, TileCoord } from '#protocol';
import { createAdmin } from '../admin/index.ts';
import { createBus } from '../bus/index.ts';
import { loadHarnessEnvironment } from '../environment.ts';
import { createSqliteMemoryFactory } from '../memory/index.ts';
import { createAgentMind } from '../mind/index.ts';
import { loadModelConfig } from '../models/config.ts';
import { createModelRegistry } from '../models/registry.ts';
import { createPromptLibrary } from '../prompts/index.ts';
import { createCockpit, type Cockpit } from './app.ts';
import { createCockpitLauncher } from './launcherRuntime.ts';
import { createModelSelectionStore } from './modelSelectionStore.ts';
import { createRuneSchoolWorldDirectory } from './worldDirectory.ts';

function uiUrlForBackend(backendUrl: string): string {
  const url = new URL(backendUrl);
  if (url.hostname === 'api.runeschool.dev') return 'https://runeschool.dev';
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
    return 'http://localhost:5300';
  }
  return url.origin;
}

function sandboxDefaultSpawn(request: Readonly<Record<string, JsonValue>>): TileCoord | undefined {
  const players = request.players;
  if (!Array.isArray(players)) return undefined;
  const player = players[0];
  if (typeof player !== 'object' || player === null || Array.isArray(player)) return undefined;
  const spawnAt = player.spawnAt;
  if (typeof spawnAt !== 'object' || spawnAt === null || Array.isArray(spawnAt)) return undefined;
  if (typeof spawnAt.x !== 'number' || !Number.isFinite(spawnAt.x)
    || typeof spawnAt.z !== 'number' || !Number.isFinite(spawnAt.z)
    || typeof spawnAt.level !== 'number' || !Number.isFinite(spawnAt.level)) return undefined;
  return { x: spawnAt.x, z: spawnAt.z, level: spawnAt.level };
}

const { runeschoolApiBackend } = loadHarnessEnvironment();
const backendUrl = runeschoolApiBackend.replace(/\/+$/, '');
const mcpUrl = `${backendUrl}/mcp`;
const uiUrl = uiUrlForBackend(backendUrl);
const directory = createRuneSchoolWorldDirectory(backendUrl);
const bus = createBus();
let cockpit: Cockpit | undefined;
const models = createModelRegistry(loadModelConfig(), { bus });
const prompts = createPromptLibrary();
const logDir = resolve(import.meta.dir, '../../runs');
const dataDir = resolve(import.meta.dir, '../../data');
const memoryFactory = createSqliteMemoryFactory({ dataDir, bus });
const modelSelectionStore = createModelSelectionStore();
let persistedSelections = [] as Awaited<ReturnType<typeof modelSelectionStore.load>>;
let persistenceWarning: string | undefined;
try {
  persistedSelections = await modelSelectionStore.load();
} catch (error) {
  persistenceWarning = error instanceof Error ? error.message : String(error);
}

const launcher = createCockpitLauncher({
  backendUrl,
  mcpUrl,
  uiUrl,
  bus,
  models,
  prompts,
  memoryFactory,
  mindFactory: createAgentMind,
  adminFactory: createAdmin,
  logDir,
  dataDir,
  initialModelSelections: persistedSelections,
  async onModelSelected(selection) { await modelSelectionStore.save(selection); },
  async onStop() { await cockpit?.stop(); },
});

cockpit = createCockpit({
  view: launcher.view,
  commands: launcher.commands,
  bus,
  worldDirectory: directory,
  async onWorldConnect(instance) { await launcher.connect(instance); },
  async onSpawnScenario(scenarioId) {
    const instanceId = await launcher.spawnScenario(scenarioId);
    return await directory.connect(instanceId);
  },
  async onSpawnSandbox(request) {
    const instance = await directory.spawnSandbox(request);
    const defaultSpawn = sandboxDefaultSpawn(request);
    await launcher.connect(instance, defaultSpawn === undefined ? undefined : { defaultSpawn });
    return instance;
  },
  statusHint: persistenceWarning === undefined
    ? `backend ${directory.backendUrl}`
    : `model persistence warning: ${persistenceWarning}`,
});

cockpit.selectTab('World');
try {
  await cockpit.start();
} finally {
  await launcher.stop('cockpit exit');
  await directory.close();
}
