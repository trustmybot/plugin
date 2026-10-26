/**
 * The code-reviewer-spawn-note gate (GH 1744): a code-reviewer spawn prompt
 * carries its name=value anchors and at most 300 chars of other prose; more
 * is denied with a pointer to bro_atomic_close's spawn_note. Bypass env and
 * other agent types allow.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BYPASS_ENV, codeReviewerSpawnNote, spawnProse } from '../hooks/code-reviewer-spawn-note.js';
import { findGate, gateNames } from '../hooks/registry.js';
const ANCHORS = "task_id=12 commit_sha=abc1234def branch_id=feat/12-x repo=plugin repo_path='/work/my plugin' attempt_n=2 subagent_session_id=sess-1";
function payload(prompt, subagentType = 'code-reviewer', toolName = 'Agent') {
    return JSON.stringify({ tool_name: toolName, tool_input: { subagent_type: subagentType, effort: 'high', prompt } });
}
function decision(stdout) {
    if (stdout === '')
        return null;
    const out = JSON.parse(stdout);
    return { decision: out.hookSpecificOutput.permissionDecision, reason: out.hookSpecificOutput.permissionDecisionReason };
}
const LONG = 'The reviewer could read this from task_brief instead. '.repeat(7);
describe('code-reviewer-spawn-note gate', () => {
    it('is registered under its name', () => {
        assert.equal(findGate('code-reviewer-spawn-note'), codeReviewerSpawnNote);
        assert.ok(gateNames().includes('code-reviewer-spawn-note'));
    });
    it('strips the seven anchors, quoted values included, and collapses whitespace', () => {
        assert.equal(spawnProse(`${ANCHORS}\n\n  Check   the migration.  `), 'Check the migration.');
        assert.equal(spawnProse(ANCHORS), '');
    });
    it('allows the anchors alone and the anchors plus a short line', () => {
        assert.equal(codeReviewerSpawnNote(payload(ANCHORS), {}).stdout, '');
        assert.equal(codeReviewerSpawnNote(payload(`${ANCHORS} Focus on the v48 migration.`), {}).stdout, '');
    });
    it('allows exactly 300 chars of prose and denies 301', () => {
        assert.equal(codeReviewerSpawnNote(payload(`${ANCHORS} ${'x'.repeat(300)}`), {}).stdout, '');
        const d = decision(codeReviewerSpawnNote(payload(`${ANCHORS} ${'x'.repeat(301)}`), {}).stdout);
        assert.equal(d?.decision, 'deny');
        assert.match(d.reason, /301 characters/);
    });
    it('denies a long prompt, telling bro to store the context as spawn_note via bro_atomic_close', () => {
        const r = codeReviewerSpawnNote(payload(`${ANCHORS}\n${LONG}`), {});
        assert.equal(r.code, 0);
        const d = decision(r.stdout);
        assert.equal(d?.decision, 'deny');
        assert.match(d.reason, /spawn_note/);
        assert.match(d.reason, /bro_atomic_close/);
        assert.match(d.reason, /300/);
    });
    it(`allows a long prompt when ${BYPASS_ENV}=1`, () => {
        assert.equal(codeReviewerSpawnNote(payload(`${ANCHORS}\n${LONG}`), { [BYPASS_ENV]: '1' }).stdout, '');
    });
    it('allows other agent types and other tools untouched', () => {
        assert.equal(codeReviewerSpawnNote(payload(`task_id=12 ${LONG}`, 'swe'), {}).stdout, '');
        assert.equal(codeReviewerSpawnNote(payload(LONG, 'consultant'), {}).stdout, '');
        assert.equal(codeReviewerSpawnNote(payload(LONG, 'code-reviewer', 'Bash'), {}).stdout, '');
    });
    it('judges a namespaced code-reviewer subagent_type the same', () => {
        const d = decision(codeReviewerSpawnNote(payload(`${ANCHORS}\n${LONG}`, 'tmb:code-reviewer'), {}).stdout);
        assert.equal(d?.decision, 'deny');
    });
});
//# sourceMappingURL=hooks-code-reviewer-spawn-note.test.js.map