import { gitOk, gitOut, cdPwd, isDir } from '../lib/git.js';
import { jqCompact } from '../lib/jq.js';
import { shellPwd } from '../lib/project-env.js';
import { decode, encode } from './encode.js';
import { bashParser } from './parser.js';
import { statementsEnc } from './statements.js';
const MAX_DEPTH = 3;
const SHELL = /^(.*\/)?(bash|sh|zsh|dash|ksh)$/;
const ENCODED = /[\x01-\x06\x0e-\x11\x13\x15\x16]/g;
const HD_MARK = /<<[\x1a\x1e]/g;
/** `read -r -a w <<< "$s"`: the first line's words. */
function readWords(s) {
    return (s.split('\n')[0] ?? '').split(/[ \t]+/).filter((w) => w !== '');
}
/** What `IFS=$'\t' read -r dir stmt` leaves of a statement: no leading or trailing tabs. */
function readStmt(stmt) {
    return stmt.replace(/^\t+|\t+$/g, '');
}
/** _tmb_cmd_inner: the encoded string `bash|sh|zsh|dash|ksh -c <s>` runs, or the rest of `eval <s>`; "" otherwise. */
function inner(stmt) {
    const words = readWords(stmt);
    const argv0 = words[0] ?? '';
    if (SHELL.test(argv0)) {
        for (let i = 1; i < words.length; i++) {
            const w = words[i];
            if (w === '-c' || /^-[a-zA-Z].*c$/s.test(w) || /^-c[a-zA-Z]/.test(w))
                return words[i + 1] ?? '';
            if (!w.startsWith('-'))
                return '';
        }
        return '';
    }
    if (argv0 === 'eval')
        return (stmt.startsWith('eval') ? stmt.slice(4) : stmt).replace(/^ /, '');
    return '';
}
/** _tmb_cmd_statements_enc <cmd> <base> <depth> without assign; null when the command or a body in it does not parse. */
function listing(parser, cmd, base, depth, home) {
    if (cmd.trim() === '')
        return [];
    const encoded = encode(parser, cmd);
    if (!encoded.ok)
        return null;
    const out = [];
    for (const record of statementsEnc(encoded.text, base, home, false)) {
        const stmt = readStmt(record.stmt);
        if (stmt === '')
            continue;
        const body = depth < MAX_DEPTH && !record.dir.startsWith('=') ? inner(stmt) : '';
        if (body === '') {
            out.push({ dir: record.dir, stmt });
            continue;
        }
        const nested = listing(parser, decode(body).replace(/\n+$/, ''), record.dir, depth + 1, home);
        if (nested === null)
            return null;
        out.push(...nested);
    }
    return out;
}
/** tmb_cwd_state <cwd>: `-` for no dir, `?` for a checkout with linked worktrees, else <cwd>. */
export function cwdState(cwd, env = process.env) {
    if (!isDir(cwd))
        return '-';
    if (gitOk(cwd, ['rev-parse', '--git-dir'], env)) {
        const n = gitOut(cwd, ['worktree', 'list', '--porcelain'], env)
            .split('\n')
            .filter((l) => l.startsWith('worktree ')).length;
        if (n > 1)
            return '?';
    }
    return cwd;
}
/**
 * tmb_cmd_statements <cmd> <cwd>: each executable statement with the dir it
 * runs in (`@` made the cwd's state, `@/x` made <cwd>/x), its encoded bytes
 * shown as `_` and encode.ts's heredoc marks dropped.
 */
export async function cmdStatements(command, cwd, env = process.env) {
    const parser = await bashParser();
    const listed = listing(parser, command, '@', 0, env.HOME ?? '');
    if (listed === null)
        return { ok: false };
    let state;
    const statements = listed.map(({ dir, stmt }) => {
        if (dir.startsWith('@/'))
            dir = isDir(cwd) ? `${cwd.replace(/\/$/, '')}${dir.slice(1)}` : '-';
        else if (dir === '@')
            dir = state ??= cwdState(cwd, env);
        return { dir, stmt: stmt.replace(HD_MARK, '<<').replace(ENCODED, '_') };
    });
    return { ok: true, statements };
}
/** tmb_git_subcommand <stmt>: the words from git's subcommand on, "" when <stmt> is no git command. */
export function gitSubcommand(stmt) {
    const w = readWords(stmt);
    if (w[0] !== 'git')
        return '';
    let k = 1;
    while (k < w.length) {
        const word = w[k];
        if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(word))
            k += 2;
        else if (word.startsWith('-'))
            k += 1;
        else
            break;
    }
    return k < w.length ? w.slice(k).join(' ') : '';
}
/** tmb_stmt_repo_root <dir> <cwd>: the main checkout of the repo a statement's dir is in, "" when none. */
export function stmtRepoRoot(dir, cwd, env = process.env) {
    if (dir === '?')
        dir = cwd || shellPwd(env);
    else if (dir === '-' || dir === '')
        return '';
    while (!isDir(dir)) {
        const slash = dir.lastIndexOf('/');
        if (slash < 0)
            return '';
        dir = dir.slice(0, slash) || '/';
    }
    const common = gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
    if (common === '')
        return '';
    if (common.endsWith('/.git'))
        return cdPwd(common.slice(0, -5), shellPwd(env));
    return gitOut(dir, ['rev-parse', '--show-toplevel'], env);
}
/** tmb_deny_ambiguous_git_target <stmt> [unresolved]: the deny JSON line. */
export function denyAmbiguousGitTarget(stmt, unresolved = false) {
    const what = stmt || 'git';
    const reason = unresolved
        ? `BLOCKED: ambiguous_git_target: \`${what}\` runs in a directory that comes through a variable, \`cd -\` or popd the guard cannot resolve, and this repo has linked worktrees, so the guard cannot tell which checkout (and branch) it runs in. Pass the literal path: git -C <path> or cd <path> && …`
        : `BLOCKED: ambiguous_git_target: \`${what}\` names no directory and this repo has linked worktrees, so the guard cannot tell which checkout (and branch) it runs in. Run with git -C <path> or cd <path> && …`;
    return `${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`;
}
//# sourceMappingURL=git.js.map