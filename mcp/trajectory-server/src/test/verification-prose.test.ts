import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { compositeTools } from '../tools/composites.js';
import { checkVerificationPaths, checkVerificationProse } from '../tools/verification-paths.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
const parse = (r: RawResult): Record<string, unknown> => JSON.parse(r.content[0].text) as Record<string, unknown>;

const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');
const PROSE = 'Run schema-upgrade.test and confirm all cases pass';

function makeRepo(): { ws: string; repoRoot: string } {
  const ws = mkdtempSync(join(tmpdir(), 'verification-prose-'));
  const repoRoot = join(ws, 'app');
  mkdirSync(repoRoot, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  for (const p of ['pkg/src/tools/mod.ts', 'tests/existing.test.mjs']) {
    mkdirSync(join(repoRoot, dirname(p)), { recursive: true });
    writeFileSync(join(repoRoot, p), 'x\n');
  }
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  return { ws, repoRoot };
}

function seed(db: TrajectoryDB, repoRoot: string): void {
  db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
  db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
          VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
}

describe('checkVerificationProse (GH 2955)', () => {
  it('refuses a capitalized English word that runs as nothing, naming the entry and the word', () => {
    for (const [command, word] of [
      [PROSE, 'Run'],
      ['Confirm the dashboard renders', 'Confirm'],
      ['node --test x.test.mjs && Verify it passes', 'Verify'],
      ["bash -c 'Check the output'", 'Check'],
    ] as const) {
      const refusal = checkVerificationProse([command], 'main');
      assert.ok(refusal, command);
      assert.equal(refusal.error, 'verification_not_command');
      assert.equal(refusal.missing.length, 1);
      assert.equal(refusal.missing[0].command, command);
      assert.equal(refusal.missing[0].path, word);
      assert.match(refusal.missing[0].reason, /not a runnable command/);
    }
  });

  it('admits real commands: PATH executables, builtins, ./scripts, cd chains, env prefixes and unknown lower-case tools', () => {
    for (const command of [
      'node --test x.test.mjs',
      'cd mcp/trajectory-server && bun run build:tsc',
      'FOO=1 node a.js',
      "grep -q 'x' f.md",
      './scripts/check.sh',
      'mytool --check',
      'test -f a && echo ok; true | cat',
      'Scripts/Run.sh',
    ]) {
      assert.equal(checkVerificationProse([command], 'main'), null, command);
    }
  });

  it('reads heredoc bodies as data, not commands, and resumes after the delimiter', () => {
    for (const command of [
      "cat > f.md <<'EOF'\n# Title\nSome text\nEOF\ngrep -q text f.md",
      "python3 - <<'EOF'\nPrint = 1\nEOF",
      'cat <<-END | grep -q x\n\tConfirm this\n\tEND\ntrue',
      'cat <<A <<"B"\nAlpha\nA\nBeta\nB\necho done',
      'grep -q x <<<"Confirm"',
    ]) {
      assert.equal(checkVerificationProse([command], 'main'), null, command);
    }
    const refusal = checkVerificationProse(["cat <<'EOF'\nSome text\nEOF\nConfirm the output"], 'main');
    assert.deepEqual(refusal?.missing.map((m) => m.path), ['Confirm']);
  });

  it('admits a capitalized word that is an executable on PATH', () => {
    const bin = mkdtempSync(join(tmpdir(), 'verification-prose-bin-'));
    const savedPath = process.env['PATH'];
    try {
      writeFileSync(join(bin, 'Rscript'), '#!/bin/sh\n', { mode: 0o755 });
      writeFileSync(join(bin, 'Notexec'), 'x\n', { mode: 0o644 });
      process.env['PATH'] = `${bin}:${savedPath ?? ''}`;
      assert.equal(checkVerificationProse(['Rscript tests.R'], null), null);
      assert.equal(checkVerificationProse(['Notexec now'], null)?.missing[0]?.path, 'Notexec');
    } finally {
      process.env['PATH'] = savedPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('checkVerificationPaths refuses prose before the test-path check and before any git lookup', () => {
    const refusal = checkVerificationPaths({ repoPath: null, ref: null, verification: ['Run node --test gone.test.mjs'], files: [] });
    assert.equal(refusal?.error, 'verification_not_command');
    assert.equal(refusal?.missing[0]?.path, 'Run');
  });
});

describe('prose verification guard in the task tools (GH 2955)', () => {
  const setup = () => {
    const repo = makeRepo();
    const db = tempDB();
    seed(db, repo.repoRoot);
    const composites = compositeTools(db, join(repo.ws, '.claude', 'tmb', 'trajectory.db'));
    const call = (name: string, args: Record<string, unknown>) =>
      composites.handlers[name]({ agent: 'bro', ...args }) as unknown as Promise<RawResult>;
    const provision = (branch_id: string, task: Record<string, unknown>) =>
      call('task_provision', {
        issue_id: 1, branch_id, decision_body: 'Chosen approach: refuse prose.',
        task: { description: 'd', spec_body: SPEC, files: ['pkg/src/tools/mod.ts'], verification: ['true'], repo: 'app', ...task },
      });
    return { ...repo, db, call, provision };
  };
  const assertProseRefusal = (r: RawResult) => {
    assert.equal(r.isError, true, r.content[0].text);
    const body = parse(r);
    assert.equal(body['error'], 'verification_not_command');
    assert.deepEqual(body['missing'], [{ command: PROSE, path: 'Run', reason: '"Run" is not a runnable command; give a shell command the close gate can run' }]);
    assert.match(String(body['message']), /Nothing was written/);
  };

  it('task_provision refuses prose and writes no task or discussion', async () => {
    const { ws, db, provision } = setup();
    try {
      assertProseRefusal(await provision('feat/prose', { verification: [PROSE] }));
      assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tasks')!.c, 0);
      assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM discussions')!.c, 0);
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('task_update_spec and task_reopen refuse prose and leave the row unchanged', async () => {
    const { ws, db, call, provision } = setup();
    try {
      const taskId = Number(parse(await provision('feat/amend', { verification: ['node --test tests/existing.test.mjs'] }))['task_id']);
      const row = () => db.get('SELECT status, verification, updated_at FROM tasks WHERE id = ?', [taskId]);
      const before = row();
      assertProseRefusal(await call('task_update_spec', { task_id: taskId, reason: 'add check', verification: [PROSE] }));
      assert.deepEqual(row(), before);
      assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit WHERE event_type = 'task_spec_amended'`)!.c, 0);

      db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [taskId]);
      const failed = row();
      assertProseRefusal(await call('task_reopen', { task_id: taskId, reason: 'rework', verification_add: [PROSE] }));
      assert.deepEqual(row(), failed);
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('task_retry refuses a failed task whose verification[] is prose and inserts no task', async () => {
    const { ws, db, call } = setup();
    try {
      db.run(
        `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, spec_body, files, verification, repo, created_at, updated_at)
         VALUES (1, 'feat/failed', 'main', 't', 'd', 'failed', ?, ?, ?, 'app', datetime('now'), datetime('now'))`,
        [SPEC, JSON.stringify(['pkg/src/tools/mod.ts']), JSON.stringify([PROSE])],
      );
      const failedId = db.get<{ id: number }>(`SELECT id FROM tasks WHERE branch_id = 'feat/failed'`)!.id;
      assertProseRefusal(await call('task_retry', {
        failed_task_id: failedId, new_branch_id: 'feat/failed-v2', corrected_spec_body: SPEC, retry_rationale: 'retry', description: 'd',
      }));
      assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tasks')!.c, 1);
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
