// Exercise evidence identity, completeness and provenance checks without treating test fixtures as native acceptance (GH 2157).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assess, hostIdentity, permissionControl, prepare, QUESTIONS, sha256, verifyCandidate } from './acceptance.ts';
import type { Observation, Plan } from './acceptance.ts';

let root: string;
let plan: Plan;
function row(question = 'Q1'): Observation {
  return {
    question, status: 'pass', expected: 'The documented native enforcement holds.', actual: 'Raw receipts are attached for independent review.',
    input: 'Synthetic unit-test input; no native host turn was run.',
    reason: 'Harness self-test only; these files are synthetic and establish no host guarantee.', nonce: plan.nonce,
    sourceRevision: plan.sourceRevision, artifactSha256: plan.artifactSha256, subjectCommit: plan.fixture.commit,
    host: { ...plan.host }, driver: 'native-subagent', parentId: 'fixture-parent', childId: 'fixture-child',
    raw: ['parent.json', 'child.json'].map((path) => ({ path, sha256: sha256(readFileSync(join(plan.fixture.root, path))) })),
  };
}
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-native-harness-unit-')));
  const source = join(root, 'source');
  mkdirSync(source);
  execFileSync('git', ['init', '--quiet', source]);
  for (const path of [
    '.codex-plugin/plugin.json', 'adapters/codex/.mcp.json', 'hooks/codex/hooks.json',
    'mcp/trajectory-server/dist/codex.js', 'mcp/trajectory-server/dist/schema.sql', 'mcp/trajectory-server/src/codex-agent-catalog.ts',
    'adapters/codex/skills/tmb-bro/SKILL.md', 'mcp/trajectory-server/dist/parsing/parser.wasm',
  ]) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), 'fixture only\n');
  }
  symlinkSync('../schema.sql', join(source, 'mcp/trajectory-server/dist/parsing/schema-link'));
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  plan = prepare({ sourceRoot: source, output: join(root, 'run'), host: {
    surface: 'interactive-cli', binaryPath: process.execPath, binarySha256: 'fixture', version: 'fixture', frontendApp: null, frontendVersion: null, frontendBuild: null,
  } });
  for (const path of ['parent.json', 'child.json']) writeFileSync(join(plan.fixture.root, path), '{"synthetic":true}\n');
});
after(() => rmSync(root, { recursive: true, force: true }));

test('preparation preserves all six gates as not-run and creates a real linked fixture worktree', () => {
  assert.deepEqual(plan.questions.map((q) => q.id), QUESTIONS.map((q) => q.id));
  assert.ok(plan.questions.every((q) => q.status === 'not-run'));
  assert.equal(execFileSync('git', ['-C', plan.fixture.taskWorktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), plan.fixture.commit);
  assert.notEqual(plan.fixture.mainCheckout, plan.fixture.taskWorktree);
});
test('an absent or incomplete run cannot be ready for review', () => {
  assert.equal(assess(plan, []).readyForIndependentReview, false);
  assert.equal(assess(plan, [row()]).readyForIndependentReview, false);
  assert.equal(assess(plan, []).nativeAcceptance, false);
});
test('even complete self-filled observations are not a native acceptance verdict', () => {
  const result = assess(plan, QUESTIONS.map((q) => row(q.id)));
  assert.equal(result.readyForIndependentReview, true);
  assert.equal(result.nativeAcceptance, false);
});
test('reject mismatched candidate SHA, artifact, attempt nonce and commit', () => {
  for (const key of ['sourceRevision', 'artifactSha256', 'nonce', 'subjectCommit'] as const) {
    assert.throws(() => assess(plan, [{ ...row(), [key]: 'mismatched' }]), /mismatch/);
  }
});
test('CLI and Desktop versions and binaries remain separate evidence identities', () => {
  for (const patch of [{ surface: 'desktop' }, { binarySha256: 'changed' }, { version: 'changed' }, { frontendBuild: 'changed' }]) {
    assert.throws(() => assess(plan, [{ ...row(), host: { ...plan.host, ...patch } as Plan['host'] }]), /host.*mismatch/);
  }
});
test('synthetic and independent-process drivers cannot claim native pass', () => {
  for (const driver of ['synthetic', 'independent-exec'] as const) {
    assert.throws(() => assess(plan, [{ ...row(), driver }]), /cannot qualify native/);
  }
});
test('native pass requires distinct parent/child IDs and different raw evidence files', () => {
  assert.throws(() => assess(plan, [{ ...row(), childId: 'fixture-parent' }]), /distinct native/);
  assert.throws(() => assess(plan, [{ ...row(), parentId: null }]), /distinct native/);
  assert.throws(() => assess(plan, [{ ...row(), raw: [row().raw[0], row().raw[0]] }]), /incomplete/);
});
test('unknown, duplicate or missing questions and empty results do not qualify', () => {
  assert.throws(() => assess(plan, [row('Q7')]), /unknown or duplicate/);
  assert.throws(() => assess(plan, [row(), row()]), /unknown or duplicate/);
  assert.throws(() => assess({ ...plan, questions: plan.questions.slice(1) }, []), /incomplete/);
  assert.throws(() => assess(plan, [{ ...row(), actual: '' }]), /outcomes are required/);
  assert.throws(() => assess(plan, [{ ...row(), input: '' }]), /probe input/);
});
test('raw evidence cannot escape the run, follow aliases, or change after hashing', () => {
  assert.throws(() => assess(plan, [{ ...row(), raw: [{ path: '../outside.json', sha256: 'x' }] }]), /escapes/);
  symlinkSync(join(plan.fixture.root, 'parent.json'), join(plan.fixture.root, 'alias.json'));
  assert.throws(() => assess(plan, [{ ...row(), raw: [{ path: 'alias.json', sha256: 'x' }] }]), /aliases/);
  assert.throws(() => assess(plan, [{ ...row(), raw: [{ path: 'parent.json', sha256: 'changed' }] }]), /digest mismatch/);
});
test('failed and blocked native observations remain visible instead of disappearing', () => {
  const result = assess(plan, [{ ...row(), status: 'fail' }, { ...row('Q2'), status: 'blocked', raw: [] }]);
  assert.deepEqual(result.questions.slice(0, 3).map((q) => q.status), ['fail', 'blocked', 'not-run']);
  assert.equal(result.readyForIndependentReview, false);
});
test('sentinels expose writes to the disposable main-checkout control', () => {
  writeFileSync(join(plan.fixture.mainCheckout, 'native-write-control.txt'), 'negative control\n');
  const result = assess(plan, []);
  assert.equal(plan.before['main-checkout/native-write-control.txt'], null);
  assert.equal(result.after['main-checkout/native-write-control.txt'], sha256('negative control\n'));
});
test('existing attempts are never overwritten and an unrelated executable cannot identify Codex', () => {
  assert.throws(() => prepare({ sourceRoot: plan.sourceRoot, output: plan.fixture.root, host: plan.host }), /already exists/);
  assert.throws(() => hostIdentity(process.execPath, 'interactive-cli', null), /did not report a Codex CLI version/);
  assert.throws(() => hostIdentity(process.execPath, 'desktop', null), /frontend-app/);
});
test('the complete tracked candidate includes Skills and auxiliary runtime assets', () => {
  assert.ok(plan.artifactFiles['adapters/codex/skills/tmb-bro/SKILL.md']);
  assert.ok(plan.artifactFiles['mcp/trajectory-server/dist/parsing/parser.wasm']);
  assert.ok(plan.artifactFiles['mcp/trajectory-server/dist/parsing/schema-link']);
  verifyCandidate(plan);
  const path = join(plan.sourceRoot, 'adapters/codex/skills/tmb-bro/SKILL.md');
  const before = readFileSync(path);
  try {
    writeFileSync(path, 'changed skill\n');
    assert.throws(() => verifyCandidate(plan), /candidate must be clean/);
  } finally { writeFileSync(path, before); }
  verifyCandidate(plan);
});
test('an untracked runtime asset cannot be labeled as the clean candidate SHA', () => {
  const path = join(plan.sourceRoot, 'mcp/trajectory-server/dist/extra.js');
  try {
    writeFileSync(path, 'untracked runtime\n');
    assert.throws(() => verifyCandidate(plan), /candidate must be clean/);
  } finally { rmSync(path); }
});
test('permission controls report process results and preserve existing canaries on a repeated attempt', () => {
  const before = readFileSync(join(plan.fixture.mainCheckout, 'native-write-control.txt'));
  const result = permissionControl(plan);
  assert.equal(result.executionProvenance, 'unverified-process');
  assert.equal(result.nativeAcceptance, false);
  assert.deepEqual(readFileSync(join(plan.fixture.mainCheckout, 'native-write-control.txt')), before);
});
test('a read-only filesystem preserves denied canary results on stdout when report persistence fails', () => {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', `
    import { outputControl } from ${JSON.stringify(new URL('./acceptance.ts', import.meta.url).href)};
    let writes = 0;
    let emitted = false;
    outputControl(${JSON.stringify(plan)}, {
      write() {
        writes++;
        if (writes === 4 && !emitted) throw new Error('report attempted before stdout');
        throw Object.assign(new Error('injected read-only filesystem'), { code: 'EACCES' });
      },
      stdout(text) { process.stdout.write(text); emitted = true; },
    });
    if (writes !== 4) throw new Error('expected three canaries and one report attempt');
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.results.length, 3);
  assert.ok(result.results.every((entry: { actual: string; code: string }) => entry.actual === 'write-denied-or-failed' && entry.code === 'EACCES'));
  assert.equal(result.nativeAcceptance, false);
  assert.equal(result.reportPersistence.policy, 'best-effort-after-stdout');
  const warning = JSON.parse(child.stderr);
  assert.equal(warning.warning, 'control-report-not-persisted');
  assert.equal(warning.code, 'EACCES');
  assert.equal(warning.path, result.reportPersistence.path);
  assert.equal(warning.reportPersisted, false);
  assert.equal(warning.resultsAvailable, 'stdout');
});
