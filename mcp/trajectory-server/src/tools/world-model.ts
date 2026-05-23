import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface DirRow {
  id: number;
  repo: string;
  path: string;
  parent_path: string | null;
  summary: string | null;
  summary_source: string;
  summary_updated_at: string | null;
  file_count: number;
}

interface TreeNode {
  path: string;
  summary: string | null;
  summary_source: string;
  summary_updated_at: string | null;
  file_count: number;
  children: TreeNode[];
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function wrap(fn: Fn): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

// Build the tree by indexing rows by parent_path, then descending from the
// requested root. Sorting children alphabetically gives stable output.
function buildTree(rows: DirRow[], rootPath: string, depth: number | null): TreeNode | null {
  const byParent = new Map<string, DirRow[]>();
  for (const r of rows) {
    const key = r.parent_path ?? '__ROOT__';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(r);
  }

  const root = rows.find((r) => r.path === rootPath);
  if (!root) return null;

  function descend(node: DirRow, remainingDepth: number | null): TreeNode {
    const children: TreeNode[] = [];
    if (remainingDepth === null || remainingDepth > 0) {
      const kids = byParent.get(node.path) ?? [];
      kids.sort((a, b) => a.path.localeCompare(b.path));
      for (const k of kids) {
        children.push(descend(k, remainingDepth === null ? null : remainingDepth - 1));
      }
    }
    return {
      path: node.path,
      summary: node.summary,
      summary_source: node.summary_source,
      summary_updated_at: node.summary_updated_at,
      file_count: node.file_count,
      children,
    };
  }

  return descend(root, depth);
}

export function worldModelTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'world_model_get',
      description:
        "Return the world model — bro's mental picture of the project — as an annotated directory tree. Summaries come from <dir>/README.md where present (high-trust, author-curated) and lazy LLM fill otherwise. This is the primary navigation surface for code-touching cold starts: one call returns the project map without reading every file. See docs/architecture/WORLD_MODEL.md + ADR 0001.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          repo: {
            type: 'string',
            description:
              'Repo name (matches `repos.name`). Defaults to `tmb_default_repo` from plugin_config.',
          },
          path: {
            type: 'string',
            description:
              "Starting directory path, repo-relative. Defaults to the repo root ('').",
          },
          depth: {
            type: ['integer', 'null'],
            description:
              'How deep to descend. Defaults to 2 (root + immediate children). Pass null for the full subtree.',
          },
        },
        required: ['agent'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    world_model_get: requireRoles(
      'world_model_get',
      ['bro', 'swe', 'pr-reviewer'],
      wrap(async (args) => {
        let repo = (args['repo'] as string | undefined) ?? '';
        if (!repo) {
          const cfg = db.get<{ value_json: string }>(
            "SELECT value_json FROM plugin_config WHERE key = 'tmb_default_repo'",
          );
          if (cfg?.value_json) {
            try {
              repo = JSON.parse(cfg.value_json) as string;
            } catch {
              // leave empty
            }
          }
        }

        const path = (args['path'] as string | undefined) ?? '';
        const depthArg = args['depth'];
        const depth: number | null =
          depthArg === null ? null : typeof depthArg === 'number' ? depthArg : 2;

        const rows = db.all<DirRow>(
          'SELECT id, repo, path, parent_path, summary, summary_source, summary_updated_at, file_count FROM directories WHERE repo = ?',
          [repo],
        );

        if (rows.length === 0) {
          return ok({ repo, root: null, warning: 'world-model-empty' });
        }

        const tree = buildTree(rows, path, depth);
        if (!tree) {
          return ok({ repo, root: null, warning: 'path-not-found', path });
        }

        return ok({ repo, root: tree });
      }),
    ),
  };

  return { definitions, handlers };
}
