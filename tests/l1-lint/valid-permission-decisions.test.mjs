// L1 lint: TypeScript gates (mcp/trajectory-server/src/hooks/**/*.ts) emit permissionDecision allow|deny|ask only; CC schema-rejects others (e.g. legacy "block") and the gate then fails open.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS_SRC = 'mcp/trajectory-server/src/hooks';
const INVALID = /permissionDecision[^a-zA-Z]+(block|reject|forbid)/;

function tsFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(path);
    return e.isFile() && e.name.endsWith('.ts') ? [path] : [];
  });
}

export function invalidDecisions(root, hooksSrc = HOOKS_SRC) {
  const sources = tsFiles(join(root, hooksSrc)).sort();
  const bad = [];
  for (const file of sources) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (INVALID.test(line)) bad.push(`valid-permission-decisions: ${relative(root, file)}:${i + 1} uses an invalid permissionDecision value`);
      });
  }
  return { sources: sources.length, bad };
}

test('a gate emitting permissionDecision "block" is caught, allow/deny/ask pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'valid-permission-decisions-'));
  try {
    mkdirSync(join(dir, HOOKS_SRC, 'nested'), { recursive: true });
    writeFileSync(join(dir, HOOKS_SRC, 'ok.ts'), "out({ permissionDecision: 'deny' });\nout({ permissionDecision: 'ask' });\n");
    writeFileSync(join(dir, HOOKS_SRC, 'nested', 'bad.ts'), "const a = 1;\nout({ permissionDecision: 'block' });\n");
    const { bad } = invalidDecisions(dir);
    assert.deepEqual(bad, [`valid-permission-decisions: ${HOOKS_SRC}/nested/bad.ts:2 uses an invalid permissionDecision value`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every TypeScript gate uses a valid permissionDecision value', () => {
  const { sources, bad } = invalidDecisions(ROOT);
  assert.ok(sources > 0, `valid-permission-decisions: FAIL (no gate sources under ${HOOKS_SRC})`);
  assert.deepEqual(bad, [], `${bad.join('\n')}\nvalid-permission-decisions: FAIL (${bad.length})`);
});
