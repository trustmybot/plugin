import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { tempDB } from './helpers.js';
import { nowISO, TrajectoryDB, } from '../db.js';
describe('TrajectoryDB', () => {
    it('opens an in-memory DB and verifies all prod tables exist with schema_version=28 (skills folded into cheatcodes #101; world model in kuzu)', () => {
        const db = tempDB();
        const expectedTables = [
            'issues',
            'tasks',
            'audit',
            'validation_attempts',
            'agents',
            'roundtables',
            'roundtable_votes',
            'discussions',
            'plugin_meta',
            'plugin_config',
            'agent_runs',
            'pr_review_runs',
            'repos',
            // #155 repos-centric schema — milestones FK hub
            'milestones',
            // #2905 FTS5 virtual tables (workflow tables only — directories moved to kuzu)
            'discussions_fts',
            'audit_fts',
            // #2905 embedding tables (workflow tables only)
            'discussions_embeddings',
            'audit_embeddings',
            // #659 cheatcode install stage
            'cheatcodes',
            'cheatcode_attachments',
        ];
        const rows = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\\_fts\\_%' ESCAPE '\\' ORDER BY name");
        const actualNames = rows.map((r) => r.name).sort();
        const expectedSorted = [...expectedTables].sort();
        assert.deepEqual(actualNames, expectedSorted);
        const meta = db.get('SELECT schema_version FROM plugin_meta LIMIT 1');
        assert.ok(meta !== undefined, 'plugin_meta should have a row');
        assert.equal(meta.schema_version, 28);
        db.close();
    });
    it('run inserts a builtin skill row into cheatcodes, get retrieves it, all lists multiple rows', () => {
        const db = tempDB();
        const now = nowISO();
        db.run(`INSERT INTO cheatcodes (name, kind, origin, description, file_path, installed_at, created_at, updated_at)
       VALUES (?, 'skill', 'builtin', ?, ?, ?, ?, ?)`, ['skill-a', 'Skill A', '/path/a.md', now, now, now]);
        db.run(`INSERT INTO cheatcodes (name, kind, origin, description, file_path, installed_at, created_at, updated_at)
       VALUES (?, 'skill', 'builtin', ?, ?, ?, ?, ?)`, ['skill-b', 'Skill B', '/path/b.md', now, now, now]);
        const single = db.get('SELECT name, description FROM cheatcodes WHERE name = ?', ['skill-a']);
        assert.ok(single !== undefined);
        assert.equal(single.name, 'skill-a');
        assert.equal(single.description, 'Skill A');
        // Scope to the test's inserted rows — schema seeds bundled tmb_* skills
        // (#101) so the table is never empty on a fresh DB. Filter on the names
        // this test wrote to keep the assertion local to the test's intent.
        const all = db.all("SELECT name FROM cheatcodes WHERE name IN ('skill-a','skill-b') ORDER BY name");
        assert.equal(all.length, 2);
        assert.equal(all[0].name, 'skill-a');
        assert.equal(all[1].name, 'skill-b');
        db.close();
    });
    it('transaction rolls back on thrown error', () => {
        const db = tempDB();
        const now = nowISO();
        assert.throws(() => {
            db.transaction(() => {
                db.run(`INSERT INTO cheatcodes (name, kind, origin, description, file_path, installed_at, created_at, updated_at)
           VALUES (?, 'skill', 'builtin', ?, ?, ?, ?, ?)`, ['rollback-skill', 'Should not persist', '/path/r.md', now, now, now]);
                throw new Error('forced rollback');
            });
        }, /forced rollback/);
        const row = db.get('SELECT name FROM cheatcodes WHERE name = ?', ['rollback-skill']);
        assert.equal(row, undefined, 'rolled-back row must not be present');
        db.close();
    });
    it('nowISO returns an ISO 8601 string ending with Z', () => {
        const iso = nowISO();
        assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    });
    it('syncs plugin_version from CLAUDE_PLUGIN_ROOT manifest on init', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-test-'));
        try {
            mkdirSync(join(tmpDir, '.claude-plugin'), { recursive: true });
            writeFileSync(join(tmpDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tmb', version: '9.9.9' }), 'utf8');
            const saved = process.env['CLAUDE_PLUGIN_ROOT'];
            process.env['CLAUDE_PLUGIN_ROOT'] = tmpDir;
            try {
                const db = new TrajectoryDB(':memory:');
                const row = db.get('SELECT plugin_version FROM plugin_meta WHERE id = 1');
                assert.ok(row !== undefined, 'plugin_meta row must exist');
                assert.equal(row.plugin_version, '9.9.9');
                db.close();
            }
            finally {
                if (saved === undefined) {
                    delete process.env['CLAUDE_PLUGIN_ROOT'];
                }
                else {
                    process.env['CLAUDE_PLUGIN_ROOT'] = saved;
                }
            }
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    it('updates plugin_version on next init when manifest version changes', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-test-'));
        try {
            mkdirSync(join(tmpDir, '.claude-plugin'), { recursive: true });
            const manifestPath = join(tmpDir, '.claude-plugin', 'plugin.json');
            writeFileSync(manifestPath, JSON.stringify({ name: 'tmb', version: '9.9.9' }), 'utf8');
            const dbPath = join(tmpDir, 'trajectory.db');
            const saved = process.env['CLAUDE_PLUGIN_ROOT'];
            process.env['CLAUDE_PLUGIN_ROOT'] = tmpDir;
            try {
                const db1 = new TrajectoryDB(dbPath);
                db1.close();
                writeFileSync(manifestPath, JSON.stringify({ name: 'tmb', version: '9.9.10' }), 'utf8');
                const db2 = new TrajectoryDB(dbPath);
                const row = db2.get('SELECT plugin_version FROM plugin_meta WHERE id = 1');
                assert.ok(row !== undefined, 'plugin_meta row must exist');
                assert.equal(row.plugin_version, '9.9.10');
                db2.close();
            }
            finally {
                if (saved === undefined) {
                    delete process.env['CLAUDE_PLUGIN_ROOT'];
                }
                else {
                    process.env['CLAUDE_PLUGIN_ROOT'] = saved;
                }
            }
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    it('treats an explicit dependency object as authoritative, including null version', () => {
        const pluginRoot = mkdtempSync(join(tmpdir(), 'tmb-explicit-deps-'));
        const saved = process.env['CLAUDE_PLUGIN_ROOT'];
        try {
            mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
            writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tmb', version: '9.9.9' }));
            process.env['CLAUDE_PLUGIN_ROOT'] = pluginRoot;
            const sqlEvents = [];
            const db = new TrajectoryDB(':memory:', {
                pluginVersion: null,
                serverLog: () => { },
                sqlLog: (entry) => sqlEvents.push(entry),
            });
            const meta = db.get('SELECT plugin_version FROM plugin_meta WHERE id = 1');
            const stampedBuiltins = db.get("SELECT COUNT(*) AS n FROM cheatcodes WHERE origin = 'builtin' AND version IS NOT NULL");
            assert.equal(meta?.plugin_version, '0.0.0');
            assert.equal(stampedBuiltins?.n, 0);
            sqlEvents.length = 0;
            db.run('CREATE TABLE injected_logger_test (id INTEGER PRIMARY KEY)');
            db.get('SELECT 1 AS n');
            db.all('SELECT 1 AS n');
            assert.throws(() => db.run('INSERT INTO missing_injected_logger_table VALUES (1)'), /no such table/);
            assert.throws(() => db.get('SELECT * FROM missing_injected_logger_table'), /no such table/);
            assert.throws(() => db.all('SELECT * FROM missing_injected_logger_table'), /no such table/);
            assert.deepEqual(sqlEvents.map((entry) => [entry['kind'], entry['ok']]), [
                ['run', true],
                ['get', true],
                ['all', true],
                ['run', false],
                ['get', false],
                ['all', false],
            ]);
            db.close();
        }
        finally {
            if (saved === undefined) {
                delete process.env['CLAUDE_PLUGIN_ROOT'];
            }
            else {
                process.env['CLAUDE_PLUGIN_ROOT'] = saved;
            }
            rmSync(pluginRoot, { recursive: true, force: true });
        }
    });
    it('uses an explicit version for plugin metadata and builtin versions', () => {
        const db = new TrajectoryDB(':memory:', {
            pluginVersion: '1.1.0',
            serverLog: () => { },
            sqlLog: () => { },
        });
        const meta = db.get('SELECT plugin_version FROM plugin_meta WHERE id = 1');
        const unstampedBuiltins = db.get("SELECT COUNT(*) AS n FROM cheatcodes WHERE origin = 'builtin' AND version != '1.1.0'");
        assert.equal(meta?.plugin_version, '1.1.0');
        assert.equal(unstampedBuiltins?.n, 0);
        db.close();
    });
    it('does not let injected logger failures change database operation results', () => {
        const db = new TrajectoryDB(':memory:', {
            pluginVersion: null,
            serverLog: () => {
                throw new Error('server logger exploded');
            },
            sqlLog: () => {
                throw new Error('SQL logger exploded');
            },
        });
        assert.doesNotThrow(() => {
            db.run('CREATE TABLE logger_throw_test (id INTEGER)');
        });
        const table = db.get("SELECT name FROM sqlite_master WHERE name = 'logger_throw_test'");
        assert.equal(table?.name, 'logger_throw_test');
        assert.throws(() => db.run('INSERT INTO missing_logger_throw_table VALUES (1)'), /no such table/);
        db.close();
    });
    it('rejects incomplete explicit dependencies instead of falling back to globals', () => {
        for (const pluginVersion of ['', '   ']) {
            assert.throws(() => new TrajectoryDB(':memory:', {
                pluginVersion,
                serverLog: () => { },
                sqlLog: () => { },
            }), /pluginVersion must be a non-empty string or null/);
        }
        assert.throws(() => new TrajectoryDB(':memory:', {
            pluginVersion: null,
            serverLog: undefined,
            sqlLog: () => { },
        }), /serverLog must be a function/);
        assert.throws(() => new TrajectoryDB(':memory:', {
            pluginVersion: null,
            serverLog: () => { },
            sqlLog: undefined,
        }), /sqlLog must be a function/);
    });
    it('routes legacy-shape warnings through the supplied server logger', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-injected-server-log-'));
        const dbPath = join(tmpDir, 'trajectory.db');
        try {
            const raw = new DatabaseSync(dbPath);
            raw.exec('CREATE TABLE legacy_table (id INTEGER PRIMARY KEY)');
            raw.close();
            const serverEvents = [];
            const db = new TrajectoryDB(dbPath, {
                pluginVersion: '1.1.0',
                serverLog: (entry) => serverEvents.push(entry),
                sqlLog: () => { },
            });
            assert.equal(db.legacyNoPluginMeta, true);
            assert.ok(serverEvents.some((entry) => entry['kind'] === 'legacy_db_no_plugin_meta'));
            db.close();
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    it('does not let a throwing server logger abort legacy DB adoption', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-throwing-server-log-'));
        const dbPath = join(tmpDir, 'trajectory.db');
        try {
            const raw = new DatabaseSync(dbPath);
            raw.exec('CREATE TABLE legacy_table (id INTEGER PRIMARY KEY)');
            raw.close();
            let db;
            assert.doesNotThrow(() => {
                db = new TrajectoryDB(dbPath, {
                    pluginVersion: '1.1.0',
                    serverLog: () => {
                        throw new Error('server logger exploded');
                    },
                    sqlLog: () => { },
                });
            });
            assert.equal(db?.legacyNoPluginMeta, true);
            db?.close();
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    it('flags legacyNoPluginMeta=false on a genuinely fresh DB', () => {
        const db = new TrajectoryDB(':memory:');
        assert.equal(db.legacyNoPluginMeta, false);
        db.close();
    });
    it('flags legacyNoPluginMeta=true when a DB has tables but no plugin_meta (#602)', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-legacy-'));
        try {
            const dbPath = join(tmpDir, 'trajectory.db');
            // Seed a pre-stamp legacy shape: a user table present, NO plugin_meta.
            // Use a zombie table the current schema no longer defines so reapplying
            // schema.sql stays clean — the flag only depends on a non-sqlite table
            // existing alongside a missing plugin_meta.
            const seed = new DatabaseSync(dbPath);
            seed.exec('PRAGMA journal_mode = WAL');
            seed.exec(`
        CREATE TABLE regen_state (id INTEGER PRIMARY KEY, state_json TEXT);
        INSERT INTO regen_state (state_json) VALUES ('{"legacy":true}');
      `);
            seed.close();
            const db = new TrajectoryDB(dbPath);
            try {
                assert.equal(db.legacyNoPluginMeta, true, 'pre-stamp legacy DB must be flagged');
                // Adopted forward, not bricked: plugin_meta now exists and is stamped,
                // and the pre-existing legacy table is preserved.
                const meta = db.get('SELECT schema_version FROM plugin_meta LIMIT 1');
                assert.ok(meta !== undefined, 'plugin_meta should be stamped on adopt-forward');
                const legacyRow = db.get('SELECT state_json FROM regen_state LIMIT 1');
                assert.ok(legacyRow !== undefined, 'pre-existing legacy rows must survive');
            }
            finally {
                db.close();
            }
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=db.test.js.map