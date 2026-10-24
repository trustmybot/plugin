import { requireRoles } from '../middleware/agent-scope.js';
import { WorldModelGraph } from '../graph.js';
import { topKByCosine } from '../embeddings/store.js';
import { backfillMissing, startWorldModelBackfill, WORLD_MODEL_TABLES } from '../embeddings/backfill.js';
import { repoRowPath, resolveSoleRepo } from '../utils/repo-paths.js';
import { spawnSync } from 'node:child_process';
import { resolveRepoDefaultBranch } from '../utils/git-refs.js';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { frameUntrusted } from '../utils/untrusted.js';
const WORLD_MODEL_GET_MAX_NODES = 500;
const RRF_K = 60;
const SEARCH_BACKFILL_LIMIT = 50;
const UNMERGED_WORK_MAX_BRANCHES = 10;
function git(repoPath, args) {
    return spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS });
}
// Twin of clean-merged-branch.sh's _cmb_integrated (GH 1674). A tip counts as
// integrated into target when any of these holds, cheapest first, each one
// bounded git call:
//   1. it is an ancestor of target (merge / fast-forward);
//   2. merging it into target is a no-op — `merge-tree --write-tree` yields
//      target's own tree (squash or rebase merge of any number of commits);
//   3. `git cherry` finds every branch commit's patch already in target (a
//      squashed single commit that target has since edited further).
// An upstream reported `[gone]` is not used: a PR closed unmerged looks the same.
export function tipIntegratedInto(repoPath, tip, target) {
    const ancestor = git(repoPath, ['merge-base', '--is-ancestor', tip, target]);
    if (ancestor.error)
        return 'spawn-error';
    if (ancestor.status === 0)
        return 'integrated';
    if (ancestor.status !== 1)
        return 'unresolvable';
    const merged = git(repoPath, ['merge-tree', '--write-tree', target, tip]);
    if (merged.status === 0) {
        const targetTree = git(repoPath, ['rev-parse', `${target}^{tree}`]);
        const mergedTree = merged.stdout.split('\n')[0]?.trim();
        if (targetTree.status === 0 && mergedTree && mergedTree === targetTree.stdout.trim())
            return 'integrated';
    }
    const cherry = git(repoPath, ['cherry', target, tip]);
    if (cherry.status === 0 && !/^\+/m.test(cherry.stdout))
        return 'integrated';
    return 'unmerged';
}
// Surface closed-task work living on un-merged feature branches (#1059). The
// main checkout answers world_model_get from the directory tree alone, so a
// checkout sitting on the target branch hides work committed on branches that
// have not merged yet — bro then reads an "empty" repo and holds. This walks
// the tasks table (rows with a commit_sha, grouped by branch_id, newest first)
// and keeps only branches that still have a live local ref whose tip is not yet
// integrated into the repo's target branch (tipIntegratedInto: ancestor, or a
// squash/rebase merge whose content target already holds). A deleted ref means
// the work was integrated or abandoned, so it is skipped. Fail-soft:
// a non-git repo path or any git spawn failure yields an empty list plus a
// warning, never an is_error.
function computeUnmergedWork(db, repo) {
    if (!repo)
        return { unmerged_work: [] };
    const repoRow = db.get(`SELECT path, target_branch FROM repos WHERE name = ?`, [repo]);
    if (!repoRow)
        return { unmerged_work: [] };
    const repoPath = repoRowPath(db, repoRow.path);
    const target = repoRow.target_branch || resolveRepoDefaultBranch(repoPath);
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
        // Require a live local ref: a deleted branch means the work was integrated
        // or abandoned.
        const refCheck = spawnSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch_id}`], { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS });
        if (refCheck.status !== 0)
            continue; // absent ref → integrated or abandoned, skip
        const integration = tipIntegratedInto(repoPath, entry.tip, target);
        if (integration === 'spawn-error') {
            return { unmerged_work: [], warning: 'unmerged-work-unavailable' };
        }
        if (integration !== 'unmerged')
            continue; // integrated, or a dangling SHA skipped defensively
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
// How far a README summary can be trusted (GH 1680): 'current', 'drifting(n)'
// when n commits touched the dir since the README did, 'dead_refs(k)' when it
// names k deleted paths (joined with ', '); null when drift is unknown.
export function trustOf(node) {
    const behind = node.commits_behind ?? null;
    if (behind === null)
        return null;
    const dead = node.dead_refs?.length ?? 0;
    const parts = [];
    if (behind > 0)
        parts.push(`drifting(${behind})`);
    if (dead > 0)
        parts.push(`dead_refs(${dead})`);
    return parts.length > 0 ? parts.join(', ') : 'current';
}
function driftView(node) {
    return {
        summary_sha: node.summary_sha ?? null,
        commits_behind: node.commits_behind ?? null,
        dead_refs: node.dead_refs ?? null,
        trust: trustOf(node),
    };
}
// File purposes are extracted from file contents, so they leave the server
// framed as untrusted data; the graph keeps them raw.
function framedPurpose(purpose) {
    return purpose ? frameUntrusted('file-purpose', purpose) : '';
}
function fileView(f) {
    return {
        path: WorldModelGraph.relativeFilePath(f),
        purpose: framedPurpose(f.purpose),
        purpose_source: f.purpose_source,
        content_md5: f.content_md5,
    };
}
function dirResult(h) {
    return {
        kind: 'dir',
        repo: h.repo,
        path: h.path,
        summary: h.summary,
        summary_source: h.summary_source,
        file_count: h.file_count,
        ...driftView(h),
        score: h.score,
    };
}
function fileResult(h) {
    return {
        kind: 'file',
        repo: h.repo,
        path: WorldModelGraph.relativeFilePath(h),
        dir: h.dir,
        purpose: framedPurpose(h.purpose),
        purpose_source: h.purpose_source,
        score: h.score,
    };
}
function dirHit(node) {
    return { kind: 'dir', key: `dir:${node.key}`, node };
}
function fileHit(node) {
    return { kind: 'file', key: `file:${node.path}`, node };
}
function hitResult(hit, score) {
    return hit.kind === 'dir' ? dirResult({ ...hit.node, score }) : fileResult({ ...hit.node, score });
}
// Embed the rows a search would miss: a bounded batch inline so a fresh scan
// is searchable at once, the rest in the background.
async function backfillWorldModel(db) {
    let saturated = false;
    for (const table of WORLD_MODEL_TABLES) {
        if ((await backfillMissing(db, table, SEARCH_BACKFILL_LIMIT)) >= SEARCH_BACKFILL_LIMIT)
            saturated = true;
    }
    if (saturated)
        startWorldModelBackfill(db);
}
async function cosineHits(db, graph, repo, query, k) {
    const search = (table) => topKByCosine(db, table, query, k, [repo]);
    const [dirs, files] = [await search('wm_directories'), await search('wm_files')];
    const dirNodes = graph.directoriesByIds(dirs.map((d) => d.rowid));
    const fileNodes = graph.filesByIds(files.map((f) => f.rowid));
    const hits = [];
    for (const d of dirs) {
        const node = dirNodes.get(d.rowid);
        if (node)
            hits.push({ hit: dirHit(node), score: d.score });
    }
    for (const f of files) {
        const node = fileNodes.get(f.rowid);
        if (node)
            hits.push({ hit: fileHit(node), score: f.score });
    }
    return hits.sort((a, b) => b.score - a.score);
}
// Reciprocal rank fusion: each ranked list adds 1/(RRF_K + rank + 1) to a hit.
function fuse(lists) {
    const fused = new Map();
    for (const list of lists) {
        list.forEach((hit, rank) => {
            const rrf = 1 / (RRF_K + rank + 1);
            const entry = fused.get(hit.key);
            if (entry)
                entry.score += rrf;
            else
                fused.set(hit.key, { hit, score: rrf });
        });
    }
    return [...fused.values()].sort((a, b) => b.score - a.score);
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
            ...driftView(node),
            children,
        };
    }
    return descend(root, depth, 0);
}
export function worldModelTools(db, graphHolder) {
    const definitions = [
        {
            name: 'world_model_get',
            description: "Return the world model as an annotated directory tree. Each node carries a README-sourced summary (summary_source='readme') or structural fallback; README nodes add trust ('current', 'drifting(n)', 'dead_refs(k)'), summary_sha, commits_behind and dead_refs. Depth-1+ summaries are truncated to the first line. Returns truncated:true when the tree exceeds 500 nodes. A non-root path adds files[] (purposes); the root adds coverage. Also returns unmerged_work: closed-task branch tips not yet merged into the repo's target branch. Primary navigation surface for code-touching cold starts.",
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
            description: "Search dir summaries + file purposes. keyword: FTS5; semantic: embedding cosine; hybrid (default): both fused by RRF. Returns top-K hits tagged kind 'dir'|'file'; without embeddings, falls back to keyword with warning: 'semantic_unavailable'. Use for 'where does X live' — cheaper than world_model_get.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    query: {
                        type: 'string',
                        description: 'Search query. Keyword terms match whole words in paths, summaries and purposes (all terms must match; when none do, any non-stopword term, reported as match: any_term), plus path/text substrings; semantic matches natural language.',
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
        world_model_get: requireRoles('world_model_get', ['bro', 'swe', 'pr-reviewer', 'consultant'], wrap(async (args) => {
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
            const graph = graphHolder?.ensureGraph() ?? null;
            if (!graph) {
                return ok({ repo, root: null, warning: 'world-model-unavailable', unmerged_work: unmerged.unmerged_work });
            }
            if (graph.directoryCount(repo) === 0) {
                return ok({ repo, root: null, warning: 'world-model-empty', unmerged_work: unmerged.unmerged_work });
            }
            const rows = graph.subtree(repo, path, depth);
            const nodeCounter = { count: 0, limit: WORLD_MODEL_GET_MAX_NODES };
            const tree = buildTree(rows, path, depth, { nodeCounter });
            if (!tree) {
                return ok({ repo, root: null, warning: 'path-not-found', path, unmerged_work: unmerged.unmerged_work });
            }
            const truncated = nodeCounter.count >= WORLD_MODEL_GET_MAX_NODES;
            if (path !== '')
                tree.files = graph.filesForDirectory(repo, path).map(fileView);
            return ok({
                repo,
                root: tree,
                ...(path === '' ? { coverage: graph.fileCoverage(repo) } : {}),
                ...(truncated ? { truncated: true } : {}),
                ...(unmerged.warning ? { warning: unmerged.warning } : {}),
                unmerged_work: unmerged.unmerged_work,
            });
        })),
        world_model_search: requireRoles('world_model_search', ['bro', 'swe', 'pr-reviewer', 'consultant'], wrap(async (args) => {
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
            const graph = graphHolder?.ensureGraph() ?? null;
            if (!graph) {
                return ok({ results: [], total_matched: 0, warning: 'world-model-unavailable', mode });
            }
            const pool = mode === 'keyword' ? k : k * 4;
            const dirSearch = graph.keywordSearchDirectories(repo, query, pool);
            const fileSearch = graph.keywordSearchFiles(repo, query, pool);
            const match = dirSearch.match === 'any_term' || fileSearch.match === 'any_term' ? 'any_term' : 'all_terms';
            const keywordDirs = dirSearch.hits.map((n) => ({ hit: dirHit(n), score: n.score }));
            const keywordFiles = fileSearch.hits.map((n) => ({ hit: fileHit(n), score: n.score }));
            const keywordRanked = [...keywordDirs, ...keywordFiles].sort((a, b) => b.score - a.score);
            const hitsOf = (ranked) => ranked.map(({ hit }) => hit);
            const respond = (ranked, extra = {}) => {
                const results = ranked.slice(0, k).map(({ hit, score }) => hitResult(hit, score));
                return ok({ results, total_matched: results.length, ...extra, mode, match });
            };
            if (mode === 'keyword')
                return respond(keywordRanked);
            await backfillWorldModel(db);
            const semantic = await cosineHits(db, graph, repo, query, pool);
            if (semantic.length === 0)
                return respond(keywordRanked, { warning: 'semantic_unavailable' });
            if (mode === 'semantic')
                return respond(semantic);
            return respond(fuse([
                hitsOf(keywordDirs),
                hitsOf(keywordFiles),
                hitsOf(semantic.filter(({ hit }) => hit.kind === 'dir')),
                hitsOf(semantic.filter(({ hit }) => hit.kind === 'file')),
            ]));
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=world_model.js.map