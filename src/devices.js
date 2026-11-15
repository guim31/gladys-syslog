// -----------------------------------------------------------------------------
// Gladys devices, proposed in the Discovery tab (the user adds the ones to
// follow, nothing is created on their behalf):
//
//   - one device per sender, identified by its IP address (what Gladys sees
//     of it; the host name in the messages is free text a sender chooses),
//     or by its host name when it comes through a trusted relay; named after
//     its host name when it sends one:
//       last_message   text/text                "app: text" of the last message
//       last_severity  text/text                its severity, in the language
//                                               of the configuration
//       errors_hour    counter-sensor/integer   messages "error" or more severe
//                                               in the last 60 minutes
//       last_seen      text/text                day/month hours:minutes
//
//   - one "Syslog rules" device, one feature per configured rule:
//       rule_<n>       counter-sensor/integer   matching messages in the last
//                                               60 minutes
//
// Published with should_poll: false: the states are pushed when messages
// arrive (src/hub.js).
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

export const SOURCE_TYPE = 'source';
export const RULES_TYPE = 'rules';
export const RULES_ID = 'all';
export const MODEL = 'Syslog';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  LAST_MESSAGE: 'last_message',
  LAST_SEVERITY: 'last_severity',
  ERRORS_HOUR: 'errors_hour',
  LAST_SEEN: 'last_seen',
});

export const ruleKey = (slot) => `rule_${slot}`;

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.LAST_MESSAGE]: 'Last message',
    [FEATURE_KEYS.LAST_SEVERITY]: 'Last severity',
    [FEATURE_KEYS.ERRORS_HOUR]: 'Errors in the last hour',
    [FEATURE_KEYS.LAST_SEEN]: 'Last seen',
    rules: 'Syslog rules',
  },
  fr: {
    [FEATURE_KEYS.LAST_MESSAGE]: 'Dernier message',
    [FEATURE_KEYS.LAST_SEVERITY]: 'Dernière sévérité',
    [FEATURE_KEYS.ERRORS_HOUR]: 'Erreurs sur la dernière heure',
    [FEATURE_KEYS.LAST_SEEN]: 'Vu pour la dernière fois',
    rules: 'Règles syslog',
  },
  de: {
    [FEATURE_KEYS.LAST_MESSAGE]: 'Letzte Meldung',
    [FEATURE_KEYS.LAST_SEVERITY]: 'Letzter Schweregrad',
    [FEATURE_KEYS.ERRORS_HOUR]: 'Fehler in der letzten Stunde',
    [FEATURE_KEYS.LAST_SEEN]: 'Zuletzt gesehen',
    rules: 'Syslog-Regeln',
  },
  es: {
    [FEATURE_KEYS.LAST_MESSAGE]: 'Último mensaje',
    [FEATURE_KEYS.LAST_SEVERITY]: 'Última gravedad',
    [FEATURE_KEYS.ERRORS_HOUR]: 'Errores en la última hora',
    [FEATURE_KEYS.LAST_SEEN]: 'Visto por última vez',
    rules: 'Reglas syslog',
  },
};

// Display bound of the counters (the core never applies it on write): the
// receiver accepts 500 messages a second at most, 1.8 million an hour.
export const MAX_COUNT = 2_000_000;
// Longest text published in a text feature.
export const MAX_STATE_TEXT = 250;

/**
 * The platform id of a sender: `192.0.2.10` → `192-0-2-10`, `fd00::1` →
 * `fd00--1`, `host:nas-01` (behind a relay) → `host-nas-01` (never an IP:
 * IPv4 has no letter, IPv6 no `h`).
 */
export const sourceKey = (id) => id.toLowerCase().replace(/[^a-z0-9]/g, '-');

export const sourceIds = (gladys, id) => gladys.externalIds(SOURCE_TYPE, sourceKey(id));
export const rulesIds = (gladys) => gladys.externalIds(RULES_TYPE, RULES_ID);

/** The id of the known sender whose device external id this is, null otherwise. */
export function parseSourceDeviceId(gladys, externalId, sources) {
  if (typeof externalId !== 'string') {
    return null;
  }
  for (const id of sources.keys()) {
    if (sourceIds(gladys, id).device === externalId) {
      return id;
    }
  }
  return null;
}

const sensor = (name, externalId, category, type, extra) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  ...extra,
});

const text = (name, externalId) =>
  sensor(name, externalId, DEVICE_FEATURE_CATEGORIES.TEXT, DEVICE_FEATURE_TYPES.TEXT.TEXT, {
    keep_history: false,
    min: 0,
    max: 0,
  });

const counter = (name, externalId) =>
  sensor(
    name,
    externalId,
    DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    { keep_history: true, min: 0, max: MAX_COUNT },
  );

/** The discovery payload of a sender. */
export function buildSourceDevice(gladys, source, language = 'en') {
  const ids = sourceIds(gladys, source.id);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: (source.hostname || source.ip).slice(0, 255),
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [{ name: 'IP', value: source.ip }],
    features: [
      text(names[FEATURE_KEYS.LAST_MESSAGE], ids.feature(FEATURE_KEYS.LAST_MESSAGE)),
      text(names[FEATURE_KEYS.LAST_SEVERITY], ids.feature(FEATURE_KEYS.LAST_SEVERITY)),
      counter(names[FEATURE_KEYS.ERRORS_HOUR], ids.feature(FEATURE_KEYS.ERRORS_HOUR)),
      text(names[FEATURE_KEYS.LAST_SEEN], ids.feature(FEATURE_KEYS.LAST_SEEN)),
    ],
  };
}

/** The discovery payload of the rules, null without any rule. */
export function buildRulesDevice(gladys, rules, language = 'en') {
  if (rules.length === 0) {
    return null;
  }
  const ids = rulesIds(gladys);
  const seen = new Set();
  return {
    name: (NAMES[language] ?? NAMES.en).rules,
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [],
    features: rules.map((rule) => {
      // Two rules of the same name: the second gets its number, the names of a
      // device must be distinct.
      let name = rule.name;
      if (seen.has(name.toLowerCase())) {
        name = `${name} (#${rule.slot})`;
      }
      seen.add(name.toLowerCase());
      return counter(name, ids.feature(ruleKey(rule.slot)));
    }),
  };
}
