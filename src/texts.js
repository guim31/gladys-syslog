// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, severities, action messages, dates. Four languages, the
// four of the Gladys interface; German says "du", Spanish "usted".
// test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

export const pick = (text, language) => text[language] ?? text.en;

export const SEVERITY_TEXT = {
  emerg: { en: 'Emergency', fr: 'Urgence', de: 'Notfall', es: 'Emergencia' },
  alert: { en: 'Alert', fr: 'Alerte', de: 'Alarm', es: 'Alerta' },
  crit: { en: 'Critical', fr: 'Critique', de: 'Kritisch', es: 'Crítico' },
  err: { en: 'Error', fr: 'Erreur', de: 'Fehler', es: 'Error' },
  warning: { en: 'Warning', fr: 'Avertissement', de: 'Warnung', es: 'Advertencia' },
  notice: { en: 'Notice', fr: 'Notification', de: 'Hinweis', es: 'Aviso' },
  info: { en: 'Info', fr: 'Information', de: 'Info', es: 'Información' },
  debug: { en: 'Debug', fr: 'Débogage', de: 'Debug', es: 'Depuración' },
};

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  receiverDown: {
    en: 'The syslog receiver is not running: restart the integration.',
    fr: "Le récepteur syslog ne tourne pas : redémarrez l'intégration.",
    de: 'Der Syslog-Empfänger läuft nicht: Starte die Integration neu.',
    es: 'El receptor syslog no está en marcha: reinicie la integración.',
  },
  invalidRules: {
    en: (slots) => `Invalid regular expression in rule ${slots}.`,
    fr: (slots) => `Expression régulière invalide dans la règle ${slots}.`,
    de: (slots) => `Ungültiger regulärer Ausdruck in Regel ${slots}.`,
    es: (slots) => `Expresión regular no válida en la regla ${slots}.`,
  },
  invalidSources: {
    en: (entries) => `Allowed senders not understood: ${entries}.`,
    fr: (entries) => `Émetteurs autorisés incompris : ${entries}.`,
    de: (entries) => `Erlaubte Absender nicht verstanden: ${entries}.`,
    es: (entries) => `Emisores permitidos no válidos: ${entries}.`,
  },
};

export const ACTION_TEXT = {
  forgotten: {
    en: (n) => `${n} sender(s) not added to Gladys forgotten.`,
    fr: (n) => `${n} émetteur(s) non ajouté(s) à Gladys oublié(s).`,
    de: (n) => `${n} nicht zu Gladys hinzugefügte(r) Absender vergessen.`,
    es: (n) => `${n} emisor(es) no añadido(s) a Gladys olvidado(s).`,
  },
};

/** Resolves a table of functions into a multi-language object. */
export const render = (table, ...args) =>
  Object.fromEntries(Object.entries(table).map(([lang, fn]) => [lang, fn(...args)]));

const DATE_FORMAT = {
  en: (d, m, time) => `${d}/${m} ${time}`,
  fr: (d, m, time) => `${d}/${m} ${time}`,
  de: (d, m, time) => `${d}.${m}. ${time}`,
  es: (d, m, time) => `${d}/${m} ${time}`,
};

/** `15/11 12:34` in the time zone of Gladys (TZ, set by the supervisor). */
export function formatTime(ms, language, timeZone = process.env.TZ || undefined) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return (DATE_FORMAT[language] ?? DATE_FORMAT.en)(
    parts.day,
    parts.month,
    `${parts.hour}:${parts.minute}`,
  );
}

/** `12:34` in the time zone of Gladys. */
export function formatClock(ms, timeZone = process.env.TZ || undefined) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}
