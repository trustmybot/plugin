// node:test suite for setup-helpers.ts: PLUGIN_ROOT, setupArgs' usage exit, writeFile, gitCommit
// (with and without tolerateFailure), sql with bound params and FK constraints off, and every
// rows/**/setup-l5.ts run against a scratch project seeded the way run-l5.ts seeds it.
// Run: node --experimental-strip-types --experimental-sqlite --test tests/l5-l6/lib/setup-helpers.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { L5_DOGFOOD_DIR, l5SeedDb, l5SetupScratchProject, PLUGIN_ROOT as FLOW_PLUGIN_ROOT } from './flow-helpers.ts';
import { git, gitCommit, PLUGIN_ROOT, sql, writeFile } from './setup-helpers.ts';

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

function query(project: string, sqlText: string, params: string[] = []): Record<string, unknown>[] {
  const db = new DatabaseSync(join(project, '.claude', 'tmb', 'trajectory.db'));
  try {
    return db.prepare(sqlText).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
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
});

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
  '12.02-consultant-ad-hoc': (p) =>
    assert.deepEqual(
      readFileSync(join(p, '.claude', 'agents', 'architect.md')),
      readFileSync(join(PLUGIN_ROOT, 'templates', 'agents', 'architect.md')),
    ),
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
