/**
 * SubagentStop recorder (GH 1905), run fail-open by swe-atomic-close.sh after
 * it writes the spawn's agent_runs row: records why the swe run stopped short
 * on that row (agent_runs.stop_cause / stop_detail, schema v52).
 *
 *   - budget: the task's checkpoint was written in the run (checkpoint.at >=
 *     TMB_STOP_SINCE), so swe handed back instead of running on;
 *   - hook_block: otherwise, when the run's last tool_result in the transcript
 *     at agent_transcript_path (entries from TMB_STOP_SINCE on, results of
 *     task_update_status and task_brief skipped) is an error whose text starts
 *     `PreToolUse:<tool> hook error:`; stop_detail is that text, capped at 500
 *     characters;
 *   - else both NULL.
 *
 * The row is the newest swe row of task TMB_STOP_TASK_ID keyed by spawn_id
 * TMB_STOP_SPAWN_ID. Never denies: it always exits 0 with empty stdout, and a
 * missing DB, transcript or env value or a failed read or write changes nothing.
 */
import { readFileSync } from 'node:fs';
import { ALLOW, type GateResult } from './gate.js';
import { dbWrite } from './lib/audit.js';
import { dbPath, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt, sqlQuote } from './lib/db.js';
import { jqAlternatives } from './lib/jq.js';

export const GATE_NAME = 'swe-stop-cause';
export const STOP_DETAIL_MAX_CHARS = 500;
const HOOK_DENY_RE = /^PreToolUse:\S+ hook error:/;
const SKIPPED_TOOL_RE = /(^|__)(task_update_status|task_brief)$/;

export type StopCause = 'budget' | 'hook_block';

export interface Stop {
  cause: StopCause;
  detail: string | null;
}

interface Block {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
  text?: unknown;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && typeof (c as Block).text === 'string' ? ((c as Block).text as string) : ''))
    .filter((t) => t !== '')
    .join('\n');
}

/** The deny text of the run's last counted tool_result when it is a PreToolUse hook block, else null. */
export function hookBlockDetail(transcriptText: string, sinceMs: number): string | null {
  const names = new Map<string, string>();
  let last: { toolUseId: string; isError: boolean; text: string } | null = null;
  for (const line of transcriptText.split('\n')) {
    if (line.trim() === '') continue;
    let entry: { timestamp?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    const inWindow = !Number.isNaN(ts) && ts >= sinceMs;
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as Block;
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        names.set(block.id, block.name);
      } else if (block.type === 'tool_result' && inWindow) {
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        if (SKIPPED_TOOL_RE.test(names.get(toolUseId) ?? '')) continue;
        last = { toolUseId, isError: block.is_error === true, text: resultText(block.content) };
      }
    }
  }
  if (!last || !last.isError || !HOOK_DENY_RE.test(last.text)) return null;
  return last.text.slice(0, STOP_DETAIL_MAX_CHARS);
}

function readTranscript(path: string): string {
  if (path === '') return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The stop of task <taskId>'s run from <sinceMs> on, or null when it stopped cleanly; undefined when the DB read failed. */
export function stopCause(
  db: string,
  taskId: string,
  sinceMs: number,
  transcriptPath: string,
  env: NodeJS.ProcessEnv,
): Stop | null | undefined {
  const at = gateRead(
    db,
    `SELECT json_extract(checkpoint, '$.at') FROM tasks WHERE id = ${taskId} AND json_valid(checkpoint);`,
    env,
  );
  if (at === GATE_READ_ERROR) return undefined;
  const atMs = at === '' ? NaN : Date.parse(at);
  if (!Number.isNaN(atMs) && atMs >= sinceMs) return { cause: 'budget', detail: null };
  const detail = hookBlockDetail(readTranscript(transcriptPath), sinceMs);
  return detail === null ? null : { cause: 'hook_block', detail };
}

const sqlText = (v: string | null): string => (v === null ? 'NULL' : `'${sqlQuote(v)}'`);

export function sweStopCause(payload: string, env: NodeJS.ProcessEnv): GateResult {
  try {
    const taskId = sqlInt(env.TMB_STOP_TASK_ID ?? '');
    const spawnId = env.TMB_STOP_SPAWN_ID ?? '';
    const sinceMs = Date.parse(env.TMB_STOP_SINCE ?? '');
    if (taskId === '' || spawnId === '' || Number.isNaN(sinceMs)) return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env)) return ALLOW;
    const stop = stopCause(db, taskId, sinceMs, jqAlternatives(payload, [['agent_transcript_path']]), env);
    if (stop === undefined) return ALLOW;
    dbWrite(
      db,
      `UPDATE agent_runs SET stop_cause = ${sqlText(stop?.cause ?? null)}, stop_detail = ${sqlText(stop?.detail ?? null)}
        WHERE id = (SELECT id FROM agent_runs
                     WHERE task_id = ${taskId} AND agent_type = 'swe' AND spawn_id = '${sqlQuote(spawnId)}'
                     ORDER BY id DESC LIMIT 1);`,
      { caller: GATE_NAME, env },
    );
  } catch {
    // A recorder never fails its hook.
  }
  return ALLOW;
}
