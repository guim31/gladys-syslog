// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `severe_messages`.
//
// The use case: a glance at the wall tablet tells whether a box, a NAS or a
// server complained lately, and what it said. So the widget shows the number
// of errors of the last hour, then the last severe messages — newest first,
// the sender and the time under the text, the severity as a colored badge,
// the full message on tap — and a button to clear the list once read.
//
// Settings: the senders (devices added to Gladys, empty: all), the minimum
// severity shown, and a switch for each optional block (the counter, the
// Clear button).
//
// Budget (8 components, 2 texts): one tile, one text when the list is empty,
// one card list (8 rows), one button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { parseSourceDeviceId } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { SEVERITIES, SEVERITY } from './syslog/parse.js';
import { SEVERITY_TEXT, formatClock, formatTime, pick } from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ CLEAR: 'clear' });
export const WIDGET_SEVERITIES = ['warning', 'err', 'crit'];
export const MAX_ROWS = 8;

export const TEXT = {
  errors: {
    en: 'Errors, last hour',
    fr: 'Erreurs, dernière heure',
    de: 'Fehler, letzte Stunde',
    es: 'Errores, última hora',
  },
  empty: {
    en: 'No severe message since the last clear.',
    fr: 'Aucun message grave depuis le dernier effacement.',
    de: 'Keine schwere Meldung seit dem letzten Leeren.',
    es: 'Ningún mensaje grave desde el último borrado.',
  },
  clear: { en: 'Clear', fr: 'Effacer', de: 'Leeren', es: 'Borrar' },
  cleared: {
    en: 'List cleared: only new messages will show.',
    fr: 'Liste effacée : seuls les nouveaux messages s’afficheront.',
    de: 'Liste geleert: Nur neue Meldungen werden angezeigt.',
    es: 'Lista borrada: solo se mostrarán los mensajes nuevos.',
  },
};

const BADGE_COLOR = {
  emerg: WIDGET_COLORS.DANGER,
  alert: WIDGET_COLORS.DANGER,
  crit: WIDGET_COLORS.DANGER,
  err: WIDGET_COLORS.DANGER,
  warning: WIDGET_COLORS.WARNING,
};

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The ids of the senders chosen in the settings, null for all. */
function chosenIds(hub, settings) {
  const chosen = [settings?.sources ?? []]
    .flat()
    .map((id) => parseSourceDeviceId(hub.gladys, id, hub.sources))
    .filter(Boolean);
  return chosen.length ? new Set(chosen) : null;
}

async function get(hub, { settings = {}, language = 'en' }) {
  const severity = WIDGET_SEVERITIES.includes(settings.min_severity)
    ? settings.min_severity
    : 'err';
  const ids = chosenIds(hub, settings);
  const messages = hub.severeMessages({ maxSeverity: SEVERITY[severity], ids });
  const now = hub.now();
  const components = [];

  if (settings.show_count !== false) {
    const errors = [...hub.sources.values()]
      .filter((source) => !ids || ids.has(source.id))
      .reduce((total, source) => total + source.errors.count(now), 0);
    components.push({
      type: 'value',
      value: errors,
      label: pick(TEXT.errors, language),
      icon: 'alert-triangle',
      color: errors > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    });
  }

  if (messages.length === 0) {
    components.push({ type: 'text', variant: 'body', text: pick(TEXT.empty, language) });
  } else {
    components.push({
      type: 'card-list',
      display: 'list',
      items: messages.slice(0, MAX_ROWS).map((message) => {
        const source = hub.sources.get(message.sourceId);
        const name = source ? hub.displayName(source) : message.ip;
        const level = SEVERITIES[message.severity];
        const line = message.app ? `${message.app}: ${message.text}` : message.text;
        return {
          title: fit(line, 60),
          subtitle: fit(`${name} · ${formatClock(message.receivedAt)}`, 60),
          badge: {
            text: pick(SEVERITY_TEXT[level], language).slice(0, 16),
            color: BADGE_COLOR[level],
          },
          description: fit(
            `${line}\n\n${name} (${message.ip}) · ${formatTime(message.receivedAt, language)}`,
            2000,
          ),
        };
      }),
    });
  }

  if (settings.show_clear !== false && messages.length > 0) {
    components.push({
      type: 'button',
      label: pick(TEXT.clear, language),
      icon: 'check-circle',
      style: 'secondary',
      action: { key: ACTIONS.CLEAR },
    });
  }

  return { ttl_seconds: 60, components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.CLEAR) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  hub.clearSevere();
  return { message: TEXT.cleared };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
