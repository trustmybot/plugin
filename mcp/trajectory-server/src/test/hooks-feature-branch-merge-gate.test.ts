/**
 * feature-branch-merge-gate (GH 2225 T5): a PR or MR from an agile feature
 * branch is denied while a task merged onto it is queued for the grouped
 * review, and allowed once a batch pass or the Human's recorded waiver
 * settles every such task.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { featureBranchMergeGate } from '../hooks/feature-branch-merge-gate.js';
import { findGate, gateNames, ROUTER_GROUPS } from '../hooks/registry.js';
import { reviewQueueTools } from '../tools/review-queue.js';

const FEATURE = 'feat/agile-epic';
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function payload(command: string, cwd: string): string {
  return JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });
}

function reason(stdout: string): string {
  if (stdout === '') return '';
  const out = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('feature-branch-merge-gate', () => {
  let dir: string;
  let repo: string;
  let other: string;
  let dbFile: string;
  let db: TrajectoryDB;
  let env: NodeJS.ProcessEnv;
  let issue: number;
  const now = (): string => new Date().toISOString();

  // A task merged onto <branch> at <commit>, closed agile and queued, as bro_atomic_close and cli feature-merge leave it.
  function mergeTask(branch: string, commit: string, repoName: string | null = null): number {
    db.run(
      `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, description, status, commit_sha, repo, workflow_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'd', 'closed', ?, ?, 'agile', ?, ?)`,
      [issue, `feat/t-${commit}`, branch, commit, repoName, now(), now()],
    );
    const id = db.get<{ id: number }>('SELECT MAX(id) AS id FROM tasks')!.id;
    const audit = `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', ?, 's', ?, ?)`;
    db.run(audit, [issue, 'review_queued', JSON.stringify({ task_id: id, commit_sha: commit }), now()]);
    db.run(audit, [issue, 'feature_branch_merged', JSON.stringify({ task_id: id, feature_branch: branch, commit_sha: commit, rebased: false }), now()]);
    return id;
  }

  async function judge(command: string, cwd = dir): Promise<string> {
    const r = await featureBranchMergeGate(payload(command, cwd), env);
    assert.equal(r.code, 0);
    return reason(r.stdout);
  }

  async function waive(branch: string, repoName?: string): Promise<RawResult> {
    return (await reviewQueueTools(db).handlers['review_waive_record']({
      agent: 'bro',
      feature_branch: branch,
      human_answer: 'Yes, merge it',
      ...(repoName === undefined ? {} : { repo: repoName }),
    })) as RawResult;
  }

  function gitInit(path: string, branch: string): void {
    mkdirSync(path);
    const r = spawnSync('git', ['init', '-q', '-b', branch, path], { encoding: 'utf8', env: GIT_ENV, timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
  }

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-fbmg-')));
    repo = join(dir, 'repo');
    other = join(dir, 'other');
    for (const [path, branch] of [
      [repo, FEATURE],
      [other, 'feat/plain'],
    ] as const) {
      gitInit(path, branch);
    }
    dbFile = join(dir, 'trajectory.db');
    db = tempDB({ path: dbFile });
    db.run(`INSERT INTO issues (objective, status, created_at, updated_at) VALUES ('epic', 'open', ?, ?)`, [now(), now()]);
    issue = db.get<{ id: number }>('SELECT MAX(id) AS id FROM issues')!.id;
    env = { ...GIT_ENV, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: dbFile };
  });

  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is registered in the PreToolUse Bash router group', () => {
    assert.equal(findGate('feature-branch-merge-gate'), featureBranchMergeGate);
    assert.ok(gateNames().includes('feature-branch-merge-gate'));
    const bash = ROUTER_GROUPS.find((g) => g.event === 'PreToolUse' && g.gates.some((x) => x.name === 'git-guards'));
    assert.ok(bash?.gates.some((x) => x.name === 'feature-branch-merge-gate'));
  });

  it('denies, then allows after a batch pass and after a waiver, and denies again once a new task merges', async () => {
    const first = mergeTask(FEATURE, 'aaa1111');
    const queuedForms = [
      `gh pr create --base dev --head ${FEATURE} --title t --body b`,
      `gh pr create -H owner:${FEATURE} --title t`,
      `gh pr create --head=${FEATURE}`,
      `glab mr create --source-branch ${FEATURE} --title t`,
      `glab mr create -s ${FEATURE}`,
      `cd ${repo} && gh pr create --title t --body b`,
      `git -C ${repo} status && gh pr create --head ${FEATURE}`,
    ];
    for (const command of queuedForms) {
      const why = await judge(command);
      assert.match(why, new RegExp(`feature branch ${FEATURE} carries agile task\\(s\\) ${first} still queued`), command);
      assert.match(why, /review_batch_record/);
      assert.match(why, new RegExp(`review_waive_record\\(feature_branch='${FEATURE}'`));
    }
    assert.notEqual(await judge('gh pr create --title t', repo), '', 'the checked-out branch of the payload cwd is the head');

    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'code-reviewer', 'review_batch_recorded', 'b', ?, ?)`,
      [issue, JSON.stringify({ task_ids: [first], commit_shas: ['aaa1111'], verdict: 'pass' }), now()],
    );
    assert.equal(await judge(`gh pr create --head ${FEATURE}`), '', 'a batch pass settles the task');

    const second = mergeTask(FEATURE, 'bbb2222');
    const again = await judge(`gh pr create --head ${FEATURE}`);
    assert.match(again, new RegExp(`task\\(s\\) ${second} still queued`), 'a task merged after the pass re-denies, naming only it');

    const waived = await waive(FEATURE);
    assert.ok(!waived.isError, waived.content[0].text);
    assert.deepEqual((JSON.parse(waived.content[0].text) as { task_ids: number[] }).task_ids, [second]);
    assert.equal(await judge(`gh pr create --head ${FEATURE}`), '', 'the waiver settles it');
    assert.equal(await judge(`glab mr create -s ${FEATURE}`), '');

    const third = mergeTask(FEATURE, 'ccc3333');
    assert.match(await judge(`gh pr create --head ${FEATURE}`), new RegExp(`task\\(s\\) ${third} still queued`), 'a task merged after the waiver re-denies');
  });

  it('denies every PR-create spelling from a queued feature branch, allows it after a waiver, and leaves read-only calls alone (GH 2225)', async () => {
    const spell = 'feat/agile-spellings';
    const queued = mergeTask(spell, 'eee5555');
    const spellings = [
      `gh -R o/r pr create --head ${spell}`,
      `gh --repo=o/r pr new -H o:${spell}`,
      `gh pr -R o/r new --head=${spell}`,
      `glab -R o/r mr new -s ${spell}`,
      `glab --repo o/r mr create --source-branch=${spell}`,
      `gh api repos/o/r/pulls -f head=${spell} -f base=dev -f title=t`,
      `gh api -X POST /repos/o/r/pulls -F head=o:${spell}`,
      `gh api --method=post repos/o/r/pulls --field=head=${spell}`,
      `gh api graphql -f query='mutation { createPullRequest(input: {repositoryId: "R", baseRefName: "dev", headRefName: "${spell}", title: "t"}) { pullRequest { id } } }'`,
      `gh api graphql -f query='mutation($h: String!) { createPullRequest(input: {headRefName: $h}) { pullRequest { id } } }' -f headRefName=${spell}`,
    ];
    for (const command of spellings) {
      assert.match(await judge(command), new RegExp(`feature branch ${spell} carries agile task\\(s\\) ${queued} still queued`), command);
    }
    for (const command of [
      `gh -R o/r pr view --head ${spell}`,
      `gh pr list --head ${spell}`,
      `gh api repos/o/r/pulls -f head=${spell} -X GET`,
      `gh api repos/o/r/pulls?head=${spell}`,
      `gh api repos/o/r/pulls/7 -f head=${spell}`,
      `gh api graphql -f query='{ repository(owner: "o", name: "r") { pullRequests(headRefName: "${spell}") { totalCount } } }'`,
    ]) {
      assert.equal(await judge(command), '', command);
    }

    const waived = await waive(spell);
    assert.ok(!waived.isError, waived.content[0].text);
    for (const command of spellings) assert.equal(await judge(command), '', command);
  });

  it('a per-task pass after a review_handoff of the task\'s commit settles it; a FAIL, or a pass of an earlier commit, does not (decision #320 item 3)', async () => {
    const branch = 'feat/agile-per-task';
    const task = mergeTask(branch, 'fff6666');
    const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
    const handoff = (commit: string, createdAt: string): void => {
      db.run(
        `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', 'review_handoff', 'h', ?, ?)`,
        [issue, JSON.stringify({ task_id: task, commit_sha: commit }), createdAt],
      );
    };
    const verdict = (v: 'pass' | 'fail', createdAt: string): void => {
      db.run(
        `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at)
         VALUES (?, (SELECT COALESCE(MAX(attempt_n), 0) + 1 FROM validation_attempts WHERE task_id = ?), 'code-reviewer', ?, 'f', 1, ?)`,
        [task, task, v, createdAt],
      );
    };
    const deniesTask = async (): Promise<boolean> => new RegExp(`task\\(s\\) ${task} still queued`).test(await judge(`gh pr create --head ${branch}`));

    handoff('0ld0000', at(1000));
    verdict('pass', at(2000));
    assert.ok(await deniesTask(), 'a pass anchored to another commit leaves the task queued');

    handoff('fff6666', at(3000));
    verdict('fail', at(4000));
    assert.ok(await deniesTask(), 'a FAIL on the current commit keeps it queued');

    verdict('pass', at(5000));
    assert.equal(await judge(`gh pr create --head ${branch}`), '', 'the per-task pass settles the task');
  });

  it('SC1: a folded task reopened for rework denies again, whatever settled its old commit, and no waiver settles it', async () => {
    const branch = 'feat/agile-reopened';
    const task = mergeTask(branch, 'abc7777');
    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'code-reviewer', 'review_batch_recorded', 'b', ?, ?)`,
      [issue, JSON.stringify({ task_ids: [task], commit_shas: ['abc7777'], verdict: 'pass' }), now()],
    );
    assert.equal(await judge(`gh pr create --head ${branch}`), '', 'the batch pass settles it while closed');
    for (const status of ['pending', 'running', 'needs_validation', 'completed']) {
      db.run('UPDATE tasks SET status = ? WHERE id = ?', [status, task]);
      assert.match(await judge(`gh pr create --head ${branch}`), new RegExp(`task\\(s\\) ${task} still queued`), status);
    }
    const waived = await waive(branch);
    assert.equal(waived.isError, true, 'nothing closed is left to waive');
    assert.equal((JSON.parse(waived.content[0].text) as { error: string }).error, 'no_queued_task');
    assert.match(await judge(`gh pr create --head ${branch}`), new RegExp(`task\\(s\\) ${task} still queued`), 'still denied after the refused waiver');
  });

  it('SC3: a same-named feature branch in another repo neither denies this repo nor is settled by its waiver', async () => {
    const shared = 'feat/agile-shared';
    const appRoot = join(dir, 'gate-app');
    const libRoot = join(dir, 'gate-lib');
    gitInit(appRoot, shared);
    gitInit(libRoot, shared);
    db.run(`INSERT INTO repos (name, path) VALUES ('gate-app', ?), ('gate-lib', ?)`, [appRoot, libRoot]);
    const inLib = mergeTask(shared, '1ib0001', 'gate-lib');
    assert.equal(await judge('gh pr create --title t', appRoot), '', 'the lib task does not deny the app checkout');
    assert.equal(await judge(`cd ${appRoot} && gh pr create --head ${shared}`), '');
    assert.match(await judge('gh pr create --title t', libRoot), new RegExp(`task\\(s\\) ${inLib} still queued`));
    assert.match(await judge(`gh pr create --head ${shared}`), new RegExp(`task\\(s\\) ${inLib} still queued`), 'an unregistered dir is judged against every repo');

    const inApp = mergeTask(shared, 'a990001', 'gate-app');
    assert.match(await judge('gh pr create --title t', appRoot), new RegExp(`task\\(s\\) ${inApp} still queued`), 'the app denial names only its own task');
    const waived = await waive(shared, 'gate-app');
    assert.ok(!waived.isError, waived.content[0].text);
    assert.deepEqual((JSON.parse(waived.content[0].text) as { task_ids: number[] }).task_ids, [inApp]);
    assert.equal(await judge('gh pr create --title t', appRoot), '');
    assert.match(await judge('gh pr create --title t', libRoot), new RegExp(`task\\(s\\) ${inLib} still queued`), 'the app waiver leaves the lib task queued');
  });

  it('allows a head that is no feature branch, other commands, and a missing DB', async () => {
    mergeTask('feat/agile-other', 'ddd4444');
    for (const command of [
      'gh pr create --head feat/t-ddd4444 --title t',
      'gh pr create --title t',
      `cd ${other} && gh pr create --title t`,
      'gh pr create --head feat/unknown',
      'gh pr list',
      'gh pr view 3',
      'gh pr merge 3 --squash',
      'glab mr list',
      'git push origin feat/agile-other',
      'echo gh pr create --head feat/agile-other',
    ]) {
      assert.equal(await judge(command, other), '', command);
    }
    assert.notEqual(await judge('gh pr create --head feat/agile-other', other), '', 'the queued sibling branch itself denies');
    const missing = await featureBranchMergeGate(payload('gh pr create --head feat/agile-other', other), { ...env, TRAJECTORY_DB_PATH: join(dir, 'nowhere.db') });
    assert.deepEqual(missing, { stdout: '', code: 0 });
  });
});
