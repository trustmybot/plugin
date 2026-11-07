// L1 lint: every it(...) block in mcp/trajectory-server/src/test/**/*.test.ts that enables issue_sync (auto|glab|gh|on) must also reference _spawnFn or makeSpawnFn, so npm test makes no real remote API calls. Each it( block is cut out by brace depth and checked on its own.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_DIR_REL = 'mcp/trajectory-server/src/test';
const ENABLES_SYNC = /config_set[\s\S]*issue_sync[\s\S]*["'](auto|glab|gh|on)["']/;
const MOCKS_SPAWN = /_spawnFn|makeSpawnFn/;

function testFiles(root, rel, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) testFiles(root, child, out);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(child);
  }
}

function lines(text) {
  const out = text.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}

export function unmockedBlocks(relpath, text) {
  const failures = [];
  let inBlock = false;
  let depth = 0;
  let blockStart = 0;
  let blockText = '';
  lines(text).forEach((line, i) => {
    if (!inBlock && /^\s*it\(/.test(line)) {
      inBlock = true;
      depth = 0;
      blockStart = i + 1;
      blockText = '';
    }
    if (!inBlock) return;
    blockText += `${line}\n`;
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          if (ENABLES_SYNC.test(blockText) && !MOCKS_SPAWN.test(blockText)) {
            failures.push(`FAIL: ${relpath}:${blockStart} — sets issue_sync active but no _spawnFn/makeSpawnFn in it() block`);
          }
          inBlock = false;
          blockText = '';
          blockStart = 0;
          depth = 0;
          break;
        }
      }
    }
  });
  return failures;
}

export function issueSyncProblems(root) {
  const files = [];
  testFiles(root, TEST_DIR_REL, files);
  return files.sort().flatMap((rel) => unmockedBlocks(rel, readFileSync(join(root, rel), 'utf8')));
}

test('an it() block enabling issue_sync without a spawn-fn is caught; a mocked one passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-issue-sync-isolation-'));
  try {
    mkdirSync(join(dir, TEST_DIR_REL, 'nested'), { recursive: true });
    writeFileSync(
      join(dir, TEST_DIR_REL, 'nested', 'sync.test.ts'),
      [
        "describe('sync', () => {",
        "  it('mocked', () => {",
        "    config_set({ key: 'issue_sync', value: 'gh' });",
        '    run({ _spawnFn: makeSpawnFn() });',
        '  });',
        "  it('live', () => {",
        '    config_set({',
        "      key: 'issue_sync', value: 'auto' });",
        '  });',
        "  it('off', () => { config_set({ key: 'issue_sync', value: 'off' }); });",
        '});',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, TEST_DIR_REL, 'other.ts'), "it('x', () => { config_set('issue_sync', 'on'); });\n");
    assert.deepEqual(issueSyncProblems(dir), [
      `FAIL: ${TEST_DIR_REL}/nested/sync.test.ts:6 — sets issue_sync active but no _spawnFn/makeSpawnFn in it() block`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all issue_sync-enabling test blocks reference spawn-fn injection', () => {
  const problems = issueSyncProblems(ROOT);
  assert.deepEqual(problems, [], problems.join('\n'));
});
