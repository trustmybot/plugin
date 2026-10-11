import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDB } from './helpers.js';
import { AUDIT_EVENT_TYPES, assertAuditEventType, isAuditEventType, type AuditEventType } from '../audit-events.js';
import { auditTools, insertAudit } from '../tools/audit.js';

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

  it('the generated hook list equals the TS list', () => {
    const lines = readFileSync(TXT, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.deepEqual(lines, AUDIT_EVENT_TYPES.map((e) => e.type));
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
