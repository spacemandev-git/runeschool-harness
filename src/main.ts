import { readFileSync } from 'node:fs';
import { createBus } from './bus/index.ts';
import { createAdmin } from './admin/index.ts';
import { parseRunConfig, type HarnessSubcommand, type ParsedRunConfig } from './cli/config.ts';
import { startDaemon } from './cli/daemon.ts';
import { runHeadless } from './cli/headless.ts';
import {
  daemonLogPath, formatPs, harnessCommand, pruneStaleDescriptors, readLogTail, selectControlDescriptor,
  runPhasesSubcommand,
} from './cli/subcommands.ts';
import { connectControl, createControlServer, listControlDescriptors } from './control/index.ts';
import { createSqliteMemoryFactory } from './memory/index.ts';
import { createModelRegistry, loadModelConfig } from './models/index.ts';
import { createPromptLibrary } from './prompts/index.ts';
import { createHarnessRuntime } from './runtime/orchestrator.ts';
import { createCockpit } from './tui/index.ts';

async function followLog(path: string): Promise<void> {
  let offset = readFileSync(path).byteLength;
  let stopped = false;
  const stop = (): void => { stopped = true; };
  process.once('SIGINT', stop);
  try {
    while (!stopped) {
      await Bun.sleep(250);
      let bytes: Buffer;
      try { bytes = readFileSync(path); } catch { continue; }
      if (bytes.byteLength < offset) offset = 0;
      if (bytes.byteLength > offset) {
        process.stdout.write(bytes.subarray(offset));
        offset = bytes.byteLength;
      }
    }
  } finally {
    process.off('SIGINT', stop);
  }
}

async function runSubcommand(command: HarnessSubcommand): Promise<number> {
  const descriptors = await listControlDescriptors(command.logDir);
  if (command.name === 'phases') return await runPhasesSubcommand(command, descriptors);
  if (command.name === 'ps') {
    console.log(formatPs(descriptors));
    if (command.prune) console.log(`pruned ${pruneStaleDescriptors(descriptors)} stale descriptor(s)`);
    return 0;
  }

  const descriptor = selectControlDescriptor(descriptors, command.target);
  if (command.name === 'logs') {
    const path = daemonLogPath(descriptor, command.logDir);
    console.log(path);
    const output = readLogTail(path);
    if (output.length > 0) console.log(output);
    if (command.follow) await followLog(path);
    return 0;
  }

  const client = await connectControl(descriptor);
  if (command.name === 'stop') {
    await client.commands.stop('operator stop');
    const reason = await client.closed;
    console.log(`run ${descriptor.runId} stopped · ${reason}`);
    return 0;
  }

  let detached = false;
  let detachClose: Promise<void> | undefined;
  const cockpit = createCockpit({
    view: client.view,
    commands: client.commands,
    bus: client.bus,
    attached: true,
    onDetach: () => {
      detached = true;
      detachClose ??= client.close();
    },
  });
  const serverClosed = client.closed.then(async (reason) => {
    if (detached) return;
    await cockpit.stop();
    console.log(`run ${descriptor.runId} closed · ${reason}`);
  });
  await cockpit.start();
  if (detached) await detachClose;
  await serverClosed;
  return 0;
}

async function run(parsed: ParsedRunConfig): Promise<number> {
  const bus = createBus();
  const models = createModelRegistry(loadModelConfig(parsed.modelConfigPath, process.env), { bus, env: process.env });
  const prompts = createPromptLibrary();
  const memoryFactory = createSqliteMemoryFactory({ dataDir: parsed.dataDir, bus });
  // The only runtime-to-Mind seam. Loading after parsing keeps --help and control commands dependency-free.
  const { createAgentMind } = await import('./mind/index.ts');
  const runtime = createHarnessRuntime(parsed, { bus, models, prompts, memoryFactory, mindFactory: createAgentMind, adminFactory: createAdmin });
  const stopForSignal = (signal: string): void => { void runtime.commands.stop(signal); };
  process.once('SIGINT', () => stopForSignal('SIGINT'));
  process.once('SIGTERM', () => stopForSignal('SIGTERM'));

  let server: Awaited<ReturnType<typeof createControlServer>> | undefined;
  try {
    await runtime.start();
    if (parsed.serve !== false) {
      server = await createControlServer({
        runId: parsed.runId,
        logDir: parsed.logDir,
        mcpUrl: parsed.mcpUrl,
        view: runtime.view,
        commands: runtime.commands,
        bus,
        ...(parsed.daemonLogPath === undefined ? {} : { logPath: parsed.daemonLogPath }),
      });
      void runtime.stopped.then(({ reason }) => server?.close(reason));
    }

    if (parsed.headless) {
      const running = runHeadless(runtime, bus);
      if (parsed.directorPrompt !== undefined) await runtime.commands.directorSay(parsed.directorPrompt);
      if (parsed.adminPrompt !== undefined) await runtime.commands.adminSay(parsed.adminPrompt);
      const code = await running;
      const { reason } = await runtime.stopped;
      await server?.close(reason);
      return code;
    }

    const cockpit = createCockpit({
      view: runtime.view,
      commands: runtime.commands,
      bus,
      ...(parsed.serve === false ? {} : {
        statusHint: `attach from another terminal: ${harnessCommand(`attach ${parsed.runId}`)}`,
      }),
    });
    void runtime.stopped.then(() => cockpit.stop());
    const cockpitRunning = cockpit.start();
    if (parsed.directorPrompt !== undefined) await runtime.commands.directorSay(parsed.directorPrompt);
    if (parsed.adminPrompt !== undefined) await runtime.commands.adminSay(parsed.adminPrompt);
    await cockpitRunning;
    await runtime.commands.stop('cockpit closed');
    const { reason } = await runtime.stopped;
    await server?.close(reason);
    const forceExit = setTimeout(() => process.exit(process.exitCode ?? 0), 2_000);
    forceExit.unref();
    return 0;
  } catch (error) {
    const adminToken = parsed.world.kind === 'attach' ? parsed.world.adminToken : undefined;
    const redactAdminToken = (text: string): string => adminToken === undefined || adminToken.length === 0
      ? text : text.replaceAll(adminToken, '[REDACTED]');
    const message = redactAdminToken(error instanceof Error ? error.message : String(error));
    bus.emit('run.error', {
      error: message,
      ...(error instanceof Error && error.stack !== undefined ? { stack: redactAdminToken(error.stack) } : {})
    });
    await runtime.commands.stop('runtime error');
    await server?.close('runtime error');
    console.error(`Harness failed: ${message}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let parsed;
  try { parsed = parseRunConfig(argv, process.env); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\nRun with --help for usage.');
    process.exitCode = 1;
    return;
  }
  if ('help' in parsed) { console.log(parsed.help); return; }
  try {
    if ('subcommand' in parsed) process.exitCode = await runSubcommand(parsed.subcommand);
    else if (parsed.daemon) process.exitCode = await startDaemon(parsed, argv);
    else process.exitCode = await run(parsed);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
