/**
 * The code-reviewer-preflight gate (GH 1740) on temp git repos and a temp
 * trajectory DB: one deny and one allow per check, each deny naming its typed
 * check, and the agent-spawn-dispatch gate returning the deny before any PREPARE step.
 * The changelog and stale-doc checks run at swe's close now; their tests live in
 * hooks-swe-verification-gate.test.ts (GH 2866), and scripts/hooks/README.md
 * must describe that split.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { agentSpawnDispatch, PREPARE } from '../hooks/agent-spawn-dispatch.js';
import { BYPASS_ENV, codeReviewerPreflight, preflightFix, type PreflightFailure } from '../hooks/code-reviewer-preflight.js';
import { ALLOW, type Gate, type GateResult } from '../hooks/gate.js';
import { findGate, gateNames } from '../hooks/registry.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
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
  const { fix, ...failure } = JSON.parse(out.hookSpecificOutput.permissionDecisionReason) as PreflightFailure & { fix: unknown };
  assert.deepEqual(fix, preflightFix(failure.check, String(TASK_ID)));
  return failure;
}

async function run(f: Fixture, input = payload()) {
  return (await codeReviewerPreflight(input, f.env)) as { stdout: string; code: number };
}

async function assertAllowed(f: Fixture): Promise<void> {
  assert.deepEqual(await run(f), { stdout: '', code: 0 });
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
    it('denies when the branch tip moved past tasks.commit_sha', async () => {
      const f = fixture();
      featureCommit(f);
      const recorded = f.record();
      f.write('src/b.txt', 'later\n');
      const tip = f.commit('after close');
      const r = await run(f);
      assert.equal(r.code, 0);
      assert.deepEqual(denial(r.stdout), { check: 'sha_mismatch', expected: recorded, actual: tip });
    });

    it('denies when the task records no commit_sha', async () => {
      const f = fixture();
      featureCommit(f);
      const d = denial((await run(f)).stdout);
      assert.equal(d.check, 'sha_mismatch');
      assert.equal(d.expected, null);
    });

    it('allows when the branch tip is tasks.commit_sha', async () => {
      const f = fixture();
      featureCommit(f);
      f.record();
      await assertAllowed(f);
    });

    describe('after cli.js integrate rebases the reviewed commit (GH 2411)', () => {
      function integrated(f: Fixture): { reviewed: string; rebased: string } {
        featureCommit(f);
        const reviewed = f.record();
        f.git('checkout', '-q', 'dev');
        f.write('src/dev.txt', 'dev moved\n');
        f.commit('dev moves');
        f.git('checkout', '-q', BRANCH);
        f.git('rebase', '-q', 'dev');
        const rebased = f.git('rev-parse', BRANCH);
        const w = new DatabaseSync(f.db);
        w.prepare(
          "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (?, ?, 'manual', ?, ?, 0, 600, 0)",
        ).run(TASK_ID, rebased, NOW, NOW);
        w.close();
        return { reviewed, rebased };
      }

      it('allows the spawn once tasks.commit_sha names the rebased tip', async () => {
        const f = fixture();
        const { reviewed, rebased } = integrated(f);
        assert.notEqual(rebased, reviewed);
        const w = new DatabaseSync(f.db);
        w.prepare('UPDATE tasks SET commit_sha = ? WHERE id = ?').run(rebased, TASK_ID);
        w.close();
        await assertAllowed(f);
      });

      it('denies sha_mismatch while tasks.commit_sha still names the reviewed commit', async () => {
        const f = fixture();
        const { reviewed, rebased } = integrated(f);
        assert.deepEqual(denial((await run(f)).stdout), { check: 'sha_mismatch', expected: reviewed, actual: rebased });
      });
    });
  });

  describe('no_passing_run', () => {
    it('denies when the only run for the commit failed', async () => {
      const f = fixture();
      featureCommit(f);
      const sha = f.record({ exit: 1 });
      const d = denial((await run(f)).stdout);
      assert.equal(d.check, 'no_passing_run');
      assert.match(d.actual ?? '', /exit_code=1, timed_out=0/);
      assert.match(d.expected ?? '', new RegExp(sha));
    });

    it('denies a timed-out run and a commit with no run at all', async () => {
      const f = fixture();
      featureCommit(f);
      f.record({ exit: 0, timedOut: 1 });
      assert.equal(denial((await run(f)).stdout).check, 'no_passing_run');
      const g = fixture();
      featureCommit(g);
      g.record(null);
      const d = denial((await run(g)).stdout);
      assert.equal(d.check, 'no_passing_run');
      assert.match(d.actual ?? '', /no verification_runs row/);
    });

    it('allows a passing run recorded for the commit', async () => {
      const f = fixture();
      featureCommit(f);
      f.record({ exit: 0 });
      await assertAllowed(f);
    });
  });

  describe('base_conflict', () => {
    it('denies when the PR target gained a conflicting change', async () => {
      const f = fixture();
      featureCommit(f);
      f.record();
      f.git('checkout', '-q', 'dev');
      f.write('src/a.txt', 'one\ntwo\nthree\nFOUR on dev\n');
      f.commit('dev conflicts');
      f.git('checkout', '-q', BRANCH);
      const d = denial((await run(f)).stdout);
      assert.equal(d.check, 'base_conflict');
      assert.match(d.actual ?? '', /conflicts in src\/a\.txt/);
    });

    it('allows a clean base move', async () => {
      const f = fixture();
      featureCommit(f);
      f.record();
      f.git('checkout', '-q', 'dev');
      f.write('src/other.txt', 'dev only\n');
      f.commit('dev moves cleanly');
      f.git('checkout', '-q', BRANCH);
      await assertAllowed(f);
    });

    const CHUNK_LINES = Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    const GENERATED_FILES: Record<string, string> = {
      ...BASE_FILES,
      'mcp/trajectory-server/dist/x.js': 'export const x = 1;\n',
      'dist/chunks/View-aaa111.js': `${CHUNK_LINES}\n`,
    };

    /** dev renames the hashed chunk; the task deletes it and adds a rebuilt one under a different hash. */
    function generatedChunkConflict(f: Fixture, alsoConflictSource = false): void {
      f.git('rm', '-q', 'dist/chunks/View-aaa111.js');
      f.write('dist/chunks/View-ccc333.js', 'export const rebuilt = true;\n');
      if (alsoConflictSource) f.write('src/a.txt', 'one\ntwo\nthree\nfour\n');
      f.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
      f.commit('feature rebuilds dist');
      f.record();
      f.git('checkout', '-q', 'dev');
      f.git('mv', 'dist/chunks/View-aaa111.js', 'dist/chunks/View-bbb222.js');
      f.write('dist/chunks/View-bbb222.js', `${CHUNK_LINES}\nexport const dev = 1;\n`);
      if (alsoConflictSource) f.write('src/a.txt', 'one\ntwo\nthree\nFOUR on dev\n');
      f.commit('dev rebuilds dist');
      f.git('checkout', '-q', BRANCH);
    }

    function assertMergeTreeConflicts(f: Fixture): void {
      const r = spawnSync('git', ['-C', f.repo, 'merge-tree', '--write-tree', '--name-only', 'dev', BRANCH], { env: f.env, encoding: 'utf8' });
      assert.equal(r.status, 1, 'merge-tree reports a conflict');
      assert.match(r.stdout, /dist\/chunks\/View-bbb222\.js/);
    }

    it('denies a conflict on a generated build path (GH 2054)', async () => {
      const f = fixture(GENERATED_FILES);
      f.write('mcp/trajectory-server/dist/x.js', 'export const x = 2;\n');
      f.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
      f.commit('feature rebuilds dist');
      f.record();
      f.git('checkout', '-q', 'dev');
      f.write('mcp/trajectory-server/dist/x.js', 'export const x = 3;\n');
      f.commit('dev rebuilds dist');
      f.git('checkout', '-q', BRANCH);
      const d = denial((await run(f)).stdout);
      assert.equal(d.check, 'base_conflict');
      assert.equal(d.actual, 'conflicts in mcp/trajectory-server/dist/x.js');
    });

    it('denies a hashed-chunk conflict (GH 2054)', async () => {
      const f = fixture(GENERATED_FILES);
      generatedChunkConflict(f);
      assertMergeTreeConflicts(f);
      const d = denial((await run(f)).stdout);
      assert.equal(d.check, 'base_conflict');
      assert.match(d.actual ?? '', /^conflicts in .*dist\/chunks\/View-bbb222\.js/);
    });

    it('denies a source conflict alongside a generated chunk, naming both paths', async () => {
      const f = fixture(GENERATED_FILES);
      generatedChunkConflict(f, true);
      assertMergeTreeConflicts(f);
      const d = denial((await run(f)).stdout);
      assert.equal(d.check, 'base_conflict');
      assert.match(d.actual ?? '', /dist\/chunks\/View-bbb222\.js/);
      assert.match(d.actual ?? '', /src\/a\.txt/);
    });
  });

  describe('the changelog and doc checks moved to the swe close gate (GH 2866)', () => {
    it('allows a recorded, passing commit that drops a doc-named path and adds no fragment', async () => {
      const f = fixture();
      f.git('rm', '-q', 'scripts/old.sh');
      f.commit('drop old.sh without a fragment');
      f.record();
      await assertAllowed(f);
    });
  });

  describe('scope', () => {
    it('ignores other subagents, a prompt without task_id, and the bypass', async () => {
      const f = fixture();
      featureCommit(f);
      assert.deepEqual(await run(f, payload(`task_id=${TASK_ID}`, 'swe')), { stdout: '', code: 0 });
      assert.deepEqual(await run(f, payload('review this')), { stdout: '', code: 0 });
      assert.deepEqual(await codeReviewerPreflight(payload(), { ...f.env, [BYPASS_ENV]: '1' }), { stdout: '', code: 0 });
      assert.equal(denial((await run(f, payload(`task_id=${TASK_ID}`, 'tmb:code-reviewer'))).stdout).check, 'sha_mismatch');
    });

    it('allows a task with no tasks row', async () => {
      const f = fixture();
      assert.deepEqual(await run(f, payload('task_id=999')), { stdout: '', code: 0 });
    });

    it('denies when the DB cannot be read', async () => {
      const f = fixture();
      writeFileSync(f.db, 'not a database');
      const out = JSON.parse(((await codeReviewerPreflight(payload(), f.env)) as { stdout: string }).stdout);
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /trajectory DB unavailable — code-reviewer-preflight/);
    });
  });

  describe('the agent-spawn-dispatch gate', () => {
    /** Of CHAIN only the gate under test runs, so the fixture needs no spec; PREPARE runs as markers. */
    function dispatch(f: Fixture): Promise<{ result: GateResult; ran: string[] }> {
      const ran: string[] = [];
      const find = (name: string): Gate | undefined =>
        PREPARE.includes(name)
          ? () => {
              ran.push(name);
              return ALLOW;
            }
          : name === 'code-reviewer-preflight' ? findGate(name) : undefined;
      return agentSpawnDispatch(payload(), f.env, find).then((result) => ({ result, ran }));
    }

    it('returns the preflight deny and runs no PREPARE step', async () => {
      const f = fixture();
      featureCommit(f);
      f.record({ exit: 1 });
      const { result, ran } = await dispatch(f);
      assert.equal(result.code, 0);
      assert.equal(denial(result.stdout.trim()).check, 'no_passing_run');
      assert.equal(ran.includes('ensure-swe-worktree'), false, 'ensure-swe-worktree did not run');
      assert.equal(ran.includes('record-swe-spawn'), false, 'record-swe-spawn did not run');
    });

    it('control: a passing preflight reaches the PREPARE steps', async () => {
      const f = fixture();
      featureCommit(f);
      f.record();
      const { result, ran } = await dispatch(f);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, '');
      assert.ok(ran.includes('ensure-swe-worktree'));
      assert.ok(ran.includes('record-swe-spawn'));
    });
  });
});

describe('scripts/hooks/README.md describes the GH 2866 split of the doc checks', () => {
  const readme = readFileSync(resolve(SERVER_ROOT, '../../scripts/hooks/README.md'), 'utf8');
  const between = (start: string, end: string): string => {
    const from = readme.indexOf(start);
    assert.notEqual(from, -1, `README has ${start}`);
    const to = readme.indexOf(end, from);
    assert.notEqual(to, -1, `README has ${end} after ${start}`);
    return readme.slice(from, to);
  };

  it('the preflight paragraph names three checks and none of the doc checks', () => {
    const preflight = between('`code-reviewer-preflight` judges a code-reviewer spawn', 'Then the TypeScript gate `rework-limit`');
    assert.match(preflight, /with three deterministic checks/);
    for (const check of ['sha_mismatch', 'no_passing_run', 'base_conflict']) assert.ok(preflight.includes(`\`${check}\` (`), `${check} is listed`);
    for (const check of ['stale_doc_ref', 'missing_changelog']) assert.equal(preflight.includes(check), false, `${check} is not a preflight check`);
  });

  it('the swe-verification-gate paragraph owns stale_doc_ref and missing_changelog', () => {
    const gate = between('Before anything else, `swe-verification-gate` runs the changelog and stale-doc checks', 'It then runs a task\'s `verification[]`');
    for (const check of ['stale_doc_ref', 'missing_changelog']) assert.ok(gate.includes(`\`${check}\` (`), `${check} is described at the close gate`);
  });

  it('the swe-atomic-close auto-complete needs a passing run and otherwise writes gate_pending', () => {
    const atomicClose = between('- `swe-atomic-close` binds the spawn', '\n');
    assert.equal(atomicClose.includes('Otherwise a `pending` or `running` task with commits is auto-completed,'), false);
    assert.match(atomicClose, /completed only when `verification_runs` holds a passing, not timed-out run for \(task, worktree HEAD\)/);
    assert.ok(atomicClose.includes('`swe_atomic_close_gate_pending`'));
  });
});
