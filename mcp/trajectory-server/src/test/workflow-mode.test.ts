// The workflow_mode config key (GH 2225): config_set refuses it, the value is
// type-checked, readWorkflowMode defaults to truest, the shared close path of
// bro_atomic_close and task_recover stamps tasks.workflow_mode, and the v65→v66
// migration adds the column once.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { seedReviewedCommit, tempDB } from './helpers.js';
import { compositeTools } from '../tools/composites.js';
import { WORKFLOW_MODE_KEY, configTools, readWorkflowMode, setConfigValues } from '../tools/config.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const call = async (handlers: Handlers, name: string, args: Record<string, unknown>): Promise<RawResult> =>
  (await handlers[name](args)) as RawResult;
const parse = (r: RawResult) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const NOW = '2026-11-09T12:00:00.000Z';

const storeMode = (db: TrajectoryDB, valueJson: string): void => {
  db.run(
    `INSERT INTO plugin_config (key, value_json) VALUES ('workflow_mode', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    [valueJson],
  );
};

describe('SC1: config_set refuses workflow_mode', () => {
  it('returns human_only_config_key and writes no plugin_config row or audit row, for any value', async () => {
    const db = tempDB();
    try {
      const config = configTools(db);
      for (const value of ['agile', 'truest', 'bogus']) {
        const r = await call(config.handlers, 'config_set', { agent: 'bro', key: 'workflow_mode', value });
        assert.equal(r.isError, true);
        const error = parse(r)['error'] as string;
        assert.ok(error.startsWith('human_only_config_key:'), error);
        assert.ok(error.includes('/onboard'), error);
      }
      assert.equal(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM plugin_config WHERE key = 'workflow_mode'`)!.n, 0);
      assert.equal(
        db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'config_changed' AND json_extract(content_json, '$.key') = 'workflow_mode'`)!.n,
        0,
      );
    } finally {
      db.close();
    }
  });

  it('another key still sets as before', async () => {
    const db = tempDB();
    try {
      const config = configTools(db);
      const r = await call(config.handlers, 'config_set', { agent: 'bro', key: 'reviewer_effort', value: 'high' });
      assert.ok(!r.isError, JSON.stringify(parse(r)));
      assert.deepEqual(parse(r), { key: 'reviewer_effort' });
      assert.equal(db.get<{ v: string }>(`SELECT value_json AS v FROM plugin_config WHERE key = 'reviewer_effort'`)!.v, '"high"');
    } finally {
      db.close();
    }
  });
});

describe('SC2: workflow_mode values and readWorkflowMode', () => {
  it('validateKnownConfigValue throws typed_field_violation for any value but truest or agile', () => {
    const db = tempDB();
    try {
      for (const bad of ['Agile', 'fast', '', 1, true, ['agile'], { mode: 'agile' }]) {
        assert.throws(
          () => setConfigValues(db, [{ key: WORKFLOW_MODE_KEY, value: bad }]),
          /^Error: typed_field_violation: config key "workflow_mode" must be one of truest, agile/,
          JSON.stringify(bad),
        );
      }
      assert.equal(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM plugin_config WHERE key = 'workflow_mode'`)!.n, 0);
      for (const good of ['truest', 'agile']) {
        setConfigValues(db, [{ key: WORKFLOW_MODE_KEY, value: good }]);
        assert.equal(readWorkflowMode(db), good);
      }
    } finally {
      db.close();
    }
  });

  it('readWorkflowMode is truest with no row and the stored value when a row exists', () => {
    const db = tempDB();
    try {
      assert.equal(readWorkflowMode(db), 'truest');
      storeMode(db, '"agile"');
      assert.equal(readWorkflowMode(db), 'agile');
      storeMode(db, '"truest"');
      assert.equal(readWorkflowMode(db), 'truest');
      storeMode(db, '"nonsense"');
      assert.equal(readWorkflowMode(db), 'truest', 'an unknown stored mode reads as truest');
      storeMode(db, 'not json');
      assert.equal(readWorkflowMode(db), 'truest', 'an unparseable stored value reads as truest');
    } finally {
      db.close();
    }
  });
});

describe('SC3: the shared close path stamps tasks.workflow_mode', () => {
  let ws: string;
  let repoRoot: string;
  let db: TrajectoryDB;
  let composites: ReturnType<typeof compositeTools>;
  let baseSha: string;
  const git = (...a: string[]) => execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'tmb-workflow-mode-'));
    repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    git('init', '-q', '-b', 'dev');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    baseSha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/dev', baseSha);
    db = tempDB();
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'dev')`, [repoRoot]);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'o', 'd', 'open', ?, ?)`, [NOW, NOW]);
    composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  const modeOf = (id: number) => db.get<{ m: string | null }>('SELECT workflow_mode AS m FROM tasks WHERE id = ?', [id])!.m;

  const seedCompleted = (id: number): string => {
    const branch = `feat/t${id}`;
    git('checkout', '-q', '-b', branch, baseSha);
    writeFileSync(join(repoRoot, `t${id}.txt`), `${id}\n`);
    git('add', '.');
    git('commit', '-q', '-m', branch);
    const sha = git('rev-parse', 'HEAD');
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, repo, files, commit_sha, created_at, updated_at)
       VALUES (?, 1, ?, 'dev', 'd', 'completed', 's', 'app', ?, ?, ?, ?)`,
      [id, branch, JSON.stringify([`t${id}.txt`]), sha, NOW, NOW],
    );
    return sha;
  };

  const atomicClose = async (id: number) => {
    const sha = seedCompleted(id);
    assert.equal(modeOf(id), null, 'an open task carries no recorded mode');
    seedReviewedCommit(db, 1, id, sha);
    const r = await call(composites.handlers, 'bro_atomic_close', { agent: 'bro', task_id: String(id), commit_sha: sha, verification_summary: 'ok' });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
  };

  const recover = async (id: number) => {
    const sha = seedCompleted(id);
    const r = await call(composites.handlers, 'task_recover', { agent: 'bro', task_id: String(id), commit_sha: sha });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.equal(parse(r)['action'], 'closed');
  };

  it('bro_atomic_close stamps truest with no config row and agile when the row says agile', async () => {
    db.run(`DELETE FROM plugin_config WHERE key = 'workflow_mode'`);
    await atomicClose(1);
    assert.equal(modeOf(1), 'truest');
    storeMode(db, '"agile"');
    await atomicClose(2);
    assert.equal(modeOf(2), 'agile');
    assert.equal(modeOf(1), 'truest', 'an earlier close keeps the mode it closed under');
  });

  it('task_recover stamps the same way', async () => {
    db.run(`DELETE FROM plugin_config WHERE key = 'workflow_mode'`);
    await recover(3);
    assert.equal(modeOf(3), 'truest');
    storeMode(db, '"agile"');
    await recover(4);
    assert.equal(modeOf(4), 'agile');
  });

  it('the CHECK holds the column to NULL, truest or agile', () => {
    assert.throws(() => db.run(`UPDATE tasks SET workflow_mode = 'fast' WHERE id = 1`), /CHECK/);
    db.run(`UPDATE tasks SET workflow_mode = NULL WHERE id = 1`);
    assert.equal(modeOf(1), null);
  });
});

describe('SC4: the v65 -> v66 migration', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmb-workflow-mode-migrate-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('adds tasks.workflow_mode once as a trailing NULL column, keeps rows, and a second boot is a no-op', () => {
    const dbFile = join(dir, 'trajectory.db');
    new TrajectoryDB(dbFile).close();
    const raw = new DatabaseSync(dbFile);
    raw.exec(`
      INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', '${NOW}', '${NOW}');
      INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at)
        VALUES (7, 1, 'feat/a', 'd', 'closed', '${NOW}', '${NOW}'), (8, 1, 'feat/b', 'd', 'running', '${NOW}', '${NOW}');
      ALTER TABLE tasks DROP COLUMN wm_commit;
      ALTER TABLE tasks DROP COLUMN base_sha;
      ALTER TABLE tasks DROP COLUMN workflow_mode;
      UPDATE plugin_meta SET schema_version = 65 WHERE id = 1;
    `);
    const before = raw.prepare('SELECT * FROM tasks ORDER BY id').all().map((r) => ({ ...r }));
    raw.close();

    const migrated = new TrajectoryDB(dbFile, undefined, { migrate: true });
    const fresh = new TrajectoryDB(join(dir, 'fresh.db'));
    try {
      assert.equal(migrated.get<{ v: number }>('SELECT schema_version AS v FROM plugin_meta WHERE id = 1')!.v, 71);
      const cols = (d: TrajectoryDB) =>
        d.all<{ name: string; type: string; notnull: number; dflt_value: unknown }>('PRAGMA table_info(tasks)')
          .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value }));
      assert.deepEqual(cols(migrated), cols(fresh), 'the migrated tasks table matches a fresh one');
      assert.deepEqual(cols(migrated).slice(-3, -2), [{ name: 'workflow_mode', type: 'TEXT', notnull: 0, dflt_value: null }]);
      const after = migrated.all<Record<string, unknown>>('SELECT * FROM tasks ORDER BY id').map((r) => ({ ...r }));
      assert.deepEqual(
        after,
        before.map((r) => ({ ...r, workflow_mode: null, base_sha: null, wm_commit: null })),
        'tasks closed before v66 carry no recorded mode',
      );
      assert.throws(() => migrated.run(`UPDATE tasks SET workflow_mode = 'fast' WHERE id = 7`), /CHECK/);
    } finally {
      migrated.close();
      fresh.close();
    }

    const backups = () => readdirSync(dir).filter((f) => f.startsWith('trajectory.db.pre-v71.') && f.endsWith('.bak')).length;
    assert.equal(backups(), 1);
    const again = new TrajectoryDB(dbFile, undefined, { migrate: true });
    try {
      assert.equal(again.get<{ v: number }>('SELECT schema_version AS v FROM plugin_meta WHERE id = 1')!.v, 71);
      assert.equal(
        again.all<{ name: string }>('PRAGMA table_info(tasks)').filter((c) => c.name === 'workflow_mode').length,
        1,
        'the column is added once',
      );
    } finally {
      again.close();
    }
    assert.equal(backups(), 1, 'a second boot writes no second backup');

    const rewound = new DatabaseSync(dbFile);
    rewound.exec(`UPDATE plugin_meta SET schema_version = 65 WHERE id = 1`);
    rewound.close();
    const rerun = new TrajectoryDB(dbFile, undefined, { migrate: true });
    try {
      assert.equal(
        rerun.all<{ name: string }>('PRAGMA table_info(tasks)').filter((c) => c.name === 'workflow_mode').length,
        1,
        'the migration skips a column that already exists',
      );
    } finally {
      rerun.close();
    }
  });
});
