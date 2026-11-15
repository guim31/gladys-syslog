// -----------------------------------------------------------------------------
// What protects Gladys from a sender gone wild, or from a sender it does not
// know: the optional list of allowed sources (IPv4 addresses and ranges, IPv6
// addresses), and token buckets that bound the messages per second, per
// source and in total.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';

/** `::ffff:192.0.2.1` (an IPv4 client on a dual-stack socket) → `192.0.2.1`. */
export function normalizeIp(address) {
  const text = String(address ?? '').toLowerCase();
  return text.startsWith('::ffff:') && isIP(text.slice(7)) === 4 ? text.slice(7) : text;
}

const ipv4ToInt = (ip) => ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);

/**
 * @param {string} raw addresses or IPv4 ranges (CIDR), separated by commas,
 *   semicolons or spaces; empty = every source allowed
 * @returns {{ test: (ip: string) => boolean, any: boolean, invalid: string[],
 *   count: number }}
 */
export function parseAllowList(raw) {
  const entries = String(raw ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean);
  const exact = new Set();
  const ranges = [];
  const invalid = [];
  for (const entry of entries) {
    const [address, bits, extra] = entry.split('/');
    const family = isIP(address);
    if (extra !== undefined || family === 0) {
      invalid.push(entry);
    } else if (bits === undefined) {
      exact.add(normalizeIp(address));
    } else if (family === 4 && /^\d{1,2}$/.test(bits) && Number(bits) <= 32) {
      const size = 2 ** (32 - Number(bits));
      const start = Math.floor(ipv4ToInt(address) / size) * size;
      ranges.push([start, start + size]);
    } else {
      invalid.push(entry);
    }
  }
  const count = exact.size + ranges.length;
  // Entries all invalid: nothing is allowed, rather than everything — a typo
  // must not open the receiver wider than the user wanted.
  const any = entries.length === 0;
  return {
    any,
    invalid,
    count,
    test(ip) {
      if (any) {
        return true;
      }
      const address = normalizeIp(ip);
      if (exact.has(address)) {
        return true;
      }
      if (isIP(address) !== 4) {
        return false;
      }
      const value = ipv4ToInt(address);
      return ranges.some(([start, end]) => value >= start && value < end);
    },
  };
}

export class TokenBucket {
  /**
   * @param {number} rate tokens per second
   * @param {number} burst bucket size
   */
  constructor(rate, burst, now) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }

  take(now) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}

// Sources followed by the rate limiter: beyond, the least recently seen is
// forgotten (a flood of spoofed addresses cannot grow the memory).
const MAX_BUCKETS = 1024;

/** Messages per second per source, and in total. */
export class RateLimiter {
  constructor({ perSource = 20, total = 500, now = () => Date.now() } = {}) {
    this.now = now;
    this.setRate(perSource, total);
  }

  setRate(perSource, total = this.totalRate ?? 500) {
    this.perSource = perSource;
    this.totalRate = total;
    this.buckets = new Map();
    this.total = new TokenBucket(total, total * 2, this.now());
  }

  /** A trusted relay speaks for many senders: only the total applies. */
  allowTotal() {
    return this.total.take(this.now());
  }

  allow(ip) {
    const now = this.now();
    let bucket = this.buckets.get(ip);
    if (bucket) {
      this.buckets.delete(ip); // re-inserted last: the map stays in LRU order
    } else {
      bucket = new TokenBucket(this.perSource, this.perSource * 2, now);
      if (this.buckets.size >= MAX_BUCKETS) {
        this.buckets.delete(this.buckets.keys().next().value);
      }
    }
    this.buckets.set(ip, bucket);
    return bucket.take(now) && this.total.take(now);
  }
}
