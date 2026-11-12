/**
 * PreToolUse gate (GH 1692).
 *
 * Rule 1, Edit / Write / MultiEdit / NotebookEdit outside a task worktree, in
 * a TMB project: allowed for a target under .claude/worktrees/, under a
 * scratch root, in a dir outside every git repo or in an unregistered repo,
 * on the docs / config allowlist, or by a swe; denied otherwise. The plugin's
 * own enforcement surfaces (scripts/hooks/, hooks/hooks.json of the repo whose
 * manifest names the running plugin) are denied even for a swe.
 * TMB_ALLOW_SOURCE_EDIT=1 lifts Rule 1. A DB that cannot be read denies.
 * For bro (GH 3075) every check runs on the target with `.` and `..` resolved,
 * and neither the worktree dir nor the allowlist admits a write to a repo file:
 * it is allowed only inside the worktree of a running task with a
 * no_code_class, on a path the task's base_sha path classes call docs or
 * prompts. A worktree path inside a git repo fails closed when the DB cannot
 * prove its task. A write that is no repo file (scratch, outside every
 * registered repo, or ignored by git) keeps the decision every other role gets.
 *
 * Rule 2, Bash, with or without a DB: a write the cmd-analysis analyzer finds
 * to a prompt-surface path outside a worktree is denied for every identity.
 *
 * Further rules:
 *   - GH 1796: the target and the scratch roots (.claude/<plugin>/scratch/ and
 *     /tmp/claude-<uid>, as containment-guard's harnessTmp admits it) are
 *     compared canonically, so a write under /private/tmp/claude-<uid> on
 *     macOS, where /tmp links to /private/tmp, is allowed, as is a scratch
 *     file whose parent dir does not exist yet.
 *   - It needs neither jq nor the sqlite3 CLI.
 *   - The analyzer's never-judged targets (`$(parse)`, `$(computed)`,
 *     `$(unproven)`) are containment-guard's to deny, not Rule 2's. The
 *     analyzer's cap line (GH 2090) is the one Rule 2 denies itself: its
 *     padding could hide a write to a prompt-surface path.
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOW, type Gate, type GateResult } from './gate.js';
import { harnessTmp, NEVER_JUDGED } from './containment-guard.js';
import { CAP_FIX, CAP_REASON, isCapLine, isPromptSurfacePath, payloadCwd, writePaths } from './cmd-analysis/index.js';
import { pathCanonical } from './lib/agent-context.js';
import { dbPath, dbState, denyDbUnavailable, gateRead, GATE_READ_ERROR, haveSqlite, projectRoot, realdir, stripTrailingNewlines } from './lib/db.js';
import { gitOk, gitOut, isDir } from './lib/git.js';
import { resolveTaskIdForTarget, worktreeRootForTarget } from './lib/target-task.js';
import { classifyPath, PATH_CLASSES_FILE, readPathClasses } from '../path-classes.js';
import { type DenyFix, denyResult as deny } from './lib/deny.js';
import { jqAlternatives } from './lib/jq.js';
import { installRoot, pluginName, posixBasename, posixDirname, TMB_STATE_HOST_DIR } from './lib/project-env.js';
import { repoGitRoot, repoNameForRoot } from './lib/repo.js';
import { agentRole } from './lib/role.js';

export const GATE_NAME = 'no-source-edit-from-main';

const JUDGED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);

const BASH_REASON =
  'BLOCKED: Bash write-forms targeting prompt-surface files (agents/*.md, skills/*/SKILL.md, commands/*.md, templates/*.md, CLAUDE.md) are denied from the main checkout for every agent identity. Sanctioned route: spawn an SWE task (prompt_bearing=1) for intentional prompt edits. Reads (cat/grep/sed -n) are always allowed.';
const SURFACE_REASON =
  "BLOCKED: enforcement surfaces (scripts/hooks/ and hooks/hooks.json) of the plugin's own source repo are only editable through task worktrees — spawn an SWE task. Main-checkout edits to these paths are denied regardless of file type.";
function sourceReason(env: NodeJS.ProcessEnv): string {
  return `BLOCKED: source edits from the main checkout are denied. Normal route: use tmb_planning → task_create_batch to spawn SWE in an isolated worktree. If the worktree-create step failed (e.g. WorktreeCreate input had no .branch field), SWE running with agent_type='swe' is auto-permitted to edit in-place (non-isolated mode). For an emergency hotfix the Human relaunches Claude Code with TMB_ALLOW_SOURCE_EDIT=1; ask the Human. Throwaway scripts, logs and data dumps belong in ${scratchDir(env)}/ (or /tmp/claude-<uid>), which are always writable; plans, decisions and analysis go in the trajectory DB.`;
}

function scratchDir(env: NodeJS.ProcessEnv): string {
  return `${TMB_STATE_HOST_DIR}/${pluginName(env)}/scratch`;
}

const ALLOWED_BASENAMES = new Set([
  'LICENSE',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmignore',
  '.dockerignore',
  'CHANGELOG',
  'CHANGELOG.md',
  'README',
  'README.md',
]);

function capture(text: string): string {
  return stripTrailingNewlines(text.replace(/\0/g, ''));
}

function field(input: string, ...paths: string[][]): string {
  return capture(jqAlternatives(input, paths));
}

const SWE_TASK_FIX: DenyFix = { allowed: 'task_create_batch for the change, then the same edit from swe in the task worktree' };
const PROMPT_TASK_FIX: DenyFix = { allowed: 'task_create_batch with prompt_bearing=1, then the same edit from swe in the task worktree' };
const BRO_NO_CODE_FIX: DenyFix = {
  allowed: "task_provision with task.no_code_class 'docs' or 'prompts', then the same edit in that task's worktree; a code path goes to swe",
};

function dbDenied(env: NodeJS.ProcessEnv): GateResult {
  return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
}

/** The bash case pattern pair `*\/<dir>/*|<dir>/*`. */
function hasDir(path: string, dir: string): boolean {
  return path.includes(`/${dir}/`) || path.startsWith(`${dir}/`);
}

function inWorktreeDir(path: string): boolean {
  return hasDir(path, '.claude/worktrees');
}

/** `*\/../*|../*|*\/..|*\/scripts/hooks/*|scripts/hooks/*`: a path the scratch allowance never covers. */
function scratchExcluded(path: string): boolean {
  return path.includes('/../') || path.startsWith('../') || path.endsWith('/..') || hasDir(path, 'scripts/hooks');
}

function under(path: string, dir: string): boolean {
  return dir !== '' && path.startsWith(`${dir.endsWith('/') ? dir.slice(0, -1) : dir}/`);
}

/**
 * The scratch allowance: the raw target under .claude/<plugin>/scratch/, or
 * (GH 1796) its canonical path under .claude/<plugin>/scratch/ or
 * under the canonical /tmp/claude-<uid>.
 */
function inScratch(target: string, input: string, env: NodeJS.ProcessEnv): boolean {
  if (scratchExcluded(target)) return false;
  const scratch = scratchDir(env);
  if (hasDir(target, scratch)) return true;
  const canonical = capture(pathCanonical(target.startsWith('/') ? target : `${payloadCwd(input, env)}/${target}`));
  if (scratchExcluded(canonical)) return false;
  return hasDir(canonical, scratch) || under(canonical, harnessTmp(process.getuid?.() ?? 0));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function manifestName(manifest: string): string {
  try {
    return field(readFileSync(manifest, 'utf8'), ['name']);
  } catch {
    return '';
  }
}

/** The nearest dir that exists at or above <path>'s parent. */
function nearestExistingDir(path: string): string {
  let dir = posixDirname(path);
  while (!isDir(dir) && dir !== '/') dir = posixDirname(dir);
  return dir;
}

/** _target_is_plugin_source_repo: the target's git root carries a manifest named like the running plugin's. */
async function targetIsPluginSourceRepo(target: string, input: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT || installRoot(posixDirname(fileURLToPath(import.meta.url))) || '';
  const running = `${pluginRoot}/.claude-plugin/plugin.json`;
  const start = target.startsWith('/') ? nearestExistingDir(target) : posixDirname(`${payloadCwd(input, env)}/${target}`);
  const root = await repoGitRoot(start, env);
  if (root === '') return false;
  const repoManifest = `${root}/.claude-plugin/plugin.json`;
  if (!isFile(running) || !isFile(repoManifest)) return false;
  const runningName = manifestName(running);
  return runningName !== '' && runningName === manifestName(repoManifest);
}

function allowlisted(target: string): boolean {
  if (/\.(md|markdown|txt|rst)$/.test(target)) return true;
  if (hasDir(target, 'docs') || hasDir(target, 'templates')) return true;
  const base = posixBasename(target);
  if (ALLOWED_BASENAMES.has(base) || base.startsWith('LICENSE.')) return true;
  if (target.endsWith('.claude-plugin/plugin.json') || target.endsWith('.claude-plugin/marketplace.json')) return true;
  return target.includes('.github/');
}

function isEnforcementSurface(target: string): boolean {
  return hasDir(target, 'scripts/hooks') || target.endsWith('/hooks/hooks.json') || target === 'hooks/hooks.json';
}

/** `${p#"$root"/}` for the first of <roots> that prefixes <p>. */
function projectRelative(p: string, roots: readonly string[]): string {
  for (const root of roots) {
    if (root !== '' && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  }
  return p;
}

/** `${word#UNRESOLVED:*:}`, or null for a never-judged marker. */
export function judgedPath(word: string): string | null {
  if (!word.startsWith('UNRESOLVED:')) return word;
  const rest = word.slice('UNRESOLVED:'.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return word;
  return Object.hasOwn(NEVER_JUDGED, rest.slice(0, colon)) ? null : rest.slice(colon + 1);
}

async function bashRule(input: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  const command = field(input, ['tool_input', 'command']);
  const proj = capture(projectRoot(env));
  const roots = [proj, proj === '' ? '' : realdir(proj)];
  const lines = capture((await writePaths(command, { cwd: payloadCwd(input, env), env })).join('\n')).split('\n');
  if (lines.some(isCapLine)) return deny(CAP_REASON, CAP_FIX);
  for (const line of lines) {
    const path = judgedPath(line);
    if (path === null || path === '') continue;
    if (await isPromptSurfacePath(path, '', env) && !inWorktreeDir(projectRelative(path, roots))) return deny(BASH_REASON, PROMPT_TASK_FIX);
  }
  return ALLOW;
}

function broDenied(why: string, fix: DenyFix = BRO_NO_CODE_FIX): GateResult {
  return deny(`BLOCKED: bro edits a repo file only inside the worktree of a running no-code task, on a path .config/tmb/path-classes.json at the task's base_sha classes docs or prompts. ${why}`, fix);
}

interface BroTask {
  id: string;
  status: string;
  noCodeClass: string;
  baseSha: string;
}

/** A DB below v72 has no no_code_class column, so every task in it reads as unclassed. */
function broTaskRow(db: string, taskId: string, env: NodeJS.ProcessEnv): BroTask | null {
  const column = gateRead(db, "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'no_code_class';", env);
  if (column === GATE_READ_ERROR) return null;
  const classExpr = column === '1' ? "COALESCE(no_code_class, '')" : "''";
  const row = gateRead(
    db,
    `SELECT status || '|' || ${classExpr} || '|' || COALESCE(base_sha, '') FROM tasks WHERE id = ${Number(taskId)} LIMIT 1;`,
    env,
  );
  if (row === GATE_READ_ERROR) return null;
  const [status = '', noCodeClass = '', baseSha = ''] = row.split('|');
  return { id: taskId, status, noCodeClass, baseSha };
}

/**
 * GH 3075: bro writes in a task worktree only on a docs or prompts path of a running
 * no-code task, judged by the path classes committed at the task's base_sha so the
 * task's own commits cannot widen them.
 */
async function broWorktreeEdit(target: string, canonical: string, db: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  if (dbState(env) === 'error') return dbDenied(env);
  const repos = reposTable(db, env);
  if (repos === 'error') return dbDenied(env);
  if (repos === 'absent') return broDenied('The trajectory DB has no repos table, so no task can be proven to own this worktree.');
  const worktree = worktreeRootForTarget(canonical);
  if (worktree === '' || canonical === worktree) return broDenied(`${target} is not a file inside a task worktree.`);
  const toplevel = capture(pathCanonical(await gitOut(worktree, ['rev-parse', '--show-toplevel'], env)));
  if (toplevel !== worktree) return broDenied(`${worktree} is not a git worktree.`);
  const taskId = await resolveTaskIdForTarget(canonical, '', db, env);
  if (taskId === '') return broDenied(`No task owns the worktree ${worktree}.`);
  const task = broTaskRow(db, taskId, env);
  if (task === null) return dbDenied(env);
  if (task.status !== 'running') return broDenied(`Task #${task.id} is ${task.status || 'missing'}, not running.`);
  if (task.noCodeClass === '') return broDenied(`Task #${task.id} has no no_code_class, so it is a code task for swe.`, SWE_TASK_FIX);
  if (task.baseSha === '') return broDenied(`Task #${task.id} has no base_sha to read its path classes at.`, SWE_TASK_FIX);
  const read = readPathClasses(worktree, task.baseSha);
  if ('error' in read) return broDenied(`${PATH_CLASSES_FILE} at ${task.baseSha} cannot be read: ${read.error}.`, SWE_TASK_FIX);
  const rel = canonical.slice(worktree.length + 1);
  if (read.classes === null) return broDenied(`${PATH_CLASSES_FILE} is absent at ${task.baseSha}, so every path, ${rel} too, is code for swe.`, SWE_TASK_FIX);
  if (classifyPath(rel, read.classes) === 'code') return broDenied(`${rel} is a code path at ${task.baseSha}; code changes go to swe.`, SWE_TASK_FIX);
  return ALLOW;
}

function reposTable(db: string, env: NodeJS.ProcessEnv): 'present' | 'absent' | 'error' {
  const count = gateRead(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'repos';", env);
  if (count === GATE_READ_ERROR) return 'error';
  return count === '1' ? 'present' : 'absent';
}

/**
 * The bro decision on <canonical>, the target with `.` and `..` resolved; null keeps the
 * rule every role gets. A path under .claude/worktrees/ in a git repo needs the DB to
 * prove its task, so it fails closed. Outside a worktree only a registered repo's file
 * that git does not ignore is decided here; a DB without a repos table leaves the main
 * checkout to the shared rule.
 */
async function broEdit(target: string, canonical: string, input: string, db: string, env: NodeJS.ProcessEnv): Promise<GateResult | null> {
  const dir = nearestExistingDir(canonical);
  const root = await repoGitRoot(dir, env);
  if (root === '') return null;
  if (inWorktreeDir(canonical)) return await broWorktreeEdit(target, canonical, db, env);
  if (dbState(env) === 'error') return dbDenied(env);
  const repos = reposTable(db, env);
  if (repos === 'error') return dbDenied(env);
  if (repos === 'absent' || repoNameForRoot(db, root, env) === '') return null;
  if (await gitOk(dir, ['check-ignore', '-q', '--', canonical], env)) return null;
  if (isEnforcementSurface(canonical) && await targetIsPluginSourceRepo(canonical, input, env)) return deny(SURFACE_REASON, SWE_TASK_FIX);
  return allowlisted(canonical) ? broDenied(`${target} is in the main checkout.`) : deny(sourceReason(env), SWE_TASK_FIX);
}

async function editRule(input: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
  if (db === null) return ALLOW;

  const raw = field(input, ['tool_input', 'file_path'], ['tool_input', 'notebook_path']);
  if (raw === '' || inScratch(raw, input, env)) return ALLOW;
  const isBro = agentRole(input) === 'bro';
  const target = isBro ? capture(pathCanonical(raw.startsWith('/') ? raw : `${payloadCwd(input, env)}/${raw}`)) : raw;
  if (isBro) {
    const broDecision = await broEdit(raw, target, input, db, env);
    if (broDecision !== null) return broDecision;
  }
  // bro's resolved target can land in a worktree dir its raw path never named (a relative path from a worktree cwd).
  if (inWorktreeDir(raw) && inWorktreeDir(target)) return ALLOW;

  if (dbState(env) === 'error') return dbDenied(env);

  if (target.startsWith('/')) {
    const dir = posixDirname(target);
    if (haveSqlite(env) && isDir(dir)) {
      const root = await repoGitRoot(dir, env);
      if (root === '') return ALLOW;
      if (gateRead(db, 'SELECT COUNT(*) FROM repos;', env) === GATE_READ_ERROR) return dbDenied(env);
      if (repoNameForRoot(db, root, env) === '') return ALLOW;
    }
  }

  if (isEnforcementSurface(target) && await targetIsPluginSourceRepo(target, input, env)) return deny(SURFACE_REASON, SWE_TASK_FIX);
  if (allowlisted(target)) return ALLOW;
  if (agentRole(input) === 'swe') return ALLOW;
  return deny(sourceReason(env), SWE_TASK_FIX);
}

export const noSourceEditFromMain: Gate = async (payload, env) => {
  const toolName = field(payload, ['tool_name']);
  if (!JUDGED_TOOLS.has(toolName)) return ALLOW;
  if (toolName === 'Bash') return await bashRule(payload, env);
  if ((env.TMB_ALLOW_SOURCE_EDIT ?? '0') === '1') return ALLOW;
  return await editRule(payload, env);
};
