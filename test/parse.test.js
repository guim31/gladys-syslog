// -----------------------------------------------------------------------------
// Parsing (src/syslog/parse.js), TCP framing (src/syslog/framing.js), allowed
// senders and rate limits (src/syslog/limits.js), rules (src/rules.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeConfig } from '../src/config.js';
import { compileRule, ruleMatches } from '../src/rules.js';
import { TcpFramer } from '../src/syslog/framing.js';
import { RateLimiter, parseAllowList } from '../src/syslog/limits.js';
import { MAX_TEXT, parseMessage } from '../src/syslog/parse.js';

const { messages } = JSON.parse(
  await readFile(new URL('./fixtures/syslog/messages.json', import.meta.url), 'utf8'),
);
const origin = { ip: '192.0.2.10', receivedAt: 1000 };

for (const fixture of messages) {
  test(`parses: ${fixture.sender}`, () => {
    const parsed = parseMessage(fixture.raw, origin);
    for (const [key, value] of Object.entries(fixture.expect)) {
      assert.deepEqual(parsed[key], value, key);
    }
    assert.equal(parsed.ip, '192.0.2.10');
    assert.equal(parsed.receivedAt, 1000);
  });
}

test('parses a Buffer, ignores an empty message, bounds the text', () => {
  assert.equal(parseMessage(Buffer.from('<13>hi'), origin).text, 'hi');
  assert.equal(parseMessage('', origin), null);
  assert.equal(parseMessage('\n', origin), null);
  assert.equal(parseMessage(`<13>${'x'.repeat(10_000)}`, origin).text.length, MAX_TEXT);
});

test('octet-counted and LF-framed TCP streams, split anywhere', () => {
  const a = '<13>1 - host app - - - first';
  const b = '<14>second line';
  const c = '<11>third';
  const stream = Buffer.from(`${Buffer.byteLength(a)} ${a}${b}\n${c}\0\n\n`);
  for (let step = 1; step <= stream.length; step += 1) {
    const frames = [];
    const framer = new TcpFramer((frame) => frames.push(frame.toString()));
    for (let i = 0; i < stream.length; i += step) {
      framer.push(stream.subarray(i, i + step));
    }
    assert.deepEqual(frames, [a, b, c], `chunks of ${step}`);
  }
});

test('an oversized frame is skipped, the next one kept', () => {
  const frames = [];
  let oversized = 0;
  const framer = new TcpFramer((frame) => frames.push(frame.toString()), {
    maxFrame: 32,
    onOversized: () => (oversized += 1),
  });
  framer.push(Buffer.from(`100 ${'x'.repeat(100)}<13>ok\n`));
  framer.push(Buffer.from(`<13>${'y'.repeat(50)}`));
  framer.push(Buffer.from(`${'y'.repeat(50)}\n<13>after\n`));
  assert.deepEqual(frames, ['<13>ok', '<13>after']);
  assert.equal(oversized, 2);
});

test('a line starting with a digit is not taken for a length', () => {
  const frames = [];
  const framer = new TcpFramer((frame) => frames.push(frame.toString()));
  framer.push(Buffer.from('2026-11-15 plain line\n'));
  assert.deepEqual(frames, ['2026-11-15 plain line']);
});

test('allowed senders: addresses, IPv4 ranges, IPv6, mapped IPv4, invalid entries', () => {
  const list = parseAllowList('192.0.2.1, 198.51.100.0/24; 2001:db8::1 nonsense 10.0.0.0/40');
  assert.deepEqual(list.invalid, ['nonsense', '10.0.0.0/40']);
  assert.ok(list.test('192.0.2.1'));
  assert.ok(list.test('::ffff:192.0.2.1'));
  assert.ok(list.test('198.51.100.254'));
  assert.ok(list.test('2001:DB8::1'));
  assert.ok(!list.test('192.0.2.2'));
  assert.ok(!list.test('198.51.101.1'));
  assert.ok(parseAllowList('').test('203.0.113.9'), 'empty: everyone');
  assert.ok(!parseAllowList('typo').test('203.0.113.9'), 'only invalid entries: nobody');
});

test('rate limit: a burst of twice the rate, then the rate, per sender', () => {
  let now = 0;
  const limiter = new RateLimiter({ perSource: 10, total: 1000, now: () => now });
  const accepted = (ip, n) => Array.from({ length: n }, () => limiter.allow(ip)).filter(Boolean);
  assert.equal(accepted('192.0.2.1', 100).length, 20);
  assert.equal(accepted('192.0.2.2', 5).length, 5, 'another sender is not affected');
  now += 1000;
  assert.equal(accepted('192.0.2.1', 100).length, 10);
});

test('rate limit: the total bounds every sender together', () => {
  const limiter = new RateLimiter({ perSource: 100, total: 10, now: () => 0 });
  let accepted = 0;
  for (let i = 0; i < 50; i += 1) {
    accepted += limiter.allow(`192.0.2.${i}`) ? 1 : 0;
  }
  assert.equal(accepted, 20);
});

test('rules: text, regular expression, severity and senders', () => {
  const message = (text, severity = 6, app = 'openvpn') => ({ text, severity, app });
  const text = compileRule({
    slot: 1,
    name: 'VPN',
    pattern: 'Peer Connection',
    maxSeverity: 7,
    sources: '',
  });
  assert.ok(ruleMatches(text, message('client-a peer connection initiated'), []));
  assert.ok(!ruleMatches(text, message('other'), []));

  const regex = compileRule({
    slot: 2,
    name: '',
    pattern: '/^kernel: .*ata\\d/',
    maxSeverity: 3,
    sources: 'NAS-01, 192.0.2.9',
  });
  assert.equal(regex.name, '#2');
  const disk = message('ata2.00: failed command', 3, 'kernel');
  assert.ok(ruleMatches(regex, disk, ['192.0.2.9']));
  assert.ok(ruleMatches(regex, disk, ['192.0.2.10', 'nas-01']));
  assert.ok(!ruleMatches(regex, disk, ['192.0.2.10']), 'another sender');
  assert.ok(!ruleMatches(regex, { ...disk, severity: 4 }, ['192.0.2.9']), 'not severe enough');
  assert.ok(!ruleMatches(regex, { ...disk, app: 'Kernel' }, ['192.0.2.9']), 'regex keeps the case');

  assert.equal(
    compileRule({ slot: 3, name: 'x', pattern: '/([/', maxSeverity: 7, sources: '' }),
    null,
  );
});

test('configuration: defaults, bounds, invalid rules reported', () => {
  const config = normalizeConfig({
    rate_limit: 5000,
    language: 'xx',
    rule_1_pattern: ' on battery ',
    rule_1_severity: 'warning',
    rule_2_pattern: '/(/',
    rule_3_name: 'no pattern',
  });
  assert.equal(config.rate, 20);
  assert.equal(config.language, 'fr');
  assert.deepEqual(
    config.rules.map((r) => [r.slot, r.pattern, r.maxSeverity]),
    [[1, 'on battery', 4]],
  );
  assert.deepEqual(config.invalidRules, [2]);
  assert.deepEqual(normalizeConfig(null).rules, []);
});
