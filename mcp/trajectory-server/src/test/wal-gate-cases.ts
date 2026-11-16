/**
 * The gate WAL cases (GH 1692): a gate must read a healthy WAL trajectory DB
 * that no process holds open (its -shm/-wal absent), read it while a holder
 * has it open, and fail closed when no read can open the DB. The gate reads
 * through node:sqlite.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runGate } from './hook-sandbox.js';

/** <db> in WAL mode, checkpointed, with no -shm or -wal beside it. */
export function walDetach(db: string): void {
  const d = new DatabaseSync(db);
  try {
    d.exec('PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    d.close();
  }
  rmSync(`${db}-shm`, { force: true });
  rmSync(`${db}-wal`, { force: true });
}

function strays(dir: string, keep: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...strays(p, keep));
    else if ((e.name.endsWith('-shm') || e.name.endsWith('-wal')) && !keep.has(p)) out.push(p);
  }
  return out;
}

export interface WalGateCase {
  label: string;
  gate: string;
  /** Sits under <proj>. */
  db: string;
  proj: string;
  input: string;
  /** The gate's normal decision holds it ('' skips the check). */
  expect: string;
  /** A string a failed (empty) read would produce. */
  forbid: string;
  cwd: string;
  /** The env the gate runs in; HOME, TMPDIR and TRAJECTORY_DB_PATH are set per run. */
  env: () => NodeJS.ProcessEnv;
  /** The scratch dir for HOME and TMPDIR. */
  work: () => string;
}

/** Registers the four WAL cases as `it` blocks in the calling describe. */
export function walGateCases(c: WalGateCase): void {
  const paths = () => {
    const work = c.work();
    return { home: join(work, 'home'), tmp: join(work, 'tmp') };
  };
  const run = () => {
    const p = paths();
    const r = runGate(c.gate, {
      cwd: c.cwd,
      input: c.input,
      env: { ...c.env(), HOME: p.home, TMPDIR: p.tmp, TRAJECTORY_DB_PATH: c.db },
    });
    return r.stdout + r.stderr;
  };
  const decidesNormally = (out: string, what: string) => {
    assert.ok(!out.includes('trajectory DB unavailable'), `${what} is not an unavailable DB: ${out}`);
    if (c.expect !== '') assert.ok(out.includes(c.expect), `the gate's normal decision: ${out}`);
    assert.ok(!out.includes(c.forbid), `no read came back empty: ${out}`);
  };

  it(`${c.label}: WAL DB with no holder → the gate reads it and decides normally`, () => {
    const p = paths();
    mkdirSync(p.home, { recursive: true });
    mkdirSync(p.tmp, { recursive: true });
    walDetach(c.db);
    decidesNormally(run(), 'no holder');
  });

  it(`${c.label}: the no-holder read leaves -shm/-wal beside the DB, nothing under HOME or TMPDIR`, () => {
    const p = paths();
    const found = [...strays(c.proj, new Set([`${c.db}-shm`, `${c.db}-wal`])), ...readdirSync(p.home), ...readdirSync(p.tmp)];
    assert.deepEqual(found, [], 'no sidecar outside the DB directory, HOME and TMPDIR untouched');
  });

  it(`${c.label}: WAL DB with a holder open → the gate reads it and decides normally`, () => {
    walDetach(c.db);
    const holder = new DatabaseSync(c.db);
    let out: string;
    try {
      holder.prepare('SELECT count(*) FROM sqlite_master').get();
      assert.ok(existsSync(`${c.db}-shm`), 'setup: the holder opened the WAL');
      out = run();
    } finally {
      holder.close();
    }
    decidesNormally(out, 'a held DB');
  });

  it(`${c.label}: a DB no read can open → deny with the unavailable reason`, () => {
    walDetach(c.db);
    const dir = dirname(c.db);
    chmodSync(dir, 0o555);
    let out: string;
    try {
      out = run();
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.ok(out.includes('"permissionDecision":"deny"'), `fails closed: ${out}`);
    assert.ok(out.includes('trajectory DB unavailable'), 'deny names the unavailable DB');
  });
}
