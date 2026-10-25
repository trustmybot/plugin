/**
 * The opt-in swe effort A/B (GH 1745). With plugin_config.swe_effort_ab set to
 * {label, target}, a newly created task whose computed effort is the default,
 * or an explicit medium, is enrolled while fewer than `target` tasks carry the
 * label: its effort becomes the arm of its id's parity (even high, odd
 * medium), recorded by one effort_ab_enrolled audit row. Reworks, explicit
 * high or low, prompt-bearing and high_effort_paths tasks are never enrolled.
 */
import type { TrajectoryDB } from './db.js';
import { readEffortAb, type Effort, type EffortReason } from './tools/config.js';
import { insertAudit } from './tools/audit.js';
import { EFFORT_AB_EVENT, effortAbEnrolledCount } from './effort-ab-report.js';

export function effortAbArm(taskId: number): Effort {
  return taskId % 2 === 0 ? 'high' : 'medium';
}

function isEligible(computed: { effort: Effort; reason: EffortReason }): boolean {
  return computed.reason === 'default' || (computed.reason === 'explicit' && computed.effort === 'medium');
}

/**
 * Enrolls the just-inserted task when the A/B is on and the task is eligible:
 * rewrites tasks.effort to the arm and writes the audit row. Call inside the
 * insert's transaction. Returns the effort and reason the task ends up with.
 */
export function enrollEffortAb(
  db: TrajectoryDB,
  computed: { effort: Effort; reason: EffortReason },
  task: { id: number; issue_id: number; branch_id: string; from_node: string; created_at: string },
): { effort: Effort; reason: EffortReason } {
  if (!isEligible(computed)) return computed;
  const ab = readEffortAb(db);
  if (!ab || effortAbEnrolledCount(db, ab.label) >= ab.target) return computed;
  const arm = effortAbArm(task.id);
  db.run(`UPDATE tasks SET effort = ? WHERE id = ?`, [arm, task.id]);
  insertAudit(db, {
    issue_id: task.issue_id,
    branch_id: task.branch_id,
    from_node: task.from_node,
    event_type: EFFORT_AB_EVENT,
    summary: `Task ${task.id} enrolled in effort A/B '${ab.label}' at ${arm}.`,
    content_json: JSON.stringify({ label: ab.label, arm, task_id: task.id }),
    created_at: task.created_at,
  });
  return { effort: arm, reason: 'ab_arm' };
}
