// L1 lint: the shipped skills/<name>/SKILL.md dirs and the builtin-skill cheatcodes seed rows in mcp/trajectory-server/src/schema.sql are the exact same set; an unseeded skill's invocations are silently dropped by the FK check, and a seed row with no dir is a dangling catalog entry.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED_ROW = /\('([^']+)',\s*'skill',\s*'builtin'/g;

export function catalogDiff(root) {
  const skillsDir = join(root, 'skills');
  const disk = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')))
        .map((e) => e.name)
    : [];
  if (disk.length === 0) return { count: 0, problems: ['  ✗ no skills/<name>/SKILL.md directories found on disk'] };
  const schema = readFileSync(join(root, 'mcp', 'trajectory-server', 'src', 'schema.sql'), 'utf8');
  const seed = new Set([...schema.matchAll(SEED_ROW)].map((m) => m[1]));
  if (seed.size === 0) return { count: disk.length, problems: ['  ✗ no builtin-skill seed rows found in schema.sql'] };
  const onDisk = new Set(disk);
  return {
    count: onDisk.size,
    problems: [
      ...[...onDisk]
        .filter((n) => !seed.has(n))
        .sort()
        .map((n) => `  ✗ skills/${n}/ ships but has no builtin-skill seed row (invocations would be silently dropped)`),
      ...[...seed]
        .filter((n) => !onDisk.has(n))
        .sort()
        .map((n) => `  ✗ builtin-skill seed row '${n}' has no skills/${n}/ dir (dangling catalog entry)`),
    ],
  };
}

test('an unseeded skill dir and a dangling seed row are both caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-skill-catalog-sync-'));
  try {
    for (const name of ['seeded', 'unseeded']) {
      mkdirSync(join(dir, 'skills', name), { recursive: true });
      writeFileSync(join(dir, 'skills', name, 'SKILL.md'), '---\n');
    }
    mkdirSync(join(dir, 'skills', 'no-skill-md'));
    mkdirSync(join(dir, 'mcp', 'trajectory-server', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'mcp', 'trajectory-server', 'src', 'schema.sql'),
      "INSERT INTO cheatcodes (name, kind, origin) VALUES\n  ('seeded', 'skill', 'builtin'),\n  ('gone',   'skill',  'builtin'),\n  ('plug', 'plugin', 'builtin');\n",
    );
    assert.deepEqual(catalogDiff(dir), {
      count: 2,
      problems: [
        '  ✗ skills/unseeded/ ships but has no builtin-skill seed row (invocations would be silently dropped)',
        "  ✗ builtin-skill seed row 'gone' has no skills/gone/ dir (dangling catalog entry)",
      ],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shipped skills match the builtin-skill seed rows', (t) => {
  const { count, problems } = catalogDiff(ROOT);
  assert.deepEqual(
    problems,
    [],
    [
      ...problems,
      '',
      '  Either add the missing skills/<name>/SKILL.md dir,',
      '  OR align the builtin-skill seed rows in mcp/trajectory-server/src/schema.sql.',
    ].join('\n'),
  );
  t.diagnostic(`✓ ${count} shipped skills match the builtin-skill seed rows`);
});
