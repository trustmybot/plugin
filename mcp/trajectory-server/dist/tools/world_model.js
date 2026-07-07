import { requireRoles } from '../middleware/agent-scope.js';
import { resolveSoleRepo } from '../utils/repo-paths.js';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
const WORLD_MODEL_GET_MAX_NODES = 500;
const UNMERGED_WORK_MAX_BRANCHES = 10;
// Surface closed-task work living on un-merged feature branches (#1059). The
// main checkout answers world_model_get from the directory tree alone, so a
// checkout sitting on the target branch hides work committed on branches that
// have not merged yet — bro then reads an "empty" repo and holds. This walks
// the tasks table (rows with a commit_sha, grouped by branch_id, newest first)
// and drops any branch whose tip is already an ancestor of the repo's target
// branch. Fail-soft: a non-git repo path or any git spawn failure yields an
// empty list plus a warning, never an is_error.
function computeUnmergedWork(db, repo) {
    if (!repo)
        return { unmerged_work: [] };
    const repoRow = db.get(`SELECT path, target_branch FROM repos WHERE name = ?`, [repo]);
    if (!repoRow)
        return { unmerged_work: [] };
    const dbDir = db.dbPath === ':memory:' ? process.cwd() : dirname(db.dbPath);
    const repoPath = repoRow.path.startsWith('/') ? repoRow.path : resolve(dbDir, repoRow.path);
    const target = repoRow.target_branch || 'dev';
    const gitCheck = spawnSync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
        timeout: SUBPROCESS_TIMEOUT_MS,
    });
    if (gitCheck.error || gitCheck.status !== 0) {
        return { unmerged_work: [], warning: 'unmerged-work-unavailable' };
    }
    const rows = db.all(`SELECT branch_id, parent_branch_id, commit_sha, status
       FROM tasks
      WHERE repo = ? AND commit_sha IS NOT NULL
      ORDER BY updated_at DESC, id DESC`, [repo]);
    // Group by branch_id; insertion order (newest updated_at first) is preserved,
    // so the first row per branch carries the tip. closed_tasks counts the closed
    // commit-bearing tasks on the branch.
    const byBranch = new Map();
    for (const r of rows) {
        let entry = byBranch.get(r.branch_id);
        if (!entry) {
            entry = { parent_branch_id: r.parent_branch_id, tip: r.commit_sha, closed_tasks: 0 };
            byBranch.set(r.branch_id, entry);
        }
        if (r.status === 'closed')
            entry.closed_tasks++;
    }
    const unmerged_work = [];
    for (const [branch_id, entry] of [...byBranch.entries()].slice(0, UNMERGED_WORK_MAX_BRANCHES)) {
        const mergeBase = spawnSync('git', ['-C', repoPath, 'merge-base', '--is-ancestor', entry.tip, target], { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS });
        if (mergeBase.error) {
            return { unmerged_work: [], warning: 'unmerged-work-unavailable' };
        }
        if (mergeBase.status === 0)
            continue; // tip is an ancestor of target → merged, omit
        unmerged_work.push({
            branch_id,
            parent_branch_id: entry.parent_branch_id,
            tip: entry.tip,
            closed_tasks: entry.closed_tasks,
            merged_into_target: false,
        });
    }
    return { unmerged_work };
}
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
function wrap(fn) {
    return async (args) => {
        try {
            return await fn(args);
        }
        catch (e) {
            return err(e.message);
        }
    };
}
// Build the tree by indexing rows by parent_path, then descending from the
// requested root. Sorting children alphabetically gives stable output.
// depthForSummary is the root's logical depth (0 = root itself). Summaries
// at depth > 1 are truncated to the first line to keep the payload compact.
export function buildTree(rows, rootPath, depth, opts) {
    const byParent = new Map();
    for (const r of rows) {
        const key = r.parent_path ?? '__ROOT__';
        if (!byParent.has(key))
            byParent.set(key, []);
        byParent.get(key).push(r);
    }
    const root = rows.find((r) => r.path === rootPath);
    if (!root)
        return null;
    // Top-level dirs carry parent_path '' (the repo root's own path), so they're
    // filed under '' alongside the root node itself. descend must exclude the
    // node from its own child list, and a visited set guards against any cycle in
    // the stored graph so traversal can't recurse forever. (#269, #272)
    const visited = new Set();
    const counter = opts?.nodeCounter;
    const depthOffset = opts?.depthOffset ?? 0;
    function descend(node, remainingDepth, currentDepth) {
        visited.add(node.path);
        if (counter)
            counter.count++;
        const children = [];
        if (remainingDepth === null || remainingDepth > 0) {
            const kids = (byParent.get(node.path) ?? []).filter((k) => k.path !== node.path && !visited.has(k.path));
            kids.sort((a, b) => a.path.localeCompare(b.path));
            for (const k of kids) {
                if (counter && counter.count >= counter.limit)
                    break;
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
export function worldModelTools(db, graph) {
    const definitions = [
        {
            name: 'world_model_get',
            description: "Return the world model as an annotated directory tree. Each node carries a README-sourced summary (summary_source='readme') or structural fallback. Depth-1+ summaries are truncated to the first line. Returns truncated:true when the tree exceeds 500 nodes. Also returns unmerged_work: closed-task branch tips not yet merged into the repo's target branch. Primary navigation surface for code-touching cold starts.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    repo: {
                        type: 'string',
                        description: 'Repo name (matches `repos.name`). Defaults to the sole registered repo when exactly one exists; required in multi-repo projects.',
                    },
                    path: {
                        type: 'string',
                        description: "Starting directory path, repo-relative. Defaults to the repo root ('').",
                    },
                    depth: {
                        type: ['integer', 'null'],
                        description: 'How deep to descend. Defaults to 2 (root + immediate children). Pass null for the full subtree.',
                    },
                },
                required: ['agent'],
            },
        },
        {
            name: 'world_model_search',
            description: "Search the world model by summary + path match. Returns top-K dir summaries with their paths. Default mode is hybrid; falls back to keyword with warning: 'semantic_unavailable'. Use for 'where does X live' questions — cheaper than world_model_get.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    query: {
                        type: 'string',
                        description: 'Search query. For keyword/hybrid: FTS5 MATCH syntax. For semantic: natural language.',
                    },
                    mode: {
                        type: 'string',
                        enum: ['keyword', 'semantic', 'hybrid'],
                        description: 'Search mode. Default: hybrid (RRF combines FTS5 + cosine).',
                    },
                    repo: {
                        type: 'string',
                        description: 'Optional — restrict to one repo. Defaults to the sole registered repo when exactly one exists; unrestricted in multi-repo projects.',
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
    const handlers = {
        world_model_get: requireRoles('world_model_get', ['bro', 'swe', 'pr-reviewer'], wrap(async (args) => {
            let repo = args['repo'] ?? '';
            if (!repo) {
                const available = db.all(`SELECT name FROM repos ORDER BY name`).map((r) => r.name);
                if (available.length >= 2) {
                    // Multi-repo with no selector: don't silently target one repo.
                    // Name the available repos so the caller can pass one.
                    return ok({ repo: '', root: null, warning: 'repo-unspecified', available_repos: available });
                }
                // 0 repos → fall through with repo='' to the empty/unavailable paths.
                // Exactly 1 → resolve the sole repo.
                repo = resolveSoleRepo(db)?.name ?? '';
            }
            const path = args['path'] ?? '';
            const depthArg = args['depth'];
            const depth = depthArg === null ? null : typeof depthArg === 'number' ? depthArg : 2;
            // Always present per resolved repo (#1059). In the degraded paths below
            // the world-model warning takes precedence; the unmerged_work array
            // still rides along so bro sees in-flight branch work either way.
            const unmerged = computeUnmergedWork(db, repo);
            if (!graph) {
                return ok({ repo, root: null, warning: 'world-model-unavailable', unmerged_work: unmerged.unmerged_work });
            }
            const nodes = graph.allDirectoriesForRepo(repo);
            if (nodes.length === 0) {
                return ok({ repo, root: null, warning: 'world-model-empty', unmerged_work: unmerged.unmerged_work });
            }
            const rows = nodes;
            const nodeCounter = { count: 0, limit: WORLD_MODEL_GET_MAX_NODES };
            const tree = buildTree(rows, path, depth, { nodeCounter });
            if (!tree) {
                return ok({ repo, root: null, warning: 'path-not-found', path, unmerged_work: unmerged.unmerged_work });
            }
            const truncated = nodeCounter.count >= WORLD_MODEL_GET_MAX_NODES;
            return ok({
                repo,
                root: tree,
                ...(truncated ? { truncated: true } : {}),
                ...(unmerged.warning ? { warning: unmerged.warning } : {}),
                unmerged_work: unmerged.unmerged_work,
            });
        })),
        world_model_search: requireRoles('world_model_search', ['bro', 'swe', 'pr-reviewer'], wrap(async (args) => {
            const query = args['query'];
            if (!query || typeof query !== 'string')
                return err('query is required');
            const mode = args['mode'] ?? 'hybrid';
            const k = Math.min(Math.max(1, args['k'] ?? 5), 20);
            let repo = args['repo'] ?? '';
            if (!repo) {
                const available = db.all(`SELECT name FROM repos ORDER BY name`).map((r) => r.name);
                if (available.length >= 2) {
                    // Multi-repo with no selector: don't silently search one repo.
                    // Name the available repos so the caller can pass one.
                    return ok({ repo: '', results: [], total_matched: 0, warning: 'repo-unspecified', available_repos: available, mode });
                }
                // 0 repos → fall through with repo='' to the empty/unavailable paths.
                // Exactly 1 → resolve the sole repo.
                repo = resolveSoleRepo(db)?.name ?? '';
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
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=world_model.js.map