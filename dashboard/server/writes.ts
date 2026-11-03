import type { DatabaseSync } from 'node:sqlite';
import { TARGET_SCHEMA_VERSION, TrajectoryDB, nowISO } from '../../mcp/trajectory-server/src/db.ts';
import { issueTools } from '../../mcp/trajectory-server/src/tools/issues.ts';
import { discussionTools } from '../../mcp/trajectory-server/src/tools/discussions.ts';
import { insertAudit } from '../../mcp/trajectory-server/src/tools/audit.ts';
import * as q from './queries.ts';

// The Human writes through the trajectory server's own handlers, so role rules,
// validation, label checks and close refusals match bro's. The handlers gate on
// `agent`; Human attribution rides on the comment author and the audit row.
const GATE_AGENT = 'bro';

export const WRITE_ACTIONS = ['edit', 'comment', 'close'] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];

export function isWriteAction(value: string): value is WriteAction {
  return (WRITE_ACTIONS as readonly string[]).includes(value);
}

export interface WriteResult {
  status: number;
  body: Record<string, unknown>;
}

type Handler = ReturnType<typeof issueTools>['handlers'][string];
type Body = Record<string, unknown>;

interface Writable {
  db: TrajectoryDB;
  handlers: Record<string, Handler>;
}

const ALLOWED_KEYS: Record<WriteAction, readonly string[]> = {
  edit: ['updated_at', 'objective', 'description', 'labels', 'milestone'],
  comment: ['body'],
  close: ['updated_at'],
};

const fail = (status: number, error: string, message: string, extra: Body = {}): WriteResult => ({
  status,
  body: { error, message, ...extra },
});

function parseHandlerResult(result: Awaited<ReturnType<Handler>>): { ok: boolean; data: Body } {
  const first = result.content[0];
  const text = first && first.type === 'text' ? first.text : '{}';
  let data: Body;
  try {
    data = JSON.parse(text) as Body;
  } catch {
    data = { error: 'unparseable_result', message: text };
  }
  return { ok: result.isError !== true, data };
}

function handlerError(tool: string, data: Body, applied: string[] = []): WriteResult {
  const code = typeof data['error'] === 'string' ? data['error'] : 'handler_error';
  const message = typeof data['message'] === 'string' ? data['message'] : code;
  return fail(422, code, message, { ...data, error: code, message, tool, applied });
}

type CheckedCall =
  | { stale: true; current: string | null }
  | { stale: false; ok: boolean; data: Body; after: string | null };

const stale = (current: string | null, applied: string[] = []): WriteResult =>
  fail(409, 'stale', 'The issue changed since you loaded it. Reload to see the latest, then retry.', {
    updated_at: current,
    applied,
  });

interface EditFields {
  update: Body;
  description?: string;
}

function parseEdit(body: Body): EditFields | string {
  const update: Body = {};
  for (const key of ['objective', 'milestone'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'string') return `${key} must be a string`;
    update[key] = body[key];
  }
  if (body['labels'] !== undefined) {
    const labels = body['labels'];
    if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) {
      return 'labels must be an array of strings';
    }
    update['labels'] = labels;
  }
  const description = body['description'];
  if (description !== undefined && typeof description !== 'string') return 'description must be a string';
  if (Object.keys(update).length === 0 && description === undefined) {
    return 'pass at least one of objective, description, labels, milestone';
  }
  return description === undefined ? { update } : { update, description };
}

export class IssueWriter {
  private writable: Writable | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly readDb: DatabaseSync,
  ) {}

  private open(): Writable {
    if (this.writable) return this.writable;
    const noop = (): void => {};
    const db = new TrajectoryDB(
      this.dbPath,
      { pluginVersion: null, serverLog: noop, sqlLog: noop },
    );
    this.writable = {
      db,
      handlers: { ...issueTools(db, this.dbPath).handlers, ...discussionTools(db).handlers },
    };
    return this.writable;
  }

  close(): void {
    this.writable?.db.close();
    this.writable = null;
  }

  async perform(action: WriteAction, issueId: number, body: Body): Promise<WriteResult> {
    const unknown = Object.keys(body).filter((k) => !ALLOWED_KEYS[action].includes(k));
    if (unknown.length > 0) {
      return fail(400, 'unknown_fields', `${action} does not take: ${unknown.join(', ')}`);
    }

    const dbVersion = q.schemaVersion(this.readDb);
    if (dbVersion !== TARGET_SCHEMA_VERSION) {
      return fail(
        409,
        'schema_version_mismatch',
        `The DB is at schema version ${dbVersion ?? 'unknown'} and this dashboard writes version ${TARGET_SCHEMA_VERSION}. ` +
          'Open a Claude Code session with the current plugin, then restart the dashboard.',
        { db_version: dbVersion, dashboard_version: TARGET_SCHEMA_VERSION },
      );
    }

    if (q.issueUpdatedAt(this.readDb, issueId) === null) return fail(404, 'not_found', `issue ${issueId} not found`);

    if (action === 'comment') return this.comment(issueId, body);

    const rendered = body['updated_at'];
    if (typeof rendered !== 'string') {
      return fail(400, 'updated_at_required', 'send the updated_at you rendered');
    }
    return action === 'edit' ? this.edit(issueId, body, rendered) : this.closeIssue(issueId, rendered);
  }

  private handler(tool: string): Handler {
    const handler = this.open().handlers[tool];
    if (!handler) throw new Error(`trajectory-server handler ${tool} missing`);
    return handler;
  }

  private async call(tool: string, args: Body): Promise<{ ok: boolean; data: Body }> {
    return parseHandlerResult(await this.handler(tool)({ agent: GATE_AGENT, ...args }));
  }

  private updatedAt(issueId: number): string | null {
    const row = this.open().db.get<{ updated_at: string }>('SELECT updated_at FROM issues WHERE id = ?', [issueId]);
    return row ? row.updated_at : null;
  }

  // The updated_at check and the handler's local write share one BEGIN IMMEDIATE,
  // so no other process can write the issue in between. The handlers write
  // before their first await (remote sync), so the write lands inside it and the
  // lock is released before any remote call.
  private async callIfCurrent(issueId: number, tool: string, args: Body, expected: string): Promise<CheckedCall> {
    const handler = this.handler(tool);
    const step = this.open().db.transaction(() => {
      const current = this.updatedAt(issueId);
      if (current !== expected) return { stale: true as const, current };
      const pending = handler({ agent: GATE_AGENT, ...args });
      return { stale: false as const, pending, after: this.updatedAt(issueId) };
    });
    if (step.stale) return { stale: true, current: step.current };
    return { stale: false, ...parseHandlerResult(await step.pending), after: step.after };
  }

  private audit(issueId: number, tool: string, fields: string[], extra: Body = {}): void {
    insertAudit(this.open().db, {
      issue_id: issueId,
      from_node: 'dashboard',
      event_type: 'issue_updated',
      summary: `the Human ran ${tool} on issue ${issueId} from the dashboard (${fields.join(', ')})`,
      content_json: JSON.stringify({ actor: 'human', source: 'dashboard', tool, issue_id: issueId, fields, ...extra }),
      created_at: nowISO(),
    });
  }

  private done(issueId: number, tools: string[], extra: Body = {}): WriteResult {
    return { status: 200, body: { ok: true, tools, updated_at: q.issueUpdatedAt(this.readDb, issueId), ...extra } };
  }

  private async edit(issueId: number, body: Body, rendered: string): Promise<WriteResult> {
    const fields = parseEdit(body);
    if (typeof fields === 'string') return fail(400, 'invalid_fields', fields);
    const applied: string[] = [];
    let expected: string | null = rendered;
    const updateKeys = Object.keys(fields.update);
    if (updateKeys.length > 0) {
      const res = await this.callIfCurrent(issueId, 'issue_update', { issue_id: String(issueId), ...fields.update }, expected);
      if (res.stale) return stale(res.current, applied);
      if (!res.ok) return handlerError('issue_update', res.data, applied);
      this.audit(issueId, 'issue_update', updateKeys);
      applied.push('issue_update');
      expected = res.after;
    }
    if (fields.description !== undefined) {
      if (expected === null) return stale(null, applied);
      const res = await this.callIfCurrent(
        issueId,
        'issue_update_description',
        { issue_id: String(issueId), description: fields.description },
        expected,
      );
      if (res.stale) return stale(res.current, applied);
      if (!res.ok) return handlerError('issue_update_description', res.data, applied);
      this.audit(issueId, 'issue_update_description', ['description']);
      applied.push('issue_update_description');
    }
    return this.done(issueId, applied);
  }

  private async comment(issueId: number, body: Body): Promise<WriteResult> {
    const text = body['body'];
    if (typeof text !== 'string' || text.trim() === '') {
      return fail(400, 'invalid_fields', 'body must be a non-empty string');
    }
    const res = await this.call('discussion_append', {
      issue_id: String(issueId),
      author: 'dashboard',
      kind: 'note',
      body: text,
    });
    if (!res.ok) return handlerError('discussion_append', res.data);
    this.audit(issueId, 'discussion_append', ['comment'], { discussion_id: res.data['id'] });
    return this.done(issueId, ['discussion_append'], { discussion_id: res.data['id'] });
  }

  private async closeIssue(issueId: number, rendered: string): Promise<WriteResult> {
    const res = await this.callIfCurrent(issueId, 'issue_close', { issue_id: String(issueId) }, rendered);
    if (res.stale) return stale(res.current);
    if (!res.ok) return handlerError('issue_close', res.data);
    this.audit(issueId, 'issue_close', ['status']);
    return this.done(issueId, ['issue_close'], { issue_status: res.data['status'] });
  }
}
