# Syslog for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that turns Gladys into a **syslog receiver**: routers, NAS, UPS, switches,
firewalls and servers send their logs to Gladys, and Gladys reacts to the
messages that matter. Nothing is archived: it keeps the last message of each
sender, the last severe ones and counters, in memory.

- **Receiver**: UDP and TCP (octet counting and LF framing), RFC 3164 and RFC
  5424 and the usual dialects in between, optional list of allowed senders,
  rate limit per sender and in total, trusted relays (an rsyslog in front of the
  devices that only send to port 514).
- **One device per sender**, found in the Discovery tab: last message, last
  severity, errors in the last hour, last seen.
- **Rules** (up to five): a text or a regular expression, a minimum severity,
  some senders; a counter per rule (matches in the last hour).
- **Scene triggers**: a rule matches, a severe message arrives, a new sender
  appears.
- **Dashboard widget**: errors of the last hour and the last severe messages,
  with a Clear button.
- Texts in English, French, German and Spanish.

Tested with real syslog senders (`logger`, rsyslog 8 as a relay) against the
Docker image of the integration, run with the constraints of the Gladys sandbox;
not yet on a real Gladys instance: feedback welcome on
[the issues](https://github.com/guim31/gladys-syslog/issues).

## Requirements

- Gladys Assistant **5.2.0** or later (sub-container ports shown in the
  configuration screen).
- Devices able to send their logs to a remote syslog server on a configurable
  port, or an rsyslog relay for those stuck on port 514.

## Installation

In Gladys: **Integrations → Install from GitHub**, then
`https://github.com/guim31/gladys-syslog`. The configuration screen shows the
UDP and TCP ports Gladys chose for the receiver; point your devices at them.
Full guide: [docs/en.md](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)).

## How it works

Gladys publishes ports for sub-containers only, never for the main container
of an integration. So the integration runs two containers from the same image:

- `receiver` (manifest `containers`, `src/receiver-main.js`): listens on port
  5514 (UDP and TCP, published on host ports chosen by Gladys), parses the
  messages, applies the allowed senders and the rate limits, and streams the
  messages over the private network of the integration (port 5515, never
  published). While the main container is away, it keeps the last 500 messages
  in memory.
- the main container (`index.js`): connects to `receiver:5515`, keeps the state
  of the senders and the rules, publishes devices, states (every 15 s at most,
  only changes, within the 300 states/minute of the core) and scene events
  (cooldown of 10 s, 120 per minute at most). It starts the receiver again when
  it does not answer (sub-containers have no restart policy).

Only the list of the senders (IP, host name, first and last seen) is written to
`/data`.

## Limits

- The time of a message is its reception time.
- A sender is identified by its IP address (or by its host name behind a
  trusted relay).
- No syslog over TLS. No message archive or search (see Graylog for that).
- 200 senders at most; messages cut at 2,048 characters.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

See [CLAUDE.md](CLAUDE.md) for the project rules and the notes on syslog.

## Credits

- The parsing follows [RFC 3164](https://www.rfc-editor.org/rfc/rfc3164),
  [RFC 5424](https://www.rfc-editor.org/rfc/rfc5424) and
  [RFC 6587](https://www.rfc-editor.org/rfc/rfc6587) (TCP framing); two
  fixtures are the examples of RFC 3164 and RFC 5424. The other fixtures follow
  the formats of rsyslog, OpenWrt, NUT and the Linux kernel.
- Built from the official
  [Gladys integration template](https://github.com/GladysAssistant/integration-template-js)
  and on the architecture of
  [gladys-healthchecks](https://github.com/guim31/gladys-healthchecks).

Not affiliated with any of the vendors whose devices send syslog.

## License

Apache-2.0, see [LICENSE](LICENSE).
