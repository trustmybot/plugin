/**
 * What clean-merged-branch and close-issue-on-merge share (GH 1692): the
 * PostToolUse(Bash) payload read as their .sh's jq calls read it, and the
 * failed-merge check on the tool response.
 */
import { jqCompact, jqIndex, jqLiteralNumbers, jqMap, jqOr } from './jq.js';
import { commandSubstitution, jqRawText } from './project-env.js';
/**
 * `.tool_name // ""`, `.tool_input.command // ""` and
 * `.tool_response | if type == "string" then . else tojson end`, each as its
 * `$(jq -r ...)` capture.
 */
export function readMergePayload(payload) {
    const input = commandSubstitution(payload);
    const toolName = jqMap(input, (v) => jqRawText(jqOr(jqIndex(v, 'tool_name'), '')));
    const command = jqMap(input, (v) => jqRawText(jqOr(jqIndex(jqIndex(v, 'tool_input'), 'command'), '')));
    const response = jqMap(input, (v) => {
        const r = jqIndex(v, 'tool_response');
        return typeof r === 'string' ? r : jqCompact(r);
    }, jqLiteralNumbers);
    return {
        input,
        toolName: commandSubstitution(toolName.join('\n')),
        command: commandSubstitution(command.join('\n')),
        response: commandSubstitution(response.join('\n')),
    };
}
const MERGE_FAILED = /(is_error|"error"|failed to merge|not mergeable|merge conflict|GraphQL: |pull request is not mergeable)/i;
/** The response carries a failure signal, so the merge must never count. */
export function mergeFailed(response) {
    return MERGE_FAILED.test(response);
}
//# sourceMappingURL=merge.js.map