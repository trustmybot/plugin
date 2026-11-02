/**
 * The corpus of every router gate, each payload materialized in its gate's
 * parity sandbox (the builders of the hooks-*-parity suites), with the env and
 * cwd its parity run uses, in-process. Shared by the router parity tests and the
 * router benches. swe-resume-gate, no-prose-in-scratch, task-overrun-alert,
 * liveness-alert, rework-waiver-capture and session-handoff have no hook-corpus
 * directory (they were born in TypeScript), so their cases are built here. A gate with bash
 * recordings carries where its case's recording sits, so the parity tests can
 * hold the router to it.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../hooks/orphan-scan.js';
import { buildTemplate as agentSpawnTemplate, caseEnv as agentSpawnEnv } from './hooks-agent-spawn-parity.suite.js';
import { buildSandbox as healthSandbox, caseEnv as healthEnv, materialize as healthCase } from './hooks-health-parity.suite.js';
import { buildSandbox as mergeSandbox, caseEnv as mergeEnv, materialize as mergeCase } from './hooks-merge-lifecycle-parity.suite.js';
import { buildSandbox as readmeSandbox, caseEnv as readmeEnv, materialize as readmeCase, resetDb as readmeReset } from './hooks-readme-staleness-parity.suite.js';
import { buildCloseSandbox, buildRescanSandbox, caseEnv as taskCloseEnv, materialize as taskCloseCase } from './hooks-task-close-parity.suite.js';
import { buildSandbox as worktreeSandbox, caseEnv as worktreeEnv, materialize as worktreeCase } from './hooks-worktree-lifecycle-parity.suite.js';
import { buildSandbox as gitBranchSandbox, caseEnv as gitBranchEnv, GIT_BRANCH_GATES, materialize as gitBranchCase } from './hooks-git-branch-guards-parity.suite.js';
import { buildSandbox as gitGuardsSandbox, materialize as gitGuardsCase } from './hooks-git-guards-parity.suite.js';
import { buildSandbox as pushGuardSandbox, materialize as pushGuardCase } from './hooks-git-push-guard-parity.suite.js';
import { buildSourceEditSandbox, caseEnv as sourceEditEnv, materialize as sourceEditCase } from './hooks-no-source-edit-parity.suite.js';
import { containmentGuardSetup, readyDepsEnv } from './hooks-parity.suite.js';
import { buildSandbox as promptIntentSandbox, caseEnv as promptIntentEnv } from './hooks-prompt-intent-parity.suite.js';
import { buildSandbox as remoteIdSandbox, materialize as remoteIdCase } from './hooks-remote-id-guard-parity.suite.js';
import { buildSandbox as roundtableSandbox, caseEnv as roundtableEnv, materialize as roundtableCase } from './hooks-roundtable-parity.suite.js';
import { buildSandbox as sessionSandbox, caseEnv as sessionEnv, materialize as sessionCase } from './hooks-session-parity.suite.js';
import { buildSessionScansSandbox, materialize as sessionScanCase, sessionScanEnv } from './hooks-session-scans-parity.suite.js';
import { buildSandbox as sweBoundarySandbox, materialize as sweBoundaryCase, resetState as sweBoundaryReset } from './hooks-swe-boundary-parity.suite.js';
import { buildSandbox as sweRunSandbox, caseEnv as sweRunEnv, materialize as sweRunCase, noCmdPath } from './hooks-swe-run-parity.suite.js';
import { buildScopeSandbox, caseEnv as scopeEnv } from './hooks-swe-scope-fence-parity.suite.js';
import { buildVerificationSandbox, caseEnv as verificationEnv, materialize as verificationCase } from './hooks-swe-verification-parity.suite.js';
import { buildSandbox as chainSandbox, caseEnv as chainEnv, materialize as chainCase, TRAJECTORY_CHAIN_GATES } from './hooks-trajectory-chain-parity.suite.js';
import { GENERIC_CASE_PREFIX } from './golden.js';
import { lintSandbox } from './lint-hooks-sandbox.js';
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const LOCALE = 'C';
export const FAKE_UID = 4242424;
export const ROUTER_BASH_GATES = [
    'containment-guard',
    'git-guards',
    'git-push-guard',
    'swe-boundary',
    ...GIT_BRANCH_GATES,
    'commit-msg-lint',
    'remote-id-guard',
    'debug-trajectory',
];
export const ROUTER_CORPUS_GATES = [
    ...ROUTER_BASH_GATES,
    'swe-brief-gate',
    'no-source-edit-from-main',
    'no-prose-in-scratch',
    'swe-scope-fence',
    'naming-lint',
    'code-quality-lint',
    'agent-spawn-dispatch',
    'swe-resume-gate',
    ...TRAJECTORY_CHAIN_GATES,
    'swe-verification-gate',
    'askuserquestion-length-lint',
    'roundtable-auq-shape',
    'cleanup-worktree-on-task-close',
    'roundtable-cleanup-postcheck',
    'post-task-close-rescan',
    'post-atomic-close-readme',
    'post-task-create-spawn-hint',
    'task-overrun-alert',
    'liveness-alert',
    'attribution-footer',
    'clean-merged-branch',
    'close-issue-on-merge',
    'swe-spawn-bind',
    'swe-spawn-rollback',
    'bro-turn-usage',
    'session-handoff',
    'swe-atomic-close',
    'consultant-persistence-gate',
    'ensure-gitignore',
    'mcp-health-check',
    'deferred-tools-drift-warn',
    'plugin-hooks-marker',
    'session-start-persona',
    'session-start-prescan',
    'ensure-mcp-deps-installed',
    'substrate-preflight',
    'orphan-scan',
    'user-prompt-persona',
    'rework-waiver-capture',
    'activation-routine',
    'session-log-capture',
    'prompt-intent-hints',
    'roundtable-slash-detect',
    'worktree-create',
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
    const lintGates = ['commit-msg-lint', 'naming-lint', 'code-quality-lint', 'attribution-footer'].filter(want);
    if (lintGates.length > 0) {
        const lint = lintSandbox(join(root, 'lint'));
        for (const file of lintGates.flatMap((gate) => files(gate).map((f) => [gate, f]))) {
            const c = lint.materialize(readFileSync(file[1]));
            cases.push({
                gate: file[0],
                file: file[1],
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
    if (want('askuserquestion-length-lint')) {
        for (const file of files('askuserquestion-length-lint')) {
            cases.push({
                gate: 'askuserquestion-length-lint',
                file,
                input: readFileSync(file, 'utf8'),
                env: clean({ ...process.env, CLAUDE_PROJECT_DIR: emptyProject, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, LC_ALL: LOCALE }),
                cwd: emptyProject,
                fakeUid: false,
            });
        }
    }
    const paths = { noJq: path, noSqlite: path };
    const rebuilt = (gate, dir, build, one, fakeUid = false) => {
        if (!want(gate))
            return;
        mkdirSync(dirname(dir), { recursive: true });
        build(dir);
        for (const file of files(gate)) {
            const c = one(file);
            cases.push({ gate, file, input: c.input.toString('utf8'), env: clean(c.env, ['NODE_OPTIONS']), cwd: c.cwd, fakeUid, reset: () => build(dir), golden: c.golden });
        }
    };
    const briefDir = join(root, 'swe-brief/sandbox');
    rebuilt('swe-brief-gate', briefDir, sweRunSandbox, (file) => {
        const c = sweRunCase(file, briefDir, paths);
        return { input: c.input, env: sweRunEnv(briefDir, LOCALE, c.env, c.cwd), cwd: c.cwd };
    });
    const fenceDir = join(root, 'swe-scope-fence/sandbox');
    rebuilt('swe-scope-fence', fenceDir, buildScopeSandbox, (file) => {
        const c = sweRunCase(file, fenceDir, paths);
        return { input: c.input, env: scopeEnv(fenceDir, LOCALE, c.env, c.cwd), cwd: c.cwd };
    });
    const sourceDir = join(root, 'no-source-edit/sandbox');
    rebuilt('no-source-edit-from-main', sourceDir, buildSourceEditSandbox, (file) => {
        const c = sourceEditCase(file, { sandbox: sourceDir, harnessTmp: `${realpathSync('/tmp')}/claude-${FAKE_UID}`, ...paths });
        return { input: c.input, env: sourceEditEnv(sourceDir, LOCALE, c.env, c.cwd), cwd: c.cwd };
    }, true);
    for (const gate of TRAJECTORY_CHAIN_GATES) {
        const dir = join(root, `chain-${gate}/sandbox`);
        rebuilt(gate, dir, chainSandbox, (file) => {
            const c = chainCase(file, dir, paths);
            return { input: c.input, env: chainEnv(dir, LOCALE, c.env, c.cwd), cwd: c.cwd };
        });
    }
    const verificationBase = join(root, 'swe-verification');
    const verificationDir = join(verificationBase, 'sandbox');
    rebuilt('swe-verification-gate', verificationDir, buildVerificationSandbox, (file) => {
        const c = verificationCase(file, verificationDir, paths);
        return { input: c.input, env: verificationEnv(verificationDir, verificationBase, LOCALE, c.env, c.cwd), cwd: c.cwd };
    });
    for (const gate of ['roundtable-auq-shape', 'consultant-persistence-gate', 'roundtable-cleanup-postcheck']) {
        const dir = join(root, `${gate}/sandbox`);
        rebuilt(gate, dir, roundtableSandbox, (file) => {
            const c = roundtableCase(file, dir, paths);
            return { input: c.input, env: roundtableEnv(dir, LOCALE, c.env, c.cwd), cwd: c.cwd };
        });
    }
    for (const gate of ['post-task-create-spawn-hint', 'swe-spawn-bind', 'swe-spawn-rollback']) {
        const dir = join(root, `${gate}/sandbox`);
        rebuilt(gate, dir, sweRunSandbox, (file) => {
            const c = sweRunCase(file, dir, paths);
            return { input: c.input, env: sweRunEnv(dir, LOCALE, c.env, c.cwd), cwd: c.cwd };
        });
    }
    /** Like rebuilt, for a sandbox too slow to build per case: built once and copied back per case. */
    const restored = (gate, build, one) => {
        if (!want(gate))
            return;
        const dir = join(root, gate, 'sandbox');
        const template = join(root, gate, 'template');
        const copy = { recursive: true, preserveTimestamps: true, verbatimSymlinks: true };
        mkdirSync(join(root, gate), { recursive: true });
        build(dir);
        cpSync(dir, template, copy);
        for (const file of files(gate)) {
            const c = one(file, dir);
            cases.push({
                gate,
                file,
                input: c.input.toString(),
                env: clean(c.env, ['NODE_OPTIONS']),
                cwd: c.cwd,
                fakeUid: false,
                golden: c.golden,
                reset: () => {
                    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
                    cpSync(template, dir, copy);
                },
            });
        }
    };
    restored('cleanup-worktree-on-task-close', worktreeSandbox, (file, s) => {
        const c = worktreeCase(file, s, paths);
        return { input: c.input, env: worktreeEnv(s, LOCALE, c), cwd: c.cwd };
    });
    let noGh;
    for (const gate of ['clean-merged-branch', 'close-issue-on-merge']) {
        restored(gate, mergeSandbox, (file, s) => {
            noGh ??= noCmdPath(join(root, 'no-glab'), 'glab', noCmdPath(join(root, 'no-gh'), 'gh', path));
            const merge = { noGh, noJq: noGh, noSqlite: noGh, noTimeout: noGh };
            const c = mergeCase(file, s, merge);
            return { input: c.input, env: mergeEnv(s, LOCALE, merge, c.env, c.cwd), cwd: c.cwd };
        });
    }
    restored('bro-turn-usage', healthSandbox, (file, s) => {
        const c = healthCase(file, s, () => `${join(s, 'bin')}:${path}`);
        const tmp = join(s, '..', 'tmp');
        mkdirSync(tmp, { recursive: true });
        return { input: c.input, env: healthEnv(s, tmp, LOCALE, c.env, c.cwd), cwd: c.cwd };
    });
    for (const [gate, build] of [
        ['swe-atomic-close', buildCloseSandbox],
        ['post-task-close-rescan', buildRescanSandbox],
    ]) {
        restored(gate, build, (file, s) => {
            const c = taskCloseCase(file, s, paths);
            const release = join(s, '..', 'rescan-release');
            writeFileSync(release, '');
            return { input: c.input, env: taskCloseEnv(s, LOCALE, c.env, c.cwd, { release, record: join(s, '..', 'rescan-record.json') }), cwd: c.cwd };
        });
    }
    if (want('post-atomic-close-readme')) {
        const dir = join(root, 'post-atomic-close-readme/sandbox');
        mkdirSync(dirname(dir), { recursive: true });
        readmeSandbox(dir);
        for (const file of files('post-atomic-close-readme')) {
            const c = readmeCase(file, dir, paths);
            cases.push({ gate: 'post-atomic-close-readme', file, input: c.input, env: clean(readmeEnv(dir, LOCALE, c.env)), cwd: join(dir, 'ws'), fakeUid: false, reset: () => void readmeReset(dir) });
        }
    }
    if (want('session-handoff'))
        cases.push(...sessionHandoffCases(join(root, 'session-handoff'), emptyProject));
    if (want('task-overrun-alert'))
        cases.push(...overrunCases(join(root, 'task-overrun-alert'), emptyProject));
    if (want('liveness-alert'))
        cases.push(...livenessCases(join(root, 'liveness-alert'), emptyProject));
    if (want('agent-spawn-dispatch')) {
        const dir = join(root, 'agent-spawn/sandbox');
        const template = join(root, 'agent-spawn/template');
        mkdirSync(dirname(dir), { recursive: true });
        agentSpawnTemplate(dir);
        cpSync(dir, template, { recursive: true });
        for (const file of files('agent-spawn-dispatch')) {
            const c = sweRunCase(file, dir, paths);
            cases.push({
                gate: 'agent-spawn-dispatch',
                file,
                input: c.input.toString('utf8'),
                env: clean(agentSpawnEnv(dir, LOCALE, c.env, c.cwd)),
                cwd: c.cwd,
                fakeUid: false,
                reset: () => {
                    rmSync(dir, { recursive: true, force: true });
                    cpSync(template, dir, { recursive: true });
                },
            });
        }
    }
    if (want('swe-resume-gate'))
        cases.push(...sweResumeCases(join(root, 'swe-resume'), emptyProject));
    if (want('no-prose-in-scratch'))
        cases.push(...noProseCases(join(root, 'no-prose'), emptyProject));
    // A sandbox's siblings in a SessionStart group would otherwise start a real install in it, or read the live trajectory-server of the Claude Code running the test.
    const noInstall = (env) => ({ TMB_DRIFT_SELF_PID: '1', ...env, TMB_SKIP_MCP_DEPS_INSTALL: '1' });
    const golden = (file, s, divergent, roots = {}) => ({ key: basename(file), roots: { '@SANDBOX@': s, '@BASE@': dirname(s), ...roots }, divergent });
    let realPaths;
    const corpusPaths = () => (realPaths ??= { noJq: noCmdPath(join(root, 'paths/nojq'), 'jq', path), noSqlite: noCmdPath(join(root, 'paths/nosqlite'), 'sqlite3', path) });
    for (const gate of ['deferred-tools-drift-warn', 'ensure-gitignore', 'mcp-health-check', 'substrate-preflight']) {
        restored(gate, healthSandbox, (file, s) => {
            const without = (cmds) => cmds.split(',').reduce((p, cmd) => noCmdPath(join(root, gate, 'paths', cmds, cmd), cmd, p), `${join(s, 'bin')}:${path}`);
            const c = healthCase(file, s, without);
            const tmp = join(s, '..', 'tmp');
            mkdirSync(tmp, { recursive: true });
            return { input: c.input, env: noInstall(healthEnv(s, tmp, LOCALE, c.env, c.cwd)), cwd: c.cwd, golden: golden(file, s, c.divergence !== undefined) };
        });
    }
    for (const gate of ['plugin-hooks-marker', 'session-start-persona', 'user-prompt-persona', 'activation-routine', 'session-log-capture']) {
        const dir = join(root, gate, 'sandbox');
        rebuilt(gate, dir, sessionSandbox, (file) => {
            const c = sessionCase(file, dir, corpusPaths().noJq);
            return { input: c.input, env: noInstall(sessionEnv(dir, LOCALE, c.env, c.cwd)), cwd: c.cwd, golden: golden(file, dir, false) };
        });
    }
    for (const gate of ['orphan-scan', 'session-start-prescan']) {
        restored(gate, (s) => buildSessionScansSandbox(s, process.pid), (file, s) => {
            const c = sessionScanCase(file, s, corpusPaths());
            return {
                input: c.input,
                env: noInstall(sessionScanEnv(s, gate, LOCALE, c.env, c.cwd)),
                cwd: c.cwd,
                golden: golden(file, s, c.divergent !== undefined, { '@SLUG@': projectSlug(join(s, 'project')), '@OTHER_SLUG@': projectSlug(join(s, 'other')) }),
            };
        });
    }
    const promptIntentDir = join(root, 'prompt-intent-hints/sandbox');
    rebuilt('prompt-intent-hints', promptIntentDir, promptIntentSandbox, (file) => {
        const c = sweRunCase(file, promptIntentDir, corpusPaths());
        return { input: c.input, env: promptIntentEnv(promptIntentDir, LOCALE, c.env, c.cwd), cwd: c.cwd, golden: golden(file, promptIntentDir, c.divergent !== undefined) };
    });
    const slashDir = join(root, 'roundtable-slash-detect/sandbox');
    rebuilt('roundtable-slash-detect', slashDir, roundtableSandbox, (file) => {
        const c = roundtableCase(file, slashDir, corpusPaths());
        return { input: c.input, env: roundtableEnv(slashDir, LOCALE, c.env, c.cwd), cwd: c.cwd, golden: golden(file, slashDir, c.divergent !== undefined) };
    });
    restored('worktree-create', worktreeSandbox, (file, s) => {
        const c = worktreeCase(file, s, corpusPaths());
        return { input: c.input, env: worktreeEnv(s, LOCALE, c), cwd: c.cwd, golden: golden(file, s, c.divergent !== undefined) };
    });
    if (want('ensure-mcp-deps-installed')) {
        const scratch = join(root, 'ensure-mcp-deps-installed');
        const env = readyDepsEnv(scratch);
        for (const file of files('ensure-mcp-deps-installed')) {
            cases.push({
                gate: 'ensure-mcp-deps-installed',
                file,
                input: readFileSync(file, 'utf8'),
                env: clean({ ...process.env, HOME: join(scratch, 'home'), CLAUDE_PROJECT_DIR: emptyProject, LC_ALL: LOCALE, TMB_DRIFT_SELF_PID: '1', ...env }, ['NODE_OPTIONS', 'TRAJECTORY_DB_PATH']),
                cwd: emptyProject,
                fakeUid: false,
                golden: { key: `${GENERIC_CASE_PREFIX}${basename(file)}`, roots: { '@PROJECT@': emptyProject, '@SCRATCH@': scratch, '@PROJECT_SLUG@': emptyProject.replace(/[^A-Za-z0-9]/g, '-') }, divergent: false },
            });
        }
    }
    if (want('rework-waiver-capture'))
        cases.push(...reworkWaiverCases(join(root, 'rework-waiver-capture'), emptyProject));
    // In-process, post-task-close-rescan's invoker is the real one: its launch is proven in hooks-task-close-parity.
    return {
        cases: cases.map((c) => ({ ...c, env: { ...c.env, TMB_SKIP_AUTO_RESCAN: '1' } })),
        cleanup: () => {
            for (const f of cleanups)
                f();
            rmSync(root, { recursive: true, force: true });
        },
    };
}
/** task-overrun-alert's cases, on a DB holding at most one running task of the given age, rebuilt per case. */
function overrunCases(dir, cwd) {
    const db = join(dir, 'trajectory.db');
    mkdirSync(dir, { recursive: true });
    const schema = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
    const build = (createdAt) => {
        for (const side of ['', '-wal', '-shm', '-journal'])
            rmSync(`${db}${side}`, { force: true });
        const d = new DatabaseSync(db);
        d.exec(schema);
        d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(SWE_RESUME_T0, SWE_RESUME_T0);
        if (createdAt !== null)
            d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (3, 9, 'feat/3-x', 'd', 'running', ?, ?)").run(createdAt, createdAt);
        d.close();
    };
    const env = clean({ PATH: process.env.PATH, HOME: join(dir, 'home'), TRAJECTORY_DB_PATH: db, LC_ALL: LOCALE });
    const payload = (extra) => JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'mcp__plugin_tmb_trajectory-server__task_list', tool_input: {}, ...extra });
    const longAgo = '2020-01-01T00:00:00.000Z';
    const scenarios = [
        ['overrun-alerts-bro', longAgo, payload({})],
        ['overrun-non-bro-caller', longAgo, payload({ agent_type: 'tmb:swe', agent_id: 'a1' })],
        ['under-threshold', () => new Date().toISOString(), payload({})],
        ['no-running-task', null, payload({})],
    ];
    return scenarios.map(([file, createdAt, input]) => ({
        gate: 'task-overrun-alert',
        file,
        input,
        env,
        cwd,
        fakeUid: false,
        reset: () => build(typeof createdAt === 'function' ? createdAt() : createdAt),
    }));
}
/** session-handoff's Stop cases, on a DB holding one bro row of the given tool calls and at most one open swe run, rebuilt per case. */
function sessionHandoffCases(dir, cwd) {
    const db = join(dir, 'trajectory.db');
    mkdirSync(dir, { recursive: true });
    const schema = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
    const sessionId = 'sess-handoff';
    const build = (toolUses, openRun) => {
        for (const side of ['', '-wal', '-shm', '-journal'])
            rmSync(`${db}${side}`, { force: true });
        const d = new DatabaseSync(db);
        d.exec(schema);
        d.prepare("INSERT INTO agent_runs (agent_type, session_id, tool_uses, started_at, completed_at) VALUES ('bro', ?, ?, ?, ?)").run(sessionId, toolUses, SWE_RESUME_T0, SWE_RESUME_T0);
        if (openRun)
            d.prepare("INSERT INTO agent_runs (agent_type, session_id, started_at) VALUES ('swe', ?, ?)").run(sessionId, new Date().toISOString());
        d.close();
    };
    const env = clean({ PATH: process.env.PATH, HOME: join(dir, 'home'), TRAJECTORY_DB_PATH: db, LC_ALL: LOCALE });
    const payload = (extra) => JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, cwd, last_assistant_message: 'note', ...extra });
    const scenarios = [
        ['past-limits-notice', 151, false, payload({})],
        ['under-limits', 1, false, payload({})],
        ['open-run', 151, true, payload({})],
        ['hook-active', 151, false, payload({ stop_hook_active: true })],
        ['background-task', 151, false, payload({ background_tasks: [{ id: 'b' }] })],
    ];
    return scenarios.map(([file, toolUses, openRun, input]) => ({ gate: 'session-handoff', file, input, env, cwd, fakeUid: false, reset: () => build(toolUses, openRun) }));
}
/** liveness-alert's cases, on a DB holding at most one open swe run of the given start, DB and throttle state rebuilt per case. */
function livenessCases(dir, cwd) {
    const db = join(dir, 'trajectory.db');
    mkdirSync(dir, { recursive: true });
    const schema = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
    const build = (startedAt) => {
        for (const side of ['', '-wal', '-shm', '-journal'])
            rmSync(`${db}${side}`, { force: true });
        rmSync(join(dir, 'sessions'), { recursive: true, force: true });
        const d = new DatabaseSync(db);
        d.exec(schema);
        d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(SWE_RESUME_T0, SWE_RESUME_T0);
        if (startedAt !== null)
            d.prepare("INSERT INTO agent_runs (issue_id, agent_type, started_at, spawn_id, session_id) VALUES (9, 'swe', ?, 'agent-swe-1', 's')").run(startedAt);
        d.close();
    };
    const env = clean({ PATH: process.env.PATH, HOME: join(dir, 'home'), TRAJECTORY_DB_PATH: db, LC_ALL: LOCALE });
    const payload = (extra) => JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'mcp__plugin_tmb_trajectory-server__task_list', tool_input: {}, ...extra });
    const longAgo = '2020-01-01T00:00:00.000Z';
    const scenarios = [
        ['dead-run-reports-to-bro', longAgo, payload({})],
        ['non-bro-caller', longAgo, payload({ agent_type: 'tmb:swe', agent_id: 'a1' })],
        ['recent-run', () => new Date().toISOString(), payload({})],
        ['no-open-run', null, payload({})],
    ];
    return scenarios.map(([file, startedAt, input]) => ({
        gate: 'liveness-alert',
        file,
        input,
        env,
        cwd,
        fakeUid: false,
        reset: () => build(typeof startedAt === 'function' ? startedAt() : startedAt),
    }));
}
/** rework-waiver-capture's cases, on a DB holding task 3 of issue 9, rebuilt per case. */
function reworkWaiverCases(dir, cwd) {
    const db = join(dir, 'trajectory.db');
    mkdirSync(dir, { recursive: true });
    const schema = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
    const build = () => {
        for (const side of ['', '-wal', '-shm', '-journal'])
            rmSync(`${db}${side}`, { force: true });
        const d = new DatabaseSync(db);
        d.exec(schema);
        d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(SWE_RESUME_T0, SWE_RESUME_T0);
        d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (3, 9, 'feat/3-x', 'd', 'closed', ?, ?)").run(SWE_RESUME_T0, SWE_RESUME_T0);
        d.close();
    };
    const env = clean({ PATH: process.env.PATH, HOME: join(dir, 'home'), TRAJECTORY_DB_PATH: db, LC_ALL: LOCALE });
    const scenarios = [
        ['waives-a-task', 'waive task 3'],
        ['waives-with-hash', 'please Waive task #3, it is fine'],
        ['waives-an-unknown-task', 'waive task 999'],
        ['other-wording', 'skip the rework on task 3'],
    ];
    return scenarios.map(([file, prompt]) => ({
        gate: 'rework-waiver-capture',
        file,
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt }),
        env,
        cwd,
        fakeUid: false,
        reset: build,
    }));
}
const SWE_RESUME_T0 = '2026-10-25T09:00:00.000Z';
/** swe-resume-gate's cases, on a DB holding one swe and one code-reviewer of task 3, rebuilt per case. */
function sweResumeCases(dir, cwd) {
    const db = join(dir, 'trajectory.db');
    mkdirSync(dir, { recursive: true });
    const schema = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
    const build = (runEffort, fails) => {
        rmSync(db, { force: true });
        const d = new DatabaseSync(db);
        d.exec(schema);
        d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(SWE_RESUME_T0, SWE_RESUME_T0);
        d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, effort, created_at, updated_at) VALUES (3, 9, 'feat/3-x', 'd', 'running', 'medium', ?, ?)").run(SWE_RESUME_T0, SWE_RESUME_T0);
        d.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, spawn_id, effort, exit_reason) VALUES (3, 9, 'swe', ?, ?, 'agent-swe-1', ?, 'completed')").run(SWE_RESUME_T0, SWE_RESUME_T0, runEffort);
        d.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id) VALUES (3, 9, 'code-reviewer', ?, 'agent-reviewer-1')").run(SWE_RESUME_T0);
        for (let i = 1; i <= fails; i++) {
            d.prepare("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (3, ?, 'code-reviewer', 'fail', 'f', 1, ?)").run(i, `2026-10-25T10:0${i}:00.000Z`);
        }
        d.close();
    };
    const env = clean({ PATH: process.env.PATH, HOME: join(dir, 'home'), TRAJECTORY_DB_PATH: db, LC_ALL: LOCALE });
    const scenarios = [
        ['resume-allowed', 'agent-swe-1', 'medium', 0],
        ['resume-at-rework-limit', 'agent-swe-1', 'medium', 2],
        ['resume-effort-mismatch', 'agent-swe-1', 'high', 0],
        ['not-a-swe', 'agent-reviewer-1', 'medium', 2],
    ];
    return scenarios.map(([file, to, effort, fails]) => ({
        gate: 'swe-resume-gate',
        file,
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to, message: 'fix the FAIL findings' } }),
        env,
        cwd,
        fakeUid: false,
        reset: () => build(effort, fails),
    }));
}
/** no-prose-in-scratch's cases: each kind of target and of body file, with a git repo inside the TMPDIR zone. */
function noProseCases(dir, cwd) {
    const tmp = join(dir, 'tmp');
    const repo = join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    const env = clean({ PATH: process.env.PATH, HOME: join(dir, 'home'), TMPDIR: tmp, LC_ALL: LOCALE });
    const write = (filePath) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } });
    const shell = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command } });
    const scenarios = [
        ['write-scratch-prose', write(join(cwd, '.claude/tmb/scratch/plan.md'))],
        ['write-tmp-prose', write(join(tmp, 'x.md'))],
        ['write-tmp-log', write(join(tmp, 'x.log'))],
        ['write-repo-prose', write(join(repo, 'README.md'))],
        ['bash-tmp-prose', shell(`echo hi > ${tmp}/x.txt`)],
        ['bash-tmp-rm', shell(`rm ${tmp}/x.md`)],
        ['bash-body-file', shell('gh issue edit 1 --body-file b.md')],
        ['bash-body-stdin', shell('gh issue edit 1 --body-file - <<EOF\nhi\nEOF')],
    ];
    return scenarios.map(([file, input]) => ({ gate: 'no-prose-in-scratch', file, input, env, cwd, fakeUid: false }));
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