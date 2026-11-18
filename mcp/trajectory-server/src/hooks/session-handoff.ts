/**
 * PreCompact gate and SessionStart consumer (GH 2275): restores bro's state
 * from the DB after Claude Code compacts a bro session. Before each
 * compaction, manual or auto, the PreCompact gate upserts the session's
 * session_handoffs row when the session has a bro agent_runs row, re-arming a
 * row an earlier compaction consumed. The SessionStart with source 'compact'
 * that follows takes that same session's row in session-start-persona's
 * context: the open issues the session's lane owns (GH 3020, recorded by
 * lane-membership) with their live task counts, then the issue, its live tasks
 * and its newest decision. The lane listing goes first because it is bounded
 * and the decision is not, so the cap never cuts it first. The gate never
 * blocks and never prints, because blocking an auto compact fails the
 * request: any error exits 0 with no output. Bypass:
 * TMB_DISABLE_SESSION_HANDOFF_HOOK=1.
 *
 * bro-turn-usage writes the bro row asynchronously, so a compaction before a
 * session's first turn has ended records nothing.
 */
import { SESSION_ID_LINE } from './activation-routine.js';
import { ALLOW, type SyncGate } from './gate.js';
import { dbWrite } from './lib/audit.js';
import { dbPath, sqliteRo, sqlQuote } from './lib/db.js';
import { LIVE, sqlList, TASK_STATE } from '../task-states.js';

export const GATE_NAME = 'session-handoff';

const LIVE_TASK_LIMIT = 20;
const LANE_ISSUE_LIMIT = 30;
const LANE_OBJECTIVE_CHARS = 160;
// Escalated tasks still wait on bro, so the handoff carries them with the live ones.
const LIVE_TASK_STATUSES = sqlList([...LIVE, TASK_STATE.escalated]);
const CONSUME_SOURCE = 'compact';
const HOOK_CONTEXT_CAP = 10_000;
const CONTEXT_SEPARATOR = '\n\n';
const MIN_BLOCK_CHARS = 200;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

interface LiveTask {
  id: number;
  status: string;
  title: string;
}

interface LaneIssue {
  id: number;
  objective: string;
  live_tasks: number;
  tasks: number;
}

interface LaneIssues {
  open_count: number;
  closed_count: number;
  open: LaneIssue[];
}

interface ConsumedHandoff {
  issue_id: number | null;
  objective: string | null;
  issue_status: string | null;
  tasks: LiveTask[];
  decision_id: number | null;
  decision: string | null;
}

function disabled(env: NodeJS.ProcessEnv): boolean {
  return (env.TMB_DISABLE_SESSION_HANDOFF_HOOK ?? '0') === '1';
}

function payloadObject(payload: string): Record<string, unknown> {
  const value: unknown = JSON.parse(payload);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_LINE.test(value);
}

function validCwd(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.includes('\0');
}

function truncated(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function upsertSql(sessionId: string, cwd: string): string {
  const issue = `(SELECT issue_id FROM agent_runs WHERE session_id = '${sessionId}' AND agent_type <> 'bro' AND issue_id IS NOT NULL ORDER BY id DESC LIMIT 1)`;
  return `
INSERT INTO session_handoffs (session_id, cwd, issue_id, summary, created_at, updated_at)
SELECT '${sessionId}', '${sqlQuote(cwd)}', ${issue}, NULL, ${NOW}, ${NOW}
 WHERE EXISTS (SELECT 1 FROM agent_runs WHERE agent_type = 'bro' AND session_id = '${sessionId}')
ON CONFLICT (session_id) DO UPDATE
   SET cwd = excluded.cwd, issue_id = excluded.issue_id, summary = NULL, updated_at = excluded.updated_at,
       consumed_at = NULL, consumed_by_session = NULL;
`;
}

export const sessionHandoff: SyncGate = (payload, env) => {
  if (disabled(env)) return ALLOW;
  try {
    const input = payloadObject(payload);
    const sessionId = input.session_id;
    const cwd = input.cwd;
    if (!validSessionId(sessionId) || !validCwd(cwd)) return ALLOW;
    const db = dbPath(env);
    if (db !== null) dbWrite(db, upsertSql(sessionId, cwd), { env, caller: GATE_NAME });
    return ALLOW;
  } catch {
    return ALLOW;
  }
};

function consumeSql(sessionId: string): string {
  const issueOfRow = 'session_handoffs.issue_id';
  const newestDecision = (column: string): string =>
    `(SELECT ${column} FROM discussions WHERE issue_id = ${issueOfRow} AND kind = 'decision' ORDER BY id DESC LIMIT 1)`;
  return `
UPDATE session_handoffs
   SET consumed_at = ${NOW}, consumed_by_session = '${sessionId}'
 WHERE session_id = '${sessionId}' AND consumed_at IS NULL
RETURNING json_object(
  'issue_id', issue_id,
  'objective', (SELECT objective FROM issues WHERE id = ${issueOfRow}),
  'issue_status', (SELECT status FROM issues WHERE id = ${issueOfRow}),
  'tasks', json((SELECT json_group_array(json_object('id', t.id, 'status', t.status, 'title', t.title))
                   FROM (SELECT id, status, title FROM tasks
                          WHERE issue_id = ${issueOfRow} AND status IN (${LIVE_TASK_STATUSES})
                          ORDER BY id DESC LIMIT ${LIVE_TASK_LIMIT}) t)),
  'decision_id', ${newestDecision('id')},
  'decision', ${newestDecision('body')});
`;
}

/** The lane's open issues, newest first, at most LANE_ISSUE_LIMIT of them, and its open and closed issue counts. */
function laneSql(sessionId: string): string {
  const owned = `FROM lane_issues li JOIN lanes l ON l.id = li.lane_id JOIN issues i ON i.id = li.issue_id WHERE l.session_id = '${sessionId}'`;
  return `
SELECT json_object(
  'open_count', (SELECT count(*) ${owned} AND i.status = 'open'),
  'closed_count', (SELECT count(*) ${owned} AND i.status <> 'open'),
  'open', json((SELECT json_group_array(json_object('id', o.id, 'objective', o.objective, 'live_tasks', o.live_tasks, 'tasks', o.tasks))
                  FROM (SELECT i.id, i.objective,
                               (SELECT count(*) FROM tasks t WHERE t.issue_id = i.id AND t.status IN (${LIVE_TASK_STATUSES})) AS live_tasks,
                               (SELECT count(*) FROM tasks t WHERE t.issue_id = i.id) AS tasks
                          ${owned} AND i.status = 'open'
                         ORDER BY i.id DESC LIMIT ${LANE_ISSUE_LIMIT}) o)));
`;
}

/** The lane listing, or none when the read fails or the lane owns no issue. */
function laneLines(lane: LaneIssues | null): string[] {
  if (lane === null || lane.open_count + lane.closed_count === 0) return [];
  const lines = [`This session's lane owns ${lane.open_count} open and ${lane.closed_count} closed issues.${lane.open_count > 0 ? ' Its open issues:' : ''}`];
  for (const i of lane.open) {
    const objective = truncated(i.objective.replace(/\s+/g, ' ').trim(), LANE_OBJECTIVE_CHARS);
    lines.push(`- #${i.id} ${objective} (${i.live_tasks} live tasks)${i.tasks === 0 ? ' unstarted' : ''}`);
  }
  const hidden = lane.open_count - lane.open.length;
  if (hidden > 0) lines.push(`+${hidden} more`);
  return lines;
}

function laneIssues(db: string, sessionId: string, env: NodeJS.ProcessEnv): LaneIssues | null {
  try {
    const out = sqliteRo(db, laneSql(sessionId), env).trim();
    return out === '' ? null : (JSON.parse(out) as LaneIssues);
  } catch {
    return null;
  }
}

function handoffBlock(h: ConsumedHandoff, lane: LaneIssues | null): string {
  const lines = ['[Compaction restore: Claude Code compacted this bro session; its state below was read from the DB just now]'];
  lines.push(...laneLines(lane));
  if (h.issue_id === null) lines.push('No issue was recorded for this session.');
  else {
    const status = h.issue_status === null || h.issue_status === 'open' ? '' : ` (status: ${h.issue_status})`;
    lines.push(`Issue #${h.issue_id}${status}: ${h.objective ?? ''}`);
  }
  if (h.tasks.length > 0) {
    lines.push('Its open tasks. Use task_brief on them:');
    for (const t of h.tasks) lines.push(`- #${t.id} [${t.status}] ${t.title}`);
  }
  if (h.decision !== null) {
    lines.push(`Its newest decision (discussion #${h.decision_id ?? '?'}):`);
    lines.push(h.decision.replace(/^/gm, '> '));
  }
  return lines.join('\n');
}

/** <context> with the state this session recorded before its compaction appended, within the hook's cap; <context> itself on any other source, when there is none or on any failure. */
export function withHandoff(context: string, payload: string, env: NodeJS.ProcessEnv): string {
  if (disabled(env)) return context;
  try {
    const input = payloadObject(payload);
    const sessionId = input.session_id;
    if (input.source !== CONSUME_SOURCE || !validSessionId(sessionId) || !validCwd(input.cwd)) return context;
    const room = HOOK_CONTEXT_CAP - context.length - CONTEXT_SEPARATOR.length;
    if (room < MIN_BLOCK_CHARS) return context;
    const db = dbPath(env);
    if (db === null) return context;
    const written = dbWrite(db, consumeSql(sessionId), { env, caller: GATE_NAME });
    if (!written.ok || written.stdout.trim() === '') return context;
    const block = handoffBlock(JSON.parse(written.stdout) as ConsumedHandoff, laneIssues(db, sessionId, env));
    return `${context}${CONTEXT_SEPARATOR}${truncated(block, room)}`;
  } catch {
    return context;
  }
}
