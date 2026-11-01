/**
 * A routed gate's scripts/hooks/<gate>.sh as a Gate: what the router runs under
 * the TMB_HOOKS_IMPL=bash kill switch (decision 187). It runs to the gate's
 * deadline, and SIGKILL because a .sh may hold SIGTERM until its foreground
 * child ends. A gate with no .sh throws, so the router judges it as dispatch.sh
 * refusing to run it: enforcement fails closed, advisory is dropped and logged.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Gate } from '../gate.js';
import { noteSpawn, spawnLimit, spawnOptions } from '../lib/deadline.js';

export function shGate(name: string): Gate {
  return (payload, env) => {
    const script = `${env.CLAUDE_PLUGIN_ROOT ?? ''}/scripts/hooks/${name}.sh`;
    if (!existsSync(script)) throw new Error(`no ${script} (TMB_HOOKS_IMPL=bash runs only .sh gates) — not run`);
    const limit = spawnLimit(undefined, 'SIGKILL');
    const r = spawnSync('bash', [script], {
      input: payload,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'inherit'],
      ...spawnOptions(limit),
    });
    const cut = noteSpawn(limit, r);
    if (r.error && !cut) throw r.error;
    return { stdout: r.stdout ?? '', code: r.status ?? 1 };
  };
}
