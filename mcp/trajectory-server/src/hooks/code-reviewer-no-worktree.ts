/**
 * PreToolUse(Agent) gate (GH 1692), the port of
 * scripts/hooks/code-reviewer-no-worktree.sh, run by agent-spawn-dispatch.sh:
 * a code-reviewer spawn with isolation "worktree" is denied. code-reviewer is
 * the push gate and reviews the feature branch from the main checkout, not
 * from swe's per-task worktree. Other agent types, other tools and any other
 * isolation are allowed. Unlike the .sh, it needs no jq, so it denies on a
 * machine without jq where the .sh let the spawn through (decision 703).
 * Bypass: TMB_ALLOW_CODE_REVIEWER_WORKTREE=1.
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { jqCompact } from './lib/jq.js';
import { jqPath, jqRawOr } from './lib/lint-shell.js';
import { commandSubstitution } from './lib/project-env.js';
import { CODE_REVIEWER_ROLE, normalizeRole } from './lib/role.js';

export const GATE_NAME = 'code-reviewer-no-worktree';
export const BYPASS_ENV = 'TMB_ALLOW_CODE_REVIEWER_WORKTREE';

export const DENY_REASON =
  'code-reviewer must NOT run with isolation="worktree". The push gate reviews the FEATURE branch as it would land in origin — ' +
  "from the main checkout, not from SWE's per-task worktree. Bro works on the worktree branch as the task-close gate " +
  '(V1/V2/V3 + bro_atomic_close); code-reviewer reviews afterward, on the bare branch ref before push.\n\n' +
  'Spawn code-reviewer without isolation (defaults to none) or with an explicit non-worktree isolation. ' +
  `For exceptional override, set ${BYPASS_ENV}=1.`;

/** `$(echo "$INPUT" | jq -r '.<keys> // ""')` over the payload `INPUT=$(cat)` captured. */
export function spawnField(payload: string, ...keys: string[]): string {
  return jqRawOr(`${commandSubstitution(payload)}\n`, [jqPath(...keys)]);
}

/** Whether the payload is an Agent call spawning code-reviewer, namespaced or not. */
export function isCodeReviewerSpawn(payload: string): boolean {
  return spawnField(payload, 'tool_name') === 'Agent' && normalizeRole(spawnField(payload, 'tool_input', 'subagent_type')) === CODE_REVIEWER_ROLE;
}

/** The `jq -nc '{hookSpecificOutput: {…, permissionDecision: "deny", permissionDecisionReason: $reason}}'` line. */
export function spawnDeny(reason: string): GateResult {
  return {
    stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`,
    code: 0,
  };
}

export const codeReviewerNoWorktree: SyncGate = (payload, env) => {
  if (env[BYPASS_ENV] === '1') return ALLOW;
  if (!isCodeReviewerSpawn(payload)) return ALLOW;
  return spawnField(payload, 'tool_input', 'isolation') === 'worktree' ? spawnDeny(DENY_REASON) : ALLOW;
};
