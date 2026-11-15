// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// The receiver settings (allowed sources, rate limit), the language of the
// texts, and five rule slots: name, pattern, minimum severity, sources.
// -----------------------------------------------------------------------------

import { SEVERITY } from './syslog/parse.js';
import { compileRule } from './rules.js';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];
export const RULE_SLOTS = [1, 2, 3, 4, 5];
// "At least as severe as", in the select of each rule; `any` matches debug too.
export const RULE_SEVERITIES = ['any', 'notice', 'warning', 'err', 'crit', 'alert', 'emerg'];

export const DEFAULT_RATE = 20;
export const MIN_RATE = 1;
export const MAX_RATE = 500;

export const DEFAULT_CONFIG = {
  allowed_sources: '',
  relays: '',
  rate_limit: DEFAULT_RATE,
  language: 'fr',
  ...Object.fromEntries(
    RULE_SLOTS.flatMap((n) => [
      [`rule_${n}_name`, ''],
      [`rule_${n}_pattern`, ''],
      [`rule_${n}_severity`, 'any'],
      [`rule_${n}_sources`, ''],
    ]),
  ),
};

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const rate = Number(source.rate_limit);
  const rules = [];
  const invalidRules = [];
  for (const n of RULE_SLOTS) {
    const pattern = text(`rule_${n}_pattern`);
    if (!pattern) {
      continue;
    }
    const severity = RULE_SEVERITIES.includes(source[`rule_${n}_severity`])
      ? source[`rule_${n}_severity`]
      : 'any';
    const rule = compileRule({
      slot: n,
      name: text(`rule_${n}_name`).slice(0, 40),
      pattern,
      maxSeverity: severity === 'any' ? SEVERITY.debug : SEVERITY[severity],
      sources: text(`rule_${n}_sources`),
    });
    if (rule) {
      rules.push(rule);
    } else {
      invalidRules.push(n);
    }
  }
  return {
    allowedSources: text('allowed_sources'),
    relays: text('relays'),
    rate: Number.isInteger(rate) && rate >= MIN_RATE && rate <= MAX_RATE ? rate : DEFAULT_RATE,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
    rules,
    invalidRules,
  };
}
