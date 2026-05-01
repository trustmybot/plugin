import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryDB } from '../db.js';
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
        db = new TrajectoryDB(':memory:');
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
        it('happy path: creates a roundtable and returns roundtable_id', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'bro',
                issue_id: issueId,
                topic: 'Should we adopt the new architecture?',
            });
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
            const data = parseResult(result);
            assert.ok(typeof data.roundtable_id === 'number', 'roundtable_id must be a number');
            assert.ok(data.roundtable_id > 0, 'roundtable_id must be positive');
            globalThis['rt1Id'] = data.roundtable_id;
        });
        it('role rejection: architect cannot call roundtable_create', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'architect',
                issue_id: issueId,
                topic: 'forbidden topic',
            });
            assert.ok(result.isError, 'Expected isError=true for architect');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
            assert.equal(data.caller_role, 'architect');
        });
        it('role rejection: swe cannot call roundtable_create', async () => {
            const rt = roundtableTools(db);
            const result = await call(rt.handlers, 'roundtable_create', {
                agent: 'swe',
                issue_id: issueId,
                topic: 'forbidden topic',
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
        it('happy path: participant=human works for ratification rows', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'bro',
                roundtable_id: roundtableId,
                participant: 'human',
                vote: 'ratified',
                rationale: 'Human approved the new architecture direction',
            });
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
            const data = parseResult(result);
            assert.ok(typeof data.vote_id === 'number', 'vote_id must be a number');
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
        it('role rejection: architect cannot call roundtable_vote', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_vote', {
                agent: 'architect',
                roundtable_id: roundtableId,
                participant: 'architect',
                vote: 'in favor',
            });
            assert.ok(result.isError, 'Expected isError=true for architect');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
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
                roundtable_id: 999999,
                participant: 'ceo',
                vote: 'in favor',
            });
            assert.ok(result.isError, 'Expected isError=true for unknown roundtable');
            const data = parseResult(result);
            assert.ok(data.error.includes('999999'), 'Error should mention the missing ID');
        });
    });
    describe('roundtable_close', () => {
        it('happy path: closes a roundtable and returns status=closed', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_close', {
                agent: 'bro',
                roundtable_id: roundtableId,
                outcome: 'New architecture adopted unanimously; carry issue #42 for implementation.',
            });
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
            const data = parseResult(result);
            assert.equal(data.roundtable_id, roundtableId);
            assert.equal(data.status, 'closed');
            assert.ok(data.closed_at, 'closed_at must be set');
        });
        it('re-closing an already-closed roundtable is idempotent (no error)', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_close', {
                agent: 'bro',
                roundtable_id: roundtableId,
                outcome: 'Re-close with updated outcome.',
            });
            assert.ok(!result.isError, 'Re-closing should not error');
            const data = parseResult(result);
            assert.equal(data.status, 'closed');
        });
        it('role rejection: architect cannot call roundtable_close', async () => {
            const rt = roundtableTools(db);
            const roundtableId = globalThis['rt1Id'];
            const result = await call(rt.handlers, 'roundtable_close', {
                agent: 'architect',
                roundtable_id: roundtableId,
                outcome: 'Forbidden outcome',
            });
            assert.ok(result.isError, 'Expected isError=true for architect');
            const data = parseResult(result);
            assert.equal(data.error, 'forbidden');
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
                roundtable_id: 999999,
                outcome: 'Some outcome',
            });
            assert.ok(result.isError, 'Expected isError=true for unknown roundtable');
            const data = parseResult(result);
            assert.ok(data.error.includes('999999'), 'Error should mention the missing ID');
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