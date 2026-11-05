import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { tempDB } from './helpers.js';
import { selectProjectInstalls } from '../tools/cheatcode-runtime.js';
import { probeCachePath, probeChildEnv, reconcileAtStartup, reconcileCheatcodes, reconcileNow, } from '../tools/cheatcode-reconcile.js';
const NOW = '2026-10-18T12:00:00.000Z';
function evidence(partial = {}) {
    return { mcpServers: null, plugins: null, ...partial };
}
function plugins(entries) {
    return new Map(Object.entries(entries).map(([id, e]) => [
        id,
        { enabled: e.enabled, mcpServers: new Set(e.mcpServers ?? []), version: e.version ?? null },
    ]));
}
describe('reconcileCheatcodes', () => {
    let db;
    let root;
    const addRow = (name, kind, status, opts = {}) => {
        const res = db.run(`INSERT INTO cheatcodes (name, kind, origin, description, source_url, file_path, version, scope, status, installed_at, created_at, updated_at)
       VALUES (?, ?, 'external', '', ?, ?, ?, 'project-local', ?, 'then', 'then', 'then')`, [name, kind, opts.source_url ?? `fixture:${name}`, opts.file_path ?? null, opts.version ?? null, status]);
        return Number(res.lastInsertRowid);
    };
    const statusOf = (id) => db.get('SELECT status FROM cheatcodes WHERE id = ?', [id]).status;
    const versionRow = (id) => ({
        ...db.get('SELECT version, updated_at FROM cheatcodes WHERE id = ?', [id]),
    });
    const reconcile = (ev, pluginRoot = root) => reconcileCheatcodes(db, ev, { fromNode: 'server', writer: 'server', now: NOW, pluginRoot });
    const healthAudits = () => db.all(`SELECT from_node, summary, content_json, created_at, issue_id, branch_id FROM audit WHERE event_type = 'cheatcode_healthcheck'`);
    beforeEach(() => {
        db = tempDB();
        db.run('DELETE FROM cheatcodes');
        root = mkdtempSync(join(tmpdir(), 'reconcile-'));
        mkdirSync(join(root, 'skills', 'present'), { recursive: true });
        writeFileSync(join(root, 'skills', 'present', 'SKILL.md'), '# present');
    });
    it('skill: absolute file_path present -> active, missing -> broken', () => {
        const present = addRow('abs-present', 'skill', 'broken', { file_path: join(root, 'skills', 'present', 'SKILL.md') });
        const missing = addRow('abs-missing', 'skill', 'active', { file_path: join(root, 'nope', 'SKILL.md') });
        const transitions = reconcile(evidence());
        assert.equal(statusOf(present), 'active');
        assert.equal(statusOf(missing), 'broken');
        assert.equal(transitions.length, 2);
    });
    it('skill: relative file_path resolves against pluginRoot', () => {
        const present = addRow('rel-present', 'skill', 'broken', { file_path: 'skills/present/SKILL.md' });
        const missing = addRow('rel-missing', 'skill', 'active', { file_path: 'skills/absent/SKILL.md' });
        reconcile(evidence());
        assert.equal(statusOf(present), 'active');
        assert.equal(statusOf(missing), 'broken');
    });
    it('bundled mcp: active only when plugin enabled and carries the server key', () => {
        const ok = addRow('srv-ok', 'mcp', 'broken', { source_url: 'mcp:tmb/trajectory-server' });
        const disabled = addRow('srv-disabled', 'mcp', 'active', { source_url: 'mcp:off/srv' });
        const noKey = addRow('srv-nokey', 'mcp', 'active', { source_url: 'mcp:tmb/other-server' });
        const noPlugin = addRow('srv-noplugin', 'mcp', 'active', { source_url: 'mcp:ghost/srv' });
        reconcile(evidence({
            plugins: plugins({
                'tmb@market': { enabled: true, mcpServers: ['trajectory-server'] },
                'off@market': { enabled: false, mcpServers: ['srv'] },
            }),
        }));
        assert.equal(statusOf(ok), 'active');
        assert.equal(statusOf(disabled), 'broken');
        assert.equal(statusOf(noKey), 'broken');
        assert.equal(statusOf(noPlugin), 'broken');
    });
    it('bundled mcp: null plugin listing leaves the row untouched', () => {
        const id = addRow('srv', 'mcp', 'active', { source_url: 'mcp:tmb/srv' });
        const transitions = reconcile(evidence({ mcpServers: new Set(['srv']) }));
        assert.equal(statusOf(id), 'active');
        assert.deepEqual(transitions, []);
    });
    it('plain mcp: name present (including merged ~/.claude.json key) -> active, missing -> broken', () => {
        const listed = addRow('listed', 'mcp', 'broken', { source_url: 'npx:listed' });
        const fromJson = addRow('from-claude-json', 'mcp', 'broken', { source_url: 'npx:json' });
        const missing = addRow('missing', 'mcp', 'active', { source_url: 'npx:missing' });
        reconcile(evidence({ mcpServers: new Set(['listed', 'from-claude-json']) }));
        assert.equal(statusOf(listed), 'active');
        assert.equal(statusOf(fromJson), 'active');
        assert.equal(statusOf(missing), 'broken');
    });
    it('plain mcp: null mcp listing leaves the row untouched', () => {
        const id = addRow('srv', 'mcp', 'active', { source_url: 'npx:srv' });
        reconcile(evidence({ plugins: plugins({}) }));
        assert.equal(statusOf(id), 'active');
    });
    it('plugin: enabled -> active, disabled or absent -> broken', () => {
        const enabled = addRow('p-enabled', 'plugin', 'broken');
        const disabled = addRow('p-disabled', 'plugin', 'active');
        const absent = addRow('p-absent', 'plugin', 'active');
        reconcile(evidence({ plugins: plugins({ 'p-enabled@m': { enabled: true }, 'p-disabled@m': { enabled: false } }) }));
        assert.equal(statusOf(enabled), 'active');
        assert.equal(statusOf(disabled), 'broken');
        assert.equal(statusOf(absent), 'broken');
    });
    it('plugin: null plugin listing leaves the row untouched', () => {
        const id = addRow('p', 'plugin', 'active');
        const transitions = reconcile(evidence({ mcpServers: new Set(['p']) }));
        assert.equal(statusOf(id), 'active');
        assert.deepEqual(transitions, []);
        assert.equal(healthAudits().length, 0);
    });
    it('matches exactly: a name that is a substring of another does not match', () => {
        const plugin = addRow('foo', 'plugin', 'active');
        const mcp = addRow('srv', 'mcp', 'active', { source_url: 'npx:srv' });
        const bundled = addRow('bundled', 'mcp', 'active', { source_url: 'mcp:foo/srv' });
        reconcile(evidence({
            mcpServers: new Set(['srv-extra', 'my-srv']),
            plugins: plugins({ 'foobar@m': { enabled: true, mcpServers: ['srv'] }, 'myfoo@m': { enabled: true } }),
        }));
        assert.equal(statusOf(plugin), 'broken');
        assert.equal(statusOf(mcp), 'broken');
        assert.equal(statusOf(bundled), 'broken');
    });
    it('writes no audit row and leaves updated_at alone when status is unchanged', () => {
        const id = addRow('p', 'plugin', 'active');
        const transitions = reconcile(evidence({ plugins: plugins({ 'p@m': { enabled: true } }) }));
        assert.deepEqual(transitions, []);
        assert.equal(healthAudits().length, 0);
        assert.equal(db.get('SELECT updated_at FROM cheatcodes WHERE id = ?', [id]).updated_at, 'then');
    });
    it('skips rows that are not active or broken', () => {
        const candidate = addRow('c', 'plugin', 'candidate');
        const approved = addRow('a', 'plugin', 'approved');
        const installed = addRow('i', 'plugin', 'installed');
        const transitions = reconcile(evidence({ plugins: plugins({}) }));
        assert.deepEqual(transitions, []);
        assert.equal(statusOf(candidate), 'candidate');
        assert.equal(statusOf(approved), 'approved');
        assert.equal(statusOf(installed), 'installed');
    });
    it('records the transition and a cheatcode_healthcheck audit row on the system issue', () => {
        const id = addRow('gone', 'plugin', 'active');
        const transitions = reconcile(evidence({ plugins: plugins({}) }));
        assert.deepEqual(transitions, [{ id, name: 'gone', kind: 'plugin', from: 'active', to: 'broken' }]);
        assert.equal(db.get('SELECT updated_at FROM cheatcodes WHERE id = ?', [id]).updated_at, NOW);
        const audits = healthAudits();
        assert.equal(audits.length, 1);
        assert.equal(audits[0].issue_id, -1);
        assert.equal(audits[0].branch_id, '');
        assert.equal(audits[0].from_node, 'server');
        assert.equal(audits[0].created_at, NOW);
        assert.equal(audits[0].summary, 'gone (plugin): active -> broken');
        assert.deepEqual(JSON.parse(audits[0].content_json), { name: 'gone', kind: 'plugin', from: 'active', to: 'broken' });
    });
    it('GH 2136: plugin: a different listed version rewrites version and updated_at, with no transition or audit row', () => {
        const id = addRow('tmb', 'plugin', 'active', { source_url: 'tmb@trustmybot', version: '1.1.0-rc.4' });
        const transitions = reconcile(evidence({ plugins: plugins({ 'tmb@trustmybot': { enabled: true, version: '1.2.0-dev.215.gh2130' } }) }));
        assert.deepEqual(versionRow(id), { version: '1.2.0-dev.215.gh2130', updated_at: NOW });
        assert.deepEqual(transitions, []);
        assert.equal(healthAudits().length, 0);
    });
    it('GH 2136: plugin: an equal, absent or empty listed version leaves version and updated_at untouched', () => {
        const equal = addRow('eq', 'plugin', 'active', { version: '1.0.0' });
        const absent = addRow('absent', 'plugin', 'active', { version: '1.0.0' });
        const empty = addRow('empty', 'plugin', 'active', { version: '1.0.0' });
        reconcile(evidence({
            plugins: plugins({
                'eq@m': { enabled: true, version: '1.0.0' },
                'absent@m': { enabled: true },
                'empty@m': { enabled: true, version: '' },
            }),
        }));
        for (const id of [equal, absent, empty])
            assert.deepEqual(versionRow(id), { version: '1.0.0', updated_at: 'then' });
    });
    it('GH 2136: plugin: no plugin listing leaves a stored version intact', () => {
        const id = addRow('p', 'plugin', 'active', { version: '1.0.0' });
        reconcile(evidence());
        assert.deepEqual(versionRow(id), { version: '1.0.0', updated_at: 'then' });
    });
    it('GH 2136: plugin: the enabled entry wins when two marketplaces list the same plugin', () => {
        const id = addRow('tmb', 'plugin', 'active', { source_url: 'tmb@trustmybot', version: '1.0.0' });
        reconcile(evidence({
            plugins: plugins({
                'tmb@trustmybot': { enabled: false, version: '1.1.0' },
                'tmb@trustmybot-dev': { enabled: true, version: '1.2.0-dev.1' },
            }),
        }));
        assert.equal(versionRow(id).version, '1.2.0-dev.1');
    });
    it('rejects a writer outside the event writer list', () => {
        addRow('gone', 'plugin', 'active');
        assert.throws(() => reconcileCheatcodes(db, evidence({ plugins: plugins({}) }), { fromNode: 'x', writer: 'hook', now: NOW, pluginRoot: root }));
    });
});
describe('probeChildEnv', () => {
    it('disables the healthcheck in any server the probe starts and preserves the parent env', () => {
        const env = probeChildEnv();
        assert.equal(env['TMB_DISABLE_CHEATCODE_HEALTHCHECK'], '1');
        assert.equal(env['PATH'], process.env['PATH']);
        for (const key of Object.keys(process.env)) {
            if (key !== 'TMB_DISABLE_CHEATCODE_HEALTHCHECK')
                assert.equal(env[key], process.env[key], key);
        }
    });
});
describe('reconcileAtStartup', () => {
    const saved = { flag: process.env['TMB_DISABLE_CHEATCODE_HEALTHCHECK'], path: process.env['PATH'] };
    afterEach(() => {
        for (const [key, value] of [
            ['TMB_DISABLE_CHEATCODE_HEALTHCHECK', saved.flag],
            ['PATH', saved.path],
        ]) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    });
    it('makes no probe and no DB change when TMB_DISABLE_CHEATCODE_HEALTHCHECK=1', async () => {
        const db = tempDB();
        db.run('DELETE FROM cheatcodes');
        const root = mkdtempSync(join(tmpdir(), 'reconcile-startup-'));
        const res = db.run(`INSERT INTO cheatcodes (name, kind, origin, description, source_url, file_path, scope, status, installed_at, created_at, updated_at)
       VALUES ('gone', 'skill', 'external', '', 'fixture:gone', ?, 'project-local', 'active', 'then', 'then', 'then')`, [join(root, 'missing', 'SKILL.md')]);
        const id = Number(res.lastInsertRowid);
        const bin = join(root, 'bin');
        mkdirSync(bin);
        const marker = join(root, 'claude-invoked');
        writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntouch '${marker}'\n`);
        chmodSync(join(bin, 'claude'), 0o755);
        process.env['PATH'] = `${bin}:${saved.path ?? ''}`;
        process.env['TMB_DISABLE_CHEATCODE_HEALTHCHECK'] = '1';
        await reconcileAtStartup(db);
        assert.equal(existsSync(marker), false);
        const row = db.get('SELECT status, updated_at FROM cheatcodes WHERE id = ?', [id]);
        assert.deepEqual({ ...row }, { status: 'active', updated_at: 'then' });
        assert.equal(db.get(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'cheatcode_healthcheck'`).n, 0);
    });
});
describe('reconcileAtStartup probe gating (GH 1698)', () => {
    const saved = {
        flag: process.env['TMB_DISABLE_CHEATCODE_HEALTHCHECK'],
        path: process.env['PATH'],
        home: process.env['HOME'],
    };
    let root;
    let home;
    let callLog;
    let db;
    const invocations = () => existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter((line) => line !== '') : [];
    const resetInvocations = () => writeFileSync(callLog, '');
    const cachePath = () => probeCachePath(root);
    const readCache = () => JSON.parse(readFileSync(cachePath(), 'utf8'));
    const addRow = (name, kind, status, sourceUrl, filePath = null) => Number(db.run(`INSERT INTO cheatcodes (name, kind, origin, description, source_url, file_path, scope, status, installed_at, created_at, updated_at)
         VALUES (?, ?, 'external', '', ?, ?, 'project-local', ?, 'then', 'then', 'then')`, [name, kind, sourceUrl, filePath, status]).lastInsertRowid);
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'reconcile-gate-'));
        home = join(root, 'home');
        mkdirSync(home);
        mkdirSync(join(root, 'project', '.claude', 'tmb'), { recursive: true });
        const bin = join(root, 'bin');
        mkdirSync(bin);
        callLog = join(root, 'claude-calls');
        writeFileSync(join(bin, 'claude'), [
            '#!/bin/sh',
            `echo "$*" >> '${callLog}'`,
            'if [ "$1" = mcp ]; then echo "srv: npx srv - Connected"; else echo "[]"; fi',
            '',
        ].join('\n'));
        chmodSync(join(bin, 'claude'), 0o755);
        process.env['PATH'] = `${bin}:${saved.path ?? ''}`;
        process.env['HOME'] = home;
        delete process.env['TMB_DISABLE_CHEATCODE_HEALTHCHECK'];
        root = join(root, 'project');
        db = tempDB({ path: join(root, '.claude', 'tmb', 'trajectory.db') });
        db.run('DELETE FROM cheatcodes');
    });
    afterEach(() => {
        db.close();
        for (const [key, value] of [
            ['TMB_DISABLE_CHEATCODE_HEALTHCHECK', saved.flag],
            ['PATH', saved.path],
            ['HOME', saved.home],
        ]) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    });
    it('spawns nothing when no mcp or plugin row is tracked, and still reconciles skill rows', async () => {
        const skill = addRow('gone', 'skill', 'active', 'fixture:gone', join(root, 'missing', 'SKILL.md'));
        addRow('candidate', 'plugin', 'candidate', 'fixture:candidate');
        await reconcileAtStartup(db);
        assert.deepEqual(invocations(), []);
        assert.equal(existsSync(cachePath()), false);
        assert.equal(db.get('SELECT status FROM cheatcodes WHERE id = ?', [skill]).status, 'broken');
    });
    it('probes once, skips while inputs are unchanged, and re-probes on a config edit or an expired cache', async () => {
        const srv = addRow('srv', 'mcp', 'broken', 'npx:srv');
        await reconcileAtStartup(db);
        assert.deepEqual(invocations().sort(), ['mcp list', 'plugin list --json']);
        assert.equal(db.get('SELECT status FROM cheatcodes WHERE id = ?', [srv]).status, 'active');
        const first = readCache();
        assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
        assert.equal(Number.isNaN(new Date(first.probed_at).getTime()), false);
        resetInvocations();
        await reconcileAtStartup(db);
        assert.deepEqual(invocations(), []);
        writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { srv: { command: 'npx' } } }));
        await reconcileAtStartup(db);
        assert.deepEqual(invocations().sort(), ['mcp list', 'plugin list --json']);
        assert.notEqual(readCache().fingerprint, first.fingerprint);
        resetInvocations();
        await reconcileAtStartup(db);
        assert.deepEqual(invocations(), []);
        const backdated = { ...readCache(), probed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
        writeFileSync(cachePath(), JSON.stringify(backdated));
        await reconcileAtStartup(db);
        assert.deepEqual(invocations().sort(), ['mcp list', 'plugin list --json']);
        assert.ok(Date.parse(readCache().probed_at) > Date.parse(backdated.probed_at));
    });
    it('ignores ~/.claude.json changes outside the fingerprinted keys', async () => {
        addRow('p', 'plugin', 'active', 'fixture:p');
        const claudeJson = (numStartups) => JSON.stringify({ numStartups, mcpServers: { srv: { command: 'npx' } }, projects: { [root]: { mcpServers: {} } } });
        writeFileSync(join(home, '.claude.json'), claudeJson(1));
        await reconcileAtStartup(db);
        assert.equal(invocations().length, 2);
        resetInvocations();
        writeFileSync(join(home, '.claude.json'), claudeJson(2));
        await reconcileAtStartup(db);
        assert.deepEqual(invocations(), []);
        writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 2, mcpServers: { srv: { command: 'npx' } }, projects: { [root]: { mcpServers: { x: {} } } } }));
        await reconcileAtStartup(db);
        assert.equal(invocations().length, 2);
    });
    it('probes when the cache file is corrupt', async () => {
        addRow('p', 'plugin', 'active', 'fixture:p');
        writeFileSync(cachePath(), '{not json');
        await reconcileAtStartup(db);
        assert.equal(invocations().length, 2);
        assert.match(readCache().fingerprint, /^[0-9a-f]{64}$/);
    });
    it('GH 2136: reconcileNow takes each listed plugin version from claude plugin list --json', async () => {
        const stale = addRow('tmb', 'plugin', 'active', 'tmb@trustmybot');
        const kept = addRow('kept', 'plugin', 'active', 'kept@m');
        db.run("UPDATE cheatcodes SET version = '1.1.0-rc.4' WHERE id = ?", [stale]);
        db.run("UPDATE cheatcodes SET version = '2.0.0' WHERE id = ?", [kept]);
        const listing = JSON.stringify([
            { id: 'tmb@trustmybot', enabled: true, version: '1.2.0-dev.215.gh2130' },
            { id: 'kept@m', enabled: true },
        ]);
        writeFileSync(join(dirname(root), 'bin', 'claude'), ['#!/bin/sh', `if [ "$1" = mcp ]; then echo ""; else echo '${listing}'; fi`, ''].join('\n'));
        await reconcileNow(db, { fromNode: 'bro', writer: 'bro' });
        const versionOf = (id) => db.get('SELECT version, updated_at FROM cheatcodes WHERE id = ?', [id]);
        assert.equal(versionOf(stale).version, '1.2.0-dev.215.gh2130');
        assert.notEqual(versionOf(stale).updated_at, 'then');
        assert.deepEqual({ ...versionOf(kept) }, { version: '2.0.0', updated_at: 'then' });
    });
    it('GH 2136: reconcileNow takes the version of the install in effect for the DB project, not the last one listed', async () => {
        const tmb = addRow('tmb', 'plugin', 'active', 'tmb@m');
        const away = addRow('away', 'plugin', 'active', 'away@m');
        db.run("UPDATE cheatcodes SET version = '0.9.0' WHERE id = ?", [tmb]);
        db.run("UPDATE cheatcodes SET version = '5.0.0' WHERE id = ?", [away]);
        const elsewhere = join(dirname(root), 'other-project');
        const listing = JSON.stringify([
            { id: 'tmb@m', version: '2.0.0', scope: 'local', enabled: true, projectPath: realpathSync(root) },
            { id: 'tmb@m', version: '3.0.0', scope: 'user', enabled: true },
            { id: 'tmb@m', version: '1.0.0', scope: 'local', enabled: true, projectPath: elsewhere },
            { id: 'away@m', version: '6.0.0', scope: 'local', enabled: true, projectPath: elsewhere },
        ]);
        writeFileSync(join(dirname(root), 'listing.json'), listing);
        writeFileSync(join(dirname(root), 'bin', 'claude'), ['#!/bin/sh', `if [ "$1" = mcp ]; then echo ""; else cat '${join(dirname(root), 'listing.json')}'; fi`, ''].join('\n'));
        await reconcileNow(db, { fromNode: 'bro', writer: 'bro' });
        const row = (id) => db.get('SELECT version, status FROM cheatcodes WHERE id = ?', [id]);
        assert.deepEqual({ ...row(tmb) }, { version: '2.0.0', status: 'active' });
        assert.deepEqual({ ...row(away) }, { version: '5.0.0', status: 'broken' });
    });
    it('reconcileNow always probes and refreshes the cache', async () => {
        await reconcileNow(db, { fromNode: 'bro', writer: 'bro' });
        assert.equal(invocations().length, 2);
        const cache = readCache();
        assert.match(cache.fingerprint, /^[0-9a-f]{64}$/);
        resetInvocations();
        await reconcileNow(db, { fromNode: 'bro', writer: 'bro' });
        assert.equal(invocations().length, 2);
        assert.equal(readCache().fingerprint, cache.fingerprint);
    });
});
describe('selectProjectInstalls (GH 2136)', () => {
    const root = '/nonexistent/gh2136-project';
    const other = join(root, 'other');
    const pick = (list, projectRoot = root) => Object.fromEntries([...selectProjectInstalls(list, projectRoot)].map(([id, e]) => [id, e === null ? null : e['version']]));
    it('GH 2136: local at the project root beats project, which beats user; other projects never apply', () => {
        assert.deepEqual(pick([
            { id: 'a@m', version: 'user', scope: 'user' },
            { id: 'a@m', version: 'local-other', scope: 'local', projectPath: other },
            { id: 'a@m', version: 'local-here', scope: 'local', projectPath: root },
            { id: 'a@m', version: 'project-here', scope: 'project', projectPath: root },
            { id: 'b@m', version: 'user', scope: 'user' },
            { id: 'b@m', version: 'project-here', scope: 'project', projectPath: `${root}/` },
            { id: 'c@m', version: 'local-other', scope: 'local', projectPath: other },
            { id: 'c@m', version: 'user', scope: 'user' },
            { id: 'd@m', version: 'unscoped' },
            { id: 'e@m', version: 'local-other', scope: 'local', projectPath: other },
        ]), { 'a@m': 'local-here', 'b@m': 'project-here', 'c@m': 'user', 'd@m': 'unscoped', 'e@m': null });
    });
    it('GH 2136: with no project root only user installs apply', () => {
        assert.deepEqual(pick([{ id: 'a@m', version: 'local', scope: 'local', projectPath: root }, { id: 'b@m', version: 'user', scope: 'user' }], null), { 'a@m': null, 'b@m': 'user' });
    });
});
//# sourceMappingURL=cheatcode-reconcile.test.js.map