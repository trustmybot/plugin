import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import type { WorldModelGraph, DirectoryNode } from '../graph-db.js';
import { resolveSoleRepo } from '../utils/repo-paths.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

type DirRow = DirectoryNode;

const WORLD_MODEL_GET_MAX_NODES = 500;

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
// depthForSummary is the root's logical depth (0 = root itself). Summaries
// at depth > 1 are truncated to the first line to keep the payload compact.
export function buildTree(
  rows: DirRow[],
  rootPath: string,
  depth: number | null,
  opts?: { nodeCounter?: { count: number; limit: number }; depthOffset?: number },
): TreeNode | null {
  const byParent = new Map<string, DirRow[]>();
  for (const r of rows) {
    const key = r.parent_path ?? '__ROOT__';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(r);
  }

  const root = rows.find((r) => r.path === rootPath);
  if (!root) return null;

  // Top-level dirs carry parent_path '' (the repo root's own path), so they're
  // filed under '' alongside the root node itself. descend must exclude the
  // node from its own child list, and a visited set guards against any cycle in
  // the stored graph so traversal can't recurse forever. (#269, #272)
  const visited = new Set<string>();
  const counter = opts?.nodeCounter;
  const depthOffset = opts?.depthOffset ?? 0;

  function descend(node: DirRow, remainingDepth: number | null, currentDepth: number): TreeNode {
    visited.add(node.path);
    if (counter) counter.count++;
    const children: TreeNode[] = [];
    if (remainingDepth === null || remainingDepth > 0) {
      const kids = (byParent.get(node.path) ?? []).filter(
        (k) => k.path !== node.path && !visited.has(k.path),
      );
      kids.sort((a, b) => a.path.localeCompare(b.path));
      for (const k of kids) {
        if (counter && counter.count >= counter.limit) break;
        children.push(descend(k, remainingDepth === null ? null : remainingDepth - 1, currentDepth + 1));
      }
    }
    // Summaries beyond the first level (depth > depthOffset) are trimmed to
    // the first non-empty line to keep the payload manageable.
    const absoluteDepth = currentDepth + depthOffset;
    const summary = absoluteDepth > 1 && node.summary
      ? (node.summary.split('\n').find((l) => l.trim().length > 0) ?? node.summary)
      : node.summary;
    return {
      path: node.path,
      summary,
      summary_source: node.summary_source,
      summary_updated_at: node.summary_updated_at,
      file_count: node.file_count,
      children,
    };
  }

  return descend(root, depth, 0);
}

export function worldModelTools(db: TrajectoryDB, graph: WorldModelGraph | null): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'world_model_get',
      description:
        "Return the world model as an annotated directory tree. Each node carries a README-sourced summary (summary_source='readme') or structural fallback. Depth-1+ summaries are truncated to the first line. Returns truncated:true when the tree exceeds 500 nodes. Primary navigation surface for code-touching cold starts.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          repo: {
            type: 'string',
            description:
              'Repo name (matches `repos.name`). Defaults to the sole registered repo when exactly one exists; required in multi-repo projects.',
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
    {
      name: 'world_model_search',
      description:
        "Search the world model by summary + path match. Returns top-K dir summaries with their paths. Default mode is hybrid; falls back to keyword with warning: 'semantic_unavailable'. Use for 'where does X live' questions — cheaper than world_model_get.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          query: {
            type: 'string',
            description:
              'Search query. For keyword/hybrid: FTS5 MATCH syntax. For semantic: natural language.',
          },
          mode: {
            type: 'string',
            enum: ['keyword', 'semantic', 'hybrid'],
            description: 'Search mode. Default: hybrid (RRF combines FTS5 + cosine).',
          },
          repo: {
            type: 'string',
            description:
              'Optional — restrict to one repo. Defaults to the sole registered repo when exactly one exists; unrestricted in multi-repo projects.',
          },
          k: {
            type: 'number',
            description: 'Top-K rows to return. Default 5. Max 20.',
          },
        },
        required: ['agent', 'query'],
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
          const sole = resolveSoleRepo(db)?.name;
          if (sole === undefined) {
            // Multi-repo (or no repos) with no selector: don't silently target
            // an empty repo. Name the available repos so the caller can pass one.
            const available = db.all<{ name: string }>(`SELECT name FROM repos ORDER BY name`).map((r) => r.name);
            return ok({ repo: '', root: null, warning: 'repo-unspecified', available_repos: available });
          }
          repo = sole;
        }

        const path = (args['path'] as string | undefined) ?? '';
        const depthArg = args['depth'];
        const depth: number | null =
          depthArg === null ? null : typeof depthArg === 'number' ? depthArg : 2;

        if (!graph) {
          return ok({ repo, root: null, warning: 'world-model-unavailable' });
        }

        const nodes = graph.allDirectoriesForRepo(repo);
        if (nodes.length === 0) {
          return ok({ repo, root: null, warning: 'world-model-empty' });
        }

        const rows: DirRow[] = nodes;
        const nodeCounter = { count: 0, limit: WORLD_MODEL_GET_MAX_NODES };
        const tree = buildTree(rows, path, depth, { nodeCounter });
        if (!tree) {
          return ok({ repo, root: null, warning: 'path-not-found', path });
        }

        const truncated = nodeCounter.count >= WORLD_MODEL_GET_MAX_NODES;
        return ok({ repo, root: tree, ...(truncated ? { truncated: true } : {}) });
      }),
    ),

    world_model_search: requireRoles(
      'world_model_search',
      ['bro', 'swe', 'pr-reviewer'],
      wrap(async (args) => {
        const query = args['query'] as string;
        if (!query || typeof query !== 'string') return err('query is required');
        const mode = (args['mode'] as string | undefined) ?? 'hybrid';
        const k = Math.min(Math.max(1, (args['k'] as number | undefined) ?? 5), 20);

        let repo = (args['repo'] as string | undefined) ?? '';
        if (!repo) {
          const sole = resolveSoleRepo(db)?.name;
          if (sole === undefined) {
            // Multi-repo (or no repos) with no selector: don't silently search
            // an empty repo. Name the available repos so the caller can pass one.
            const available = db.all<{ name: string }>(`SELECT name FROM repos ORDER BY name`).map((r) => r.name);
            return ok({ repo: '', results: [], total_matched: 0, warning: 'repo-unspecified', available_repos: available, mode });
          }
          repo = sole;
        }

        if (!graph) {
          return ok({ results: [], total_matched: 0, warning: 'world-model-unavailable', mode });
        }

        // Keyword: substring match over summary + path. Score is constant
        // until kuzu's FTS extension lands (follow-up post-v0.7).
        // Semantic: requires kuzu's vector extension — also follow-up.
        // Hybrid: falls back to keyword + 'semantic_unavailable' warning.
        const hits = graph.keywordSearchDirectories(repo, query, k);

        if (mode === 'keyword') {
          return ok({
            results: hits.map((h) => ({
              repo: h.repo,
              path: h.path,
              summary: h.summary,
              summary_source: h.summary_source,
              file_count: h.file_count,
              score: h.score,
            })),
            total_matched: hits.length,
            mode: 'keyword',
          });
        }

        if (mode === 'semantic') {
          return ok({
            results: [],
            total_matched: 0,
            warning: 'semantic_unavailable',
            mode: 'semantic',
          });
        }

        // hybrid — return keyword results with semantic_unavailable warning
        return ok({
          results: hits.map((h) => ({
            repo: h.repo,
            path: h.path,
            summary: h.summary,
            summary_source: h.summary_source,
            file_count: h.file_count,
            score: h.score,
          })),
          total_matched: hits.length,
          warning: 'semantic_unavailable',
          mode: 'hybrid',
        });
      }),
    ),
  };

  return { definitions, handlers };
}
