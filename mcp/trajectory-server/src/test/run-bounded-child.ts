/**
 * The watchdog behind runBounded (cmd-analysis-l3.ts), the node port of the
 * perl run_bounded of the bash cmd-analysis suite (GH 1692):
 * `node run-bounded-child.js <caller-pid> <secs> <cmd> [args…]` runs <cmd> in
 * its own process group and kills the whole group on timeout (exit 124), on
 * INT (130) or TERM (143) to the watchdog, and when <caller-pid> dies (143), so
 * nothing <cmd> backgrounded outlives the suite. A finished <cmd> keeps its
 * exit code, or 128 + its signal.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const [callerArg = '', secsArg = '', cmd = '', ...args] = process.argv.slice(2);
const caller = Number(callerArg);
const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function reap(code: number): never {
  if (child.pid !== undefined) killGroup(child.pid);
  process.exit(code);
}

child.on('error', () => process.exit(127));
child.on('exit', (code, signal) => process.exit(signal ? 128 + constants.signals[signal] : (code ?? 1)));
process.on('SIGINT', () => reap(130));
process.on('SIGTERM', () => reap(143));
setTimeout(() => reap(124), Number(secsArg) * 1000).unref();
setInterval(() => {
  if (!alive(caller)) reap(143);
}, 50).unref();
