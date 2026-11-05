/**
 * `cli.js integrate` (GH 1518, GH 1692), ported with every assertion of the
 * former integrate-script L3 suite: bro's post-review rebase of a task's
 * branch in a temporary worktree.
 *
 * Each case builds a temp repo (main + the task branch feat/x-1) and a
 * trajectory DB holding task 1 with a passing review for its commit_sha, then
 * runs `cli.js integrate 1 <base>` against the built bundle and checks the exit
 * code, the SHA it prints, the branch ref, the verification_runs rows and that
 * no temporary worktree is left.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gitGuards } from '../hooks/git-guards.js';
import { installRoot } from '../hooks/lib/project-env.js';
const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const HOOKS = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
};
const PASSING = '["test -f a.txt", "test -f m.txt"]';
const FAILING = '["test -f a.txt", "echo broken; exit 7"]';
// The second command runs in the temp worktree <repo>/.claude/worktrees/integrate-1.*,
// so ../../tmb is <repo>/.claude/tmb.
const SLOW = '["test -f a.txt", "touch ../../tmb/cmd-started; sleep 2"]';
const NODE_MODULES_PASSING = '["test -f node_modules/marker", "test -f pkg/node_modules/marker", "test ! -e other/node_modules"]';
const NODE_MODULES_FAILING = '["test -f node_modules/marker", "test -f pkg/node_modules/marker", "exit 5"]';
const REGEN_OK = `const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const root = path.resolve(path.dirname(process.argv[1]), "../..");
const src = path.join(root, "src");
const names = fs.readdirSync(src).filter((n) => n.endsWith(".txt")).sort();
fs.writeFileSync(path.join(root, "gen/out.txt"), names.map((n) => fs.readFileSync(path.join(src, n), "utf8")).join(""));
`;
const REGEN_HASHED = `const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const crypto = process.getBuiltinModule("node:crypto");
const root = path.resolve(path.dirname(process.argv[1]), "../..");
const src = path.join(root, "src");
const gen = path.join(root, "gen");
const names = fs.readdirSync(src).filter((n) => n.endsWith(".txt")).sort();
const body = names.map((n) => fs.readFileSync(path.join(src, n), "utf8")).join("");
const hash = crypto.createHash("sha1").update(body).digest("hex").slice(0, 8);
for (const n of fs.readdirSync(gen)) fs.rmSync(path.join(gen, n));
fs.writeFileSync(path.join(gen, "chunk-" + hash + ".txt"), hash + "\\n");
fs.writeFileSync(path.join(gen, "out.txt"), "chunk-" + hash + ".txt\\n" + body);
fs.writeFileSync(path.join(root, "regen.log"), "regenerated\\n");
`;
const REGEN_FAIL = `process.stderr.write("regen-generated: toolchain missing\\n");
process.exit(2);
`;
const REGEN_RUN = 'node --experimental-strip-types --no-warnings scripts/maintenance/regen-generated.ts';
const REGEN_PASSING = JSON.stringify(['grep -q l4-task src/s.txt', `${REGEN_RUN} && git diff --exit-code -- gen`]);
let repo = '';
let db = '';
let base0 = '';
let commit = '';
function git(...args) {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.replace(/\n+$/, '');
}
function rev(ref) {
    const r = spawnSync('git', ['-C', repo, 'rev-parse', ref], { encoding: 'utf8', env: GIT_ENV });
    return r.status === 0 ? r.stdout.trim() : '';
}
function commitFile(file, content, msg = `feat: ${file}`) {
    writeFileSync(join(repo, file), `${content}\n`);
    git('add', file);
    git('commit', '-qm', msg);
}
function q(sql) {
    const d = new DatabaseSync(db);
    try {
        const rows = d.prepare(sql).all();
        return rows.map((row) => Object.values(row).map((v) => (v === null ? '' : String(v))).join('|')).join('\n');
    }
    finally {
        d.close();
    }
}
function exec(sql) {
    const d = new DatabaseSync(db);
    try {
        d.exec(sql);
    }
    finally {
        d.close();
    }
}
function pointTaskAt(sha) {
    exec(`UPDATE tasks SET commit_sha = '${sha}';
        UPDATE audit SET content_json = '{"task_id":1,"commit_sha":"${sha}"}';`);
}
// main gets README (base0); feat/x-1 adds a.txt (commit); then main moves:
//   clean    — m.txt
//   conflict — a.txt with other content
//   same     — the task's exact a.txt change (a rebase drops the task commit)
function setup(move, verification = PASSING) {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-integrate-')));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    commitFile('README.md', 'init');
    base0 = rev('HEAD');
    git('checkout', '-q', '-b', 'feat/x-1');
    commitFile('a.txt', 'task');
    commit = rev('HEAD');
    git('checkout', '-q', 'main');
    if (move === 'clean')
        commitFile('m.txt', 'moved');
    if (move === 'conflict')
        commitFile('a.txt', 'other');
    if (move === 'same')
        commitFile('a.txt', 'task', 'chore: land a.txt on main');
    db = join(repo, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(db), { recursive: true });
    const d = new DatabaseSync(db);
    try {
        d.exec(SCHEMA);
        d.prepare(`INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('repo', ?, 'main', 'github-flow', '["main"]')`).run(repo);
        d.exec(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'test', 'test', 'open', '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');`);
        d.prepare(`INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, repo, verification, created_at, updated_at)
       VALUES (1, 1, 'feat/x-1', 'task 1', 'd', 'closed', '## body', ?, 'repo', ?, '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z')`).run(commit, verification);
        d.prepare(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (1, 'feat/x-1', 'bro', 'bro_verification_pass', 'v', ?, '2026-10-19T01:00:00.000Z')`).run(JSON.stringify({ task_id: 1, commit_sha: commit }));
        d.exec(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
      VALUES (1, 1, 'code-reviewer', 'pass', 1, 'LGTM', '2026-10-19T02:00:00.000Z');`);
    }
    finally {
        d.close();
    }
}
function cliEnv() {
    const env = { ...GIT_ENV, TRAJECTORY_DB_PATH: db, PWD: repo };
    delete env.TMB_VERIFICATION_TIMEOUT_S;
    return env;
}
function integrate(base) {
    const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'integrate', '1', base], { cwd: repo, encoding: 'utf8', env: cliEnv() });
    return { code: r.status, out: r.stdout.replace(/\n+$/, ''), err: r.stderr };
}
function assertNoTempWorktree() {
    assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'worktrees after the run');
    const dir = join(repo, '.claude/worktrees');
    const left = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('integrate-')) : [];
    assert.deepEqual(left, [], 'integrate-* dirs left behind');
}
afterEach(() => {
    if (repo !== '')
        rmSync(repo, { recursive: true, force: true });
    repo = '';
});
describe('cli.js integrate', () => {
    it('clean rebase: records a passing manual run on the new SHA and moves the branch', () => {
        setup('clean');
        const r = integrate('main');
        assert.equal(r.code, 0, r.err);
        const next = r.out;
        assert.equal(rev('refs/heads/feat/x-1'), next, 'feat/x-1 tip');
        assert.equal(rev(`${next}^`), rev('main'), "the rebased commit's parent is main");
        assert.notEqual(next, commit, 'the printed SHA is the original commit');
        assert.equal(q(`SELECT COUNT(*) FROM verification_runs WHERE commit_sha = '${next}'`), '1', 'verification_runs rows for the new SHA');
        assert.equal(q(`SELECT task_id || '|' || source || '|' || exit_code || '|' || timed_out FROM verification_runs WHERE commit_sha = '${next}'`), '1|manual|0|0', 'the run row');
        assert.equal(q(`SELECT COUNT(*) FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.commit_sha = '${next}' AND c.exit_code = 0`), '2', 'both commands recorded as passing');
        assert.equal(q('SELECT commit_sha FROM tasks WHERE id = 1'), commit, 'tasks.commit_sha keeps the reviewed commit');
        assert.match(r.err, /^integrate: feat\/x-1 -> [0-9a-f]{40} \(verification run #1 passed\)$/m);
        assert.equal(git('reflog', '-1', '--format=%gs', 'refs/heads/feat/x-1'), 'cli.js integrate: task 1 onto main', 'the reflog names the subcommand');
        assertNoTempWorktree();
    });
    it('conflict: exit 2, branch and verification_runs unchanged', () => {
        setup('conflict');
        const r = integrate('main');
        assert.equal(r.code, 2, r.err);
        assert.equal(r.out, '', 'nothing on stdout');
        assert.match(r.err, /conflicted/, 'stderr names the conflict');
        assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
        assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
        assertNoTempWorktree();
    });
    it("patch drift: the task's change already on main → exit 2, nothing recorded", () => {
        setup('same');
        const r = integrate('main');
        assert.equal(r.code, 2, r.err);
        assert.match(r.err, /patch/, 'stderr names the patch-id mismatch');
        assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
        assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
        assertNoTempWorktree();
    });
    it('stacked on a squash-merged parent branch: not drift, exit 0 (GH 1666)', () => {
        setup('none');
        git('branch', '-q', '-D', 'feat/x-1');
        git('checkout', '-q', '-b', 'feat/parent');
        commitFile('p.txt', 'parent');
        git('checkout', '-q', '-b', 'feat/x-1');
        commitFile('a.txt', 'task');
        commit = rev('HEAD');
        git('checkout', '-q', 'main');
        git('merge', '-q', '--squash', 'feat/parent');
        git('commit', '-qm', 'feat: parent (squash)');
        commitFile('m.txt', 'moved');
        pointTaskAt(commit);
        const r = integrate('main');
        assert.equal(r.code, 0, r.err);
        const next = r.out;
        assert.equal(rev(`${next}^`), rev('main'), "the rebased commit's parent is main");
        assert.equal(git('diff', `${next}^`, next, '--name-only'), 'a.txt', 'the rebased commit changes only a.txt');
        assert.equal(rev('refs/heads/feat/x-1'), next, 'feat/x-1 tip');
        assert.equal(q(`SELECT COUNT(*) || '|' || MAX(source) || '|' || MAX(exit_code) FROM verification_runs WHERE commit_sha = '${next}'`), '1|manual|0', 'a passing manual run on the printed SHA');
        assertNoTempWorktree();
    });
    it('failing verification: exit 1, the failing run is recorded, branch unmoved', () => {
        setup('clean', FAILING);
        const r = integrate('main');
        assert.equal(r.code, 1, r.err);
        assert.equal(r.out, '', 'nothing on stdout');
        assert.ok(r.err.includes('echo broken; exit 7'), 'stderr names the failing command');
        assert.match(r.err, /^broken$/m, "stderr carries the command's output tail");
        assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
        assert.equal(q(`SELECT COUNT(*) || '|' || MAX(source) || '|' || MAX(exit_code) FROM verification_runs WHERE task_id = 1 AND commit_sha <> '${commit}'`), '1|manual|7', 'one failing manual run on the rebased SHA');
        assert.equal(q('SELECT exit_code FROM verification_run_commands WHERE ordinal = 2'), '7', "the failing command's row");
        assertNoTempWorktree();
    });
    for (const [signal, want] of [
        ['SIGTERM', 143],
        ['SIGINT', 130],
    ]) {
        it(`${signal} during a verification command: exit ${want}, the run finished as ${want}, temp worktree removed (GH 1814)`, async () => {
            setup('clean', SLOW);
            const child = spawn(process.execPath, ['--experimental-sqlite', CLI, 'integrate', '1', 'main'], { cwd: repo, env: cliEnv(), stdio: 'ignore' });
            const exited = new Promise((done) => child.on('exit', (code) => done(code)));
            const started = join(repo, '.claude/tmb/cmd-started');
            for (let i = 0; i < 100 && !existsSync(started); i += 1)
                await new Promise((done) => setTimeout(done, 100));
            child.kill(signal);
            assert.equal(await exited, want, 'integrate exit');
            assert.equal(q("SELECT COUNT(*) || '|' || MAX(exit_code) || '|' || MAX(timed_out) || '|' || MIN(finished_at IS NOT NULL) FROM verification_runs"), `1|${want}|0|1`, "the run row is finished with the signal's exit code");
            assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
            assertNoTempWorktree();
        });
    }
    it('no review: exit 3, nothing touched', () => {
        setup('clean');
        exec('DELETE FROM validation_attempts;');
        const r = integrate('main');
        assert.equal(r.code, 3, r.err);
        assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
        assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
        assertNoTempWorktree();
    });
    it('a pass verdict for an earlier commit is no review of this one: exit 3', () => {
        setup('clean');
        exec(`UPDATE audit SET content_json = '{"task_id":1,"commit_sha":"${base0}"}';`);
        const r = integrate('main');
        assert.equal(r.code, 3, r.err);
        assert.equal(r.err, `integrate: task 1 has no passing code-reviewer verdict for commit ${commit}\n`);
    });
    it('base not moved: prints the original SHA, records nothing', () => {
        setup('none');
        const r = integrate('main');
        assert.equal(r.code, 0, r.err);
        assert.equal(r.out, commit, 'printed SHA');
        assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
        assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
        assertNoTempWorktree();
    });
    it('branch checked out in a worktree: exit 4 before any rebase', () => {
        setup('clean');
        git('worktree', 'add', '-q', join(repo, '.claude/worktrees/x-1'), 'feat/x-1');
        const r = integrate('main');
        assert.equal(r.code, 4, r.err);
        assert.match(r.err, /checked out at/, 'stderr names the holder');
        assert.match(r.err, /run cli\.js integrate again/, 'stderr names the subcommand to rerun');
        assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
        assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
    });
    it('re-integration after main moves again: the branch moves from the verified rebase', () => {
        setup('clean');
        const first = integrate('main').out;
        commitFile('n.txt', 'again');
        const r = integrate('main');
        assert.equal(r.code, 0, r.err);
        assert.equal(rev('refs/heads/feat/x-1'), r.out, 'feat/x-1 tip');
        assert.notEqual(r.out, first, 'second integration printed the first SHA');
        assert.equal(rev(`${r.out}^`), rev('main'), 'the second rebase sits on main');
    });
    it('usage and argument errors exit 4', () => {
        setup('none');
        const cases = [
            [['1'], 'integrate: usage: cli.js integrate <task_id> <base>\n'],
            [['x', 'main'], "integrate: task_id must be a number, got 'x'\n"],
            [['1', ''], 'integrate: base is empty\n'],
            [['2', 'main'], 'integrate: no task 2\n'],
            [['1', 'nope'], `integrate: base 'nope' is not a commit in ${repo}\n`],
        ];
        for (const [args, err] of cases) {
            const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'integrate', ...args], { cwd: repo, encoding: 'utf8', env: cliEnv() });
            assert.equal(r.status, 4, args.join(' '));
            assert.equal(r.stderr, err, args.join(' '));
            assert.equal(r.stdout, '', args.join(' '));
        }
    });
    describe('node_modules', () => {
        // setup, then main tracks package.json, pkg/package.json and other/package.json; the
        // main checkout holds untracked node_modules/marker and pkg/node_modules/marker, other/ has none.
        function setupNodeModules(move, verification) {
            setup(move, verification);
            mkdirSync(join(repo, 'pkg'));
            mkdirSync(join(repo, 'other'));
            for (const f of ['package.json', 'pkg/package.json', 'other/package.json'])
                writeFileSync(join(repo, f), '{}\n');
            git('add', 'package.json', 'pkg/package.json', 'other/package.json');
            git('commit', '-qm', 'chore: package manifests');
            mkdirSync(join(repo, 'node_modules'));
            mkdirSync(join(repo, 'pkg/node_modules'));
            writeFileSync(join(repo, 'node_modules/marker'), 'root-dep\n');
            writeFileSync(join(repo, 'pkg/node_modules/marker'), 'pkg-dep\n');
        }
        function assertMarkersIntact() {
            assert.equal(readFileSync(join(repo, 'node_modules/marker'), 'utf8'), 'root-dep\n', 'main checkout node_modules/marker');
            assert.equal(readFileSync(join(repo, 'pkg/node_modules/marker'), 'utf8'), 'pkg-dep\n', 'main checkout pkg/node_modules/marker');
        }
        it('untracked installs are linked into the worktree, clean rebase exits 0', () => {
            setupNodeModules('clean', NODE_MODULES_PASSING);
            const r = integrate('main');
            assert.equal(r.code, 0, r.err);
            assert.equal(rev('refs/heads/feat/x-1'), r.out, 'feat/x-1 tip');
            assert.equal(q('SELECT COUNT(*) FROM verification_run_commands WHERE exit_code = 0'), '3', 'all three commands passed');
            assertNoTempWorktree();
            assertMarkersIntact();
        });
        it("failing verification exits 1 and leaves the main checkout's installs", () => {
            setupNodeModules('clean', NODE_MODULES_FAILING);
            const r = integrate('main');
            assert.equal(r.code, 1, r.err);
            assert.equal(q("SELECT group_concat(exit_code, '|') FROM (SELECT exit_code FROM verification_run_commands ORDER BY ordinal)"), '0|0|5', 'the links resolved before the failing command');
            assertNoTempWorktree();
            assertMarkersIntact();
        });
        it("conflict exits 2 and leaves the main checkout's installs", () => {
            setupNodeModules('conflict', NODE_MODULES_PASSING);
            const r = integrate('main');
            assert.equal(r.code, 2, r.err);
            assertNoTempWorktree();
            assertMarkersIntact();
        });
    });
    // Worktree setup (GH 2054): main commits .config/tmb/worktree-setup.json, so the
    // rebased worktree runs it after node_modules is linked and before verification[].
    describe('worktree setup', () => {
        function setupWithSetupFile(commands) {
            setup('clean', '["test -f setup-ran"]');
            mkdirSync(join(repo, '.config/tmb'), { recursive: true });
            writeFileSync(join(repo, '.config/tmb/worktree-setup.json'), JSON.stringify({ version: 1, commands }));
            git('add', '.config/tmb/worktree-setup.json');
            git('commit', '-qm', 'chore: worktree setup');
        }
        it('a failing setup exits 1, prints the failing command and its output tail, records nothing', () => {
            setupWithSetupFile(['echo integrate-setup-broke; exit 8']);
            const r = integrate('main');
            assert.equal(r.code, 1, r.err);
            assert.equal(r.out, '', 'nothing on stdout');
            assert.match(r.err, /worktree setup command exited 8: echo integrate-setup-broke; exit 8/);
            assert.match(r.err, /Output \(last 20 lines\):\nintegrate-setup-broke/);
            assert.match(r.err, /worktree setup failed on [0-9a-f]{40}; no verification run recorded, feat\/x-1 unmoved/);
            assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
            assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
            assertNoTempWorktree();
        });
        it('a passing setup runs before verification[] and is not recorded as a command', () => {
            setupWithSetupFile(['touch setup-ran']);
            const r = integrate('main');
            assert.equal(r.code, 0, r.err);
            assert.equal(q('SELECT group_concat(command, char(10)) FROM verification_run_commands'), 'test -f setup-ran');
            assertNoTempWorktree();
        });
    });
    // Generated files (GH 1652). .gitattributes routes gen/** to the tmb-regen
    // merge driver (keeps ours); scripts/maintenance/regen-generated.ts rebuilds
    // gen/out.txt from src/*.txt. src/s.txt holds l1..l7; the task changes l4 and
    // regenerates, then main moves with its own src/ change and regenerates, so
    // gen/out.txt conflicts on every rebase:
    //   gen      — src/base.txt (gen/out.txt is the only conflict)
    //   drift    — l2 of src/s.txt (merges cleanly, but the task's source patch
    //              context changes)
    //   conflict — l4 of src/s.txt (a real source conflict)
    //   absorbed — the task's own l4 change (the rebase drops the task commit)
    // The regen mode "fail" commits a regen script that exits 2; "hashed" one
    // that replaces gen/ with gen/out.txt naming a new gen/chunk-<content hash>.txt
    // (a content-hashed chunk, GH 2353) and writes an untracked regen.log outside gen/.
    describe('generated files', () => {
        let regenMode = 'ok';
        function regenCommit(msg) {
            mkdirSync(join(repo, 'gen'), { recursive: true });
            if (regenMode === 'hashed') {
                const r = spawnSync(process.execPath, ['scripts/maintenance/regen-generated.ts'], { cwd: repo, encoding: 'utf8', env: GIT_ENV });
                assert.equal(r.status, 0, `hashed regen: ${r.stderr}`);
                rmSync(join(repo, 'regen.log'));
            }
            else {
                const src = join(repo, 'src');
                const names = readdirSync(src).filter((n) => n.endsWith('.txt')).sort();
                writeFileSync(join(repo, 'gen/out.txt'), names.map((n) => readFileSync(join(src, n), 'utf8')).join(''));
            }
            git('add', '-A', 'src', 'gen');
            git('commit', '-qm', msg);
        }
        function sLines(line, value) {
            const lines = [1, 2, 3, 4, 5, 6, 7].map((i) => (i === line ? value : `l${i}`));
            writeFileSync(join(repo, 'src/s.txt'), `${lines.join('\n')}\n`);
        }
        function setupRegen(move, regen = 'ok') {
            regenMode = regen;
            setup('none', REGEN_PASSING);
            const r = spawnSync(process.execPath, [HOOKS, 'install-merge-driver', repo], { cwd: repo, encoding: 'utf8', env: GIT_ENV });
            assert.equal(r.status, 0, `install-merge-driver: ${r.stderr}`);
            git('checkout', '-q', 'main');
            git('branch', '-q', '-D', 'feat/x-1');
            writeFileSync(join(repo, '.gitattributes'), 'gen/** merge=tmb-regen\n');
            mkdirSync(join(repo, 'scripts/maintenance'), { recursive: true });
            mkdirSync(join(repo, 'src'), { recursive: true });
            writeFileSync(join(repo, 'scripts/maintenance/regen-generated.ts'), { ok: REGEN_OK, fail: REGEN_FAIL, hashed: REGEN_HASHED }[regen]);
            sLines(0, '');
            git('add', '.gitattributes', 'scripts');
            regenCommit('chore: generated gen/out.txt');
            git('checkout', '-q', '-b', 'feat/x-1');
            sLines(4, 'l4-task');
            regenCommit('feat: l4');
            commit = rev('HEAD');
            git('checkout', '-q', 'main');
            if (move === 'gen')
                writeFileSync(join(repo, 'src/base.txt'), 'base\n');
            if (move === 'drift')
                sLines(2, 'l2-base');
            if (move === 'conflict')
                sLines(4, 'l4-base');
            if (move === 'absorbed')
                sLines(4, 'l4-task');
            regenCommit(`feat: main moves (${move})`);
            pointTaskAt(commit);
        }
        /** gen/ at <sha> equals a regen of <sha>'s src/. */
        function freshRegenMatches(sha) {
            const check = join(repo, '.claude/regen-check');
            git('worktree', 'add', '-q', '--detach', check, sha);
            try {
                return spawnSync('bash', ['-c', `${REGEN_RUN} && git diff --quiet -- gen`], { cwd: check, env: GIT_ENV }).status === 0;
            }
            finally {
                git('worktree', 'remove', '--force', check);
            }
        }
        it('generated-file conflict only: regenerated, amended, verified, exit 0', () => {
            setupRegen('gen');
            const r = integrate('main');
            assert.equal(r.code, 0, r.err);
            const next = r.out;
            assert.equal(rev('refs/heads/feat/x-1'), next, 'feat/x-1 tip');
            assert.equal(rev(`${next}^`), rev('main'), "the rebased commit's parent is main");
            assert.equal(git('log', '-1', '--format=%s|%an', next), 'feat: l4|Test', "the amended commit keeps the task's message and author");
            assert.equal(git('show', `${next}:gen/out.txt`), 'base\nl1\nl2\nl3\nl4-task\nl5\nl6\nl7', "gen/out.txt holds both sides' sources");
            assert.match(r.err, /regenerating generated files with scripts\/maintenance\/regen-generated\.ts/);
            assertNoTempWorktree();
            assert.ok(freshRegenMatches(next), `gen/out.txt at ${next} differs from a fresh regen`);
            assert.equal(q(`SELECT COUNT(*) || '|' || MAX(source) || '|' || MAX(exit_code) FROM verification_runs WHERE commit_sha = '${next}'`), '1|manual|0', 'a passing manual run on the printed SHA');
        });
        it('regen renames a generated file: the amended commit tracks the new name only (GH 2353)', () => {
            setupRegen('gen', 'hashed');
            const r = integrate('main');
            assert.equal(r.code, 0, r.err);
            const next = r.out;
            const [chunk, ...body] = git('show', `${next}:gen/out.txt`).split('\n');
            assert.equal(body.join('\n'), 'base\nl1\nl2\nl3\nl4-task\nl5\nl6\nl7', "gen/out.txt holds both sides' sources");
            assert.match(chunk, /^chunk-[0-9a-f]{8}\.txt$/);
            assert.deepEqual(git('ls-tree', '-r', '--name-only', next, '--', 'gen').split('\n'), [`gen/${chunk}`, 'gen/out.txt'], 'gen/ tracks the new chunk only');
            assert.equal(git('log', '-1', '--format=%s|%an', next), 'feat: l4|Test', "the amended commit keeps the task's message and author");
            assert.equal(rev('refs/heads/feat/x-1'), next, 'feat/x-1 tip');
            assertNoTempWorktree();
        });
        it('regen writes an untracked file outside merge=tmb-regen paths: not committed', () => {
            setupRegen('gen', 'hashed');
            const r = integrate('main');
            assert.equal(r.code, 0, r.err);
            assert.equal(git('ls-tree', '--name-only', r.out, '--', 'regen.log'), '', 'regen.log is not in the amended commit');
            assert.deepEqual(git('diff', '--name-only', 'main', r.out, '--', '.', ':(exclude)gen').split('\n'), ['src/s.txt'], 'outside gen/ the commit changes only the task source');
        });
        it('generated-file conflict with source drift: exit 2, nothing recorded', () => {
            setupRegen('drift');
            const r = integrate('main');
            assert.equal(r.code, 2, r.err);
            assert.match(r.err, /patch/, 'stderr names the patch-id mismatch');
            assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
            assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
            assertNoTempWorktree();
        });
        it('source conflict beside a generated-file conflict: exit 2', () => {
            setupRegen('conflict');
            const r = integrate('main');
            assert.equal(r.code, 2, r.err);
            assert.match(r.err, /conflicted/, 'stderr names the conflict');
            assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
            assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
            assertNoTempWorktree();
        });
        it("task change already on main: exit 2, main's commit is not amended", () => {
            setupRegen('absorbed');
            const mainTip = rev('main');
            const r = integrate('main');
            assert.equal(r.code, 2, r.err);
            assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
            assert.equal(rev('main'), mainTip, 'main tip');
            assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
            assertNoTempWorktree();
        });
        it('failing regen: exit 2 naming regen-generated.ts, branch unmoved', () => {
            setupRegen('gen', 'fail');
            const r = integrate('main');
            assert.equal(r.code, 2, r.err);
            assert.equal(r.out, '', 'nothing on stdout');
            assert.ok(r.err.includes('regen-generated.ts exited 2'), 'stderr names the failing regen script');
            assert.ok(r.err.includes('toolchain missing'), 'stderr carries the regen output');
            assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
            assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
            assertNoTempWorktree();
        });
    });
    // git-guards denies a rebase in the main checkout; the temporary worktree
    // integrate rebases in is a linked worktree, where rebase is allowed, and
    // bro's own command is a cli.js call git-guards does not judge as a rebase.
    it('git-guards: rebase in the temp worktree allowed, in the main checkout denied, bro’s call allowed', async () => {
        setup('clean');
        const wt = join(repo, '.claude/worktrees/integrate-1.abc123');
        git('worktree', 'add', '-q', '--detach', wt, commit);
        const env = { ...GIT_ENV, TRAJECTORY_DB_PATH: db, PWD: repo };
        const guard = async (command) => (await gitGuards(JSON.stringify({ cwd: repo, tool_input: { command } }), env)).stdout;
        assert.doesNotMatch(await guard(`cd ${wt} && git rebase main`), /"permissionDecision":"deny"/, 'a rebase in the temporary worktree');
        const denied = await guard(`git -C ${repo} rebase main`);
        assert.match(denied, /"permissionDecision":"deny"/, 'a rebase in the main checkout');
        assert.match(denied, /main checkout/, 'the deny names the main checkout');
        assert.doesNotMatch(await guard(`node --experimental-sqlite "${CLI}" integrate 1 main`), /"permissionDecision":"deny"/, 'bro running cli.js integrate from the main checkout');
    });
});
//# sourceMappingURL=cli-integrate.test.js.map