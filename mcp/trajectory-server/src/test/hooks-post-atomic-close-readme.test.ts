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
import { isDistDir, nudgeReason, parseTaskRow, postAtomicCloseReadme, touchedDirs } from '../hooks/post-atomic-close-readme.js';
import { buildSandbox, resetDb } from './hooks-readme-staleness-parity.suite.js';

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
  it('knows a dist dir by any dist path segment', () => {
    assert.equal(isDistDir('x/dist'), true);
    assert.equal(isDistDir('dist'), true);
    assert.equal(isDistDir('mcp/trajectory-server/dist/hooks'), true);
    assert.equal(isDistDir('distro'), false);
    assert.equal(isDistDir('src/redist-notes'), false);
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
