/**
 * Each Bash router gate's budget floor (GH 1861): the timeout, in seconds, of
 * the hooks.json registration it ran under before R1 (origin/dev 619ce711).
 * Every gate was its own registration, so its share is that whole timeout.
 */
export const PRE_R1_TIMEOUT_S: Readonly<Record<string, number>> = Object.freeze({
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
});

export function floorMs(gate: string): number {
  const s = PRE_R1_TIMEOUT_S[gate];
  if (s === undefined) throw new Error(`no pre-R1 timeout for gate '${gate}'`);
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
