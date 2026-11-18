import { nowISO } from '../db.js';
import { integrated } from '../hooks/clean-merged-branch.js';
import { serverLog } from '../logger.js';
import { inSymbolScope } from '../parsing/extract.js';
import { repoPaths } from '../parsing/runners.js';
import { extractFiles, NAME_ONLY_EDGES, Resolver, sharedCandidates, symbolsStamp, } from '../symbol-index.js';
import { WORLD_MODEL_OVERLAY_TRIGGER } from '../task-rework.js';
import { insertAudit } from '../tools/audit.js';
import { blobMd5 } from '../tools/scan-walk.js';
import { CommitContent, diffNameStatus, lsTree, mergeBase, revParseCommit } from '../utils/git-objects.js';
import { resolveSoleRepo } from '../utils/repo-paths.js';
const OVERLAY_TRIGGER = WORLD_MODEL_OVERLAY_TRIGGER;
export function dropTaskOverlay(db, taskId) {
    db.run(`DELETE FROM wm_overlays WHERE task_id = ?`, [taskId]);
}
// The diff's base: the task's recorded base, else where the commit left the
// repo's indexed commit.
function overlayBase(db, repo, repoPath, task, commit) {
    const recorded = task.base_sha ? revParseCommit(repoPath, task.base_sha) : null;
    if (recorded)
        return recorded;
    const indexed = db.get(`SELECT indexed_commit FROM repos WHERE name = ?`, [repo])?.indexed_commit;
    return indexed ? mergeBase(repoPath, indexed, commit) : null;
}
// Build (or replace) the task's overlay from its commit. null when the task
// has no commit or repo to read it from; throws when git cannot list the
// commit's tree or diff.
export async function buildTaskOverlay(db, taskId) {
    const started = Date.now();
    const task = db.get(`SELECT id, repo, commit_sha, base_sha, no_code_class FROM tasks WHERE id = ?`, [taskId]);
    if (!task?.commit_sha)
        return null;
    const repo = resolveSoleRepo(db, task.repo ?? undefined);
    if (!repo)
        return null;
    const commit = revParseCommit(repo.path, task.commit_sha);
    if (!commit)
        throw new Error(`overlay: commit ${task.commit_sha} not found in ${repo.path}`);
    const base = overlayBase(db, repo.name, repo.path, task, commit);
    if (!base)
        throw new Error(`overlay: no base commit for task ${taskId}`);
    const tree = lsTree(repo.path, commit);
    const diff = tree ? diffNameStatus(repo.path, base, commit) : null;
    if (!tree || !diff)
        throw new Error(`overlay: git cannot list ${base}..${commit}`);
    const content = new CommitContent(repo.path, commit, tree, true);
    try {
        const files = [];
        for (const { path } of diff) {
            const entry = tree.get(path);
            files.push(entry
                ? { path, status: 'present', content_md5: blobMd5(await content.read(path)), size_bytes: entry.size, symbols_md5: null }
                : { path, status: 'deleted', content_md5: null, size_bytes: null, symbols_md5: null });
        }
        const stale = task.no_code_class === null
            ? files
                .filter((f) => f.status === 'present' && inSymbolScope(f.path))
                .map((f) => ({ path: f.path, content_md5: f.content_md5, size_bytes: f.size_bytes }))
            : [];
        const { parsed } = await extractFiles(stale, (p) => content.text(p), repo.path, () => repoPaths([...tree.keys()]));
        const parsedPaths = new Set(parsed.map((p) => p.file.path));
        for (const f of files)
            if (parsedPaths.has(f.path))
                f.symbols_md5 = symbolsStamp(f.content_md5);
        const counts = db.transaction(() => {
            dropTaskOverlay(db, taskId);
            const overlayId = Number(db.run(`INSERT INTO wm_overlays (task_id, repo, base_sha, commit_sha, built_at, path_count) VALUES (?, ?, ?, ?, ?, ?)`, [
                taskId,
                repo.name,
                base,
                commit,
                nowISO(),
                files.length,
            ]).lastInsertRowid);
            for (const f of files) {
                db.run(`INSERT INTO wm_overlay_files (overlay_id, path, status, content_md5, size_bytes, symbols_md5) VALUES (?, ?, ?, ?, ?, ?)`, [overlayId, f.path, f.status, f.content_md5, f.size_bytes, f.symbols_md5]);
            }
            const own = [];
            const pending = [];
            for (const { file, extraction } of parsed) {
                if (!extraction)
                    continue;
                const ids = extraction.symbols.map((s) => {
                    const id = Number(db.run(`INSERT INTO wm_overlay_symbols (overlay_id, path, kind, qualified_name, signature, doc, start_line, end_line, body_hash, exported, run_order, params_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [overlayId, file.path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, s.run_order ?? null, s.params_json ?? null]).lastInsertRowid);
                    own.push({ id: -id, path: file.path, kind: s.kind, qualified_name: s.qualified_name });
                    return id;
                });
                for (const edge of extraction.edges) {
                    const rowid = Number(db.run(`INSERT INTO wm_overlay_edges (overlay_id, src_id, dst_name, kind, resolution, line, hint) VALUES (?, ?, ?, ?, ?, ?, ?)`, [overlayId, ids[edge.src], edge.dst_name, edge.kind, NAME_ONLY_EDGES.has(edge.kind) ? 'name' : 'unresolved', edge.line, edge.hint]).lastInsertRowid);
                    pending.push({ rowid, from: file.path, edge });
                }
            }
            const hidden = new Set(files.filter((f) => f.status === 'deleted' || f.symbols_md5 !== null).map((f) => f.path));
            const resolver = new Resolver([...sharedCandidates(db, repo.name, hidden), ...own], pending);
            let resolved = 0;
            for (const p of pending) {
                const hit = resolver.resolve(p.from, p.edge);
                if (!hit)
                    continue;
                db.run(`UPDATE wm_overlay_edges SET dst_overlay_id = ?, dst_symbol_id = ?, resolution = ? WHERE rowid = ?`, [
                    hit.dst < 0 ? -hit.dst : null,
                    hit.dst > 0 ? hit.dst : null,
                    hit.how,
                    p.rowid,
                ]);
                resolved++;
            }
            return { symbols: own.length, edges: pending.length, resolved };
        });
        const build = {
            task_id: taskId,
            repo: repo.name,
            base_sha: base,
            commit_sha: commit,
            path_count: files.length,
            files_parsed: parsed.filter((p) => p.extraction !== null).length,
            symbols: counts.symbols,
            edges: counts.edges,
            duration_ms: Date.now() - started,
        };
        recordOverlayBuild(db, build);
        return build;
    }
    finally {
        content.close();
    }
}
function recordOverlayBuild(db, build) {
    insertAudit(db, {
        issue_id: -1,
        from_node: 'system',
        event_type: 'wm_reindex',
        summary: `World model overlay of task ${build.task_id} built at ${build.commit_sha.slice(0, 12)}: ${build.path_count} paths diffed from ${build.base_sha.slice(0, 12)}, ${build.files_parsed} parsed in ${build.duration_ms} ms`,
        content_json: JSON.stringify({ ...build, mode: OVERLAY_TRIGGER, trigger: OVERLAY_TRIGGER }),
        repo: build.repo,
    });
}
// The task's overlay as a SymbolView over the shared index, rebuilt first
// when tasks.commit_sha moved since the build. null when the task has no
// overlay or the rebuild fails, so the read falls back to the shared index.
export async function taskOverlay(db, taskId) {
    if (taskId === null || !Number.isSafeInteger(taskId))
        return null;
    const row = db.get(`SELECT o.commit_sha, t.commit_sha AS task_commit FROM wm_overlays o LEFT JOIN tasks t ON t.id = o.task_id WHERE o.task_id = ?`, [taskId]);
    if (!row)
        return null;
    let commit = row.commit_sha;
    if (row.task_commit && !commit.startsWith(row.task_commit.toLowerCase())) {
        try {
            const rebuilt = await buildTaskOverlay(db, taskId);
            if (!rebuilt)
                return null;
            commit = rebuilt.commit_sha;
        }
        catch (e) {
            dropTaskOverlay(db, taskId);
            serverLog({ event: 'wm_overlay_rebuild_error', task_id: taskId, error: e.message });
            return null;
        }
    }
    return { view: overlayView(taskId), task_id: taskId, commit_sha: commit };
}
// The shared symbols under a path the overlay deleted or re-parsed.
function hiddenShared(taskId) {
    return `SELECT s.id, s.path, s.kind, s.qualified_name
            FROM wm_overlays v
            JOIN wm_overlay_files f ON f.overlay_id = v.id AND (f.status = 'deleted' OR f.symbols_md5 IS NOT NULL)
            JOIN wm_symbols s ON s.repo = v.repo AND s.path = f.path
           WHERE v.task_id = ${taskId}`;
}
// Overlay symbols carry their negated id. A shared edge into a hidden symbol
// is moved to the overlay symbol with the same anchor key, or left with no
// target when the branch removed it.
export function overlayView(taskId) {
    if (!Number.isSafeInteger(taskId))
        throw new Error(`overlay: task id must be an integer (got ${taskId})`);
    const hidden = hiddenShared(taskId);
    const symbols = `(
    SELECT -o.id AS id, v.repo AS repo, o.path AS path, o.kind AS kind, o.qualified_name AS qualified_name,
           o.signature AS signature, o.doc AS doc, o.start_line AS start_line, o.end_line AS end_line,
           o.body_hash AS body_hash, o.exported AS exported, o.run_order AS run_order, o.params_json AS params_json
      FROM wm_overlay_symbols o JOIN wm_overlays v ON v.id = o.overlay_id
     WHERE v.task_id = ${taskId}
    UNION ALL
    SELECT s.id, s.repo, s.path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line,
           s.body_hash, s.exported, s.run_order, s.params_json
      FROM wm_symbols s
     WHERE s.id NOT IN (SELECT id FROM (${hidden})))`;
    const edges = `(
    SELECT e.src_id AS src_id, e.dst_id AS dst_id, e.dst_name AS dst_name, e.kind AS kind,
           e.resolution AS resolution, e.line AS line, e.hint AS hint
      FROM wm_edges e
     WHERE e.dst_id IS NULL OR e.dst_id NOT IN (SELECT id FROM (${hidden}))
    UNION ALL
    SELECT e.src_id,
           (SELECT -o.id FROM wm_overlay_symbols o JOIN wm_overlays v ON v.id = o.overlay_id
             WHERE v.task_id = ${taskId} AND o.path = h.path AND o.kind = h.kind AND o.qualified_name = h.qualified_name),
           e.dst_name, e.kind, e.resolution, e.line, e.hint
      FROM (${hidden}) h JOIN wm_edges e ON e.dst_id = h.id
    UNION ALL
    SELECT -oe.src_id, COALESCE(-oe.dst_overlay_id, oe.dst_symbol_id), oe.dst_name, oe.kind, oe.resolution, oe.line, oe.hint
      FROM wm_overlay_edges oe JOIN wm_overlays v ON v.id = oe.overlay_id
     WHERE v.task_id = ${taskId})`;
    return { symbols, edges };
}
// Drop each overlay of `repo` whose commit's work is in `indexedCommit`
// (an ancestor, or a squash or cherry-pick of it): the shared index now holds
// it. Returns the dropped task ids.
export async function dropMergedOverlays(db, repo, repoPath, indexedCommit) {
    const dropped = [];
    for (const o of db.all(`SELECT task_id, commit_sha FROM wm_overlays WHERE repo = ?`, [repo])) {
        if (!(await integrated(repoPath, o.commit_sha, indexedCommit)))
            continue;
        dropTaskOverlay(db, Number(o.task_id));
        dropped.push(Number(o.task_id));
    }
    return dropped;
}
//# sourceMappingURL=overlay.js.map