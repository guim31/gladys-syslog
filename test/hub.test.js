// -----------------------------------------------------------------------------
// The hub (src/hub.js) through the real wiring (src/app.js) and the SDK's fake
// Gladys: discovery of the senders, states and their budget, rules, scene
// events and their cooldown, the widget, the receiver link, quiet logs.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { sourceIds, rulesIds } from '../src/devices.js';
import { TRIGGERS, WIDGET_KEY } from '../src/hub.js';
import { Store } from '../src/store.js';
import { T0, createWorld } from './helpers/world.js';

const NAS = '192.0.2.10';
const ROUTER = '192.0.2.1';
const RULES = {
  rule_1_name: 'Power cut',
  rule_1_pattern: 'on battery',
  rule_2_name: 'Disk failure',
  rule_2_pattern: '/ata\\d.*failed/i',
  rule_2_severity: 'err',
  rule_2_sources: 'nas-01',
};

const events = (world, key) =>
  world.fake.sceneEvents.filter((event) => event.key === key).map((event) => event.data);
const state = (world, id) => world.fake.lastState(id);

test('a new sender is proposed in Discovery, named by its host name, and announced', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.receive('<30>Nov 15 12:00:00 nas-01 smbd[1]: started', NAS);
  world.receive('<30>dnsmasq[2]: no host name here', ROUTER);
  await world.hub.flush();
  const devices = world.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => [d.name, d.external_id]),
    [
      ['nas-01', sourceIds(world.gladys, NAS).device],
      [ROUTER, sourceIds(world.gladys, ROUTER).device],
    ],
  );
  assert.deepEqual(
    events(world, TRIGGERS.NEW_SOURCE).map((e) => e.ip),
    [NAS, ROUTER],
  );
});

test('the senders survive a restart, without any message on disk', async (t) => {
  const first = await createWorld();
  first.receive('<11>Nov 15 12:00:00 nas-01 secret: do not keep me', NAS);
  await first.app.stop();
  const saved = JSON.parse(
    await import('node:fs/promises').then((fs) =>
      fs.readFile(`${first.directory}/syslog-sources.json`, 'utf8'),
    ),
  );
  assert.deepEqual(saved.sources[0].ip, NAS);
  assert.ok(!JSON.stringify(saved).includes('do not keep me'));
  const again = await createWorld({ dataDir: first.directory });
  t.after(() => again.app.stop());
  assert.equal(again.fake.discoveredDevices[0].name, 'nas-01');
  assert.equal(events(again, TRIGGERS.NEW_SOURCE).length, 0, 'not new any more');
  assert.ok(new Store(first.directory));
});

test('states of the added senders: published once, then only what changed', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.receive('<11>Nov 15 12:00:00 nas-01 smartd[812]: /dev/sda FAILED', NAS);
  await world.hub.flush();
  await world.addAll();
  const ids = sourceIds(world.gladys, NAS);
  assert.equal(state(world, ids.feature('last_message')), 'smartd: /dev/sda FAILED');
  assert.equal(state(world, ids.feature('last_severity')), 'Error');
  assert.equal(state(world, ids.feature('errors_hour')), 1);
  assert.equal(state(world, ids.feature('last_seen')), '15/11 12:00');

  const count = world.fake.states.length;
  assert.equal(await world.hub.flush(), 0, 'nothing changed');
  world.advance(30_000);
  world.receive('<14>Nov 15 12:00:30 nas-01 smbd[1]: hello', NAS);
  assert.equal(await world.hub.flush(), 2, 'last message and severity, same minute');
  assert.equal(world.fake.states.length, count + 2);

  // The error leaves the one-hour window.
  world.advance(60 * 60_000);
  await world.hub.flush();
  assert.equal(state(world, ids.feature('errors_hour')), 0);

  // Heartbeat: an unchanged value is sent again after 12 h.
  world.advance(12 * 3600_000);
  assert.equal(await world.hub.flush(), 4);
});

test('onDeviceCreated sends every state again', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.receive('<14>hello', NAS);
  await world.hub.flush();
  await world.addAll();
  const count = world.fake.states.length;
  await world.fake.deviceUpdated(world.fake.discoveredDevices[0]);
  assert.equal(world.fake.states.length, count + 4);
});

test('at most statesPerFlush states per round, the least recently published first', async (t) => {
  const world = await createWorld({ timings: { statesPerFlush: 6 } });
  t.after(() => world.app.stop());
  for (let i = 1; i <= 5; i += 1) {
    world.receive(`<14>sender ${i}`, `198.51.100.${i}`);
  }
  await world.hub.flush();
  for (const device of world.fake.discoveredDevices) {
    world.gladys.devices.push(device);
  }
  const rounds = [];
  for (let i = 0; i < 4; i += 1) {
    rounds.push(await world.hub.flush());
  }
  assert.deepEqual(rounds, [6, 6, 6, 2]);
});

test('rules: counters in the rules device and the "rule matches" trigger', async (t) => {
  const world = await createWorld({ config: RULES });
  t.after(() => world.app.stop());
  const rules = world.fake.discoveredDevices.find(
    (d) => d.external_id === rulesIds(world.gladys).device,
  );
  assert.deepEqual(
    rules.features.map((f) => f.name),
    ['Power cut', 'Disk failure'],
  );
  world.receive('<161>Nov 15 12:00:02 nas-01 upsmon[912]: UPS ups@localhost on battery', NAS);
  world.receive('<3>Nov 15 12:00:03 nas-01 kernel: ata2.00: failed command', NAS);
  world.receive('<3>Nov 15 12:00:03 other kernel: ata2.00: failed command', '192.0.2.99');
  world.receive('<4>Nov 15 12:00:03 nas-01 kernel: ata2.00: failed command (warning only)', NAS);
  const matched = events(world, TRIGGERS.RULE_MATCHED);
  assert.deepEqual(
    matched.map((e) => [e.rule, e.rule_name, e.source]),
    [
      ['rule_1', 'Power cut', 'nas-01'],
      ['rule_2', 'Disk failure', 'nas-01'],
    ],
  );
  assert.equal(matched[0].device, sourceIds(world.gladys, NAS).device);
  assert.equal(matched[0].app, 'upsmon');
  assert.equal(matched[0].severity_label, 'Alert');

  await world.addAll();
  const ids = rulesIds(world.gladys);
  assert.equal(state(world, ids.feature('rule_1')), 1);
  assert.equal(state(world, ids.feature('rule_2')), 1);
});

test('scene events have a cooldown per sender, and a budget per minute', async (t) => {
  const world = await createWorld({ config: RULES, timings: { eventsPerMinute: 5 } });
  t.after(() => world.app.stop());
  world.receive('<14>on battery', NAS); // new_source + rule_1
  world.receive('<14>on battery', NAS); // cooldown
  world.advance(10_000);
  world.receive('<14>on battery', NAS); // rule_1 again
  assert.equal(events(world, TRIGGERS.RULE_MATCHED).length, 2);
  // Over the budget: new senders are counted, not announced.
  for (let i = 1; i <= 5; i += 1) {
    world.receive('<14>hello', `198.51.100.${i}`);
  }
  assert.equal(world.fake.sceneEvents.length, 5);
  world.advance(60_000);
  world.receive('<14>on battery', NAS);
  assert.equal(world.fake.sceneEvents.length, 6);
});

test('"a severe message arrives": warning or worse, with the severity as a filter', async (t) => {
  const world = await createWorld({ config: { language: 'fr' } });
  t.after(() => world.app.stop());
  world.receive('<14>info: not severe', NAS);
  world.receive('<12>warning one', NAS);
  world.receive('<12>warning two (cooldown)', NAS);
  world.receive('<10>critical one', NAS);
  const severe = events(world, TRIGGERS.SEVERE_MESSAGE);
  assert.deepEqual(
    severe.map((e) => [e.severity, e.severity_label, e.message]),
    [
      ['warning', 'Avertissement', 'warning one'],
      ['crit', 'Critique', 'critical one'],
    ],
  );
});

test('behind a trusted relay, the senders are told apart by their host name', async (t) => {
  const world = await createWorld({
    config: { relays: '192.0.2.2', rule_1_pattern: 'on battery', rule_1_sources: 'ups-box' },
  });
  t.after(() => world.app.stop());
  world.receive('<161>Nov 15 12:00:02 ups-box upsd[9]: on battery', '192.0.2.2');
  world.receive('<30>Nov 15 12:00:02 isp-box dhcpd: lease', '192.0.2.2');
  world.receive('<30>no host name through the relay', '192.0.2.2');
  world.receive('<30>Nov 15 12:00:02 direct-box app: hello', NAS);
  await world.hub.flush();
  assert.deepEqual(
    world.fake.discoveredDevices.map((d) => [d.name, d.external_id.split(':').at(-1)]),
    [
      ['Syslog rules', 'all'],
      ['ups-box', 'host-ups-box'],
      ['isp-box', 'host-isp-box'],
      ['192.0.2.2', '192-0-2-2'],
      ['direct-box', '192-0-2-10'],
    ],
  );
  const [matched] = events(world, TRIGGERS.RULE_MATCHED);
  assert.equal(matched.source, 'ups-box');
  assert.equal(matched.device, sourceIds(world.gladys, 'host:ups-box').device);
  assert.equal(world.link.configs.at(-1).relays, '192.0.2.2');
});

test('the allowed senders are enforced, and a typo is reported', async (t) => {
  const world = await createWorld({ config: { allowed_sources: '192.0.2.0/28, 192.0.2.300' } });
  t.after(() => world.app.stop());
  world.receive('<14>allowed', NAS);
  world.receive('<14>refused', '198.51.100.7');
  await world.hub.flush();
  assert.deepEqual(
    world.fake.discoveredDevices.map((d) => d.params[0].value),
    [NAS],
  );
  assert.deepEqual(world.link.configs.at(-1), {
    allow: '192.0.2.0/28, 192.0.2.300',
    relays: '',
    rate: 20,
  });
  await world.hub.updateStatus();
  const status = world.fake.connectionStatus;
  assert.equal(status.connected, false);
  assert.match(status.message.en, /192\.0\.2\.300/);
  assert.deepEqual(Object.keys(status.message), ['en', 'fr', 'de', 'es']);
});

test('an invalid regular expression is reported in the connection status', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await world.fake.configUpdated({ language: 'en', rule_3_pattern: '/([/' });
  const status = world.fake.connectionStatus;
  assert.equal(status.connected, false);
  assert.equal(status.message.fr, 'Expression régulière invalide dans la règle 3.');
});

test('the receiver unreachable: status red, the sub-container started again', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.link.connected = false;
  for (let failures = 1; failures <= 4; failures += 1) {
    await world.hub.onLinkDown({ wasConnected: failures === 1, failures });
  }
  assert.equal(world.fake.connectionStatus.connected, false);
  const starts = world.fake.requests.filter(
    (r) => r.method === 'POST' && r.path === '/container/receiver/start',
  );
  assert.equal(starts.length, 1, 'once per 5 minutes at most');
  world.link.connected = true;
  await world.hub.onLinkUp();
  assert.equal(world.fake.connectionStatus.connected, true);
});

test('"forget the senders not added" clears Discovery, keeps the added ones', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.receive('<14>a', NAS);
  world.receive('<14>b', ROUTER);
  await world.hub.flush();
  await world.fake.deviceCreated(world.fake.discoveredDevices[0]);
  const ack = await world.fake.action('forget_senders', {});
  assert.equal(ack.success, true);
  assert.equal(ack.data.message.en, '1 sender(s) not added to Gladys forgotten.');
  assert.deepEqual(
    world.fake.discoveredDevices.map((d) => d.params[0].value),
    [NAS],
  );
});

test('the widget: errors of the hour, last severe messages, Clear', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.receive('<11>Nov 15 12:00:00 nas-01 smartd[812]: /dev/sda FAILED', NAS);
  world.receive('<12>dnsmasq[3]: a warning', ROUTER);
  await world.hub.flush();
  await world.fake.deviceCreated({ ...world.fake.discoveredDevices[0], name: 'Garage NAS' });

  let ack = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'fr' });
  assert.equal(ack.success, true, ack.error);
  let content = ack.data.content;
  assert.deepEqual(validateWidgetContent(content).errors ?? [], []);
  assert.equal(content.components[0].value, 1);
  const list = content.components.find((c) => c.type === 'card-list');
  assert.deepEqual(
    list.items.map((i) => [i.title, i.subtitle, i.badge.text]),
    [['smartd: /dev/sda FAILED', 'Garage NAS · 12:00', 'Erreur']],
    'error or worse by default, the name given in Gladys',
  );

  ack = await world.fake.widgetGet(WIDGET_KEY, {
    settings: { min_severity: 'warning', sources: [sourceIds(world.gladys, ROUTER).device] },
  });
  assert.deepEqual(
    ack.data.content.components.find((c) => c.type === 'card-list').items.map((i) => i.title),
    ['dnsmasq: a warning'],
    'only the chosen sender, from warnings',
  );

  ack = await world.fake.widgetAction(WIDGET_KEY, 'clear');
  assert.equal(ack.success, true, ack.error);
  ack = await world.fake.widgetGet(WIDGET_KEY, { settings: { show_count: false } });
  content = ack.data.content;
  assert.deepEqual(
    content.components.map((c) => c.type),
    ['text'],
  );
  assert.equal(world.fake.widgetRefreshes.length > 0, true);
  assert.ok(T0);
});

async function captureLogs(t, level, fn) {
  const lines = [];
  const write = (chunk) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  };
  const before = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const stdout = t.mock.method(process.stdout, 'write', write);
  const stderr = t.mock.method(process.stderr, 'write', write);
  try {
    await fn();
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
    process.env.LOG_LEVEL = before;
  }
  return lines;
}

test('messages received and states published write nothing at the info level', async (t) => {
  const world = await createWorld({ config: RULES });
  t.after(() => world.app.stop());
  world.receive('<14>first', NAS);
  await world.hub.flush();
  await world.addAll();
  const sent = world.fake.states.length;
  const lines = await captureLogs(t, 'info', async () => {
    for (let i = 0; i < 20; i += 1) {
      world.advance(20_000);
      world.receive(`<${i % 2 ? 11 : 14}>message ${i} on battery`, NAS);
      await world.hub.flush();
    }
  });
  assert.ok(world.fake.states.length > sent, 'states were published');
  assert.deepEqual(lines, []);
});
