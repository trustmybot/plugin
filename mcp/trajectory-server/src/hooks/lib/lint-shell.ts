/**
 * The shell idioms the lint hooks are built from (GH 1692), as macOS runs
 * them: `jq -r 'a // b // ""'` captured by `$( )`, `echo "$x" | grep -E`
 * line by line, and the POSIX classes grep and awk read in the hook's locale.
 */
import { existsSync } from 'node:fs';
import { jqCompact, jsonValues } from './jq.js';
import { ctypeUtf8, jqRawText } from './project-env.js';

export class JqError extends Error {}

export type JqFilter = (value: unknown) => unknown;

export function jqIndex(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new JqError(`Cannot index ${typeof value} with "${key}"`);
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : null;
}

export function jqPath(...keys: string[]): JqFilter {
  return (value) => keys.reduce<unknown>((v, key) => jqIndex(v, key), value);
}

export function jqTruthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

/** jq's text: a lone surrogate (from a `\ud800` escape) is U+FFFD. */
export function wellFormed(text: string): string {
  return text.replace(/\p{Cs}/gu, '�');
}

/** `$( ... )`: NUL bytes dropped, trailing newlines stripped. */
export function shellCapture(text: string): string {
  return text.replace(/\0/g, '').replace(/\n+$/, '');
}

/** `$(echo "$INPUT" | jq -r f)`: one line per value of the stream, none for a value `f` errors on. */
export function jqRawLines(text: string, filter: JqFilter): string {
  const lines: string[] = [];
  for (const value of jsonValues(text)) {
    try {
      lines.push(wellFormed(jqRawText(filter(value))));
    } catch (e) {
      if (!(e instanceof JqError)) throw e;
    }
  }
  return shellCapture(lines.join('\n'));
}

/**
 * `$(echo "$INPUT" | jq -r 'f1 // f2 // … // ""')`: a value whose filters
 * error prints nothing (jq 1.7's `//` does not catch them), one with no
 * truthy result prints "".
 */
export function jqRawOr(text: string, filters: readonly JqFilter[]): string {
  return jqRawLines(text, (value) => {
    for (const f of filters) {
      const v = f(value);
      if (jqTruthy(v)) return v;
    }
    return '';
  });
}

/** jq's `join("\n")` over an array: null is "", numbers and booleans their JSON, anything else an error. */
export function jqJoinLines(items: readonly unknown[]): string {
  return items
    .map((v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
      throw new JqError('cannot be added');
    })
    .join('\n');
}

/** `.[]?`: an array's elements, an object's values, nothing for any other value. */
export function jqEachOptional(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.values(value);
  return [];
}

const LOCALE_CATEGORIES = ['LC_COLLATE', 'LC_CTYPE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME'] as const;

function localeLoads(name: string, category: string): boolean {
  if (name === 'C' || name === 'POSIX') return true;
  return !name.includes('/') && existsSync(`/usr/share/locale/${name}/${category}`);
}

/**
 * Whether macOS grep matches by UTF-8 character: its setlocale(LC_ALL, "")
 * must load every category (bare UTF-8 has an LC_CTYPE only, so grep stays
 * in C) and the ctype must be a UTF-8 one.
 */
export function grepMultibyte(env: NodeJS.ProcessEnv): boolean {
  const name = (category: string): string => env.LC_ALL || env[category] || env.LANG || 'C';
  if (!LOCALE_CATEGORIES.every((c) => localeLoads(name(c), c))) return false;
  return /(^|\.)utf-?8$/i.test(name('LC_CTYPE'));
}

const ASCII_SPACE = ' \\t\\n\\v\\f\\r';
const UNICODE_SPACE = '\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

/** The chars of grep's `[:space:]`, for use inside a `u`-flag regex class. */
export function grepSpace(multibyte: boolean): string {
  return multibyte ? ASCII_SPACE + UNICODE_SPACE : ASCII_SPACE;
}

/** The chars of grep's `[:alnum:]` (macOS's tables: letters and decimal digits), for a `u`-flag regex class. */
export function grepAlnum(multibyte: boolean): string {
  return multibyte ? '\\p{L}\\p{Nd}' : 'A-Za-z0-9';
}

/** The chars of awk's `[:space:]`: macOS awk adds U+00A0 under a UTF-8 ctype. */
export function awkSpace(env: NodeJS.ProcessEnv): string {
  return ctypeUtf8(env) ? `${ASCII_SPACE}\\u00a0` : ASCII_SPACE;
}

/** `echo "$text" | grep -E <re> >/dev/null`: whether any line of <text> matches. */
export function anyLine(text: string, re: RegExp): boolean {
  return text.split('\n').some((line) => re.test(line));
}

/** The `jq -nc --arg ctx … '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $ctx}}'` line. */
export function preToolContext(ctx: string): string {
  return `${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: wellFormed(ctx) } })}\n`;
}
