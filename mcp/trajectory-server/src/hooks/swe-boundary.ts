/**
 * PreToolUse gate (GH 1692), the port of scripts/hooks/swe-boundary.sh: the
 * structural fence of an swe, keyed on its identity (agentRole) and the task
 * and worktree its spawn transcript resolves to (agentContext).
 *
 *   (a) Bash: git push                                     → deny
 *   (b) Bash: gh/glab mutating subcommands                 → deny
 *   (c) Edit/Write outside the assigned worktree           → deny, except the
 *       session's own scratchpad under <canonical /tmp>/claude-<uid>/
 *   (d) Edit/Write CLAUDE.md at the worktree root          → deny (always);
 *       other prompt-surface paths                         → deny unless prompt_bearing=1
 *   (e) Bash-written root CLAUDE.md / prompt-surface path  → as (d)
 *   (f) Bash-written path outside files[]                  → note, once per path
 *   (g) Bash write target the guard cannot resolve         → deny unless prompt_bearing=1
 *   (h) Edit/Write after a recorded Bash deny on the path  → allow, audit hook_block_bypassed
 *
 * Deny messages, notes, audit rows and decisions are the .sh's, with two
 * exceptions, each stricter: a command tree-sitter-bash cannot parse is
 * denied (the .sh reads it with its awk skeleton), and the DB is read
 * wherever node:sqlite works, with no sqlite3 CLI on PATH. The analyzer's
 * never-judged targets (`$(parse)`, `$(computed)`, `$(unproven)`, which the
 * .sh's analyzer never prints) are containment-guard's to deny, not (g)'s.
 */
import { lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { ALLOW, type Gate, type GateResult } from './gate.js';
import { NEVER_JUDGED, UNJUDGED_PHRASE } from './containment-guard.js';
import {
  cmdStatements,
  ghMutation,
  gitSubcommand,
  isPromptSurfacePath,
  payloadCwd,
  writePaths,
  writeShapes,
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
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { posixDirname } from './lib/project-env.js';
import { agentRole } from './lib/role.js';
import { ScopeFence } from './lib/scope-fence.js';
import { pathDigest, resolveTaskIdForTarget, worktreeRootForTarget } from './lib/target-task.js';

export const GATE_NAME = 'swe-boundary';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FORCE = / --force | -f | --force-with-lease | --force-with-lease=/;
const GLOB_CHAR = /[*?[]/;

const PUSH_REASON =
  'BLOCKED: SWE must never push. Bro handles the push gate after code-reviewer passes. Commit in your worktree and call task_update_status(completed).';
const GH_REASON =
  'BLOCKED: SWE may not run gh/glab mutating commands (create/close/edit/merge/delete/api POST|PATCH|PUT|DELETE). Read-only gh commands (view, list, status) are allowed. Mutations go through bro.';
export const PARSE_REASON =
  'BLOCKED: swe-boundary could not parse this command, so it cannot tell whether it pushes, runs a gh/glab mutation or writes a prompt-surface path. Split it into simpler commands or fix its quoting.';

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

function deny(reason: string): GateResult {
  const decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  return { stdout: `${jqCompact(decision)}\n`, code: 0 };
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
class ArithmeticAbort {
  constructor(readonly message: string) {}
}

class Boundary {
  readonly toolName: string;
  readonly swe: boolean;
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
    this.swe = agentRole(input) === 'swe';
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

  taskFor(target: string, db: string): string {
    return this.callerTask !== '' ? this.callerTask : resolveTaskIdForTarget(target, this.input, db, this.env);
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

  async bash(): Promise<GateResult> {
    const command = field(this.input, ['tool_input', 'command']);
    const cwd = payloadCwd(this.input, this.env);
    const listed = await cmdStatements(command, cwd, this.env);
    if (!listed.ok) return deny(PARSE_REASON);
    let push = false;
    let mutating = false;
    for (const { stmt } of listed.statements) {
      const sub = gitSubcommand(stmt);
      if ((sub === 'push' || sub.startsWith('push ')) && !FORCE.test(` ${sub} `)) push = true;
      if (ghMutation(stmt) !== '') mutating = true;
    }
    if (push) return deny(PUSH_REASON);
    if (mutating) return deny(GH_REASON);

    const root = this.worktree || capture(projectRoot(this.env));
    let surface = '';
    let anchor = '';
    let rootClaudeMd = '';
    let unresolved = '';
    const fence: string[] = [];
    const lines = (await writePaths(command, { cwd, root, env: this.env })).join('\n').split('\n');
    for (const path of lines) {
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
      if (surface === '' && isPromptSurfacePath(rel, wt, this.env)) {
        surface = path;
        anchor = wt === '' ? '' : path;
      }
      if (wt !== '') fence.push(path);
    }

    if (rootClaudeMd !== '') return deny(claudeMdReason(rootClaudeMd));

    const db = surface !== '' || unresolved !== '' || fence.length > 0 ? this.dbPath() : '';
    if ((surface !== '' || unresolved !== '') && dbState(this.env) === 'error') return this.dbDenied();

    let lifted = false;
    if (surface !== '' || unresolved !== '') {
      const task = this.taskFor(anchor, db);
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
          `BLOCKED: a loop or glob over ${over} reaches prompt-surface paths (${surface}); scope the listing below agents/, skills/, commands/, templates/ and rules/, exclude them in the source (-not -path '*/agents/*', --glob '!agents/**', ':!agents'), or inline the paths. Sanctioned route for intentional prompt edits: a prompt_bearing=1 task.`,
        );
      }
      return deny(
        `BLOCKED: SWE may not write prompt-surface files via Bash (${writeShapes()}). Target: ${surface}. Sanctioned routes: use a prompt_bearing=1 task for intentional prompt edits, or pr_monitor_worktree for reviewer experiments. Reads (cat/grep/sed -n) are always allowed.`,
      );
    }
    if (unresolved !== '' && !lifted) {
      return deny(
        `BLOCKED: write target "${unresolved}" ${UNJUDGED_PHRASE} depends on a variable the guard cannot resolve in this command; inline the path or set the variable in the same command.`,
      );
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
        fenceTask = this.taskFor(path, db);
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

  bypassCheck(): GateResult {
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
    const task = this.taskFor(this.target, db);
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

  edit(): GateResult {
    this.target = field(this.input, ['tool_input', 'file_path'], ['tool_input', 'notebook_path']);
    const target = this.target;
    if (target === '') return ALLOW;
    if (this.ctxState === 'missing') {
      return deny(
        `BLOCKED: swe-boundary cannot resolve this swe's worktree: ${this.missing}. An swe works out of <repos.path of tasks.repo>/.claude/worktrees/<branch slug>, found from the task_id=<N> in its spawn prompt; until that resolves, Edit/Write is denied. Target: ${target}. Report this to bro.`,
      );
    }
    const abs = target.startsWith('/') ? target : `${payloadCwd(this.input, this.env)}/${target}`;
    if (this.worktree !== '' && !ctxInWorktree(abs, this.worktree)) {
      const session = sessionOf(this.input);
      const uid = process.geteuid?.() ?? 0;
      const base = `${canonical('/tmp')}/claude-${uid}`;
      if (this.scratchpadAllows(abs, session, base)) return ALLOW;
      const hint = this.scratchHint(session, base, uid);
      return deny(
        `BLOCKED: SWE may only edit files inside its assigned worktree (${this.worktree}) of task ${this.callerTask}. Target '${target}' is outside the worktree. Scratch files go in this session's scratchpad, ${hint}/.`,
      );
    }

    let subject: string;
    if (this.worktree !== '') {
      this.wtD = this.worktree;
      subject = stripDir(canonical(abs), canonical(this.worktree));
    } else {
      this.wtD = worktreeRootForTarget(target);
      subject = this.wtD === '' ? target : stripDir(target, this.wtD);
    }
    if (this.wtD !== '' && subject === 'CLAUDE.md') return deny(claudeMdReason(target));
    if (!isPromptSurfacePath(subject, this.wtD, this.env)) return this.bypassCheck();

    const db = this.dbPath();
    if (dbState(this.env) === 'error') return this.dbDenied();
    if (db !== '' && haveSqlite(this.env)) {
      const task = this.taskFor(target, db);
      if (task !== '') {
        const pb = this.promptBearing(db, task);
        if (pb === GATE_READ_ERROR) return this.dbDenied();
        if (pb === '1') return this.bypassCheck();
      }
    }
    return deny(
      `BLOCKED: SWE may not edit prompt-surface files (agents/, skills/*/SKILL.md, commands/, templates/, CLAUDE.md, CODEX/CURSOR/GEMINI.md). Target: ${target}. If this task intentionally modifies agent prompts, set prompt_bearing=1 in task_create_batch.`,
    );
  }
}

export const sweBoundary: Gate = async (payload, env) => {
  const b = new Boundary(payload, env);
  const early = b.resolve();
  if (early) return early;
  if (b.toolName === 'Bash' && b.swe) return b.bash();
  if (!EDIT_TOOLS.has(b.toolName) || !b.swe) return ALLOW;
  try {
    return b.edit();
  } catch (e) {
    if (!(e instanceof ArithmeticAbort)) throw e;
    process.stderr.write(`${e.message}\n`);
    return ALLOW;
  }
};
