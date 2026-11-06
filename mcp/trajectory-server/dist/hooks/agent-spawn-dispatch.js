import { ALLOW } from './gate.js';
import { jqCompact } from './lib/jq.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
import { commandSubstitution } from './lib/project-env.js';
export const GATE_NAME = 'agent-spawn-dispatch';
export const CHAIN = [
    'require-task-spec',
    'require-spawn-effort',
    'require-feature-branch-active',
    'code-reviewer-no-worktree',
    'code-reviewer-spawn-prompt-shape',
    'code-reviewer-after-atomic-close',
    'code-reviewer-spawn-note',
    'code-reviewer-preflight',
    'rework-limit',
];
export const PREPARE = ['ensure-swe-worktree', 'record-swe-spawn'];
export const CONTEXT_SEPARATOR = '\n\n---\n\n';
/** `$(printf '%s' "$INPUT" | <gate> 2>/dev/null) || true`: the gate's stdout, "" when it is missing or throws. */
async function quietly(gate, input, env) {
    if (gate === undefined)
        return '';
    const write = process.stderr.write;
    process.stderr.write = (() => true);
    try {
        return (await gate(input, env)).stdout;
    }
    catch {
        return '';
    }
    finally {
        process.stderr.write = write;
    }
}
export async function agentSpawnDispatch(payload, env, find) {
    const input = commandSubstitution(payload);
    const parts = [];
    for (const name of CHAIN) {
        const out = commandSubstitution(await quietly(find(name), input, env));
        if (out === '')
            continue;
        const reply = jqInput(out);
        if (jqCapture(reply, ['hookSpecificOutput', 'permissionDecision']) === 'deny')
            return { stdout: `${out}\n`, code: 0 };
        const ctx = jqCapture(reply, ['hookSpecificOutput', 'additionalContext']);
        if (ctx !== '')
            parts.push(ctx);
    }
    for (const name of PREPARE)
        await quietly(find(name), input, env);
    if (parts.length === 0)
        return ALLOW;
    const merged = parts.join(CONTEXT_SEPARATOR);
    return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: merged } })}\n`, code: 0 };
}
//# sourceMappingURL=agent-spawn-dispatch.js.map