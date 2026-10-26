// File-purpose coverage over this worktree (GH 1843): with the symbols and
// structural fallbacks, nearly every code file and most files carry a purpose.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WorldModelGraph, GraphHolder } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { pinScanEnv, tempDB } from './helpers.js';
const scanPin = pinScanEnv();
after(() => scanPin.restore());
const WORKTREE = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const CODE = /\.(ts|tsx|js|mjs|sh)$/;
describe('file-purpose coverage over this worktree (GH 1843)', () => {
    const db = tempDB();
    const holder = GraphHolder.fixed(new WorldModelGraph(db));
    let rows = [];
    before(async () => {
        const r = (await scanTools(db, holder, ':memory:').handlers['scan_run']({
            agent: 'bro',
            session_dir: WORKTREE,
        }));
        const text = r.content[0].text;
        assert.ok(!r.isError, text);
        const repo = JSON.parse(text).repos[0].name;
        rows = db.all(`SELECT path, purpose, purpose_source FROM wm_files WHERE repo = ?`, [repo]);
    });
    after(() => db.close());
    const share = (subset) => subset.filter((r) => r.purpose !== '').length / subset.length;
    const missing = (subset) => subset
        .filter((r) => r.purpose === '')
        .map((r) => r.path)
        .slice(0, 30)
        .join(', ');
    it('at least 95% of ts/tsx/js/mjs/sh files have a purpose', () => {
        const code = rows.filter((r) => CODE.test(r.path));
        assert.ok(code.length > 0);
        assert.ok(share(code) >= 0.95, `${(share(code) * 100).toFixed(1)}% of ${code.length}; missing: ${missing(code)}`);
    });
    it('at least 90% of all files have a purpose', () => {
        assert.ok(rows.length > 0);
        assert.ok(share(rows) >= 0.9, `${(share(rows) * 100).toFixed(1)}% of ${rows.length}; missing: ${missing(rows)}`);
    });
    it('both fallbacks populate rows: symbols and structural each count above zero', () => {
        for (const source of ['symbols', 'structural']) {
            const n = rows.filter((r) => r.purpose_source === source && r.purpose !== '').length;
            assert.ok(n > 0, `${source}: ${n}`);
        }
    });
});
//# sourceMappingURL=world-model-coverage.test.js.map