// node:test suite for setup-helpers.ts: PLUGIN_ROOT, setupArgs' usage exit, writeFile, gitCommit
// (with and without tolerateFailure), gitOrThrow, sql with bound params and FK constraints off, withDb,
// query, ensureSchema, ensureStandaloneProject, 13-roundtable's standalone seed-agents.ts, and every rows/**/setup-l5.ts run
// against a scratch project seeded the way run-l5.ts seeds it.
// Run: node --experimental-strip-types --experimental-sqlite --test tests/l5-l6/lib/setup-helpers.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { L5_DOGFOOD_DIR, l5SeedDb, l5SetupScratchProject, PLUGIN_ROOT as FLOW_PLUGIN_ROOT } from './flow-helpers.ts';
import { ensureSchema, ensureStandaloneProject, git, gitCommit, gitOrThrow, PLUGIN_ROOT, query, sql, trajectoryDbPath, withDb, writeFile } from './setup-helpers.ts';

const NO_SQLITE3 = spawnSync('sqlite3', ['-version']).status !== 0 && 'sqlite3 not installed';
const ROWS = join(L5_DOGFOOD_DIR, 'rows');

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const HOME = tempDir();
const baseEnv: NodeJS.ProcessEnv = { ...process.env, HOME, TMB_DISABLE_REMOTE_SYNC: '1' };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-setup-helpers.'));
  roots.push(dir);
  return dir;
}

function scratchProject(): string {
  const dir = l5SetupScratchProject(baseEnv);
  roots.push(dir);
  return dir;
}

function gitOut(project: string, ...args: string[]): string {
  return spawnSync('git', args, { cwd: project, encoding: 'utf8' }).stdout.trim();
}

function lastSubject(project: string): string {
  return gitOut(project, 'log', '-1', '--format=%s');
}

function runSetup(script: string, args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--experimental-sqlite', '--no-warnings', script, ...args], {
    env: baseEnv,
    encoding: 'utf8',
  });
}

function setupScripts(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return setupScripts(path);
      return name === 'setup-l5.ts' ? [path] : [];
    });
}

describe('setup helpers', () => {
  test('PLUGIN_ROOT is the plugin root flow-helpers names', () => {
    assert.equal(PLUGIN_ROOT, FLOW_PLUGIN_ROOT);
    assert.ok(existsSync(join(PLUGIN_ROOT, 'templates', 'agents')));
  });

  test('setupArgs exits 2 with a usage line when the project argument is missing', () => {
    const r = runSetup(join(ROWS, '04', '04.01-cheatcode-install-approval', 'setup-l5.ts'), []);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^usage: setup-l5\.ts <project>/);
  });

  test('writeFile creates the parent dirs and writes the bytes', () => {
    const project = tempDir();
    writeFile(project, 'a/b/c.txt', 'hi\n');
    assert.equal(readFileSync(join(project, 'a', 'b', 'c.txt'), 'utf8'), 'hi\n');
  });

  test('gitCommit commits the paths; a failure throws, or returns false under tolerateFailure', () => {
    const project = scratchProject();
    writeFile(project, 'x.txt', 'x\n');
    assert.equal(gitCommit(project, ['x.txt'], 'add x'), true);
    assert.equal(lastSubject(project), 'add x');
    assert.equal(gitOut(project, 'status', '--porcelain'), '');

    assert.throws(() => gitCommit(project, ['.'], 'nothing to commit'), /git commit failed/);
    assert.equal(gitCommit(project, ['.'], 'nothing to commit', { tolerateFailure: true }), false);
    assert.equal(lastSubject(project), 'add x');
    assert.equal(git(project, ['rev-parse', '-q', '--verify', 'no-such-ref'], { quiet: true }), false);
  });

  test('sql binds params and runs with FK constraints off', () => {
    const project = tempDir();
    writeFile(project, '.claude/tmb/.keep', '');
    sql(project, 'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER, parent_id INTEGER REFERENCES parent(id), name TEXT);');
    sql(project, 'INSERT INTO child (id, parent_id, name) VALUES (?, ?, ?)', [1, 99, "it's $PROJECT"]);
    assert.deepEqual(
      query(project, 'SELECT id, parent_id, name FROM child').map((r) => ({ ...r })),
      [{ id: 1, parent_id: 99, name: "it's $PROJECT" }],
    );
  });

  test('withDb runs on one FK-off connection; query returns bound SELECT rows', () => {
    const project = tempDir();
    writeFile(project, '.claude/tmb/.keep', '');
    sql(project, 'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT); CREATE TABLE u (t_id INTEGER REFERENCES t(id));');
    withDb(project, (db) => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('a');
      db.exec('INSERT INTO u (t_id) VALUES (last_insert_rowid()); INSERT INTO u (t_id) VALUES (42);');
    });
    assert.deepEqual(query(project, 'SELECT t_id FROM u ORDER BY rowid').map((r) => r.t_id), [1, 42]);
    assert.deepEqual(query(project, 'SELECT v FROM t WHERE id = ?', [1]).map((r) => ({ ...r })), [{ v: 'a' }]);
  });

  test('ensureSchema loads schema.sql into a missing DB only', () => {
    const project = tempDir();
    assert.equal(ensureSchema(project), true);
    assert.ok(existsSync(trajectoryDbPath(project)));
    assert.equal(query(project, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'milestones'")[0].n, 1);
    sql(project, "INSERT INTO repos (name, path) VALUES ('keep', '/k')");
    assert.equal(ensureSchema(project), false);
    assert.equal(query(project, "SELECT COUNT(*) AS n FROM repos WHERE name = 'keep'")[0].n, 1);
  });

  test('gitOrThrow runs git and throws when it exits non-zero', () => {
    const project = scratchProject();
    gitOrThrow(project, ['checkout', '-q', '-b', 'side']);
    assert.equal(gitOut(project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'side');
    assert.throws(() => gitOrThrow(project, ['checkout', '-q', 'no-such-branch']), /git checkout -q no-such-branch failed/);
  });

  test('ensureStandaloneProject inits a bare dir as its own repo with a schema DB', () => {
    const parent = tempDir();
    git(parent, ['init', '-q', '-b', 'main']);
    const project = join(parent, 'nested');
    writeFile(project, '.keep', '');
    ensureStandaloneProject(project);
    assert.equal(gitOut(project, 'rev-parse', '--show-toplevel'), realpathSync(project));
    assert.equal(gitOut(project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(gitOut(project, 'log', '--format=%s|%an|%ae'), 'init|L5 Test|l6@l6.test');
    assert.equal(gitOut(project, 'ls-files'), '.gitignore');
    assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), '.claude/\n');
    assert.equal(query(project, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'repos'")[0].n, 1);
  });

  test('ensureStandaloneProject leaves a runner-seeded project alone', () => {
    const project = scratchProject();
    sql(project, readFileSync(join(PLUGIN_ROOT, 'mcp', 'trajectory-server', 'src', 'schema.sql'), 'utf8'));
    sql(project, "INSERT INTO repos (name, path) VALUES ('keep', '/k')");
    const head = gitOut(project, 'rev-parse', 'HEAD');
    ensureStandaloneProject(project);
    assert.equal(gitOut(project, 'rev-parse', 'HEAD'), head);
    assert.equal(query(project, "SELECT COUNT(*) AS n FROM repos WHERE name = 'keep'")[0].n, 1);
  });
});

describe('13-roundtable seed-agents.ts standalone', { skip: NO_SQLITE3 }, () => {
  test('seeds the panel files and agents rows; exits 2 without a project', () => {
    const project = scratchProject();
    assert.equal(l5SeedDb(project, 'onboarding-named', { env: baseEnv }), 0);
    const script = join(ROWS, '13', '13-roundtable', 'seed-agents.ts');
    const r = runSetup(script, [project]);
    assert.equal(r.status, 0, r.stderr);
    assertRoundtablePanel(project);
    const usage = runSetup(script, []);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /^usage: seed-agents\.ts <project_dir>/);
  });
});

function assertRoundtablePanel(project: string): void {
  for (const name of ['cto', 'data-engineer'])
    assert.deepEqual(readFileSync(join(project, '.claude', 'agents', `${name}.md`)), readFileSync(join(ROWS, '13', '13-roundtable', `${name}.md`)));
  assert.deepEqual(
    query(project, "SELECT name, file_path FROM agents WHERE name IN ('cto', 'data-engineer') ORDER BY name").map((r) => ({ ...r })),
    [
      { name: 'cto', file_path: 'project:.claude/agents/cto.md' },
      { name: 'data-engineer', file_path: 'project:.claude/agents/data-engineer.md' },
    ],
  );
}

type Check = (project: string, rowDir: string) => void;

const noScanRow: Check = (project) =>
  assert.equal(query(project, "SELECT COUNT(*) AS n FROM audit WHERE event_type = 'deep_scan_completed'")[0].n, 0);

const ROW_EFFECTS: Record<string, Check> = {
  '02-reonboard-implicit-from-local': (p) =>
    assert.equal(query(p, "SELECT value_json FROM plugin_config WHERE key = 'issue_sync'")[0].value_json, '"off"'),
  '03-reonboard-remote': (p) =>
    assert.equal(query(p, "SELECT value_json FROM plugin_config WHERE key = 'pr_target'")[0].value_json, '"main"'),
  '04.01-cheatcode-install-approval': (p) =>
    assert.deepEqual(JSON.parse(readFileSync(join(p, '.tmb-cheatcode-install-fixture.json'), 'utf8')), { installed: true, version: '1.4.0', error: null }),
  '04.02-cheatcode-search': (p) =>
    assert.equal(JSON.parse(readFileSync(join(p, '.tmb-cheatcode-fixture.json'), 'utf8')).length, 3),
  '04.03-cheatcode-vet': (p) =>
    assert.equal(JSON.parse(readFileSync(join(p, '.tmb-cheatcode-vet-fixture.json'), 'utf8')).repo.stargazers_count, 1200),
  '05-first-task-hits-gate': (p) => {
    noScanRow(p);
    assert.equal(lastSubject(p), 'feat: scaffold src/ + tests/');
    assert.equal(readFileSync(join(p, 'tests', '__init__.py'), 'utf8'), '"""tests package."""\n');
  },
  '05.03-codebase-memory-cold-start': (p) => {
    noScanRow(p);
    assert.equal(lastSubject(p), 'seed existing files');
    assert.equal(gitOut(p, 'ls-files', 'src'), 'src/existing.py');
  },
  '05.06-base-branch': (p) => {
    assert.deepEqual(
      query(p, 'SELECT path, target_branch, branching_model, protected_branches FROM repos WHERE name = ?', [basename(p)]).map((r) => ({ ...r })),
      [{ path: p, target_branch: 'dev', branching_model: 'gitflow', protected_branches: '["main","dev"]' }],
    );
    assert.equal(gitOut(p, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(p, ['rev-parse', '-q', '--verify', 'refs/heads/dev'], { quiet: true }), true);
  },
  '06.01-swe-retry': (p) => {
    assert.equal(query(p, 'SELECT status FROM tasks WHERE id = 1')[0].status, 'failed');
    assert.equal(query(p, "SELECT COUNT(*) AS n FROM discussions WHERE issue_id = 1 AND kind = 'note'")[0].n, 1);
  },
  '06.03-source-edit-attempt': (p) => {
    assert.equal(readFileSync(join(p, 'src', 'foo.ts'), 'utf8'), 'export const note = "recieve";\n');
    assert.equal(lastSubject(p), 'seed src/foo.ts with typo');
  },
  '10.01-difficult-task': (p, row) => {
    assert.deepEqual(readFileSync(join(p, 'todo.py')), readFileSync(join(row, 'fixture', 'todo.py')));
    assert.equal(lastSubject(p), 'feat: initial todo CLI');
  },
  '12.01-agent-creator': (p, row) => {
    assert.deepEqual(readFileSync(join(p, 'app.py')), readFileSync(join(row, 'fixture', 'app.py')));
    assert.equal(lastSubject(p), 'seed app.py for architect review');
  },
  '12.02-consultant-ad-hoc': (p, row) =>
    assert.deepEqual(readFileSync(join(p, '.claude', 'agents', 'architect.md')), readFileSync(join(row, 'architect.md'))),
  '03-multirepo-onboard-scan': (p) => {
    assert.deepEqual(
      query(p, "SELECT name, path, protected_branches FROM repos WHERE name IN ('repo-a', 'repo-b') ORDER BY name").map((r) => ({ ...r })),
      [
        { name: 'repo-a', path: join(p, 'repo-a'), protected_branches: '["main"]' },
        { name: 'repo-b', path: join(p, 'repo-b'), protected_branches: '["main"]' },
      ],
    );
    assert.equal(gitOut(join(p, 'repo-b'), 'remote', 'get-url', 'origin'), 'git@gitlab.com:acme/repo-b.git');
    assert.equal(lastSubject(join(p, 'repo-a')), 'init');
  },
  '04-cheatcode-install-plugins': (p) => {
    assert.deepEqual(JSON.parse(readFileSync(join(p, '.tmb-cheatcode-fixture.json'), 'utf8')).map((c: { name: string }) => c.name), ['feature-dev', 'code-review']);
    assert.deepEqual(JSON.parse(readFileSync(join(p, '.tmb-cheatcode-vet-fixture.json'), 'utf8')).contents, ['README.md', 'LICENSE', '.claude-plugin', 'hooks']);
    assert.deepEqual(
      JSON.parse(readFileSync(join(p, '.tmb-cheatcode-install-fixture.json'), 'utf8')).attachments.map((a: { target: string }) => a.target),
      ['swe', 'code-reviewer'],
    );
  },
  '05.04-multirepo-commit': (p) => {
    assert.deepEqual(
      query(p, "SELECT name, path, protected_branches FROM repos WHERE name IN ('api', 'app') ORDER BY name").map((r) => ({ ...r })),
      [
        { name: 'api', path: realpathSync(join(p, 'api')), protected_branches: '["main"]' },
        { name: 'app', path: realpathSync(join(p, 'app')), protected_branches: null },
      ],
    );
    assert.equal(lastSubject(join(p, 'api')), 'seed: api initial');
    assert.equal(gitOut(join(p, 'app'), 'ls-files'), 'README.md\nsrc/index.ts');
  },
  '06.02-codebase-memory-verify-on-drift': (p) => {
    assert.equal(query(p, "SELECT value_json FROM plugin_config WHERE key = 'last_verified_sha'")[0].value_json, JSON.stringify(gitOut(p, 'rev-parse', 'HEAD')));
    assert.equal(query(p, "SELECT COUNT(*) AS n FROM audit WHERE summary = 'setup: seeded stale world model'")[0].n, 1);
    assert.equal(query(p, 'SELECT path FROM repos WHERE name = ?', [basename(realpathSync(p))])[0].path, realpathSync(p));
    assert.equal(lastSubject(p), 'v1');
    assert.equal(readFileSync(join(p, 'src', 'foo.py'), 'utf8'), "def foo(): return 'v2-modified'\n");
    assert.equal(gitOut(p, 'status', '--porcelain'), 'M README.md\n M src/foo.py');
  },
  '06-swe-atomic-close': (p) => {
    assert.deepEqual(query(p, 'SELECT name, path FROM repos WHERE name = ?', ['todo-cli']).map((r) => ({ ...r })), [{ name: 'todo-cli', path: realpathSync(p) }]);
    assert.equal(query(p, "SELECT COUNT(*) AS n FROM audit WHERE event_type = 'deep_scan_completed' AND content_json = '{\"source\":\"step04\"}'")[0].n, 1);
    assert.equal(lastSubject(p), 'feat: todo CLI with add/list/done/remove + tests');
    assert.equal(gitOut(p, 'ls-files', 'src', 'tests'), 'src/cli.py\ntests/test_cli.py');
  },
  '07-post-close-cleanup': (p) => {
    assert.equal(query(p, 'SELECT path FROM repos WHERE name = ?', [basename(realpathSync(p))])[0].path, realpathSync(p));
    assert.equal(query(p, "SELECT COUNT(*) AS n FROM audit WHERE event_type = 'deep_scan_completed' AND summary = 'setup-l5: world model pre-warmed for row 06'")[0].n, 1);
    assert.match(readFileSync(join(p, 'README.md'), 'utf8'), /^# todo-cli\n/);
    assert.equal(gitOut(p, 'status', '--porcelain'), 'M README.md\n?? src/');
  },
  '12-consultant': (p) => {
    assert.equal(lastSubject(p), 'feat: todo CLI with JSON storage');
    assert.equal(query(p, "SELECT status FROM issues WHERE objective = 'Evaluate TODO CLI storage scale-out'")[0].status, 'open');
  },
  '14-issue-resume': (p) => {
    assert.deepEqual(
      query(p, "SELECT t.status, t.parent_branch_id, a.event_type FROM tasks t JOIN audit a ON a.issue_id = t.issue_id AND a.branch_id = t.branch_id WHERE t.branch_id = 'feat/add-count-subcommand'").map((r) => ({ ...r })),
      [{ status: 'pending', parent_branch_id: 'dev', event_type: 'planning_complete' }],
    );
    assert.match(query(p, "SELECT spec_body FROM tasks WHERE branch_id = 'feat/add-count-subcommand'")[0].spec_body as string, /Add a `count` subcommand/);
    assert.equal(gitOut(p, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(lastSubject(p), 'feat: todo CLI core (step 04 substrate)');
    assert.equal(gitOut(p, 'log', '-1', '--format=%s', 'feat/add-count-subcommand'), 'init');
  },
  '15-search-grounding': (p) => {
    assert.deepEqual(
      query(p, "SELECT d.issue_id = (SELECT MIN(id) FROM issues) AS first_issue, length(e.embedding) AS bytes, e.model_id FROM discussions d JOIN discussions_embeddings e ON e.discussion_id = d.id WHERE d.kind = 'decision' AND d.body LIKE 'Decision: extract storage%'").map((r) => ({ ...r })),
      [{ first_issue: 1, bytes: 6144, model_id: 'stub-zero-v0' }],
    );
  },
  '16-concurrent-tasks': (p) => {
    assert.deepEqual(query(p, 'SELECT path, protected_branches FROM repos WHERE name = ?', [basename(p)]).map((r) => ({ ...r })), [{ path: p, protected_branches: '["main"]' }]);
    assert.equal(lastSubject(p), 'feat: todo CLI with add and list');
  },
  '17-audit-request': (p) => {
    const store = JSON.parse(readFileSync(join(p, 'todos.json'), 'utf8'));
    assert.equal(store.length, 12);
    assert.deepEqual(store[11], { id: 12, text: 'update resume', done: false });
    assert.equal(lastSubject(p), 'feat: todo CLI with add and list, seeded store');
    assert.equal(gitOut(p, 'status', '--porcelain'), '');
  },
  '18-spec-shape-gate': (p) => {
    assert.equal(readFileSync(join(p, '.gitignore'), 'utf8'), '.claude/\ntodos.db\n');
    assert.equal(gitOut(p, 'ls-files', 'src'), 'src/cli.py\nsrc/schema.sql');
    assert.equal(query(p, 'SELECT path FROM repos WHERE name = ?', [basename(p)])[0].path, p);
  },
  '19-review-fail-rework': (p) => {
    const wt = join(p, '.claude', 'worktrees', 'add-count-subcommand');
    const sha = gitOut(p, 'rev-parse', 'feat/add-count-subcommand');
    assert.equal(gitOut(wt, 'rev-parse', 'HEAD'), sha);
    assert.equal(lastSubject(wt), 'feat: add count subcommand');
    assert.match(readFileSync(join(wt, 'src', 'cli.py'), 'utf8'), /\n\ndef count\(args\):\n {4}print\(len\(STORE\.read_text\(\)\)\)\n\n\ndef main\(\):[\s\S]*set_defaults\(func=list_items\)\n {4}sub\.add_parser\("count"\)\.set_defaults\(func=count\)\n/);
    const [task] = query(p, "SELECT id, status, commit_sha, files, verification FROM tasks WHERE branch_id = 'feat/add-count-subcommand'");
    assert.deepEqual({ ...task, id: undefined }, { id: undefined, status: 'closed', commit_sha: sha, files: '["src/cli.py"]', verification: '["python3 src/cli.py count"]' });
    assert.equal(query(p, 'SELECT root_dir FROM agent_runs WHERE task_id = ?', [task.id])[0].root_dir, wt);
    assert.equal(query(p, 'SELECT verdict FROM validation_attempts WHERE task_id = ?', [task.id])[0].verdict, 'fail');
    assert.equal(lastSubject(p), 'feat: todo CLI with add and list');
  },
  '08-push-gate': (p) => {
    const sha = gitOut(p, 'rev-parse', 'feat/seed-todo');
    const [task] = query(p, "SELECT id, status, commit_sha, repo, files, verification FROM tasks WHERE branch_id = 'feat/seed-todo'");
    assert.deepEqual(
      { ...task, id: undefined },
      { id: undefined, status: 'needs_validation', commit_sha: sha, repo: basename(p), files: '["todo.py"]', verification: '["python3 todo.py | grep -x todo >/dev/null"]' },
    );
    assert.deepEqual(
      query(p, 'SELECT c.command FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = ? AND r.commit_sha = ?', [task.id, sha]).map((r) => r.command),
      ['python3 todo.py | grep -x todo >/dev/null'],
    );
    assert.equal(gitOut(p, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  },
  '09-cheatcode-uninstall-plugins': (p) => {
    assert.deepEqual(query(p, 'SELECT id, name, installed_at GLOB ? AS shaped FROM cheatcodes WHERE id IN (101, 102) ORDER BY id', ['[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z']).map((r) => ({ ...r })), [
      { id: 101, name: 'feature-dev', shaped: 1 },
      { id: 102, name: 'code-review', shaped: 1 },
    ]);
    assert.deepEqual(query(p, 'SELECT cheatcode_id, target FROM cheatcode_attachments WHERE cheatcode_id IN (101, 102) ORDER BY cheatcode_id').map((r) => ({ ...r })), [
      { cheatcode_id: 101, target: 'swe' },
      { cheatcode_id: 102, target: 'code-reviewer' },
    ]);
    assert.deepEqual(
      query(p, "SELECT json_extract(content_json, '$.cheatcode_id') AS id FROM audit WHERE event_type = 'cheatcode_installed' ORDER BY id").map((r) => r.id),
      [101, 102],
    );
    assert.deepEqual(JSON.parse(readFileSync(join(p, '.tmb-cheatcode-uninstall-fixture.json'), 'utf8')), { removed: true, error: null });
  },
  '10-architectural-change': (p) => {
    assert.equal(lastSubject(p), 'feat: initial todo CLI with JSON storage');
    assert.match(readFileSync(join(p, 'src', 'cli.py'), 'utf8'), /^DATA_FILE = "tasks\.json"$/m);
  },
  '11-concerns-protocol': (p) => {
    assert.equal(lastSubject(p), 'feat+test: seed cli + exact-equality test');
    assert.equal(gitOut(p, 'ls-files', 'src', 'tests'), 'src/cli.py\ntests/test_cli.py');
  },
  '13-roundtable': (p) => {
    assertRoundtablePanel(p);
    assert.equal(lastSubject(p), 'feat: todo CLI');
    assert.equal(query(p, "SELECT COUNT(*) AS n FROM issues WHERE objective = 'TODO CLI storage choice' AND status = 'open'")[0].n, 1);
  },
  '20-containment-recovery': (p) => {
    assert.equal(lastSubject(p), 'feat: todo CLI core (row 20 substrate)');
    assert.equal(gitOut(p, 'status', '--porcelain'), '');
  },
  '21-move-milestone': (p) => {
    assert.deepEqual(query(p, 'SELECT name FROM milestones WHERE repo = ? ORDER BY name', [basename(p)]).map((r) => r.name), ['v0.1.0', 'v0.2.0', 'v0.3.0']);
    assert.deepEqual(
      query(p, "SELECT repo, milestone, labels FROM issues WHERE objective = 'Add count subcommand to todo CLI'").map((r) => ({ ...r })),
      [{ repo: basename(p), milestone: 'v0.1.0', labels: '["Feature","Priority: Medium"]' }],
    );
  },
  '22-onboard-persona': (p) => {
    assert.deepEqual(readFileSync(join(p, 'CLAUDE.md')), readFileSync(join(p, '.claude', 'tmb', '_l5_claude_md_seed.md')));
    assert.match(readFileSync(join(p, 'CLAUDE.md'), 'utf8'), /^# todo-cli\n/);
    assert.equal(lastSubject(p), 'docs: project CLAUDE.md (row 22 substrate)');
  },
  '23-bulk-cleanup': (p) => {
    for (const ds of ['.DS_Store', 'src/.DS_Store', 'src/components/.DS_Store']) assert.ok(existsSync(join(p, ds)), ds);
    assert.equal(readFileSync(join(p, 'src', 'index.js'), 'utf8'), "console.log('hello');\n");
    assert.equal(lastSubject(p), 'seed: add .DS_Store + keep-list');
  },
};

describe('rows/**/setup-l5.ts on a seeded scratch project', { skip: NO_SQLITE3 }, () => {
  const scripts = setupScripts(ROWS);

  test('every ported row script has a row-specific check', () => {
    assert.deepEqual(scripts.map((s) => basename(join(s, '..'))).sort(), Object.keys(ROW_EFFECTS).sort());
  });

  for (const script of scripts) {
    const rowDir = join(script, '..');
    const row = basename(rowDir);
    test(relative(ROWS, rowDir), () => {
      const project = scratchProject();
      const fixtureFile = join(rowDir, 'fixture.txt');
      const fixture = existsSync(fixtureFile) ? readFileSync(fixtureFile, 'utf8').replace(/\n+$/, '') : 'onboarding-named';
      assert.equal(l5SeedDb(project, fixture, { env: baseEnv }), 0);
      const r = runSetup(script, [project, rowDir]);
      assert.equal(r.status, 0, r.stderr);
      ROW_EFFECTS[row](project, rowDir);
    });
  }
});
