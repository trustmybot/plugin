/**
 * The TypeScript lint hooks where they part from their scripts/hooks/*.sh
 * twins (GH 1692): commit-msg-lint denies a commit command tree-sitter-bash
 * cannot parse with git-guards' PARSE_REASON unless it holds `$(` or a
 * backtick, all four lint with no jq on PATH (the .sh exit silently), and
 * attribution-footer's `[:alnum:]` under a UTF-8 locale is node's Unicode
 * letters and decimal digits. Plus the registry wiring.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attributionFooter, normalizeFooter, TMB_FOOTER } from '../hooks/attribution-footer.js';
import { codeQualityLint } from '../hooks/code-quality-lint.js';
import { commitMsgLint } from '../hooks/commit-msg-lint.js';
import { PARSE_REASON } from '../hooks/git-guards.js';
import { namingLint } from '../hooks/naming-lint.js';
import { findGate, gateNames } from '../hooks/registry.js';
import { LINT_GATES, lintSandbox, type LintSandbox } from './lint-hooks-sandbox.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BARE_FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

function bashPayload(command: string): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

function runSh(gate: string, input: string, env: NodeJS.ProcessEnv): string {
  const r = spawnSync('/bin/bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], { input, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function context(stdout: string): { decision?: string; text: string } {
  const out = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };
  const h = out.hookSpecificOutput;
  return { decision: h.permissionDecision, text: h.additionalContext ?? h.permissionDecisionReason ?? '' };
}

describe('lint hooks: the TypeScript gates', () => {
  let dir: string;
  let sandbox: LintSandbox;
  let noJq: string;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-lint-')));
    sandbox = lintSandbox(join(dir, 'sandbox'));
    noJq = join(dir, 'empty-bin');
    mkdirSync(noJq);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers all four lint gates', () => {
    for (const gate of LINT_GATES) {
      assert.ok(gateNames().includes(gate), gate);
      assert.ok(findGate(gate), gate);
    }
  });

  describe('commit-msg-lint on a command tree-sitter-bash cannot parse', () => {
    const unparseable = 'git commit -m "wip" )';

    it('denies it with PARSE_REASON, where the .sh lints what it reads', async () => {
      const result = await commitMsgLint(bashPayload(unparseable), { ...process.env, LC_ALL: 'C' });
      assert.deepEqual(context(result.stdout), { decision: 'deny', text: PARSE_REASON });
      assert.equal(result.code, 0);
      const sh = runSh('commit-msg-lint', bashPayload(unparseable), { ...process.env, LC_ALL: 'C' });
      assert.notEqual(sh === '' ? undefined : context(sh).decision, 'deny');
    });

    it('stays silent when it builds its message with $( or a backtick, as the .sh does', async () => {
      for (const command of ['git commit -m "$(cat <<EOF\\nfeat: x\\nEOF\\n)"', 'git commit -m "`cat msg`" )']) {
        const result = await commitMsgLint(bashPayload(command), { ...process.env, LC_ALL: 'C' });
        assert.deepEqual(result, { stdout: '', code: 0 }, command);
        assert.equal(runSh('commit-msg-lint', bashPayload(command), { ...process.env, LC_ALL: 'C' }), '', command);
      }
    });

    it('still skips a command that never names commit', async () => {
      assert.deepEqual(await commitMsgLint(bashPayload('echo "wip" )'), process.env), { stdout: '', code: 0 });
    });
  });

  describe('with no jq on PATH, where each .sh exits silently', () => {
    it('commit-msg-lint still warns', async () => {
      const env = { ...process.env, PATH: noJq, LC_ALL: 'C' };
      const result = await commitMsgLint(bashPayload('git commit -m "feat: add x"'), env);
      assert.match(context(result.stdout).text, /^commit-msg-lint: commit subject does not match/);
      assert.equal(runSh('commit-msg-lint', bashPayload('git commit -m "feat: add x"'), env), '');
    });

    it('naming-lint still warns', () => {
      const env = { ...process.env, PATH: noJq, LC_ALL: 'C' };
      const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(dir, 'new/BadName.py') } });
      assert.match(context(namingLint(input, env).stdout).text, /snake_case/);
      assert.equal(runSh('naming-lint', input, env), '');
    });

    it('code-quality-lint still warns', () => {
      const env = { ...process.env, PATH: noJq, LC_ALL: 'C' };
      const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/w/a.py', content: 'except:\n' } });
      assert.match(context(codeQualityLint(input, env).stdout).text, /bare 'except:'/);
      assert.equal(runSh('code-quality-lint', input, env), '');
    });

    it('attribution-footer still writes the footer', () => {
      const stubs = sandbox.env.PATH?.split(':')[0] ?? '';
      const log = join(dir, 'no-jq.log');
      const env = { ...process.env, PATH: stubs, LC_ALL: 'C', STUB_LOG: log, STUB_VIEW_OUT: 'Body' };
      const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: 'https://github.com/o/r/pull/7' });
      assert.deepEqual(attributionFooter(input, env), { stdout: '', code: 0 });
      assert.ok(readFileSync(log, 'utf8').includes(`[gh][pr][edit][7][--body][Body\n\n${TMB_FOOTER}]`));
      rmSync(log);
      runSh('attribution-footer', input, env);
      assert.equal(existsSync(log), false);
    });
  });

  function ghPwdStub(name: string): { pwds: string; env: NodeJS.ProcessEnv } {
    const bin = join(dir, `${name}-bin`);
    const pwds = join(dir, `${name}.log`);
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/bash\npwd -P >> '${pwds}'\nif [ "$2" = view ]; then echo Body; fi\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    return { pwds, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, LC_ALL: 'C' } };
  }

  it('attribution-footer falls back to the payload cwd when a relative cd target does not join it (F292-1)', () => {
    const { pwds, env } = ghPwdStub('post-cd');
    const postCd = join(dir, 'post-cd-repo', 'sub');
    mkdirSync(postCd, { recursive: true });
    attributionFooter(
      JSON.stringify({
        tool_name: 'Bash',
        cwd: postCd,
        tool_input: { command: 'cd sub && gh pr create --fill' },
        tool_response: 'https://github.com/o/r/pull/9',
      }),
      env,
    );
    const expected = realpathSync(postCd);
    assert.deepEqual(readFileSync(pwds, 'utf8').trim().split('\n'), [expected, expected]);
  });

  it('attribution-footer runs gh in the payload cwd, not a git -C target (F292-2)', () => {
    const { pwds, env } = ghPwdStub('git-c');
    const here = join(dir, 'git-c-here');
    const other = join(dir, 'git-c-other');
    mkdirSync(here);
    mkdirSync(other);
    attributionFooter(
      JSON.stringify({
        tool_name: 'Bash',
        cwd: here,
        tool_input: { command: `git -C ${other} pull && gh pr create --fill` },
        tool_response: 'https://github.com/o/r/pull/9',
      }),
      env,
    );
    const expected = realpathSync(here);
    assert.deepEqual(readFileSync(pwds, 'utf8').trim().split('\n'), [expected, expected]);
  });

  function forgeStub(cli: string, name: string): { calls: string; env: NodeJS.ProcessEnv } {
    const bin = join(dir, `${name}-bin`);
    const calls = join(dir, `${name}.log`);
    mkdirSync(bin);
    writeFileSync(
      join(bin, cli),
      `#!/bin/bash\necho "$(pwd -P)|\${GH_REPO:-}|\${GITLAB_REPO:-}|$1 $2 $3" >> '${calls}'\nif [ "$2" = view ]; then echo "\${STUB_VIEW_OUT:-Body}"; fi\n`,
    );
    chmodSync(join(bin, cli), 0o755);
    return { calls, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, LC_ALL: 'C' } };
  }

  it('attribution-footer targets the repo in the response URL with the .sh argv, whatever the command text says (F292-4)', () => {
    mkdirSync(join(dir, 'url-here'));
    const here = realpathSync(join(dir, 'url-here'));
    const other = join(dir, 'url-other');
    mkdirSync(other);
    const commands = {
      'leading cd': `cd '${other}' && gh pr create --fill`,
      'heredoc body': `gh pr create --title t --body "$(cat <<X\nTest plan:\ncd ${other}\nnpm test\nX\n)"`,
      'cd after gh': `gh pr create --fill\ncd ${other} && git status`,
    };
    for (const [name, command] of Object.entries(commands)) {
      const { calls, env } = forgeStub('gh', `url-${name.replace(' ', '-')}`);
      attributionFooter(
        JSON.stringify({ tool_name: 'Bash', cwd: here, tool_input: { command }, tool_response: 'https://github.example.com/o/r/pull/9' }),
        env,
      );
      assert.deepEqual(
        readFileSync(calls, 'utf8').trim().split('\n'),
        [`${here}|github.example.com/o/r||pr view 9`, `${here}|github.example.com/o/r||pr edit 9`],
        name,
      );
    }
  });

  it('attribution-footer targets a nested GitLab project by its URL', () => {
    const { calls, env } = forgeStub('glab', 'glab-url');
    attributionFooter(
      JSON.stringify({
        tool_name: 'Bash',
        cwd: dir,
        tool_input: { command: 'glab mr create --fill' },
        tool_response: 'https://gitlab.example.com/g/s/p/-/merge_requests/4',
      }),
      { ...env, STUB_VIEW_OUT: '{"description":"Body"}' },
    );
    const start = `${realpathSync(dir)}||https://gitlab.example.com/g/s/p`;
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [`${start}|mr view 4`, `${start}|mr update 4`]);
  });

  it('attribution-footer still writes when the payload cwd is gone, and writes nothing with no URL', () => {
    const { calls, env } = forgeStub('gh', 'gone-cwd');
    const input = (response: string) =>
      JSON.stringify({ tool_name: 'Bash', cwd: join(dir, 'never-existed'), tool_input: { command: 'gh pr create --fill' }, tool_response: response });
    attributionFooter(input('no url here'), env);
    assert.equal(existsSync(calls), false);
    attributionFooter(input('https://github.com/o/r/pull/3'), env);
    const lines = readFileSync(calls, 'utf8').trim().split('\n');
    assert.deepEqual(lines.map((l) => l.split('|').slice(1).join('|')), ['github.com/o/r||pr view 3', 'github.com/o/r||pr edit 3']);
  });

  it('attribution-footer reads a letter newer than the OS tables (U+105C0) as a word char under UTF-8', () => {
    const log = join(dir, 'alnum.log');
    const env = { ...process.env, ...sandbox.env, LC_ALL: 'en_US.UTF-8', STUB_LOG: log, STUB_VIEW_OUT: 'Body' };
    const input = (prefix: string) =>
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: `${prefix}gh pr create --fill` }, tool_response: 'https://github.com/o/r/pull/8' });
    attributionFooter(input('\u{105C0}'), env);
    assert.equal(existsSync(log), false, 'no gh call after a letter');
    attributionFooter(input('+'), env);
    assert.ok(readFileSync(log, 'utf8').includes('[gh][pr][edit][8]'));
  });

  it('normalizeFooter swaps a bare Claude Code footer for the TMB one and keeps an existing one', () => {
    assert.equal(normalizeFooter(`Body\n\n${BARE_FOOTER}\n\n \n`, { LC_ALL: 'C' }), `Body\n\n${TMB_FOOTER}`);
    assert.equal(normalizeFooter(`Body\n\n${TMB_FOOTER}\n`, { LC_ALL: 'C' }), `Body\n\n${TMB_FOOTER}`);
    assert.equal(normalizeFooter('', { LC_ALL: 'C' }), TMB_FOOTER);
  });
});
