/**
 * `$(printf '%s' "$INPUT" | jq -r <path>)` as the trajectory-gates chain's
 * .sh gates capture payload fields (GH 1692), on jq 1.7's stream: numbers
 * print the literal jq keeps (1.0 stays 1.0, 1e2 is 1E+2), a lone surrogate
 * reads as U+FFFD, a value whose path indexes a non-object prints nothing and
 * the stream ends at the first value that fails to parse.
 */
import { jqCompact, jqLiteralNumbers, jqNumberLiteral, jsonStream, jsonValues } from './jq.js';
import { stringifyInOrder } from './jq-key-order.js';
import { shellCapture, wellFormed } from './lint-shell.js';

export class JqUnindexable extends Error {}

type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

const isRawJson = (value: unknown): boolean =>
  (JSON as unknown as { isRawJSON?: (v: unknown) => boolean }).isRawJSON?.(value) ?? false;

const textReviver: Reviver = function (key, value, context) {
  if (typeof value === 'string') return wellFormed(value);
  return jqLiteralNumbers ? jqLiteralNumbers.call(this, key, value, context) : value;
};

export interface JqInput {
  values: unknown[];
  /** Whether every value parsed; jq exits non-zero when a parse error ends the stream. */
  complete: boolean;
}

/** The payload as the .sh's `$(cat)` holds it, read as jq's value stream. */
export function jqInput(payload: string): JqInput {
  const text = payload.replace(/\0/g, '');
  const stream = jsonStream(text);
  return { values: jsonValues(text, textReviver).slice(0, stream.values.length), complete: stream.complete };
}

/** jq's `.<key>`: null on null, an error on anything but an object. */
export function jqGet(value: unknown, ...keys: string[]): unknown {
  let v = value;
  for (const key of keys) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'object' || Array.isArray(v) || isRawJson(v)) throw new JqUnindexable(`Cannot index with "${key}"`);
    v = Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : null;
  }
  return v ?? null;
}

/** jq's `<value> // <fallback>`. */
export function jqAlt(value: unknown, fallback: unknown): unknown {
  return value !== null && value !== undefined && value !== false ? value : fallback;
}

/** jq's `tostring`: a string as is, anything else its compact JSON. */
export function jqTostring(value: unknown): string {
  return typeof value === 'string' ? value : jqCompact(value);
}

/** What `jq -r` prints for a value: a string raw, anything else indented JSON. */
export function jqRaw(value: unknown): string {
  if (typeof value === 'string') return value;
  return stringifyInOrder(value, 2).replace(/\x7f/g, '\\u007f');
}

/**
 * `$(... | jq -r '.<keys> // ""')`, or `// empty` when `orEmpty`: one line per
 * value of the stream, none for a value the path cannot index.
 */
export function jqCapture(input: JqInput, keys: readonly string[], orEmpty = false): string {
  const lines: string[] = [];
  for (const value of input.values) {
    let v: unknown;
    try {
      v = jqGet(value, ...keys);
    } catch (e) {
      if (e instanceof JqUnindexable) continue;
      throw e;
    }
    const picked = jqAlt(v, orEmpty ? null : '');
    if (picked !== null) lines.push(jqRaw(picked));
  }
  return shellCapture(lines.join('\n'));
}

/** A JSON number of `digits` as `jq --argjson` and `tonumber` print it. */
export function jqNumber(digits: string): unknown {
  const raw = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
  const literal = jqNumberLiteral(digits);
  return raw ? raw(literal) : Number(literal);
}
