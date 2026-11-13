import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
import { insertAudit } from './audit.js';
import { WorldModelGraph } from '../graph.js';
import { topKByCosine } from '../embeddings/store.js';
import { backfillMissing, startWorldModelBackfill, WORLD_MODEL_TABLES } from '../embeddings/backfill.js';
import { repoRowPath, resolveSoleRepo } from '../utils/repo-paths.js';
import { spawnSync } from 'node:child_process';
import { probeBaseRef, resolveBaseRef, resolveRepoDefaultBranch } from '../utils/git-refs.js';
import { gitUnanswered, runGit } from '../utils/git-run.js';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { frameUntrusted } from '../utils/untrusted.js';
import { readBlobSync } from '../utils/git-objects.js';
import { isTestPath } from '../utils/test-paths.js';
import { serverLog } from '../logger.js';
import { ensureFresh, fetchTargetIfDue, freshnessBlock, freshnessFields, isStale } from '../world-model/freshness.js';
import { needsReview } from '../world-model/needs-review.js';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { configKeyReaders, coveringRunners, fileRefKey, IMPACT_MAX_DEPTH, keywordSearchSymbols, staleFiles, symbolById, symbolCard, symbolImpact, symbolsByName, } from '../symbol-index.js';
import { CLAIM_ARGS_SCHEMA, CLAIMS, CONCEPT_KINDS, DERIVED_SEED_HITS, HANDOFFS, derivedChain, getConcept, searchConcepts, upsertConcept, } from '../world-model/concepts.js';
const WORLD_MODEL_GET_MAX_NODES = 500;
const RRF_K = 60;
const SEARCH_BACKFILL_LIMIT = 50;
const UNMERGED_WORK_MAX_BRANCHES = 10;
const NET_DIFF_MAX_TARGET_COMMITS = 500;
const PATCH_ID_MAX_BUFFER = 256 * 1024 * 1024;
const SYMBOL_POOL = 40;
const FILE_RANK_POOL = 20;
const PATH_RANK_K = 10;
const AUX_WEIGHT = 0.5;
const DIR_WEIGHT = 0.5;
const SEARCH_K_MAX = 100;
const DEFAULT_IMPACT_DEPTH = 2;
const SOURCE_MAX_LINES = 200;
function git(repoPath, args) {
    return runGit(repoPath, args);
}
function patchIds(repoPath, args) {
    const patch = runGit(repoPath, args, { maxBuffer: PATCH_ID_MAX_BUFFER });
    if (gitUnanswered(patch))
        return 'spawn-error';
    if (patch.status !== 0)
        return null;
    if (!patch.stdout.trim())
        return [];
    const ids = runGit(repoPath, ['patch-id', '--stable'], { maxBuffer: PATCH_ID_MAX_BUFFER, input: patch.stdout });
    if (gitUnanswered(ids))
        return 'spawn-error';
    if (ids.status !== 0)
        return null;
    return ids.stdout
        .split('\n')
        .map((line) => line.split(' ')[0]?.trim())
        .filter((id) => !!id);
}
function netDiffLandedOn(repoPath, tip, target) {
    const mb = git(repoPath, ['merge-base', target, tip]);
    if (gitUnanswered(mb))
        return 'spawn-error';
    const base = mb.stdout?.trim();
    if (mb.status !== 0 || !base)
        return false;
    const branch = patchIds(repoPath, ['diff', '--no-color', '--no-ext-diff', base, tip]);
    if (branch === 'spawn-error')
        return branch;
    if (!branch || branch.length === 0)
        return false;
    const landed = patchIds(repoPath, [
        'log', '-p', '--no-color', '--no-ext-diff', '--no-merges', '--format=commit %H',
        '-n', String(NET_DIFF_MAX_TARGET_COMMITS), `${base}..${target}`,
    ]);
    if (landed === 'spawn-error')
        return landed;
    return !!landed && landed.includes(branch[0]);
}
// Twin of clean-merged-branch's integrated() (GH 1674). A tip counts as
// integrated into target when any of these holds, cheapest first, each one
// bounded git call:
//   1. it is an ancestor of target (merge / fast-forward);
//   2. merging it into target is a no-op — `merge-tree --write-tree` yields
//      target's own tree (squash or rebase merge of any number of commits);
//   3. `git cherry` finds every branch commit's patch already in target (a
//      squashed single commit that target has since edited further);
//   4. the branch's net diff (merge-base..tip) has the patch-id of one of the
//      last NET_DIFF_MAX_TARGET_COMMITS target commits since the merge-base (a
//      multi-commit squash that target has since edited further). Query-only:
//      _cmb_integrated has no such check, so the deletion gate stays stricter.
// An upstream reported `[gone]` is not used: a PR closed unmerged looks the same.
export function tipIntegratedInto(repoPath, tip, target) {
    const ancestor = git(repoPath, ['merge-base', '--is-ancestor', tip, target]);
    if (gitUnanswered(ancestor))
        return 'spawn-error';
    if (ancestor.status === 0)
        return 'integrated';
    if (ancestor.status !== 1)
        return 'unresolvable';
    const merged = git(repoPath, ['merge-tree', '--write-tree', target, tip]);
    if (gitUnanswered(merged))
        return 'spawn-error';
    if (merged.status === 0) {
        const targetTree = git(repoPath, ['rev-parse', `${target}^{tree}`]);
        if (gitUnanswered(targetTree))
            return 'spawn-error';
        const mergedTree = merged.stdout.split('\n')[0]?.trim();
        if (targetTree.status === 0 && mergedTree && mergedTree === targetTree.stdout.trim())
            return 'integrated';
    }
    const cherry = git(repoPath, ['cherry', target, tip]);
    if (gitUnanswered(cherry))
        return 'spawn-error';
    if (cherry.status === 0 && !/^\+/m.test(cherry.stdout))
        return 'integrated';
    const landed = netDiffLandedOn(repoPath, tip, target);
    if (landed === 'spawn-error')
        return landed;
    if (landed)
        return 'integrated';
    return 'unmerged';
}
// Surface closed-task work living on un-merged feature branches (#1059). The
// main checkout answers world_model_get from the directory tree alone, so a
// checkout sitting on the target branch hides work committed on branches that
// have not merged yet — bro then reads an "empty" repo and holds. This walks
// the tasks table (rows with a commit_sha, grouped by branch_id, newest first)
// and keeps only branches that still have a live local ref whose tip is not yet
// integrated into the repo's target branch, origin/<target> when it resolves
// (tipIntegratedInto: ancestor, or a
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
    const targetBranch = repoRow.target_branch || resolveRepoDefaultBranch(repoPath);
    const gitCheck = git(repoPath, ['rev-parse', '--is-inside-work-tree']);
    if (gitCheck.error || gitCheck.status !== 0) {
        return { unmerged_work: [], warning: 'unmerged-work-unavailable' };
    }
    const target = probeBaseRef(repoPath, targetBranch);
    if (target === 'unanswered')
        return { unmerged_work: [], warning: 'unmerged-work-unavailable' };
    if (!target)
        return { unmerged_work: [] };
    const rows = db.all(`SELECT branch_id, parent_branch_id, commit_sha, status
       FROM tasks
      WHERE repo = ? AND commit_sha IS NOT NULL
      ORDER BY updated_at DESC, id DESC`, [repo]);
    // Group by branch_id; insertion order (newest updated_at first) is preserved,
    // so the newest row per branch carries parent_branch_id. closed_tasks counts
    // the closed commit-bearing tasks on the branch.
    const byBranch = new Map();
    for (const r of rows) {
        let entry = byBranch.get(r.branch_id);
        if (!entry) {
            entry = { parent_branch_id: r.parent_branch_id, closed_tasks: 0 };
            byBranch.set(r.branch_id, entry);
        }
        if (r.status === 'closed')
            entry.closed_tasks++;
    }
    const unmerged_work = [];
    for (const [branch_id, entry] of [...byBranch.entries()].slice(0, UNMERGED_WORK_MAX_BRANCHES)) {
        // Require a live local ref: a deleted branch means the work was integrated
        // or abandoned.
        const refCheck = git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch_id}`]);
        if (gitUnanswered(refCheck))
            return { unmerged_work: [], warning: 'unmerged-work-unavailable' };
        if (refCheck.status !== 0)
            continue; // absent ref → integrated or abandoned, skip
        const tip = refCheck.stdout.trim();
        // Judge the live ref, not tasks.commit_sha: cli.js integrate rebases and
        // regenerates dist, so the pushed tip differs from the recorded one.
        const integration = tipIntegratedInto(repoPath, tip, target);
        if (integration === 'spawn-error') {
            return { unmerged_work: [], warning: 'unmerged-work-unavailable' };
        }
        if (integration !== 'unmerged')
            continue; // integrated, or an unresolvable tip skipped defensively
        unmerged_work.push({
            branch_id,
            parent_branch_id: entry.parent_branch_id,
            tip,
            closed_tasks: entry.closed_tasks,
            merged_into_target: false,
        });
    }
    return { unmerged_work };
}
// The world model is built from git objects at indexed_commit, but the main
// checkout trails origin/<target> as lanes merge (GH 1966). Counts against the
// last fetch (reads and the startup catch-up run fetchTargetIfDue, at most every
// 10 minutes); this never fetches. Null when the target has no origin ref, the
// checkout is current, or git fails.
export function checkoutLag(db, repo) {
    if (!repo)
        return null;
    const repoRow = db.get(`SELECT path, target_branch FROM repos WHERE name = ?`, [repo]);
    if (!repoRow)
        return null;
    const repoPath = repoRowPath(db, repoRow.path);
    const upstream = resolveBaseRef(repoPath, repoRow.target_branch || resolveRepoDefaultBranch(repoPath));
    if (!upstream?.startsWith('origin/'))
        return null;
    const res = spawnSync('git', ['-C', repoPath, 'rev-list', '--count', `HEAD..refs/remotes/${upstream}`], {
        encoding: 'utf8',
        timeout: SUBPROCESS_TIMEOUT_MS,
    });
    if (res.error || res.status !== 0)
        return null;
    const behind = Number.parseInt(res.stdout.trim(), 10);
    return Number.isInteger(behind) && behind > 0 ? { checkout_behind_upstream: behind, upstream } : null;
}
const COVERED_BY_CAP = 10;
// dir, then each ancestor up to the repo root ''.
function selfAndAncestors(dir) {
    const out = [];
    for (let d = dir; d !== null; d = d === '' ? null : d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
        out.push(d);
    }
    return out;
}
// The runners whose covers edge names dir or one of its ancestors, nearest
// first, each once, their commands framed; {} when none.
function coveredByView(covers, dir) {
    const seen = new Set();
    const runners = [];
    for (const d of selfAndAncestors(dir)) {
        for (const r of covers.get(d) ?? []) {
            const key = `${r.path}\u0000${r.runner}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            runners.push(r);
        }
    }
    if (runners.length === 0)
        return {};
    const framed = runners.slice(0, COVERED_BY_CAP).map((r) => ({ ...r, command: frameUntrusted('runner-command', r.command) }));
    return { covered_by: framed, ...(runners.length > COVERED_BY_CAP ? { covered_by_truncated: true } : {}) };
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
const TREE_FIELDS = [
    'path', 'summary', 'summary_source', 'summary_updated_at', 'file_count', 'summary_sha', 'commits_behind',
    'dead_refs', 'trust', 'covered_by', 'covered_by_truncated', 'children', 'files',
];
const FILE_FIELDS = ['path', 'purpose', 'purpose_source', 'content_md5'];
const VALID_FIELDS = new Set([...TREE_FIELDS, ...FILE_FIELDS]);
// world_model_get's fields argument: null when absent, else the named keys,
// or an error naming the valid ones.
export function parseFields(arg) {
    if (arg === undefined || arg === null)
        return { fields: null };
    const valid = [...VALID_FIELDS].join(', ');
    if (!Array.isArray(arg) || arg.some((f) => typeof f !== 'string'))
        return { error: `fields must be an array of strings; valid fields: ${valid}` };
    const unknown = arg.filter((f) => !VALID_FIELDS.has(f));
    if (unknown.length > 0)
        return { error: `unknown field(s) ${unknown.join(', ')}; valid fields: ${valid}` };
    return { fields: new Set(arg) };
}
function pickFields(entry, fields) {
    return Object.fromEntries(Object.entries(entry).filter(([key]) => key === 'path' || fields.has(key)));
}
// A tree node cut to the named keys; path, children and files always stay,
// and each files[] entry keeps path plus the named keys.
export function projectTree(node, fields) {
    const out = pickFields(node, fields);
    out['children'] = node.children.map((c) => projectTree(c, fields));
    if (node.files)
        out['files'] = node.files.map((f) => pickFields(f, fields));
    return out;
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
// Symbol signatures and docs are copied out of file contents, so they leave
// the server framed like purposes.
function framedSymbol(s) {
    return {
        ...s,
        signature: s.signature ? frameUntrusted('symbol-signature', s.signature) : '',
        doc: s.doc ? frameUntrusted('symbol-doc', s.doc) : '',
    };
}
function sourceLines(start_line, end_line, lines) {
    const start = Math.max(1, start_line);
    if (start > lines.length)
        return { source: null, source_reason: 'range-past-eof' };
    const end = Math.min(end_line, lines.length);
    const truncated = end - start + 1 > SOURCE_MAX_LINES;
    const last = truncated ? start + SOURCE_MAX_LINES - 1 : end;
    const text = frameUntrusted('symbol-source', lines.slice(start - 1, last).join('\n'));
    return { source: { start_line: start, end_line: last, text, truncated } };
}
// The symbol's lines framed as untrusted content: from the blob at the
// repo's indexed commit, the content its range was taken from (GH 2584), else
// from the repo root on disk, refusing a path that resolves (through .. or a
// symlink) outside that root.
function symbolSource(db, symbol) {
    const rootArg = resolveSoleRepo(db, symbol.repo)?.path;
    if (!rootArg)
        return { source: null, source_reason: 'repo-path-unknown' };
    const indexed = db.get(`SELECT indexed_commit FROM repos WHERE name = ?`, [symbol.repo])?.indexed_commit;
    if (indexed) {
        const blob = readBlobSync(rootArg, indexed, symbol.path);
        if (blob !== null)
            return sourceLines(symbol.start_line, symbol.end_line, blob.split('\n'));
    }
    let root;
    let file;
    try {
        root = realpathSync(rootArg);
        file = realpathSync(join(root, symbol.path));
    }
    catch {
        return { source: null, source_reason: 'file-missing' };
    }
    const rel = relative(root, file);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        return { source: null, source_reason: 'outside-repo-root' };
    let lines;
    try {
        lines = readFileSync(file, 'utf8').split('\n');
    }
    catch {
        return { source: null, source_reason: 'file-unreadable' };
    }
    return sourceLines(symbol.start_line, symbol.end_line, lines);
}
function symbolResult(symbol, score, stale) {
    const s = framedSymbol(symbol);
    return {
        kind: 'symbol',
        id: s.id,
        repo: s.repo,
        qualified_name: s.qualified_name,
        symbol_kind: s.kind,
        path: s.path,
        line_start: s.start_line,
        line_end: s.end_line,
        signature: s.signature,
        doc: s.doc,
        stale,
        score,
    };
}
function dirHit(node) {
    return { kind: 'dir', key: `dir:${node.key}`, node };
}
function fileHit(node) {
    return { kind: 'file', key: `file:${node.path}`, node };
}
function symbolHit(node) {
    return { kind: 'symbol', key: `symbol:${node.id}`, node };
}
function hitResult(hit, score, stale, fresh) {
    if (hit.kind === 'dir')
        return dirResult({ ...hit.node, score });
    if (hit.kind === 'file') {
        const result = fileResult({ ...hit.node, score });
        return isStale(fresh.get(hit.node.repo), WorldModelGraph.relativeFilePath(hit.node)) ? { ...result, stale: true } : result;
    }
    return symbolResult(hit.node, score, stale.has(fileRefKey(hit.node)) || isStale(fresh.get(hit.node.repo), hit.node.path));
}
function staleFlag(fresh) {
    return fresh && (fresh.stale === 'all' || fresh.stale.size > 0) ? { stale: true } : {};
}
function isBuildOutput(path) {
    return /(^|\/)dist\//.test(path) || path.endsWith('.map');
}
function pathWeight(path) {
    return isTestPath(path) || /(^|\/)changelog\.d\//.test(path) ? AUX_WEIGHT : 1;
}
// A dir weighs as a file inside it would, times dirWeight.
function hitWeight(hit, dirWeight) {
    if (hit.kind === 'dir')
        return pathWeight(`${hit.node.path}/x`) * dirWeight;
    if (hit.kind === 'file')
        return pathWeight(WorldModelGraph.relativeFilePath(hit.node));
    return pathWeight(hit.node.path);
}
// Keyword ranking across dirs, files and symbols. A repo-relative path scores
// w/(K + rank) once for the rank of its first symbol hit and once for its
// file-hit rank, so a file matched both ways rises; tests and changelog
// fragments count half. The path's first hit takes the path score, each later
// hit of the same path a falling share of it. Dirs score w/(K + rank) by their
// own rank, w scaled by dirWeight.
function rankKeyword(dirs, files, symbols, dirWeight) {
    const pathScore = new Map();
    const bump = (path, rank) => pathScore.set(path, (pathScore.get(path) ?? 0) + pathWeight(path) / (PATH_RANK_K + rank));
    const symbolRank = new Map();
    for (const s of symbols)
        if (!symbolRank.has(s.path))
            symbolRank.set(s.path, symbolRank.size);
    for (const [path, rank] of symbolRank)
        bump(path, rank);
    files.forEach((f, rank) => bump(WorldModelGraph.relativeFilePath(f), rank));
    const seen = new Map();
    const share = (path) => {
        const n = seen.get(path) ?? 0;
        seen.set(path, n + 1);
        return (pathScore.get(path) ?? 0) / (n + 1);
    };
    const ranked = [];
    dirs.forEach((d, rank) => {
        const hit = dirHit(d);
        ranked.push({ hit, score: hitWeight(hit, dirWeight) / (PATH_RANK_K + rank), order: ranked.length });
    });
    const firsts = [...pathScore.keys()].sort((a, b) => pathScore.get(b) - pathScore.get(a));
    const symbolsByPath = new Map();
    for (const s of symbols)
        symbolsByPath.set(s.path, [...(symbolsByPath.get(s.path) ?? []), s]);
    const fileByPath = new Map(files.map((f) => [WorldModelGraph.relativeFilePath(f), f]));
    for (const path of firsts) {
        for (const s of symbolsByPath.get(path) ?? [])
            ranked.push({ hit: symbolHit(s), score: share(path), order: ranked.length });
        const file = fileByPath.get(path);
        if (file)
            ranked.push({ hit: fileHit(file), score: share(path), order: ranked.length });
    }
    return ranked.sort((a, b) => b.score - a.score || a.order - b.order).map(({ hit, score }) => ({ hit, score }));
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
// Reciprocal rank fusion: each ranked list adds w/(RRF_K + rank + 1) to a hit,
// w its hitWeight.
function fuse(lists, dirWeight) {
    const fused = new Map();
    for (const list of lists) {
        list.forEach((hit, rank) => {
            const rrf = hitWeight(hit, dirWeight) / (RRF_K + rank + 1);
            const entry = fused.get(hit.key);
            if (entry)
                entry.score += rrf;
            else
                fused.set(hit.key, { hit, score: rrf });
        });
    }
    return [...fused.values()].sort((a, b) => b.score - a.score);
}
// The one world-model ranking, shared by world_model_search and the derived
// concept chain: keyword pools over dirs, files and symbols; in semantic or
// hybrid mode cosine hits too, fused by RRF in hybrid; keyword ranking alone
// when no embedding answers.
export async function rankWorldModel(db, graph, repo, query, mode, k) {
    const pool = mode === 'keyword' ? k : k * 4;
    const filePool = Math.max(pool, FILE_RANK_POOL);
    const symbolPool = Math.max(pool, SYMBOL_POOL);
    const dirSearch = graph.keywordSearchDirectories(repo, query, pool);
    const fileSearch = graph.keywordSearchFiles(repo, query, filePool);
    const symbolSearch = keywordSearchSymbols(db, repo, query, symbolPool);
    const match = [dirSearch, fileSearch, symbolSearch].some((r) => r.match === 'any_term')
        ? 'any_term'
        : 'all_terms';
    const poolFull = dirSearch.hits.length >= pool
        || fileSearch.hits.length >= filePool
        || symbolSearch.hits.length >= symbolPool;
    const files = fileSearch.hits.filter((f) => !isBuildOutput(WorldModelGraph.relativeFilePath(f)));
    const dirWeight = symbolSearch.hits.length > 0 ? DIR_WEIGHT : 1;
    const keywordRanked = rankKeyword(dirSearch.hits, files, symbolSearch.hits, dirWeight);
    const hitsOf = (ranked) => ranked.map(({ hit }) => hit);
    if (mode === 'keyword')
        return { ranked: keywordRanked, match, poolFull };
    await backfillWorldModel(db);
    const semantic = await cosineHits(db, graph, repo, query, pool);
    if (semantic.length === 0)
        return { ranked: keywordRanked, match, poolFull, warning: 'semantic_unavailable' };
    if (mode === 'semantic') {
        const weighted = semantic.map(({ hit, score }) => {
            const w = hitWeight(hit, 1);
            return { hit, score: score >= 0 ? score * w : score / w };
        });
        return { ranked: weighted.sort((a, b) => b.score - a.score), match, poolFull: false };
    }
    return {
        ranked: fuse([
            dirSearch.hits.map(dirHit),
            hitsOf(keywordRanked.filter(({ hit }) => hit.kind !== 'dir')),
            hitsOf(semantic.filter(({ hit }) => hit.kind === 'dir')),
            hitsOf(semantic.filter(({ hit }) => hit.kind === 'file')),
        ], dirWeight),
        match,
        poolFull,
    };
}
function derivedSeeds(ranked) {
    return ranked
        .flatMap(({ hit }) => {
        if (hit.kind === 'symbol')
            return [{ kind: 'symbol', id: hit.node.id }];
        if (hit.kind === 'file')
            return [{ kind: 'file', path: WorldModelGraph.relativeFilePath(hit.node) }];
        return [];
    })
        .slice(0, DERIVED_SEED_HITS);
}
export const SCOPE_K_DEFAULT = 10;
export const SCOPE_K_MAX = 30;
export const SCOPE_FILES_MAX = 50;
export const SCOPE_VERIFICATION_MAX = 5;
const ANCHOR_SCORE = 1;
const LINKED_SCORE = 0.5;
function dirOf(path) {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
}
// The non-module files whose module imports the symbol, or for a module row
// any symbol of its file.
function importerPaths(db, symbol) {
    const whole = symbol.kind === 'module' ? 1 : 0;
    return db
        .all(`SELECT DISTINCT o.path
         FROM wm_edges e JOIN wm_symbols d ON d.id = e.dst_id JOIN wm_symbols o ON o.id = e.src_id
        WHERE e.kind = 'imports' AND (d.id = ? OR (? = 1 AND d.repo = ? AND d.path = ?)) AND o.path <> ?
        ORDER BY o.path`, [symbol.id, whole, symbol.repo, symbol.path, symbol.path])
        .map((r) => r.path);
}
function anchorSymbols(db, repo, anchor) {
    const matches = symbolsByName(db, repo, anchor);
    const definitions = matches.filter((s) => s.kind !== 'module');
    if (definitions.length > 0)
        return definitions;
    if (matches.length > 0)
        return matches;
    return db.get(`SELECT 1 AS hit FROM wm_files WHERE repo = ? AND path = ?`, [repo, anchor]) ? 'file' : null;
}
// What is in scope for an objective and its anchors: the top-k search paths,
// each anchor's file, its callers (symbolImpact depth 1) and importers, the
// tests reaching it, and the runners covering every in-scope directory,
// nearest first. A file's score sums one share per distinct via.
export async function scopeSuggest(db, graph, repo, objective, anchors, k) {
    const scored = new Map();
    const add = (path, score, via) => {
        const entry = scored.get(path) ?? { score: 0, via: [] };
        if (entry.via.includes(via))
            return;
        entry.score += score;
        entry.via.push(via);
        scored.set(path, entry);
    };
    const tests = new Map();
    const addTest = (path, via) => {
        if (!tests.has(path))
            tests.set(path, via);
    };
    let warning;
    if (objective) {
        const ranking = await rankWorldModel(db, graph, repo, objective, 'hybrid', k);
        warning = ranking.warning;
        const best = new Map();
        for (const { hit, score } of ranking.ranked) {
            if (hit.kind === 'dir')
                continue;
            const path = hit.kind === 'file' ? WorldModelGraph.relativeFilePath(hit.node) : hit.node.path;
            if (isBuildOutput(path) || (!best.has(path) && best.size >= k))
                continue;
            best.set(path, Math.max(best.get(path) ?? 0, score));
        }
        for (const [path, score] of best) {
            if (isTestPath(path))
                addTest(path, 'search');
            else
                add(path, score, 'search');
        }
    }
    const unresolved = [];
    for (const anchor of anchors) {
        const roots = anchorSymbols(db, repo, anchor);
        if (roots === null) {
            unresolved.push(anchor);
            continue;
        }
        if (roots === 'file') {
            add(anchor, ANCHOR_SCORE, 'anchor');
            continue;
        }
        for (const s of roots) {
            add(s.path, ANCHOR_SCORE, 'anchor');
            const impact = symbolImpact(db, s, 1);
            for (const ref of impact.levels[0]?.refs ?? []) {
                if (ref.via === 'call' && ref.path !== s.path)
                    add(ref.path, LINKED_SCORE, `caller:${s.qualified_name}`);
            }
            for (const t of impact.tests)
                addTest(t.path, `test_of:${s.qualified_name}`);
            for (const path of importerPaths(db, s)) {
                if (isTestPath(path))
                    addTest(path, `test_of:${s.qualified_name}`);
                else
                    add(path, LINKED_SCORE, `import:${s.qualified_name}`);
            }
        }
    }
    const ranked = [...scored.entries()]
        .map(([path, e]) => ({ path, score: e.score, via: e.via }))
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const files = ranked.slice(0, SCOPE_FILES_MAX);
    const testList = [...tests.entries()].map(([path, via]) => ({ path, via }));
    const covers = coveringRunners(db, repo);
    const found = new Map();
    for (const path of [...files.map((f) => f.path), ...testList.map((t) => t.path)]) {
        selfAndAncestors(dirOf(path)).forEach((dir, distance) => {
            for (const runner of covers.get(dir) ?? []) {
                const key = `${runner.path}\u0000${runner.runner}`;
                const prior = found.get(key);
                if (!prior)
                    found.set(key, { runner, dir, distance, order: found.size });
                else if (distance < prior.distance)
                    found.set(key, { ...prior, dir, distance });
            }
        });
    }
    const runnerHits = [...found.values()].sort((a, b) => a.distance - b.distance || a.order - b.order);
    const runners = runnerHits.map(({ runner, dir }) => ({
        runner: runner.runner,
        path: runner.path,
        command: frameUntrusted('runner-command', runner.command),
        via: `covers:${dir === '' ? '.' : dir}`,
    }));
    const commands = [...new Set(runnerHits.map(({ runner }) => runner.command))].slice(0, SCOPE_VERIFICATION_MAX);
    return {
        files,
        ...(ranked.length > SCOPE_FILES_MAX ? { files_truncated: true } : {}),
        tests: testList,
        runners,
        unresolved_anchors: unresolved,
        draft: { files: files.map((f) => f.path), verification: commands.map((c) => frameUntrusted('runner-command', c)) },
        ...(warning ? { warning } : {}),
    };
}
function isScanError(e) {
    if (!e || typeof e !== 'object')
        return false;
    const r = e;
    return typeof r['stage'] === 'string' && typeof r['repo'] === 'string' && typeof r['error'] === 'string';
}
function lastScan(db) {
    const row = db.get(`SELECT created_at, content_json FROM audit WHERE event_type = 'deep_scan_completed' ORDER BY id DESC LIMIT 1`);
    if (!row)
        return null;
    let content = {};
    try {
        const parsed = row.content_json ? JSON.parse(row.content_json) : {};
        if (parsed && typeof parsed === 'object')
            content = parsed;
    }
    catch {
        content = {};
    }
    const errors = Array.isArray(content['errors']) ? content['errors'].filter(isScanError) : [];
    const source = typeof content['source'] === 'string' ? content['source'] : null;
    return { at: row.created_at, source, ok: errors.length === 0, errors };
}
function indexErrorOf(scan, repo) {
    const hit = scan?.errors.find((e) => e.stage === 'symbol_index' && e.repo === repo);
    return hit ? { index_error: hit.error } : {};
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
const LOGGED_ARGS = ['query', 'path', 'id', 'qualified_name', 'name', 'mode', 'depth', 'repo', 'k'];
const TOOL_LOGGED_ARGS = {
    world_model_symbol: ['impact', 'source', 'config_key'],
    scope_suggest: ['objective', 'anchors'],
};
function treeNodeCount(node) {
    const children = Array.isArray(node['children']) ? node['children'] : [];
    const files = Array.isArray(node['files']) ? node['files'].length : 0;
    return 1 + files + children.reduce((n, c) => n + treeNodeCount(c), 0);
}
const RESULT_COUNTS = {
    world_model_get: (p) => (p['root'] && typeof p['root'] === 'object' ? treeNodeCount(p['root']) : 0),
    world_model_search: (p) => (Array.isArray(p['results']) ? p['results'].length : 0),
    world_model_symbol: (p) => p['symbol'] && typeof p['symbol'] === 'object' ? 1 : Array.isArray(p['readers']) ? p['readers'].length : 0,
    world_model_concepts: (p) => (Array.isArray(p['concepts']) ? p['concepts'].length : 0) + (p['derived'] != null ? 1 : 0),
    world_model_concept_get: () => 1,
    world_model_concept_upsert: (p) => (typeof p['id'] === 'number' ? 1 : 0),
    scope_suggest: (p) => (Array.isArray(p['files']) ? p['files'].length : 0),
};
function attributedTask(db, agent) {
    const runs = db.all(`SELECT task_id FROM agent_runs WHERE completed_at IS NULL AND agent_type = ? LIMIT 2`, [normalizeAgent(agent)]);
    const taskId = runs.length === 1 ? runs[0].task_id : null;
    if (taskId === null)
        return null;
    const task = db.get(`SELECT issue_id, branch_id, repo FROM tasks WHERE id = ?`, [taskId]);
    return task ? { task_id: taskId, ...task } : null;
}
function recordToolCall(db, tool, args, result, latencyMs) {
    const agent = String(args['agent']);
    const error = result.isError === true;
    const first = result.content[0];
    const payload = error || first?.type !== 'text' ? {} : JSON.parse(first.text);
    const resultCount = error ? 0 : RESULT_COUNTS[tool](payload);
    const task = attributedTask(db, agent);
    insertAudit(db, {
        issue_id: task?.issue_id ?? -1,
        branch_id: task?.branch_id ?? null,
        repo: task?.repo ?? null,
        from_node: agent,
        event_type: 'wm_tool_called',
        summary: `${tool} by ${agent}: ${resultCount} result(s)`,
        content_json: JSON.stringify({
            tool,
            agent,
            task_id: task?.task_id ?? null,
            args: Object.fromEntries([...LOGGED_ARGS, ...(TOOL_LOGGED_ARGS[tool] ?? [])].filter((k) => args[k] !== undefined).map((k) => [k, args[k]])),
            result_count: resultCount,
            empty: error || resultCount === 0,
            error,
            warning: typeof payload['warning'] === 'string' ? payload['warning'] : null,
            match: payload['match'] ?? null,
            derived: payload['derived'] != null,
            latency_ms: latencyMs,
        }),
    });
}
function logged(db, tool, fn) {
    return async (args) => {
        const started = performance.now();
        const result = await fn(args);
        try {
            recordToolCall(db, tool, args, result, Math.round(performance.now() - started));
        }
        catch (e) {
            console.error(`[world-model] ${tool} call log failed: ${e.message}`);
        }
        return result;
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
            ...(opts?.covers ? coveredByView(opts.covers, node.path) : {}),
            children,
        };
    }
    return descend(root, depth, 0);
}
const CONCEPT_LIMIT = 10;
// A step's symbol text is copied out of file contents, and a derived step's
// description is that text, so both leave the server framed.
function framedStep(step, derived) {
    const symbol = step.symbol && step.symbol.id !== null
        ? {
            ...step.symbol,
            signature: step.symbol.signature ? frameUntrusted('symbol-signature', step.symbol.signature) : '',
            doc: step.symbol.doc ? frameUntrusted('symbol-doc', step.symbol.doc) : '',
        }
        : step.symbol;
    const description = derived && step.description ? frameUntrusted('symbol-doc', step.description) : step.description;
    return { ...step, description, symbol };
}
const REPO_RESOLUTION_DOC = "Omitted, it defaults to the registered repo whose path contains the server's cwd (the deepest one), else the sole registered repo; repo_source in the result says which ('arg', 'cwd' or 'sole').";
const REPO_DEFAULT_DOC = `${REPO_RESOLUTION_DOC} With two or more repos and no match, returns warning 'repo-unspecified' with available_repos.`;
const REPO_ALL_DOC = `${REPO_RESOLUTION_DOC} With two or more repos and no match, it searches every repo, with repo_source 'all'.`;
function realOrResolved(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return resolve(path);
    }
}
function containsPath(dir, path) {
    const rel = relative(dir, path);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
// GH 1968: explicit arg, then the repo whose path holds the cwd (longest wins),
// then the sole repo; two or more repos and no match warn repo-unspecified.
export function resolveWorldModelRepo(db, arg, cwd = process.cwd()) {
    if (typeof arg === 'string' && arg)
        return { name: arg, repo_source: 'arg' };
    const rows = db.all(`SELECT name, path FROM repos ORDER BY name`);
    const here = realOrResolved(cwd);
    let best = null;
    for (const row of rows) {
        if (!row.path)
            continue;
        const dir = realOrResolved(repoRowPath(db, row.path));
        if (containsPath(dir, here) && (!best || dir.length > best.length))
            best = { name: row.name, length: dir.length };
    }
    if (best)
        return { name: best.name, repo_source: 'cwd' };
    if (rows.length >= 2)
        return { name: '', warning: 'repo-unspecified', available_repos: rows.map((r) => r.name) };
    if (rows.length === 1)
        return { name: rows[0].name, repo_source: 'sole' };
    return { name: '' };
}
export function worldModelTools(db, graphHolder, cwd) {
    const definitions = [
        {
            name: 'world_model_get',
            description: "The world model as a directory tree, the map for cold-start code tasks. Each node has a README summary (summary_source='readme', trust current|drifting(n)|dead_refs(k), summary_sha, commits_behind, dead_refs) or a structural one, first line only below root. " +
                'truncated:true past 500 nodes. A non-root path adds files[] (purposes); the root adds coverage. unmerged_work: closed-task branch tips not in the target. ' +
                'checkout_behind_upstream: commits the checkout trails origin/<target> at last fetch (may explain missing files, shifted lines); absent if current. ' +
                'last_scan {at, source, ok, errors}: newest scan_run (ok false if a stage failed), else null. ' +
                'Reads reindex to the target first: indexed_commit, target_commit; stale:true (+files[].stale) while another session reindexes. freshness: the index-freshness block. needs_review: flagged concepts and changed READMEs, if any.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    repo: {
                        type: 'string',
                        description: `Repo name (matches \`repos.name\`). ${REPO_DEFAULT_DOC}`,
                    },
                    path: {
                        type: 'string',
                        description: "Starting directory path, repo-relative. Defaults to the repo root ('').",
                    },
                    depth: {
                        type: ['integer', 'null'],
                        description: 'How deep to descend. Defaults to 2 (root + immediate children). Pass null for the full subtree.',
                    },
                    fields: {
                        type: 'array',
                        items: { type: 'string', enum: [...VALID_FIELDS] },
                        description: "Keep only these keys on each tree node and files[] entry, e.g. ['path','purpose']. path always stays, and children and files stay on tree nodes. An unknown name is an error listing the valid ones.",
                    },
                },
                required: ['agent'],
            },
        },
        {
            name: 'scope_suggest',
            description: "Read-only scope draft for a task: given an objective and anchors, the files in scope ranked by score with via (search, anchor, caller:<name>, import:<name>), the tests and covering runners, and draft {files, verification} to edit.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    objective: {
                        type: 'string',
                        description: 'What the task should achieve; seeds the hybrid search. May be empty only when anchors are given.',
                    },
                    anchors: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Symbol qualified_names or repo-relative file paths. A symbol adds its callers (depth 1), importers and tests; one that matches nothing goes to unresolved_anchors.',
                    },
                    repo: { type: 'string', description: REPO_DEFAULT_DOC },
                    k: {
                        type: 'number',
                        description: `Search paths to seed from. Default ${SCOPE_K_DEFAULT}. Max ${SCOPE_K_MAX}.`,
                    },
                },
                required: ['agent'],
            },
        },
        {
            name: 'world_model_search',
            description: "Search dir summaries + file purposes for 'where does X live', cheaper than world_model_get. keyword is FTS5, semantic is embedding cosine. Hits are tagged kind 'dir'|'file'|'symbol'; a hit has stale: true while its file awaits reindex. Without embeddings it falls back to keyword with warning 'semantic_unavailable'. freshness: the index-freshness block. needs_review: flagged concepts and changed READMEs, if any.",
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
                        description: `Repo to search. ${REPO_ALL_DOC}`,
                    },
                    k: {
                        type: 'number',
                        description: 'Top-K rows to return. Default 5. Max 100.',
                    },
                },
                required: ['agent', 'query'],
            },
        },
        {
            name: 'world_model_symbol',
            description: "Card for one indexed symbol: callers, callees, imports, reads_table, writes_table, reads_config, tests and bundled_by (up to 50 refs each, full-count totals). Pass id from world_model_search, qualified_name (+ optional path) or config_key. " +
                "note: by-name resolution, lists may be incomplete. symbol.stale: its file awaits reindex; indexed_commit/target_commit: the card's and the read's commit. impact: levels[] by depth, refs via call or table:<name>, levels[].total, up to 200 refs (truncated). " +
                "index_error: the newest scan's symbol-index error for its repo, if any (lists may lag). freshness: the index-freshness block. needs_review: flagged concepts and changed READMEs, if any.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    id: { type: 'number', description: 'Symbol id from a world_model_search hit.' },
                    repo: {
                        type: 'string',
                        description: `Repo name, used without id. ${REPO_ALL_DOC}`,
                    },
                    path: { type: 'string', description: 'Repo-relative file path, to pick one of several same-named symbols.' },
                    qualified_name: { type: 'string', description: "Name as indexed, e.g. 'persistScan' or 'WorldModelGraph.pruneFiles'." },
                    name: { type: 'string', description: 'Alias of qualified_name; qualified_name wins when both are given.' },
                    config_key: {
                        type: 'string',
                        description: "A plugin_config key, e.g. 'verification_timeout_s'. Returns {config_key, readers: [{qualified_name, kind, repo, path, line}]}: the symbols whose SELECT reads it, instead of a card.",
                    },
                    impact: {
                        type: ['boolean', 'integer'],
                        description: `Transitive inbound callers and readers of tables a walked symbol writes. true walks 2 hops; an integer 1-${IMPACT_MAX_DEPTH} sets the depth. Test callers and test modules importing any walked symbol go to impact.tests and are not walked past.`,
                    },
                    source: {
                        type: 'boolean',
                        description: 'Add source {start_line, end_line, text, truncated}: the body read from disk, capped at 200 lines, text framed as untrusted content.',
                    },
                },
                required: ['agent'],
            },
        },
        {
            name: 'world_model_concepts',
            description: "Search verified concepts (named, ordered flows over symbols) by bm25; each hit has step_count and per-step trust counts. With no match, derived is a chain walked from the top symbol hit over exact calls/sources/runs edges, labelled 'derived, unverified'.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    query: { type: 'string' },
                    repo: { type: 'string', description: REPO_DEFAULT_DOC },
                },
                required: ['agent', 'query'],
            },
        },
        {
            name: 'world_model_concept_get',
            description: 'One concept with its steps in order: description, trust, handoff and the anchored symbol resolved now (null when the anchor is gone; a file anchor is {id: null, kind: \'file\', qualified_name: <path>} with null signature, doc and lines).',
            inputSchema: {
                type: 'object',
                properties: { agent: { type: 'string' }, id: { type: 'number' } },
                required: ['agent', 'id'],
            },
        },
        {
            name: 'world_model_concept_upsert',
            description: "Write a concept, replacing any of the same repo+name. Every step must anchor a current symbol (kind '' anchors the file) and every claim must pass, or nothing is written. Scans then mark drifted steps suspect or broken.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    repo: { type: 'string', description: REPO_DEFAULT_DOC },
                    name: { type: 'string' },
                    kind: { type: 'string', enum: [...CONCEPT_KINDS] },
                    body: { type: 'string' },
                    steps: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                path: { type: 'string' },
                                kind: { type: 'string' },
                                qualified_name: { type: 'string' },
                                description: { type: 'string' },
                                handoff: { type: ['string', 'null'], enum: [...HANDOFFS, null] },
                            },
                            required: ['path', 'description'],
                        },
                    },
                    claims: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { claim: { type: 'string', enum: [...CLAIMS] }, args: CLAIM_ARGS_SCHEMA },
                            required: ['claim', 'args'],
                        },
                    },
                },
                required: ['agent', 'name', 'steps'],
            },
        },
    ];
    const resolveRepo = (arg) => resolveWorldModelRepo(db, arg, cwd);
    const sourceOf = (r) => r.repo_source ? { repo_source: r.repo_source } : {};
    // Fetch each repo's target when its window is due, all at once, then bring
    // each index to its target before answering (GH 2584). A failure answers
    // from the index as it is.
    const freshenAll = async (repos, agent) => {
        const byRepo = new Map();
        const graph = graphHolder?.ensureGraph() ?? null;
        if (!graph)
            return byRepo;
        const named = repos.filter((repo) => repo);
        const fetched = await Promise.all(named.map((repo) => fetchTargetIfDue(db, repo, { agent })));
        for (const [i, repo] of named.entries()) {
            try {
                const trigger = fetched[i] === 'moved' ? 'fetch' : 'read';
                byRepo.set(repo, await ensureFresh(db, graph, repo, { dbPath: db.dbPath, trigger }));
            }
            catch (e) {
                serverLog({ event: 'wm_freshness_error', repo, error: e.message });
            }
        }
        return byRepo;
    };
    const freshen = async (repo, agent) => (await freshenAll([repo], agent)).get(repo) ?? null;
    // The freshness block (decision 2487) every world_model_get, _search and
    // _symbol answer carries, with several repos the first by name, plus the
    // needs_review list of every repo the answer covers (GH 2584). The block is
    // read first, so its needs_review_count includes the READMEs a bro answer
    // delivers and clears.
    const blockOf = (repo, agent) => {
        const repos = repo === null ? [] : typeof repo === 'string' ? [repo] : [...repo].sort();
        const freshness = freshnessBlock(db, repo === null ? null : (repos[0] ?? null));
        return { freshness, ...needsReview(db, repos, agent) };
    };
    const handlers = {
        world_model_get: requireRoles('world_model_get', ['bro', 'swe', 'code-reviewer', 'consultant'], logged(db, 'world_model_get', wrap(async (args) => {
            const parsedFields = parseFields(args['fields']);
            if ('error' in parsedFields)
                return err(parsedFields.error);
            const { fields } = parsedFields;
            const last_scan = lastScan(db);
            const resolved = resolveRepo(args['repo']);
            if (resolved.warning) {
                return ok({ repo: '', root: null, warning: resolved.warning, available_repos: resolved.available_repos, last_scan, ...blockOf(resolved.available_repos, args['agent']) });
            }
            const repo = resolved.name;
            const source = sourceOf(resolved);
            const path = args['path'] ?? '';
            const depthArg = args['depth'];
            const depth = depthArg === null ? null : typeof depthArg === 'number' ? depthArg : 2;
            // Always present per resolved repo (#1059). In the degraded paths below
            // the world-model warning takes precedence; the unmerged_work array
            // still rides along so bro sees in-flight branch work either way.
            const unmerged = computeUnmergedWork(db, repo);
            const lag = checkoutLag(db, repo);
            const graph = graphHolder?.ensureGraph() ?? null;
            if (!graph) {
                return ok({ repo, ...source, root: null, warning: 'world-model-unavailable', unmerged_work: unmerged.unmerged_work, ...lag, last_scan, ...blockOf(repo, args['agent']) });
            }
            const fr = await freshen(repo, args['agent']);
            if (graph.directoryCount(repo) === 0) {
                return ok({ repo, ...source, root: null, warning: 'world-model-empty', unmerged_work: unmerged.unmerged_work, ...lag, last_scan, ...blockOf(repo, args['agent']) });
            }
            const rows = graph.subtree(repo, path, depth);
            const nodeCounter = { count: 0, limit: WORLD_MODEL_GET_MAX_NODES };
            const tree = buildTree(rows, path, depth, { nodeCounter, covers: coveringRunners(db, repo) });
            if (!tree) {
                return ok({ repo, ...source, root: null, warning: 'path-not-found', path, unmerged_work: unmerged.unmerged_work, ...lag, last_scan, ...blockOf(repo, args['agent']) });
            }
            const truncated = nodeCounter.count >= WORLD_MODEL_GET_MAX_NODES;
            if (path !== '') {
                tree.files = graph.filesForDirectory(repo, path).map((f) => {
                    const view = fileView(f);
                    return isStale(fr, view.path) ? { ...view, stale: true } : view;
                });
            }
            return ok({
                repo,
                ...source,
                ...freshnessFields(fr),
                ...staleFlag(fr),
                root: fields ? projectTree(tree, fields) : tree,
                ...(path === '' ? { coverage: graph.fileCoverage(repo) } : {}),
                ...(truncated ? { truncated: true } : {}),
                ...(unmerged.warning ? { warning: unmerged.warning } : {}),
                unmerged_work: unmerged.unmerged_work,
                ...lag,
                last_scan,
                ...blockOf(repo, args['agent']),
            });
        }))),
        scope_suggest: requireRoles('scope_suggest', ['bro', 'consultant'], logged(db, 'scope_suggest', wrap(async (args) => {
            const objectiveArg = args['objective'];
            if (objectiveArg !== undefined && objectiveArg !== null && typeof objectiveArg !== 'string') {
                return err('objective must be a string');
            }
            const objective = (objectiveArg ?? '').trim();
            const anchorsArg = args['anchors'] ?? [];
            if (!Array.isArray(anchorsArg) || anchorsArg.some((a) => typeof a !== 'string')) {
                return err('anchors must be an array of strings');
            }
            const anchors = [...new Set(anchorsArg.map((a) => a.trim()).filter((a) => a !== ''))];
            if (!objective && anchors.length === 0)
                return err('objective is required when no anchors are given');
            const kArg = args['k'];
            const k = typeof kArg === 'number' && Number.isFinite(kArg)
                ? Math.min(Math.max(1, Math.floor(kArg)), SCOPE_K_MAX)
                : SCOPE_K_DEFAULT;
            const empty = { files: [], tests: [], runners: [], unresolved_anchors: [], draft: { files: [], verification: [] } };
            const resolved = resolveRepo(args['repo']);
            if (resolved.warning) {
                return ok({ repo: '', ...empty, warning: resolved.warning, available_repos: resolved.available_repos });
            }
            const repo = resolved.name;
            const source = sourceOf(resolved);
            const lag = checkoutLag(db, repo);
            const graph = graphHolder?.ensureGraph() ?? null;
            if (!graph)
                return ok({ repo, ...source, ...empty, warning: 'world-model-unavailable', ...lag });
            return ok({ repo, ...source, ...(await scopeSuggest(db, graph, repo, objective, anchors, k)), ...lag });
        }))),
        world_model_search: requireRoles('world_model_search', ['bro', 'swe', 'code-reviewer', 'consultant'], logged(db, 'world_model_search', wrap(async (args) => {
            const query = args['query'];
            if (!query || typeof query !== 'string')
                return err('query is required');
            const mode = args['mode'] ?? 'hybrid';
            const k = Math.min(Math.max(1, args['k'] ?? 5), SEARCH_K_MAX);
            const resultsOf = (top, fresh) => {
                const stale = staleFiles(db, top.flatMap(({ hit }) => (hit.kind === 'symbol' ? [hit.node] : [])));
                return top.map(({ hit, score }) => hitResult(hit, score, stale, fresh));
            };
            const resolved = resolveRepo(args['repo']);
            if (resolved.warning) {
                const scope = { repo_source: 'all', repos_searched: resolved.available_repos };
                const graph = graphHolder?.ensureGraph() ?? null;
                if (!graph)
                    return ok({ ...scope, results: [], total_matched: 0, warning: 'world-model-unavailable', mode, ...blockOf(resolved.available_repos, args['agent']) });
                const fresh = await freshenAll(resolved.available_repos, args['agent']);
                const rankings = [];
                for (const repo of resolved.available_repos)
                    rankings.push(await rankWorldModel(db, graph, repo, query, mode, k));
                const top = rankings
                    .flatMap((r) => r.ranked.slice(0, k))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, k);
                const results = resultsOf(top, fresh);
                const warning = rankings.find((r) => r.warning)?.warning;
                const match = rankings.some((r) => r.match === 'any_term') ? 'any_term' : 'all_terms';
                const total_matched = rankings.reduce((n, r) => n + r.ranked.length, 0);
                const truncated = rankings.some((r) => r.poolFull) || results.length < total_matched;
                return ok({
                    ...scope,
                    ...([...fresh.values()].some((f) => staleFlag(f).stale) ? { stale: true } : {}),
                    results,
                    total_matched,
                    ...(truncated ? { truncated } : {}),
                    ...(warning ? { warning } : {}),
                    mode,
                    match,
                    ...blockOf(resolved.available_repos, args['agent']),
                });
            }
            const repo = resolved.name;
            const scope = resolved.repo_source ? { repo, repo_source: resolved.repo_source } : {};
            const lag = checkoutLag(db, repo);
            const graph = graphHolder?.ensureGraph() ?? null;
            if (!graph) {
                return ok({ ...scope, results: [], total_matched: 0, warning: 'world-model-unavailable', mode, ...lag, ...blockOf(repo, args['agent']) });
            }
            const fr = await freshen(repo, args['agent']);
            const { ranked, match, poolFull, warning } = await rankWorldModel(db, graph, repo, query, mode, k);
            const results = resultsOf(ranked.slice(0, k), fr ? new Map([[repo, fr]]) : new Map());
            const total_matched = ranked.length;
            const truncated = poolFull || results.length < total_matched;
            return ok({
                ...scope,
                ...freshnessFields(fr),
                ...staleFlag(fr),
                results,
                total_matched,
                ...(truncated ? { truncated } : {}),
                ...(warning ? { warning } : {}),
                mode,
                match,
                ...lag,
                ...blockOf(repo, args['agent']),
            });
        }))),
        world_model_symbol: requireRoles('world_model_symbol', ['bro', 'swe', 'code-reviewer', 'consultant'], logged(db, 'world_model_symbol', wrap(async (args) => {
            const configKey = args['config_key'];
            if (configKey !== undefined && configKey !== null) {
                if (typeof configKey !== 'string' || !configKey)
                    return err('config_key must be a non-empty string');
                const resolved = resolveRepo(args['repo']);
                const allRepos = resolved.warning !== undefined;
                const repos = allRepos ? resolved.available_repos : [resolved.name];
                return ok({
                    config_key: configKey,
                    readers: configKeyReaders(db, repos, configKey),
                    ...(allRepos ? { repo_source: 'all' } : sourceOf(resolved)),
                    ...blockOf(repos, args['agent']),
                });
            }
            const id = args['id'];
            let symbol = null;
            let source = {};
            let fresh = new Map();
            if (typeof id === 'number') {
                const before = symbolById(db, id);
                if (!before)
                    return err(`symbol ${id} not found`);
                fresh = await freshenAll([before.repo], args['agent']);
                symbol = symbolById(db, id) ?? symbolsByName(db, before.repo, before.qualified_name, before.path)[0] ?? null;
                if (!symbol)
                    return err(`symbol ${id} not found: ${before.qualified_name} left ${before.path} at the target commit`);
            }
            else {
                const qualified = args['qualified_name'];
                const name = typeof qualified === 'string' && qualified ? qualified : args['name'];
                if (typeof name !== 'string' || !name)
                    return err('id, qualified_name or name is required');
                const resolved = resolveRepo(args['repo']);
                const allRepos = resolved.warning !== undefined;
                const repo = resolved.name;
                source = allRepos ? { repo_source: 'all' } : sourceOf(resolved);
                const pathArg = args['path'];
                const path = typeof pathArg === 'string' && pathArg ? pathArg : undefined;
                fresh = await freshenAll(allRepos ? resolved.available_repos : [repo], args['agent']);
                const matches = allRepos
                    ? resolved.available_repos.flatMap((r) => symbolsByName(db, r, name, path))
                    : symbolsByName(db, repo, name, path);
                if (matches.length === 0) {
                    const indexError = allRepos ? undefined : indexErrorOf(lastScan(db), repo).index_error;
                    return err(`symbol ${name} not found in ${allRepos ? 'any repo' : `repo ${repo || '(none)'}`}` +
                        (indexError ? `; the last scan's symbol index failed for this repo: ${indexError}` : ''));
                }
                const definitions = matches.filter((m) => m.kind !== 'module');
                if (definitions.length > 1) {
                    return ok({
                        symbol: null,
                        ...source,
                        warning: 'ambiguous',
                        matches: definitions.map((m) => ({
                            id: m.id,
                            qualified_name: m.qualified_name,
                            kind: m.kind,
                            repo: m.repo,
                            path: m.path,
                            line_start: m.start_line,
                        })),
                        ...(allRepos ? {} : checkoutLag(db, repo)),
                        ...(allRepos ? {} : indexErrorOf(lastScan(db), repo)),
                        ...blockOf(allRepos ? resolved.available_repos : repo, args['agent']),
                    });
                }
                symbol = definitions[0] ?? matches[0];
            }
            const impactArg = args['impact'];
            let impactDepth = null;
            if (impactArg === true)
                impactDepth = DEFAULT_IMPACT_DEPTH;
            else if (typeof impactArg === 'number') {
                if (!Number.isInteger(impactArg) || impactArg < 1 || impactArg > IMPACT_MAX_DEPTH) {
                    return err(`impact must be true or an integer 1-${IMPACT_MAX_DEPTH}`);
                }
                impactDepth = impactArg;
            }
            else if (impactArg !== undefined && impactArg !== false && impactArg !== null) {
                return err(`impact must be true or an integer 1-${IMPACT_MAX_DEPTH}`);
            }
            const card = symbolCard(db, symbol);
            const fr = fresh.get(symbol.repo);
            return ok({
                ...card,
                ...source,
                ...freshnessFields(fr),
                symbol: { ...framedSymbol(card.symbol), stale: card.symbol.stale || isStale(fr, symbol.path) },
                ...(impactDepth !== null ? { impact: symbolImpact(db, symbol, impactDepth) } : {}),
                ...(args['source'] === true ? symbolSource(db, symbol) : {}),
                ...checkoutLag(db, symbol.repo),
                ...indexErrorOf(lastScan(db), symbol.repo),
                ...blockOf(symbol.repo, args['agent']),
            });
        }))),
        world_model_concepts: requireRoles('world_model_concepts', ['bro', 'swe', 'code-reviewer', 'consultant'], logged(db, 'world_model_concepts', wrap(async (args) => {
            const query = args['query'];
            if (typeof query !== 'string' || !query.trim())
                return err('query is required');
            const repo = resolveRepo(args['repo']);
            if (repo.warning)
                return ok({ available: false, concepts: [], derived: null, ...repo });
            const source = sourceOf(repo);
            const available = db.get(`SELECT 1 AS hit FROM wm_files WHERE repo = ? LIMIT 1`, [repo.name]) !== undefined;
            if (!available)
                return ok({ available, ...source, concepts: [], derived: null });
            const concepts = searchConcepts(db, repo.name, query, CONCEPT_LIMIT);
            const graph = concepts.length === 0 ? (graphHolder?.ensureGraph() ?? null) : null;
            const derived = graph
                ? derivedChain(db, repo.name, query, derivedSeeds((await rankWorldModel(db, graph, repo.name, query, 'hybrid', DERIVED_SEED_HITS)).ranked))
                : null;
            return ok({
                available,
                ...source,
                concepts,
                derived: derived ? { label: derived.label, steps: derived.steps.map((st) => framedStep(st, true)) } : null,
            });
        }))),
        world_model_concept_get: requireRoles('world_model_concept_get', ['bro', 'swe', 'code-reviewer', 'consultant'], logged(db, 'world_model_concept_get', wrap(async (args) => {
            const id = args['id'];
            if (typeof id !== 'number')
                return err('id is required');
            const concept = getConcept(db, id);
            if (!concept)
                return err(`concept ${id} not found`);
            return ok({ ...concept, steps: concept.steps.map((st) => framedStep(st, false)) });
        }))),
        world_model_concept_upsert: requireRoles('world_model_concept_upsert', ['bro', 'consultant'], logged(db, 'world_model_concept_upsert', wrap(async (args) => {
            const repo = resolveRepo(args['repo']);
            if (repo.warning)
                return ok({ concept: null, ...repo });
            const input = { ...args, repo: repo.name };
            const repoPath = resolveSoleRepo(db, repo.name)?.path ?? null;
            return ok(upsertConcept(db, input, { repoPath, agent: String(args['agent']) }));
        }))),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=world_model.js.map