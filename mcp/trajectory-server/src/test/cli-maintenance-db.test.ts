/**
 * `cli.js trajectory-doctor` and `cli.js backfill-agent-runs` (GH 1692) keep
 * the flags and exit codes of the shell wrappers they replace, run against
 * the built dist/cli.js bundle on temp DBs.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { TARGET_SCHEMA_VERSION, TrajectoryDB } from '../db.js';
import { installRoot } from '../hooks/lib/project-env.js';

const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url))) as string;
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');

let sandbox: string;
let n = 0;

interface Run {
  code: number | null;
  out: string;
  err: string;
}

function cli(args: string[], extra: NodeJS.ProcessEnv = {}): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(sandbox, 'home') };
  for (const key of ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'TRAJECTORY_DB_PATH']) delete env[key];
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', CLI, ...args], {
    cwd: join(sandbox, 'cwd'),
    env: { ...env, ...extra },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function freshDb(): string {
  n += 1;
  const path = join(sandbox, `t${n}.db`);
  new TrajectoryDB(path).close();
  return path;
}

function query<T>(db: string, sql: string): T {
  const d = new DatabaseSync(db);
  try {
    return d.prepare(sql).get() as T;
  } finally {
    d.close();
  }
}

function exec(db: string, sql: string): void {
  const d = new DatabaseSync(db);
  try {
    d.exec(sql);
  } finally {
    d.close();
  }
}

const doctorRuns = (db: string): number =>
  query<{ c: number }>(db, "SELECT COUNT(*) AS c FROM audit WHERE event_type = 'trajectory_doctor_run'").c;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tmb-maintenance-db-'));
  mkdirSync(join(sandbox, 'home'));
  mkdirSync(join(sandbox, 'cwd'));
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('cli.js trajectory-doctor', () => {
  it('a healthy DB prints the JSON report and exits 0', () => {
    const r = cli(['trajectory-doctor', '--db', freshDb()]);
    assert.equal(r.code, 0, r.err);
    assert.equal((JSON.parse(r.out) as { healthy: boolean }).healthy, true);
  });

  it('TRAJECTORY_DB_PATH stands in for --db', () => {
    const r = cli(['trajectory-doctor'], { TRAJECTORY_DB_PATH: freshDb() });
    assert.equal(r.code, 0, r.err);
  });

  it('an error-severity violation exits 1; --ids runs only the named contracts', () => {
    const db = freshDb();
    const now = new Date().toISOString();
    const d = new DatabaseSync(db);
    try {
      d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'closed', ?, ?)").run(now, now);
      d.prepare(
        "INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at) VALUES (1, 'feat/x', 'd', 'running', ?, ?)",
      ).run(now, now);
    } finally {
      d.close();
    }
    const r = cli(['trajectory-doctor', '--db', db, '--ids', 'issues_closed_no_live_tasks']);
    assert.equal(r.code, 1, r.out);
    const report = JSON.parse(r.out) as { healthy: boolean; violations: { id: string }[] };
    assert.equal(report.healthy, false);
    assert.deepEqual(report.violations.map((v) => v.id), ['issues_closed_no_live_tasks']);
  });

  it('an unknown --ids id exits 2 with the known ids', () => {
    const r = cli(['trajectory-doctor', '--db', freshDb(), '--ids', 'nope']);
    assert.equal(r.code, 2);
    assert.ok('error' in (JSON.parse(r.out) as object), r.out);
  });

  it('--record adds one trajectory_doctor_run audit row', () => {
    const db = freshDb();
    const r = cli(['trajectory-doctor', '--db', db, '--record']);
    assert.equal(r.code, 0, r.err);
    assert.equal(doctorRuns(db), 1);
  });

  it('an older-schema DB exits 2 unchecked and is never migrated; --record writes nothing', () => {
    const db = freshDb();
    exec(db, 'UPDATE plugin_meta SET schema_version = 3');
    const r = cli(['trajectory-doctor', '--db', db]);
    assert.equal(r.code, 2, r.out);
    assert.ok(r.err.includes('start the trajectory server to migrate'), r.err);
    const rec = cli(['trajectory-doctor', '--db', db, '--record']);
    assert.equal(rec.code, 2, rec.out);
    assert.equal(query<{ v: number }>(db, 'SELECT MAX(schema_version) AS v FROM plugin_meta').v, 3);
    assert.equal(doctorRuns(db), 0);
    assert.notEqual(TARGET_SCHEMA_VERSION, 3);
  });

  it('usage: an unknown argument or a flag with no value exits 2; --help exits 0', () => {
    const unknown = cli(['trajectory-doctor', '--bogus']);
    assert.equal(unknown.code, 2);
    assert.ok(unknown.err.includes('trajectory-doctor: unknown argument: --bogus'), unknown.err);
    assert.equal(cli(['trajectory-doctor', '--db']).code, 2);
    assert.equal(cli(['trajectory-doctor', '--ids']).code, 2);
    const help = cli(['trajectory-doctor', '--help']);
    assert.equal(help.code, 0);
    assert.ok(help.out.includes('cli.js trajectory-doctor [--db <path>] [--ids <id,id,...>] [--record]'), help.out);
  });
});

describe('cli.js backfill-agent-runs', () => {
  it('a dry run prints the report and writes nothing; --apply runs for real', () => {
    const db = freshDb();
    const transcripts = join(sandbox, 'transcripts');
    mkdirSync(transcripts, { recursive: true });
    const dry = cli(['backfill-agent-runs', '--transcripts-dir', transcripts, '--since', '2020-01-01T00:00:00Z'], { TRAJECTORY_DB_PATH: db });
    assert.equal(dry.code, 0, dry.out + dry.err);
    assert.equal((JSON.parse(dry.out) as { dry_run: boolean }).dry_run, true);
    assert.equal(query<{ c: number }>(db, "SELECT COUNT(*) AS c FROM audit WHERE event_type LIKE '%backfill%'").c, 0);
    const apply = cli(['backfill-agent-runs', '--transcripts-dir', transcripts, '--apply'], { TRAJECTORY_DB_PATH: db });
    assert.equal(apply.code, 0, apply.out + apply.err);
    assert.equal((JSON.parse(apply.out) as { dry_run: boolean }).dry_run, false);
  });

  it('a tool error exits 1', () => {
    const r = cli(['backfill-agent-runs', '--since', 'garbage'], { TRAJECTORY_DB_PATH: freshDb() });
    assert.equal(r.code, 1, r.out);
  });

  it('no DB prints the usage and exits 2', () => {
    const r = cli(['backfill-agent-runs'], { TRAJECTORY_DB_PATH: join(sandbox, 'missing/trajectory.db') });
    assert.equal(r.code, 2);
    assert.ok(r.err.includes('cli.js backfill-agent-runs [--apply] [--since <ISO>] [--transcripts-dir <dir>]'), r.err);
  });

  it('usage: an unknown argument or a flag with no value exits 2; --help exits 0', () => {
    const unknown = cli(['backfill-agent-runs', '--nope']);
    assert.equal(unknown.code, 2);
    assert.ok(unknown.err.includes('backfill-agent-runs: unknown argument: --nope'), unknown.err);
    assert.equal(cli(['backfill-agent-runs', '--since']).code, 2);
    assert.equal(cli(['backfill-agent-runs', '--transcripts-dir']).code, 2);
    assert.equal(cli(['backfill-agent-runs', '--help']).code, 0);
  });
});
