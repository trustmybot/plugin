import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIST = fileURLToPath(new URL('..', import.meta.url));
const TOOL_MODULES = [
    'tools/index.js',
    'tools/composites.js',
    'tools/agent-runs-backfill.js',
    'tools/trajectory-doctor.js',
];
function importScript() {
    return TOOL_MODULES.map((m) => `await import(${JSON.stringify(new URL(m, `file://${DIST}`).href)});`).join(' ');
}
function importInEmptyCwd(dbPath) {
    const root = mkdtempSync(join(tmpdir(), 'tmb-module-load-'));
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { ...process.env, HOME: home };
    delete env['TRAJECTORY_DB_PATH'];
    delete env['TMB_SYNC_LOG_DIR'];
    if (dbPath !== undefined)
        env['TRAJECTORY_DB_PATH'] = dbPath.replace('<root>', root);
    const result = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', importScript()], { cwd: root, env, encoding: 'utf8' });
    return { root, status: result.status, stderr: result.stderr };
}
describe('module load footprint', () => {
    it('importing the tool modules in an empty cwd creates nothing on disk', () => {
        const { root, status, stderr } = importInEmptyCwd();
        try {
            assert.equal(status, 0, stderr);
            assert.deepEqual(readdirSync(root), ['home']);
            assert.deepEqual(readdirSync(join(root, 'home')), []);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('importing with TRAJECTORY_DB_PATH pointing at a missing dir does not create it', () => {
        const { root, status, stderr } = importInEmptyCwd('<root>/nope/trajectory.db');
        try {
            assert.equal(status, 0, stderr);
            assert.equal(existsSync(join(root, 'nope')), false);
            assert.deepEqual(readdirSync(root), ['home']);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=module-load-footprint.test.js.map