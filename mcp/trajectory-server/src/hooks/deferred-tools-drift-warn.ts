/**
 * SessionStart hook (GH 1692), the port of
 * scripts/hooks/deferred-tools-drift-warn.sh (#98): when a dist/tools/*.js on
 * disk is newer than this session's own trajectory-server child, a Tier 2
 * restart note. The child is the trajectory-server whose ppid chain holds
 * the nearest Claude Code ancestor of this process (ps and pgrep, as the .sh
 * walks it). Test overrides: TMB_MCP_PID_OVERRIDE, TMB_MCP_START_OVERRIDE,
 * TMB_TOOL_DIR_OVERRIDE, TMB_DRIFT_SELF_PID. It never denies.
 *
 * Divergences: the .sh needs jq to print the note (it exits 127 without);
 * this gate needs no jq, and compares mtimes in place of a mktemp reference
 * file, so an unwritable TMPDIR no longer silences it.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOW, type SyncGate } from './gate.js';
import { stripTrailingNewlines } from './lib/db.js';
import { commandOnPath } from './lib/host.js';
import { jqCompact } from './lib/jq.js';
import { installRoot, posixDirname } from './lib/project-env.js';

export const GATE_NAME = 'deferred-tools-drift-warn';

const ANCESTRY_GUARD = 40;
const SERVER_PATTERN = 'trajectory-server/dist/index.js';
const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);
/**
 * An arithmetic error in the .sh abandons its start-time block; the unset
 * start then fails the reference date, so the hook exits 0 with no output.
 */
class ArithError extends Error {}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.stdout ?? '';
}

/** bash's integer test operand: blanks, a sign and decimal digits within 64 bits, else null. */
export function testInt(text: string): bigint | null {
  const m = /^[ \t\n]*([-+]?[0-9]+)[ \t\n]*$/.exec(text);
  if (m === null) return null;
  const v = BigInt(m[1]);
  return v > INT64_MAX || v < INT64_MIN ? null : v;
}

/** `[ -n "$pid" ] && [ "$pid" -gt 1 ]`. */
function walkable(pid: string): boolean {
  const v = testInt(pid);
  return pid !== '' && v !== null && v > 1n;
}

/** is_cc_cmd: `claude`, `claude *`, `*\/claude`, `*\/claude *`. */
export function isCcCommand(cmd: string): boolean {
  return /^(?:claude|claude .*|.*\/claude|.*\/claude .*)$/s.test(cmd);
}

function procPpid(pid: string, env: NodeJS.ProcessEnv): string {
  return stripTrailingNewlines(run('ps', ['-o', 'ppid=', '-p', pid], env).replaceAll(' ', ''));
}

function procCmd(pid: string, env: NodeJS.ProcessEnv): string {
  return stripTrailingNewlines(run('ps', ['-o', 'command=', '-p', pid], env));
}

function nearestCcAncestor(start: string, env: NodeJS.ProcessEnv): string {
  let pid = start;
  let guard = 0;
  while (walkable(pid)) {
    guard += 1;
    if (guard > ANCESTRY_GUARD) break;
    if (isCcCommand(procCmd(pid, env))) return pid;
    pid = procPpid(pid, env);
  }
  return '';
}

function chainContains(start: string, target: string, env: NodeJS.ProcessEnv): boolean {
  if (target === '') return false;
  let pid = start;
  let guard = 0;
  while (walkable(pid)) {
    guard += 1;
    if (guard > ANCESTRY_GUARD) break;
    if (pid === target) return true;
    pid = procPpid(pid, env);
  }
  return false;
}

function resolveOwnServer(env: NodeJS.ProcessEnv): string {
  const ownCc = nearestCcAncestor(env.TMB_DRIFT_SELF_PID || String(process.pid), env);
  if (ownCc === '') return '';
  for (const line of run('pgrep', ['-f', SERVER_PATTERN], env).split('\n')) {
    const pid = line.trim();
    if (pid === '' || pid === ownCc) continue;
    if (chainContains(pid, ownCc, env)) return pid;
  }
  return '';
}

/** `$(( 10#<part> ))` of an etime field. */
function base10(part: string): bigint {
  if (!/^[0-9]+$/.test(part)) throw new ArithError(part);
  return BigInt(part);
}

/** `$(( <digits> ))`: a leading 0 reads octal. */
function arithDigits(text: string): bigint {
  if (text.length > 1 && text.startsWith('0')) {
    if (!/^[0-7]+$/.test(text)) throw new ArithError(text);
    return BigInt(`0o${text}`);
  }
  return BigInt(text);
}

/** Seconds of a ps etime `[DD-][HH:]MM:SS`, as the .sh splits it. */
export function etimeSeconds(raw: string): bigint {
  const dash = raw.indexOf('-');
  const days = dash < 0 ? '0' : raw.slice(0, dash);
  const rest = dash < 0 ? raw : raw.slice(dash + 1);
  const head = (s: string): string => (s.includes(':') ? s.slice(0, s.indexOf(':')) : s);
  const tail = (s: string): string => (s.includes(':') ? s.slice(s.indexOf(':') + 1) : s);
  if ((rest.match(/:/g) ?? []).length === 2) {
    const rest2 = tail(rest);
    return base10(days) * 86400n + base10(head(rest)) * 3600n + base10(head(rest2)) * 60n + base10(tail(rest2));
  }
  return base10(days) * 86400n + base10(head(rest)) * 60n + base10(tail(rest));
}

function serverStart(pid: string, env: NodeJS.ProcessEnv): bigint | null {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const etimes = run('ps', ['-o', 'etimes=', '-p', pid], env).replaceAll(' ', '').replace(/\n+$/, '');
  let start: bigint;
  if (etimes !== '' && /^[0-9]+$/.test(etimes)) {
    start = now - arithDigits(etimes);
  } else {
    const raw = run('ps', ['-o', 'etime=', '-p', pid], env).replaceAll(' ', '').replace(/\n+$/, '');
    if (raw === '') return null;
    const elapsed = etimeSeconds(raw);
    if (elapsed < 0n) return null;
    start = now - elapsed;
  }
  return start > 0n ? start : null;
}

/** `date -j -r <start>`'s operand: strtoq base 0 (sign, 0x hex, 0 octal, decimal). */
export function epochOperand(text: string): bigint | null {
  const m = /^[ \t\n\v\f\r]*([-+]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.exec(text);
  if (m === null) return null;
  const digits = m[2];
  const v = /^0[xX]/.test(digits) ? BigInt(digits) : digits.length > 1 && digits.startsWith('0') ? BigInt(`0o${digits}`) : BigInt(digits);
  return m[1] === '-' ? -v : v;
}

/** The ns mtime `touch -t` gives the reference file for <start>, null when date or touch fails. */
function referenceNs(start: bigint): bigint | null {
  const year = new Date(Number(start) * 1000).getFullYear();
  if (!Number.isFinite(year) || year < 1970 || year > 9999) return null;
  return start * 1_000_000_000n;
}

/** `find <dir> -name '*.js' -newer <ref>`: every path, the start included, without following links. */
export function newerJs(dir: string, refNs: bigint): number {
  let count = 0;
  const visit = (path: string, name: string): void => {
    let st;
    try {
      st = lstatSync(path, { bigint: true });
    } catch {
      return;
    }
    if (name.endsWith('.js') && st.mtimeNs > refNs) count += 1;
    if (!st.isDirectory()) return;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const child of names) visit(`${path}/${child}`, child);
  };
  visit(dir, dir.replace(/\/+$/, '').slice(dir.replace(/\/+$/, '').lastIndexOf('/') + 1) || dir);
  return count;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pluginRoot(): string {
  return installRoot(posixDirname(fileURLToPath(import.meta.url))) ?? '';
}

export function driftContext(count: number, pid: string): string {
  return `[tmb deferred-tools drift] ${count} MCP tool source file(s) on disk are newer than the running trajectory-server child (PID ${pid}). CC's deferred-tools registry is session-scoped and only a new session replays tool discovery. Workaround (Tier 2): fully quit and relaunch Claude Code to bind the new tools. See #98.`;
}

export const deferredToolsDriftWarn: SyncGate = (_payload, env) => {
  let pid = env.TMB_MCP_PID_OVERRIDE ?? '';
  if (pid === '') {
    if (!commandOnPath('pgrep', env)) return ALLOW;
    pid = resolveOwnServer(env);
    if (pid === '') return ALLOW;
  }
  const toolDir = env.TMB_TOOL_DIR_OVERRIDE || `${pluginRoot()}/mcp/trajectory-server/dist/tools`;
  if (!isDir(toolDir)) return ALLOW;
  let start: bigint | null;
  const override = env.TMB_MCP_START_OVERRIDE ?? '';
  if (override !== '') {
    start = epochOperand(override);
  } else {
    try {
      start = serverStart(pid, env);
    } catch (e) {
      if (e instanceof ArithError) return ALLOW;
      throw e;
    }
  }
  if (start === null) return ALLOW;
  const ref = referenceNs(start);
  if (ref === null) return ALLOW;
  const count = newerJs(toolDir, ref);
  if (count === 0) return ALLOW;
  return {
    stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: driftContext(count, pid) } })}\n`,
    code: 0,
  };
};
