/**
 * `cli.js bro-sqlite-readonly` (src/cli/) on a WAL DB whose -shm is missing
 * (GH 1629, GH 1692): a copy of db+wal whose rows sit only in the -wal, and a
 * detached WAL DB (no -wal, no -shm, as a clean shutdown leaves it), are read
 * from a VACUUM INTO snapshot. The rows come back, the main file's size and
 * mtime and the -wal stay as they were, and the scratch snapshot is removed. A
 * snapshot that cannot be taken fails loudly; a DB with its -shm, or not in
 * WAL mode, keeps the direct read-only path. Every node:sqlite open and
 * statement in the CLI is logged through a --import preload.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { CLI_JS, childEnv, migratedDb, runNode, sandboxDir, sqlExec, sqlRows, type Run } from './db-test-fixtures.js';

/** Each line: [-readonly ]<target> <sql>, one per exec or prepare. */
const TRACE = `import { appendFileSync } from 'node:fs';
const builtin = process.getBuiltinModule.bind(process);
const real = builtin('node:sqlite');
const log = (line) => appendFileSync(process.env.SQLITE_TRACE_LOG, \`\${line}\\n\`);
class TracedDatabase extends real.DatabaseSync {
  #label;
  constructor(target, options) {
    super(target, options);
    this.#label = \`\${options?.readOnly ? '-readonly ' : ''}\${target}\`;
  }
  exec(sql) {
    log(\`\${this.#label} \${sql}\`);
    return super.exec(sql);
  }
  prepare(sql) {
    log(\`\${this.#label} \${sql}\`);
    return super.prepare(sql);
  }
}
const traced = { ...real, DatabaseSync: TracedDatabase };
process.getBuiltinModule = (id) => (id === 'node:sqlite' || id === 'sqlite' ? traced : builtin(id));
`;

const ROWS = `INSERT INTO plugin_config (key, value_json) VALUES ('sentinel', '"wal-only"');
  INSERT INTO issues (id, objective, status, created_at, updated_at, remote_kind, gh_iid)
    VALUES (1, 'row in the wal', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'github', 1629);`;

const OLD = new Date('2020-01-01T00:00:00');
const dbIn = (proj: string) => join(proj, '.claude/tmb/trajectory.db');

function fingerprint(path: string): string {
  if (!existsSync(path)) return 'absent';
  const st = statSync(path);
  return `${st.size} ${Math.floor(st.mtimeMs / 1000)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

describe('readonly-wal-no-shm: bro-sqlite-readonly reads a WAL DB with no -shm from a snapshot (GH 1629)', () => {
  let tmp: string;
  let log: string;
  let scratch: string;
  let trace: string;
  let pristine: string;
  let mainIssues: number;
  let heldProj: string;
  let holder: DatabaseSync | null = null;

  /** Runs the helper against <proj>'s DB from /, the DB named by TRAJECTORY_DB_PATH. */
  function runHelper(proj: string, ...args: string[]): Run {
    writeFileSync(log, '');
    return runNode(['--experimental-sqlite', '--import', trace, CLI_JS, 'bro-sqlite-readonly', ...args], {
      cwd: '/',
      env: childEnv({ HOME: join(tmp, 'home'), SQLITE_TRACE_LOG: log, TMPDIR: scratch, TRAJECTORY_DB_PATH: dbIn(proj) }),
    });
  }
  const logText = () => readFileSync(log, 'utf8');

  function assertSnapshotOnly(): void {
    const other = logText()
      .split('\n')
      .filter((l) => !l.includes('VACUUM INTO') && !l.includes('snap.db'))
      .join('\n');
    assert.ok(!other.includes('trajectory.db'), 'the DB is opened only to take the snapshot');
  }
  const assertScratchClean = () => assert.deepEqual(readdirSync(scratch), [], 'scratch snapshot removed on exit');

  /** The held DB's main file and -wal, without its -shm. */
  function walCopy(proj: string): string {
    const db = dbIn(proj);
    mkdirSync(dirname(db), { recursive: true });
    copyFileSync(join(pristine, 'trajectory.db'), db);
    copyFileSync(join(pristine, 'trajectory.db-wal'), `${db}-wal`);
    utimesSync(db, OLD, OLD);
    utimesSync(`${db}-wal`, OLD, OLD);
    return db;
  }

  before(() => {
    tmp = sandboxDir('readonly-wal-no-shm');
    log = join(tmp, 'sqlite.log');
    scratch = join(tmp, 'scratch');
    trace = join(tmp, 'sqlite-trace.mjs');
    pristine = join(tmp, 'pristine');
    for (const d of [scratch, pristine, join(tmp, 'home')]) mkdirSync(d, { recursive: true });
    writeFileSync(trace, TRACE);

    heldProj = join(tmp, 'held');
    const held = dbIn(heldProj);
    migratedDb(held);
    holder = new DatabaseSync(held);
    holder.prepare('SELECT count(*) FROM sqlite_master').get();
    holder.exec(ROWS);
    copyFileSync(held, join(pristine, 'trajectory.db'));
    copyFileSync(`${held}-wal`, join(pristine, 'trajectory.db-wal'));
  });

  after(() => {
    holder?.close();
    if (existsSync(join(tmp, 'ro/.claude/tmb'))) chmodSync(join(tmp, 'ro/.claude/tmb'), 0o755);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a WAL DB with its -shm (holder open) keeps the direct read-only path', () => {
    assert.ok(existsSync(`${dbIn(heldProj)}-shm`), 'the holder keeps a -shm beside the DB');
    const r = runHelper(heldProj, 'config_get', '{"key":"sentinel"}');
    assert.ok(r.stdout.includes('wal-only'), 'row read');
    assert.ok(!logText().includes('VACUUM INTO'), 'no snapshot taken');
    holder?.close();
    holder = null;
  });

  it("setup: the copy's rows are only in its -wal, and it has no -shm", () => {
    mkdirSync(join(tmp, 'mainonly'), { recursive: true });
    const main = join(tmp, 'mainonly/main.db');
    copyFileSync(join(pristine, 'trajectory.db'), main);
    const uri = `file:${main}?immutable=1`;
    assert.equal(
      sqlRows(uri, "SELECT (SELECT count(*) FROM plugin_config WHERE key = 'sentinel') || ' ' || (SELECT count(*) FROM issues WHERE id = 1);", { readOnly: true }),
      '0 0',
      'main file holds no seeded rows',
    );
    mainIssues = Number(sqlRows(uri, 'SELECT count(*) FROM issues;', { readOnly: true }));
    assert.ok(statSync(join(pristine, 'trajectory.db-wal')).size > 0, 'the -wal is not empty');
    const copy = walCopy(join(tmp, 'copy'));
    assert.ok(!existsSync(`${copy}-shm`), 'the copy has no -shm');
  });

  it('WAL copy without -shm: the rows in its -wal come back, the DB is unchanged', () => {
    const copy = dbIn(join(tmp, 'copy'));
    const mainBefore = fingerprint(copy);
    const walBefore = fingerprint(`${copy}-wal`);
    const r = runHelper(join(tmp, 'copy'), 'config_get', '{"key":"sentinel"}');
    assert.equal(r.code, 0, 'exit 0');
    assert.equal(r.stdout.trim(), '"wal-only"', 'sentinel row read from the -wal');
    assert.ok(logText().includes('VACUUM INTO'), 'read through a snapshot');
    assertSnapshotOnly();
    assert.equal(fingerprint(copy), mainBefore, 'main file size, mtime and content unchanged');
    assert.equal(fingerprint(`${copy}-wal`), walBefore, '-wal size, mtime and content unchanged');
    assertScratchClean();
  });

  it('WAL copy without -shm: issue_get and --dry-run read the -wal rows', () => {
    walCopy(join(tmp, 'copy2'));
    assert.ok(runHelper(join(tmp, 'copy2'), 'issue_get', '{"issue_id":1}').stdout.includes('row in the wal'), 'issue row read');
    walCopy(join(tmp, 'copy3'));
    const out = runHelper(join(tmp, 'copy3'), '--dry-run').stdout;
    assert.ok(out.includes(`"db_path":"${dbIn(join(tmp, 'copy3'))}"`), 'dry-run names the DB, not the snapshot');
    assert.ok(out.includes(`"issues_count":${mainIssues + 1}`), 'dry-run counts the -wal row');
    assertScratchClean();
  });

  it('detached WAL DB (no -wal, no -shm): rows come back, nothing appears beside it', () => {
    const proj = join(tmp, 'detached');
    const det = dbIn(proj);
    migratedDb(det);
    sqlExec(det, `${ROWS} PRAGMA wal_checkpoint(TRUNCATE);`);
    rmSync(`${det}-wal`, { force: true });
    rmSync(`${det}-shm`, { force: true });
    utimesSync(det, OLD, OLD);
    const mainBefore = fingerprint(det);
    const r = runHelper(proj, 'config_get', '{"key":"sentinel"}');
    assert.equal(r.code, 0, 'exit 0');
    assert.equal(r.stdout.trim(), '"wal-only"', 'sentinel row read');
    assert.ok(logText().includes('immutable=1'), 'snapshot taken from an immutable open');
    assertSnapshotOnly();
    assert.equal(fingerprint(det), mainBefore, 'main file size, mtime and content unchanged');
    assert.equal(`${fingerprint(`${det}-wal`)} ${fingerprint(`${det}-shm`)}`, 'absent absent', 'no -wal or -shm created');
    assertScratchClean();
  });

  it('a snapshot that cannot be taken prints the sqlite error and exits non-zero', (t) => {
    const proj = join(tmp, 'ro');
    const ro = walCopy(proj);
    const dir = dirname(ro);
    chmodSync(dir, 0o555);
    let writable = true;
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      writable = false;
    }
    if (writable) {
      chmodSync(dir, 0o755);
      t.skip('running as a user who can write a 555 directory; read-only directory case skipped');
      return;
    }
    let r: Run;
    try {
      r = runHelper(proj, 'config_get', '{"key":"sentinel"}');
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.notEqual(r.code, 0, 'exit 0 on a failed snapshot');
    assert.ok(r.stderr.includes(`snapshot of ${ro} failed`), 'stderr names the failed snapshot');
    assert.ok(r.stderr.includes('unable to open database file'), 'stderr carries the sqlite error');
    assert.equal(r.stdout, '', 'no result printed');
    assertScratchClean();
  });

  it('a rollback-journal DB keeps the direct read-only path', () => {
    const proj = join(tmp, 'delete');
    const del = dbIn(proj);
    migratedDb(del);
    sqlExec(del, `PRAGMA journal_mode=DELETE; ${ROWS}`);
    const r = runHelper(proj, 'config_get', '{"key":"sentinel"}');
    assert.equal(r.stdout.trim(), '"wal-only"', 'sentinel row read');
    assert.ok(!logText().includes('VACUUM INTO'), 'no snapshot taken');
  });
});
