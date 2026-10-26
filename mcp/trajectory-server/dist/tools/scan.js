import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { insertAudit } from './audit.js';
import { WorldModelGraph } from '../graph.js';
import { extractPurpose, isPurposeCandidate } from '../file-purpose.js';
import { readFileHead, refreshSymbolPurposes } from '../symbol-purpose.js';
import { readmeDrift, readRepoHistory } from '../readme-drift.js';
import { cleanReadme } from '../readme-summary.js';
import { classifyUrl } from '../utils/classify-url.js';
import { frameUntrusted } from '../utils/untrusted.js';
import { serverLog } from '../logger.js';
import { indexRepoSymbols } from '../symbol-index.js';
import { isGeneratedPath } from '../parsing/extract.js';
import { applyConceptProposals, refreshConcepts } from '../world-model/concepts.js';
import { syncRepoMilestones } from './milestones.js';
import { primaryIndex, repoRemotes, upsertRepoRemotes } from '../repos/remotes.js';
import { projectRootFromDbPath } from './containment.js';
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
export function runScanWithScript(script, sessionDir, timeoutMs, dbPath = '') {
    return new Promise((resolve, reject) => {
        const env = dbPath && dbPath !== ':memory:' ? { ...process.env, TRAJECTORY_DB_PATH: dbPath } : process.env;
        const child = spawn('bash', [script, sessionDir], {
            cwd: sessionDir,
            env,
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
function runScan(sessionDir, timeoutMs, dbPath) {
    return runScanWithScript(resolveScanScript(), sessionDir, timeoutMs, dbPath);
}
// Valid `source` values for scan_run (#2881). The default — bro_auto_initial —
// matches the historical un-tagged behavior (bro hit the registry-cold gate
// and remediated by running scan).
const VALID_SCAN_SOURCES = new Set([
    'user_manual',
    'bro_auto_post_close',
    'bro_auto_post_change',
    'bro_auto_initial',
    'startup_catchup',
]);
// Compute whether the current scan differs from the previous deep_scan_completed
// audit row in a way that warrants an arch-doc refresh (#2881). Currently a
// coarse heuristic: repo-set delta OR top-level dir set delta OR a scan that
// refilled an empty world model (GH 1593). Refinable later with
// package-manager / language-set deltas.
export function detectStructuralChange(db, currentRepos, currentTopDirs, refilledEmptyGraph = false) {
    if (refilledEmptyGraph)
        return true;
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
const STRUCTURAL_PURPOSES_MAX = 5;
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
function buildStructuralSummary(dirPath, fileNames, subdirNames, filePurposes = []) {
    const leaf = dirPath === '' ? '(repo root)' : basename(dirPath);
    const join = (names) => {
        const shown = names.slice(0, STRUCTURAL_LIST_MAX).join(', ');
        const extra = names.length - STRUCTURAL_LIST_MAX;
        return extra > 0 ? `${shown}, +${extra} more` : shown;
    };
    const parts = [];
    const fileCount = `${fileNames.length} file${fileNames.length === 1 ? '' : 's'}`;
    if (filePurposes.length > 0) {
        const shown = filePurposes
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, STRUCTURAL_PURPOSES_MAX)
            .map((f) => `${f.name}: ${f.purpose}`);
        // One line, so the depth-2 first-line trim in world_model_get keeps the
        // whole frame.
        parts.push(fileCount, frameUntrusted('file-purpose', shown.join('; ')).replace(/\n/g, ' '));
    }
    else if (fileNames.length > 0) {
        parts.push(`${fileCount} (${join(fileNames.slice().sort())})`);
    }
    if (subdirNames.length > 0) {
        parts.push(`subdirs: ${join(subdirNames.slice().sort())}`);
    }
    return `${leaf}/ — ${parts.length > 0 ? parts.join('; ') : 'empty directory'}`;
}
function readReadme(absDirPath, candidates = README_CANDIDATES) {
    for (const name of candidates) {
        const readmePath = join(absDirPath, name);
        if (!existsSync(readmePath))
            continue;
        try {
            return { name, text: readFileSync(readmePath, 'utf8') };
        }
        catch {
            // Unreadable — fall through.
        }
    }
    return null;
}
export function readReadmeSummary(absDirPath) {
    const readme = readReadme(absDirPath);
    if (!readme)
        return null;
    const text = cleanReadme(readme.text);
    const clipped = text.length > README_MAX_BYTES ? text.slice(0, README_MAX_BYTES) : text;
    // A README is remotely-sourced text — frame it as untrusted data so any
    // agent that later reads this world-model summary treats it as content,
    // not instructions (#1036).
    return frameUntrusted('readme', clipped);
}
// README drift per directory, keyed '<repo> <path>': only for a README git
// tracks, read whole (not the summary clip). Runs before the write transaction
// so git calls never hold the DB lock; a repo or README git cannot answer for
// is simply absent, leaving its columns NULL.
function planReadmeDrift(out) {
    const drift = new Map();
    const dirMap = deriveDirectoryEntries(out);
    const repoPaths = new Map(out.repos.map((r) => [r.name, r.path]));
    const histories = new Map();
    const historyFor = (repo, root) => {
        if (!histories.has(repo)) {
            const trackedDirs = new Set();
            for (const e of dirMap.values())
                if (e.repo === repo && e.path !== '')
                    trackedDirs.add(e.path);
            histories.set(repo, readRepoHistory(root, trackedDirs));
        }
        return histories.get(repo) ?? null;
    };
    for (const entry of dirMap.values()) {
        const root = repoPaths.get(entry.repo);
        const tracked = README_CANDIDATES.filter((name) => entry.file_names.includes(name));
        if (!root || tracked.length === 0)
            continue;
        const history = historyFor(entry.repo, root);
        if (!history)
            continue;
        const readme = readReadme(entry.path === '' ? root : join(root, entry.path), tracked);
        if (!readme)
            continue;
        const d = readmeDrift(history, entry.path, readme.name, readme.text);
        if (d)
            drift.set(`${entry.repo} ${entry.path}`, d);
    }
    return drift;
}
function persistDirectoriesGraph(graph, out, now, purposesByDir = new Map(), driftByDir = new Map()) {
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
    // Two-pass: first upsert every directory row, then link each child to its
    // parent once both rows exist.
    for (const entry of dirMap.values()) {
        const repoPath = repoPaths.get(entry.repo);
        if (!repoPath)
            continue;
        const absDirPath = entry.path === '' ? repoPath : join(repoPath, entry.path);
        const readmeSummary = readReadmeSummary(absDirPath);
        const subdirNames = subdirsByParent.get(`${entry.repo} ${entry.path}`) ?? [];
        const summary = readmeSummary
            ?? buildStructuralSummary(entry.path, entry.file_names, subdirNames, purposesByDir.get(`${entry.repo} ${entry.path}`) ?? []);
        const drift = readmeSummary !== null ? driftByDir.get(`${entry.repo} ${entry.path}`) : undefined;
        graph.upsertDirectory({
            repo: entry.repo,
            path: entry.path,
            parent_path: entry.parent_path,
            summary,
            summary_source: readmeSummary !== null ? 'readme' : 'structural',
            summary_updated_at: now,
            file_count: entry.file_count,
            summary_sha: drift?.summary_sha ?? null,
            commits_behind: drift?.commits_behind ?? null,
            dead_refs: drift?.dead_refs ?? null,
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
function fileDir(relPath) {
    const i = relPath.lastIndexOf('/');
    return i >= 0 ? relPath.slice(0, i) : '';
}
// Hash-keyed File plan: an unchanged content_md5 keeps the stored row as is,
// unless its purpose_source is still 'none' (then it is re-extracted, written
// only when that finds a purpose); a changed or new file is re-extracted from
// its first PURPOSE_HEAD_BYTES; a purpose an swe wrote (purpose_source='swe')
// survives a content change.
function planFiles(graph, out, now) {
    const repoPaths = new Map(out.repos.map((r) => [r.name, r.path]));
    const existing = new Map();
    for (const r of out.repos) {
        for (const f of graph.allFilesForRepo(r.name))
            existing.set(f.path, f);
    }
    const plan = { nodes: [], writes: [], extracted: 0 };
    for (const f of out.files) {
        const repoPath = repoPaths.get(f.repo);
        if (!repoPath)
            continue;
        const path = WorldModelGraph.fileKey(f.repo, f.path);
        const prev = existing.get(path);
        const md5 = f.content_md5 ?? '';
        if (prev && md5 !== '' && prev.content_md5 === md5) {
            if (prev.purpose_source === 'none' && isPurposeCandidate(f.path)) {
                const extracted = extractPurpose(f.path, readFileHead(join(repoPath, f.path)));
                plan.extracted++;
                if (extracted.source !== 'none') {
                    const node = { ...prev, purpose: extracted.purpose, purpose_source: extracted.source, updated_at: now };
                    plan.nodes.push(node);
                    plan.writes.push(node);
                    continue;
                }
            }
            plan.nodes.push(prev);
            continue;
        }
        const facts = {
            path,
            repo: f.repo,
            dir: fileDir(f.path),
            content_md5: md5,
            size_bytes: Number(f.size_bytes ?? 0),
            last_commit_sha: f.last_commit_sha ?? '',
            updated_at: now,
        };
        let node;
        if (prev?.purpose_source === 'swe') {
            node = { ...facts, purpose: prev.purpose, purpose_source: prev.purpose_source };
        }
        else {
            const extracted = isPurposeCandidate(f.path)
                ? extractPurpose(f.path, readFileHead(join(repoPath, f.path)))
                : { purpose: '', source: 'none' };
            node = { ...facts, purpose: extracted.purpose, purpose_source: extracted.source };
            plan.extracted++;
        }
        plan.nodes.push(node);
        plan.writes.push(node);
    }
    return plan;
}
function purposesByDirectory(nodes) {
    const byDir = new Map();
    for (const n of nodes) {
        if (!n.purpose)
            continue;
        const key = `${n.repo} ${n.dir}`;
        const entry = { name: basename(WorldModelGraph.relativeFilePath(n)), purpose: n.purpose };
        const list = byDir.get(key);
        if (list)
            list.push(entry);
        else
            byDir.set(key, [entry]);
    }
    return byDir;
}
function persistFilesGraph(graph, out, plan) {
    let files_retired = 0;
    for (const n of plan.writes)
        graph.upsertFile(n);
    for (const r of out.repos) {
        const linked = graph.filePathsWithDirectory(r.name);
        for (const n of plan.nodes) {
            if (n.repo === r.name && !linked.has(n.path))
                graph.upsertHasFile(n.repo, n.dir, n.path);
        }
        const keep = new Set(plan.nodes.filter((n) => n.repo === r.name).map((n) => n.path));
        files_retired += graph.pruneFiles(r.name, keep);
    }
    return { files_upserted: plan.writes.length, files_retired };
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
function canonicalPath(p) {
    try {
        return realpathSync(p);
    }
    catch {
        return p.replace(/\/+$/, '');
    }
}
function normalizeRemoteUrl(url) {
    return url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
}
function primaryRemoteUrl(remotes) {
    const primary = remotes[primaryIndex(remotes)];
    return primary ? normalizeRemoteUrl(primary.url) : null;
}
// A discovered repo with no row of its own whose canonical path or primary
// remote URL matches an existing row that this scan did not rediscover is a
// rename, not a new repo. It is surfaced for repo_rename, never applied here.
function detectRenames(existing, discovered, remotesByRepo, storedRemotes) {
    const scannedNames = new Set(discovered.map((r) => r.name));
    const existingNames = new Set(existing.map((r) => r.name));
    const orphaned = existing.filter((r) => !scannedNames.has(r.name));
    const claimed = new Set();
    const candidates = [];
    for (const r of discovered) {
        if (existingNames.has(r.name))
            continue;
        const path = canonicalPath(r.path);
        const remote = primaryRemoteUrl(remotesByRepo.get(r.name) ?? []);
        let match = null;
        for (const row of orphaned) {
            if (claimed.has(row.name))
                continue;
            if (canonicalPath(row.path) === path) {
                match = { name: row.name, by: 'path' };
                break;
            }
        }
        if (!match && remote) {
            for (const row of orphaned) {
                if (claimed.has(row.name))
                    continue;
                if (primaryRemoteUrl(storedRemotes(row.name)) === remote) {
                    match = { name: row.name, by: 'remote' };
                    break;
                }
            }
        }
        if (match) {
            claimed.add(match.name);
            candidates.push({ old: match.name, new: r.name, by: match.by, path: r.path });
        }
    }
    return candidates;
}
// Repos with remotes but no sync = 1 row while issue_sync is on: issue and
// milestone sync reach nothing for them (GH 1601).
function noSyncRemoteWarnings(db, repos) {
    const row = db.get(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
    let issueSync = 'off';
    try {
        if (row)
            issueSync = String(JSON.parse(row.value_json));
    }
    catch {
        issueSync = 'off';
    }
    if (issueSync === 'off')
        return [];
    return repos
        .filter((repo) => {
        const remotes = repoRemotes(db, repo);
        return remotes.length > 0 && !remotes.some((r) => r.sync);
    })
        .map((repo) => ({
        repo,
        reason: 'no_sync_remote',
        hint: 'Issue and milestone sync reach no remote for this repo; re-run /onboard to choose the Remote.',
    }));
}
const SYMBOL_STAT_KEYS = ['files_parsed', 'files_failed', 'symbols', 'edges', 'edges_resolved'];
export function persistedFiles(files, renamedTo) {
    return files.filter((f) => !renamedTo.has(f.repo) && !isGeneratedPath(f.path));
}
// Persist repos[] and the world model (wm_directories + wm_files), each in its
// own transaction, then bring each scanned repo's symbol index up to date.
// sessionDir is used to scope repo retirement: repos in the DB whose path
// falls under sessionDir but are absent from this scan's result are retired,
// unless a task or another row still references them; those are kept and
// reported in repos_stale_kept (GH 1551).
async function persistScan(db, graph, out, sessionDir) {
    const now = nowISO();
    const normSession = sessionDir.replace(/\/+$/, '');
    const existing = db.all(`SELECT name, path FROM repos`);
    const remotesByRepo = new Map();
    for (const r of out.repos)
        remotesByRepo.set(r.name, readRepoRemotes(r.path));
    const rename_candidates = detectRenames(existing, out.repos, remotesByRepo, (repo) => repoRemotes(db, repo));
    const renamedTo = new Set(rename_candidates.map((c) => c.new));
    const renamedFrom = new Set(rename_candidates.map((c) => c.old));
    const persisted = {
        ...out,
        repos: out.repos.filter((r) => !renamedTo.has(r.name)),
        files: persistedFiles(out.files, renamedTo),
    };
    const scannedNames = new Set(persisted.repos.map((r) => r.name));
    // Find repos in DB that were discovered under sessionDir but are absent now.
    // A rename candidate's old row stays until repo_rename moves it.
    const toRetire = existing.filter((r) => {
        const normPath = r.path.replace(/\/+$/, '');
        const underSession = normPath === normSession || normPath.startsWith(normSession + '/');
        return underSession && !scannedNames.has(r.name) && !renamedFrom.has(r.name);
    });
    let repos_upserted = 0;
    let repos_retired = 0;
    let dirs_retired = 0;
    const retired = [];
    const repos_stale_kept = [];
    db.transaction(() => {
        for (const r of persisted.repos) {
            db.run(`INSERT INTO repos (name, path, file_count, last_scanned_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path = excluded.path,
           file_count = excluded.file_count,
           last_scanned_at = excluded.last_scanned_at`, [r.name, r.path, r.file_count, now]);
            upsertRepoRemotes(db, r.name, remotesByRepo.get(r.name) ?? []);
            repos_upserted++;
        }
        for (const r of toRetire) {
            if (db.get(`SELECT 1 FROM tasks WHERE repo = ? LIMIT 1`, [r.name])) {
                repos_stale_kept.push({ name: r.name, path: r.path, reason: 'task_referenced' });
                continue;
            }
            // Milestones no issue references (e.g. a scan-seeded one) go with the
            // repo; the savepoint restores them when the repo itself can't retire.
            db.run(`SAVEPOINT retire_repo`);
            try {
                db.run(`DELETE FROM milestones WHERE repo = ? AND NOT EXISTS
             (SELECT 1 FROM issues WHERE issues.repo = milestones.repo AND issues.milestone = milestones.name)`, [r.name]);
                db.run(`DELETE FROM repos WHERE name = ?`, [r.name]);
                db.run(`RELEASE retire_repo`);
                repos_retired++;
                retired.push({ name: r.name, path: r.path });
            }
            catch {
                // ON DELETE RESTRICT FK: the repo is still referenced (tasks/issues
                // point at it). Keep its row and skip retiring it rather than failing
                // the whole scan; the surrounding transaction stays open for the
                // remaining repos.
                db.run(`ROLLBACK TO retire_repo`);
                db.run(`RELEASE retire_repo`);
                repos_stale_kept.push({ name: r.name, path: r.path, reason: 'row_referenced' });
            }
        }
        for (const c of rename_candidates) {
            insertAudit(db, {
                issue_id: -1,
                from_node: 'bro',
                event_type: 'repo_rename_detected',
                summary: `Scan: repo ${c.old} looks renamed to ${c.new} (matched by ${c.by}); run repo_rename to apply`,
                content_json: JSON.stringify({ old: c.old, new: c.new, by: c.by }),
                repo: c.old,
            });
        }
    });
    let files_upserted = 0;
    let files_extracted = 0;
    let files_retired = 0;
    let dirs_upserted = 0;
    let dirs_readme_summarized = 0;
    let dirs_structural_summarized = 0;
    if (graph) {
        const plan = planFiles(graph, persisted, now);
        files_extracted = plan.extracted;
        const drift = planReadmeDrift(persisted);
        graph.transaction(() => {
            // Retire the world model of repos actually removed above.
            for (const r of retired) {
                dirs_retired += graph.pruneDirectories(r.name, new Set());
                files_retired += graph.pruneFiles(r.name, new Set());
            }
            const stats = persistDirectoriesGraph(graph, persisted, now, purposesByDirectory(plan.nodes), drift);
            dirs_upserted = stats.dirs_upserted;
            dirs_readme_summarized = stats.dirs_readme_summarized;
            dirs_structural_summarized = stats.dirs_structural_summarized;
            // Prune stale directory rows for each scanned repo (handles renames).
            const dirMap = deriveDirectoryEntries(persisted);
            for (const r of persisted.repos) {
                const keepKeys = new Set();
                for (const [, entry] of dirMap) {
                    if (entry.repo === r.name) {
                        keepKeys.add(WorldModelGraph.dirKey(r.name, entry.path));
                    }
                }
                graph.pruneDirectories(r.name, keepKeys);
            }
            const fileStats = persistFilesGraph(graph, persisted, plan);
            files_upserted = fileStats.files_upserted;
            files_retired += fileStats.files_retired;
        });
    }
    const symbols = { files_parsed: 0, files_failed: 0, symbols: 0, edges: 0, edges_resolved: 0 };
    if (graph) {
        for (const r of persisted.repos) {
            try {
                const repoStats = await indexRepoSymbols(db, r.name, r.path);
                for (const key of SYMBOL_STAT_KEYS)
                    symbols[key] += repoStats[key];
            }
            catch (e) {
                symbols.error = `${r.name}: ${e.message}`;
                serverLog({ event: 'symbol_index_error', repo: r.name, error: e.message });
            }
            try {
                refreshSymbolPurposes(db, r.name);
            }
            catch (e) {
                serverLog({ event: 'symbol_purpose_error', repo: r.name, error: e.message });
            }
            try {
                refreshConcepts(db, r.name);
            }
            catch (e) {
                serverLog({ event: 'concept_refresh_error', repo: r.name, error: e.message });
            }
            try {
                applyConceptProposals(db, r.name, r.path);
            }
            catch (e) {
                serverLog({ event: 'concept_proposals_error', repo: r.name, error: e.message });
            }
        }
    }
    return {
        repos_discovered: out.repos.length,
        repos_upserted,
        repos_retired,
        repos_stale_kept,
        dirs_upserted,
        dirs_retired,
        dirs_readme_summarized,
        dirs_structural_summarized,
        files_upserted,
        files_extracted,
        files_retired,
        symbols,
        rename_candidates,
    };
}
/**
 * The one writer for a discovered resource, keyed on (name, kind) — the server
 * twin of scripts/scan.sh `_register`. A new row is inserted with a
 * scan_discovered audit row; an existing row only gets a blank description /
 * NULL version filled and a legacy 'mcp:<server>' source_url rewritten to the
 * bundled 'mcp:<plugin>/<server>' form, without an audit row.
 */
export function upsertDiscoveredCheatcode(db, r) {
    const description = r.description ?? '';
    const version = r.version ?? null;
    return db.transaction(() => {
        const now = nowISO();
        const res = db.run(`INSERT INTO cheatcodes
         (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?,
               (SELECT trust_tier FROM cheatcodes WHERE kind = 'plugin' AND name = ?),
               'project-local', ?, ?, ?, ?)
       ON CONFLICT (name, kind) DO NOTHING`, [
            r.name, r.kind, r.origin, description, r.source_url, r.file_path ?? null, version,
            r.trust_parent ?? null, r.status, now, now, now,
        ]);
        if (res.changes > 0) {
            insertAudit(db, {
                issue_id: -1,
                from_node: r.from_node ?? 'system',
                event_type: 'scan_discovered',
                summary: `${r.name} (${r.kind}): discovered`,
                content_json: JSON.stringify({ name: r.name, kind: r.kind, origin: r.origin, source: r.source_url }),
            });
            return { id: Number(res.lastInsertRowid), inserted: true };
        }
        db.run(`UPDATE cheatcodes
          SET description = CASE WHEN description = '' THEN ? ELSE description END,
              version = COALESCE(version, ?),
              source_url = CASE WHEN kind = 'mcp' AND source_url = 'mcp:' || name AND ? LIKE 'mcp:%/%'
                                THEN ? ELSE source_url END,
              updated_at = ?
        WHERE name = ? AND kind = ?
          AND ((description = '' AND ? <> '')
               OR (version IS NULL AND ? IS NOT NULL)
               OR (kind = 'mcp' AND source_url = 'mcp:' || name AND ? LIKE 'mcp:%/%'))`, [
            description, version, r.source_url, r.source_url, now, r.name, r.kind,
            description, version, r.source_url,
        ]);
        const row = db.get('SELECT id FROM cheatcodes WHERE name = ? AND kind = ?', [r.name, r.kind]);
        return { id: row.id, inserted: false };
    });
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
export function scanTools(db, graphHolder = null, dbPath = '') {
    const definitions = [
        {
            name: 'scan_run',
            description: "Run a deterministic project scan: discovers git repos under the session dir, enumerates tracked files (.gitignore-aware), and writes directory + file rows to the world model. Directory summaries come from README.md (summary_source='readme') or a structural fallback (summary_source='structural'). Emits a deep_scan_completed audit event with source and structural_change fields. A renamed repo lands in rename_candidates for repo_rename, never as a second row. warnings (always an array, empty when none) lists repos whose remotes have no sync row while issue_sync is on (reason no_sync_remote). Hard timeout: 10 minutes.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    session_dir: {
                        type: 'string',
                        description: 'Absolute path to the session directory (workspace root). Defaults to the project root (the directory holding the trajectory DB\'s .claude/).',
                    },
                    source: {
                        type: 'string',
                        enum: ['user_manual', 'bro_auto_post_close', 'bro_auto_post_change', 'bro_auto_initial', 'startup_catchup'],
                        description: 'Who fired this scan. user_manual = the user typed /scan; bro_auto_post_close = post-task-close-rescan.sh hook; bro_auto_post_change = bro decided to rescan mid-session; bro_auto_initial = bro hit the registry-cold gate and ran scan as remediation; startup_catchup = the server\'s connect-time catch-up. Defaults to bro_auto_initial.',
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
            const sessionDir = args['session_dir'] ?? projectRootFromDbPath(dbPath);
            if (!sessionDir) {
                return err('session_dir is required: the project root is unknown for this trajectory DB');
            }
            const rawSource = args['source'] ?? 'bro_auto_initial';
            const source = VALID_SCAN_SOURCES.has(rawSource) ? rawSource : 'bro_auto_initial';
            // No holder: the world model lives in the trajectory DB itself. A
            // holder that recorded an open failure surfaces it as
            // graph_db_open_failed rather than scanning without a world model.
            const graph = graphHolder ? graphHolder.ensureGraph() : new WorldModelGraph(db);
            const graphOpenError = graphHolder?.openError ?? null;
            if (!graph && graphOpenError) {
                return err(`graph_db_open_failed: ${graphOpenError}`);
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
                let acquired = false;
                let acquireThrew = false;
                try {
                    acquired = acquireLock(lockPath);
                }
                catch {
                    // wx write failed: raced another acquirer, or the lock dir is absent.
                    acquireThrew = true;
                }
                if (!acquired) {
                    const recheck = readLock(lockPath);
                    if (recheck && pidAlive(recheck.pid)) {
                        // A live lock appeared between the pre-check and the acquire — we
                        // lost the race. Never fall through to a concurrent scan (#1018c).
                        return err(`scan already running (pid ${recheck.pid}, started ${recheck.started_at})`);
                    }
                    if (!acquireThrew) {
                        // acquireLock returned false with no live lock present — treat as a
                        // lost lock rather than silently double-scanning.
                        return err('scan lock could not be acquired');
                    }
                    // Threw with no live lock (missing lock dir / dead leftover): proceed
                    // best-effort lock-less, as there is no concurrent scan to guard.
                }
            }
            try {
                const out = await runScan(sessionDir, SCAN_TIMEOUT_MS, dbPath);
                if (!graph && out.files.length > 0) {
                    return err('world_model_unavailable: no world-model graph to write; repos and deep_scan_completed left unchanged');
                }
                const dirsBefore = graph?.directoryCount() ?? 0;
                const stats = await persistScan(db, graph, out, sessionDir);
                // Milestones: reconcile from each repo's remote, then seed one
                // v<next-patch> where none exist. Never fails the scan.
                const spawnFn = args['_spawnFn'];
                const renamedTo = new Set(stats.rename_candidates.map((c) => c.new));
                const upsertedRepos = out.repos.filter((repo) => !renamedTo.has(repo.name));
                const files = persistedFiles(out.files, renamedTo);
                const warnings = noSyncRemoteWarnings(db, upsertedRepos.map((r) => r.name));
                for (const r of upsertedRepos) {
                    try {
                        syncRepoMilestones(db, r.name, r.path, spawnFn);
                    }
                    catch (e) {
                        serverLog({ event: 'milestone_sync_error', repo: r.name, error: e.message });
                    }
                }
                // #2881: structural-change detection vs previous deep_scan_completed
                // audit. The flag rides in the audit content_json so downstream
                // tooling (the scan-side renderer pass, manual diagnostic queries)
                // can decide whether the scan changed the project shape.
                const topDirs = new Set(files.map((f) => f.path.split('/')[0]).filter(Boolean));
                const structuralChange = detectStructuralChange(db, out.repos, topDirs, dirsBefore === 0 && stats.dirs_upserted > 0);
                // Emit deep_scan_completed audit row. Attach to the system issue
                // (id=-1) — this is a session-level event, not work-issue scoped.
                const pluginInventory = out.plugin_inventory ?? null;
                const pluginNote = pluginInventory?.status === 'unavailable'
                    ? `; plugins unavailable: ${pluginInventory.note}`
                    : '';
                const mcpInventory = out.mcp_inventory ?? null;
                const mcpNote = mcpInventory?.status === 'unavailable'
                    ? `; mcp servers unavailable: ${mcpInventory.note}`
                    : '';
                insertAudit(db, {
                    issue_id: -1,
                    from_node: 'bro',
                    event_type: 'deep_scan_completed',
                    summary: `Scan: discovered ${stats.repos_discovered} repos, upserted ${stats.repos_upserted}, retired ${stats.repos_retired}${stats.repos_stale_kept.length ? ` (kept ${stats.repos_stale_kept.length} stale, still referenced)` : ''}; ${files.length} files; dirs upserted ${stats.dirs_upserted} (${stats.dirs_readme_summarized} README + ${stats.dirs_structural_summarized} structural), retired ${stats.dirs_retired}; files upserted ${stats.files_upserted} (${stats.files_extracted} extracted), retired ${stats.files_retired}; symbols ${stats.symbols.symbols} in ${stats.symbols.files_parsed} parsed files (${stats.symbols.files_failed} failed), edges ${stats.symbols.edges_resolved}/${stats.symbols.edges} resolved — source=${source}${structuralChange ? ', structural-change' : ''}${pluginNote}${mcpNote}`,
                    content_json: JSON.stringify({
                        ...stats,
                        session_dir: out.session_dir,
                        scanned_at: out.scanned_at,
                        source,
                        structural_change: structuralChange,
                        repos_seen: out.repos.map((r) => r.name),
                        top_dirs: Array.from(topDirs).sort(),
                    }),
                });
                return ok({
                    session_dir: out.session_dir,
                    scanned_at: out.scanned_at,
                    repos: out.repos.map((r) => ({ name: r.name, file_count: r.file_count })),
                    source,
                    structural_change: structuralChange,
                    plugin_inventory: pluginInventory,
                    mcp_inventory: mcpInventory,
                    ...stats,
                    warnings,
                });
            }
            finally {
                // Release the lock whether runScan or persistScan threw or not, so a
                // failed scan never wedges future runs behind a stale lock.
                if (lockPath)
                    releaseLock(lockPath);
            }
        })),
        repos_list: requireRoles('repos_list', ['bro', 'swe', 'pr-reviewer', 'consultant'], wrap(async () => {
            const rows = db.all(`SELECT name, path, file_count, last_scanned_at FROM repos ORDER BY name`);
            return ok({ repos: rows });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=scan.js.map