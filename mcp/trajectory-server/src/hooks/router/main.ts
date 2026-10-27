/**
 * `node dist/hooks.js <event>`: the router entry. The install this project
 * runs (activeInstall) answers when it is another install whose dist ships
 * the router; else this one decides: under dispatch.sh's per-call dedupe when
 * the project has TMB state, then prints the decision and writes its records.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haveSqlite, stateDir } from '../lib/db.js';
import { activeInstall, canonicalDir } from '../lib/install.js';
import { installRoot } from '../lib/project-env.js';
import { routerTimeoutS } from '../registry.js';
import { type DecideDeps, ROUTER_NAME, type RouterDecision, decide, denyOutput, failClosedReason } from './decide.js';
import { Dedupe, type Emitted, dedupeKey } from './dedupe.js';
import { auditCall, recordBashDeny } from './records.js';

export const ROUTER_MANIFEST = 'mcp/trajectory-server/dist/hooks-router.txt';
const BUNDLE = 'mcp/trajectory-server/dist/hooks.js';
const HOP_ENV = 'TMB_ROUTER_HOP';

export interface RouterIo {
  readStdin(): string;
  writeStdout(text: string): Promise<void>;
  writeStderr(text: string): void;
}

export interface RouterOptions extends DecideDeps {
  /** false: decide without the lock (parity tests). */
  dedupe?: boolean;
  /** false: write no audit rows or deny records. */
  record?: boolean;
  /** false: never hand the call to another install. */
  hop?: boolean;
  selfRoot?: string;
}

function ownRoot(env: NodeJS.ProcessEnv): string {
  return installRoot(dirname(fileURLToPath(import.meta.url))) ?? env.CLAUDE_PLUGIN_ROOT ?? '';
}

function hopTo(root: string, event: string, payload: string, env: NodeJS.ProcessEnv): Emitted {
  const r = spawnSync(process.execPath, [`${root}/${BUNDLE}`, event], {
    input: payload,
    env: { ...env, CLAUDE_PLUGIN_ROOT: root, [HOP_ENV]: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status === null) {
    const cause = `could not run in ${root}`;
    return { stdout: denyOutput(failClosedReason(ROUTER_NAME, cause)), stderr: `TMB dispatch: gate ${ROUTER_NAME} ${cause} — failing closed\n`, code: 0 };
  }
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function lockBase(env: NodeJS.ProcessEnv): string | null {
  if (!haveSqlite(env)) return null;
  const state = stateDir(env);
  return state === null ? null : `${canonicalDir(state)}/locks`;
}

export async function routerMain(event: string, env: NodeJS.ProcessEnv, io: RouterIo, opts: RouterOptions = {}): Promise<number> {
  const payload = io.readStdin();
  const self = opts.selfRoot ?? ownRoot(env);
  if (opts.hop !== false && env[HOP_ENV] !== '1') {
    const root = activeInstall(env, io.writeStderr);
    if (root !== '' && self !== '' && canonicalDir(root) !== canonicalDir(self)) {
      if (existsSync(`${root}/${ROUTER_MANIFEST}`) && existsSync(`${root}/${BUNDLE}`)) {
        const out = hopTo(root, event, payload, env);
        io.writeStderr(out.stderr);
        await io.writeStdout(out.stdout);
        return out.code;
      }
      io.writeStderr(`TMB router: no router in ${root} — using ${self}\n`);
    }
  }
  const gateEnv = self === '' ? env : { ...env, CLAUDE_PLUGIN_ROOT: self };
  const locks = opts.dedupe === false ? null : lockBase(gateEnv);
  const key = locks === null ? null : dedupeKey(payload);
  let dedupe: Dedupe | null = null;
  let lock: string | null = null;
  if (locks !== null && key !== null) {
    dedupe = new Dedupe(`${locks}/events`, routerTimeoutS(opts.groups), gateEnv);
    try {
      mkdirSync(dedupe.base, { recursive: true });
      const claim = await dedupe.claim(key);
      if (claim.kind === 'replay') {
        io.writeStderr(claim.out.stderr);
        await io.writeStdout(claim.out.stdout);
        return claim.out.code;
      }
      if (claim.kind === 'none') return 0;
      lock = claim.lock;
    } catch {
      lock = null;
    }
  }
  const d: RouterDecision = await decide(event, payload, gateEnv, opts);
  if (lock !== null) Dedupe.store(lock, d);
  io.writeStderr(d.stderr);
  await io.writeStdout(d.stdout);
  if (opts.record !== false) {
    try {
      auditCall(event, payload, d, gateEnv);
    } catch {
      /* observes only */
    }
    if (locks !== null && lock !== null) await recordBashDeny(`${locks}/boundary-denies`, payload, d, gateEnv);
  }
  return d.code;
}
