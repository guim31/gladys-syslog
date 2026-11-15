// -----------------------------------------------------------------------------
// A test world: the SDK's fake Gladys, the real wiring (src/app.js), a fake
// link to the receiver driven by the test, a controlled clock, a /data in a
// temporary folder. No timers: the tests call hub.flush() themselves.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { parseMessage } from '../../src/syslog/parse.js';
import { Store } from '../../src/store.js';

process.env.LOG_LEVEL ??= 'silent';
process.env.TZ = 'Europe/Paris';

// 15/11/2026 12:00:00 Paris.
export const T0 = Date.UTC(2026, 10, 15, 11, 0, 0);

export class FakeLink extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.configs = [];
  }

  configure(config) {
    this.configs.push(config);
  }

  start() {
    this.connected = true;
  }

  stop() {
    this.connected = false;
  }
}

export async function createWorld({ config = {}, devices = [], dataDir, timings } = {}) {
  const clock = { now: T0 };
  const fake = createFakeGladys({ config: { language: 'en', ...config }, devices });
  const link = new FakeLink();
  const directory = dataDir ?? mkdtempSync(join(tmpdir(), 'gladys-syslog-'));
  const app = registerHandlers(fake, {
    store: new Store(directory),
    link,
    timers: false,
    now: () => clock.now,
    timings,
  });
  await fake.connect();
  await app.ready;
  const world = {
    fake: fake.fake,
    gladys: fake,
    app,
    hub: app.hub,
    link,
    clock,
    directory,
    /** A raw syslog line received from `ip`, as the receiver forwards it. */
    receive(raw, ip = '192.0.2.10') {
      const message = parseMessage(raw, { ip, receivedAt: clock.now });
      link.emit('message', JSON.parse(JSON.stringify({ type: 'message', ...message })));
    },
    advance(ms) {
      clock.now += ms;
    },
    /** Adds every discovered device to Gladys, as the user would. */
    async addAll() {
      for (const device of fake.fake.discoveredDevices) {
        await fake.fake.deviceCreated(device);
      }
    },
  };
  return world;
}
