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
        // Seed the slash-invoke audit so the roundtable_create gate clears.
        // Tests targeting the gate explicitly use a fresh DB without this seed.
        db.run(`INSERT INTO audit (issue_id, branch_id, from_node, kind, event_type, summary, content_json, created_at)
       VALUES (-1, NULL, 'system', 'event', 'roundtable_slash_invoked', 'test fixture: gate cleared', '{}', datetime('now'))`);
        const issues = issueTools(db);
        const result = await call(issues.handlers, 'issue_create', {
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
            assert.equal(data.status, 'closed', 'Status must be closed');
        });
        it('happy path: closes a roundtable in awaiting_human with human vote', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
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
            assert.equal(data.status, 'closed');
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
            assert.ok(data.ratification_received_at, 'ratification_received_at must be set');
        });
        it('rolls back on error (invalid topic_slug triggers early rejection)', async () => {
            const rt = roundtableTools(db);
            const issues = issueTools(db);
            const issueResult = await call(issues.handlers, 'issue_create', {
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
});
//# sourceMappingURL=roundtable.test.js.map