// L1 lint: no live reference to file_registry / file-registry.ts in code, prompts or docs; the table was retired in schema v7 (GH 1680), so a hit is drift back toward the pre-world-model design. CLAUDE.md is Human-owned and only warns.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PATTERN = /file_registry|file-registry\.ts/;
const EXTENSIONS = /\.(ts|js|sh|mjs|md|json|sql)$/;
const TARGETS = [
  'agents',
  'skills',
  'commands',
  'hooks',
  'scripts',
  'mcp/trajectory-server/src',
  'docs',
  'CLAUDE.md',
  'mcp/trajectory-server/README.md',
  'tests',
];
const EXEMPT = new Set([
  'docs/architecture/WORLD_MODEL.md',
  'mcp/trajectory-server/src/db.ts',
  'mcp/trajectory-server/src/test/schema.test.ts',
  'mcp/trajectory-server/src/test/schema-upgrade.test.ts',
  'tests/l1-lint/no-file-registry-refs.test.mjs',
  'tests/run-all.ts',
  'tests/EVALUATION.md',
  'tests/l3-integration/mcp/search-tools.test.mjs',
]);
const WARN_ONLY = 'CLAUDE.md';

function walk(root, rel, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) {
    out.push(rel);
    return;
  }
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
}

export function fileRegistryRefs(root) {
  const files = [];
  for (const target of TARGETS) walk(root, target, files);
  const hits = [...new Set(files)]
    .filter((f) => EXTENSIONS.test(f) && PATTERN.test(readFileSync(join(root, f), 'utf8')))
    .sort();
  return {
    failures: hits.filter((f) => !EXEMPT.has(f) && f !== WARN_ONLY),
    warnings: hits.includes(WARN_ONLY) ? [WARN_ONLY] : [],
  };
}

function failureMessage(failures) {
  return [
    ...failures.map((f) => `no-file-registry-refs: ${f} contains file_registry / file-registry reference`),
    '',
    'no-file-registry-refs: FAIL — file_registry was retired in v7. Use world_model_get / world_model_search (wm_ tables in the trajectory DB) or scan_run.',
  ].join('\n');
}

test('a file_registry reference outside the exemptions is caught, CLAUDE.md only warns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-no-file-registry-refs-'));
  try {
    mkdirSync(join(dir, 'skills', 'x'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'architecture'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'x', 'SKILL.md'), 'Call file_registry_search first.\n');
    writeFileSync(join(dir, 'skills', 'x', 'notes.txt'), 'file_registry\n');
    writeFileSync(join(dir, 'docs', 'architecture', 'WORLD_MODEL.md'), 'What was replaced: file_registry\n');
    writeFileSync(join(dir, 'CLAUDE.md'), 'file_registry\n');
    const refs = fileRegistryRefs(dir);
    assert.deepEqual(refs, { failures: ['skills/x/SKILL.md'], warnings: ['CLAUDE.md'] });
    assert.match(failureMessage(refs.failures), /skills\/x\/SKILL\.md contains file_registry \/ file-registry reference/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no file_registry references remain (v7 retirement)', (t) => {
  const { failures, warnings } = fileRegistryRefs(ROOT);
  for (const w of warnings) {
    t.diagnostic(`no-file-registry-refs: WARN — ${w} still references file_registry. Human-owned file; propose changes in chat.`);
  }
  assert.deepEqual(failures, [], failureMessage(failures));
});
