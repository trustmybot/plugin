import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { labelTools, decodeLabels, encodeLabels } from '../tools/labels.js';
import { issueTools } from '../tools/issues.js';
async function call(handlers, name, args) {
    const handler = handlers[name];
    assert.ok(handler, `Handler not found: ${name}`);
    return handler(args);
}
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
async function createIssue(issueHandlers, objective = 'Test issue') {
    const result = await call(issueHandlers, 'issue_create', { agent: 'bro', objective });
    const issue = parseResult(result);
    assert.ok(!result.isError, `create failed: ${issue.error}`);
    return issue.id;
}
describe('decodeLabels / encodeLabels', () => {
    it('round-trips a label array', () => {
        const labels = ['bug', 'p0', 'area:mcp'];
        assert.deepEqual(decodeLabels(encodeLabels(labels)), labels);
    });
    it('returns empty array for null', () => {
        assert.deepEqual(decodeLabels(null), []);
    });
    it('returns empty array for undefined', () => {
        assert.deepEqual(decodeLabels(undefined), []);
    });
    it('returns empty array for invalid JSON', () => {
        assert.deepEqual(decodeLabels('not-json'), []);
    });
    it('returns empty array for non-array JSON', () => {
        assert.deepEqual(decodeLabels('{"key":"val"}'), []);
    });
});
describe('issue_set_labels', () => {
    it('replaces the full label set', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        const r1 = await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['bug', 'p1'],
        });
        const d1 = parseResult(r1);
        assert.ok(!r1.isError, d1.error);
        assert.deepEqual(d1.labels, ['bug', 'p1']);
        const r2 = await call(labels.handlers, 'issue_set_labels', {
            agent: 'swe',
            issue_id: String(issueId),
            labels: ['enhancement'],
        });
        const d2 = parseResult(r2);
        assert.ok(!r2.isError, d2.error);
        assert.deepEqual(d2.labels, ['enhancement'], 'should replace, not union');
        db.close();
    });
    it('accepts empty array (clears all labels)', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['bug'],
        });
        const r = await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: [],
        });
        const d = parseResult(r);
        assert.ok(!r.isError, d.error);
        assert.deepEqual(d.labels, []);
        db.close();
    });
    it('rejects invalid label format', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        const r = await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['invalid label with spaces'],
        });
        assert.ok(r.isError, 'should fail for invalid label');
        db.close();
    });
    it('rejects label exceeding 50 chars', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        const r = await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['a'.repeat(51)],
        });
        assert.ok(r.isError, 'should fail for label > 50 chars');
        db.close();
    });
    it('rejects empty string label', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        const r = await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: [''],
        });
        assert.ok(r.isError, 'should fail for empty string label');
        db.close();
    });
    it('rejects when issue does not exist', async () => {
        const db = tempDB();
        const labels = labelTools(db);
        const r = await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: '99999',
            labels: ['bug'],
        });
        assert.ok(r.isError, 'should fail for non-existent issue');
        const d = parseResult(r);
        assert.match(d.error, /Not found/);
        db.close();
    });
    it('requireRoles rejects malformed agent name', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        const r = await call(labels.handlers, 'issue_set_labels', {
            agent: '!!!malformed',
            issue_id: String(issueId),
            labels: ['bug'],
        });
        assert.ok(r.isError, 'should be forbidden');
        const d = parseResult(r);
        assert.equal(d.error, 'forbidden');
        db.close();
    });
    it('deduplicates labels', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        const r = await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['bug', 'bug', 'p0'],
        });
        const d = parseResult(r);
        assert.ok(!r.isError, d.error);
        assert.deepEqual(d.labels, ['bug', 'p0']);
        db.close();
    });
});
describe('issue_add_labels', () => {
    it('unions with existing labels', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['bug'],
        });
        const r = await call(labels.handlers, 'issue_add_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['p0', 'area:mcp'],
        });
        const d = parseResult(r);
        assert.ok(!r.isError, d.error);
        assert.ok(d.labels.includes('bug'), 'original label preserved');
        assert.ok(d.labels.includes('p0'), 'new label added');
        assert.ok(d.labels.includes('area:mcp'), 'new label added');
        db.close();
    });
    it('is idempotent — adding existing label is a no-op', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['bug', 'p1'],
        });
        const r = await call(labels.handlers, 'issue_add_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['bug'],
        });
        const d = parseResult(r);
        assert.ok(!r.isError, d.error);
        assert.equal(d.labels.length, 2, 'should still have exactly 2 labels');
        db.close();
    });
    it('works on issue with no existing labels (consultant role)', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        const r = await call(labels.handlers, 'issue_add_labels', {
            agent: 'architect',
            issue_id: String(issueId),
            labels: ['enhancement'],
        });
        const d = parseResult(r);
        assert.ok(!r.isError, d.error);
        assert.deepEqual(d.labels, ['enhancement']);
        db.close();
    });
    it('requireRoles rejects malformed agent name', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        const r = await call(labels.handlers, 'issue_add_labels', {
            agent: '!!!malformed',
            issue_id: String(issueId),
            labels: ['bug'],
        });
        assert.ok(r.isError);
        assert.equal(parseResult(r).error, 'forbidden');
        db.close();
    });
});
describe('issue_remove_labels', () => {
    it('removes specified labels', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['bug', 'p0', 'enhancement'],
        });
        const r = await call(labels.handlers, 'issue_remove_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['p0', 'enhancement'],
        });
        const d = parseResult(r);
        assert.ok(!r.isError, d.error);
        assert.deepEqual(d.labels, ['bug']);
        db.close();
    });
    it('is idempotent — removing non-existent label is a no-op', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['bug'],
        });
        const r = await call(labels.handlers, 'issue_remove_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['does-not-exist'],
        });
        const d = parseResult(r);
        assert.ok(!r.isError, d.error);
        assert.deepEqual(d.labels, ['bug'], 'existing label should still be there');
        db.close();
    });
    it('requireRoles rejects malformed agent name', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers);
        const r = await call(labels.handlers, 'issue_remove_labels', {
            agent: '!!!malformed',
            issue_id: String(issueId),
            labels: ['bug'],
        });
        assert.ok(r.isError);
        assert.equal(parseResult(r).error, 'forbidden');
        db.close();
    });
});
describe('migration idempotency', () => {
    it('running TrajectoryDB constructor twice does not error', () => {
        const db1 = tempDB();
        db1.close();
        const db2 = tempDB();
        db2.close();
    });
});
describe('backward-compat: null labels', () => {
    it('issue_get returns no labels field when issue has null labels', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const issueId = await createIssue(issues.handlers);
        const r = await call(issues.handlers, 'issue_get', {
            agent: 'bro',
            issue_id: String(issueId),
        });
        const d = parseResult(r);
        assert.ok(!r.isError);
        assert.ok(!('labels' in d) || d.labels === undefined, 'labels should be absent for NULL db value');
        db.close();
    });
    it('issue_list omits labels field when null', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        await createIssue(issues.handlers, 'Issue with no labels');
        const r = await call(issues.handlers, 'issue_list', { agent: 'bro' });
        const d = parseResult(r);
        assert.ok(!r.isError);
        assert.ok(Array.isArray(d));
        for (const row of d) {
            assert.ok(!('labels' in row) || row.labels === undefined, 'labels should be absent when null');
        }
        db.close();
    });
    it('issue_list includes labels when set', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const labels = labelTools(db);
        const issueId = await createIssue(issues.handlers, 'Labeled issue');
        await call(labels.handlers, 'issue_set_labels', {
            agent: 'bro',
            issue_id: String(issueId),
            labels: ['bug', 'p0'],
        });
        const r = await call(issues.handlers, 'issue_list', { agent: 'bro' });
        const d = parseResult(r);
        assert.ok(!r.isError);
        const found = d.find((row) => row.id === issueId);
        assert.ok(found, 'issue not found in list');
        assert.deepEqual(found.labels, ['bug', 'p0']);
        db.close();
    });
});
//# sourceMappingURL=labels.test.js.map