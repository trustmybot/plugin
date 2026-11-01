/**
 * The golden-master recordings of scripts/hooks/<gate>.sh (GH 1692): the bash
 * side of a parity suite reads tests/fixtures/hook-golden/<gate>.json instead
 * of spawning the .sh, so the corpus keeps something to compare the TypeScript
 * gate with once the scripts are deleted.
 *
 * `goldenBash(gate, caseName, locale, roots, live)` returns the recording of
 * that case and locale and never calls `live`; a missing entry throws, naming
 * the gate and case. With TMB_HOOK_GOLDEN=record it calls `live`, writes the
 * entry and returns what a later read will return.
 *
 * A file maps each case to groups of locales that share one value, the key
 * being the sorted locales joined by commas: one group when all locales agree,
 * more only where they differ. `roots` maps tokens to this run's paths; each
 * path is stored as its token, or as `@TOKEN:real@` in its realpath spelling
 * where that differs, so a recording depends on neither the checkout nor the
 * temp dir.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const GOLDEN_DIR = join(PLUGIN_ROOT, 'tests/fixtures/hook-golden');

/** hooks-parity.suite.ts runs some gates a dedicated suite also runs, in another sandbox, so its entries are keyed apart. */
export const GENERIC_CASE_PREFIX = 'generic/';

const LOCK_WAIT_MS = 20;
const LOCK_ATTEMPTS = 3000;

export type GoldenRoots = Readonly<Record<string, string>>;
type GoldenFile = Record<string, Record<string, unknown>>;

export function goldenRoots(sandboxRoots: GoldenRoots): GoldenRoots {
  return { ...sandboxRoots, '@PLUGIN_ROOT@': PLUGIN_ROOT, '@HOME@': homedir(), '@TMPDIR@': tmpdir() };
}

export function isRecording(): boolean {
  const mode = process.env.TMB_HOOK_GOLDEN;
  if (mode !== undefined && mode !== '' && mode !== 'record') throw new Error(`TMB_HOOK_GOLDEN=${mode}: the only mode is record`);
  return mode === 'record';
}

function realOrRaw(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function spellings(roots: GoldenRoots): { token: string; path: string }[] {
  return Object.entries(roots).flatMap(([token, path]) => {
    const real = realOrRaw(path);
    return [
      { token, path },
      { token: token.replace(/@$/, ':real@'), path: real },
    ];
  });
}

function mapStrings(value: unknown, map: (s: string) => string): unknown {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, map));
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value).map(([k, v]) => [map(k), mapStrings(v, map)] as const);
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function plain(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('a recording must be JSON');
  return JSON.parse(text);
}

export function tokenizeRoots(value: unknown, roots: GoldenRoots): unknown {
  const longestFirst = spellings(roots).sort((a, b) => b.path.length - a.path.length);
  const patterns = longestFirst.map(({ token, path }) => ({
    token,
    pattern: new RegExp(`(?<![\\w.-])${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'),
  }));
  return mapStrings(plain(value), (s) => patterns.reduce((text, { token, pattern }) => text.replace(pattern, () => token), s));
}

export function expandRoots(value: unknown, roots: GoldenRoots): unknown {
  const all = spellings(roots);
  return mapStrings(value, (s) => all.reduce((text, { token, path }) => text.replaceAll(token, () => path), s));
}

/** A file's sha256 with the sandbox root masked in both spellings, so the same content hashes the same in another temp dir. */
export function sandboxSha(path: string, root: string): string {
  const text = readFileSync(path, 'latin1').replaceAll(realOrRaw(root), '@SANDBOX@').replaceAll(root, '@SANDBOX@');
  return createHash('sha256').update(text, 'latin1').digest('hex');
}

/**
 * `after` with `<unchanged>` for each file hash the run left as `before` had it.
 * Setup writes clocks, pids and paths into its files, so their hashes differ
 * between recording and comparing; what a gate wrote, moved or removed stays.
 */
export function settledTree(before: Record<string, string | null>, after: Record<string, string | null>): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(after).map(([rel, value]) => [rel, value !== null && /^[0-9a-f]{64}$/.test(value) && before[rel] === value ? '<unchanged>' : value]),
  );
}

function readGolden(file: string): GoldenFile {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as GoldenFile) : {};
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(file: string, body: () => void): void {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (attempt >= LOCK_ATTEMPTS) throw new Error(`could not take ${lock}: remove it if no recording is running`);
      sleepSync(LOCK_WAIT_MS);
    }
  }
  try {
    body();
  } finally {
    rmdirSync(lock);
  }
}

/** The locale groups of a case with one locale's value replaced, regrouped so the same values always give the same key. */
function regrouped(groups: Record<string, unknown>, locale: string, value: unknown): Record<string, unknown> {
  const byLocale = new Map<string, unknown>();
  for (const [key, stored] of Object.entries(groups)) for (const l of key.split(',')) byLocale.set(l, stored);
  byLocale.set(locale, value);
  const byValue = new Map<string, { locales: string[]; value: unknown }>();
  for (const [l, stored] of byLocale) {
    const text = JSON.stringify(stored);
    const group = byValue.get(text) ?? { locales: [], value: stored };
    group.locales.push(l);
    byValue.set(text, group);
  }
  return Object.fromEntries([...byValue.values()].map((g) => [g.locales.sort().join(','), g.value]));
}

function record(file: string, caseName: string, locale: string, value: unknown): void {
  withLock(file, () => {
    const golden = readGolden(file);
    golden[caseName] = regrouped(golden[caseName] ?? {}, locale, value);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(mapStrings(golden, (s) => s), null, 2)}\n`);
    renameSync(tmp, file);
  });
}

function lookup(file: string, gate: string, caseName: string, locale: string): unknown {
  const groups = readGolden(file)[caseName];
  const key = groups && Object.keys(groups).find((k) => k.split(',').includes(locale));
  if (groups === undefined || key === undefined) {
    throw new Error(`no recording for ${gate} / ${caseName} (LC_ALL=${locale}) in ${file}: run the suite with TMB_HOOK_GOLDEN=record`);
  }
  return groups[key];
}

export type GoldenBash = <T>(gate: string, caseName: string, locale: string, roots: GoldenRoots, live: () => T) => T;

export function goldenStore(dir: string): GoldenBash {
  return <T>(gate: string, caseName: string, locale: string, roots: GoldenRoots, live: () => T): T => {
    const file = join(dir, `${gate}.json`);
    if (isRecording()) record(file, caseName, locale, tokenizeRoots(live(), roots));
    return expandRoots(lookup(file, gate, caseName, locale), roots) as T;
  };
}

export const goldenBash = goldenStore(GOLDEN_DIR);

/** A recording as stored, for a suite that only compares with it and never records. */
export function goldenRecording(gate: string, caseName: string, locale: string, roots: GoldenRoots): { code: number; stdout: string } {
  return expandRoots(lookup(join(GOLDEN_DIR, `${gate}.json`), gate, caseName, locale), goldenRoots(roots)) as { code: number; stdout: string };
}

/** Whether a gate has recordings: the set the parity suites select from once the scripts are gone. */
export function hasGolden(gate: string, dir: string = GOLDEN_DIR): boolean {
  return existsSync(join(dir, `${gate}.json`));
}

export function goldenGates(dir: string = GOLDEN_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** Case name to the locales recorded for it. */
export function goldenLocales(gate: string, dir: string = GOLDEN_DIR): Record<string, string[]> {
  const golden = readGolden(join(dir, `${gate}.json`));
  return Object.fromEntries(Object.entries(golden).map(([caseName, groups]) => [caseName, Object.keys(groups).flatMap((k) => k.split(',')).sort()]));
}
