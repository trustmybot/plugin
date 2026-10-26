/**
 * swe-boundary rule (c) and the swe's own session scratchpad (GH 1912): a
 * Write under <canonical /tmp>/claude-<uid>/<project>/<session_id>/scratchpad/
 * is admitted, in the /tmp and the canonical spelling, when that dir is a real
 * dir this user owns; another session's scratchpad, a symlinked scratchpad,
 * /tmp/other, $HOME, /tmp/claude-<uid> itself and a payload with no session_id
 * keep the rule-(c) deny, whose message names the scratch root.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HOOK = join(PLUGIN_ROOT, 'scripts/hooks/swe-boundary.sh');
const NOW = '2026-10-25T10:00:00.000Z';
const UID = process.getuid?.() ?? 0;
describe('swe-boundary: the session scratchpad (GH 1912)', () => {
    let sandbox;
    let project;
    let wt;
    let home;
    let transcript;
    let env;
    const realTmp = realpathSync('/tmp');
    const harness = join(realTmp, `claude-${UID}`);
    const harnessCreated = !existsSync(harness);
    const slug = `tmb-1912-test-${randomUUID()}`;
    const slugB = `${slug}-b`;
    const sid = randomUUID();
    const otherSid = randomUUID();
    const linkSid = randomUUID();
    const twiceSid = randomUUID();
    const scratch = (s, spelling = '/tmp', project = slug) => `${spelling}/claude-${UID}/${project}/${s}/scratchpad`;
    before(() => {
        sandbox = mkdtempSync(join(tmpdir(), 'tmb-swe-scratchpad-'));
        project = join(sandbox, 'project');
        wt = join(project, '.claude/worktrees/sp-task');
        home = join(sandbox, 'home');
        const db = join(project, '.claude/tmb/trajectory.db');
        for (const dir of [join(wt, 'src'), dirname(db), home])
            mkdirSync(dir, { recursive: true });
        const d = new DatabaseSync(db);
        d.exec(readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
        d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', project);
        d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'scratch', 'open', ?, ?)").run(NOW, NOW);
        d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo) VALUES (5, 7, 'fix/sp-task', 'd', 'running', ?, ?, 'project')").run(NOW, NOW);
        d.close();
        transcript = join(sandbox, 'spawn-5.jsonl');
        writeFileSync(transcript, '{"message":{"content":[{"type":"text","text":"task_id=5"}]}}\n');
        for (const s of [sid, otherSid, twiceSid])
            mkdirSync(scratch(s, realTmp), { recursive: true });
        mkdirSync(scratch(twiceSid, realTmp, slugB), { recursive: true });
        const elsewhere = join(harness, slug, 'elsewhere');
        mkdirSync(elsewhere, { recursive: true });
        mkdirSync(dirname(scratch(linkSid, realTmp)), { recursive: true });
        symlinkSync(elsewhere, scratch(linkSid, realTmp));
        env = {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_PROJECT_DIR: project,
            TMPDIR: process.env.TMPDIR,
        };
    });
    after(() => {
        rmSync(sandbox, { recursive: true, force: true });
        rmSync(join(harness, slug), { recursive: true, force: true });
        rmSync(join(harness, slugB), { recursive: true, force: true });
        if (harnessCreated) {
            try {
                rmdirSync(harness);
            }
            catch {
                /* another run still holds files under it */
            }
        }
    });
    function write(target, session) {
        const payload = {
            hook_event_name: 'PreToolUse',
            tool_name: 'Write',
            cwd: wt,
            agent_type: 'tmb:swe',
            agent_transcript_path: transcript,
            tool_input: { file_path: target, content: 'x' },
        };
        if (session !== null)
            payload.session_id = session;
        const r = spawnSync('bash', [HOOK], { input: JSON.stringify(payload), env, cwd: wt, encoding: 'utf8', timeout: 20_000 });
        if (r.error)
            throw r.error;
        return { code: r.status, stdout: r.stdout };
    }
    function denyReason(stdout) {
        assert.notEqual(stdout.trim(), '', 'the hook denies');
        const out = JSON.parse(stdout);
        assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
        return out.hookSpecificOutput.permissionDecisionReason;
    }
    const ruleC = (target) => `BLOCKED: SWE may only edit files inside its assigned worktree (${wt}) of task 5. Target '${target}' is outside the worktree.`;
    const pattern = `/tmp/claude-${UID}/<project>/<session_id>/scratchpad/`;
    function assertRuleC(target, session, root) {
        const r = write(target, session);
        assert.equal(r.code, 0);
        assert.equal(denyReason(r.stdout), `${ruleC(target)} Scratch files go in this session's scratchpad, ${root}.`);
    }
    it('control: a Write inside the worktree is allowed', () => {
        assert.deepEqual(write(join(wt, 'src/a.ts'), sid), { code: 0, stdout: '' });
    });
    it('allows a Write to its own scratchpad in the /tmp spelling', () => {
        assert.deepEqual(write(`${scratch(sid)}/x.txt`, sid), { code: 0, stdout: '' });
    });
    it('allows a Write to its own scratchpad in the canonical (/private/tmp on macOS) spelling', () => {
        assert.deepEqual(write(`${scratch(sid, realTmp)}/x.txt`, sid), { code: 0, stdout: '' });
    });
    it('allows a Write to a nested path under its own scratchpad', () => {
        assert.deepEqual(write(`${scratch(sid)}/a/b/x.txt`, sid), { code: 0, stdout: '' });
    });
    it("denies a Write to another session's scratchpad, naming its own", () => {
        assertRuleC(`${scratch(otherSid)}/x.txt`, sid, `${scratch(sid, realTmp)}/`);
    });
    it('denies a .. that climbs from its scratchpad into another session', () => {
        assertRuleC(`${scratch(sid)}/../../${otherSid}/scratchpad/x.txt`, sid, `${scratch(sid, realTmp)}/`);
    });
    it('denies a Write to a scratchpad that is a symlink', () => {
        assertRuleC(`${scratch(linkSid)}/x.txt`, linkSid, pattern);
    });
    it('denies /tmp/other/x', () => {
        assertRuleC('/tmp/other/x', sid, `${scratch(sid, realTmp)}/`);
    });
    it('denies $HOME/x', () => {
        assertRuleC(join(home, 'x'), sid, `${scratch(sid, realTmp)}/`);
    });
    it('denies /tmp/claude-<uid>/x, outside any scratchpad', () => {
        assertRuleC(`/tmp/claude-${UID}/x`, sid, `${scratch(sid, realTmp)}/`);
    });
    it('denies the scratchpad dir path itself', () => {
        assertRuleC(scratch(sid), sid, `${scratch(sid, realTmp)}/`);
    });
    it('denies a payload with no session_id, naming the pattern', () => {
        assertRuleC(`${scratch(sid)}/x.txt`, null, pattern);
    });
    it('denies a session_id with a slash or a leading dot', () => {
        assertRuleC(`${scratch(sid)}/x.txt`, `../${sid}`, pattern);
        assertRuleC(`/tmp/claude-${UID}/${slug}/.hidden/scratchpad/x.txt`, '.hidden', pattern);
    });
    it('names the pattern when the session has no scratchpad', () => {
        assertRuleC('/tmp/other/x', randomUUID(), pattern);
    });
    it('names the pattern when the session has two scratchpads, and still admits each', () => {
        assertRuleC('/tmp/other/x', twiceSid, pattern);
        assert.deepEqual(write(`${scratch(twiceSid)}/x.txt`, twiceSid), { code: 0, stdout: '' });
        assert.deepEqual(write(`${scratch(twiceSid, '/tmp', slugB)}/x.txt`, twiceSid), { code: 0, stdout: '' });
    });
});
//# sourceMappingURL=swe-boundary-scratchpad.test.js.map