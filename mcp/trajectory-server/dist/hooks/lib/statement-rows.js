import { stripTrailingNewlines } from './db.js';
import { jqCompact } from './jq.js';
import { jqCapture } from './jq-raw.js';
import { shellPwd } from './project-env.js';
/** `IFS=$'\t' read -r f1 … fn` of one line: tab runs split, the last field keeps the rest. */
export function readTabFields(line, n) {
    let s = line.replace(/^\t+/, '');
    const fields = [];
    for (let i = 0; i < n - 1; i++) {
        const tab = s.indexOf('\t');
        if (tab < 0) {
            fields.push(s);
            s = '';
            continue;
        }
        fields.push(s.slice(0, tab));
        s = s.slice(tab).replace(/^\t+/, '');
    }
    fields.push(s.replace(/\t+$/, ''));
    return fields;
}
/** The `dir` / `stmt` pairs the .sh's read loop sees from tmb_cmd_statements' lines. */
export function statementRows(statements) {
    const text = stripTrailingNewlines(statements.map(({ dir, stmt }) => `${dir}\t${stmt}`).join('\n'));
    if (text === '')
        return [];
    return text.split('\n').map((line) => {
        const [dir, stmt] = readTabFields(line, 2);
        return { dir, stmt };
    });
}
/** tmb_payload_cwd: the payload's `.cwd // empty`, else $PWD. */
export function payloadCwdOf(input, env = process.env) {
    return jqCapture(input, ['cwd'], true) || shellPwd(env);
}
/** The PreToolUse deny of <reason> as `jq -nc --arg reason …` prints it. */
export function denyResult(reason) {
    const decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    return { stdout: `${jqCompact(decision)}\n`, code: 0 };
}
//# sourceMappingURL=statement-rows.js.map