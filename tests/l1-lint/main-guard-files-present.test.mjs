// L1 lint: .github/workflows/main-source-guard.yml and .github/CODEOWNERS are present, and the workflow's name is exactly 'main source guard'. Every run also checks a temp copy with each file removed in turn and with the workflow renamed.
import { strict as assert } from 'node:assert';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_REL = join('.github', 'workflows', 'main-source-guard.yml');
const CODEOWNERS_REL = join('.github', 'CODEOWNERS');

export function guardProblems(root) {
  const out = [];
  const wf = join(root, WORKFLOW_REL);
  if (!existsSync(wf)) out.push('MISSING: .github/workflows/main-source-guard.yml');
  else {
    const nameLine = readFileSync(wf, 'utf8').split('\n').find((l) => l.startsWith('name:')) ?? '';
    const name = nameLine.replace(/^name:\s*/, '').replace(/^['"]/, '').replace(/['"]$/, '');
    if (name !== 'main source guard') out.push(`WRONG workflow name: got "${name}", expected "main source guard"`);
  }
  if (!existsSync(join(root, CODEOWNERS_REL))) out.push('MISSING: .github/CODEOWNERS');
  return out;
}

test('a missing workflow, a missing CODEOWNERS and a wrong workflow name are caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-main-guard-files-present-'));
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    const restore = () => {
      copyFileSync(join(ROOT, WORKFLOW_REL), join(dir, WORKFLOW_REL));
      copyFileSync(join(ROOT, CODEOWNERS_REL), join(dir, CODEOWNERS_REL));
    };
    restore();
    assert.deepEqual(guardProblems(dir), [], 'self-test FAIL: both-present case should pass');

    rmSync(join(dir, WORKFLOW_REL));
    assert.deepEqual(guardProblems(dir), ['MISSING: .github/workflows/main-source-guard.yml'], 'self-test FAIL: missing workflow not detected');

    restore();
    rmSync(join(dir, CODEOWNERS_REL));
    assert.deepEqual(guardProblems(dir), ['MISSING: .github/CODEOWNERS'], 'self-test FAIL: missing CODEOWNERS not detected');

    restore();
    const renamed = readFileSync(join(ROOT, WORKFLOW_REL), 'utf8').replace(/^name:.*$/gm, 'name: wrong name');
    writeFileSync(join(dir, WORKFLOW_REL), renamed);
    assert.deepEqual(guardProblems(dir), ['WRONG workflow name: got "wrong name", expected "main source guard"'], 'self-test FAIL: wrong workflow name not detected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main-source-guard + CODEOWNERS present', () => {
  const out = guardProblems(ROOT);
  assert.deepEqual(out, [], `${out.join('\n')}\nmain-guard-files-present: FAIL`);
});
