import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDB } from './helpers.js';
import { AUDIT_EVENT_TYPES, assertAuditEventType, isAuditEventType, type AuditEventType } from '../audit-events.js';
import { AuditWriterError, auditTools, insertAudit } from '../tools/audit.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const TXT = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/hooks/lib/audit-events.txt');

describe('AUDIT_EVENT_TYPES — the closed audit.event_type set', () => {
  it('every value has a one-line description', () => {
    for (const e of AUDIT_EVENT_TYPES) {
      assert.match(e.type, /^[a-z][a-z0-9_]*$/, `type ${e.type} is snake_case`);
      assert.ok(e.description.trim().length > 0, `${e.type} has a description`);
      assert.ok(!e.description.includes('\n'), `${e.type} description is one line`);
    }
  });

  it('holds no duplicates', () => {
    const types = AUDIT_EVENT_TYPES.map((e) => e.type);
    assert.equal(new Set(types).size, types.length);
  });

  it('every value names at least one known writer', () => {
    const known = new Set(['bro', 'swe', 'pr-reviewer', 'consultant', 'server', 'hook']);
    for (const e of AUDIT_EVENT_TYPES) {
      assert.ok(e.writers.length > 0, `${e.type} has writers`);
      for (const w of e.writers) assert.ok(known.has(w), `${e.type} writer ${w} is known`);
    }
  });

  it('every *_gate_waived event is written by bro or a hook only', () => {
    for (const e of AUDIT_EVENT_TYPES.filter((x) => x.type.endsWith('_gate_waived'))) {
      for (const w of e.writers) assert.ok(w === 'bro' || w === 'hook', `${e.type} writer ${w}`);
    }
  });

  it('the generated hook list equals the TS list, one event<TAB>writers line each', () => {
    const lines = readFileSync(TXT, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.deepEqual(lines, AUDIT_EVENT_TYPES.map((e) => `${e.type}\t${e.writers.join(',')}`));
  });

  it('isAuditEventType / assertAuditEventType accept members and reject everything else', () => {
    assert.equal(isAuditEventType('planning_complete'), true);
    assert.equal(isAuditEventType('not_an_event'), false);
    assert.equal(isAuditEventType(undefined), false);
    assert.equal(assertAuditEventType('planning_complete'), 'planning_complete');
    assert.throws(() => assertAuditEventType('not_an_event'), /unknown audit event_type 'not_an_event'/);
  });
});

describe('server writers reject an unknown event_type', () => {
  it('insertAudit throws a named error and writes nothing', () => {
    const db = tempDB();
    const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit')?.n;
    assert.throws(
      () => insertAudit(db, { issue_id: -1, from_node: 'bro', event_type: 'not_an_event' as AuditEventType, summary: 's' }),
      /unknown audit event_type 'not_an_event'. Allowed: .*planning_complete/,
    );
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit')?.n, before);
    db.close();
  });

  it('audit_append returns is_error listing the allowed set', async () => {
    const db = tempDB();
    const r = (await auditTools(db).handlers['audit_append']!({
      agent: 'bro',
      issue_id: '-1',
      from_node: 'bro',
      event_type: 'swe_retry_spawned',
      summary: 's',
    })) as RawResult;
    assert.equal(r.isError, true);
    const error = (JSON.parse(r.content[0]!.text) as { error: string }).error;
    assert.match(error, /unknown audit event_type 'swe_retry_spawned'/);
    for (const e of AUDIT_EVENT_TYPES) assert.ok(error.includes(e.type), `allowed list names ${e.type}`);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'swe_retry_spawned'")?.n, 0);
    db.close();
  });

  it('audit_append advertises the closed set in its input schema', () => {
    const def = auditTools(tempDB()).definitions.find((d) => d.name === 'audit_append');
    const prop = (def?.inputSchema.properties as Record<string, { enum?: string[] }>)['event_type'];
    assert.deepEqual(prop?.enum, AUDIT_EVENT_TYPES.map((e) => e.type));
  });
});

describe('audit_append — who may write which event', () => {
  async function append(db: ReturnType<typeof tempDB>, args: Record<string, unknown>): Promise<RawResult> {
    return (await auditTools(db).handlers['audit_append']!({ issue_id: '-1', summary: 's', ...args })) as RawResult;
  }

  it('bro writes a bro event; from_node is recorded as bro without being passed', async () => {
    const db = tempDB();
    const r = await append(db, { agent: 'bro', event_type: 'scope_gate_waived' });
    assert.ok(!r.isError, r.content[0]!.text);
    assert.equal((JSON.parse(r.content[0]!.text) as { from_node: string }).from_node, 'bro');
    db.close();
  });

  for (const agent of ['pr-reviewer', 'swe', 'architect']) {
    it(`${agent} is refused on scope_gate_waived with the allowed writers`, async () => {
      const db = tempDB();
      const r = await append(db, { agent, from_node: 'bro', event_type: 'scope_gate_waived' });
      assert.equal(r.isError, true);
      const body = JSON.parse(r.content[0]!.text) as { error: string; caller_role: string; allowed_writers: string[] };
      assert.equal(body.error, 'audit_event_not_writable_by_role');
      assert.equal(body.caller_role, agent === 'architect' ? 'consultant' : agent);
      assert.deepEqual(body.allowed_writers, ['bro']);
      assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'scope_gate_waived'")?.n, 0);
      db.close();
    });
  }

  it('a from_node other than the calling agent is refused', async () => {
    const db = tempDB();
    const r = await append(db, { agent: 'bro', from_node: 'pr-reviewer', event_type: 'roundtable_summary' });
    assert.equal(r.isError, true);
    assert.match((JSON.parse(r.content[0]!.text) as { error: string }).error, /from_node 'pr-reviewer' does not match/);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'roundtable_summary'")?.n, 0);
    db.close();
  });

  it('a non-bro writer records its own role as from_node', async () => {
    const db = tempDB();
    const r = await append(db, { agent: 'pr-reviewer', event_type: 'mcp_unavailable_fallback_invoked' });
    assert.ok(!r.isError, r.content[0]!.text);
    assert.equal((JSON.parse(r.content[0]!.text) as { from_node: string }).from_node, 'pr-reviewer');
    db.close();
  });

  it('a hook-only or server-only event is refused for every agent', async () => {
    const db = tempDB();
    for (const event_type of ['verification_gate_waived', 'task_escalated_repair']) {
      const r = await append(db, { agent: 'bro', event_type });
      assert.equal(r.isError, true, event_type);
      assert.equal((JSON.parse(r.content[0]!.text) as { error: string }).error, 'audit_event_not_writable_by_role');
    }
    db.close();
  });
});

describe('legacy_event — written only by the schema-38 and schema-39 migrations', () => {
  for (const agent of ['bro', 'swe', 'pr-reviewer', 'architect']) {
    it(`audit_append refuses legacy_event for ${agent}`, async () => {
      const db = tempDB();
      const r = (await auditTools(db).handlers['audit_append']!({
        agent,
        issue_id: '-1',
        summary: 's',
        event_type: 'legacy_event',
      })) as RawResult;
      assert.equal(r.isError, true);
      const body = JSON.parse(r.content[0]!.text) as { error: string; allowed_writers: string[] };
      assert.equal(body.error, 'audit_event_not_writable_by_role');
      assert.deepEqual(body.allowed_writers, ['server']);
      assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'legacy_event'")?.n, 0);
      db.close();
    });
  }
});

describe('insertAudit writer check', () => {
  it('throws AuditWriterError and writes nothing when the writer is not listed', () => {
    const db = tempDB();
    assert.throws(
      () => insertAudit(db, { issue_id: -1, from_node: 'pr-reviewer', event_type: 'review_gate_waived', summary: 's', writer: 'pr-reviewer' }),
      (e: unknown) => e instanceof AuditWriterError && /audit_event_not_writable_by_role/.test(e.message),
    );
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'review_gate_waived'")?.n, 0);
    assert.ok(insertAudit(db, { issue_id: -1, from_node: 'bro', event_type: 'review_gate_waived', summary: 's', writer: 'bro' }) > 0);
    db.close();
  });
});
