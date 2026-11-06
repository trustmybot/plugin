// L1 lint: the build and CI produce these outputs, so git must not track any of them (GH 2054).
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const GENERATED_PATHS = [
  'mcp/trajectory-server/dist',
  'dashboard/dist',
  'scripts/hooks/lib/audit-events.txt',
  'scripts/hooks/lib/data-contracts.json',
];

export function trackedGenerated(repo) {
  const out = execFileSync('git', ['-C', repo, 'ls-files', '-z', '--', ...GENERATED_PATHS], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function failureMessage(tracked) {
  const roots = GENERATED_PATHS.filter((p) => tracked.some((f) => f === p || f.startsWith(`${p}/`)));
  return [
    'generated outputs are tracked in git (the build and CI produce them):',
    ...tracked.map((f) => `  ${f}`),
    'fix:',
    ...roots.map((p) => `  git rm -r --cached ${p}`),
  ].join('\n');
}

test('no generated output is tracked in this repo', () => {
  const tracked = trackedGenerated(ROOT);
  assert.deepEqual(tracked, [], failureMessage(tracked));
});

test('self-test: a force-added dist file is reported', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tmb-no-tracked-generated-'));
  try {
    execFileSync('git', ['-C', repo, 'init', '-q']);
    writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    mkdirSync(join(repo, 'mcp/trajectory-server/dist'), { recursive: true });
    writeFileSync(join(repo, 'mcp/trajectory-server/dist/index.js'), 'export {};\n');
    assert.deepEqual(trackedGenerated(repo), []);
    execFileSync('git', ['-C', repo, 'add', '-f', 'mcp/trajectory-server/dist/index.js']);
    const tracked = trackedGenerated(repo);
    assert.deepEqual(tracked, ['mcp/trajectory-server/dist/index.js']);
    const message = failureMessage(tracked);
    assert.match(message, /mcp\/trajectory-server\/dist\/index\.js/);
    assert.match(message, /git rm -r --cached mcp\/trajectory-server\/dist/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
