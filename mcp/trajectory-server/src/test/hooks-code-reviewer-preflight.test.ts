/**
 * The code-reviewer-preflight gate (GH 1740) on temp git repos and a temp
 * trajectory DB: one deny and one allow per check, each deny naming its typed
 * check, and agent-spawn-dispatch.sh returning the deny before any PREPARE step.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BYPASS_ENV, codeReviewerPreflight, type PreflightFailure } from '../hooks/code-reviewer-preflight.js';
import { findGate, gateNames } from '../hooks/registry.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ROOT = resolve(SERVER_ROOT, '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const NOW = '2026-10-25T10:00:00.000Z';
const TASK_ID = 3;
const BRANCH = 'feat/3-x';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const BASE_FILES: Record<string, string> = {
  'README.md': 'See docs/guide.md.\n',
  'docs/guide.md': 'Run `scripts/old.sh` first.\n',
  'scripts/old.sh': 'echo old\n',
  'skills/s/SKILL.md': 'Call `keep_tool`.\n',
  'mcp/srv/src/tools/t.ts': "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n  {\n    name: 'old_tool',\n  },\n];\n",
  'changelog.d/README.md': 'One file per change.\n',
  'src/a.txt': 'one\ntwo\nthree\n',
};

interface Fixture {
  repo: string;
  db: string;
  env: NodeJS.ProcessEnv;
  git(...args: string[]): string;
  write(path: string, text: string): void;
  commit(message: string): string;
  /** Records the branch tip as tasks.commit_sha with a verification run of the given result. */
  record(run?: { exit: number | null; timedOut?: number } | null): string;
}

let sandbox: string;
let seq = 0;

function fixture(files: Record<string, string> = BASE_FILES): Fixture {
  seq += 1;
  const root = join(sandbox, `case-${seq}`);
  const repo = join(root, 'repo');
  const db = join(root, '.claude/tmb/trajectory.db');
  mkdirSync(repo, { recursive: true });
  mkdirSync(dirname(db), { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: db, ...GIT_ENV };
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'dev');
  for (const [path, text] of Object.entries(files)) write(path, text);
  commit('base');
  git('checkout', '-q', '-b', BRANCH);

  const d = new DatabaseSync(db);
  d.exec(SCHEMA);
  d.prepare("INSERT INTO repos (name, path, target_branch) VALUES ('repo', ?, 'dev')").run(repo);
  d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(NOW, NOW);
  d.prepare(
    "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, repo, created_at, updated_at) VALUES (?, 9, ?, 'dev', 'd', 'closed', 'repo', ?, ?)",
  ).run(TASK_ID, BRANCH, NOW, NOW);
  d.close();

  const record = (run: { exit: number | null; timedOut?: number } | null = { exit: 0 }) => {
    const sha = git('rev-parse', BRANCH);
    const w = new DatabaseSync(db);
    w.prepare('UPDATE tasks SET commit_sha = ? WHERE id = ?').run(sha, TASK_ID);
    if (run) {
      w.prepare(
        "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (?, ?, 'gate', ?, ?, ?, 600, ?)",
      ).run(TASK_ID, sha, NOW, NOW, run.exit, run.timedOut ?? 0);
    }
    w.close();
    return sha;
  };
  return { repo, db, env, git, write, commit, record };
}

/** A feature commit that changes src/a.txt and adds its changelog fragment. */
function featureCommit(f: Fixture): void {
  f.write('src/a.txt', 'one\ntwo\nthree\nfour\n');
  f.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
  f.commit('feature');
}

const payload = (prompt = `task_id=${TASK_ID} commit_sha=x`, subagent = 'code-reviewer') =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: subagent, prompt } });

function denial(stdout: string): PreflightFailure {
  assert.notEqual(stdout, '', 'expected a deny');
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return JSON.parse(out.hookSpecificOutput.permissionDecisionReason) as PreflightFailure;
}

function run(f: Fixture, input = payload()) {
  return codeReviewerPreflight(input, f.env) as { stdout: string; code: number };
}

function assertAllowed(f: Fixture): void {
  assert.deepEqual(run(f), { stdout: '', code: 0 });
}

describe('code-reviewer-preflight', () => {
  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tmb-preflight-'));
  });
  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('is registered, so the build lists it in dist/hooks-gates.txt', () => {
    assert.equal(findGate('code-reviewer-preflight'), codeReviewerPreflight);
    assert.ok(gateNames().includes('code-reviewer-preflight'));
  });

  describe('sha_mismatch', () => {
    it('denies when the branch tip moved past tasks.commit_sha', () => {
      const f = fixture();
      featureCommit(f);
      const recorded = f.record();
      f.write('src/b.txt', 'later\n');
      const tip = f.commit('after close');
      const r = run(f);
      assert.equal(r.code, 0);
      assert.deepEqual(denial(r.stdout), { check: 'sha_mismatch', expected: recorded, actual: tip });
    });

    it('denies when the task records no commit_sha', () => {
      const f = fixture();
      featureCommit(f);
      const d = denial(run(f).stdout);
      assert.equal(d.check, 'sha_mismatch');
      assert.equal(d.expected, null);
    });

    it('allows when the branch tip is tasks.commit_sha', () => {
      const f = fixture();
      featureCommit(f);
      f.record();
      assertAllowed(f);
    });
  });

  describe('no_passing_run', () => {
    it('denies when the only run for the commit failed', () => {
      const f = fixture();
      featureCommit(f);
      const sha = f.record({ exit: 1 });
      const d = denial(run(f).stdout);
      assert.equal(d.check, 'no_passing_run');
      assert.match(d.actual ?? '', /exit_code=1, timed_out=0/);
      assert.match(d.expected ?? '', new RegExp(sha));
    });

    it('denies a timed-out run and a commit with no run at all', () => {
      const f = fixture();
      featureCommit(f);
      f.record({ exit: 0, timedOut: 1 });
      assert.equal(denial(run(f).stdout).check, 'no_passing_run');
      const g = fixture();
      featureCommit(g);
      g.record(null);
      const d = denial(run(g).stdout);
      assert.equal(d.check, 'no_passing_run');
      assert.match(d.actual ?? '', /no verification_runs row/);
    });

    it('allows a passing run recorded for the commit', () => {
      const f = fixture();
      featureCommit(f);
      f.record({ exit: 0 });
      assertAllowed(f);
    });
  });

  describe('base_conflict', () => {
    it('denies when the PR target gained a conflicting change', () => {
      const f = fixture();
      featureCommit(f);
      f.record();
      f.git('checkout', '-q', 'dev');
      f.write('src/a.txt', 'one\ntwo\nthree\nFOUR on dev\n');
      f.commit('dev conflicts');
      f.git('checkout', '-q', BRANCH);
      const d = denial(run(f).stdout);
      assert.equal(d.check, 'base_conflict');
      assert.match(d.actual ?? '', /conflicts in src\/a\.txt/);
    });

    it('allows a clean base move', () => {
      const f = fixture();
      featureCommit(f);
      f.record();
      f.git('checkout', '-q', 'dev');
      f.write('src/other.txt', 'dev only\n');
      f.commit('dev moves cleanly');
      f.git('checkout', '-q', BRANCH);
      assertAllowed(f);
    });
  });

  describe('stale_doc_ref', () => {
    it('denies a deleted path a docs/ file still names', () => {
      const f = fixture();
      featureCommit(f);
      f.git('rm', '-q', 'scripts/old.sh');
      f.commit('drop old.sh');
      f.record();
      const d = denial(run(f).stdout);
      assert.equal(d.check, 'stale_doc_ref');
      assert.match(d.actual ?? '', /docs\/guide\.md mentions removed path 'scripts\/old\.sh'/);
    });

    it('denies a renamed path whose old name README.md still carries', () => {
      const f = fixture();
      featureCommit(f);
      f.git('mv', 'docs/guide.md', 'docs/handbook.md');
      f.commit('rename guide');
      f.record();
      const d = denial(run(f).stdout);
      assert.equal(d.check, 'stale_doc_ref');
      assert.match(d.actual ?? '', /README\.md mentions removed path 'docs\/guide\.md'/);
    });

    it('denies an MCP tool the diff removes that a skills/*/SKILL.md still mentions', () => {
      const f = fixture();
      f.write('skills/s/SKILL.md', 'Call `mcp__plugin_tmb_trajectory-server__old_tool` then `keep_tool`.\n');
      f.commit('skill names old_tool');
      featureCommit(f);
      f.write('mcp/srv/src/tools/t.ts', "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n];\n");
      f.commit('drop old_tool');
      f.record();
      const d = denial(run(f).stdout);
      assert.equal(d.check, 'stale_doc_ref');
      assert.match(d.actual ?? '', /skills\/s\/SKILL\.md mentions removed MCP tool 'old_tool'/);
    });

    it('allows a deletion and a tool removal once the docs drop them', () => {
      const f = fixture();
      featureCommit(f);
      f.git('rm', '-q', 'scripts/old.sh');
      f.write('docs/guide.md', 'Nothing to run first.\n');
      f.write('mcp/srv/src/tools/t.ts', "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n];\n");
      f.commit('drop old.sh and old_tool');
      f.record();
      assertAllowed(f);
    });
  });

  describe('missing_changelog', () => {
    it('denies a diff that adds no file under changelog.d/', () => {
      const f = fixture();
      f.write('src/a.txt', 'one\ntwo\nthree\nfour\n');
      f.commit('feature without fragment');
      f.record();
      const d = denial(run(f).stdout);
      assert.equal(d.check, 'missing_changelog');
      assert.equal(d.actual, 'no file added under changelog.d/');
    });

    it('allows a repo without changelog.d/ that adds no fragment', () => {
      const files = { ...BASE_FILES };
      delete files['changelog.d/README.md'];
      const f = fixture(files);
      f.write('src/a.txt', 'one\ntwo\nthree\nfour\n');
      f.commit('feature');
      f.record();
      assertAllowed(f);
    });
  });

  describe('scope', () => {
    it('ignores other subagents, a prompt without task_id, and the bypass', () => {
      const f = fixture();
      featureCommit(f);
      assert.deepEqual(run(f, payload(`task_id=${TASK_ID}`, 'swe')), { stdout: '', code: 0 });
      assert.deepEqual(run(f, payload('review this')), { stdout: '', code: 0 });
      assert.deepEqual(codeReviewerPreflight(payload(), { ...f.env, [BYPASS_ENV]: '1' }), { stdout: '', code: 0 });
      assert.equal(denial(run(f, payload(`task_id=${TASK_ID}`, 'tmb:code-reviewer')).stdout).check, 'sha_mismatch');
    });

    it('allows a task with no tasks row', () => {
      const f = fixture();
      assert.deepEqual(run(f, payload('task_id=999')), { stdout: '', code: 0 });
    });

    it('denies when the DB cannot be read', () => {
      const f = fixture();
      writeFileSync(f.db, 'not a database');
      const out = JSON.parse((codeReviewerPreflight(payload(), f.env) as { stdout: string }).stdout);
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /trajectory DB unavailable — code-reviewer-preflight/);
    });
  });

  describe('agent-spawn-dispatch.sh', () => {
    function dispatcherRoot(): { hooks: string; marks: string } {
      seq += 1;
      const root = join(sandbox, `plugin-${seq}`);
      const hooks = join(root, 'scripts/hooks');
      const marks = join(root, 'marks');
      mkdirSync(hooks, { recursive: true });
      mkdirSync(marks);
      mkdirSync(join(root, 'mcp/trajectory-server'), { recursive: true });
      symlinkSync(join(SERVER_ROOT, 'dist'), join(root, 'mcp/trajectory-server/dist'));
      copyFileSync(join(PLUGIN_ROOT, 'scripts/hooks/agent-spawn-dispatch.sh'), join(hooks, 'agent-spawn-dispatch.sh'));
      for (const step of ['ensure-swe-worktree', 'record-swe-spawn']) {
        writeFileSync(join(hooks, `${step}.sh`), `#!/usr/bin/env bash\ntouch "${marks}/${step}"\n`);
        chmodSync(join(hooks, `${step}.sh`), 0o755);
      }
      return { hooks, marks };
    }

    const dispatch = (hooks: string, env: NodeJS.ProcessEnv) =>
      spawnSync('bash', [join(hooks, 'agent-spawn-dispatch.sh')], { input: payload(), env, encoding: 'utf8', timeout: 30_000 });

    it('returns the preflight deny and runs no PREPARE step', () => {
      const f = fixture();
      featureCommit(f);
      f.record({ exit: 1 });
      const { hooks, marks } = dispatcherRoot();
      const r = dispatch(hooks, f.env);
      assert.equal(r.status, 0);
      assert.equal(denial(r.stdout.trim()).check, 'no_passing_run');
      assert.equal(existsSync(join(marks, 'ensure-swe-worktree')), false, 'ensure-swe-worktree.sh did not run');
      assert.equal(existsSync(join(marks, 'record-swe-spawn')), false, 'record-swe-spawn.sh did not run');
    });

    it('control: a passing preflight reaches the PREPARE steps', () => {
      const f = fixture();
      featureCommit(f);
      f.record();
      const { hooks, marks } = dispatcherRoot();
      const r = dispatch(hooks, f.env);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.ok(existsSync(join(marks, 'ensure-swe-worktree')));
      assert.ok(existsSync(join(marks, 'record-swe-spawn')));
    });
  });
});
