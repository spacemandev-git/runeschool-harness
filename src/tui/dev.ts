import { createBus } from '../bus/index.ts';
import { createCockpit } from './app.ts';
import { createFakeRuntime } from './fake/fakeRuntime.ts';

const bus = createBus();
const fake = createFakeRuntime(bus, { seed: 1 });
const cockpit = createCockpit({ view: fake.view, commands: fake.commands, bus });

fake.start();
await cockpit.start();
cockpit.renderer.once('destroy', () => {
  fake.stop();
  process.exit(0);
});
