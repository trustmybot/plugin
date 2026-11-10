// L1 lint: no pr-check.yml job runs `tests/run-all.ts` without `--l1-only`, since the full L1-L4 sweep runs only at the rc release gate (GH 2805); pr-check.yml runs on merge_group with a concurrency group that falls back to github.ref (GH 2820); release-gate's `tests` job uses the `./.github/actions/fetch-bge-model` composite action with no inline copy of the fetch, and CONTRIBUTING.md never tells a contributor to run the whole `tests/run-all.ts` locally (GH 2497).
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
const FULL_SWEEP = /tests\/run-all\.ts(?!\s+--l1-only)/;
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
  return [...jobBlocks(text)].filter(([, body]) => FULL_SWEEP.test(body)).map(([name]) => name);
}

function localSweepLines(text) {
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => FULL_SWEEP.test(line))
    .map(({ n }) => n);
}

const L1_ONLY_WORKFLOW = `name: x
jobs:
  l1:
    steps:
      - run: node --experimental-strip-types tests/run-all.ts --l1-only
  dashboard:
    steps:
      - run: node --test dashboard/test/*.test.mjs
`;

const SUITE_JOB = `  suite:
    steps:
      - uses: ./.github/actions/fetch-bge-model

      - name: sweep
        run: node --experimental-strip-types tests/run-all.ts
`;

test('fixtures: fullSweepJobs flags each job running the full run-all.ts', () => {
  assert.deepEqual(fullSweepJobs(L1_ONLY_WORKFLOW), []);
  assert.deepEqual(fullSweepJobs(L1_ONLY_WORKFLOW + SUITE_JOB), ['suite']);
  assert.deepEqual(fullSweepJobs(L1_ONLY_WORKFLOW + SUITE_JOB.replace('      - uses: ./.github/actions/fetch-bge-model\n', '')), ['suite']);
  assert.deepEqual(fullSweepJobs(L1_ONLY_WORKFLOW + SUITE_JOB.replace('run-all.ts\n', 'run-all.ts --skip-l4\n')), ['suite']);
  assert.deepEqual(fullSweepJobs(L1_ONLY_WORKFLOW.replace('run-all.ts --l1-only', 'run-all.ts')), ['l1']);
  assert.deepEqual(fullSweepJobs(L1_ONLY_WORKFLOW + SUITE_JOB.replace('run-all.ts\n', 'run-all.ts --l1-only\n')), []);
});

test('fixtures: localSweepLines flags a local full-sweep instruction', () => {
  assert.deepEqual(localSweepLines('4. `node --experimental-strip-types tests/run-all.ts` — must be green.'), [1]);
  assert.deepEqual(localSweepLines("pr-check's `suite` job runs `tests/run-all.ts`."), [1]);
  assert.deepEqual(localSweepLines('Its `l1` job reruns `tests/run-all.ts --l1-only`.'), []);
});

test('pr-check.yml has no job running tests/run-all.ts without --l1-only', () => {
  const text = readFileSync(PR_CHECK, 'utf8');
  assert.ok(jobBlocks(text).size > 0, 'pr-check.yml has no jobs');
  assert.deepEqual(fullSweepJobs(text), [], 'these pr-check.yml jobs run the full L1-L4 sweep, which runs only at the rc release gate');
});

test('pr-check.yml runs on merge_group with a concurrency group that falls back to github.ref', () => {
  const text = readFileSync(PR_CHECK, 'utf8');
  const on = /^on:\n((?: .*\n|\n)*)/m.exec(text)?.[1] ?? '';
  assert.match(on, /^ {2}pull_request:\n {4}branches: \[dev, rc, main\]$/m);
  assert.match(on, /^ {2}merge_group:\n {4}types: \[checks_requested\]$/m, 'pr-check.yml must run on merge_group checks_requested for the dev merge queue');
  assert.match(text, /^ {2}group: pr-check-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}$/m, 'merge_group runs have no PR number, so the concurrency group needs the github.ref fallback');
  assert.equal(text.match(/github\.event\.pull_request\b/g)?.length, 1, 'only the concurrency key may read github.event.pull_request');
  for (const [name, body] of jobBlocks(text)) assert.doesNotMatch(body, /^ {4}if:/m, `job ${name} must not be skipped on merge_group`);
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
  assert.deepEqual(stale, [], 'these lines name tests/run-all.ts without --l1-only');
});
