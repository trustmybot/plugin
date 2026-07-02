import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { WorldModelGraph } from '../graph-db.js';
import { classifyUrl, type Provider } from '../utils/classify-url.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface ScanFile {
  repo: string;
  path: string;
  content_md5: string;
}

interface ScanRepo {
  name: string;
  path: string;
  file_count: number;
}

interface ScanOutput {
  session_dir: string;
  scanned_at: string;
  repos: ScanRepo[];
  files: ScanFile[];
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

// Locate scripts/scan.sh relative to this compiled module. Plugin layout:
//   <plugin>/mcp/trajectory-server/dist/tools/scan.js
//   <plugin>/scripts/scan.sh
// Walking up four levels lands at the plugin root.
function resolveScanScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', '..', '..', 'scripts', 'scan.sh'),
    join(here, '..', '..', '..', 'scripts', 'scan.sh'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // Fall back to the plugin root via CLAUDE_PLUGIN_ROOT.
  const pluginRoot = process.env['CLAUDE_PLUGIN_ROOT'];
  if (pluginRoot) {
    const c = join(pluginRoot, 'scripts', 'scan.sh');
    if (existsSync(c)) return c;
  }
  throw new Error('scan.sh not found — expected at <plugin>/scripts/scan.sh');
}

export function runScanWithScript(script: string, sessionDir: string, timeoutMs: number): Promise<ScanOutput> {
  return new Promise<ScanOutput>((resolve, reject) => {
    const child = spawn('bash', [script, sessionDir], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    function killGroup(): void {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Process may have already exited — ignore.
      }
    }

    killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      reject(new Error('scan.sh timed out after 10 minutes'));
    }, timeoutMs);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      reject(new Error(`scan.sh spawn error: ${e.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2000);

      if (code !== 0) {
        reject(new Error(`scan.sh failed (exit ${code ?? '?'}): ${stderr || 'unknown error'}`));
        return;
      }

      let parsed: ScanOutput;
      try {
        parsed = JSON.parse(stdout) as ScanOutput;
      } catch {
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

function runScan(sessionDir: string, timeoutMs: number): Promise<ScanOutput> {
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
export function detectStructuralChange(
  db: TrajectoryDB,
  currentRepos: Array<{ name: string }>,
  currentTopDirs: Set<string>,
): boolean {
  const prev = db.get<{ content_json: string }>(
    `SELECT content_json FROM audit
     WHERE event_type = 'deep_scan_completed'
     ORDER BY id DESC
     LIMIT 1`,
  );
  if (!prev?.content_json) return true; // First scan ever — always structural.
  let parsed: { repos_seen?: string[]; top_dirs?: string[] } = {};
  try {
    parsed = JSON.parse(prev.content_json);
  } catch {
    return true;
  }
  const prevRepos = new Set(parsed.repos_seen ?? []);
  const curRepos = new Set(currentRepos.map((r) => r.name));
  if (prevRepos.size !== curRepos.size) return true;
  for (const r of curRepos) if (!prevRepos.has(r)) return true;
  const prevDirs = new Set(parsed.top_dirs ?? []);
  if (prevDirs.size !== currentTopDirs.size) return true;
  for (const d of currentTopDirs) if (!prevDirs.has(d)) return true;
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

interface DirEntry {
  repo: string;
  path: string;
  parent_path: string | null;
  file_count: number;
  file_names: string[];
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function deriveDirectoryEntries(out: ScanOutput): Map<string, DirEntry> {
  const dirMap = new Map<string, DirEntry>();

  function ensureDir(repo: string, dirPath: string): void {
    const key = `${repo} ${dirPath}`;
    if (dirMap.has(key)) return;
    let parent_path: string | null = null;
    if (dirPath !== '') {
      const lastSlash = dirPath.lastIndexOf('/');
      parent_path = lastSlash >= 0 ? dirPath.slice(0, lastSlash) : '';
    }
    dirMap.set(key, { repo, path: dirPath, parent_path, file_count: 0, file_names: [] });
    if (parent_path !== null) ensureDir(repo, parent_path);
  }

  for (const r of out.repos) ensureDir(r.name, '');

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
function buildStructuralSummary(
  dirPath: string,
  fileNames: string[],
  subdirNames: string[],
): string {
  const leaf = dirPath === '' ? '(repo root)' : basename(dirPath);
  const join = (names: string[]): string => {
    const shown = names.slice(0, STRUCTURAL_LIST_MAX).join(', ');
    const extra = names.length - STRUCTURAL_LIST_MAX;
    return extra > 0 ? `${shown}, +${extra} more` : shown;
  };
  const parts: string[] = [];
  if (fileNames.length > 0) {
    parts.push(`${fileNames.length} file${fileNames.length === 1 ? '' : 's'} (${join(fileNames.slice().sort())})`);
  }
  if (subdirNames.length > 0) {
    parts.push(`subdirs: ${join(subdirNames.slice().sort())}`);
  }
  return `${leaf}/ — ${parts.length > 0 ? parts.join('; ') : 'empty directory'}`;
}

function readReadmeSummary(absDirPath: string): string | null {
  for (const candidate of README_CANDIDATES) {
    const readmePath = join(absDirPath, candidate);
    if (!existsSync(readmePath)) continue;
    try {
      const raw = readFileSync(readmePath, 'utf8');
      return raw.length > README_MAX_BYTES ? raw.slice(0, README_MAX_BYTES) : raw;
    } catch {
      // Unreadable — fall through.
    }
  }
  return null;
}

function persistDirectoriesGraph(
  graph: WorldModelGraph,
  out: ScanOutput,
  now: string,
): { dirs_upserted: number; dirs_readme_summarized: number; dirs_structural_summarized: number } {
  const repoPaths = new Map<string, string>();
  for (const r of out.repos) repoPaths.set(r.name, r.path);

  const dirMap = deriveDirectoryEntries(out);
  let dirs_upserted = 0;
  let dirs_readme_summarized = 0;
  let dirs_structural_summarized = 0;

  // Immediate-subdir names per directory, for the structural summary.
  const subdirsByParent = new Map<string, string[]>();
  for (const entry of dirMap.values()) {
    if (entry.parent_path === null) continue;
    const key = `${entry.repo} ${entry.parent_path}`;
    const list = subdirsByParent.get(key);
    if (list) list.push(basename(entry.path));
    else subdirsByParent.set(key, [basename(entry.path)]);
  }

  // Two-pass: first upsert all Directory nodes (so CONTAINS edge targets
  // exist), then create CONTAINS edges from each child to its parent.
  for (const entry of dirMap.values()) {
    const repoPath = repoPaths.get(entry.repo);
    if (!repoPath) continue;

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
    if (readmeSummary !== null) dirs_readme_summarized++;
    else dirs_structural_summarized++;
    dirs_upserted++;
  }

  for (const entry of dirMap.values()) {
    if (entry.parent_path === null) continue;
    graph.upsertContains(
      { repo: entry.repo, path: entry.parent_path },
      { repo: entry.repo, path: entry.path },
    );
  }

  return { dirs_upserted, dirs_readme_summarized, dirs_structural_summarized };
}

interface RepoRemote {
  name: string;
  provider: Provider;
  url: string;
}

// Read a repo's actual git remotes as {name, provider, url}[]. Mirrors
// onboard.ts probeGit: `git -C <path> remote` then `git -C <path> remote
// get-url <name>`. A repo with no remote → []. Any error degrades to [] so
// one unreadable repo never throws the whole scan.
function readRepoRemotes(path: string): RepoRemote[] {
  try {
    const opts = { encoding: 'utf8' as const, timeout: 3000 };
    const listR = spawnSync('git', ['-C', path, 'remote'], opts);
    if (listR.status !== 0) return [];
    const names = (listR.stdout ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const remotes: RepoRemote[] = [];
    for (const name of names) {
      const urlR = spawnSync('git', ['-C', path, 'remote', 'get-url', name], opts);
      if (urlR.status !== 0) continue;
      const url = (urlR.stdout ?? '').trim();
      if (!url) continue;
      remotes.push({ name, provider: classifyUrl(url), url });
    }
    return remotes;
  } catch {
    return [];
  }
}

// Persist repos[] + directories[] from a scan output. Transactional.
// File-level state lives entirely in the directories rows (file_count) and
// the world model. Per-file md5/summary state was retired in schema v7
// (ADR 0001) — leaf-zoom now happens via explicit Read on demand.
// sessionDir is used to scope repo retirement: repos in the DB whose path
// falls under sessionDir but are absent from this scan's result are retired.
function persistScan(
  db: TrajectoryDB,
  graph: WorldModelGraph | null,
  out: ScanOutput,
  sessionDir: string,
): {
  repos_discovered: number;
  repos_upserted: number;
  repos_retired: number;
  dirs_upserted: number;
  dirs_retired: number;
  dirs_readme_summarized: number;
  dirs_structural_summarized: number;
} {
  const now = nowISO();
  const scannedNames = new Set(out.repos.map((r) => r.name));
  const normSession = sessionDir.replace(/\/+$/, '');

  // Find repos in DB that were discovered under sessionDir but are absent now.
  const existing = db.all<{ name: string; path: string }>(
    `SELECT name, path FROM repos`,
  );
  const toRetire = existing.filter((r) => {
    const normPath = r.path.replace(/\/+$/, '');
    const underSession = normPath === normSession || normPath.startsWith(normSession + '/');
    return underSession && !scannedNames.has(r.name);
  });

  let repos_upserted = 0;
  let repos_retired = 0;
  let dirs_retired = 0;
  const retired: Array<{ name: string; path: string }> = [];

  db.transaction(() => {
    for (const r of out.repos) {
      const remotesJson = JSON.stringify(readRepoRemotes(r.path));
      db.run(
        `INSERT INTO repos (name, path, file_count, last_scanned_at, remotes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path = excluded.path,
           file_count = excluded.file_count,
           last_scanned_at = excluded.last_scanned_at,
           remotes = excluded.remotes`,
        [r.name, r.path, r.file_count, now, remotesJson],
      );
      repos_upserted++;
    }
    for (const r of toRetire) {
      try {
        db.run(`DELETE FROM repos WHERE name = ?`, [r.name]);
        repos_retired++;
        retired.push(r);
      } catch {
        // ON DELETE RESTRICT FK: the repo is still referenced (tasks/issues
        // point at it). Keep its row and skip retiring it rather than failing
        // the whole scan. SQLite rolls back only this statement, so the
        // surrounding transaction stays open for the remaining repos.
      }
    }
  });

  // Retire kuzu nodes for repos actually removed above (prune all their dirs).
  if (graph) {
    for (const r of retired) {
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
      const keepKeys = new Set<string>();
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

interface ScanLock {
  pid: number;
  started_at: string;
}

function readLock(lockPath: string): ScanLock | null {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as ScanLock;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockPath: string): boolean {
  const existing = readLock(lockPath);
  if (existing) {
    if (pidAlive(existing.pid)) return false;
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: nowISO() }), { flag: 'wx' });
  return true;
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // already removed — not an error
  }
}

export function scanTools(
  db: TrajectoryDB,
  graph: WorldModelGraph | null,
  dbPath = '',
  graphOpenError: string | null = null,
): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'scan_run',
      description:
        "Run a deterministic project scan: discovers git repos under the session dir, enumerates tracked files (.gitignore-aware), and writes Directory nodes + CONTAINS edges to the kuzu world model. Directory summaries come from README.md (summary_source='readme') or a structural fallback (summary_source='structural'). Emits a deep_scan_completed audit event with source and structural_change fields. Hard timeout: 10 minutes.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          session_dir: {
            type: 'string',
            description:
              'Absolute path to the session directory (workspace root). Defaults to the MCP server\'s CWD.',
          },
          source: {
            type: 'string',
            enum: ['user_manual', 'bro_auto_post_close', 'bro_auto_post_change', 'bro_auto_initial'],
            description:
              'Who fired this scan. user_manual = the user typed /scan; bro_auto_post_close = post-task-close-rescan.sh hook; bro_auto_post_change = bro decided to rescan mid-session; bro_auto_initial = bro hit the registry-cold gate and ran scan as remediation. Defaults to bro_auto_initial.',
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

  const handlers: Record<string, Fn> = {
    scan_run: requireRoles(
      'scan_run',
      ['bro'],
      wrap(async (args) => {
        const sessionDir = (args['session_dir'] as string | undefined) ?? process.cwd();
        const rawSource = (args['source'] as string | undefined) ?? 'bro_auto_initial';
        const source = VALID_SCAN_SOURCES.has(rawSource) ? rawSource : 'bro_auto_initial';

        // #590/#591: when the server lost the cold-start kuzu write-lock race
        // its graph is null for the session because the open hit a lock error.
        // Surface that as graph_db_open_failed — NOT as a scan-lock message — so
        // the operator isn't sent chasing a phantom "scan already running" with a
        // dead pid. A genuinely-absent kuzu (missing native binding, sandbox) has
        // no lock error and falls through to the no-op graph path below.
        if (!graph && graphOpenError) {
          return err(
            `graph_db_open_failed: ${graphOpenError} — world model could not be opened this session (kuzu write-lock contention); restart the session to retry`,
          );
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
          } catch {
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
          const out = await runScan(sessionDir, SCAN_TIMEOUT_MS);
          const stats = persistScan(db, graph, out, sessionDir);

          // #2881: structural-change detection vs previous deep_scan_completed
          // audit. The flag rides in the audit content_json so downstream
          // tooling (the scan-side renderer pass, manual diagnostic queries)
          // can decide whether the scan changed the project shape.
          const topDirs = new Set(out.files.map((f) => f.path.split('/')[0]).filter(Boolean));
          const structuralChange = detectStructuralChange(db, out.repos, topDirs);

          // Emit deep_scan_completed audit row. Attach to the system issue
          // (id=-1) — this is a session-level event, not work-issue scoped.
          db.run(
            `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (-1, NULL, 'bro', 'deep_scan_completed', ?, ?, ?)`,
            [
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
            ],
          );

          return ok({
            session_dir: out.session_dir,
            scanned_at: out.scanned_at,
            repos: out.repos.map((r) => ({ name: r.name, file_count: r.file_count })),
            source,
            structural_change: structuralChange,
            ...stats,
          });
        } finally {
          // Release the lock whether runScan or persistScan threw or not, so a
          // failed scan never wedges future runs behind a stale lock.
          if (lockPath) releaseLock(lockPath);
        }
      }),
    ),

    repos_list: requireRoles(
      'repos_list',
      ['bro', 'swe', 'pr-reviewer'],
      wrap(async () => {
        const rows = db.all<{
          name: string;
          path: string;
          file_count: number;
          last_scanned_at: string;
        }>(`SELECT name, path, file_count, last_scanned_at FROM repos ORDER BY name`);
        return ok({ repos: rows });
      }),
    ),

  };

  return { definitions, handlers };
}
