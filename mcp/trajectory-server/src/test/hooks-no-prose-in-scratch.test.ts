/**
 * Unit tests of the no-prose-in-scratch gate (GH 2089). The gate runs in
 * process against a sandbox whose TMPDIR is the temp zone. The target standing
 * outside every zone is a path that does not exist, since the sandbox itself
 * may sit under /tmp.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTmpdir } from '../hooks/containment-guard.js';
import { findGate, gateNames } from '../hooks/registry.js';
import { joinContinuations, noProseInScratch } from '../hooks/no-prose-in-scratch.js';
import { isProseFile } from '../prose-files.js';
import { PLUGIN_ROOT } from './router-sandboxes.js';

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

    it('route bro to the trajectory DB, swe and code-reviewer to the final report, command output to a .log file', async () => {
      const text = await write(join(tmp, 'x.md'));
      assert.ok(
        text.includes(
          'bro records prose in the trajectory DB (issue_create, issue_update_description, discussion_append, task_update_spec). swe or code-reviewer: put the text in your final report instead.',
        ),
        text,
      );
      assert.match(text, /Allowed form: bro: one of those trajectory DB calls; swe or code-reviewer: the final report; for command output, the same write to a \.log file$/);
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
      assert.match(await shell('rm /tmp/m.md; printf x > /tmp/m.md'), /m\.md/);
      assert.equal(await shell('rm /tmp/m.md > /tmp/n.md'), '', 'rm output captured in a prose file (GH 2405)');
    });

    it('leave a capped command and an unparseable one to the other gates', async () => {
      assert.equal(await shell(`${'echo $('.repeat(2000)}x${')'.repeat(2000)} > /tmp/x.md`), '');
      assert.equal(await shell("echo hi > /tmp/x.md; if ( 'unterminated"), '');
    });

    it('allow removing a quoted path that holds a blank or an operator (F345-5)', async () => {
      assert.equal(await shell('rm "/tmp/a b.md"'), '');
      assert.equal(await shell('cd /tmp; rm "a b.md"'), '');
      assert.equal(await shell('rm ".claude/tmb/scratch/a b.md"'), '');
      assert.equal(await shell('rm "/tmp/a;b.md"'), '');
      assert.equal(await shell('rm \\\n  /tmp/x.md'), '');
    });

    it('still deny the write beside a flattened rm: each rm takes one target (F345-5)', async () => {
      assert.match(await shell('rm "/tmp/a b.md"; echo hi > /tmp/a_b.md'), /^BLOCKED: prose file/);
      assert.match(await shell('rm /tmp/a_b.md; echo hi > "/tmp/a b.md"'), /^BLOCKED: prose file/);
      assert.match(await shell('rm "/tmp/a b.md"; echo hi > "/tmp/a b.md"'), /^BLOCKED: prose file/);
    });

    it('read a target past a line continuation (F345-2)', async () => {
      assert.match(await shell('cp a \\\n  /tmp/x.md'), /^BLOCKED: prose file.*x\.md/);
      assert.match(await shell('tee \\\n  /tmp/x.md'), /^BLOCKED: prose file.*x\.md/);
      assert.equal(await shell('cp a \\\n  /tmp/x.log'), '');
    });

    it('take a backslash-newline as text where the shell does (F345-2)', async () => {
      assert.match(await shell("cat <<'EOF'\nx \\\nEOF\necho hi > /tmp/b.md"), /b\.md/, 'a heredoc body ends at its delimiter');
      assert.match(await shell('# note \\\necho hi > /tmp/b.md'), /b\.md/, 'a comment does not continue');
      assert.match(await shell('echo a\\\\\necho hi > /tmp/b.md'), /b\.md/, 'an escaped backslash does not continue');
    });

    describe('GH 2405: command output captured in a prose file', () => {
      const S = '/tmp/tmb-no-prose-2405';

      it('allows piped git diff output in a .txt', async () => {
        assert.equal(await shell(`git diff A B | grep x > ${S}/a.txt`), '');
      });

      it('allows gh issue view output in a .md', async () => {
        assert.equal(await shell(`gh issue view 1 --json body -q .body > ${S}/i.md`), '');
      });

      it('allows sort output in a $TMPDIR .txt', async () => {
        assert.equal(await shell('sort -u f > $TMPDIR/block.txt'), '');
      });

      it('allows a program run with stderr joined', async () => {
        assert.equal(await shell(`node x.mjs > ${S}/p.txt 2>&1`), '');
      });

      it('allows an append', async () => {
        assert.equal(await shell(`cmd >> ${S}/o.txt`), '');
      });

      it('allows each capture operator and cat of a file', async () => {
        for (const command of [`git log &> ${S}/a.md`, `git log &>> ${S}/a.md`, `git log >| ${S}/a.md`, `git log 2> ${S}/e.txt`, `cat a.txt > ${S}/x.md`, `cd ${S} && git log > a.md`]) {
          assert.equal(await shell(command), '', command);
        }
      });

      it('denies a heredoc into cat', async () => {
        assert.match(await shell(`cat > ${S}/plan.md <<EOF\nplan\nEOF`), /^BLOCKED: prose file.*plan\.md/);
      });

      it('denies echo and printf', async () => {
        assert.match(await shell(`echo plan > ${S}/x.txt`), /^BLOCKED: prose file.*x\.txt/);
        assert.match(await shell(`printf '%s' plan > ${S}/x.md`), /^BLOCKED: prose file.*x\.md/);
      });

      it('denies a heredoc piped into tee', async () => {
        assert.match(await shell(`cat <<EOF | tee ${S}/s.md\nplan\nEOF`), /^BLOCKED: prose file.*s\.md/);
      });

      it('denies a pipeline whose first command authors', async () => {
        assert.match(await shell(`printf x | sort > ${S}/x.md`), /^BLOCKED: prose file.*x\.md/);
        assert.match(await shell(`cat <<EOF | sort > ${S}/x.md\nplan\nEOF`), /^BLOCKED: prose file.*x\.md/);
      });

      it('denies cp, a here-string and the Write tool', async () => {
        assert.match(await shell(`cp spec.md ${S}/spec.md`), /^BLOCKED: prose file.*spec\.md/);
        assert.match(await shell(`tr a b <<< plan > ${S}/x.txt`), /^BLOCKED: prose file.*x\.txt/);
        assert.match(await write(`${S}/spec.md`), /^BLOCKED: prose file.*spec\.md/);
      });

      it('keeps judged what it cannot pin to one plain command', async () => {
        for (const command of [
          `{ echo a; git log; } > ${S}/a.md`,
          `(echo plan) > ${S}/a.md`,
          `command echo plan > ${S}/a.md`,
          `bash -c 'echo plan' > ${S}/a.md`,
          `$CMD > ${S}/a.md`,
          `cat > ${S}/a.md`,
          `git log > ${S}/a.md$(echo plan > ${S}/b.txt)`,
          `git log && echo plan > ${S}/a.md`,
          `cp x > ${S}/a.log ${S}/b.md`,
        ]) {
          assert.match(await shell(command), /^BLOCKED: prose file/, command);
        }
      });

      it('denies the authored write beside a capture', async () => {
        const text = await shell(`git log > ${S}/log.txt; echo plan > ${S}/p.md`);
        assert.match(text, /^BLOCKED: prose file.*p\.md/);
        assert.doesNotMatch(text, /log\.txt/);
      });

      it('still denies a gh body file', async () => {
        assert.match(await shell(`gh issue create --body-file ${S}/b.md`), /--body, or by --body-file - on stdin$/);
      });
    });

    describe('GH 2468: a pipeline member with a redirect of its own', () => {
      const S = '/tmp/tmb-no-prose-2468';

      it('allows a script run with stderr joined, piped into a capture', async () => {
        assert.equal(await shell(`bash t.sh 2>&1 | grep x | sort > ${S}/x.txt`), '');
      });

      it('allows find with stderr dropped, piped into a capture', async () => {
        assert.equal(await shell(`find . -type f 2>/dev/null | sort > ${S}/x.txt`), '');
      });

      it('allows members with an assignment prefix and a redirect of their own', async () => {
        assert.equal(await shell(`LC_ALL=C find . 2>/dev/null | LC_ALL=C sort > ${S}/x.txt`), '');
      });

      it('allows an outer pipeline head with a redirect of its own', async () => {
        assert.equal(await shell(`find . 2>/dev/null | sort 2> ${S}/e.txt | wc`), '');
      });

      it('denies echo with stderr dropped at the head', async () => {
        assert.match(await shell(`echo hi 2>/dev/null | sort > ${S}/x.txt`), /^BLOCKED: prose file.*x\.txt/);
      });

      it('denies printf with stderr joined at the head', async () => {
        assert.match(await shell(`printf x 2>&1 | sort > ${S}/x.md`), /^BLOCKED: prose file.*x\.md/);
      });

      it('denies a heredoc piped into a capture', async () => {
        assert.match(await shell(`cat <<'EOF' | sort > ${S}/x.txt\nplan\nEOF`), /^BLOCKED: prose file.*x\.txt/);
      });

      it('denies a here-string with a redirect of its own piped into a capture', async () => {
        assert.match(await shell(`cat <<< hi 2>/dev/null | sort > ${S}/x.txt`), /^BLOCKED: prose file.*x\.txt/);
      });

      it('denies an authoring outer pipeline head with a redirect of its own', async () => {
        assert.match(await shell(`echo hi 2>/dev/null | sort 2> ${S}/e.txt | wc`), /^BLOCKED: prose file.*e\.txt/);
      });
    });

    describe('GH 2469: a command tree-sitter parses with an error', () => {
      const S = '/tmp/tmb-no-prose-2469';

      it('denies a here-string after a stderr redirect piped into a capture', async () => {
        assert.match(await shell(`tr a b 2>/dev/null <<< "plan" | sort > ${S}/x.txt`), /^BLOCKED: prose file.*x\.txt/);
        assert.match(await shell('tr a b 2>/dev/null <<< "plan" | sort > $TMPDIR/x.txt'), /^BLOCKED: prose file.*x\.txt/);
      });

      it('denies a heredoc after a stderr redirect piped into a capture', async () => {
        assert.match(await shell(`cat 2>/dev/null <<'EOF' | sort > ${S}/x.txt\nplan\nEOF`), /^BLOCKED: prose file.*x\.txt/);
      });

      it('denies any prose file a command with a parse error writes into scratch', async () => {
        assert.match(await shell('tr a b 2>/dev/null <<< plan | tee .claude/tmb/scratch/x.md'), /^BLOCKED: prose file.*x\.md/);
        assert.match(await shell(`tr a b 2>/dev/null <<< plan > "${S}/x.md"`), /^BLOCKED: prose file.*x\.md/);
      });

      it('allows the same command writing a log or prose outside every zone', async () => {
        assert.equal(await shell(`tr a b 2>/dev/null <<< plan | sort > ${S}/x.log`), '');
        assert.equal(await shell(`tr a b 2>/dev/null <<< plan | sort > ${OUTSIDE_EVERY_ZONE}/x.md`), '');
      });
    });

    describe('GH 2470: every member of the pipeline', () => {
      const S = '/tmp/tmb-no-prose-2470';

      it('denies echo and printf in the middle of a pipeline', async () => {
        assert.match(await shell(`find . | echo plan | sort > ${S}/x.txt`), /^BLOCKED: prose file.*x\.txt/);
        assert.match(await shell(`find . | printf x | sort > ${S}/x.md`), /^BLOCKED: prose file.*x\.md/);
      });

      it('denies a here-string in the middle of a pipeline', async () => {
        assert.match(await shell(`find . | cat <<< hi | sort > ${S}/x.md`), /^BLOCKED: prose file.*x\.md/);
      });

      it('denies an authoring member in the middle of an outer pipeline', async () => {
        assert.match(await shell(`find . 2>/dev/null | echo hi | sort 2> ${S}/e.txt | wc`), /^BLOCKED: prose file.*e\.txt/);
        assert.match(await shell(`a | echo hi 2>/dev/null | c 2>/dev/null | d > ${S}/x.txt`), /^BLOCKED: prose file.*x\.txt/);
      });

      it('still denies a bare cat at the head', async () => {
        assert.match(await shell(`cat | sort > ${S}/x.txt`), /^BLOCKED: prose file.*x\.txt/);
      });

      it('allows captures in the middle', async () => {
        for (const command of [
          `find . | sort | uniq -c > ${S}/x.txt`,
          `grep x a | cat | sort > ${S}/x.txt`,
          `bash t.sh 2>&1 | grep -v y 2>/dev/null | sort > ${S}/x.txt`,
          `git log | cat > ${S}/x.txt`,
          `a | b 2>/dev/null | c 2>/dev/null | d > ${S}/x.txt`,
        ]) {
          assert.equal(await shell(command), '', command);
        }
      });
    });

    it('leave an UNRESOLVED target to containment-guard', async () => {
      assert.equal(await shell('echo hi > "$(pick-a-name)"'), '');
    });
  });

  describe('gh body files', () => {
    const REASON = /--body, or by --body-file - on stdin$/;

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

    it('read a flag past a line continuation (F345-2)', async () => {
      for (const command of ['gh issue edit 1 \\\n  --body-file /tmp/b.md', 'gh issue edit 1 \\\n  --body-file=b.md', 'gh pr comment 1 \\\n  -F b.md', 'cd d && gh pr edit 1 \\\n  --body-file b']) {
        assert.match(await shell(command), REASON, command);
      }
      assert.equal(await shell('gh issue edit 1 \\\n  --body-file - <<EOF\nhi\nEOF'), '');
    });

    it('take a heredoc run onto the value as stdin (F345-3)', async () => {
      for (const command of [
        'gh issue edit 1 --body-file -<<EOF\nhi\nEOF',
        "gh issue edit 1 --body-file -<<'EOF'\nhi\nEOF",
        'gh issue edit 1 --body-file=-<<EOF\nhi\nEOF',
        'gh issue edit 1 -F -<<EOF\nhi\nEOF',
        'gh issue edit 1 -F=-<<EOF\nhi\nEOF',
        'gh issue edit 1 --body-file -<<<hi',
      ]) {
        assert.equal(await shell(command), '', command);
      }
      assert.match(await shell('gh issue edit 1 --body-file b.md<<EOF\nhi\nEOF'), REASON);
    });

    it('skip the value of a flag that takes one (F345-4)', async () => {
      for (const command of [
        'gh pr create --title "-F x" --body y',
        'gh pr create --title "-Fix it" --body y',
        'gh pr create --title "--body-file=x y"',
        'gh pr create -t "-F x" -b "--body-file y"',
        'gh issue edit 1 --add-label "-F x"',
      ]) {
        assert.equal(await shell(command), '', command);
      }
      assert.match(await shell('gh pr create --title "-F x" --body-file b.md'), REASON);
      assert.match(await shell('gh pr create --title t -F b.md'), REASON);
    });

    it('leave other gh commands alone', async () => {
      assert.equal(await shell('gh api repos/x/y -F a=b'), '');
      assert.equal(await shell('gh pr review 1 --body-file b'), '');
    });
  });

  describe('joinContinuations', () => {
    it('drops a continuation outside and inside double quotes, as the shell does', async () => {
      assert.equal(await joinContinuations('a \\\n  b'), 'a   b');
      assert.equal(await joinContinuations('ab\\\ncd'), 'abcd');
      assert.equal(await joinContinuations('echo "a \\\nb"'), 'echo "a b"');
    });

    it('keeps a backslash-newline in single quotes, ANSI-C quotes, a heredoc body and a comment', async () => {
      for (const command of ["echo 'a \\\nb'", "echo $'a \\\nb'", 'cat <<EOF\nx \\\ny\nEOF', "cat <<'EOF'\nx \\\ny\nEOF", '# a \\\nb']) {
        assert.equal(await joinContinuations(command), command);
      }
    });

    it('keeps the newline after an escaped backslash', async () => {
      assert.equal(await joinContinuations('a\\\\\nb'), 'a\\\\\nb');
    });

    it('judges each one alone, past a literal and past text wider than one code unit', async () => {
      assert.equal(await joinContinuations("✅ 'a \\\nb' c \\\nd"), "✅ 'a \\\nb' c d");
      assert.equal(await joinContinuations("x \\\ny 'a \\\nb' z \\\nw"), "x y 'a \\\nb' z w");
    });
  });

  describe('the built gate, as the findings probed it', () => {
    const gate = (command: string): string => {
      const input = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: project, tool_name: 'Bash', tool_input: { command } });
      const run = spawnSync('node', [join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js'), 'no-prose-in-scratch'], { input, encoding: 'utf8', env });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout;
    };

    it('F345-2: denies a body file past a line continuation', () => {
      assert.match(gate('gh issue edit 1 \\\n  --body-file /tmp/b.md'), /body-file - on stdin/);
    });

    it('F345-3: allows --body-file -<<EOF', () => {
      assert.equal(gate('gh issue edit 1 --body-file -<<EOF\nhi\nEOF'), '');
    });

    it('F345-4: allows a title that looks like a body-file flag', () => {
      assert.equal(gate('gh pr create --title "-F x" --body y'), '');
    });

    it('F345-5: allows removing a quoted path with a space', () => {
      assert.equal(gate('rm "/tmp/a b.md"'), '');
    });
  });

  describe('the router --shim, the headless entry (F345-1)', () => {
    const shim = (toolName: string, toolInput: Record<string, unknown>, over: NodeJS.ProcessEnv = {}): string => {
      const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'probe', cwd: project, tool_name: toolName, tool_input: toolInput });
      return spawnSync(process.execPath, [join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js'), 'PreToolUse', '--shim'], {
        input,
        encoding: 'utf8',
        env: { ...env, CLAUDE_PROJECT_DIR: project, TMB_SHIM_PROJECT: project, ...over },
      }).stdout;
    };
    const DENY = /"permissionDecision":"deny"/;
    const elsewhere = (): NodeJS.ProcessEnv => ({ CLAUDE_PROJECT_DIR: tmp });

    it('yields to a session of another project, a prose write included', () => {
      assert.doesNotMatch(shim('Bash', { command: 'ls' }, elsewhere()), DENY);
      assert.doesNotMatch(shim('Write', { file_path: join(project, 'a.ts'), content: 'x' }, elsewhere()), DENY);
      assert.doesNotMatch(shim('Bash', { command: 'echo hi > /tmp/x.md' }, elsewhere()), DENY);
    });

    it('still denies through the shim in normal mode', () => {
      assert.match(shim('Bash', { command: 'echo hi > /tmp/x.md' }), DENY);
      assert.match(shim('Bash', { command: 'gh issue edit 1 --body-file b.md' }), DENY);
      assert.match(shim('Write', { file_path: scratch('plan.md'), content: 'x' }), DENY);
      assert.doesNotMatch(shim('Bash', { command: 'ls' }), DENY);
    });

    it('lists this gate as ts-only in the table', () => {
      const rows = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks-router.txt'), 'utf8').trimEnd().split('\n').map((line) => line.split(' '));
      assert.deepEqual(rows.filter((f) => f[0] === 'no-prose-in-scratch').map((f) => f[2]), ['ts-only', 'ts-only']);
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
