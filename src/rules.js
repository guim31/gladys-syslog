// -----------------------------------------------------------------------------
// User rules: "this text (or this regular expression), at least this severe,
// from these senders". Each matching message counts in the rule's sensor and
// fires the `rule_matched` scene trigger.
//
// A pattern is a case-insensitive text to find in the message, or a regular
// expression written between slashes (`/disk \S+ failed/i`). The message is
// matched as `app: text` (the tag of the sender, then the text), so a pattern
// can name the program (`openvpn: .* connected`).
// -----------------------------------------------------------------------------

export const MAX_PATTERN = 200;

/**
 * @returns {{ slot: number, name: string, pattern: string, maxSeverity: number,
 *   sources: string[], test: (line: string) => boolean }|null} null when the
 *   pattern is not a valid regular expression
 */
export function compileRule({ slot, name, pattern, maxSeverity, sources }) {
  const source = pattern.slice(0, MAX_PATTERN);
  let test;
  const regex = source.match(/^\/(.+)\/([imsu]*)$/s);
  if (regex) {
    let compiled;
    try {
      compiled = new RegExp(regex[1], regex[2]);
    } catch {
      return null;
    }
    test = (line) => compiled.test(line);
  } else {
    const needle = source.toLowerCase();
    test = (line) => line.toLowerCase().includes(needle);
  }
  return {
    slot,
    name: name || `#${slot}`,
    pattern: source,
    maxSeverity,
    sources: sources
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((entry) => entry.toLowerCase()),
    test,
  };
}

/** The line a rule is matched against. */
export const matchLine = (message) =>
  message.app ? `${message.app}: ${message.text}` : message.text;

/**
 * @param {object} rule compiled rule
 * @param {object} message parsed message
 * @param {string[]} names what the sender is known as (IP, host names, the
 *   name given in Gladys), lowercase
 */
export function ruleMatches(rule, message, names) {
  if (message.severity > rule.maxSeverity) {
    return false;
  }
  if (rule.sources.length > 0 && !rule.sources.some((entry) => names.includes(entry))) {
    return false;
  }
  return rule.test(matchLine(message));
}
