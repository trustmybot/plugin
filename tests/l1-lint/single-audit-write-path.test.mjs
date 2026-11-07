// L1 lint: every server-side audit row goes through insertAudit (tools/audit.ts), so src/tools/*.ts holds exactly one INSERT INTO audit, inside audit.ts.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS = join(ROOT, 'mcp', 'trajectory-server', 'src', 'tools');

export function auditInserts(dir) {
  const matches = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts')).sort()) {
    readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.includes('INSERT INTO audit')) matches.push({ file: name, line: i + 1, text: line });
      });
  }
  return matches;
}

export function singleWritePath(matches) {
  return matches.length === 1 && matches[0].file === 'audit.ts';
}

function report(matches, prefix) {
  const rows = matches.map((m) => `${prefix}${m.file}:${m.line}:${m.text}`).join('\n');
  return `  ✗ expected exactly 1 INSERT INTO audit in src/tools/ (inside insertAudit in audit.ts), found ${matches.length}:\n${rows}\n\nSingle-audit-write-path: FAIL — route audit writes through insertAudit()`;
}

test('a second raw INSERT INTO audit outside audit.ts is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'single-audit-write-path-'));
  try {
    writeFileSync(join(dir, 'audit.ts'), 'db.prepare(`INSERT INTO audit (x) VALUES (?)`);\n');
    assert.equal(singleWritePath(auditInserts(dir)), true);
    writeFileSync(join(dir, 'rogue.ts'), 'const a = 1;\ndb.exec("INSERT INTO audit (x) VALUES (1)");\n');
    const matches = auditInserts(dir);
    assert.equal(singleWritePath(matches), false);
    assert.deepEqual(
      matches.map((m) => `${m.file}:${m.line}`),
      ['audit.ts:1', 'rogue.ts:2'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exactly one INSERT INTO audit in src/tools/ (insertAudit)', () => {
  const matches = auditInserts(TOOLS);
  assert.ok(singleWritePath(matches), report(matches, 'mcp/trajectory-server/src/tools/'));
});
