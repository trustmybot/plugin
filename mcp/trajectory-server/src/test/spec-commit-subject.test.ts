/**
 * specCommitProblem (GH 2667): a spec's `## Commit` subject must pass the
 * commit-msg-lint rule when the spec is written.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { specCommitProblem } from '../success-criteria.js';

const BASE = ['## Description', 'do it', '', '## Success Criteria', '- SC1: works'].join('\n');
const VALID = '⚡ improvement(tools): check a spec commit subject';

const spec = (...commit: string[]) => [BASE, '', '## Commit', '', ...commit].join('\n');
const ofLength = (n: number) => {
  const head = '⚡ improvement(tools): ';
  return head + 'x'.repeat(n - [...head].length);
};

describe('specCommitProblem (GH 2667)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TMB_SKIP_COMMIT_MSG_LINT;
    delete process.env.TMB_SKIP_COMMIT_MSG_LINT;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TMB_SKIP_COMMIT_MSG_LINT;
    else process.env.TMB_SKIP_COMMIT_MSG_LINT = saved;
  });

  it('returns null for a valid subject, a missing section and an empty section', () => {
    assert.equal(specCommitProblem(spec(VALID)), null);
    assert.equal(specCommitProblem(BASE), null);
    assert.equal(specCommitProblem(spec('')), null);
    assert.equal(specCommitProblem(`${spec('')}\n## Out of Scope\n- nothing`), null);
  });

  it('returns null under TMB_SKIP_COMMIT_MSG_LINT=1', () => {
    process.env.TMB_SKIP_COMMIT_MSG_LINT = '1';
    assert.equal(specCommitProblem(spec('no emoji here')), null);
  });

  it('admits 72 code points and refuses 73 with commit_subject_invalid', () => {
    assert.equal([...ofLength(72)].length, 72);
    assert.equal(specCommitProblem(spec(ofLength(72))), null);
    const problem = specCommitProblem(spec(ofLength(73)));
    assert.ok(problem);
    assert.ok(
      problem.startsWith(`commit_subject_invalid: ## Commit subject "${ofLength(73)}" — commit subject breaks the length rule: it is 73 chars (>72). `),
      problem,
    );
    assert.ok(problem.endsWith(`Write the subject the swe will commit, in '<emoji> <type>(<scope>): <msg>' within 72 code points.`), problem);
  });

  it('refuses a subject without an emoji or with an unknown type', () => {
    assert.match(specCommitProblem(spec('improvement(tools): no emoji'))!, /^commit_subject_invalid: .*grammar rule/);
    assert.match(specCommitProblem(spec('⚡ tweak(tools): unknown type'))!, /^commit_subject_invalid: .*grammar rule/);
  });

  it('reads the subject from inside a fenced block and from a backtick-wrapped line', () => {
    assert.equal(specCommitProblem(spec('```', VALID, '```')), null);
    assert.equal(specCommitProblem(spec('```text', '', VALID, '```')), null);
    assert.match(specCommitProblem(spec('```', 'no emoji', '```'))!, /^commit_subject_invalid: ## Commit subject "no emoji"/);
    assert.equal(specCommitProblem(spec(`\`${VALID}\``)), null);
    assert.match(specCommitProblem(spec('`no emoji`'))!, /^commit_subject_invalid: ## Commit subject "no emoji"/);
  });

  it('ignores a ## Commit heading inside a code fence elsewhere in the spec', () => {
    const fenced = [BASE, '', '```markdown', '## Commit', '', 'no emoji', '```'].join('\n');
    assert.equal(specCommitProblem(fenced), null);
    assert.equal(specCommitProblem(`${fenced}\n\n## Commit\n\n${VALID}`), null);
    assert.match(specCommitProblem(`${fenced}\n\n## Commit\n\nbad subject`)!, /"bad subject"/);
  });
});
