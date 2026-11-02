/**
 * Unit tests of the no-prose-in-scratch gate (GH 2089). The gate runs in
 * process against a sandbox whose TMPDIR is the temp zone. The target standing
 * outside every zone is a path that does not exist, since the sandbox itself
 * may sit under /tmp.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTmpdir } from '../hooks/containment-guard.js';
import { findGate, gateNames } from '../hooks/registry.js';
import { noProseInScratch } from '../hooks/no-prose-in-scratch.js';
import { isProseFile } from '../prose-files.js';

const OUTSIDE_EVERY_ZONE = '/nonexistent-home/Documents';

/** os.tmpdir() is /tmp, or under it, on Linux and in a sandboxed run, the only places a test may write there. */
const CANONICAL_TMP = realpathSync('/tmp');
const SYSTEM_TMP = realpathSync(tmpdir());
const SYSTEM_TMP_IS_UNDER_TMP = SYSTEM_TMP === CANONICAL_TMP || SYSTEM_TMP.startsWith(`${CANONICAL_TMP}/`);

describe('no-prose-in-scratch', () => {
  let root: string;
  let tmp: string;
  let project: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-no-prose-')));
    tmp = join(root, 'tmp');
    project = join(root, 'project');
    repo = join(tmp, 'repo');
    mkdirSync(tmp);
    mkdirSync(project);
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    env = { PATH: process.env.PATH, HOME: OUTSIDE_EVERY_ZONE, TMPDIR: tmp };
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  async function reason(toolName: string, toolInput: Record<string, unknown>, over: NodeJS.ProcessEnv = {}): Promise<string> {
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: project, tool_name: toolName, tool_input: toolInput });
    const { stdout, code } = await noProseInScratch(payload, { ...env, ...over });
    assert.equal(code, 0);
    if (stdout === '') return '';
    const { hookSpecificOutput: out } = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(out.permissionDecision, 'deny');
    return out.permissionDecisionReason;
  }
  const write = (path: string): Promise<string> => reason('Write', { file_path: path, content: 'x' });
  const shell = (command: string): Promise<string> => reason('Bash', { command });
  const scratch = (name: string): string => join(project, '.claude/tmb/scratch', name);

  it('is a gate dist/hooks-gates.txt lists', () => {
    assert.equal(findGate('no-prose-in-scratch'), noProseInScratch);
    assert.ok(gateNames().includes('no-prose-in-scratch'));
  });

  describe('prose suffixes', () => {
    it('are md, markdown, txt and rst, in any case', () => {
      for (const name of ['a.md', 'a.markdown', 'a.txt', 'a.rst', 'A.MD', 'a.Txt']) assert.ok(isProseFile(name), name);
      for (const name of ['a.log', 'a.json', 'a.ts', 'md', 'a.md.log']) assert.equal(isProseFile(name), false, name);
    });
  });

  describe('file tools', () => {
    it('deny prose in the scratch folder and in the temp zone, for each tool', async () => {
      const inputs: [string, Record<string, unknown>][] = [
        ['Write', { file_path: scratch('plan.md') }],
        ['Edit', { file_path: scratch('plan.md') }],
        ['MultiEdit', { file_path: join(tmp, 'x.md') }],
        ['NotebookEdit', { notebook_path: join(tmp, 'x.md') }],
      ];
      for (const [tool, input] of inputs) assert.match(await reason(tool, input), /^BLOCKED: prose file/, tool);
    });

    it('deny a case-variant suffix and a relative path', async () => {
      assert.match(await write(join(tmp, 'X.MD')), /^BLOCKED/);
      assert.match(await write('.claude/tmb/scratch/plan.md'), /^BLOCKED/);
    });

    it('name every trajectory tool and send command output to a .log file', async () => {
      const text = await write(join(tmp, 'x.md'));
      for (const name of ['issue_create', 'issue_update_description', 'discussion_append', 'decision', 'analysis', 'note', 'task_update_spec', 'task_create_batch']) {
        assert.ok(text.includes(name), name);
      }
      assert.match(text, /Command output belongs in a \.log file/);
    });

    it('allow what is not prose in a zone', async () => {
      for (const name of ['q.ts', 'x.log', 'x.json']) {
        assert.equal(await write(scratch(name)), '', name);
        assert.equal(await write(join(tmp, name)), '', name);
      }
    });

    it('allow prose in a git worktree under the temp zone, a deliverable', async () => {
      assert.equal(await write(join(repo, 'README.md')), '');
      assert.equal(await write(join(repo, 'changelog.d/123.md')), '');
    });

    it('allow a deliverable in a git worktree under /tmp, canonically compared', { skip: !SYSTEM_TMP_IS_UNDER_TMP && 'os.tmpdir() is outside /tmp here' }, async () => {
      const underTmp = mkdtempSync(join(SYSTEM_TMP, 'tmb-no-prose-'));
      const onlyTmpZone = { TMPDIR: OUTSIDE_EVERY_ZONE };
      const inZone = (path: string): Promise<string> => reason('Write', { file_path: path }, onlyTmpZone);
      try {
        assert.match(await inZone(join(underTmp, 'README.md')), /^BLOCKED/);
        execFileSync('git', ['init', '-q', underTmp]);
        assert.equal(await inZone(join(underTmp, 'README.md')), '');
        assert.equal(await inZone(join(underTmp, 'changelog.d/123.md')), '');
      } finally {
        rmSync(underTmp, { recursive: true, force: true });
      }
    });

    it('allow prose outside every zone', async () => {
      assert.equal(await write(join(OUTSIDE_EVERY_ZONE, 'plan.md')), '');
    });

    it('deny the scratch folder even inside a git repo', async () => {
      assert.match(await write(join(repo, '.claude/tmb/scratch/plan.md')), /^BLOCKED/);
    });

    it('judge a target whose parent does not exist yet from its nearest existing ancestor', async () => {
      assert.match(await write(join(tmp, 'a/b/c/x.md')), /^BLOCKED/);
      assert.equal(await write(join(repo, 'a/b/c/x.md')), '');
    });
  });

  describe('Bash write targets', () => {
    it('deny prose through the effective TMPDIR and under /tmp', async () => {
      assert.match(await shell('cat > $TMPDIR/x.md <<EOF\nhi\nEOF'), /^BLOCKED: prose file/);
      assert.match(await shell('echo hi > /tmp/x.txt'), /^BLOCKED: prose file/);
      assert.match(await shell('echo hi > .claude/tmb/scratch/x.md'), /^BLOCKED: prose file/);
    });

    it('take the sandbox TMPDIR when the hook has none, as containment-guard does', () => {
      const call = (extra: Record<string, unknown> = {}): string => JSON.stringify({ tool_input: { command: 'ls', ...extra } });
      assert.equal(runTmpdir(call(), 'Bash', {}, 7, '/tmp/claude-7'), '/tmp/claude-7');
      assert.equal(runTmpdir(call(), 'Bash', { TMPDIR: tmp }, 7, '/tmp/claude-7'), tmp);
      assert.equal(runTmpdir(call({ dangerouslyDisableSandbox: true }), 'Bash', {}, 7, '/tmp/claude-7'), '');
      assert.equal(runTmpdir(call(), 'Write', {}, 7, '/tmp/claude-7'), '');
    });

    it('allow a log and prose outside every zone', async () => {
      assert.equal(await shell('echo hi > /tmp/x.log'), '');
      assert.equal(await shell(`echo hi > ${OUTSIDE_EVERY_ZONE}/plan.md`), '');
    });

    it('allow removing prose, the cleanup the gate asks for', async () => {
      assert.equal(await shell('rm /tmp/x.md'), '');
      assert.equal(await shell('rm .claude/tmb/scratch/x.md'), '');
      assert.equal(await shell('rm /tmp/x.md 2>/dev/null'), '');
    });

    it('judge each statement: an rm next to a prose write leaves the write denied', async () => {
      assert.match(await shell('rm /tmp/a.md; echo hi > /tmp/b.md'), /b\.md/);
      assert.match(await shell('rm /tmp/x.md; echo hi > /tmp/x.md'), /x\.md/);
      assert.match(await shell('rm /tmp/m.md > /tmp/n.md'), /n\.md/);
    });

    it('leave a capped command and an unparseable one to the other gates', async () => {
      assert.equal(await shell(`${'echo $('.repeat(2000)}x${')'.repeat(2000)} > /tmp/x.md`), '');
      assert.equal(await shell("echo hi > /tmp/x.md; if ( 'unterminated"), '');
    });

    it('leave an UNRESOLVED target to containment-guard', async () => {
      assert.equal(await shell('echo hi > "$(pick-a-name)"'), '');
    });
  });

  describe('gh body files', () => {
    const REASON = /--body, or with --body-file - on stdin/;

    it('allow stdin and an inline body', async () => {
      assert.equal(await shell('gh issue edit 1 --body-file - <<EOF\nhi\nEOF'), '');
      assert.equal(await shell('gh pr create --body x'), '');
      assert.equal(await shell('gh issue comment 1 --body-file=-'), '');
      assert.equal(await shell('gh issue comment 1 -F=-'), '');
    });

    it('deny each flag form with a file value, wherever the file lives', async () => {
      for (const command of [
        'gh issue edit 1 --body-file /tmp/b.md',
        'gh issue create --title t --body-file b.md',
        'gh pr comment 1 -F b.txt',
        'gh issue comment 1 -F=b.txt',
        `gh pr create --body-file ${OUTSIDE_EVERY_ZONE}/b.log`,
        'cd d && gh pr edit 1 --body-file=b',
      ]) {
        assert.match(await shell(command), REASON, command);
      }
    });

    it('leave other gh commands alone', async () => {
      assert.equal(await shell('gh api repos/x/y -F a=b'), '');
      assert.equal(await shell('gh pr review 1 --body-file b'), '');
    });
  });

  it('lifts entirely under TMB_ALLOW_PROSE_SCRATCH=1, for every tool', async () => {
    const lifted = { TMB_ALLOW_PROSE_SCRATCH: '1' };
    assert.equal(await reason('Write', { file_path: scratch('plan.md') }, lifted), '');
    assert.equal(await reason('Bash', { command: 'echo hi > /tmp/x.md' }, lifted), '');
    assert.equal(await reason('Bash', { command: 'gh issue edit 1 --body-file b.md' }, lifted), '');
  });

  it('leaves every other tool alone', async () => {
    assert.equal(await reason('Read', { file_path: join(tmp, 'x.md') }), '');
  });
});
