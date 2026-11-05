/**
 * GH 2381: the words after an unquoted $( ) or backtick are arguments of the
 * statement it sits in, so a `cd` / `pushd` there moves no later git
 * statement. The git guards still list those words as a statement, since a
 * command word like xargs runs them (fail closed, F454-1), and the
 * commit-message lint prefers a commit that is not such a tail. TS-only: the
 * bash git-guards.sh keeps the old reading.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cmdStatements, ghMutation } from '../hooks/cmd-analysis/index.js';
import { gitCommitMessage } from '../hooks/cmd-analysis/commit-message.js';

const CWD = '/x';

async function listed(cmd: string): Promise<Array<{ dir: string; stmt: string }>> {
  const r = await cmdStatements(cmd, CWD);
  assert.equal(r.ok, true, cmd);
  return r.ok ? r.statements : [];
}

describe('cmdStatements and the words after a substitution (GH 2381)', () => {
  it('a cd / pushd after a substitution moves no later git commit (GH 2381)', async () => {
    const alone = (await listed('git commit -m a')).find((s) => s.stmt === 'git commit -m a');
    assert.ok(alone);
    for (const cmd of [
      'echo $(true) cd /w/ok; git commit -m a',
      'echo `true` cd /w/ok; git commit -m a',
      'echo $(true) pushd /w/ok; git commit -m a',
      'echo $(true) cd /w/ok && git commit -m a',
    ]) {
      const commit = (await listed(cmd)).find((s) => s.stmt === 'git commit -m a');
      assert.equal(commit?.dir, alone.dir, cmd);
    }
  });

  it('a gh write run by xargs or watch after a substitution is still listed (GH 2381, F454-1)', async () => {
    for (const cmd of ['xargs $(true) gh pr merge 1', 'watch `true` gh pr merge 1']) {
      const out = await listed(cmd);
      assert.ok(out.some((s) => ghMutation(s.stmt) !== ''), cmd);
    }
  });

  it('a git push after a substitution, in its body or after it is still listed (GH 2381)', async () => {
    for (const cmd of [
      'echo $(true) git push origin main',
      'xargs `true` git push origin main',
      'echo $(true) $(git push origin main)',
      'echo $(true); git push origin main',
    ]) {
      const out = await listed(cmd);
      assert.ok(out.some((s) => s.stmt === 'git push origin main'), cmd);
    }
  });

  it('a substitution in a prefix assignment leaves the next words a command (GH 2381)', async () => {
    const out = await listed('x=$(true) cd /w/ok; git commit -m a');
    assert.ok(out.some((s) => s.stmt === 'cd /w/ok'));
    assert.equal(out.find((s) => s.stmt === 'git commit -m a')?.dir, '/w/ok');
  });
});

describe('gitCommitMessage and the words after a substitution (GH 2381)', () => {
  it('reads the real commit after an echoed one (GH 2381)', async () => {
    const m = await gitCommitMessage("echo $(true) git commit -m 'ok'; git commit -m 'bad'");
    assert.equal(m.ok && m.message, 'bad');
  });

  it('falls back to a commit run by xargs after a substitution (GH 2381)', async () => {
    const m = await gitCommitMessage("xargs $(true) git commit -m 'bad'");
    assert.equal(m.ok && m.message, 'bad');
  });

  it('keeps a commit whose prefix assignment holds a substitution (GH 2381)', async () => {
    const m = await gitCommitMessage("x=$(echo a) git commit -m 'ok'");
    assert.equal(m.ok && m.message, 'ok');
  });
});
