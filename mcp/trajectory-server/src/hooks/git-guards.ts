/**
 * PreToolUse gate (GH 1692): the git
 * workflow rules of the repo's branching model, judged per executable
 * statement against the repo and branch of that statement's dir.
 *   1. A PR (gh pr create) or MR (glab mr create) targets pr_target; dev → main
 *      is the one release merge when pr_target is dev.
 *   2. No merge / rebase / cherry-pick in a main checkout (a fast-forward of a
 *      branch to its own upstream aside), and no commit on a shared workflow base.
 *   3. No force push to a protected branch.
 *   4. A new branch starts from the latest pr_target.
 *   5. A git statement whose subcommand is not literal text (gitSubcommandOf,
 *      GH 2641) is denied, since no rule can be judged on it.
 * Only a registered repo is guarded when the DB reads; a registered repo with
 * no policy gets github-flow with its default branch as target and sole
 * protected branch.
 *
 * A command naming git, gh or glab that tree-sitter-bash cannot parse is
 * denied with PARSE_REASON, the early exit reads ASCII letters and digits in
 * every locale, the DB is read wherever node:sqlite works, with no sqlite3
 * CLI on PATH, and the switch-then-fast-forward sync needs an ASCII-only
 * command.
 */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { ALLOW, type Gate, type GateResult } from './gate.js';
import {
  ambiguousSubcommandReason,
  cmdStatements,
  cwdState,
  denyAmbiguousGitTarget,
  gitBesideExpansion,
  gitSubcommandOf,
  payloadCwd,
  prefilterPasses,
  type Statement,
  stmtRepoRoot,
  stripLiterals,
} from './cmd-analysis/index.js';
import { dbPath, haveSqlite, sqliteRo, sqlQuote, stripTrailingNewlines, taskBySlug } from './lib/db.js';
import { gitOk, gitOut, gitRun, isDir } from './lib/git.js';
import { type DenyFix, denyResult } from './lib/deny.js';
import { jqAlternatives, jqCompact, jqRawElements, jsonStream } from './lib/jq.js';
import { posixBasename } from './lib/project-env.js';
import { lineStatements } from './lib/statement-rows.js';
import { repoDefaultBranch, repoIsRegistered, repoNameForRoot, repoResolve } from './lib/repo.js';
import { classifyUrl } from '../utils/classify-url.js';

export const GATE_NAME = 'git-guards';

const NEEDS_GUARD = /(^|[^A-Za-z0-9_.-])(git|gh|glab)([ \t\n\v\f\r]|$)/;
const SPACE = '[ \\t\\n\\v\\f\\r]';
const NONSPACE = '[^ \\t\\n\\v\\f\\r]';
const GUARDED_SUB = /^(commit|merge|rebase|cherry-pick|push)( |$)|^(checkout -b|switch -c) /;
const INTEGRATION_SUB = /^(merge|rebase|cherry-pick)( |$)/;
const FF_SYNC_QUIET = new Set(['-q', '--quiet', '-v', '--verbose', '--stat', '--no-stat', '-n', '--progress', '--no-progress']);
const FF_SYNC_COMPANIONS = new Set(['cd', 'echo', 'printf', 'true', 'false', 'test', '[', 'pwd']);
const FF_SYNC_GIT_READS = new Set(['fetch', 'status', 'log', 'diff', 'show', 'rev-parse']);
const NON_ASCII = /[^\x00-\x7f]/;
const SWITCH_TAIL = new Set(['', ' ', ';', '|', '&', ')']);

export const PARSE_REASON =
  'BLOCKED: the git guard could not parse this command, so it cannot tell which statements run git, gh or glab, or in which checkout.';
export const PARSE_FIX: DenyFix = { allowed: 'the same command split into simpler commands with plain quoting' };
const UNKNOWN_FIX: DenyFix = { allowed: 'git -C <path> <subcommand> …, the subcommand written literally' };
const MALFORMED_REASON = "BLOCKED: this repo's protected_branches is malformed JSON; the repos row needs fixing or onboarding re-run.";

/**
 * _cmd_needs_git_guard: a git, gh or glab word anywhere, as written or
 * unquoted, a `$'…'` word (GH 2758), or a git word beside an expansion (GH 2641), the early exit before
 * any parse or DB read. Its letters and digits are ASCII in every locale, so a
 * word right after a non-ASCII letter is analysed, as under LC_ALL=C.
 */
export function needsGitGuard(command: string): boolean {
  return prefilterPasses(command, (text) => NEEDS_GUARD.test(text)) || gitBesideExpansion(command);
}

class Denied extends Error {
  constructor(readonly result: GateResult) {
    super('git-guards denied');
  }
}

function deny(reason: string, fix: DenyFix): Denied {
  return new Denied(denyResult(reason, fix));
}

interface Recovery {
  text: string;
  fix: DenyFix;
}

/** The URL `origin` fetches from in `git remote -v` output, else the first remote's. */
export function primaryRemoteUrl(remotes: string): string {
  const rows = remotes
    .split('\n')
    .map((line) => line.split(/[ \t]+/))
    .filter((cols) => cols.length >= 2 && cols[0] !== '');
  return (rows.find((cols) => cols[0] === 'origin') ?? rows[0])?.[1] ?? '';
}

/** The push-then-open recovery for <target>: `glab mr create` on a GitLab remote, `gh pr create` on any other. */
export function forgeRecovery(remotes: string, target: string): Recovery {
  if (classifyUrl(primaryRemoteUrl(remotes)) === 'gitlab') {
    return {
      text: ` Push your feature branch and open an MR into ${target}.`,
      fix: { allowed: `git push origin <branch> && glab mr create --target-branch ${target} --source-branch <branch>` },
    };
  }
  return {
    text: ` Push your feature branch and open a PR into ${target}.`,
    fix: { allowed: `git push origin <branch> && gh pr create --base ${target} --head <branch>` },
  };
}

interface Row {
  dir: string;
  stmt: string;
}

/** `IFS=$'\t' read -r dir stmt` of one line. */
function readRow(line: string): Row {
  const s = line.replace(/^\t+/, '');
  const tab = s.indexOf('\t');
  if (tab < 0) return { dir: s, stmt: '' };
  return { dir: s.slice(0, tab), stmt: s.slice(tab).replace(/^\t+|\t+$/g, '') };
}

/** `read -r -a w <<< "$s"`: the first line's words. */
function words(s: string): string[] {
  return (s.split('\n')[0] ?? '').split(/[ \t]+/).filter((w) => w !== '');
}

/** `printf '%s' "$s" | grep -oE -- <find> | head -1 | sed -E 's/<strip>//'`. */
function optionValue(s: string, find: string, strip: string): string {
  const m = new RegExp(find).exec(s);
  return m ? m[0].replace(new RegExp(strip), '') : '';
}

/** `$(printf '%s' <text> | cut -d'|' -f<n>)`. */
function cutField(text: string, n: number): string {
  const fields = text.split('\n').map((line) => (line.includes('|') ? (line.split('|')[n - 1] ?? '') : line));
  return stripTrailingNewlines(fields.join('\n'));
}

/** `(cd <dir> && pwd -P)`, "" when the cd fails. */
function physicalDir(dir: string): string {
  try {
    if (!statSync(dir).isDirectory()) return '';
    accessSync(dir, constants.X_OK);
    return realpathSync.native(dir);
  } catch {
    return '';
  }
}

/**
 * _rule2_inline_landings: every commit's landing branch when the statements
 * switch to a named branch before each commit, "" when any commit lands on an
 * unknown branch, no statement commits, or a `git -C` statement touches a
 * branch or commit.
 */
function inlineLandings(text: string): string {
  const leadC = new RegExp(`^git${SPACE}+-C(${SPACE}|$)`);
  const commit = new RegExp(`^git${SPACE}+commit(${SPACE}|$)`);
  const create = [new RegExp(`^git${SPACE}+checkout${SPACE}+-b${SPACE}`), new RegExp(`^git${SPACE}+switch${SPACE}+-c${SPACE}`)];
  const change = new RegExp(`^git${SPACE}+(checkout|switch)(${SPACE}|$)`);
  const split = new RegExp(`${SPACE}+`);
  let landings = '';
  let current = '';
  let known = false;
  let saw = false;
  for (const s of text.split('\n')) {
    if (leadC.test(s) && /(commit|checkout|switch)/.test(s)) return '';
    if (commit.test(s)) {
      saw = true;
      if (!known) return '';
      landings += `${current}\n`;
    } else if (create.some((re) => re.test(s))) {
      const tok = s.split(split);
      const j = tok.findIndex((t) => t === '-b' || t === '-c');
      const name = j >= 0 && j < tok.length - 1 ? tok[j + 1] : '';
      if (name === '') return '';
      current = name;
      known = true;
    } else if (change.test(s)) {
      const name = s.split(split)[2] ?? '';
      if (name === '' || name.startsWith('-')) return '';
      current = name;
      known = true;
    }
  }
  return saw ? stripTrailingNewlines(landings) : '';
}

/** ff_sync_other_ok: a statement a fast-forward sync may share its command with. */
function ffSyncOtherOk(stmt: string, statement: string | Statement): boolean {
  if (stmt.includes('>') || stmt.includes('<')) return false;
  const w0 = words(stmt)[0] ?? '';
  if (FF_SYNC_COMPANIONS.has(w0)) return true;
  if (w0 !== 'git') return false;
  if (stmt.includes(':')) return false;
  return FF_SYNC_GIT_READS.has((gitSubcommandOf(statement) ?? '').split(' ')[0]);
}

class GitGuards {
  private readonly dirs: string[];
  private readonly stmts: string[];
  private readonly landings: string;
  private readonly dbReadable: boolean;
  private gitRoot = '';
  private prTarget = '';
  private protectedBranches = '';
  private judging = 0;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly db: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly lines: string[],
    private readonly owners: ReadonlyArray<Statement | undefined> = [],
  ) {
    const rows = lines.map(readRow);
    this.dirs = rows.map((r) => r.dir);
    this.stmts = rows.map((r) => r.stmt);
    this.landings = inlineLandings(stripTrailingNewlines(lines.map((l) => (l.includes('\t') ? l.slice(l.indexOf('\t') + 1) : l)).join('\n')));
    this.dbReadable = db !== '' && isFile(db) && haveSqlite(env);
  }

  /** Line <idx>'s statement, with its `cut` and `src`, when the line is all of one; else the line's text. */
  private statementAt(idx: number): string | Statement {
    return this.owners[idx] ?? this.stmts[idx];
  }

  private async git(dir: string, ...args: string[]): Promise<string> {
    return await gitOut(dir, args, this.env);
  }

  private async gitOk(dir: string, ...args: string[]): Promise<boolean> {
    return await gitOk(dir, args, this.env);
  }

  /** load_policy: the repos row of <root>, or false for no root or an unregistered repo. */
  private async loadPolicy(root: string): Promise<boolean> {
    if (root === '') return false;
    this.gitRoot = root;
    this.prTarget = '';
    let raw = '';
    if (this.dbReadable) {
      if (!repoIsRegistered(this.db, root, this.env)) return false;
      const row = repoResolve(this.db, root, this.env);
      this.prTarget = cutField(row, 1);
      raw = cutField(row, 3);
    }
    const defaultBranch = await repoDefaultBranch(root, this.env);
    this.prTarget ||= defaultBranch;
    raw ||= jqCompact([defaultBranch]);
    const parsed = jsonStream(raw);
    if (!parsed.complete || !Array.isArray(parsed.values[parsed.values.length - 1])) throw deny(MALFORMED_REASON, 'policy');
    this.protectedBranches = stripTrailingNewlines(jqRawElements(raw));
    return true;
  }

  private branchIsProtected(branch: string): boolean {
    return this.protectedBranches.split('\n').includes(branch);
  }

  /** dir_branch: the branch checked out in <dir>, else the newest task whose branch_id ends in /<basename of dir>. */
  private async dirBranch(dir: string): Promise<string> {
    const branch = await this.git(dir, 'branch', '--show-current');
    if (branch !== '' || !this.dbReadable) return branch;
    return taskBySlug(this.db, posixBasename(dir), 'branch_id', '', this.env, (line) => process.stderr.write(`${line}\n`)).replace(/\n/g, '');
  }

  private async dirInWorktree(dir: string): Promise<boolean> {
    const top = await this.git(dir, 'rev-parse', '--show-toplevel');
    return top !== '' && physicalDir(top) !== physicalDir(this.gitRoot);
  }

  /** need_dir: deny an ambiguous dir; false for an unknown or missing one. */
  private needDir(dir: string, stmt: string, unresolved: boolean): boolean {
    if (dir === '?') {
      const owner = this.owners[this.judging];
      const src = this.stmts[this.judging] === stmt && owner?.stmt === stmt ? owner.src : undefined;
      throw new Denied({ stdout: denyAmbiguousGitTarget({ stmt, src }, unresolved), code: 0 });
    }
    if (dir === '-' || dir === '') return false;
    return isDir(dir);
  }

  /**
   * rule2_protected_bases: protected_branches ∪ target ∪ repos.pr_target ∪ every task's parent_branch_id
   * that no task owns as its branch_id. A stacked task branch is not a shared base (GH 2607).
   */
  private rule2ProtectedBases(): Set<string> {
    const out = [...this.protectedBranches.split('\n'), this.prTarget];
    if (this.dbReadable) {
      const name = repoNameForRoot(this.db, this.gitRoot, this.env);
      if (name !== '' && sqliteRo(this.db, "SELECT 1 FROM pragma_table_info('repos') WHERE name='pr_target' LIMIT 1;", this.env) !== '') {
        out.push(
          ...sqliteRo(this.db, `SELECT pr_target FROM repos WHERE name = '${sqlQuote(name)}' AND pr_target IS NOT NULL AND pr_target != '';`, this.env).split('\n'),
        );
      }
      const filter = name === '' ? 'repo IS NULL' : `(repo = '${sqlQuote(name)}' OR repo IS NULL)`;
      out.push(
        ...sqliteRo(
          this.db,
          `SELECT DISTINCT parent_branch_id FROM tasks WHERE parent_branch_id IS NOT NULL AND parent_branch_id != '' AND ${filter}
             AND parent_branch_id NOT IN (SELECT branch_id FROM tasks WHERE branch_id IS NOT NULL AND branch_id != '' AND ${filter});`,
          this.env,
        ).split('\n'),
      );
    }
    return new Set(out.filter((b) => !/^[ \t\n\v\f\r]*$/.test(b)));
  }

  private async rule2Recovery(dir: string): Promise<Recovery> {
    if (dir === '-' || dir === '?' || dir === '' || !isDir(dir)) return { text: '', fix: forgeRecovery('', this.prTarget).fix };
    const remotes = await this.git(dir, 'remote', '-v');
    if (remotes !== '') return forgeRecovery(remotes, this.prTarget);
    return { text: ' This repo has no remote — leave the branch unmerged and surface it to the Human for integration.', fix: 'policy' };
  }

  /** ff_sync_switch: the local branch statement <i> switches to right before `&&` and the merge, "" otherwise. */
  private async ffSyncSwitch(i: number, dir: string): Promise<string> {
    if (i < 0 || (this.dirs[i] ?? '') !== dir) return '';
    const stmt = this.stmts[i];
    const w = words(stmt);
    if (w[0] !== 'git') return '';
    let k = w[1] === '-C' ? 3 : 1;
    if (w[k] !== 'switch' && w[k] !== 'checkout') return '';
    k += 1;
    if (w[k] === '-q' || w[k] === '--quiet') k += 1;
    const name = w[k] ?? '';
    if (name === '' || name.startsWith('-') || k + 1 !== w.length) return '';
    if (!await this.gitOk(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`)) return '';
    if (NON_ASCII.test(this.command)) return '';
    const flat = stripLiterals(this.command).replace(/\n/g, ';').replace(/[ \t]+/g, ' ');
    const needle = `${stmt} && ${this.stmts[i + 1] ?? ''}`;
    const at = flat.indexOf(needle);
    if (at < 0) return '';
    const tail = flat.slice(at + needle.length);
    if (tail.includes(needle) || !SWITCH_TAIL.has(tail.slice(0, 1))) return '';
    const head = flat.slice(0, at).replace(/ +$/, '');
    return head === '' || head.endsWith(';') || head.endsWith('&&') ? name : '';
  }

  /** ff_upstream_sync: statement <idx> fast-forwards a branch to its own remote-tracking upstream. */
  private async ffUpstreamSync(idx: number, dir: string, sub: string): Promise<boolean> {
    const own = this.dirs[idx] ?? '';
    if (own === '-' || own === '?' || own === '') return false;
    let target = '';
    let ff = false;
    for (const w of words(sub.startsWith('merge') ? sub.slice(5) : sub)) {
      if (w === '--ff-only') ff = true;
      else if (FF_SYNC_QUIET.has(w)) continue;
      else if (w.startsWith('-')) return false;
      else if (target !== '') return false;
      else target = w;
    }
    if (!ff || target === '') return false;
    let branch = await this.ffSyncSwitch(idx - 1, own);
    const skip = branch === '' ? -1 : idx - 1;
    for (let j = 0; j < this.stmts.length; j++) {
      if (j === idx || j === skip || this.stmts[j] === '') continue;
      if (!ffSyncOtherOk(this.stmts[j], this.statementAt(j))) return false;
    }
    branch ||= await this.git(dir, 'branch', '--show-current');
    if (branch === '' || !await this.gitOk(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) return false;
    const remote = await this.git(dir, 'config', '--get', `branch.${branch}.remote`);
    if (remote === '' || remote === '.') return false;
    const up = await this.git(dir, 'rev-parse', '--symbolic-full-name', `${branch}@{u}`);
    if (!/^refs\/remotes\/[\s\S]/.test(up)) return false;
    if (target === '@{u}' || target === '@{upstream}') return true;
    return await this.git(dir, 'rev-parse', '--symbolic-full-name', target) === up;
  }

  private async ghRule(stmt: string, dir: string, unresolved: boolean): Promise<void> {
    const pr = this.prTarget;
    const base = optionValue(stmt, `--base[= ]${NONSPACE}+`, '--base[= ]+');
    if (base !== '' && base === pr) return;
    if (pr === 'dev' && base === 'main') {
      let head = optionValue(stmt, `--head[= ]${NONSPACE}+`, '--head[= ]+');
      if (head === '' && this.needDir(dir, stmt, unresolved)) head = await this.git(dir, 'branch', '--show-current');
      if (head !== 'dev') {
        throw deny(`BLOCKED: only 'dev → main' is permitted as a release merge. Feature branches must PR to ${pr}. Got --head=${head}.`, {
          allowed: `gh pr create --base ${pr} --head <branch>`,
        });
      }
      return;
    }
    throw deny(`BLOCKED: PRs must target ${pr} branch. (Dev → main release merges are allowed when PR_TARGET=dev.)`, {
      allowed: `gh pr create --base ${pr} --head <branch>`,
    });
  }

  private async glabRule(stmt: string, dir: string, unresolved: boolean): Promise<void> {
    const pr = this.prTarget;
    const target =
      optionValue(stmt, `--target-branch[= ]${NONSPACE}+`, '--target-branch[= ]+') ||
      optionValue(stmt, `(^|${SPACE})-b[= ]${NONSPACE}+`, `^${SPACE}*-b[= ]+`);
    let source =
      optionValue(stmt, `--source-branch[= ]${NONSPACE}+`, '--source-branch[= ]+') ||
      optionValue(stmt, `(^|${SPACE})-s[= ]${NONSPACE}+`, `^${SPACE}*-s[= ]+`);
    if (target === pr) return;
    if (pr === 'dev' && target === 'main') {
      if (source === '' && this.needDir(dir, stmt, unresolved)) source = await this.git(dir, 'branch', '--show-current');
      if (source !== 'dev') {
        throw deny(`BLOCKED: only 'dev → main' is permitted as a release merge. Feature branches must MR to ${pr}. Got --source-branch=${source}.`, {
          allowed: `glab mr create --target-branch ${pr} --source-branch <branch>`,
        });
      }
      return;
    }
    throw deny(`BLOCKED: MRs must target ${pr} branch. (Dev → main release merges are allowed when PR_TARGET=dev.)`, {
      allowed: `glab mr create --target-branch ${pr} --source-branch <branch>`,
    });
  }

  private async integrationRule(idx: number, sub: string, stmt: string, dir: string, unresolved: boolean): Promise<void> {
    if (!this.needDir(dir, stmt, unresolved) || await this.dirInWorktree(dir)) return;
    const recovery = await this.rule2Recovery(dir);
    const reason = `BLOCKED: local merge/rebase/cherry-pick in the main checkout is not allowed — integration is PR-only.${recovery.text}`;
    if (sub === 'merge' || sub.startsWith('merge ')) {
      if (await this.ffUpstreamSync(idx, dir, sub)) return;
      throw deny(`${reason} Syncing a branch with its own upstream (git pull --ff-only, or git merge --ff-only @{u}, on that branch) is allowed.`, recovery.fix);
    }
    throw deny(reason, recovery.fix);
  }

  private async commitRule(stmt: string, dir: string, unresolved: boolean): Promise<void> {
    const bases = this.rule2ProtectedBases();
    let branch: string;
    if (this.landings !== '') {
      branch = this.landings.split('\n').find((b) => bases.has(b)) ?? '';
    } else {
      if (!this.needDir(dir, stmt, unresolved)) return;
      branch = await this.dirBranch(dir);
      if (!bases.has(branch)) branch = '';
    }
    if (branch === '') return;
    const recovery = await this.rule2Recovery(dir);
    throw deny(`BLOCKED: ${branch} is a shared workflow base — no direct commits/merges/rebases.${recovery.text}`, recovery.fix);
  }

  private async forcePushRule(sub: string, stmt: string, dir: string, unresolved: boolean): Promise<void> {
    let force = false;
    const pos: string[] = [];
    for (const a of words(sub.startsWith('push') ? sub.slice(4) : sub)) {
      if (a === '--force' || a === '--force-with-lease' || a.startsWith('--force-with-lease=') || a === '-f') force = true;
      else if (!a.startsWith('-')) pos.push(a);
    }
    if (!force) return;
    let target = pos[0] === 'origin' || pos[0] === 'upstream' ? (pos[1] ?? '') : '';
    if (target === '') {
      if (!this.needDir(dir, stmt, unresolved)) return;
      target = await this.git(dir, 'branch', '--show-current');
    }
    if (target !== '' && this.branchIsProtected(target)) throw deny(`BLOCKED: Force push to ${target} is forbidden. This is destructive and irreversible.`, 'policy');
  }

  private async newBranchRule(stmt: string, dir: string, unresolved: boolean): Promise<void> {
    if (!this.needDir(dir, stmt, unresolved)) return;
    const branch = await this.dirBranch(dir);
    let t = this.prTarget;
    if (!await this.gitOk(dir, 'rev-parse', '--verify', '--quiet', t) && !await this.gitOk(dir, 'rev-parse', '--verify', '--quiet', `origin/${t}`)) {
      const fallback = await repoDefaultBranch(this.gitRoot, this.env);
      if (fallback !== '') t = fallback;
    }
    if (branch !== '' && branch !== t) {
      throw deny(`BLOCKED: New branches must be created from ${t}. Currently on '${branch}'.`, {
        allowed: `git checkout ${t} && git pull origin ${t}, then the same branch command`,
      });
    }
    if (branch === '') {
      throw deny('BLOCKED: Detached HEAD detected; reattach before creating your feature branch.', {
        allowed: `git checkout -B ${t} origin/${t}, then the same branch command`,
      });
    }
    if (await this.git(dir, 'remote', 'get-url', 'origin') === '') return;
    await gitRun(dir, ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=5', 'fetch', 'origin', t, '--quiet'], this.env);
    const local = await this.git(dir, 'rev-parse', '--verify', t);
    const remote = await this.git(dir, 'rev-parse', '--verify', `origin/${t}`);
    if (local !== '' && remote !== '' && local !== remote) throw deny(`BLOCKED: Local ${t} is behind origin/${t}.`, { allowed: `git pull origin ${t}, then the same branch command` });
  }

  private async judge(idx: number): Promise<void> {
    this.judging = idx;
    const stmt = this.stmts[idx];
    if (stmt === '') return;
    const statement = this.statementAt(idx);
    const sub = gitSubcommandOf(statement);
    let forge = '';
    if (stmt === 'gh pr create' || stmt.startsWith('gh pr create ')) forge = 'gh';
    else if (stmt === 'glab mr create' || stmt.startsWith('glab mr create ')) forge = 'glab';
    if (sub !== undefined && !GUARDED_SUB.test(sub) && forge === '') return;

    let dir = this.dirs[idx];
    let unresolved = false;
    if (dir === '-') {
      unresolved = true;
      dir = await cwdState(this.cwd, this.env, { unresolved: true });
    }
    if (!await this.loadPolicy(await stmtRepoRoot(dir, this.cwd, this.env))) return;

    if (sub === undefined) {
      // A dir that may name any checkout is the deny to fix first, as for a literal subcommand (GH 2510).
      this.needDir(dir, stmt, unresolved);
      const what = typeof statement === 'string' ? statement : (statement.src ?? statement.stmt);
      throw deny(ambiguousSubcommandReason(what, 'commits, merges, rebases, cherry-picks, pushes or creates a branch'), UNKNOWN_FIX);
    }
    if (forge === 'gh') return await this.ghRule(stmt, dir, unresolved);
    if (forge === 'glab') return await this.glabRule(stmt, dir, unresolved);
    if (INTEGRATION_SUB.test(sub)) return await this.integrationRule(idx, sub, stmt, dir, unresolved);
    if (sub === 'commit' || sub.startsWith('commit ')) return await this.commitRule(stmt, dir, unresolved);
    if (sub === 'push' || sub.startsWith('push ')) return await this.forcePushRule(sub, stmt, dir, unresolved);
    if (sub.startsWith('checkout -b ') || sub.startsWith('switch -c ')) return await this.newBranchRule(stmt, dir, unresolved);
  }

  async run(): Promise<GateResult> {
    try {
      for (let idx = 0; idx < this.lines.length; idx++) await this.judge(idx);
    } catch (e) {
      if (e instanceof Denied) return e.result;
      throw e;
    }
    return ALLOW;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const gitGuards: Gate = async (payload, env) => {
  const command = stripTrailingNewlines(jqAlternatives(payload, [['tool_input', 'command']]).replace(/\0/g, ''));
  if (!needsGitGuard(command)) return ALLOW;
  const cwd = payloadCwd(payload, env);
  const listed = await cmdStatements(command, cwd, env);
  if (!listed.ok) return denyResult(PARSE_REASON, PARSE_FIX);
  const text = stripTrailingNewlines(listed.statements.map(({ dir, stmt }) => `${dir}\t${stmt}`).join('\n'));
  if (text === '') return ALLOW;
  return await new GitGuards(command, cwd, dbPath(env) ?? '', env, text.split('\n'), lineStatements(listed.statements)).run();
};
