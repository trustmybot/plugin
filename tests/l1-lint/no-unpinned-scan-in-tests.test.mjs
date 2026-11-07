// L1 lint: keeps L2 unit tests that run the scan walker off the live claude CLI, ~/.claude.json and the live trajectory DB. Every *.ts file under mcp/trajectory-server/src/test/, except the data modules under src/test/fixtures/, whose text contains `walkProject`, `scan_run` or `project_scan` must also, outside comments, call `pinScanEnv(` (src/test/helpers.ts) or assign `TRAJECTORY_DB_PATH` (`TRAJECTORY_DB_PATH: ...`, `env['TRAJECTORY_DB_PATH'] = ...`); a mention is not a pin. Every run also checks fixtures/unpinned-scan/: unpinned.test.ts and mentioned.test.ts are flagged, pinned.test.ts passes.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'unpinned-scan');
const TEST_DIR = join(ROOT, 'mcp', 'trajectory-server', 'src', 'test');
const FORKS_SCAN = /walkProject|scan_run|project_scan/;
const PINNED = /pinScanEnv\(|TRAJECTORY_DB_PATH['"]?\]?\s*(:|=[^=])/;

function tsFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(child, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(child);
  }
}

function codeOnly(text) {
  return text.split('\n').map((line) => line.replace(/^\s*(\/\*|\*).*/, '').replace(/(^|[^:])\/\/.*$/, '$1'));
}

export function unpinnedFiles(dir, excluded) {
  const files = [];
  tsFiles(dir, files);
  return files
    .filter((f) => !(excluded && f.startsWith(`${excluded}/`)))
    .filter((f) => {
      const text = readFileSync(f, 'utf8');
      return FORKS_SCAN.test(text) && !codeOnly(text).some((line) => PINNED.test(line));
    })
    .sort();
}

test('the unpinned and mention-only fixtures are caught, the pinned fixture passes', () => {
  for (const f of ['unpinned.test.ts', 'mentioned.test.ts', 'pinned.test.ts']) {
    assert.ok(existsSync(join(FIXTURES, f)), `no-unpinned-scan-in-tests self-test: fixture missing: ${f}`);
  }
  const out = unpinnedFiles(FIXTURES);
  assert.ok(out.includes(join(FIXTURES, 'unpinned.test.ts')), 'no-unpinned-scan-in-tests self-test: FAIL (unpinned fixture not caught)');
  assert.ok(out.includes(join(FIXTURES, 'mentioned.test.ts')), 'no-unpinned-scan-in-tests self-test: FAIL (mention-only fixture not caught)');
  assert.ok(!out.includes(join(FIXTURES, 'pinned.test.ts')), 'no-unpinned-scan-in-tests self-test: FAIL (pinned fixture flagged)');
});

test('scan-forking unit tests pin TRAJECTORY_DB_PATH', () => {
  assert.ok(existsSync(TEST_DIR), `no-unpinned-scan-in-tests: ${TEST_DIR} missing`);
  const out = unpinnedFiles(TEST_DIR, join(TEST_DIR, 'fixtures'));
  const lines = out.map(
    (f) =>
      `${f.slice(ROOT.length + 1)}: references walkProject/scan_run/project_scan without a pinScanEnv( call (src/test/helpers.ts) or a TRAJECTORY_DB_PATH assignment outside comments`,
  );
  assert.deepEqual(lines, [], `${lines.join('\n')}\n\nno-unpinned-scan-in-tests: FAIL`);
});
