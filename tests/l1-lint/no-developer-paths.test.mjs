// L1 lint: no hardcoded developer-machine path (/Users/<name>/, /home/<name>/, /Volumes/, C:\Users\<name>) in public-facing artifacts: README.md, CONTRIBUTING.md, CLAUDE.md, SECURITY.md, docs/, agents/, skills/, commands/, templates/. Exempt: tests/l1-lint/fixtures/, tests/l5-l6/fixtures/, templates/docs-trustmybot/snapshots/, CHANGELOG.md; binary files are skipped. Every run also checks fixtures/developer-paths/has-personal-path.md is caught.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'developer-paths', 'has-personal-path.md');
const DEV_PATH = /\/Users\/[A-Za-z][A-Za-z0-9_-]*\/|\/home\/[a-z][a-z0-9_-]*\/|\/Volumes\/[A-Za-z]|C:\\Users\\[A-Za-z]/;
const ALLOWLIST = ['tests/l1-lint/fixtures/', 'tests/l5-l6/fixtures/', 'templates/docs-trustmybot/snapshots/', 'CHANGELOG.md'];
const SCAN_TARGETS = ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'SECURITY.md', 'docs', 'agents', 'skills', 'commands', 'templates'];

function files(abs, out) {
  if (statSync(abs).isDirectory()) {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) files(child, out);
      else if (entry.isFile()) out.push(child);
    }
  } else out.push(abs);
}

export function matchingLines(file) {
  const buf = readFileSync(file);
  if (buf.includes(0)) return [];
  const lines = buf.toString('utf8').split('\n');
  return lines.flatMap((line, i) => (DEV_PATH.test(line) ? [i + 1] : []));
}

test('the personal-path fixture is caught', () => {
  assert.ok(existsSync(FIXTURE), `no-developer-paths self-test: fixture missing: ${FIXTURE}`);
  assert.ok(matchingLines(FIXTURE).length > 0, 'no-developer-paths self-test: FAIL (fixture not caught)');
  for (const p of ['/home/jane/x', '/Volumes/Data', 'C:\\Users\\jane']) assert.ok(DEV_PATH.test(p), p);
  assert.ok(!DEV_PATH.test('/Users/<name>/ and ~/projects'));
});

test('no developer paths in public-facing artifacts', () => {
  const all = [];
  for (const target of SCAN_TARGETS) {
    const abs = join(ROOT, target);
    if (existsSync(abs)) files(abs, all);
  }
  const out = all
    .map((f) => f.slice(ROOT.length + 1))
    .filter((rel) => !ALLOWLIST.some((p) => rel.startsWith(p)))
    .flatMap((rel) => matchingLines(join(ROOT, rel)).map((n) => `${rel}:${n}: hardcoded developer path`));
  assert.deepEqual(out, [], `${out.join('\n')}\n\nno-developer-paths: FAIL`);
});
