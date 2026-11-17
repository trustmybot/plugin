/**
 * PreToolUse(Agent) gate (GH 1744), run by agent-spawn-dispatch right
 * before code-reviewer-preflight: a code-reviewer spawn prompt carries the
 * name=value anchors (task_id, commit_sha, branch_id, repo, repo_path,
 * attempt_n, subagent_session_id), or a grouped review's BATCH_ANCHORS, and at
 * most SPAWN_NOTE_MAX_CHARS of other prose. The reviewer reads the spec, discussions and swe's completion report
 * from task_brief; anything else bro wants it to know goes into spawn_note via
 * review_handoff, which task_brief returns. Other agent types are allowed
 * untouched. Bypass: TMB_SKIP_CODE_REVIEWER_SPAWN_NOTE=1.
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { type DenyFix, denyResult } from './lib/deny.js';
import { jqAlternatives } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';
import { SPAWN_NOTE_MAX_CHARS } from '../success-criteria.js';

export const GATE_NAME = 'code-reviewer-spawn-note';
export const BYPASS_ENV = 'TMB_SKIP_CODE_REVIEWER_SPAWN_NOTE';

export const ANCHORS = ['task_id', 'commit_sha', 'branch_id', 'repo', 'repo_path', 'attempt_n', 'subagent_session_id'] as const;

/** The anchors of a grouped agile review, which review_batch_handoff hands off instead of one task. */
export const BATCH_ANCHORS = ['batch_handoff_id', 'feature_branch', 'head_sha', 'repo', 'repo_path', 'subagent_session_id'] as const;

const STRIPPED = [...new Set<string>([...ANCHORS, ...BATCH_ANCHORS])];
const ANCHOR_RE = new RegExp(`\\b(?:${STRIPPED.join('|')})\\s*=\\s*(?:'[^']*'|"[^"]*"|\`[^\`]*\`|\\S+)`, 'g');

/** The spawn prompt's prose once the anchors are stripped and whitespace collapsed. */
export function spawnProse(prompt: string): string {
  return prompt.replace(ANCHOR_RE, ' ').replace(/\s+/g, ' ').trim();
}

export function denyReason(proseChars: number): string {
  return (
    `BLOCKED: the code-reviewer spawn prompt carries ${proseChars} characters of prose beyond its anchors ` +
    `(${ANCHORS.map((a) => `${a}=`).join(', ')}); the cap is ${SPAWN_NOTE_MAX_CHARS}. The reviewer reads the spec, ` +
    "discussions and swe's completion report from task_brief, and review_handoff's spawn_note carries the rest."
  );
}

const SPAWN_NOTE_FIX: DenyFix = {
  allowed: 'the same spawn with reviewer_spawn.prompt exactly as review_handoff returned it (anchors only); to add a note, review_handoff(spawn_note=...) again',
};

function deny(reason: string): GateResult {
  return denyResult(reason, SPAWN_NOTE_FIX);
}

export const codeReviewerSpawnNote: SyncGate = (payload, env) => {
  if (env[BYPASS_ENV] === '1') return ALLOW;
  if (jqAlternatives(payload, [['tool_name']]) !== 'Agent') return ALLOW;
  if (normalizeRole(jqAlternatives(payload, [['tool_input', 'subagent_type']])) !== 'code-reviewer') return ALLOW;
  const prose = spawnProse(jqAlternatives(payload, [['tool_input', 'prompt']]));
  return prose.length > SPAWN_NOTE_MAX_CHARS ? deny(denyReason(prose.length)) : ALLOW;
};
