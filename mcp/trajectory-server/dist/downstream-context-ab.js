export const DOWNSTREAM_AB_EVENT = 'downstream_context_ab_enrolled';
export const DOWNSTREAM_INJECTED_EVENT = 'downstream_context_injected';
export const DOWNSTREAM_AB_ARMS = ['on', 'off'];
export function downstreamContextArm(taskId) {
    return Math.floor(taskId / 2) % 2 === 1 ? 'on' : 'off';
}
export function isDownstreamArm(value) {
    return DOWNSTREAM_AB_ARMS.includes(value);
}
/**
 * The task's arm, enrolling it on the way when the A/B is on and the target
 * is not reached; null when the A/B is off, the task stays out, or a read or
 * the write fails.
 */
export function enrollDownstreamContextAb(store, taskId) {
    if (!Number.isInteger(taskId) || taskId <= 0)
        return null;
    const ab = store.config();
    if (!ab)
        return null;
    const recorded = store.enrolledArm(ab.label, taskId);
    if (recorded === null)
        return null;
    if (recorded !== 'none')
        return recorded;
    const count = store.enrolledCount(ab.label);
    if (count === null || count >= ab.target)
        return null;
    const arm = downstreamContextArm(taskId);
    return store.enroll(ab.label, arm, taskId) ? arm : null;
}
//# sourceMappingURL=downstream-context-ab.js.map