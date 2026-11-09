import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { computeChangeImpact, type ChangeImpactOptions } from '../../mcp/trajectory-server/src/change-impact/index.ts';
import type { StatsReader } from '../../mcp/trajectory-server/src/tools/stats.ts';

export interface ChangeImpactJob {
  dbPath: string;
  opts: ChangeImpactOptions;
}

export type ChangeImpactReply = { result: unknown } | { error: string };

function statsReader(db: DatabaseSync): StatsReader {
  return {
    get<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).get(...(params as never[])) as T | undefined;
    },
    all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

function run({ dbPath, opts }: ChangeImpactJob): ChangeImpactReply {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return { result: computeChangeImpact(statsReader(db), undefined, opts) };
    } finally {
      db.close();
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

parentPort?.postMessage(run(workerData as ChangeImpactJob));
