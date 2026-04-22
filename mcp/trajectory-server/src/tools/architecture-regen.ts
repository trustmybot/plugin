import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, isAbsolute, normalize } from 'node:path';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { renderCodebaseTree } from '../renderers/codebase-tree.js';
import { renderErd } from '../renderers/erd.js';
import { renderModuleGraph } from '../renderers/module-graph.js';
import { renderChangelog, type CommitEntry } from '../renderers/changelog.js';
import type { FileRegistryRow as RendererFileRegistryRow } from '../renderers/types.js';
import type { FileRegistryRow as RawFileRegistryRow } from '../types.js';
import {
  getHeadSha,
  listAllFiles,
  getDeltaSince,
  isBinaryFile,
  classifyFile,
  detectLanguage,
  getFileCommitInfo,
  getFileSize,
  readFileText,
  getGitLogEntries,
} from '../regen/git-walker.js';
import { parseImports } from '../regen/ts-import-parser.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const VALID_SCOPES = new Set(['full', 'incremental']);
const VALID_TARGETS = new Set(['codebase_tree', 'erd', 'module_graph', 'changelog']);
const ALL_TARGETS = ['codebase_tree', 'erd', 'module_graph', 'changelog'] as const;
type TargetName = (typeof ALL_TARGETS)[number];

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function validateArchitectureDir(raw: string, cwd: string): { resolved: string } | { error: string } {
  if (isAbsolute(raw)) {
    const cwdResolved = resolve(cwd);
    const dirResolved = resolve(raw);
    if (!dirResolved.startsWith(cwdResolved + '/') && dirResolved !== cwdResolved) {
      return { error: `architecture_dir must be inside the working directory: ${raw}` };
    }
    if (dirResolved.includes('/manual/') || dirResolved.endsWith('/manual')) {
      return { error: 'architecture_dir must not point to the manual/ directory' };
    }
    return { resolved: dirResolved };
  }

  const normalised = normalize(raw);
  if (normalised.startsWith('..') || normalised.includes('/../')) {
    return { error: `architecture_dir must not contain ".." path-traversal: ${raw}` };
  }
  if (
    normalised === 'manual' ||
    normalised.startsWith('manual/') ||
    normalised.includes('/manual/') ||
    normalised.endsWith('/manual')
  ) {
    return { error: 'architecture_dir must not point to the manual/ directory' };
  }

  const resolved = resolve(cwd, normalised);
  const cwdResolved = resolve(cwd);
  if (!resolved.startsWith(cwdResolved + '/') && resolved !== cwdResolved) {
    return { error: `architecture_dir resolves outside CWD: ${raw}` };
  }

  return { resolved };
}

function getRegenStateRow(
  db: TrajectoryDB,
  target: string,
): { last_regen_at: string | null; last_seen_sha: string | null } | null {
  return (
    db.get<{ last_regen_at: string | null; last_seen_sha: string | null }>(
      `SELECT last_regen_at, last_seen_sha FROM regen_state WHERE target = ?`,
      [target],
    ) ?? null
  );
}

function setRegenState(db: TrajectoryDB, target: string, sha: string): void {
  const now = nowISO();
  db.run(
    `INSERT INTO regen_state (target, last_regen_at, last_seen_sha, notes)
     VALUES (?, ?, ?, '')
     ON CONFLICT(target) DO UPDATE SET
       last_regen_at = excluded.last_regen_at,
       last_seen_sha = excluded.last_seen_sha`,
    [target, now, sha],
  );
}

async function upsertFile(
  db: TrajectoryDB,
  filePath: string,
  cwd: string,
  sha: string,
  changeType: 'added' | 'modified' | 'renamed',
): Promise<void> {
  const type = classifyFile(filePath);
  const language = detectLanguage(filePath);
  const size = await getFileSize(filePath, cwd);
  const commitInfo = await getFileCommitInfo(filePath, { cwd });

  let imports: string[] = [];
  const tsLangs = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);
  if (language && tsLangs.has(language)) {
    const source = await readFileText(filePath, cwd);
    if (source !== null) {
      imports = parseImports(source);
    }
  }

  db.run(
    `INSERT OR REPLACE INTO file_registry
       (path, type, language, size_bytes, last_commit_sha, last_change_type, last_change_at, imports_json, exports_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}')`,
    [
      filePath,
      type,
      language,
      size,
      commitInfo?.sha ?? sha,
      changeType,
      commitInfo?.date ?? nowISO(),
      JSON.stringify(imports),
    ],
  );
}

async function refreshFileRegistryFull(
  db: TrajectoryDB,
  cwd: string,
  headSha: string,
): Promise<{ upserted: number; deleted: number }> {
  const allFiles = await listAllFiles({ cwd });
  const currentPaths = new Set(allFiles);

  let deleted = 0;
  const existingRows = db.all<{ path: string }>(`SELECT path FROM file_registry`);
  for (const row of existingRows) {
    if (!currentPaths.has(row.path)) {
      db.run(`DELETE FROM file_registry WHERE path = ?`, [row.path]);
      deleted++;
    }
  }

  let upserted = 0;
  for (const filePath of allFiles) {
    const binary = await isBinaryFile(filePath, cwd);
    if (binary) continue;
    await upsertFile(db, filePath, cwd, headSha, 'modified');
    upserted++;
  }

  return { upserted, deleted };
}

async function refreshFileRegistryIncremental(
  db: TrajectoryDB,
  cwd: string,
  headSha: string,
): Promise<{ upserted: number; deleted: number }> {
  const stateRow = getRegenStateRow(db, 'file_registry');
  const sinceSha = stateRow?.last_seen_sha ?? null;
  const sinceDate = stateRow?.last_regen_at ?? null;

  const delta = await getDeltaSince({ cwd }, sinceSha || null, sinceDate);

  let upserted = 0;
  let deleted = 0;

  for (const entry of delta) {
    if (entry.status === 'D') {
      const result = db.run(`DELETE FROM file_registry WHERE path = ?`, [entry.path]);
      if (result.changes > 0) deleted++;
    } else if (entry.status === 'R' && entry.newPath) {
      db.run(`DELETE FROM file_registry WHERE path = ?`, [entry.path]);
      const binary = await isBinaryFile(entry.newPath, cwd);
      if (!binary) {
        await upsertFile(db, entry.newPath, cwd, headSha, 'renamed');
        upserted++;
      }
    } else {
      const ct = entry.status === 'A' ? 'added' : 'modified';
      const binary = await isBinaryFile(entry.path, cwd);
      if (!binary) {
        await upsertFile(db, entry.path, cwd, headSha, ct);
        upserted++;
      }
    }
  }

  return { upserted, deleted };
}

function toRendererRows(raw: RawFileRegistryRow[]): RendererFileRegistryRow[] {
  return raw.map(r => ({
    path: r.path,
    type: r.type as RendererFileRegistryRow['type'],
    language: r.language,
    size_bytes: r.size_bytes,
    last_commit_sha: r.last_commit_sha,
    last_change_type: r.last_change_type as RendererFileRegistryRow['last_change_type'],
    last_change_at: r.last_change_at,
    imports: JSON.parse(r.imports_json) as string[],
    exports: JSON.parse(r.exports_json) as string[],
    metadata: JSON.parse(r.metadata_json) as Record<string, unknown>,
  }));
}

export function architectureRegenTools(
  db: TrajectoryDB,
  cwd?: string,
): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const repoCwd = cwd ?? process.cwd();

  const definitions: Tool[] = [
    {
      name: 'architecture_regen',
      description:
        'Orchestrates regeneration of all auto/ architecture docs: codebase-tree.md, erd.md, module-graph.md, changelog.md. Refreshes file_registry as part of the run.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description: 'full | incremental (default: incremental). full re-walks the entire repo.',
          },
          targets: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Renderer targets to regenerate. Values: codebase_tree | erd | module_graph | changelog. Default: all 4.',
          },
          schema_path: {
            type: 'string',
            description:
              'Path (relative to repo root) to SQL file for ERD. Required for erd target; if absent the erd step is skipped with a warning.',
          },
          architecture_dir: {
            type: 'string',
            description:
              'Directory where outputs are written. Default: docs/trustmybot/architecture/auto. Must be inside CWD; must not be manual/.',
          },
          since_sha: {
            type: 'string',
            description: 'Override for changelog: show commits after this SHA.',
          },
          since_date: {
            type: 'string',
            description:
              'Override for changelog: show commits after this ISO date. Used only if since_sha is also absent.',
          },
        },
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    architecture_regen: async (args) => {
      const startMs = Date.now();

      const rawScope = args['scope'] ?? 'incremental';
      if (typeof rawScope !== 'string' || !VALID_SCOPES.has(rawScope)) {
        return err(`Invalid scope "${rawScope}": must be full or incremental`);
      }
      const scope = rawScope as 'full' | 'incremental';

      let targets: TargetName[];
      if (args['targets'] !== undefined && args['targets'] !== null) {
        if (!Array.isArray(args['targets'])) {
          return err('targets must be an array of strings');
        }
        for (const t of args['targets'] as unknown[]) {
          if (typeof t !== 'string' || !VALID_TARGETS.has(t)) {
            return err(
              `Invalid target "${t}": must be one of codebase_tree | erd | module_graph | changelog`,
            );
          }
        }
        targets = args['targets'] as TargetName[];
      } else {
        targets = [...ALL_TARGETS];
      }

      const rawArchDir =
        typeof args['architecture_dir'] === 'string'
          ? args['architecture_dir']
          : 'docs/trustmybot/architecture/auto';

      const dirResult = validateArchitectureDir(rawArchDir, repoCwd);
      if ('error' in dirResult) {
        return err(dirResult.error);
      }
      const architectureDir = dirResult.resolved;

      const schemaPath =
        typeof args['schema_path'] === 'string' ? args['schema_path'] : null;
      const sinceShaOverride =
        typeof args['since_sha'] === 'string' ? args['since_sha'] : null;
      const sinceDateOverride =
        typeof args['since_date'] === 'string' ? args['since_date'] : null;

      await mkdir(architectureDir, { recursive: true });

      const headSha = await getHeadSha({ cwd: repoCwd });

      let fileRegistryDelta: { upserted: number; deleted: number } = { upserted: 0, deleted: 0 };

      if (scope === 'full') {
        fileRegistryDelta = await refreshFileRegistryFull(db, repoCwd, headSha);
      } else {
        fileRegistryDelta = await refreshFileRegistryIncremental(db, repoCwd, headSha);
      }

      if (headSha) {
        setRegenState(db, 'file_registry', headSha);
      }

      const targetsCompleted: string[] = [];
      const targetsSkipped: Array<{ target: string; reason: string }> = [];
      const now = nowISO();

      for (const target of targets) {
        try {
          if (target === 'codebase_tree') {
            const rawRows = db.all<RawFileRegistryRow>(`SELECT * FROM file_registry ORDER BY path`);
            const rows = toRendererRows(rawRows);
            const content = renderCodebaseTree(rows, { generatedAt: now });
            await writeFile(`${architectureDir}/codebase-tree.md`, content, 'utf8');
            setRegenState(db, 'codebase_tree', headSha);
            targetsCompleted.push('codebase_tree');
          } else if (target === 'erd') {
            if (!schemaPath) {
              targetsSkipped.push({ target: 'erd', reason: 'schema_path not provided' });
              continue;
            }
            const absSchemaPath = isAbsolute(schemaPath)
              ? schemaPath
              : resolve(repoCwd, schemaPath);
            let sqlText: string;
            try {
              sqlText = await readFile(absSchemaPath, 'utf8');
            } catch {
              targetsSkipped.push({
                target: 'erd',
                reason: `schema_path not readable: ${schemaPath}`,
              });
              continue;
            }
            const content = renderErd(sqlText, { generatedAt: now, schemaSource: schemaPath });
            await writeFile(`${architectureDir}/erd.md`, content, 'utf8');
            setRegenState(db, 'erd', headSha);
            targetsCompleted.push('erd');
          } else if (target === 'module_graph') {
            const rawRows = db.all<RawFileRegistryRow>(
              `SELECT * FROM file_registry WHERE type = 'source' ORDER BY path`,
            );
            const content = renderModuleGraph(rawRows, { generatedAt: now });
            await writeFile(`${architectureDir}/module-graph.md`, content, 'utf8');
            setRegenState(db, 'module_graph', headSha);
            targetsCompleted.push('module_graph');
          } else if (target === 'changelog') {
            let sinceSha: string | null = sinceShaOverride;
            let sinceDate: string | null = sinceDateOverride;

            if (sinceSha === null && sinceDate === null) {
              const stateRow = getRegenStateRow(db, 'changelog');
              sinceSha = stateRow?.last_seen_sha ?? null;
              sinceDate = stateRow?.last_regen_at ?? null;
            }

            const gitEntries = await getGitLogEntries({ cwd: repoCwd }, sinceSha, sinceDate);
            const commits: CommitEntry[] = gitEntries.map(e => ({
              sha: e.sha,
              author: e.author,
              date: e.date,
              subject: e.subject,
              body: e.body,
              files_changed: e.filesChanged,
            }));
            const content = renderChangelog(commits, {
              generatedAt: now,
              sinceSha,
              sinceDate,
            });
            await writeFile(`${architectureDir}/changelog.md`, content, 'utf8');
            setRegenState(db, 'changelog', headSha);
            targetsCompleted.push('changelog');
          }
        } catch (e) {
          targetsSkipped.push({ target, reason: (e as Error).message });
        }
      }

      return ok({
        scope,
        targets_requested: targets,
        targets_completed: targetsCompleted,
        targets_skipped: targetsSkipped,
        file_registry_delta: fileRegistryDelta,
        head_sha: headSha,
        duration_ms: Date.now() - startMs,
      });
    },
  };

  return { definitions, handlers };
}
