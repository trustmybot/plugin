/**
 * PreToolUse gate (GH 1692), the port of scripts/hooks/git-guards.sh: the git
 * workflow rules of the repo's branching model, judged per executable
 * statement against the repo and branch of that statement's dir.
 *   1. A PR (gh pr create) or MR (glab mr create) targets pr_target; dev → main
 *      is the one release merge when pr_target is dev.
 *   2. No merge / rebase / cherry-pick in a main checkout (a fast-forward of a
 *      branch to its own upstream aside), and no commit on a shared workflow base.
 *   3. No force push to a protected branch.
 *   4. A new branch starts from the latest pr_target.
 * Only a registered repo is guarded when the DB reads; a registered repo with
 * no policy gets github-flow with its default branch as target and sole
 * protected branch.
 *
 * Deny messages and decisions are the .sh's, with four stricter exceptions:
 * a command naming git, gh or glab that tree-sitter-bash cannot parse is
 * denied with PARSE_REASON (the .sh judges the statements its awk skeleton
 * reads), the early exit reads ASCII letters and digits in every locale, the
 * DB is read wherever node:sqlite works, with no sqlite3 CLI on PATH, and the
 * switch-then-fast-forward sync needs an ASCII-only command (the .sh's awk
 * fails on a quoted non-ASCII character in a UTF-8 locale and so denies it).
 */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { cmdStatements, cwdState, denyAmbiguousGitTarget, gitSubcommand, payloadCwd, stmtRepoRoot, stripLiterals } from './cmd-analysis/index.js';
import { dbPath, haveSqlite, sqliteRo, sqlQuote, stripTrailingNewlines, taskBySlug } from './lib/db.js';
import { gitOk, gitOut, gitRun, isDir } from './lib/git.js';
import { jqAlternatives, jqCompact, jqRawElements, jsonStream } from './lib/jq.js';
import { posixBasename } from './lib/project-env.js';
import { repoDefaultBranch, repoIsRegistered, repoNameForRoot, repoResolve } from './lib/repo.js';
export const GATE_NAME = 'git-guards';
const NEEDS_GUARD = /(^|[^A-Za-z0-9_./-])(git|gh|glab)([ \t\n\v\f\r]|$)/;
const SPACE = '[ \\t\\n\\v\\f\\r]';
const NONSPACE = '[^ \\t\\n\\v\\f\\r]';
const GUARDED_SUB = /^(commit|merge|rebase|cherry-pick|push)( |$)|^(checkout -b|switch -c) /;
const INTEGRATION_SUB = /^(merge|rebase|cherry-pick)( |$)/;
const FF_SYNC_QUIET = new Set(['-q', '--quiet', '-v', '--verbose', '--stat', '--no-stat', '-n', '--progress', '--no-progress']);
const FF_SYNC_COMPANIONS = new Set(['cd', 'echo', 'printf', 'true', 'false', 'test', '[', 'pwd']);
const FF_SYNC_GIT_READS = new Set(['fetch', 'status', 'log', 'diff', 'show', 'rev-parse']);
const NON_ASCII = /[^\x00-\x7f]/;
const SWITCH_TAIL = new Set(['', ' ', ';', '|', '&', ')']);
export const PARSE_REASON = 'BLOCKED: the git guard could not parse this command, so it cannot tell which statements run git, gh or glab, or in which checkout. Split it into simpler commands or fix its quoting, then retry.';
const MALFORMED_REASON = "BLOCKED: this repo's protected_branches is malformed JSON. Fix the repos row or re-run bro onboarding.";
/**
 * _cmd_needs_git_guard: a git, gh or glab word anywhere, the early exit before
 * any parse or DB read. Its letters and digits are ASCII in every locale, so a
 * word right after a non-ASCII letter is analysed, as the .sh does under LC_ALL=C.
 */
export function needsGitGuard(command) {
    return NEEDS_GUARD.test(command);
}
class Denied {
    result;
    constructor(result) {
        this.result = result;
    }
}
function deny(reason) {
    const decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    return new Denied({ stdout: `${jqCompact(decision)}\n`, code: 0 });
}
/** `IFS=$'\t' read -r dir stmt` of one line. */
function readRow(line) {
    const s = line.replace(/^\t+/, '');
    const tab = s.indexOf('\t');
    if (tab < 0)
        return { dir: s, stmt: '' };
    return { dir: s.slice(0, tab), stmt: s.slice(tab).replace(/^\t+|\t+$/g, '') };
}
/** `read -r -a w <<< "$s"`: the first line's words. */
function words(s) {
    return (s.split('\n')[0] ?? '').split(/[ \t]+/).filter((w) => w !== '');
}
/** `printf '%s' "$s" | grep -oE -- <find> | head -1 | sed -E 's/<strip>//'`. */
function optionValue(s, find, strip) {
    const m = new RegExp(find).exec(s);
    return m ? m[0].replace(new RegExp(strip), '') : '';
}
/** `$(printf '%s' <text> | cut -d'|' -f<n>)`. */
function cutField(text, n) {
    const fields = text.split('\n').map((line) => (line.includes('|') ? (line.split('|')[n - 1] ?? '') : line));
    return stripTrailingNewlines(fields.join('\n'));
}
/** `(cd <dir> && pwd -P)`, "" when the cd fails. */
function physicalDir(dir) {
    try {
        if (!statSync(dir).isDirectory())
            return '';
        accessSync(dir, constants.X_OK);
        return realpathSync.native(dir);
    }
    catch {
        return '';
    }
}
/**
 * _rule2_inline_landings: every commit's landing branch when the statements
 * switch to a named branch before each commit, "" when any commit lands on an
 * unknown branch, no statement commits, or a `git -C` statement touches a
 * branch or commit.
 */
function inlineLandings(text) {
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
        if (leadC.test(s) && /(commit|checkout|switch)/.test(s))
            return '';
        if (commit.test(s)) {
            saw = true;
            if (!known)
                return '';
            landings += `${current}\n`;
        }
        else if (create.some((re) => re.test(s))) {
            const tok = s.split(split);
            const j = tok.findIndex((t) => t === '-b' || t === '-c');
            const name = j >= 0 && j < tok.length - 1 ? tok[j + 1] : '';
            if (name === '')
                return '';
            current = name;
            known = true;
        }
        else if (change.test(s)) {
            const name = s.split(split)[2] ?? '';
            if (name === '' || name.startsWith('-'))
                return '';
            current = name;
            known = true;
        }
    }
    return saw ? stripTrailingNewlines(landings) : '';
}
/** ff_sync_other_ok: a statement a fast-forward sync may share its command with. */
function ffSyncOtherOk(stmt) {
    if (stmt.includes('>') || stmt.includes('<'))
        return false;
    const w0 = words(stmt)[0] ?? '';
    if (FF_SYNC_COMPANIONS.has(w0))
        return true;
    if (w0 !== 'git')
        return false;
    if (stmt.includes(':'))
        return false;
    return FF_SYNC_GIT_READS.has(gitSubcommand(stmt).split(' ')[0]);
}
class GitGuards {
    command;
    cwd;
    db;
    env;
    lines;
    dirs;
    stmts;
    landings;
    dbReadable;
    gitRoot = '';
    prTarget = '';
    protectedBranches = '';
    constructor(command, cwd, db, env, lines) {
        this.command = command;
        this.cwd = cwd;
        this.db = db;
        this.env = env;
        this.lines = lines;
        const rows = lines.map(readRow);
        this.dirs = rows.map((r) => r.dir);
        this.stmts = rows.map((r) => r.stmt);
        this.landings = inlineLandings(stripTrailingNewlines(lines.map((l) => (l.includes('\t') ? l.slice(l.indexOf('\t') + 1) : l)).join('\n')));
        this.dbReadable = db !== '' && isFile(db) && haveSqlite(env);
    }
    async git(dir, ...args) {
        return await gitOut(dir, args, this.env);
    }
    async gitOk(dir, ...args) {
        return await gitOk(dir, args, this.env);
    }
    /** load_policy: the repos row of <root>, or false for no root or an unregistered repo. */
    async loadPolicy(root) {
        if (root === '')
            return false;
        this.gitRoot = root;
        this.prTarget = '';
        let raw = '';
        if (this.dbReadable) {
            if (!repoIsRegistered(this.db, root, this.env))
                return false;
            const row = repoResolve(this.db, root, this.env);
            this.prTarget = cutField(row, 1);
            raw = cutField(row, 3);
        }
        const defaultBranch = await repoDefaultBranch(root, this.env);
        this.prTarget ||= defaultBranch;
        raw ||= jqCompact([defaultBranch]);
        const parsed = jsonStream(raw);
        if (!parsed.complete || !Array.isArray(parsed.values[parsed.values.length - 1]))
            throw deny(MALFORMED_REASON);
        this.protectedBranches = stripTrailingNewlines(jqRawElements(raw));
        return true;
    }
    branchIsProtected(branch) {
        return this.protectedBranches.split('\n').includes(branch);
    }
    /** dir_branch: the branch checked out in <dir>, else the newest task whose branch_id ends in /<basename of dir>. */
    async dirBranch(dir) {
        const branch = await this.git(dir, 'branch', '--show-current');
        if (branch !== '' || !this.dbReadable)
            return branch;
        return taskBySlug(this.db, posixBasename(dir), 'branch_id', '', this.env, (line) => process.stderr.write(`${line}\n`)).replace(/\n/g, '');
    }
    async dirInWorktree(dir) {
        const top = await this.git(dir, 'rev-parse', '--show-toplevel');
        return top !== '' && physicalDir(top) !== physicalDir(this.gitRoot);
    }
    /** need_dir: deny an ambiguous dir; false for an unknown or missing one. */
    needDir(dir, stmt, unresolved) {
        if (dir === '?')
            throw new Denied({ stdout: denyAmbiguousGitTarget(stmt, unresolved), code: 0 });
        if (dir === '-' || dir === '')
            return false;
        return isDir(dir);
    }
    /** rule2_protected_bases: protected_branches ∪ target ∪ repos.pr_target ∪ every task's parent_branch_id. */
    rule2ProtectedBases() {
        const out = [...this.protectedBranches.split('\n'), this.prTarget];
        if (this.dbReadable) {
            const name = repoNameForRoot(this.db, this.gitRoot, this.env);
            if (name !== '' && sqliteRo(this.db, "SELECT 1 FROM pragma_table_info('repos') WHERE name='pr_target' LIMIT 1;", this.env) !== '') {
                out.push(...sqliteRo(this.db, `SELECT pr_target FROM repos WHERE name = '${sqlQuote(name)}' AND pr_target IS NOT NULL AND pr_target != '';`, this.env).split('\n'));
            }
            const filter = name === '' ? 'repo IS NULL' : `(repo = '${sqlQuote(name)}' OR repo IS NULL)`;
            out.push(...sqliteRo(this.db, `SELECT DISTINCT parent_branch_id FROM tasks WHERE parent_branch_id IS NOT NULL AND parent_branch_id != '' AND ${filter};`, this.env).split('\n'));
        }
        return new Set(out.filter((b) => !/^[ \t\n\v\f\r]*$/.test(b)));
    }
    async rule2Recovery(dir) {
        if (dir === '-' || dir === '?' || dir === '' || !isDir(dir))
            return '';
        if (await this.git(dir, 'remote', '-v') !== '') {
            return ` Push your feature branch and open a PR into ${this.prTarget}: git push origin <branch> && gh pr create --base ${this.prTarget} --head <branch>.`;
        }
        return ' This repo has no remote — leave the branch unmerged and surface it to the Human for integration.';
    }
    /** ff_sync_switch: the local branch statement <i> switches to right before `&&` and the merge, "" otherwise. */
    async ffSyncSwitch(i, dir) {
        if (i < 0 || (this.dirs[i] ?? '') !== dir)
            return '';
        const stmt = this.stmts[i];
        const w = words(stmt);
        if (w[0] !== 'git')
            return '';
        let k = w[1] === '-C' ? 3 : 1;
        if (w[k] !== 'switch' && w[k] !== 'checkout')
            return '';
        k += 1;
        if (w[k] === '-q' || w[k] === '--quiet')
            k += 1;
        const name = w[k] ?? '';
        if (name === '' || name.startsWith('-') || k + 1 !== w.length)
            return '';
        if (!await this.gitOk(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`))
            return '';
        if (NON_ASCII.test(this.command))
            return '';
        const flat = stripLiterals(this.command).replace(/\n/g, ';').replace(/[ \t]+/g, ' ');
        const needle = `${stmt} && ${this.stmts[i + 1] ?? ''}`;
        const at = flat.indexOf(needle);
        if (at < 0)
            return '';
        const tail = flat.slice(at + needle.length);
        if (tail.includes(needle) || !SWITCH_TAIL.has(tail.slice(0, 1)))
            return '';
        const head = flat.slice(0, at).replace(/ +$/, '');
        return head === '' || head.endsWith(';') || head.endsWith('&&') ? name : '';
    }
    /** ff_upstream_sync: statement <idx> fast-forwards a branch to its own remote-tracking upstream. */
    async ffUpstreamSync(idx, dir, sub) {
        const own = this.dirs[idx] ?? '';
        if (own === '-' || own === '?' || own === '')
            return false;
        let target = '';
        let ff = false;
        for (const w of words(sub.startsWith('merge') ? sub.slice(5) : sub)) {
            if (w === '--ff-only')
                ff = true;
            else if (FF_SYNC_QUIET.has(w))
                continue;
            else if (w.startsWith('-'))
                return false;
            else if (target !== '')
                return false;
            else
                target = w;
        }
        if (!ff || target === '')
            return false;
        let branch = await this.ffSyncSwitch(idx - 1, own);
        const skip = branch === '' ? -1 : idx - 1;
        for (let j = 0; j < this.stmts.length; j++) {
            if (j === idx || j === skip || this.stmts[j] === '')
                continue;
            if (!ffSyncOtherOk(this.stmts[j]))
                return false;
        }
        branch ||= await this.git(dir, 'branch', '--show-current');
        if (branch === '' || !await this.gitOk(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`))
            return false;
        const remote = await this.git(dir, 'config', '--get', `branch.${branch}.remote`);
        if (remote === '' || remote === '.')
            return false;
        const up = await this.git(dir, 'rev-parse', '--symbolic-full-name', `${branch}@{u}`);
        if (!/^refs\/remotes\/[\s\S]/.test(up))
            return false;
        if (target === '@{u}' || target === '@{upstream}')
            return true;
        return await this.git(dir, 'rev-parse', '--symbolic-full-name', target) === up;
    }
    async ghRule(stmt, dir, unresolved) {
        const pr = this.prTarget;
        const base = optionValue(stmt, `--base[= ]${NONSPACE}+`, '--base[= ]+');
        if (base !== '' && base === pr)
            return;
        if (pr === 'dev' && base === 'main') {
            let head = optionValue(stmt, `--head[= ]${NONSPACE}+`, '--head[= ]+');
            if (head === '' && this.needDir(dir, stmt, unresolved))
                head = await this.git(dir, 'branch', '--show-current');
            if (head !== 'dev') {
                throw deny(`BLOCKED: only 'dev → main' is permitted as a release merge. Feature branches must PR to ${pr}: gh pr create --base ${pr} --head <branch>. Got --head=${head}.`);
            }
            return;
        }
        throw deny(`BLOCKED: PRs must target ${pr} branch. Use: gh pr create --base ${pr} --head <branch>. (Dev → main release merges are allowed when PR_TARGET=dev.)`);
    }
    async glabRule(stmt, dir, unresolved) {
        const pr = this.prTarget;
        const target = optionValue(stmt, `--target-branch[= ]${NONSPACE}+`, '--target-branch[= ]+') ||
            optionValue(stmt, `(^|${SPACE})-b[= ]${NONSPACE}+`, `^${SPACE}*-b[= ]+`);
        let source = optionValue(stmt, `--source-branch[= ]${NONSPACE}+`, '--source-branch[= ]+') ||
            optionValue(stmt, `(^|${SPACE})-s[= ]${NONSPACE}+`, `^${SPACE}*-s[= ]+`);
        if (target === pr)
            return;
        if (pr === 'dev' && target === 'main') {
            if (source === '' && this.needDir(dir, stmt, unresolved))
                source = await this.git(dir, 'branch', '--show-current');
            if (source !== 'dev') {
                throw deny(`BLOCKED: only 'dev → main' is permitted as a release merge. Feature branches must MR to ${pr}: glab mr create --target-branch ${pr} --source-branch <branch>. Got --source-branch=${source}.`);
            }
            return;
        }
        throw deny(`BLOCKED: MRs must target ${pr} branch. Use: glab mr create --target-branch ${pr} --source-branch <branch>. (Dev → main release merges are allowed when PR_TARGET=dev.)`);
    }
    async integrationRule(idx, sub, stmt, dir, unresolved) {
        if (!this.needDir(dir, stmt, unresolved) || await this.dirInWorktree(dir))
            return;
        const reason = `BLOCKED: local merge/rebase/cherry-pick in the main checkout is not allowed — integration is PR-only.${await this.rule2Recovery(dir)}`;
        if (sub === 'merge' || sub.startsWith('merge ')) {
            if (await this.ffUpstreamSync(idx, dir, sub))
                return;
            throw deny(`${reason} To sync a branch with its own upstream, run git pull --ff-only (or git merge --ff-only @{u}) on that branch.`);
        }
        throw deny(reason);
    }
    async commitRule(stmt, dir, unresolved) {
        const bases = this.rule2ProtectedBases();
        let branch;
        if (this.landings !== '') {
            branch = this.landings.split('\n').find((b) => bases.has(b)) ?? '';
        }
        else {
            if (!this.needDir(dir, stmt, unresolved))
                return;
            branch = await this.dirBranch(dir);
            if (!bases.has(branch))
                branch = '';
        }
        if (branch !== '')
            throw deny(`BLOCKED: ${branch} is a shared workflow base — no direct commits/merges/rebases.${await this.rule2Recovery(dir)}`);
    }
    async forcePushRule(sub, stmt, dir, unresolved) {
        let force = false;
        const pos = [];
        for (const a of words(sub.startsWith('push') ? sub.slice(4) : sub)) {
            if (a === '--force' || a === '--force-with-lease' || a.startsWith('--force-with-lease=') || a === '-f')
                force = true;
            else if (!a.startsWith('-'))
                pos.push(a);
        }
        if (!force)
            return;
        let target = pos[0] === 'origin' || pos[0] === 'upstream' ? (pos[1] ?? '') : '';
        if (target === '') {
            if (!this.needDir(dir, stmt, unresolved))
                return;
            target = await this.git(dir, 'branch', '--show-current');
        }
        if (target !== '' && this.branchIsProtected(target))
            throw deny(`BLOCKED: Force push to ${target} is forbidden. This is destructive and irreversible.`);
    }
    async newBranchRule(stmt, dir, unresolved) {
        if (!this.needDir(dir, stmt, unresolved))
            return;
        const branch = await this.dirBranch(dir);
        let t = this.prTarget;
        if (!await this.gitOk(dir, 'rev-parse', '--verify', '--quiet', t) && !await this.gitOk(dir, 'rev-parse', '--verify', '--quiet', `origin/${t}`)) {
            const fallback = await repoDefaultBranch(this.gitRoot, this.env);
            if (fallback !== '')
                t = fallback;
        }
        if (branch !== '' && branch !== t) {
            throw deny(`BLOCKED: New branches must be created from ${t}. Currently on '${branch}'. Run: git checkout ${t} && git pull origin ${t} first.`);
        }
        if (branch === '')
            throw deny(`BLOCKED: Detached HEAD detected. Run: git checkout -B ${t} origin/${t} to reattach, then create your feature branch.`);
        if (await this.git(dir, 'remote', 'get-url', 'origin') === '')
            return;
        await gitRun(dir, ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=5', 'fetch', 'origin', t, '--quiet'], this.env);
        const local = await this.git(dir, 'rev-parse', '--verify', t);
        const remote = await this.git(dir, 'rev-parse', '--verify', `origin/${t}`);
        if (local !== '' && remote !== '' && local !== remote)
            throw deny(`BLOCKED: Local ${t} is behind origin/${t}. Run: git pull origin ${t} first.`);
    }
    async judge(idx) {
        const stmt = this.stmts[idx];
        if (stmt === '')
            return;
        const sub = gitSubcommand(stmt);
        let forge = '';
        if (stmt === 'gh pr create' || stmt.startsWith('gh pr create '))
            forge = 'gh';
        else if (stmt === 'glab mr create' || stmt.startsWith('glab mr create '))
            forge = 'glab';
        if (!GUARDED_SUB.test(sub) && forge === '')
            return;
        let dir = this.dirs[idx];
        let unresolved = false;
        if (dir === '-') {
            unresolved = true;
            dir = await cwdState(this.cwd, this.env);
        }
        if (!await this.loadPolicy(await stmtRepoRoot(dir, this.cwd, this.env)))
            return;
        if (forge === 'gh')
            return await this.ghRule(stmt, dir, unresolved);
        if (forge === 'glab')
            return await this.glabRule(stmt, dir, unresolved);
        if (INTEGRATION_SUB.test(sub))
            return await this.integrationRule(idx, sub, stmt, dir, unresolved);
        if (sub === 'commit' || sub.startsWith('commit '))
            return await this.commitRule(stmt, dir, unresolved);
        if (sub === 'push' || sub.startsWith('push '))
            return await this.forcePushRule(sub, stmt, dir, unresolved);
        if (sub.startsWith('checkout -b ') || sub.startsWith('switch -c '))
            return await this.newBranchRule(stmt, dir, unresolved);
    }
    async run() {
        try {
            for (let idx = 0; idx < this.lines.length; idx++)
                await this.judge(idx);
        }
        catch (e) {
            if (e instanceof Denied)
                return e.result;
            throw e;
        }
        return ALLOW;
    }
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
export const gitGuards = async (payload, env) => {
    const command = stripTrailingNewlines(jqAlternatives(payload, [['tool_input', 'command']]).replace(/\0/g, ''));
    if (!needsGitGuard(command))
        return ALLOW;
    const cwd = payloadCwd(payload, env);
    const listed = await cmdStatements(command, cwd, env);
    if (!listed.ok)
        return deny(PARSE_REASON).result;
    const text = stripTrailingNewlines(listed.statements.map(({ dir, stmt }) => `${dir}\t${stmt}`).join('\n'));
    if (text === '')
        return ALLOW;
    return await new GitGuards(command, cwd, dbPath(env) ?? '', env, text.split('\n')).run();
};
//# sourceMappingURL=git-guards.js.map