/**
 * Unit tests of the TypeScript post-atomic-close-readme gate (GH 1692): the
 * README verdict read from the closed commit's tree (GH 2044, GH 1792), the
 * dist skip, the nudge and audit row, and the divergences from the .sh that
 * decision 703 allows (no jq, no sqlite3 CLI).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findGate, gateNames } from '../hooks/registry.js';
import { commandOnPath } from '../hooks/lib/persona.js';
import {
  cappedList,
  DEFAULT_SKIP_DIRS,
  isSkippedDir,
  nudgeReason,
  parseSkipDirs,
  parseTaskRow,
  postAtomicCloseReadme,
  SKIP_DIRS_KEY,
  touchedDirs,
} from '../hooks/post-atomic-close-readme.js';
import { buildSandbox, commit, GIT_ENV, initRepo, resetDb, trajectoryDb } from './hooks-readme-staleness-parity.suite.js';

const ALLOWED = { stdout: '', code: 0 };
const C = { LC_ALL: 'C' };
const OLDER = '(README.md older than the commit)';
const GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

function close(taskId: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tool_name: 'mcp__plugin_tmb_trajectory-server__bro_atomic_close',
    tool_input: { agent: 'bro', task_id: taskId },
    tool_response: { is_error: false },
    ...extra,
  });
}

function context(stdout: string): string {
  assert.ok(stdout.endsWith('\n'));
  const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  return out.hookSpecificOutput.additionalContext;
}

function staleLines(stdout: string): string[] {
  const ctx = context(stdout);
  const start = ctx.indexOf('older than the commit:\n') + 'older than the commit:\n'.length;
  return ctx.slice(start, ctx.indexOf('\n\nFor each,')).split('\n');
}

function auditRows(db: string): { issue_id: number; branch_id: string; from_node: string; summary: string; content_json: string }[] {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare("SELECT issue_id, branch_id, from_node, summary, content_json FROM audit WHERE event_type = 'readme_staleness_surfaced' ORDER BY id").all() as {
      issue_id: number;
      branch_id: string;
      from_node: string;
      summary: string;
      content_json: string;
    }[];
  } finally {
    d.close();
  }
}

function taskSha(db: string, taskId: number): string {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return (d.prepare('SELECT commit_sha FROM tasks WHERE id = ?').get(taskId) as { commit_sha: string }).commit_sha;
  } finally {
    d.close();
  }
}

describe('post-atomic-close-readme is registered', () => {
  it('is a gate dist/hooks-gates.txt lists', () => {
    assert.equal(findGate('post-atomic-close-readme'), postAtomicCloseReadme);
    assert.ok(gateNames().includes('post-atomic-close-readme'));
  });
});

describe('post-atomic-close-readme helpers', () => {
  it("splits the task row as the .sh's parameter expansions do", () => {
    assert.deepEqual(parseTaskRow('abc|repo|7|feat/x'), { commitSha: 'abc', repo: 'repo', issueId: '7', branchId: 'feat/x' });
    assert.deepEqual(parseTaskRow('abc|||'), { commitSha: 'abc', repo: '', issueId: '', branchId: '' });
    assert.deepEqual(parseTaskRow('abc|repo|7|feat/a|b'), { commitSha: 'abc', repo: 'repo', issueId: '7', branchId: 'feat/a|b' });
  });
  it('maps each changed path to its dir, the root as ., sorted and unique', () => {
    assert.deepEqual(touchedDirs(['b/x', 'README.md', 'a/b/c.txt', 'b/y', 'notes'], C), ['.', 'a/b', 'b']);
  });
  it('knows a skipped dir by any path segment in the skip list', () => {
    assert.equal(isSkippedDir('x/dist', DEFAULT_SKIP_DIRS), true);
    assert.equal(isSkippedDir('dist', DEFAULT_SKIP_DIRS), true);
    assert.equal(isSkippedDir('mcp/trajectory-server/dist/hooks', DEFAULT_SKIP_DIRS), true);
    assert.equal(isSkippedDir('changelog.d', DEFAULT_SKIP_DIRS), true);
    assert.equal(isSkippedDir('tests/fixtures/hook-corpus', DEFAULT_SKIP_DIRS), true);
    assert.equal(isSkippedDir('mcp/trajectory-server/src/test', DEFAULT_SKIP_DIRS), true);
    assert.equal(isSkippedDir('distro', DEFAULT_SKIP_DIRS), false);
    assert.equal(isSkippedDir('src/redist-notes', DEFAULT_SKIP_DIRS), false);
    assert.equal(isSkippedDir('src/testing', DEFAULT_SKIP_DIRS), false);
    assert.equal(isSkippedDir('.', DEFAULT_SKIP_DIRS), false);
    assert.equal(isSkippedDir('vendor/lib', ['vendor']), true);
    assert.equal(isSkippedDir('dist', []), false);
  });
  it('reads the skip list from value_json, the default when unset, malformed or not an array of strings', () => {
    assert.deepEqual(DEFAULT_SKIP_DIRS, ['dist', 'build', 'changelog.d', 'fixtures', 'test', 'tests', '__tests__', 'node_modules']);
    assert.deepEqual(parseSkipDirs('["vendor","gen"]'), ['vendor', 'gen']);
    assert.deepEqual(parseSkipDirs('[]'), []);
    for (const bad of ['', 'not json', '{"a":1}', '"dist"', '["dist",1]', 'null']) assert.equal(parseSkipDirs(bad), DEFAULT_SKIP_DIRS, bad);
  });
  it('caps the nudge list at 10 dirs, then and N more', () => {
    const dirs = Array.from({ length: 13 }, (_, i) => `d${i}`);
    assert.equal(cappedList(dirs.slice(0, 10)), dirs.slice(0, 10).join('\n'));
    assert.equal(cappedList(dirs.slice(0, 11)), [...dirs.slice(0, 10), 'and 1 more'].join('\n'));
    assert.equal(cappedList(dirs), [...dirs.slice(0, 10), 'and 3 more'].join('\n'));
  });
  it('words the nudge as the .sh does', () => {
    const reason = nudgeReason('9', '0123456789abcdef', `src ${OLDER}`);
    assert.ok(reason.startsWith('📝 README-staleness check (task 9, commit 0123456): '));
    assert.ok(reason.includes(`older than the commit:\nsrc ${OLDER}\n\nFor each,`));
  });
});

describe('post-atomic-close-readme over a git and DB sandbox', { skip: !GIT && 'needs git' }, () => {
  let base: string;
  let s: string;
  let project: string;
  let db: string;
  let gitOnly: string;
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: join(s, 'ws'), LC_ALL: 'C', ...extra };
    for (const key of ['TMB_TEST_RUN_ID', 'TMB_FORBID_LIVE_SYNC', 'TMB_HOOKS_SQLITE']) delete e[key];
    return e;
  };

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-readme-staleness-')));
    s = join(base, 'sandbox');
    buildSandbox(s);
    project = join(s, 'ws/project');
    gitOnly = join(base, 'git-only');
    mkdirSync(gitOnly);
    const gitPath = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(gitPath, join(gitOnly, 'git'));
  });
  after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('GH 2044: a commit on a branch the main checkout lacks, adding a/b/README.md, editing a/README.md and building x/dist, flags nothing', async () => {
    db = resetDb(s);
    assert.equal(existsSync(join(project, 'a')), false, 'the main checkout has no a/');
    assert.deepEqual(await postAtomicCloseReadme(close(5), env()), ALLOWED);
    assert.deepEqual(auditRows(db), []);
  });

  it('GH 1792: a commit editing dashboard/README.md flags no dashboard line, its checkout mtime notwithstanding', async () => {
    db = resetDb(s);
    assert.deepEqual(await postAtomicCloseReadme(close(4), env()), ALLOWED);
    assert.deepEqual(auditRows(db), []);
  });

  it('flags a README missing from the tree and one the commit left alone, and records one audit row', async () => {
    db = resetDb(s);
    const r = await postAtomicCloseReadme(close(6), env());
    assert.equal(r.code, 0);
    assert.deepEqual(staleLines(r.stdout), [`project/ ${OLDER}`, 'Zeta (no README.md)', `src/lib ${OLDER}`, 'tools (no README.md)']);
    const mixed = taskSha(db, 6);
    const rows = auditRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].issue_id, 7);
    assert.equal(rows[0].branch_id, 'feat/mixed');
    assert.equal(rows[0].from_node, 'hook:post-atomic-close-readme');
    assert.equal(rows[0].summary, `task 6: README may be stale in 4 dir(s) after ${mixed.slice(0, 7)}`);
    assert.equal(
      rows[0].content_json,
      JSON.stringify({ task_id: 6, commit_sha: mixed, stale: [`project/ ${OLDER}`, 'Zeta (no README.md)', `src/lib ${OLDER}`, 'tools (no README.md)'] }),
    );
  });

  it('skips a dir with a dist path segment and still flags its parent', async () => {
    db = resetDb(s);
    assert.deepEqual(staleLines((await postAtomicCloseReadme(close(12), env())).stdout), ['web (no README.md)']);
  });

  it('sorts the dirs by the locale, as sort -u does', async () => {
    db = resetDb(s);
    const r = await postAtomicCloseReadme(close(6), env({ LC_ALL: 'en_US.UTF-8' }));
    const lines = staleLines(r.stdout);
    assert.deepEqual([...lines].sort(), [`project/ ${OLDER}`, 'Zeta (no README.md)', `src/lib ${OLDER}`, 'tools (no README.md)'].sort());
  });

  it('labels the root by the task repo, <repo root> without one', async () => {
    db = resetDb(s);
    assert.deepEqual(staleLines((await postAtomicCloseReadme(close(1), env())).stdout), [`project/ ${OLDER}`]);
    assert.deepEqual(staleLines((await postAtomicCloseReadme(close(10), env())).stdout), [`<repo root> ${OLDER}`]);
    assert.deepEqual(staleLines((await postAtomicCloseReadme(close(11), env())).stdout), [`ghost/ ${OLDER}`]);
  });

  it('prints nothing for another tool, an error response, a bad task id, SHA or commit, or the bypass', async () => {
    db = resetDb(s);
    assert.deepEqual(await postAtomicCloseReadme(close(1, { tool_name: 'Bash' }), env()), ALLOWED);
    assert.deepEqual(await postAtomicCloseReadme(close(1, { tool_response: { is_error: true } }), env()), ALLOWED);
    assert.deepEqual(await postAtomicCloseReadme(close('1a'), env()), ALLOWED);
    for (const id of [7, 8, 9, 999]) assert.deepEqual(await postAtomicCloseReadme(close(id), env()), ALLOWED, `task ${id}`);
    assert.deepEqual(await postAtomicCloseReadme(close(1), env({ TMB_DISABLE_README_STALENESS_HOOK: '1' })), ALLOWED);
    assert.deepEqual(await postAtomicCloseReadme('not json', env()), ALLOWED);
    assert.deepEqual(auditRows(db), []);
  });

  it('prints nothing without a trajectory DB', async () => {
    const r = await postAtomicCloseReadme(close(1), env({ TRAJECTORY_DB_PATH: join(s, 'nodb/none.db'), CLAUDE_PROJECT_DIR: join(s, 'nodb') }));
    assert.deepEqual(r, ALLOWED);
  });

  it('nudges and records without jq or the sqlite3 CLI, where the .sh exits silently', async () => {
    db = resetDb(s);
    const bare = env({ PATH: gitOnly });
    assert.equal(commandOnPath('jq', bare), false);
    assert.equal(commandOnPath('sqlite3', bare), false);
    assert.deepEqual(staleLines((await postAtomicCloseReadme(close(2), bare)).stdout), [`src/lib ${OLDER}`]);
    assert.equal(auditRows(db).length, 1);
  });
});

describe('post-atomic-close-readme scope and cap (GH 1965)', { skip: !GIT && 'needs git' }, () => {
  const MANY = Array.from({ length: 13 }, (_, i) => `many${String(i + 1).padStart(2, '0')}`);
  let base: string;
  let db: string;
  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: base, LC_ALL: 'C' };
    for (const key of ['TMB_TEST_RUN_ID', 'TMB_FORBID_LIVE_SYNC', 'TMB_HOOKS_SQLITE']) delete e[key];
    return e;
  };
  const setSkipDirs = (valueJson: string | null): void => {
    const d = new DatabaseSync(db);
    try {
      d.prepare('DELETE FROM plugin_config WHERE key = ?').run(SKIP_DIRS_KEY);
      if (valueJson !== null) d.prepare('INSERT INTO plugin_config (key, value_json) VALUES (?, ?)').run(SKIP_DIRS_KEY, valueJson);
      d.prepare("DELETE FROM audit WHERE event_type = 'readme_staleness_surfaced'").run();
    } finally {
      d.close();
    }
  };

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-readme-scope-')));
    const repo = join(base, 'scoped');
    initRepo(repo);
    commit(repo, 'init', { 'README.md': '# scoped\n', 'legacy/old.txt': 'v1\n', 'legacy/keep.txt': 'k\n' });
    const shas = {
      skipOnly: commit(repo, 'generated, fragment and test dirs only', {
        'changelog.d/1965-x.md': 'fragment\n',
        'dist/bundle.js': 'built\n',
        'tests/fixtures/case.json': '{}\n',
        'src/test/a.test.ts': 'test\n',
      }),
      modifyOnly: commit(repo, 'modify a README-less dir', { 'legacy/old.txt': 'v2\n' }),
      addOne: commit(repo, 'add to a README-less dir', { 'legacy/new.txt': 'new\n' }),
      many: commit(repo, 'thirteen new dirs', Object.fromEntries(MANY.map((d) => [`${d}/f.txt`, `${d}\n`]))),
      rename: '',
    };
    mkdirSync(join(repo, 'moved'));
    const mv = spawnSync('git', ['-C', repo, 'mv', 'legacy/keep.txt', 'moved/keep.txt'], { env: { ...process.env, ...GIT_ENV } });
    assert.equal(mv.status, 0);
    shas.rename = commit(repo, 'rename into a README-less dir', {});
    db = join(base, '.claude/tmb/trajectory.db');
    trajectoryDb(db, (d) => {
      d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('scoped', repo);
      d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'scope', 'open', 't', 't')").run();
      const task = d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, commit_sha, created_at, updated_at) VALUES (?, 7, ?, 'd', 'closed', 'scoped', ?, 't', 't')");
      for (const [id, sha] of [[21, shas.skipOnly], [22, shas.modifyOnly], [23, shas.addOne], [24, shas.many], [25, shas.rename]] as const) task.run(id, `feat/scope-${id}`, sha);
    });
  });
  after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('SC1: a commit touching only changelog.d/, dist/, tests/fixtures/ and src/test/ prints no nudge under the default list', async () => {
    for (const unset of [null, 'not json', '{"dist":true}']) {
      setSkipDirs(unset);
      assert.deepEqual(await postAtomicCloseReadme(close(21), env()), ALLOWED, String(unset));
    }
    assert.deepEqual(auditRows(db), []);
  });

  it('SC2: a custom readme_nudge_skip_dirs changes which dirs are skipped', async () => {
    setSkipDirs('["fixtures"]');
    assert.deepEqual(staleLines((await postAtomicCloseReadme(close(21), env())).stdout), ['changelog.d (no README.md)', 'dist (no README.md)', 'src/test (no README.md)']);
    setSkipDirs('[]');
    assert.deepEqual(staleLines((await postAtomicCloseReadme(close(21), env())).stdout), [
      'changelog.d (no README.md)',
      'dist (no README.md)',
      'src/test (no README.md)',
      'tests/fixtures (no README.md)',
    ]);
    setSkipDirs('["src","tests","dist","changelog.d"]');
    assert.deepEqual(await postAtomicCloseReadme(close(21), env()), ALLOWED);
  });

  it('SC3: a README-less dir is reported when the commit adds a file there, renames included, not when it only modifies one', async () => {
    setSkipDirs(null);
    assert.deepEqual(await postAtomicCloseReadme(close(22), env()), ALLOWED);
    assert.deepEqual(auditRows(db), []);
    assert.deepEqual(staleLines((await postAtomicCloseReadme(close(23), env())).stdout), ['legacy (no README.md)']);
    assert.deepEqual(staleLines((await postAtomicCloseReadme(close(25), env())).stdout), ['moved (no README.md)']);
  });

  it('SC4: more than 10 stale dirs print 10 plus and N more; the audit row keeps every dir', async () => {
    setSkipDirs(null);
    const r = await postAtomicCloseReadme(close(24), env());
    const missing = MANY.map((d) => `${d} (no README.md)`);
    assert.deepEqual(staleLines(r.stdout), [...missing.slice(0, 10), 'and 3 more']);
    const rows = auditRows(db);
    assert.equal(rows.length, 1);
    assert.match(rows[0].summary, /^task 24: README may be stale in 13 dir\(s\) after [0-9a-f]{7}$/);
    assert.deepEqual((JSON.parse(rows[0].content_json) as { stale: string[] }).stale, missing);
  });
});
