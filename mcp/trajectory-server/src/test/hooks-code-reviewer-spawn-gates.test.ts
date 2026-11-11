/**
 * Unit tests of the TypeScript code-reviewer Agent-spawn gates (GH 1692):
 * code-reviewer-no-worktree, code-reviewer-spawn-prompt-shape and
 * code-reviewer-after-atomic-close. They cover each allow and deny branch,
 * the grep locale semantics the parity corpus leans on, and the divergences
 * from the .sh that decision 703 allows (no jq, no sqlite3 CLI).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGate, gateNames } from '../hooks/registry.js';
import { ANCHORS } from '../hooks/code-reviewer-spawn-note.js';
import { commandOnPath } from '../hooks/lib/persona.js';
import { codeReviewerNoWorktree, DENY_FIX, DENY_REASON } from '../hooks/code-reviewer-no-worktree.js';
import {
  codeReviewerSpawnPromptShape,
  missingAnchors,
  missingAnchorsFix,
  missingAnchorsReason,
  RUBBER_STAMP_FIX,
  rubberStampPhrase,
  rubberStampReason,
} from '../hooks/code-reviewer-spawn-prompt-shape.js';
import { codeReviewerAfterAtomicClose, notHandedOffFix, notHandedOffReason, promptTaskId } from '../hooks/code-reviewer-after-atomic-close.js';
import { fixedReason } from '../hooks/lib/deny.js';
import { buildSandbox } from './hooks-reviewer-spawn-parity.suite.js';

const ALLOWED = { stdout: '', code: 0 };
const ANCHORED = (id: number): string => ANCHORS.map((a) => `${a}=${a === 'task_id' ? id : 'x'}`).join(' ');

function spawn(toolInput: Record<string, unknown>, tool = 'Agent'): string {
  return JSON.stringify({ tool_name: tool, tool_input: toolInput });
}

function denyReason(stdout: string): string {
  assert.ok(stdout.endsWith('\n'));
  const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('code-reviewer spawn gates are registered', () => {
  for (const name of ['code-reviewer-no-worktree', 'code-reviewer-spawn-prompt-shape', 'code-reviewer-after-atomic-close']) {
    it(`${name} is a gate dist/hooks-gates.txt lists`, () => {
      assert.ok(findGate(name));
      assert.ok(gateNames().includes(name));
    });
  }
  it('maps each name to its gate', () => {
    assert.equal(findGate('code-reviewer-no-worktree'), codeReviewerNoWorktree);
    assert.equal(findGate('code-reviewer-spawn-prompt-shape'), codeReviewerSpawnPromptShape);
    assert.equal(findGate('code-reviewer-after-atomic-close'), codeReviewerAfterAtomicClose);
  });
});

describe('code-reviewer-no-worktree', () => {
  const env = { PATH: '' };
  it('denies a code-reviewer spawn in a worktree, plain or namespaced', () => {
    for (const subagent_type of ['code-reviewer', 'tmb:code-reviewer']) {
      const r = codeReviewerNoWorktree(spawn({ subagent_type, isolation: 'worktree' }), env);
      assert.equal(r.code, 0);
      assert.equal(denyReason(r.stdout), fixedReason(DENY_REASON, DENY_FIX));
    }
  });
  it('names the review_handoff → code-reviewer → bro_atomic_close order, not the retired section-6 checks (GH 2866)', () => {
    assert.ok(DENY_REASON.includes('The order on SWE return is review_handoff → code-reviewer → bro_atomic_close'), DENY_REASON);
    assert.ok(!DENY_REASON.includes('four checks'), DENY_REASON);
    assert.ok(!DENY_REASON.includes('V1/V2/V3'), DENY_REASON);
  });
  it('allows other isolation values, other agents and other tools', () => {
    assert.deepEqual(codeReviewerNoWorktree(spawn({ subagent_type: 'code-reviewer' }), env), ALLOWED);
    assert.deepEqual(codeReviewerNoWorktree(spawn({ subagent_type: 'code-reviewer', isolation: 'Worktree' }), env), ALLOWED);
    assert.deepEqual(codeReviewerNoWorktree(spawn({ subagent_type: 'swe', isolation: 'worktree' }), env), ALLOWED);
    assert.deepEqual(codeReviewerNoWorktree(spawn({ subagent_type: 'code-reviewer', isolation: 'worktree' }, 'Bash'), env), ALLOWED);
  });
  it('allows input jq cannot read as one object', () => {
    const one = spawn({ subagent_type: 'code-reviewer', isolation: 'worktree' });
    assert.deepEqual(codeReviewerNoWorktree('not json {', env), ALLOWED);
    assert.deepEqual(codeReviewerNoWorktree(`${one}\n${one}\n`, env), ALLOWED);
  });
  it('allows only under TMB_ALLOW_CODE_REVIEWER_WORKTREE=1', () => {
    const p = spawn({ subagent_type: 'code-reviewer', isolation: 'worktree' });
    assert.deepEqual(codeReviewerNoWorktree(p, { ...env, TMB_ALLOW_CODE_REVIEWER_WORKTREE: '1' }), ALLOWED);
    assert.notDeepEqual(codeReviewerNoWorktree(p, { ...env, TMB_ALLOW_CODE_REVIEWER_WORKTREE: 'true' }), ALLOWED);
  });
});

describe('code-reviewer-spawn-prompt-shape', () => {
  const env = { PATH: '', LC_ALL: 'C' };
  const cr = (prompt?: string): string => spawn(prompt === undefined ? { subagent_type: 'code-reviewer' } : { subagent_type: 'code-reviewer', prompt });

  it('allows a prompt carrying every anchor and no shortcut', () => {
    assert.deepEqual(codeReviewerSpawnPromptShape(cr(`${ANCHORED(13)}\nReview it.`), env), ALLOWED);
  });
  it('denies the missing anchors in ANCHORS order, before any shortcut', () => {
    const missing = (anchors: readonly string[]): string => fixedReason(missingAnchorsReason(anchors), missingAnchorsFix(anchors));
    assert.equal(denyReason(codeReviewerSpawnPromptShape(cr(), env).stdout), missing([...ANCHORS]));
    assert.equal(denyReason(codeReviewerSpawnPromptShape(cr('task_id=1 rubber stamp'), env).stdout), missing(ANCHORS.slice(1)));
    assert.match(missingAnchorsReason(['repo']), /missing required anchors: repo\.\n\nPer tmb_push-gate, the prompt MUST contain task_id, commit_sha, .*, and subagent_session_id, each as name=value/);
  });
  it('needs a non-word character or line start before an anchor', () => {
    assert.deepEqual(missingAnchors(ANCHORED(1).replace('task_id=', 'subtask_id='), false), ['task_id']);
    assert.deepEqual(missingAnchors(ANCHORED(1).replace('task_id=', '-task_id='), false), []);
    assert.deepEqual(missingAnchors(ANCHORED(1).replace(' repo=x', ''), false), ['repo']);
  });
  it('reads a non-ASCII letter as a word character only under a UTF-8 locale', () => {
    const prompt = ANCHORED(1).replace('task_id=', 'étask_id=');
    assert.deepEqual(missingAnchors(prompt, false), []);
    assert.deepEqual(missingAnchors(prompt, true), ['task_id']);
  });
  it('denies the first shortcut phrase, folding ASCII case only', () => {
    const r = codeReviewerSpawnPromptShape(cr(`${ANCHORED(13)}\nTrust The PRIOR Verdict`), env);
    assert.equal(denyReason(r.stdout), fixedReason(rubberStampReason('trust the prior verdict'), RUBBER_STAMP_FIX));
    assert.equal(rubberStampPhrase('just rubber-stamp it', false), 'rubber.stamp');
    assert.equal(rubberStampPhrase('the prior verdict', false), 'prior verdict');
    assert.equal(rubberStampPhrase('FAST-TRACK IF green', false), 'fast-track if');
    assert.equal(rubberStampPhrase('fast-tracK if', true), null);
    assert.equal(rubberStampPhrase('rubber\nstamp', false), null);
  });
  it('matches one byte for rubber.stamp under C, one character under UTF-8', () => {
    assert.equal(rubberStampPhrase('rubber—stamp', false), null);
    assert.equal(rubberStampPhrase('rubber—stamp', true), 'rubber.stamp');
    assert.equal(rubberStampPhrase('rubberéstamp', false), null);
  });
  it('allows other agents and TMB_SKIP_CODE_REVIEWER_PROMPT_SHAPE=1', () => {
    assert.deepEqual(codeReviewerSpawnPromptShape(spawn({ subagent_type: 'swe', prompt: 'x' }), env), ALLOWED);
    assert.deepEqual(codeReviewerSpawnPromptShape(cr('x'), { ...env, TMB_SKIP_CODE_REVIEWER_PROMPT_SHAPE: '1' }), ALLOWED);
  });
});

describe('code-reviewer-after-atomic-close', () => {
  let base: string;
  let s: string;
  let emptyBin: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-reviewer-spawn-gates-')));
    s = join(base, 'sandbox');
    emptyBin = join(base, 'empty-bin');
    mkdirSync(emptyBin);
    buildSandbox(s);
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: join(s, 'project/.claude/tmb/trajectory.db'),
    PATH: emptyBin,
    LC_ALL: 'C',
    ...extra,
  });
  const cr = (prompt: string, subagent_type = 'code-reviewer'): string => spawn({ subagent_type, prompt });

  it('the PATH under test holds neither jq nor sqlite3', () => {
    assert.equal(commandOnPath('jq', env()), false);
    assert.equal(commandOnPath('sqlite3', env()), false);
  });
  it('denies a task not handed off at its current commit through node:sqlite, where the .sh lets the spawn through without jq or sqlite3', () => {
    const notHandedOff = (id: string, status: string): string => fixedReason(notHandedOffReason(id, status), notHandedOffFix(id));
    assert.equal(denyReason(codeReviewerAfterAtomicClose(cr(ANCHORED(13)), env()).stdout), notHandedOff('13', 'running'));
    assert.equal(denyReason(codeReviewerAfterAtomicClose(cr(ANCHORED(12)), env()).stdout), notHandedOff('12', 'completed'));
    assert.equal(denyReason(codeReviewerAfterAtomicClose(cr('task_id=14', 'tmb:code-reviewer'), env()).stdout), notHandedOff('14', 'needs_validation'));
  });
  it('names tmb_planning section 6 and the verify, hand off, review, close order (GH 2866)', () => {
    const reason = notHandedOffReason('13', 'running');
    assert.ok(reason.includes('Per tmb_planning section 6 (Verify on SWE return + review handoff):\n'), reason);
    assert.ok(reason.includes('  2. bro verifies the return (task_brief + git diff, the four section-6 checks), then calls review_handoff.\n'), reason);
    assert.ok(reason.includes('bro_atomic_close follows its pass'), reason);
    assert.ok(fixedReason(reason, notHandedOffFix('13')).includes("Allowed form: review_handoff(agent='bro', task_id=13,"), reason);
    assert.doesNotMatch(reason, /Step 5|V1|V2|V3/);
  });
  it('allows a completed task handed off at its current commit', () => {
    assert.deepEqual(codeReviewerAfterAtomicClose(cr(ANCHORED(15)), env()), ALLOWED);
  });
  it('allows a closed task, a missing row, no task_id and no DB', () => {
    assert.deepEqual(codeReviewerAfterAtomicClose(cr(ANCHORED(11)), env()), ALLOWED);
    assert.deepEqual(codeReviewerAfterAtomicClose(cr(ANCHORED(99)), env()), ALLOWED);
    assert.deepEqual(codeReviewerAfterAtomicClose(cr('review the branch'), env()), ALLOWED);
    assert.deepEqual(codeReviewerAfterAtomicClose(cr('task_id=99999999999999999999'), env()), ALLOWED);
    assert.deepEqual(codeReviewerAfterAtomicClose(cr(ANCHORED(13)), env({ TRAJECTORY_DB_PATH: join(s, 'fresh/.claude/tmb/trajectory.db') })), ALLOWED);
    assert.deepEqual(codeReviewerAfterAtomicClose(cr(ANCHORED(13)), env({ TRAJECTORY_DB_PATH: join(s, 'none.db') })), ALLOWED);
  });
  it('denies a corrupt DB, naming the DB it could not read', () => {
    const bad = join(s, 'bad/.claude/tmb/trajectory.db');
    assert.equal(
      denyReason(codeReviewerAfterAtomicClose(cr(ANCHORED(13)), env({ TRAJECTORY_DB_PATH: bad })).stdout),
      `BLOCKED: trajectory DB unavailable — code-reviewer-after-atomic-close could not read ${bad} (read error: busy, corrupt, or unreadable), so it refuses to fail open. Check the trajectory DB and retry. Allowed form: the same call again, once the trajectory DB reads`,
    );
  });
  it('allows other agents and TMB_SKIP_CODE_REVIEWER_CLOSE_GATE=1', () => {
    assert.deepEqual(codeReviewerAfterAtomicClose(cr(ANCHORED(13), 'swe'), env()), ALLOWED);
    assert.deepEqual(codeReviewerAfterAtomicClose(cr(ANCHORED(13)), env({ TMB_SKIP_CODE_REVIEWER_CLOSE_GATE: '1' })), ALLOWED);
  });
  it('takes the first task_id=<digits> line by line, spaces allowed around =', () => {
    assert.equal(promptTaskId('task_id=abc\nsee task_id=11 then task_id=13', false), '11');
    assert.equal(promptTaskId('task_id = \t013', false), '013');
    assert.equal(promptTaskId('subtask_id=12', false), '12');
    assert.equal(promptTaskId('task_id\n=13', false), '');
  });
  it('reads NBSP as a space only under a UTF-8 locale', () => {
    assert.equal(promptTaskId('task_id =13', false), '');
    assert.equal(promptTaskId('task_id =13', true), '13');
  });
});
