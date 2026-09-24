import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  Recorder,
  RecordingResolution,
  RecordingSession,
  RecordingSessionHandle,
  RecordingState,
  RecordingSummary,
  RecordingTarget,
} from '../core/recording.ts';
import { recordingTargetId } from '../core/recording.ts';

declare global {
  interface Window {
    __RECORDER_READY__?: boolean;
    __RECORDER_ERROR__?: string;
    __RECORDER_STATE__?: { tick: number; ended: boolean };
  }
}

export interface ConsoleMessageLike {
  type(): string;
  text(): string;
}

export interface VideoLike {
  path(): Promise<string>;
}

export interface PageLike {
  goto(url: string, options: { readonly waitUntil: 'load'; readonly timeout: number }): Promise<unknown>;
  waitForFunction(
    pageFunction: () => unknown,
    arg: unknown,
    options: { readonly timeout: number; readonly polling: number },
  ): Promise<unknown>;
  evaluate<Result>(pageFunction: () => Result): Promise<Result>;
  on(event: 'console', listener: (message: ConsoleMessageLike) => void): void;
  on(event: 'pageerror', listener: (error: Error) => void): void;
  video(): VideoLike | null;
}

export interface ContextLike {
  addInitScript(script: (serverUrl: string) => void, serverUrl: string): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newContext(options: {
    readonly viewport: RecordingResolution;
    readonly deviceScaleFactor: 1;
    readonly recordVideo: { readonly dir: string; readonly size: RecordingResolution };
  }): Promise<ContextLike>;
  close(): Promise<void>;
}

interface ChromiumLike {
  launch(options: {
    readonly headless: boolean;
    readonly channel?: string;
    readonly executablePath?: string;
    readonly timeout: number;
    readonly args: readonly string[];
  }): Promise<unknown>;
}

interface PlaywrightLike {
  readonly chromium: ChromiumLike;
}

export interface PlaywrightRecorderOptions {
  readonly headless?: boolean;
  readonly channel?: string;
  readonly executablePath?: string;
  readonly launchTimeoutMs?: number;
  /** Test seam replacing Playwright import and browser launch. */
  readonly launch?: () => Promise<BrowserLike>;
  /** `null` simulates a missing ffmpeg; `undefined` searches PATH. */
  readonly ffmpegPath?: string | null;
  readonly runFfmpeg?: (args: readonly string[]) => Promise<{ readonly ok: boolean; readonly output: string }>;
  readonly now?: () => number;
  /** Test seam for simulating a failed lazy import without installing Playwright. */
  readonly loadPlaywright?: () => Promise<PlaywrightLike>;
}

interface CameraRecord {
  readonly id: string;
  readonly target: RecordingTarget;
  readonly resolution: RecordingResolution;
  state: RecordingState;
  startedAt: number;
  endedAt?: number;
  file?: string;
  error?: string;
  context?: ContextLike;
  page?: PageLike;
  video?: VideoLike;
  finishPromise?: Promise<RecordingSummary>;
}

const ACTIVE_STATES = new Set<RecordingState>(['starting', 'recording', 'finishing']);
const PLAYWRIGHT_MISSING = 'Recording: the playwright package is not installed; run: bun install && bunx playwright install chromium';
const FFMPEG_TIMEOUT_MS = 10 * 60_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyTarget(target: RecordingTarget): RecordingTarget {
  return target.kind === 'overview'
    ? { kind: 'overview', ...(target.orbit === undefined ? {} : { orbit: target.orbit }), ...(target.span === undefined ? {} : { span: target.span }) }
    : { kind: 'agent', agentId: target.agentId };
}

function summaryOf(camera: CameraRecord): RecordingSummary {
  return {
    id: camera.id,
    target: copyTarget(camera.target),
    resolution: { ...camera.resolution },
    state: camera.state,
    startedAt: camera.startedAt,
    ...(camera.endedAt === undefined ? {} : { endedAt: camera.endedAt }),
    ...(camera.file === undefined ? {} : { file: camera.file }),
    ...(camera.error === undefined ? {} : { error: camera.error }),
  };
}

function isActive(camera: CameraRecord): boolean {
  return ACTIVE_STATES.has(camera.state);
}

function browserDetail(error: unknown, messages: readonly string[]): string {
  const detail = messages.slice(-3).join(' | ');
  return detail.length === 0 ? messageOf(error) : `${messageOf(error)} (browser: ${detail})`;
}

function ffmpegFailure(output: string): string {
  const lines = output.trim().split(/\r?\n/).filter((line) => line.length > 0).slice(-4);
  return lines.length === 0 ? 'ffmpeg failed with no output' : lines.join('\n');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref?.();
  });
}

async function runFfmpegCommand(
  executable: string,
  args: readonly string[],
): Promise<{ readonly ok: boolean; readonly output: string }> {
  const process = Bun.spawn([executable, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const outputPromise = Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]).then((parts) => parts.filter((part) => part.length > 0).join('\n'));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill();
  }, FFMPEG_TIMEOUT_MS);
  timer.unref?.();
  const exitCode = await process.exited;
  clearTimeout(timer);
  const output = await outputPromise;
  return {
    ok: !timedOut && exitCode === 0,
    output: timedOut ? `${output}${output.length === 0 ? '' : '\n'}ffmpeg timed out after 10 minutes` : output,
  };
}

function launchArgs(): readonly string[] {
  return [
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--use-gl=angle',
    ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
  ];
}

function isMissingExecutable(error: unknown): boolean {
  return /Executable doesn't exist/i.test(messageOf(error));
}

async function defaultPlaywrightLoader(): Promise<PlaywrightLike> {
  try {
    const packageName = 'playwright';
    return await import(packageName) as unknown as PlaywrightLike;
  } catch {
    throw new Error(PLAYWRIGHT_MISSING);
  }
}

async function launchBrowser(options: PlaywrightRecorderOptions): Promise<BrowserLike> {
  if (options.launch !== undefined) return await options.launch();

  let playwright: PlaywrightLike;
  try {
    playwright = await (options.loadPlaywright ?? defaultPlaywrightLoader)();
  } catch (error) {
    if (messageOf(error) === PLAYWRIGHT_MISSING) throw error;
    throw new Error(PLAYWRIGHT_MISSING);
  }
  const common = {
    headless: options.headless ?? true,
    timeout: options.launchTimeoutMs ?? 60_000,
    args: launchArgs(),
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
  };
  try {
    return await playwright.chromium.launch({
      ...common,
      ...(options.channel === undefined ? {} : { channel: options.channel }),
    }) as BrowserLike;
  } catch (error) {
    if (!isMissingExecutable(error) || options.channel !== undefined || options.executablePath !== undefined) throw error;
    try {
      return await playwright.chromium.launch({ ...common, channel: 'chrome' }) as BrowserLike;
    } catch (retryError) {
      throw new Error(`Recording: could not launch Chromium: ${messageOf(retryError)}; run: bunx playwright install chromium`);
    }
  }
}

function cameraRoute(session: RecordingSession, target: RecordingTarget, entityName?: string): string {
  const instance = encodeURIComponent(session.instanceId);
  if (target.kind === 'agent') {
    if (entityName === undefined) throw new Error(`Recording: no display name resolved for agent '${target.agentId}'`);
    return `#/record/${instance}?follow=${encodeURIComponent(entityName)}`;
  }
  let route = `#/record/${instance}?view=overview`;
  if (target.orbit !== false) route += '&orbit=1';
  if (target.span !== undefined && Number.isFinite(target.span) && target.span > 0) route += `&span=${target.span}`;
  return route;
}

function assertSafeCameraId(id: string): void {
  if (id.length === 0 || id.includes('/') || id.includes('\\') || id.includes(sep)) {
    throw new Error(`Recording: invalid camera id '${id}'`);
  }
}

function assertWithin(directory: string, path: string): string {
  const absolute = resolve(path);
  const child = relative(directory, absolute);
  if (child.length === 0 || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Recording: capture path escaped output directory`);
  }
  return absolute;
}

export function createPlaywrightRecorder(options: PlaywrightRecorderOptions = {}): Recorder {
  return {
    async open(session): Promise<RecordingSessionHandle> {
      const outDir = resolve(session.outDir);
      const captureDir = resolve(outDir, '.capture');
      await mkdir(outDir, { recursive: true });

      const cameras: CameraRecord[] = [];
      const listeners = new Set<(summary: RecordingSummary) => void>();
      const now = options.now ?? Date.now;
      const selectedFfmpeg = options.ffmpegPath === undefined ? Bun.which('ffmpeg') : options.ffmpegPath;
      let browserPromise: Promise<BrowserLike> | undefined;
      let browser: BrowserLike | undefined;
      let closed = false;
      let closePromise: Promise<void> | undefined;
      let manifestQueue = Promise.resolve();

      const list = (): readonly RecordingSummary[] => cameras.map(summaryOf);

      const emit = (camera: CameraRecord): void => {
        const summary = summaryOf(camera);
        for (const listener of listeners) listener(summary);
      };

      const transition = (camera: CameraRecord, state: RecordingState): void => {
        camera.state = state;
        emit(camera);
      };

      const writeManifest = async (): Promise<void> => {
        manifestQueue = manifestQueue.then(async () => {
          const manifest = {
            runId: session.runId,
            instanceId: session.instanceId,
            uiUrl: session.uiUrl,
            serverUrl: session.serverUrl,
            resolution: { ...session.resolution },
            updatedAt: new Date(now()).toISOString(),
            recordings: list(),
          };
          await writeFile(resolve(outDir, 'recording.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        });
        await manifestQueue;
      };

      const getBrowser = async (): Promise<BrowserLike> => {
        browserPromise ??= launchBrowser(options).then((launched) => {
          browser = launched;
          return launched;
        });
        return await browserPromise;
      };

      const runFfmpeg = async (args: readonly string[]): Promise<{ readonly ok: boolean; readonly output: string }> => {
        if (options.runFfmpeg !== undefined) return await options.runFfmpeg(args);
        if (selectedFfmpeg === null) return { ok: false, output: 'ffmpeg not found on PATH' };
        return await runFfmpegCommand(selectedFfmpeg, args);
      };

      const finishCamera = async (camera: CameraRecord, failureReason?: string): Promise<RecordingSummary> => {
        if (camera.finishPromise !== undefined) return await camera.finishPromise;
        camera.finishPromise = (async () => {
          transition(camera, 'finishing');
          try {
            await camera.context?.close();
          } catch (error) {
            failureReason ??= `could not close browser context: ${messageOf(error)}`;
          }
          camera.endedAt = now();

          try {
            if (camera.video === undefined) throw new Error('Playwright did not create a video');
            const source = assertWithin(captureDir, await camera.video.path());
            const webm = resolve(outDir, `${camera.id}.webm`);
            const mp4 = resolve(outDir, `${camera.id}.mp4`);
            await rename(source, webm);
            camera.file = webm;

            if (selectedFfmpeg === null) {
              camera.error = failureReason ?? 'ffmpeg not found on PATH; kept WebM';
              if (failureReason !== undefined) camera.error = `${failureReason}; ffmpeg not found on PATH; kept WebM`;
              transition(camera, failureReason === undefined ? 'done' : 'failed');
            } else {
              const args = [
                '-y',
                '-i', webm,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '18',
                '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart',
                '-an',
                mp4,
              ] as const;
              const result = await runFfmpeg(args);
              if (!result.ok) {
                camera.error = failureReason === undefined
                  ? ffmpegFailure(result.output)
                  : `${failureReason}; ${ffmpegFailure(result.output)}`;
                transition(camera, 'failed');
              } else {
                camera.file = mp4;
                if (!session.keepWebm) await unlink(webm);
                if (failureReason === undefined) {
                  delete camera.error;
                  transition(camera, 'done');
                } else {
                  camera.error = failureReason;
                  transition(camera, 'failed');
                }
              }
            }
          } catch (error) {
            camera.error = failureReason === undefined ? messageOf(error) : `${failureReason}; ${messageOf(error)}`;
            transition(camera, 'failed');
          }
          await writeManifest();
          return summaryOf(camera);
        })();
        return await camera.finishPromise;
      };

      const monitor = async (camera: CameraRecord): Promise<void> => {
        while (camera.state === 'recording') {
          try {
            const ended = await camera.page?.evaluate(() => window.__RECORDER_STATE__?.ended === true);
            if (ended === true) {
              await finishCamera(camera);
              return;
            }
          } catch (error) {
            await finishCamera(camera, `recorder state polling failed: ${messageOf(error)}`);
            return;
          }
          await delay(2_000);
        }
      };

      const add = async (target: RecordingTarget): Promise<RecordingSummary> => {
        if (closed) throw new Error('Recording: session is closed');
        const baseId = recordingTargetId(target);
        assertSafeCameraId(baseId);
        if (cameras.some((camera) => recordingTargetId(camera.target) === baseId && isActive(camera))) {
          throw new Error(`Recording: camera '${baseId}' is already active`);
        }
        let id = baseId;
        for (let suffix = 2; cameras.some((camera) => camera.id === id); suffix += 1) id = `${baseId}-${suffix}`;
        assertSafeCameraId(id);
        const camera: CameraRecord = {
          id,
          target: copyTarget(target),
          resolution: { ...session.resolution },
          state: 'starting',
          startedAt: 0,
        };
        cameras.push(camera);
        emit(camera);

        const browserErrors: string[] = [];
        try {
          const launched = await getBrowser();
          const videoDir = resolve(captureDir, id);
          await mkdir(videoDir, { recursive: true });
          const context = await launched.newContext({
            viewport: { ...session.resolution },
            deviceScaleFactor: 1,
            recordVideo: { dir: videoDir, size: { ...session.resolution } },
          });
          camera.context = context;
          await context.addInitScript((serverUrl) => {
            localStorage.setItem('runeschool.client.baseUrl', serverUrl);
            localStorage.setItem('runeschool.client.baseUrl.default', serverUrl);
          }, session.serverUrl);
          const page = await context.newPage();
          camera.page = page;
          page.on('pageerror', (error) => browserErrors.push(error.message));
          page.on('console', (entry) => {
            if (entry.type() === 'error') browserErrors.push(entry.text());
          });
          const video = page.video();
          if (video === null) throw new Error(`Playwright did not create a video for camera '${id}'`);
          camera.video = video;

          const entityName = target.kind === 'agent' ? await session.entityName(target.agentId) : undefined;
          const route = cameraRoute(session, target, entityName);
          const uiOrigin = session.uiUrl.replace(/\/+$/, '');
          await page.goto(`${uiOrigin}/${route}`, { waitUntil: 'load', timeout: 90_000 });
          await page.waitForFunction(
            () => window.__RECORDER_READY__ === true || typeof window.__RECORDER_ERROR__ === 'string',
            undefined,
            { timeout: 120_000, polling: 100 },
          );
          const recorderError = await page.evaluate(() => window.__RECORDER_ERROR__);
          if (typeof recorderError === 'string') throw new Error(recorderError);
          // A stop() or close() that raced this start already finished the camera; do not revive it.
          if (camera.finishPromise !== undefined) return await camera.finishPromise;
          camera.startedAt = now();
          transition(camera, 'recording');
          void monitor(camera);
          return summaryOf(camera);
        } catch (error) {
          const detail = browserDetail(error, browserErrors);
          try {
            await camera.context?.close();
          } catch (closeError) {
            camera.error = `${detail} (context close: ${messageOf(closeError)})`;
          }
          camera.endedAt = now();
          camera.error ??= detail;
          transition(camera, 'failed');
          await writeManifest();
          throw new Error(camera.error);
        }
      };

      const stop = async (id?: string): Promise<readonly RecordingSummary[]> => {
        if (id !== undefined) {
          const camera = cameras.find((candidate) => candidate.id === id && (candidate.state === 'starting' || candidate.state === 'recording'));
          if (camera === undefined) throw new Error(`Recording: no active camera '${id}'`);
          return [await finishCamera(camera)];
        }
        const active = cameras.filter((camera) => camera.state === 'starting' || camera.state === 'recording');
        if (active.length === 0) {
          await writeManifest();
          return list();
        }
        return await Promise.all(active.map(async (camera) => await finishCamera(camera)));
      };

      const close = async (): Promise<void> => {
        if (closePromise !== undefined) return await closePromise;
        closed = true;
        closePromise = (async () => {
          let failure: unknown;
          try {
            const active = cameras.filter((camera) => camera.state === 'starting' || camera.state === 'recording');
            await Promise.all(active.map(async (camera) => await finishCamera(camera)));
            await writeManifest();
          } catch (error) {
            failure = error;
          }
          try {
            await browser?.close();
          } catch (error) {
            failure ??= error;
          }
          try {
            await rm(captureDir, { recursive: true, force: true });
          } catch (error) {
            failure ??= error;
          }
          if (failure !== undefined) throw failure;
        })();
        return await closePromise;
      };

      return {
        list,
        add,
        stop,
        close,
        onChange(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  };
}
