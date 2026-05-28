import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
    let stdout;
    try {
        stdout = execFileSync('bash', [script, sessionDir], {
            encoding: 'utf8',
            maxBuffer: 200 * 1024 * 1024, // 200MB headroom for large monorepos
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch (e) {
        // Surface scan.sh's real failure (exit code + stderr) rather than masking
        // it as a JSON.parse error on partial stdout. (#285)
        const se = e;
        const stderr = se.stderr ? se.stderr.toString().slice(0, 2000) : '';
        throw new Error(`scan.sh failed (exit ${se.status ?? '?'}): ${stderr || se.message || 'unknown error'}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        throw new Error(`scan.sh emitted non-JSON output (first 500 chars): ${stdout.slice(0, 500)}`);
    }
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
// Directory-level world model population (v0.7 world-model). For each unique
// dir implied by the scanned file set, populate the row's summary from
// <dir>/README.md when present (author-curated, high-trust). Dirs without a
// README land with summary=NULL — lazy LLM fill is the agent's responsibility.
// See docs/architecture/WORLD_MODEL.md + ADR 0001.
const README_CANDIDATES = ['README.md', 'readme.md', 'README.rst', 'readme.rst'];
const README_MAX_BYTES = 1024;
function deriveDirectoryEntries(out) {
    const dirMap = new Map();
    function ensureDir(repo, dirPath) {
        const key = `${repo} ${dirPath}`;
        if (dirMap.has(key))
            return;
        let parent_path = null;
        if (dirPath !== '') {
            const lastSlash = dirPath.lastIndexOf('/');
            parent_path = lastSlash >= 0 ? dirPath.slice(0, lastSlash) : '';
        }
        dirMap.set(key, { repo, path: dirPath, parent_path, file_count: 0 });
        if (parent_path !== null)
            ensureDir(repo, parent_path);
    }
    for (const r of out.repos)
        ensureDir(r.name, '');
    for (const f of out.files) {
        const lastSlash = f.path.lastIndexOf('/');
        const dirPath = lastSlash >= 0 ? f.path.slice(0, lastSlash) : '';
        ensureDir(f.repo, dirPath);
        const entry = dirMap.get(`${f.repo} ${dirPath}`);
        if (entry)
            entry.file_count++;
    }
    return dirMap;
}
function readReadmeSummary(absDirPath) {
    for (const candidate of README_CANDIDATES) {
        const readmePath = join(absDirPath, candidate);
        if (!existsSync(readmePath))
            continue;
        try {
            const raw = readFileSync(readmePath, 'utf8');
            return raw.length > README_MAX_BYTES ? raw.slice(0, README_MAX_BYTES) : raw;
        }
        catch {
            // Unreadable — fall through.
        }
    }
    return null;
}
function persistDirectoriesGraph(graph, out, now) {
    const repoPaths = new Map();
    for (const r of out.repos)
        repoPaths.set(r.name, r.path);
    const dirMap = deriveDirectoryEntries(out);
    let dirs_upserted = 0;
    let dirs_readme_summarized = 0;
    // Two-pass: first upsert all Directory nodes (so CONTAINS edge targets
    // exist), then create CONTAINS edges from each child to its parent.
    for (const entry of dirMap.values()) {
        const repoPath = repoPaths.get(entry.repo);
        if (!repoPath)
            continue;
        const absDirPath = entry.path === '' ? repoPath : join(repoPath, entry.path);
        const readmeSummary = readReadmeSummary(absDirPath);
        graph.upsertDirectory({
            repo: entry.repo,
            path: entry.path,
            parent_path: entry.parent_path,
            summary: readmeSummary,
            summary_source: readmeSummary !== null ? 'readme' : 'llm',
            summary_updated_at: readmeSummary !== null ? now : null,
            file_count: entry.file_count,
        });
        if (readmeSummary !== null)
            dirs_readme_summarized++;
        dirs_upserted++;
    }
    for (const entry of dirMap.values()) {
        if (entry.parent_path === null)
            continue;
        graph.upsertContains({ repo: entry.repo, path: entry.parent_path }, { repo: entry.repo, path: entry.path });
    }
    return { dirs_upserted, dirs_readme_summarized };
}
// Persist repos[] + directories[] from a scan output. Transactional.
// File-level state lives entirely in the directories rows (file_count) and
// the world model. Per-file md5/summary state was retired in schema v7
// (ADR 0001) — leaf-zoom now happens via explicit Read on demand.
function persistScan(db, graph, out) {
    let repos_upserted = 0;
    const now = nowISO();
    db.transaction(() => {
        for (const r of out.repos) {
            db.run(`INSERT INTO repos (name, path, file_count, last_scanned_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path = excluded.path,
           file_count = excluded.file_count,
           last_scanned_at = excluded.last_scanned_at`, [r.name, r.path, r.file_count, now]);
            repos_upserted++;
        }
    });
    let dirs_upserted = 0;
    let dirs_readme_summarized = 0;
    if (graph) {
        const stats = persistDirectoriesGraph(graph, out, now);
        dirs_upserted = stats.dirs_upserted;
        dirs_readme_summarized = stats.dirs_readme_summarized;
    }
    return {
        repos_upserted,
        dirs_upserted,
        dirs_readme_summarized,
    };
}
export function scanTools(db, graph) {
    const definitions = [
        {
            name: 'scan_run',
            description: "Run a deterministic project scan: discovers git repos under the session dir, enumerates each repo's tracked files, and persists to `repos` + `directories`. For each unique directory in the file set, populates `directories.summary` from `<dir>/README.md` (author-curated, summary_source='readme') or leaves NULL for lazy LLM fill. Emits a deep_scan_completed audit event. The audit content_json carries `source` (user_manual / bro_auto_post_close / bro_auto_post_change / bro_auto_initial) and `structural_change` (whether the repos or top-level-dirs set changed vs the previous scan). See docs/architecture/WORLD_MODEL.md + ADR 0001.",
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
    ];
    const handlers = {
        scan_run: requireRoles('scan_run', ['bro'], wrap(async (args) => {
            const sessionDir = args['session_dir'] ?? process.cwd();
            const rawSource = args['source'] ?? 'bro_auto_initial';
            const source = VALID_SCAN_SOURCES.has(rawSource) ? rawSource : 'bro_auto_initial';
            const out = runScan(sessionDir);
            const stats = persistScan(db, graph, out);
            // #2881: structural-change detection vs previous deep_scan_completed
            // audit. The flag rides in the audit content_json so downstream
            // tooling (the scan-side renderer pass, manual diagnostic queries)
            // can decide whether the scan changed the project shape.
            const topDirs = new Set(out.files.map((f) => f.path.split('/')[0]).filter(Boolean));
            const structuralChange = detectStructuralChange(db, out.repos, topDirs);
            // Emit deep_scan_completed audit row. Attach to the system issue
            // (id=-1) — this is a session-level event, not work-issue scoped.
            db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
           VALUES (-1, NULL, 'bro', 'deep_scan_completed', ?, ?, ?)`, [
                `Scanned ${out.repos.length} repos, ${out.files.length} files, ${stats.dirs_upserted} dirs (${stats.dirs_readme_summarized} README-summarized) — source=${source}${structuralChange ? ', structural-change' : ''}`,
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
                db.run(`INSERT INTO plugin_config (key, value_json) VALUES (?, ?)`, ['tmb_default_repo', JSON.stringify(preferredDefaultRepo(out.repos, sessionDir))]);
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
            const rows = db.all(`SELECT name, path, file_count, last_scanned_at FROM repos ORDER BY name`);
            return ok({ repos: rows });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=scan.js.map