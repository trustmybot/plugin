/**
 * commit-msg-lint denies a commit subject outside its allowlist grammar
 * `<emoji> <type>(<scope>): <msg>` or over 72 chars (GH 2582), in every
 * locale, and still admits the modes with no message to read.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commitMsgLint, EXPECTED_FORM, MAX_SUBJECT_CHARS } from '../hooks/commit-msg-lint.js';

interface Hook {
  hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
}

const LOCALES = ['C', 'en_US.UTF-8'];

async function lint(command: string, extra: NodeJS.ProcessEnv = {}, locale = 'C.UTF-8') {
  const env = { ...process.env, LC_ALL: locale, TMB_SKIP_COMMIT_MSG_LINT: undefined, ...extra };
  return commitMsgLint(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), env);
}

async function denyReason(command: string, locale?: string): Promise<string> {
  const result = await lint(command, {}, locale);
  assert.equal(result.code, 0);
  assert.notEqual(result.stdout, '', `${command} was admitted`);
  const hook = (JSON.parse(result.stdout) as Hook).hookSpecificOutput;
  assert.equal(hook.permissionDecision, 'deny', command);
  assert.equal(hook.additionalContext, undefined);
  return hook.permissionDecisionReason ?? '';
}

async function assertAdmitted(command: string, extra: NodeJS.ProcessEnv = {}, locale?: string) {
  assert.deepEqual(await lint(command, extra, locale), { stdout: '', code: 0 }, command);
}

describe('commit-msg-lint denies (GH 2582)', () => {
  for (const subject of ['fix: x', 'é fix: x', '✨ feature: x', '✨feat: x', '✨ feat:x', '✨ feat(Hooks): x', '✨ ✨ feat: x', 'x ✨ feat: x']) {
    it(`denies "${subject}" naming the expected form`, async () => {
      for (const locale of LOCALES) {
        const reason = await denyReason(`git commit -m "${subject}"`, locale);
        assert.ok(reason.includes(EXPECTED_FORM), reason);
        assert.ok(reason.includes('grammar rule'), reason);
        assert.ok(reason.includes(`Subject seen: "${subject}"`), reason);
        assert.ok(reason.includes('Allowed form:'), reason);
      }
    });
  }

  it('denies a subject over 72 chars, naming its length', async () => {
    const subject = `✨ feat(hooks): ${'y'.repeat(60)}`;
    const length = [...subject].length;
    assert.ok(length > MAX_SUBJECT_CHARS);
    for (const locale of LOCALES) {
      const reason = await denyReason(`git commit -m "${subject}"`, locale);
      assert.ok(reason.includes('length rule'), reason);
      assert.ok(reason.includes(`${length} chars`), reason);
      assert.ok(reason.includes(`>${MAX_SUBJECT_CHARS}`), reason);
    }
  });

  it('counts a 72-char subject in code points, so it is admitted', async () => {
    const prefix = '✨ feat(hooks): ';
    const subject = `${prefix}${'y'.repeat(MAX_SUBJECT_CHARS - [...prefix].length)}`;
    assert.equal([...subject].length, MAX_SUBJECT_CHARS);
    for (const locale of LOCALES) await assertAdmitted(`git commit -m "${subject}"`, {}, locale);
  });

  it('lints --amend with -m', async () => {
    assert.ok((await denyReason('git commit --amend -m "bad subject"')).includes(EXPECTED_FORM));
  });

  it('lints only the first line of the message', async () => {
    await assertAdmitted("git commit -m '✨ feat(x): add y' -m 'body line that is not a subject'");
  });

  for (const command of ["git commit -m $'\\xe2\\x9c\\xa8 bad subject'", "git commit -m $'\\342\\234\\250 bad subject'"]) {
    it(`lints the UTF-8 subject ${command} spells in byte escapes (GH 2765)`, async () => {
      const reason = await denyReason(command);
      assert.ok(reason.includes('grammar rule'), reason);
      assert.ok(reason.includes('Subject seen: "✨ bad subject"'), reason);
    });
  }
});

describe('commit-msg-lint on byte-escape subjects (GH 2765)', () => {
  it('admits a valid subject spelled in byte escapes', async () => {
    await assertAdmitted("git commit -m $'\\xe2\\x9c\\xa8 feat(hooks): good subject'");
  });

  for (const command of ["git commit -m $'\\xff bad subject'", "git commit -m $'\\xe2\\x9c bad'"])
    it(`admits ${command} as unproven, an invalid UTF-8 run read as computed text`, async () => {
      await assertAdmitted(command);
    });
});

describe('commit-msg-lint admits (GH 2582)', () => {
  for (const subject of [
    '✨ feat(hooks): x',
    '🔬 research(x): y',
    '🐛 fix: no scope',
    ':bug: fix(db): a shortcode',
    '♻️ refactor(core): a VS16 emoji',
    '👩‍💻 chore: a ZWJ sequence',
    '⚡ improvement(scope): description',
  ]) {
    it(`admits "${subject}"`, async () => {
      for (const locale of LOCALES) await assertAdmitted(`git commit -m "${subject}"`, {}, locale);
    });
  }

  for (const command of [
    'git commit --fixup=HEAD',
    'git commit --squash=HEAD',
    'git commit --amend --no-edit',
    'git commit --no-edit',
    'git commit --merge',
    'git commit -F msg.txt',
    'git commit',
    'ls -la',
  ]) {
    it(`admits ${command}`, async () => {
      await assertAdmitted(command);
    });
  }

  it('admits a bad subject under TMB_SKIP_COMMIT_MSG_LINT=1', async () => {
    await assertAdmitted('git commit -m "bad subject"', { TMB_SKIP_COMMIT_MSG_LINT: '1' });
  });

  it('admits a non-Bash tool call', async () => {
    const result = await commitMsgLint(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'git commit' } }), process.env);
    assert.deepEqual(result, { stdout: '', code: 0 });
  });
});
