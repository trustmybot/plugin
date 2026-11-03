/**
 * Unit tests of the TypeScript trajectory-gates chain members (GH 1692):
 * agent-arg-matches-caller, reviewer-identity-observe and
 * cheatcode-install-approval. They cover each allow and deny branch, the jq
 * and tr semantics the parity corpus leans on, and the divergences from the
 * .sh that decision 703 allows (no jq, no sqlite3 CLI).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findGate, gateNames } from '../hooks/registry.js';
import { commandOnPath } from '../hooks/lib/persona.js';
import { agentArgMatchesCaller, callFields, trLower } from '../hooks/agent-arg-matches-caller.js';
import { reviewerIdentityObserve } from '../hooks/reviewer-identity-observe.js';
import {
  approvalSql,
  cheatcodeInstallApproval,
  NO_SOURCE_URL_REASON,
  notApprovedReason,
  UNVERIFIABLE_REASON,
} from '../hooks/cheatcode-install-approval.js';
import { buildSandbox } from './hooks-trajectory-chain-parity.suite.js';

const ALLOWED = { stdout: '', code: 0 };
const C = { LC_ALL: 'C' };
const UTF8 = { LC_ALL: 'en_US.UTF-8' };

function denyReason(stdout: string): string {
  assert.ok(stdout.endsWith('\n'));
  const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

function auditRows(db: string, eventType: string): { issue_id: number; summary: string; content_json: string }[] {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare('SELECT issue_id, summary, content_json FROM audit WHERE event_type = ? ORDER BY id').all(eventType) as {
      issue_id: number;
      summary: string;
      content_json: string;
    }[];
  } finally {
    d.close();
  }
}

describe('trajectory-gates chain members are registered', () => {
  for (const name of ['agent-arg-matches-caller', 'reviewer-identity-observe', 'cheatcode-install-approval']) {
    it(`${name} is a gate dist/hooks-gates.txt lists`, () => {
      assert.ok(findGate(name));
      assert.ok(gateNames().includes(name));
    });
  }
  it('maps each name to its gate', () => {
    assert.equal(findGate('agent-arg-matches-caller'), agentArgMatchesCaller);
    assert.equal(findGate('reviewer-identity-observe'), reviewerIdentityObserve);
    assert.equal(findGate('cheatcode-install-approval'), cheatcodeInstallApproval);
  });
});

describe('trLower', () => {
  it('lowercases ASCII only in the C locale', () => {
    assert.equal(trLower('Code-Reviewer ÉΣ', C), 'code-reviewer ÉΣ');
  });
  it('lowercases each uppercase letter one codepoint at a time under UTF-8', () => {
    assert.equal(trLower('Code-Reviewer ÉΣ', UTF8), 'code-reviewer éσ');
    assert.equal(trLower('ǅ', UTF8), 'ǅ');
  });
  it('follows macOS libc where it differs from Unicode', () => {
    assert.equal(trLower('İ', UTF8), 'i');
    assert.equal(trLower('Ύ', UTF8), 'ώ');
    assert.equal(trLower('Ώ', UTF8), 'Ϗ');
    assert.equal(trLower('ꟋᲉ', UTF8), 'ꟋᲉ');
  });
});

describe('callFields', () => {
  it('reads the first value, flattening newlines, CR and US to spaces', () => {
    assert.deepEqual(callFields('{"tool_name":"a\\nb","tool_input":{"agent":"x\\u001fy","task_id":42},"agent_type":"swe"}'), {
      tool: 'a b',
      given: 'x y',
      actual: 'swe',
      task: '42',
    });
    assert.deepEqual(callFields('{"tool_name":"t1"} {"tool_name":"t2"}')?.tool, 't1');
  });
  it('keeps number literals as jq prints them', () => {
    assert.equal(callFields('{"tool_input":{"agent":1.0,"task_id":1E+2}}')?.given, '1.0');
    assert.equal(callFields('{"tool_input":{"task_id":1E+2}}')?.task, '1E+2');
  });
  it('falls back from agent_type to subagent_type', () => {
    assert.equal(callFields('{"subagent_type":"swe"}')?.actual, 'swe');
    assert.equal(callFields('{"agent_type":null,"subagent_type":"swe"}')?.actual, 'swe');
  });
  it('is null when jq exits non-zero: a parse error, or the last value errors', () => {
    assert.equal(callFields('{"tool_name":'), null);
    assert.equal(callFields('{"tool_name":"t"} [1]'), null);
    assert.equal(callFields('{"tool_name":7}'), null);
    assert.notEqual(callFields('[1] {"tool_name":"t"}'), null);
  });
});

describe('the gates against a sandbox', () => {
  let base: string;
  let s: string;
  let emptyBin: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-trajectory-chain-gates-')));
    s = join(base, 'sandbox');
    emptyBin = join(base, 'empty-bin');
    mkdirSync(emptyBin);
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  const projectDb = (): string => join(s, 'project/.claude/tmb/trajectory.db');
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: projectDb(),
    PATH: emptyBin,
    LC_ALL: 'C',
    ...extra,
  });

  it('the PATH under test holds neither jq nor sqlite3', () => {
    assert.equal(commandOnPath('jq', env()), false);
    assert.equal(commandOnPath('sqlite3', env()), false);
  });

  describe('agent-arg-matches-caller', () => {
    before(() => buildSandbox(s));
    const call = (input: Record<string, unknown>, extra: Record<string, unknown> = {}, tool = 'mcp__plugin_tmb_trajectory-server__task_get'): string =>
      JSON.stringify({ tool_name: tool, tool_input: input, ...extra });

    it('denies a mismatched agent and records it without jq or sqlite3, where the .sh exits 1 and lets the call through', () => {
      const r = agentArgMatchesCaller(call({ agent: 'swe', task_id: 42 }), env());
      assert.equal(
        denyReason(r.stdout),
        "BLOCKED: task_get called with agent='swe' but the caller is the main session (bro); pass agent='bro'.",
      );
      const rows = auditRows(projectDb(), 'agent_arg_mismatch');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].issue_id, 7);
      assert.equal(rows[0].summary, "task_get: agent='swe' but the caller is the main session (bro)");
      assert.equal(rows[0].content_json, '{"tool":"task_get","given":"swe","actual":"bro","task_id":42}');
    });
    it('names a subagent caller and files a task-less mismatch on the system issue', () => {
      const r = agentArgMatchesCaller(call({ agent: 'bro' }, { agent_type: 'tmb:swe' }), env());
      assert.equal(denyReason(r.stdout), "BLOCKED: task_get called with agent='bro' but the caller is a swe subagent; pass agent='swe'.");
      const rows = auditRows(projectDb(), 'agent_arg_mismatch');
      assert.equal(rows.at(-1)?.issue_id, -1);
      assert.equal(rows.at(-1)?.content_json, '{"tool":"task_get","given":"bro","actual":"swe","task_id":null}');
    });
    it('allows a matching agent in any case the locale lowercases', () => {
      assert.deepEqual(agentArgMatchesCaller(call({ agent: 'SWE' }, { agent_type: 'swe' }), env()), ALLOWED);
      assert.deepEqual(agentArgMatchesCaller(call({ agent: 'tmb:bro' }), env()), ALLOWED);
      assert.notDeepEqual(agentArgMatchesCaller(call({ agent: 'É' }, { agent_type: 'é' }), env()), ALLOWED);
      assert.deepEqual(agentArgMatchesCaller(call({ agent: 'É' }, { agent_type: 'é' }), env(UTF8)), ALLOWED);
    });
    it('allows no agent, other tools and a payload jq cannot read', () => {
      assert.deepEqual(agentArgMatchesCaller(call({}), env()), ALLOWED);
      assert.deepEqual(agentArgMatchesCaller(call({ agent: '' }), env()), ALLOWED);
      assert.deepEqual(agentArgMatchesCaller(call({ agent: 'swe' }, {}, 'Bash'), env()), ALLOWED);
      assert.deepEqual(agentArgMatchesCaller(call({ agent: 'swe' }, {}, 'mcp__other__task_get'), env()), ALLOWED);
      assert.deepEqual(agentArgMatchesCaller('not json', env()), ALLOWED);
    });
    it('still denies with no DB to record in', () => {
      const r = agentArgMatchesCaller(call({ agent: 'swe' }), env({ TRAJECTORY_DB_PATH: join(s, 'none.db'), CLAUDE_PROJECT_DIR: join(s, 'bare') }));
      assert.match(denyReason(r.stdout), /pass agent='bro'/);
    });
  });

  describe('reviewer-identity-observe', () => {
    before(() => buildSandbox(s));
    const record = (extra: Record<string, unknown> = {}, input: Record<string, unknown> = { task_id: 42, attempt_n: 2 }): string =>
      JSON.stringify({
        tool_name: 'mcp__plugin_tmb_trajectory-server__validation_record',
        session_id: 'sess-1',
        tool_use_id: 'toolu_1',
        agent_id: 'agent-abc',
        agent_type: 'tmb:code-reviewer',
        tool_input: input,
        ...extra,
      });

    it('records a code-reviewer call without jq or sqlite3, where the .sh records nothing', () => {
      assert.deepEqual(reviewerIdentityObserve(record(), env()), ALLOWED);
      const rows = auditRows(projectDb(), 'reviewer_identity_observed');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].issue_id, 7);
      assert.equal(rows[0].summary, 'code-reviewer agent-abc called validation_record for task 42 attempt 2');
      const content = JSON.parse(rows[0].content_json) as Record<string, unknown>;
      assert.match(String(content.observed_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
      delete content.observed_at;
      assert.deepEqual(content, { task_id: 42, attempt_n: 2, session_id: 'sess-1', agent_id: 'agent-abc', tool_use_id: 'toolu_1', consumed: 0 });
    });
    it('stores a missing tool_use_id as null', () => {
      assert.deepEqual(reviewerIdentityObserve(record({ tool_use_id: null }), env()), ALLOWED);
      const rows = auditRows(projectDb(), 'reviewer_identity_observed');
      assert.equal((JSON.parse(rows.at(-1)?.content_json ?? '{}') as { tool_use_id: unknown }).tool_use_id, null);
    });
    it('records nothing for other tools, callers and arguments', () => {
      const before = auditRows(projectDb(), 'reviewer_identity_observed').length;
      for (const payload of [
        record({ tool_name: 'mcp__plugin_tmb_trajectory-server__validation_get' }),
        record({ agent_id: '' }),
        record({ agent_type: 'swe' }),
        record({}, { task_id: 'x', attempt_n: 1 }),
        record({}, { task_id: 42 }),
        record({}, { task_id: 999, attempt_n: 1 }),
        'not json',
      ]) {
        assert.deepEqual(reviewerIdentityObserve(payload, env()), ALLOWED);
      }
      assert.equal(auditRows(projectDb(), 'reviewer_identity_observed').length, before);
    });
    it('allows when no DB resolves and denies a corrupt one', () => {
      assert.deepEqual(reviewerIdentityObserve(record(), env({ TRAJECTORY_DB_PATH: '', CLAUDE_PROJECT_DIR: join(s, 'bare') })), ALLOWED);
      const bad = join(s, 'bad/.claude/tmb/trajectory.db');
      assert.match(denyReason(reviewerIdentityObserve(record(), env({ TRAJECTORY_DB_PATH: bad, CLAUDE_PROJECT_DIR: join(s, 'bad') })).stdout), /trajectory DB unavailable/);
    });
  });

  describe('cheatcode-install-approval', () => {
    before(() => buildSandbox(s));
    const install = (candidate: Record<string, unknown> | undefined, tool = 'mcp__plugin_tmb_trajectory-server__cheatcode_install'): string =>
      JSON.stringify({ tool_name: tool, tool_input: candidate === undefined ? {} : { candidate } });

    it('allows an approved source_url through node:sqlite, where the .sh denies every install without sqlite3', () => {
      assert.deepEqual(cheatcodeInstallApproval(install({ name: 'approved-skill', source_url: 'https://x.test/approved' }), env()), ALLOWED);
      assert.deepEqual(cheatcodeInstallApproval(install({ source_url: "https://x.test/o'brien" }), env()), ALLOWED);
    });
    it('denies an unapproved install without jq, where the .sh lets it through', () => {
      const r = cheatcodeInstallApproval(install({ name: 'other', source_url: 'https://x.test/other' }), env());
      assert.equal(denyReason(r.stdout), notApprovedReason('other', 'https://x.test/other'));
      assert.match(notApprovedReason('', 'https://u'), /cheatcode 'https:\/\/u' \(https:\/\/u\)/);
    });
    it('denies a missing source_url and an unverifiable DB', () => {
      assert.equal(denyReason(cheatcodeInstallApproval(install({ name: 'x' }), env()).stdout), NO_SOURCE_URL_REASON);
      assert.equal(denyReason(cheatcodeInstallApproval(install(undefined), env()).stdout), NO_SOURCE_URL_REASON);
      assert.equal(
        denyReason(cheatcodeInstallApproval(install({ source_url: 'https://x.test/approved' }), env({ TRAJECTORY_DB_PATH: '', CLAUDE_PROJECT_DIR: join(s, 'bare') })).stdout),
        UNVERIFIABLE_REASON,
      );
    });
    it('denies when the DB does not read', () => {
      const bad = env({ TRAJECTORY_DB_PATH: join(s, 'bad/.claude/tmb/trajectory.db'), CLAUDE_PROJECT_DIR: join(s, 'bad') });
      assert.equal(denyReason(cheatcodeInstallApproval(install({ source_url: 'https://x.test/approved' }), bad).stdout), notApprovedReason('', 'https://x.test/approved'));
    });
    it('allows other tools', () => {
      assert.deepEqual(cheatcodeInstallApproval(install({ source_url: 'https://x.test/other' }, 'mcp__plugin_tmb_trajectory-server__cheatcode_list'), env()), ALLOWED);
      assert.deepEqual(cheatcodeInstallApproval('not json', env()), ALLOWED);
    });
    it('quotes the source_url into the approval SQL', () => {
      assert.match(approvalSql("a'b"), /= 'a''b'/);
    });
  });
});
