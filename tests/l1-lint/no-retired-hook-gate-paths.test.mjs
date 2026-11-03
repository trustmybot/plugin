import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = 'tests/l1-lint/no-retired-hook-gate-paths.test.mjs';
const EXCLUDES = [
  ':!changelog.d',
  ':!CHANGELOG.md',
  ':!research',
  ':!**/dist/**',
  ':!tests/fixtures',
  ':!tests/l1-lint/fixtures',
  ':!tests/l0-install/upgrade-smoke.Dockerfile',
  ':!mcp/trajectory-server/src/test/fixtures',
  `:!${SELF}`,
];
const FIX = 'cite mcp/trajectory-server/src/hooks/<gate>.ts instead';

function gitGrep(args) {
  const res = spawnSync('git', ['grep', '-n', ...args], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(res.status === 0 || res.status === 1, `git grep failed (${res.status}): ${res.stderr}`);
  return res.stdout.trim();
}

test('no retired shell gate or persona/scope-fence library path is cited', () => {
  const hits = gitGrep(['-E', 'scripts/hooks/[A-Za-z0-9_-]+\\.sh|lib/(persona|scope-fence)\\.sh', '--', '.', ...EXCLUDES]);
  assert.equal(hits, '', `${hits}\n${FIX}`);
});

test('docs and the TS sources do not cite the scripts/hooks/*.sh glob', () => {
  const hits = gitGrep(['-F', 'scripts/hooks/*.sh', '--', 'docs', 'mcp/trajectory-server/src']);
  assert.equal(hits, '', `${hits}\n${FIX}`);
});
