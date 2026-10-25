import { readEffortAb } from './tools/config.js';
import { insertAudit } from './tools/audit.js';
import { EFFORT_AB_EVENT, effortAbEnrolledCount } from './effort-ab-report.js';
export function effortAbArm(taskId) {
    return taskId % 2 === 0 ? 'high' : 'medium';
}
function isEligible(computed) {
    return computed.reason === 'default' || (computed.reason === 'explicit' && computed.effort === 'medium');
}
/**
 * Enrolls the just-inserted task when the A/B is on and the task is eligible:
 * rewrites tasks.effort to the arm and writes the audit row. Call inside the
 * insert's transaction. Returns the effort and reason the task ends up with.
 */
export function enrollEffortAb(db, computed, task) {
    if (!isEligible(computed))
        return computed;
    const ab = readEffortAb(db);
    if (!ab || effortAbEnrolledCount(db, ab.label) >= ab.target)
        return computed;
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
//# sourceMappingURL=effort-ab.js.map