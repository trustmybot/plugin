import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { topKByCosine } from '../embeddings/store.js';
import type { WorldModelGraph, DirectoryNode } from '../graph-db.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

type DirRow = DirectoryNode & { id: number };

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

export function worldModelTools(db: TrajectoryDB, graph: WorldModelGraph | null): {
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
    {
      name: 'world_model_search',
      description:
        "Search the world model — bro's directory-level memory — via keyword (FTS5), semantic (cosine), or hybrid (RRF) ranking. Returns top-K dir summaries with their paths. Default mode is hybrid; falls back to keyword if embeddings are unavailable (warning: 'semantic_unavailable'). Use for 'where in this codebase does X live' questions — cheaper than reading the full tree from world_model_get.",
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
              'Optional — restrict to one repo. Defaults to `tmb_default_repo` from plugin_config.',
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

        if (!graph) {
          return ok({ repo, root: null, warning: 'world-model-unavailable' });
        }

        const nodes = graph.allDirectoriesForRepo(repo);
        if (nodes.length === 0) {
          return ok({ repo, root: null, warning: 'world-model-empty' });
        }

        const rows: DirRow[] = nodes.map((n, idx) => ({ ...n, id: idx }));
        const tree = buildTree(rows, path, depth);
        if (!tree) {
          return ok({ repo, root: null, warning: 'path-not-found', path });
        }

        return ok({ repo, root: tree });
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
          const cfg = db.get<{ value_json: string }>(
            "SELECT value_json FROM plugin_config WHERE key = 'tmb_default_repo'",
          );
          if (cfg?.value_json) {
            try {
              repo = JSON.parse(cfg.value_json) as string;
            } catch {
              // empty
            }
          }
        }

        interface SearchHit {
          id: number;
          repo: string;
          path: string;
          summary: string;
          summary_source: string;
          file_count: number;
          score: number;
        }

        const fetchById = (id: number): SearchHit | null => {
          const row = db.get<{
            id: number;
            repo: string;
            path: string;
            summary: string;
            summary_source: string;
            file_count: number;
          }>(
            'SELECT id, repo, path, summary, summary_source, file_count FROM directories WHERE id = ? AND (? = \'\' OR repo = ?)',
            [id, repo, repo],
          );
          if (!row) return null;
          return { ...row, score: 0 };
        };

        if (mode === 'keyword' || mode === 'hybrid') {
          const ftsRows = db.all<{
            id: number;
            repo: string;
            path: string;
            summary: string;
            summary_source: string;
            file_count: number;
            bm25_score: number;
          }>(
            "SELECT d.id, d.repo, d.path, d.summary, d.summary_source, d.file_count, bm25(directories_fts) AS bm25_score FROM directories_fts JOIN directories d ON d.id = directories_fts.rowid WHERE directories_fts MATCH ? AND (? = '' OR d.repo = ?) ORDER BY bm25(directories_fts) ASC LIMIT ?",
            [query, repo, repo, k * 2],
          );

          if (mode === 'keyword') {
            return ok({
              results: ftsRows.slice(0, k).map((r) => ({
                id: r.id,
                repo: r.repo,
                path: r.path,
                summary: r.summary,
                summary_source: r.summary_source,
                file_count: r.file_count,
                score: -r.bm25_score,
              })),
              total_matched: ftsRows.length,
              mode: 'keyword',
            });
          }

          // hybrid: RRF combine FTS rank + cosine rank
          const cosineResults = await topKByCosine(db, 'directories', query, k * 2);
          if (cosineResults.length === 0 && ftsRows.length === 0) {
            return ok({ results: [], total_matched: 0, mode: 'hybrid' });
          }

          const RRF_K = 60;
          const scoreById = new Map<number, number>();
          ftsRows.forEach((row, idx) => {
            const rrf = 1 / (RRF_K + idx + 1);
            scoreById.set(row.id, (scoreById.get(row.id) ?? 0) + rrf);
          });
          cosineResults.forEach((cr, idx) => {
            const rrf = 1 / (RRF_K + idx + 1);
            scoreById.set(cr.rowid, (scoreById.get(cr.rowid) ?? 0) + rrf);
          });

          const ranked = [...scoreById.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, k);

          const results: SearchHit[] = [];
          for (const [id, score] of ranked) {
            const hit = fetchById(id);
            if (hit) results.push({ ...hit, score });
          }

          const out: Record<string, unknown> = {
            results,
            total_matched: scoreById.size,
            mode: 'hybrid',
          };
          if (cosineResults.length === 0) out['warning'] = 'semantic_unavailable';
          return ok(out);
        }

        // semantic
        const cosineResults = await topKByCosine(db, 'directories', query, k);
        if (cosineResults.length === 0) {
          return ok({ results: [], total_matched: 0, warning: 'semantic_unavailable', mode: 'semantic' });
        }
        const results: SearchHit[] = [];
        for (const cr of cosineResults) {
          const hit = fetchById(cr.rowid);
          if (hit) results.push({ ...hit, score: cr.score });
        }
        return ok({ results, total_matched: results.length, mode: 'semantic' });
      }),
    ),
  };

  return { definitions, handlers };
}
