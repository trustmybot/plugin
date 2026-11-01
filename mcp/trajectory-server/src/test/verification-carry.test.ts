// planCarry (GH 1950): which gate commands a rework commit carries forward
// from the task's last passing run, over a temp git repo and trajectory DB,
// and every reason it carries nothing.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrajectoryDB } from '../db.js';
import { planCarry, planCarrySafe, VERIFICATION_INPUTS_PATH, type CarryRequest } from '../hooks/lib/verification-carry.js';
import { latestVerificationRun, passingRunForCommit } from '../tools/verification-runs.js';
import { tempDB } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../hooks/lib/verification-carry.js');

const HOOKS = 'bash tests/hooks.test.sh';
const LINT = 'bash tests/lint.sh';
const DOCS = 'bash tests/docs.test.sh';
const UNDECLARED = 'bash tests/everything.sh';
const PROBE = '[probe F1-1] bash tests/hooks.test.sh';

const MAP = {
  version: 1,
  commands: [
    { match: HOOKS, inputs: ['scripts/**', 'tests/**'] },
    { match: LINT, inputs: ['scripts/**/*.sh'] },
    { match: DOCS, inputs: ['docs/**'] },
  ],
};

const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();

function write(repo: string, path: string, body: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}

function commit(repo: string, files: Record<string, string>, msg = 'change'): string {
  for (const [path, body] of Object.entries(files)) write(repo, path, body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

describe('planCarry (GH 1950)', () => {
  let root: string;
  let repo: string;
  let dbPath: string;
  let db: TrajectoryDB;
  let taskId: number;
  let base: string;
  const commands = [HOOKS, LINT, DOCS, UNDECLARED, PROBE];

  function seedRun(sha: string, rows: Array<[string, number]>, exitCode = 0, timedOut = 0): number {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
       VALUES (?, ?, 'gate', ?, ?, ?, 900, ?)`,
      [taskId, sha, now, now, exitCode, timedOut],
    );
    const runId = db.get<{ id: number }>(`SELECT MAX(id) AS id FROM verification_runs`)!.id;
    rows.forEach(([command, exit], i) => {
      db.run(
        `INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (?, ?, ?, ?, 1.5, '')`,
        [runId, i + 1, command, exit],
      );
    });
    return runId;
  }

  const greenRows = (): Array<[string, number]> => [
    [HOOKS, 0],
    [LINT, 0],
    [DOCS, 0],
    [UNDECLARED, 0],
    [PROBE, 0],
  ];

  const request = (head: string, cmds: string[] = commands): CarryRequest => ({
    db: dbPath,
    taskId: String(taskId),
    worktree: repo,
    head,
    commandsJson: JSON.stringify(cmds),
  });

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'verification-carry-'));
    dbPath = join(root, 'trajectory.db');
    db = tempDB({ path: dbPath });
    const now = new Date().toISOString();
    db.run(`INSERT INTO issues (objective, created_at, updated_at) VALUES ('carry', ?, ?)`, [now, now]);
    const issueId = db.get<{ id: number }>(`SELECT MAX(id) AS id FROM issues`)!.id;
    db.run(`INSERT INTO tasks (issue_id, branch_id, description, created_at, updated_at) VALUES (?, 'perf/carry', 'carry', ?, ?)`, [
      issueId,
      now,
      now,
    ]);
    taskId = db.get<{ id: number }>(`SELECT MAX(id) AS id FROM tasks`)!.id;
  });

  after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.run(`DELETE FROM verification_runs`);
    repo = mkdtempSync(join(root, 'repo-'));
    git(repo, 'init', '-q', '-b', 'dev');
    base = commit(repo, {
      [VERIFICATION_INPUTS_PATH]: JSON.stringify(MAP),
      'scripts/hooks/gate.sh': 'echo gate\n',
      'tests/hooks.test.sh': 'echo test\n',
      'docs/x.md': 'docs\n',
    });
  });

  it('a docs-only rework carries every declared command whose inputs it missed, from the newest passing run', async () => {
    seedRun(base, [[HOOKS, 1]], 1);
    const runId = seedRun(base, greenRows());
    const head = commit(repo, { 'docs/x.md': 'docs v2\n' });
    const plan = await planCarry(request(head));
    assert.equal(plan.refused, null);
    assert.equal(plan.source_run, runId);
    assert.equal(plan.source_sha, base);
    assert.deepEqual(plan.carry, [1, 2]);
    assert.deepEqual(
      plan.commands.map((c) => [c.ordinal, c.carried, c.reason]),
      [
        [1, true, null],
        [2, true, null],
        [3, false, 'inputs_changed'],
        [4, false, 'undeclared'],
        [5, false, 'probe'],
      ],
    );
  });

  it('a code change matching a glob is not carried, and globs that miss it still are', async () => {
    seedRun(base, greenRows());
    const head = commit(repo, { 'tests/hooks.test.sh': 'echo test v2\n' });
    const plan = await planCarry(request(head));
    assert.deepEqual(plan.carry, [2, 3]);
    assert.equal(plan.commands[0].reason, 'inputs_changed');
  });

  it('a renamed file counts at both its old and new path', async () => {
    seedRun(base, greenRows());
    git(repo, 'mv', 'scripts/hooks/gate.sh', 'docs/gate.txt');
    const head = commit(repo, {});
    const plan = await planCarry(request(head));
    assert.deepEqual(plan.carry, []);
    assert.deepEqual(
      plan.commands.slice(0, 3).map((c) => c.reason),
      ['inputs_changed', 'inputs_changed', 'inputs_changed'],
    );
  });

  it('a command the source run failed or never ran is not carried', async () => {
    seedRun(base, [
      [HOOKS, 2],
      [DOCS, 0],
    ]);
    const head = commit(repo, { 'README.md': 'readme\n' });
    const plan = await planCarry(request(head));
    assert.deepEqual(plan.carry, [3]);
    assert.equal(plan.commands[0].reason, 'not_passed_in_source');
    assert.equal(plan.commands[1].reason, 'not_passed_in_source');
  });

  it('a command two map entries match is not carried', async () => {
    seedRun(base, greenRows());
    const ambiguous = { version: 1, commands: [...MAP.commands, { match: LINT, inputs: ['other/**'] }] };
    const head1 = commit(repo, { [VERIFICATION_INPUTS_PATH]: JSON.stringify(ambiguous) });
    seedRun(head1, greenRows());
    const head2 = commit(repo, { 'README.md': 'readme\n' });
    const plan = await planCarry(request(head2));
    assert.deepEqual(plan.carry, [1, 3]);
    assert.equal(plan.commands[1].reason, 'ambiguous_declaration');
  });

  it('carries nothing without a passing, finished, untimed source run on another commit', async () => {
    const head = commit(repo, { 'docs/x.md': 'docs v2\n' });
    assert.equal((await planCarry(request(head))).refused, 'no_source_run');
    seedRun(base, greenRows(), 1);
    seedRun(base, greenRows(), 124, 1);
    seedRun(head, greenRows());
    db.run(`INSERT INTO verification_runs (task_id, commit_sha, source, started_at, budget_s) VALUES (?, ?, 'gate', ?, 900)`, [
      taskId,
      base,
      new Date().toISOString(),
    ]);
    const plan = await planCarry(request(head));
    assert.equal(plan.refused, 'no_source_run');
    assert.deepEqual(plan.carry, []);
  });

  it('carries nothing when the source commit is not an ancestor of HEAD (a rebase)', async () => {
    const side = commit(repo, { 'docs/side.md': 'side\n' });
    seedRun(side, greenRows());
    git(repo, 'reset', '-q', '--hard', base);
    const head = commit(repo, { 'docs/x.md': 'docs v2\n' });
    const plan = await planCarry(request(head));
    assert.equal(plan.refused, 'not_ancestor');
    assert.deepEqual(plan.carry, []);
  });

  it('carries nothing over a merge commit in P..HEAD', async () => {
    seedRun(base, greenRows());
    git(repo, 'checkout', '-q', '-b', 'side');
    commit(repo, { 'docs/side.md': 'side\n' });
    git(repo, 'checkout', '-q', 'dev');
    commit(repo, { 'docs/x.md': 'docs v2\n' });
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'side');
    const plan = await planCarry(request(git(repo, 'rev-parse', 'HEAD')));
    assert.equal(plan.refused, 'merge_in_range');
    assert.deepEqual(plan.carry, []);
  });

  it('carries nothing from a dirty worktree, tracked or untracked', async () => {
    seedRun(base, greenRows());
    const head = commit(repo, { 'docs/x.md': 'docs v2\n' });
    write(repo, 'docs/untracked.md', 'new\n');
    assert.equal((await planCarry(request(head))).refused, 'dirty_worktree');
    rmSync(join(repo, 'docs/untracked.md'));
    write(repo, 'docs/x.md', 'edited\n');
    const plan = await planCarry(request(head));
    assert.equal(plan.refused, 'dirty_worktree');
    assert.deepEqual(plan.carry, []);
  });

  it('carries nothing when P..HEAD changed the inputs map', async () => {
    seedRun(base, greenRows());
    const head = commit(repo, { [VERIFICATION_INPUTS_PATH]: JSON.stringify({ ...MAP, commands: MAP.commands.slice(0, 2) }) });
    const plan = await planCarry(request(head));
    assert.equal(plan.refused, 'map_changed');
    assert.deepEqual(plan.carry, []);
  });

  it('carries nothing when HEAD has no map, a map of an unknown version, or a malformed one', async () => {
    const cases: Array<[string | null, string]> = [
      [null, 'map_missing'],
      [JSON.stringify({ ...MAP, version: 2 }), 'map_unknown_version'],
      ['{"version":1,', 'map_invalid'],
      [JSON.stringify({ version: 1, commands: [{ match: HOOKS, inputs: [] }] }), 'map_invalid'],
      [JSON.stringify({ version: 1, commands: [{ match: HOOKS }] }), 'map_invalid'],
    ];
    for (const [map, reason] of cases) {
      db.run(`DELETE FROM verification_runs`);
      if (map === null) git(repo, 'rm', '-q', VERIFICATION_INPUTS_PATH);
      else write(repo, VERIFICATION_INPUTS_PATH, map);
      const p = commit(repo, {}, `map ${reason}`);
      seedRun(p, greenRows());
      const head = commit(repo, { 'docs/x.md': `docs ${reason}\n` });
      const plan = await planCarry(request(head));
      assert.equal(plan.refused, reason, `map ${map}`);
      assert.deepEqual(plan.carry, []);
    }
  });

  it('carries nothing on bad input, a HEAD other than the worktree HEAD, or an unreadable DB', async () => {
    seedRun(base, greenRows());
    const head = commit(repo, { 'docs/x.md': 'docs v2\n' });
    assert.equal((await planCarry({ ...request(head), commandsJson: '{"not":"an array"}' })).refused, 'bad_input');
    assert.equal((await planCarry({ ...request(head), commandsJson: '[' })).refused, 'bad_input');
    assert.equal((await planCarry({ ...request(head), taskId: '1; DROP TABLE tasks' })).refused, 'bad_input');
    assert.equal((await planCarry({ ...request(head), head: 'HEAD' })).refused, 'bad_input');
    assert.equal((await planCarry(request(base))).refused, 'head_mismatch');
    assert.equal((await planCarry({ ...request(head), db: join(root, 'missing.db') })).refused, 'db_unreadable');
    assert.equal((await planCarrySafe({ ...request(head), worktree: join(root, 'no-such-dir') })).refused, 'head_mismatch');
  });

  it('a run of carried rows on the new commit passes the close and push checks unchanged', async () => {
    const sourceRun = seedRun(base, greenRows());
    const head = commit(repo, { 'docs/x.md': 'docs v2\n' });
    const plan = await planCarry(request(head));
    assert.deepEqual(plan.carry, [1, 2]);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
       VALUES (?, ?, 'gate', ?, ?, 0, 900, 0)`,
      [taskId, head, now, now],
    );
    const runId = db.get<{ id: number }>(`SELECT MAX(id) AS id FROM verification_runs`)!.id;
    commands.forEach((command, i) => {
      const carried = plan.carry.includes(i + 1);
      db.run(
        `INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (?, ?, ?, 0, ?, ?)`,
        [runId, i + 1, command, carried ? 0 : 1.2, carried ? `carried from run #${sourceRun} at ${base.slice(0, 12)}` : 'ok'],
      );
    });
    assert.equal(passingRunForCommit(db, taskId, head.slice(0, 12), commands), runId);
    const latest = latestVerificationRun(db, taskId);
    assert.equal(latest?.exit_code, 0);
    assert.equal(latest?.commit_sha, head);
  });

  it('the CLI entry prints the plan as one JSON line, and a refusal on bad arguments', () => {
    const runId = seedRun(base, greenRows());
    const head = commit(repo, { 'docs/x.md': 'docs v2\n' });
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    const ok = run(dbPath, String(taskId), repo, head, JSON.stringify(commands));
    assert.equal(ok.status, 0);
    const plan = JSON.parse(ok.stdout) as { source_run: number; carry: number[] };
    assert.equal(plan.source_run, runId);
    assert.deepEqual(plan.carry, [1, 2]);
    assert.equal(ok.stdout.trim().split('\n').length, 1);
    const bad = run(dbPath, String(taskId), repo, head, 'not json');
    assert.equal(bad.status, 0);
    assert.deepEqual(JSON.parse(bad.stdout), { source_run: null, source_sha: null, carry: [], refused: 'bad_input', commands: [] });
  });
});
