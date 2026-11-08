/**
 * PreToolUse(task_provision) gate (GH 2329), born in TypeScript: bro reads
 * the world model before it plans a task (tmb_planning §1).
 *
 * An allowlist, in warn mode. The call is silent only when the session
 * transcript (`transcript_path`) holds an assistant tool_use of a world-model
 * read tool timestamped within the last WINDOW_MINUTES. Any other call — no
 * such read, only older ones, or a missing, unreadable or unparsable
 * transcript — is allowed with an additionalContext nudge and one
 * `wm_read_missing_before_provision` audit row. It never denies; a failed
 * audit write never blocks the call.
 */
import { readFileSync } from 'node:fs';
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { auditAppend } from './lib/audit.js';
import { dbPath } from './lib/db.js';
import { jqCompact } from './lib/jq.js';

export const GATE_NAME = 'wm-read-before-provision';

export const WINDOW_MINUTES = 60;

export const EVENT_TYPE = 'wm_read_missing_before_provision';

const WINDOW_MS = WINDOW_MINUTES * 60_000;
const PROVISION_TOOL = /trajectory-server__task_provision$/;
const WM_READ_TOOL = /trajectory-server__(world_model_get|world_model_search|world_model_symbol|world_model_concepts|world_model_concept_get|scope_suggest)$/;
const WM_READ_HINT = /trajectory-server__(world_model_|scope_suggest)/;

export type MissingReason = 'no_read' | 'transcript_unreadable';

interface Payload {
  tool_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  tool_input?: { issue_id?: unknown } | null;
}

interface TranscriptLine {
  type?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown } | null;
}

function parseLine(line: string): TranscriptLine | null {
  try {
    const v: unknown = JSON.parse(line);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as TranscriptLine) : null;
  } catch {
    return null;
  }
}

function isWmRead(block: unknown): boolean {
  if (block === null || typeof block !== 'object') return false;
  const b = block as { type?: unknown; name?: unknown };
  return b.type === 'tool_use' && typeof b.name === 'string' && WM_READ_TOOL.test(b.name);
}

/** Whether <transcript> holds an assistant world-model read tool_use timestamped in [now - window, now]. */
export function hasRecentWmRead(transcript: string, nowMs: number): boolean {
  const lines = transcript.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!WM_READ_HINT.test(line)) continue;
    const entry = parseLine(line);
    if (entry === null || entry.type !== 'assistant' || typeof entry.timestamp !== 'string') continue;
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at) || at > nowMs || nowMs - at > WINDOW_MS) continue;
    const content = entry.message?.content;
    if (Array.isArray(content) && content.some(isWmRead)) return true;
  }
  return false;
}

function readTranscript(path: unknown): string | null {
  if (typeof path !== 'string' || path === '') return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function nudge(reason: MissingReason): string {
  const seen =
    reason === 'transcript_unreadable'
      ? 'this session\'s transcript could not be read, so no world-model read is on record'
      : `no world-model read in this session's last ${WINDOW_MINUTES} minutes`;
  return (
    `TMB: task_provision with ${seen}. Read the world model before planning a task (tmb_planning §1): ` +
    'world_model_get, world_model_search, world_model_symbol or scope_suggest on the code the task touches, so the spec names real paths and symbols.'
  );
}

function issueIdOf(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  return /^[0-9]+$/.test(text) ? text : '-1';
}

function audit(payload: Payload, tool: string, reason: MissingReason, env: NodeJS.ProcessEnv): void {
  try {
    const db = dbPath(env);
    if (db === null) return;
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
    const content = { tool, session_id: sessionId, window_minutes: WINDOW_MINUTES, reason };
    const r = auditAppend(
      db,
      {
        issueId: issueIdOf(payload.tool_input?.issue_id),
        branchId: '',
        fromNode: `hook:${GATE_NAME}`,
        eventType: 'wm_read_missing_before_provision',
        summary: `task_provision with no world-model read in the last ${WINDOW_MINUTES} min (${reason})`,
        contentJson: JSON.stringify(content),
      },
      { caller: GATE_NAME, env },
    );
    if (!r.ok) process.stderr.write(`${r.error}\n`);
  } catch (e) {
    process.stderr.write(`${GATE_NAME}: audit write failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

export const wmReadBeforeProvision: SyncGate = (raw, env): GateResult => {
  let payload: Payload;
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    return ALLOW;
  }
  if (payload === null || typeof payload !== 'object') return ALLOW;
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (!PROVISION_TOOL.test(tool)) return ALLOW;

  const transcript = readTranscript(payload.transcript_path);
  if (transcript !== null && hasRecentWmRead(transcript, Date.now())) return ALLOW;

  const reason: MissingReason = transcript === null ? 'transcript_unreadable' : 'no_read';
  audit(payload, tool, reason, env);
  const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: nudge(reason) } };
  return { stdout: `${jqCompact(output)}\n`, code: 0 };
};
