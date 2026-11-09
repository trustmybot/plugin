// L1 lint: pr-check.yml has a job running the full `tests/run-all.ts` (no `--l1-only`) after the `./.github/actions/fetch-bge-model` composite action, release-gate's `tests` job uses the same action with no inline copy of the fetch, and CONTRIBUTING.md never tells a contributor to run the whole `tests/run-all.ts` locally (GH 2497).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const PR_CHECK = join(WORKFLOWS, 'pr-check.yml');
const RELEASE_GATE = join(WORKFLOWS, 'release-gate.yml');
const CONTRIBUTING = join(ROOT, 'CONTRIBUTING.md');
const ACTION_USE = /^ {6}- uses: \.\/\.github\/actions\/fetch-bge-model$/m;
const FULL_SWEEP = /node --experimental-strip-types tests\/run-all\.ts *$/m;
const INLINE_FETCH = /EXPECTED_SHA256=|hf-bge-small-/;

function jobBlocks(text) {
  const lines = text.split('\n');
  const jobsAt = lines.indexOf('jobs:');
  if (jobsAt < 0) return new Map();
  const blocks = new Map();
  let name = null;
  for (const line of lines.slice(jobsAt + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      name = m[1];
      blocks.set(name, []);
    } else if (name) {
      blocks.get(name).push(line);
    }
  }
  return new Map([...blocks].map(([k, v]) => [k, v.join('\n')]));
}

function fullSweepJobs(text) {
  return [...jobBlocks(text)]
    .filter(([, body]) => FULL_SWEEP.test(body) && ACTION_USE.test(body))
    .filter(([, body]) => body.search(ACTION_USE) < body.search(FULL_SWEEP))
    .map(([name]) => name);
}

function localSweepLines(text) {
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /tests\/run-all\.ts(?! --l1-only)/.test(line) && !line.includes('`suite`'))
    .map(({ n }) => n);
}

const GOOD_WORKFLOW = `name: x
jobs:
  l1:
    steps:
      - run: node --experimental-strip-types tests/run-all.ts --l1-only
  suite:
    steps:
      - uses: ./.github/actions/fetch-bge-model

      - name: sweep
        run: node --experimental-strip-types tests/run-all.ts
`;

test('fixtures: fullSweepJobs flags each violation', () => {
  assert.deepEqual(fullSweepJobs(GOOD_WORKFLOW), ['suite']);
  assert.deepEqual(fullSweepJobs(GOOD_WORKFLOW.replace(/run-all\.ts\n$/, 'run-all.ts --l1-only\n')), []);
  assert.deepEqual(fullSweepJobs(GOOD_WORKFLOW.replace('      - uses: ./.github/actions/fetch-bge-model\n', '')), []);
  const actionAfterSweep = GOOD_WORKFLOW.replace('      - uses: ./.github/actions/fetch-bge-model\n', '') + '      - uses: ./.github/actions/fetch-bge-model\n';
  assert.deepEqual(fullSweepJobs(actionAfterSweep), []);
});

test('fixtures: localSweepLines flags a local full-sweep instruction', () => {
  assert.deepEqual(localSweepLines('4. `node --experimental-strip-types tests/run-all.ts` — must be green.'), [1]);
  assert.deepEqual(localSweepLines("pr-check's `suite` job runs `tests/run-all.ts`."), []);
  assert.deepEqual(localSweepLines('Its `l1` job reruns `tests/run-all.ts --l1-only`.'), []);
});

test('pr-check.yml has a job running the full run-all.ts after fetch-bge-model', () => {
  const text = readFileSync(PR_CHECK, 'utf8');
  assert.ok(fullSweepJobs(text).length > 0, 'pr-check.yml has no job running tests/run-all.ts without --l1-only after ./.github/actions/fetch-bge-model');
  assert.doesNotMatch(text, INLINE_FETCH, 'pr-check.yml carries an inline copy of the bge-small fetch');
});

test("release-gate.yml's tests job uses fetch-bge-model with no inline copy", () => {
  const text = readFileSync(RELEASE_GATE, 'utf8');
  const tests = jobBlocks(text).get('tests');
  assert.ok(tests, 'release-gate.yml has no tests job');
  assert.match(tests, ACTION_USE);
  assert.doesNotMatch(text, INLINE_FETCH, 'release-gate.yml carries an inline copy of the bge-small fetch');
});

test('CONTRIBUTING.md never tells a contributor to run the whole run-all.ts locally', () => {
  const stale = localSweepLines(readFileSync(CONTRIBUTING, 'utf8')).map((n) => `CONTRIBUTING.md:${n}`);
  assert.deepEqual(stale, [], 'these lines name tests/run-all.ts without --l1-only or the pr-check `suite` job');
});
