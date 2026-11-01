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
import { GATE_NAME as REWORK_WAIVER_GATE, reworkWaiverCapture } from './rework-waiver-capture.js';
import { GATE_NAME as CONSULTANT_PERSISTENCE_GATE, consultantPersistenceGate } from './consultant-persistence-gate.js';
import { GATE_NAME as RT_AUQ_SHAPE_GATE, roundtableAuqShape } from './roundtable-auq-shape.js';
import { GATE_NAME as RT_CLEANUP_GATE, roundtableCleanupPostcheck } from './roundtable-cleanup-postcheck.js';
import { GATE_NAME as RT_SLASH_GATE, roundtableSlashDetect } from './roundtable-slash-detect.js';
import { GATE_NAME as TOOL_OUTPUT_SIZE_GATE, toolOutputSize } from './tool-output-size.js';
import { GATE_NAME as CR_NO_WORKTREE_GATE, codeReviewerNoWorktree } from './code-reviewer-no-worktree.js';
import { GATE_NAME as CR_PROMPT_SHAPE_GATE, codeReviewerSpawnPromptShape } from './code-reviewer-spawn-prompt-shape.js';
import { GATE_NAME as CR_AFTER_CLOSE_GATE, codeReviewerAfterAtomicClose } from './code-reviewer-after-atomic-close.js';
import { GATE_NAME as SWE_VERIFICATION_GATE, sweVerificationGate } from './swe-verification-gate.js';
import { GATE_NAME as SWE_BRIEF_GATE, sweBriefGate } from './swe-brief-gate.js';
import { GATE_NAME as SWE_SPAWN_BIND_GATE, sweSpawnBind } from './swe-spawn-bind.js';
import { GATE_NAME as SWE_SPAWN_ROLLBACK_GATE, sweSpawnRollback } from './swe-spawn-rollback.js';
import { GATE_NAME as SPAWN_HINT_GATE, postTaskCreateSpawnHint } from './post-task-create-spawn-hint.js';
import { GATE_NAME as AGENT_ARG_GATE, agentArgMatchesCaller } from './agent-arg-matches-caller.js';
import { GATE_NAME as REVIEWER_IDENTITY_GATE, reviewerIdentityObserve } from './reviewer-identity-observe.js';
import { GATE_NAME as CHEATCODE_APPROVAL_GATE, cheatcodeInstallApproval } from './cheatcode-install-approval.js';
import { GATE_NAME as STAY_ON_BASE_GATE, stayOnBaseGuard } from './stay-on-base-guard.js';
import { GATE_NAME as BRANCH_UP_TO_DATE_GATE, branchUpToDateWithRemote } from './branch-up-to-date-with-remote.js';
import { GATE_NAME as NO_WORKTREE_BRANCH_CREATE_GATE, noWorktreeBranchCreate } from './no-worktree-branch-create.js';
import { GATE_NAME as NO_REMOTE_AUTH_GATE, noRemoteAuthGuard } from './no-remote-auth-guard.js';
import { GATE_NAME as PROMPT_INTENT_GATE, promptIntentHints } from './prompt-intent-hints.js';
import { GATE_NAME as SWE_SCOPE_FENCE_GATE, sweScopeFence } from './swe-scope-fence.js';
import { GATE_NAME as ORPHAN_SCAN_GATE, orphanScan } from './orphan-scan.js';
import { GATE_NAME as SESSION_START_PRESCAN_GATE, sessionStartPrescan } from './session-start-prescan.js';
import { GATE_NAME as CLEAN_MERGED_GATE, cleanMergedBranch } from './clean-merged-branch.js';
import { GATE_NAME as CLOSE_ISSUE_GATE, closeIssueOnMerge } from './close-issue-on-merge.js';
import { GATE_NAME as SWE_ATOMIC_CLOSE_GATE, sweAtomicClose } from './swe-atomic-close.js';
import { GATE_NAME as TASK_CLOSE_RESCAN_GATE, postTaskCloseRescan } from './post-task-close-rescan.js';
import { GATE_NAME as README_STALENESS_GATE, postAtomicCloseReadme } from './post-atomic-close-readme.js';
import { GATE_NAME as AGENT_SPAWN_DISPATCH_GATE, agentSpawnDispatch } from './agent-spawn-dispatch.js';
import { GATE_NAME as ENSURE_SWE_WORKTREE_GATE, ensureSweWorktree } from './ensure-swe-worktree.js';
import { GATE_NAME as RECORD_SWE_SPAWN_GATE, recordSweSpawn } from './record-swe-spawn.js';
import { GATE_NAME as CLEANUP_WORKTREE_GATE, cleanupWorktreeOnTaskClose } from './cleanup-worktree-on-task-close.js';
import { GATE_NAME as WORKTREE_CREATE_GATE, worktreeCreate } from './worktree-create.js';
import { GATE_NAME as REMOTE_ID_GATE, remoteIdGuard } from './remote-id-guard.js';
import { GATE_NAME as NO_SOURCE_EDIT_GATE, noSourceEditFromMain } from './no-source-edit-from-main.js';

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
  [REWORK_WAIVER_GATE, reworkWaiverCapture],
  [CONSULTANT_PERSISTENCE_GATE, consultantPersistenceGate],
  [RT_AUQ_SHAPE_GATE, roundtableAuqShape],
  [RT_CLEANUP_GATE, roundtableCleanupPostcheck],
  [RT_SLASH_GATE, roundtableSlashDetect],
  [TOOL_OUTPUT_SIZE_GATE, toolOutputSize],
  [CR_NO_WORKTREE_GATE, codeReviewerNoWorktree],
  [CR_PROMPT_SHAPE_GATE, codeReviewerSpawnPromptShape],
  [CR_AFTER_CLOSE_GATE, codeReviewerAfterAtomicClose],
  [SWE_VERIFICATION_GATE, sweVerificationGate],
  [SWE_BRIEF_GATE, sweBriefGate],
  [SWE_SPAWN_BIND_GATE, sweSpawnBind],
  [SWE_SPAWN_ROLLBACK_GATE, sweSpawnRollback],
  [SPAWN_HINT_GATE, postTaskCreateSpawnHint],
  [AGENT_ARG_GATE, agentArgMatchesCaller],
  [REVIEWER_IDENTITY_GATE, reviewerIdentityObserve],
  [CHEATCODE_APPROVAL_GATE, cheatcodeInstallApproval],
  [STAY_ON_BASE_GATE, stayOnBaseGuard],
  [BRANCH_UP_TO_DATE_GATE, branchUpToDateWithRemote],
  [NO_WORKTREE_BRANCH_CREATE_GATE, noWorktreeBranchCreate],
  [NO_REMOTE_AUTH_GATE, noRemoteAuthGuard],
  [PROMPT_INTENT_GATE, promptIntentHints],
  [SWE_SCOPE_FENCE_GATE, sweScopeFence],
  [ORPHAN_SCAN_GATE, orphanScan],
  [SESSION_START_PRESCAN_GATE, sessionStartPrescan],
  [CLEAN_MERGED_GATE, cleanMergedBranch],
  [CLOSE_ISSUE_GATE, closeIssueOnMerge],
  [SWE_ATOMIC_CLOSE_GATE, sweAtomicClose],
  [TASK_CLOSE_RESCAN_GATE, postTaskCloseRescan],
  [README_STALENESS_GATE, postAtomicCloseReadme],
  [AGENT_SPAWN_DISPATCH_GATE, (payload, env) => agentSpawnDispatch(payload, env, findGate)],
  [ENSURE_SWE_WORKTREE_GATE, ensureSweWorktree],
  [RECORD_SWE_SPAWN_GATE, recordSweSpawn],
  [CLEANUP_WORKTREE_GATE, cleanupWorktreeOnTaskClose],
  [WORKTREE_CREATE_GATE, worktreeCreate],
  [REMOTE_ID_GATE, remoteIdGuard],
  [NO_SOURCE_EDIT_GATE, noSourceEditFromMain],
]);

export function findGate(name: string): Gate | undefined {
  return GATES.get(name);
}

export function gateNames(): string[] {
  return [...GATES.keys()].sort();
}

/*
 * The router (GH 1692): `node dist/hooks.js <event>` runs the gates of the one
 * group whose event and matcher fit the payload, one after another in this
 * order, each within its budget from router/budgets.json. A matcher is the
 * text of that group's hooks.json entry; matchers do not overlap, so each call
 * starts one process. A tool no group matches runs no gates.
 */
import ROUTER_BUDGETS from './router/budgets.json' with { type: 'json' };

export type RouterGateKind = 'enforcement' | 'advisory';

export interface RouterGate {
  readonly name: string;
  readonly kind: RouterGateKind;
  readonly budgetMs: number;
  /** Runs only for a tool_name ending in `trajectory-server__<toolSuffix>`; absent, for every tool of its group. */
  readonly toolSuffix?: string;
}

export interface RouterGroup {
  readonly event: string;
  readonly matcher: string;
  readonly gates: readonly RouterGate[];
  /**
   * The time one call's gates share (decision 922): each gate's deadline is the
   * smaller of its budget and what is left of this, and a gate that starts with
   * none left is not run.
   */
  readonly groupBudgetMs: number;
  /** The first deny ends the call, as a dispatch.sh chain does: the later gates' side effects never happen. */
  readonly stopAtFirstDeny?: boolean;
}

function routerGate(name: string, kind: RouterGateKind, toolSuffix?: string): RouterGate {
  const budgets: Record<string, { budget_ms: number }> = ROUTER_BUDGETS.gates;
  return { name, kind, budgetMs: budgets[name].budget_ms, ...(toolSuffix === undefined ? {} : { toolSuffix }) };
}

function preToolUseGroup(matcher: string, gates: readonly RouterGate[], opts: { stopAtFirstDeny?: boolean } = {}): RouterGroup {
  const budgets: Record<string, { group_budget_ms: number }> = ROUTER_BUDGETS.groups;
  return { event: 'PreToolUse', matcher, gates, groupBudgetMs: budgets[matcher].group_budget_ms, ...opts };
}

export const ROUTER_GROUPS: readonly RouterGroup[] = [
  preToolUseGroup('Write|Edit|MultiEdit|NotebookEdit', [
    routerGate('containment-guard', 'enforcement'),
    routerGate(SWE_BRIEF_GATE, 'enforcement'),
    routerGate(NO_SOURCE_EDIT_GATE, 'enforcement'),
    routerGate(SWE_BOUNDARY_GATE, 'enforcement'),
    routerGate(SWE_SCOPE_FENCE_GATE, 'advisory'),
    routerGate(NAMING_LINT_GATE, 'advisory'),
    routerGate(CQ_LINT_GATE, 'advisory'),
    routerGate(DEBUG_TRAJECTORY_GATE, 'advisory'),
  ]),
  preToolUseGroup('Bash', [
    routerGate('containment-guard', 'enforcement'),
    routerGate(GIT_GUARDS_GATE, 'enforcement'),
    routerGate(PUSH_GUARD_GATE, 'enforcement'),
    routerGate(SWE_BOUNDARY_GATE, 'enforcement'),
    routerGate(NO_WORKTREE_BRANCH_CREATE_GATE, 'enforcement'),
    routerGate(STAY_ON_BASE_GATE, 'enforcement'),
    routerGate(BRANCH_UP_TO_DATE_GATE, 'enforcement'),
    routerGate(COMMIT_MSG_GATE, 'advisory'),
    routerGate(NO_REMOTE_AUTH_GATE, 'enforcement'),
    routerGate(REMOTE_ID_GATE, 'enforcement'),
    routerGate(DEBUG_TRAJECTORY_GATE, 'advisory'),
  ]),
  preToolUseGroup('Agent', [routerGate(AGENT_SPAWN_DISPATCH_GATE, 'enforcement'), routerGate(DEBUG_TRAJECTORY_GATE, 'advisory')]),
  preToolUseGroup('SendMessage', [routerGate(SWE_RESUME_GATE, 'enforcement')]),
  preToolUseGroup(
    'mcp__.*trajectory-server__.*',
    [
      routerGate(AGENT_ARG_GATE, 'enforcement'),
      routerGate(SWE_BRIEF_GATE, 'enforcement'),
      routerGate(SWE_VERIFICATION_GATE, 'enforcement', 'task_update_status'),
      routerGate(REVIEWER_IDENTITY_GATE, 'enforcement', 'validation_record'),
      routerGate(CHEATCODE_APPROVAL_GATE, 'enforcement', 'cheatcode_install'),
    ],
    { stopAtFirstDeny: true },
  ),
  preToolUseGroup('AskUserQuestion', [routerGate('askuserquestion-length-lint', 'advisory'), routerGate(RT_AUQ_SHAPE_GATE, 'advisory')]),
  preToolUseGroup('Read|Skill', [routerGate(DEBUG_TRAJECTORY_GATE, 'advisory')]),
];

export function routerEvents(): ReadonlySet<string> {
  return new Set(ROUTER_GROUPS.map((g) => g.event));
}

/** Whether <matcher>, hooks.json regex text, matches the whole of <tool>. */
export function matcherFits(matcher: string, tool: string): boolean {
  return new RegExp(`^(?:${matcher})$`).test(tool);
}

/** The group serving a call: the first whose event and matcher fit. */
export function routerGroup(event: string, tool: string, groups: readonly RouterGroup[] = ROUTER_GROUPS): RouterGroup | undefined {
  return groups.find((g) => g.event === event && matcherFits(g.matcher, tool));
}

/** The gates a call runs: its group's, less those whose tool filter excludes <tool>, in group order. */
export function routerGates(event: string, tool: string, groups: readonly RouterGroup[] = ROUTER_GROUPS): RouterGate[] {
  const gates = routerGroup(event, tool, groups)?.gates ?? [];
  return gates.filter((g) => g.toolSuffix === undefined || tool.endsWith(`trajectory-server__${g.toolSuffix}`));
}

/** The router's hooks.json timeout (s) for <group>: the parse allowance plus its group budget, rounded up, plus 1 s. */
export function routerTimeoutS(group: Pick<RouterGroup, 'groupBudgetMs'>): number {
  return Math.ceil((ROUTER_BUDGETS.parse_allowance_ms + group.groupBudgetMs) / 1000) + 1;
}
