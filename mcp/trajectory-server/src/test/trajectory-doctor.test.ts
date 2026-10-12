import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDB } from './helpers.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SCHEMA_V28_SQL } from './fixtures/schema-v28.js';
import type { TrajectoryDB } from '../db.js';
import { DATA_CONTRACTS, DATA_CONTRACTS_SCHEMA_VERSION, NULLABLE_COLUMNS, dataContractsJson, type Contract } from '../data-contracts.js';
import { AUDIT_EVENT_TYPES } from '../audit-events.js';
import { checkTrajectoryDbFile, runDataContracts, trajectoryDbReader, trajectoryDoctorTools, type ContractReader } from '../tools/trajectory-doctor.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

function contract(id: string): Contract {
  const c = DATA_CONTRACTS.find((k) => k.id === id);
  assert.ok(c, `contract ${id} exists`);
  return c;
}

function violated(db: TrajectoryDB, id: string): boolean {
  const report = runDataContracts(trajectoryDbReader(db), [contract(id)], { env: {} });
  assert.deepEqual(report.skipped, [], `${id} ran without error`);
  return report.violations.some((v) => v.id === id);
}

function seedIssue(db: TrajectoryDB, status: 'open' | 'closed' = 'open'): number {
  db.run(`INSERT INTO issues (objective, status, created_at, updated_at) VALUES ('doctor', ?, ?, ?)`, [status, iso(), iso()]);
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM issues')!.id;
}

function seedTask(db: TrajectoryDB, issueId: number, status: string, updatedAt = iso()): number {
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at)
     VALUES (?, ?, 'd', ?, ?, ?)`,
    [issueId, `feat/t-${Math.random().toString(36).slice(2)}`, status, iso(), updatedAt],
  );
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM tasks')!.id;
}

function seedAudit(db: TrajectoryDB, eventType: string, content: Record<string, unknown> = {}, createdAt = iso(), fromNode = 'bro'): void {
  db.run(
    `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (-1, ?, ?, 's', ?, ?)`,
    [fromNode, eventType, JSON.stringify(content), createdAt],
  );
}

interface RunOpts {
  agentType?: string;
  taskId?: number | null;
  completedAt?: string | null;
  tokens?: number | null;
  usageSource?: string | null;
  sessionId?: string | null;
  model?: string | null;
  host?: string | null;
  rootDir?: string | null;
  exitReason?: string | null;
}

function seedRun(db: TrajectoryDB, o: RunOpts = {}): void {
  const completedAt = o.completedAt === undefined ? iso() : o.completedAt;
  const tokens = o.tokens === undefined ? 100 : o.tokens;
  db.run(
    `INSERT INTO agent_runs (task_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens,
       started_at, completed_at, session_id, usage_source, model, host, root_dir, exit_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      o.taskId ?? null,
      o.agentType ?? 'swe',
      tokens,
      tokens,
      tokens,
      tokens,
      iso(-HOUR),
      completedAt,
      o.sessionId === undefined ? 'sess' : o.sessionId,
      o.usageSource === undefined ? (completedAt ? 'subagent_stop' : null) : o.usageSource,
      o.model === undefined ? 'claude-opus' : o.model,
      o.host === undefined ? 'claude' : o.host,
      o.rootDir === undefined ? '/w' : o.rootDir,
      o.exitReason === undefined ? (completedAt ? 'completed' : null) : o.exitReason,
    ],
  );
}

// One violating and one passing fixture per contract id.
// populated_tasks_prompt_bearing has no violating row: the column is NOT NULL,
// so its violation is shown through a reader that reports a drifted DB.
const FIXTURES: Record<string, { violate?: (db: TrajectoryDB) => void; pass: (db: TrajectoryDB) => void }> = {
  fk_check_empty: {
    violate: (db) => {
      db.run('PRAGMA foreign_keys = OFF');
      db.run(`INSERT INTO tasks (issue_id, branch_id, description, created_at, updated_at) VALUES (9999, 'b', 'd', ?, ?)`, [iso(), iso()]);
      db.run('PRAGMA foreign_keys = ON');
    },
    pass: (db) => {
      seedTask(db, seedIssue(db), 'pending');
    },
  },
  event_type_documented: {
    violate: (db) => seedAudit(db, 'made_up_event'),
    pass: (db) => seedAudit(db, 'planning_complete'),
  },
  swe_runs_metered: {
    violate: (db) => seedRun(db, { tokens: 0, usageSource: 'subagent_stop' }),
    pass: (db) => {
      seedRun(db, { tokens: 0, usageSource: 'unmeasured' });
      seedRun(db, { tokens: 0, usageSource: 'subagent_stop', completedAt: iso(-8 * DAY) });
      seedRun(db, { agentType: 'bro', tokens: 0, usageSource: 'transcript' });
      seedRun(db, { tokens: 5 });
    },
  },
  closed_tasks_reviewed: {
    violate: (db) => {
      seedTask(db, seedIssue(db), 'closed', iso(-25 * HOUR));
    },
    pass: (db) => {
      const issue = seedIssue(db);
      seedTask(db, issue, 'closed', iso(-HOUR));
      const reviewed = seedTask(db, issue, 'closed', iso(-25 * HOUR));
      db.run(
        `INSERT INTO validation_attempts (task_id, attempt_n, verdict, mcp_available, created_at) VALUES (?, 1, 'pass', 1, ?)`,
        [reviewed, iso()],
      );
      const bypassed = seedTask(db, issue, 'closed', iso(-25 * HOUR));
      seedAudit(db, 'review_gate_bypassed', { task_id: bypassed, commit_sha: 'abc1234' });
      const waived = seedTask(db, issue, 'closed', iso(-25 * HOUR));
      seedAudit(db, 'review_gate_waived', { task_id: waived });
      const mergeBypassed = seedTask(db, issue, 'closed', iso(-25 * HOUR));
      seedAudit(db, 'review_gate_bypassed', { task_id: mergeBypassed }, iso(), 'hook:close-issue-on-merge');
      seedTask(db, issue, 'closed', iso(-31 * DAY));
    },
  },
  no_stale_running: {
    violate: (db) => {
      seedTask(db, seedIssue(db), 'running', iso(-7 * HOUR));
    },
    pass: (db) => {
      const issue = seedIssue(db);
      seedTask(db, issue, 'running', iso(-HOUR));
      const live = seedTask(db, issue, 'running', iso(-7 * HOUR));
      seedRun(db, { taskId: live, completedAt: null });
    },
  },
  scan_fresh: {
    violate: (db) => {
      db.run(`INSERT INTO repos (name, path, last_scanned_at) VALUES ('r', '/r', ?)`, [iso(-8 * DAY)]);
    },
    pass: (db) => {
      db.run(`INSERT INTO repos (name, path, last_scanned_at) VALUES ('r', '/r', ?)`, [iso(-8 * DAY)]);
      db.run(`INSERT INTO repos (name, path, last_scanned_at) VALUES ('s', '/s', ?)`, [iso(-DAY)]);
    },
  },
  waiver_not_duplicated: {
    violate: (db) => {
      seedAudit(db, 'verification_gate_waived', { task_id: 7, waiver_reason: 'flaky network test' });
      seedAudit(db, 'verification_gate_waived', { task_id: 7, waiver_reason: 'flaky network test' });
    },
    pass: (db) => {
      seedAudit(db, 'verification_gate_waived', { task_id: 7, commit_sha: 'aaa1111' });
      seedAudit(db, 'verification_gate_waived', { task_id: 7, commit_sha: 'bbb2222' });
      seedAudit(db, 'verification_gate_waived', { task_id: 8 });
    },
  },
  embeddings_not_degraded: {
    violate: (db) => {
      seedAudit(db, 'embeddings_degraded', { reason: 'model load failed', consecutive_failures: 1 }, iso(-2 * HOUR));
      seedAudit(db, 'embeddings_recovered', { retries: 1 }, iso(-HOUR));
      seedAudit(db, 'embeddings_degraded', { reason: '5 consecutive embed failures', consecutive_failures: 5 });
    },
    pass: (db) => {
      seedAudit(db, 'embeddings_degraded', { reason: 'model load failed', consecutive_failures: 1 }, iso(-2 * DAY));
      seedAudit(db, 'embeddings_degraded', { reason: 'model load failed', consecutive_failures: 1 }, iso(-2 * HOUR));
      seedAudit(db, 'embeddings_recovered', { retries: 1 }, iso(-HOUR));
    },
  },
  populated_agent_runs_session_id: {
    violate: (db) => seedRun(db, { sessionId: null }),
    pass: (db) => {
      for (let i = 0; i < 9; i++) seedRun(db);
      seedRun(db, { sessionId: null });
    },
  },
  populated_agent_runs_usage_source: {
    violate: (db) => seedRun(db, { usageSource: null }),
    pass: (db) => {
      seedRun(db);
      seedRun(db, { completedAt: null });
    },
  },
  populated_agent_runs_model: {
    violate: (db) => seedRun(db, { model: null }),
    pass: (db) => {
      seedRun(db);
      seedRun(db, { model: null, usageSource: 'unmeasured', tokens: null });
    },
  },
  populated_agent_runs_host: {
    violate: (db) => seedRun(db, { host: null }),
    pass: (db) => seedRun(db),
  },
  populated_agent_runs_root_dir: {
    violate: (db) => seedRun(db, { rootDir: null }),
    pass: (db) => seedRun(db),
  },
  populated_agent_runs_exit_reason: {
    violate: (db) => seedRun(db, { exitReason: null }),
    pass: (db) => {
      seedRun(db);
      seedRun(db, { completedAt: null });
    },
  },
  populated_tasks_prompt_bearing: {
    pass: (db) => {
      seedTask(db, seedIssue(db), 'pending');
    },
  },
  issues_closed_no_live_tasks: {
    violate: (db) => {
      seedTask(db, seedIssue(db, 'closed'), 'completed');
    },
    pass: (db) => {
      seedTask(db, seedIssue(db, 'closed'), 'closed');
      seedTask(db, seedIssue(db, 'closed'), 'escalated');
      seedTask(db, seedIssue(db, 'open'), 'running');
    },
  },
};

describe('data contracts', () => {
  it('a fresh DB is healthy with no violations', () => {
    const db = tempDB();
    const report = runDataContracts(trajectoryDbReader(db), DATA_CONTRACTS, { env: {} });
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.skipped, []);
    assert.equal(report.healthy, true);
  });

  it('every contract has a violating and a passing fixture', () => {
    assert.deepEqual(Object.keys(FIXTURES).sort(), DATA_CONTRACTS.map((c) => c.id).sort());
  });

  for (const c of DATA_CONTRACTS) {
    it(`${c.id}: violating fixture fails, passing fixture holds`, () => {
      const fx = FIXTURES[c.id]!;
      if (!fx.violate) {
        const db = tempDB();
        seedTask(db, seedIssue(db), 'pending');
        const nullReader: ContractReader = {
          get: (sql, params) => (sql === c.sql ? { rate: 1 } : trajectoryDbReader(db).get(sql, params)),
          all: () => [],
        };
        const report = runDataContracts(nullReader, [c], { env: {} });
        assert.equal(report.violations[0]?.id, c.id);
      } else {
        const bad = tempDB();
        fx.violate(bad);
        assert.equal(violated(bad, c.id), true, `${c.id} should be violated`);
      }
      const good = tempDB();
      fx.pass(good);
      assert.equal(violated(good, c.id), false, `${c.id} should hold`);
    });
  }

  it('closed_tasks_reviewed does not count a review_gate_waived row bro did not write', () => {
    const db = tempDB();
    const task = seedTask(db, seedIssue(db), 'closed', iso(-25 * HOUR));
    seedAudit(db, 'review_gate_waived', { task_id: task }, iso(), 'pr-reviewer');
    assert.equal(violated(db, 'closed_tasks_reviewed'), true);
  });

  it('closed_tasks_reviewed does not count a review_gate_bypassed row from another hook', () => {
    const db = tempDB();
    const task = seedTask(db, seedIssue(db), 'closed', iso(-25 * HOUR));
    seedAudit(db, 'review_gate_bypassed', { task_id: task }, iso(), 'hook:other-hook');
    assert.equal(violated(db, 'closed_tasks_reviewed'), true);
  });

  it('no_stale_running reads TMB_STALE_RUNNING_HOURS', () => {
    const db = tempDB();
    seedTask(db, seedIssue(db), 'running', iso(-7 * HOUR));
    const c = contract('no_stale_running');
    assert.equal(runDataContracts(trajectoryDbReader(db), [c], { env: { TMB_STALE_RUNNING_HOURS: '8' } }).violations.length, 0);
    assert.equal(runDataContracts(trajectoryDbReader(db), [c], { env: {} }).violations.length, 1);
  });

  it('compares legacy `YYYY-MM-DD HH:MM:SS` timestamps by time', () => {
    const db = tempDB();
    const legacy = (offsetMs: number): string => iso(offsetMs).replace('T', ' ').slice(0, 19);
    seedTask(db, seedIssue(db), 'running', legacy(-HOUR));
    assert.equal(violated(db, 'no_stale_running'), false);
    seedTask(db, seedIssue(db), 'running', legacy(-7 * HOUR));
    assert.equal(violated(db, 'no_stale_running'), true);
  });

  it('closed_tasks_reviewed waits TMB_REVIEW_GRACE_HOURS (default 24) after the close for a review', () => {
    const db = tempDB();
    seedTask(db, seedIssue(db), 'closed', iso(-20 * HOUR));
    const c = contract('closed_tasks_reviewed');
    assert.equal(runDataContracts(trajectoryDbReader(db), [c], { env: {} }).violations.length, 0);
    assert.equal(runDataContracts(trajectoryDbReader(db), [c], { env: { TMB_REVIEW_GRACE_HOURS: '12' } }).violations.length, 1);
  });

  it('skips contracts that need a newer schema than the DB has, and the error ones make it unhealthy', () => {
    const db = tempDB();
    db.run('UPDATE plugin_meta SET schema_version = 29 WHERE id = 1');
    const report = runDataContracts(trajectoryDbReader(db), DATA_CONTRACTS, { env: {} });
    const skipped = new Set(report.skipped.map((s) => s.id));
    assert.deepEqual(report.schema, { stored: 29, required: DATA_CONTRACTS_SCHEMA_VERSION, current: false });
    for (const c of DATA_CONTRACTS) assert.equal(skipped.has(c.id), (c.min_schema ?? 0) > 29, c.id);
    assert.match(report.skipped[0]!.reason, /^schema v29 < v3\d — start the trajectory server to migrate$/);
    assert.equal(report.healthy, false, 'swe_runs_metered (error) could not run');
  });

  it('checks a v28 DB file without migrating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-doctor-'));
    try {
      const path = join(dir, 'trajectory.db');
      const seed = new DatabaseSync(path);
      seed.exec(SCHEMA_V28_SQL);
      seed.exec('PRAGMA user_version = 28');
      seed.close();
      const report = checkTrajectoryDbFile(path, DATA_CONTRACTS, { env: {} });
      assert.equal(report.schema.stored, 28);
      assert.equal(report.schema.current, false);
      assert.ok(report.skipped.some((s) => s.id === 'swe_runs_metered' && s.reason.startsWith('schema v28 <')));
      const after = new DatabaseSync(path, { readOnly: true });
      const meta = after.prepare('SELECT schema_version FROM plugin_meta').get() as { schema_version: number };
      const uv = after.prepare('PRAGMA user_version').get() as { user_version: number };
      const cols = (after.prepare(`SELECT name FROM pragma_table_info('agent_runs')`).all() as Array<{ name: string }>).map((r) => r.name);
      after.close();
      assert.equal(meta.schema_version, 28);
      assert.equal(uv.user_version, 28);
      assert.equal(cols.includes('usage_source'), false, 'no v30 column appeared');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a violation carries actual, expected, severity and a sample', () => {
    const db = tempDB();
    seedTask(db, seedIssue(db, 'closed'), 'running');
    const report = runDataContracts(trajectoryDbReader(db), [contract('issues_closed_no_live_tasks')], { env: {} });
    const v = report.violations[0]!;
    assert.equal(v.actual, 1);
    assert.deepEqual(v.expected, { op: '=', value: 0 });
    assert.equal(v.severity, 'error');
    assert.equal(v.sample.length, 1);
    assert.equal(report.healthy, false);
  });

  it('warn-severity violations leave the report healthy', () => {
    const db = tempDB();
    seedRun(db, { host: null });
    const report = runDataContracts(trajectoryDbReader(db), DATA_CONTRACTS, { env: {} });
    assert.deepEqual(report.violations.map((v) => v.id), ['populated_agent_runs_host']);
    assert.equal(report.healthy, true);
  });

  it('an error-severity contract that errors is skipped and the report is unhealthy', () => {
    const throwing: ContractReader = {
      get: () => {
        throw new Error('database is locked');
      },
      all: () => [],
    };
    const report = runDataContracts(throwing, [contract('fk_check_empty')], { env: {} });
    assert.deepEqual(report.violations, []);
    assert.equal(report.skipped[0]?.id, 'fk_check_empty');
    assert.match(report.skipped[0]!.reason, /database is locked/);
    assert.equal(report.healthy, false);
  });

  it('an error-severity contract past the statement timeout is skipped and the report is unhealthy', () => {
    const db = tempDB();
    let t = 0;
    const report = runDataContracts(trajectoryDbReader(db), [contract('fk_check_empty'), contract('scan_fresh')], {
      env: {},
      statementTimeoutMs: 50,
      now: () => (t += 100),
    });
    assert.deepEqual(report.skipped.map((s) => s.id), ['fk_check_empty', 'scan_fresh']);
    assert.match(report.skipped[0]!.reason, /^timeout/);
    assert.equal(report.healthy, false);
  });

  it('a warn-severity skip alone keeps the report healthy', () => {
    const throwing: ContractReader = {
      get: () => {
        throw new Error('no such column');
      },
      all: () => [],
    };
    assert.equal(runDataContracts(throwing, [contract('scan_fresh')], { env: {} }).healthy, true);
  });

  it('declares the nullable v29–v33 columns with a reason and gives them no contract', () => {
    const ids = new Set(DATA_CONTRACTS.map((c) => c.id));
    assert.ok(NULLABLE_COLUMNS.some((n) => n.table === 'discussions' && n.column === 'remote_comment_id'));
    for (const n of NULLABLE_COLUMNS) {
      assert.ok(n.reason.length > 0);
      assert.equal(ids.has(`populated_${n.table}_${n.column}`), false);
    }
  });

  it('event_type_documented checks against every AUDIT_EVENT_TYPES entry', () => {
    const sql = contract('event_type_documented').sql;
    for (const e of AUDIT_EVENT_TYPES) assert.ok(sql.includes(`'${e.type}'`), e.type);
    assert.ok(AUDIT_EVENT_TYPES.some((e) => e.type === 'trajectory_doctor_run'));
  });

  it('scripts/hooks/lib/data-contracts.json is generated from DATA_CONTRACTS and fresh', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const committed = readFileSync(join(here, '..', '..', '..', '..', 'scripts', 'hooks', 'lib', 'data-contracts.json'), 'utf8');
    assert.equal(committed, dataContractsJson(), 'stale — run: node scripts/maintenance/emit-data-contracts.mjs');
  });
});

describe('trajectory_doctor tool', () => {
  async function call(db: TrajectoryDB, args: Record<string, unknown>): Promise<RawResult> {
    return (await trajectoryDoctorTools(db).handlers['trajectory_doctor']!(args)) as RawResult;
  }
  const auditCount = (db: TrajectoryDB): number => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit')!.n;

  it('is bro-only', async () => {
    const db = tempDB();
    for (const agent of ['swe', 'pr-reviewer', 'architect']) {
      const res = await call(db, { agent });
      assert.equal(res.isError, true);
      assert.equal(JSON.parse(res.content[0]!.text).error, 'forbidden');
    }
  });

  it('record:false (the default) writes nothing', async () => {
    const db = tempDB();
    seedTask(db, seedIssue(db, 'closed'), 'pending');
    const before = auditCount(db);
    const body = JSON.parse((await call(db, { agent: 'bro' })).content[0]!.text);
    assert.equal(body.healthy, false);
    assert.equal(typeof body.checked_at, 'string');
    assert.deepEqual(body.violations.map((v: { id: string }) => v.id), ['issues_closed_no_live_tasks']);
    assert.equal(auditCount(db), before);
    await call(db, { agent: 'bro', record: false });
    assert.equal(auditCount(db), before);
  });

  it('record:true writes exactly one trajectory_doctor_run audit row on the system issue', async () => {
    const db = tempDB();
    const before = auditCount(db);
    const body = JSON.parse((await call(db, { agent: 'bro', record: true })).content[0]!.text);
    assert.equal(auditCount(db), before + 1);
    const row = db.get<{ id: number; issue_id: number; event_type: string; content_json: string }>(
      `SELECT id, issue_id, event_type, content_json FROM audit ORDER BY id DESC LIMIT 1`,
    )!;
    assert.equal(row.id, body.audit_id);
    assert.equal(row.issue_id, -1);
    assert.equal(row.event_type, 'trajectory_doctor_run');
    assert.equal(JSON.parse(row.content_json).healthy, true);
    const again = JSON.parse((await call(db, { agent: 'bro' })).content[0]!.text);
    assert.deepEqual(again.violations, [], 'a recorded run is itself a documented event');
  });

  it('carries the live embedding model status', async () => {
    const db = tempDB();
    const body = JSON.parse((await call(db, { agent: 'bro' })).content[0]!.text);
    assert.ok(['ready', 'degraded', 'loading', 'disabled'].includes(body.embeddings.state));
    assert.equal(typeof body.embeddings.consecutive_failures, 'number');
  });

  it('ids runs only the named subset', async () => {
    const db = tempDB();
    seedTask(db, seedIssue(db, 'closed'), 'pending');
    seedAudit(db, 'made_up_event');
    const body = JSON.parse((await call(db, { agent: 'bro', ids: ['event_type_documented'] })).content[0]!.text);
    assert.deepEqual(body.violations.map((v: { id: string }) => v.id), ['event_type_documented']);
  });

  it('rejects unknown ids', async () => {
    const db = tempDB();
    const res = await call(db, { agent: 'bro', ids: ['nope'] });
    assert.equal(res.isError, true);
    assert.match(JSON.parse(res.content[0]!.text).error, /unknown contract id\(s\): nope/);
  });
});
