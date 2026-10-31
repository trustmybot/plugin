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
import { LINT_GATES, lintSandbox } from './lint-hooks-sandbox.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BARE_FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
function bashPayload(command) {
    return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}
function runSh(gate, input, env) {
    const r = spawnSync('/bin/bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], { input, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
}
function context(stdout) {
    const out = JSON.parse(stdout);
    const h = out.hookSpecificOutput;
    return { decision: h.permissionDecision, text: h.additionalContext ?? h.permissionDecisionReason ?? '' };
}
describe('lint hooks: the TypeScript gates', () => {
    let dir;
    let sandbox;
    let noJq;
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
    it('attribution-footer views and edits the artifact in the dir the create ran in, not the hook process cwd (GH 2134)', () => {
        const bin = join(dir, 'pwd-bin');
        const repoDir = join(dir, 'other-repo');
        const pwds = join(dir, 'gh-pwd.log');
        mkdirSync(bin);
        mkdirSync(repoDir);
        writeFileSync(join(bin, 'gh'), `#!/bin/bash\npwd -P >> '${pwds}'\nif [ "$2" = view ]; then echo Body; fi\n`);
        chmodSync(join(bin, 'gh'), 0o755);
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, LC_ALL: 'C' };
        const input = JSON.stringify({
            tool_name: 'Bash',
            cwd: tmpdir(),
            tool_input: { command: `cd '${repoDir}' && gh pr create --fill` },
            tool_response: 'https://github.com/o/r/pull/9',
        });
        assert.deepEqual(attributionFooter(input, env), { stdout: '', code: 0 });
        const expected = realpathSync(repoDir);
        assert.deepEqual(readFileSync(pwds, 'utf8').trim().split('\n'), [expected, expected]);
    });
    function ghPwdStub(name) {
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
        attributionFooter(JSON.stringify({
            tool_name: 'Bash',
            cwd: postCd,
            tool_input: { command: 'cd sub && gh pr create --fill' },
            tool_response: 'https://github.com/o/r/pull/9',
        }), env);
        const expected = realpathSync(postCd);
        assert.deepEqual(readFileSync(pwds, 'utf8').trim().split('\n'), [expected, expected]);
    });
    it('attribution-footer runs gh in the payload cwd, not a git -C target (F292-2)', () => {
        const { pwds, env } = ghPwdStub('git-c');
        const here = join(dir, 'git-c-here');
        const other = join(dir, 'git-c-other');
        mkdirSync(here);
        mkdirSync(other);
        attributionFooter(JSON.stringify({
            tool_name: 'Bash',
            cwd: here,
            tool_input: { command: `git -C ${other} pull && gh pr create --fill` },
            tool_response: 'https://github.com/o/r/pull/9',
        }), env);
        const expected = realpathSync(here);
        assert.deepEqual(readFileSync(pwds, 'utf8').trim().split('\n'), [expected, expected]);
    });
    it('attribution-footer reads a letter newer than the OS tables (U+105C0) as a word char under UTF-8', () => {
        const log = join(dir, 'alnum.log');
        const env = { ...process.env, ...sandbox.env, LC_ALL: 'en_US.UTF-8', STUB_LOG: log, STUB_VIEW_OUT: 'Body' };
        const input = (prefix) => JSON.stringify({ tool_name: 'Bash', tool_input: { command: `${prefix}gh pr create --fill` }, tool_response: 'https://github.com/o/r/pull/8' });
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
//# sourceMappingURL=hooks-lint.test.js.map