/**
 * The TypeScript hook gates, by name. The build writes gateNames() to
 * dist/hooks-gates.txt, and `node dist/hooks.js <gate>` runs one directly.
 */
import type { Gate } from './gate.js';
import { askuserquestionLengthLint } from './askuserquestion-length-lint.js';
import { GATE_NAME as BASH_OUTPUT_TRIM_GATE, bashOutputTrim } from './bash-output-trim.js';
import { GATE_NAME as SWE_DOWNSTREAM_GATE, sweDownstreamContext } from './swe-downstream-context.js';
import { GATE_NAME as REVIEWER_DOWNSTREAM_GATE, reviewerDownstreamContext } from './reviewer-downstream-context.js';
import { GATE_NAME as BRO_TURN_USAGE_GATE, broTurnUsage } from './bro-turn-usage.js';
import { GATE_NAME as FOOTER_GATE, attributionFooter } from './attribution-footer.js';
import { GATE_NAME as CQ_LINT_GATE, codeQualityLint } from './code-quality-lint.js';
import { GATE_NAME as TEST_RUN_NUDGE_GATE, testRunNudge } from './test-run-nudge.js';
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
import { GATE_NAME as LIVENESS_ALERT_GATE, livenessAlert } from './liveness-alert.js';
import { GATE_NAME as LIVENESS_SENTINEL_GATE, livenessSentinel } from './liveness-sentinel.js';
import { GATE_NAME as ACTIVATION_GATE, activationRoutine } from './activation-routine.js';
import { GATE_NAME as DEBUG_TRAJECTORY_GATE, debugTrajectory } from './debug-trajectory.js';
import { GATE_NAME as PLUGIN_HOOKS_MARKER_GATE, pluginHooksMarker } from './plugin-hooks-marker.js';
import { GATE_NAME as SESSION_LOG_GATE, sessionLogCapture } from './session-log-capture.js';
import { GATE_NAME as SESSION_HANDOFF_GATE, sessionHandoff } from './session-handoff.js';
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
import { GATE_NAME as SWE_VERIFICATION_GATE, sweVerificationGate } from './swe-verification-gate.js';
import { GATE_NAME as SWE_BRIEF_GATE, sweBriefGate } from './swe-brief-gate.js';
import { GATE_NAME as SWE_SPAWN_BIND_GATE, sweSpawnBind } from './swe-spawn-bind.js';
import { GATE_NAME as SWE_SPAWN_ROLLBACK_GATE, sweSpawnRollback } from './swe-spawn-rollback.js';
import { GATE_NAME as SPAWN_HINT_GATE, postTaskCreateSpawnHint } from './post-task-create-spawn-hint.js';
import { GATE_NAME as AGENT_ARG_GATE, agentArgMatchesCaller } from './agent-arg-matches-caller.js';
import { GATE_NAME as REVIEWER_IDENTITY_GATE, reviewerIdentityObserve } from './reviewer-identity-observe.js';
import { GATE_NAME as CHEATCODE_APPROVAL_GATE, cheatcodeInstallApproval } from './cheatcode-install-approval.js';
import { GATE_NAME as PROMPT_WRITE_APPROVAL_GATE, promptWriteApproval } from './prompt-write-approval.js';
import { GATE_NAME as STAY_ON_BASE_GATE, stayOnBaseGuard } from './stay-on-base-guard.js';
import { GATE_NAME as BRANCH_UP_TO_DATE_GATE, branchUpToDateWithRemote } from './branch-up-to-date-with-remote.js';
import { GATE_NAME as NO_WORKTREE_BRANCH_CREATE_GATE, noWorktreeBranchCreate } from './no-worktree-branch-create.js';
import { GATE_NAME as NO_REMOTE_AUTH_GATE, noRemoteAuthGuard } from './no-remote-auth-guard.js';
import { GATE_NAME as PROMPT_INTENT_GATE, promptIntentHints } from './prompt-intent-hints.js';
import { GATE_NAME as SWE_SCOPE_FENCE_GATE, sweScopeFence } from './swe-scope-fence.js';
import { GATE_NAME as SWE_EDIT_LINT_GATE, sweEditLint } from './swe-edit-lint.js';
import { GATE_NAME as ORPHAN_SCAN_GATE, orphanScan } from './orphan-scan.js';
import { GATE_NAME as SESSION_START_PRESCAN_GATE, sessionStartPrescan } from './session-start-prescan.js';
import { GATE_NAME as CLEAN_MERGED_GATE, cleanMergedBranch } from './clean-merged-branch.js';
import { GATE_NAME as CLOSE_ISSUE_GATE, closeIssueOnMerge } from './close-issue-on-merge.js';
import { GATE_NAME as SWE_ATOMIC_CLOSE_GATE, sweAtomicClose } from './swe-atomic-close.js';
import { GATE_NAME as README_STALENESS_GATE, postAtomicCloseReadme } from './post-atomic-close-readme.js';
import { GATE_NAME as AGENT_SPAWN_DISPATCH_GATE, agentSpawnDispatch } from './agent-spawn-dispatch.js';
import { GATE_NAME as ENSURE_SWE_WORKTREE_GATE, ensureSweWorktree } from './ensure-swe-worktree.js';
import { GATE_NAME as RECORD_SWE_SPAWN_GATE, recordSweSpawn } from './record-swe-spawn.js';
import { GATE_NAME as RECORD_REVIEWER_SPAWN_GATE, recordReviewerSpawn } from './record-reviewer-spawn.js';
import { GATE_NAME as CLEANUP_WORKTREE_GATE, cleanupWorktreeOnTaskClose } from './cleanup-worktree-on-task-close.js';
import { GATE_NAME as WORKTREE_CREATE_GATE, worktreeCreate } from './worktree-create.js';
import { GATE_NAME as REMOTE_ID_GATE, remoteIdGuard } from './remote-id-guard.js';
import { GATE_NAME as NO_SOURCE_EDIT_GATE, noSourceEditFromMain } from './no-source-edit-from-main.js';
import { GATE_NAME as NO_PROSE_GATE, noProseInScratch } from './no-prose-in-scratch.js';
import { GATE_NAME as WORKTREE_ADOPT_GATE, worktreeAdoptGuard } from './worktree-adopt-guard.js';
import { GATE_NAME as WM_READ_GATE, wmReadBeforeProvision } from './wm-read-before-provision.js';
import { GATE_NAME as REF_MOVE_REINDEX_GATE, refMoveReindex } from './ref-move-reindex.js';

const GATES: ReadonlyMap<string, Gate> = new Map<string, Gate>([
  ['askuserquestion-length-lint', askuserquestionLengthLint],
  [BASH_OUTPUT_TRIM_GATE, bashOutputTrim],
  [SWE_DOWNSTREAM_GATE, sweDownstreamContext],
  [REVIEWER_DOWNSTREAM_GATE, reviewerDownstreamContext],
  [BRO_TURN_USAGE_GATE, broTurnUsage],
  [FOOTER_GATE, attributionFooter],
  [CQ_LINT_GATE, codeQualityLint],
  [TEST_RUN_NUDGE_GATE, testRunNudge],
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
  [LIVENESS_ALERT_GATE, livenessAlert],
  [LIVENESS_SENTINEL_GATE, livenessSentinel],
  [ACTIVATION_GATE, activationRoutine],
  [DEBUG_TRAJECTORY_GATE, debugTrajectory],
  [PLUGIN_HOOKS_MARKER_GATE, pluginHooksMarker],
  [SESSION_LOG_GATE, sessionLogCapture],
  [SESSION_START_PERSONA_GATE, sessionStartPersona],
  [SESSION_HANDOFF_GATE, sessionHandoff],
  [USER_PROMPT_PERSONA_GATE, userPromptPersona],
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
  [PROMPT_WRITE_APPROVAL_GATE, promptWriteApproval],
  [STAY_ON_BASE_GATE, stayOnBaseGuard],
  [BRANCH_UP_TO_DATE_GATE, branchUpToDateWithRemote],
  [NO_WORKTREE_BRANCH_CREATE_GATE, noWorktreeBranchCreate],
  [NO_REMOTE_AUTH_GATE, noRemoteAuthGuard],
  [PROMPT_INTENT_GATE, promptIntentHints],
  [SWE_SCOPE_FENCE_GATE, sweScopeFence],
  [SWE_EDIT_LINT_GATE, sweEditLint],
  [ORPHAN_SCAN_GATE, orphanScan],
  [SESSION_START_PRESCAN_GATE, sessionStartPrescan],
  [CLEAN_MERGED_GATE, cleanMergedBranch],
  [CLOSE_ISSUE_GATE, closeIssueOnMerge],
  [SWE_ATOMIC_CLOSE_GATE, sweAtomicClose],
  [README_STALENESS_GATE, postAtomicCloseReadme],
  [AGENT_SPAWN_DISPATCH_GATE, (payload, env) => agentSpawnDispatch(payload, env, findGate)],
  [ENSURE_SWE_WORKTREE_GATE, ensureSweWorktree],
  [RECORD_SWE_SPAWN_GATE, recordSweSpawn],
  [RECORD_REVIEWER_SPAWN_GATE, recordReviewerSpawn],
  [CLEANUP_WORKTREE_GATE, cleanupWorktreeOnTaskClose],
  [WORKTREE_CREATE_GATE, worktreeCreate],
  [REMOTE_ID_GATE, remoteIdGuard],
  [NO_SOURCE_EDIT_GATE, noSourceEditFromMain],
  [NO_PROSE_GATE, noProseInScratch],
  [WORKTREE_ADOPT_GATE, worktreeAdoptGuard],
  [WM_READ_GATE, wmReadBeforeProvision],
  [REF_MOVE_REINDEX_GATE, refMoveReindex],
]);

export function findGate(name: string): Gate | undefined {
  return GATES.get(name);
}

export function gateNames(): string[] {
  return [...GATES.keys()].sort();
}

/*
 * The router (GH 1692): `node dist/hooks.js <event> [part]` runs the gates of
 * the one group whose event, part and matcher fit the payload, each within its
 * budget from router/budgets.json: one after another in this order, or, in a
 * group marked concurrent, all started in this order and awaited together, with
 * the answer still read in this order. A matcher is
 * the text of that group's hooks.json entry, empty for every call of its event
 * as in Claude Code; an event's matchers do not overlap. A part is a registration
 * of its own under one event, for a gate whose context must meet Claude Code's
 * per-output cap alone, so a part's process runs beside the event's others. A
 * tool no group matches runs no gates.
 */
import ROUTER_BUDGETS from './router/budgets.json' with { type: 'json' };

export type RouterGateKind = 'enforcement' | 'advisory';

export interface RouterGate {
  readonly name: string;
  readonly kind: RouterGateKind;
  readonly budgetMs: number;
  /** Runs only for a tool_name ending in `trajectory-server__<toolSuffix>`; absent, for every tool of its group. */
  readonly toolSuffix?: string;
  /** A discipline rule, not containment, marked in the `ts-only` column of dist/hooks-router.txt. The router runs it as any other gate. */
  readonly tsOnly?: boolean;
}

export interface RouterGroup {
  readonly event: string;
  readonly matcher: string;
  /** The registration of its event this group answers, the command's last word; absent, the event's default registration. */
  readonly part?: string;
  readonly gates: readonly RouterGate[];
  /**
   * The time one call's gates share (decision 922): each gate's deadline is the
   * smaller of its budget and what is left of this, and a gate that starts with
   * none left is not run. In a concurrent group it is the critical path, the
   * largest gate budget, and each gate's deadline is the smaller of its budget
   * and this, from its own start.
   */
  readonly groupBudgetMs: number;
  /** The first deny ends the call: the later gates' side effects never happen. */
  readonly stopAtFirstDeny?: boolean;
  /** Every gate starts at once and all are awaited (decisions 937 and 1136); absent, they run one at a time. An allowlist, and never with stopAtFirstDeny, whose purpose it would defeat. */
  readonly concurrent?: boolean;
}

const TS_ONLY_GATES: ReadonlySet<string> = new Set([NO_PROSE_GATE, WORKTREE_ADOPT_GATE, WM_READ_GATE]);

function routerGate(name: string, kind: RouterGateKind, toolSuffix?: string): RouterGate {
  const budgets: Record<string, { budget_ms: number }> = ROUTER_BUDGETS.gates;
  return { name, kind, budgetMs: budgets[name].budget_ms, ...(toolSuffix === undefined ? {} : { toolSuffix }), ...(TS_ONLY_GATES.has(name) ? { tsOnly: true } : {}) };
}

/** A group's key in budgets.json: a matcher alone is not unique, Bash and Agent sit under two events, and an event's parts share a matcher. */
export function routerGroupKey(group: Pick<RouterGroup, 'event' | 'matcher' | 'part'>): string {
  return group.part === undefined ? `${group.event}:${group.matcher}` : `${group.event}:${group.matcher}:${group.part}`;
}

function eventGroup(event: string, matcher: string, gates: readonly RouterGate[], opts: { stopAtFirstDeny?: boolean; concurrent?: boolean; part?: string } = {}): RouterGroup {
  const budgets: Record<string, { group_budget_ms: number }> = ROUTER_BUDGETS.groups;
  return { event, matcher, gates, groupBudgetMs: budgets[routerGroupKey({ event, matcher, part: opts.part })].group_budget_ms, ...opts };
}

function preToolUseGroup(matcher: string, gates: readonly RouterGate[], opts: { stopAtFirstDeny?: boolean; concurrent?: boolean } = {}): RouterGroup {
  return eventGroup('PreToolUse', matcher, gates, opts);
}

export const ROUTER_GROUPS: readonly RouterGroup[] = [
  preToolUseGroup('Write|Edit|MultiEdit|NotebookEdit', [
    routerGate('containment-guard', 'enforcement'),
    routerGate(SWE_BRIEF_GATE, 'enforcement'),
    routerGate(NO_SOURCE_EDIT_GATE, 'enforcement'),
    routerGate(PROMPT_WRITE_APPROVAL_GATE, 'enforcement'),
    routerGate(NO_PROSE_GATE, 'enforcement'),
    routerGate(SWE_BOUNDARY_GATE, 'enforcement'),
    routerGate(SWE_SCOPE_FENCE_GATE, 'advisory'),
    routerGate(NAMING_LINT_GATE, 'advisory'),
    routerGate(CQ_LINT_GATE, 'advisory'),
    routerGate(DEBUG_TRAJECTORY_GATE, 'advisory'),
  ], { concurrent: true }),
  eventGroup('PreToolUse', 'Write|Edit|MultiEdit|NotebookEdit', [routerGate(SWE_DOWNSTREAM_GATE, 'advisory')], { part: SWE_DOWNSTREAM_GATE }),
  preToolUseGroup('Bash', [
    routerGate('containment-guard', 'enforcement'),
    routerGate(GIT_GUARDS_GATE, 'enforcement'),
    routerGate(PUSH_GUARD_GATE, 'enforcement'),
    routerGate(SWE_BOUNDARY_GATE, 'enforcement'),
    routerGate(NO_WORKTREE_BRANCH_CREATE_GATE, 'enforcement'),
    routerGate(STAY_ON_BASE_GATE, 'enforcement'),
    routerGate(BRANCH_UP_TO_DATE_GATE, 'enforcement'),
    routerGate(COMMIT_MSG_GATE, 'advisory'),
    routerGate(TEST_RUN_NUDGE_GATE, 'advisory'),
    routerGate(NO_REMOTE_AUTH_GATE, 'enforcement'),
    routerGate(REMOTE_ID_GATE, 'enforcement'),
    routerGate(NO_PROSE_GATE, 'enforcement'),
    routerGate(PROMPT_WRITE_APPROVAL_GATE, 'enforcement'),
    routerGate(DEBUG_TRAJECTORY_GATE, 'advisory'),
  ], { concurrent: true }),
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
      routerGate(WORKTREE_ADOPT_GATE, 'enforcement', 'task_provision'),
      routerGate(WORKTREE_ADOPT_GATE, 'enforcement', 'task_reopen'),
      routerGate(WORKTREE_ADOPT_GATE, 'enforcement', 'task_retry'),
      routerGate(WM_READ_GATE, 'enforcement', 'task_provision'),
    ],
    { stopAtFirstDeny: true },
  ),
  preToolUseGroup('AskUserQuestion', [routerGate('askuserquestion-length-lint', 'advisory'), routerGate(RT_AUQ_SHAPE_GATE, 'advisory')]),
  preToolUseGroup('Read|Skill', [routerGate(DEBUG_TRAJECTORY_GATE, 'advisory')]),
  eventGroup('PostToolUse', 'mcp__.*trajectory-server__.*', [
    routerGate(CLEANUP_WORKTREE_GATE, 'advisory', 'task_update_status'),
    routerGate(CLEANUP_WORKTREE_GATE, 'advisory', 'validation_record'),
    routerGate(RT_CLEANUP_GATE, 'advisory', 'roundtable_close'),
    routerGate(README_STALENESS_GATE, 'advisory', 'bro_atomic_close'),
    routerGate(CLEANUP_WORKTREE_GATE, 'advisory', 'bro_atomic_close'),
    routerGate(SPAWN_HINT_GATE, 'advisory', 'task_create_batch'),
    routerGate(OVERRUN_GATE, 'advisory'),
    routerGate(LIVENESS_ALERT_GATE, 'advisory'),
  ]),
  eventGroup('PostToolUse', 'Bash', [routerGate(BASH_OUTPUT_TRIM_GATE, 'advisory'), routerGate(FOOTER_GATE, 'advisory'), routerGate(CLEAN_MERGED_GATE, 'advisory'), routerGate(CLOSE_ISSUE_GATE, 'advisory'), routerGate(REF_MOVE_REINDEX_GATE, 'advisory')]),
  eventGroup('PostToolUse', 'Agent', [routerGate(SWE_SPAWN_BIND_GATE, 'advisory')]),
  eventGroup('PostToolUse', 'Write|Edit|MultiEdit', [routerGate(SWE_EDIT_LINT_GATE, 'advisory')]),
  eventGroup('PermissionDenied', 'Agent', [routerGate(SWE_SPAWN_ROLLBACK_GATE, 'advisory')]),
  eventGroup('Stop', '', [routerGate(BRO_TURN_USAGE_GATE, 'advisory')]),
  eventGroup('PreCompact', '', [routerGate(SESSION_HANDOFF_GATE, 'advisory')]),
  eventGroup('SubagentStart', '^tmb:code-reviewer$', [routerGate(REVIEWER_DOWNSTREAM_GATE, 'advisory')], { part: REVIEWER_DOWNSTREAM_GATE }),
  eventGroup('SubagentStop', '', [routerGate(CONSULTANT_PERSISTENCE_GATE, 'enforcement'), routerGate(SWE_ATOMIC_CLOSE_GATE, 'advisory')]),
  eventGroup('SessionStart', '', [
    routerGate(ENSURE_GITIGNORE_GATE, 'advisory'),
    routerGate(MCP_HEALTH_GATE, 'advisory'),
    routerGate(DRIFT_WARN_GATE, 'advisory'),
    routerGate(PLUGIN_HOOKS_MARKER_GATE, 'advisory'),
    routerGate('ensure-mcp-deps-installed', 'advisory'),
    routerGate(SUBSTRATE_GATE, 'advisory'),
    routerGate(ORPHAN_SCAN_GATE, 'advisory'),
  ]),
  eventGroup('SessionStart', '', [routerGate(SESSION_START_PERSONA_GATE, 'advisory')], { part: 'persona' }),
  eventGroup('SessionStart', '', [routerGate(SESSION_START_PRESCAN_GATE, 'advisory')], { part: 'prescan' }),
  eventGroup('UserPromptSubmit', '', [
    routerGate(ACTIVATION_GATE, 'advisory'),
    routerGate(SESSION_LOG_GATE, 'advisory'),
    routerGate(PROMPT_INTENT_GATE, 'advisory'),
    routerGate(OVERRUN_GATE, 'advisory'),
    routerGate(LIVENESS_ALERT_GATE, 'advisory'),
  ]),
  eventGroup('UserPromptSubmit', '', [routerGate(USER_PROMPT_PERSONA_GATE, 'advisory')], { part: 'persona' }),
  eventGroup('UserPromptSubmit', '', [routerGate(RT_SLASH_GATE, 'advisory')], { part: 'roundtable' }),
  eventGroup('WorktreeCreate', '', [routerGate(WORKTREE_CREATE_GATE, 'advisory')]),
];

export function routerEvents(): ReadonlySet<string> {
  return new Set(ROUTER_GROUPS.map((g) => g.event));
}

/** Whether an enforcement gate serves <event> in <part>: only then can a call that reaches no gate be refused. */
export function eventHoldsEnforcement(event: string, groups: readonly RouterGroup[] = ROUTER_GROUPS, part?: string): boolean {
  return groups.some((g) => g.event === event && g.part === part && g.gates.some((x) => x.kind === 'enforcement'));
}

/** Whether <matcher>, hooks.json regex text, matches the whole of <tool>; empty matches every call. */
export function matcherFits(matcher: string, tool: string): boolean {
  return matcher === '' || new RegExp(`^(?:${matcher})$`).test(tool);
}

/** The group serving a call: the first whose event, part and matcher fit. */
export function routerGroup(event: string, tool: string, groups: readonly RouterGroup[] = ROUTER_GROUPS, part?: string): RouterGroup | undefined {
  return groups.find((g) => g.event === event && g.part === part && matcherFits(g.matcher, tool));
}

/** The gates a call runs: its group's, less those whose tool filter excludes <tool>, in group order. */
export function routerGates(event: string, tool: string, groups: readonly RouterGroup[] = ROUTER_GROUPS, part?: string): RouterGate[] {
  const gates = routerGroup(event, tool, groups, part)?.gates ?? [];
  return gates.filter((g) => g.toolSuffix === undefined || tool.endsWith(`trajectory-server__${g.toolSuffix}`));
}

/** The router's hooks.json timeout (s) for <group>: the parse allowance plus its group budget, rounded up, plus 1 s. */
export function routerTimeoutS(group: Pick<RouterGroup, 'groupBudgetMs'>): number {
  return Math.ceil((ROUTER_BUDGETS.parse_allowance_ms + group.groupBudgetMs) / 1000) + 1;
}
