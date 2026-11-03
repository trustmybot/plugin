// Regression test: the scan walker emits valid JSON when a repo contains a
// non-ASCII tracked path.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { walkProject } from '../tools/scan-walk.js';
import { pinScanEnv } from './helpers.js';
describe('scan walker on a repo with a non-ASCII tracked path', () => {
    let pin;
    let workspace = '';
    let out = null;
    let error = null;
    before(async () => {
        pin = pinScanEnv();
        workspace = mkdtempSync(join(tmpdir(), 'tmb-scan-non-ascii-paths-'));
        const repo = join(workspace, 'testrepo');
        mkdirSync(join(repo, 'subdir'), { recursive: true });
        writeFileSync(join(repo, 'subdir', '⊗.txt'), 'content\n');
        writeFileSync(join(repo, 'plain.txt'), 'plain\n');
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: repo });
        const db = new TrajectoryDB(':memory:');
        try {
            out = await walkProject(db, workspace, { timeoutMs: 60_000 });
        }
        catch (e) {
            error = e;
        }
        finally {
            db.close();
        }
    });
    after(() => {
        pin.restore();
        rmSync(workspace, { recursive: true, force: true });
    });
    it('scan succeeds on a repo with a non-ASCII path', () => {
        assert.equal(error, null);
    });
    it('scan output is valid JSON', () => {
        assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
    });
    it('non-ASCII path appears in files[].path', () => {
        assert.ok(out.files.some((f) => f.path.endsWith('⊗.txt')), '⊗.txt not found in files[].path');
    });
});
//# sourceMappingURL=scan-non-ascii-paths.test.js.map