/**
 * The maintenance entry points that load trajectory-server modules
 * (`cli.js backfill-agent-runs`, `cli.js trajectory-doctor` and
 * scripts/maintenance/run-scan.mjs) check the DB before loading any tool
 * module: with no trajectory DB each exits 2 and creates nothing. Each runs
 * from an empty temp dir, HOME pointed inside it, once with
 * TRAJECTORY_DB_PATH at a missing path and once with it unset. Ported from the
 * former L3 shell test (GH 1692).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRoot } from '../hooks/lib/project-env.js';
const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const RUN_SCAN = join(PLUGIN_ROOT, 'scripts/maintenance/run-scan.mjs');
const ENTRIES = [
    ['cli.js backfill-agent-runs', ['--experimental-sqlite', '--no-warnings', CLI, 'backfill-agent-runs']],
    ['cli.js trajectory-doctor', ['--experimental-sqlite', '--no-warnings', CLI, 'trajectory-doctor']],
    ['run-scan.mjs', ['--experimental-sqlite', '--no-warnings', RUN_SCAN]],
];
function entriesUnder(dir) {
    return readdirSync(dir, { recursive: true }).map(String).sort();
}
describe('maintenance entry points with no trajectory DB', () => {
    for (const [name, args] of ENTRIES) {
        for (const withDbEnv of [true, false]) {
            it(`${name}, ${withDbEnv ? 'TRAJECTORY_DB_PATH at a missing path' : 'no TRAJECTORY_DB_PATH, empty cwd'}: exit 2, nothing created`, () => {
                const root = mkdtempSync(join(tmpdir(), 'tmb-maintenance-no-db-'));
                try {
                    mkdirSync(join(root, 'home'));
                    mkdirSync(join(root, 'cwd'));
                    const env = { ...process.env, HOME: join(root, 'home') };
                    for (const key of ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'TRAJECTORY_DB_PATH'])
                        delete env[key];
                    if (withDbEnv)
                        env.TRAJECTORY_DB_PATH = join(root, 'cwd/nope/trajectory.db');
                    const r = spawnSync(process.execPath, args, { cwd: join(root, 'cwd'), env, encoding: 'utf8' });
                    assert.equal(r.status, 2, `exit ${r.status} with no DB (want 2)\n${r.stdout}${r.stderr}`);
                    assert.deepEqual(entriesUnder(root), ['cwd', 'home'], 'created files');
                }
                finally {
                    rmSync(root, { recursive: true, force: true });
                }
            });
        }
    }
});
//# sourceMappingURL=cli-maintenance-no-db.test.js.map