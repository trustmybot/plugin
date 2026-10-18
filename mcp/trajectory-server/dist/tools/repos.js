import { requireRoles } from '../middleware/agent-scope.js';
import { repoSlugFromRemoteUrl } from '../sync/issue_sync.js';
import { insertAudit } from './audit.js';
import { taskWorktreePath } from './composites.js';
import { LIVE_TASK_STATUSES } from './lifecycle.js';
export { resolveRepoDefaultBranch } from '../utils/git-refs.js';
import { repoRemotes } from '../repos/remotes.js';
// Every table whose `repo` column is an FK to repos(name), with its move.
export const REPO_FK_CHILDREN = [
    ['milestones', 'UPDATE milestones SET repo = ? WHERE repo = ?'],
    ['repo_remotes', 'UPDATE repo_remotes SET repo = ? WHERE repo = ?'],
    ['issues', 'UPDATE issues SET repo = ? WHERE repo = ?'],
    ['tasks', 'UPDATE tasks SET repo = ? WHERE repo = ?'],
    ['audit', 'UPDATE audit SET repo = ? WHERE repo = ?'],
    ['validation_attempts', 'UPDATE validation_attempts SET repo = ? WHERE repo = ?'],
    ['discussions', 'UPDATE discussions SET repo = ? WHERE repo = ?'],
    ['agent_runs', 'UPDATE agent_runs SET repo = ? WHERE repo = ?'],
];
function pathHasSegment(path, segment) {
    return path.split('/').includes(segment);
}
// Live tasks whose worktree (the computed task_provision path, or an open run's
// root_dir) sits under a directory named `old`. Renaming under them would strand
// the worktree's recorded location.
function blockingTasks(db, old, oldPath) {
    const tasks = db.all(`SELECT t.id, t.status, t.branch_id, r.path AS repo_path
       FROM tasks t LEFT JOIN repos r ON r.name = t.repo
      WHERE t.status IN (SELECT value FROM json_each(?))`, [JSON.stringify(LIVE_TASK_STATUSES)]);
    const blocking = [];
    for (const t of tasks) {
        const roots = db
            .all(`SELECT root_dir FROM agent_runs WHERE task_id = ? AND completed_at IS NULL AND root_dir IS NOT NULL`, [t.id])
            .map((r) => r.root_dir);
        const repoPath = t.repo_path ?? oldPath;
        const candidates = [taskWorktreePath(repoPath, t.branch_id), ...roots];
        const hit = candidates.find((p) => pathHasSegment(p, old));
        if (hit)
            blocking.push({ id: t.id, status: t.status, worktree: hit });
    }
    return blocking;
}
// The pr_review_runs host-slug rewrites implied by the repo's remotes: a remote
// whose last path segment names the old (or already the new) repo identifies
// the owner prefix; both the host-qualified and the bare owner/repo forms move.
function slugRewrites(remotes, old, next) {
    const pairs = new Map();
    for (const r of remotes) {
        const full = repoSlugFromRemoteUrl(r.url);
        if (!full)
            continue;
        const cut = full.lastIndexOf('/');
        if (cut < 0)
            continue;
        const prefix = full.slice(0, cut);
        const last = full.slice(cut + 1).toLowerCase();
        if (last !== old.toLowerCase() && last !== next.toLowerCase())
            continue;
        const oldFull = last === old.toLowerCase() ? full : `${prefix}/${old}`;
        const newFull = last === next.toLowerCase() ? full : `${prefix}/${next}`;
        pairs.set(oldFull, newFull);
        const bare = (s) => s.replace(/^[^/]+\//, '');
        if (bare(oldFull) !== oldFull)
            pairs.set(bare(oldFull), bare(newFull));
    }
    return [...pairs.entries()];
}
export function renameRepo(db, graph, input) {
    const { old, reason } = input;
    const next = input.new;
    if (old === next)
        return { renamed: false, error: 'repo_same', old, new: next };
    const row = db.get(`SELECT name, path FROM repos WHERE name = ?`, [old]);
    if (!row)
        return { renamed: false, error: 'repo_not_found', old, new: next };
    if (db.get(`SELECT 1 AS x FROM repos WHERE name = ?`, [next])) {
        return { renamed: false, error: 'repo_exists', old, new: next };
    }
    if (!input.force) {
        const blocking = blockingTasks(db, old, row.path);
        if (blocking.length > 0) {
            return { renamed: false, error: 'rename_in_progress', old, new: next, blocking_tasks: blocking };
        }
    }
    const remotes = repoRemotes(db, old);
    // foreign_keys cannot change inside a transaction, so it is switched off
    // around it; foreign_key_check inside the transaction is the real guard.
    db.run('PRAGMA foreign_keys = OFF');
    try {
        return db.transaction(() => {
            const rows_by_table = {};
            db.run(`INSERT INTO repos (name, path, file_count, last_scanned_at, target_branch, branching_model, protected_branches)
         SELECT ?, path, file_count, last_scanned_at, target_branch, branching_model, protected_branches
           FROM repos WHERE name = ?`, [next, old]);
            for (const [table, sql] of REPO_FK_CHILDREN) {
                rows_by_table[table] = Number(db.run(sql, [next, old]).changes);
            }
            let prRuns = 0;
            for (const [from, to] of slugRewrites(remotes, old, next)) {
                prRuns += Number(db.run(`UPDATE pr_review_runs SET repo = ? WHERE repo = ? COLLATE NOCASE`, [to, from]).changes);
            }
            rows_by_table['pr_review_runs'] = prRuns;
            db.run(`DELETE FROM repos WHERE name = ?`, [old]);
            const violations = db.all('PRAGMA foreign_key_check');
            if (violations.length > 0) {
                throw new Error(`repo_rename: foreign_key_check found ${violations.length} dangling reference(s); rolled back`);
            }
            let graphState = 'deferred';
            let graph_nodes = 0;
            let graph_error;
            if (graph) {
                try {
                    graph_nodes = graph.renameRepo(old, next);
                    graphState = 'rekeyed';
                }
                catch (e) {
                    graph_error = e.message;
                }
            }
            const audit_id = insertAudit(db, {
                issue_id: -1,
                from_node: input.from_node ?? 'bro',
                event_type: 'repo_renamed',
                summary: `Repo renamed ${old} → ${next}; graph ${graphState}`,
                content_json: JSON.stringify({
                    old,
                    new: next,
                    reason,
                    rows_by_table,
                    graph: graphState,
                    graph_nodes,
                    ...(graph_error ? { graph_error } : {}),
                }),
                repo: next,
            });
            return {
                renamed: true,
                old,
                new: next,
                rows_by_table,
                graph: graphState,
                graph_nodes,
                ...(graph_error ? { graph_error } : {}),
                audit_id,
            };
        });
    }
    finally {
        db.run('PRAGMA foreign_keys = ON');
    }
}
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function refuse(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: true };
}
export function repoTools(db, graphHolder = null) {
    const definitions = [
        {
            name: 'repo_rename',
            description: 'Rename a repo in one transaction: the repos row, every repo FK, pr_review_runs slugs and world-model nodes (graph deferred to the next scan_run when kuzu is down). Audited repo_renamed. Refuses repo_same, repo_not_found, repo_exists, rename_in_progress (force overrides).',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    old: { type: 'string' },
                    new: { type: 'string' },
                    reason: { type: 'string' },
                    force: { type: 'boolean', description: 'Rename even when a live task worktree sits under the old name.' },
                },
                required: ['agent', 'old', 'new', 'reason'],
            },
        },
    ];
    const handlers = {
        repo_rename: requireRoles('repo_rename', ['bro'], async (args) => {
            const old = typeof args['old'] === 'string' ? args['old'].trim() : '';
            const next = typeof args['new'] === 'string' ? args['new'].trim() : '';
            const reason = typeof args['reason'] === 'string' ? args['reason'].trim() : '';
            if (!old || !next || !reason) {
                return refuse({ error: 'invalid_args', message: 'old, new and reason are required non-empty strings' });
            }
            try {
                const graph = graphHolder?.ensureGraph() ?? null;
                const out = renameRepo(db, graph, { old, new: next, reason, force: args['force'] === true });
                return out.renamed ? ok(out) : refuse(out);
            }
            catch (e) {
                return refuse({ error: 'rename_failed', message: e.message });
            }
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=repos.js.map