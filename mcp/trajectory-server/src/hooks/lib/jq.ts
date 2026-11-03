/**
 * The few jq filters the hook libs run on a payload or transcript (GH 1692),
 * with jq 1.7's stream semantics: the input is a sequence of JSON values, a
 * value whose filter errors (indexing a string, an array, a number) is skipped
 * and the next one runs, and a parse error ends the stream after the values
 * before it. Objects keep jq's key order (jq-key-order.ts).
 */
import { isRawJson, keysInOrder, parseKeepingKeyOrder, stringifyInOrder, valueEnd, type JsonReviver } from './jq-key-order.js';
import { jqRawText } from './project-env.js';

/** The JSON values of a jq input stream, up to the first one that fails to parse. */
export function jsonValues(text: string, reviver?: JsonReviver): unknown[] {
  const values: unknown[] = [];
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) return values;
    const end = valueEnd(text, i);
    if (end < 0) return values;
    try {
      values.push(parseKeepingKeyOrder(text.slice(i, end), reviver));
    } catch {
      return values;
    }
    i = end;
  }
}

/**
 * The JSON values of a jq input stream and whether all of it parsed: jq's
 * exit status is 2 when a parse error ends the stream, whatever it printed.
 */
export function jsonStream(text: string): { values: unknown[]; complete: boolean } {
  const values: unknown[] = [];
  let i = 0;
  for (;;) {
    while (i < text.length && /[ \t\n\r]/.test(text[i])) i += 1;
    if (i >= text.length) return { values, complete: true };
    const end = valueEnd(text, i);
    if (end < 0) return { values, complete: false };
    try {
      values.push(parseKeepingKeyOrder(text.slice(i, end)));
    } catch {
      return { values, complete: false };
    }
    i = end;
  }
}

/** `jq -r '.[]'` over every value of <text>: array elements and object values, one rendering per line. */
export function jqRawElements(text: string): string {
  const out: string[] = [];
  for (const value of jsonStream(text).values) {
    if (value === null || typeof value !== 'object') continue;
    for (const v of Array.isArray(value) ? value : keysInOrder(value).map((key) => (value as Record<string, unknown>)[key])) out.push(jqRawText(v));
  }
  return out.join('\n');
}

class JqError extends Error {}

function index(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value) || isRawJson(value)) throw new JqError(`Cannot index ${typeof value}`);
  const v = (value as Record<string, unknown>)[key];
  return v === undefined ? null : v;
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let v = value;
  for (const key of path) v = index(v, key);
  return v;
}

function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false;
}

/**
 * `jq -r '.a.b // .c // empty'` over every value of <text>, as the lines the
 * command prints, joined by newlines (what a `$(...)` capture holds).
 */
export function jqAlternatives(text: string, paths: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const value of jsonValues(text)) {
    try {
      for (const path of paths) {
        const v = getPath(value, path);
        if (truthy(v)) {
          out.push(jqRawText(v));
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof JqError)) throw e;
    }
  }
  return out.join('\n');
}

/**
 * <filter> run on every value of <text>, as jq runs a program: a value the
 * filter cannot index (jqIndex throws) is skipped and the next one runs.
 */
export function jqMap<T>(text: string, filter: (value: unknown) => T, reviver?: JsonReviver): T[] {
  const out: T[] = [];
  for (const value of jsonValues(text, reviver)) {
    try {
      out.push(filter(value));
    } catch (e) {
      if (!(e instanceof JqError)) throw e;
    }
  }
  return out;
}

/** jq's `.<key>`: null on null, an error on anything but an object. */
export function jqIndex(value: unknown, key: string): unknown {
  return index(value, key);
}

/** jq's `<value> // <fallback>`. */
export function jqOr(value: unknown, fallback: unknown): unknown {
  return truthy(value) ? value : fallback;
}

/** `jq -r '.<key> // "<fallback>"'` over every value of <text>, the lines joined by newlines. */
export function jqFieldOr(text: string, key: string, fallback = ''): string {
  return jqMap(text, (value) => jqRawText(jqOr(index(value, key), fallback))).join('\n');
}

/** `jq -r '.message.content // [] | tostring'`: one line per value. */
export function jqContentStrings(text: string): string[] {
  const out: string[] = [];
  for (const value of jsonValues(text)) {
    try {
      const v = getPath(value, ['message', 'content']);
      const content = truthy(v) ? v : [];
      out.push(typeof content === 'string' ? content : stringifyInOrder(content));
    } catch (e) {
      if (!(e instanceof JqError)) throw e;
    }
  }
  return out;
}

/** `jq -c` output of a JSON value: JSON.stringify, with DEL escaped as jq does. */
export function jqCompact(value: unknown): string {
  return stringifyInOrder(value).replace(/\x7f/g, '\\u007f');
}

/**
 * A JSON number literal as jq 1.7 prints it: the decNumber scientific string
 * of the literal, so 1.000 stays 1.000, 1e2 is 1E+2 and -0 stays -0.
 */
export function jqNumberLiteral(source: string): string {
  const m = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!m) return source;
  const [, sign, int, frac = '', exp = '0'] = m;
  const coefficient = `${int}${frac}`.replace(/^0+(?=\d)/, '');
  const e = Number(exp) - frac.length;
  const adjusted = e + coefficient.length - 1;
  if (e <= 0 && adjusted >= -6) {
    if (e === 0) return `${sign}${coefficient}`;
    const point = coefficient.length + e;
    return point > 0
      ? `${sign}${coefficient.slice(0, point)}.${coefficient.slice(point)}`
      : `${sign}0.${'0'.repeat(-point)}${coefficient}`;
  }
  const mantissa = coefficient.length > 1 ? `${coefficient[0]}.${coefficient.slice(1)}` : coefficient;
  return `${sign}${mantissa}E${adjusted >= 0 ? '+' : '-'}${Math.abs(adjusted)}`;
}

const rawJson = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;

/** A reviver keeping each number's literal as jq prints it, for jqCompact. */
export const jqLiteralNumbers: JsonReviver | undefined = rawJson
  ? (_key, value, context) =>
      typeof value === 'number' && typeof context?.source === 'string' ? rawJson(jqNumberLiteral(context.source)) : value
  : undefined;
