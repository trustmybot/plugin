/**
 * PreToolUse(Edit|Write|MultiEdit) gate (GH 2927), born in TypeScript: a
 * project skill or agent file changes only on the Human's approval. A target
 * under the project root with a `.claude/skills/` or `.claude/agents/` path
 * segment (in any letter case, on its spelled or its resolved path), or one
 * resolving into the project's own skill or agent dirs or their symlinked
 * entries, needs a prompt_write_approved audit row naming its canonical path
 * from the last APPROVAL_WINDOW_MINUTES; a swe (task-gated and reviewed) is
 * exempt. With the newest such row scoped `skills-array`, an edit to an
 * existing agent file may change only its frontmatter `skills:` list. It
 * fails closed: no trajectory DB, no sqlite, or no approval row denies.
 *
 * Bash (GH 2942): each write target the cmd-analysis analyzer finds is judged
 * the same way, and every gated one needs its own approval scoped `full`, since
 * a shell write cannot be held to the skills: list. The analyzer's cap line
 * denies; its never-judged targets are containment-guard's. A command with no
 * gated target reads no DB.
 *
 * A write naming only a dir above the prompt dirs (GH 2981) is gated too: a
 * `.claude`, `.claude/skills` or `.claude/agents` dir for any write, and the
 * root, any ancestor of it or of where the prompt dirs resolve when a whole
 * tree lands there (the analyzer's treeWrites mode: a recursive cp, mv, rsync,
 * tar extract, git checkout / restore pathspec or interpreter copy), since the
 * tree may carry a `.claude/skills` of its own.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ALLOW, type Gate, type GateResult } from './gate.js';
import { CAP_FIX, CAP_REASON, isCapLine, payloadCwd, writePaths, type WritePathsOptions } from './cmd-analysis/index.js';
import { judgedPath } from './no-source-edit-from-main.js';
import { pathCanonical } from './lib/agent-context.js';
import { DB_RETRY_FIX, dbPath, haveSqlite, projectRoot, sqlQuote, sqliteRo } from './lib/db.js';
import { type DenyFix, denyResult } from './lib/deny.js';
import { agentRole } from './lib/role.js';

export const GATE_NAME = 'prompt-write-approval';

export const EVENT_TYPE = 'prompt_write_approved';

export const APPROVAL_WINDOW_MINUTES = 30;

const APPROVED_PREFIX = 'approved:';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
// Case-insensitive: on macOS's default APFS a .Claude/Skills spelling writes into .claude/skills.
const PROMPT_DIR = /(^|\/)\.claude\/(skills|agents)\//i;
const AGENT_DIR = /(^|\/)\.claude\/agents\//i;
const PROMPT_PARENT = /(^|\/)\.claude(\/(skills|agents))?$/i;

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

export function shellScopeReason(path: string, scope: string): string {
  return `BLOCKED: the Human's approval for ${path} is scoped ${JSON.stringify(scope)}, not "full", and a Bash write cannot be limited to the frontmatter skills: list.`;
}

export function shellScopeFix(path: string): DenyFix {
  return {
    allowed: `an Edit that changes only the skills: list of ${path}, or ask the Human again and audit_append event_type='${EVENT_TYPE}' with scope "full", then the same command`,
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
  tool_input?: (EditSpec & { file_path?: unknown; content?: unknown; edits?: unknown; command?: unknown }) | null;
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
  return path[root.length] === '/' && path.slice(0, root.length).toLowerCase() === root.toLowerCase() ? path.slice(root.length + 1) : null;
}

function within(path: string, dir: string): boolean {
  return path.toLowerCase() === dir.toLowerCase() || underRoot(path, dir) !== null;
}

type PromptKind = 'skills' | 'agents';

/** The canonical <root>/.claude/<kind> dir plus the canonical target of each symlinked entry in it. */
function realPromptDirs(root: string, kind: PromptKind): string[] {
  const dir = join(root, '.claude', kind);
  const dirs = [pathCanonical(dir)];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) dirs.push(pathCanonical(join(dir, entry.name)));
    }
  } catch {
    // No such dir: nothing is symlinked out of it.
  }
  return dirs;
}

/** The paths of a spelled and a canonical target under the root, spelled and canonical. */
function rootRels(spelled: string, target: string, root: string): string[] {
  const canonicalRoot = pathCanonical(root);
  return [underRoot(spelled, root), underRoot(spelled, canonicalRoot), underRoot(target, canonicalRoot)].filter((rel): rel is string => rel !== null);
}

/**
 * The project prompt dir a write lands in, agents winning over skills, or null. Judged on the
 * spelled path (vs the root as given and canonical), on the canonical one, and on where the root's
 * own skill and agent dirs and their symlinked entries resolve, so no symlink or case spelling of
 * a dir Claude Code loads slips past.
 */
function promptKind(spelled: string, target: string, root: string): PromptKind | null {
  const rels = rootRels(spelled, target, root);
  const inRealDir = (kind: PromptKind): boolean => isAbsolute(root) && realPromptDirs(root, kind).some((dir) => within(target, dir));
  if (rels.some((rel) => AGENT_DIR.test(rel)) || inRealDir('agents')) return 'agents';
  if (rels.some((rel) => PROMPT_DIR.test(rel)) || inRealDir('skills')) return 'skills';
  return null;
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

function approvalDb(env: NodeJS.ProcessEnv): string | null {
  const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
  return db === null || !haveSqlite(env) ? null : db;
}

/** The scope of the newest fresh approval naming <target>, or null when there is none. */
function approvedScope(db: string, target: string, env: NodeJS.ProcessEnv): string | null {
  const row = sqliteRo(db, approvalSql(target), env).split('\n')[0];
  return row.startsWith(APPROVED_PREFIX) ? row.slice(APPROVED_PREFIX.length) : null;
}

function baseDir(cwd: unknown, root: string): string {
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : root;
}

/** Whether a write target is a `.claude`, `.claude/skills` or `.claude/agents` dir under the root, any letter case, spelled or resolved. */
function isPromptParent(spelled: string, target: string, root: string): boolean {
  return rootRels(spelled, target, root).some((rel) => PROMPT_PARENT.test(rel));
}

function ancestorOrSelf(path: string, of: string): boolean {
  return path === '/' || within(of, path);
}

/**
 * Whether a tree written whole into <spelled> can reach a prompt dir: it is the root's `.claude`
 * dir (spelled or canonical) or an ancestor of it, or an ancestor of where the root's skill or
 * agent dirs or their symlinked entries resolve.
 */
function holdsPromptDirs(spelled: string, target: string, root: string): boolean {
  if (!isAbsolute(root) || root === '/') return false;
  const claudeDirs = [join(root, '.claude'), join(pathCanonical(root), '.claude')];
  if (claudeDirs.some((dir) => ancestorOrSelf(spelled, dir) || ancestorOrSelf(target, dir))) return true;
  return [...realPromptDirs(root, 'skills'), ...realPromptDirs(root, 'agents')].some((dir) => ancestorOrSelf(target, dir));
}

/** The canonical targets of <lines> that <isGated> holds for. */
function gatedTargets(lines: readonly string[], base: string, isGated: (spelled: string, target: string) => boolean): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const path = judgedPath(line);
    if (path === null || path === '') continue;
    const spelled = resolve(base, path);
    const target = pathCanonical(spelled);
    if (isGated(spelled, target)) out.push(target);
  }
  return out;
}

const analyzed = async (command: string, options: WritePathsOptions): Promise<string[]> => (await writePaths(command, options)).join('\n').split('\n');

async function bashRule(raw: string, command: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  if (agentRole(raw) === 'swe') return ALLOW;
  const root = projectRoot(env);
  const cwd = payloadCwd(raw, env);
  const lines = await analyzed(command, { cwd, root, env });
  if (lines.some(isCapLine)) return denyResult(CAP_REASON, CAP_FIX);
  const treeLines = await analyzed(command, { cwd, root, env, treeWrites: true });
  if (treeLines.some(isCapLine)) return denyResult(CAP_REASON, CAP_FIX);

  const base = baseDir(cwd, root);
  const promptWrite = (spelled: string, target: string): boolean => promptKind(spelled, target, root) !== null || isPromptParent(spelled, target, root);
  const gated = new Set([
    ...gatedTargets(lines, base, promptWrite),
    ...gatedTargets(treeLines, base, (spelled, target) => promptWrite(spelled, target) || holdsPromptDirs(spelled, target, root)),
  ]);
  if (gated.size === 0) return ALLOW;

  const db = approvalDb(env);
  if (db === null) return denyResult(UNVERIFIABLE_REASON, DB_RETRY_FIX);
  for (const target of gated) {
    const scope = approvedScope(db, target, env);
    if (scope === null) return denyResult(notApprovedReason(target), notApprovedFix(target));
    if (scope !== 'full') return denyResult(shellScopeReason(target, scope), shellScopeFix(target));
  }
  return ALLOW;
}

function editRule(raw: string, payload: Payload, tool: string, input: NonNullable<Payload['tool_input']>, env: NodeJS.ProcessEnv): GateResult {
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  if (filePath === '') return ALLOW;

  const root = projectRoot(env);
  const spelled = resolve(baseDir(payload.cwd, root), filePath);
  const target = pathCanonical(spelled);
  const kind = promptKind(spelled, target, root);
  if (kind === null) return ALLOW;
  if (agentRole(raw) === 'swe') return ALLOW;

  const db = approvalDb(env);
  if (db === null) return denyResult(UNVERIFIABLE_REASON, DB_RETRY_FIX);
  const scope = approvedScope(db, target, env);
  if (scope === null) return denyResult(notApprovedReason(target), notApprovedFix(target));

  if (scope === 'full' || kind !== 'agents' || !isFile(target)) return ALLOW;
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
}

/** Answers an Edit, Write or MultiEdit at once and a Bash command as a Promise. */
export const promptWriteApproval: Gate = (raw, env) => {
  let payload: Payload;
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    return ALLOW;
  }
  if (payload === null || typeof payload !== 'object') return ALLOW;
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const input = payload.tool_input;
  if (input === null || typeof input !== 'object') return ALLOW;
  if (tool === 'Bash') return typeof input.command === 'string' && input.command.trim() !== '' ? bashRule(raw, input.command, env) : ALLOW;
  if (!EDIT_TOOLS.has(tool)) return ALLOW;
  return editRule(raw, payload, tool, input, env);
};
