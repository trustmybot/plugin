/**
 * GH 2381: the git guards read the words after an unquoted $( ) or backtick
 * as arguments of the statement it sits in, not as a command of their own,
 * so a `cd` there moves no later git statement and a `git` there is no git
 * statement. TS-only: the bash git-guards.sh keeps the old reading.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cmdStatements } from '../hooks/cmd-analysis/git.js';
import { gitCommitMessage } from '../hooks/cmd-analysis/commit-message.js';

const CWD = '/x';

async function listed(cmd: string): Promise<Array<{ dir: string; stmt: string }>> {
  const r = await cmdStatements(cmd, CWD);
  assert.equal(r.ok, true, cmd);
  return r.ok ? r.statements : [];
}

describe('cmdStatements skips the words after a substitution (GH 2381)', () => {
  it('a cd / pushd after a substitution moves no later git commit (GH 2381)', async () => {
    const alone = (await listed('git commit -m a')).find((s) => s.stmt === 'git commit -m a');
    assert.ok(alone);
    for (const cmd of [
      'echo $(true) cd /w/ok; git commit -m a',
      'echo `true` cd /w/ok; git commit -m a',
      'echo $(true) pushd /w/ok; git commit -m a',
      'echo $(true) cd /w/ok && git commit -m a',
    ]) {
      const out = await listed(cmd);
      const commit = out.find((s) => s.stmt === 'git commit -m a');
      assert.equal(commit?.dir, alone.dir, cmd);
      assert.ok(!out.some((s) => /^(cd|pushd) \/w\/ok$/.test(s.stmt)), cmd);
    }
  });

  it('a git word after a substitution is no git statement, its own body and a later statement are (GH 2381)', async () => {
    const pushes = async (cmd: string) => (await listed(cmd)).filter((s) => s.stmt.startsWith('git push')).length;
    assert.equal(await pushes('echo $(true) git push origin main'), 0);
    assert.equal(await pushes('echo $(true) $(git push origin main)'), 1);
    assert.equal(await pushes('echo $(true); git push origin main'), 1);
  });

  it('a substitution in a prefix assignment leaves the next words a command (GH 2381)', async () => {
    const out = await listed('x=$(true) cd /w/ok; git commit -m a');
    assert.ok(out.some((s) => s.stmt === 'cd /w/ok'));
  });
});

describe('gitCommitMessage skips the words after a substitution (GH 2381)', () => {
  it('reads the real commit after an echoed one (GH 2381)', async () => {
    const m = await gitCommitMessage("echo $(true) git commit -m 'ok'; git commit -m 'bad'");
    assert.equal(m.ok && m.message, 'bad');
  });

  it('keeps a commit whose prefix assignment holds a substitution (GH 2381)', async () => {
    const m = await gitCommitMessage("x=$(echo a) git commit -m 'ok'");
    assert.equal(m.ok && m.message, 'ok');
  });
});
