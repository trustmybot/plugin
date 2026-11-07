// L1 lint: the audit.event_type table in docs/contributing/ENUMS.md and scripts/hooks/lib/audit-events.txt match mcp/trajectory-server/src/audit-events.ts, read through its compiled dist/ (build the server first).
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEN = join(ROOT, 'scripts', 'maintenance', 'gen-enums-doc.mjs');
const DOC = join('docs', 'contributing', 'ENUMS.md');
const TXT = join('scripts', 'hooks', 'lib', 'audit-events.txt');

export function checkEnums(args = []) {
  try {
    execFileSync(process.execPath, [GEN, '--check', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stderr: '' };
  } catch (err) {
    return { ok: false, stderr: err.stderr ?? '' };
  }
}

function dropLines(text, re) {
  const dropped = text
    .split('\n')
    .filter((line) => !re.test(line))
    .join('\n');
  assert.notEqual(dropped, text);
  return dropped;
}

function checkStaged(stale) {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-enums-doc-fresh-'));
  try {
    for (const rel of [DOC, TXT]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      const text = readFileSync(join(ROOT, rel), 'utf8');
      writeFileSync(join(dir, rel), rel === stale.rel ? dropLines(text, stale.re) : text);
    }
    return checkEnums(['--root', dir]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('self-test: a doc missing a generated row fails naming ENUMS.md', () => {
  const result = checkStaged({ rel: DOC, re: /^\| `planning_complete` \|/ });
  assert.equal(result.ok, false, 'self-test: a doc missing a generated row should fail naming ENUMS.md');
  assert.match(result.stderr, /docs\/contributing\/ENUMS\.md/);
});

test('self-test: a txt missing an event fails naming audit-events.txt', () => {
  const result = checkStaged({ rel: TXT, re: /^planning_complete\s/ });
  assert.equal(result.ok, false, 'self-test: a txt missing an event should fail naming audit-events.txt');
  assert.match(result.stderr, /audit-events\.txt/);
});

test('ENUMS.md audit.event_type table and scripts/hooks/lib/audit-events.txt match audit-events.ts', () => {
  const result = checkEnums();
  assert.ok(
    result.ok,
    `${result.stderr}\n  To fix: cd mcp/trajectory-server && npm run build && cd - && node scripts/maintenance/gen-enums-doc.mjs\nEnums-doc-fresh: FAIL`,
  );
});
