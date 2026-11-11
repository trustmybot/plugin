// L1 lint: TMB writes nothing under the user's home directory. Project state (trajectory DB, logs, locks, session markers, the headless shim) lives under <project>/.claude/<plugin>/; the only path outside the project is the embedding model cache, declared once as TMB_MODEL_CACHE_DIR. Scans the L5/L6 runners + their libs in tests/l5-l6/ and tests/l5-l6/lib/ and mcp/trajectory-server/src/ (TypeScript, tests excluded). A line is a violation when it writes and its target references the home directory — directly (homedir(), process.env.HOME) or through a variable assigned from one in the same file. TS writes: writeFileSync, mkdirSync, appendFileSync, cpSync, renameSync, symlinkSync, writeFile, mkdir, appendFile. TS taint also covers a `homeDir` parameter and functions that return a home-rooted path. Lines naming TMB_MODEL_CACHE_DIR are allowed; comment lines are skipped. Allowlist: tests/l1-lint/no-home-writes.allowlist — repo-relative paths of Human-run tools whose job is repairing Claude Code's own config; nothing a hook or the server runs may be listed. Every run also checks fixtures/no-home-writes/.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { files, ROOT, scan } from './lib/no-home-writes.mjs';

const FIXTURES = 'tests/l1-lint/fixtures/no-home-writes';

function countViolations(rel) {
  return readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => l.includes('VIOLATION')).length;
}

test('fixture bad.ts: every VIOLATION line is reported', () => {
  const bad = scan([`${FIXTURES}/bad.ts`]);
  const expected = countViolations(`${FIXTURES}/bad.ts`);
  assert.equal(bad.length, expected, `no-home-writes self-test: expected ${expected} violations in bad fixtures, got ${bad.length}\n${bad.join('\n')}`);
});

test('fixture good.ts: no violations', () => {
  const good = scan([`${FIXTURES}/good.ts`]);
  assert.deepEqual(good, [], `no-home-writes self-test: false positives in good fixtures:\n${good.join('\n')}`);
});

test('no writes under the home directory', () => {
  const out = scan(files());
  assert.deepEqual(out, [], `No-home-writes: FAIL — writes under the home directory (project state belongs in <project>/.claude/<plugin>/):\n${out.join('\n')}`);
});
