import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordingSession } from '../core/recording.ts';
import {
  createPlaywrightRecorder,
  type BrowserLike,
  type ConsoleMessageLike,
  type ContextLike,
  type PageLike,
  type VideoLike,
} from './recorder.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-recorder-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

interface PageSettings {
  readonly recorderError?: string;
  readonly consoleErrors?: readonly string[];
  readonly pageErrors?: readonly string[];
  readonly ended?: boolean;
  readonly pollingError?: Error;
}

class FakeVideo implements VideoLike {
  constructor(readonly source: string) {}
  async path(): Promise<string> { return this.source; }
}

class FakePage implements PageLike {
  url?: string;
  gotoOptions?: { readonly waitUntil: 'load'; readonly timeout: number };
  waitOptions?: { readonly timeout: number; readonly polling: number };
  private evaluations = 0;
  private readonly consoleListeners: Array<(message: ConsoleMessageLike) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  constructor(readonly capture: FakeVideo, private readonly settings: PageSettings = {}) {}

  async goto(url: string, options: { readonly waitUntil: 'load'; readonly timeout: number }): Promise<void> {
    this.url = url;
    this.gotoOptions = options;
  }

  async waitForFunction(
    _pageFunction: () => unknown,
    _arg: unknown,
    options: { readonly timeout: number; readonly polling: number },
  ): Promise<void> {
    this.waitOptions = options;
    for (const message of this.settings.consoleErrors ?? []) {
      for (const listener of this.consoleListeners) listener({ type: () => 'error', text: () => message });
    }
    for (const error of this.settings.pageErrors ?? []) {
      for (const listener of this.errorListeners) listener(new Error(error));
    }
  }

  async evaluate<Result>(_pageFunction: () => Result): Promise<Result> {
    this.evaluations += 1;
    if (this.evaluations === 1) return this.settings.recorderError as Result;
    if (this.settings.pollingError !== undefined) throw this.settings.pollingError;
    return (this.settings.ended === true) as Result;
  }

  on(event: 'console' | 'pageerror', listener: ((message: ConsoleMessageLike) => void) | ((error: Error) => void)): void {
    if (event === 'console') this.consoleListeners.push(listener as (message: ConsoleMessageLike) => void);
    else this.errorListeners.push(listener as (error: Error) => void);
  }

  video(): VideoLike { return this.capture; }
}

class FakeContext implements ContextLike {
  closed = 0;
  readonly storage = new Map<string, string>();

  constructor(readonly page: FakePage) {}

  async addInitScript(script: (serverUrl: string) => void, serverUrl: string): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { setItem: (key: string, value: string) => this.storage.set(key, value) },
    });
    try {
      script(serverUrl);
    } finally {
      if (original === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  }

  async newPage(): Promise<PageLike> { return this.page; }
  async close(): Promise<void> { this.closed += 1; }
}

class FakeBrowser implements BrowserLike {
  readonly contexts: FakeContext[] = [];
  readonly contextOptions: Parameters<BrowserLike['newContext']>[0][] = [];
  closed = 0;

  constructor(private readonly outDir: string, private readonly settings: readonly PageSettings[] = []) {}

  async newContext(options: Parameters<BrowserLike['newContext']>[0]): Promise<ContextLike> {
    this.contextOptions.push(options);
    const index = this.contexts.length;
    const source = join(options.recordVideo.dir, `.source-${index}.webm`);
    await writeFile(source, `capture ${index}`, 'utf8');
    const context = new FakeContext(new FakePage(new FakeVideo(source), this.settings[index]));
    this.contexts.push(context);
    return context;
  }

  async close(): Promise<void> { this.closed += 1; }
}

function session(outDir: string, overrides: Partial<RecordingSession> = {}): RecordingSession {
  return {
    runId: 'run-test',
    instanceId: 'inst / one',
    uiUrl: 'https://runeschool.example///',
    serverUrl: 'https://api.runeschool.example',
    outDir,
    resolution: { width: 2560, height: 1440 },
    async entityName() { return 'Alice / Mage'; },
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await Bun.sleep(5);
  }
}

describe('Playwright recorder', () => {
  test('constructs overview and follow routes, viewport options, and both localStorage keys', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir);
    const handle = await createPlaywrightRecorder({ launch: async () => browser, ffmpegPath: null }).open(session(outDir));

    await handle.add({ kind: 'overview', span: 36 });
    await handle.add({ kind: 'agent', agentId: 'alice' });

    expect(browser.contexts[0]?.page.url).toBe('https://runeschool.example/#/record/inst%20%2F%20one?view=overview&orbit=1&span=36');
    expect(browser.contexts[1]?.page.url).toBe('https://runeschool.example/#/record/inst%20%2F%20one?follow=Alice%20%2F%20Mage');
    expect(browser.contexts[0]?.page.gotoOptions).toEqual({ waitUntil: 'load', timeout: 90_000 });
    expect(browser.contexts[0]?.page.waitOptions).toEqual({ timeout: 120_000, polling: 100 });
    expect(browser.contextOptions[0]).toEqual({
      viewport: { width: 2560, height: 1440 },
      deviceScaleFactor: 1,
      recordVideo: { dir: join(outDir, '.capture', 'overview'), size: { width: 2560, height: 1440 } },
    });
    expect(Object.fromEntries(browser.contexts[0]?.storage ?? [])).toEqual({
      'runeschool.client.baseUrl': 'https://api.runeschool.example',
      'runeschool.client.baseUrl.default': 'https://api.runeschool.example',
    });
    await handle.close();
  });

  test('emits starting and recording transitions and timestamps readiness', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir);
    let time = 40;
    const handle = await createPlaywrightRecorder({
      launch: async () => browser,
      ffmpegPath: null,
      now: () => ++time,
    }).open(session(outDir));
    const transitions: Array<{ readonly state: string; readonly startedAt: number }> = [];
    handle.onChange((summary) => transitions.push({ state: summary.state, startedAt: summary.startedAt }));

    const ready = await handle.add({ kind: 'overview', orbit: false });

    expect(ready.state).toBe('recording');
    expect(ready.startedAt).toBe(41);
    expect(transitions.slice(0, 2)).toEqual([
      { state: 'starting', startedAt: 0 },
      { state: 'recording', startedAt: 41 },
    ]);
    expect(browser.contexts[0]?.page.url).toBe('https://runeschool.example/#/record/inst%20%2F%20one?view=overview');
    await handle.close();
  });

  test('records startup errors with the last three browser details and closes the context', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir, [{
      recorderError: 'unknown follower',
      consoleErrors: ['old detail', 'console second', 'console third'],
      pageErrors: ['page fourth'],
    }]);
    const handle = await createPlaywrightRecorder({ launch: async () => browser, ffmpegPath: null }).open(session(outDir));

    await expect(handle.add({ kind: 'agent', agentId: 'missing' })).rejects.toThrow(
      'unknown follower (browser: console second | console third | page fourth)',
    );
    expect(handle.list()[0]).toMatchObject({ state: 'failed', startedAt: 0 });
    expect(browser.contexts[0]?.closed).toBe(1);
    await handle.close();
  });

  test('automatically stops when the recorder page reports ended', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir, [{ ended: true }]);
    const handle = await createPlaywrightRecorder({ launch: async () => browser, ffmpegPath: null }).open(session(outDir));

    await handle.add({ kind: 'overview' });
    await waitUntil(() => handle.list()[0]?.state === 'done');

    expect(handle.list()[0]).toMatchObject({
      state: 'done',
      file: join(outDir, 'overview.webm'),
      error: 'ffmpeg not found on PATH; kept WebM',
    });
    expect(browser.contexts[0]?.closed).toBe(1);
    await handle.close();
  });

  test('preserves captured video and marks polling failures failed', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir, [{ pollingError: new Error('page crashed') }]);
    const handle = await createPlaywrightRecorder({ launch: async () => browser, ffmpegPath: null }).open(session(outDir));

    await handle.add({ kind: 'overview' });
    await waitUntil(() => handle.list()[0]?.state === 'failed');

    expect(handle.list()[0]).toMatchObject({
      state: 'failed',
      file: join(outDir, 'overview.webm'),
      error: 'recorder state polling failed: page crashed; ffmpeg not found on PATH; kept WebM',
    });
    expect(await Bun.file(join(outDir, 'overview.webm')).exists()).toBe(true);
    await handle.close();
  });

  test('transcodes with exact ffmpeg arguments, writes a manifest, and removes WebM by default', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir);
    const invocations: readonly string[][] = [];
    const mutableInvocations = invocations as string[][];
    const handle = await createPlaywrightRecorder({
      launch: async () => browser,
      ffmpegPath: '/usr/local/bin/ffmpeg',
      now: () => 1_700_000_000_000,
      async runFfmpeg(args) {
        mutableInvocations.push([...args]);
        const output = args.at(-1);
        if (output !== undefined) await writeFile(output, 'mp4', 'utf8');
        return { ok: true, output: '' };
      },
    }).open(session(outDir));
    await handle.add({ kind: 'overview' });

    const [stopped] = await handle.stop('overview');
    const webm = join(outDir, 'overview.webm');
    const mp4 = join(outDir, 'overview.mp4');

    expect(invocations).toEqual([[
      '-y', '-i', webm,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an', mp4,
    ]]);
    expect(stopped).toMatchObject({ state: 'done', file: mp4 });
    expect(await Bun.file(webm).exists()).toBe(false);
    const manifest = JSON.parse(await readFile(join(outDir, 'recording.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      runId: 'run-test',
      instanceId: 'inst / one',
      uiUrl: 'https://runeschool.example///',
      serverUrl: 'https://api.runeschool.example',
      resolution: { width: 2560, height: 1440 },
      updatedAt: '2023-11-14T22:13:20.000Z',
    });
    expect(manifest.recordings).toEqual(handle.list());
    expect((await readFile(join(outDir, 'recording.json'), 'utf8')).endsWith('\n')).toBe(true);
    await handle.close();
  });

  test('keeps WebM as a successful fallback when ffmpeg is missing', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir);
    const handle = await createPlaywrightRecorder({ launch: async () => browser, ffmpegPath: null }).open(session(outDir));
    await handle.add({ kind: 'overview' });

    const [stopped] = await handle.stop('overview');

    expect(stopped).toMatchObject({
      state: 'done',
      file: join(outDir, 'overview.webm'),
      error: 'ffmpeg not found on PATH; kept WebM',
    });
    expect(await Bun.file(join(outDir, 'overview.webm')).exists()).toBe(true);
    await handle.close();
  });

  test('keeps WebM and reports the tail when ffmpeg fails', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir);
    const handle = await createPlaywrightRecorder({
      launch: async () => browser,
      ffmpegPath: '/ffmpeg',
      async runFfmpeg() {
        return { ok: false, output: 'discarded\none\ntwo\nthree\nfour' };
      },
    }).open(session(outDir, { keepWebm: true }));
    await handle.add({ kind: 'overview' });

    const [stopped] = await handle.stop('overview');

    expect(stopped).toMatchObject({
      state: 'failed',
      file: join(outDir, 'overview.webm'),
      error: 'one\ntwo\nthree\nfour',
    });
    expect(await Bun.file(join(outDir, 'overview.webm')).exists()).toBe(true);
    await handle.close();
  });

  test('keeps the intermediate WebM after a successful transcode when requested', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir);
    const handle = await createPlaywrightRecorder({
      launch: async () => browser,
      ffmpegPath: '/ffmpeg',
      async runFfmpeg(args) {
        const output = args.at(-1);
        if (output !== undefined) await writeFile(output, 'mp4', 'utf8');
        return { ok: true, output: '' };
      },
    }).open(session(outDir, { keepWebm: true }));
    await handle.add({ kind: 'overview' });

    const [stopped] = await handle.stop('overview');

    expect(stopped).toMatchObject({ state: 'done', file: join(outDir, 'overview.mp4') });
    expect(await Bun.file(join(outDir, 'overview.webm')).exists()).toBe(true);
    await handle.close();
  });

  test('rejects active duplicates and gives a repeated finished target a new basename', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir);
    const handle = await createPlaywrightRecorder({ launch: async () => browser, ffmpegPath: null }).open(session(outDir));
    await handle.add({ kind: 'overview' });

    await expect(handle.add({ kind: 'overview' })).rejects.toThrow("Recording: camera 'overview' is already active");
    await handle.stop('overview');
    await expect(handle.stop('overview')).rejects.toThrow("Recording: no active camera 'overview'");
    expect(await handle.stop()).toHaveLength(1);
    expect((await handle.add({ kind: 'overview' })).id).toBe('overview-2');
    await handle.close();
  });

  test('close is idempotent, removes captures, and prevents later cameras', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir);
    const handle = await createPlaywrightRecorder({ launch: async () => browser, ffmpegPath: null }).open(session(outDir));
    await handle.add({ kind: 'overview' });

    await Promise.all([handle.close(), handle.close()]);

    expect(browser.closed).toBe(1);
    expect(await Bun.file(join(outDir, '.capture')).exists()).toBe(false);
    await expect(handle.add({ kind: 'overview' })).rejects.toThrow('Recording: session is closed');
  });

  test('reports a failed lazy Playwright import with the installation command', async () => {
    const outDir = await temporaryDirectory();
    const handle = await createPlaywrightRecorder({
      ffmpegPath: null,
      async loadPlaywright() { throw new Error('module not found'); },
    }).open(session(outDir));

    await expect(handle.add({ kind: 'overview' })).rejects.toThrow(
      'Recording: the playwright package is not installed; run: bun install && bunx playwright install chromium',
    );
    expect(handle.list()[0]?.state).toBe('failed');
    await handle.close();
  });

  test('retries a missing bundled Chromium with the Chrome channel and required launch arguments', async () => {
    const outDir = await temporaryDirectory();
    const browser = new FakeBrowser(outDir);
    const launches: Array<Record<string, unknown>> = [];
    const handle = await createPlaywrightRecorder({
      ffmpegPath: null,
      loadPlaywright: async () => ({
        chromium: {
          async launch(launchOptions) {
            launches.push({ ...launchOptions });
            if (launches.length === 1) throw new Error("Executable doesn't exist at bundled path");
            return browser;
          },
        },
      }),
    }).open(session(outDir));

    await handle.add({ kind: 'overview' });

    expect(launches).toHaveLength(2);
    expect(launches[0]).toMatchObject({ headless: true, timeout: 60_000 });
    expect(launches[1]).toMatchObject({ channel: 'chrome' });
    expect(launches[0]?.args).toEqual([
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    ]);
    await handle.close();
  });
});
