import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { insertAudit } from './audit.js';
import { WorldModelGraph } from '../graph.js';
import { extractPurpose, isPurposeCandidate, PURPOSE_HEAD_BYTES } from '../file-purpose.js';
import { purposeHeadPaths, purposeHeadPathsOf, refreshSymbolPurposes } from '../symbol-purpose.js';
import { readmeDrift, readRepoHistory } from '../readme-drift.js';
import { cleanReadme } from '../readme-summary.js';
import { classifyUrl } from '../utils/classify-url.js';
import { frameUntrusted } from '../utils/untrusted.js';
import { serverLog } from '../logger.js';
import { applyRepoSymbols, builtBundleMaps, bundleMaps, diskReader, EXTRACTOR_VERSION, planRepoSymbols, } from '../symbol-index.js';
import { isGeneratedPath } from '../parsing/extract.js';
import { applyConceptProposals, refreshConcepts } from '../world-model/concepts.js';
import { catchUpRepos, indexStamp, markReindexFailed, markReindexFinish, markReindexStart, mismatchPending, recordReindex, triggerOfSource, } from '../world-model/freshness.js';
import { startShadowCompare } from '../world-model/shadow-compare.js';
import { syncRepoMilestones } from './milestones.js';
import { primaryIndex, repoRemotes, upsertRepoRemotes } from '../repos/remotes.js';
import { projectRootFromDbPath } from './containment.js';
import { closeContents, walkProject } from './scan-walk.js';
import { liveLock, releaseLock, scanLockPath, tryLock } from '../utils/scan-lock.js';
import { configureTestLane } from '../utils/test-paths.js';
import { readTestLaneConfig } from './config.js';
import { verificationDefaultsHint } from './verification-defaults.js';
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
// Valid `source` values for scan_run (#2881). The default — bro_auto_initial —
// matches the historical un-tagged behavior (bro hit the registry-cold gate
// and remediated by running scan).
const VALID_SCAN_SOURCES = new Set([
    'user_manual',
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
// See docs/architecture/WORLD_MODEL.md and GH 1680.
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
// A README is remotely-sourced text — frame it as untrusted data so any agent
// that later reads this world-model summary treats it as content, not
// instructions (#1036).
function readmeSummaryText(raw) {
    const text = cleanReadme(raw);
    const clipped = text.length > README_MAX_BYTES ? text.slice(0, README_MAX_BYTES) : text;
    return frameUntrusted('readme', clipped);
}
export function readReadmeSummary(absDirPath) {
    const readme = readReadme(absDirPath);
    return readme ? readmeSummaryText(readme.text) : null;
}
function readmePath(dir, name) {
    return dir === '' ? name : `${dir}/${name}`;
}
// The README of each directory, read whole from the indexed commit's blobs.
// With a scope only a README whose blob changed is read.
async function readReadmes(out, dirMap, scope) {
    const readmes = new Map();
    for (const entry of dirMap.values()) {
        const content = out.contents?.get(entry.repo);
        if (!content)
            continue;
        for (const name of README_CANDIDATES) {
            if (!entry.file_names.includes(name))
                continue;
            const path = readmePath(entry.path, name);
            if (scope && !scope.changed.has(path))
                break;
            const text = await content.text(path);
            if (text !== null) {
                readmes.set(`${entry.repo} ${entry.path}`, { name, text });
                break;
            }
        }
    }
    return readmes;
}
// README drift per directory, keyed '<repo> <path>', for each README read.
// Runs before the write transaction so git calls never hold the DB lock; a
// repo or README git cannot answer for is simply absent, leaving its columns
// NULL.
function planReadmeDrift(out, dirMap, readmes) {
    const drift = new Map();
    const repos = new Map(out.repos.map((r) => [r.name, r]));
    const histories = new Map();
    const historyFor = (repo) => {
        if (!histories.has(repo.name)) {
            const trackedDirs = new Set();
            for (const e of dirMap.values())
                if (e.repo === repo.name && e.path !== '')
                    trackedDirs.add(e.path);
            const tree = out.contents?.get(repo.name)?.tree;
            histories.set(repo.name, readRepoHistory(repo.path, trackedDirs, repo.commit ?? 'HEAD', tree ? new Set(tree.keys()) : undefined));
        }
        return histories.get(repo.name) ?? null;
    };
    for (const entry of dirMap.values()) {
        const key = `${entry.repo} ${entry.path}`;
        const readme = readmes.get(key);
        const repo = repos.get(entry.repo);
        if (!readme || !repo)
            continue;
        const history = historyFor(repo);
        if (!history)
            continue;
        const d = readmeDrift(history, entry.path, readme.name, readme.text);
        if (d)
            drift.set(key, d);
    }
    return drift;
}
function persistDirectoriesGraph(graph, out, now, purposesByDir = new Map(), driftByDir = new Map(), readmes = new Map(), scope) {
    const repoPaths = new Map();
    for (const r of out.repos)
        repoPaths.set(r.name, r.path);
    const dirMap = deriveDirectoryEntries(out);
    const stored = new Map();
    if (scope) {
        for (const r of out.repos)
            for (const d of graph.allDirectoriesForRepo(r.name))
                stored.set(`${d.repo} ${d.path}`, d);
    }
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
        const key = `${entry.repo} ${entry.path}`;
        if (!repoPaths.has(entry.repo) || (scope && !scope.dirs.has(key)))
            continue;
        const readme = readmes.get(key);
        const prev = stored.get(key);
        const keepsReadme = !readme && prev?.summary_source === 'readme' && README_CANDIDATES.some((name) => entry.file_names.includes(name));
        const readmeSummary = readme ? readmeSummaryText(readme.text) : keepsReadme ? prev.summary : null;
        const subdirNames = subdirsByParent.get(key) ?? [];
        const summary = readmeSummary
            ?? buildStructuralSummary(entry.path, entry.file_names, subdirNames, purposesByDir.get(key) ?? []);
        const drift = readme ? driftByDir.get(key) : keepsReadme ? prev : undefined;
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
        if (entry.parent_path === null || (scope && !scope.dirs.has(`${entry.repo} ${entry.path}`)))
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
// except a new non-empty last_commit_sha is written onto it, and a
// purpose_source still 'none' is re-extracted (written only when that finds a
// purpose); a changed or new file is re-extracted from
// its first PURPOSE_HEAD_BYTES; a purpose an swe wrote (purpose_source='swe')
// survives a content change. A stored file whose read failed (md5 '') keeps its
// row, so a failed read never counts as a content change (GH 2242). Heads come
// from the indexed commit's blobs; a scoped reindex re-extracts only the files
// whose content changed. For a repo in `reparse` every stored row is ignored,
// swe purposes included, so each row is rewritten from the walk as a clean
// rebuild writes it.
async function planFiles(graph, out, now, scope, reparse = new Set()) {
    const repoNames = new Set(out.repos.map((r) => r.name));
    const existing = new Map();
    for (const r of out.repos.filter((x) => !reparse.has(x.name))) {
        for (const f of graph.allFilesForRepo(r.name))
            existing.set(f.path, f);
    }
    const headOf = async (repo, rel) => (await out.contents?.get(repo)?.head(rel, PURPOSE_HEAD_BYTES)) ?? '';
    const plan = { nodes: [], writes: [], extracted: 0 };
    for (const f of out.files) {
        if (!repoNames.has(f.repo))
            continue;
        const path = WorldModelGraph.fileKey(f.repo, f.path);
        const prev = existing.get(path);
        const md5 = f.content_md5 ?? '';
        if (prev && md5 === '') {
            plan.nodes.push(prev);
            continue;
        }
        if (prev && prev.content_md5 === md5) {
            const sha = f.last_commit_sha ?? '';
            let node = sha !== '' && sha !== prev.last_commit_sha ? { ...prev, last_commit_sha: sha, updated_at: now } : prev;
            if (!scope && prev.purpose_source === 'none' && isPurposeCandidate(f.path)) {
                const extracted = extractPurpose(f.path, await headOf(f.repo, f.path));
                plan.extracted++;
                if (extracted.source !== 'none')
                    node = { ...node, purpose: extracted.purpose, purpose_source: extracted.source, updated_at: now };
            }
            plan.nodes.push(node);
            if (node !== prev)
                plan.writes.push(node);
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
                ? extractPurpose(f.path, await headOf(f.repo, f.path))
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
        graph.syncFileLanes(r.name);
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
export const SCAN_ERRORS_MAX = 20;
export const SCAN_ERROR_MESSAGE_MAX = 500;
export function recordScanError(errors, stage, repo, e) {
    const message = e instanceof Error ? e.message : String(e);
    serverLog({ event: `${stage}_error`, repo, error: message });
    if (errors.length >= SCAN_ERRORS_MAX)
        return;
    errors.push({ stage, repo, error: message.slice(0, SCAN_ERROR_MESSAGE_MAX) });
}
export function persistedFiles(files, renamedTo) {
    return files.filter((f) => !renamedTo.has(f.repo) && !isGeneratedPath(f.path));
}
// Persist repos[], the world model (wm_directories + wm_files) and each
// scanned repo's symbols, purposes, concepts and indexed_commit stamp (GH
// 2584): every git read and parse is planned first, then all of it is written
// in one synchronous transaction with no await, so a reader on another
// connection sees the old snapshot or the new one, never a mix. A stage that
// fails is recorded in errors and the rest commits; a throw rolls it all back.
// `run` given, each repo's wm_freshness row is finished in that transaction.
// A repo with a shadow-compare mismatch pending is reparsed in full, since the
// scan's full wm_reindex row clears it.
// sessionDir is used to scope repo retirement: repos in the DB whose path
// falls under sessionDir but are absent from this scan's result are retired,
// unless a task or another row still references them; those are kept and
// reported in repos_stale_kept (GH 1551).
async function persistScan(db, graph, out, sessionDir, run) {
    const now = nowISO();
    configureTestLane(readTestLaneConfig(db));
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
    let graphStats = emptyGraphStats();
    const symbols = emptySymbolStats();
    const errors = [];
    const indexed_by_repo = new Map();
    const repoFiles = (r) => out.files.filter((f) => f.repo === r.name);
    const reparse = new Set(persisted.repos.filter((r) => mismatchPending(db, r.name)).map((r) => r.name));
    const graphPlan = graph ? await planGraph(graph, persisted, now, undefined, reparse) : null;
    const repoPlans = new Map();
    if (graphPlan) {
        for (const r of persisted.repos) {
            const planned = plannedFiles(db, r.name, graphPlan.files, reparse.has(r.name));
            repoPlans.set(r.name, await planRepoIndex(db, r, repoFiles(r), out.contents?.get(r.name), planned));
        }
    }
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
            // Milestones no issue references (e.g. a scan-seeded one) and the
            // repo's wm_reindex history go with the repo; the savepoint restores
            // them when the repo itself can't retire.
            db.run(`SAVEPOINT retire_repo`);
            try {
                db.run(`DELETE FROM audit WHERE event_type = 'wm_reindex' AND repo = ?`, [r.name]);
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
        if (!graph || !graphPlan)
            return;
        graphStats = applyGraph(graph, persisted, now, graphPlan, retired);
        reindexHooks.afterGraph?.();
        for (const r of persisted.repos)
            indexed_by_repo.set(r.name, applyRepoIndex(db, r, repoPlans.get(r.name), symbols, errors));
        if (run) {
            for (const r of persisted.repos) {
                const target = r.commit ? { ref: r.target_ref ?? null, commit: r.commit } : undefined;
                markReindexFinish(db, r.name, run, !errors.some((e) => e.repo === r.name), target);
            }
        }
        reindexHooks.afterIndex?.();
    });
    dirs_retired += graphStats.dirs_retired;
    return {
        repos_discovered: out.repos.length,
        repos_upserted,
        repos_retired,
        repos_stale_kept,
        ...graphStats,
        dirs_retired,
        symbols,
        rename_candidates,
        errors,
        indexed_by_repo,
    };
}
function emptyGraphStats() {
    return {
        dirs_upserted: 0,
        dirs_retired: 0,
        dirs_readme_summarized: 0,
        dirs_structural_summarized: 0,
        files_upserted: 0,
        files_extracted: 0,
        files_retired: 0,
    };
}
function emptySymbolStats() {
    return { files_parsed: 0, files_failed: 0, symbols: 0, edges: 0, edges_resolved: 0 };
}
async function planGraph(graph, out, now, scope, reparse) {
    const files = await planFiles(graph, out, now, scope, reparse);
    const dirMap = deriveDirectoryEntries(out);
    const readmes = await readReadmes(out, dirMap, scope);
    return { files, dirMap, readmes, drift: planReadmeDrift(out, dirMap, readmes), scope };
}
// The wm_files and wm_directories rows of out's repos, with README drift;
// retired repos lose theirs. With a scope only the changed files and the
// scoped directories are rewritten, and rows of paths the commit no longer
// has are dropped.
function applyGraph(graph, out, now, { files: plan, dirMap, readmes, drift, scope }, retired = []) {
    const stats = emptyGraphStats();
    stats.files_extracted = plan.extracted;
    graph.transaction(() => {
        for (const r of retired) {
            stats.dirs_retired += graph.pruneDirectories(r.name, new Set());
            stats.files_retired += graph.pruneFiles(r.name, new Set());
        }
        const dirStats = persistDirectoriesGraph(graph, out, now, purposesByDirectory(plan.nodes), drift, readmes, scope);
        stats.dirs_upserted = dirStats.dirs_upserted;
        stats.dirs_readme_summarized = dirStats.dirs_readme_summarized;
        stats.dirs_structural_summarized = dirStats.dirs_structural_summarized;
        // Prune stale directory rows for each scanned repo (handles renames).
        for (const r of out.repos) {
            const keepKeys = new Set();
            for (const entry of dirMap.values()) {
                if (entry.repo === r.name)
                    keepKeys.add(WorldModelGraph.dirKey(r.name, entry.path));
            }
            stats.dirs_retired += graph.pruneDirectories(r.name, keepKeys);
        }
        const fileStats = persistFilesGraph(graph, out, plan);
        stats.files_upserted = fileStats.files_upserted;
        stats.files_retired += fileStats.files_retired;
    });
    return stats;
}
// A repo's wm_files rows as they stand once applyGraph has run `plan`: its
// planned nodes, each keeping the stored symbols_md5 (upsertFile leaves it),
// NULL for a new row or when `reparse` drops every stamp.
function plannedFiles(db, repo, plan, reparse = false) {
    const stored = new Map(db
        .all(`SELECT path, symbols_md5 FROM wm_files WHERE repo = ?`, [repo])
        .map((f) => [f.path, f.symbols_md5]));
    return plan.nodes
        .filter((n) => n.repo === repo)
        .map((n) => {
        const path = WorldModelGraph.relativeFilePath(n);
        return {
            path,
            content_md5: n.content_md5,
            size_bytes: n.size_bytes,
            symbols_md5: reparse ? null : stored.get(path) ?? null,
            purpose_source: n.purpose_source,
        };
    });
}
async function planRepoIndex(db, r, files, content, planned, scope) {
    const read = content ? (rel) => content.text(rel) : diskReader(r.path);
    const plan = { scope };
    try {
        const maps = [...bundleMaps(files), ...(await builtBundleMaps(r.path))];
        plan.symbols = await planRepoSymbols(db, r.name, r.path, EXTRACTOR_VERSION, maps, read, planned);
    }
    catch (e) {
        plan.symbolsError = e;
    }
    if (content) {
        try {
            const heads = new Map();
            const paths = planned ? purposeHeadPathsOf(planned, scope?.changed) : purposeHeadPaths(db, r.name, scope?.changed);
            for (const path of paths)
                heads.set(path, await content.head(path, PURPOSE_HEAD_BYTES));
            plan.heads = heads;
        }
        catch (e) {
            plan.headsError = e;
        }
    }
    return plan;
}
// One repo's symbols, symbol purposes and concepts brought up to its commit,
// then repos.indexed_commit stamped; a repo git gave no commit was read from
// disk and is not stamped. A stage that throws is recorded and the rest still
// run. Synchronous: every git read is in `plan`, so a caller can run this
// inside one db.transaction with no await in it. Returns the files parsed and
// concepts_flagged, the concepts whose status refreshConcepts changed.
function applyRepoIndex(db, r, plan, symbols, errors) {
    const paths = plan.scope?.changed;
    let parsed = 0;
    let concepts_flagged = 0;
    try {
        if (!plan.symbols)
            throw plan.symbolsError;
        const repoStats = applyRepoSymbols(db, plan.symbols);
        for (const key of SYMBOL_STAT_KEYS)
            symbols[key] += repoStats[key];
        parsed = repoStats.files_parsed + repoStats.files_failed;
    }
    catch (e) {
        symbols.error = `${r.name}: ${e.message}`;
        recordScanError(errors, 'symbol_index', r.name, e);
    }
    try {
        if (plan.headsError !== undefined)
            throw plan.headsError;
        refreshSymbolPurposes(db, r.name, plan.heads ? { heads: plan.heads, paths } : { paths });
    }
    catch (e) {
        recordScanError(errors, 'symbol_purpose', r.name, e);
    }
    try {
        concepts_flagged = refreshConcepts(db, r.name).changed;
    }
    catch (e) {
        recordScanError(errors, 'concept_refresh', r.name, e);
    }
    try {
        applyConceptProposals(db, r.name, r.path);
    }
    catch (e) {
        recordScanError(errors, 'concept_proposals', r.name, e);
    }
    if (r.commit) {
        db.run(`UPDATE repos SET indexed_commit = ?, indexed_stamp = ? WHERE name = ?`, [r.commit, indexStamp(), r.name]);
    }
    return { parsed, concepts_flagged };
}
// Test seams inside the reindex and full scan transactions: afterGraph once
// the wm_files and wm_directories rows are written, afterIndex once the
// symbols, concepts and indexed_commit stamp are. Both run synchronously in it.
export const reindexHooks = {};
// One repo's world model brought to out's commit (GH 2584): a full rebuild
// without a `scope`, the incremental reindex with one. out holds that one
// repo, already registered in repos. Every blob is read and parsed first, then
// files, dirs, symbols with the relink and orphan marking, purposes, concepts
// and the indexed_commit stamp are written in one synchronous transaction. No
// await runs inside it, so no other write on this connection joins it. In the
// incremental reindex a stage that fails rolls it all back; the full rebuild
// records the stage's error and commits the rest, as scan_run does. onApply
// runs inside the transaction with the stage errors, once the stamp is written.
// opts.reparse ignores the stored wm_files rows and symbols_md5 stamps, so
// every file row is rewritten from the walk and every file parsed again: the
// rebuild a shadow-compare mismatch forces cannot trust them.
export async function persistRepoReindex(db, graph, out, scope, onApply, opts = {}) {
    const now = nowISO();
    configureTestLane(readTestLaneConfig(db));
    const persisted = { ...out, files: persistedFiles(out.files, new Set()) };
    const repoFiles = (r) => out.files.filter((f) => f.repo === r.name);
    const stampCounts = () => {
        for (const r of out.repos) {
            db.run(`UPDATE repos SET file_count = ?, last_scanned_at = ? WHERE name = ?`, [r.file_count, now, r.name]);
        }
    };
    const symbols = emptySymbolStats();
    const errors = [];
    let concepts_flagged = 0;
    const stats = (graphStats) => ({
        files_parsed: symbols.files_parsed + symbols.files_failed,
        dirs_touched: graphStats.dirs_upserted,
        concepts_flagged,
        errors,
    });
    const graphPlan = await planGraph(graph, persisted, now, scope, new Set(opts.reparse ? out.repos.map((r) => r.name) : []));
    const repoPlans = new Map();
    for (const r of out.repos) {
        const planned = plannedFiles(db, r.name, graphPlan.files, opts.reparse === true);
        repoPlans.set(r.name, await planRepoIndex(db, r, repoFiles(r), out.contents?.get(r.name), planned, scope));
    }
    return db.transaction(() => {
        stampCounts();
        const graphStats = applyGraph(graph, persisted, now, graphPlan);
        reindexHooks.afterGraph?.();
        for (const r of out.repos)
            concepts_flagged += applyRepoIndex(db, r, repoPlans.get(r.name), symbols, errors).concepts_flagged;
        reindexHooks.afterIndex?.();
        if (scope && errors.length > 0) {
            throw new Error(`incremental reindex failed: ${errors.map((e) => `${e.stage}: ${e.error}`).join('; ')}`);
        }
        onApply?.(errors);
        return stats(graphStats);
    });
}
const SCAN_TIMEOUT_MS = 10 * 60 * 1000; // 10-minute hard timeout
export function scanTools(db, graphHolder = null, dbPath = '') {
    const definitions = [
        {
            name: 'scan_run',
            description: "Deterministic scan of git repos under session_dir: writes tracked files (.gitignore-aware) and dirs to the world model, dir summaries from README.md (summary_source='readme') or structural, and a deep_scan_completed audit row. " +
                `errors[] (max ${SCAN_ERRORS_MAX}, also in that row): {stage, repo, error} per repo stage that threw. ` +
                'A renamed repo goes to rename_candidates (for repo_rename), not a new row. warnings[]: no_sync_remote per repo whose remotes lack a sync row while issue_sync is on. 10-min hard timeout.',
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
                        enum: ['user_manual', 'bro_auto_initial', 'startup_catchup'],
                        description: 'Who fired this scan. user_manual = the user typed /scan (full rebuild of every repo); bro_auto_initial = bro hit the registry-cold gate, and run-scan.mjs\'s default; startup_catchup = the server\'s connect-time catch-up, which on a warm DB reindexes each known repo to its target commit instead of walking the workspace, then starts the daily shadow compare of at most one repo in the background (result `shadow_compare`: its name or null). Reads and task spawns reindex on their own. Defaults to bro_auto_initial.',
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
            // startup_catchup on a warm DB brings each known repo to its target
            // (git-range scope, full-repo only when the stamp needs it) and runs no
            // workspace discovery (GH 2584). Then the daily shadow compare of at
            // most one repo starts in the background, not awaited.
            if (source === 'startup_catchup' && graph && db.get(`SELECT 1 FROM repos LIMIT 1`)) {
                const results = await catchUpRepos(db, graph, { dbPath, trigger: 'startup_catchup' });
                const shadowCompare = startShadowCompare(db);
                return ok({ source, repos: results, shadow_compare: shadowCompare });
            }
            // #339: lock file prevents concurrent scans. Lock lives beside the DB.
            const lockPath = scanLockPath(dbPath);
            const held = liveLock(lockPath);
            if (held)
                return err(`scan already running (pid ${held.pid}, started ${held.started_at})`);
            if (!tryLock(lockPath)) {
                // A live lock appeared between the check and the acquire — we lost the
                // race. Never fall through to a concurrent scan (#1018c).
                const recheck = liveLock(lockPath);
                return err(recheck
                    ? `scan already running (pid ${recheck.pid}, started ${recheck.started_at})`
                    : 'scan lock could not be acquired');
            }
            const started = Date.now();
            let out = null;
            try {
                out = await walkProject(db, sessionDir, { timeoutMs: SCAN_TIMEOUT_MS });
                if (!graph && out.files.length > 0) {
                    return err('world_model_unavailable: no world-model graph to write; repos and deep_scan_completed left unchanged');
                }
                const dirsBefore = graph?.directoryCount() ?? 0;
                const indexedBefore = new Map(db.all(`SELECT name, indexed_commit FROM repos`).map((r) => [r.name, r.indexed_commit]));
                const trigger = triggerOfSource(source);
                const run = { mode: 'full', trigger, startedMs: started };
                // A repo new to this scan gets its wm_freshness row with its repos
                // row, in persistScan's transaction.
                const running = graph ? out.repos.filter((r) => indexedBefore.has(r.name)).map((r) => r.name) : [];
                for (const name of running)
                    markReindexStart(db, name, run);
                let persistedScan;
                try {
                    persistedScan = await persistScan(db, graph, out, sessionDir, graph ? run : undefined);
                }
                catch (e) {
                    for (const name of running)
                        markReindexFailed(db, name, run);
                    throw e;
                }
                const { indexed_by_repo, ...stats } = persistedScan;
                const scanMs = Date.now() - started;
                for (const r of out.repos) {
                    const indexed = indexed_by_repo.get(r.name);
                    if (!graph || !r.commit || !indexed)
                        continue;
                    const dirs = db.get(`SELECT COUNT(*) AS n FROM wm_directories WHERE repo = ?`, [r.name]);
                    recordReindex(db, {
                        repo: r.name,
                        mode: 'full',
                        reason: 'scan',
                        trigger,
                        from_commit: indexedBefore.get(r.name) ?? '',
                        to_commit: r.commit,
                        files_diffed: r.file_count,
                        files_parsed: indexed.parsed,
                        dirs_touched: dirs?.n ?? 0,
                        concepts_flagged: indexed.concepts_flagged,
                        ms: scanMs,
                    });
                }
                // Milestones: reconcile from each repo's remote, then seed one
                // v<next-patch> where none exist. Never fails the scan.
                const spawnFn = args['_spawnFn'];
                const renamedTo = new Set(stats.rename_candidates.map((c) => c.new));
                const upsertedRepos = out.repos.filter((repo) => !renamedTo.has(repo.name));
                const files = persistedFiles(out.files, renamedTo);
                const warnings = noSyncRemoteWarnings(db, upsertedRepos.map((r) => r.name));
                const defaultsHints = upsertedRepos
                    .map((r) => verificationDefaultsHint(db, r.name, r.path))
                    .filter((h) => h !== null);
                for (const r of upsertedRepos) {
                    try {
                        syncRepoMilestones(db, r.name, r.path, spawnFn);
                    }
                    catch (e) {
                        recordScanError(stats.errors, 'milestone_sync', r.name, e);
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
                    ...(defaultsHints.length > 0 ? { verification_defaults_hint: defaultsHints } : {}),
                });
            }
            finally {
                // Release the lock whether runScan or persistScan threw or not, so a
                // failed scan never wedges future runs behind a stale lock.
                if (out)
                    closeContents(out);
                releaseLock(lockPath);
            }
        })),
        repos_list: requireRoles('repos_list', ['bro', 'swe', 'code-reviewer', 'consultant'], wrap(async () => {
            const rows = db.all(`SELECT name, path, file_count, last_scanned_at FROM repos ORDER BY name`);
            return ok({ repos: rows });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=scan.js.map