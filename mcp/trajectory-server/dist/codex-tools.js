import { CodexRuntimeError, } from './codex-runtime.js';
export function createCodexToolRegistry(manager) {
    const definitions = deepFreeze([
        {
            name: 'runtime_initialize',
            description: 'Initialize or reuse TMB runtime state for one explicit Git worktree root.',
            inputSchema: {
                type: 'object',
                properties: {
                    project_root: {
                        type: 'string',
                        description: 'Absolute path to the Git worktree root.',
                    },
                },
                required: ['project_root'],
                additionalProperties: false,
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
    ]);
    const handlers = deepFreeze({
        runtime_initialize: async (args) => {
            try {
                const projectRoot = typeof args === 'object' && args !== null
                    ? args['project_root']
                    : undefined;
                const result = await manager.initialize(projectRoot);
                return jsonResult({ ok: true, runtime: result });
            }
            catch (error) {
                return runtimeErrorResult(error);
            }
        },
    });
    const call = async (name, args) => {
        const handler = handlers[name];
        if (!handler) {
            return jsonResult({
                ok: false,
                error: {
                    code: 'unknown_tool',
                    message: `Unknown Codex tool: ${name}`,
                },
            }, true);
        }
        return handler(args);
    };
    return deepFreeze({ definitions, handlers, call });
}
function runtimeErrorResult(error) {
    const runtimeError = error instanceof CodexRuntimeError
        ? error
        : new CodexRuntimeError('runtime_initialization_failed', error instanceof Error ? error.message : String(error));
    return jsonResult({
        ok: false,
        error: {
            code: runtimeError.code,
            message: runtimeError.message,
        },
    }, true);
}
function jsonResult(value, isError = false) {
    return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        ...(isError ? { isError: true } : {}),
    };
}
function deepFreeze(value) {
    if (value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}
//# sourceMappingURL=codex-tools.js.map