/**
 * The TypeScript remote-id-guard's in-process deadline (GH 1821, GH 1861) and
 * the decision-703 divergences from scripts/hooks/remote-id-guard.sh. The
 * overrun path is reached through TMB_REMOTE_ID_GUARD_TEST_OVERRUN=1, which
 * makes the budget read as spent from the start: no test waits on the clock.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { candidateTokens, deadlineSeconds, GATE_NAME, printfB } from '../hooks/remote-id-guard.js';
import { findGate } from '../hooks/registry.js';
import { localIssuesDb } from './hooks-remote-id-guard-parity.suite.js';
import { noCmdPath } from './hooks-swe-run-parity.suite.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const CITES_FIVE = "gh pr create --title x --body 'Closes #5'";
const UNSET = ['TMB_DISABLE_REMOTE_ID_GUARD', 'TMB_REMOTE_ID_GUARD_DEADLINE_S', 'TMB_REMOTE_ID_GUARD_TEST_OVERRUN', 'TMB_HOOKS_SQLITE', 'LANG', 'LC_CTYPE'];
const OVERRUN_LINE = /^remote-id-guard: analysis passed its (\S+)s deadline \(TMB_REMOTE_ID_GUARD_DEADLINE_S\) after (\d+\.\d{3})s; allowing\n$/;
function reason(stdout) {
    if (stdout === '')
        return '';
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    return out.hookSpecificOutput.permissionDecisionReason;
}
describe('remote-id-guard: in-process deadline and decision-703 divergences', () => {
    let dir;
    let db;
    const run = (command, extra = {}) => {
        const env = { ...process.env };
        for (const key of UNSET)
            delete env[key];
        Object.assign(env, { CLAUDE_PROJECT_DIR: join(dir, 'project'), TRAJECTORY_DB_PATH: db, LC_ALL: 'C', ...extra });
        const r = spawnSync(process.execPath, [HOOKS_BUNDLE, GATE_NAME], {
            input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
            env,
            cwd: dir,
            encoding: 'utf8',
            timeout: 30_000,
        });
        if (r.error)
            throw r.error;
        return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const overrunRows = () => {
        const handle = new DatabaseSync(db, { readOnly: true });
        try {
            return handle.prepare("SELECT issue_id, from_node, event_type, summary, content_json FROM audit WHERE event_type = 'remote_id_guard_overrun' ORDER BY id").all();
        }
        finally {
            handle.close();
        }
    };
    before(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-rig-')));
        db = join(dir, 'db/trajectory.db');
        localIssuesDb(db);
    });
    after(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    it('is registered in the gate registry', () => {
        assert.ok(findGate(GATE_NAME));
    });
    it('denies a local id that names a different remote issue', () => {
        const r = run(CITES_FIVE);
        assert.equal(r.code, 0);
        assert.ok(reason(r.stdout).includes('#5 → #42 (GitHub)'), r.stdout);
    });
    it('on overrun allows, prints one stderr line and writes one audit row on issue -1', () => {
        const before = overrunRows().length;
        const r = run(CITES_FIVE, { TMB_REMOTE_ID_GUARD_TEST_OVERRUN: '1', TMB_REMOTE_ID_GUARD_DEADLINE_S: '1' });
        assert.equal(r.code, 0);
        assert.equal(r.stdout, '', 'allowed');
        const line = OVERRUN_LINE.exec(r.stderr);
        assert.ok(line, r.stderr);
        assert.equal(line[1], '1');
        assert.ok(Number(line[2]) >= 1, line[2]);
        const rows = overrunRows();
        assert.equal(rows.length, before + 1);
        const row = rows[rows.length - 1];
        assert.equal(row.issue_id, -1);
        assert.equal(row.from_node, 'hook:remote-id-guard');
        assert.equal(row.summary, 'remote-id-guard allowed a Bash command: its analysis passed the 1s deadline');
        const content = JSON.parse(row.content_json);
        assert.equal(content.deadline_s, 1);
        assert.ok(content.elapsed_s >= 1, row.content_json);
    });
    it('on overrun with no DB still allows with the stderr line', () => {
        const r = run(CITES_FIVE, { TMB_REMOTE_ID_GUARD_TEST_OVERRUN: '1', TRAJECTORY_DB_PATH: join(dir, 'no-such.db') });
        assert.equal(r.code, 0);
        assert.equal(r.stdout, '');
        assert.match(r.stderr, OVERRUN_LINE);
    });
    it('an invalid deadline falls back to 3 s', () => {
        for (const bad of ['abc', '0', '00', '01', '1.', '.5', '-1', '0.0', '', ' 2'])
            assert.equal(deadlineSeconds({ TMB_REMOTE_ID_GUARD_DEADLINE_S: bad }), '3', JSON.stringify(bad));
        for (const good of ['1', '2.5', '0.5', '10'])
            assert.equal(deadlineSeconds({ TMB_REMOTE_ID_GUARD_DEADLINE_S: good }), good);
        assert.equal(deadlineSeconds({}), '3');
        const r = run(CITES_FIVE, { TMB_REMOTE_ID_GUARD_TEST_OVERRUN: '1', TMB_REMOTE_ID_GUARD_DEADLINE_S: 'abc' });
        assert.equal(OVERRUN_LINE.exec(r.stderr)?.[1], '3', r.stderr);
        assert.ok(reason(run(CITES_FIVE, { TMB_REMOTE_ID_GUARD_DEADLINE_S: 'abc' }).stdout).includes('#5 → #42'));
    });
    it('the bypass allows before any analysis', () => {
        const r = run(CITES_FIVE, { TMB_DISABLE_REMOTE_ID_GUARD: '1', TMB_REMOTE_ID_GUARD_TEST_OVERRUN: '1' });
        assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
    });
    it('decision 703: a command tree-sitter cannot parse is allowed', () => {
        const r = run("gh pr create --title x --body 'Closes #5");
        assert.equal(r.code, 0);
        assert.equal(r.stdout, '');
    });
    it('decision 703: no jq and no sqlite3 CLI on PATH still denies', () => {
        const path = process.env.PATH ?? '';
        for (const cmd of ['jq', 'sqlite3']) {
            const r = run(CITES_FIVE, { PATH: noCmdPath(join(dir, `no-${cmd}`), cmd, path) });
            assert.equal(r.code, 0, `${cmd}: ${r.stderr}`);
            assert.ok(reason(r.stdout).includes('#5 → #42 (GitHub)'), `${cmd}: ${r.stdout}`);
        }
    });
    it('printfB reads escapes as bash printf %b does', () => {
        for (const text of ['back\\slash \\t tab \\x41 \\101 \\c cut', 'a\\nb\\\\c', '\\0101\\08\\1x', '\\e\\E\\a\\v\\f\\r', '\\u00e9 ü \\q', 'trail\\', 'two\\n\\n']) {
            const bash = spawnSync('bash', ['-c', 'printf "%b" "$1"', '_', text], { encoding: 'utf8' });
            assert.equal(printfB(text), bash.stdout.replace(/\0/g, '').replace(/\n+$/, ''), JSON.stringify(text));
        }
    });
    it('candidateTokens drops remote markers and sorts unique ids', () => {
        assert.deepEqual(candidateTokens('see #5 #5 #12 GH-7 gl-6 remote:8 o/r#9 #042'), ['042', '12', '5']);
    });
});
//# sourceMappingURL=hooks-remote-id-guard.test.js.map