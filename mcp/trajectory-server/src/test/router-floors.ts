/**
 * Each router gate's budget floor (GH 1861): the timeout, in seconds, of the
 * hooks.json registration it ran under before the router took it (the Bash
 * gates at origin/dev 619ce711, the post-tool and stop gates at 54f9731c, the
 * session, prompt and worktree gates at 76ec206d, the rest at 9cc886e8). Every
 * gate was its own registration, so its share is that whole timeout; a
 * trajectory-gates chain member's is its chain-table budget.
 */
export const PRE_ROUTER_TIMEOUT_S: Readonly<Record<string, number>> = Object.freeze({
  'containment-guard': 5,
  'git-guards': 11,
  'git-push-guard': 6,
  'swe-boundary': 6,
  'no-worktree-branch-create': 6,
  'stay-on-base-guard': 6,
  'branch-up-to-date-with-remote': 16,
  'commit-msg-lint': 4,
  'no-remote-auth-guard': 6,
  'remote-id-guard': 6,
  'debug-trajectory': 4,
  'swe-brief-gate': 6,
  'no-source-edit-from-main': 6,
  'swe-scope-fence': 6,
  'naming-lint': 4,
  'code-quality-lint': 4,
  'agent-spawn-dispatch': 16,
  'swe-resume-gate': 6,
  'agent-arg-matches-caller': 6,
  'swe-verification-gate': 1830,
  'reviewer-identity-observe': 6,
  'cheatcode-install-approval': 6,
  'askuserquestion-length-lint': 6,
  'roundtable-auq-shape': 6,
  'cleanup-worktree-on-task-close': 11,
  'roundtable-cleanup-postcheck': 6,
  'post-task-close-rescan': 6,
  'post-atomic-close-readme': 6,
  'post-task-create-spawn-hint': 4,
  'task-overrun-alert': 6,
  'liveness-alert': 6,
  'attribution-footer': 16,
  'clean-merged-branch': 11,
  'close-issue-on-merge': 16,
  'swe-spawn-bind': 6,
  'swe-spawn-rollback': 6,
  'bro-turn-usage': 6,
  'swe-atomic-close': 6,
  'consultant-persistence-gate': 6,
  'ensure-gitignore': 6,
  'mcp-health-check': 6,
  'deferred-tools-drift-warn': 6,
  'plugin-hooks-marker': 4,
  'session-start-persona': 6,
  'session-start-prescan': 6,
  'ensure-mcp-deps-installed': 6,
  'substrate-preflight': 6,
  'orphan-scan': 7,
  'user-prompt-persona': 6,
  'rework-waiver-capture': 6,
  'activation-routine': 6,
  'session-log-capture': 4,
  'prompt-intent-hints': 6,
  'roundtable-slash-detect': 21,
  'worktree-create': 16,
});

export function floorMs(gate: string): number {
  const s = PRE_ROUTER_TIMEOUT_S[gate];
  if (s === undefined) throw new Error(`no pre-router timeout for gate '${gate}'`);
  return s * 1000;
}

export const BUDGET_MARGIN_MS = 200;

/**
 * The router's own time on one call beyond its gates' budgets: the shared
 * bash parser load before the first gate clock starts, the install check,
 * the dedupe lock and the record writes. It keeps the 2 s margin the
 * registration timeout had over a gate budget before the gates ran in turn.
 */
export const PARSE_ALLOWANCE_MS = 2000;

/** budget_ms = max(floor_ms, ceil(2 x max(bench_p99, transcript_p99)) + 200). */
export function budgetMs(floor: number, benchP99: number, transcriptP99: number | null): number {
  return Math.max(floor, Math.ceil(2 * Math.max(benchP99, transcriptP99 ?? 0)) + BUDGET_MARGIN_MS);
}

/** A gate's p99 term of the group budget: max(bench_p99, transcript_p99). */
export function p99Term(benchP99: number, transcriptP99: number | null): number {
  return Math.max(benchP99, transcriptP99 ?? 0);
}

/** group_budget_ms = max(max_budget_ms, ceil(1.5 x p99_sum_ms)). */
export function groupBudgetMs(maxBudgetMs: number, p99SumMs: number): number {
  return Math.max(maxBudgetMs, Math.ceil(1.5 * p99SumMs));
}
