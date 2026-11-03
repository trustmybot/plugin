/**
 * The record-swe-spawn gate (GH 1692) on a temp trajectory DB: a swe spawn
 * for task_id=<N> sweeps the task's stale unbound swe rows, moves a pending
 * task to running and opens its agent_runs row with root_dir, effort, model,
 * spawn_id and plugin_version. GH 2032: a recorded tasks.worktree_path that
 * exists is the row's root_dir; a recorded path that is gone keeps the slug.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { recordSweSpawn, spawnFields, spawnSql } from '../hooks/record-swe-spawn.js';
import { jqInput } from '../hooks/lib/jq-raw.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const T0 = '2026-10-01T10:00:00.000Z';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Task {
  id: number;
  branch?: string;
  status?: string;
  repo?: string | null;
  effort?: string;
  worktree?: string | null;
}

interface Run {
  task_id: number;
  issue_id: number;
  agent_type: string;
  started_at: string;
  repo: string | null;
  root_dir: string | null;
  host: string | null;
  session_id: string | null;
  effort: string | null;
  model: string | null;
  spawn_id: string | null;
  plugin_version: string | null;
  completed_at: string | null;
  exit_reason: string | null;
}

interface Fixture {
  ws: string;
  db: string;
  env: NodeJS.ProcessEnv;
  runs(taskId?: number): Run[];
  status(taskId: number): string;
}

let sandbox: string;
let seq = 0;

/** A workspace <ws> whose DB is <ws>/.claude/tmb/trajectory.db, holding <repos> and <tasks> of issue 1. */
function fixture(repos: Array<{ name: string; path: string }>, tasks: Task[], seed?: (d: DatabaseSync) => void): Fixture {
  seq += 1;
  const ws = join(sandbox, `case-${seq}`);
  const db = join(ws, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  d.exec(SCHEMA);
  d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', ?, ?)").run(T0, T0);
  for (const r of repos) d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run(r.name, r.path);
  for (const t of tasks) {
    d.prepare(
      `INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo, effort, worktree_path)
       VALUES (?, 1, ?, 'd', ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, t.branch ?? `feat/${t.id}`, t.status ?? 'running', T0, T0, t.repo ?? null, t.effort ?? 'medium', t.worktree ?? null);
  }
  seed?.(d);
  d.close();
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(ws, 'home'), TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: ws };
  const read = <T>(sql: string, ...args: number[]): T[] => {
    const r = new DatabaseSync(db, { readOnly: true });
    try {
      return r.prepare(sql).all(...args) as T[];
    } finally {
      r.close();
    }
  };
  return {
    ws,
    db,
    env,
    runs: (taskId) =>
      taskId === undefined ? read<Run>('SELECT * FROM agent_runs ORDER BY id') : read<Run>('SELECT * FROM agent_runs WHERE task_id = ? ORDER BY id', taskId),
    status: (taskId) => read<{ status: string }>('SELECT status FROM tasks WHERE id = ?', taskId)[0].status,
  };
}

const spawn = (prompt: string, extra: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
  JSON.stringify({ tool_name: 'Agent', tool_use_id: 'toolu_1', session_id: 'sess-1', ...extra, tool_input: { subagent_type: 'swe', prompt, ...input } });

function record(f: Fixture, payload: string): void {
  assert.deepEqual(recordSweSpawn(payload, f.env), { stdout: '', code: 0 });
}

function onlyRun(f: Fixture, taskId: number): Run {
  const rows = f.runs(taskId);
  assert.equal(rows.length, 1, `one agent_runs row for task ${taskId}`);
  return rows[0];
}

describe('record-swe-spawn', () => {
  before(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-record-swe-spawn-')));
  });
  after(() => rmSync(sandbox, { recursive: true, force: true }));

  it('opens the run row of a swe spawn', () => {
    const f = fixture([{ name: 'plugin', path: '/repos/plugin' }], [{ id: 5, branch: 'feat/5-thing', repo: 'plugin' }]);
    record(f, spawn('task_id=5 do it', {}, { effort: 'high', model: 'opus' }));
    const run = onlyRun(f, 5);
    assert.equal(run.issue_id, 1);
    assert.equal(run.agent_type, 'swe');
    assert.match(run.started_at, ISO);
    assert.equal(run.repo, 'plugin');
    assert.equal(run.root_dir, '/repos/plugin/.claude/worktrees/5-thing');
    assert.equal(run.host, 'claude');
    assert.equal(run.session_id, 'sess-1');
    assert.equal(run.effort, 'high');
    assert.equal(run.model, 'opus');
    assert.equal(run.spawn_id, 'tool_use:toolu_1');
    assert.equal(run.completed_at, null);
  });

  it('records nothing for another agent type', () => {
    const f = fixture([], [{ id: 5 }]);
    record(f, JSON.stringify({ tool_name: 'Agent', tool_use_id: 't', tool_input: { subagent_type: 'code-reviewer', prompt: 'task_id=5' } }));
    assert.deepEqual(f.runs(), []);
  });

  it('accepts a namespaced swe subagent type', () => {
    const f = fixture([], [{ id: 5 }]);
    record(f, JSON.stringify({ tool_name: 'Agent', tool_use_id: 't', tool_input: { subagent_type: 'tmb:swe', prompt: 'task_id: 5' } }));
    assert.equal(onlyRun(f, 5).spawn_id, 'tool_use:t');
  });

  it('records nothing without a task_id in the prompt', () => {
    const f = fixture([], [{ id: 5 }]);
    record(f, spawn('implement the thing'));
    assert.deepEqual(f.runs(), []);
  });

  it('allows when there is no DB', () => {
    const ws = join(sandbox, 'no-db');
    mkdirSync(ws, { recursive: true });
    const env = { PATH: process.env.PATH, HOME: join(ws, 'home'), TRAJECTORY_DB_PATH: join(ws, 'missing.db'), CLAUDE_PROJECT_DIR: ws };
    assert.deepEqual(recordSweSpawn(spawn('task_id=5'), env), { stdout: '', code: 0 });
  });

  it('records nothing for an unknown task', () => {
    const f = fixture([], [{ id: 5 }]);
    record(f, spawn('task_id=999'));
    assert.deepEqual(f.runs(), []);
  });

  it('moves a pending task to running and leaves other statuses alone', () => {
    const f = fixture([], [{ id: 5, status: 'pending' }, { id: 6, status: 'needs_validation' }]);
    record(f, spawn('task_id=5'));
    record(f, spawn('task_id=6', { tool_use_id: 'toolu_2' }));
    assert.equal(f.status(5), 'running');
    assert.equal(f.status(6), 'needs_validation');
  });

  describe('root_dir', () => {
    it('is the named repo path with a trailing slash dropped', () => {
      const f = fixture([{ name: 'plugin', path: '/repos/plugin/' }], [{ id: 5, branch: 'feat/a', repo: 'plugin' }]);
      record(f, spawn('task_id=5'));
      assert.equal(onlyRun(f, 5).root_dir, '/repos/plugin/.claude/worktrees/a');
    });

    it('falls back to <workspace>/<repo> for a repo without a path', () => {
      const f = fixture([{ name: 'ghost', path: '' }], [{ id: 5, branch: 'feat/a', repo: 'ghost' }]);
      record(f, spawn('task_id=5'));
      assert.equal(onlyRun(f, 5).root_dir, `${f.ws}/ghost/.claude/worktrees/a`);
    });

    it('is the single registered repo for a task without a repo', () => {
      const f = fixture([{ name: 'solo', path: '/repos/solo' }], [{ id: 5, branch: 'feat/a' }]);
      record(f, spawn('task_id=5'));
      assert.equal(onlyRun(f, 5).root_dir, '/repos/solo/.claude/worktrees/a');
    });

    it('is the workspace root when no repo is registered', () => {
      const f = fixture([], [{ id: 5, branch: 'feat/a' }]);
      record(f, spawn('task_id=5'));
      assert.equal(onlyRun(f, 5).root_dir, `${f.ws}/.claude/worktrees/a`);
    });

    it('is the workspace root among several repos for a task without a repo', () => {
      const f = fixture([{ name: 'a', path: '/repos/a' }, { name: 'b', path: '/repos/b' }], [{ id: 5, branch: 'feat/a' }]);
      record(f, spawn('task_id=5'));
      assert.equal(onlyRun(f, 5).root_dir, `${f.ws}/.claude/worktrees/a`);
    });

    it('is NULL for a task with an empty branch', () => {
      const f = fixture([], [{ id: 5, branch: '' }]);
      record(f, spawn('task_id=5'));
      assert.equal(onlyRun(f, 5).root_dir, null);
    });

    it('is the recorded worktree when it exists (GH 2032)', () => {
      const repo = join(sandbox, 'gh2032-repo');
      const recorded = join(repo, '.claude/worktrees/session-1');
      mkdirSync(recorded, { recursive: true });
      const f = fixture([{ name: 'plugin', path: repo }], [{ id: 5, branch: 'feat/adopted', repo: 'plugin', worktree: recorded }]);
      record(f, spawn('task_id=5'));
      assert.equal(onlyRun(f, 5).root_dir, recorded);
    });

    it('keeps the slug path when the recorded worktree is gone (GH 2032)', () => {
      const repo = join(sandbox, 'gh2032-gone');
      mkdirSync(repo, { recursive: true });
      const f = fixture(
        [{ name: 'plugin', path: repo }],
        [{ id: 5, branch: 'feat/adopted', repo: 'plugin', worktree: join(repo, '.claude/worktrees/session-gone') }],
      );
      record(f, spawn('task_id=5'));
      assert.equal(onlyRun(f, 5).root_dir, `${repo}/.claude/worktrees/adopted`);
    });
  });

  describe('effort and model', () => {
    for (const effort of ['low', 'medium', 'high']) {
      it(`stores the spawn effort ${effort}`, () => {
        const f = fixture([], [{ id: 5, effort: effort === 'high' ? 'low' : 'high' }]);
        record(f, spawn('task_id=5', {}, { effort }));
        assert.equal(onlyRun(f, 5).effort, effort);
      });
    }

    it('keeps the task effort for an unknown or missing spawn effort', () => {
      const f = fixture([], [{ id: 5, effort: 'high' }, { id: 6, effort: 'low' }]);
      record(f, spawn('task_id=5', {}, { effort: 'max' }));
      record(f, spawn('task_id=6', { tool_use_id: 'toolu_2' }));
      assert.equal(onlyRun(f, 5).effort, 'high');
      assert.equal(onlyRun(f, 6).effort, 'low');
    });

    it('stores NULL for a missing model and session', () => {
      const f = fixture([], [{ id: 5 }]);
      record(f, JSON.stringify({ tool_name: 'Agent', tool_use_id: 'toolu_9', tool_input: { subagent_type: 'swe', prompt: 'task_id=5' } }));
      const run = onlyRun(f, 5);
      assert.equal(run.model, null);
      assert.equal(run.session_id, null);
    });
  });

  describe('spawn_id', () => {
    it('is tool_use:<tool_use_id>', () => {
      const f = fixture([], [{ id: 5 }]);
      record(f, spawn('task_id=5', { tool_use_id: "toolu_'q" }));
      assert.equal(onlyRun(f, 5).spawn_id, "tool_use:toolu_'q");
    });

    it('falls back to tool_use:<session_id>:<epoch ms>', () => {
      const f = fixture([], [{ id: 5 }]);
      record(f, JSON.stringify({ tool_name: 'Agent', session_id: 'sess-4', tool_input: { subagent_type: 'swe', prompt: 'task_id=5' } }));
      assert.match(onlyRun(f, 5).spawn_id ?? '', /^tool_use:sess-4:\d{13}$/);
    });
  });

  describe('the sweep', () => {
    it('closes stale unbound swe rows of the task as swept_orphan and keeps the rest', () => {
      const f = fixture([], [{ id: 5 }, { id: 6 }], (d) => {
        const add = d.prepare('INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id, completed_at) VALUES (?, 1, ?, ?, ?, ?)');
        add.run(5, 'swe', T0, 'tool_use:toolu_stale', null);
        add.run(5, 'swe', T0, null, null);
        add.run(5, 'swe', T0, 'agent-keyed', null);
        add.run(5, 'swe', '2099-01-01T00:00:00.000Z', 'tool_use:toolu_future', null);
        add.run(5, 'swe', T0, 'tool_use:toolu_done', '2026-10-01T11:00:00.000Z');
        add.run(5, 'code-reviewer', T0, 'tool_use:toolu_reviewer', null);
        add.run(6, 'swe', T0, 'tool_use:toolu_other', null);
      });
      record(f, spawn('task_id=5', { tool_use_id: 'toolu_new' }));
      const bySpawn = new Map(f.runs().map((r) => [r.spawn_id, r]));
      assert.equal(bySpawn.get('tool_use:toolu_stale')?.exit_reason, 'swept_orphan');
      assert.match(bySpawn.get('tool_use:toolu_stale')?.completed_at ?? '', ISO);
      const nullSpawn = f.runs(5).find((r) => r.spawn_id === null);
      assert.equal(nullSpawn?.exit_reason, 'swept_orphan');
      for (const kept of ['agent-keyed', 'tool_use:toolu_future', 'tool_use:toolu_reviewer', 'tool_use:toolu_other']) {
        assert.equal(bySpawn.get(kept)?.completed_at, null, `${kept} stays open`);
      }
      assert.equal(bySpawn.get('tool_use:toolu_done')?.completed_at, '2026-10-01T11:00:00.000Z');
      assert.equal(bySpawn.get('tool_use:toolu_done')?.exit_reason, null);
      assert.equal(bySpawn.get('tool_use:toolu_new')?.completed_at, null);
    });
  });

  it('writes nothing to a corrupt DB and still allows', () => {
    const ws = join(sandbox, 'corrupt');
    const db = join(ws, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(db), { recursive: true });
    writeFileSync(db, 'not a database');
    const env = { PATH: process.env.PATH, HOME: join(ws, 'home'), TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: ws };
    assert.deepEqual(recordSweSpawn(spawn('task_id=5'), env), { stdout: '', code: 0 });
    assert.equal(readFileSync(db, 'utf8'), 'not a database');
  });
});

describe('spawnFields', () => {
  it('reads the four fields and stringifies non-strings', () => {
    assert.deepEqual(spawnFields(jqInput('{"session_id":12,"tool_use_id":"t","tool_input":{"effort":"low","model":5}}')), {
      sessionId: '12',
      toolUseId: 't',
      effort: 'low',
      model: '5',
    });
  });

  it('is null on a parse error or an unindexable last value', () => {
    assert.equal(spawnFields(jqInput('{"session_id":"s"} {oops')), null);
    assert.equal(spawnFields(jqInput('{"session_id":"s"} 3')), null);
  });

  it('keeps the first value of a stream and the first line of a field', () => {
    assert.deepEqual(spawnFields(jqInput('3 {"session_id":"a\\nb","tool_use_id":"t"}')), { sessionId: 'a', toolUseId: '', effort: '', model: '' });
  });
});

describe('spawnSql', () => {
  const base = { taskId: '5', rootDir: null, spawnId: "tool_use:o'k", pluginVersion: '', now: T0 };
  const fields = { sessionId: '', toolUseId: '', effort: 'max', model: '' };

  it('keeps the effort column for an unknown effort and NULLs empty values', () => {
    const sql = spawnSql({ ...base, fields });
    assert.match(sql, /'claude',\n\s+NULL, effort, NULL, 'tool_use:o''k', NULL/);
    assert.match(sql, /repo, NULL, 'claude'/);
  });

  it('quotes a known effort and the root dir', () => {
    const sql = spawnSql({ ...base, rootDir: "/r/o'k", fields: { ...fields, effort: 'low' } });
    assert.match(sql, /repo, '\/r\/o''k', 'claude'/);
    assert.match(sql, /NULL, 'low', NULL/);
  });
});
