// L1 lint: the generated part of docs/architecture/ERD.md (between the erd:generated markers) and its `schema_version = N` token match src/schema.sql, src/schema-eval.sql and TARGET_SCHEMA_VERSION in src/db.ts.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEN = join(ROOT, 'scripts', 'maintenance', 'gen-erd-doc.mjs');
const DOC = join('docs', 'architecture', 'ERD.md');

export function checkErd(args = []) {
  try {
    execFileSync(process.execPath, [GEN, '--check', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stderr: '' };
  } catch (err) {
    return { ok: false, stderr: err.stderr ?? '' };
  }
}

function checkStaged(edit) {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-erd-doc-fresh-'));
  try {
    mkdirSync(join(dir, 'docs', 'architecture'), { recursive: true });
    const doc = readFileSync(join(ROOT, DOC), 'utf8');
    const staged = edit(doc);
    assert.notEqual(staged, doc);
    writeFileSync(join(dir, DOC), staged);
    return checkErd(['--root', dir]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('self-test: an ERD missing a generated index row fails naming ERD.md', () => {
  const result = checkStaged((doc) =>
    doc
      .split('\n')
      .filter((line) => !line.startsWith('| `idx_tasks_status` |'))
      .join('\n'),
  );
  assert.equal(result.ok, false, 'self-test: an ERD missing a generated index row should fail naming ERD.md');
  assert.match(result.stderr, /docs\/architecture\/ERD\.md/);
});

test('self-test: an ERD with a stale schema_version fails naming ERD.md', () => {
  const result = checkStaged((doc) => doc.replace(/`schema_version = [0-9]*`/, '`schema_version = 1`'));
  assert.equal(result.ok, false, 'self-test: an ERD with a stale schema_version should fail naming ERD.md');
  assert.match(result.stderr, /docs\/architecture\/ERD\.md/);
});

test('ERD.md generated section matches schema.sql, schema-eval.sql and TARGET_SCHEMA_VERSION', () => {
  const result = checkErd();
  assert.ok(result.ok, `${result.stderr}\n  To fix: node scripts/maintenance/gen-erd-doc.mjs\nErd-doc-fresh: FAIL`);
});
