import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { compositeTools } from '../tools/composites.js';
import {
  appendVerificationDefaults,
  readVerificationDefaults,
  VERIFICATION_DEFAULTS_FILE,
} from '../tools/verification-defaults.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
const parse = (r: RawResult): Record<string, unknown> => JSON.parse(r.content[0]!.text);

const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');
const LINT = 'node --test tests/l1-lint/no-x.test.mjs';
const DEFAULTS = JSON.stringify({ version: 1, commands: [LINT, 'bun run lint'] });

function makeRepo(defaults: string | null): { ws: string; repoRoot: string; git: (...a: string[]) => string } {
  const ws = mkdtempSync(join(tmpdir(), 'verification-defaults-'));
  const repoRoot = join(ws, 'app');
  mkdirSync(repoRoot, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  const files: Record<string, string> = { 'tests/l1-lint/no-x.test.mjs': 'x\n', 'src/mod.ts': 'x\n' };
  if (defaults !== null) files[VERIFICATION_DEFAULTS_FILE] = defaults;
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(repoRoot, dirname(p)), { recursive: true });
    writeFileSync(join(repoRoot, p), body);
  }
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  return { ws, repoRoot, git };
}

function setup(defaults: string | null) {
  const repo = makeRepo(defaults);
  const db = tempDB();
  db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repo.repoRoot]);
  db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
          VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
  const composites = compositeTools(db, join(repo.ws, '.claude', 'tmb', 'trajectory.db'));
  const call = (name: string, args: Record<string, unknown>) =>
    composites.handlers[name]!({ agent: 'bro', ...args }) as unknown as Promise<RawResult>;
  const provision = (branch_id: string, verification: string[]) =>
    call('task_provision', {
      issue_id: 1, branch_id, decision_body: 'Chosen approach: append the defaults.',
      task: { description: 'd', spec_body: SPEC, files: ['src/mod.ts'], verification, repo: 'app' },
    });
  const insertFailed = (branch_id: string, verification: string[]): number => {
    db.run(
      `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, spec_body, files, verification, repo, created_at, updated_at)
       VALUES (1, ?, 'main', 't', 'd', 'failed', ?, ?, ?, 'app', datetime('now'), datetime('now'))`,
      [branch_id, SPEC, JSON.stringify(['src/mod.ts']), JSON.stringify(verification)],
    );
    return db.get<{ id: number }>(`SELECT id FROM tasks WHERE branch_id = ?`, [branch_id])!.id;
  };
  const retry = (failed_task_id: number, new_branch_id: string) =>
    call('task_retry', { failed_task_id, new_branch_id, corrected_spec_body: SPEC, retry_rationale: 'retry', description: 'd' });
  const stored = (taskId: unknown): string[] =>
    JSON.parse(db.get<{ verification: string }>('SELECT verification FROM tasks WHERE id = ?', [Number(taskId)])!.verification);
  const cleanup = () => {
    db.close();
    rmSync(repo.ws, { recursive: true, force: true });
  };
  return { ...repo, db, provision, insertFailed, retry, stored, cleanup };
}

describe('appendVerificationDefaults', () => {
  it('keeps the given commands first and appends each new default once, in file order', () => {
    assert.deepEqual(appendVerificationDefaults(['a', 'b'], ['b', 'c', 'd', 'c']), {
      verification: ['a', 'b', 'c', 'd'],
      added: ['c', 'd'],
    });
    assert.deepEqual(appendVerificationDefaults(['a'], []), { verification: ['a'], added: [] });
  });
});

describe('readVerificationDefaults', () => {
  it('reads the file at the ref, ignores the working tree and refuses malformed content', () => {
    const { ws, repoRoot, git } = makeRepo(null);
    try {
      assert.deepEqual(readVerificationDefaults(repoRoot, 'origin/main'), { commands: [] });
      assert.deepEqual(readVerificationDefaults(repoRoot, null), { commands: [] });
      assert.deepEqual(readVerificationDefaults(null, 'origin/main'), { commands: [] });

      mkdirSync(join(repoRoot, '.config', 'tmb'), { recursive: true });
      writeFileSync(join(repoRoot, VERIFICATION_DEFAULTS_FILE), DEFAULTS);
      assert.deepEqual(readVerificationDefaults(repoRoot, 'origin/main'), { commands: [] }, 'untracked file does not count');
      git('add', '.');
      assert.deepEqual(readVerificationDefaults(repoRoot, 'origin/main'), { commands: [] }, 'staged file does not count');
      git('commit', '-q', '-m', 'defaults');
      assert.deepEqual(readVerificationDefaults(repoRoot, 'main'), { commands: [LINT, 'bun run lint'] });
      writeFileSync(join(repoRoot, VERIFICATION_DEFAULTS_FILE), '{bad');
      assert.deepEqual(readVerificationDefaults(repoRoot, 'main'), { commands: [LINT, 'bun run lint'] }, 'uncommitted edit does not count');

      const bad = (content: string, pattern: RegExp) => {
        writeFileSync(join(repoRoot, VERIFICATION_DEFAULTS_FILE), content);
        git('commit', '-q', '-am', 'bad');
        const out = readVerificationDefaults(repoRoot, 'main');
        assert.ok('error' in out, content);
        assert.match(out.error, pattern);
      };
      bad('{bad', /not valid JSON/);
      bad('[]', /JSON object/);
      bad(JSON.stringify({ version: 2, commands: ['x'] }), /version must be 1/);
      bad(JSON.stringify({ version: 1, commands: [] }), /non-empty array/);
      bad(JSON.stringify({ version: 1, commands: ['ok', ' '] }), /non-empty strings/);
      bad(JSON.stringify({ version: 1, commands: [1] }), /non-empty strings/);

      const unresolved = readVerificationDefaults(repoRoot, 'origin/nope');
      assert.ok('error' in unresolved);
      assert.match(unresolved.error, /cannot resolve origin\/nope/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('verification defaults in task_provision and task_retry (GH 2570)', () => {
  it('task_provision stores the given commands then each new default and reports them', async () => {
    const { provision, stored, cleanup } = setup(DEFAULTS);
    try {
      const out = parse(await provision('feat/defaults', ['true']));
      assert.equal(typeof out['task_id'], 'number', JSON.stringify(out));
      assert.deepEqual(out['verification_defaults_added'], [LINT, 'bun run lint']);
      assert.deepEqual(stored(out['task_id']), ['true', LINT, 'bun run lint']);

      const dup = parse(await provision('feat/dup', [LINT, 'true']));
      assert.deepEqual(dup['verification_defaults_added'], ['bun run lint']);
      assert.deepEqual(stored(dup['task_id']), [LINT, 'true', 'bun run lint']);
    } finally {
      cleanup();
    }
  });

  it('task_provision without the file at the base leaves verification[] unchanged, even with a worktree copy', async () => {
    const { repoRoot, provision, stored, cleanup } = setup(null);
    try {
      mkdirSync(join(repoRoot, '.config', 'tmb'), { recursive: true });
      writeFileSync(join(repoRoot, VERIFICATION_DEFAULTS_FILE), DEFAULTS);
      const out = parse(await provision('feat/none', ['true']));
      assert.equal(typeof out['task_id'], 'number', JSON.stringify(out));
      assert.deepEqual(out['verification_defaults_added'], []);
      assert.deepEqual(stored(out['task_id']), ['true']);
    } finally {
      cleanup();
    }
  });

  it('task_provision refuses a malformed file and writes no task row, branch or worktree', async () => {
    const { repoRoot, db, git, provision, cleanup } = setup('{"version":1,"commands":"x"}');
    try {
      const refused = await provision('feat/bad', ['true']);
      assert.equal(refused.isError, true);
      const body = parse(refused);
      assert.equal(body['error'], 'verification_defaults_invalid');
      assert.match(String(body['message']), /\.config\/tmb\/verification-defaults\.json at origin\/main is invalid: commands must be/);
      assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tasks')!.c, 0, 'no task row');
      assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM discussions')!.c, 0, 'no discussion');
      assert.throws(() => git('rev-parse', '--verify', 'refs/heads/feat/bad'), 'no branch ref');
      assert.equal(existsSync(join(repoRoot, '.claude', 'worktrees', 'bad')), false, 'no worktree');
    } finally {
      cleanup();
    }
  });

  it('task_retry appends the defaults from the base, skipping ones the failed task lists', async () => {
    const { insertFailed, retry, stored, cleanup } = setup(DEFAULTS);
    try {
      const failedId = insertFailed('feat/failed', ['true', 'bun run lint']);
      const out = parse(await retry(failedId, 'feat/failed-v2'));
      assert.equal(typeof out['task_id'], 'number', JSON.stringify(out));
      assert.deepEqual(out['verification_defaults_added'], [LINT]);
      assert.deepEqual(stored(out['task_id']), ['true', 'bun run lint', LINT]);
    } finally {
      cleanup();
    }
  });

  it('task_retry without the file reports [] and keeps verification[]; a malformed file refuses and inserts no task', async () => {
    const none = setup(null);
    try {
      const failedId = none.insertFailed('feat/failed', ['true']);
      const out = parse(await none.retry(failedId, 'feat/failed-v2'));
      assert.deepEqual(out['verification_defaults_added'], []);
      assert.deepEqual(none.stored(out['task_id']), ['true']);
    } finally {
      none.cleanup();
    }

    const bad = setup('not json');
    try {
      const failedId = bad.insertFailed('feat/failed', ['true']);
      const refused = await bad.retry(failedId, 'feat/failed-v2');
      assert.equal(refused.isError, true);
      assert.equal(parse(refused)['error'], 'verification_defaults_invalid');
      assert.equal(bad.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tasks')!.c, 1);
      assert.throws(() => bad.git('rev-parse', '--verify', 'refs/heads/feat/failed-v2'), 'no branch ref');
      assert.equal(existsSync(join(bad.repoRoot, '.claude', 'worktrees', 'failed-v2')), false, 'no worktree');
    } finally {
      bad.cleanup();
    }
  });
});
