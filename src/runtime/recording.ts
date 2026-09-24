import { join } from 'node:path';
import type {
  HarnessBus,
  ProvisionedWorld,
  Recorder,
  RecordingRequest,
  RecordingResolution,
  RecordingSessionHandle,
  RecordingSummary,
  RecordingTarget,
} from '../core/index.ts';
import { recordingTargetId } from '../core/recording.ts';
import { serverBaseUrlOf } from '../transport/index.ts';

const ENTITY_NAME_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 10 * 60_000;

export interface RecordingControllerOptions {
  readonly recorder: () => Recorder;
  readonly bus: HarnessBus;
  readonly runId: string;
  readonly uiUrl: string;
  readonly logDir: string;
  readonly now?: () => number;
  readonly world: () => ProvisionedWorld | undefined;
  readonly agents: () => readonly { readonly id: string; readonly entity: number; readonly displayName: string }[];
  readonly fetch?: typeof fetch;
}

export interface RecordingController {
  start(request: RecordingRequest & { readonly outDir?: string }): Promise<readonly RecordingSummary[]>;
  stop(id?: string): Promise<readonly RecordingSummary[]>;
  list(): readonly RecordingSummary[];
  onAgentSpawned(agentId: string): Promise<void>;
  close(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameResolution(left: RecordingResolution, right: RecordingResolution): boolean {
  return left.width === right.width && left.height === right.height;
}

function isActive(summary: RecordingSummary): boolean {
  return summary.state === 'starting' || summary.state === 'recording' || summary.state === 'finishing';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createRecordingController(options: RecordingControllerOptions): RecordingController {
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? fetch;
  const summaries = new Map<string, RecordingSummary>();
  let handle: RecordingSessionHandle | undefined;
  let resolution: RecordingResolution | undefined;
  let opening: Promise<RecordingSessionHandle> | undefined;
  let followNewAgents = false;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = (): void => undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let sessionGeneration = 0;

  const log = (level: 'info' | 'warn', message: string): void => {
    options.bus.emit('log', { level, scope: 'recording', message });
  };

  const clearMaxTimer = (): void => {
    if (maxTimer !== undefined) clearTimeout(maxTimer);
    maxTimer = undefined;
  };

  const remember = (summary: RecordingSummary): void => {
    summaries.set(summary.id, summary);
  };
  let observeChange = (summary: RecordingSummary): void => { remember(summary); };

  const currentList = (): readonly RecordingSummary[] => {
    const current = handle?.list() ?? [];
    for (const summary of current) remember(summary);
    return [...summaries.values()];
  };

  const entityName = async (agentId: string, serverUrl: string, instanceId: string): Promise<string> => {
    const agent = options.agents().find((entry) => entry.id === agentId);
    if (agent === undefined) throw new Error(`Recording: unknown agent '${agentId}'`);
    const fallback = agent.displayName || agentId;
    try {
      const response = await fetcher(`${serverUrl}/instances/${encodeURIComponent(instanceId)}/entities`, {
        signal: AbortSignal.timeout(ENTITY_NAME_TIMEOUT_MS),
      });
      if (!response.ok) return fallback;
      const body = await response.json() as unknown;
      if (!isRecord(body) || !Array.isArray(body.entities)) return fallback;
      const entity = body.entities.find((candidate) => isRecord(candidate) && candidate.id === agent.entity);
      return isRecord(entity) && typeof entity.name === 'string' && entity.name.length > 0
        ? entity.name
        : fallback;
    } catch {
      return fallback;
    }
  };

  const resetSession = (): void => {
    unsubscribe();
    unsubscribe = (): void => undefined;
    observeChange = (summary): void => { remember(summary); };
    handle = undefined;
    opening = undefined;
    resolution = undefined;
    followNewAgents = false;
    sessionGeneration++;
  };

  const ensureSession = async (
    request: RecordingRequest & { readonly outDir?: string },
  ): Promise<RecordingSessionHandle> => {
    if (closed) throw new Error('Recording: controller is closed');
    if (handle !== undefined || opening !== undefined) {
      const activeResolution = resolution!;
      if (!sameResolution(activeResolution, request.resolution)) {
        throw new Error(
          `Recording: a ${activeResolution.width}x${activeResolution.height} session is active; stop it before recording at ${request.resolution.width}x${request.resolution.height}`,
        );
      }
      return handle ?? await opening!;
    }

    const world = options.world();
    if (world === undefined) throw new Error('Recording: world is not provisioned');
    const serverUrl = serverBaseUrlOf(world.httpUrl);
    const sessionOutDir = request.outDir ?? join(options.logDir, 'recordings', options.runId);
    resolution = request.resolution;
    const generation = ++sessionGeneration;
    opening = Promise.resolve().then(async () => await options.recorder().open({
      runId: options.runId,
      instanceId: world.instanceId,
      uiUrl: options.uiUrl,
      serverUrl,
      outDir: sessionOutDir,
      resolution: request.resolution,
      ...(request.keepWebm === undefined ? {} : { keepWebm: request.keepWebm }),
      entityName: (agentId) => entityName(agentId, serverUrl, world.instanceId),
    }));
    try {
      const opened = await opening;
      if (generation !== sessionGeneration) {
        await opened.close();
        throw new Error('Recording: session closed while opening');
      }
      handle = opened;
      const started = new Set<string>();
      const finished = new Set<string>();
      observeChange = (summary: RecordingSummary): void => {
        remember(summary);
        if (summary.state === 'recording' && !started.has(summary.id)) {
          started.add(summary.id);
          options.bus.emit('recording.started', {
            id: summary.id,
            target: summary.target,
            resolution: summary.resolution,
            outDir: sessionOutDir,
          });
          log('info', `Recording started: ${summary.id}`);
        }
        if ((summary.state === 'done' || summary.state === 'failed') && !finished.has(summary.id)) {
          finished.add(summary.id);
          options.bus.emit('recording.finished', {
            id: summary.id,
            ok: summary.state === 'done',
            ...(summary.file === undefined ? {} : { file: summary.file }),
            durationMs: Math.max(0, (summary.endedAt ?? now()) - summary.startedAt),
            ...(summary.error === undefined ? {} : { error: summary.error }),
          });
          log(summary.state === 'done' ? 'info' : 'warn', summary.state === 'done'
            ? `Recording finished: ${summary.id}`
            : `Recording failed: ${summary.id}: ${summary.error ?? 'unknown error'}`);
        }
      };
      unsubscribe = opened.onChange(observeChange);
      for (const summary of opened.list()) observeChange(summary);
      return opened;
    } catch (error) {
      if (generation === sessionGeneration) resetSession();
      throw error;
    } finally {
      if (generation === sessionGeneration) opening = undefined;
    }
  };

  const observeResult = (summary: RecordingSummary): RecordingSummary => {
    observeChange(summary);
    return summary;
  };

  const addTargets = async (
    activeHandle: RecordingSessionHandle,
    targets: readonly RecordingTarget[],
    activeResolution: RecordingResolution,
  ): Promise<readonly RecordingSummary[]> => {
    const activeIds = new Set(activeHandle.list().filter(isActive).map((summary) => recordingTargetId(summary.target)));
    const unique = new Map<string, RecordingTarget>();
    for (const target of targets) {
      const id = recordingTargetId(target);
      if (!activeIds.has(id) && !unique.has(id)) unique.set(id, target);
    }
    const entries = [...unique.entries()];
    const settled = await Promise.allSettled(entries.map(([, target]) => activeHandle.add(target)));
    return settled.map((result, index) => {
      const [id, target] = entries[index]!;
      if (result.status === 'fulfilled') return observeResult(result.value);
      const recorded = activeHandle.list().filter((summary) =>
        recordingTargetId(summary.target) === id && summary.state === 'failed').at(-1);
      if (recorded !== undefined) return observeResult(recorded);
      const at = now();
      return observeResult({
        id,
        target,
        resolution: activeResolution,
        state: 'failed',
        startedAt: at,
        endedAt: at,
        error: errorMessage(result.reason),
      });
    });
  };

  const controller: RecordingController = {
    async start(request): Promise<readonly RecordingSummary[]> {
      const activeHandle = await ensureSession(request);
      if (request.followNewAgents === true) followNewAgents = true;
      const targets = [...request.targets];
      if (request.followNewAgents === true) {
        for (const agent of options.agents()) targets.push({ kind: 'agent', agentId: agent.id });
      }
      if (request.maxSeconds !== undefined) {
        clearMaxTimer();
        maxTimer = setTimeout(() => {
          maxTimer = undefined;
          void controller.stop().catch((error: unknown) => {
            log('warn', `Automatic recording stop failed: ${errorMessage(error)}`);
          });
        }, request.maxSeconds * 1_000);
        maxTimer.unref();
      }
      return await addTargets(activeHandle, targets, request.resolution);
    },

    async stop(id): Promise<readonly RecordingSummary[]> {
      const activeHandle = handle ?? (opening === undefined ? undefined : await opening);
      if (activeHandle === undefined) return [];
      if (id === undefined) clearMaxTimer();
      const stopped = await activeHandle.stop(id);
      for (const summary of stopped) observeChange(summary);
      if (id === undefined) {
        const remaining = activeHandle.list();
        for (const summary of remaining) observeChange(summary);
        if (!remaining.some(isActive)) {
          await activeHandle.close();
          resetSession();
        }
      }
      return stopped;
    },

    list(): readonly RecordingSummary[] {
      return currentList();
    },

    async onAgentSpawned(agentId): Promise<void> {
      if (!followNewAgents || handle === undefined || resolution === undefined) return;
      try {
        await addTargets(handle, [{ kind: 'agent', agentId }], resolution);
      } catch (error) {
        log('warn', `Could not start follow camera for agent '${agentId}': ${errorMessage(error)}`);
      }
    },

    close(): Promise<void> {
      if (closing !== undefined) return closing;
      closed = true;
      clearMaxTimer();
      closing = (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<'timeout'>((resolve) => {
          timeout = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS);
          timeout.unref();
        });
        const finish = (async (): Promise<'closed'> => {
          const activeHandle = handle ?? (opening === undefined ? undefined : await opening.catch(() => undefined));
          if (activeHandle === undefined) return 'closed';
          let failure: unknown;
          try {
            const stopped = await activeHandle.stop();
            for (const summary of stopped) observeChange(summary);
          } catch (error) {
            failure = error;
          }
          try {
            await activeHandle.close();
          } catch (error) {
            failure ??= error;
          }
          if (failure !== undefined) throw failure;
          return 'closed';
        })();
        try {
          const result = await Promise.race([finish, deadline]);
          if (result === 'timeout') log('warn', 'Recording close timed out after 10 minutes; giving up');
        } catch (error) {
          log('warn', `Recording close failed: ${errorMessage(error)}`);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          resetSession();
        }
      })();
      return closing;
    },
  };

  return controller;
}
