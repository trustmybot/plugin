/**
 * The few jq filters the hook libs run on a payload or transcript (GH 1692),
 * with jq 1.7's stream semantics: the input is a sequence of JSON values, a
 * value whose filter errors (indexing a string, an array, a number) is skipped
 * and the next one runs, and a parse error ends the stream after the values
 * before it.
 */
import { jqRawText } from './project-env.js';

function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === '\\') i += 2;
      else if (text[i] === '"') return i + 1;
      else i += 1;
    }
    return -1;
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    let i = start;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        const end = valueEnd(text, i);
        if (end < 0) return -1;
        i = end;
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    return -1;
  }
  let i = start;
  while (i < text.length && !/[\s{}[\]",]/.test(text[i])) i += 1;
  return i === start ? -1 : i;
}

/** The JSON values of a jq input stream, up to the first one that fails to parse. */
export function jsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) return values;
    const end = valueEnd(text, i);
    if (end < 0) return values;
    try {
      values.push(JSON.parse(text.slice(i, end)));
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
      values.push(JSON.parse(text.slice(i, end)));
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
    for (const v of Array.isArray(value) ? value : Object.values(value)) out.push(jqRawText(v));
  }
  return out.join('\n');
}

class JqError extends Error {}

function index(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new JqError(`Cannot index ${typeof value}`);
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

/** `jq -r '.message.content // [] | tostring'`: one line per value. */
export function jqContentStrings(text: string): string[] {
  const out: string[] = [];
  for (const value of jsonValues(text)) {
    try {
      const v = getPath(value, ['message', 'content']);
      const content = truthy(v) ? v : [];
      out.push(typeof content === 'string' ? content : JSON.stringify(content));
    } catch (e) {
      if (!(e instanceof JqError)) throw e;
    }
  }
  return out;
}

/** `jq -c` output of a JSON value: JSON.stringify, with DEL escaped as jq does. */
export function jqCompact(value: unknown): string {
  return JSON.stringify(value).replace(/\x7f/g, '\\u007f');
}
