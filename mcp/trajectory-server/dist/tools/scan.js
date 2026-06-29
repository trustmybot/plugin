import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { WorldModelGraph } from '../graph-db.js';
import { classifyUrl } from '../utils/classify-url.js';
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
export function runScanWithScript(script, sessionDir, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', [script, sessionDir], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
        let settled = false;
        let killTimer = null;
        function killGroup() {
            try {
                process.kill(-child.pid, 'SIGKILL');
            }
            catch {
                // Process may have already exited — ignore.
            }
        }
        killTimer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            killGroup();
            reject(new Error('scan.sh timed out after 10 minutes'));
        }, timeoutMs);
        child.on('error', (e) => {
            if (settled)
                return;
            settled = true;
            if (killTimer)
                clearTimeout(killTimer);
            reject(new Error(`scan.sh spawn error: ${e.message}`));
        });
        child.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            if (killTimer)
                clearTimeout(killTimer);
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2000);
            if (code !== 0) {
                reject(new Error(`scan.sh failed (exit ${code ?? '?'}): ${stderr || 'unknown error'}`));
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(stdout);
            }
            catch {
                reject(new Error(`scan.sh emitted non-JSON output (first 500 chars): ${stdout.slice(0, 500)}`));
                return;
            }
            if (!parsed.repos || !parsed.files) {
                reject(new Error('scan.sh emitted unexpected shape (missing repos/files)'));
                return;
            }
            resolve(parsed);
        });
    });
}
function runScan(sessionDir, timeoutMs) {
    return runScanWithScript(resolveScanScript(), sessionDir, timeoutMs);
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
// Directory-level world model population (v0.7 world-model). For each unique
// dir implied by the scanned file set, the summary comes from <dir>/README.md
// when present (author-curated, high-trust, summary_source='readme'). Dirs with
// no README get a deterministic structural summary built from their immediate
// file + subdir names (summary_source='structural') so every node is non-empty
// and reachable by world_model_search — README excerpts beat reading the whole
// tree, and a structural line beats a NULL the search can never hit (#288).
// See docs/architecture/WORLD_MODEL.md + ADR 0001.
const README_CANDIDATES = ['README.md', 'readme.md', 'README.rst', 'readme.rst'];
const README_MAX_BYTES = 1024;
const STRUCTURAL_LIST_MAX = 8;
function basename(p) {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
}
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
        dirMap.set(key, { repo, path: dirPath, parent_path, file_count: 0, file_names: [] });
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
        if (entry) {
            entry.file_count++;
            entry.file_names.push(basename(f.path));
        }
    }
    return dirMap;
}
// Deterministic summary for a directory with no README: a one-line digest of
// its immediate file + subdir names. Gives world_model_search real tokens to
// match and bro a structure-only sense of the dir without reading the tree.
function buildStructuralSummary(dirPath, fileNames, subdirNames) {
    const leaf = dirPath === '' ? '(repo root)' : basename(dirPath);
    const join = (names) => {
        const shown = names.slice(0, STRUCTURAL_LIST_MAX).join(', ');
        const extra = names.length - STRUCTURAL_LIST_MAX;
        return extra > 0 ? `${shown}, +${extra} more` : shown;
    };
    const parts = [];
    if (fileNames.length > 0) {
        parts.push(`${fileNames.length} file${fileNames.length === 1 ? '' : 's'} (${join(fileNames.slice().sort())})`);
    }
    if (subdirNames.length > 0) {
        parts.push(`subdirs: ${join(subdirNames.slice().sort())}`);
    }
    return `${leaf}/ — ${parts.length > 0 ? parts.join('; ') : 'empty directory'}`;
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
    let dirs_structural_summarized = 0;
    // Immediate-subdir names per directory, for the structural summary.
    const subdirsByParent = new Map();
    for (const entry of dirMap.values()) {
        if (entry.parent_path === null)
            continue;
        const key = `${entry.repo} ${entry.parent_path}`;
        const list = subdirsByParent.get(key);
        if (list)
            list.push(basename(entry.path));
        else
            subdirsByParent.set(key, [basename(entry.path)]);
    }
    // Two-pass: first upsert all Directory nodes (so CONTAINS edge targets
    // exist), then create CONTAINS edges from each child to its parent.
    for (const entry of dirMap.values()) {
        const repoPath = repoPaths.get(entry.repo);
        if (!repoPath)
            continue;
        const absDirPath = entry.path === '' ? repoPath : join(repoPath, entry.path);
        const readmeSummary = readReadmeSummary(absDirPath);
        const subdirNames = subdirsByParent.get(`${entry.repo} ${entry.path}`) ?? [];
        const summary = readmeSummary
            ?? buildStructuralSummary(entry.path, entry.file_names, subdirNames);
        graph.upsertDirectory({
            repo: entry.repo,
            path: entry.path,
            parent_path: entry.parent_path,
            summary,
            summary_source: readmeSummary !== null ? 'readme' : 'structural',
            summary_updated_at: now,
            file_count: entry.file_count,
        });
        if (readmeSummary !== null)
            dirs_readme_summarized++;
        else
            dirs_structural_summarized++;
        dirs_upserted++;
    }
    for (const entry of dirMap.values()) {
        if (entry.parent_path === null)
            continue;
        graph.upsertContains({ repo: entry.repo, path: entry.parent_path }, { repo: entry.repo, path: entry.path });
    }
    return { dirs_upserted, dirs_readme_summarized, dirs_structural_summarized };
}
// Read a repo's actual git remotes as {name, provider, url}[]. Mirrors
// onboard.ts probeGit: `git -C <path> remote` then `git -C <path> remote
// get-url <name>`. A repo with no remote → []. Any error degrades to [] so
// one unreadable repo never throws the whole scan.
function readRepoRemotes(path) {
    try {
        const opts = { encoding: 'utf8', timeout: 3000 };
        const listR = spawnSync('git', ['-C', path, 'remote'], opts);
        if (listR.status !== 0)
            return [];
        const names = (listR.stdout ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        const remotes = [];
        for (const name of names) {
            const urlR = spawnSync('git', ['-C', path, 'remote', 'get-url', name], opts);
            if (urlR.status !== 0)
                continue;
            const url = (urlR.stdout ?? '').trim();
            if (!url)
                continue;
            remotes.push({ name, provider: classifyUrl(url), url });
        }
        return remotes;
    }
    catch {
        return [];
    }
}
// Persist repos[] + directories[] from a scan output. Transactional.
// File-level state lives entirely in the directories rows (file_count) and
// the world model. Per-file md5/summary state was retired in schema v7
// (ADR 0001) — leaf-zoom now happens via explicit Read on demand.
// sessionDir is used to scope repo retirement: repos in the DB whose path
// falls under sessionDir but are absent from this scan's result are retired.
function persistScan(db, graph, out, sessionDir) {
    const now = nowISO();
    const scannedNames = new Set(out.repos.map((r) => r.name));
    const normSession = sessionDir.replace(/\/+$/, '');
    // Find repos in DB that were discovered under sessionDir but are absent now.
    const existing = db.all(`SELECT name, path FROM repos`);
    const toRetire = existing.filter((r) => {
        const normPath = r.path.replace(/\/+$/, '');
        const underSession = normPath === normSession || normPath.startsWith(normSession + '/');
        return underSession && !scannedNames.has(r.name);
    });
    let repos_upserted = 0;
    let repos_retired = 0;
    let dirs_retired = 0;
    db.transaction(() => {
        for (const r of out.repos) {
            const remotesJson = JSON.stringify(readRepoRemotes(r.path));
            db.run(`INSERT INTO repos (name, path, file_count, last_scanned_at, remotes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path = excluded.path,
           file_count = excluded.file_count,
           last_scanned_at = excluded.last_scanned_at,
           remotes = excluded.remotes`, [r.name, r.path, r.file_count, now, remotesJson]);
            repos_upserted++;
        }
        for (const r of toRetire) {
            db.run(`DELETE FROM repos WHERE name = ?`, [r.name]);
            repos_retired++;
        }
    });
    // Retire kuzu nodes for vanished repos (prune all their dirs).
    if (graph) {
        for (const r of toRetire) {
            const n = graph.pruneDirectories(r.name, new Set());
            dirs_retired += n;
        }
    }
    let dirs_upserted = 0;
    let dirs_readme_summarized = 0;
    let dirs_structural_summarized = 0;
    if (graph) {
        const stats = persistDirectoriesGraph(graph, out, now);
        dirs_upserted = stats.dirs_upserted;
        dirs_readme_summarized = stats.dirs_readme_summarized;
        dirs_structural_summarized = stats.dirs_structural_summarized;
        // Prune stale directory nodes for each scanned repo (handles renames).
        const dirMap = deriveDirectoryEntries(out);
        for (const r of out.repos) {
            const keepKeys = new Set();
            for (const [, entry] of dirMap) {
                if (entry.repo === r.name) {
                    keepKeys.add(WorldModelGraph.dirKey(r.name, entry.path));
                }
            }
            graph.pruneDirectories(r.name, keepKeys);
        }
    }
    return {
        repos_discovered: out.repos.length,
        repos_upserted,
        repos_retired,
        dirs_upserted,
        dirs_retired,
        dirs_readme_summarized,
        dirs_structural_summarized,
    };
}
const SCAN_TIMEOUT_MS = 10 * 60 * 1000; // 10-minute hard timeout
function readLock(lockPath) {
    try {
        return JSON.parse(readFileSync(lockPath, 'utf8'));
    }
    catch {
        return null;
    }
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function acquireLock(lockPath) {
    const existing = readLock(lockPath);
    if (existing) {
        if (pidAlive(existing.pid))
            return false;
        unlinkSync(lockPath);
    }
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: nowISO() }), { flag: 'wx' });
    return true;
}
function releaseLock(lockPath) {
    try {
        unlinkSync(lockPath);
    }
    catch {
        // already removed — not an error
    }
}
export function scanTools(db, graph, dbPath = '', graphOpenError = null) {
    const definitions = [
        {
            name: 'scan_run',
            description: "Run a deterministic project scan: discovers git repos under the session dir, enumerates tracked files (.gitignore-aware), and writes Directory nodes + CONTAINS edges to the kuzu world model. Directory summaries come from README.md (summary_source='readme') or a structural fallback (summary_source='structural'). Emits a deep_scan_completed audit event with source and structural_change fields. Hard timeout: 10 minutes.",
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
            // #590/#591: when the server lost the cold-start kuzu write-lock race
            // its graph is null for the session because the open hit a lock error.
            // Surface that as graph_db_open_failed — NOT as a scan-lock message — so
            // the operator isn't sent chasing a phantom "scan already running" with a
            // dead pid. A genuinely-absent kuzu (missing native binding, sandbox) has
            // no lock error and falls through to the no-op graph path below.
            if (!graph && graphOpenError) {
                return err(`graph_db_open_failed: ${graphOpenError} — world model could not be opened this session (kuzu write-lock contention); restart the session to retry`);
            }
            // #339: lock file prevents concurrent scans. Lock lives beside the DB.
            const lockPath = dbPath && dbPath !== ':memory:'
                ? join(dirname(dbPath), 'scan.lock')
                : '';
            if (lockPath) {
                const existing = readLock(lockPath);
                if (existing && pidAlive(existing.pid)) {
                    return err(`scan already running (pid ${existing.pid}, started ${existing.started_at})`);
                }
                try {
                    acquireLock(lockPath);
                }
                catch {
                    const recheck = readLock(lockPath);
                    if (recheck && pidAlive(recheck.pid)) {
                        return err(`scan already running (pid ${recheck.pid}, started ${recheck.started_at})`);
                    }
                }
            }
            let out;
            try {
                out = await runScan(sessionDir, SCAN_TIMEOUT_MS);
            }
            catch (e) {
                if (lockPath)
                    releaseLock(lockPath);
                throw e;
            }
            const stats = persistScan(db, graph, out, sessionDir);
            if (lockPath)
                releaseLock(lockPath);
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
                `Scan: discovered ${stats.repos_discovered} repos, upserted ${stats.repos_upserted}, retired ${stats.repos_retired}; ${out.files.length} files; dirs upserted ${stats.dirs_upserted} (${stats.dirs_readme_summarized} README + ${stats.dirs_structural_summarized} structural), retired ${stats.dirs_retired} — source=${source}${structuralChange ? ', structural-change' : ''}`,
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