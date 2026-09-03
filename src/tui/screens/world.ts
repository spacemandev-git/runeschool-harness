import {
  BoxRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type SelectOption,
} from '@opentui/core';
import type { JsonValue } from '#protocol';
import type { RuntimeView } from '../../core/runtime.ts';
import type {
  BackendInstanceSummary,
  BackendScenarioSummary,
  WorldDirectory,
} from '../worldDirectory.ts';
import { usageLine } from '../format.ts';
import { theme } from '../theme.ts';

type WorldChoice =
  | { readonly kind: 'instance'; readonly id: string }
  | { readonly kind: 'scenario'; readonly id: string };

export interface WorldScreenOptions {
  readonly directory?: WorldDirectory;
  readonly onConnect?: (instance: BackendInstanceSummary) => void | Promise<void>;
}

export interface WorldScreen {
  readonly root: BoxRenderable;
  refresh(): void;
  refreshRemote(): Promise<void>;
  connect(instanceId: string): Promise<BackendInstanceSummary>;
  spawnScenario(scenarioId: string): Promise<BackendInstanceSummary>;
  spawnSandbox(request: Readonly<Record<string, JsonValue>>): Promise<BackendInstanceSummary>;
  focus(): void;
  dispose(): void;
}

function instanceDescription(instance: BackendInstanceSummary): string {
  return `${instance.kind} · ${instance.state} · tick ${instance.tick} · ${instance.entityCount} entities · ${instance.pvp ? 'pvp' : 'safe'}`;
}

function choice(option: SelectOption | null): WorldChoice | undefined {
  const value: unknown = option?.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if ((entry.kind !== 'instance' && entry.kind !== 'scenario') || typeof entry.id !== 'string') return undefined;
  return { kind: entry.kind, id: entry.id };
}

export function createWorldScreen(renderer: CliRenderer, view: RuntimeView, options: WorldScreenOptions = {}): WorldScreen {
  const root = new BoxRenderable(renderer, { width: '100%', height: '100%', flexDirection: 'row' });
  const hasDirectory = options.directory !== undefined;
  const left = new BoxRenderable(renderer, {
    width: hasDirectory ? '52%' : 0,
    height: '100%',
    border: hasDirectory,
    borderColor: theme.border,
    title: hasDirectory ? 'backend worlds' : undefined,
    titleColor: theme.teal,
    flexDirection: 'column',
  });
  const selector = new SelectRenderable(renderer, {
    width: '100%', height: '100%', options: [], wrapSelection: true,
    backgroundColor: theme.ink, textColor: theme.paper,
    focusedBackgroundColor: theme.tealDim, focusedTextColor: theme.paper,
    selectedBackgroundColor: theme.teal, selectedTextColor: theme.ink,
    descriptionColor: theme.paperMuted, selectedDescriptionColor: theme.ink,
    showDescription: true, showSelectionIndicator: true,
  });
  const detail = new ScrollBoxRenderable(renderer, {
    width: hasDirectory ? '48%' : '100%', height: '100%', border: true,
    borderColor: theme.border, title: 'world', titleColor: theme.teal,
    scrollY: true, contentOptions: { flexDirection: 'column' }, focusable: !hasDirectory,
  });
  const text = new TextRenderable(renderer, { content: '', fg: theme.paper, width: '100%', wrapMode: 'word' });
  detail.add(text);
  if (hasDirectory) {
    left.add(selector);
    root.add(left);
  }
  root.add(detail);

  let instances: readonly BackendInstanceSummary[] = [];
  let scenarios: readonly BackendScenarioSummary[] = [];
  let connected: BackendInstanceSummary | undefined;
  let loading = false;
  let action = hasDirectory ? 'connecting to backend…' : '';
  let error: string | undefined;
  let disposed = false;

  const draw = (): void => {
    if (disposed) return;
    const instance = view.instance;
    const teams = view.teams();
    const selected = choice(selector.getSelectedOption());
    const selectedInstance = selected?.kind === 'instance' ? instances.find((entry) => entry.id === selected.id) : undefined;
    const selectedScenario = selected?.kind === 'scenario' ? scenarios.find((entry) => entry.id === selected.id) : undefined;
    text.content = [
      'ACTIVE INSTANCE',
      instance === undefined ? 'not connected' : `id ${instance.id}\nkind ${instance.kind}\ntick ${instance.tick}\nhttp ${instance.httpUrl}\nwatch ${instance.watchUrl ?? '—'}`,
      ...(hasDirectory ? [
        '',
        'BACKEND',
        options.directory!.backendUrl,
        '',
        'BACKEND CONNECTION',
        connected === undefined ? 'none' : `${connected.id}\n${instanceDescription(connected)}`,
        '',
        'SELECTED',
        selectedInstance === undefined
          ? selectedScenario === undefined
            ? 'none'
            : `new scenario\n${selectedScenario.name}\n${selectedScenario.description ?? selectedScenario.id}`
          : `${selectedInstance.id}\n${instanceDescription(selectedInstance)}`,
        '',
        loading ? 'working…' : error === undefined ? action : `connection error: ${error}`,
        '',
        'Enter connects to an instance or spawns the selected scenario. Press r to refresh.',
      ] : []),
      '',
      'TEAMS',
      ...(teams.length === 0 ? ['none'] : teams.map((team) => `${team.id} · ${team.mission}\n  members ${team.agents.join(', ')}\n  model ${team.coordinatorModel}\n  report ${team.lastReport ?? '—'}`)),
      '',
      'USAGE',
      ...(view.usage().length === 0 ? ['none'] : view.usage().map(usageLine)),
      '',
      'REDACTED CONFIG',
      JSON.stringify(view.config(), null, 2),
    ].join('\n');
  };

  const updateChoices = (): void => {
    const previous = choice(selector.getSelectedOption());
    selector.options = [
      ...instances.map((instance): SelectOption => ({
        name: instance.id,
        description: instanceDescription(instance),
        value: { kind: 'instance', id: instance.id } satisfies WorldChoice,
      })),
      ...scenarios.map((scenario): SelectOption => ({
        name: `+ ${scenario.name}`,
        description: `spawn scenario · ${scenario.id}`,
        value: { kind: 'scenario', id: scenario.id } satisfies WorldChoice,
      })),
    ];
    if (previous !== undefined) {
      const index = selector.options.findIndex((entry) => {
        const next = choice(entry);
        return next?.kind === previous.kind && next.id === previous.id;
      });
      if (index >= 0) selector.setSelectedIndex(index);
    }
  };

  const run = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
    if (loading) throw new Error('another world action is already running');
    loading = true;
    error = undefined;
    action = label;
    draw();
    try {
      const result = await operation();
      action = label;
      return result;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      throw caught;
    } finally {
      loading = false;
      draw();
    }
  };

  const connect = async (instanceId: string): Promise<BackendInstanceSummary> => {
    if (options.directory === undefined) throw new Error('backend world directory is not configured');
    return await run(`connected to ${instanceId}`, async () => {
      const instance = await options.directory!.connect(instanceId);
      await options.onConnect?.(instance);
      connected = instance;
      return instance;
    });
  };

  const refreshRemote = async (): Promise<void> => {
    if (options.directory === undefined) return;
    await run('backend worlds refreshed', async () => {
      [instances, scenarios] = await Promise.all([
        options.directory!.listInstances(),
        options.directory!.listScenarios(),
      ]);
      updateChoices();
    });
  };

  const spawnScenario = async (scenarioId: string): Promise<BackendInstanceSummary> => {
    if (options.directory === undefined) throw new Error('backend world directory is not configured');
    return await run(`spawned scenario ${scenarioId}`, async () => {
      const instance = await options.directory!.spawnScenario(scenarioId);
      connected = instance;
      await options.onConnect?.(instance);
      instances = await options.directory!.listInstances();
      updateChoices();
      return instance;
    });
  };

  const spawnSandbox = async (request: Readonly<Record<string, JsonValue>>): Promise<BackendInstanceSummary> => {
    if (options.directory === undefined) throw new Error('backend world directory is not configured');
    return await run('spawned sandbox', async () => {
      const instance = await options.directory!.spawnSandbox(request);
      connected = instance;
      await options.onConnect?.(instance);
      instances = await options.directory!.listInstances();
      updateChoices();
      return instance;
    });
  };

  const activate = async (): Promise<void> => {
    const selected = choice(selector.getSelectedOption());
    if (selected === undefined) throw new Error('select an instance or scenario first');
    if (selected.kind === 'instance') await connect(selected.id);
    else await spawnScenario(selected.id);
  };

  selector.on(SelectRenderableEvents.SELECTION_CHANGED, draw);
  selector.on(SelectRenderableEvents.ITEM_SELECTED, () => { void activate().catch(() => undefined); });
  selector.onKeyDown = (key) => {
    if (key.name === 'r') {
      key.preventDefault();
      void refreshRemote().catch(() => undefined);
    }
  };

  draw();
  if (hasDirectory) void refreshRemote().catch(() => undefined);

  return {
    root,
    refresh: draw,
    refreshRemote,
    connect,
    spawnScenario,
    spawnSandbox,
    focus() { if (hasDirectory) selector.focus(); else detail.focus(); },
    dispose() { disposed = true; },
  };
}
