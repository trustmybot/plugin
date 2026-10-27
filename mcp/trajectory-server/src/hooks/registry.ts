/**
 * The TypeScript hook gates, by name. dispatch.sh runs a gate through
 * `node dist/hooks.js <gate>` only when its name is a line of
 * dist/hooks-gates.txt, which the build writes from gateNames().
 */
import type { Gate } from './gate.js';
import { askuserquestionLengthLint } from './askuserquestion-length-lint.js';
import { GATE_NAME as BRO_TURN_USAGE_GATE, broTurnUsage } from './bro-turn-usage.js';
import { GATE_NAME as FOOTER_GATE, attributionFooter } from './attribution-footer.js';
import { GATE_NAME as CQ_LINT_GATE, codeQualityLint } from './code-quality-lint.js';
import { GATE_NAME as COMMIT_MSG_GATE, commitMsgLint } from './commit-msg-lint.js';
import { containmentGuard } from './containment-guard.js';
import { GATE_NAME as DRIFT_WARN_GATE, deferredToolsDriftWarn } from './deferred-tools-drift-warn.js';
import { GATE_NAME as ENSURE_GITIGNORE_GATE, ensureGitignore } from './ensure-gitignore.js';
import { ensureMcpDepsInstalled } from './ensure-mcp-deps-installed.js';
import { GATE_NAME as GIT_GUARDS_GATE, gitGuards } from './git-guards.js';
import { GATE_NAME as PUSH_GUARD_GATE, gitPushGuard } from './git-push-guard.js';
import { GATE_NAME as MCP_HEALTH_GATE, mcpHealthCheck } from './mcp-health-check.js';
import { GATE_NAME as PREFLIGHT_GATE, codeReviewerPreflight } from './code-reviewer-preflight.js';
import { GATE_NAME as SPAWN_NOTE_GATE, codeReviewerSpawnNote } from './code-reviewer-spawn-note.js';
import { GATE_NAME as REWORK_GATE, reworkLimit } from './rework-limit.js';
import { GATE_NAME as FEATURE_BRANCH_GATE, requireFeatureBranchActive } from './require-feature-branch-active.js';
import { GATE_NAME as SPAWN_EFFORT_GATE, requireSpawnEffort } from './require-spawn-effort.js';
import { GATE_NAME as TASK_SPEC_GATE, requireTaskSpec } from './require-task-spec.js';
import { GATE_NAME as SUBSTRATE_GATE, substratePreflight } from './substrate-preflight.js';
import { GATE_NAME as NAMING_LINT_GATE, namingLint } from './naming-lint.js';
import { GATE_NAME as SWE_BOUNDARY_GATE, sweBoundary } from './swe-boundary.js';
import { GATE_NAME as SWE_RESUME_GATE, sweResumeGate } from './swe-resume-gate.js';
import { GATE_NAME as SWE_STOP_CAUSE_GATE, sweStopCause } from './swe-stop-cause.js';
import { GATE_NAME as OVERRUN_GATE, taskOverrunAlert } from './task-overrun-alert.js';
import { GATE_NAME as ACTIVATION_GATE, activationRoutine } from './activation-routine.js';
import { GATE_NAME as DEBUG_TRAJECTORY_GATE, debugTrajectory } from './debug-trajectory.js';
import { GATE_NAME as PLUGIN_HOOKS_MARKER_GATE, pluginHooksMarker } from './plugin-hooks-marker.js';
import { GATE_NAME as SESSION_LOG_GATE, sessionLogCapture } from './session-log-capture.js';
import { GATE_NAME as SESSION_START_PERSONA_GATE, sessionStartPersona } from './session-start-persona.js';
import { GATE_NAME as USER_PROMPT_PERSONA_GATE, userPromptPersona } from './user-prompt-persona.js';
import { GATE_NAME as CONSULTANT_PERSISTENCE_GATE, consultantPersistenceGate } from './consultant-persistence-gate.js';
import { GATE_NAME as RT_AUQ_SHAPE_GATE, roundtableAuqShape } from './roundtable-auq-shape.js';
import { GATE_NAME as RT_CLEANUP_GATE, roundtableCleanupPostcheck } from './roundtable-cleanup-postcheck.js';
import { GATE_NAME as RT_SLASH_GATE, roundtableSlashDetect } from './roundtable-slash-detect.js';
import { GATE_NAME as TOOL_OUTPUT_SIZE_GATE, toolOutputSize } from './tool-output-size.js';
import { GATE_NAME as CR_NO_WORKTREE_GATE, codeReviewerNoWorktree } from './code-reviewer-no-worktree.js';
import { GATE_NAME as CR_PROMPT_SHAPE_GATE, codeReviewerSpawnPromptShape } from './code-reviewer-spawn-prompt-shape.js';
import { GATE_NAME as CR_AFTER_CLOSE_GATE, codeReviewerAfterAtomicClose } from './code-reviewer-after-atomic-close.js';
import { GATE_NAME as SWE_BRIEF_GATE, sweBriefGate } from './swe-brief-gate.js';
import { GATE_NAME as SWE_SPAWN_BIND_GATE, sweSpawnBind } from './swe-spawn-bind.js';
import { GATE_NAME as SWE_SPAWN_ROLLBACK_GATE, sweSpawnRollback } from './swe-spawn-rollback.js';
import { GATE_NAME as SPAWN_HINT_GATE, postTaskCreateSpawnHint } from './post-task-create-spawn-hint.js';
import { GATE_NAME as AGENT_ARG_GATE, agentArgMatchesCaller } from './agent-arg-matches-caller.js';
import { GATE_NAME as REVIEWER_IDENTITY_GATE, reviewerIdentityObserve } from './reviewer-identity-observe.js';
import { GATE_NAME as CHEATCODE_APPROVAL_GATE, cheatcodeInstallApproval } from './cheatcode-install-approval.js';
import { GATE_NAME as SWE_SCOPE_FENCE_GATE, sweScopeFence } from './swe-scope-fence.js';
import { GATE_NAME as SWE_ATOMIC_CLOSE_GATE, sweAtomicClose } from './swe-atomic-close.js';
import { GATE_NAME as TASK_CLOSE_RESCAN_GATE, postTaskCloseRescan } from './post-task-close-rescan.js';

const GATES: ReadonlyMap<string, Gate> = new Map<string, Gate>([
  ['askuserquestion-length-lint', askuserquestionLengthLint],
  [BRO_TURN_USAGE_GATE, broTurnUsage],
  [FOOTER_GATE, attributionFooter],
  [CQ_LINT_GATE, codeQualityLint],
  [COMMIT_MSG_GATE, commitMsgLint],
  ['containment-guard', containmentGuard],
  [DRIFT_WARN_GATE, deferredToolsDriftWarn],
  [ENSURE_GITIGNORE_GATE, ensureGitignore],
  ['ensure-mcp-deps-installed', ensureMcpDepsInstalled],
  [GIT_GUARDS_GATE, gitGuards],
  [PUSH_GUARD_GATE, gitPushGuard],
  [MCP_HEALTH_GATE, mcpHealthCheck],
  [PREFLIGHT_GATE, codeReviewerPreflight],
  [SPAWN_NOTE_GATE, codeReviewerSpawnNote],
  [REWORK_GATE, reworkLimit],
  [FEATURE_BRANCH_GATE, requireFeatureBranchActive],
  [SPAWN_EFFORT_GATE, requireSpawnEffort],
  [TASK_SPEC_GATE, requireTaskSpec],
  [SUBSTRATE_GATE, substratePreflight],
  [NAMING_LINT_GATE, namingLint],
  [SWE_BOUNDARY_GATE, sweBoundary],
  [SWE_RESUME_GATE, sweResumeGate],
  [SWE_STOP_CAUSE_GATE, sweStopCause],
  [OVERRUN_GATE, taskOverrunAlert],
  [ACTIVATION_GATE, activationRoutine],
  [DEBUG_TRAJECTORY_GATE, debugTrajectory],
  [PLUGIN_HOOKS_MARKER_GATE, pluginHooksMarker],
  [SESSION_LOG_GATE, sessionLogCapture],
  [SESSION_START_PERSONA_GATE, sessionStartPersona],
  [USER_PROMPT_PERSONA_GATE, userPromptPersona],
  [CONSULTANT_PERSISTENCE_GATE, consultantPersistenceGate],
  [RT_AUQ_SHAPE_GATE, roundtableAuqShape],
  [RT_CLEANUP_GATE, roundtableCleanupPostcheck],
  [RT_SLASH_GATE, roundtableSlashDetect],
  [TOOL_OUTPUT_SIZE_GATE, toolOutputSize],
  [CR_NO_WORKTREE_GATE, codeReviewerNoWorktree],
  [CR_PROMPT_SHAPE_GATE, codeReviewerSpawnPromptShape],
  [CR_AFTER_CLOSE_GATE, codeReviewerAfterAtomicClose],
  [SWE_BRIEF_GATE, sweBriefGate],
  [SWE_SPAWN_BIND_GATE, sweSpawnBind],
  [SWE_SPAWN_ROLLBACK_GATE, sweSpawnRollback],
  [SPAWN_HINT_GATE, postTaskCreateSpawnHint],
  [AGENT_ARG_GATE, agentArgMatchesCaller],
  [REVIEWER_IDENTITY_GATE, reviewerIdentityObserve],
  [CHEATCODE_APPROVAL_GATE, cheatcodeInstallApproval],
  [SWE_SCOPE_FENCE_GATE, sweScopeFence],
  [SWE_ATOMIC_CLOSE_GATE, sweAtomicClose],
  [TASK_CLOSE_RESCAN_GATE, postTaskCloseRescan],
]);

export function findGate(name: string): Gate | undefined {
  return GATES.get(name);
}

export function gateNames(): string[] {
  return [...GATES.keys()].sort();
}
