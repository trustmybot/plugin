/**
 * PreToolUse gate (GH 1692), the port of scripts/hooks/containment-guard.sh:
 * an agent writes only under its run's root — a swe under its task's
 * worktree, bro and code-reviewer under the project — plus the model cache,
 * the host temp dir, Claude Code's /tmp/claude-<uid>, the devices and, for
 * the main session only, Claude Code's own project and plans dirs.
 *
 * Write / Edit / MultiEdit / NotebookEdit are judged by their canonical
 * target; Bash by its cwd and by the write targets the tree-sitter analyzer
 * (cmd-analysis) finds. Every denial writes one containment_denied audit row.
 * No trajectory DB → allow; a DB that cannot be read → deny.
 *
 * Deny messages, audit rows and the allow/deny decision are the .sh's, with
 * one exception: a target the analyzer reports as `$(parse)` (the command did
 * not parse), `$(computed)` (a path built at run time) or `$(unproven)` (an
 * inline program or command the analyzer cannot prove, GH 1739) is always denied,
 * never through the literal-dir allowance. That deny, and the deny of a
 * target behind a variable, substitution or cd the guard cannot resolve,
 * reads `BLOCKED: write target "<target>" cannot be judged: <why>`;
 * dispatch.sh matches the phrase (its UNJUDGED_PHRASE) and keeps no
 * boundary-deny record for it, since no path was judged (GH 1750, GH 1772).
 *
 * A second exception (GH 1912): with no absolute TMPDIR in the hook env, a
 * Bash call the sandbox runs (not marked dangerouslyDisableSandbox) is judged
 * with the TMPDIR Claude Code's sandbox gives it, /tmp/claude-<uid>, when that
 * dir passes harnessTmp's check. The .sh keeps the hook env, so a `$TMPDIR`
 * target stays unresolved there and is denied. No corpus payload runs it.
 */
import { lstatSync, statSync } from 'node:fs';
import { ALLOW, type Gate, type GateResult } from './gate.js';
import { agentContext, pathCanonical } from './lib/agent-context.js';
import { auditAppend } from './lib/audit.js';
import {
  dbPath,
  dbState,
  denyDbUnavailable,
  projectRoot,
  sqlInt,
  sqliteRo,
  stripTrailingNewlines,
  sweContext,
} from './lib/db.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { ctypeUtf8, posixDirname, shellPwd } from './lib/project-env.js';
import { normalizeRole } from './lib/role.js';
import { writePaths, type WritePathsOptions } from './cmd-analysis/index.js';

export type WritePathsFn = (command: string, options: WritePathsOptions) => Promise<string[]>;

const HOOK = 'containment-guard';
const RUN_BUDGET_MS = '2500';
const JUDGED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);
const DEVICE = /^\/dev\/(null|stdout|stderr|tty)$|^\/dev\/fd\//;
const GLOB_CHAR = /[*?[]/;

export const UNJUDGED_PHRASE = 'cannot be judged:';

/** Why each never-judged target is denied; dispatch.sh relies on no text holding a double quote. */
export const NEVER_JUDGED: Readonly<Record<string, string>> = {
  '$(parse)': 'the command could not be parsed, so its write targets are unknown; split it or fix its quoting.',
  '$(computed)':
    'the program builds the path at run time (a computed or argv path, a program held in a variable, a substitution or stdin, or an exec placeholder under `sh -c`), so the guard cannot tell where it writes; use Edit or Write on the literal path, or a Bash command whose write target is a literal path.',
  '$(unproven)':
    'the inline program is unproven: it calls something the guard can neither prove read-only nor judge as a write (an unlisted call, a callable held in a name, dynamic attribute access), or the shell fills in part of its text or command word, so the guard cannot tell what it writes; use Edit or Write, a plain read-only one-liner, or a script file.',
};

/** What a `$(...)` capture of a command's output keeps. */
function capture(text: string): string {
  return stripTrailingNewlines(text.replace(/\0/g, ''));
}

function jqField(input: string, ...paths: string[][]): string {
  return capture(jqAlternatives(input, paths));
}

function canonical(path: string): string {
  return capture(pathCanonical(path));
}

function stripSlash(dir: string): string {
  return dir.endsWith('/') ? dir.slice(0, -1) : dir;
}

function under(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${stripSlash(dir)}/`);
}

/** The canonical /tmp/claude-<uid>, which counts only when absent or a real dir (not a link) this user owns; "" otherwise. */
export function harnessTmp(uid: number): string {
  const dir = `/tmp/claude-${uid}`;
  let link: ReturnType<typeof lstatSync> | undefined;
  try {
    link = lstatSync(dir);
  } catch {
    link = undefined;
  }
  let target: ReturnType<typeof statSync> | undefined;
  try {
    target = statSync(dir);
  } catch {
    target = undefined;
  }
  const isLink = link?.isSymbolicLink() ?? false;
  if (!target && !isLink) return canonical(dir);
  if (target?.isDirectory() && !isLink && target.uid === (process.geteuid?.() ?? uid)) return canonical(dir);
  return '';
}

/** `sed 's/[^A-Za-z0-9]/-/g'`: per code point under a UTF-8 locale, per byte otherwise. */
function ccSlug(dir: string, env: NodeJS.ProcessEnv): string {
  const units = ctypeUtf8(env) ? [...dir] : [...Buffer.from(dir, 'utf8')].map((b) => String.fromCharCode(b));
  return capture(units.map((u) => (u === '\n' || /^[A-Za-z0-9]$/.test(u) ? u : '-')).join(''));
}

function ccProjectDir(ccHome: string, dir: string, env: NodeJS.ProcessEnv): string {
  const slug = ccSlug(dir, env);
  return /[A-Za-z0-9]/.test(slug) ? canonical(`${ccHome}/projects/${slug}`) : '';
}

class Denied {
  constructor(readonly result: GateResult) {}
}

class Guard {
  readonly env: NodeJS.ProcessEnv;
  readonly uid = process.getuid?.() ?? 0;
  db = '';
  cwd = '';
  toolName = '';
  agentId = '';
  taskId = '';
  root = '';
  rootC = '';
  unbound = false;
  bound = false;
  missing = '';
  cacheDir = '';
  cacheC = '';
  hostTmpC = '';
  harnessTmpC = '';
  ccProjectC = '';
  ccSessionC = '';
  ccPlansC = '';

  runEnv: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv) {
    this.env = env;
    this.runEnv = env;
  }

  home(): string {
    return this.env.HOME ?? '';
  }

  allowed(path: string): boolean {
    if (DEVICE.test(path)) return true;
    if (this.unbound) return false;
    const c = canonical(path);
    return (
      under(c, this.rootC) ||
      under(c, this.cacheC) ||
      (this.hostTmpC !== '' && this.hostTmpC !== '/' && under(c, this.hostTmpC)) ||
      (this.harnessTmpC !== '' && under(c, this.harnessTmpC)) ||
      (this.ccProjectC !== '' && under(c, this.ccProjectC)) ||
      (this.ccSessionC !== '' && under(c, this.ccSessionC)) ||
      (this.ccPlansC !== '' && under(c, this.ccPlansC))
    );
  }

  deny(path: string, given = ''): never {
    let reason = given;
    let why = '';
    if (this.unbound) {
      why = `unbound_caller: ${this.agentId ? `swe agent_id ${this.agentId}: ` : ''}${this.missing}`;
      reason = `BLOCKED: containment — this swe${this.agentId ? ` (agent_id ${this.agentId})` : ''} has no root to write under: ${this.missing}. An swe writes under <repos.path of tasks.repo>/.claude/worktrees/<branch slug>, found from the task_id=<N> in its spawn prompt. Target: ${path}. Report this to bro.`;
    }
    const content = jqCompact({
      tool: this.toolName,
      path,
      root: this.root === '' ? null : this.root,
      task_id: this.taskId === '' ? null : Number(this.taskId),
      ...(why === '' ? {} : { reason: why }),
    });
    const taskId = sqlInt(this.taskId);
    let issue = '-1';
    if (taskId !== '') issue = sqlInt(sqliteRo(this.db, `SELECT issue_id FROM tasks WHERE id = ${taskId};`, this.env)) || '-1';
    const written = auditAppend(
      this.db,
      {
        issueId: issue,
        branchId: '',
        fromNode: `hook:${HOOK}`,
        eventType: 'containment_denied',
        summary: `${this.toolName} denied: ${path} is outside ${this.root || `any root (unbound swe ${this.agentId})`}`,
        contentJson: content,
      },
      { caller: HOOK, env: this.env },
    );
    if (written.error !== '') process.stderr.write(`${written.error}\n`);
    if (reason === '') {
      reason = `BLOCKED: containment — ${path} is outside this run's root ${this.root}. TMB agents write only under their root (the task worktree for swe, the project for bro); put scratch files in ${stripSlash(this.root)}/.claude/tmb/scratch/ (or /tmp/claude-${this.uid}).`;
    }
    const decision = jqCompact({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    });
    throw new Denied({ stdout: `${written.stdout}${decision}\n`, code: 0 });
  }

  /** The absolute path a write-position word names; null behind an unresolvable variable or command. */
  expand(word: string): string | null {
    const home = this.home();
    let p = word;
    if (p === '~') p = home;
    else if (p.startsWith('~/')) p = `${home}/${p.slice(2)}`;
    p = p.split('${HOME}').join(home).split('$HOME').join(home);
    p = p.split('${TMB_MODEL_CACHE_DIR}').join(this.cacheDir).split('$TMB_MODEL_CACHE_DIR').join(this.cacheDir);
    if (/[$`]/.test(p) || p.startsWith('~')) return null;
    const glob = p.search(GLOB_CHAR);
    if (glob >= 0) {
      p = p.slice(0, glob);
      if (!p.endsWith('/')) p = capture(posixDirname(p));
    }
    if (!p.startsWith('/')) p = `${this.cwd}/${p}`;
    return stripTrailingNewlines(p);
  }

  unresolved(raw: string, variable: string): void {
    const cut = raw.search(/[$`]/);
    const lit = cut < 0 ? raw : raw.slice(0, cut);
    const slash = lit.lastIndexOf('/');
    const dir = slash < 0 ? '' : lit.slice(0, slash) || '/';
    if (dir !== '') {
      const expanded = this.expand(dir);
      if (expanded !== null && this.allowed(expanded)) return;
    }
    this.deny(raw, `BLOCKED: write target "${raw}" ${UNJUDGED_PHRASE} ${unresolvedWhy(variable)}.`);
  }

  /** A .. leaves the root and a later name enters it again: the write lands on the root from outside. */
  climbsBack(path: string): boolean {
    if (!`/${path}/`.includes('/../')) return false;
    if (this.root === '') return false;
    const line = (path.startsWith('/') ? path.slice(1) : path).split('\n')[0];
    let acc = '';
    let left = false;
    let inside = false;
    for (const part of line.split('/')) {
      if (part === '' || part === '.') continue;
      acc = part === '..' ? acc.slice(0, Math.max(0, acc.lastIndexOf('/'))) : `${acc}/${part}`;
      const at = acc || '/';
      if (under(at, stripSlash(this.root)) || under(at, stripSlash(this.rootC))) {
        inside = true;
      } else {
        if (inside) left = true;
        inside = false;
      }
    }
    return left && inside;
  }

  judge(path: string): void {
    if (this.climbsBack(path)) {
      this.deny(
        path,
        `BLOCKED: containment — write target "${path}" leaves this run's root ${this.root} with .. and comes back into it, so it lands on the root from outside. Name the path from inside the root.`,
      );
    }
    if (!this.allowed(path)) this.deny(path);
  }
}

function unresolvedWhy(variable: string): string {
  switch (variable) {
    case '$(proc)':
      return 'comes from a process call in an inline program (subprocess, os.system, exec, spawn, …) whose command, arguments or cwd are not all plain literals, so the guard cannot tell what it writes; pass literal arguments, or run the command from the shell';
    case '$(alias-write)':
      return "is written through an aliased or stored write builtin the guard can't resolve; call open() (or the write method) directly with a literal path";
    case '$()':
      return 'is built by a command substitution or backticks the guard cannot evaluate; inline the path';
    case 'PWD':
      return 'is relative to a directory from a cd, pushd or popd the guard cannot resolve (cd -, popd, or a cd through a variable); cd to a literal path';
    case '':
      return 'depends on a variable the guard cannot resolve in this command; inline the path or set the variable in the same command';
    default:
      return `depends on a variable the guard cannot resolve in this command: $${variable} is not set to a literal earlier in it; inline the path or set ${variable}=<path> in the same command`;
  }
}

function globClimbs(word: string): boolean {
  const glob = word.search(GLOB_CHAR);
  return glob >= 0 && `/${word.slice(glob + 1)}/`.includes('/../');
}

/** `${word#UNRESOLVED:*:}` and the <var> between the two colons. */
function splitUnresolved(word: string): { variable: string | null; target: string } {
  if (!word.startsWith('UNRESOLVED:')) return { variable: null, target: word };
  const rest = word.slice('UNRESOLVED:'.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return { variable: rest, target: word };
  return { variable: rest.slice(0, colon), target: rest.slice(colon + 1) };
}

async function judgeBash(g: Guard, input: string, analyze: WritePathsFn): Promise<void> {
  const command = jqField(input, ['tool_input', 'command']);
  const writes = command === '' ? [] : await analyze(command, { cwd: g.cwd, raw: true, root: g.root, env: g.runEnv });
  const lines = capture(writes.join('\n')).split('\n').filter((w) => w !== '');
  if (lines.length === 0) return;
  if (!g.unbound && !g.bound && !g.allowed(g.cwd)) g.deny(g.cwd);
  const seen = new Set<string>();
  for (const word of lines) {
    if (seen.has(word)) continue;
    seen.add(word);
    const { variable, target } = splitUnresolved(word);
    if (variable !== null && Object.hasOwn(NEVER_JUDGED, variable)) {
      g.deny(target, `BLOCKED: write target "${target}" ${UNJUDGED_PHRASE} ${NEVER_JUDGED[variable]}`);
    }
    if (globClimbs(target)) {
      g.deny(
        target,
        `BLOCKED: containment — write target "${target}" climbs with .. after a glob; the guard cannot tell where that lands. Name the directory without .. after a glob.`,
      );
    }
    const path = g.expand(target);
    if (variable !== null) {
      if (path !== null) g.judge(path);
      else g.unresolved(target, variable);
      continue;
    }
    if (path !== null) g.judge(path);
  }
}

/** The TMPDIR the command runs with: the hook's when absolute, else the sandbox's for a sandboxed Bash call. */
function runTmpdir(input: string, g: Guard): string {
  const hookTmp = g.env.TMPDIR ?? '';
  if (/^\/./s.test(hookTmp)) return hookTmp;
  if (g.toolName !== 'Bash' || g.harnessTmpC === '') return hookTmp;
  if (jqField(input, ['tool_input', 'dangerouslyDisableSandbox']) === 'true') return hookTmp;
  return `/tmp/claude-${g.uid}`;
}

async function guard(input: string, env: NodeJS.ProcessEnv, analyze: WritePathsFn): Promise<void> {
  const g = new Guard(env);
  g.toolName = jqField(input, ['tool_name']);
  if (!JUDGED_TOOLS.has(g.toolName)) return;
  const state = dbState(env);
  if (state === 'unresolved') return;
  if (state === 'error') throw new Denied({ stdout: `${denyDbUnavailable(HOOK, env)}\n`, code: 0 });
  g.db = dbPath(env) ?? '';
  g.cwd = capture(jqField(input, ['cwd']) || shellPwd(env));
  const agentType = normalizeRole(jqField(input, ['agent_type']));
  g.agentId = jqField(input, ['agent_id']);
  const project = projectRoot(env);
  if (sweContext(agentType) === 'yes') {
    const ctx = agentContext(input, g.db, env);
    g.taskId = ctx.taskId;
    if (ctx.code === 0) {
      g.root = ctx.worktree;
      g.bound = true;
    } else if (ctx.code === 2) {
      throw new Denied({ stdout: `${denyDbUnavailable(HOOK, env)}\n`, code: 0 });
    } else {
      g.unbound = true;
      g.missing = ctx.missing;
    }
  }
  if (g.root === '' && !g.unbound) g.root = project;
  g.rootC = g.root === '' ? '' : canonical(g.root);

  g.cacheDir = env.TMB_MODEL_CACHE_DIR || env.HF_HOME || `${g.home()}/.cache/huggingface`;
  g.cacheC = canonical(g.cacheDir);
  g.harnessTmpC = harnessTmp(g.uid);
  const tmpdir = runTmpdir(input, g);
  if (tmpdir !== (env.TMPDIR ?? '')) g.runEnv = { ...env, TMPDIR: tmpdir };
  if (/^\/./s.test(tmpdir)) g.hostTmpC = canonical(tmpdir);
  if (agentType === '' || agentType === 'bro') {
    const ccHome = env.CLAUDE_CONFIG_DIR || `${g.home()}/.claude`;
    g.ccProjectC = ccProjectDir(ccHome, g.root, env);
    if (env.CLAUDE_PROJECT_DIR) g.ccSessionC = ccProjectDir(ccHome, env.CLAUDE_PROJECT_DIR, env);
    g.ccPlansC = canonical(`${ccHome}/plans`);
  }

  if (g.toolName !== 'Bash') {
    let target = jqField(input, ['tool_input', 'file_path'], ['tool_input', 'notebook_path']);
    if (target === '') return;
    if (!target.startsWith('/')) target = `${g.cwd}/${target}`;
    if (!g.allowed(target)) g.deny(target);
    return;
  }
  await judgeBash(g, input, analyze);
}

export function containmentGuardWith(analyze: WritePathsFn): Gate {
  return async (payload, env) => {
    try {
      await guard(payload, { ...env, TMB_DB_WRITE_RUN_BUDGET_MS: RUN_BUDGET_MS }, analyze);
      return ALLOW;
    } catch (e) {
      if (e instanceof Denied) return e.result;
      throw e;
    }
  };
}

export const containmentGuard: Gate = containmentGuardWith(writePaths);
