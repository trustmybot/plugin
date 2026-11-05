// The live-DB sqlite3 shim (tests/lib/live-db-shim.mjs): the protected set on a
// checkout whose parent is a plain directory (the CI layout), a refusal for each
// argument form, and an allowed call passed through to the real sqlite3.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { liveDbShimStart, protectedDirs } from './live-db-shim.mjs';
import { tmpFootprintParent } from './tmp-footprint.mjs';

const D = mkdtempSync(`${tmpFootprintParent()}/tmb-live-db-shim.`);
const CHECKOUT = join(D, 'parent', 'checkout');
mkdirSync(join(D, 'parent'));
spawnSync('git', ['init', '-q', CHECKOUT], { cwd: D, stdio: 'ignore' });
const CHECKOUT_REAL = realpathSync(CHECKOUT);
const DB = `${CHECKOUT_REAL}/.claude/tmb/trajectory.db`;
const hasSqlite = spawnSync('sqlite3', ['-version'], { cwd: D, stdio: 'ignore' }).status === 0;

after(() => rmSync(D, { recursive: true, force: true }));

describe('protectedDirs with a plain parent directory', () => {
  it('returns without an error', () => {
    assert.doesNotThrow(() => protectedDirs(CHECKOUT));
  });

  it("lists the checkout's .claude/tmb", () => {
    assert.ok(protectedDirs(CHECKOUT).includes(`${CHECKOUT_REAL}/.claude/tmb`));
  });
});

describe('the sqlite3 shim', { skip: !hasSqlite && 'no sqlite3 on PATH' }, () => {
  const state = join(D, 'state');
  let shim;
  let savedPath;
  const savedLog = process.env.LIVE_DB_SHIM_LOG;
  const savedRefusals = process.env.LIVE_DB_SHIM_REFUSALS;

  before(() => {
    savedPath = process.env.PATH;
    liveDbShimStart(CHECKOUT, state);
    shim = join(state, 'bin', 'sqlite3');
    process.env.PATH = savedPath;
  });

  after(() => {
    for (const [k, v] of [['LIVE_DB_SHIM_LOG', savedLog], ['LIVE_DB_SHIM_REFUSALS', savedRefusals]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const call = (args, cwd = D) => spawnSync(shim, args, { cwd, encoding: 'utf8', env: { ...process.env, PWD: cwd } });

  for (const [form, args, cwd] of [
    ['an absolute path', [DB, 'select 1'], D],
    ['a file: URI', [`file:${DB}?mode=ro`, 'select 1'], D],
    ['a relative path', ['.claude/tmb/trajectory.db', 'select 1'], CHECKOUT_REAL],
    ['a quoted path in SQL', [':memory:', `ATTACH '${DB}' AS live`], D],
  ]) {
    it(`refuses ${form}`, () => {
      const r = call(args, cwd);
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`^sqlite3-shim: refused .* \\(under the real project DB dir ${CHECKOUT_REAL}/\\.claude/tmb\\)\\n$`));
      assert.ok(readFileSync(join(state, 'sqlite3-refusals.log'), 'utf8').includes(`${cwd}\t${args.join(' ')}\n`));
    });
  }

  it('passes an allowed call through with its stdout and exit code', () => {
    const ok = call([':memory:', 'select 41 + 1']);
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, '42\n');
    const bad = call([':memory:', 'select from']);
    const real = spawnSync('sqlite3', [':memory:', 'select from'], { cwd: D, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.equal(bad.status, real.status);
    assert.ok(readFileSync(join(state, 'sqlite3-calls.log'), 'utf8').includes(`${D}\t:memory: select 41 + 1\n`));
  });
});
