// L1 lint: no hardcoded developer-machine path (/Users/<name>/, /home/<name>/, /Volumes/, C:\Users\<name>) in public-facing artifacts: README.md, CONTRIBUTING.md, CLAUDE.md, SECURITY.md, docs/, agents/, skills/, commands/, templates/. Exempt: tests/l1-lint/fixtures/, tests/l5-l6/fixtures/, templates/docs-trustmybot/snapshots/, CHANGELOG.md; binary files are skipped. Every run also checks fixtures/developer-paths/has-personal-path.md is caught.
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEV_PATH, files, matchingLines, message } from './lib/no-developer-paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'developer-paths', 'has-personal-path.md');

test('the personal-path fixture is caught', () => {
  assert.ok(existsSync(FIXTURE), `no-developer-paths self-test: fixture missing: ${FIXTURE}`);
  assert.ok(matchingLines(FIXTURE).length > 0, 'no-developer-paths self-test: FAIL (fixture not caught)');
  for (const p of ['/home/jane/x', '/Volumes/Data', 'C:\\Users\\jane']) assert.ok(DEV_PATH.test(p), p);
  assert.ok(!DEV_PATH.test('/Users/<name>/ and ~/projects'));
});

test('no developer paths in public-facing artifacts', () => {
  const out = files(ROOT).flatMap((rel) => matchingLines(join(ROOT, rel)).map((n) => message(rel, n)));
  assert.deepEqual(out, [], `${out.join('\n')}\n\nno-developer-paths: FAIL`);
});
