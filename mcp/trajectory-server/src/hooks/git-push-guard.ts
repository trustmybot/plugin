/**
 * PreToolUse gate (GH 1692): a `git push` runs only when every pushed commit that is a task's
 * commit_sha has a code-reviewer pass verdict, and every pushed commit with the
 * patch-id of a task commit (a rebase, GH 1518), or its patch-id outside
 * mcp/[name]/dist and dashboard/dist (a rebase with regenerated dist, GH 1627),
 * is reviewed and has a passing verification run of its own. swe and
 * code-reviewer never push; a push from .claude/worktrees/, or from a dir the
 * guard cannot tie to one checkout, is denied; so is a git statement whose
 * subcommand is not literal text (an expansion, GH 2634), a statement that
 * runs code the listing cannot read (`opaque`, GH 2635: a non-literal code
 * string or command word, a PS4 set other than by a literal assignment, a
 * variable name a builtin takes from an expansion), and a DB read error.
 * Code a statement runs later (a trap, an alias, a `-C` callback, a PS4 that
 * `set -x` expands) is listed in `-`, so a push in it is an unresolved target.
 *
 * GH 3102: a push is judged on the commits its refspecs send, not on HEAD,
 * forced pushes included, a refspec that names no commit is denied, and a
 * stored commit_sha matches as a 7+ hex prefix of the pushed SHA.
 *
 * Decision 369: a command naming `push` (or, GH 2634, a git word beside an
 * expansion) that tree-sitter-bash cannot parse is denied (GH 1927), and the
 * DB is read wherever node:sqlite works, with no sqlite3 CLI on PATH.
 */
import { ALLOW, type Gate, type GateResult } from './gate.js';
import {
  ambiguousSubcommandReason,
  cmdStatements,
  denyAmbiguousGitTarget,
  gitBesideExpansion,
  gitSubcommandOf,
  payloadCwd,
  prefilterPasses,
  type Statement,
  stmtRepoRoot,
} from './cmd-analysis/index.js';
import { operandWords } from './cmd-analysis/statements.js';
import { DB_RETRY_FIX, dbPath, gateRead, GATE_READ_ERROR, haveSqlite, sqlQuote, stripTrailingNewlines } from './lib/db.js';
import { shaPrefixMatchSql, shaValuesCte } from './lib/sha-prefix.js';
import { gitOk, gitOut, gitRun } from './lib/git.js';
import { type DenyFix, denyResult as deny } from './lib/deny.js';
import { jqAlternatives } from './lib/jq.js';
import { repoGitRoot, repoNameForRoot, repoResolve, repoSinglePath } from './lib/repo.js';
import { agentRole, CODE_REVIEWER_ROLE } from './lib/role.js';
import { HAS_PASS_SQL } from '../review-sql.js';

export const GATE_NAME = 'git-push-guard';

const SOURCE_PATHS = [':(top)', ':(top,exclude,glob)mcp/*/dist/**', ':(top,exclude)dashboard/dist'];
const HEX = /^[0-9a-f]+$/;
/** `git push` options whose value is the next word. */
const PUSH_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option']);
/** `git push` options that push every ref under a namespace instead of naming refspecs. */
const PUSH_REF_SETS: ReadonlyMap<string, readonly string[]> = new Map([
  ['--all', ['refs/heads/']],
  ['--branches', ['refs/heads/']],
  ['--mirror', ['refs/']],
  ['--tags', ['refs/tags/']],
]);
const GIT_WORD = /\bgit\b/;
/** An `xargs` git may take its subcommand from stdin (GH 2797). */
const XARGS = /\bxargs\b/;

export const SWE_PUSH_REASON = 'BLOCKED: SWE must never push. Bro handles the push gate after code-reviewer passes; commit in your worktree.';
export const SWE_PUSH_FIX: DenyFix = { allowed: "task_update_status(status='completed', commit_sha, report)" };
const CODE_REVIEWER_REASON = `BLOCKED: ${CODE_REVIEWER_ROLE} must not push. The push decision belongs to bro after the verdict row. Bro reads the validation_attempts verdict and handles the push when all tasks are signed.`;
const WORKTREE_REASON = 'BLOCKED: push from .claude/worktrees/ is forbidden. Bro pushes from the main checkout after reaping the detached-HEAD commits.';
const WORKTREE_FIX: DenyFix = { allowed: 'git fetch ./.claude/worktrees/<slug> HEAD:<feature>, then git push from the main checkout' };
const DB_REASON =
  'BLOCKED: trajectory DB unavailable — the push gate could not read task review state (sqlite3 error), so it refuses to fail open. Check the trajectory DB.';
export const PARSE_REASON =
  'BLOCKED: the push gate could not parse this command, so it cannot tell which statements push or from which checkout.';
export const PARSE_FIX: DenyFix = { allowed: 'the same push split into simpler commands with plain quoting' };
const subcommandReason = (what: string): string =>
  `${ambiguousSubcommandReason(what, 'pushes')} An option value in double quotes, such as \`git -C "$W" status\`, is allowed.`;
const SUBCOMMAND_FIX: DenyFix = { allowed: 'git -C <path> push …, or the literal subcommand it runs' };
const opaqueReason = (what: string): string =>
  `BLOCKED: ambiguous_git_subcommand: \`${what}\` runs code the guard cannot read (a \`bash -c\` or \`eval\` string built from an expansion, a command word that is an expansion, code a shell reads from stdin, a \`\${…@P}\` prompt expansion, a PS4 set other than by a literal \`PS4=\` assignment, a variable name a builtin takes from an expansion, or code nested too deep), so it cannot tell whether that code pushes. Write the code literally.`;
const OPAQUE_FIX: DenyFix = { allowed: "the code itself, or bash -c '<literal code>', or PS4='<literal>'" };
const INTEGRATE_FIX: DenyFix = { allowed: 'node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" integrate <task_id> <base>' };
const unresolvedRefspecReason = (refspec: string, what: string, dir: string): string =>
  `BLOCKED: the push gate cannot resolve the refspec \`${refspec}\` of \`${what}\` to a commit in ${dir}, so it cannot tell which commits the push sends and refuses to fail open.`;
const UNRESOLVED_REFSPEC_FIX: DenyFix = { allowed: 'git -C <repo> push <remote> <src>[:<dst>], its <src> a local branch, HEAD, a full ref or a commit' };
const SHA_LIST_REASON = 'BLOCKED: the push gate read a pushed commit that is not a full SHA, so it cannot match it against task commits and refuses to fail open.';

function pushVerb(sub: string): boolean {
  return sub === 'push' || sub.startsWith('push ');
}

/** What a `git push` names: its remote ('' when none), its refspecs, whether `--delete` makes every refspec a delete, and the ref namespaces `--all`, `--branches`, `--mirror` or `--tags` push. */
export interface PushArgs {
  readonly remote: string;
  readonly refspecs: readonly string[];
  readonly deletes: boolean;
  readonly refSets: readonly string[];
}

/** The PushArgs of <sub>, git's subcommand `push` and the words after it, its redirects dropped. */
export function pushArgs(sub: string): PushArgs {
  const words = operandWords(sub.split(/[ \t]+/).filter((w) => w !== ''));
  const operands: string[] = [];
  const refSets = new Set<string>();
  let repoOption = '';
  let deletes = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === '--') {
      operands.push(...words.slice(i + 1));
      break;
    }
    if (!word.startsWith('-') || word === '-') {
      operands.push(word);
    } else if (PUSH_VALUE_OPTIONS.has(word)) {
      if (word === '--repo') repoOption = words[i + 1] ?? '';
      i++;
    } else if (word.startsWith('--repo=')) {
      repoOption = word.slice('--repo='.length);
    } else if (word === '--delete') {
      deletes = true;
    } else if (PUSH_REF_SETS.has(word)) {
      for (const set of PUSH_REF_SETS.get(word) ?? []) refSets.add(set);
    } else if (!word.startsWith('--')) {
      for (let c = 1; c < word.length; c++) {
        if (word[c] === 'd') deletes = true;
        if (word[c] !== 'o') continue;
        if (c === word.length - 1) i++;
        break;
      }
    }
  }
  return { remote: operands[0] ?? repoOption, refspecs: operands.slice(1), deletes, refSets: [...refSets] };
}

/** One refspec of a push: its source and destination as written ('' when left out), and whether it is a delete, which sends no commits. */
interface Refspec {
  readonly src: string;
  readonly dst: string;
  readonly deletes: boolean;
}

/** <refspec> split, its `+` (a forced update, judged like any other) dropped; null for a pattern or negative refspec, which names no one commit. */
function splitRefspec(refspec: string): Refspec | null {
  const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  if (spec.startsWith('^') || spec.includes('*')) return null;
  const colon = spec.indexOf(':');
  const src = colon < 0 ? spec : spec.slice(0, colon);
  const dst = colon < 0 ? '' : spec.slice(colon + 1);
  return { src, dst, deletes: src === '' && dst !== '' };
}

/** The lines of a `$(...)` capture, as `printf '%s\n' "$x"` feeds them on: [""] for "". */
function lines(text: string): string[] {
  return text.split('\n');
}

/** `awk -F'|'` field <n> (1-based) of a line, "" past its last. */
function field(line: string, n: number): string {
  return line.split('|')[n - 1] ?? '';
}

function hexLines(text: string): string[] {
  return lines(text).filter((l) => HEX.test(l));
}

/** `grep -vxF -f <(printf '%s\n' "$drop")` over the lines of <text>. */
function without(text: string, drop: string): string {
  const gone = new Set(lines(drop));
  return lines(text)
    .filter((l) => !gone.has(l))
    .join('\n');
}

class Guard {
  constructor(
    private readonly db: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  private read(sql: string): string {
    return gateRead(this.db, sql, this.env);
  }

  /** paths_sig: `<\037-joined changed paths>\t<sha>` per commit of <input> that changes something within the pathspec. */
  private async pathsSig(dir: string, input: string, spec: readonly string[]): Promise<string[]> {
    const out = (await gitRun(dir, ['diff-tree', '--stdin', '-r', '--root', '--name-only', '--format=commit %H', ...spec], this.env, input)).stdout;
    const sigs: string[] = [];
    let sha = '';
    let files = '';
    const flush = (): void => {
      if (sha !== '' && files !== '') sigs.push(`${files}\t${sha}`);
      sha = '';
      files = '';
    };
    const rows = out.split('\n');
    if (rows[rows.length - 1] === '') rows.pop();
    for (const row of rows) {
      const m = /^commit ([0-9a-f]+)$/.exec(row);
      if (m) {
        flush();
        sha = m[1];
      } else if (/\S/.test(row)) {
        files += `\x1f${row}`;
      }
    }
    flush();
    return sigs;
  }

  /** pair_by_paths: `<sha> <task sha>...` per commit of <shas> sharing its changed-path set with task commits. */
  private async pairByPaths(dir: string, taskRows: string, shas: string, spec: readonly string[]): Promise<string> {
    const bySet = new Map<string, string>();
    const taskInput = `${lines(taskRows).map((r) => field(r, 1)).join('\n')}\n`;
    for (const sig of await this.pathsSig(dir, taskInput, spec)) {
      const [files, sha = ''] = sig.split('\t');
      bySet.set(files, `${bySet.get(files) ?? ''} ${sha}`);
    }
    const out: string[] = [];
    for (const sig of await this.pathsSig(dir, `${shas}\n`, spec)) {
      const [files, sha = ''] = sig.split('\t');
      const tasks = bySet.get(files);
      if (tasks !== undefined) out.push(sha + tasks);
    }
    return out.join('\n');
  }

  /** task_matches: `<sha>|<task_id>|<branch_id>|<reviewed>` per paired commit whose patch-id equals a task commit's, a reviewed task preferred. */
  private async taskMatches(dir: string, taskRows: string, pairs: string, spec: readonly string[]): Promise<string[]> {
    const shas = [...new Set(pairs.split(/[ \n]/))].sort();
    const patch = (await gitRun(dir, ['diff-tree', '--stdin', '-p', '-r', '--root', ...spec], this.env, `${shas.join('\n')}\n`)).stdout;
    const ids = stripTrailingNewlines((await gitRun(dir, ['patch-id', '--stable'], this.env, patch)).stdout);
    if (ids === '') return [];
    const pid = new Map<string, string>();
    for (const row of lines(ids)) {
      const [id = '', sha = ''] = row.trim().split(/\s+/);
      pid.set(sha, id);
    }
    const task = new Map<string, string>();
    for (const row of lines(taskRows)) {
      const bar = row.indexOf('|');
      task.set(bar < 0 ? '' : row.slice(0, bar), bar < 0 ? row : row.slice(bar));
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of lines(pairs)) {
      const words = row.trim().split(/\s+/).filter((w) => w !== '');
      const sha = words[0] ?? '';
      if (!pid.has(sha) || seen.has(sha)) continue;
      seen.add(sha);
      let m = '';
      for (const cand of words.slice(1)) {
        if (pid.has(cand) && pid.get(cand) === pid.get(sha) && task.has(cand)) {
          const t = task.get(cand) ?? '';
          if (m === '' || /\|1$/.test(t)) m = t;
          if (/\|1$/.test(m)) break;
        }
      }
      if (m !== '') out.push(sha + m);
    }
    return out;
  }

  /**
   * unchecked_rebases: `<sha>|<task_id>|<branch_id>|<reviewed>|<full|src>`
   * per pushed rebase of a task commit that is not reviewed or has no passing
   * verification run of its own; __ERR__ when a DB read fails.
   */
  async uncheckedRebases(dir: string, pushed: string): Promise<string> {
    const values = shaValuesCte(hexLines(pushed));
    if (values === null) return '';
    const taskCommits = this.read(
      `WITH ${values} SELECT p.sha FROM p WHERE EXISTS (SELECT 1 FROM tasks t WHERE ${shaPrefixMatchSql('t.commit_sha', 'p.sha')});`,
    );
    if (taskCommits === GATE_READ_ERROR) return GATE_READ_ERROR;
    const fresh = without(pushed, taskCommits);
    if (fresh === '') return '';

    const name = repoNameForRoot(this.db, await repoGitRoot(dir, this.env), this.env);
    const repoFilter = name === '' ? '' : `AND (t.repo IS NULL OR t.repo = '${sqlQuote(name)}')`;
    const tasks = this.read(
      `SELECT t.commit_sha || '|' || t.id || '|' || COALESCE(t.branch_id, '') || '|' || ${HAS_PASS_SQL} FROM tasks t WHERE length(t.commit_sha) >= 7 AND t.commit_sha NOT GLOB '*[^0-9a-f]*' ${repoFilter} ORDER BY t.id;`,
    );
    if (tasks === GATE_READ_ERROR) return GATE_READ_ERROR;
    if (tasks === '') return '';

    const taskLines = lines(tasks);
    const checked = lines(
      (await gitRun(
        dir,
        ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
        this.env,
        `${taskLines.map((r) => field(r, 1)).join('\n')}\n`,
      )).stdout.replace(/\n$/, ''),
    );
    const fullRows: string[] = [];
    const n = Math.max(checked.length, taskLines.length);
    for (let i = 0; i < n; i++) {
      const rest = taskLines[i] === undefined ? '' : taskLines[i].slice(taskLines[i].indexOf('|') + 1);
      const row = `${checked[i] ?? ''}|${rest}`;
      const o = row.split(/[ |]/);
      if (o[1] === 'commit') fullRows.push(o[0] + row.slice(row.indexOf('|')));
    }
    const full = fullRows.join('\n');
    if (full === '') return '';

    let matches: string[] = [];
    let pairs = await this.pairByPaths(dir, full, fresh, []);
    if (pairs !== '') matches = (await this.taskMatches(dir, full, pairs, [])).map((m) => `${m}|full`);

    let srcMatches: string[] = [];
    const rest = without(fresh, matches.map((m) => field(m, 1)).join('\n'));
    if (rest !== '') {
      const spec = ['--', ...SOURCE_PATHS];
      pairs = await this.pairByPaths(dir, full, rest, spec);
      if (pairs !== '') srcMatches = (await this.taskMatches(dir, full, pairs, spec)).map((m) => `${m}|src`);
    }
    const all = [...matches, ...srcMatches].filter((m) => m !== '');
    if (all.length === 0) return '';

    const reviewed = shaValuesCte(all.filter((m) => field(m, 4) === '1' && HEX.test(field(m, 1))).map((m) => field(m, 1)));
    let ok = '';
    if (reviewed !== null) {
      ok = this.read(
        `WITH ${reviewed} SELECT DISTINCT p.sha FROM p WHERE EXISTS (SELECT 1 FROM verification_runs v WHERE ${shaPrefixMatchSql('v.commit_sha', 'p.sha')} AND v.exit_code = 0 AND v.timed_out = 0);`,
      );
      if (ok === GATE_READ_ERROR) return GATE_READ_ERROR;
    }
    const passed = new Set(lines(ok).map((l) => field(l, 1)));
    return all.filter((m) => field(m, 4) !== '1' || !passed.has(field(m, 1))).join('\n');
  }

  /** The base the commits of a branch with no upstream are counted from: the target branch's ref, else the remote default's, else "". */
  private async baseRef(dir: string): Promise<string> {
    let target = field(repoResolve(this.db, await stmtRepoRoot(dir, this.cwd, this.env), this.env), 1);
    if (target === '') {
      const sole = repoSinglePath(this.db, this.env);
      if (sole !== '') target = field(repoResolve(this.db, sole, this.env), 1);
    }
    const remoteDefault = async (): Promise<string> =>
      (await gitOut(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], this.env)).replace(/^origin\//gm, '');
    if (target === '') target = await remoteDefault();
    target ||= 'main';
    const existing = async (branch: string): Promise<string> => {
      for (const cand of [`origin/${branch}`, branch]) {
        if (await gitOk(dir, ['rev-parse', '--verify', '--quiet', cand], this.env)) return cand;
      }
      return '';
    };
    let base = await existing(target);
    if (base === '') {
      const fallback = await remoteDefault();
      if (fallback !== '') base = await existing(fallback);
    }
    return base;
  }

  /** The commits a bare `git push`, which names no refspec, sends: those past the upstream, else past the base. */
  private async headShas(dir: string): Promise<string> {
    const upstream = await gitOut(dir, ['log', '@{u}..HEAD', '--pretty=%H'], this.env);
    if (upstream !== '') return upstream;
    const base = await this.baseRef(dir);
    return await gitOut(dir, ['log', base === '' ? 'HEAD' : `${base}..HEAD`, '--pretty=%H'], this.env);
  }

  /** The commit <rev> names in <dir>, or '' when it names none. */
  private async commitOf(dir: string, rev: string): Promise<string> {
    if (rev === '' || rev.startsWith('-')) return '';
    const r = await gitRun(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], this.env);
    return r.code === 0 ? r.stdout.trim() : '';
  }

  /** The remote-tracking ref of the branch <spec> updates on <remote>, when it exists; '' sends the caller to the base. */
  private async trackingRef(dir: string, remote: string, spec: Refspec): Promise<string> {
    let dst = spec.dst || spec.src;
    if (dst === 'HEAD' || dst === '@') dst = await gitOut(dir, ['symbolic-ref', '-q', 'HEAD'], this.env);
    const branch = dst.startsWith('refs/heads/') ? dst.slice('refs/heads/'.length) : dst.startsWith('refs/') ? '' : dst;
    if (remote === '' || branch === '') return '';
    const ref = `refs/remotes/${remote}/${branch}`;
    return (await this.commitOf(dir, ref)) === '' ? '' : ref;
  }

  /** The refspecs `<set>:<set>` for every ref under each of <sets>. */
  private async refSetSpecs(dir: string, sets: readonly string[]): Promise<string[]> {
    if (sets.length === 0) return [];
    const refs = await gitOut(dir, ['for-each-ref', '--format=%(refname)', ...sets], this.env);
    return refs === '' ? [] : lines(refs).map((ref) => `${ref}:${ref}`);
  }

  /**
   * The commits one push statement sends, newline-joined, or the refspec no
   * commit can be found for. Each refspec sends its source minus the remote
   * branch it updates when that is tracked here, else minus the base; a bare
   * push keeps HEAD's range and a delete sends nothing.
   */
  private async pushedShas(dir: string, args: PushArgs): Promise<{ shas: string } | { unresolved: string }> {
    if (args.refspecs.length === 0 && args.refSets.length === 0) return { shas: await this.headShas(dir) };
    if (!(await gitOk(dir, ['rev-parse', '--git-dir'], this.env))) return { shas: '' };
    const isMatching = (refspec: string): boolean => refspec === ':' || refspec === '+:';
    const matching = args.refspecs.some(isMatching) ? ['refs/heads/'] : [];
    const specs: { refspec: string; enumerated: boolean }[] = [
      ...args.refspecs.filter((refspec) => !isMatching(refspec)).map((refspec) => ({ refspec, enumerated: false })),
      ...(await this.refSetSpecs(dir, [...new Set([...args.refSets, ...matching])])).map((refspec) => ({ refspec, enumerated: true })),
    ];
    let base: string | undefined;
    const shas = new Set<string>();
    for (const { refspec, enumerated } of specs) {
      const spec = splitRefspec(refspec);
      if (spec === null) return { unresolved: refspec };
      if (args.deletes || spec.deletes) continue;
      const tip = await this.commitOf(dir, spec.src);
      if (tip === '') {
        if (enumerated) continue;
        return { unresolved: refspec };
      }
      let stop = await this.trackingRef(dir, args.remote, spec);
      if (stop === '') stop = base ??= await this.baseRef(dir);
      const range = stop === '' ? [tip] : [tip, `^${stop}`];
      const out = await gitOut(dir, ['rev-list', ...range], this.env);
      if (out !== '') for (const sha of lines(out)) shas.add(sha);
    }
    return { shas: [...shas].join('\n') };
  }

  /** The deny for one push statement <push>, whose subcommand words are <sub>, or null when it may go. */
  async judge(push: Statement, sub: string): Promise<GateResult | null> {
    const { dir } = push;
    const listed = await this.pushedShas(dir, pushArgs(sub));
    if ('unresolved' in listed) return deny(unresolvedRefspecReason(listed.unresolved, push.src ?? push.stmt, dir), UNRESOLVED_REFSPEC_FIX);
    const pushed = listed.shas;
    if (pushed === '') return null;
    const shaList = hexLines(pushed);
    if (shaList.length === 0) return null;
    const values = shaValuesCte(shaList);
    if (values === null) return deny(SHA_LIST_REASON, 'policy');

    const unsigned = this.read(
      `WITH ${values} SELECT t.id || '|' || t.branch_id || '|' || substr(t.title, 1, 60) FROM tasks t WHERE EXISTS (SELECT 1 FROM p WHERE ${shaPrefixMatchSql('t.commit_sha', 'p.sha')}) AND NOT ${HAS_PASS_SQL};`,
    );
    if (unsigned === GATE_READ_ERROR) return deny(DB_REASON, DB_RETRY_FIX);
    if (unsigned !== '') {
      const rows = lines(unsigned);
      const list = rows.map((r) => `  - task_id=${field(r, 1)}  ${field(r, 2)}  (${field(r, 3)})`).join('\n');
      return deny(
        `BLOCKED: pushing ${rows.length} unsigned commit(s). The following tasks lack a code-reviewer pass verdict:\n\n${list}\n\nbro will spawn code-reviewer for each unsigned task. On all-pass the push will proceed. On any fail bro surfaces what needs fixing.`,
        { allowed: '@bro review before push' },
      );
    }

    const unchecked = await this.uncheckedRebases(dir, pushed);
    if (unchecked === GATE_READ_ERROR) return deny(DB_REASON, DB_RETRY_FIX);
    if (unchecked === '') return null;
    const rows = lines(unchecked);
    const list = rows
      .map((r) => {
        const why = field(r, 4) === '1' ? 'no passing verification run for this commit' : 'the task has no passing review';
        const kind = field(r, 5) === 'src' ? 'rebase with regenerated dist' : 'rebase';
        return `  - ${field(r, 1)}  ${kind} of task_id=${field(r, 2)}  ${field(r, 3)}  (${why})`;
      })
      .join('\n');
    return deny(
      `BLOCKED: pushing ${rows.length} rebased task commit(s) not covered by a review and a verification run. Each has the patch-id of a task commit (a rebase with regenerated dist: the patch-id outside mcp/*/dist and dashboard/dist) but is not that commit:\n\n${list}\nA task with no passing review needs @bro review before push first. Then rebase it with cli.js integrate, which re-runs verification[] on the rebased commit, records the run and only then moves the branch.`,
      INTEGRATE_FIX,
    );
  }
}

export const gitPushGuard: Gate = async (payload, env) => {
  const command = stripTrailingNewlines(jqAlternatives(payload, [['tool_input', 'command']]).replace(/\0/g, ''));
  const namesPush = prefilterPasses(command, (text) => text.includes('push'));
  const xargsGit = !namesPush && prefilterPasses(command, (text) => GIT_WORD.test(text) && XARGS.test(text));
  if (!namesPush && !xargsGit && !gitBesideExpansion(command)) return ALLOW;

  const cwd = payloadCwd(payload, env);
  const listed = await cmdStatements(command, cwd, env);
  if (!listed.ok) return deny(PARSE_REASON, PARSE_FIX);
  const opaque = namesPush ? listed.statements.find((statement) => statement.opaque) : undefined;
  if (opaque) return deny(opaqueReason(opaque.src ?? opaque.stmt), OPAQUE_FIX);
  const subs = listed.statements.map((statement) => gitSubcommandOf(statement));
  const unknown = listed.statements[subs.indexOf(undefined)];
  if (unknown) return deny(subcommandReason(unknown.src ?? unknown.stmt), SUBCOMMAND_FIX);
  const pushes = listed.statements.flatMap((statement, j) => {
    const sub = subs[j] ?? '';
    return pushVerb(sub) ? [{ statement, sub }] : [];
  });
  if (pushes.length === 0) return ALLOW;

  const role = agentRole(payload);
  if (role === 'swe') return deny(SWE_PUSH_REASON, SWE_PUSH_FIX);
  if (role === CODE_REVIEWER_ROLE) return deny(CODE_REVIEWER_REASON, 'policy');

  const db = dbPath(env, (line) => process.stderr.write(`${line}\n`)) ?? '';
  const guard = new Guard(db, cwd, env);
  for (const { statement, sub } of pushes) {
    const { dir } = statement;
    if (dir === '?') return { stdout: denyAmbiguousGitTarget(statement), code: 0 };
    if (dir === '-') return { stdout: denyAmbiguousGitTarget(statement, true), code: 0 };
    if (dir.includes('/.claude/worktrees/')) return deny(WORKTREE_REASON, WORKTREE_FIX);
    if (db === '' || !haveSqlite(env)) continue;
    const verdict = await guard.judge(statement, sub);
    if (verdict) return verdict;
  }
  return ALLOW;
};
