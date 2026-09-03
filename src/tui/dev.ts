import { createBus } from '../bus/index.ts';
import { loadHarnessEnvironment } from '../environment.ts';
import { loadModelConfig } from '../models/config.ts';
import { createModelRegistry } from '../models/registry.ts';
import { createCockpit, type Cockpit } from './app.ts';
import { createWorldBrowserRuntime } from './launcherRuntime.ts';
import { createModelSelectionStore } from './modelSelectionStore.ts';
import { createRuneSchoolWorldDirectory } from './worldDirectory.ts';

const { runeschoolApiBackend } = loadHarnessEnvironment();
const directory = createRuneSchoolWorldDirectory(runeschoolApiBackend);
const bus = createBus();
let cockpit: Cockpit | undefined;
const models = createModelRegistry(loadModelConfig(), { bus });
const modelSelectionStore = createModelSelectionStore();
let persistedSelections = [] as Awaited<ReturnType<typeof modelSelectionStore.load>>;
let persistenceWarning: string | undefined;
try {
  persistedSelections = await modelSelectionStore.load();
} catch (error) {
  persistenceWarning = error instanceof Error ? error.message : String(error);
}
const runtime = createWorldBrowserRuntime({
  backendUrl: directory.backendUrl,
  models,
  initialModelSelections: persistedSelections,
  async onModelSelected(selection) { await modelSelectionStore.save(selection); },
  async onStop() { await cockpit?.stop(); },
});

cockpit = createCockpit({
  view: runtime.view,
  commands: runtime.commands,
  bus,
  worldDirectory: directory,
  onWorldConnect(instance) {
    runtime.connect(instance);
    bus.emit('world.provisioned', {
      instanceId: instance.id,
      httpUrl: `${directory.backendUrl}/instances/${encodeURIComponent(instance.id)}`,
      wsUrl: '',
      kind: instance.kind === 'scenario' ? 'scenario' : 'sandbox',
    });
  },
  statusHint: persistenceWarning === undefined
    ? `backend ${directory.backendUrl}`
    : `model persistence warning: ${persistenceWarning}`,
});

cockpit.selectTab('World');
try {
  await cockpit.start();
} finally {
  await directory.close();
}
