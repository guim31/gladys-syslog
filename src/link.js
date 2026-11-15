// -----------------------------------------------------------------------------
// Main container side of the private link to the receiver (src/receiver.js):
// connects to `receiver:5515` on the private network of the integration (the
// DNS alias of the sub-container), sends the configuration, reads one JSON
// object per line. Reconnects on its own, 1 s then up to 30 s apart.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { LINK_PORT } from './receiver.js';

const MAX_LINE = 64 * 1024;

export class ReceiverLink extends EventEmitter {
  constructor({
    host = process.env.SYSLOG_RECEIVER_HOST || 'receiver',
    port = Number(process.env.SYSLOG_RECEIVER_PORT) || LINK_PORT,
    minDelayMs = 1000,
    maxDelayMs = 30_000,
  } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.delay = minDelayMs;
    this.socket = null;
    this.connected = false;
    this.stopped = true;
    this.config = null;
    this.failures = 0;
  }

  start() {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
  }

  /** The configuration of the receiver, sent now and on every reconnection. */
  configure(config) {
    this.config = config;
    this.send();
  }

  send() {
    if (this.connected && this.config) {
      this.socket.write(`${JSON.stringify({ type: 'config', ...this.config })}\n`);
    }
  }

  connect() {
    if (this.stopped) {
      return;
    }
    const socket = net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    let pending = '';
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30_000);
    socket.on('connect', () => {
      this.connected = true;
      this.failures = 0;
      this.delay = this.minDelayMs;
      this.send();
      this.emit('up');
    });
    socket.on('data', (chunk) => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        this.line(line);
      }
      if (pending.length > MAX_LINE) {
        pending = '';
      }
    });
    socket.on('error', (err) => {
      this.lastError = err;
    });
    socket.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.socket !== socket || this.stopped) {
        return;
      }
      this.failures += 1;
      this.emit('down', { wasConnected, failures: this.failures, error: this.lastError });
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.timer.unref?.();
      this.delay = Math.min(this.delay * 2, this.maxDelayMs);
    });
  }

  line(text) {
    let item;
    try {
      item = JSON.parse(text);
    } catch {
      return;
    }
    if (item?.type === 'message') {
      this.emit('message', item);
    } else if (item?.type === 'stats') {
      this.emit('stats', item);
    }
  }
}
