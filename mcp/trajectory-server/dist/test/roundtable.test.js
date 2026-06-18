import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { roundtableTools } from '../tools/roundtable.js';
import { issueTools } from '../tools/issues.js';
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
async function call(handlers, name, args) {
    const handler = handlers[name];
    assert.ok(handler, `Handler not found: ${name}`);
    return handler(args);
}
describe('roundtable tools', () => {
    let db;
    let issueId;
    before(async () => {
        db = tempDB();
        // Seed enough slash-invoke audit rows to cover all roundtable_create calls
        // in the shared-db test suite. Each successful create consumes one row (#356).
        // 20 rows covers all creates in this suite with margin.
        for (let i = 0; i < 20; i++) {
            db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
         VALUES (-1, NULL, 'system', 'roundtable_slash_invoked', 'test fixture: gate cleared', '{}', datetime('now'))`);
        }
        const issues = issueTools(db);
        const result = await call(issues.handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'],
            agent: 'bro',
            objective: 'roundtable test carrier issue',
            description: '# Roundtable test',
        });
        const issue = parseResult(result);
        assert.ok(!result.isError, `issue_create failed: ${JSON.stringify(issue)}`);
        issueId = issue.id;
    });
    after(() => {
        db.close();
    });
    describe('roundtable_create', () => {
        it('happy path: creates a roundtable and returns roundtable_id + state=collecting', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: issueId,
                topic: 'Should we adopt the new architecture?',
                expected_participants: 3,
            });
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
            const data = parseResult(result);
            assert.ok(typeof data.roundtable_id === 'number', 'roundtable_id must be a number');
            assert.ok(data.roundtable_id > 0, 'roundtable_id must be positive');
            assert.equal(data.state, 'collecting', 'initial state must be collecting');
            globalThis['rt1Id'] = data.roundtable_id;
        });
        it('rejects expected_participants < 2', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: issueId,
                topic: 'too few',
                expected_participants: 1,
            });
            assert.ok(result.isError, 'Expected isError=true for expected_participants=1');
            const data = parseResult(result);
            assert.ok(data.error.includes('expected_participants'), 'Error mentions expected_participants');
        });
        it('rejects expected_participants > 5', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: issueId,
                topic: 'too many',
                expected_participants: 6,
            });
            assert.ok(result.isError, 'Expected isError=true for expected_participants=6');
            const data = parseResult(result);
            assert.ok(data.error.includes('expected_participants'), 'Error mentions expected_participants');
        });
        it('role rejection: consultant (architect) cannot call roundtable_create', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'architect',
                issue_id: issueId,
                topic: 'forbidden topic',
                expected_participants: 2,
            });
            assert.ok(result.isError, 'Expected isError=true for consultant');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
            assert.equal(data.caller_role, 'consultant');
        });
        it('role rejection: swe cannot call roundtable_create', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'swe',
                issue_id: issueId,
                topic: 'forbidden topic',
                expected_participants: 2,
            });
            assert.ok(result.isError, 'Expected isError=true for swe');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
        });
        it('role rejection: pr-reviewer cannot call roundtable_create', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'pr-reviewer',
                issue_id: issueId,
                topic: 'forbidden topic',
                expected_participants: 2,
            });
            assert.ok(result.isError, 'Expected isError=true for pr-reviewer');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
        });
    });
    describe('roundtable_vote', () => {
        it('happy path: records a participant vote', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: roundtableId,
                participant: 'ceo',
                vote: 'strongly in favor',
                rationale: 'Aligns with our Q3 growth strategy',
            });
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
            const data = parseResult(result);
            assert.ok(typeof data.vote_id === 'number', 'vote_id must be a number');
            assert.ok(data.vote_id > 0, 'vote_id must be positive');
        });
        it('participant=human while state=collecting is allowed but does NOT auto-flip state', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'human-vote-collecting-test',
                description: '',
            });
            const localIssueId = parseResult(issueResult).id;
            const createResult = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'human vote in collecting state test',
                expected_participants: 2,
            });
            const localRtId = parseResult(createResult).roundtable_id;
            const voteResult = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: localRtId,
                participant: 'human',
                vote: 'ratified',
                rationale: 'Human approved early',
            });
            assert.ok(!voteResult.isError, 'Human vote in collecting state should succeed');
            const data = parseResult(voteResult);
            assert.equal(data.state, 'collecting', 'State must stay collecting after human vote in collecting');
        });
        it('auto-flips state to awaiting_human when Nth distinct non-human participant votes', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'auto-flip-test',
                description: '',
            });
            const localIssueId = parseResult(issueResult).id;
            const createResult = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'auto-flip state test',
                expected_participants: 2,
            });
            const localRtId = parseResult(createResult).roundtable_id;
            const v1 = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: localRtId,
                participant: 'ceo',
                vote: 'in favor',
            });
            assert.ok(!v1.isError);
            assert.equal(parseResult(v1).state, 'collecting', 'Still collecting after 1 of 2');
            const v2 = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: localRtId,
                participant: 'cto',
                vote: 'in favor',
            });
            assert.ok(!v2.isError);
            assert.equal(parseResult(v2).state, 'awaiting_human', 'State flips to awaiting_human after Nth participant');
        });
        it('rejects vote when state=closed', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'vote-closed-test',
                description: '',
            });
            const localIssueId = parseResult(issueResult).id;
            const createResult = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'vote in closed roundtable',
                expected_participants: 2,
            });
            const localRtId = parseResult(createResult).roundtable_id;
            await call(rt.handlers, 'roundtable_close', {
                agent: 'bro',
                roundtable_id: localRtId,
                outcome: 'skipped for test',
                skip: true,
            });
            const voteResult = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: localRtId,
                participant: 'ceo',
                vote: 'too late',
            });
            assert.ok(voteResult.isError, 'Vote on closed roundtable should error');
            assert.ok(parseResult(voteResult).error.includes('invalid_state'), 'Error is invalid_state');
        });
        it('multiple votes per roundtable are allowed', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const participants = ['cto', 'pm'];
            for (const participant of participants) {
                const result = await call(rt.handlers, 'roundtable_vote', {
                    agent: 'bro',
                    roundtable_id: roundtableId,
                    participant,
                    vote: 'in favor',
                    rationale: `${participant} position`,
                });
                assert.ok(!result.isError, `Expected no error for ${participant}: ${JSON.stringify(parseResult(result))}`);
            }
        });
        it('vote without rationale (optional) succeeds', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: roundtableId,
                participant: 'architect',
                vote: 'neutral',
            });
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        });
        it('role rejection: consultant (architect) cannot call roundtable_vote', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'architect',
                roundtable_id: roundtableId,
                participant: 'architect',
                vote: 'in favor',
            });
            assert.ok(result.isError, 'Expected isError=true for consultant');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
            assert.equal(data.caller_role, 'consultant');
        });
        it('role rejection: swe cannot call roundtable_vote', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'swe',
                roundtable_id: roundtableId,
                participant: 'swe',
                vote: 'in favor',
            });
            assert.ok(result.isError, 'Expected isError=true for swe');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
        });
        it('role rejection: pr-reviewer cannot call roundtable_vote', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'pr-reviewer',
                roundtable_id: roundtableId,
                participant: 'pr-reviewer',
                vote: 'in favor',
            });
            assert.ok(result.isError, 'Expected isError=true for pr-reviewer');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
        });
        it('errors on unknown roundtable_id', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: -1,
                participant: 'ceo',
                vote: 'in favor',
            });
            assert.ok(result.isError, 'Expected isError=true for unknown roundtable');
            const data = parseResult(result);
            assert.ok(data.error.includes('-1'), 'Error should mention the missing ID');
        });
    });
    describe('roundtable_close', () => {
        it('rejects close when state=collecting', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'close-collecting-test',
                description: '',
            });
            const localIssueId = parseResult(issueResult).id;
            const createResult = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'close in collecting state',
                expected_participants: 2,
            });
            const localRtId = parseResult(createResult).roundtable_id;
            const closeResult = await call(rt.handlers, 'roundtable_close', {
                agent: 'bro',
                roundtable_id: localRtId,
                outcome: 'premature close',
            });
            assert.ok(closeResult.isError, 'Close in collecting state should error');
            assert.ok(parseResult(closeResult).error.includes('invalid_state'), 'Error is invalid_state');
        });
        it('rejects close when state=awaiting_human and no human votes', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'close-awaiting-no-human-vote-test',
                description: '',
            });
            const localIssueId = parseResult(issueResult).id;
            const createResult = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'close awaiting_human no votes',
                expected_participants: 2,
            });
            const localRtId = parseResult(createResult).roundtable_id;
            await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro', roundtable_id: localRtId, participant: 'ceo', vote: 'yes',
            });
            await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro', roundtable_id: localRtId, participant: 'cto', vote: 'yes',
            });
            const closeResult = await call(rt.handlers, 'roundtable_close', {
                agent: 'bro',
                roundtable_id: localRtId,
                outcome: 'no human vote yet',
            });
            assert.ok(closeResult.isError, 'Close without human vote should error');
            assert.ok(parseResult(closeResult).error.includes('precondition_failed'), 'Error is precondition_failed');
        });
        it('skip:true closes from any state and sets state=skipped', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'skip-close-test',
                description: '',
            });
            const localIssueId = parseResult(issueResult).id;
            const createResult = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'skip close test',
                expected_participants: 2,
            });
            const localRtId = parseResult(createResult).roundtable_id;
            const closeResult = await call(rt.handlers, 'roundtable_close', {
                agent: 'bro',
                roundtable_id: localRtId,
                outcome: 'skipped — no substance',
                skip: true,
            });
            assert.ok(!closeResult.isError, 'Skip close should succeed');
            const data = parseResult(closeResult);
            assert.equal(data.state, 'skipped', 'State must be skipped');
        });
        it('happy path: closes a roundtable in awaiting_human with human vote', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'happy-close-test',
                description: '',
            });
            const localIssueId = parseResult(issueResult).id;
            const createResult = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'happy close test',
                expected_participants: 2,
            });
            const localRtId = parseResult(createResult).roundtable_id;
            await call(rt.handlers, 'roundtable_vote', { agent: 'bro', roundtable_id: localRtId, participant: 'ceo', vote: 'yes' });
            await call(rt.handlers, 'roundtable_vote', { agent: 'bro', roundtable_id: localRtId, participant: 'cto', vote: 'yes' });
            await call(rt.handlers, 'roundtable_vote', { agent: 'bro', roundtable_id: localRtId, participant: 'human', vote: 'ratified' });
            const closeResult = await call(rt.handlers, 'roundtable_close', {
                agent: 'bro',
                roundtable_id: localRtId,
                outcome: 'All agreed.',
            });
            assert.ok(!closeResult.isError, `Expected no error: ${JSON.stringify(parseResult(closeResult))}`);
            const data = parseResult(closeResult);
            assert.equal(data.state, 'closed');
            assert.ok(data.closed_at, 'closed_at must be set');
        });
        it('role rejection: consultant (architect) cannot call roundtable_close', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_close', {
                agent: 'architect',
                roundtable_id: roundtableId,
                outcome: 'Forbidden outcome',
            });
            assert.ok(result.isError, 'Expected isError=true for consultant');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
            assert.equal(data.caller_role, 'consultant');
        });
        it('role rejection: swe cannot call roundtable_close', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_close', {
                agent: 'swe',
                roundtable_id: roundtableId,
                outcome: 'Forbidden outcome',
            });
            assert.ok(result.isError, 'Expected isError=true for swe');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
        });
        it('role rejection: pr-reviewer cannot call roundtable_close', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_close', {
                agent: 'pr-reviewer',
                roundtable_id: roundtableId,
                outcome: 'Forbidden outcome',
            });
            assert.ok(result.isError, 'Expected isError=true for pr-reviewer');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
        });
        it('errors on unknown roundtable_id', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_close', {
                agent: 'bro',
                roundtable_id: -1,
                outcome: 'Some outcome',
            });
            assert.ok(result.isError, 'Expected isError=true for unknown roundtable');
            const data = parseResult(result);
            assert.ok(data.error.includes('-1'), 'Error should mention the missing ID');
        });
    });
    describe('roundtable_finalize_decisions', () => {
        let localRtId;
        let localIssueId;
        before(async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'finalize-test carrier',
                description: '',
            });
            localIssueId = parseResult(issueResult).id;
            const createResult = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'finalize decisions test',
                expected_participants: 2,
            });
            localRtId = parseResult(createResult).roundtable_id;
            await call(rt.handlers, 'roundtable_vote', { agent: 'bro', roundtable_id: localRtId, participant: 'ceo', vote: 'yes' });
            await call(rt.handlers, 'roundtable_vote', { agent: 'bro', roundtable_id: localRtId, participant: 'cto', vote: 'yes' });
        });
        it('rejects when state != awaiting_human', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro', objective: 'finalize-collecting-test', description: '',
            });
            const liid = parseResult(issueResult).id;
            const cr = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro', issue_id: liid, topic: 'collecting state finalize test', expected_participants: 2,
            });
            const lrid = parseResult(cr).roundtable_id;
            const result = await call(rt.handlers, 'roundtable_finalize_decisions', {
                agent: 'bro',
                roundtable_id: lrid,
                ratified: ['agreement'],
                unratified: [],
                resolutions: [],
            });
            assert.ok(result.isError, 'finalize on collecting state should error');
            assert.ok(parseResult(result).error.includes('invalid_state'));
        });
        it('rejects when all three arrays empty', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_finalize_decisions', {
                agent: 'bro',
                roundtable_id: localRtId,
                ratified: [],
                unratified: [],
                resolutions: [],
            });
            assert.ok(result.isError, 'All empty arrays should error');
            assert.ok(parseResult(result).error.includes('invalid_argument'));
        });
        it('rejects when topic_slug > 12 chars', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_finalize_decisions', {
                agent: 'bro',
                roundtable_id: localRtId,
                ratified: [],
                unratified: [],
                resolutions: [{ topic_slug: 'thisistoolong', winning_stance: 'A', dissenter: 'B' }],
            });
            assert.ok(result.isError, 'topic_slug > 12 should error');
            assert.ok(parseResult(result).error.includes('topic_slug'));
        });
        it('writes expected discussion + vote rows in one transaction', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_finalize_decisions', {
                agent: 'bro',
                roundtable_id: localRtId,
                ratified: ['Use microservices', 'Adopt TypeScript'],
                unratified: ['Rewrite in Rust'],
                resolutions: [
                    { topic_slug: 'deploy', winning_stance: 'k8s', dissenter: 'ceo', rationale: 'CEO preferred VMs' },
                ],
            });
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
            const data = parseResult(result);
            assert.equal(data.discussion_rows_written, 6, '2 ratified * 2 rows each + 1 unratified note + 1 resolution decision = 6');
            assert.equal(data.vote_rows_written, 3, '2 ratified votes + 1 resolution vote');
            assert.equal(data.state, 'awaiting_human');
        });
        it('rolls back on error (invalid topic_slug triggers early rejection)', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro', objective: 'rollback-test', description: '',
            });
            const liid = parseResult(issueResult).id;
            const cr = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro', issue_id: liid, topic: 'rollback test', expected_participants: 2,
            });
            const lrid = parseResult(cr).roundtable_id;
            await call(rt.handlers, 'roundtable_vote', { agent: 'bro', roundtable_id: lrid, participant: 'ceo', vote: 'yes' });
            await call(rt.handlers, 'roundtable_vote', { agent: 'bro', roundtable_id: lrid, participant: 'cto', vote: 'yes' });
            const result = await call(rt.handlers, 'roundtable_finalize_decisions', {
                agent: 'bro',
                roundtable_id: lrid,
                ratified: ['Some agreement'],
                unratified: [],
                resolutions: [{ topic_slug: 'toolongslugXYZ', winning_stance: 'A', dissenter: 'B' }],
            });
            assert.ok(result.isError, 'Should error on invalid topic_slug');
            assert.ok(parseResult(result).error.includes('topic_slug'));
        });
        it('role rejection: all 5 tools are bro-only', async () => {
            const rt = roundtableTools(db);
            for (const toolName of [
                'roundtable_create',
                'roundtable_vote',
                'roundtable_close',
                'roundtable_finalize_decisions',
                'roundtable_summarize',
            ]) {
                for (const agent of ['architect', 'swe', 'pr-reviewer']) {
                    const result = await call(rt.handlers, toolName, {
                        agent,
                        issue_id: issueId,
                        roundtable_id: 1,
                        topic: 'x',
                        expected_participants: 2,
                        participant: 'ceo',
                        vote: 'yes',
                        outcome: 'x',
                        ratified: [],
                        unratified: [],
                        resolutions: [],
                    });
                    assert.ok(result.isError, `${toolName} should reject agent=${agent}`);
                    assert.equal(parseResult(result).error, 'forbidden', `${toolName} error should be 'forbidden' for ${agent}`);
                }
            }
        });
    });
    describe('roundtable_summarize', () => {
        it('returns canonical shape from a fully-populated roundtable', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro', objective: 'summarize-test carrier', description: '',
            });
            const localIssueId = parseResult(issueResult).id;
            const createResult = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro', issue_id: localIssueId, topic: 'Summarize test topic', expected_participants: 2,
            });
            const localRtId = parseResult(createResult).roundtable_id;
            await call(rt.handlers, 'roundtable_vote', { agent: 'bro', roundtable_id: localRtId, participant: 'ceo', vote: 'yes' });
            await call(rt.handlers, 'roundtable_vote', { agent: 'bro', roundtable_id: localRtId, participant: 'cto', vote: 'yes' });
            await call(rt.handlers, 'roundtable_finalize_decisions', {
                agent: 'bro',
                roundtable_id: localRtId,
                ratified: ['Go with microservices'],
                unratified: ['Rewrite in Go'],
                resolutions: [{ topic_slug: 'infra', winning_stance: 'k8s', dissenter: 'ceo' }],
            });
            await call(rt.handlers, 'roundtable_close', {
                agent: 'bro', roundtable_id: localRtId, outcome: 'Microservices adopted.',
            });
            const result = await call(rt.handlers, 'roundtable_summarize', {
                agent: 'bro', roundtable_id: localRtId,
            });
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
            const data = parseResult(result);
            assert.equal(data.topic, 'Summarize test topic');
            assert.ok(Array.isArray(data.participants), 'participants is array');
            assert.ok(Array.isArray(data.agreements_ratified), 'agreements_ratified is array');
            assert.ok(Array.isArray(data.unratified), 'unratified is array');
            assert.ok(Array.isArray(data.disagreements_resolved), 'disagreements_resolved is array');
            assert.ok(data.agreements_ratified.includes('Go with microservices'), 'ratified agreement present');
            assert.ok(data.unratified.includes('Rewrite in Go'), 'unratified item present');
            assert.equal(data.state, 'closed');
            assert.equal(data.outcome, 'Microservices adopted.');
        });
    });
    describe('discussion_append kind=analysis', () => {
        it('kind=analysis is accepted by discussion_append', async () => {
            const { discussionTools } = await import('../tools/discussions.js');
            const disc = discussionTools(db);
            const result = await call(disc.handlers, 'discussion_append', {
                agent: 'bro',
                issue_id: String(issueId),
                author: 'ceo',
                kind: 'analysis',
                body: 'CEO position: adopt the new architecture. Reasoning: aligns with Q3 goals.',
            });
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
            const data = parseResult(result);
            assert.equal(data.kind, 'analysis');
            assert.equal(data.author, 'ceo');
        });
    });
    describe('roundtable_summarize cross-roundtable fence', () => {
        it('returns only items from the target roundtable when multiple roundtables exist on same issue', async () => {
            const localDb = tempDB();
            for (let i = 0; i < 5; i++) {
                localDb.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
           VALUES (-1, NULL, 'system', 'roundtable_slash_invoked', 'fence test fixture', '{}', datetime('now'))`);
            }
            const issues = issueTools(localDb);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'multi-roundtable fence test',
            });
            const localIssueId = parseResult(issueResult).id;
            const rt = roundtableTools(localDb);
            const rt1Result = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'first roundtable',
                expected_participants: 2,
            });
            assert.ok(!rt1Result.isError, `rt1 create failed: ${JSON.stringify(parseResult(rt1Result))}`);
            const rt1Id = parseResult(rt1Result).roundtable_id;
            const t1 = '2025-01-01T10:00:00.000Z';
            const t2 = '2025-06-01T10:00:00.000Z';
            localDb.run(`UPDATE roundtables SET created_at = ?, closed_at = ?, state = 'closed' WHERE id = ?`, [t1, '2025-01-02T10:00:00.000Z', rt1Id]);
            localDb.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', 'answer', 'answer from rt1', ?)`, [localIssueId, '2025-01-01T11:00:00.000Z']);
            const rt2Result = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'second roundtable',
                expected_participants: 2,
            });
            assert.ok(!rt2Result.isError, `rt2 create failed: ${JSON.stringify(parseResult(rt2Result))}`);
            const rt2Id = parseResult(rt2Result).roundtable_id;
            localDb.run(`UPDATE roundtables SET created_at = ? WHERE id = ?`, [t2, rt2Id]);
            localDb.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', 'answer', 'answer from rt2', ?)`, [localIssueId, '2025-06-01T11:00:00.000Z']);
            const summaryResult = await call(rt.handlers, 'roundtable_summarize', {
                agent: 'bro',
                roundtable_id: rt1Id,
            });
            assert.ok(!summaryResult.isError, `summarize failed: ${JSON.stringify(parseResult(summaryResult))}`);
            const summary = parseResult(summaryResult);
            assert.equal(summary.agreements_ratified.length, 1, 'rt1 summary must include only rt1 answers');
            assert.equal(summary.agreements_ratified[0], 'answer from rt1');
            assert.ok(!summary.agreements_ratified.includes('answer from rt2'), 'rt1 summary must NOT include rt2 answers');
            const summary2Result = await call(rt.handlers, 'roundtable_summarize', {
                agent: 'bro',
                roundtable_id: rt2Id,
            });
            assert.ok(!summary2Result.isError);
            const summary2 = parseResult(summary2Result);
            assert.equal(summary2.agreements_ratified.length, 1, 'rt2 summary must include only rt2 answers');
            assert.equal(summary2.agreements_ratified[0], 'answer from rt2');
            localDb.close();
        });
    });
    describe('roundtable_vote length caps (#506)', () => {
        it('accepts vote exactly at 60 chars', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: roundtableId,
                participant: 'pm',
                vote: 'a'.repeat(60),
                rationale: 'Within cap',
            });
            assert.ok(!result.isError, `Vote at 60-char cap should be accepted: ${JSON.stringify(parseResult(result))}`);
        });
        it('rejects vote at 61 chars with named error', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: roundtableId,
                participant: 'pm',
                vote: 'a'.repeat(61),
            });
            assert.ok(result.isError, 'Vote over 60 chars should be rejected');
            const data = parseResult(result);
            assert.ok(data.error.includes('invalid_argument'), `Error must cite invalid_argument: ${data.error}`);
            assert.ok(data.error.includes('60'), `Error must mention the cap: ${data.error}`);
            assert.ok(data.error.includes('61'), `Error must include the actual length: ${data.error}`);
        });
        it('accepts rationale exactly at 120 chars', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: roundtableId,
                participant: 'pm',
                vote: 'at cap',
                rationale: 'b'.repeat(120),
            });
            assert.ok(!result.isError, `Rationale at 120-char cap should be accepted: ${JSON.stringify(parseResult(result))}`);
        });
        it('rejects rationale at 121 chars with named error', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: roundtableId,
                participant: 'pm',
                vote: 'valid vote',
                rationale: 'b'.repeat(121),
            });
            assert.ok(result.isError, 'Rationale over 120 chars should be rejected');
            const data = parseResult(result);
            assert.ok(data.error.includes('invalid_argument'), `Error must cite invalid_argument: ${data.error}`);
            assert.ok(data.error.includes('120'), `Error must mention the cap: ${data.error}`);
            assert.ok(data.error.includes('121'), `Error must include the actual length: ${data.error}`);
        });
    });
    describe('roundtable_create slash gate (#356)', () => {
        it('rejects when no slash-invoke audit row exists within 10 minutes', async () => {
            const localDb = tempDB();
            const issues = issueTools(localDb);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'gate expiry test',
            });
            const localIssueId = parseResult(issueResult).id;
            const rt = roundtableTools(localDb);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'should be rejected',
                expected_participants: 2,
            });
            assert.ok(result.isError, 'Expected isError=true when no slash row exists');
            const data = parseResult(result);
            assert.equal(data.error, 'roundtable_slash_gate_violation');
            localDb.close();
        });
        it('rejects when slash-invoke row exists but is older than 10 minutes (expiry)', async () => {
            const localDb = tempDB();
            localDb.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
         VALUES (-1, NULL, 'system', 'roundtable_slash_invoked', 'stale fixture', '{}', datetime('now', '-11 minutes'))`);
            const issues = issueTools(localDb);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'gate expiry test',
            });
            const localIssueId = parseResult(issueResult).id;
            const rt = roundtableTools(localDb);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'should be rejected — stale slash row',
                expected_participants: 2,
            });
            assert.ok(result.isError, 'Expected isError=true for stale slash row');
            const data = parseResult(result);
            assert.equal(data.error, 'roundtable_slash_gate_violation');
            localDb.close();
        });
        it('rejects when slash-invoke row already consumed (single-use)', async () => {
            const localDb = tempDB();
            localDb.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
         VALUES (-1, NULL, 'system', 'roundtable_slash_invoked', 'single-use fixture', '{}', datetime('now'))`);
            const issues = issueTools(localDb);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'single-use test',
            });
            const localIssueId = parseResult(issueResult).id;
            const rt = roundtableTools(localDb);
            const firstResult = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'first roundtable — should succeed',
                expected_participants: 2,
            });
            assert.ok(!firstResult.isError, `First create must succeed: ${JSON.stringify(parseResult(firstResult))}`);
            const firstRtId = parseResult(firstResult).roundtable_id;
            assert.ok(typeof firstRtId === 'number' && firstRtId > 0);
            const secondResult = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'second roundtable — should be rejected (row consumed)',
                expected_participants: 2,
            });
            assert.ok(secondResult.isError, 'Second create must fail — slash row consumed');
            const secondData = parseResult(secondResult);
            assert.equal(secondData.error, 'roundtable_slash_gate_violation');
            localDb.close();
        });
        it('accepts roundtable_create when fresh slash row present, stamps roundtable_id into content_json', async () => {
            const localDb = tempDB();
            localDb.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
         VALUES (-1, NULL, 'system', 'roundtable_slash_invoked', 'fresh fixture', '{}', datetime('now'))`);
            const issues = issueTools(localDb);
            const issueResult = await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro',
                objective: 'stamp test',
            });
            const localIssueId = parseResult(issueResult).id;
            const rt = roundtableTools(localDb);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: localIssueId,
                topic: 'stamp test',
                expected_participants: 2,
            });
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
            const rtId = parseResult(result).roundtable_id;
            const auditRow = localDb.get(`SELECT content_json FROM audit WHERE event_type = 'roundtable_slash_invoked' LIMIT 1`);
            assert.ok(auditRow, 'Audit row must exist');
            const content = JSON.parse(auditRow.content_json);
            assert.equal(content.consumed_by_roundtable_id, rtId, 'content_json must be stamped with roundtable_id');
            localDb.close();
        });
    });
});
//# sourceMappingURL=roundtable.test.js.map