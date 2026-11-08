// L1 lint: no shipped prompt names this repository's own paths or scripts (mcp/trajectory-server, scripts/hooks/, scripts/maintenance/, changelog.d, tests/l<N>, regen-generated, dist-fresh, docs/architecture). TMB is general purpose, so such a prompt describes the user's project with this repo's layout. Lines naming product internals every install has (CLAUDE_PLUGIN_ROOT, .claude/tmb/, the plugin cache) pass. Scans the *.md files directly in agents/, commands/ and templates/agents/ and every *.md under skills/. Every run also checks fixtures/repo-paths-in-prompts/: has-paths.md yields at least six findings, allowlisted.md none.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findingsInText, repoPathProblems } from './lib/no-repo-paths-in-prompts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'repo-paths-in-prompts');

test('has-paths.md yields at least six findings and allowlisted.md none', () => {
  const bad = join(FIXTURES, 'has-paths.md');
  const ok = join(FIXTURES, 'allowlisted.md');
  for (const f of [bad, ok]) assert.ok(existsSync(f), `no-repo-paths-in-prompts self-test: fixture missing: ${f}`);
  const found = findingsInText(readFileSync(bad, 'utf8')).length;
  const clean = findingsInText(readFileSync(ok, 'utf8')).length;
  assert.ok(found >= 6 && clean === 0, `no-repo-paths-in-prompts self-test: FAIL (has-paths.md ${found} finding(s), allowlisted.md ${clean})`);
});

test('repository paths in each scanned prompt location are caught, allowlisted lines pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-no-repo-paths-'));
  try {
    for (const d of ['agents/sub', 'commands', 'templates/agents', 'skills/a/b', 'docs']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'agents', 'swe.md'), 'fine\nEdit scripts/hooks/gate.sh.\n');
    writeFileSync(join(dir, 'agents', 'sub', 'deep.md'), 'docs/architecture\n');
    writeFileSync(join(dir, 'commands', 'go.md'), 'Run ${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/index.js\n');
    writeFileSync(join(dir, 'templates', 'agents', 'cto.md'), 'Add a changelog.d fragment\n');
    writeFileSync(join(dir, 'skills', 'a', 'b', 'notes.md'), 'x\nbash tests/l1-lint/x.sh\n');
    writeFileSync(join(dir, 'docs', 'x.md'), 'mcp/trajectory-server\n');
    assert.deepEqual(repoPathProblems(dir), [
      'agents/swe.md:2: repository path in prompt',
      'templates/agents/cto.md:1: repository path in prompt',
      'skills/a/b/notes.md:2: repository path in prompt',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no repository paths in prompts', () => {
  const problems = repoPathProblems(ROOT);
  assert.deepEqual(problems, [], `${problems.join('\n')}\n\nno-repo-paths-in-prompts: FAIL`);
});
