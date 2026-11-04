/**
 * A sandbox for the l3 hook ports (GH 1692): a temp dir with its own HOME and
 * TMPDIR, a child env that inherits no CLAUDE_* / TMB_* variable, the
 * `node dist/hooks.js <gate>` spawn, and the PATH without a command that
 * tests/l3-integration/hooks/fixtures/no-jq-path.sh builds in bash.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { PLUGIN_ROOT } from './hooks-router-table.js';

export { PLUGIN_ROOT };
export const HOOKS_JS = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
export const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export interface Sandbox {
  dir: string;
  home: string;
  tmp: string;
  /** PATH with this node's dir first, HOME and TMPDIR in the sandbox, git config off; nothing else inherited. */
  env: NodeJS.ProcessEnv;
  remove(): void;
}

export function makeSandbox(name: string): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `tmb-${name}.`)));
  const home = join(dir, 'home');
  const tmp = join(dir, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  const env: NodeJS.ProcessEnv = {
    PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    HOME: home,
    TMPDIR: tmp,
    ...GIT_ENV,
  };
  return { dir, home, tmp, env, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface HookRun {
  stdout: string;
  stderr: string;
  status: number | null;
}

export function runGate(gate: string, opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string; hooksJs?: string }): HookRun {
  const r = spawnSync(process.execPath, [opts.hooksJs ?? HOOKS_JS, gate], {
    cwd: opts.cwd,
    input: opts.input ?? '',
    env: opts.env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** <env> without the named keys (an `env -u`). */
export function without(env: NodeJS.ProcessEnv, ...keys: string[]): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of keys) delete out[k];
  return out;
}

/** <path> with <command> gone: each dir holding it becomes <dir>/<n>, linking all its entries but <command>. */
export function noCmdPath(dir: string, command: string, path: string): string {
  let n = 0;
  return path
    .split(delimiter)
    .filter((d) => d !== '')
    .map((d) => {
      if (!existsSync(join(d, command))) return d;
      n += 1;
      const shadow = join(dir, String(n));
      mkdirSync(shadow, { recursive: true });
      for (const entry of readdirSync(d)) if (entry !== command) symlinkSync(join(d, entry), join(shadow, entry));
      return shadow;
    })
    .join(delimiter);
}

/** Every JSON value in <text>, one per line or spread over several (a `jq` read of the stream). */
export function jsonValues(text: string): unknown[] {
  const out: unknown[] = [];
  let pending = '';
  for (const line of text.split('\n')) {
    pending = pending === '' ? line : `${pending}\n${line}`;
    if (pending.trim() === '') {
      pending = '';
      continue;
    }
    try {
      out.push(JSON.parse(pending));
      pending = '';
    } catch {
      /* the value goes on over the next line */
    }
  }
  return out;
}

/** hookSpecificOutput.additionalContext of the first JSON value in <stdout>, '' when there is none. */
export function contextOf(stdout: string): string {
  const v = jsonValues(stdout)[0] as { hookSpecificOutput?: { additionalContext?: unknown } } | undefined;
  const ctx = v?.hookSpecificOutput?.additionalContext;
  return typeof ctx === 'string' ? ctx : '';
}

/** The file's bytes as text, or 'absent' (the bash tests' cksum check). */
export function checksum(path: string): string {
  try {
    return readFileSync(path).toString('base64');
  } catch {
    return 'absent';
  }
}

export const lines = (text: string) => text.split('\n');
export const lineAt = (text: string, n: number) => lines(text)[n - 1] ?? '';
