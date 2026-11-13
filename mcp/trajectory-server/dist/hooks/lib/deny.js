import { jqCompact } from './jq.js';
export const ALLOWED_FORM = ' Allowed form: ';
export const POLICY_ENDING = ' This is policy: stop and report.';
/** <reason> with its trailing whitespace dropped and the ending <fix> names. */
export function fixedReason(reason, fix) {
    const text = reason.replace(/\s+$/, '');
    return fix === 'policy' ? `${text}${POLICY_ENDING}` : `${text}${ALLOWED_FORM}${fix.allowed}`;
}
/** Whether <reason> ends with one of the two endings. */
export function endsWithFix(reason) {
    if (reason.endsWith(POLICY_ENDING))
        return true;
    const at = reason.lastIndexOf(ALLOWED_FORM);
    return at >= 0 && reason.slice(at + ALLOWED_FORM.length).trim() !== '';
}
function preToolUseDeny(reason) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}
/** The PreToolUse deny JSON line (no newline), as `jq -nc` prints it. */
export function denyJson(reason, fix) {
    return jqCompact(preToolUseDeny(fixedReason(reason, fix)));
}
/** The PreToolUse deny as a gate result. */
export function denyResult(reason, fix) {
    return { stdout: `${denyJson(reason, fix)}\n`, code: 0 };
}
/** The `{decision: 'block', reason}` JSON line (no newline) of a Stop, SubagentStop or PostToolUse block. */
export function blockJson(reason, fix) {
    return jqCompact({ decision: 'block', reason: fixedReason(reason, fix) });
}
export function blockResult(reason, fix) {
    return { stdout: `${blockJson(reason, fix)}\n`, code: 0 };
}
/**
 * A PreToolUse deny whose reason is machine-readable JSON: <failure> with a
 * `fix` key ({allowed} or "policy") in place of the text ending.
 */
export function structuredDenyResult(failure, fix) {
    return { stdout: `${jqCompact(preToolUseDeny(JSON.stringify({ ...failure, fix })))}\n`, code: 0 };
}
/**
 * The router's re-emit of a reason that already carries its ending: a deny
 * on PreToolUse, a block on any other event, as JSON.stringify prints it.
 */
export function passthroughDeny(reason, event) {
    const output = event === 'PreToolUse' ? { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } } : { decision: 'block', reason };
    return `${JSON.stringify(output)}\n`;
}
//# sourceMappingURL=deny.js.map