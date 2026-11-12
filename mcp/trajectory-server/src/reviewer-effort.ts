/**
 * Reviewer effort by risk tier (GH 1955). review_handoff assigns the effort
 * the task's code-reviewer spawn runs at and records it in one
 * reviewer_effort_assigned audit row; require-spawn-effort and swe-atomic-close
 * read that row back through reviewerEffortFor in src/hooks/lib/effort.ts.
 * With reviewer_effort_tiers and reviewer_effort_ab unset every assignment is
 * plugin_config.reviewer_effort (reason `config`). A tier assignment takes
 * the model and effort plugin_config.reviewer_tier_settings names for its
 * reason (GH 2932). reviewerSpawn builds the code-reviewer Agent call
 * review_handoff returns as reviewer_spawn (GH 2582).
 */
import type { TrajectoryDB } from './db.js';
import { ANCHORS } from './hooks/code-reviewer-spawn-note.js';
import { insertAudit } from './tools/audit.js';
import {
  pathsOverlap,
  readHighEffortPaths,
  readReviewerEffortAb,
  readReviewerEffortTiers,
  readReviewerTierSettings,
  resolveEffortDefaults,
  type Effort,
  type ReviewerModel,
  type ReviewerTierReason,
} from './tools/config.js';

export const REVIEWER_EFFORT_EVENT = 'reviewer_effort_assigned';

export type ReviewerEffortReason = ReviewerTierReason | 'config';
export type ReviewerEffortArm = 'tiered' | 'fixed';

export interface ReviewerEffortTierInput {
  readonly prompt_bearing: boolean;
  readonly changed: readonly string[];
  readonly high_effort_paths: readonly string[];
}

const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__']);

/** A docs path (`*.md`, or under a `docs/` segment) or a test path (a test segment, or `.test.` / `.spec.` in the basename). */
export function isDocsOrTestPath(path: string): boolean {
  const segments = path.split('/').filter((s) => s.length > 0);
  const base = segments.at(-1) ?? '';
  const dirs = segments.slice(0, -1);
  if (base.endsWith('.md') || dirs.includes('docs')) return true;
  return dirs.some((s) => TEST_SEGMENTS.has(s)) || base.includes('.test.') || base.includes('.spec.');
}

/**
 * The risk tier of a change: high for a prompt-bearing task or a changed path
 * overlapping a high_effort_paths prefix; low when every changed path is docs
 * or tests; medium otherwise, an empty list included.
 */
export function reviewerEffortTier(input: ReviewerEffortTierInput): { effort: Effort; reason: ReviewerTierReason } {
  if (input.prompt_bearing) return { effort: 'high', reason: 'prompt_bearing' };
  if (input.changed.some((file) => input.high_effort_paths.some((prefix) => pathsOverlap(file, prefix)))) {
    return { effort: 'high', reason: 'high_effort_paths' };
  }
  if (input.changed.length > 0 && input.changed.every(isDocsOrTestPath)) return { effort: 'low', reason: 'docs_tests' };
  return { effort: 'medium', reason: 'default' };
}

export function reviewerEffortAbArm(taskId: number): ReviewerEffortArm {
  return taskId % 2 === 0 ? 'tiered' : 'fixed';
}

const LABEL_SQL = `event_type = ? AND json_valid(content_json) AND json_extract(content_json, '$.label') = ?`;

function enrolledArm(db: TrajectoryDB, taskId: number, label: string): ReviewerEffortArm | null {
  const row = db.get<{ arm: string | null }>(
    `SELECT json_extract(content_json, '$.arm') AS arm FROM audit
      WHERE ${LABEL_SQL} AND json_extract(content_json, '$.task_id') = ?
      ORDER BY id DESC LIMIT 1`,
    [REVIEWER_EFFORT_EVENT, label, taskId],
  );
  return row?.arm === 'tiered' || row?.arm === 'fixed' ? row.arm : null;
}

function enrolledTaskCount(db: TrajectoryDB, label: string): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT json_extract(content_json, '$.task_id')) AS n FROM audit WHERE ${LABEL_SQL}`,
      [REVIEWER_EFFORT_EVENT, label],
    )?.n ?? 0
  );
}

export interface ReviewerEffortAssignment {
  readonly effort: Effort;
  readonly model?: ReviewerModel;
  readonly reason: ReviewerEffortReason;
  readonly label?: string;
  readonly arm?: ReviewerEffortArm;
}

function applyTierSetting(db: TrajectoryDB, tier: { effort: Effort; reason: ReviewerTierReason }): ReviewerEffortAssignment {
  const setting = readReviewerTierSettings(db)[tier.reason];
  const effort = setting?.effort ?? tier.effort;
  return setting?.model ? { effort, model: setting.model, reason: tier.reason } : { effort, reason: tier.reason };
}

/**
 * Assigns the reviewer effort for one review handoff and writes its
 * reviewer_effort_assigned row. Call inside the handoff transaction, after
 * its review_handoff row. An unchecked scope (no changed list) is the config
 * effort. A task enrolled under the current A/B label keeps its arm; a new
 * one enrolls while fewer than `target` tasks carry the label, at its id's
 * parity arm (even tiered, odd fixed). Any other task follows
 * reviewer_effort_tiers. A tier assignment takes the model and effort
 * reviewer_tier_settings names for its reason; the config effort never
 * carries a model.
 */
export function assignReviewerEffort(
  db: TrajectoryDB,
  task: { id: number; issue_id: number; branch_id: string; prompt_bearing: number | null },
  commitSha: string,
  scope: { checked: boolean; changed: readonly string[] },
  now: string,
): ReviewerEffortAssignment {
  const fixed: ReviewerEffortAssignment = { effort: resolveEffortDefaults(db).reviewer, reason: 'config' };
  const tier = scope.checked
    ? reviewerEffortTier({ prompt_bearing: task.prompt_bearing === 1, changed: scope.changed, high_effort_paths: readHighEffortPaths(db) })
    : null;

  const ab = readReviewerEffortAb(db);
  let arm: ReviewerEffortArm | null = null;
  if (ab) {
    arm = enrolledArm(db, task.id, ab.label);
    if (arm === null && enrolledTaskCount(db, ab.label) < ab.target) arm = reviewerEffortAbArm(task.id);
  }
  const useTier = arm !== null ? arm === 'tiered' : readReviewerEffortTiers(db);
  const chosen = useTier && tier !== null ? applyTierSetting(db, tier) : fixed;
  const assignment: ReviewerEffortAssignment = arm !== null && ab ? { ...chosen, label: ab.label, arm } : chosen;

  insertAudit(db, {
    issue_id: task.issue_id,
    branch_id: task.branch_id,
    from_node: 'bro',
    event_type: REVIEWER_EFFORT_EVENT,
    summary: `Task ${task.id} review assigned effort ${assignment.effort}${assignment.model ? `, model ${assignment.model}` : ''} (${assignment.reason}${assignment.arm ? `, arm ${assignment.arm}` : ''}).`,
    content_json: JSON.stringify({ task_id: task.id, commit_sha: commitSha, ...assignment }),
    created_at: now,
  });
  return assignment;
}

export const REVIEWER_SUBAGENT_TYPE = 'tmb:code-reviewer';
const REVIEWER_SPAWN_LINE = 'Judge whether this commit breaks other behaviour; task_brief carries the spec and the rest.';

export interface ReviewerSpawn {
  readonly prompt: string;
  readonly effort: Effort;
  readonly model?: ReviewerModel;
  readonly subagent_type: typeof REVIEWER_SUBAGENT_TYPE;
}

export type ReviewerSpawnResult = { reviewer_spawn: ReviewerSpawn } | { reviewer_spawn_unavailable: 'session_id' | 'repo' | 'repo_path' };

function anchorValue(value: string): string {
  if (!/\s/.test(value)) return value;
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

/**
 * The code-reviewer Agent call for a handed-off task: every ANCHORS entry of
 * code-reviewer-spawn-note as name=value, one short line, and the assigned
 * effort and model (no model key when none is assigned). repo_path is the
 * task's worktree, else its repo's path; attempt_n is the task's
 * code-reviewer validation rows + 1. A missing input names itself in
 * reviewer_spawn_unavailable instead.
 */
export function reviewerSpawn(
  db: TrajectoryDB,
  task: { id: number; branch_id: string; repo: string | null },
  repoPath: string | null,
  commitSha: string,
  assigned: Pick<ReviewerEffortAssignment, 'effort' | 'model'>,
  sessionId: string | null,
): ReviewerSpawnResult {
  if (sessionId === null) return { reviewer_spawn_unavailable: 'session_id' };
  if (task.repo === null || task.repo === '') return { reviewer_spawn_unavailable: 'repo' };
  if (!repoPath) return { reviewer_spawn_unavailable: 'repo_path' };
  const reviews =
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ? AND (agent = 'code-reviewer' OR agent LIKE '%:code-reviewer')`,
      [task.id],
    )?.n ?? 0;
  const values: Record<(typeof ANCHORS)[number], string> = {
    task_id: String(task.id),
    commit_sha: commitSha,
    branch_id: task.branch_id,
    repo: task.repo,
    repo_path: repoPath,
    attempt_n: String(reviews + 1),
    subagent_session_id: sessionId,
  };
  const anchors = ANCHORS.map((name) => `${name}=${anchorValue(values[name])}`).join(' ');
  const prompt = `${anchors}\n${REVIEWER_SPAWN_LINE}`;
  const { effort, model } = assigned;
  return {
    reviewer_spawn: model
      ? { prompt, effort, model, subagent_type: REVIEWER_SUBAGENT_TYPE }
      : { prompt, effort, subagent_type: REVIEWER_SUBAGENT_TYPE },
  };
}
