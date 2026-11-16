/**
 * PostToolUse gate (GH 3020): records the issues a session's lane owns. After a
 * successful intent_start, issue_create, issue_adopt_remote or task_provision
 * call it upserts the lanes row of the payload's session_id and adds the
 * call's issue to lane_issues. The issue is tool_input.issue_id, else the
 * issue_id, else the id, of the JSON the tool returned. The compaction restore
 * in session-handoff lists the lane's open issues. An error response, another
 * tool, an unknown issue or a malformed payload writes nothing. It never
 * blocks and never prints: any error exits 0 with no output. Bypass:
 * TMB_DISABLE_LANE_MEMBERSHIP_HOOK=1.
 */
import { SESSION_ID_LINE } from './activation-routine.js';
import { ALLOW, type SyncGate } from './gate.js';
import { dbWrite } from './lib/audit.js';
import { dbPath } from './lib/db.js';

export const GATE_NAME = 'lane-membership';
export const BYPASS_ENV = 'TMB_DISABLE_LANE_MEMBERSHIP_HOOK';

const MEMBERSHIP_TOOL = /^mcp__[\s\S]*trajectory-server__(?:intent_start|issue_create|issue_adopt_remote|task_provision)$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A positive integer id, given as a JSON number or a string of digits; null for anything else. */
function issueIdOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) return issueIdOf(Number(value));
  return null;
}

/** The text of the tool result's first content block: `content[0].text` of the response object, or `[0].text` of a bare block array. */
function responseText(response: unknown): string | null {
  const blocks = Array.isArray(response) ? response : asRecord(response)?.content;
  const text = Array.isArray(blocks) ? asRecord(blocks[0])?.text : undefined;
  return typeof text === 'string' ? text : null;
}

function isErrorResponse(response: unknown): boolean {
  const r = asRecord(response);
  return r !== null && (r.is_error === true || r.isError === true);
}

function issueFromResponse(response: unknown): number | null {
  const text = responseText(response);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const body = asRecord(parsed);
  if (body === null) return null;
  return issueIdOf(body.issue_id) ?? issueIdOf(body.id);
}

function membershipSql(sessionId: string, issueId: number): string {
  const issueExists = `EXISTS (SELECT 1 FROM issues WHERE id = ${issueId})`;
  return `
INSERT INTO lanes (session_id, created_at, updated_at)
SELECT '${sessionId}', ${NOW}, ${NOW} WHERE ${issueExists}
ON CONFLICT (session_id) DO UPDATE SET updated_at = excluded.updated_at;
INSERT INTO lane_issues (lane_id, issue_id, added_at)
SELECT id, ${issueId}, ${NOW} FROM lanes WHERE session_id = '${sessionId}' AND ${issueExists}
ON CONFLICT (lane_id, issue_id) DO NOTHING;
`;
}

export const laneMembership: SyncGate = (payload, env) => {
  if ((env[BYPASS_ENV] ?? '0') === '1') return ALLOW;
  try {
    const input = asRecord(JSON.parse(payload));
    if (input === null) return ALLOW;
    const sessionId = input.session_id;
    if (typeof input.tool_name !== 'string' || !MEMBERSHIP_TOOL.test(input.tool_name)) return ALLOW;
    if (typeof sessionId !== 'string' || !SESSION_ID_LINE.test(sessionId)) return ALLOW;
    if (isErrorResponse(input.tool_response)) return ALLOW;
    const issueId = issueIdOf(asRecord(input.tool_input)?.issue_id) ?? issueFromResponse(input.tool_response);
    if (issueId === null) return ALLOW;
    const db = dbPath(env);
    if (db !== null) dbWrite(db, membershipSql(sessionId, issueId), { env, caller: GATE_NAME });
    return ALLOW;
  } catch {
    return ALLOW;
  }
};
