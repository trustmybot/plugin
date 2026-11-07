// L1 lint: destructive SQL (DROP TABLE, DELETE FROM, TRUNCATE) in schema.sql and db.ts needs a LINT-ALLOW: <reason> comment on the line above, guarding against data loss in migrations.
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESTRUCTIVE = /DROP TABLE|DELETE FROM|TRUNCATE/;
const SCAN_FILES = ['mcp/trajectory-server/src/schema.sql', 'mcp/trajectory-server/src/db.ts'];

export function unmarkedDestructive(root, files = SCAN_FILES) {
  const bad = [];
  for (const rel of files) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!DESTRUCTIVE.test(line)) return;
      if (i > 0 && lines[i - 1].includes('LINT-ALLOW:')) return;
      bad.push(`✗ ${relative(root, path)}:${i + 1} — destructive SQL without LINT-ALLOW marker\n    ${line}`);
    });
  }
  return bad;
}

test('destructive SQL without a LINT-ALLOW marker on the line above is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-destructive-sql-'));
  try {
    writeFileSync(
      join(dir, 'm.sql'),
      ['-- LINT-ALLOW: rebuild', 'DROP TABLE old;', 'CREATE TABLE t (x);', 'DELETE FROM t;', '-- LINT-ALLOW: reset', 'SELECT 1;', 'TRUNCATE t;'].join('\n'),
    );
    assert.deepEqual(unmarkedDestructive(dir, ['m.sql']), [
      '✗ m.sql:4 — destructive SQL without LINT-ALLOW marker\n    DELETE FROM t;',
      '✗ m.sql:7 — destructive SQL without LINT-ALLOW marker\n    TRUNCATE t;',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no destructive SQL without a LINT-ALLOW marker', () => {
  const bad = unmarkedDestructive(ROOT);
  assert.deepEqual(
    bad,
    [],
    `${bad.join('\n')}\n\nDestructive SQL must be opt-in via a LINT-ALLOW: <reason> comment on the previous line.\nThis guards against accidental data loss during schema migrations.`,
  );
});
