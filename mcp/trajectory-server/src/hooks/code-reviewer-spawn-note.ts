/**
 * PreToolUse(Agent) gate (GH 1744), run by agent-spawn-dispatch.sh right
 * before code-reviewer-preflight: a code-reviewer spawn prompt carries the
 * name=value anchors (task_id, commit_sha, branch_id, repo, repo_path,
 * attempt_n, subagent_session_id) and at most SPAWN_NOTE_MAX_CHARS of other
 * prose. The reviewer reads the spec, discussions and swe's completion report
 * from task_brief; anything else bro wants it to know goes into spawn_note via
 * bro_atomic_close, which task_brief returns. Other agent types are allowed
 * untouched. Bypass: TMB_SKIP_CODE_REVIEWER_SPAWN_NOTE=1.
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';
import { SPAWN_NOTE_MAX_CHARS } from '../success-criteria.js';

export const GATE_NAME = 'code-reviewer-spawn-note';
export const BYPASS_ENV = 'TMB_SKIP_CODE_REVIEWER_SPAWN_NOTE';

export const ANCHORS = ['task_id', 'commit_sha', 'branch_id', 'repo', 'repo_path', 'attempt_n', 'subagent_session_id'] as const;

const ANCHOR_RE = new RegExp(`\\b(?:${ANCHORS.join('|')})\\s*=\\s*(?:'[^']*'|"[^"]*"|\`[^\`]*\`|\\S+)`, 'g');

/** The spawn prompt's prose once the anchors are stripped and whitespace collapsed. */
export function spawnProse(prompt: string): string {
  return prompt.replace(ANCHOR_RE, ' ').replace(/\s+/g, ' ').trim();
}

export function denyReason(proseChars: number): string {
  return (
    `BLOCKED: the code-reviewer spawn prompt carries ${proseChars} characters of prose beyond its anchors ` +
    `(${ANCHORS.map((a) => `${a}=`).join(', ')}); the cap is ${SPAWN_NOTE_MAX_CHARS}. The reviewer reads the spec, ` +
    "discussions and swe's completion report from task_brief. Store the remaining context as spawn_note " +
    `(at most ${SPAWN_NOTE_MAX_CHARS} chars) with bro_atomic_close, where task_brief returns it, and respawn with the anchors ` +
    `and at most ${SPAWN_NOTE_MAX_CHARS} chars of prose.`
  );
}

function deny(reason: string): GateResult {
  return {
    stdout: `${jqCompact({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    })}\n`,
    code: 0,
  };
}

export const codeReviewerSpawnNote: SyncGate = (payload, env) => {
  if (env[BYPASS_ENV] === '1') return ALLOW;
  if (jqAlternatives(payload, [['tool_name']]) !== 'Agent') return ALLOW;
  if (normalizeRole(jqAlternatives(payload, [['tool_input', 'subagent_type']])) !== 'code-reviewer') return ALLOW;
  const prose = spawnProse(jqAlternatives(payload, [['tool_input', 'prompt']]));
  return prose.length > SPAWN_NOTE_MAX_CHARS ? deny(denyReason(prose.length)) : ALLOW;
};
