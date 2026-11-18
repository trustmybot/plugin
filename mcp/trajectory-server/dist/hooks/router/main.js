/**
 * `node dist/hooks.js <event> [part] [--shim]`: the router entry. Under
 * --shim (the headless shim, resolve-hook.ts) it exits 0 with no
 * output and runs no gate when the session belongs to another project or the
 * plugin's own hooks marked it (shimYields); otherwise --shim changes nothing.
 * The install this
 * project runs (activeInstall) answers when it is another install whose dist
 * ships the router and serves the call's event, part and tool; else this one
 * decides: under the per-call dedupe of router/dedupe.ts when the project has TMB state,
 * then prints the decision and writes its records. The event loop stays open
 * until the decision: every deadline timer is unref'd, so a wait with no live
 * handle behind it would otherwise end the process with no answer.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haveSqlite, stateDir } from '../lib/db.js';
import { activeInstall, canonicalDir } from '../lib/install.js';
import { installRoot, pluginName, TMB_STATE_HOST_DIR } from '../lib/project-env.js';
import { safeSessionId } from '../plugin-hooks-marker.js';
import { eventHoldsEnforcement, matcherFits, routerGroup, routerTimeoutS } from '../registry.js';
import { ROUTER_NAME, decide, denyOutput, failClosedReason, isBarePath, pathFailure, payloadTool, stdoutIsPath } from './decide.js';
import { Dedupe, dedupeKey } from './dedupe.js';
import { auditCall, recordBashDeny } from './records.js';
import { matcherOfColumn, rowHoldsPart } from './table.js';
export const ROUTER_MANIFEST = 'mcp/trajectory-server/dist/hooks-router.txt';
const BUNDLE = 'mcp/trajectory-server/dist/hooks.js';
const HOP_ENV = 'TMB_ROUTER_HOP';
const TRANSIENT_SPAWN_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM']);
const HOP_BACKOFF_MS = [25, 100];
function ownRoot(env) {
    return installRoot(dirname(fileURLToPath(import.meta.url))) ?? env.CLAUDE_PLUGIN_ROOT ?? '';
}
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function spawnErrorCode(r) {
    const error = r.error;
    return error?.code;
}
function isTransient(r) {
    const code = spawnErrorCode(r);
    return r.signal === null && code !== undefined && TRANSIENT_SPAWN_CODES.has(code);
}
function spawnFailure(r) {
    if (r.error)
        return spawnErrorCode(r) ?? r.error.message;
    if (r.signal)
        return `killed by ${r.signal}`;
    return 'no exit status';
}
function hopTo(root, event, part, payload, env, spawn) {
    const run = () => spawn(process.execPath, [`${root}/${BUNDLE}`, event, ...(part === undefined ? [] : [part])], {
        input: payload,
        env: { ...env, CLAUDE_PLUGIN_ROOT: root, [HOP_ENV]: '1' },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    let r = run();
    for (const ms of HOP_BACKOFF_MS) {
        if (!isTransient(r))
            break;
        sleepSync(ms);
        r = run();
    }
    if (r.error || r.status === null) {
        const cause = `could not run in ${root} (${spawnFailure(r)})`;
        if (stdoutIsPath(event))
            return { stdout: '', stderr: pathFailure(event, cause), code: 1 };
        if (!eventHoldsEnforcement(event, undefined, part))
            return { stdout: '', stderr: `TMB router: ${event} ${cause} — no gate run\n`, code: 0 };
        return { stdout: denyOutput(failClosedReason(ROUTER_NAME, cause), event), stderr: `TMB dispatch: gate ${ROUTER_NAME} ${cause} — failing closed\n`, code: 0 };
    }
    if (stdoutIsPath(event) && (r.status !== 0 || !isBarePath(r.stdout))) {
        return { stdout: '', stderr: `${r.stderr}${pathFailure(event, `${root} answered exit ${r.status} with no bare path`)}`, code: r.status === 0 ? 1 : r.status };
    }
    return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}
/**
 * Whether <root>'s router table has a group for the call: its event, its part,
 * and a matcher fitting its tool, any matcher when an unparseable payload names
 * none. A router predating a group would allow its tools unjudged or answer
 * `unknown gate` (GH 2207), so it never answers for them.
 */
function servesCall(root, event, part, tool) {
    let table;
    try {
        table = readFileSync(`${root}/${ROUTER_MANIFEST}`, 'utf8');
    }
    catch {
        return false;
    }
    return table.split('\n').some((line) => {
        const f = line.split(' ');
        if (f[3] !== event || !rowHoldsPart(f, part))
            return false;
        return tool === null || matcherOfColumn(f[4] ?? '').split(',').some((m) => matcherFits(m, tool));
    });
}
/**
 * The --shim yield: CLAUDE_PROJECT_DIR is another project than
 * TMB_SHIM_PROJECT (physical paths), or the plugin's SessionStart hook left
 * <project>/.claude/<plugin>/sessions/<session_id>.plugin-hooks for the
 * payload's session_id, so the plugin's own hooks judge this session.
 */
export function shimYields(payload, env) {
    const project = env.CLAUDE_PROJECT_DIR ? canonicalDir(env.CLAUDE_PROJECT_DIR) : '';
    const shimProject = env.TMB_SHIM_PROJECT ? canonicalDir(env.TMB_SHIM_PROJECT) : '';
    if (project !== '' && shimProject !== '' && project !== shimProject)
        return true;
    const sessionRoot = project || shimProject;
    const sessionId = safeSessionId(payload);
    if (sessionRoot === '' || sessionId === '')
        return false;
    return existsSync(`${sessionRoot}/${TMB_STATE_HOST_DIR}/${pluginName(env)}/sessions/${sessionId}.plugin-hooks`);
}
function lockBase(env) {
    if (!haveSqlite(env))
        return null;
    const state = stateDir(env);
    return state === null ? null : `${canonicalDir(state)}/locks`;
}
export async function routerMain(event, env, io, opts = {}) {
    const payload = io.readStdin();
    const tool = payloadTool(payload, event);
    const self = opts.selfRoot ?? ownRoot(env);
    const gateEnv = self === '' ? env : { ...env, CLAUDE_PLUGIN_ROOT: self };
    if (opts.shim === true && shimYields(payload, gateEnv))
        return 0;
    if (opts.hop !== false && env[HOP_ENV] !== '1') {
        const root = activeInstall(env, io.writeStderr);
        if (root !== '' && self !== '' && canonicalDir(root) !== canonicalDir(self)) {
            if (existsSync(`${root}/${ROUTER_MANIFEST}`) && existsSync(`${root}/${BUNDLE}`) && servesCall(root, event, opts.part, tool)) {
                const out = hopTo(root, event, opts.part, payload, env, opts.hopSpawn ?? spawnSync);
                io.writeStderr(out.stderr);
                await io.writeStdout(out.stdout);
                return out.code;
            }
            io.writeStderr(`TMB router: no router in ${root} — using ${self}\n`);
        }
    }
    const locks = opts.dedupe === false ? null : lockBase(gateEnv);
    const key = locks === null ? null : dedupeKey(payload, event, opts.part);
    let dedupe = null;
    let lock = null;
    const groupBudget = opts.groupBudgetMs ?? routerGroup(event, tool ?? '', opts.groups, opts.part)?.groupBudgetMs;
    if (locks !== null && key !== null && groupBudget !== undefined) {
        dedupe = new Dedupe(`${locks}/events`, routerTimeoutS({ groupBudgetMs: groupBudget }), gateEnv, stdoutIsPath(event));
        try {
            mkdirSync(dedupe.base, { recursive: true });
            const claim = await dedupe.claim(key);
            if (claim.kind === 'replay') {
                io.writeStderr(claim.out.stderr);
                await io.writeStdout(claim.out.stdout);
                return claim.out.code;
            }
            if (claim.kind === 'none') {
                if (!stdoutIsPath(event))
                    return 0;
                io.writeStderr(pathFailure(event, 'a duplicate of a call whose answer never came'));
                return 1;
            }
            lock = claim.lock;
        }
        catch {
            lock = null;
        }
    }
    const holdOpen = setInterval(() => undefined, 60_000);
    let d;
    try {
        d = await decide(event, payload, gateEnv, opts);
    }
    finally {
        clearInterval(holdOpen);
    }
    if (lock !== null)
        Dedupe.store(lock, d);
    io.writeStderr(d.stderr);
    await io.writeStdout(d.stdout);
    if (opts.record !== false) {
        try {
            auditCall(event, payload, d, gateEnv);
        }
        catch {
            /* observes only */
        }
        if (locks !== null && lock !== null)
            await recordBashDeny(`${locks}/boundary-denies`, payload, d, gateEnv);
    }
    return d.code;
}
//# sourceMappingURL=main.js.map