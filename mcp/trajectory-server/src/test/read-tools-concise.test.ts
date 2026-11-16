// GH 1958: audit_list, validation_history, discussion_list and task_get are
// concise by default; 'detailed' returns today's rows, and an explicit fields
// projection is unaffected by response_format.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { auditTools } from '../tools/audit.js';
import { discussionTools } from '../tools/discussions.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { validationTools } from '../tools/validation.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
type DB = ReturnType<typeof tempDB>;

const SEED_ROWS = 30;
const LONG_TEXT = 'x'.repeat(1500);

async function call(handlers: Handlers, name: string, args: Record<string, unknown>): Promise<RawResult> {
  return (await handlers[name](args)) as RawResult;
}

const bytes = (r: RawResult): number => Buffer.byteLength(r.content[0].text, 'utf8');
const parse = (r: RawResult): unknown => JSON.parse(r.content[0].text);

async function seedIssueAndTask(db: DB): Promise<{ issueId: number; taskId: number }> {
  const issue = await call(issueTools(db).handlers, 'issue_create', {
    agent: 'bro',
    labels: ['Bug', 'Priority: High'],
    objective: 'concise read tools',
  });
  const issueId = (parse(issue) as { id: number }).id;
  const batch = await call(taskTools(db).handlers, 'task_create_batch', {
    waive_scope_gate: true,
    waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
    agent: 'bro',
    issue_id: String(issueId),
    tasks: [{ branch_id: 'feat/concise-read', description: 'concise read task' }],
  });
  const raw = parse(batch) as { tasks?: Array<{ id: number }> } | Array<{ id: number }>;
  const tasks = Array.isArray(raw) ? raw : raw.tasks!;
  return { issueId, taskId: tasks[0].id };
}

function seedAudit(db: DB, issueId: number): void {
  for (let i = 0; i < SEED_ROWS; i++) {
    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (?, 'bro', 'planning_complete', ?, ?, ?)`,
      [issueId, `event ${i}`, JSON.stringify({ i, payload: LONG_TEXT }), `2026-11-16T00:00:${String(i).padStart(2, '0')}.000Z`],
    );
  }
}

function seedValidation(db: DB, taskId: number): void {
  for (let n = 1; n <= SEED_ROWS; n++) {
    db.run(
      `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, reviewed_sha, created_at, probes_json)
       VALUES (?, ?, 'code-reviewer', 'fail', ?, 1, 'abc1234', ?, ?)`,
      [taskId, n, LONG_TEXT, `2026-11-16T01:00:${String(n).padStart(2, '0')}.000Z`,
        JSON.stringify([{ target: 'x', probe_cmd: 'true', observed: LONG_TEXT }])],
    );
    db.run(
      `INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at, severity, class)
       VALUES (?, ?, ?, 'SC1', ?, ?, ?, 'open', '2026-11-16T01:00:00.000Z', 'blocking', 'fact')`,
      [`F${taskId}-${n}`, taskId, n, LONG_TEXT, LONG_TEXT, LONG_TEXT],
    );
  }
}

function seedDiscussions(db: DB, issueId: number): void {
  for (let i = 0; i < SEED_ROWS; i++) {
    db.run(
      `INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', ?, ?, ?)`,
      [issueId, i === 0 ? 'decision' : 'note', LONG_TEXT, `2026-11-16T02:00:${String(i).padStart(2, '0')}.000Z`],
    );
  }
}

describe('concise-by-default read tools (GH 1958)', () => {
  it('audit_list: concise omits content_json and is at most half the detailed bytes', async () => {
    const db = tempDB();
    const { issueId } = await seedIssueAndTask(db);
    seedAudit(db, issueId);
    const h = auditTools(db).handlers;
    const base = { agent: 'bro', issue_id: String(issueId) };

    const concise = await call(h, 'audit_list', base);
    const detailed = await call(h, 'audit_list', { ...base, response_format: 'detailed' });
    const rows = parse(concise) as Array<Record<string, unknown>>;
    assert.ok(rows.length >= SEED_ROWS);
    assert.ok(rows.every((r) => !('content_json' in r) && 'summary' in r));
    assert.ok((parse(detailed) as Array<Record<string, unknown>>).every((r) => 'content_json' in r));
    assert.ok(bytes(concise) <= bytes(detailed) / 2, `concise ${bytes(concise)} vs detailed ${bytes(detailed)}`);

    const paged = parse(await call(h, 'audit_list', { ...base, limit: 5 })) as { rows: Array<Record<string, unknown>> };
    assert.ok(paged.rows.every((r) => !('content_json' in r)));

    const projected = parse(await call(h, 'audit_list', { ...base, fields: ['id', 'content_json'] })) as Array<Record<string, unknown>>;
    assert.ok(projected.some((r) => typeof r['content_json'] === 'string' && r['content_json'].includes(LONG_TEXT)));
  });

  it('validation_history: concise drops feedback, probes, verification_run and slims findings', async () => {
    const db = tempDB();
    const { taskId } = await seedIssueAndTask(db);
    seedValidation(db, taskId);
    const h = validationTools(db).handlers;
    const base = { agent: 'bro', task_id: String(taskId) };

    const concise = await call(h, 'validation_history', base);
    const detailed = await call(h, 'validation_history', { ...base, response_format: 'detailed' });
    const rows = parse(concise) as Array<Record<string, unknown>>;
    assert.equal(rows.length, SEED_ROWS);
    for (const r of rows) {
      for (const dropped of ['feedback', 'probes', 'probes_json', 'verification_run']) assert.ok(!(dropped in r), dropped);
      for (const kept of ['verdict', 'mcp_available', 'reviewed_sha', 'attempt_n']) assert.ok(kept in r, kept);
      assert.deepEqual(r['findings'], [{ id: `F${taskId}-${Number(r['attempt_n'])}`, criterion_id: 'SC1', status: 'open', severity: 'blocking' }]);
    }
    const full = parse(detailed) as Array<Record<string, unknown>>;
    assert.ok(full.every((r) => r['feedback'] === LONG_TEXT && Array.isArray(r['probes']) && 'verification_run' in r));
    assert.ok(bytes(concise) <= bytes(detailed) / 2, `concise ${bytes(concise)} vs detailed ${bytes(detailed)}`);

    const otherSwe = parse(await call(h, 'validation_history', { agent: 'swe', task_id: String(taskId), own_task_id: String(taskId + 1) })) as Array<Record<string, unknown>>;
    assert.ok(otherSwe.every((r) => !('findings' in r) && !('feedback' in r)), 'concise keeps findings gated where feedback is withheld');

    const projected = parse(await call(h, 'validation_history', { ...base, fields: ['attempt_n', 'feedback', 'findings'] })) as Array<Record<string, unknown>>;
    assert.ok(projected.every((r) => r['feedback'] === LONG_TEXT && (r['findings'] as Array<Record<string, unknown>>)[0]['observed'] === LONG_TEXT));
  });

  it('discussion_list: concise cuts non-decision/intent bodies to 200 chars with body_truncated', async () => {
    const db = tempDB();
    const { issueId } = await seedIssueAndTask(db);
    seedDiscussions(db, issueId);
    const h = discussionTools(db).handlers;
    const base = { agent: 'bro', issue_id: String(issueId) };

    const concise = await call(h, 'discussion_list', base);
    const detailed = await call(h, 'discussion_list', { ...base, response_format: 'detailed' });
    const rows = parse(concise) as Array<Record<string, unknown>>;
    assert.ok(rows.length >= SEED_ROWS);
    const decision = rows.find((r) => r['kind'] === 'decision')!;
    assert.equal(decision['body'], LONG_TEXT);
    assert.ok(!('body_truncated' in decision));
    const notes = rows.filter((r) => r['kind'] === 'note' && r['body_truncated'] === true);
    assert.ok(notes.length >= SEED_ROWS - 1);
    assert.ok(notes.every((r) => (r['body'] as string).length === 200));
    assert.ok((parse(detailed) as Array<Record<string, unknown>>).every((r) => !('body_truncated' in r)));
    assert.ok(bytes(concise) <= bytes(detailed) / 2, `concise ${bytes(concise)} vs detailed ${bytes(detailed)}`);

    const projected = parse(await call(h, 'discussion_list', { ...base, fields: ['kind', 'body'] })) as Array<Record<string, unknown>>;
    assert.ok(projected.every((r) => r['body'] === LONG_TEXT && !('body_truncated' in r)));
  });

  it('task_get: concise omits completion_report; detailed returns it', async () => {
    const db = tempDB();
    const { taskId } = await seedIssueAndTask(db);
    db.run('UPDATE tasks SET completion_report = ? WHERE id = ?', [JSON.stringify({ criteria: [{ id: 'SC1', note: LONG_TEXT }] }), taskId]);
    const h = taskTools(db).handlers;
    const base = { agent: 'bro', task_id: String(taskId) };

    const concise = await call(h, 'task_get', base);
    const detailed = await call(h, 'task_get', { ...base, response_format: 'detailed' });
    assert.ok(!('completion_report' in (parse(concise) as Record<string, unknown>)));
    assert.ok(((parse(detailed) as Record<string, unknown>)['completion_report'] as string).includes(LONG_TEXT));
    assert.ok(bytes(concise) < bytes(detailed));

    const withSpec = parse(await call(h, 'task_get', { ...base, include_spec_body: true })) as Record<string, unknown>;
    assert.ok('spec_body' in withSpec && !('completion_report' in withSpec));
  });

  it('every tool refuses an unknown response_format, naming the valid values', async () => {
    const db = tempDB();
    const { issueId, taskId } = await seedIssueAndTask(db);
    const cases: Array<[Handlers, string, Record<string, unknown>]> = [
      [auditTools(db).handlers, 'audit_list', { issue_id: String(issueId) }],
      [validationTools(db).handlers, 'validation_history', { task_id: String(taskId) }],
      [discussionTools(db).handlers, 'discussion_list', { issue_id: String(issueId) }],
      [taskTools(db).handlers, 'task_get', { task_id: String(taskId) }],
    ];
    for (const [h, name, args] of cases) {
      const res = await call(h, name, { agent: 'bro', ...args, response_format: 'terse' });
      assert.equal(res.isError, true, name);
      assert.equal((parse(res) as { error: string }).error, 'unknown response_format "terse"; valid values: concise, detailed', name);
    }
  });
});
