/**
 * The git statement listing follows a loop-body cd (GH 2065): a statement in
 * a loop body is listed in every dir an iteration can start it in, as the
 * write-path side already frames loops, so git-guards judges each dir.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdStatements } from '../hooks/cmd-analysis/index.js';
import { gitPushGuard } from '../hooks/git-push-guard.js';

const pushDirs = async (cmd: string): Promise<string[]> => {
  const listed = await cmdStatements(cmd, '/w', {});
  assert.ok(listed.ok, cmd);
  return listed.statements.filter(({ stmt }) => stmt === 'git push origin dev').map(({ dir }) => dir);
};

describe('git statement listing follows a loop-body cd (GH 2065)', () => {
  it('while: the push runs in the entry dir and in the dir the body cds to', async () => {
    assert.deepEqual(await pushDirs('cd /tmp; while :; do git push origin dev; cd /etc; done'), ['/tmp', '/etc']);
  });

  it('for and until', async () => {
    assert.deepEqual(await pushDirs('cd /tmp; for x in a b; do git push origin dev; cd /etc; done'), ['/tmp', '/etc']);
    assert.deepEqual(await pushDirs('cd /tmp; until false; do git push origin dev; cd /etc; done'), ['/tmp', '/etc']);
  });

  it('a nested loop adds the dirs both back-edges bring the push to', async () => {
    const dirs = await pushDirs('cd /tmp; while :; do for x in a; do git push origin dev; cd /etc; done; cd /usr; done');
    assert.deepEqual([...dirs].sort(), ['/etc', '/tmp', '/usr']);
  });

  it('a statement after the loop runs in the entry dir or any dir a pass ends in', async () => {
    assert.deepEqual(await pushDirs('cd /tmp; while false; do cd /etc; done; git push origin dev'), ['/tmp', '/etc']);
  });

  it('a bash -c body in the loop inherits every dir', async () => {
    assert.deepEqual(await pushDirs("cd /tmp; while :; do bash -c 'git push origin dev'; cd /etc; done"), ['/tmp', '/etc']);
  });

  it('git -C in a loop body resolves against every dir', async () => {
    const listed = await cmdStatements('cd /tmp; while :; do git -C a push origin dev; cd /etc; done', '/w', {});
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.statements.filter(({ stmt }) => stmt.startsWith('git -C')).map(({ dir }) => dir),
      ['/tmp/a', '/etc/a'],
    );
  });

  it('a relative cd that keeps drifting fails closed with an unresolved dir', async () => {
    assert.ok((await pushDirs('cd /tmp; while :; do git push origin dev; cd sub; done')).includes('-'));
  });

  it('git-push-guard judges the push in the dir a later pass cds to', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2065-')));
    try {
      const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: join(dir, 'none.db') };
      const run = async (command: string) => (await gitPushGuard(JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command } }), env)).stdout;
      assert.equal(await run(`cd ${dir}; git push origin dev; cd ${dir}/.claude/worktrees/t`), '');
      assert.match(await run(`cd ${dir}; while :; do git push origin dev; cd ${dir}/.claude/worktrees/t; done`), /push from \.claude\/worktrees\/ is forbidden/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists no loop frame records', async () => {
    const listed = await cmdStatements('cd /tmp; while :; do git push origin dev; cd /etc; done', '/w', {});
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.statements.map(({ stmt }) => stmt),
      ['cd /tmp', ':', ':', 'git push origin dev', 'git push origin dev', 'cd /etc', 'cd /etc'],
    );
  });
});
