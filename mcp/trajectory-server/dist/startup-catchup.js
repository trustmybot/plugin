// Startup catch-up scan (GH 1680): after the server connects, a
// detached `run-scan.mjs <projectRoot> startup_catchup` brings each known
// repo's world model to its target commit (origin/<target branch>, fetched
// first when the periodic fetch is due, else HEAD) with the git-range scope, the full-repo scope only when the repo's stamp
// needs it, and never a workspace walk on a warm DB (GH 2584). Each repo's
// scan lock serialises it with any other reindex of that repo; the child never
// holds the stdio event loop.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverLog } from './logger.js';
import { sweepStaleReindexes } from './world-model/freshness.js';
export const RUN_SCAN_SCRIPT = fileURLToPath(new URL('../../../scripts/maintenance/run-scan.mjs', import.meta.url));
export const STARTUP_CATCHUP_SOURCE = 'startup_catchup';
export function startupCatchupArgs(script, projectRoot, execArgv = process.execArgv) {
    return [...execArgv, script, projectRoot, STARTUP_CATCHUP_SOURCE];
}
export function decideStartupCatchup(opts) {
    const script = opts.script ?? RUN_SCAN_SCRIPT;
    const exists = opts.exists ?? existsSync;
    if (opts.dbPath === ':memory:')
        return { spawn: false, reason: 'memory-db' };
    if (opts.env['TMB_SKIP_AUTO_RESCAN'] === '1')
        return { spawn: false, reason: 'skip-env' };
    if (opts.env['NODE_TEST_CONTEXT'])
        return { spawn: false, reason: 'test-context' };
    const projectRoot = opts.env['CLAUDE_PROJECT_DIR']?.trim();
    if (!projectRoot)
        return { spawn: false, reason: 'no-project-root' };
    if (!exists(script))
        return { spawn: false, reason: 'script-missing' };
    return { spawn: true, script, projectRoot, reason: 'spawned' };
}
// Before the catch-up starts: wm_freshness rows a dead process left 'running'
// become 'failed' (GH 2584). Never throws.
export function sweepStaleAtStartup(db, dbPath) {
    try {
        const swept = sweepStaleReindexes(db, dbPath);
        if (swept.length > 0)
            serverLog({ kind: 'wm_freshness_sweep', repos: swept });
        return swept;
    }
    catch (e) {
        serverLog({ kind: 'wm_freshness_sweep_error', error_message: e.message });
        return [];
    }
}
export function startStartupCatchup(dbPath) {
    const decision = decideStartupCatchup({ dbPath, env: process.env });
    if (decision.spawn) {
        try {
            const child = spawn(process.execPath, startupCatchupArgs(decision.script, decision.projectRoot), {
                detached: true,
                stdio: 'ignore',
                env: { ...process.env, TRAJECTORY_DB_PATH: dbPath },
            });
            child.on('error', (e) => serverLog({ kind: 'startup_catchup_error', error_message: e.message }));
            child.unref();
        }
        catch (e) {
            serverLog({ kind: 'startup_catchup', spawned: false, reason: 'spawn-error', error_message: e.message });
            return decision;
        }
    }
    serverLog({ kind: 'startup_catchup', spawned: decision.spawn, reason: decision.reason });
    return decision;
}
// Change impact cache (GH 2600): after connect, a detached
// `change-impact/cli.js --db <db> --cache` writes the regressed changes to
// change-impact-regressions.json next to the DB for the next SessionStart
// prescan, so no hook ever runs the statistics.
export const CHANGE_IMPACT_CLI = fileURLToPath(new URL('./change-impact/cli.js', import.meta.url));
export function changeImpactCacheArgs(script, dbPath, execArgv = process.execArgv) {
    return [...execArgv, script, '--db', dbPath, '--cache'];
}
export function decideChangeImpactCache(opts) {
    const script = opts.script ?? CHANGE_IMPACT_CLI;
    const exists = opts.exists ?? existsSync;
    if (opts.dbPath === ':memory:')
        return { spawn: false, reason: 'memory-db' };
    if (opts.env['TMB_SKIP_AUTO_RESCAN'] === '1')
        return { spawn: false, reason: 'skip-env' };
    if (opts.env['NODE_TEST_CONTEXT'])
        return { spawn: false, reason: 'test-context' };
    if (!exists(script))
        return { spawn: false, reason: 'script-missing' };
    return { spawn: true, script, reason: 'spawned' };
}
export function startChangeImpactCache(dbPath) {
    const decision = decideChangeImpactCache({ dbPath, env: process.env });
    if (decision.spawn) {
        try {
            const child = spawn(process.execPath, changeImpactCacheArgs(decision.script, dbPath), { cwd: dirname(dbPath), detached: true, stdio: 'ignore' });
            child.on('error', (e) => serverLog({ kind: 'change_impact_cache_error', error_message: e.message }));
            child.unref();
        }
        catch (e) {
            serverLog({ kind: 'change_impact_cache', spawned: false, reason: 'spawn-error', error_message: e.message });
            return decision;
        }
    }
    serverLog({ kind: 'change_impact_cache', spawned: decision.spawn, reason: decision.reason });
    return decision;
}
//# sourceMappingURL=startup-catchup.js.map