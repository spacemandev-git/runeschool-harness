import { createBus } from '../bus/index.ts';
import type { RuntimeCommands, RuntimeView } from '../core/runtime.ts';
import { loadHarnessEnvironment } from '../environment.ts';
import { createCockpit, type Cockpit } from './app.ts';
import { createRuneSchoolWorldDirectory, type BackendInstanceSummary } from './worldDirectory.ts';

const { runeschoolApiBackend } = loadHarnessEnvironment();
const directory = createRuneSchoolWorldDirectory(runeschoolApiBackend);
const bus = createBus();
const startedAt = Date.now();
let activeInstance: BackendInstanceSummary | undefined;
let cockpit: Cockpit | undefined;

const unavailable = async (): Promise<never> => {
  throw new Error('connect to a RuneSchool instance from the World tab first');
};

const view: RuntimeView = {
  runId: `cockpit-${process.pid}`,
  startedAt,
  get instance() {
    const instance = activeInstance;
    if (instance === undefined) return undefined;
    return {
      id: instance.id,
      httpUrl: `${directory.backendUrl}/instances/${encodeURIComponent(instance.id)}`,
      kind: instance.kind,
      tick: instance.tick,
    };
  },
  agents: () => [],
  teams: () => [],
  agentSnapshot: () => undefined,
  agentReflexes: () => undefined,
  agentTranscript: () => [],
  directorTranscript: () => [],
  adminTranscript: () => [],
  coordinatorTranscript: () => [],
  usage: () => [],
  config: () => ({ backend: directory.backendUrl, mode: 'world-browser' }),
};

const commands: RuntimeCommands = {
  directorSay: unavailable,
  adminSay: unavailable,
  agentSay: unavailable,
  coordinatorSay: unavailable,
  setAgentGoal: unavailable,
  pauseAgent() { throw new Error('no harness agent is connected'); },
  resumeAgent() { throw new Error('no harness agent is connected'); },
  agentCommand: unavailable,
  spawnAgent: unavailable,
  async stop() { await cockpit?.stop(); },
};

cockpit = createCockpit({
  view,
  commands,
  bus,
  worldDirectory: directory,
  onWorldConnect(instance) {
    activeInstance = instance;
    bus.emit('world.provisioned', {
      instanceId: instance.id,
      httpUrl: `${directory.backendUrl}/instances/${encodeURIComponent(instance.id)}`,
      wsUrl: '',
      kind: instance.kind === 'scenario' ? 'scenario' : 'sandbox',
    });
  },
  statusHint: `backend ${directory.backendUrl}`,
});

cockpit.selectTab('World');
try {
  await cockpit.start();
} finally {
  await directory.close();
}
