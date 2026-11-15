// -----------------------------------------------------------------------------
// The syslog receiver: runs in the `receiver` sub-container (manifest
// `containers`), the only kind of container Gladys publishes ports for. It
// listens for syslog over UDP and TCP, parses each message, applies the list
// of allowed sources and the rate limits, and streams the messages to the main
// container over a private link (one JSON object per line, TCP, on the private
// network of the integration — never published on the host).
//
// Nothing is written to disk: while the main container is not connected, the
// last `bufferSize` messages wait in memory, older ones are dropped.
//
// Link protocol:
//   main → receiver   {"type":"config","allow":"192.0.2.0/24","relays":"","rate":20}
//   receiver → main   {"type":"message", ...parseMessage()}
//                     {"type":"stats","refused":{ip:n},"limited":{ip:n},
//                      "oversized":n,"dropped":n}   (every 10 s, when non-zero)
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import net from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';
import { TcpFramer } from './syslog/framing.js';
import { RateLimiter, normalizeIp, parseAllowList } from './syslog/limits.js';
import { parseMessage } from './syslog/parse.js';

const logger = createLogger({ name: 'syslog-receiver' });

export const SYSLOG_PORT = 5514;
export const LINK_PORT = 5515;
export const DEFAULT_RATE = 20;

const MAX_TCP_CLIENTS = 64;
// One sender cannot take every TCP slot.
const MAX_TCP_CLIENTS_PER_IP = 8;
const TCP_IDLE_MS = 10 * 60 * 1000;
// A connection that has sent nothing yet is closed sooner.
const TCP_SILENT_MS = 60 * 1000;
// Beyond this many bytes waiting on the link, messages are dropped rather than
// queued: the main container is not keeping up.
const LINK_HIGH_WATER = 1024 * 1024;
const STATS_MS = 10_000;

export class Receiver {
  constructor({
    syslogPort = SYSLOG_PORT,
    linkPort = LINK_PORT,
    host = '0.0.0.0',
    bufferSize = 500,
    totalRate = 500,
    now = () => Date.now(),
  } = {}) {
    this.options = { syslogPort, linkPort, host };
    this.bufferSize = bufferSize;
    this.now = now;
    this.allow = parseAllowList('');
    this.relays = parseAllowList('none');
    this.limiter = new RateLimiter({ perSource: DEFAULT_RATE, total: totalRate, now });
    this.buffer = [];
    this.link = null;
    this.tcpClients = new Set();
    this.resetStats();
  }

  resetStats() {
    this.stats = { refused: {}, limited: {}, oversized: 0, dropped: 0 };
  }

  get statsEmpty() {
    const { refused, limited, oversized, dropped } = this.stats;
    return !Object.keys(refused).length && !Object.keys(limited).length && !oversized && !dropped;
  }

  async start() {
    const { syslogPort, linkPort, host } = this.options;
    this.udp = dgram.createSocket({ type: 'udp4', recvBufferSize: 1 << 20 });
    this.udp.on('message', (data, rinfo) => this.receive(data, rinfo.address));
    this.udp.on('error', (err) => logger.error(`UDP socket error: ${err.message}`));
    await new Promise((resolve, reject) => {
      this.udp.once('error', reject);
      this.udp.bind(syslogPort, host, () => {
        this.udp.off('error', reject);
        resolve();
      });
    });

    this.tcp = net.createServer((socket) => this.acceptSyslog(socket));
    await listen(this.tcp, syslogPort, host);
    this.linkServer = net.createServer((socket) => this.acceptLink(socket));
    await listen(this.linkServer, linkPort, host);
    // An accept error (EMFILE…) must not crash the receiver.
    for (const server of [this.tcp, this.linkServer]) {
      server.on('error', (err) => logger.error(`TCP server error: ${err.message}`));
    }

    this.statsTimer = setInterval(() => this.sendStats(), STATS_MS);
    this.statsTimer.unref();
    logger.info(`Listening for syslog on UDP and TCP port ${this.udpPort}`);
  }

  get udpPort() {
    return this.udp.address().port;
  }

  get tcpPort() {
    return this.tcp.address().port;
  }

  get linkPort() {
    return this.linkServer.address().port;
  }

  async stop() {
    clearInterval(this.statsTimer);
    for (const socket of this.tcpClients) {
      socket.destroy();
    }
    this.link?.destroy();
    await Promise.all([
      new Promise((resolve) => (this.udp ? this.udp.close(resolve) : resolve())),
      new Promise((resolve) => (this.tcp ? this.tcp.close(resolve) : resolve())),
      new Promise((resolve) => (this.linkServer ? this.linkServer.close(resolve) : resolve())),
    ]);
  }

  acceptSyslog(socket) {
    if (this.tcpClients.size >= MAX_TCP_CLIENTS) {
      socket.destroy();
      return;
    }
    const ip = normalizeIp(socket.remoteAddress);
    if (!this.allow.test(ip)) {
      this.count('refused', ip);
      socket.destroy();
      return;
    }
    const fromIp = [...this.tcpClients].filter((client) => client.syslogIp === ip).length;
    if (fromIp >= MAX_TCP_CLIENTS_PER_IP) {
      socket.destroy();
      return;
    }
    socket.syslogIp = ip;
    this.tcpClients.add(socket);
    socket.setTimeout(TCP_SILENT_MS, () => socket.destroy());
    socket.once('data', () => socket.setTimeout(TCP_IDLE_MS));
    const framer = new TcpFramer((frame) => this.receive(frame, ip), {
      onOversized: () => {
        this.stats.oversized += 1;
      },
    });
    socket.on('data', (chunk) => framer.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => this.tcpClients.delete(socket));
  }

  /** One message from a sender, UDP datagram or TCP frame. */
  receive(data, address) {
    const ip = normalizeIp(address);
    if (!this.allow.test(ip)) {
      this.count('refused', ip);
      return;
    }
    const allowed = this.relays.test(ip) ? this.limiter.allowTotal() : this.limiter.allow(ip);
    if (!allowed) {
      this.count('limited', ip);
      return;
    }
    const message = parseMessage(data, { ip, receivedAt: this.now() });
    if (message) {
      this.forward(message);
    }
  }

  count(kind, ip) {
    const table = this.stats[kind];
    // Bounded like the rate limiter: a flood of spoofed addresses is one line.
    if (table[ip] !== undefined || Object.keys(table).length < 50) {
      table[ip] = (table[ip] ?? 0) + 1;
    }
  }

  forward(message) {
    const line = `${JSON.stringify({ type: 'message', ...message })}\n`;
    if (this.link && !this.link.destroyed) {
      if (this.link.writableLength > LINK_HIGH_WATER) {
        this.stats.dropped += 1;
        return;
      }
      this.link.write(line);
      return;
    }
    this.buffer.push(line);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
      this.stats.dropped += 1;
    }
  }

  /** Every 10 s when something happened, and once more after: the end of a problem. */
  sendStats() {
    const empty = this.statsEmpty;
    if ((empty && !this.statsSent) || !this.link || this.link.destroyed) {
      return;
    }
    this.link.write(`${JSON.stringify({ type: 'stats', ...this.stats })}\n`);
    this.statsSent = !empty;
    this.resetStats();
  }

  acceptLink(socket) {
    // The main container: one at a time, the newest wins (a restart of the
    // main container leaves its old socket half-open for a while).
    if (this.link && this.link !== socket) {
      this.link.destroy();
    }
    this.link = socket;
    logger.info('Main container connected');
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.on('error', () => {});
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      if (pending.length > 65536) {
        pending = '';
        return;
      }
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        this.command(line);
      }
    });
    socket.on('close', () => {
      if (this.link === socket) {
        this.link = null;
        logger.info('Main container disconnected');
      }
    });
    for (const line of this.buffer.splice(0)) {
      socket.write(line);
    }
  }

  command(line) {
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      return;
    }
    if (command?.type !== 'config') {
      return;
    }
    this.allow = parseAllowList(command.allow);
    this.relays = parseAllowList(command.relays || 'none');
    const rate = Number(command.rate);
    if (Number.isInteger(rate) && rate >= 1 && rate !== this.limiter.perSource) {
      this.limiter.setRate(rate);
    }
    logger.debug(`Configuration received: ${this.allow.count} allowed entries, ${rate} msg/s`);
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
