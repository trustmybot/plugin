import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { WorldModelGraph } from '../graph.js';
import type { DirectoryNode, FileNode, GraphHolder, KeywordMatch, Scored } from '../graph.js';
import { topKByCosine, type WorldModelEmbeddableTable } from '../embeddings/store.js';
import { backfillMissing, startWorldModelBackfill, WORLD_MODEL_TABLES } from '../embeddings/backfill.js';
import { repoRowPath, resolveSoleRepo } from '../utils/repo-paths.js';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolveBaseRef, resolveRepoDefaultBranch } from '../utils/git-refs.js';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { frameUntrusted } from '../utils/untrusted.js';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  fileRefKey,
  IMPACT_MAX_DEPTH,
  isTestPath,
  keywordSearchSymbols,
  staleFiles,
  symbolById,
  symbolCard,
  symbolImpact,
  symbolsByName,
  type ScoredSymbol,
  type SymbolRow,
} from '../symbol-index.js';
import {
  CLAIMS,
  CONCEPT_KINDS,
  DERIVED_SEED_HITS,
  HANDOFFS,
  derivedChain,
  getConcept,
  searchConcepts,
  upsertConcept,
  type ConceptInput,
  type SeedCandidate,
  type Step,
} from '../world-model/concepts.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

type DirRow = DirectoryNode;

const WORLD_MODEL_GET_MAX_NODES = 500;
const RRF_K = 60;
const SEARCH_BACKFILL_LIMIT = 50;
const UNMERGED_WORK_MAX_BRANCHES = 10;
const NET_DIFF_MAX_TARGET_COMMITS = 500;
const PATCH_ID_MAX_BUFFER = 256 * 1024 * 1024;
const SYMBOL_POOL = 40;
const FILE_RANK_POOL = 20;
const PATH_RANK_K = 10;
const DEFAULT_IMPACT_DEPTH = 2;
const SOURCE_MAX_LINES = 200;

interface UnmergedBranch {
  branch_id: string;
  parent_branch_id: string | null;
  tip: string;
  closed_tasks: number;
  merged_into_target: false;
}

type Integration = 'integrated' | 'unmerged' | 'unresolvable' | 'spawn-error';

function git(repoPath: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS });
}

function patchIds(repoPath: string, args: string[]): string[] | null {
  const opts = { encoding: 'utf8' as const, timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: PATCH_ID_MAX_BUFFER };
  const patch = spawnSync('git', ['-C', repoPath, ...args], opts);
  if (patch.error || patch.status !== 0) return null;
  if (!patch.stdout.trim()) return [];
  const ids = spawnSync('git', ['-C', repoPath, 'patch-id', '--stable'], { ...opts, input: patch.stdout });
  if (ids.error || ids.status !== 0) return null;
  return ids.stdout
    .split('\n')
    .map((line) => line.split(' ')[0]?.trim())
    .filter((id): id is string => !!id);
}

function netDiffLandedOn(repoPath: string, tip: string, target: string): boolean {
  const mb = git(repoPath, ['merge-base', target, tip]);
  const base = mb.stdout?.trim();
  if (mb.status !== 0 || !base) return false;
  const branch = patchIds(repoPath, ['diff', '--no-color', '--no-ext-diff', base, tip]);
  if (!branch || branch.length === 0) return false;
  const landed = patchIds(repoPath, [
    'log', '-p', '--no-color', '--no-ext-diff', '--no-merges', '--format=commit %H',
    '-n', String(NET_DIFF_MAX_TARGET_COMMITS), `${base}..${target}`,
  ]);
  return !!landed && landed.includes(branch[0]!);
}

// Twin of clean-merged-branch.sh's _cmb_integrated (GH 1674). A tip counts as
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
export function tipIntegratedInto(repoPath: string, tip: string, target: string): Integration {
  const ancestor = git(repoPath, ['merge-base', '--is-ancestor', tip, target]);
  if (ancestor.error) return 'spawn-error';
  if (ancestor.status === 0) return 'integrated';
  if (ancestor.status !== 1) return 'unresolvable';

  const merged = git(repoPath, ['merge-tree', '--write-tree', target, tip]);
  if (merged.status === 0) {
    const targetTree = git(repoPath, ['rev-parse', `${target}^{tree}`]);
    const mergedTree = merged.stdout.split('\n')[0]?.trim();
    if (targetTree.status === 0 && mergedTree && mergedTree === targetTree.stdout.trim()) return 'integrated';
  }

  const cherry = git(repoPath, ['cherry', target, tip]);
  if (cherry.status === 0 && !/^\+/m.test(cherry.stdout)) return 'integrated';

  if (netDiffLandedOn(repoPath, tip, target)) return 'integrated';
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
function computeUnmergedWork(
  db: TrajectoryDB,
  repo: string,
): { unmerged_work: UnmergedBranch[]; warning?: 'unmerged-work-unavailable' } {
  if (!repo) return { unmerged_work: [] };

  const repoRow = db.get<{ path: string; target_branch: string | null }>(
    `SELECT path, target_branch FROM repos WHERE name = ?`,
    [repo],
  );
  if (!repoRow) return { unmerged_work: [] };

  const repoPath = repoRowPath(db, repoRow.path);
  const targetBranch = repoRow.target_branch || resolveRepoDefaultBranch(repoPath);

  const gitCheck = spawnSync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  if (gitCheck.error || gitCheck.status !== 0) {
    return { unmerged_work: [], warning: 'unmerged-work-unavailable' };
  }

  const target = resolveBaseRef(repoPath, targetBranch);
  if (!target) return { unmerged_work: [] };

  const rows = db.all<{
    branch_id: string;
    parent_branch_id: string | null;
    commit_sha: string;
    status: string;
  }>(
    `SELECT branch_id, parent_branch_id, commit_sha, status
       FROM tasks
      WHERE repo = ? AND commit_sha IS NOT NULL
      ORDER BY updated_at DESC, id DESC`,
    [repo],
  );

  // Group by branch_id; insertion order (newest updated_at first) is preserved,
  // so the newest row per branch carries parent_branch_id. closed_tasks counts
  // the closed commit-bearing tasks on the branch.
  const byBranch = new Map<string, { parent_branch_id: string | null; closed_tasks: number }>();
  for (const r of rows) {
    let entry = byBranch.get(r.branch_id);
    if (!entry) {
      entry = { parent_branch_id: r.parent_branch_id, closed_tasks: 0 };
      byBranch.set(r.branch_id, entry);
    }
    if (r.status === 'closed') entry.closed_tasks++;
  }

  const unmerged_work: UnmergedBranch[] = [];
  for (const [branch_id, entry] of [...byBranch.entries()].slice(0, UNMERGED_WORK_MAX_BRANCHES)) {
    // Require a live local ref: a deleted branch means the work was integrated
    // or abandoned.
    const refCheck = spawnSync(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch_id}`],
      { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS },
    );
    if (refCheck.status !== 0) continue; // absent ref → integrated or abandoned, skip
    const tip = refCheck.stdout.trim();

    // Judge the live ref, not tasks.commit_sha: integrate.sh rebases and
    // regenerates dist, so the pushed tip differs from the recorded one.
    const integration = tipIntegratedInto(repoPath, tip, target);
    if (integration === 'spawn-error') {
      return { unmerged_work: [], warning: 'unmerged-work-unavailable' };
    }
    if (integration !== 'unmerged') continue; // integrated, or an unresolvable tip skipped defensively
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

interface DriftView {
  summary_sha: string | null;
  commits_behind: number | null;
  dead_refs: string[] | null;
  trust: string | null;
}

interface TreeNode extends DriftView {
  path: string;
  summary: string | null;
  summary_source: string;
  summary_updated_at: string | null;
  file_count: number;
  children: TreeNode[];
  files?: FileView[];
}

interface FileView {
  path: string;
  purpose: string;
  purpose_source: string;
  content_md5: string;
}

// How far a README summary can be trusted (GH 1680): 'current', 'drifting(n)'
// when n commits touched the dir since the README did, 'dead_refs(k)' when it
// names k deleted paths (joined with ', '); null when drift is unknown.
export function trustOf(node: Pick<DirectoryNode, 'commits_behind' | 'dead_refs'>): string | null {
  const behind = node.commits_behind ?? null;
  if (behind === null) return null;
  const dead = node.dead_refs?.length ?? 0;
  const parts: string[] = [];
  if (behind > 0) parts.push(`drifting(${behind})`);
  if (dead > 0) parts.push(`dead_refs(${dead})`);
  return parts.length > 0 ? parts.join(', ') : 'current';
}

function driftView(node: DirectoryNode): DriftView {
  return {
    summary_sha: node.summary_sha ?? null,
    commits_behind: node.commits_behind ?? null,
    dead_refs: node.dead_refs ?? null,
    trust: trustOf(node),
  };
}

// File purposes are extracted from file contents, so they leave the server
// framed as untrusted data; the graph keeps them raw.
function framedPurpose(purpose: string): string {
  return purpose ? frameUntrusted('file-purpose', purpose) : '';
}

function fileView(f: FileNode): FileView {
  return {
    path: WorldModelGraph.relativeFilePath(f),
    purpose: framedPurpose(f.purpose),
    purpose_source: f.purpose_source,
    content_md5: f.content_md5,
  };
}

function dirResult(h: Scored<DirectoryNode>): Record<string, unknown> {
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

function fileResult(h: Scored<FileNode>): Record<string, unknown> {
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
function framedSymbol(s: SymbolRow): SymbolRow {
  return {
    ...s,
    signature: s.signature ? frameUntrusted('symbol-signature', s.signature) : '',
    doc: s.doc ? frameUntrusted('symbol-doc', s.doc) : '',
  };
}

interface SymbolSource {
  start_line: number;
  end_line: number;
  text: string;
  truncated: boolean;
}

// The symbol's lines read from the repo root on disk, framed as untrusted
// content, refusing a path that resolves (through .. or a symlink) outside
// that root.
function symbolSource(db: TrajectoryDB, symbol: SymbolRow): { source: SymbolSource | null; source_reason?: string } {
  const rootArg = resolveSoleRepo(db, symbol.repo)?.path;
  if (!rootArg) return { source: null, source_reason: 'repo-path-unknown' };
  let root: string;
  let file: string;
  try {
    root = realpathSync(rootArg);
    file = realpathSync(join(root, symbol.path));
  } catch {
    return { source: null, source_reason: 'file-missing' };
  }
  const rel = relative(root, file);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { source: null, source_reason: 'outside-repo-root' };
  let lines: string[];
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    return { source: null, source_reason: 'file-unreadable' };
  }
  const start = Math.max(1, symbol.start_line);
  if (start > lines.length) return { source: null, source_reason: 'range-past-eof' };
  const end = Math.min(symbol.end_line, lines.length);
  const truncated = end - start + 1 > SOURCE_MAX_LINES;
  const last = truncated ? start + SOURCE_MAX_LINES - 1 : end;
  const text = frameUntrusted('symbol-source', lines.slice(start - 1, last).join('\n'));
  return { source: { start_line: start, end_line: last, text, truncated } };
}

function symbolResult(symbol: SymbolRow, score: number, stale: boolean): Record<string, unknown> {
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

export type SearchHit =
  | { kind: 'dir'; key: string; node: DirectoryNode }
  | { kind: 'file'; key: string; node: FileNode }
  | { kind: 'symbol'; key: string; node: SymbolRow };

function dirHit(node: DirectoryNode): SearchHit {
  return { kind: 'dir', key: `dir:${node.key}`, node };
}

function fileHit(node: FileNode): SearchHit {
  return { kind: 'file', key: `file:${node.path}`, node };
}

function symbolHit(node: SymbolRow): SearchHit {
  return { kind: 'symbol', key: `symbol:${node.id}`, node };
}

function hitResult(hit: SearchHit, score: number, stale: Set<string>): Record<string, unknown> {
  if (hit.kind === 'dir') return dirResult({ ...hit.node, score });
  if (hit.kind === 'file') return fileResult({ ...hit.node, score });
  return symbolResult(hit.node, score, stale.has(fileRefKey(hit.node)));
}

function isBuildOutput(path: string): boolean {
  return /(^|\/)dist\//.test(path) || path.endsWith('.map');
}

function pathWeight(path: string): number {
  return isTestPath(path) || /(^|\/)changelog\.d\//.test(path) ? 0.5 : 1;
}

// Keyword ranking across dirs, files and symbols. A repo-relative path scores
// w/(K + rank) once for the rank of its first symbol hit and once for its
// file-hit rank, so a file matched both ways rises; tests and changelog
// fragments count half. The path's first hit takes the path score, each later
// hit of the same path a falling share of it. Dirs score by their own rank.
function rankKeyword(
  dirs: DirectoryNode[],
  files: FileNode[],
  symbols: ScoredSymbol[],
): Array<{ hit: SearchHit; score: number }> {
  const pathScore = new Map<string, number>();
  const bump = (path: string, rank: number) =>
    pathScore.set(path, (pathScore.get(path) ?? 0) + pathWeight(path) / (PATH_RANK_K + rank));
  const symbolRank = new Map<string, number>();
  for (const s of symbols) if (!symbolRank.has(s.path)) symbolRank.set(s.path, symbolRank.size);
  for (const [path, rank] of symbolRank) bump(path, rank);
  files.forEach((f, rank) => bump(WorldModelGraph.relativeFilePath(f), rank));

  const seen = new Map<string, number>();
  const share = (path: string) => {
    const n = seen.get(path) ?? 0;
    seen.set(path, n + 1);
    return (pathScore.get(path) ?? 0) / (n + 1);
  };
  const ranked: Array<{ hit: SearchHit; score: number; order: number }> = [];
  dirs.forEach((d, rank) => ranked.push({ hit: dirHit(d), score: 1 / (PATH_RANK_K + rank), order: ranked.length }));
  const firsts = [...pathScore.keys()].sort((a, b) => pathScore.get(b)! - pathScore.get(a)!);
  const symbolsByPath = new Map<string, ScoredSymbol[]>();
  for (const s of symbols) symbolsByPath.set(s.path, [...(symbolsByPath.get(s.path) ?? []), s]);
  const fileByPath = new Map(files.map((f) => [WorldModelGraph.relativeFilePath(f), f]));
  for (const path of firsts) {
    for (const s of symbolsByPath.get(path) ?? []) ranked.push({ hit: symbolHit(s), score: share(path), order: ranked.length });
    const file = fileByPath.get(path);
    if (file) ranked.push({ hit: fileHit(file), score: share(path), order: ranked.length });
  }
  return ranked.sort((a, b) => b.score - a.score || a.order - b.order).map(({ hit, score }) => ({ hit, score }));
}

// Embed the rows a search would miss: a bounded batch inline so a fresh scan
// is searchable at once, the rest in the background.
async function backfillWorldModel(db: TrajectoryDB): Promise<void> {
  let saturated = false;
  for (const table of WORLD_MODEL_TABLES) {
    if ((await backfillMissing(db, table, SEARCH_BACKFILL_LIMIT)) >= SEARCH_BACKFILL_LIMIT) saturated = true;
  }
  if (saturated) startWorldModelBackfill(db);
}

async function cosineHits(
  db: TrajectoryDB,
  graph: WorldModelGraph,
  repo: string,
  query: string,
  k: number,
): Promise<Array<{ hit: SearchHit; score: number }>> {
  const search = (table: WorldModelEmbeddableTable) => topKByCosine(db, table, query, k, [repo]);
  const [dirs, files] = [await search('wm_directories'), await search('wm_files')];
  const dirNodes = graph.directoriesByIds(dirs.map((d) => d.rowid));
  const fileNodes = graph.filesByIds(files.map((f) => f.rowid));
  const hits: Array<{ hit: SearchHit; score: number }> = [];
  for (const d of dirs) {
    const node = dirNodes.get(d.rowid);
    if (node) hits.push({ hit: dirHit(node), score: d.score });
  }
  for (const f of files) {
    const node = fileNodes.get(f.rowid);
    if (node) hits.push({ hit: fileHit(node), score: f.score });
  }
  return hits.sort((a, b) => b.score - a.score);
}

// Reciprocal rank fusion: each ranked list adds 1/(RRF_K + rank + 1) to a hit.
function fuse(lists: Array<SearchHit[]>): Array<{ hit: SearchHit; score: number }> {
  const fused = new Map<string, { hit: SearchHit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const rrf = 1 / (RRF_K + rank + 1);
      const entry = fused.get(hit.key);
      if (entry) entry.score += rrf;
      else fused.set(hit.key, { hit, score: rrf });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

export interface WorldModelRanking {
  ranked: Array<{ hit: SearchHit; score: number }>;
  match: KeywordMatch;
  warning?: 'semantic_unavailable';
}

// The one world-model ranking, shared by world_model_search and the derived
// concept chain: keyword pools over dirs, files and symbols; in semantic or
// hybrid mode cosine hits too, fused by RRF in hybrid; keyword ranking alone
// when no embedding answers.
export async function rankWorldModel(
  db: TrajectoryDB,
  graph: WorldModelGraph,
  repo: string,
  query: string,
  mode: string,
  k: number,
): Promise<WorldModelRanking> {
  const pool = mode === 'keyword' ? k : k * 4;
  const dirSearch = graph.keywordSearchDirectories(repo, query, pool);
  const fileSearch = graph.keywordSearchFiles(repo, query, Math.max(pool, FILE_RANK_POOL));
  const symbolSearch = keywordSearchSymbols(db, repo, query, SYMBOL_POOL);
  const match: KeywordMatch = [dirSearch, fileSearch, symbolSearch].some((r) => r.match === 'any_term')
    ? 'any_term'
    : 'all_terms';
  const files = fileSearch.hits.filter((f) => !isBuildOutput(WorldModelGraph.relativeFilePath(f)));
  const keywordRanked = rankKeyword(dirSearch.hits, files, symbolSearch.hits);
  const hitsOf = (ranked: Array<{ hit: SearchHit }>): SearchHit[] => ranked.map(({ hit }) => hit);

  if (mode === 'keyword') return { ranked: keywordRanked, match };

  await backfillWorldModel(db);
  const semantic = await cosineHits(db, graph, repo, query, pool);
  if (semantic.length === 0) return { ranked: keywordRanked, match, warning: 'semantic_unavailable' };
  if (mode === 'semantic') return { ranked: semantic, match };

  return {
    ranked: fuse([
      dirSearch.hits.map(dirHit),
      hitsOf(keywordRanked.filter(({ hit }) => hit.kind !== 'dir')),
      hitsOf(semantic.filter(({ hit }) => hit.kind === 'dir')),
      hitsOf(semantic.filter(({ hit }) => hit.kind === 'file')),
    ]),
    match,
  };
}

function derivedSeeds(ranked: Array<{ hit: SearchHit }>): SeedCandidate[] {
  return ranked
    .flatMap(({ hit }): SeedCandidate[] => {
      if (hit.kind === 'symbol') return [{ kind: 'symbol', id: hit.node.id }];
      if (hit.kind === 'file') return [{ kind: 'file', path: WorldModelGraph.relativeFilePath(hit.node) }];
      return [];
    })
    .slice(0, DERIVED_SEED_HITS);
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function wrap(fn: Fn): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

// Build the tree by indexing rows by parent_path, then descending from the
// requested root. Sorting children alphabetically gives stable output.
// depthForSummary is the root's logical depth (0 = root itself). Summaries
// at depth > 1 are truncated to the first line to keep the payload compact.
export function buildTree(
  rows: DirRow[],
  rootPath: string,
  depth: number | null,
  opts?: { nodeCounter?: { count: number; limit: number }; depthOffset?: number },
): TreeNode | null {
  const byParent = new Map<string, DirRow[]>();
  for (const r of rows) {
    const key = r.parent_path ?? '__ROOT__';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(r);
  }

  const root = rows.find((r) => r.path === rootPath);
  if (!root) return null;

  // Top-level dirs carry parent_path '' (the repo root's own path), so they're
  // filed under '' alongside the root node itself. descend must exclude the
  // node from its own child list, and a visited set guards against any cycle in
  // the stored graph so traversal can't recurse forever. (#269, #272)
  const visited = new Set<string>();
  const counter = opts?.nodeCounter;
  const depthOffset = opts?.depthOffset ?? 0;

  function descend(node: DirRow, remainingDepth: number | null, currentDepth: number): TreeNode {
    visited.add(node.path);
    if (counter) counter.count++;
    const children: TreeNode[] = [];
    if (remainingDepth === null || remainingDepth > 0) {
      const kids = (byParent.get(node.path) ?? []).filter(
        (k) => k.path !== node.path && !visited.has(k.path),
      );
      kids.sort((a, b) => a.path.localeCompare(b.path));
      for (const k of kids) {
        if (counter && counter.count >= counter.limit) break;
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

const CONCEPT_LIMIT = 10;

// A step's symbol text is copied out of file contents, and a derived step's
// description is that text, so both leave the server framed.
function framedStep(step: Step, derived: boolean): Step {
  const symbol =
    step.symbol && step.symbol.id !== null
      ? {
          ...step.symbol,
          signature: step.symbol.signature ? frameUntrusted('symbol-signature', step.symbol.signature) : '',
          doc: step.symbol.doc ? frameUntrusted('symbol-doc', step.symbol.doc) : '',
        }
      : step.symbol;
  const description = derived && step.description ? frameUntrusted('symbol-doc', step.description) : step.description;
  return { ...step, description, symbol };
}

export function worldModelTools(db: TrajectoryDB, graphHolder: GraphHolder | null): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'world_model_get',
      description:
        "Return the world model as an annotated directory tree. Each node carries a README-sourced summary (summary_source='readme') or structural fallback; README nodes add trust ('current', 'drifting(n)', 'dead_refs(k)'), summary_sha, commits_behind and dead_refs. Depth-1+ summaries are truncated to the first line. Returns truncated:true when the tree exceeds 500 nodes. A non-root path adds files[] (purposes); the root adds coverage. Also returns unmerged_work: closed-task branch tips not yet merged into the repo's target branch. Primary navigation surface for code-touching cold starts.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          repo: {
            type: 'string',
            description:
              'Repo name (matches `repos.name`). Defaults to the sole registered repo when exactly one exists; required in multi-repo projects.',
          },
          path: {
            type: 'string',
            description:
              "Starting directory path, repo-relative. Defaults to the repo root ('').",
          },
          depth: {
            type: ['integer', 'null'],
            description:
              'How deep to descend. Defaults to 2 (root + immediate children). Pass null for the full subtree.',
          },
        },
        required: ['agent'],
      },
    },
    {
      name: 'world_model_search',
      description:
        "Search dir summaries + file purposes. keyword: FTS5; semantic: embedding cosine; hybrid (default): both fused by RRF. Returns top-K hits tagged kind 'dir'|'file'|'symbol'; a symbol hit carries stale: true when its file changed on disk since the last scan. Without embeddings, falls back to keyword with warning: 'semantic_unavailable'. Use for 'where does X live' — cheaper than world_model_get.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          query: {
            type: 'string',
            description:
              'Search query. Keyword terms match whole words in paths, summaries and purposes (all terms must match; when none do, any non-stopword term, reported as match: any_term), plus path/text substrings; semantic matches natural language.',
          },
          mode: {
            type: 'string',
            enum: ['keyword', 'semantic', 'hybrid'],
            description: 'Search mode. Default: hybrid (RRF combines FTS5 + cosine).',
          },
          repo: {
            type: 'string',
            description:
              'Optional — restrict to one repo. Defaults to the sole registered repo when exactly one exists; unrestricted in multi-repo projects.',
          },
          k: {
            type: 'number',
            description: 'Top-K rows to return. Default 5. Max 20.',
          },
        },
        required: ['agent', 'query'],
      },
    },
    {
      name: 'world_model_symbol',
      description:
        "Card for one indexed symbol: callers, callees, imports, reads_table, writes_table and tests (up to 50 refs each). Pass id from a world_model_search hit, or qualified_name plus optional path. note flags by-name resolution, so lists may be incomplete. symbol.stale is true when the file on disk no longer matches the index (rescan to refresh). impact adds transitive callers by depth (levels[].refs) plus the tests reached, up to 200 refs (truncated). source: true adds the body read from disk, up to 200 lines.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          id: { type: 'number', description: 'Symbol id from a world_model_search hit.' },
          repo: {
            type: 'string',
            description: 'Repo name. Defaults to the sole registered repo; required in multi-repo projects without id.',
          },
          path: { type: 'string', description: 'Repo-relative file path, to pick one of several same-named symbols.' },
          qualified_name: { type: 'string', description: "Name as indexed, e.g. 'persistScan' or 'WorldModelGraph.pruneFiles'." },
          impact: {
            type: ['boolean', 'integer'],
            description: `Transitive inbound callers. true walks 2 hops; an integer 1-${IMPACT_MAX_DEPTH} sets the depth. Test callers go to impact.tests and are not walked past.`,
          },
          source: {
            type: 'boolean',
            description:
              'Add source {start_line, end_line, text, truncated}: the body read from disk, capped at 200 lines, text framed as untrusted content.',
          },
        },
        required: ['agent'],
      },
    },
    {
      name: 'world_model_concepts',
      description:
        "Search verified concepts (named, ordered flows over symbols) by bm25. Each hit has step_count and per-step trust counts. With no match, derived is a chain walked from the top symbol hit over exact calls/sources/runs edges, labelled 'derived, unverified'.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          query: { type: 'string' },
          repo: { type: 'string', description: 'Defaults to the sole registered repo.' },
        },
        required: ['agent', 'query'],
      },
    },
    {
      name: 'world_model_concept_get',
      description:
        'One concept with its steps in order: description, trust, handoff and the anchored symbol resolved now (null when the anchor is gone; a file anchor is {id: null, kind: \'file\', qualified_name: <path>} with null signature, doc and lines).',
      inputSchema: {
        type: 'object',
        properties: { agent: { type: 'string' }, id: { type: 'number' } },
        required: ['agent', 'id'],
      },
    },
    {
      name: 'world_model_concept_upsert',
      description:
        "Write a concept, replacing any of the same repo+name. Every step must anchor a current symbol (kind '' anchors the file) and every claim must pass, or nothing is written. Scans then mark drifted steps suspect or broken.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          repo: { type: 'string' },
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
              properties: { claim: { type: 'string', enum: [...CLAIMS] }, args: { type: 'object' } },
              required: ['claim', 'args'],
            },
          },
        },
        required: ['agent', 'name', 'steps'],
      },
    },
  ];

  const conceptRepo = (arg: unknown): { name: string; warning?: 'repo-unspecified'; available_repos?: string[] } => {
    if (typeof arg === 'string' && arg) return { name: arg };
    const available = db.all<{ name: string }>(`SELECT name FROM repos ORDER BY name`).map((r) => r.name);
    if (available.length >= 2) return { name: '', warning: 'repo-unspecified', available_repos: available };
    return { name: resolveSoleRepo(db)?.name ?? '' };
  };

  const handlers: Record<string, Fn> = {
    world_model_get: requireRoles(
      'world_model_get',
      ['bro', 'swe', 'pr-reviewer', 'consultant'],
      wrap(async (args) => {
        let repo = (args['repo'] as string | undefined) ?? '';
        if (!repo) {
          const available = db.all<{ name: string }>(`SELECT name FROM repos ORDER BY name`).map((r) => r.name);
          if (available.length >= 2) {
            // Multi-repo with no selector: don't silently target one repo.
            // Name the available repos so the caller can pass one.
            return ok({ repo: '', root: null, warning: 'repo-unspecified', available_repos: available });
          }
          // 0 repos → fall through with repo='' to the empty/unavailable paths.
          // Exactly 1 → resolve the sole repo.
          repo = resolveSoleRepo(db)?.name ?? '';
        }

        const path = (args['path'] as string | undefined) ?? '';
        const depthArg = args['depth'];
        const depth: number | null =
          depthArg === null ? null : typeof depthArg === 'number' ? depthArg : 2;

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

        const rows: DirRow[] = graph.subtree(repo, path, depth);
        const nodeCounter = { count: 0, limit: WORLD_MODEL_GET_MAX_NODES };
        const tree = buildTree(rows, path, depth, { nodeCounter });
        if (!tree) {
          return ok({ repo, root: null, warning: 'path-not-found', path, unmerged_work: unmerged.unmerged_work });
        }

        const truncated = nodeCounter.count >= WORLD_MODEL_GET_MAX_NODES;
        if (path !== '') tree.files = graph.filesForDirectory(repo, path).map(fileView);
        return ok({
          repo,
          root: tree,
          ...(path === '' ? { coverage: graph.fileCoverage(repo) } : {}),
          ...(truncated ? { truncated: true } : {}),
          ...(unmerged.warning ? { warning: unmerged.warning } : {}),
          unmerged_work: unmerged.unmerged_work,
        });
      }),
    ),

    world_model_search: requireRoles(
      'world_model_search',
      ['bro', 'swe', 'pr-reviewer', 'consultant'],
      wrap(async (args) => {
        const query = args['query'] as string;
        if (!query || typeof query !== 'string') return err('query is required');
        const mode = (args['mode'] as string | undefined) ?? 'hybrid';
        const k = Math.min(Math.max(1, (args['k'] as number | undefined) ?? 5), 20);

        let repo = (args['repo'] as string | undefined) ?? '';
        if (!repo) {
          const available = db.all<{ name: string }>(`SELECT name FROM repos ORDER BY name`).map((r) => r.name);
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

        const { ranked, match, warning } = await rankWorldModel(db, graph, repo, query, mode, k);
        const top = ranked.slice(0, k);
        const stale = staleFiles(
          db,
          top.flatMap(({ hit }) => (hit.kind === 'symbol' ? [hit.node] : [])),
        );
        const results = top.map(({ hit, score }) => hitResult(hit, score, stale));
        return ok({ results, total_matched: results.length, ...(warning ? { warning } : {}), mode, match });
      }),
    ),

    world_model_symbol: requireRoles(
      'world_model_symbol',
      ['bro', 'swe', 'pr-reviewer', 'consultant'],
      wrap(async (args) => {
        const id = args['id'];
        let symbol: SymbolRow | null = null;
        if (typeof id === 'number') {
          symbol = symbolById(db, id);
          if (!symbol) return err(`symbol ${id} not found`);
        } else {
          const name = args['qualified_name'];
          if (typeof name !== 'string' || !name) return err('id or qualified_name is required');
          let repo = (args['repo'] as string | undefined) ?? '';
          if (!repo) {
            const available = db.all<{ name: string }>(`SELECT name FROM repos ORDER BY name`).map((r) => r.name);
            if (available.length >= 2) return ok({ symbol: null, warning: 'repo-unspecified', available_repos: available });
            repo = resolveSoleRepo(db)?.name ?? '';
          }
          const path = args['path'];
          const matches = symbolsByName(db, repo, name, typeof path === 'string' && path ? path : undefined);
          if (matches.length === 0) return err(`symbol ${name} not found in repo ${repo || '(none)'}`);
          const definitions = matches.filter((m) => m.kind !== 'module');
          if (definitions.length > 1) {
            return ok({
              symbol: null,
              warning: 'ambiguous',
              matches: definitions.map((m) => ({
                id: m.id,
                qualified_name: m.qualified_name,
                kind: m.kind,
                repo: m.repo,
                path: m.path,
                line_start: m.start_line,
              })),
            });
          }
          symbol = matches[0]!;
        }
        const impactArg = args['impact'];
        let impactDepth: number | null = null;
        if (impactArg === true) impactDepth = DEFAULT_IMPACT_DEPTH;
        else if (typeof impactArg === 'number') {
          if (!Number.isInteger(impactArg) || impactArg < 1 || impactArg > IMPACT_MAX_DEPTH) {
            return err(`impact must be true or an integer 1-${IMPACT_MAX_DEPTH}`);
          }
          impactDepth = impactArg;
        } else if (impactArg !== undefined && impactArg !== false && impactArg !== null) {
          return err(`impact must be true or an integer 1-${IMPACT_MAX_DEPTH}`);
        }
        const card = symbolCard(db, symbol);
        return ok({
          ...card,
          symbol: { ...framedSymbol(card.symbol), stale: card.symbol.stale },
          ...(impactDepth !== null ? { impact: symbolImpact(db, symbol, impactDepth) } : {}),
          ...(args['source'] === true ? symbolSource(db, symbol) : {}),
        });
      }),
    ),

    world_model_concepts: requireRoles(
      'world_model_concepts',
      ['bro', 'swe', 'pr-reviewer', 'consultant'],
      wrap(async (args) => {
        const query = args['query'];
        if (typeof query !== 'string' || !query.trim()) return err('query is required');
        const repo = conceptRepo(args['repo']);
        if (repo.warning) return ok({ available: false, concepts: [], derived: null, ...repo });
        const available = db.get(`SELECT 1 AS hit FROM wm_files WHERE repo = ? LIMIT 1`, [repo.name]) !== undefined;
        if (!available) return ok({ available, concepts: [], derived: null });
        const concepts = searchConcepts(db, repo.name, query, CONCEPT_LIMIT);
        const graph = concepts.length === 0 ? (graphHolder?.ensureGraph() ?? null) : null;
        const derived = graph
          ? derivedChain(db, repo.name, query, derivedSeeds((await rankWorldModel(db, graph, repo.name, query, 'hybrid', DERIVED_SEED_HITS)).ranked))
          : null;
        return ok({
          available,
          concepts,
          derived: derived ? { label: derived.label, steps: derived.steps.map((st) => framedStep(st, true)) } : null,
        });
      }),
    ),

    world_model_concept_get: requireRoles(
      'world_model_concept_get',
      ['bro', 'swe', 'pr-reviewer', 'consultant'],
      wrap(async (args) => {
        const id = args['id'];
        if (typeof id !== 'number') return err('id is required');
        const concept = getConcept(db, id);
        if (!concept) return err(`concept ${id} not found`);
        return ok({ ...concept, steps: concept.steps.map((st) => framedStep(st, false)) });
      }),
    ),

    world_model_concept_upsert: requireRoles(
      'world_model_concept_upsert',
      ['bro', 'consultant'],
      wrap(async (args) => {
        const repo = conceptRepo(args['repo']);
        if (repo.warning) return ok({ concept: null, ...repo });
        const input = { ...args, repo: repo.name } as unknown as ConceptInput;
        const repoPath = resolveSoleRepo(db, repo.name)?.path ?? null;
        return ok(upsertConcept(db, input, { repoPath, agent: String(args['agent']) }));
      }),
    ),
  };

  return { definitions, handlers };
}
