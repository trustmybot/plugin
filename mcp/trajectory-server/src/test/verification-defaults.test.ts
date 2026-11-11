import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { compositeTools } from '../tools/composites.js';
import { envTools } from '../tools/env.js';
import { onboardTools } from '../tools/onboard.js';
import { scanTools } from '../tools/scan.js';
import {
  appendVerificationDefaults,
  proposeVerificationDefaults,
  readVerificationDefaults,
  VERIFICATION_DEFAULTS_FILE,
  verificationDefaultsBaseRef,
  verificationDefaultsHint,
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
  const insertTask = (branch_id: string, verification: string[], status = 'failed'): number => {
    db.run(
      `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, spec_body, files, verification, repo, created_at, updated_at)
       VALUES (1, ?, 'main', 't', 'd', ?, ?, ?, ?, 'app', datetime('now'), datetime('now'))`,
      [branch_id, status, SPEC, JSON.stringify(['src/mod.ts']), JSON.stringify(verification)],
    );
    return db.get<{ id: number }>(`SELECT id FROM tasks WHERE branch_id = ?`, [branch_id])!.id;
  };
  const insertFailed = (branch_id: string, verification: string[]): number => insertTask(branch_id, verification);
  const retry = (failed_task_id: number, new_branch_id: string) =>
    call('task_retry', { failed_task_id, new_branch_id, corrected_spec_body: SPEC, retry_rationale: 'retry', description: 'd' });
  const reopen = (task_id: number, verification_add?: string[]) =>
    call('task_reopen', { task_id, reason: 'rework', ...(verification_add ? { verification_add } : {}) });
  const updateSpec = (task_id: number, fields: Record<string, unknown>) =>
    call('task_update_spec', { task_id, reason: 'amend', ...fields });
  const stored = (taskId: unknown): string[] =>
    JSON.parse(db.get<{ verification: string }>('SELECT verification FROM tasks WHERE id = ?', [Number(taskId)])!.verification);
  const cleanup = () => {
    db.close();
    rmSync(repo.ws, { recursive: true, force: true });
  };
  return { ...repo, db, provision, insertTask, insertFailed, retry, reopen, updateSpec, stored, cleanup };
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

describe('verification defaults in task_reopen and task_update_spec (GH 2866)', () => {
  const statusOf = (db: TrajectoryDB, taskId: number) =>
    db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])!.status;

  it('task_reopen appends each default missing after verification_add and reports them', async () => {
    const { reopen, insertFailed, stored, cleanup } = setup(DEFAULTS);
    try {
      const taskId = insertFailed('feat/reopen', ['true']);
      const out = parse(await reopen(taskId, ['bun run lint']));
      assert.equal(out['status'], 'running', JSON.stringify(out));
      assert.deepEqual(out['verification_defaults_added'], [LINT]);
      assert.deepEqual(out['verification'], ['true', 'bun run lint', LINT]);
      assert.deepEqual(stored(taskId), ['true', 'bun run lint', LINT]);
    } finally {
      cleanup();
    }
  });

  it('task_reopen without the file reports []; a malformed file refuses and leaves the task as it was', async () => {
    const none = setup(null);
    try {
      const taskId = none.insertFailed('feat/reopen', ['true']);
      const out = parse(await none.reopen(taskId));
      assert.deepEqual(out['verification_defaults_added'], []);
      assert.deepEqual(none.stored(taskId), ['true']);
    } finally {
      none.cleanup();
    }

    const bad = setup('{"version":1}');
    try {
      const taskId = bad.insertFailed('feat/reopen', ['true']);
      const refused = await bad.reopen(taskId);
      assert.equal(refused.isError, true);
      assert.equal(parse(refused)['error'], 'verification_defaults_invalid');
      assert.equal(statusOf(bad.db, taskId), 'failed');
      assert.deepEqual(bad.stored(taskId), ['true']);
      assert.throws(() => bad.git('rev-parse', '--verify', 'refs/heads/feat/reopen'), 'no branch ref');
    } finally {
      bad.cleanup();
    }
  });

  it('task_update_spec appends the defaults to the kept or replacement verification[], deduped, and reports them', async () => {
    const { db, insertTask, updateSpec, stored, cleanup } = setup(DEFAULTS);
    try {
      const taskId = insertTask('feat/amend', ['true'], 'running');
      const specOnly = parse(await updateSpec(taskId, { spec_body: `${SPEC}\n- SC2: more` }));
      assert.deepEqual(specOnly['verification_defaults_added'], [LINT, 'bun run lint']);
      assert.deepEqual(specOnly['changed'], ['verification', 'spec_body']);
      assert.deepEqual(stored(taskId), ['true', LINT, 'bun run lint']);

      const replaced = parse(await updateSpec(taskId, { verification: ['bun run lint', 'true'] }));
      assert.deepEqual(replaced['verification_defaults_added'], [LINT]);
      assert.deepEqual(stored(taskId), ['bun run lint', 'true', LINT]);

      const unchanged = parse(await updateSpec(taskId, { spec_body: SPEC }));
      assert.deepEqual(unchanged['verification_defaults_added'], []);
      assert.deepEqual(unchanged['changed'], ['spec_body']);

      const amended = db.get<{ content_json: string }>(
        `SELECT content_json FROM audit WHERE event_type = 'task_spec_amended' ORDER BY id LIMIT 1`,
      )!;
      const { changes } = JSON.parse(amended.content_json) as { changes: Record<string, unknown> };
      assert.deepEqual(changes['verification'], { added: [LINT, 'bun run lint'], removed: [] });
    } finally {
      cleanup();
    }
  });

  it('task_update_spec refuses a malformed file and writes nothing', async () => {
    const { db, insertTask, updateSpec, stored, cleanup } = setup('[]');
    try {
      const taskId = insertTask('feat/amend', ['true'], 'running');
      const refused = await updateSpec(taskId, { verification: ['true', 'bun run lint'] });
      assert.equal(refused.isError, true);
      assert.equal(parse(refused)['error'], 'verification_defaults_invalid');
      assert.deepEqual(stored(taskId), ['true']);
      assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit WHERE event_type = 'task_spec_amended'`)!.c, 0);
    } finally {
      cleanup();
    }
  });
});

const candidate = (command: string, source: string) => ({ command, source, confidence: 0.9, probe: null, provenance: { kind: 'existing_repo' } });

async function recordProfiles(db: TrajectoryDB, repo: string, profiles: Array<Record<string, unknown>>): Promise<void> {
  const r = (await envTools(db).handlers['env_record']({
    agent: 'bro',
    repo,
    profiles: profiles.map((p) => ({ package_manager: 'pip', globs: ['**/*.py'], status: 'detected', evidence_hash: 'h1', ...p })),
  })) as unknown as RawResult;
  assert.notEqual(r.isError, true, r.content[0].text);
}

describe('proposeVerificationDefaults (GH 2866)', () => {
  it('returns the root profiles\' effective lint, typecheck and test commands in that order, each once, with their source', async () => {
    const { db, cleanup } = setup(null);
    try {
      assert.deepEqual(proposeVerificationDefaults(db, 'app'), { candidates: [], reason: 'no_env_profile' });

      await recordProfiles(db, 'app', [
        {
          package_path: '.',
          ecosystem: 'python',
          commands: {
            install: [candidate('pip install -e .', 'pyproject.toml:1')],
            test: [candidate('make test', 'Makefile:3')],
            lint: [candidate('make lint', 'Makefile:1')],
            format_check: [candidate('make fmt-check', 'Makefile:5')],
            typecheck: [candidate('python -m mypy src', 'pyproject.toml:9')],
          },
          overrides: { lint: [candidate('ruff check .', 'ci.yml:12')] },
        },
        { package_path: '.', ecosystem: 'make', commands: { test: [candidate('make test', 'Makefile:3'), candidate('make e2e', 'Makefile:7')] } },
        { package_path: 'web', ecosystem: 'node', commands: { lint: [candidate('npm run lint', 'web/package.json:4')] } },
      ]);
      assert.deepEqual(proposeVerificationDefaults(db, 'app'), {
        candidates: [
          { command: 'ruff check .', category: 'lint', source: 'ci.yml:12' },
          { command: 'python -m mypy src', category: 'typecheck', source: 'pyproject.toml:9' },
          { command: 'make test', category: 'test', source: 'Makefile:3' },
          { command: 'make e2e', category: 'test', source: 'Makefile:7' },
        ],
      });
    } finally {
      cleanup();
    }
  });

  it('a sub-package profile alone is no root profile', async () => {
    const { db, cleanup } = setup(null);
    try {
      await recordProfiles(db, 'app', [{ package_path: 'web', ecosystem: 'node', commands: { lint: [candidate('npm run lint', 'web/package.json:4')] } }]);
      assert.deepEqual(proposeVerificationDefaults(db, 'app'), { candidates: [], reason: 'no_env_profile' });
    } finally {
      cleanup();
    }
  });
});

describe('the defaults base ref resolves like task_provision (GH 2866)', () => {
  it("an empty pr_target means unset: the default branch, as provision reads it", async () => {
    const none = setup(null);
    try {
      none.db.run(`UPDATE repos SET target_branch = '' WHERE name = 'app'`);
      const ref = verificationDefaultsBaseRef(none.db, 'app', none.repoRoot);
      assert.equal(typeof ref, 'string');
      const out = parse(await none.provision('feat/empty-target', ['true']));
      assert.equal(typeof out['task_id'], 'number', JSON.stringify(out));
      assert.ok(String(out['verification_defaults_missing']).startsWith(`${ref} has no `), JSON.stringify(out));
      await recordProfiles(none.db, 'app', [{ package_path: '.', ecosystem: 'python', commands: { test: [candidate('make test', 'Makefile:3')] } }]);
      assert.deepEqual(verificationDefaultsHint(none.db, 'app', none.repoRoot), {
        repo: 'app',
        ref,
        candidates: [{ command: 'make test', category: 'test', source: 'Makefile:3' }],
      });
    } finally {
      none.cleanup();
    }

    const present = setup(DEFAULTS);
    try {
      present.db.run(`UPDATE repos SET target_branch = '' WHERE name = 'app'`);
      const ref = verificationDefaultsBaseRef(present.db, 'app', present.repoRoot);
      assert.equal(typeof ref, 'string');
      assert.deepEqual(readVerificationDefaults(present.repoRoot, ref), { commands: [LINT, 'bun run lint'] });
      const out = parse(await present.provision('feat/empty-target', ['true']));
      assert.deepEqual(out['verification_defaults_added'], [LINT, 'bun run lint']);
      await recordProfiles(present.db, 'app', [{ package_path: '.', ecosystem: 'python', commands: { test: [candidate('make test', 'Makefile:3')] } }]);
      assert.equal(verificationDefaultsHint(present.db, 'app', present.repoRoot), null);
    } finally {
      present.cleanup();
    }
  });
});

describe('verification_defaults_missing on task_provision and task_retry (GH 2866)', () => {
  it('names /onboard when the base has no defaults file, and is omitted when it has one', async () => {
    const none = setup(null);
    try {
      const out = parse(await none.provision('feat/none', ['true']));
      assert.equal(typeof out['task_id'], 'number', JSON.stringify(out));
      assert.match(String(out['verification_defaults_missing']), /origin\/main has no \.config\/tmb\/verification-defaults\.json.*\/onboard/);
      const retried = parse(await none.retry(none.insertFailed('feat/failed', ['true']), 'feat/failed-v2'));
      assert.equal(typeof retried['task_id'], 'number', JSON.stringify(retried));
      assert.match(String(retried['verification_defaults_missing']), /\/onboard/);
    } finally {
      none.cleanup();
    }

    const present = setup(DEFAULTS);
    try {
      const out = parse(await present.provision('feat/has', ['true']));
      assert.equal(typeof out['task_id'], 'number', JSON.stringify(out));
      assert.equal('verification_defaults_missing' in out, false);
      const retried = parse(await present.retry(present.insertFailed('feat/failed', ['true']), 'feat/failed-v2'));
      assert.equal('verification_defaults_missing' in retried, false);
    } finally {
      present.cleanup();
    }
  });
});

// A user's project, not the plugin: Python with a Makefile, no package.json,
// no changelog.d and no .config/tmb.
describe('fixture repo: env profile -> /onboard -> committed defaults -> provision (GH 2866)', () => {
  it('scan_run hints the candidates, onboard_apply writes them, and once committed provision appends them', async () => {
    const base = mkdtempSync(join(tmpdir(), 'verification-defaults-fixture-'));
    const repoRoot = join(base, 'pyapp');
    const git = (...a: string[]) =>
      execFileSync('git', ['-C', repoRoot, '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], { stdio: ['ignore', 'pipe', 'pipe'] })
        .toString()
        .trim();
    const files: Record<string, string> = {
      Makefile: 'lint:\n\truff check src\ntest:\n\tpytest tests\n',
      'pyproject.toml': '[project]\nname = "pyapp"\n',
      'src/pyapp/__init__.py': 'VALUE = 1\n',
      'tests/test_app.py': 'def test_value():\n    assert True\n',
    };
    mkdirSync(repoRoot, { recursive: true });
    git('init', '-q', '-b', 'main');
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(repoRoot, dirname(p)), { recursive: true });
      writeFileSync(join(repoRoot, p), body);
    }
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    for (const absent of ['package.json', 'changelog.d', '.config/tmb']) assert.equal(existsSync(join(repoRoot, absent)), false, absent);

    const db = new TrajectoryDB(join(base, 'trajectory.db'));
    const dbPath = join(base, '.claude', 'tmb', 'trajectory.db');
    const scan = async () => parse((await scanTools(db, null).handlers['scan_run']({ agent: 'bro', session_dir: repoRoot })) as unknown as RawResult);
    const onboard = onboardTools(db, dbPath);
    const composites = compositeTools(db, dbPath);
    const provision = async (branch_id: string) =>
      parse(
        (await composites.handlers['task_provision']({
          agent: 'bro',
          issue_id: 1,
          branch_id,
          decision_body: 'Chosen approach: the fixture task.',
          task: { description: 'd', spec_body: SPEC, files: ['src/pyapp/__init__.py'], verification: ['true'], repo: 'pyapp' },
        })) as unknown as RawResult,
      );
    try {
      const first = await scan();
      assert.ok(Array.isArray(first['repos']), JSON.stringify(first));
      assert.equal('verification_defaults_hint' in first, false, 'no profile, no hint');

      await recordProfiles(db, 'pyapp', [
        {
          package_path: '.',
          ecosystem: 'python',
          commands: {
            install: [candidate('pip install -e .', 'pyproject.toml:1')],
            lint: [candidate('make lint', 'Makefile:1')],
            test: [candidate('make test', 'Makefile:3')],
          },
        },
      ]);
      const commands = proposeVerificationDefaults(db, 'pyapp').candidates.map((c) => c.command);
      assert.deepEqual(commands, ['make lint', 'make test']);

      const hinted = await scan();
      assert.deepEqual(hinted['verification_defaults_hint'], [
        {
          repo: 'pyapp',
          ref: 'origin/main',
          candidates: [
            { command: 'make lint', category: 'lint', source: 'Makefile:1' },
            { command: 'make test', category: 'test', source: 'Makefile:3' },
          ],
        },
      ]);

      db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
      const before = await provision('feat/before');
      assert.equal(typeof before['task_id'], 'number', JSON.stringify(before));
      assert.deepEqual(before['verification_defaults_added'], []);
      assert.match(String(before['verification_defaults_missing']), /\/onboard/);

      const questions = parse((await onboard.handlers['onboard_get_questions']({ agent: 'bro', round: 'verification_defaults' })) as unknown as RawResult);
      const options = (questions['questions'] as Array<{ options: Array<{ wire: string }> }>)[0].options.map((o) => o.wire);
      assert.deepEqual(options, commands);
      const applied = parse((await onboard.handlers['onboard_apply']({ agent: 'bro', verification_defaults: options })) as unknown as RawResult);
      assert.equal((applied['verification_defaults'] as Record<string, unknown>)['commit_needed'], true, JSON.stringify(applied));

      git('add', VERIFICATION_DEFAULTS_FILE);
      git('commit', '-q', '-m', 'verification defaults');
      const after = await provision('feat/after');
      assert.equal(typeof after['task_id'], 'number', JSON.stringify(after));
      assert.deepEqual(after['verification_defaults_added'], commands);
      assert.equal('verification_defaults_missing' in after, false);
      const stored: unknown = JSON.parse(db.get<{ verification: string }>('SELECT verification FROM tasks WHERE id = ?', [Number(after['task_id'])])!.verification);
      assert.deepEqual(stored, ['true', ...commands]);
      assert.equal('verification_defaults_hint' in (await scan()), false, 'committed file, no hint');
    } finally {
      db.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
