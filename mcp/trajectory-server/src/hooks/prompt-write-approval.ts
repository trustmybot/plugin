/**
 * PreToolUse(Edit|Write|MultiEdit) gate (GH 2927), born in TypeScript: a
 * project skill or agent file changes only on the Human's approval. A target
 * under the project root with a `.claude/skills/` or `.claude/agents/` path
 * segment needs a prompt_write_approved audit row naming its canonical path
 * from the last APPROVAL_WINDOW_MINUTES; a swe (task-gated and reviewed) is
 * exempt. With the newest such row scoped `skills-array`, an edit to an
 * existing agent file may change only its frontmatter `skills:` list. It
 * fails closed: no trajectory DB, no sqlite, or no approval row denies.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { pathCanonical } from './lib/agent-context.js';
import { DB_RETRY_FIX, dbPath, haveSqlite, projectRoot, sqlQuote, sqliteRo } from './lib/db.js';
import { type DenyFix, denyResult } from './lib/deny.js';
import { agentRole } from './lib/role.js';

export const GATE_NAME = 'prompt-write-approval';

export const EVENT_TYPE = 'prompt_write_approved';

export const APPROVAL_WINDOW_MINUTES = 30;

const APPROVED_PREFIX = 'approved:';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const PROMPT_DIR = /(^|\/)\.claude\/(skills|agents)\//;
const AGENT_DIR = /(^|\/)\.claude\/agents\//;

export const UNVERIFIABLE_REASON =
  'BLOCKED: a project skill or agent write needs a Human approval record, and the trajectory DB is unavailable to verify it — failing closed.';

export function notApprovedReason(path: string): string {
  return `BLOCKED: no Human approval in the last ${APPROVAL_WINDOW_MINUTES} minutes for the project skill/agent write to ${path}. Ask the Human with AskUserQuestion first; a Yes is recorded as audit event ${EVENT_TYPE}.`;
}

export function notApprovedFix(path: string): DenyFix {
  return {
    allowed: `after the Human's AskUserQuestion Yes, audit_append(agent='bro', issue_id=<issue>, event_type='${EVENT_TYPE}', summary=<what the Human approved>, content_json='${JSON.stringify({ path, scope: 'full' })}') (scope "skills-array" to change only an agent's skills: list), then the same write`,
  };
}

export function skillsOnlyReason(path: string): string {
  return `BLOCKED: the Human's approval for ${path} is scoped skills-array: only the frontmatter skills: list may change, and this edit changes the rest of the file.`;
}

export function skillsOnlyFix(path: string): DenyFix {
  return {
    allowed: `an edit that changes only the skills: list of ${path}, or ask the Human again and audit_append event_type='${EVENT_TYPE}' with scope "full"`,
  };
}

interface EditSpec {
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

interface Payload {
  tool_name?: unknown;
  cwd?: unknown;
  tool_input?: (EditSpec & { file_path?: unknown; content?: unknown; edits?: unknown }) | null;
}

export function approvalSql(path: string): string {
  return `
  SELECT '${APPROVED_PREFIX}' || COALESCE(json_extract(content_json, '$.scope'), '') FROM audit
   WHERE event_type = 'prompt_write_approved'
     AND from_node = 'bro'
     AND json_extract(content_json, '$.path') = '${sqlQuote(path)}'
     AND julianday(created_at) >= julianday('now', '-${APPROVAL_WINDOW_MINUTES} minutes')
   ORDER BY julianday(created_at) DESC, id DESC
  LIMIT 1;
`;
}

function underRoot(path: string, root: string): string | null {
  if (root === '' || root === '/') return null;
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/** One Edit applied as the Edit tool does, or null when old_string is not found. */
function applyEdit(text: string, edit: EditSpec): string | null {
  const from = typeof edit.old_string === 'string' ? edit.old_string : '';
  const to = typeof edit.new_string === 'string' ? edit.new_string : '';
  const at = text.indexOf(from);
  if (at < 0) return null;
  if (edit.replace_all === true && from !== '') return text.split(from).join(to);
  return `${text.slice(0, at)}${to}${text.slice(at + from.length)}`;
}

function postEditText(tool: string, current: string, input: NonNullable<Payload['tool_input']>): string | null {
  if (tool === 'Write') return typeof input.content === 'string' ? input.content : '';
  if (tool === 'Edit') return applyEdit(current, input);
  if (!Array.isArray(input.edits)) return null;
  let text: string | null = current;
  for (const edit of input.edits as EditSpec[]) {
    if (text === null) return null;
    text = applyEdit(text, edit ?? {});
  }
  return text;
}

const isFence = (line: string): boolean => line.replace(/\r$/, '') === '---';

/** <text> minus its frontmatter `skills:` entry: an inline `skills: [..]` (its continuation lines too) or the `skills:` line with its `- item` lines. */
export function withoutSkillsEntry(text: string): string {
  const lines = text.split('\n');
  if (lines.length === 0 || !isFence(lines[0])) return text;
  const close = lines.findIndex((line, i) => i > 0 && isFence(line));
  if (close < 0) return text;
  const at = lines.findIndex((line, i) => i > 0 && i < close && /^skills\s*:/.test(line));
  if (at < 0) return text;
  const value = lines[at].replace(/^skills\s*:/, '').trim();
  let end = at + 1;
  if (value === '') {
    while (end < close && /^\s*-(\s|$)/.test(lines[end])) end++;
  } else if (value.startsWith('[') && !value.includes(']')) {
    while (end < close && !lines[end].includes(']')) end++;
    end = Math.min(end + 1, close);
  }
  return [...lines.slice(0, at), ...lines.slice(end)].join('\n');
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export const promptWriteApproval: SyncGate = (raw, env): GateResult => {
  let payload: Payload;
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    return ALLOW;
  }
  if (payload === null || typeof payload !== 'object') return ALLOW;
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const input = payload.tool_input;
  if (!EDIT_TOOLS.has(tool) || input === null || typeof input !== 'object') return ALLOW;
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  if (filePath === '') return ALLOW;

  const root = projectRoot(env);
  const base = typeof payload.cwd === 'string' && isAbsolute(payload.cwd) ? payload.cwd : root;
  const target = pathCanonical(isAbsolute(filePath) ? filePath : resolve(base, filePath));
  const rel = underRoot(target, pathCanonical(root));
  if (rel === null || !PROMPT_DIR.test(rel)) return ALLOW;
  if (agentRole(raw) === 'swe') return ALLOW;

  const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
  if (db === null || !haveSqlite(env)) return denyResult(UNVERIFIABLE_REASON, DB_RETRY_FIX);
  const row = sqliteRo(db, approvalSql(target), env).split('\n')[0];
  if (!row.startsWith(APPROVED_PREFIX)) return denyResult(notApprovedReason(target), notApprovedFix(target));
  const scope = row.slice(APPROVED_PREFIX.length);

  if (scope === 'full' || !AGENT_DIR.test(rel) || !isFile(target)) return ALLOW;
  let current: string;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    return denyResult(skillsOnlyReason(target), skillsOnlyFix(target));
  }
  const next = postEditText(tool, current, input);
  if (next === null) return ALLOW;
  if (withoutSkillsEntry(next) === withoutSkillsEntry(current)) return ALLOW;
  return denyResult(skillsOnlyReason(target), skillsOnlyFix(target));
};
