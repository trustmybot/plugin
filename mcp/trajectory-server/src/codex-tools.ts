import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CodexRuntimeError,
  type CodexRuntimeManager,
} from './codex-runtime.js';

type CodexToolHandler = (args: unknown) => Promise<CallToolResult>;

export interface CodexToolRegistry {
  readonly definitions: readonly Tool[];
  readonly handlers: Readonly<Record<string, CodexToolHandler>>;
  readonly call: (
    name: string,
    args: unknown,
  ) => Promise<CallToolResult>;
}

export function createCodexToolRegistry(
  manager: CodexRuntimeManager,
): CodexToolRegistry {
  const definitions = deepFreeze([
    {
      name: 'runtime_initialize',
      description:
        'Initialize or reuse TMB runtime state for one explicit Git worktree root.',
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
    } satisfies Tool,
  ]);

  const handlers: Readonly<Record<string, CodexToolHandler>> = deepFreeze({
    runtime_initialize: async (args: unknown): Promise<CallToolResult> => {
      try {
        const projectRoot =
          typeof args === 'object' && args !== null
            ? (args as Record<string, unknown>)['project_root']
            : undefined;
        const result = await manager.initialize(projectRoot);
        return jsonResult({ ok: true, runtime: result });
      } catch (error) {
        return runtimeErrorResult(error);
      }
    },
  });

  const call = async (
    name: string,
    args: unknown,
  ): Promise<CallToolResult> => {
    const handler = handlers[name];
    if (!handler) {
      return jsonResult(
        {
          ok: false,
          error: {
            code: 'unknown_tool',
            message: `Unknown Codex tool: ${name}`,
          },
        },
        true,
      );
    }
    return handler(args);
  };

  return deepFreeze({ definitions, handlers, call });
}

function runtimeErrorResult(error: unknown): CallToolResult {
  const runtimeError =
    error instanceof CodexRuntimeError
      ? error
      : new CodexRuntimeError(
          'runtime_initialization_failed',
          error instanceof Error ? error.message : String(error),
        );
  return jsonResult(
    {
      ok: false,
      error: {
        code: runtimeError.code,
        message: runtimeError.message,
      },
    },
    true,
  );
}

function jsonResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
