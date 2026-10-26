/**
 * The TypeScript git-push-guard where it is stricter than
 * scripts/hooks/git-push-guard.sh (decision 369): a command naming `push`
 * that encode() cannot parse faithfully is denied with PARSE_REASON, where the
 * .sh judges its misread statements (GH 1927). tree-sitter-bash runs a heredoc
 * whose delimiter is quoted mid-word (`<<E"M"`) or whose body holds a lone `$`
 * line to the end of the command, hiding the push after it inside the body.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashParser } from '../hooks/cmd-analysis/parser.js';
import { encode } from '../hooks/cmd-analysis/encode.js';
import { cmdStatements } from '../hooks/cmd-analysis/index.js';
import { gitPushGuard, PARSE_REASON } from '../hooks/git-push-guard.js';
import { PR_REVIEWER_ROLE } from '../hooks/lib/role.js';
import { findGate } from '../hooks/registry.js';

const MID_WORD_QUOTE = (wt: string) => `W=${wt}; cat <<E"M"\nx\nEM\ngit -C $W push origin HEAD`;
const DOLLAR_LINE = (wt: string) => `W=${wt}; cat <<EOF\n$\nEOF\ngit -C $W push origin HEAD`;

function payload(command: string, cwd: string): string {
  return JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });
}

function reason(stdout: string): string {
  if (stdout === '') return '';
  const out = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('git-push-guard: GH 1927 misparsed heredocs fail closed', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gpg-')));
    env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: join(dir, 'none.db') };
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('encode() reports both shapes as not ok', async () => {
    const parser = await bashParser();
    for (const shape of [MID_WORD_QUOTE, DOLLAR_LINE]) assert.equal(encode(parser, shape('/w/r')).ok, false, shape('/w/r'));
  });

  it('encode() still parses a heredoc whose delimiter line ends it', async () => {
    const parser = await bashParser();
    assert.equal(encode(parser, 'W=/w/r; cat <<EOF\nx\nEOF\ngit -C $W push origin HEAD').ok, true);
    assert.equal(encode(parser, 'cat <<"EM"\n$x\nEM\ngit push').ok, true);
  });

  it('cmdStatements() fails closed on both shapes, directly and inside bash -c', async () => {
    for (const shape of [MID_WORD_QUOTE, DOLLAR_LINE]) {
      assert.deepEqual(await cmdStatements(shape(`${dir}/.claude/worktrees/t`), dir, env), { ok: false });
      const inner = `bash -c '${shape(`${dir}/.claude/worktrees/t`).replaceAll("'", `'"'"'`)}'`;
      assert.deepEqual(await cmdStatements(inner, dir, env), { ok: false }, inner);
    }
  });

  it('the gate denies the mid-word-quoted delimiter shape with the parse reason', async () => {
    const r = await gitPushGuard(payload(MID_WORD_QUOTE(`${dir}/.claude/worktrees/t`), dir), env);
    assert.equal(r.code, 0);
    assert.equal(reason(r.stdout), PARSE_REASON);
  });

  it('the gate denies the lone-$ body line shape with the parse reason', async () => {
    const r = await gitPushGuard(payload(DOLLAR_LINE(`${dir}/.claude/worktrees/t`), dir), env);
    assert.equal(r.code, 0);
    assert.equal(reason(r.stdout), PARSE_REASON);
  });

  it('a well-terminated heredoc before a worktree push gets the worktree deny, not the parse deny', async () => {
    const r = await gitPushGuard(payload(`W=${dir}/.claude/worktrees/t; cat <<EOF\nx\nEOF\ngit -C $W push origin HEAD`, dir), env);
    const why = reason(r.stdout);
    assert.notEqual(why, PARSE_REASON);
    assert.match(why, /push from \.claude\/worktrees\/ is forbidden/);
  });

  it('an unparseable command that never names push is allowed untouched', async () => {
    const r = await gitPushGuard(payload(`W=${dir}; cat <<E"M"\nx\nEM\ngit -C $W status`, dir), env);
    assert.deepEqual(r, { stdout: '', code: 0 });
  });
});

describe('git-push-guard: wiring', () => {
  it('is registered under its gate name', () => {
    assert.equal(findGate('git-push-guard'), gitPushGuard);
  });

  it('names the pr-reviewer role through the one shared constant', () => {
    assert.equal(PR_REVIEWER_ROLE, 'pr-reviewer');
  });
});
