// -----------------------------------------------------------------------------
// The heart of the main container: receives the parsed messages from the
// receiver (src/link.js), keeps one small state per sender and per rule,
// publishes the Discovery list, the states and the scene events.
//
// Nothing of the messages is kept but the last one of each sender, the last
// severe ones for the widget (RECENT_SIZE), and per-minute counters for the
// last hour.
//
// The Gladys budgets drive the publishing: the core takes 300 states and 300
// scene events a minute at most, and re-evaluates the scenes at every state.
// So the states are published every 15 s, only when they changed (or once
// every 12 h, the heartbeat), STATES_PER_FLUSH at most per round; the scene
// events have a cooldown per sender and a budget per minute.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  FEATURE_KEYS,
  MAX_STATE_TEXT,
  buildRulesDevice,
  buildSourceDevice,
  ruleKey,
  rulesIds,
  sourceIds,
} from './devices.js';
import { ProblemLog } from './problems.js';
import { matchLine, ruleMatches } from './rules.js';
import { parseAllowList } from './syslog/limits.js';
import { SEVERITIES, SEVERITY } from './syslog/parse.js';
import { ACTION_TEXT, CONNECTION_TEXT, SEVERITY_TEXT, formatTime, pick, render } from './texts.js';

const logger = createLogger({ name: 'syslog' });

export const TRIGGERS = Object.freeze({
  RULE_MATCHED: 'rule_matched',
  SEVERE_MESSAGE: 'severe_message',
  NEW_SOURCE: 'new_source',
});
export const WIDGET_KEY = 'severe_messages';
export const RECEIVER_CONTAINER = 'receiver';

// Severe = warning or worse: the scene trigger and the widget.
export const SEVERE_MAX = SEVERITY.warning;
// Counted in "errors in the last hour": error or worse.
export const ERROR_MAX = SEVERITY.err;

export const MAX_SOURCES = 200;
export const RECENT_SIZE = 100;
const MAX_EVENT_TEXT = 1000;

export const DEFAULT_TIMINGS = {
  flushMs: 15_000,
  heartbeatMs: 12 * 3600 * 1000,
  cooldownMs: 10_000,
  discoveryDelayMs: 2000,
  statesPerFlush: 60,
  eventsPerMinute: 120,
  widgetRefreshMs: 10_000,
  // The receiver unreachable this many times in a row: the status turns red
  // and the sub-container is started again (it has no restart policy).
  restartAfterFailures: 3,
  restartIntervalMs: 5 * 60 * 1000,
};

/** Per-minute counts over the last hour. */
export class HourWindow {
  constructor() {
    this.buckets = new Map();
  }

  add(now) {
    const minute = Math.floor(now / 60_000);
    this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + 1);
  }

  count(now) {
    const oldest = Math.floor(now / 60_000) - 59;
    let total = 0;
    for (const [minute, n] of this.buckets) {
      if (minute < oldest) {
        this.buckets.delete(minute);
      } else {
        total += n;
      }
    }
    return total;
  }
}

export class SyslogHub {
  constructor({ gladys, store, link, now = () => Date.now(), timers = true, timings = {} }) {
    this.gladys = gladys;
    this.store = store;
    this.link = link;
    this.now = now;
    this.timers = timers;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.problems = new ProblemLog(logger);
    this.config = null;
    this.allow = parseAllowList('');
    this.relays = parseAllowList('none');
    /** @type {Map<string, object>} senders by id: the IP, or `host:<name>` behind a relay */
    this.sources = new Map();
    /** @type {Map<number, HourWindow>} matches per rule slot */
    this.ruleWindows = new Map();
    this.recent = [];
    this.clearedAt = 0;
    /** @type {Map<string, { value: string|number, at: number }>} last published state */
    this.published = new Map();
    this.cooldowns = new Map();
    this.events = { minute: 0, count: 0 };
    this.lastWidgetRefresh = 0;
    this.restartAt = 0;
    this.refusedLogged = new Set();
    this.status = null;
  }

  // --- Life cycle ----------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    for (const entry of Array.isArray(saved.sources) ? saved.sources : []) {
      if (typeof entry?.ip === 'string' && this.sources.size < MAX_SOURCES) {
        const id = typeof entry.id === 'string' ? entry.id : entry.ip;
        this.sources.set(id, {
          id,
          ip: entry.ip,
          hostname: typeof entry.hostname === 'string' ? entry.hostname : null,
          firstSeen: Number(entry.firstSeen) || 0,
          lastSeen: Number(entry.lastSeen) || 0,
          last: null,
          errors: new HourWindow(),
        });
      }
    }
    this.applyConfig(config);
    this.link.on('message', (message) => this.handleMessage(message));
    this.link.on('stats', (stats) => this.handleStats(stats));
    this.link.on('up', () => this.onLinkUp());
    this.link.on('down', (info) => this.onLinkDown(info));
    this.link.configure(this.receiverConfig());
    this.link.start();
    await this.publishDiscovery();
    if (this.timers) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => logger.error(`Publishing failed: ${err.message}`));
      }, this.timings.flushMs);
      this.flushTimer.unref?.();
    }
    logger.info(`Syslog hub started, ${this.sources.size} sender(s) known`);
  }

  /** Gladys came back: everything it may have lost is sent again. */
  async resync(config) {
    await this.reconfigure(config);
    this.published.clear();
    this.status = null;
    await this.updateStatus();
    await this.flush();
  }

  async reconfigure(config) {
    this.applyConfig(config);
    this.link.configure(this.receiverConfig());
    await this.publishDiscovery();
    await this.updateStatus();
  }

  applyConfig(config) {
    const previous = this.config;
    this.config = config;
    this.allow = parseAllowList(config.allowedSources);
    // Empty: no relay (an empty allow list would mean "everyone").
    this.relays = parseAllowList(config.relays || 'none');
    if (config.relays && this.relays.invalid.length) {
      logger.warn(`Relays not understood: ${this.relays.invalid.join(', ')}`);
    }
    if (this.allow.invalid.length) {
      logger.warn(`Allowed senders not understood: ${this.allow.invalid.join(', ')}`);
    }
    if (config.invalidRules.length) {
      logger.warn(`Invalid regular expression in rule ${config.invalidRules.join(', ')}`);
    }
    // A rule whose pattern changed starts counting again.
    const before = new Map((previous?.rules ?? []).map((rule) => [rule.slot, rule]));
    for (const slot of [...this.ruleWindows.keys()]) {
      const rule = config.rules.find((r) => r.slot === slot);
      const old = before.get(slot);
      if (!rule || !old || old.pattern !== rule.pattern) {
        this.ruleWindows.delete(slot);
      }
    }
    for (const rule of config.rules) {
      if (!this.ruleWindows.has(rule.slot)) {
        this.ruleWindows.set(rule.slot, new HourWindow());
      }
    }
  }

  receiverConfig() {
    return {
      allow: this.config.allowedSources,
      relays: this.config.relays,
      rate: this.config.rate,
    };
  }

  async stop() {
    clearInterval(this.flushTimer);
    clearTimeout(this.discoveryTimer);
    this.link.stop();
    this.save();
    await this.store.flush();
  }

  // --- The link to the receiver ----------------------------------------------------

  async onLinkUp() {
    this.problems.recover('link', 'Receiver reachable again');
    await this.updateStatus();
  }

  async onLinkDown({ wasConnected, failures, error }) {
    const reason = error?.code ?? error?.message ?? 'closed';
    if (wasConnected) {
      this.problems.fail('link', `Lost the link to the receiver (${reason})`);
    } else {
      logger.debug(`Receiver not reachable (${reason}), attempt ${failures}`);
    }
    if (failures < this.timings.restartAfterFailures) {
      return;
    }
    this.problems.fail('link', 'The receiver does not answer');
    await this.updateStatus();
    const now = this.now();
    if (now - this.restartAt < this.timings.restartIntervalMs) {
      return;
    }
    this.restartAt = now;
    try {
      await this.gladys.startContainer(RECEIVER_CONTAINER);
      logger.info('Receiver container started again');
    } catch (err) {
      logger.warn(`Cannot start the receiver container: ${err.message}`);
    }
  }

  /** Connection status: the receiver reachable, and the configuration understood. */
  async updateStatus() {
    const language = this.config.language;
    let connected = this.link.connected;
    let message;
    if (!connected) {
      message = CONNECTION_TEXT.receiverDown;
    } else if (this.config.invalidRules.length) {
      connected = false;
      message = render(CONNECTION_TEXT.invalidRules, this.config.invalidRules.join(', '));
    } else if (this.allow.invalid.length) {
      connected = false;
      message = render(CONNECTION_TEXT.invalidSources, this.allow.invalid.join(', ').slice(0, 80));
    }
    const key = JSON.stringify([connected, message && pick(message, language)]);
    if (key === this.status) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.status = key;
      this.problems.recover('status');
    } catch (err) {
      this.problems.fail('status', `Connection status refused: ${err.message}`);
    }
  }

  handleStats({ refused = {}, limited = {}, oversized = 0, dropped = 0 }) {
    for (const ip of Object.keys(refused)) {
      if (!this.refusedLogged.has(ip) && this.refusedLogged.size < 50) {
        this.refusedLogged.add(ip);
        logger.info(`Messages refused from ${ip}: not in the allowed senders`);
      }
    }
    const over = Object.keys(limited);
    if (over.length) {
      this.problems.fail('limited', `Rate limit reached, messages dropped from ${over.join(', ')}`);
    } else {
      this.problems.recover('limited', 'Rate limit no longer reached');
    }
    if (oversized) {
      logger.debug(`${oversized} oversized TCP frame(s) skipped`);
    }
    if (dropped) {
      this.problems.fail('dropped', 'Messages dropped: the integration does not keep up');
    } else {
      this.problems.recover('dropped');
    }
  }

  // --- Messages ------------------------------------------------------------------

  handleMessage(message) {
    if (!message || typeof message.ip !== 'string' || !Number.isInteger(message.severity)) {
      return;
    }
    // Messages buffered by the receiver before it got the configuration.
    if (!this.allow.test(message.ip)) {
      return;
    }
    const now = this.now();
    const id = this.sourceIdOf(message);
    let source = this.sources.get(id);
    if (!source) {
      if (this.sources.size >= MAX_SOURCES) {
        this.problems.fail('sources', `More than ${MAX_SOURCES} senders, ${id} ignored`);
        return;
      }
      source = {
        id,
        ip: message.ip,
        hostname: message.hostname,
        firstSeen: now,
        lastSeen: now,
        last: null,
        errors: new HourWindow(),
      };
      this.sources.set(id, source);
      logger.info(`New sender: ${message.hostname ?? message.ip} (${message.ip})`);
      this.save();
      this.scheduleDiscovery();
      this.fire(TRIGGERS.NEW_SOURCE, `new:${id}`, {
        source: message.hostname ?? message.ip,
        ip: message.ip,
      });
    } else if (message.hostname && message.hostname !== source.hostname) {
      source.hostname = message.hostname;
      this.save();
      this.scheduleDiscovery();
    }
    source.ip = message.ip;
    source.lastSeen = now;
    source.last = message;
    if (message.severity <= ERROR_MAX) {
      source.errors.add(now);
    }
    logger.debug(`${message.ip} ${SEVERITIES[message.severity]} ${matchLine(message)}`);

    const ids = sourceIds(this.gladys, id);
    const common = () => ({
      device: ids.device,
      source: this.displayName(source),
      ip: message.ip,
      severity_label: pick(SEVERITY_TEXT[SEVERITIES[message.severity]], this.config.language),
      app: message.app ?? '',
      message: message.text.slice(0, MAX_EVENT_TEXT),
    });

    if (message.severity <= SEVERE_MAX) {
      this.recent.unshift({ ...message, sourceId: id, receivedAt: now });
      this.recent.length = Math.min(this.recent.length, RECENT_SIZE);
      this.fire(TRIGGERS.SEVERE_MESSAGE, `severe:${id}:${message.severity}`, {
        ...common(),
        severity: SEVERITIES[message.severity],
      });
      this.refreshWidget();
    }

    const names = this.namesOf(source);
    for (const rule of this.config.rules) {
      if (ruleMatches(rule, message, names)) {
        this.ruleWindows.get(rule.slot)?.add(now);
        this.fire(TRIGGERS.RULE_MATCHED, `rule:${rule.slot}:${id}`, {
          ...common(),
          rule: ruleKey(rule.slot),
          rule_name: rule.name,
        });
      }
    }
  }

  /**
   * The sender of a message: its IP address, or — for a message forwarded by
   * a trusted relay (an rsyslog in front of devices that only send to port
   * 514) — the host name it carries.
   */
  sourceIdOf(message) {
    return message.hostname && this.relays.test(message.ip)
      ? `host:${message.hostname}`
      : message.ip;
  }

  /** What a rule can name a sender by: IP, host name, name in Gladys. */
  namesOf(source) {
    const names = [source.ip];
    if (source.hostname) {
      names.push(source.hostname, source.hostname.split('.')[0]);
    }
    const device = this.createdDevice(sourceIds(this.gladys, source.id).device);
    if (device?.name) {
      names.push(device.name.toLowerCase());
    }
    return names;
  }

  displayName(source) {
    const device = this.createdDevice(sourceIds(this.gladys, source.id).device);
    return device?.name || source.hostname || source.ip;
  }

  /** Publish a scene event, within the cooldown and the budget per minute. */
  fire(key, cooldownKey, data) {
    const now = this.now();
    const until = this.cooldowns.get(cooldownKey);
    if (until !== undefined && now < until) {
      return;
    }
    const minute = Math.floor(now / 60_000);
    if (this.events.minute !== minute) {
      this.events = { minute, count: 0 };
      this.problems.recover('events', 'Scene events below the budget again');
    }
    if (this.events.count >= this.timings.eventsPerMinute) {
      this.problems.fail(
        'events',
        `More than ${this.timings.eventsPerMinute} scene events a minute, some skipped`,
      );
      return;
    }
    this.events.count += 1;
    this.cooldowns.set(cooldownKey, now + this.timings.cooldownMs);
    if (this.cooldowns.size > 5000) {
      for (const [k, t] of this.cooldowns) {
        if (t <= now) this.cooldowns.delete(k);
      }
    }
    this.gladys.publishSceneEvent(key, data).then(
      () => this.problems.recover(`event:${key}`),
      (err) => this.problems.fail(`event:${key}`, `Scene event ${key} refused: ${err.message}`),
    );
  }

  refreshWidget(force = false) {
    const now = this.now();
    if (!force && now - this.lastWidgetRefresh < this.timings.widgetRefreshMs) {
      return;
    }
    this.lastWidgetRefresh = now;
    try {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    } catch (err) {
      logger.debug(`Widget refresh not sent: ${err.message}`);
    }
  }

  /** The severe messages for the widget, newest first, since the last "Clear". */
  severeMessages({ maxSeverity = SEVERITY.err, ids = null } = {}) {
    return this.recent.filter(
      (message) =>
        message.receivedAt > this.clearedAt &&
        message.severity <= maxSeverity &&
        (!ids || ids.has(message.sourceId)),
    );
  }

  clearSevere() {
    this.clearedAt = this.now();
  }

  // --- Devices ---------------------------------------------------------------------

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((device) => device.external_id === externalId);
  }

  discoveredDevices() {
    const language = this.config.language;
    const devices = [...this.sources.values()]
      .filter((source) => this.allow.test(source.ip))
      .map((source) => buildSourceDevice(this.gladys, source, language));
    const rules = buildRulesDevice(this.gladys, this.config.rules, language);
    return rules ? [rules, ...devices] : devices;
  }

  scheduleDiscovery() {
    if (!this.timers) {
      this.discoveryDue = true;
      return;
    }
    clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => this.publishDiscovery(), this.timings.discoveryDelayMs);
    this.discoveryTimer.unref?.();
  }

  async publishDiscovery() {
    this.discoveryDue = false;
    try {
      await this.gladys.publishDiscoveredDevices(this.discoveredDevices());
      this.problems.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.problems.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab. */
  async rediscover() {
    await this.publishDiscovery();
  }

  /**
   * The user added (or updated) a device: its states sent before were dropped
   * by Gladys, send them all again.
   */
  async onDeviceCreated(device) {
    const prefix = device?.external_id;
    if (typeof prefix === 'string') {
      for (const key of [...this.published.keys()]) {
        if (key.startsWith(`${prefix}:`)) {
          this.published.delete(key);
        }
      }
    }
    await this.flush();
    this.refreshWidget(true);
  }

  /** Forget the senders the user did not add to Gladys (the action of the configuration). */
  async forgetUnadded() {
    let count = 0;
    for (const source of [...this.sources.values()]) {
      if (!this.createdDevice(sourceIds(this.gladys, source.id).device)) {
        this.sources.delete(source.id);
        count += 1;
      }
    }
    logger.info(`${count} sender(s) not added to Gladys forgotten`);
    this.save();
    await this.publishDiscovery();
    return render(ACTION_TEXT.forgotten, count);
  }

  save() {
    this.store.save({
      sources: [...this.sources.values()].map(({ id, ip, hostname, firstSeen, lastSeen }) => ({
        id,
        ip,
        hostname,
        firstSeen,
        lastSeen,
      })),
    });
  }

  // --- States ----------------------------------------------------------------------

  /** Every state of the added devices: `{ id, value, state|text }`. */
  currentStates() {
    const language = this.config.language;
    const now = this.now();
    const states = [];
    const text = (id, value) =>
      states.push({ id, value, text: String(value).slice(0, MAX_STATE_TEXT) || '-' });
    const number = (id, value) => states.push({ id, value, state: value });
    for (const source of this.sources.values()) {
      const ids = sourceIds(this.gladys, source.id);
      if (!this.createdDevice(ids.device)) {
        continue;
      }
      if (source.last) {
        text(ids.feature(FEATURE_KEYS.LAST_MESSAGE), matchLine(source.last));
        text(
          ids.feature(FEATURE_KEYS.LAST_SEVERITY),
          pick(SEVERITY_TEXT[SEVERITIES[source.last.severity]], language),
        );
      }
      number(ids.feature(FEATURE_KEYS.ERRORS_HOUR), source.errors.count(now));
      if (source.lastSeen) {
        text(ids.feature(FEATURE_KEYS.LAST_SEEN), formatTime(source.lastSeen, language));
      }
    }
    const rules = rulesIds(this.gladys);
    if (this.createdDevice(rules.device)) {
      for (const rule of this.config.rules) {
        number(rules.feature(ruleKey(rule.slot)), this.ruleWindows.get(rule.slot).count(now));
      }
    }
    return states;
  }

  /**
   * Publish what changed (and the heartbeat), the least recently published
   * first, STATES_PER_FLUSH at most: the rest waits for the next round.
   */
  async flush() {
    if (this.discoveryDue) {
      await this.publishDiscovery();
    }
    const now = this.now();
    const due = this.currentStates()
      .filter((s) => {
        const last = this.published.get(s.id);
        return !last || last.value !== s.value || now - last.at >= this.timings.heartbeatMs;
      })
      .sort((a, b) => (this.published.get(a.id)?.at ?? 0) - (this.published.get(b.id)?.at ?? 0))
      .slice(0, this.timings.statesPerFlush);
    if (due.length === 0) {
      return 0;
    }
    try {
      await this.gladys.publishStates(
        due.map(({ id, state, text }) => ({
          device_feature_external_id: id,
          ...(text !== undefined ? { text } : { state }),
        })),
      );
      for (const s of due) {
        this.published.set(s.id, { value: s.value, at: now });
      }
      this.problems.recover('states', 'States accepted again');
    } catch (err) {
      this.problems.fail('states', `States refused: ${err.message}`);
    }
    return due.length;
  }
}
