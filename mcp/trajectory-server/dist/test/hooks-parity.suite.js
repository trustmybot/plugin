/**
 * Bash-vs-node parity for the TypeScript hook gates (GH 1692): every corpus
 * payload in tests/fixtures/hook-corpus/<gate>/ gives the same exit code and
 * the same stdout (empty, or deep-equal JSON) through
 * `node dist/hooks.js <gate>` as the recording of `bash scripts/hooks/<gate>.sh`
 * in tests/fixtures/hook-golden/<gate>.json (golden.ts), and a gate that audits
 * writes the same audit rows (id and created_at aside). A gate
 * born in TypeScript, with no scripts/hooks/<gate>.sh to port from
 * (code-reviewer-preflight, code-reviewer-spawn-note, rework-limit,
 * rework-waiver-capture, swe-resume-gate, task-overrun-alert), has no bash side
 * and is not in the parity set.
 * The gate × payload × locale runs split across
 * hooks-parity.shard-<k>of<n>.test.ts (GH 1947); shard 1 also runs the
 * whole-corpus checks, and each shard checks its own sandbox stayed untouched.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gateNames } from '../hooks/registry.js';
import { TRANSFORMERS_VERSION } from '../runtime-deps.js';
import { LINT_GATES, lintSandbox } from './lint-hooks-sandbox.js';
import { GENERIC_CASE_PREFIX, goldenBash, goldenRoots, hasGolden, isRecording } from './golden.js';
import { shardOf } from './shard.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const MIN_CORPUS = 8;
const PARITY_GATES = gateNames().filter((gate) => (isRecording() ? existsSync(join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)) : hasGolden(gate)));
const LOCALES = ['C', 'en_US.UTF-8', 'UTF-8'];
const FAKE_UID = 4242424;
function corpusFiles(root, gate) {
    const dir = join(root, gate);
    if (!existsSync(dir))
        return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f));
}
function corpusProblems(gates, root) {
    return gates.flatMap((gate) => {
        const n = corpusFiles(root, gate).length;
        return n >= MIN_CORPUS ? [] : [`${gate}: ${n} corpus inputs in ${join(root, gate)}, need at least ${MIN_CORPUS}`];
    });
}
function run(cmd, args, input, env, cwd) {
    const r = spawnSync(cmd, args, { input, env, cwd, encoding: 'utf8', timeout: 20_000 });
    if (r.error)
        throw r.error;
    return { code: r.status, stdout: r.stdout };
}
function parsedStdout(stdout) {
    return stdout.trim() === '' ? null : JSON.parse(stdout);
}
/**
 * ensure-mcp-deps-installed runs in the ready state: a temp plugin root whose
 * MCP dir resolves @huggingface/transformers at the pinned version, and an
 * empty temp data dir, so neither implementation installs anything.
 */
function readyDepsEnv(scratch) {
    const root = join(scratch, 'ready-root');
    const mcp = join(root, 'mcp/trajectory-server');
    const pkg = join(root, 'node_modules/@huggingface/transformers');
    mkdirSync(mcp, { recursive: true });
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    mkdirSync(join(scratch, 'data'), { recursive: true });
    writeFileSync(join(mcp, 'package.json'), JSON.stringify({ name: 'traj', type: 'module' }));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
        name: '@huggingface/transformers',
        version: TRANSFORMERS_VERSION,
        exports: { node: { import: { default: './dist/transformers.node.mjs' }, require: { default: './dist/transformers.node.cjs' } } },
    }));
    writeFileSync(join(pkg, 'dist/transformers.node.mjs'), 'export const pipeline = 1;\n');
    writeFileSync(join(pkg, 'dist/transformers.node.cjs'), 'exports.pipeline = 1;\n');
    return { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: join(scratch, 'data') };
}
const NOW = '2026-10-11T10:00:00.000Z';
/**
 * containment-guard runs against the l3 suite's sandbox: a project whose DB
 * (src/schema.sql) holds a running swe task 5 with its worktree and an
 * agent_run bound to agent_id agent-cg, a spawn transcript naming task_id=5,
 * a model cache, a host TMPDIR, a Claude Code config dir and a fake uid (an
 * `id` shim for bash, a process.getuid preload for node), so
 * /tmp/claude-<uid> never covers the sandbox. Corpus payloads name it as
 * @SANDBOX@ and the project's Claude Code slug as @PROJECT_SLUG@; a payload's
 * top-level corpus_env (removed before the run) overrides the env.
 */
export function containmentGuardSetup(scratch) {
    const project = join(scratch, 'project');
    const wt = join(project, '.claude/worktrees/cg-task');
    const db = join(project, '.claude/tmb/trajectory.db');
    const shim = join(scratch, 'shim');
    for (const dir of [join(wt, 'src'), dirname(db), shim, join(scratch, 'cache'), join(scratch, 'host-tmp'), join(scratch, 'home'), join(scratch, 'cc'), join(scratch, 'no-db'), join(scratch, 'outside')]) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(shim, 'id'), `#!/bin/sh\n[ "$1" = -u ] && { echo ${FAKE_UID}; exit 0; }\nexec /usr/bin/id "$@"\n`);
    chmodSync(join(shim, 'id'), 0o755);
    const d = new DatabaseSync(db);
    d.exec(readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
    d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', project);
    d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'containment', 'open', ?, ?)").run(NOW, NOW);
    d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo) VALUES (5, 7, 'feat/cg-task', 'd', 'running', ?, ?, 'project')").run(NOW, NOW);
    d.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, root_dir, host, spawn_id) VALUES (5, 7, 'swe', ?, ?, 'claude', 'agent-cg')").run(NOW, wt);
    d.close();
    writeFileSync(join(scratch, 'spawn-5.jsonl'), '{"message":{"content":[{"type":"text","text":"task_id=5"}]}}\n');
    const slug = project.replace(/[^A-Za-z0-9]/g, '-');
    return {
        env: {
            CLAUDE_PROJECT_DIR: project,
            CLAUDE_CONFIG_DIR: join(scratch, 'cc'),
            TRAJECTORY_DB_PATH: undefined,
            HF_HOME: undefined,
            HOME: join(scratch, 'home'),
            TMB_MODEL_CACHE_DIR: join(scratch, 'cache'),
            TMPDIR: join(scratch, 'host-tmp'),
            PATH: `${shim}:${process.env.PATH ?? ''}`,
            PWD: project,
            NODE_OPTIONS: `--import ${join(PLUGIN_ROOT, 'tests/lib/fake-uid.mjs')}`,
        },
        cwd: project,
        auditDb: db,
        materialize: (raw) => {
            const text = raw.toString('utf8').replaceAll('@SANDBOX@', scratch).replaceAll('@PROJECT_SLUG@', slug);
            let parsed;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                return { input: Buffer.from(text), env: {} };
            }
            const { corpus_env: env = {}, ...payload } = parsed;
            return { input: Buffer.from(JSON.stringify(payload)), env };
        },
    };
}
/** The lint hooks run in lint-hooks-sandbox.ts, gh and glab stubbed so attribution-footer never reaches a forge. */
function lintSetup(scratch) {
    const sandbox = lintSandbox(scratch);
    return { env: sandbox.env, materialize: (raw) => sandbox.materialize(raw) };
}
const GATE_SETUP = {
    'ensure-mcp-deps-installed': (scratch) => ({ env: readyDepsEnv(scratch) }),
    'containment-guard': containmentGuardSetup,
    ...Object.fromEntries(LINT_GATES.map((gate) => [gate, lintSetup])),
};
function auditMark(db) {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
        return Number(d.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit').get().n);
    }
    finally {
        d.close();
    }
}
function auditRowsAfter(db, mark) {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
        return d
            .prepare('SELECT issue_id, branch_id, from_node, event_type, summary, content_json FROM audit WHERE id > ? ORDER BY id')
            .all(mark)
            .map((row) => ({ ...row }));
    }
    finally {
        d.close();
    }
}
/**
 * Gates that write markers, logs or DB rows into the project, or read the
 * host's processes and installs, so they run in hooks-session-parity.suite.ts
 * or hooks-health-parity.suite.ts, which rebuild their sandbox before each side;
 * and the task-DB Agent-spawn gates, which read a sandbox of git repos and
 * trajectory DBs in hooks-spawn-gates-parity.suite.ts; remote-id-guard,
 * which reads a sandbox DB of local issues in
 * hooks-remote-id-guard-parity.suite.ts; and no-source-edit-from-main, which
 * reads registered repos and plugin manifests in
 * hooks-no-source-edit-parity.suite.ts.
 */
const OWN_SANDBOX_GATES = new Set([
    'activation-routine',
    'bro-turn-usage',
    'debug-trajectory',
    'deferred-tools-drift-warn',
    'ensure-gitignore',
    'mcp-health-check',
    'plugin-hooks-marker',
    'require-feature-branch-active',
    'require-spawn-effort',
    'require-task-spec',
    'session-log-capture',
    'session-start-persona',
    'substrate-preflight',
    'user-prompt-persona',
    'consultant-persistence-gate',
    'roundtable-auq-shape',
    'roundtable-cleanup-postcheck',
    'roundtable-slash-detect',
    'code-reviewer-no-worktree',
    'code-reviewer-spawn-prompt-shape',
    'code-reviewer-after-atomic-close',
    'swe-brief-gate',
    'swe-spawn-bind',
    'swe-spawn-rollback',
    'post-task-create-spawn-hint',
    'agent-arg-matches-caller',
    'reviewer-identity-observe',
    'cheatcode-install-approval',
    'stay-on-base-guard',
    'branch-up-to-date-with-remote',
    'no-worktree-branch-create',
    'no-remote-auth-guard',
    'prompt-intent-hints',
    'swe-scope-fence',
    'orphan-scan',
    'session-start-prescan',
    'clean-merged-branch',
    'close-issue-on-merge',
    'swe-atomic-close',
    'post-task-close-rescan',
    'swe-verification-gate',
    'post-atomic-close-readme',
    'agent-spawn-dispatch',
    'ensure-swe-worktree',
    'record-swe-spawn',
    'cleanup-worktree-on-task-close',
    'worktree-create',
    'remote-id-guard',
    'no-source-edit-from-main',
]);
function parityCases() {
    return PARITY_GATES.filter((gate) => !OWN_SANDBOX_GATES.has(gate)).flatMap((gate) => corpusFiles(CORPUS_ROOT, gate).flatMap((file) => LOCALES.map((locale) => ({ gate, file, locale }))));
}
export function hooksParityShard(k, n) {
    const cases = shardOf(parityCases(), k, n);
    describe(`hooks parity: bash vs node over the corpus (shard ${k} of ${n})`, () => {
        let project;
        let scratch;
        const setups = new Map();
        before(() => {
            project = mkdtempSync(join(tmpdir(), 'tmb-hooks-parity-'));
            scratch = mkdtempSync(join(tmpdir(), 'tmb-hooks-parity-scratch-'));
            for (const [gate, build] of Object.entries(GATE_SETUP))
                setups.set(gate, build(join(scratch, gate)));
        });
        after(() => {
            rmSync(project, { recursive: true, force: true });
            rmSync(scratch, { recursive: true, force: true });
        });
        if (k === 1) {
            it('every registered gate with a bash twin has a corpus of at least 8 inputs', () => {
                assert.ok(PARITY_GATES.length > 0, 'the registry lists no gate with a bash twin');
                assert.deepEqual(corpusProblems(PARITY_GATES, CORPUS_ROOT), []);
            });
            it('the gates born in TypeScript are the only registered gates without a bash twin', () => {
                assert.deepEqual(gateNames().filter((gate) => !PARITY_GATES.includes(gate)), [
                    'code-reviewer-preflight',
                    'code-reviewer-spawn-note',
                    'rework-limit',
                    'rework-waiver-capture',
                    'swe-resume-gate',
                    'swe-stop-cause',
                    'task-overrun-alert',
                    'tool-output-size',
                ]);
            });
            it('self-test: a registered gate without a corpus, or with too few inputs, fails the check', () => {
                const root = mkdtempSync(join(tmpdir(), 'tmb-hooks-corpus-'));
                try {
                    mkdirSync(join(root, 'thin-gate'));
                    for (let i = 0; i < MIN_CORPUS - 1; i++)
                        writeFileSync(join(root, 'thin-gate', `${i}.json`), '{}');
                    const problems = corpusProblems(['no-corpus-gate', 'thin-gate'], root);
                    assert.equal(problems.length, 2);
                    assert.match(problems[0], /^no-corpus-gate: 0 corpus inputs/);
                    assert.match(problems[1], /^thin-gate: 7 corpus inputs/);
                }
                finally {
                    rmSync(root, { recursive: true, force: true });
                }
            });
        }
        for (const { gate, file, locale } of cases) {
            it(`${gate} / ${file.slice(CORPUS_ROOT.length + gate.length + 2)} (LC_ALL=${locale})`, () => {
                const setup = setups.get(gate);
                const raw = readFileSync(file);
                const { input, env: payloadEnv } = setup?.materialize?.(raw) ?? { input: raw, env: {} };
                const env = {
                    ...process.env,
                    CLAUDE_PROJECT_DIR: project,
                    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
                    LC_ALL: locale,
                    ...setup?.env,
                    ...payloadEnv,
                };
                const db = setup?.auditDb;
                const { audit: bashAudit, ...bash } = goldenBash(gate, `${GENERIC_CASE_PREFIX}${basename(file)}`, locale, goldenRoots({ '@PROJECT@': project, '@SCRATCH@': scratch, '@PROJECT_SLUG@': (setup?.cwd ?? project).replace(/[^A-Za-z0-9]/g, '-') }), () => {
                    const start = db ? auditMark(db) : 0;
                    return { ...run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], input, env, setup?.cwd), audit: db ? auditRowsAfter(db, start) : [] };
                });
                const middle = db ? auditMark(db) : 0;
                const node = run(process.execPath, [HOOKS_BUNDLE, gate], input, env, setup?.cwd);
                assert.equal(node.code, bash.code, 'exit code');
                assert.deepEqual(parsedStdout(node.stdout), parsedStdout(bash.stdout), 'stdout');
                if (db)
                    assert.deepEqual(auditRowsAfter(db, middle), bashAudit, 'audit rows');
            });
        }
        it('the parity runs left the isolated project and the ready-state data dir untouched', () => {
            assert.deepEqual(readdirSync(project), []);
            assert.deepEqual(readdirSync(join(scratch, 'ensure-mcp-deps-installed/data')), []);
        });
    });
}
//# sourceMappingURL=hooks-parity.suite.js.map