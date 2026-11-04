/**
 * The consultant-spawn nudge of prompt-intent-hints (GH 865, GH 1692): a
 * domain trade-off prompt gets the nudge and writes exactly one
 * consultant_spawn_nudged audit row from hook:prompt-intent-hints; a benign
 * prompt gets neither; an absent DB still gets the nudge and exit 0; and a DB
 * found by walking up from the cwd, with no env var, gets the row. Each case
 * runs `node dist/hooks.js prompt-intent-hints` in a sandbox with its own HOME.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT, runGate } from './hook-sandbox.js';
const GATE = 'prompt-intent-hints';
const NUDGE = 'consultant-spawn enforcement';
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
function schemaDb(path) {
    mkdirSync(dirname(path), { recursive: true });
    const d = new DatabaseSync(path);
    try {
        d.exec(SCHEMA);
    }
    finally {
        d.close();
    }
}
function query(db, sql) {
    const d = new DatabaseSync(db);
    try {
        return d.prepare(sql).all();
    }
    finally {
        d.close();
    }
}
const nudged = (db) => Number(query(db, "SELECT COUNT(*) AS n FROM audit WHERE event_type='consultant_spawn_nudged'")[0].n);
const clearNudges = (db) => query(db, "DELETE FROM audit WHERE event_type='consultant_spawn_nudged' RETURNING id");
describe('prompt-intent-hints: the consultant-spawn nudge writes its audit row', () => {
    let sb;
    let db;
    before(() => {
        sb = makeSandbox('consultant-spawn-enforcement');
        db = join(sb.dir, 'project/.claude/tmb/trajectory.db');
        schemaDb(db);
    });
    after(() => sb.remove());
    const run = (prompt, extra = {}, cwd = sb.dir) => {
        const r = runGate(GATE, {
            cwd,
            input: JSON.stringify({ prompt }),
            env: { ...sb.env, TMB_DISABLE_CHEATCODE_INSTALL_HINT: '0', TMB_DISABLE_CONSULTANT_HINT: '0', TRAJECTORY_DB_PATH: db, ...extra },
        });
        return { out: r.stdout + r.stderr, status: r.status };
    };
    it('a domain trade-off prompt gets the nudge and exactly one audit row from hook:prompt-intent-hints', () => {
        clearNudges(db);
        const { out } = run("Should we keep src/cli.py's storage in JSON or move to SQLite as the CLI scales?");
        assert.ok(out.includes(NUDGE), `domain trade-off prompt must emit the nudge: ${out}`);
        assert.equal(nudged(db), 1, 'one audit row per nudge');
        const [row] = query(db, "SELECT from_node, event_type FROM audit WHERE event_type='consultant_spawn_nudged' LIMIT 1");
        assert.equal(`${row.from_node}|${row.event_type}`, 'hook:prompt-intent-hints|consultant_spawn_nudged', 'from_node + event_type');
    });
    it('a non-triggering prompt gets no nudge and no audit row', () => {
        clearNudges(db);
        const { out } = run('Please update the README with the new install steps');
        assert.ok(!out.includes(NUDGE), `benign prompt must not emit the nudge: ${out}`);
        assert.equal(nudged(db), 0, 'no audit row for a non-triggering prompt');
    });
    it('a missing DB: exit 0, the advisory nudge still emitted', () => {
        const { out, status } = run('Should we keep JSON or move to SQLite as the CLI scales?', {
            TMB_DISABLE_CHEATCODE_INSTALL_HINT: undefined,
            TRAJECTORY_DB_PATH: '/nonexistent-tmb-consultant-spawn.db',
        });
        assert.equal(status, 0, 'hook exits 0 when DB is absent');
        assert.ok(out.includes(NUDGE), `advisory nudge still emitted with no DB: ${out}`);
    });
    it('a DB resolved by walking up from the cwd, with no env var, gets the row', () => {
        const walkDb = join(sb.dir, 'walk/.claude/tmb/trajectory.db');
        schemaDb(walkDb);
        const child = join(sb.dir, 'walk/some/nested/path');
        mkdirSync(child, { recursive: true });
        const beforeCount = nudged(walkDb);
        run('Should we move from JSON to SQLite as the CLI scales?', { TMB_DISABLE_CHEATCODE_INSTALL_HINT: undefined, TRAJECTORY_DB_PATH: undefined }, child);
        assert.equal(nudged(walkDb), beforeCount + 1, 'walk-up resolution writes the audit row');
    });
});
//# sourceMappingURL=consultant-spawn-enforcement.test.js.map