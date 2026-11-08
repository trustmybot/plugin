/**
 * Change-impact CLI (GH 2600), read-only:
 *   node --experimental-sqlite dist/change-impact/cli.js --db <path> [--git <repo>] --change <N> [--metric <id>] [--window-days D] [--max-samples M]
 *   node --experimental-sqlite dist/change-impact/cli.js --db <path> --sample-counts <DAYS>
 * Prints the JSON result on stdout.
 */
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import type { StatsReader } from '../tools/stats.js';
import { computeChangeImpact, defaultGitSource, sampleCounts } from './index.js';

function readerFor(path: string): StatsReader & { close(): void } {
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    get<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).get(...(params as never[])) as T | undefined;
    },
    all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    close() {
      db.close();
    },
  };
}

function optionalInt(v: string | undefined): number | undefined {
  return v === undefined ? undefined : Number(v);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      db: { type: 'string' },
      git: { type: 'string' },
      change: { type: 'string' },
      metric: { type: 'string' },
      'window-days': { type: 'string' },
      'max-samples': { type: 'string' },
      limit: { type: 'string' },
      'sample-counts': { type: 'string' },
    },
  });
  if (!values.db) throw new Error('--db <path> is required');
  const reader = readerFor(values.db);
  try {
    const result =
      values['sample-counts'] !== undefined
        ? sampleCounts(reader, Number(values['sample-counts']))
        : computeChangeImpact(reader, defaultGitSource(reader, values.git), {
            change: optionalInt(values.change),
            metric: values.metric,
            window_days: optionalInt(values['window-days']),
            max_samples: optionalInt(values['max-samples']),
            limit: optionalInt(values.limit),
          });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    reader.close();
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exitCode = 1;
}
