/**
 * The review-first order end to end (GH 2866) on a project that is not the
 * plugin repo: sources under lib/, docs under documentation/, no changelog.d.
 * task_provision → swe completes → review_handoff → code-reviewer verdict →
 * bro_atomic_close, with the code-reviewer spawn gate run as the shipped
 * bundle against the same DB file.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { TrajectoryDB } from '../db.js';
import { compositeTools } from '../tools/composites.js';
import { taskTools } from '../tools/tasks.js';
import { validationTools } from '../tools/validation.js';
import { makeSandbox, runGate, type Sandbox } from './hook-sandbox.js';
import { seedReviewerObservation, tempDB } from './helpers.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, ((args: Record<string, unknown>) => Promise<unknown>) | undefined>;

const SESSION = 'session-2866-review-handoff';
const SPEC = [
  '## Objective',
  'Add a percentage discount to the cart and document it.',
  '',
  '## Files',
  '- `lib/` — the discount helper',
  '- `documentation/` — the user guide',
  '',
  '## Success Criteria',
  '- SC1: applyDiscount(100, 10) returns 90',
].join('\n');

describe('review_handoff: code-reviewer reviews the completed task, bro closes after the pass (GH 2866)', () => {
  let sb: Sandbox;
  let repoRoot: string;
  let dbPath: string;
  let db: TrajectoryDB;
  let handlers: Handlers;
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

  before(() => {
    sb = makeSandbox('review-handoff');
    repoRoot = join(sb.dir, 'shop');
    mkdirSync(join(repoRoot, 'lib'), { recursive: true });
    mkdirSync(join(repoRoot, 'documentation'), { recursive: true });
    git(repoRoot, 'init', '-q', '-b', 'main');
    git(repoRoot, 'config', 'user.email', 't@t.t');
    git(repoRoot, 'config', 'user.name', 't');
    writeFileSync(join(repoRoot, 'lib', 'cart.js'), 'export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n');
    writeFileSync(join(repoRoot, 'documentation', 'guide.md'), '# Cart\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-q', '-m', 'base');
    git(repoRoot, 'update-ref', 'refs/remotes/origin/main', git(repoRoot, 'rev-parse', 'HEAD'));
    mkdirSync(join(sb.dir, '.claude', 'tmb'), { recursive: true });
    dbPath = join(sb.dir, '.claude', 'tmb', 'trajectory.db');
    db = tempDB({ path: dbPath });
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('shop', ?, 'main')`, [repoRoot]);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
    handlers = { ...compositeTools(db, dbPath).handlers, ...taskTools(db).handlers, ...validationTools(db).handlers };
  });

  after(() => {
    db.close();
    sb.remove();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await handlers[name]!(args)) as RawResult;
    return { isError: r.isError === true, body: JSON.parse(r.content[0].text) as Record<string, unknown> };
  };
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const status = (taskId: number) => db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])!.status;
  const close = (taskId: number, sha: string) =>
    call('bro_atomic_close', { agent: 'bro', task_id: String(taskId), commit_sha: sha, verification_summary: 'reviewed' });

  const provision = async (branchId: string): Promise<{ taskId: number; worktree: string }> => {
    const body = await ok('task_provision', {
      agent: 'bro', issue_id: 1, branch_id: branchId, decision_body: 'Chosen approach: a pure helper in lib/ plus a guide page.',
      task: { description: 'discount', spec_body: SPEC, files: ['lib/', 'documentation/'], verification: ['true'], repo: 'shop' },
    });
    const taskId = Number(body['task_id']);
    const worktree = String(body['worktree_path']);
    assert.ok(existsSync(worktree), `worktree ${worktree}`);
    return { taskId, worktree };
  };

  const sweCommits = async (taskId: number, worktree: string, files: Record<string, string>): Promise<string> => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(worktree, path), text);
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-q', '-m', 'discount');
    const sha = git(worktree, 'rev-parse', 'HEAD');
    await ok('task_brief', { agent: 'swe', task_id: taskId });
    const complete = {
      agent: 'swe', task_id: String(taskId), status: 'completed', commit_sha: sha,
      report: { criteria: [{ id: 'SC1', status: 'met', evidence_cmd: 'true' }] },
    };
    const gate = runGate('swe-verification-gate', {
      cwd: worktree,
      input: JSON.stringify({
        session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_tmb_trajectory-server__task_update_status', tool_input: complete,
      }),
      env: { ...sb.env, CLAUDE_PROJECT_DIR: sb.dir, TRAJECTORY_DB_PATH: dbPath },
    });
    assert.equal(gate.status, 0);
    assert.doesNotMatch(gate.stdout, /"permissionDecision":"deny"/, gate.stdout);
    await ok('task_update_status', complete);
    assert.equal(status(taskId), 'completed');
    return sha;
  };

  const reviewerSpawnGate = (prompt: string) =>
    runGate('code-reviewer-after-atomic-close', {
      cwd: sb.dir,
      input: JSON.stringify({
        session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: 'Agent',
        tool_input: { subagent_type: 'tmb:code-reviewer', prompt, effort: 'high', description: 'review' },
      }),
      env: { ...sb.env, CLAUDE_PROJECT_DIR: sb.dir, TRAJECTORY_DB_PATH: dbPath },
    });

  const verdict = async (taskId: number, attemptN: number, v: 'pass' | 'fail', findings: unknown[] = []) => {
    seedReviewerObservation(db, taskId, attemptN, { agentId: `reviewer${attemptN}agent${taskId}x` });
    await ok('validation_record', {
      agent: 'code-reviewer', task_id: String(taskId), attempt_n: attemptN, verdict: v, feedback: v, mcp_available: true, findings,
    });
  };

  it('a completed task is handed off, reviewed, then closed; the close and the reviewer spawn wait for their step', async () => {
    const { taskId, worktree } = await provision('feat/discount');
    const sha = await sweCommits(taskId, worktree, {
      'lib/discount.js': 'export const applyDiscount = (p, pct) => p - (p * pct) / 100;\n',
      'documentation/discount.md': '# Discounts\n',
    });

    const early = reviewerSpawnGate(`task_id=${taskId} commit_sha=${sha} attempt_n=1`);
    assert.equal(early.status, 0);
    assert.match(early.stdout, /"permissionDecision":"deny"/);
    assert.match(early.stdout, /review_handoff/);

    const unreviewed = await close(taskId, sha);
    assert.ok(unreviewed.isError);
    assert.match(String(unreviewed.body['error']), /^review_pass_missing: /);

    const handoff = await ok('review_handoff', { agent: 'bro', task_id: String(taskId), session_id: SESSION });
    assert.equal(handoff['review_pending'], true);
    assert.equal(typeof handoff['reviewer_effort'], 'string');
    assert.equal(status(taskId), 'completed', 'the handoff leaves the status alone');
    const anchor = db.get<{ content_json: string }>(`SELECT content_json FROM audit WHERE event_type = 'review_handoff'`)!;
    const recorded = JSON.parse(anchor.content_json) as Record<string, unknown>;
    assert.equal(recorded['task_id'], taskId);
    assert.equal(recorded['commit_sha'], sha);
    assert.ok(recorded['scope'], 'the handoff records the scope report');

    const spawn = handoff['reviewer_spawn'] as { prompt: string };
    const allowed = reviewerSpawnGate(spawn.prompt);
    assert.equal(allowed.status, 0);
    assert.equal(allowed.stdout, '', `the handed-off spawn passes: ${allowed.stdout}`);

    const pending = await close(taskId, sha);
    assert.match(String(pending.body['error']), /^review_pass_missing: /, 'no verdict yet');

    await verdict(taskId, 1, 'pass');
    await ok('bro_atomic_close', { agent: 'bro', task_id: String(taskId), commit_sha: sha, verification_summary: 'reviewed' });
    assert.equal(status(taskId), 'closed');
    assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit WHERE event_type = 'bro_verification_pass'`)!.c, 1);
  });

  it('a FAIL on the completed task reopens it for rework, and the reworked commit closes after its own pass', async () => {
    const { taskId, worktree } = await provision('feat/discount-guard');
    const first = await sweCommits(taskId, worktree, { 'lib/discount.js': 'export const applyDiscount = (p, pct) => p - pct;\n' });
    await ok('review_handoff', { agent: 'bro', task_id: String(taskId) });
    await verdict(taskId, 1, 'fail', [{
      criterion_id: 'SC1', probe_cmd: 'grep -q "/ 100" lib/discount.js', expected: 'a percentage', observed: 'subtracts pct as an amount',
    }]);
    assert.equal(status(taskId), 'running', 'the FAIL reopens the task itself (GH 2866)');
    assert.match(String((await close(taskId, first)).body['error']), /status is "running"/, 'a FAIL never closes');

    const second = await sweCommits(taskId, worktree, { 'lib/discount.js': 'export const applyDiscount = (p, pct) => p - (p * pct) / 100;\n' });
    assert.match(String((await close(taskId, second)).body['error']), /^review_pass_missing: /, 'the first pass of a new commit needs its own handoff');
    await ok('review_handoff', { agent: 'bro', task_id: String(taskId) });
    await verdict(taskId, 2, 'pass');
    await ok('bro_atomic_close', { agent: 'bro', task_id: String(taskId), commit_sha: second, verification_summary: 'reworked and reviewed' });
    assert.equal(status(taskId), 'closed');
  });

  it('F857-1: a disputed FAIL re-hands the unchanged, verified commit to a new code-reviewer after a re_review analysis, then closes on its pass', async () => {
    const { taskId, worktree } = await provision('feat/discount-dispute');
    const sha = await sweCommits(taskId, worktree, { 'lib/discount.js': 'export const applyDiscount = (p, pct) => p - (p * pct) / 100;\n' });
    const report = db.get<{ completion_report: string }>('SELECT completion_report FROM tasks WHERE id = ?', [taskId])!.completion_report;
    await ok('review_handoff', { agent: 'bro', task_id: String(taskId) });
    await verdict(taskId, 1, 'fail', [{
      criterion_id: 'SC1', probe_cmd: 'grep -q "Math.round" lib/discount.js', expected: 'rounded cents', observed: 'no rounding', class: 'spec-overreach',
    }]);
    assert.equal(status(taskId), 'running');
    const failId = db.get<{ id: number }>(`SELECT id FROM validation_attempts WHERE task_id = ? AND verdict = 'fail'`, [taskId])!.id;
    const findingId = db.get<{ id: string }>('SELECT id FROM review_findings WHERE task_id = ?', [taskId])!.id;
    const handoff = () => call('review_handoff', { agent: 'bro', task_id: String(taskId), session_id: SESSION });

    const live = await handoff();
    assert.ok(live.isError);
    assert.match(String(live.body['error']), /^re_review_refused: .*swe run \d+ of task \d+ is live/);
    db.run(`UPDATE agent_runs SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id = ? AND completed_at IS NULL`, [taskId]);

    const noAnalysis = await handoff();
    assert.match(String(noAnalysis.body['error']), /^re_review_refused: .*latest task_rework_analysis \(none\)/);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await ok('task_rework_analysis', {
      agent: 'bro', task_id: taskId, fail_validation_ids: [failId], finding_ids: [findingId], root_cause: 'reviewer_disputed', change: 're_review',
      approach_shared_cause: false, rationale: 'SC1 asks for no rounding; the finding reads a requirement the spec does not state.',
    });
    const unwaived = await handoff();
    assert.match(String(unwaived.body['error']), /^verification_run_missing: /, 'the disputed finding still needs its probe or a wontfix');
    assert.equal(status(taskId), 'running', 'a refused handoff leaves the task running');

    await ok('task_reopen', {
      agent: 'bro', task_id: taskId, reason: 'reviewer disputed', effort: 'high',
      wontfix: [{ finding_id: findingId, reason: 'The Human accepts it: SC1 asks for no rounding and the probe tests a requirement outside the spec.' }],
    });

    const reReview = await handoff();
    assert.ok(!reReview.isError, JSON.stringify(reReview.body));
    assert.equal(reReview.body['re_review_of'], failId);
    assert.equal(reReview.body['commit_sha'], sha);
    assert.equal(status(taskId), 'completed', 'the re-review restores the completion the FAIL cleared');
    assert.equal(db.get<{ completion_report: string }>('SELECT completion_report FROM tasks WHERE id = ?', [taskId])!.completion_report, report);

    const spawn = reReview.body['reviewer_spawn'] as { prompt: string };
    const allowed = reviewerSpawnGate(spawn.prompt);
    assert.equal(allowed.stdout, '', `the re-review spawn passes: ${allowed.stdout}`);
    await verdict(taskId, 2, 'pass');
    await ok('bro_atomic_close', { agent: 'bro', task_id: String(taskId), commit_sha: sha, verification_summary: 're-reviewed' });
    assert.equal(status(taskId), 'closed');
  });

  it('SC1 (GH 2932): a docs-only handoff under reviewer_tier_settings returns and records the tier model, and the effort gate admits that spawn as is', async () => {
    db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('reviewer_effort_tiers', 'true'), ('reviewer_tier_settings', '{"docs_tests":{"model":"sonnet","effort":"high"}}')`);
    try {
      const { taskId, worktree } = await provision('feat/discount-docs');
      await sweCommits(taskId, worktree, { 'documentation/faq.md': '# FAQ\n' });
      const handoff = await ok('review_handoff', { agent: 'bro', task_id: String(taskId), session_id: SESSION });
      const spawn = handoff['reviewer_spawn'] as { prompt: string; effort: string; model?: string; subagent_type: string };
      assert.equal(spawn.model, 'sonnet');
      assert.equal(spawn.effort, 'high');
      const row = db.get<{ content_json: string }>(
        `SELECT content_json FROM audit WHERE event_type = 'reviewer_effort_assigned' AND json_extract(content_json, '$.task_id') = ? ORDER BY id DESC LIMIT 1`,
        [taskId],
      )!;
      const assigned = JSON.parse(row.content_json) as Record<string, unknown>;
      assert.deepEqual([assigned['model'], assigned['effort'], assigned['reason']], ['sonnet', 'high', 'docs_tests']);

      const effortGate = (toolInput: Record<string, unknown>) =>
        runGate('require-spawn-effort', {
          cwd: sb.dir,
          input: JSON.stringify({ session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { ...toolInput, description: 'review' } }),
          env: { ...sb.env, CLAUDE_PROJECT_DIR: sb.dir, TRAJECTORY_DB_PATH: dbPath },
        }).stdout;
      assert.equal(effortGate(spawn), '', 'the returned spawn passes as is');
      const withoutModel = { prompt: spawn.prompt, effort: spawn.effort, subagent_type: spawn.subagent_type };
      assert.match(effortGate(withoutModel), /"permissionDecision":"deny"/, 'dropping the model is denied');
    } finally {
      db.run(`DELETE FROM plugin_config WHERE key IN ('reviewer_effort_tiers', 'reviewer_tier_settings')`);
    }
  });
});
