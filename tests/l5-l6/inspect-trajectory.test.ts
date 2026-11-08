import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'inspect-trajectory.ts');
const roots: string[] = [];

after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-inspect-trajectory-'));
  roots.push(dir);
  return dir;
}

function makeDb(dir: string, channel: string, rows: Array<[number, string, string]>): string {
  mkdirSync(join(dir, '.claude', channel), { recursive: true });
  const path = join(dir, '.claude', channel, 'trajectory.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE debug_trajectory (id INTEGER PRIMARY KEY, kind TEXT, tool_or_mcp_name TEXT)');
  const insert = db.prepare('INSERT INTO debug_trajectory (id, kind, tool_or_mcp_name) VALUES (?, ?, ?)');
  for (const [id, kind, name] of rows) insert.run(id, kind, name);
  db.close();
  return path;
}

function run(dir: string) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, dir], { cwd: dir, encoding: 'utf8' });
}

const HEADER_TAIL = [
  '# Copy lines below into tests/l5-l6/expected/<flow>.txt',
  "# (Edit out any setup/teardown calls that aren't part of the flow under test.)",
  '',
];

test('prints the header, then kind:tool_or_mcp_name lines ordered by id', () => {
  const dir = project();
  const db = makeDb(dir, 'tmb', [
    [3, 'mcp', 'task_brief'],
    [1, 'tool', 'Read'],
    [2, 'tool', 'Bash'],
  ]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [`# Trajectory from ${db} (3 rows)`, ...HEADER_TAIL, 'tool:Read', 'tool:Bash', 'mcp:task_brief', ''].join('\n'));
});

test('no trajectory.db exits 1 with the not-found message', () => {
  const dir = project();
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, new RegExp(`no trajectory.db found under ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.claude/`));
});

test('a DB with no debug_trajectory rows exits 1', () => {
  const dir = project();
  makeDb(dir, 'tmb', []);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no debug_trajectory rows recorded\.\n {3}Was TMB_DEBUG_TRAJECTORY=1 set when claude ran\?/);
});

test('falls back to .claude/tmb-rc/ when .claude/tmb/ has no DB', () => {
  const dir = project();
  const db = makeDb(dir, 'tmb-rc', [[1, 'tool', 'Grep']]);
  makeDb(dir, 'other', [[1, 'tool', 'Glob']]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [`# Trajectory from ${db} (1 rows)`, ...HEADER_TAIL, 'tool:Grep', ''].join('\n'));
});
