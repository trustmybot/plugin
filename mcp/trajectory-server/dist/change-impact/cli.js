/**
 * Change-impact CLI (GH 2600), read-only:
 *   node --experimental-sqlite dist/change-impact/cli.js --db <path> --source <S> --id <I> [--repo <name>] [--metric <id>] [--window-days D] [--max-samples M]
 *   node --experimental-sqlite dist/change-impact/cli.js --db <path> --list [--source <S>] [--limit N]
 *   node --experimental-sqlite dist/change-impact/cli.js --db <path> --sample-counts <DAYS>
 *   node --experimental-sqlite dist/change-impact/cli.js --db <path> --cache
 * Prints the JSON result on stdout. --cache writes the regressed metrics of the
 * list form to change-impact-regressions.json next to the DB (the trajectory
 * server spawns it after connect, startup-catchup.ts) and prints {path, changes}.
 */
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { computeChangeImpact, sampleCounts } from './index.js';
import { regressionsCacheOf, writeRegressionsCache } from './regressions-cache.js';
function readerFor(path) {
    const db = new DatabaseSync(path, { readOnly: true });
    return {
        get(sql, params = []) {
            return db.prepare(sql).get(...params);
        },
        all(sql, params = []) {
            return db.prepare(sql).all(...params);
        },
        close() {
            db.close();
        },
    };
}
function optionalInt(v) {
    return v === undefined ? undefined : Number(v);
}
function main() {
    const { values } = parseArgs({
        options: {
            db: { type: 'string' },
            source: { type: 'string' },
            id: { type: 'string' },
            repo: { type: 'string' },
            list: { type: 'boolean' },
            metric: { type: 'string' },
            'window-days': { type: 'string' },
            'max-samples': { type: 'string' },
            limit: { type: 'string' },
            'sample-counts': { type: 'string' },
            cache: { type: 'boolean' },
        },
    });
    if (!values.db)
        throw new Error('--db <path> is required');
    if (!values.cache && values['sample-counts'] === undefined && !values.list && (values.source === undefined || values.id === undefined)) {
        throw new Error('one of --source <S> --id <I>, --list, --sample-counts <DAYS> or --cache is required');
    }
    const reader = readerFor(values.db);
    try {
        if (values.cache) {
            const list = computeChangeImpact(reader);
            const cache = regressionsCacheOf(list.changes);
            const path = writeRegressionsCache(values.db, cache);
            process.stdout.write(`${JSON.stringify({ path, changes: cache.changes.length })}\n`);
            return;
        }
        const source = values.source;
        const result = values['sample-counts'] !== undefined
            ? sampleCounts(reader, Number(values['sample-counts']))
            : computeChangeImpact(reader, undefined, {
                change: values.list ? undefined : { source: source, id: values.id, repo: values.repo },
                source: values.list ? source : undefined,
                metric: values.metric,
                window_days: optionalInt(values['window-days']),
                max_samples: optionalInt(values['max-samples']),
                limit: optionalInt(values.limit),
            });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    finally {
        reader.close();
    }
}
try {
    main();
}
catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
}
//# sourceMappingURL=cli.js.map