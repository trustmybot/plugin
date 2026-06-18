import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { auditTools } from '../tools/audit.js';
import { validationTools } from '../tools/validation.js';
import { skillTools } from '../tools/skills.js';
import { reportTools } from '../tools/reports.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
async function call(handlers, name, args) {
    return (await handlers[name](args));
}
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
function parseBatch(result) {
    const raw = JSON.parse(result.content[0].text);
    return (raw.tasks ?? raw);
}
async function createIssue(db) {
    const tools = issueTools(db);
    const result = await call(tools.handlers, 'issue_create', {
        agent: 'bro',
        objective: 'Test issue',
    });
    return parseResult(result).id;
}
async function createTask(db, issueId, branchId = 'feat/test-task') {
    const tools = taskTools(db);
    const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [
            {
                branch_id: branchId,
                description: 'Test task',
            },
        ],
    });
    return parseBatch(result)[0].id;
}
describe('auditTools', () => {
    it('audit_log stores small content_json intact', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = auditTools(db);
        const result = await call(tools.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'planning_complete',
            summary: 'Plan done',
            content_json: JSON.stringify({ cmd: 'echo hi' }),
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.issue_id, issueId);
        assert.equal(row.event_type, 'planning_complete');
        assert.equal(row.content_json, JSON.stringify({ cmd: 'echo hi' }));
        db.close();
    });
    it('audit_log rejects content_json > 1 MB with a named error', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = auditTools(db);
        const bigContent = JSON.stringify({ blob: 'x'.repeat(2_000_000) });
        const result = await call(tools.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'planning_complete',
            summary: 'Plan done',
            content_json: bigContent,
        });
        assert.ok(result.isError, 'Expected error for oversized content_json');
        const row = parseResult(result);
        assert.ok(typeof row['error'] === 'string' && row['error'].includes('1MB limit'), `error should mention 1MB limit, got: ${JSON.stringify(row)}`);
        db.close();
    });
    // Slim contract — audit is event-only. `kind` and `is_truncated` are gone
    // from the schema; the audit_log handler must not surface them on output
    // rows. Verify both via PRAGMA + the returned row shape.
    it('audit table has no kind or is_truncated columns after the slim cleanup', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = auditTools(db);
        const result = await call(tools.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'planning_complete',
            summary: 'slim event',
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.kind, undefined, 'returned audit row must not expose a `kind` field');
        assert.equal(row.is_truncated, undefined, 'returned audit row must not expose `is_truncated`');
        const colInfo = db.all(`PRAGMA table_info(audit)`);
        const present = new Set(colInfo.map((c) => c.name));
        assert.ok(!present.has('kind'), 'audit.kind must be dropped from the schema');
        assert.ok(!present.has('is_truncated'), 'audit.is_truncated must be dropped from the schema');
        db.close();
    });
    it('audit_log returns ok and audit row exists even when embed returns null (no model in CI)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = auditTools(db);
        const result = await call(tools.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'embed_await_test',
            summary: 'embedding await test',
        });
        assert.ok(!result.isError, `audit_log must succeed: ${JSON.stringify(parseResult(result))}`);
        const row = parseResult(result);
        assert.equal(row.event_type, 'embed_await_test');
        const auditRow = db.get('SELECT id FROM audit WHERE id = ?', [row.id]);
        assert.ok(auditRow, 'audit row must be persisted before tool returns');
        db.close();
    });
    it('audit_log returns ok when embedAndStore rejects (embed error does not propagate)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = auditTools(db);
        const r1 = await call(tools.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'embed_prime',
            summary: 'first call primes loadFailed state',
        });
        assert.ok(!r1.isError, 'first call must succeed');
        const r2 = await call(tools.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'embed_degraded',
            summary: 'second call with loadFailed=true must succeed (graceful degradation)',
        });
        assert.ok(!r2.isError, 'subsequent call with failed embed must still succeed');
        const d2 = parseResult(r2);
        assert.equal(d2.event_type, 'embed_degraded');
        db.close();
    });
});
describe('validationTools', () => {
    it('validation_record rejects invalid verdict', async () => {
        const db = tempDB();
        const tools = validationTools(db);
        const result = await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: 1,
            attempt_n: 1,
            verdict: 'maybe',
            feedback: '# Notes',
            subagent_session_id: 'test-session-abc',
        });
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('Invalid verdict'), `Error should mention invalid verdict: ${data.error}`);
        db.close();
    });
    it('validation_record rejects non-integer task_id', async () => {
        const db = tempDB();
        const tools = validationTools(db);
        const result = await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: 'task_abc',
            attempt_n: 1,
            verdict: 'fail',
            feedback: '# Notes',
            subagent_session_id: 'test-session-abc',
        });
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('task_id must be a positive integer'), `Error should mention task_id validation: ${data.error}`);
        db.close();
    });
    it('validation_record rejects task_id that does not exist', async () => {
        const db = tempDB();
        const tools = validationTools(db);
        const result = await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: 9999,
            attempt_n: 1,
            verdict: 'pass',
            feedback: 'MCP available: yes\n# Notes',
            subagent_session_id: 'test-session-abc',
        });
        assert.ok(result.isError);
        const data = parseResult(result);
        assert.ok(data.error.includes('not found in tasks table'), `Error should cite missing task row: ${data.error}`);
        db.close();
    });
    it('validation_history returns attempts in ascending order', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const taskId = await createTask(db, issueId);
        const tools = validationTools(db);
        await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: taskId,
            attempt_n: 3,
            verdict: 'fail',
            feedback: 'MCP available: yes\n# Third attempt',
            subagent_session_id: 'session-3',
        });
        await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: taskId,
            attempt_n: 1,
            verdict: 'fail',
            feedback: 'MCP available: yes\n# First attempt',
            subagent_session_id: 'session-1',
        });
        await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: taskId,
            attempt_n: 2,
            verdict: 'pass',
            feedback: 'MCP available: yes\n# Second attempt',
            subagent_session_id: 'session-2',
        });
        const result = await call(tools.handlers, 'validation_history', {
            agent: 'bro',
            task_id: taskId,
        });
        const rows = parseResult(result);
        assert.ok(!result.isError);
        assert.equal(rows.length, 3);
        assert.equal(rows[0].attempt_n, 1);
        assert.equal(rows[1].attempt_n, 2);
        assert.equal(rows[2].attempt_n, 3);
        db.close();
    });
});
describe('skillTools', () => {
    it('skill_register returns a row without the dropped effectiveness stat columns', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        const result = await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-skill',
            description: 'A test skill',
            file_path: 'skills/my-skill.md',
            trust_tier: 'agent',
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.name, 'my-skill');
        assert.equal(row.status, 'draft');
        for (const dead of ['uses', 'successes', 'effectiveness']) {
            assert.ok(!(dead in row), `skill row must not expose dropped column ${dead}`);
        }
        db.close();
    });
    it('skill_promote rejects invalid transition', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-skill',
            description: 'A test skill',
            file_path: 'skills/my-skill.md',
            trust_tier: 'agent',
        });
        const result = await call(tools.handlers, 'skill_promote', {
            agent: 'bro',
            name: 'my-skill',
            from_status: 'draft',
            to_status: 'active',
        });
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('Invalid transition'), `Error should mention invalid transition: ${data.error}`);
        db.close();
    });
    it('skill_promote accepts draft→pending_review', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-skill',
            description: 'A test skill',
            file_path: 'skills/my-skill.md',
            trust_tier: 'agent',
        });
        const result = await call(tools.handlers, 'skill_promote', {
            agent: 'bro',
            name: 'my-skill',
            from_status: 'draft',
            to_status: 'pending_review',
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.status, 'pending_review');
        db.close();
    });
    it('skill_promote rejects when skill is not in from_status (#364)', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-promote-guard-skill',
            description: 'Promote guard test',
            file_path: 'skills/promote-guard.md',
            trust_tier: 'agent',
        });
        const result = await call(tools.handlers, 'skill_promote', {
            agent: 'bro',
            name: 'my-promote-guard-skill',
            from_status: 'pending_review',
            to_status: 'active',
        });
        assert.ok(result.isError, 'Expected error when from_status does not match actual status');
        const data = parseResult(result);
        assert.match(data.error, /from_status must match/, `Error must mention from_status mismatch: ${data.error}`);
        db.close();
    });
    it('skill_promote rejects tier transition when trust_tier does not match from (#364)', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-tier-guard-skill',
            description: 'Tier guard test',
            file_path: 'skills/tier-guard.md',
            trust_tier: 'agent',
        });
        const result = await call(tools.handlers, 'skill_promote', {
            agent: 'bro',
            name: 'my-tier-guard-skill',
            from_status: 'curated',
            to_status: 'agent',
        });
        assert.ok(result.isError, 'Expected error when from_status does not match actual trust_tier');
        const data = parseResult(result);
        assert.match(data.error, /Invalid transition/, `Error must be invalid transition (curated→agent not in table): ${data.error}`);
        db.close();
    });
    it('skill_promote accepts agent→curated tier transition when trust_tier matches (#364)', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-tier-upgrade-skill',
            description: 'Tier upgrade test',
            file_path: 'skills/tier-upgrade.md',
            trust_tier: 'agent',
        });
        const result = await call(tools.handlers, 'skill_promote', {
            agent: 'bro',
            name: 'my-tier-upgrade-skill',
            from_status: 'agent',
            to_status: 'curated',
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.trust_tier, 'curated');
        db.close();
    });
});
describe('skill_register name validation gate', () => {
    it('rejects names not matching ^[a-z][a-z0-9-]{0,63}$', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        for (const badName of ['My-Skill', '1starts-digit', 'has_underscore']) {
            const result = await call(tools.handlers, 'skill_register', {
                agent: 'bro',
                name: badName,
                description: 'test',
                file_path: `skills/bad.md`,
                trust_tier: 'agent',
            });
            assert.ok(result.isError, `Expected error for invalid name '${badName}'`);
            assert.match(parseResult(result).error, /invalid name/, `Error for '${badName}' must mention invalid name`);
        }
        db.close();
    });
    it("tmb_ prefix with underscore is blocked by the name regex (underscore not in ^[a-z][a-z0-9-]{0,63}$)", async () => {
        const db = tempDB();
        const tools = skillTools(db);
        // tmb- (hyphen after tmb) is a valid name and allowed at project-local scope
        const hyphenResult = await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'tmb-myskill',
            description: 'test',
            file_path: 'skills/tmb-myskill.md',
            trust_tier: 'agent',
        });
        assert.ok(!hyphenResult.isError, "tmb- (hyphen) prefix must be allowed — only tmb_ (underscore) is reserved");
        // tmb_ (underscore) fails the name regex first (underscore not in [a-z0-9-]);
        // the tmb_ prefix guard is defense-in-depth for future regex relaxations.
        const underscoreResult = await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'tmb_myskill',
            description: 'test',
            file_path: 'skills/tmb_myskill.md',
            trust_tier: 'agent',
        });
        assert.ok(underscoreResult.isError, "tmb_ prefix (underscore) must be rejected — underscore not in valid name chars");
        assert.match(parseResult(underscoreResult).error, /invalid name/);
        db.close();
    });
    it('accepts valid kebab-case names', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        for (const goodName of ['my-skill', 'data-export-v2', 'a', 'abc123-def']) {
            const result = await call(tools.handlers, 'skill_register', {
                agent: 'bro',
                name: goodName,
                description: 'test',
                file_path: `skills/${goodName}.md`,
                trust_tier: 'agent',
            });
            assert.ok(!result.isError, `Expected success for valid name '${goodName}': ${JSON.stringify(parseResult(result))}`);
        }
        db.close();
    });
});
describe('reportTools', () => {
    it('issue_report_md renders sections when an issue has tasks and audit events', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        await createTask(db, issueId);
        const audit = auditTools(db);
        await call(audit.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'swe',
            event_type: 'task_started',
            summary: 'SWE began work',
        });
        const tools = reportTools(db);
        const result = await call(tools.handlers, 'issue_report_md', {
            agent: 'bro',
            issue_id: String(issueId),
            mode: 'detail',
        });
        const data = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
        assert.ok(typeof data.markdown === 'string', 'Expected markdown string');
        assert.ok(data.markdown.includes('## Objective + Status'), 'Missing Objective section');
        assert.ok(data.markdown.includes('## Tasks'), 'Missing Tasks section');
        assert.ok(data.markdown.includes('## Validation History'), 'Missing Validation History section');
        assert.ok(data.markdown.includes('## Audit Event Timeline'), 'Missing Audit Event Timeline section');
        assert.ok(data.markdown.includes('SWE began work'), 'Audit event missing from report');
        db.close();
    });
});
//# sourceMappingURL=remaining_tools.test.js.map