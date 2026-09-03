import {
  BoxRenderable,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core';
import type { AgentSpec } from '../core/agent.ts';
import type { HarnessBus } from '../core/bus.ts';
import type { RuntimeCommands, RuntimeView } from '../core/runtime.ts';
import { createAdminScreen } from './screens/admin.ts';
import { createAgentScreen } from './screens/agent.ts';
import { createAgentsScreen } from './screens/agents.ts';
import { createDirectorScreen } from './screens/director.ts';
import { createHelpScreen } from './screens/help.ts';
import { createTraceScreen } from './screens/trace.ts';
import { createWorldScreen } from './screens/world.ts';
import { TAB_NAMES } from './keymap.ts';
import { theme } from './theme.ts';
import { createStatusBar } from './widgets/statusBar.ts';

export interface CockpitOptions {
  readonly view: RuntimeView;
  readonly commands: RuntimeCommands;
  readonly bus: HarnessBus;
  readonly renderer?: CliRenderer;
  readonly refreshMs?: number;
  readonly attached?: boolean;
  readonly onDetach?: () => void;
  readonly statusHint?: string;
}

export interface Cockpit {
  start(): Promise<void>;
  stop(): Promise<void>;
  selectAgent(id: string): void;
  selectTab(name: string): void;
  readonly renderer: CliRenderer;
}

type Screen = { readonly root: BoxRenderable; focus(): void };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseObject(text: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(text);
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('expected a JSON object');
  return value as Readonly<Record<string, unknown>>;
}

export function createCockpit(options: CockpitOptions): Cockpit {
  let renderer = options.renderer;
  let mounted = false;
  let stopped = false;
  let selectedTab = 0;
  let requestedAgent: string | undefined;
  let cleanup: (() => void) | undefined;
  let resolveStopped!: () => void;
  const stoppedPromise = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const attached = options.attached ?? false;

  const cockpit: Cockpit = {
    get renderer() {
      if (renderer === undefined) throw new Error('cockpit renderer is available after start()');
      return renderer;
    },
    async start() {
      if (mounted) return await stoppedPromise;
      renderer ??= await createCliRenderer({ exitOnCtrlC: false, backgroundColor: theme.ink });
      const activeRenderer = renderer;
      const root = new BoxRenderable(activeRenderer, { id: 'cockpit', width: '100%', height: '100%', flexDirection: 'column', backgroundColor: theme.ink });
      const header = new TextRenderable(activeRenderer, { id: 'header', height: 1, width: '100%', content: '', fg: theme.paper, bg: theme.ink, truncate: true });
      const tabs = new TabSelectRenderable(activeRenderer, {
        id: 'tabs', width: '100%', height: 1,
        options: TAB_NAMES.map((name) => ({ name, description: '' })),
        tabWidth: 12, showDescription: false, showUnderline: true, wrapSelection: true,
        backgroundColor: theme.ink, textColor: theme.paperMuted,
        focusedBackgroundColor: theme.tealDim, focusedTextColor: theme.paper,
        selectedBackgroundColor: theme.teal, selectedTextColor: theme.ink,
      });
      const body = new BoxRenderable(activeRenderer, { id: 'body', width: '100%', flexGrow: 1, flexDirection: 'column' });
      const status = createStatusBar(activeRenderer);
      const footer = new TextareaRenderable(activeRenderer, {
        id: 'footer', width: '100%', height: 1, initialValue: '', wrapMode: 'none',
        backgroundColor: theme.ink, textColor: theme.paper,
        focusedBackgroundColor: '#182d29', focusedTextColor: theme.paper,
        placeholder: 'message the director…', placeholderColor: theme.paperMuted,
        keyBindings: [
          { name: 'return', action: 'submit' },
          { name: 'return', shift: true, action: 'newline' },
        ],
        onSubmit: () => { void submitFooter(); },
      });
      root.add(header);
      root.add(tabs);
      root.add(body);
      root.add(status.root);
      root.add(footer);
      activeRenderer.root.add(root);

      const openAgent = (id: string): void => { agentScreen.setAgent(id); requestedAgent = id; selectTabIndex(3); };
      const directorScreen = createDirectorScreen(activeRenderer, options.view, options.bus);
      const adminScreen = createAdminScreen(activeRenderer, options.view, options.bus);
      const agentsScreen = createAgentsScreen(activeRenderer, options.view, options.commands, openAgent);
      const agentScreen = createAgentScreen(activeRenderer, options.view, options.bus);
      const firstAgent = requestedAgent ?? options.view.agents()[0]?.id;
      if (firstAgent !== undefined) agentScreen.setAgent(firstAgent);
      const worldScreen = createWorldScreen(activeRenderer, options.view);
      const traceScreen = createTraceScreen(activeRenderer, options.bus);
      const helpScreen = createHelpScreen(activeRenderer);
      const screens: readonly Screen[] = [directorScreen, adminScreen, agentsScreen, agentScreen, worldScreen, traceScreen, helpScreen];
      let shown: Screen | undefined;
      let focusIndex = 2;
      let ctrlCAt = 0;
      let quitAt = 0;
      let pending = 0;
      let dirty = true;
      let disposed = false;

      footer.onContentChange = () => {
        if (selectedTab !== 5) return;
        const value = footer.plainText.trim();
        const isCommand = /^\/(admin|goal|say|pause|resume|cmd|spawn|model|stop|quit|detach|help)(\s|$)/.test(value);
        if (value === '') traceScreen.setFilter('');
        else if (value.startsWith('/') && !isCommand) traceScreen.setFilter(value);
      };

      function selectedAgentId(): string | undefined {
        return agentScreen.selectedAgent() ?? agentsScreen.selectedId() ?? options.view.agents()[0]?.id;
      }

      function updateHeader(): void {
        const usage = options.view.usage().reduce((total, row) => ({ prompt: total.prompt + row.usage.promptTokens, completion: total.completion + row.usage.completionTokens }), { prompt: 0, completion: 0 });
        const instance = options.view.instance;
        header.content = `RuneSchool cockpit${attached ? ' · attached' : ''} · run ${options.view.runId} · inst ${instance?.id ?? '—'} · tick ${instance?.tick ?? 0} · agents ${options.view.agents().length} · $tokens ${usage.prompt}/${usage.completion}`;
      }

      function updateFooterTarget(): void {
        if (selectedTab === 0) footer.placeholder = 'message the director…';
        else if (selectedTab === 1) footer.placeholder = 'Tell the admin what to change in the world…';
        else if (selectedTab === 3) footer.placeholder = `message ${selectedAgentId() ?? 'agent'}…`;
        else if (selectedTab === 5) footer.placeholder = '/prefix to filter, or enter a command…';
        else footer.placeholder = 'enter /model, /goal, /say, /pause, /resume, /cmd, /spawn, /stop, /quit, /detach, or /help…';
      }

      function showScreen(): void {
        const next = screens[selectedTab];
        if (next === undefined || next === shown) return;
        if (shown !== undefined) body.remove(shown.root);
        shown = next;
        body.add(next.root);
        updateFooterTarget();
        if (focusIndex === 1) next.focus();
      }

      function selectTabIndex(index: number): void {
        selectedTab = Math.max(0, Math.min(TAB_NAMES.length - 1, index));
        tabs.setSelectedIndex(selectedTab);
        showScreen();
      }

      function focusArea(index: number): void {
        focusIndex = (index + 3) % 3;
        if (focusIndex === 0) tabs.focus();
        else if (focusIndex === 1) screens[selectedTab]?.focus();
        else footer.focus();
      }

      async function runCommand(action: () => void | Promise<unknown>): Promise<void> {
        pending += 1;
        status.setBusy(true);
        status.setError(undefined);
        try {
          await action();
          dirty = true;
        } catch (error) {
          status.setError(errorText(error));
        } finally {
          pending -= 1;
          status.setBusy(pending > 0);
        }
      }

      async function consoleCommand(text: string): Promise<void> {
        const admin = text.match(/^\/admin\s+([\s\S]+)$/);
        if (admin?.[1] !== undefined) return void await options.commands.adminSay(admin[1]);
        const goal = text.match(/^\/goal\s+(\S+)\s+([\s\S]+)$/);
        if (goal?.[1] !== undefined && goal[2] !== undefined) return void await options.commands.setAgentGoal(goal[1], goal[2]);
        const say = text.match(/^\/say\s+(\S+)\s+([\s\S]+)$/);
        if (say?.[1] !== undefined && say[2] !== undefined) return void await options.commands.agentSay(say[1], say[2]);
        const pause = text.match(/^\/pause\s+(\S+)$/);
        if (pause?.[1] !== undefined) { options.commands.pauseAgent(pause[1]); return; }
        const resume = text.match(/^\/resume\s+(\S+)$/);
        if (resume?.[1] !== undefined) { options.commands.resumeAgent(resume[1]); return; }
        const command = text.match(/^\/cmd\s+(\S+)\s+(\S+)\s+([\s\S]+)$/);
        if (command?.[1] !== undefined && command[2] !== undefined && command[3] !== undefined) {
          await options.commands.agentCommand(command[1], command[2], parseObject(command[3])); return;
        }
        const spawn = text.match(/^\/spawn\s+([\s\S]+)$/);
        if (spawn?.[1] !== undefined) { await options.commands.spawnAgent(parseObject(spawn[1]) as unknown as AgentSpec); return; }
        const directorModel = text.match(/^\/model\s+director\s+(\S+)$/);
        if (directorModel?.[1] !== undefined) {
          if (options.commands.setModel === undefined) throw new Error('this runtime does not support model selection');
          await options.commands.setModel({ role: 'director', model: directorModel[1] });
          status.setHint(`director model → ${directorModel[1]}`);
          return;
        }
        const coordinatorModel = text.match(/^\/model\s+coordinator\s+(\S+)\s+(\S+)$/);
        if (coordinatorModel?.[1] !== undefined && coordinatorModel[2] !== undefined) {
          if (options.commands.setModel === undefined) throw new Error('this runtime does not support model selection');
          await options.commands.setModel({ role: 'coordinator', team: coordinatorModel[1], model: coordinatorModel[2] });
          status.setHint(`${coordinatorModel[1]} coordinator model → ${coordinatorModel[2]}`);
          return;
        }
        const agentModel = text.match(/^\/model\s+agent\s+(\S+)\s+(\S+)$/);
        if (agentModel?.[1] !== undefined && agentModel[2] !== undefined) {
          if (options.commands.setModel === undefined) throw new Error('this runtime does not support model selection');
          await options.commands.setModel({ role: 'agent', agent: agentModel[1], model: agentModel[2] });
          status.setHint(`${agentModel[1]} model → ${agentModel[2]}`);
          return;
        }
        if (/^\/model(\s|$)/.test(text)) {
          throw new Error('usage: /model director <model> | /model coordinator <team> <model> | /model agent <agent> <model>');
        }
        if (text === '/stop') { await options.commands.stop('operator'); return; }
        if (text === '/quit') {
          await options.commands.stop('operator');
          if (!attached) await cockpit.stop();
          return;
        }
        if (text === '/detach') {
          if (!attached) throw new Error('/detach is only available in attached mode');
          options.onDetach?.();
          await cockpit.stop();
          return;
        }
        if (text === '/help') { selectTabIndex(6); return; }
        throw new Error(`unknown command: ${text.split(/\s/, 1)[0] ?? text}`);
      }

      async function submitFooter(): Promise<void> {
        const text = footer.plainText.trim();
        if (text.length === 0) return;
        footer.setText('');
        if (/^\/(admin|goal|say|pause|resume|cmd|spawn|model|stop|quit|detach|help)(\s|$)/.test(text)) await runCommand(() => consoleCommand(text));
        else if (selectedTab === 0) await runCommand(() => options.commands.directorSay(text));
        else if (selectedTab === 1) await runCommand(() => options.commands.adminSay(text));
        else if (selectedTab === 3) {
          const id = selectedAgentId();
          if (id === undefined) status.setError('no agent selected');
          else await runCommand(() => options.commands.agentSay(id, text));
        } else if (selectedTab === 5 && text.startsWith('/') && !/^\/(admin|goal|say|pause|resume|cmd|spawn|model|stop|quit|detach|help)(\s|$)/.test(text)) {
          traceScreen.setFilter(text);
          status.setError(undefined);
          status.setHint(`trace filter /${traceScreen.filter()}`);
        } else await runCommand(() => consoleCommand(text));
      }

      const keyHandler = (key: KeyEvent): void => {
        let consumed = false;
        if (key.ctrl && key.name === 'c') {
          consumed = true;
          const now = Date.now();
          if (now - ctrlCAt <= 2_000) {
            ctrlCAt = 0;
            void runCommand(async () => {
              await options.commands.stop('operator');
              await cockpit.stop();
            });
          } else {
            ctrlCAt = now;
            status.setHint('press Ctrl+C again within 2s to stop');
          }
        } else if (focusIndex !== 2 && !key.ctrl && !key.meta && key.name === 'q') {
          consumed = true;
          if (attached) {
            options.onDetach?.();
            void cockpit.stop();
          } else {
            const now = Date.now();
            if (now - quitAt <= 2_000) {
              quitAt = 0;
              void runCommand(async () => {
                await options.commands.stop('operator');
                await cockpit.stop();
              });
            } else {
              quitAt = now;
              status.setHint('press q again within 2s to stop the run and exit');
            }
          }
        } else if (key.ctrl && key.name === 'l') {
          consumed = true;
          activeRenderer.requestRender();
        } else if (key.name === 'tab') {
          consumed = true;
          focusArea(focusIndex + (key.shift ? -1 : 1));
        } else if (selectedTab === 5 && key.name === 'escape' && traceScreen.filter().length > 0) {
          consumed = true;
          footer.setText('');
          traceScreen.setFilter('');
          status.setHint('trace filter cleared');
        } else if (focusIndex !== 2 && !key.ctrl && !key.meta && /^[1-7]$/.test(key.name)) {
          consumed = true;
          selectTabIndex(Number(key.name) - 1);
        } else if (focusIndex !== 2 && key.name === '?') {
          consumed = true;
          selectTabIndex(6);
        } else if (focusIndex !== 2 && selectedTab === 3 && key.shift && (key.name === '[' || key.name === ']' || key.name === '{' || key.name === '}')) {
          consumed = true;
          const list = options.view.agents();
          const current = list.findIndex((agent) => agent.id === selectedAgentId());
          const direction = key.name === '[' || key.name === '{' ? -1 : 1;
          if (list.length > 0) agentScreen.setAgent(list[(current + direction + list.length) % list.length]?.id ?? list[0]?.id ?? '');
          updateFooterTarget();
        }
        if (consumed) {
          key.preventDefault();
          key.stopPropagation();
        }
      };
      activeRenderer.keyInput.on('keypress', keyHandler);
      tabs.on(TabSelectRenderableEvents.SELECTION_CHANGED, (index: number) => { selectedTab = index; showScreen(); });
      const offBus = options.bus.onAny((event) => { if (event.type.startsWith('agent.') || event.type.startsWith('model.') || event.type.startsWith('team.')) dirty = true; });
      const refresh = (): void => {
        updateHeader();
        if (dirty) {
          agentsScreen.refresh();
          agentScreen.refresh();
          worldScreen.refresh();
          updateFooterTarget();
          dirty = false;
        }
      };
      const refreshTimer = setInterval(refresh, options.refreshMs ?? 250);
      selectedTab = Math.max(0, Math.min(TAB_NAMES.length - 1, selectedTab));
      tabs.setSelectedIndex(selectedTab);
      showScreen();
      refresh();
      focusArea(2);
      mounted = true;
      if (options.statusHint !== undefined) status.setHint(options.statusHint);

      cleanup = (): void => {
        if (disposed) return;
        disposed = true;
        clearInterval(refreshTimer);
        offBus();
        activeRenderer.keyInput.off('keypress', keyHandler);
        directorScreen.dispose();
        adminScreen.dispose();
        agentScreen.dispose();
        traceScreen.dispose();
        if (root.parent !== null) activeRenderer.root.remove(root);
      };

      cockpit.selectAgent = (id: string): void => { requestedAgent = id; agentScreen.setAgent(id); updateFooterTarget(); };
      cockpit.selectTab = (name: string): void => {
        const index = TAB_NAMES.findIndex((tab) => tab.toLowerCase() === name.toLowerCase());
        if (index < 0) throw new Error(`unknown tab: ${name}`);
        selectTabIndex(index);
      };
      if (stopped) {
        cleanup();
        renderer.destroy();
      }
      await stoppedPromise;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      cleanup?.();
      renderer?.destroy();
      resolveStopped();
    },
    selectAgent(id) { requestedAgent = id; },
    selectTab(name) {
      const index = TAB_NAMES.findIndex((tab) => tab.toLowerCase() === name.toLowerCase());
      if (index < 0) throw new Error(`unknown tab: ${name}`);
      selectedTab = index;
    },
  };
  return cockpit;
}
