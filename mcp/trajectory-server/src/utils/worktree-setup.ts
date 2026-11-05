// A repo opts in to a build step for every worktree TMB makes (GH 2054) with
// <worktree>/.config/tmb/worktree-setup.json: {"version":1,"commands":["..."]}.
// Each command runs in order through `bash -c` in the worktree, stopping at
// the first failure. The file is read from the worktree's own checkout, so its
// commands carry the same trust as verification[]. No file is a no-op.
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKTREE_SETUP_COMMAND_TIMEOUT_MS } from './timeouts.js';

export const WORKTREE_SETUP_FILE = '.config/tmb/worktree-setup.json';

const TAIL_LINES = 20;
const TAIL_CHARS = 4000;
const TIMED_OUT_CODE = 124;
const signals: Readonly<Record<string, number>> = osConstants.signals;

export interface WorktreeSetupCommand {
  command: string;
  exit_code: number;
  timed_out: boolean;
  elapsed_ms: number;
}

export interface WorktreeSetupResult {
  ran: boolean;
  commands: WorktreeSetupCommand[];
  error?: string;
  output_tail?: string;
}

export interface WorktreeSetupOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  totalTimeoutMs?: number;
}

type Parsed = { commands: string[] } | { error: string } | null;

function readSetupFile(worktreePath: string): Parsed {
  let raw: string;
  try {
    raw = readFileSync(join(worktreePath, WORKTREE_SETUP_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { error: `${WORKTREE_SETUP_FILE}: cannot read: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `${WORKTREE_SETUP_FILE}: not valid JSON: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `${WORKTREE_SETUP_FILE}: must be a JSON object {"version":1,"commands":[...]}` };
  }
  const { version, commands } = parsed as { version?: unknown; commands?: unknown };
  if (version !== 1) return { error: `${WORKTREE_SETUP_FILE}: version must be 1, got ${JSON.stringify(version) ?? 'none'}` };
  if (!Array.isArray(commands) || commands.length === 0 || !commands.every((c) => typeof c === 'string' && c.trim() !== '')) {
    return { error: `${WORKTREE_SETUP_FILE}: commands must be a non-empty array of non-empty strings` };
  }
  return { commands: commands as string[] };
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

function tail(text: string): string {
  return text.replace(/\n+$/, '').split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS);
}

function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outPath: string,
): Promise<{ exitCode: number; timedOut: boolean }> {
  return new Promise((done) => {
    const fd = openSync(outPath, 'w');
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ exitCode, timedOut });
    };
    const child = spawn('bash', ['-c', command], { cwd, env: { ...env, PWD: cwd }, stdio: ['ignore', fd, fd], detached: true });
    closeSync(fd);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('error', () => finish(127));
    child.on('exit', (code, signal) => {
      if (timedOut) finish(TIMED_OUT_CODE);
      else finish(code ?? 128 + (signal !== null ? (signals[signal] ?? 0) : 0));
    });
  });
}

/** Runs the worktree's setup commands; never throws. `ran` is false when no command started. */
export async function runWorktreeSetup(worktreePath: string, opts: WorktreeSetupOptions = {}): Promise<WorktreeSetupResult> {
  let parsed: Parsed;
  try {
    parsed = readSetupFile(worktreePath);
  } catch (e) {
    parsed = { error: `${WORKTREE_SETUP_FILE}: ${(e as Error).message}` };
  }
  if (parsed === null) return { ran: false, commands: [] };
  if ('error' in parsed) return { ran: false, commands: [], error: parsed.error };

  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? WORKTREE_SETUP_COMMAND_TIMEOUT_MS;
  const total = opts.totalTimeoutMs;
  const totalStart = Date.now();
  const result: WorktreeSetupResult = { ran: false, commands: [] };
  let scratch: string;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'tmb-worktree-setup-'));
  } catch (e) {
    return { ran: false, commands: [], error: `worktree setup: cannot create a scratch dir: ${(e as Error).message}` };
  }
  try {
    for (const [i, command] of parsed.commands.entries()) {
      const outPath = join(scratch, `out-${i + 1}`);
      const left = total === undefined ? Infinity : total - (Date.now() - totalStart);
      if (left <= 0) {
        result.commands.push({ command, exit_code: TIMED_OUT_CODE, timed_out: true, elapsed_ms: 0 });
        result.error = `worktree setup ran out of its ${seconds(total ?? 0)}s budget before command ${i + 1}/${parsed.commands.length}: ${command}`;
        return result;
      }
      const budgetBound = left < timeoutMs;
      const started = Date.now();
      let run: { exitCode: number; timedOut: boolean };
      try {
        run = await runCommand(command, worktreePath, env, budgetBound ? left : timeoutMs, outPath);
      } catch (e) {
        result.commands.push({ command, exit_code: 127, timed_out: false, elapsed_ms: Date.now() - started });
        result.error = `worktree setup command failed to start: ${command}: ${(e as Error).message}`;
        return result;
      }
      result.ran = true;
      result.commands.push({ command, exit_code: run.exitCode, timed_out: run.timedOut, elapsed_ms: Date.now() - started });
      if (run.exitCode === 0) continue;
      let out = '';
      try {
        out = readFileSync(outPath, 'utf8');
      } catch {
        /* no output file */
      }
      if (!run.timedOut) result.error = `worktree setup command exited ${run.exitCode}: ${command}`;
      else if (budgetBound) result.error = `worktree setup command timed out: its ${seconds(total ?? 0)}s budget ran out: ${command}`;
      else result.error = `worktree setup command timed out after ${seconds(timeoutMs)}s: ${command}`;
      result.output_tail = tail(out);
      return result;
    }
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The one-line-plus-tail text a fail-closed caller prints or denies with. */
export function describeSetupFailure(r: WorktreeSetupResult): string {
  const lines = [r.error ?? 'worktree setup failed'];
  if (r.output_tail) lines.push(`Output (last ${TAIL_LINES} lines):\n${r.output_tail}`);
  return lines.join('\n');
}
