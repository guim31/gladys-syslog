# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Syslog receiver over UDP and TCP (RFC 3164, RFC 5424, octet counting and
  line framing), on ports chosen by Gladys and shown in the configuration.
- Optional list of allowed senders, rate limit per sender, trusted relays.
- One device per sender in the Discovery tab: last message, last severity,
  errors in the last hour, last seen.
- Up to five rules (text or regular expression, minimum severity, senders), a
  counter per rule.
- Scene triggers: a rule matches, a severe message arrives, a new sender
  appears.
- Dashboard widget of the last severe messages, with a Clear button.
- "Forget the senders not added" action.
- English, French, German and Spanish.
