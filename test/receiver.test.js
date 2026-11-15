// -----------------------------------------------------------------------------
// The receiver (src/receiver.js) and the link of the main container
// (src/link.js), with real sockets on the loopback interface: UDP and TCP
// syslog in, parsed messages out, the buffer while the main container is
// away, the allowed senders and the rate limit pushed by the configuration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { once } from 'node:events';
import { ReceiverLink } from '../src/link.js';
import { Receiver } from '../src/receiver.js';

process.env.LOG_LEVEL ??= 'silent';

async function startReceiver(options = {}) {
  const receiver = new Receiver({ syslogPort: 0, linkPort: 0, host: '127.0.0.1', ...options });
  await receiver.start();
  return receiver;
}

function connectLink(receiver) {
  const link = new ReceiverLink({ host: '127.0.0.1', port: receiver.linkPort, minDelayMs: 20 });
  const messages = [];
  const stats = [];
  link.on('message', (m) => messages.push(m));
  link.on('stats', (s) => stats.push(s));
  link.start();
  return { link, messages, stats };
}

async function sendUdp(port, line) {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) =>
    socket.send(Buffer.from(line), port, '127.0.0.1', (err) => (err ? reject(err) : resolve())),
  );
  socket.close();
}

async function sendTcp(port, payload) {
  const socket = net.connect({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  socket.end(payload);
  await once(socket, 'close');
}

async function until(predicate, what) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('UDP and TCP messages reach the main container, parsed', async (t) => {
  const receiver = await startReceiver();
  const { link, messages } = connectLink(receiver);
  t.after(async () => {
    link.stop();
    await receiver.stop();
  });
  await once(link, 'up');
  await sendUdp(
    receiver.udpPort,
    '<11>Nov 15 12:00:00 nas-01 smartd[812]: Device: /dev/sda, FAILED SMART self-check',
  );
  const five = '<14>1 2026-11-15T12:00:00Z router dropbear 77 - - Password auth succeeded';
  await sendTcp(receiver.tcpPort, `${Buffer.byteLength(five)} ${five}<13>plain line\n`);
  await until(() => messages.length === 3, 'three messages');
  const byText = Object.fromEntries(messages.map((m) => [m.text, m]));
  assert.equal(byText['Device: /dev/sda, FAILED SMART self-check'].severity, 3);
  assert.equal(byText['Device: /dev/sda, FAILED SMART self-check'].hostname, 'nas-01');
  assert.equal(byText['Password auth succeeded'].app, 'dropbear');
  assert.equal(byText['plain line'].ip, '127.0.0.1');
});

test('messages wait in a small buffer while the main container is away', async (t) => {
  const receiver = await startReceiver({ bufferSize: 3 });
  t.after(() => receiver.stop());
  for (let i = 1; i <= 5; i += 1) {
    await sendUdp(receiver.udpPort, `<13>message ${i}`);
  }
  await until(() => receiver.buffer.length === 3 && receiver.stats.dropped === 2, 'the buffer');
  const { link, messages } = connectLink(receiver);
  t.after(() => link.stop());
  await until(() => messages.length === 3, 'the buffered messages');
  assert.deepEqual(
    messages.map((m) => m.text),
    ['message 3', 'message 4', 'message 5'],
  );
});

test('the configuration refuses senders and limits the rate, reported in the stats', async (t) => {
  const receiver = await startReceiver();
  const { link, messages, stats } = connectLink(receiver);
  t.after(async () => {
    link.stop();
    await receiver.stop();
  });
  link.configure({ allow: '192.0.2.1', rate: 20 });
  await once(link, 'up');
  await until(() => receiver.allow.count === 1, 'the configuration');
  await sendUdp(receiver.udpPort, '<13>refused');
  await sendTcp(receiver.tcpPort, '<13>refused too\n');
  await until(() => receiver.stats.refused['127.0.0.1'] >= 2, 'refusals');

  link.configure({ allow: '127.0.0.0/8', rate: 5 });
  await until(() => receiver.limiter.perSource === 5, 'the new rate');
  const lines = Array.from({ length: 50 }, (_, i) => `<13>burst ${i}\n`).join('');
  await sendTcp(receiver.tcpPort, lines);
  await until(() => messages.length === 10, 'the burst allowance (twice the rate)');
  receiver.sendStats();
  await until(() => stats.length === 1, 'the stats');
  assert.ok(stats[0].limited['127.0.0.1'] >= 40);
  assert.equal(stats[0].refused['127.0.0.1'], 2);
});

test('the link reconnects when the receiver comes back', async (t) => {
  const receiver = await startReceiver();
  const port = receiver.linkPort;
  const { link } = connectLink(receiver);
  t.after(() => link.stop());
  await once(link, 'up');
  const down = once(link, 'down');
  await receiver.stop();
  const [info] = await down;
  assert.equal(info.wasConnected, true);
  const again = new Receiver({ syslogPort: 0, linkPort: port, host: '127.0.0.1' });
  await again.start();
  t.after(() => again.stop());
  await once(link, 'up');
  assert.equal(link.connected, true);
});
