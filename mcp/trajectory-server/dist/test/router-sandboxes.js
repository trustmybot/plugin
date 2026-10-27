/**
 * The corpus of the 11 PreToolUse Bash router gates, each payload materialized
 * in its gate's parity sandbox (the builders of the hooks-*-parity suites),
 * with the env and cwd its parity run uses, in-process. Shared by the router
 * parity tests and the router benches.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandbox as gitBranchSandbox, caseEnv as gitBranchEnv, GIT_BRANCH_GATES, materialize as gitBranchCase } from './hooks-git-branch-guards-parity.suite.js';
import { buildSandbox as gitGuardsSandbox, materialize as gitGuardsCase } from './hooks-git-guards-parity.suite.js';
import { buildSandbox as pushGuardSandbox, materialize as pushGuardCase } from './hooks-git-push-guard-parity.suite.js';
import { containmentGuardSetup } from './hooks-parity.suite.js';
import { buildSandbox as remoteIdSandbox, materialize as remoteIdCase } from './hooks-remote-id-guard-parity.suite.js';
import { buildSandbox as sessionSandbox, caseEnv as sessionEnv, materialize as sessionCase } from './hooks-session-parity.suite.js';
import { buildSandbox as sweBoundarySandbox, materialize as sweBoundaryCase, resetState as sweBoundaryReset } from './hooks-swe-boundary-parity.suite.js';
import { lintSandbox } from './lint-hooks-sandbox.js';
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const LOCALE = 'C';
export const FAKE_UID = 4242424;
export const ROUTER_CORPUS_GATES = [
    'containment-guard',
    'git-guards',
    'git-push-guard',
    'swe-boundary',
    ...GIT_BRANCH_GATES,
    'commit-msg-lint',
    'remote-id-guard',
    'debug-trajectory',
];
function files(gate) {
    const dir = join(CORPUS_ROOT, gate);
    return existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .sort()
            .map((f) => join(dir, f))
        : [];
}
const GIT_ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
};
function clean(env, drop = []) {
    const out = {};
    for (const [k, v] of Object.entries(env))
        if (v !== undefined && v !== null && !drop.includes(k))
            out[k] = v;
    return out;
}
/** The corpus of <gates> (default: every router gate), materialized under <root> (an existing, real dir); only those gates' sandboxes are built. */
export function routerSandbox(rootDir, gates) {
    const want = (gate) => gates === undefined || gates.includes(gate);
    const root = realpathSync(rootDir);
    const cases = [];
    const cleanups = [];
    const emptyProject = join(root, 'empty-project');
    mkdirSync(emptyProject, { recursive: true });
    const path = process.env.PATH ?? '';
    if (want('containment-guard')) {
        const cg = containmentGuardSetup(join(root, 'cg'));
        for (const file of files('containment-guard')) {
            const { input, env } = cg.materialize?.(readFileSync(file)) ?? { input: readFileSync(file), env: {} };
            cases.push({
                gate: 'containment-guard',
                file,
                input: input.toString('utf8'),
                env: clean({ ...process.env, CLAUDE_PROJECT_DIR: emptyProject, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, LC_ALL: LOCALE, ...cg.env, ...env }, ['NODE_OPTIONS']),
                cwd: cg.cwd ?? emptyProject,
                fakeUid: true,
            });
        }
    }
    for (const [gate, build, materialize] of [
        ['git-guards', gitGuardsSandbox, gitGuardsCase],
        ['git-push-guard', pushGuardSandbox, pushGuardCase],
    ]) {
        if (!want(gate))
            continue;
        const sb = join(root, gate);
        mkdirSync(sb, { recursive: true });
        build(sb);
        for (const file of files(gate)) {
            const c = materialize(file, sb);
            cases.push({
                gate,
                file,
                input: c.input,
                env: clean({
                    ...process.env,
                    ...GIT_ENV,
                    CLAUDE_PROJECT_DIR: join(sb, 'project'),
                    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
                    TRAJECTORY_DB_PATH: join(sb, 'db/trajectory.db'),
                    LC_ALL: LOCALE,
                    ...c.env,
                }, ['TMB_HOOKS_SQLITE']),
                cwd: join(sb, 'project'),
                fakeUid: false,
            });
        }
    }
    if (want('swe-boundary')) {
        const sbDir = join(root, 'swe-boundary');
        mkdirSync(sbDir, { recursive: true });
        const sb = sweBoundarySandbox(sbDir);
        cleanups.push(() => rmSync(sb.scratchProject, { recursive: true, force: true }));
        for (const file of files('swe-boundary')) {
            const c = sweBoundaryCase(file, sb);
            cases.push({
                gate: 'swe-boundary',
                file,
                input: c.input,
                env: clean({ ...process.env, CLAUDE_PROJECT_DIR: join(sb.dir, 'project'), CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, TRAJECTORY_DB_PATH: sb.db, LC_ALL: LOCALE, ...c.env }, ['TMB_HOOKS_SQLITE', 'NODE_OPTIONS']),
                cwd: join(sb.dir, 'project'),
                fakeUid: false,
                reset: () => sweBoundaryReset(sb, c.record, Math.floor(Date.now() / 1000)),
            });
        }
    }
    const branchGates = GIT_BRANCH_GATES.filter(want);
    if (branchGates.length > 0) {
        const gb = join(root, 'git-branch/sandbox');
        mkdirSync(gb, { recursive: true });
        gitBranchSandbox(gb);
        for (const gate of branchGates) {
            for (const file of files(gate)) {
                const c = gitBranchCase(file, gb, { noJq: path, noSqlite: path });
                cases.push({ gate, file, input: c.input.toString('utf8'), env: clean(gitBranchEnv(gb, LOCALE, c.env, c.cwd)), cwd: c.cwd, fakeUid: false });
            }
        }
    }
    if (want('commit-msg-lint')) {
        const lint = lintSandbox(join(root, 'lint'));
        for (const file of files('commit-msg-lint')) {
            const c = lint.materialize(readFileSync(file));
            cases.push({
                gate: 'commit-msg-lint',
                file,
                input: c.input.toString('utf8'),
                env: clean({ ...process.env, CLAUDE_PROJECT_DIR: emptyProject, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, LC_ALL: LOCALE, ...lint.env, ...c.env }),
                cwd: emptyProject,
                fakeUid: false,
            });
        }
    }
    if (want('remote-id-guard')) {
        const rid = join(root, 'remote-id/sandbox');
        remoteIdSandbox(rid);
        for (const file of files('remote-id-guard')) {
            const c = remoteIdCase(file, rid, { noJq: path, noSqlite: path });
            cases.push({
                gate: 'remote-id-guard',
                file,
                input: c.input,
                env: clean({
                    ...process.env,
                    CLAUDE_PROJECT_DIR: join(rid, 'project'),
                    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
                    TRAJECTORY_DB_PATH: join(rid, 'db/trajectory.db'),
                    LC_ALL: LOCALE,
                    ...c.env,
                }, ['TMB_HOOKS_SQLITE', 'TMB_DB_WRITE_TIMEOUT_MS', 'LANG', 'LC_CTYPE']),
                cwd: join(rid, 'project'),
                fakeUid: false,
            });
        }
    }
    if (want('debug-trajectory')) {
        const ss = join(root, 'session/sandbox');
        sessionSandbox(ss);
        for (const file of files('debug-trajectory')) {
            const c = sessionCase(file, ss, path);
            cases.push({
                gate: 'debug-trajectory',
                file,
                input: c.input.toString('utf8'),
                env: clean(sessionEnv(ss, LOCALE, c.env, c.cwd)),
                cwd: c.cwd,
                fakeUid: false,
                reset: () => sessionSandbox(ss),
            });
        }
    }
    return {
        cases,
        cleanup: () => {
            for (const f of cleanups)
                f();
            rmSync(root, { recursive: true, force: true });
        },
    };
}
/** Runs <fn> under the case's uid (containment-guard's fake one, or the real one). */
export async function underUid(fake, fn) {
    if (!fake)
        return fn();
    const real = process.getuid;
    process.getuid = () => FAKE_UID;
    try {
        return await fn();
    }
    finally {
        process.getuid = real;
    }
}
//# sourceMappingURL=router-sandboxes.js.map