// L1 lint: .github/workflows/dev-build.yml keeps its l1 job (runs `tests/run-all.ts --l1-only` on push, no `needs:`), and every CONTRIBUTING.md line that names dev-build.yml mentions L1, so the docs describe both the stamp and l1 jobs (GH 2651).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'dev-build.yml');
const CONTRIBUTING = join(ROOT, 'CONTRIBUTING.md');

function jobBlock(text, name) {
  const lines = text.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l) || /^\S/.test(l));
  return rest.slice(0, end < 0 ? rest.length : end).join('\n');
}

test('dev-build.yml l1 job reruns the L1 tier on push with no needs link', () => {
  const l1 = jobBlock(readFileSync(WORKFLOW, 'utf8'), 'l1');
  assert.ok(l1, 'dev-build.yml has no l1 job');
  assert.match(l1, /^ {4}if: github\.event_name == 'push'$/m);
  assert.match(l1, /node --experimental-strip-types tests\/run-all\.ts --l1-only/);
  assert.match(l1, /^ {4}permissions:\n {6}contents: read$/m);
  assert.doesNotMatch(l1, /^ {4}needs:/m);
});

test('CONTRIBUTING.md mentions L1 wherever it names dev-build.yml', () => {
  const hits = readFileSync(CONTRIBUTING, 'utf8')
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes('dev-build.yml'));
  assert.ok(hits.length > 0, 'CONTRIBUTING.md never names dev-build.yml');
  const stale = hits.filter(({ line }) => !line.includes('L1')).map(({ n }) => `CONTRIBUTING.md:${n}`);
  assert.deepEqual(stale, [], 'these lines describe dev-build.yml without its l1 job');
});
