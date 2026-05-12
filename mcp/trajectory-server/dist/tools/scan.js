import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
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
// Locate scripts/scan.sh relative to this compiled module. Plugin layout:
//   <plugin>/mcp/trajectory-server/dist/tools/scan.js
//   <plugin>/scripts/scan.sh
// Walking up four levels lands at the plugin root.
function resolveScanScript() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '..', '..', '..', '..', 'scripts', 'scan.sh'),
        join(here, '..', '..', '..', 'scripts', 'scan.sh'),
    ];
    for (const c of candidates)
        if (existsSync(c))
            return c;
    // Fall back to the plugin root via CLAUDE_PLUGIN_ROOT.
    const pluginRoot = process.env['CLAUDE_PLUGIN_ROOT'];
    if (pluginRoot) {
        const c = join(pluginRoot, 'scripts', 'scan.sh');
        if (existsSync(c))
            return c;
    }
    throw new Error('scan.sh not found — expected at <plugin>/scripts/scan.sh');
}
function runScan(sessionDir) {
    const script = resolveScanScript();
    const stdout = execFileSync('bash', [script, sessionDir], {
        encoding: 'utf8',
        maxBuffer: 200 * 1024 * 1024, // 200MB headroom for large monorepos
    });
    const parsed = JSON.parse(stdout);
    if (!parsed.repos || !parsed.files) {
        throw new Error('scan.sh emitted unexpected shape (missing repos/files)');
    }
    return parsed;
}
// Valid `source` values for scan_run (#2881). The default — bro_auto_initial —
// matches the historical un-tagged behavior (bro hit the registry-cold gate
// and remediated by running scan).
const VALID_SCAN_SOURCES = new Set([
    'user_manual',
    'bro_auto_post_close',
    'bro_auto_post_change',
    'bro_auto_initial',
]);
// Compute whether the current scan differs from the previous deep_scan_completed
// audit row in a way that warrants an arch-doc refresh (#2881). Currently a
// coarse heuristic: repo-set delta OR top-level dir set delta. Refinable later
// with package-manager / language-set deltas.
export function detectStructuralChange(db, currentRepos, currentTopDirs) {
    const prev = db.get(`SELECT content_json FROM audit
     WHERE event_type = 'deep_scan_completed'
     ORDER BY id DESC
     LIMIT 1`);
    if (!prev?.content_json)
        return true; // First scan ever — always structural.
    let parsed = {};
    try {
        parsed = JSON.parse(prev.content_json);
    }
    catch {
        return true;
    }
    const prevRepos = new Set(parsed.repos_seen ?? []);
    const curRepos = new Set(currentRepos.map((r) => r.name));
    if (prevRepos.size !== curRepos.size)
        return true;
    for (const r of curRepos)
        if (!prevRepos.has(r))
            return true;
    const prevDirs = new Set(parsed.top_dirs ?? []);
    if (prevDirs.size !== currentTopDirs.size)
        return true;
    for (const d of currentTopDirs)
        if (!prevDirs.has(d))
            return true;
    return false;
}
// Pick the repo whose path encloses (or equals) the scan session_dir. This is
// the cwd-aware default for `tmb_default_repo` — without it, scan picked the
// alphabetically-first repo, which surprises users launching CC from a deeper
// sibling (#2885). Falls back to repos[0].name when no repo encloses session_dir
// (e.g. session_dir is the workspace root above all repos).
export function preferredDefaultRepo(repos, sessionDir) {
    if (repos.length === 0)
        return '';
    const norm = (p) => p.replace(/\/+$/, '');
    const sd = norm(sessionDir);
    const enclosing = repos.find((r) => {
        const rp = norm(r.path);
        return sd === rp || sd.startsWith(rp + '/');
    });
    return (enclosing ?? repos[0]).name;
}
// Persist repos[] + files[] from a scan output. Transactional.
// Drift detection is md5-only: rows with matching md5 keep their summary
// (so re-running /scan doesn't blow away populated descriptions); rows
// where md5 differs get the summary cleared so future Reads repopulate.
function persistScan(db, out) {
    let repos_upserted = 0;
    let files_upserted = 0;
    let files_md5_changed = 0;
    const now = nowISO();
    db.transaction(() => {
        for (const r of out.repos) {
            db.run(`INSERT INTO repos (name, path, default_branch, head_commit_sha, file_count, last_scanned_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path = excluded.path,
           default_branch = excluded.default_branch,
           head_commit_sha = excluded.head_commit_sha,
           file_count = excluded.file_count,
           last_scanned_at = excluded.last_scanned_at,
           updated_at = excluded.updated_at`, [r.name, r.path, r.default_branch, r.head_commit_sha, r.file_count, now, now, now]);
            repos_upserted++;
        }
        for (const f of out.files) {
            const existing = db.get(`SELECT content_md5 FROM file_registry WHERE repo = ? AND path = ?`, [f.repo, f.path]);
            const md5Changed = !existing || existing.content_md5 !== f.content_md5;
            if (md5Changed)
                files_md5_changed++;
            // INSERT OR REPLACE rebuilds the row; preserve summary unless md5 changed.
            const summaryClause = md5Changed
                ? 'NULL, NULL'
                : `(SELECT summary FROM file_registry WHERE repo = ? AND path = ?), (SELECT summary_updated_at FROM file_registry WHERE repo = ? AND path = ?)`;
            const summaryArgs = md5Changed ? [] : [f.repo, f.path, f.repo, f.path];
            db.run(`INSERT OR REPLACE INTO file_registry
           (repo, path, type, size_bytes, last_commit_sha, content_md5, summary, summary_updated_at, imports_json, exports_json, metadata_json)
         VALUES (?, ?, 'source', ?, ?, ?, ${summaryClause}, '[]', '[]', '{}')`, [f.repo, f.path, f.size_bytes, f.last_commit_sha, f.content_md5, ...summaryArgs]);
            files_upserted++;
        }
    });
    return { repos_upserted, files_upserted, files_md5_changed };
}
export function scanTools(db) {
    const definitions = [
        {
            name: 'scan_run',
            description: 'Run a deterministic project scan: discovers git repos under the session dir, enumerates each repo\'s tracked files, computes md5 + size + last_commit_sha, and persists to repos + file_registry. Drift detection is md5-only (no git diff). Emits a deep_scan_completed audit event so the registry-cold gate clears. The audit content_json carries a `source` field naming who fired the scan (user_manual / bro_auto_post_close / bro_auto_post_change / bro_auto_initial) plus `structural_change` (whether the repos or top-level-dirs set changed vs the previous scan) — useful for diagnostics + the scan-side renderer pass (#2881). Phase 1 only — file summaries are filled by parallel subagents in Phase 2 (see commands/scan.md).',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    session_dir: {
                        type: 'string',
                        description: 'Absolute path to the session directory (workspace root). Defaults to the MCP server\'s CWD.',
                    },
                    source: {
                        type: 'string',
                        enum: ['user_manual', 'bro_auto_post_close', 'bro_auto_post_change', 'bro_auto_initial'],
                        description: 'Who fired this scan. user_manual = the user typed /scan; bro_auto_post_close = post-task-close-rescan.sh hook; bro_auto_post_change = bro decided to rescan mid-session; bro_auto_initial = bro hit the registry-cold gate and ran scan as remediation. Defaults to bro_auto_initial.',
                    },
                },
                required: ['agent'],
            },
        },
        {
            name: 'repos_list',
            description: 'List all repos discovered by the most recent scan.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                },
                required: ['agent'],
            },
        },
        {
            name: 'file_registry_bulk_upsert',
            description: 'Bulk-upsert file_registry rows from a JSON array. Preserves existing summaries when content_md5 matches; clears them otherwise. Lower-level companion to scan_run for tooling that has already enumerated files.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    files: {
                        type: 'array',
                        description: 'Array of { repo, path, size_bytes, content_md5, last_commit_sha } objects.',
                        items: {
                            type: 'object',
                            properties: {
                                repo: { type: 'string' },
                                path: { type: 'string' },
                                size_bytes: { type: 'integer' },
                                content_md5: { type: 'string' },
                                last_commit_sha: { type: 'string' },
                            },
                            required: ['repo', 'path', 'content_md5'],
                        },
                    },
                },
                required: ['agent', 'files'],
            },
        },
    ];
    const handlers = {
        scan_run: requireRoles('scan_run', ['bro'], wrap(async (args) => {
            const sessionDir = args['session_dir'] ?? process.cwd();
            const rawSource = args['source'] ?? 'bro_auto_initial';
            const source = VALID_SCAN_SOURCES.has(rawSource) ? rawSource : 'bro_auto_initial';
            const out = runScan(sessionDir);
            const stats = persistScan(db, out);
            // #2881: structural-change detection vs previous deep_scan_completed
            // audit. The flag rides in the audit content_json so downstream
            // tooling (the scan-side renderer pass, manual diagnostic queries)
            // can decide whether the scan changed the project shape.
            const topDirs = new Set(out.files.map((f) => f.path.split('/')[0]).filter(Boolean));
            const structuralChange = detectStructuralChange(db, out.repos, topDirs);
            // Emit deep_scan_completed audit row. Attach to the system issue
            // (id=-1) — this is a session-level event, not work-issue scoped.
            db.run(`INSERT INTO audit (issue_id, branch_id, from_node, kind, event_type, summary, content_json, created_at)
           VALUES (-1, NULL, 'bro', 'event', 'deep_scan_completed', ?, ?, ?)`, [
                `Scanned ${out.repos.length} repos, ${out.files.length} files (${stats.files_md5_changed} md5-changed) — source=${source}${structuralChange ? ', structural-change' : ''}`,
                JSON.stringify({
                    ...stats,
                    session_dir: out.session_dir,
                    scanned_at: out.scanned_at,
                    source,
                    structural_change: structuralChange,
                    repos_seen: out.repos.map((r) => r.name),
                    top_dirs: Array.from(topDirs).sort(),
                }),
                nowISO(),
            ]);
            // Set tmb_default_repo to the cwd-enclosing repo if possible, else
            // fall back to the first discovered repo. Helps resolveSpawnCwd pick a
            // sensible default for issue_sync (#2877) AND avoids the surprise where
            // alphabetical-first wins on workspace-pattern repos (#2885: a user
            // launching CC from ~/Git/GitHub/TMB/plugin saw tmb_default_repo set to
            // 'enterprise' just because it sorted first alphabetically among sibling
            // repos — every fallback path then targeted the wrong project).
            const existing = db.get(`SELECT value_json FROM plugin_config WHERE key = 'tmb_default_repo'`);
            if (!existing && out.repos.length > 0) {
                db.run(`INSERT INTO plugin_config (key, value_json, updated_at) VALUES (?, ?, ?)`, ['tmb_default_repo', JSON.stringify(preferredDefaultRepo(out.repos, sessionDir)), nowISO()]);
            }
            return ok({
                session_dir: out.session_dir,
                scanned_at: out.scanned_at,
                repos: out.repos.map((r) => ({ name: r.name, file_count: r.file_count })),
                source,
                structural_change: structuralChange,
                ...stats,
            });
        })),
        repos_list: requireRoles('repos_list', ['bro', 'swe', 'pr-reviewer'], wrap(async () => {
            const rows = db.all(`SELECT name, path, default_branch, head_commit_sha, file_count, last_scanned_at FROM repos ORDER BY name`);
            return ok({ repos: rows });
        })),
        file_registry_bulk_upsert: requireRoles('file_registry_bulk_upsert', ['bro', 'swe'], wrap(async (args) => {
            const files = (args['files'] ?? []);
            if (!Array.isArray(files))
                return err('files must be an array');
            const stats = persistScan(db, {
                session_dir: '',
                scanned_at: nowISO(),
                repos: [],
                files,
            });
            return ok(stats);
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=scan.js.map