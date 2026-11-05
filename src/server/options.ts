/**
 * Validation of a squawk's answer options (#168).
 *
 * Options are the creator's answer CHOICES for one item, for example
 * `["Ship it", "Hold", "Ask the vendor"]`. They are not states: the five states
 * in `SQUAWK_STATES` stay the single source of truth, and picking an option
 * resolves the item as `confirmed` with the option's label recorded as `choice`.
 */

import {
  MAX_OPTION_LENGTH,
  MAX_OPTIONS_PER_SQUAWK,
  SQUAWK_STATES,
} from "./types.ts";

/** The input was not a valid option list; `message` says why (it becomes the 400). */
export class OptionsError extends Error {}

/** Characters refused in a label: control characters, and the line and paragraph separators. */
const CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * Validate and normalise an option list: an array of at most
 * {@link MAX_OPTIONS_PER_SQUAWK} strings, each trimmed to 1 through
 * {@link MAX_OPTION_LENGTH} characters, with no control characters, unique
 * ignoring case, and not equal (ignoring case) to a state name. An empty array
 * is no options. Throws {@link OptionsError} with the reason on anything else.
 */
export function validateOptions(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new OptionsError("options must be an array of strings");
  }
  if (input.length > MAX_OPTIONS_PER_SQUAWK) {
    throw new OptionsError(`at most ${MAX_OPTIONS_PER_SQUAWK} options`);
  }
  const states: ReadonlySet<string> = new Set(SQUAWK_STATES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") {
      throw new OptionsError("every option must be a string");
    }
    // Check the raw label: trim() would quietly strip a leading or trailing newline.
    if (CONTROL_CHARS.test(raw)) {
      throw new OptionsError("an option must not contain control characters");
    }
    const label = raw.trim();
    if (label.length === 0) {
      throw new OptionsError("an option must not be empty");
    }
    if (label.length > MAX_OPTION_LENGTH) {
      throw new OptionsError(`an option is at most ${MAX_OPTION_LENGTH} characters`);
    }
    const key = label.toLowerCase();
    if (states.has(key)) {
      throw new OptionsError(`"${label}" is a state name, not an answer option`);
    }
    if (seen.has(key)) {
      throw new OptionsError(`duplicate option "${label}"`);
    }
    seen.add(key);
    out.push(label);
  }
  return out;
}
