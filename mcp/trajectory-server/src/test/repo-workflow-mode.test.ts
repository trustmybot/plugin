// The repo's mode decides every pre-close step (GH 3281): resolveWorkflowMode
// reads exempt first, then the repo's truest|agile, then the project mode
// (unset reads as truest); the hooks' gateResolveWorkflowMode agrees with it;
// bro_atomic_close and task_update_status stamp the mode they resolved, an
// exempt task closing with no review row; and src/stored-mode.ts reads a
// stored task mode as the sites it replaced did, exempt owing no review.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { GATE_READ_ERROR } from '../hooks/lib/db.js';
import { gateResolveWorkflowMode } from '../hooks/lib/git-refs.js';
import { AGILE_QUEUED_SQL } from '../review-sql.js';
import { isStoredAgile, isStoredExempt, storedAgileSql, storedExemptSql, storedReviewOwed, storedReviewOwedSql } from '../stored-mode.js';
import { compositeTools } from '../tools/composites.js';
import { resolveWorkflowMode } from '../tools/config.js';
import { taskTools } from '../tools/tasks.js';
import { seedReviewedCommit, setProjectWorkflowMode, tempDB } from './helpers.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
const call = async (handlers: Handlers, name: string, args: Record<string, unknown>): Promise<RawResult> =>
  (await handlers[name](args)) as RawResult;
const parse = (r: RawResult) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const NOW = '2026-11-17T12:00:00.000Z';

const REPO_MODES = [null, 'truest', 'agile', 'exempt'] as const;
// The project value as stored in plugin_config.value_json; null is no row.
const PROJECT_VALUES = [null, '"truest"', '"agile"', '"lane"', 'not json'] as const;

const storeProject = (db: TrajectoryDB, valueJson: string | null): void => {
  db.run(`DELETE FROM plugin_config WHERE key = 'workflow_mode'`);
  if (valueJson !== null) db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('workflow_mode', ?)`, [valueJson]);
};
const projectMode = (valueJson: string | null): string => (valueJson === '"agile"' ? 'agile' : 'truest');

describe('SC1: resolveWorkflowMode', () => {
  it('exempt wins over every project mode; a repo truest|agile wins over the project; a NULL repo mode reads the project (unset, unknown or unparseable: truest)', () => {
    const db = tempDB();
    try {
      db.run(`INSERT INTO repos (name, path) VALUES ('app', '/repo/app'), ('lib', '/repo/lib')`);
      for (const repoMode of REPO_MODES) {
        db.run(`UPDATE repos SET mode = ? WHERE name = 'app'`, [repoMode]);
        for (const value of PROJECT_VALUES) {
          storeProject(db, value);
          const expected = repoMode ?? projectMode(value);
          assert.equal(resolveWorkflowMode(db, 'app'), expected, `repo ${repoMode} / project ${value}`);
        }
      }
    } finally {
      db.close();
    }
  });

  it('a NULL task repo reads the sole registered repo; with none or several, the project mode', () => {
    const db = tempDB();
    try {
      setProjectWorkflowMode(db, 'truest');
      assert.equal(resolveWorkflowMode(db, null), 'truest', 'no repo registered');
      db.run(`INSERT INTO repos (name, path, mode) VALUES ('app', '/repo/app', 'exempt')`);
      assert.equal(resolveWorkflowMode(db, null), 'exempt', 'the sole repo');
      assert.equal(resolveWorkflowMode(db, ''), 'exempt', 'an empty repo is a NULL one');
      assert.equal(resolveWorkflowMode(db, 'ghost'), 'truest', 'a named repo never falls back to the sole one');
      db.run(`UPDATE repos SET mode = 'agile' WHERE name = 'app'`);
      assert.equal(resolveWorkflowMode(db, null), 'agile');
      db.run(`INSERT INTO repos (name, path, mode) VALUES ('lib', '/repo/lib', 'exempt')`);
      assert.equal(resolveWorkflowMode(db, null), 'truest', 'several repos');
      assert.equal(resolveWorkflowMode(db, 'lib'), 'exempt');
    } finally {
      db.close();
    }
  });

  it('a missing project mode reads as truest', () => {
    const db = tempDB();
    try {
      assert.equal(resolveWorkflowMode(db, null), 'truest');
      db.run(`INSERT INTO repos (name, path) VALUES ('app', '/repo/app')`);
      assert.equal(resolveWorkflowMode(db, 'app'), 'truest');
    } finally {
      db.close();
    }
  });
});

describe('SC3: gateResolveWorkflowMode agrees with resolveWorkflowMode', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmb-repo-workflow-mode-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('across the repo × project matrix, for a named, a sole, an unregistered and a several-repo NULL repo', () => {
    const dbPath = join(dir, 'matrix.db');
    const db = tempDB({ path: dbPath });
    try {
      db.run(`INSERT INTO repos (name, path) VALUES ('app', '/repo/app')`);
      let checked = 0;
      for (const repos of [1, 2]) {
        if (repos === 2) db.run(`INSERT INTO repos (name, path, mode) VALUES ('it''s', '/repo/q', 'exempt')`);
        for (const repoMode of REPO_MODES) {
          db.run(`UPDATE repos SET mode = ? WHERE name = 'app'`, [repoMode]);
          for (const value of PROJECT_VALUES) {
            storeProject(db, value);
            for (const name of ['app', '', 'ghost', "it's"]) {
              const label = `${repos} repo(s), app ${repoMode}, project ${value}, repo '${name}'`;
              assert.equal(gateResolveWorkflowMode(dbPath, name, process.env), resolveWorkflowMode(db, name), label);
              checked++;
            }
          }
        }
      }
      assert.equal(checked, 2 * REPO_MODES.length * PROJECT_VALUES.length * 4);
    } finally {
      db.close();
    }
  });

  it('a DB that does not read is GATE_READ_ERROR', () => {
    assert.equal(gateResolveWorkflowMode(join(dir, 'missing.db'), 'app', process.env), GATE_READ_ERROR);
  });
});

describe('SC2/SC5: the close resolves the task repo mode and stamps it', () => {
  let ws: string;
  let repoRoot: string;
  let db: TrajectoryDB;
  let composites: ReturnType<typeof compositeTools>;
  let tasks: ReturnType<typeof taskTools>;
  let baseSha: string;
  let nextId = 1;
  const git = (...a: string[]) => execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).toString().trim();

  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'tmb-repo-workflow-close-'));
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
    tasks = taskTools(db);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  const setModes = (repoMode: string | null, project: string): void => {
    db.run(`UPDATE repos SET mode = ? WHERE name = 'app'`, [repoMode]);
    setProjectWorkflowMode(db, project);
  };
  const modeOf = (id: number) => db.get<{ m: string | null }>('SELECT workflow_mode AS m FROM tasks WHERE id = ?', [id])!.m;
  const statusOf = (id: number) => db.get<{ s: string }>('SELECT status AS s FROM tasks WHERE id = ?', [id])!.s;
  const reviewRows = (id: number): string[] =>
    db.all<{ e: string }>(
      `SELECT event_type AS e FROM audit
        WHERE event_type IN ('review_queued', 'review_gate_bypassed', 'review_handoff')
          AND json_extract(content_json, '$.task_id') = ? ORDER BY id`,
      [id],
    ).map((r) => r.e);

  /** A completed task of repo app with its own commit, at <status>. */
  const seedTask = (status: string): { id: number; sha: string } => {
    const id = nextId++;
    const branch = `feat/t${id}`;
    git('checkout', '-q', '-b', branch, baseSha);
    writeFileSync(join(repoRoot, `t${id}.txt`), `${id}\n`);
    git('add', '.');
    git('commit', '-q', '-m', branch);
    const sha = git('rev-parse', 'HEAD');
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, repo, files, commit_sha, created_at, updated_at)
       VALUES (?, 1, ?, 'dev', 'd', ?, 's', 'app', ?, ?, ?, ?)`,
      [id, branch, status, JSON.stringify([`t${id}.txt`]), sha, NOW, NOW],
    );
    return { id, sha };
  };
  const atomicClose = async (id: number, sha: string): Promise<RawResult> =>
    await call(composites.handlers, 'bro_atomic_close', { agent: 'bro', task_id: String(id), commit_sha: sha, verification_summary: 'ok' });
  const updateClose = async (id: number): Promise<RawResult> =>
    await call(tasks.handlers, 'task_update_status', { agent: 'bro', task_id: String(id), status: 'closed' });

  for (const project of ['truest', 'agile']) {
    it(`an exempt repo under project ${project}: bro_atomic_close closes with no pass and no handoff, stamps exempt, writes no review row`, async () => {
      setModes('exempt', project);
      const { id, sha } = seedTask('completed');
      const r = await atomicClose(id, sha);
      assert.ok(!r.isError, JSON.stringify(parse(r)));
      assert.equal(statusOf(id), 'closed');
      assert.equal(modeOf(id), 'exempt');
      assert.deepEqual(reviewRows(id), []);
    });

    it(`an exempt repo under project ${project}: task_update_status closes, stamps exempt, writes no review row`, async () => {
      setModes('exempt', project);
      const { id } = seedTask('escalated');
      const r = await updateClose(id);
      assert.ok(!r.isError, JSON.stringify(parse(r)));
      assert.equal(statusOf(id), 'closed');
      assert.equal(modeOf(id), 'exempt');
      assert.deepEqual(reviewRows(id), []);
    });
  }

  it('an agile repo under project truest: both closes queue the task and stamp agile', async () => {
    setModes('agile', 'truest');
    const atomic = seedTask('completed');
    assert.ok(!(await atomicClose(atomic.id, atomic.sha)).isError);
    assert.equal(modeOf(atomic.id), 'agile');
    assert.deepEqual(reviewRows(atomic.id), ['review_queued']);
    const updated = seedTask('escalated');
    assert.ok(!(await updateClose(updated.id)).isError);
    assert.equal(modeOf(updated.id), 'agile');
    assert.deepEqual(reviewRows(updated.id), ['review_queued']);
  });

  it('a truest repo under project agile: bro_atomic_close refuses review_pass_missing, task_update_status records a bypass and stamps truest', async () => {
    setModes('truest', 'agile');
    const atomic = seedTask('completed');
    const refused = await atomicClose(atomic.id, atomic.sha);
    assert.ok(refused.isError);
    assert.match(String(parse(refused)['error']), /^review_pass_missing: /);
    assert.equal(statusOf(atomic.id), 'completed');
    const updated = seedTask('escalated');
    assert.ok(!(await updateClose(updated.id)).isError);
    assert.equal(modeOf(updated.id), 'truest');
    assert.deepEqual(reviewRows(updated.id), ['review_gate_bypassed']);
  });

  for (const project of [null, 'truest']) {
    it(`SC5: a NULL-mode repo under ${project === null ? 'an unset' : 'an explicit'} project truest needs the pass and stamps truest`, async () => {
      db.run(`UPDATE repos SET mode = NULL WHERE name = 'app'`);
      storeProject(db, project === null ? null : JSON.stringify(project));
      const { id, sha } = seedTask('completed');
      assert.match(String(parse(await atomicClose(id, sha))['error']), /^review_pass_missing: /);
      seedReviewedCommit(db, 1, id, sha);
      assert.ok(!(await atomicClose(id, sha)).isError);
      assert.equal(modeOf(id), 'truest');
      assert.deepEqual(reviewRows(id), ['review_handoff']);
    });
  }

  it('SC5: a NULL-mode repo under an explicit project agile closes unreviewed, queued and stamped agile', async () => {
    setModes(null, 'agile');
    const { id, sha } = seedTask('completed');
    assert.ok(!(await atomicClose(id, sha)).isError);
    assert.equal(modeOf(id), 'agile');
    assert.deepEqual(reviewRows(id), ['review_queued']);
  });

  it('a closed task keeps the mode it closed under when the repo mode changes and a status call repeats the close', async () => {
    setModes('exempt', 'agile');
    const { id } = seedTask('escalated');
    assert.ok(!(await updateClose(id)).isError);
    setModes('truest', 'truest');
    await updateClose(id);
    const later = seedTask('escalated');
    assert.ok(!(await updateClose(later.id)).isError);
    assert.equal(modeOf(later.id), 'truest');
    assert.equal(modeOf(id), 'exempt');
    assert.deepEqual(reviewRows(id), []);
  });
});

describe('SC4: src/stored-mode.ts reads a stored task mode', () => {
  const STORED = [null, 'truest', 'agile', 'exempt'] as const;
  // The expressions the helpers replaced: review-sql's agile test, data-contracts'
  // NOT_AGILE_TASK and close-issue-on-merge's not-agile test.
  const OLD_AGILE = (a: string) => `${a}.workflow_mode = 'agile'`;
  const OLD_NOT_AGILE = (a: string) => `COALESCE(${a}.workflow_mode, 'truest') <> 'agile'`;
  const OLD_MERGE_NOT_AGILE = (a: string) => `COALESCE(${a}.workflow_mode, '') <> 'agile'`;

  const withTask = (run: (db: TrajectoryDB, read: (expr: string) => boolean) => void): void => {
    const db = tempDB();
    try {
      db.run(`INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, 'o', ?, ?)`, [NOW, NOW]);
      db.run(
        `INSERT INTO tasks (id, issue_id, branch_id, description, status, commit_sha, created_at, updated_at)
           VALUES (7, 1, 'feat/7', 'd', 'closed', 'abc1234', ?, ?)`,
        [NOW, NOW],
      );
      // COALESCE(.., 0): a WHERE drops a NULL predicate, so NULL reads as false.
      const read = (expr: string): boolean => db.get<{ v: number }>(`SELECT COALESCE((${expr}), 0) AS v FROM tasks t WHERE t.id = 7`)!.v === 1;
      run(db, read);
    } finally {
      db.close();
    }
  };

  it('the SQL helpers agree with the TS predicates for NULL, truest, agile and exempt, unaliased too', () => {
    withTask((db, read) => {
      for (const mode of STORED) {
        db.run(`UPDATE tasks SET workflow_mode = ? WHERE id = 7`, [mode]);
        assert.equal(read(storedAgileSql('t')), isStoredAgile(mode), `agile ${mode}`);
        assert.equal(read(storedExemptSql('t')), isStoredExempt(mode), `exempt ${mode}`);
        assert.equal(read(storedReviewOwedSql('t')), storedReviewOwed(mode), `review owed ${mode}`);
        const bare = db.get<{ v: number }>(`SELECT COALESCE((${storedAgileSql('')}), 0) AS v FROM tasks WHERE id = 7`)!.v === 1;
        assert.equal(bare, isStoredAgile(mode), `unaliased agile ${mode}`);
        assert.equal(read(`NOT ${storedExemptSql('t')}`), !isStoredExempt(mode), `NOT exempt holds for ${mode}`);
      }
    });
  });

  it('parity with the replaced expressions for NULL, truest and agile', () => {
    withTask((db, read) => {
      for (const mode of [null, 'truest', 'agile'] as const) {
        db.run(`UPDATE tasks SET workflow_mode = ? WHERE id = 7`, [mode]);
        assert.equal(read(storedAgileSql('t')), read(OLD_AGILE('t')), `agile ${mode}`);
        assert.equal(read(storedReviewOwedSql('t')), read(OLD_NOT_AGILE('t')), `data contracts ${mode}`);
        assert.equal(read(storedReviewOwedSql('t')), read(OLD_MERGE_NOT_AGILE('t')), `close-issue-on-merge ${mode}`);
      }
    });
  });

  it('exempt is neither agile nor review-owed, and a review_queued row never makes it queued', () => {
    withTask((db, read) => {
      db.run(`UPDATE tasks SET workflow_mode = 'exempt' WHERE id = 7`);
      assert.equal(read(storedAgileSql('t')), false);
      assert.equal(read(storedReviewOwedSql('t')), false);
      db.run(
        `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
           VALUES (1, 'bro', 'review_queued', 'q', '{"task_id":7,"commit_sha":"abc1234"}', ?)`,
        [NOW],
      );
      assert.equal(read(AGILE_QUEUED_SQL), false, 'an exempt task is never queued');
      db.run(`UPDATE tasks SET workflow_mode = 'agile' WHERE id = 7`);
      assert.equal(read(AGILE_QUEUED_SQL), true, 'the same row queues an agile task');
    });
  });
});
