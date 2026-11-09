// Worker thread for /api/insights/change-impact (GH 2618): runs computeChangeImpact off the main thread so the dashboard's event loop stays free.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { computeChangeImpact, type ChangeImpactOptions } from '../../mcp/trajectory-server/src/change-impact/index.ts';
import type { StatsReader } from '../../mcp/trajectory-server/src/tools/stats.ts';

export interface ChangeImpactJob {
  dbPath: string;
  opts: ChangeImpactOptions;
}

export type ChangeImpactReply = { result: unknown } | { error: string; stack?: string };

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
    if (!(err instanceof Error)) return { error: String(err) };
    return err.stack === undefined ? { error: err.message } : { error: err.message, stack: err.stack };
  }
}

parentPort?.postMessage(run(workerData as ChangeImpactJob));
