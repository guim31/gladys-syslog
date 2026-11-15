// -----------------------------------------------------------------------------
// Syslog message parsing: RFC 5424 (`<PRI>1 TIMESTAMP HOST APP PROCID MSGID SD
// MSG`) and the many dialects of RFC 3164 (`<PRI>Mmm dd hh:mm:ss HOST TAG:
// MSG`, often without the host, the timestamp, or with an ISO timestamp).
//
// Lenient on purpose: a message is never rejected for its shape. What cannot
// be understood falls back on the RFC 3164 defaults (§4.3.3): facility user,
// severity notice, the whole line as the text. The time is the reception time
// (device clocks are often wrong, and RFC 3164 timestamps carry no year nor
// time zone).
// -----------------------------------------------------------------------------

// Severity codes of RFC 5424, 0 the most severe.
export const SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
export const SEVERITY = Object.freeze(Object.fromEntries(SEVERITIES.map((name, i) => [name, i])));

const FACILITIES = [
  'kern',
  'user',
  'mail',
  'daemon',
  'auth',
  'syslog',
  'lpr',
  'news',
  'uucp',
  'cron',
  'authpriv',
  'ftp',
  'ntp',
  'audit',
  'alert',
  'clock',
  'local0',
  'local1',
  'local2',
  'local3',
  'local4',
  'local5',
  'local6',
  'local7',
];

// Longest text kept per message: enough for any real log line, bounded for
// the rule matching and the memory of the receiver.
export const MAX_TEXT = 2048;

const DEFAULT_PRI = 13; // user.notice
const BSD_TIMESTAMP = /^[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}(?:\.\d+)? /;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\S* /;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253})$|^[0-9a-fA-F:]{2,39}$/;
const TAG = /^([^\s:[\]]{1,48})(?:\[([^\]\s]{1,32})\])?: ?/;

/** Control characters (line breaks included) become spaces. */
// eslint-disable-next-line no-control-regex
const clean = (text) => text.replace(/ *[\u0000-\u001f\u007f]+ */g, ' ').trim();

const nil = (value) => (value === undefined || value === '-' || value === '' ? null : value);

function validHost(value) {
  return value && HOSTNAME.test(value) ? value.toLowerCase() : null;
}

/** Splits the RFC 5424 structured data off the rest of the line. */
function splitStructuredData(rest) {
  if (rest.startsWith('-')) {
    return { sd: null, msg: rest.slice(1) };
  }
  let i = 0;
  while (rest[i] === '[') {
    let inQuotes = false;
    i += 1;
    while (i < rest.length) {
      const c = rest[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ']' && !inQuotes) {
        break;
      }
      i += 1;
    }
    i += 1; // past the closing bracket
  }
  return i > 0 ? { sd: rest.slice(0, i), msg: rest.slice(i) } : null;
}

function parse5424(body) {
  // VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP SD [SP MSG]
  const match = body.match(/^1 (\S+) (\S+) (\S+) (\S+) (\S+) ([\s\S]*)$/);
  if (!match) {
    return null;
  }
  const [, , host, app, procId, msgId, rest] = match;
  const split = splitStructuredData(rest);
  if (!split) {
    return null;
  }
  // The message may start with a UTF-8 byte order mark.
  const msg = split.msg.replace(/^ /, '').replace(/^\uFEFF/, '');
  return {
    format: 'rfc5424',
    hostname: validHost(nil(host)),
    app: nil(app),
    procId: nil(procId),
    msgId: nil(msgId),
    text: msg,
  };
}

function parse3164(body) {
  let rest = body;
  let hostname = null;
  const stamp = rest.match(BSD_TIMESTAMP) ?? rest.match(ISO_TIMESTAMP);
  if (stamp) {
    rest = rest.slice(stamp[0].length);
    // After a timestamp comes the host, unless the next word is already the tag
    // (`Nov 15 12:00:00 dnsmasq[12]: …`, common on routers).
    const word = rest.match(/^(\S+) /);
    if (word && !TAG.test(`${word[1]} `) && !word[1].endsWith(':')) {
      hostname = validHost(word[1]);
      if (hostname) {
        rest = rest.slice(word[0].length);
      }
    }
  }
  let app = null;
  let procId = null;
  const tag = rest.match(TAG);
  if (tag) {
    app = tag[1];
    procId = tag[2] ?? null;
    rest = rest.slice(tag[0].length);
  }
  return { format: 'rfc3164', hostname, app, procId, msgId: null, text: rest };
}

/**
 * @param {string|Buffer} raw one syslog message (one UDP datagram or TCP frame)
 * @param {{ ip: string, receivedAt: number }} origin
 * @returns {{ ip: string, receivedAt: number, facility: string, severity: number,
 *   format: string, hostname: string|null, app: string|null, procId: string|null,
 *   msgId: string|null, text: string }|null} null for an empty message
 */
export function parseMessage(raw, { ip, receivedAt }) {
  let line = (typeof raw === 'string' ? raw : raw.toString('utf8')).replace(/^\uFEFF/, '');
  line = line.replace(/[\r\n\0]+$/, '');
  if (line.trim() === '') {
    return null;
  }
  let pri = DEFAULT_PRI;
  const priMatch = line.match(/^<(\d{1,3})>/);
  if (priMatch && Number(priMatch[1]) <= 191) {
    pri = Number(priMatch[1]);
    line = line.slice(priMatch[0].length);
  }
  const parsed = parse5424(line) ?? parse3164(line);
  const text = clean(parsed.text).slice(0, MAX_TEXT);
  return {
    ip,
    receivedAt,
    facility: FACILITIES[pri >> 3] ?? 'local7',
    severity: pri & 7,
    format: parsed.format,
    hostname: parsed.hostname,
    app: parsed.app ? clean(parsed.app).slice(0, 48) : null,
    procId: parsed.procId,
    msgId: parsed.msgId,
    text: text || '-',
  };
}
