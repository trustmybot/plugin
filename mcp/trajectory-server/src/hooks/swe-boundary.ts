/**
 * PreToolUse gate (GH 1692): the
 * structural fence of an swe, keyed on its identity (agentRole) and the task
 * and worktree its spawn transcript resolves to (agentContext).
 *
 *   (a) Bash: git push, or a git subcommand not literal    → deny (GH 2641)
 *   (b) Bash: gh/glab mutating subcommands                 → deny
 *   (c) Edit/Write outside the assigned worktree           → deny, except the
 *       session's own scratchpad under <canonical /tmp>/claude-<uid>/
 *   (d) Edit/Write CLAUDE.md at the worktree root          → deny (always);
 *       other prompt-surface paths                         → deny unless prompt_bearing=1
 *   (e) Bash-written root CLAUDE.md / prompt-surface path  → as (d)
 *   (f) Bash-written path outside files[]                  → note, once per path
 *   (g) Bash write target the guard cannot resolve         → deny unless prompt_bearing=1
 *   (h) Edit/Write after a recorded Bash deny on the path  → allow, audit hook_block_bypassed
 *   (i) Bash: git stash other than a literal list/show, or a git
 *       subcommand not read literally, for swe and
 *       code-reviewer (GH 2786, GH 2837)                   → deny
 *
 * Deny messages, notes, audit rows and decisions are the .sh's, with two
 * exceptions, each stricter: a command tree-sitter-bash cannot parse is
 * denied (the .sh reads it with its awk skeleton), and the DB is read
 * wherever node:sqlite works, with no sqlite3 CLI on PATH. The analyzer's
 * never-judged targets (`$(parse)`, `$(computed)`, `$(unproven)`, which the
 * .sh's analyzer never prints) are containment-guard's to deny, not (g)'s.
 * The analyzer's cap line (GH 2090) is denied here for every task, read first
 * so a command past the cap never reaches the unbounded cmdStatements.
 */
import { lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { ALLOW, type Gate, type GateResult } from './gate.js';
import { NEVER_JUDGED, UNJUDGED_PHRASE, UNRESOLVED_FIX } from './containment-guard.js';
import {
  ambiguousSubcommandReason,
  CAP_FIX,
  CAP_REASON,
  cmdStatements,
  ghMutation,
  gitSubcommandOf,
  isCapLine,
  isPromptSurfacePath,
  payloadCwd,
  writePaths,
  writeShapes,
  type GitStatements,
  type Statement,
} from './cmd-analysis/index.js';
import { agentContext, ctxInWorktree, pathCanonical } from './lib/agent-context.js';
import { auditAppend } from './lib/audit.js';
import {
  dbPath,
  dbState,
  denyDbUnavailable,
  gateRead,
  GATE_READ_ERROR,
  haveSqlite,
  projectRoot,
  sqlInt,
  sqliteRo,
  stateDir,
  stripTrailingNewlines,
} from './lib/db.js';
import { type DenyFix, denyResult as deny } from './lib/deny.js';
import { SWE_PUSH_FIX, SWE_PUSH_REASON } from './git-push-guard.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { posixDirname } from './lib/project-env.js';
import { agentRole, CODE_REVIEWER_ROLE } from './lib/role.js';
import { ScopeFence } from './lib/scope-fence.js';
import { pathDigest, resolveTaskIdForTarget, worktreeRootForTarget } from './lib/target-task.js';

export const GATE_NAME = 'swe-boundary';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FORCE = / --force | -f | --force-with-lease | --force-with-lease=/;
const GLOB_CHAR = /[*?[]/;

const GH_REASON =
  'BLOCKED: SWE may not run gh/glab mutating commands (create/close/edit/merge/delete/api POST|PATCH|PUT|DELETE). Read-only gh commands (view, list, status) are allowed. Mutations go through bro.';
export const PARSE_REASON =
  'BLOCKED: swe-boundary could not parse this command, so it cannot tell whether it pushes, runs a gh/glab mutation or writes a prompt-surface path.';
export const PARSE_FIX: DenyFix = { allowed: 'the same command split into simpler commands with plain quoting' };
const UNKNOWN_FIX: DenyFix = { allowed: 'git -C <path> <subcommand> …, the subcommand written literally' };
export const STASH_REASON =
  'BLOCKED: swe and code-reviewer may not write the git stash; the stash stack is shared by every worktree and session, so pop/apply/drop can take another session\'s work. Read-only `git stash list` and `git stash show` are allowed.';
export const STASH_FIX: DenyFix = { allowed: 'a work-in-progress commit on your task branch, or git diff > <scratch file> to set changes aside' };
export const SUBCOMMAND_REASON =
  "BLOCKED: swe-boundary cannot read git's subcommand literally: it comes from an expansion, a pattern, a redirect, a quote or backslash, a path-qualified git, or an alias a `-c` / `--config-env` option defines, so the guard cannot tell whether the statement writes the git stash. Spell out git and its subcommand literally.";
export const SUBCOMMAND_FIX: DenyFix = { allowed: 'git [-C <path>] <subcommand> …, the subcommand unquoted, with no expansion and no -c alias.* / include.*' };
const STASH_READS = new Set(['list', 'show']);
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const CONFIG_ENV = '--config-env=';
const ALIASING_KEY = /^(alias|include|includeif)\./i;
const EXPANDING = /[$`*?[{]/;
const PATH_GIT = /^\S*\/git$/;

type RawWord = { raw: string; text: string };

/** The end of the `$( )` whose `(` is at <open> in <src>, -1 when it is not closed. */
function substitutionEnd(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') j++;
    else if (c === "'") {
      j = src.indexOf("'", j + 1);
      if (j < 0) return -1;
    } else if (c === '"' || c === '`') {
      j = quoteEnd(src, j) - 1;
      if (j < 0) return -1;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j + 1;
  }
  return -1;
}

/** The end of the double-quoted string or backtick substitution starting at <i> in <src>, -1 when it is not closed. */
function quoteEnd(src: string, i: number): number {
  const close = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') j++;
    else if (c === close) return j + 1;
    else if (close === '"' && c === '$' && src[j + 1] === '(') {
      j = substitutionEnd(src, j + 1) - 1;
      if (j < 0) return -1;
    }
  }
  return -1;
}

/** The words of shell source <src> as written (raw) and with quotes and escapes removed (text), substitutions whole; null at an unclosed quote or substitution. */
function rawWords(src: string): RawWord[] | null {
  const words: RawWord[] = [];
  let i = 0;
  for (;;) {
    while (i < src.length && (/[ \t\n]/.test(src[i]) || src.startsWith('\\\n', i))) i += src[i] === '\\' ? 2 : 1;
    if (i >= src.length) return words;
    const start = i;
    let text = '';
    while (i < src.length && !/[ \t\n]/.test(src[i])) {
      const c = src[i];
      let end: number;
      if (c === '\\') {
        end = i + 2;
        text += src[i + 1] === '\n' ? '' : (src[i + 1] ?? '');
      } else if (c === "'") {
        end = src.indexOf("'", i + 1) + 1;
        text += src.slice(i + 1, end - 1);
      } else if (c === '"') {
        end = quoteEnd(src, i);
        text += src.slice(i + 1, end - 1).replace(/\\(.)/gs, '$1');
      } else {
        end = c === '`' ? quoteEnd(src, i) : c === '$' && src[i + 1] === '(' ? substitutionEnd(src, i + 1) : i + 1;
        text += src.slice(i, end);
      }
      if (end <= 0) return null;
      i = end;
    }
    words.push({ raw: src.slice(start, i), text });
  }
}

/** Whether the config key a `-c` / `--config-env` value sets is not literal or may define an alias. */
function aliasing(value: string): boolean {
  const key = value.split('=')[0];
  return EXPANDING.test(key) || ALIASING_KEY.test(key);
}

/**
 * The stash rule's verdict on one listed statement (GH 2786, GH 2837): null
 * when it is no git command, one it proves leaves the stash alone, or one
 * whose subcommand gitSubcommandOf cannot read (each caller denies that as
 * ambiguous_git_subcommand, GH 2641), 'stash' when it runs `git stash` with
 * anything but a literal `list` or `show`, and 'unreadable' when git's
 * subcommand, read from the statement's own source, is quoted, escaped,
 * behind a path-qualified git, or may be an alias a git option before it
 * defines.
 */
function stashVerdict(statement: Statement): 'stash' | 'unreadable' | null {
  if (PATH_GIT.test(statement.stmt.split(/[ \t]/)[0] ?? '')) return 'unreadable';
  const sub = gitSubcommandOf(statement);
  if (sub === undefined || sub === '') return null;
  const words = statement.src === undefined ? null : rawWords(statement.src);
  if (words === null || words[0]?.raw !== 'git') return 'unreadable';
  let k = 1;
  while (k < words.length) {
    const word = words[k].text;
    if (word === '--config-env') return 'unreadable';
    if (word === '-c' && aliasing(words[k + 1]?.text ?? '')) return 'unreadable';
    if (word.startsWith(CONFIG_ENV) && aliasing(word.slice(CONFIG_ENV.length))) return 'unreadable';
    if (VALUE_OPTIONS.has(word)) k += 2;
    else if (word.startsWith('-')) k += 1;
    else break;
  }
  const [name, action] = sub.split(' ');
  if (words[k]?.raw !== name) return 'unreadable';
  if (name.toLowerCase() !== 'stash') return null;
  return action !== undefined && STASH_READS.has(action) && words[k + 1]?.raw === action ? null : 'stash';
}

/** The stash rule's deny for the first listed statement it does not admit, else null. */
function stashDeny(statements: readonly Statement[]): GateResult | null {
  for (const statement of statements) {
    const verdict = stashVerdict(statement);
    if (verdict === 'unreadable') return deny(SUBCOMMAND_REASON, SUBCOMMAND_FIX);
    if (verdict === 'stash') return deny(STASH_REASON, STASH_FIX);
  }
  return null;
}

function claudeMdReason(target: string): string {
  return `BLOCKED: SWE may not edit CLAUDE.md at the repo root (Human-owned; prompt_bearing does not lift this). Target: ${target}. Propose the change in your report; the Human applies it.`;
}

function capture(text: string): string {
  return stripTrailingNewlines(text.replace(/\0/g, ''));
}

function field(input: string, ...paths: string[][]): string {
  return capture(jqAlternatives(input, paths));
}

function canonical(path: string): string {
  return capture(pathCanonical(path));
}

function context(text: string, prefix = ''): GateResult {
  return { stdout: `${prefix}${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })}\n`, code: 0 };
}

/** `${s#"$prefix"/}`. */
function stripDir(s: string, dir: string): string {
  return s.startsWith(`${dir}/`) ? s.slice(dir.length + 1) : s;
}

/** A real dir (not a link) this user owns: `[ -d ] && [ ! -L ] && [ -O ]`. */
function ownDir(path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) return false;
    const st = statSync(path);
    return st.isDirectory() && st.uid === (process.geteuid?.() ?? -1);
  } catch {
    return false;
  }
}

/** A `$(( ))` operand: decimal, or octal with a leading 0; null where bash fails. */
function arith(value: string): number | null {
  if (/^0[0-9]+$/.test(value)) return /^[0-7]+$/.test(value) ? parseInt(value, 8) : null;
  return Number(value);
}

/** A session_id usable as a path segment, else "". */
function sessionOf(input: string): string {
  const session = field(input, ['session_id']);
  return session === '' || session.includes('/') || session.startsWith('.') ? '' : session;
}

/** A `$(( ))` error: bash abandons the top-level command it is in, so the .sh prints nothing and exits 0. */
class ArithmeticAbort extends Error {}

/** cmdStatements has no work cap, so the stack can run out in it on a shape the analyzer's own count let through. */
async function statementsOrOverflow(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<GitStatements | 'overflow'> {
  try {
    return await cmdStatements(command, cwd, env);
  } catch (e) {
    if (e instanceof RangeError) return 'overflow';
    throw e;
  }
}

class Boundary {
  readonly toolName: string;
  readonly swe: boolean;
  readonly reviewer: boolean;
  callerTask = '';
  worktree = '';
  ctxState: 'ok' | 'missing' | 'nodb' = 'ok';
  missing = '';
  wtD = '';
  target = '';

  constructor(
    readonly input: string,
    readonly env: NodeJS.ProcessEnv,
  ) {
    this.toolName = field(input, ['tool_name']);
    const role = agentRole(input);
    this.swe = role === 'swe';
    this.reviewer = role === CODE_REVIEWER_ROLE;
  }

  /** null when resolved, else the gate's whole answer (a DB read error). */
  resolve(): GateResult | null {
    if (!this.swe || !haveSqlite(this.env)) return null;
    const ctx = agentContext(this.input, '', this.env);
    switch (ctx.code) {
      case 0:
        this.callerTask = ctx.taskId;
        this.worktree = ctx.worktree;
        return null;
      case 2:
        return { stdout: `${denyDbUnavailable(GATE_NAME, this.env)}\n`, code: 0 };
      case 3:
        this.ctxState = 'nodb';
        return null;
      default:
        this.ctxState = 'missing';
        this.callerTask = ctx.taskId;
        this.missing = ctx.missing;
        return null;
    }
  }

  dbPath(): string {
    return dbPath(this.env, (line) => process.stderr.write(`${line}\n`)) ?? '';
  }

  async taskFor(target: string, db: string): Promise<string> {
    return this.callerTask !== '' ? this.callerTask : await resolveTaskIdForTarget(target, this.input, db, this.env);
  }

  wtOf(path: string): string {
    return ctxInWorktree(path, this.worktree) ? this.worktree : worktreeRootForTarget(path);
  }

  dbDenied(): GateResult {
    return { stdout: `${denyDbUnavailable(GATE_NAME, this.env)}\n`, code: 0 };
  }

  /** prompt_bearing of <task>: "1" lifts, GATE_READ_ERROR denies. */
  promptBearing(db: string, task: string): string {
    const value = gateRead(db, `\n        SELECT COALESCE(prompt_bearing, 0) FROM tasks WHERE id = ${task} LIMIT 1;\n      `, this.env);
    return value === GATE_READ_ERROR ? value : value || '0';
  }

  /** code-reviewer's only Bash rule: a command the analyzer cannot list stays admitted. */
  async reviewerBash(): Promise<GateResult> {
    const command = field(this.input, ['tool_input', 'command']);
    const listed = await statementsOrOverflow(command, payloadCwd(this.input, this.env), this.env);
    if (listed === 'overflow' || !listed.ok) return ALLOW;
    const unknown = listed.statements.find((statement) => gitSubcommandOf(statement) === undefined);
    if (unknown) return deny(ambiguousSubcommandReason(unknown.src ?? unknown.stmt, 'writes the git stash'), UNKNOWN_FIX);
    return stashDeny(listed.statements) ?? ALLOW;
  }

  async bash(): Promise<GateResult> {
    const command = field(this.input, ['tool_input', 'command']);
    const cwd = payloadCwd(this.input, this.env);
    const root = this.worktree || capture(projectRoot(this.env));
    const written = await writePaths(command, { cwd, root, env: this.env });
    if (written.some(isCapLine)) return deny(CAP_REASON, CAP_FIX);
    const listed = await statementsOrOverflow(command, cwd, this.env);
    if (listed === 'overflow') return deny(CAP_REASON, CAP_FIX);
    if (!listed.ok) return deny(PARSE_REASON, PARSE_FIX);
    const stash = stashDeny(listed.statements);
    if (stash) return stash;
    let push = false;
    let mutating = false;
    let unknown: Statement | undefined;
    for (const statement of listed.statements) {
      const sub = gitSubcommandOf(statement);
      if (sub === undefined) unknown ??= statement;
      else if ((sub === 'push' || sub.startsWith('push ')) && !FORCE.test(` ${sub} `)) push = true;
      if (ghMutation(statement.stmt) !== '') mutating = true;
    }
    if (push) return deny(SWE_PUSH_REASON, SWE_PUSH_FIX);
    if (unknown) return deny(ambiguousSubcommandReason(unknown.src ?? unknown.stmt, 'pushes'), UNKNOWN_FIX);
    if (mutating) return deny(GH_REASON, 'policy');

    let surface = '';
    let anchor = '';
    let rootClaudeMd = '';
    let unresolved = '';
    const fence: string[] = [];
    for (const path of written.join('\n').split('\n')) {
      if (path === '') continue;
      if (path.startsWith('UNRESOLVED:')) {
        const rest = path.slice('UNRESOLVED:'.length);
        const colon = rest.indexOf(':');
        if (unresolved === '' && !Object.hasOwn(NEVER_JUDGED, colon < 0 ? rest : rest.slice(0, colon))) {
          unresolved = colon < 0 ? path : rest.slice(colon + 1);
        }
        continue;
      }
      let wt = this.wtOf(path);
      let rel = stripDir(path, wt);
      if (wt === '' || rel === path) {
        wt = '';
        rel = path;
      }
      if (wt !== '' && rel === 'CLAUDE.md') rootClaudeMd = path;
      if (surface === '' && await isPromptSurfacePath(rel, wt, this.env)) {
        surface = path;
        anchor = wt === '' ? '' : path;
      }
      if (wt !== '') fence.push(path);
    }

    if (rootClaudeMd !== '') return deny(claudeMdReason(rootClaudeMd), 'policy');

    const db = surface !== '' || unresolved !== '' || fence.length > 0 ? this.dbPath() : '';
    if ((surface !== '' || unresolved !== '') && dbState(this.env) === 'error') return this.dbDenied();

    let lifted = false;
    if (surface !== '' || unresolved !== '') {
      const task = await this.taskFor(anchor, db);
      if (task !== '' && db !== '' && haveSqlite(this.env)) {
        const pb = this.promptBearing(db, task);
        if (pb === GATE_READ_ERROR) return this.dbDenied();
        lifted = pb === '1';
      }
    }
    if (surface !== '' && !lifted) {
      const glob = surface.search(GLOB_CHAR);
      if (glob >= 0) {
        const over = capture(posixDirname(`${surface.slice(0, glob)}x`));
        return deny(
          `BLOCKED: a loop or glob over ${over} reaches prompt-surface paths (${surface}); scope the listing below agents/, skills/, commands/, templates/ and rules/. Sanctioned route for intentional prompt edits: a prompt_bearing=1 task.`,
          { allowed: "the same command with the paths inlined, or excluding them in the source (-not -path '*/agents/*', --glob '!agents/**', ':!agents')" },
        );
      }
      return deny(
        `BLOCKED: SWE may not write prompt-surface files via Bash (${writeShapes()}). Target: ${surface}. Sanctioned routes: use a prompt_bearing=1 task for intentional prompt edits, or pr_monitor_worktree for reviewer experiments. Reads (cat/grep/sed -n) are always allowed.`,
        'policy',
      );
    }
    if (unresolved !== '' && !lifted) {
      return deny(`BLOCKED: write target "${unresolved}" ${UNJUDGED_PHRASE} depends on a variable the guard cannot resolve in this command.`, UNRESOLVED_FIX);
    }

    if (fence.length === 0 || db === '' || !haveSqlite(this.env)) return ALLOW;
    const scope = new ScopeFence(this.env);
    let fenceWt = '';
    let fenceTask = '';
    const notes: string[] = [];
    for (const path of fence) {
      const wt = this.wtOf(path);
      if (wt !== fenceWt) {
        fenceWt = wt;
        fenceTask = await this.taskFor(path, db);
        scope.load(db, fenceTask);
      }
      if (scope.state !== 'ok') continue;
      const rel = stripDir(path, wt);
      if (scope.allows(rel)) continue;
      const note = scope.note(fenceTask, rel);
      if (note !== '') notes.push(note);
    }
    return notes.length === 0 ? ALLOW : context(`TMB: ${notes.join('; ')}`);
  }

  scratchpadAllows(abs: string, session: string, base: string): boolean {
    if (session === '') return false;
    const target = canonical(abs);
    const rest = stripDir(target, base);
    const slash = rest.indexOf('/');
    const project = slash < 0 ? rest : rest.slice(0, slash);
    const scratch = `${base}/${project}/${session}/scratchpad`;
    const inner = stripDir(target, scratch);
    return rest !== target && project !== '' && project !== rest && inner !== target && inner !== '' && ownDir(scratch);
  }

  scratchHint(session: string, base: string, uid: number): string {
    const fallback = `/tmp/claude-${uid}/<project>/<session_id>/scratchpad`;
    if (session === '') return fallback;
    let names: string[];
    try {
      names = readdirSync(base).filter((n) => !n.startsWith('.'));
    } catch {
      return fallback;
    }
    const found = names.map((n) => `${base}/${n}/${session}/scratchpad`).filter(ownDir);
    return found.length === 1 ? found[0] : fallback;
  }

  async bypassCheck(): Promise<GateResult> {
    const session = sessionOf(this.input);
    if (session === '') return ALLOW;
    const state = stateDir(this.env);
    if (state === null) return ALLOW;
    const abs = this.target.startsWith('/') ? this.target : `${payloadCwd(this.input, this.env)}/${this.target}`;
    const record = `${canonical(state)}/locks/boundary-denies/${session}/${pathDigest(abs)}`;
    let text: string;
    try {
      if (!statSync(record).isFile()) return ALLOW;
      text = readFileSync(record, 'utf8');
    } catch {
      return ALLOW;
    }
    const lines = text.split('\n');
    const gate = lines[0] ?? '';
    const deniedAt = lines.length > 1 ? (lines[1] ?? '') : '';
    const drop = (): GateResult => {
      rmSync(record, { force: true });
      return ALLOW;
    };
    if (!/^[0-9]+$/.test(deniedAt)) return drop();
    let window = this.env.TMB_BYPASS_WINDOW_MIN || '10';
    if (!/^[0-9]+$/.test(window) || window === '0') window = '10';
    const at = arith(deniedAt);
    if (at === null) throw new ArithmeticAbort(`${deniedAt}: value too great for base (error token is "${deniedAt}")`);
    const windowMin = arith(window);
    if (windowMin === null) throw new ArithmeticAbort(`${window}: value too great for base (error token is "${window}")`);
    if (Math.floor(Date.now() / 1000) - at > windowMin * 60) return drop();
    const db = capture(dbPath(this.env) ?? '');
    if (db === '' || !haveSqlite(this.env)) return ALLOW;
    const task = await this.taskFor(this.target, db);
    let issue = '-1';
    if (task !== '') issue = sqlInt(capture(sqliteRo(db, `SELECT issue_id FROM tasks WHERE id = ${task};`, this.env))) || '-1';
    const rel = this.wtD === '' ? this.target : stripDir(this.target, this.wtD);
    const content = jqCompact({
      tool: this.toolName,
      path: this.target,
      denied_gate: gate,
      denied_at: Number(deniedAt),
      session_id: session,
      task_id: task === '' ? null : Number(task),
    });
    const written = auditAppend(
      db,
      {
        issueId: issue,
        branchId: '',
        fromNode: `hook:${GATE_NAME}`,
        eventType: 'hook_block_bypassed',
        summary: `${this.toolName} to ${rel} after ${gate} denied a Bash write to it`,
        contentJson: content,
      },
      { caller: GATE_NAME, env: this.env },
    );
    if (!written.ok) {
      if (written.error !== '') process.stderr.write(`${written.error}\n`);
      return { stdout: written.stdout, code: 0 };
    }
    rmSync(record, { force: true });
    return context(
      `TMB: ${this.toolName} to ${this.target} follows a ${gate} Bash deny in this session; recorded as hook_block_bypassed. A hook block is a hard stop: report it to bro instead of rewriting the file with another tool.`,
      written.stdout,
    );
  }

  async edit(): Promise<GateResult> {
    this.target = field(this.input, ['tool_input', 'file_path'], ['tool_input', 'notebook_path']);
    const target = this.target;
    if (target === '') return ALLOW;
    if (this.ctxState === 'missing') {
      return deny(
        `BLOCKED: swe-boundary cannot resolve this swe's worktree: ${this.missing}. An swe works out of <repos.path of tasks.repo>/.claude/worktrees/<branch slug>, found from the task_id=<N> in its spawn prompt; until that resolves, Edit/Write is denied. Target: ${target}. Report this to bro.`,
        'policy',
      );
    }
    const abs = target.startsWith('/') ? target : `${payloadCwd(this.input, this.env)}/${target}`;
    if (this.worktree !== '' && !ctxInWorktree(abs, this.worktree)) {
      const session = sessionOf(this.input);
      const uid = process.geteuid?.() ?? 0;
      const base = `${canonical('/tmp')}/claude-${uid}`;
      if (this.scratchpadAllows(abs, session, base)) return ALLOW;
      const hint = this.scratchHint(session, base, uid);
      return deny(`BLOCKED: SWE may only edit files inside its assigned worktree (${this.worktree}) of task ${this.callerTask}. Target '${target}' is outside the worktree.`, {
        allowed: `the same ${this.toolName} on a path under ${this.worktree}/, or under this session's scratchpad ${hint}/ for a scratch file`,
      });
    }

    let subject: string;
    if (this.worktree !== '') {
      this.wtD = this.worktree;
      subject = stripDir(canonical(abs), canonical(this.worktree));
    } else {
      this.wtD = worktreeRootForTarget(target);
      subject = this.wtD === '' ? target : stripDir(target, this.wtD);
    }
    if (this.wtD !== '' && subject === 'CLAUDE.md') return deny(claudeMdReason(target), 'policy');
    if (!await isPromptSurfacePath(subject, this.wtD, this.env)) return await this.bypassCheck();

    const db = this.dbPath();
    if (dbState(this.env) === 'error') return this.dbDenied();
    if (db !== '' && haveSqlite(this.env)) {
      const task = await this.taskFor(target, db);
      if (task !== '') {
        const pb = this.promptBearing(db, task);
        if (pb === GATE_READ_ERROR) return this.dbDenied();
        if (pb === '1') return await this.bypassCheck();
      }
    }
    return deny(
      `BLOCKED: SWE may not edit prompt-surface files (agents/, skills/*/SKILL.md, commands/, templates/, CLAUDE.md, CODEX/CURSOR/GEMINI.md). Target: ${target}. If the spec needs this edit, stop and name the file in your report; bro re-plans it as a new prompt_bearing=1 task.`,
      'policy',
    );
  }
}

export const sweBoundary: Gate = async (payload, env) => {
  const b = new Boundary(payload, env);
  const early = b.resolve();
  if (early) return early;
  if (b.toolName === 'Bash' && b.swe) return await b.bash();
  if (b.toolName === 'Bash' && b.reviewer) return await b.reviewerBash();
  if (!EDIT_TOOLS.has(b.toolName) || !b.swe) return ALLOW;
  try {
    return await b.edit();
  } catch (e) {
    if (!(e instanceof ArithmeticAbort)) throw e;
    process.stderr.write(`${e.message}\n`);
    return ALLOW;
  }
};
