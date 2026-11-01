/**
 * `node dist/hooks.js <event> [part]`: the router entry. The install this
 * project runs (activeInstall) answers when it is another install whose dist
 * ships the router and serves the call's event, part and tool; else this one
 * decides: under dispatch.sh's per-call dedupe when the project has TMB state,
 * then prints the decision and writes its records.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haveSqlite, stateDir } from '../lib/db.js';
import { activeInstall, canonicalDir } from '../lib/install.js';
import { installRoot } from '../lib/project-env.js';
import { eventHoldsEnforcement, matcherFits, routerGroup, routerTimeoutS } from '../registry.js';
import { ROUTER_NAME, decide, denyOutput, failClosedReason, isBarePath, pathFailure, payloadTool, stdoutIsPath } from './decide.js';
import { Dedupe, dedupeKey } from './dedupe.js';
import { auditCall, recordBashDeny } from './records.js';
import { matcherOfColumn, rowHoldsPart } from './table.js';
export const ROUTER_MANIFEST = 'mcp/trajectory-server/dist/hooks-router.txt';
const BUNDLE = 'mcp/trajectory-server/dist/hooks.js';
const HOP_ENV = 'TMB_ROUTER_HOP';
function ownRoot(env) {
    return installRoot(dirname(fileURLToPath(import.meta.url))) ?? env.CLAUDE_PLUGIN_ROOT ?? '';
}
function hopTo(root, event, part, payload, env) {
    const r = spawnSync(process.execPath, [`${root}/${BUNDLE}`, event, ...(part === undefined ? [] : [part])], {
        input: payload,
        env: { ...env, CLAUDE_PLUGIN_ROOT: root, [HOP_ENV]: '1' },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error || r.status === null) {
        const cause = `could not run in ${root}`;
        if (stdoutIsPath(event))
            return { stdout: '', stderr: pathFailure(event, cause), code: 1 };
        if (!eventHoldsEnforcement(event))
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
function lockBase(env) {
    if (!haveSqlite(env))
        return null;
    const state = stateDir(env);
    return state === null ? null : `${canonicalDir(state)}/locks`;
}
export async function routerMain(event, env, io, opts = {}) {
    const payload = io.readStdin();
    const tool = payloadTool(payload);
    const self = opts.selfRoot ?? ownRoot(env);
    if (opts.hop !== false && env[HOP_ENV] !== '1') {
        const root = activeInstall(env, io.writeStderr);
        if (root !== '' && self !== '' && canonicalDir(root) !== canonicalDir(self)) {
            if (existsSync(`${root}/${ROUTER_MANIFEST}`) && existsSync(`${root}/${BUNDLE}`) && servesCall(root, event, opts.part, tool)) {
                const out = hopTo(root, event, opts.part, payload, env);
                io.writeStderr(out.stderr);
                await io.writeStdout(out.stdout);
                return out.code;
            }
            io.writeStderr(`TMB router: no router in ${root} — using ${self}\n`);
        }
    }
    const gateEnv = self === '' ? env : { ...env, CLAUDE_PLUGIN_ROOT: self };
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
    const d = await decide(event, payload, gateEnv, opts);
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