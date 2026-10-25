/**
 * The TypeScript containment-guard gate (GH 1692) where it is stricter than
 * scripts/hooks/containment-guard.sh: an analyzer line `UNRESOLVED:$(parse):…`
 * or `UNRESOLVED:$(computed):…` is always denied, even when its raw text
 * starts with a literal path inside the root (which the .sh's literal-dir
 * allowance would let through). Everything else is the parity corpus's job.
 * The deny's phrase is pinned to dispatch.sh's UNJUDGED_PHRASE, which keeps
 * such a deny from recording boundary-deny paths (GH 1750); the deny of a
 * target behind a variable, substitution or cd the guard cannot resolve
 * carries it too (GH 1772).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { containmentGuard, containmentGuardWith, NEVER_JUDGED, UNJUDGED_PHRASE, } from '../hooks/containment-guard.js';
import { findGate } from '../hooks/registry.js';
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const FAKE_UID = 4242424;
const DISPATCH = readFileSync(join(SERVER_ROOT, '../../scripts/hooks/dispatch.sh'), 'utf8');
/** dispatch.sh's unjudged_deny run on <reason>: true when it records no boundary-deny path. */
function unjudgedDeny(reason) {
    const fn = DISPATCH.match(/^unjudged_deny\(\) \{\n[\s\S]*?\n\}$/m);
    assert.ok(fn, 'dispatch.sh defines unjudged_deny');
    try {
        execFileSync('bash', ['-c', `UNJUDGED_PHRASE='${UNJUDGED_PHRASE}'\n${fn[0]}\nunjudged_deny "$1"`, '_', reason]);
        return true;
    }
    catch {
        return false;
    }
}
const PARSE_TEXT = 'the command could not be parsed, so its write targets are unknown; split it or fix its quoting.';
const COMPUTED_TEXT = 'the program builds the path at run time (a computed or argv path, a program held in a variable, a substitution or stdin, or an exec placeholder under `sh -c`), so the guard cannot tell where it writes; use Edit or Write on the literal path, or a Bash command whose write target is a literal path.';
function reason(stdout) {
    if (stdout === '')
        return null;
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    return out.hookSpecificOutput.permissionDecisionReason;
}
describe('containment-guard (TS): denies that judge no path', () => {
    let sandbox;
    let project;
    let db;
    let env;
    const realGetuid = process.getuid;
    before(() => {
        process.getuid = () => FAKE_UID;
        sandbox = mkdtempSync(join(tmpdir(), 'tmb-cg-unit-'));
        project = join(sandbox, 'project');
        db = join(project, '.claude/tmb/trajectory.db');
        mkdirSync(join(project, 'src'), { recursive: true });
        mkdirSync(dirname(db), { recursive: true });
        const d = new DatabaseSync(db);
        d.exec(SCHEMA);
        d.close();
        env = {
            PATH: process.env.PATH,
            HOME: join(sandbox, 'home'),
            CLAUDE_PROJECT_DIR: project,
            CLAUDE_CONFIG_DIR: join(sandbox, 'cc'),
            TMB_MODEL_CACHE_DIR: join(sandbox, 'cache'),
            TMPDIR: join(sandbox, 'host-tmp'),
        };
    });
    after(() => {
        process.getuid = realGetuid;
        rmSync(sandbox, { recursive: true, force: true });
    });
    const bash = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: project, tool_input: { command } });
    const lines = (...out) => async () => out;
    function denials() {
        const d = new DatabaseSync(db, { readOnly: true });
        try {
            return d
                .prepare("SELECT summary, content_json AS content FROM audit WHERE event_type = 'containment_denied' ORDER BY id")
                .all();
        }
        finally {
            d.close();
        }
    }
    it('the registry runs this gate under containment-guard', () => {
        assert.equal(findGate('containment-guard'), containmentGuard);
    });
    it('control: another unresolved variable behind an in-root literal dir is allowed', async () => {
        const raw = `${project}/src/$OUT`;
        const r = await containmentGuardWith(lines(`UNRESOLVED:OUT:${raw}`))(bash('x'), env);
        assert.deepEqual(r, { stdout: '', code: 0 });
    });
    it('denies $(parse) whose raw text starts with an in-root literal path', async () => {
        const raw = `${project}/src/a "unterminated`;
        const before = denials().length;
        const r = await containmentGuardWith(lines(`UNRESOLVED:$(parse):${raw}`))(bash('x'), env);
        assert.equal(r.code, 0);
        assert.equal(reason(r.stdout), `BLOCKED: write target "${raw}" cannot be judged: ${PARSE_TEXT}`);
        const rows = denials();
        assert.equal(rows.length, before + 1, 'one containment_denied row');
        assert.equal(rows.at(-1)?.summary, `Bash denied: ${raw} is outside ${project}`);
        assert.deepEqual(JSON.parse(rows.at(-1)?.content ?? ''), { tool: 'Bash', path: raw, root: project, task_id: null });
    });
    it('denies $(computed) whose raw text starts with an in-root literal path', async () => {
        const raw = `${project}/src/$(computed)`;
        const r = await containmentGuardWith(lines(`UNRESOLVED:$(computed):${raw}`))(bash('x'), env);
        assert.equal(reason(r.stdout), `BLOCKED: write target "${raw}" cannot be judged: ${COMPUTED_TEXT}`);
    });
    it('denies $(computed) even when the raw text holds no variable at all', async () => {
        const raw = `${project}/src/out.txt`;
        const r = await containmentGuardWith(lines(`UNRESOLVED:$(computed):${raw}`))(bash('x'), env);
        assert.equal(reason(r.stdout), `BLOCKED: write target "${raw}" cannot be judged: ${COMPUTED_TEXT}`);
    });
    it('denies a real analyzer $(parse): an unclosed quote after cd into the root', async () => {
        const command = `cd ${project}/src && echo "x > a`;
        const r = await containmentGuard(bash(command), env);
        const raw = [...command].slice(0, 80).join('');
        assert.equal(reason(r.stdout), `BLOCKED: write target "${raw}" cannot be judged: ${PARSE_TEXT}`);
    });
    it("dispatch.sh's UNJUDGED_PHRASE is the deny's phrase, and no reason text holds the quote it stops at", () => {
        assert.deepEqual(DISPATCH.match(/^UNJUDGED_PHRASE='([^']*)'$/gm), [`UNJUDGED_PHRASE='${UNJUDGED_PHRASE}'`]);
        assert.deepEqual(Object.keys(NEVER_JUDGED).sort(), ['$(computed)', '$(parse)']);
        for (const text of Object.values(NEVER_JUDGED))
            assert.ok(!text.includes('"'), text);
    });
    for (const variable of ['$(proc)', '$(alias-write)', '$()', 'PWD', '', 'OUT']) {
        it(`an unresolved ${variable || "''"} target outside the root is denied as unjudged (GH 1772)`, async () => {
            const raw = '/etc/tmb-cg/$OUT';
            const r = await containmentGuardWith(lines(`UNRESOLVED:${variable}:${raw}`))(bash('x'), env);
            const why = reason(r.stdout) ?? '';
            assert.ok(why.startsWith(`BLOCKED: write target "${raw}" ${UNJUDGED_PHRASE} `), why);
            assert.ok(unjudgedDeny(why), `dispatch.sh records paths for: ${why}`);
        });
    }
    it('a judged deny of a literal target outside the root is not unjudged', async () => {
        const r = await containmentGuard(bash('echo x > /etc/tmb-cg/a'), env);
        const why = reason(r.stdout) ?? '';
        assert.ok(!why.includes(UNJUDGED_PHRASE), why);
        assert.equal(unjudgedDeny(why), false);
    });
    it('a bare in-root redirect still passes, so the denials above are the reasons, not the paths', async () => {
        const r = await containmentGuard(bash(`echo x > ${project}/src/a`), env);
        assert.deepEqual(r, { stdout: '', code: 0 });
    });
});
//# sourceMappingURL=hooks-containment-guard.test.js.map