/**
 * validation_attempts.reviewed_sha (GH 2684): the record-reviewer-spawn
 * PREPARE step of agent-spawn-dispatch writes one reviewer_spawn_observed row
 * for an allowed code-reviewer spawn and none for a denied or non-reviewer one;
 * validation_record copies that row's commit_sha onto the attempt it records,
 * NULL with no observed spawn; validation_history returns it; the v64→v65
 * migration adds the column without touching existing rows.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TrajectoryDB } from '../db.js';
import { agentSpawnDispatch } from '../hooks/agent-spawn-dispatch.js';
import { ALLOW, type Gate } from '../hooks/gate.js';
import { findGate, gateNames } from '../hooks/registry.js';
import { FROM_NODE, recordReviewerSpawn, reviewerSpawnAnchors } from '../hooks/record-reviewer-spawn.js';
import { validationTools } from '../tools/validation.js';
import { TEST_PROBES, seedReviewerObservation } from './helpers.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const NOW = '2026-11-09T10:00:00.000Z';
const TASK_ID = 3;
const ISSUE_ID = 9;
const BRANCH = 'fix/3-x';
const TASK_SHA = 'a'.repeat(40);
const MERGE_SHA = '6e2c1db5'.padEnd(40, 'b');
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let sandbox: string;
let seq = 0;

function caseDir(): string {
  seq += 1;
  return join(sandbox, `case-${seq}`);
}

const spawnPayload = (prompt: string, subagent = 'code-reviewer'): string =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's', tool_use_id: 'toolu_1', tool_input: { subagent_type: subagent, prompt } });

const reviewerPrompt = (attemptN: number, sha: string): string =>
  `task_id=${TASK_ID} commit_sha=${sha} branch_id=${BRANCH} repo=repo repo_path=/r attempt_n=${attemptN} subagent_session_id=s`;

function spawnRows(db: string): Array<{ issue_id: number; from_node: string; content_json: string }> {
  const d = new DatabaseSync(db);
  try {
    return d
      .prepare("SELECT issue_id, from_node, content_json FROM audit WHERE event_type = 'reviewer_spawn_observed' ORDER BY id")
      .all() as Array<{ issue_id: number; from_node: string; content_json: string }>;
  } finally {
    d.close();
  }
}

async function call(db: TrajectoryDB, name: string, args: Record<string, unknown>): Promise<RawResult> {
  return (await validationTools(db).handlers[name]!(args)) as unknown as RawResult;
}

function parse(result: RawResult): unknown {
  assert.ok(!result.isError, result.content[0]?.text);
  return JSON.parse(result.content[0]!.text);
}

describe('validation_attempts.reviewed_sha (GH 2684)', () => {
  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tmb-reviewed-sha-'));
  });
  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  describe('validation_record and validation_history', () => {
    let dbFile: string;
    let env: NodeJS.ProcessEnv;
    let db: TrajectoryDB;

    before(() => {
      const root = caseDir();
      dbFile = join(root, '.claude/tmb/trajectory.db');
      mkdirSync(dirname(dbFile), { recursive: true });
      env = { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: dbFile };
      db = new TrajectoryDB(dbFile);
      db.run("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', ?, ?)", [ISSUE_ID, NOW, NOW]);
      db.run(
        "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, commit_sha, created_at, updated_at) VALUES (?, ?, ?, 'dev', 'd', 'closed', ?, ?, ?)",
        [TASK_ID, ISSUE_ID, BRANCH, TASK_SHA, NOW, NOW],
      );
    });
    after(() => db.close());

    function record(attemptN: number, extra: Record<string, unknown> = {}): Promise<RawResult> {
      return call(db, 'validation_record', {
        agent: 'code-reviewer',
        task_id: TASK_ID,
        attempt_n: attemptN,
        verdict: 'pass', probes: TEST_PROBES,
        feedback: '# Review',
        mcp_available: true,
        ...extra,
      });
    }

    it('SC1: an observed spawn at the merge sha for attempt 2 becomes that attempt\'s reviewed_sha, not tasks.commit_sha', async () => {
      assert.deepEqual(recordReviewerSpawn(spawnPayload(reviewerPrompt(2, TASK_SHA)), env), ALLOW);
      assert.deepEqual(recordReviewerSpawn(spawnPayload(reviewerPrompt(2, MERGE_SHA)), env), ALLOW);
      assert.deepEqual(recordReviewerSpawn(spawnPayload(reviewerPrompt(7, 'c'.repeat(40))), env), ALLOW);
      seedReviewerObservation(db, TASK_ID, 2, { agentId: 'reviewer-agent-0002' });
      const row = parse(await record(2)) as { attempt_n: number; reviewed_sha: string | null };
      assert.equal(row.attempt_n, 2);
      assert.notEqual(row.reviewed_sha, null);
      assert.equal(row.reviewed_sha, MERGE_SHA, 'the newest observed spawn for (task, attempt 2) wins');
      assert.notEqual(db.get<{ c: string }>('SELECT commit_sha AS c FROM tasks WHERE id = ?', [TASK_ID])!.c, MERGE_SHA);
      assert.equal(db.get<{ s: string }>('SELECT reviewed_sha AS s FROM validation_attempts WHERE task_id = ? AND attempt_n = 2', [TASK_ID])!.s, MERGE_SHA);

      const history = parse(await call(db, 'validation_history', { agent: 'bro', task_id: String(TASK_ID) })) as Array<Record<string, unknown>>;
      assert.equal(history.find((r) => r['attempt_n'] === 2)?.['reviewed_sha'], MERGE_SHA);
      const projected = parse(await call(db, 'validation_history', { agent: 'bro', task_id: String(TASK_ID), fields: ['reviewed_sha'] })) as Array<Record<string, unknown>>;
      assert.deepEqual(projected.map((r) => Object.keys(r)), projected.map(() => ['reviewed_sha']));
      assert.ok(projected.some((r) => r['reviewed_sha'] === MERGE_SHA));
      const paged = parse(await call(db, 'validation_history', { agent: 'bro', task_id: String(TASK_ID), limit: 10, fields: ['attempt_n', 'reviewed_sha'] })) as {
        rows: Array<Record<string, unknown>>;
      };
      assert.deepEqual(paged.rows.find((r) => r['attempt_n'] === 2), { attempt_n: 2, reviewed_sha: MERGE_SHA });
    });

    it('SC3: with no observed spawn for the attempt, validation_record succeeds and reviewed_sha is NULL', async () => {
      seedReviewerObservation(db, TASK_ID, 3, { agentId: 'reviewer-agent-0003' });
      const row = parse(await record(3)) as { attempt_n: number; reviewed_sha: string | null };
      assert.equal(row.attempt_n, 3);
      assert.equal(row.reviewed_sha, null);
    });

    it('SC3: the honor-system path with no observed spawn records reviewed_sha NULL', async () => {
      const row = parse(await record(4, { mcp_available: false, subagent_session_id: 'honor' })) as { reviewed_sha: string | null; mcp_available: number };
      assert.equal(row.mcp_available, 0);
      assert.equal(row.reviewed_sha, null);
      const history = parse(await call(db, 'validation_history', { agent: 'bro', task_id: String(TASK_ID), fields: ['attempt_n', 'reviewed_sha'] })) as Array<Record<string, unknown>>;
      assert.deepEqual(history.find((r) => r['attempt_n'] === 4), { attempt_n: 4, reviewed_sha: null });
    });

    it('a row another writer forged under a different from_node is not read', async () => {
      db.run(
        "INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES (?, NULL, 'bro', 'reviewer_spawn_observed', 's', ?, ?)",
        [ISSUE_ID, JSON.stringify({ task_id: TASK_ID, attempt_n: 5, commit_sha: MERGE_SHA }), NOW],
      );
      seedReviewerObservation(db, TASK_ID, 5, { agentId: 'reviewer-agent-0005' });
      const row = parse(await record(5)) as { reviewed_sha: string | null };
      assert.equal(row.reviewed_sha, null);
    });
  });

  describe('SC2: the agent-spawn-dispatch path', () => {
    interface Fixture {
      db: string;
      env: NodeJS.ProcessEnv;
      tip: string;
    }

    function fixture(recordedSha: 'tip' | 'other'): Fixture {
      const root = caseDir();
      const repo = join(root, 'repo');
      const db = join(root, '.claude/tmb/trajectory.db');
      mkdirSync(repo, { recursive: true });
      mkdirSync(dirname(db), { recursive: true });
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: db, ...GIT_ENV };
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      git('init', '-q', '-b', 'dev');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      git('add', '-A');
      git('commit', '-qm', 'base');
      git('checkout', '-q', '-b', BRANCH);
      mkdirSync(join(repo, 'changelog.d'), { recursive: true });
      writeFileSync(join(repo, 'changelog.d/3-x.md'), '### Fixed\n- x (GH 3)\n');
      git('add', '-A');
      git('commit', '-qm', 'feature');
      const tip = git('rev-parse', 'HEAD');
      const recorded = recordedSha === 'tip' ? tip : TASK_SHA;

      const d = new TrajectoryDB(db);
      d.close();
      const w = new DatabaseSync(db);
      w.prepare("INSERT INTO repos (name, path, target_branch) VALUES ('repo', ?, 'dev')").run(repo);
      w.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', ?, ?)").run(ISSUE_ID, NOW, NOW);
      w.prepare(
        "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, repo, commit_sha, created_at, updated_at) VALUES (?, ?, ?, 'dev', 'd', 'closed', 'repo', ?, ?, ?)",
      ).run(TASK_ID, ISSUE_ID, BRANCH, recorded, NOW, NOW);
      w.prepare(
        "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (?, ?, 'gate', ?, ?, 0, 600, 0)",
      ).run(TASK_ID, recorded, NOW, NOW);
      w.close();
      return { db, env, tip };
    }

    /** Of CHAIN only code-reviewer-preflight runs, so the fixture needs no spec; of PREPARE only record-reviewer-spawn. */
    const find = (name: string): Gate | undefined =>
      name === 'code-reviewer-preflight' || name === 'record-reviewer-spawn' ? findGate(name) : undefined;

    it('is a registered gate', () => {
      assert.ok(gateNames().includes('record-reviewer-spawn'));
    });

    it('an allowed code-reviewer spawn writes exactly one row with {task_id, attempt_n, commit_sha}', async () => {
      const f = fixture('tip');
      const result = await agentSpawnDispatch(spawnPayload(reviewerPrompt(2, f.tip)), f.env, find);
      assert.deepEqual(result, ALLOW);
      const rows = spawnRows(f.db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.issue_id, ISSUE_ID);
      assert.equal(rows[0]!.from_node, FROM_NODE);
      assert.deepEqual(JSON.parse(rows[0]!.content_json), { task_id: TASK_ID, attempt_n: 2, commit_sha: f.tip });
    });

    it('a spawn the preflight denies (sha_mismatch) writes none', async () => {
      const f = fixture('other');
      const result = await agentSpawnDispatch(spawnPayload(reviewerPrompt(2, f.tip)), f.env, find);
      const out = JSON.parse(result.stdout);
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(JSON.parse(out.hookSpecificOutput.permissionDecisionReason).check, 'sha_mismatch');
      assert.equal(spawnRows(f.db).length, 0);
    });

    it('a non-reviewer spawn writes none', async () => {
      const f = fixture('tip');
      assert.deepEqual(await agentSpawnDispatch(spawnPayload(reviewerPrompt(2, f.tip), 'swe'), f.env, find), ALLOW);
      assert.equal(spawnRows(f.db).length, 0);
    });

    it('a reviewer spawn missing an anchor or carrying a malformed one writes none', async () => {
      const f = fixture('tip');
      for (const prompt of [
        `task_id=${TASK_ID} commit_sha=${f.tip}`,
        `task_id=${TASK_ID} attempt_n=two commit_sha=${f.tip}`,
        `task_id=${TASK_ID} attempt_n=2 commit_sha=xyz`,
        `task_id=${TASK_ID} attempt_n=2 commit_sha=${f.tip}ff`,
      ]) {
        assert.deepEqual(recordReviewerSpawn(spawnPayload(prompt), f.env), ALLOW, prompt);
      }
      assert.equal(spawnRows(f.db).length, 0);
    });

    it('a spawn for an unknown task or with no DB writes none and allows', () => {
      const f = fixture('tip');
      assert.deepEqual(recordReviewerSpawn(spawnPayload(`task_id=999 attempt_n=1 commit_sha=${f.tip}`), f.env), ALLOW);
      assert.equal(spawnRows(f.db).length, 0);
      const missing = { ...f.env, TRAJECTORY_DB_PATH: join(sandbox, 'missing', 'trajectory.db') };
      assert.deepEqual(recordReviewerSpawn(spawnPayload(reviewerPrompt(1, f.tip)), missing), ALLOW);
    });
  });

  describe('reviewerSpawnAnchors', () => {
    it('reads quoted and spaced anchors and lowercases the sha', () => {
      assert.deepEqual(reviewerSpawnAnchors(`task_id = 3\nattempt_n='2' commit_sha="ABCDEF1"`), { taskId: 3, attemptN: 2, commitSha: 'abcdef1' });
    });
    it('ignores an anchor name inside a longer word', () => {
      assert.equal(reviewerSpawnAnchors('own_task_id=3 attempt_n=2 commit_sha=abcdef1'), null);
    });
  });

  describe('SC4: the v64 -> v65 migration', () => {
    it('adds reviewed_sha to a v64 DB as NULL and leaves every existing row as it was', () => {
      const dir = caseDir();
      mkdirSync(dir, { recursive: true });
      const dbFile = join(dir, 'trajectory.db');
      new TrajectoryDB(dbFile).close();
      const raw = new DatabaseSync(dbFile);
      raw.exec(`
        INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (${ISSUE_ID}, 'o', 'open', '${NOW}', '${NOW}');
        INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (${TASK_ID}, ${ISSUE_ID}, 'b', 'd', 'closed', '${NOW}', '${NOW}');
        INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, reviewer_agent_id, created_at)
          VALUES (${TASK_ID}, 1, 'code-reviewer', 'pass', 'ok', 1, 's', 'reviewer-agent-0001', '${NOW}');
        ALTER TABLE validation_attempts DROP COLUMN reviewed_sha;
        UPDATE plugin_meta SET schema_version = 64 WHERE id = 1;
      `);
      const before = raw.prepare('SELECT * FROM validation_attempts ORDER BY id').all().map((r) => ({ ...r }));
      raw.close();

      const migrated = new TrajectoryDB(dbFile, undefined, { migrate: true });
      try {
        assert.equal(migrated.get<{ v: number }>('SELECT schema_version AS v FROM plugin_meta WHERE id = 1')!.v, 68);
        const after = migrated.all<Record<string, unknown>>('SELECT * FROM validation_attempts ORDER BY id').map((r) => ({ ...r }));
        assert.deepEqual(after, before.map((r) => ({ ...r, reviewed_sha: null })));
        assert.deepEqual(
          migrated.all<{ name: string }>('PRAGMA table_info(validation_attempts)').map((c) => c.name).slice(-1),
          ['reviewed_sha'],
        );
      } finally {
        migrated.close();
      }
    });
  });
});
