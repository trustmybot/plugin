/**
 * Suite-slot lock (GH 2092): a per-user, machine-wide cap on how many full
 * test suites run at once, so suites from parallel worktrees queue instead of
 * stacking up. test-run.ts and the swe-verification-gate take a slot around a
 * command isFullSuite() accepts; a targeted command runs straight away.
 *
 * Root: /tmp/claude-<uid>/tmb-suite-lock, or TMB_SUITE_LOCK_DIR; a dir that is
 * a symlink or owned by another user (containment-guard's harnessTmp rule)
 * makes the lock fail soft: the suite runs unlocked with one stderr warning.
 * Slots slot-0..slot-(N-1), N = TMB_TEST_SUITE_SLOTS (default 1), are mkdir'd
 * dirs holding a `holder` JSON {pid, pgid, worktree, command, started}. A
 * holder whose pid is dead is reclaimed under the slot-<i>.reclaim mkdir mutex
 * after a re-read; a slot with no holder file is live for its first 10 s. The
 * holder exports TMB_SUITE_LOCK_HELD=<slot> to its children, and an acquirer
 * that finds it pointing at a live holder's slot skips the lock.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SUITE_LOCK_POLL_MS = 500;
export const SUITE_LOCK_NOTICE_MS = 60_000;
export const SUITE_LOCK_STALE_MS = 10_000;
export const SUITE_LOCK_HELD_ENV = 'TMB_SUITE_LOCK_HELD';

export interface SlotHolder {
  pid: number;
  pgid: number | null;
  worktree: string;
  command: string;
  started: string;
}

export type SlotResult =
  | { kind: 'held'; slot: string; release: () => void }
  | { kind: 'nested'; slot: string }
  | { kind: 'unlocked' }
  | { kind: 'busy'; holder: SlotHolder | null; waitedS: number };

export interface AcquireOptions {
  command: string;
  worktree: string;
  env: NodeJS.ProcessEnv;
  maxWaitS?: number;
  stderr?: (text: string) => void;
}

const SHELL_SEPARATORS = /&&|\|\||[;|&\n]/;
const PACKAGE_TEST = /^(?:(?:bun|pnpm|npm) run test|npm test|pnpm test)(?:\s|$)/;
const NODE_VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--conditions',
  '-C',
  '--env-file',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-concurrency',
  '--test-shard',
  '--test-timeout',
]);

function unquote(token: string): string {
  return token.replace(/^(['"])(.*)\1$/, '$2');
}

function commandWords(segment: string): string[] {
  const words = segment.trim().split(/\s+/).filter((w) => w !== '').map(unquote);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i] === 'env')) i++;
  return words.slice(i);
}

function nodeFullSuite(words: string[]): boolean {
  if (!/(?:^|\/)node$/.test(words[0] ?? '') || !words.includes('--test')) return false;
  const files: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (NODE_VALUE_FLAGS.has(w)) i++;
    else if (!w.startsWith('-')) files.push(w);
  }
  return files.length === 0 || files.some((f) => /[*?[]/.test(f));
}

/** True for a command that runs a whole test suite: bun/npm/pnpm run test, npm/pnpm test, tests/run-all.sh, or node --test with a glob or no file. */
export function isFullSuite(command: string): boolean {
  return command.split(SHELL_SEPARATORS).some((segment) => {
    const words = commandWords(segment);
    if (words.length === 0) return false;
    if (PACKAGE_TEST.test(words.join(' '))) return true;
    if (words.some((w) => /(?:^|\/)tests\/run-all\.sh$/.test(w))) return true;
    return nodeFullSuite(words);
  });
}

/** TMB_TEST_SUITE_SLOTS as a positive integer, else 1. */
export function suiteSlots(env: NodeJS.ProcessEnv): number {
  const raw = env.TMB_TEST_SUITE_SLOTS ?? '';
  return /^[1-9][0-9]{0,2}$/.test(raw) ? Number(raw) : 1;
}

/** <dir>, created when absent, when it is a real dir (not a link) this user owns; null otherwise. */
function ownedDir(dir: string, recursive: boolean): string | null {
  try {
    mkdirSync(dir, { recursive, mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null;
  }
  try {
    const st = lstatSync(dir);
    const uid = process.geteuid?.();
    return st.isDirectory() && !st.isSymbolicLink() && (uid === undefined || st.uid === uid) ? dir : null;
  } catch {
    return null;
  }
}

/** The lock root, or null when it is unusable. */
export function suiteLockRoot(env: NodeJS.ProcessEnv): string | null {
  const override = env.TMB_SUITE_LOCK_DIR ?? '';
  if (override !== '') return ownedDir(override, true);
  const uid = process.geteuid?.();
  if (uid === undefined) return null;
  const base = ownedDir(`/tmp/claude-${uid}`, false);
  return base === null ? null : ownedDir(join(base, 'tmb-suite-lock'), false);
}

let warnedUnusable = false;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readHolderText(slot: string): string | null {
  try {
    return readFileSync(join(slot, 'holder'), 'utf8');
  } catch {
    return null;
  }
}

function parseHolder(text: string | null): SlotHolder | null {
  if (text === null) return null;
  try {
    const h = JSON.parse(text) as Partial<SlotHolder>;
    if (typeof h.pid !== 'number' || !Number.isInteger(h.pid) || h.pid <= 0) return null;
    return {
      pid: h.pid,
      pgid: typeof h.pgid === 'number' ? h.pgid : null,
      worktree: typeof h.worktree === 'string' ? h.worktree : '',
      command: typeof h.command === 'string' ? h.command : '',
      started: typeof h.started === 'string' ? h.started : '',
    };
  } catch {
    return null;
  }
}

export function readHolder(slot: string): SlotHolder | null {
  return parseHolder(readHolderText(slot));
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** A slot is stale when its holder pid is dead, or it has had no readable holder for 10 s. */
function stale(slot: string): boolean {
  const holder = readHolder(slot);
  if (holder !== null) return !pidAlive(holder.pid);
  const mtime = mtimeMs(slot);
  return mtime !== null && Date.now() - mtime > SUITE_LOCK_STALE_MS;
}

function tryMkdir(dir: string): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Removes a stale slot under its reclaim mutex, re-checking it there so a live holder's slot stays. */
function reclaim(slot: string): void {
  const mutex = `${slot}.reclaim`;
  if (!tryMkdir(mutex)) {
    const mtime = mtimeMs(mutex);
    if (mtime !== null && Date.now() - mtime > SUITE_LOCK_STALE_MS) rmSync(mutex, { recursive: true, force: true });
    return;
  }
  try {
    if (stale(slot)) rmSync(slot, { recursive: true, force: true });
  } finally {
    rmSync(mutex, { recursive: true, force: true });
  }
}

function processGroup(): number | null {
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const pgid = (r.stdout ?? '').trim();
  return /^[0-9]+$/.test(pgid) ? Number(pgid) : null;
}

function claim(slot: string, opts: AcquireOptions, pgid: number | null): () => void {
  const text = `${JSON.stringify({ pid: process.pid, pgid, worktree: opts.worktree, command: opts.command, started: new Date().toISOString() })}\n`;
  try {
    writeFileSync(join(slot, 'holder.tmp'), text);
    renameSync(join(slot, 'holder.tmp'), join(slot, 'holder'));
  } catch {
    /* a holder-less slot stays live for SUITE_LOCK_STALE_MS */
  }
  return () => {
    if (readHolderText(slot) === text) rmSync(slot, { recursive: true, force: true });
  };
}

function ageS(holder: SlotHolder | null): number {
  const started = holder === null ? NaN : Date.parse(holder.started);
  return Number.isNaN(started) ? 0 : Math.max(0, Math.round((Date.now() - started) / 1000));
}

/** The longest-held live slot's holder, for the waiting line and the busy result. */
function oldestHolder(slots: string[]): SlotHolder | null {
  let oldest: SlotHolder | null = null;
  for (const slot of slots) {
    const h = readHolder(slot);
    if (h !== null && (oldest === null || ageS(h) > ageS(oldest))) oldest = h;
  }
  return oldest;
}

export function describeHolder(holder: SlotHolder | null): string {
  if (holder === null) return 'held by an unnamed holder';
  return `held by pid ${holder.pid} (worktree ${holder.worktree || '?'}) for ${ageS(holder)}s`;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Takes a free suite slot, waiting for one (polling every 500 ms, a waiting
 * line on stderr at the start and every 60 s), until <maxWaitS> when given.
 */
export async function acquireSuiteSlot(opts: AcquireOptions): Promise<SlotResult> {
  const stderr = opts.stderr ?? ((text: string) => process.stderr.write(text));
  const inherited = opts.env[SUITE_LOCK_HELD_ENV] ?? '';
  if (inherited !== '') {
    const holder = readHolder(inherited);
    if (holder !== null && pidAlive(holder.pid)) return { kind: 'nested', slot: inherited };
  }
  const root = suiteLockRoot(opts.env);
  if (root === null) {
    if (!warnedUnusable) {
      warnedUnusable = true;
      stderr('suite-lock: the suite-slot lock root is unusable (a symlink, another user\'s dir, or not creatable); running unlocked\n');
    }
    return { kind: 'unlocked' };
  }
  const slots = Array.from({ length: suiteSlots(opts.env) }, (_, i) => join(root, `slot-${i}`));
  const pgid = processGroup();
  const begun = Date.now();
  let noticeAt = 0;
  for (;;) {
    for (const slot of slots) {
      if (tryMkdir(slot)) return { kind: 'held', slot, release: claim(slot, opts, pgid) };
      if (stale(slot)) {
        reclaim(slot);
        if (tryMkdir(slot)) return { kind: 'held', slot, release: claim(slot, opts, pgid) };
      }
    }
    const waited = Date.now() - begun;
    if (opts.maxWaitS !== undefined && waited >= opts.maxWaitS * 1000) {
      return { kind: 'busy', holder: oldestHolder(slots), waitedS: Math.round(waited / 1000) };
    }
    if (waited >= noticeAt) {
      stderr(`waiting for a suite slot: ${describeHolder(oldestHolder(slots))}\n`);
      noticeAt += SUITE_LOCK_NOTICE_MS;
    }
    await sleep(SUITE_LOCK_POLL_MS);
  }
}
