/**
 * review_handoff's reviewer_spawn round trip (GH 2582, GH 2866): a handoff
 * with session_id returns {prompt, effort, subagent_type}, and that payload
 * passed as is to the Agent tool clears code-reviewer-after-atomic-close,
 * code-reviewer-spawn-prompt-shape, code-reviewer-spawn-note and
 * require-spawn-effort, run as the shipped bundle against the same DB file.
 * Without session_id the result names reviewer_spawn_unavailable instead.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { TrajectoryDB } from '../db.js';
import { ANCHORS } from '../hooks/code-reviewer-spawn-note.js';
import { compositeTools, taskWorktreePath } from '../tools/composites.js';
import { makeSandbox, runGate, type Sandbox } from './hook-sandbox.js';
import { tempDB } from './helpers.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
interface ReviewerSpawn {
  prompt: string;
  effort: string;
  subagent_type: string;
}
interface HandoffResult {
  reviewer_effort: string;
  reviewer_spawn?: ReviewerSpawn;
  reviewer_spawn_unavailable?: string;
}

const NOW = '2026-11-08T12:00:00.000Z';
const SESSION = 'session-2582-roundtrip';
const GATES = ['code-reviewer-after-atomic-close', 'code-reviewer-spawn-prompt-shape', 'code-reviewer-spawn-note', 'require-spawn-effort'];

describe('review_handoff reviewer_spawn round trip (GH 2582, GH 2866)', () => {
  let sb: Sandbox;
  let repoRoot: string;
  let dbPath: string;
  let db: TrajectoryDB;
  let composites: ReturnType<typeof compositeTools>;
  let baseSha: string;
  const git = (...a: string[]) => execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

  before(() => {
    sb = makeSandbox('reviewer-spawn');
    repoRoot = join(sb.dir, 'my app');
    mkdirSync(repoRoot, { recursive: true });
    git('init', '-q', '-b', 'dev');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    baseSha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/dev', baseSha);
    dbPath = join(sb.dir, 'trajectory.db');
    db = tempDB({ path: dbPath });
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'dev')`, [repoRoot]);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'o', 'd', 'open', ?, ?)`, [NOW, NOW]);
    db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('reviewer_effort', '"high"')`);
    composites = compositeTools(db, dbPath);
  });

  after(() => {
    db.close();
    sb.remove();
  });

  const handoff = async (
    id: number,
    worktreePath: string | null,
    sessionId?: string,
    priorValidators: string[] = [],
  ): Promise<{ result: HandoffResult; sha: string }> => {
    const branch = `feat/t${id}`;
    git('checkout', '-q', '-b', branch, baseSha);
    writeFileSync(join(repoRoot, `t${id}.ts`), `${id}\n`);
    git('add', '.');
    git('commit', '-q', '-m', branch);
    const sha = git('rev-parse', 'HEAD');
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, repo, files, commit_sha, worktree_path, created_at, updated_at)
       VALUES (?, 1, ?, 'dev', 'd', 'completed', 's', 'app', ?, ?, ?, ?, ?)`,
      [id, branch, JSON.stringify([`t${id}.ts`]), sha, worktreePath, NOW, NOW],
    );
    priorValidators.forEach((agent, i) => {
      db.run(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, ?, ?, 'fail', 1, ?)`, [id, i + 1, agent, NOW]);
    });
    const args: Record<string, unknown> = { agent: 'bro', task_id: String(id) };
    if (sessionId !== undefined) args['session_id'] = sessionId;
    const r = (await composites.handlers.review_handoff!(args)) as RawResult;
    const result = JSON.parse(r.content[0]!.text) as HandoffResult;
    assert.ok(!r.isError, JSON.stringify(result));
    return { result, sha };
  };

  const agentPayload = (spawn: ReviewerSpawn) =>
    JSON.stringify({
      session_id: SESSION,
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: spawn.subagent_type, prompt: spawn.prompt, effort: spawn.effort, description: 'review' },
    });

  const runGates = (input: string) =>
    GATES.map((gate) => {
      const r = runGate(gate, { cwd: sb.dir, input, env: { ...sb.env, CLAUDE_PROJECT_DIR: sb.dir, TRAJECTORY_DB_PATH: dbPath } });
      return { gate, status: r.status, stdout: r.stdout };
    });

  it('returns a reviewer_spawn every spawn gate allows as is', async () => {
    const { result, sha } = await handoff(1, repoRoot, SESSION);
    const spawn = result.reviewer_spawn;
    assert.ok(spawn, JSON.stringify(result));
    assert.ok(spawn.prompt.length > 0, 'non-empty prompt');
    assert.equal(spawn.subagent_type, 'tmb:code-reviewer');
    assert.equal(spawn.effort, 'high');
    assert.equal(spawn.effort, result.reviewer_effort);
    assert.equal(result.reviewer_spawn_unavailable, undefined);
    for (const name of ANCHORS) assert.ok(spawn.prompt.includes(`${name}=`), `${name} anchor`);
    assert.ok(spawn.prompt.includes(`task_id=1 commit_sha=${sha} branch_id=feat/t1 repo=app repo_path='${repoRoot}' attempt_n=1 subagent_session_id=${SESSION}`), spawn.prompt);
    assert.ok(spawn.prompt.split('\n').length <= 2, 'anchors plus at most one line');

    for (const run of runGates(agentPayload(spawn))) {
      assert.equal(run.status, 0, run.gate);
      assert.equal(run.stdout, '', `${run.gate} allows the payload: ${run.stdout}`);
    }
  });

  it('the gates still deny a payload with the effort changed, so the round trip is live', async () => {
    const { result } = await handoff(3, repoRoot, SESSION);
    const runs = runGates(agentPayload({ ...result.reviewer_spawn!, effort: 'low' }));
    const effort = runs.find((r) => r.gate === 'require-spawn-effort')!;
    assert.ok(effort.stdout.includes('"permissionDecision":"deny"'), effort.stdout);
  });

  it('names the task worktree as repo_path and counts prior code-reviewer rows into attempt_n', async () => {
    const { result } = await handoff(5, null, SESSION, ['code-reviewer', 'tmb:code-reviewer', 'swe']);
    const prompt = result.reviewer_spawn!.prompt;
    assert.ok(prompt.includes(`repo_path='${taskWorktreePath(repoRoot, 'feat/t5')}'`), prompt);
    assert.ok(prompt.includes('attempt_n=3 '), prompt);
  });

  it('without session_id omits reviewer_spawn and names the missing input', async () => {
    const { result } = await handoff(7, repoRoot);
    assert.equal(result.reviewer_spawn, undefined);
    assert.equal(result.reviewer_spawn_unavailable, 'session_id');
    assert.equal(result.reviewer_effort, 'high');
  });

  it('refuses an invalid session_id', async () => {
    const r = (await composites.handlers.review_handoff!({ agent: 'bro', task_id: '9', session_id: 'bad id!' })) as RawResult;
    assert.ok(r.isError, r.content[0]!.text);
  });
});
