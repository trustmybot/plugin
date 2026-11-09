import type { DatabaseSync } from 'node:sqlite';
import { TARGET_SCHEMA_VERSION } from '../../mcp/trajectory-server/src/db.ts';
import type { Contract, ContractExpect, ContractSeverity } from '../../mcp/trajectory-server/src/data-contracts.ts';
import {
  checkTrajectoryDbFile,
  runDataContracts,
  selectContracts,
  type ContractReader,
  type DoctorReport,
} from '../../mcp/trajectory-server/src/tools/trajectory-doctor.ts';
import { freshnessBlock, wmRepos, type Freshness } from './freshness.ts';
import { schemaVersion } from './queries.ts';

type Row = Record<string, unknown>;

export interface ContractResult {
  id: string;
  severity: ContractSeverity;
  description: string;
  ok: boolean | null;
  skipped: string | null;
  actual: number | null;
  expected: ContractExpect;
}

export interface EmbeddingCount {
  source: string;
  rows: number;
  embedded: number;
}

export interface Health {
  checked_at: string;
  healthy: boolean;
  schema: { version: number | null; target: number };
  contracts: ContractResult[];
  freshness: Array<{ repo: string; freshness: Freshness | null }>;
  concepts: { by_status: Record<string, number>; steps_by_trust: Record<string, number> };
  embeddings: EmbeddingCount[];
}

const EMBEDDED_SOURCES: ReadonlyArray<[source: string, vectors: string, key: string]> = [
  ['discussions', 'discussions_embeddings', 'discussion_id'],
  ['audit', 'audit_embeddings', 'audit_id'],
  ['wm_directories', 'wm_directories_embeddings', 'dir_id'],
  ['wm_files', 'wm_files_embeddings', 'file_id'],
];

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function countBy(db: DatabaseSync, table: string, column: string): Record<string, number> {
  if (!hasTable(db, table)) return {};
  const rows = db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column} ORDER BY ${column}`).all() as Row[];
  return Object.fromEntries(rows.map((r) => [String(r['k']), Number(r['n'])]));
}

const bind = (params: Record<string, number>): never[] => (Object.keys(params).length > 0 ? [params as never] : []);

function connectionReader(db: DatabaseSync): ContractReader {
  return {
    get: (sql, params) => db.prepare(sql).get(...bind(params)) as Row | undefined,
    all: (sql, params) => db.prepare(sql).all(...bind(params)) as Row[],
  };
}

// The file behind the dashboard's connection, or '' for an in-memory DB.
export function dbFile(db: DatabaseSync): string {
  const main = (db.prepare('PRAGMA database_list').all() as Row[]).find((r) => r['name'] === 'main');
  return String(main?.['file'] ?? '');
}

// The trajectory doctor's checks on their own query-only connection; when that
// cannot open, the same read-only SELECTs on the dashboard's connection.
function doctorReport(db: DatabaseSync, dbPath: string, contracts: readonly Contract[]): DoctorReport {
  try {
    return checkTrajectoryDbFile(dbPath, contracts);
  } catch {
    return runDataContracts(connectionReader(db), contracts, { dbPath });
  }
}

function contractResults(db: DatabaseSync, dbPath: string): { healthy: boolean; checked_at: string; contracts: ContractResult[] } {
  const selected = selectContracts(undefined);
  if ('error' in selected) throw new Error(selected.error);
  const report = doctorReport(db, dbPath, selected.contracts);
  const violations = new Map(report.violations.map((v) => [v.id, v]));
  const skipped = new Map(report.skipped.map((s) => [s.id, s.reason]));
  const contracts = selected.contracts.map((c): ContractResult => {
    const violation = violations.get(c.id);
    const reason = skipped.get(c.id) ?? null;
    return {
      id: c.id,
      severity: c.severity,
      description: c.description,
      ok: violation ? false : reason === null ? true : null,
      skipped: reason,
      actual: violation?.actual ?? null,
      expected: c.expect,
    };
  });
  return { healthy: report.healthy, checked_at: report.checked_at, contracts };
}

function embeddingCounts(db: DatabaseSync): EmbeddingCount[] {
  return EMBEDDED_SOURCES.filter(([source, vectors]) => hasTable(db, source) && hasTable(db, vectors)).map(([source, vectors, key]) => {
    const row = db
      .prepare(`SELECT (SELECT COUNT(*) FROM ${source}) AS rows, (SELECT COUNT(*) FROM ${vectors} v JOIN ${source} s ON s.id = v.${key}) AS embedded`)
      .get() as Row;
    return { source, rows: Number(row['rows']), embedded: Number(row['embedded']) };
  });
}

// GET /api/health: read-only; the data contracts run fresh on every call.
export function health(db: DatabaseSync, dbPath: string): Health {
  const { healthy, checked_at, contracts } = contractResults(db, dbPath);
  return {
    checked_at,
    healthy,
    schema: { version: schemaVersion(db), target: TARGET_SCHEMA_VERSION },
    contracts,
    freshness: wmRepos(db).map((repo) => ({ repo, freshness: freshnessBlock(db, repo) })),
    concepts: { by_status: countBy(db, 'wm_concepts', 'status'), steps_by_trust: countBy(db, 'wm_concept_steps', 'trust') },
    embeddings: embeddingCounts(db),
  };
}
