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
 * denies, and so does a command that did not parse wherever containment-guard
 * judges too (a trajectory DB and sqlite resolve), since nothing it writes can
 * be told (GH 2981); where it does not, such a command is denied only when its
 * text may name `.claude` (mayNameClaudeDir). Its other never-judged targets
 * are containment-guard's. A write target (a tee or redirect target too) is
 * judged on each word bash brace-expands it to; past what can be listed, on the
 * words standing for it, and as the root's `.claude` dir, needing that dir's
 * approval, when a word it expands to may lie outside its stem (a `..`
 * segment, a root, or a `$` or backtick after it; GH 2994). A command that
 * writes nothing has no word expanded. A command with no gated target reads no
 * DB.
 *
 * A write naming only a dir above the prompt dirs (GH 2981) is gated too: a
 * `.claude`, `.claude/skills` or `.claude/agents` dir for any write, and the
 * root, any ancestor of it or of where the prompt dirs resolve when a whole
 * tree lands there (the analyzer's treeWrites mode: a recursive cp, rsync,
 * tar or unzip extract, git checkout / restore pathspec, read from the
 * repository's top for a `:/` or `:(top)` one, or interpreter copy), since the
 * tree may carry a `.claude/skills` of its own. A mv lands only its sources'
 * names, so a mv into the root is gated only when one, brace-expanded, is
 * named `.claude` or is a glob that may match it (no glob char matches a
 * leading dot unless the command names dotglob); a source whose braces expand
 * past what can be listed counts as one that may be named `.claude`, or as the
 * root's `.claude` dir when it may lie outside its stem.
 *
 * A git move that rewrites its whole work tree (GH 2987: a checkout or switch
 * of a ref, a reset --hard, merge, cherry-pick, revert or stash pop / apply)
 * is judged on the files it would change. The analyzer reports each git
 * statement it reaches, through whatever runs it, as a GIT_MOVE line. A work
 * tree holding none of the root's prompt dirs is passed on a path check
 * alone, with no git run and no DB read; else git is asked read-only which
 * paths differ, and each prompt dir one of them lies in needs its own full
 * approval. A move whose changes cannot be told before it runs (pull, rebase,
 * am, apply, a ref git cannot resolve, a git error, an argument the shell
 * fills in, shell text the analyzer cannot read, another ref-moving git
 * statement beside it) fails closed: it needs a full approval of the prompt
 * dirs its work tree holds, and the deny points to `git fetch`, then a judged
 * merge or checkout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ALLOW, type Gate, type GateResult } from './gate.js';
import {
  braceWords,
  CAP_FIX,
  CAP_REASON,
  GIT_MOVE_PREFIX,
  gitWorkTreeTop,
  isCapLine,
  parseGitMoveLine,
  payloadCwd,
  REFS_MAY_MOVE,
  writePaths,
  type GitMove,
  type TreeChange,
  type WritePathsOptions,
} from './cmd-analysis/index.js';
import { NEVER_JUDGED, NEVER_JUDGED_FIX, UNJUDGED_PHRASE } from './containment-guard.js';
import { judgedPath } from './no-source-edit-from-main.js';
import { pathCanonical } from './lib/agent-context.js';
import { DB_RETRY_FIX, dbPath, dbState, haveSqlite, projectRoot, sqlQuote, sqliteRo } from './lib/db.js';
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

export function gitUnresolvedReason(what: string, why: string, dir: string): string {
  return `BLOCKED: \`${what}\` may change project skill or agent files under ${dir}, and which files it changes cannot be told before it runs (${why}). To update from a remote, run \`git fetch\`, then \`git merge <ref>\` or \`git checkout <ref>\`, which are judged on the files they change; otherwise ask the Human with AskUserQuestion first; a Yes is recorded as audit event ${EVENT_TYPE}.`;
}

export function gitUnresolvedFix(dir: string): DenyFix {
  return {
    allowed: `git fetch, then git merge <ref> or git checkout <ref>; or, after the Human's AskUserQuestion Yes, audit_append(agent='bro', issue_id=<issue>, event_type='${EVENT_TYPE}', summary=<what the Human approved>, content_json='${JSON.stringify({ path: dir, scope: 'full' })}'), then the same command`,
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

/**
 * A shell glob as a case-insensitive RegExp, or null when it is no valid class. As bash's default
 * (no dotglob), its `*`, `?` and `[...]` never match a leading dot; only a literal leading `.` does.
 */
function globRegExp(glob: string, dotglob: boolean): RegExp | null {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const close = c === '[' ? glob.indexOf(']', i + 2) : -1;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (close > 0) {
      const body = glob.slice(i + 1, close).replace(/\\/g, '\\\\');
      re += `[${/^[!^]/.test(body) ? `^${body.slice(1)}` : body}]`;
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  try {
    return new RegExp(`^${dotglob || glob.startsWith('.') ? '' : '(?!\\.)'}${re}$`, 'i');
  } catch {
    return null;
  }
}

/** An extglob operator (`@(…)`, `!(…)`, `+(…)`, `*(…)`, `?(…)`), whose match is not modelled. */
const EXTGLOB = /[@!+*?]\(/;

/**
 * Whether <path> is <of> or an ancestor of it, a glob in its last segment matching the name below
 * its parent (an invalid glob or an extglob matches); <dotglob> as in globRegExp.
 */
function ancestorOrSelf(path: string, of: string, dotglob: boolean): boolean {
  if (path === '/' || within(of, path)) return true;
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  if (!/[*?[]/.test(name) && !EXTGLOB.test(name)) return false;
  const parent = path.slice(0, slash) || '/';
  const below = parent === '/' ? of.slice(1) : underRoot(of, parent);
  if (below === null || below === '') return false;
  if (EXTGLOB.test(name)) return true;
  return globRegExp(name, dotglob)?.test(below.split('/')[0]) ?? true;
}

/**
 * Whether a tree written whole into <spelled> can reach a prompt dir: it is the root's `.claude`
 * dir (spelled or canonical) or an ancestor of it, or an ancestor of where the root's skill or
 * agent dirs or their symlinked entries resolve; a glob last segment (`mv x/.c* .`) counts when
 * it may match the next segment down.
 */
function holdsPromptDirs(spelled: string, target: string, root: string, dotglob: boolean): boolean {
  if (!isAbsolute(root) || root === '/') return false;
  const claudeDirs = [join(root, '.claude'), join(pathCanonical(root), '.claude')];
  if (claudeDirs.some((dir) => ancestorOrSelf(spelled, dir, dotglob) || ancestorOrSelf(target, dir, dotglob))) return true;
  return [...realPromptDirs(root, 'skills'), ...realPromptDirs(root, 'agents')].some((dir) => ancestorOrSelf(target, dir, dotglob));
}

/**
 * The canonical targets of <lines> that <isGated> holds for. A write target is judged on each word
 * bash brace-expands it to (a tee or redirect target too), or past what can be listed on the words
 * braceWords stands it as, the root's `.claude` dir for one that may leave its stem; only a line
 * that is a write target gets here, so no other command's words expand.
 */
function gatedTargets(lines: readonly string[], base: string, root: string, isGated: (spelled: string, target: string) => boolean): string[] {
  const out: string[] = [];
  const claudeDir = join(root, '.claude');
  for (const line of lines) {
    const path = judgedPath(line);
    if (path === null || path === '') continue;
    for (const alternative of braceWords([path], claudeDir)) {
      const spelled = resolve(base, alternative);
      const target = pathCanonical(spelled);
      if (isGated(spelled, target)) out.push(target);
    }
  }
  return out;
}

/** Whether the command may let a glob match a leading dot: bash's dotglob or GLOBIGNORE, or zsh's GLOB_DOTS, named anywhere in it. */
const DOTGLOB = /dotglob|GLOBIGNORE|glob_?dots/i;

/** An analyzer line for a command (or a body it runs) that did not parse, so nothing it writes can be told. */
const UNPARSED = 'UNRESOLVED:$(parse):';

/**
 * Whether an unparsed command's raw text may name `.claude`, read conservatively since nothing
 * else of it can be told: `claude` in any letter case once every quote and backslash is taken out,
 * ANSI-C or locale quoting (`$'…'`, `$"…"`, which can spell any char), or a whitespace-free run
 * holding a `.` with a glob, brace or `$` after it (`.c*`, `.[cC]laude`, `x/.{a,b}`, `.$X`).
 */
function mayNameClaudeDir(command: string): boolean {
  return /claude/i.test(command.replace(/['"\\]/g, '')) || /\$['"]/.test(command) || /\.\S*[*?[{$]/.test(command);
}

const analyzed = async (command: string, options: WritePathsOptions): Promise<string[]> => (await writePaths(command, options)).join('\n').split('\n');

/**
 * The prompt dirs a git work tree topped at <top> holds, as approval targets: the root's canonical
 * `.claude` dir (for its skills and agents both) and each symlinked-out entry's resolved dir in the
 * tree, or the one entry dir a tree inside it lands in; all of them for a work tree that cannot be
 * told (null). A pure path check: no git runs.
 */
function heldPromptDirs(top: string | null, root: string): string[] {
  if (!isAbsolute(root) || root === '/') return [];
  const claude = pathCanonical(join(root, '.claude'));
  const dirs = [...realPromptDirs(root, 'skills'), ...realPromptDirs(root, 'agents')];
  if (top === null) return [claude, ...dirs.filter((dir) => !within(dir, claude))];
  const holding = dirs.filter((dir) => within(top, dir)).sort((a, b) => b.length - a.length);
  if (holding.length > 0) return [holding[0]];
  if (within(claude, top)) return [claude, ...dirs.filter((dir) => !within(dir, claude) && within(dir, top))];
  return dirs.filter((dir) => within(dir, top));
}

/** The prompt dir a gated path lies in, as an approval target: the deepest real skill or agent dir holding it, else its `.claude/skills` or `.claude/agents` segment. */
function promptDirOf(path: string, root: string): string {
  const real = [...realPromptDirs(root, 'skills'), ...realPromptDirs(root, 'agents')].filter((dir) => within(path, dir)).sort((a, b) => b.length - a.length);
  if (real.length > 0) return real[0];
  const canonicalRoot = pathCanonical(root);
  const rel = underRoot(path, canonicalRoot) ?? '';
  const match = PROMPT_DIR.exec(rel);
  return match === null ? path : pathCanonical(join(canonicalRoot, rel.slice(0, match.index + match[0].length - 1)));
}

const GIT_QUERY_TIMEOUT_MS = 5000;

/** A read-only git query's stdout in work tree <top>, or null on any error or timeout; no shell, and no optional index lock is taken. */
function gitQuery(top: string, args: readonly string[], env: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync('git', ['-C', top, ...args], {
      encoding: 'utf8',
      env: { ...env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_QUERY_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const nulList = (out: string): string[] => out.split('\0').filter((path) => path !== '');

/** The paths `git diff <revs>` lists (one rev: against the work tree), or null when git cannot tell. */
function diffNames(top: string, revs: readonly string[], env: NodeJS.ProcessEnv): string[] | null {
  const out = gitQuery(top, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--end-of-options', ...revs, '--'], env);
  return out === null ? null : nulList(out);
}

type Changed = { readonly paths: readonly string[] } | { readonly why: string };

/** The paths, relative to <top>, a move changes, asked of git read-only, or why they cannot be told. */
function changedPaths(change: TreeChange, top: string, dir: string, env: NodeJS.ProcessEnv): Changed {
  if (change.kind === 'unresolvable') return { why: change.why };
  const named = change.kind === 'revs' ? change.revs : change.kind === 'commits' ? change.commits : change.kind === 'stash' ? [change.stash] : [change.operand];
  const optionLike = named.find((rev) => rev.startsWith('-'));
  if (optionLike !== undefined) return { why: `${optionLike} reads as an option` };
  const paths = new Set<string>();
  const add = (list: readonly string[] | null, what: string): string | null => {
    if (list === null) return `git cannot resolve ${what}`;
    for (const path of list) paths.add(path);
    return null;
  };
  let why: string | null = null;
  switch (change.kind) {
    case 'revs':
      for (const rev of change.revs) why ??= add(diffNames(top, ['HEAD', rev], env), rev);
      if (change.worktree) why ??= add(diffNames(top, ['HEAD'], env), 'the work tree');
      break;
    case 'rev-or-path': {
      const listed = diffNames(top, ['HEAD', change.operand], env);
      if (listed === null) return existsSync(resolve(dir, change.operand)) ? { paths: [] } : { why: `git cannot resolve ${change.operand}` };
      add(listed, change.operand);
      if (change.worktree) why ??= add(diffNames(top, ['HEAD'], env), 'the work tree');
      break;
    }
    case 'stash': {
      const out = gitQuery(top, ['stash', 'show', '--include-untracked', '--name-only', '-z', '--no-renames', change.stash], env);
      why = add(out === null ? null : nulList(out), change.stash);
      break;
    }
    case 'commits':
      for (const commit of change.commits) {
        const parents = gitQuery(top, ['rev-list', '--parents', '-n', '1', '--end-of-options', commit, '--'], env)?.trim().split(/\s+/);
        if (parents === undefined) why ??= `git cannot resolve ${commit}`;
        else if (parents.length !== 2) why ??= `${commit} is a merge or root commit`;
        else why ??= add(diffNames(top, [parents[1], parents[0]], env), commit);
      }
      break;
  }
  return why === null ? { paths: [...paths] } : { why };
}

interface PlacedMove {
  readonly move: GitMove;
  /** The work tree top git finds from the move's dir; null when its dir cannot be told, undefined when it runs in no work tree. */
  readonly top: string | null | undefined;
}

/**
 * The analyzer's GIT_MOVE lines, each placed in its work tree. A move is judged on the refs as they are
 * before the command runs, so beside another ref-moving git statement in its work tree (or in one that
 * cannot be told) it cannot be told; a statement that changes no tree is dropped once counted.
 */
function placedMoves(lines: readonly string[]): PlacedMove[] {
  const placed: PlacedMove[] = [];
  for (const line of new Set(lines)) {
    const move = parseGitMoveLine(line);
    if (move === null) continue;
    placed.push({ move, top: move.dir === null ? null : (gitWorkTreeTop(move.dir) ?? undefined) });
  }
  const movers = (top: string | null | undefined): number => placed.filter((p) => p.move.refMover && (p.top === top || p.top === null)).length;
  const moves: PlacedMove[] = [];
  for (const { move, top } of placed) {
    if (move.change === null) continue;
    const resolvable = move.change.kind !== 'unresolvable';
    moves.push(resolvable && top !== undefined && movers(top) > 1 ? { move: { ...move, change: REFS_MAY_MOVE }, top } : { move, top });
  }
  return moves;
}

interface GitMoveVerdict {
  /** The prompt dirs the moves would change, as approval targets. */
  readonly gated: readonly string[];
  /** The moves whose changes cannot be told, each with the prompt dirs its work tree holds. */
  readonly unresolved: readonly { readonly move: GitMove; readonly why: string; readonly dirs: readonly string[] }[];
}

/**
 * Judges whole-tree git moves: one in a work tree holding no prompt dir is passed with no git run;
 * else the paths it changes are asked of git, and each one promptKind gates names its prompt dir.
 */
function judgeGitMoves(moves: readonly PlacedMove[], root: string, env: NodeJS.ProcessEnv): GitMoveVerdict {
  const gated = new Set<string>();
  const unresolved: { move: GitMove; why: string; dirs: string[] }[] = [];
  for (const { move, top } of moves) {
    if (top === undefined || move.change === null) continue;
    const dirs = heldPromptDirs(top, root);
    if (dirs.length === 0) continue;
    if (move.dir === null || top === null) {
      unresolved.push({ move, why: move.change.kind === 'unresolvable' ? move.change.why : 'git runs in a dir or repository the gate cannot tell', dirs });
      continue;
    }
    const changed = changedPaths(move.change, top, move.dir, env);
    if ('why' in changed) {
      unresolved.push({ move, why: changed.why, dirs });
      continue;
    }
    for (const rel of changed.paths) {
      const path = join(top, rel);
      if (promptKind(path, path, root) !== null) gated.add(promptDirOf(path, root));
    }
  }
  return { gated: [...gated], unresolved };
}

async function bashRule(raw: string, command: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  if (agentRole(raw) === 'swe') return ALLOW;
  const root = projectRoot(env);
  const cwd = payloadCwd(raw, env);
  // Raw, so a `..` after a brace (`{.claude/skills/a,b}/../q`) is resolved per expanded word, not folded into the brace.
  const lines = await analyzed(command, { cwd, raw: true, root, env });
  if (lines.some(isCapLine)) return denyResult(CAP_REASON, CAP_FIX);
  const analyzedTree = await analyzed(command, { cwd, raw: true, root, env, treeWrites: true, gitMoves: true });
  if (analyzedTree.some(isCapLine)) return denyResult(CAP_REASON, CAP_FIX);
  const treeLines = analyzedTree.filter((line) => !line.startsWith(GIT_MOVE_PREFIX));
  const unparsed = lines.find((line) => line.startsWith(UNPARSED));
  if (unparsed !== undefined) {
    // containment-guard's own state test: where it stands aside (no DB or no sqlite) an unparsed command goes on unless it may name a prompt root.
    if (dbState(env) !== 'unresolved') {
      return denyResult(`BLOCKED: write target "${unparsed.slice(UNPARSED.length)}" ${UNJUDGED_PHRASE} ${NEVER_JUDGED['$(parse)']}`, NEVER_JUDGED_FIX['$(parse)']);
    }
    if (mayNameClaudeDir(command)) return denyResult(UNVERIFIABLE_REASON, DB_RETRY_FIX);
  }

  const base = baseDir(cwd, root);
  const dotglob = DOTGLOB.test(command);
  const promptWrite = (spelled: string, target: string): boolean => promptKind(spelled, target, root) !== null || isPromptParent(spelled, target, root);
  const plain = gatedTargets(lines, base, root, promptWrite);
  const tree = gatedTargets(treeLines, base, root, (spelled, target) => promptWrite(spelled, target) || holdsPromptDirs(spelled, target, root, dotglob));
  // A full approval of a dir already admits any tree into it, so where a moved file lands inside a gated dir needs no second approval.
  const gated = new Set([...plain, ...tree.filter((path) => !plain.some((dir) => underRoot(path, dir) !== null))]);
  const git = judgeGitMoves(placedMoves(analyzedTree.filter((line) => line.startsWith(GIT_MOVE_PREFIX))), root, env);
  for (const dir of git.gated) gated.add(dir);
  if (gated.size === 0 && git.unresolved.length === 0) return ALLOW;

  const db = approvalDb(env);
  if (db === null) return denyResult(UNVERIFIABLE_REASON, DB_RETRY_FIX);
  for (const target of gated) {
    const scope = approvedScope(db, target, env);
    if (scope === null) return denyResult(notApprovedReason(target), notApprovedFix(target));
    if (scope !== 'full') return denyResult(shellScopeReason(target, scope), shellScopeFix(target));
  }
  for (const { move, why, dirs } of git.unresolved) {
    for (const dir of dirs) {
      const scope = approvedScope(db, dir, env);
      if (scope === null) return denyResult(gitUnresolvedReason(move.what, why, dir), gitUnresolvedFix(dir));
      if (scope !== 'full') return denyResult(shellScopeReason(dir, scope), shellScopeFix(dir));
    }
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
