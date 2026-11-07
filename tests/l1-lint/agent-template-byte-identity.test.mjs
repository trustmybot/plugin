// L1 lint: the backbone agents (swe, code-reviewer) no longer ship as template copies, so templates/agents/{swe,code-reviewer}.md must stay absent.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKBONE = ['swe', 'code-reviewer'];

export function templateCopies(root) {
  return BACKBONE.map((name) => join(root, 'templates', 'agents', `${name}.md`)).filter((path) => existsSync(path));
}

function drift(copies) {
  return copies.map((path) => `DRIFT: ${path} must not exist — backbone agents no longer ship as template copies`).join('\n');
}

test('a re-introduced backbone template copy is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-template-byte-identity-'));
  try {
    mkdirSync(join(dir, 'templates', 'agents'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'agents', 'swe.md'), '# swe\n');
    writeFileSync(join(dir, 'templates', 'agents', 'other.md'), '# other\n');
    assert.deepEqual(templateCopies(dir), [join(dir, 'templates', 'agents', 'swe.md')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backbone template copies are absent', () => {
  const copies = templateCopies(ROOT);
  assert.deepEqual(copies, [], `${drift(copies)}\nagent-template-byte-identity: FAIL`);
});
