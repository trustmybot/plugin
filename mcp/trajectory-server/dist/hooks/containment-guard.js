/**
 * PreToolUse gate (GH 1692), the port of scripts/hooks/containment-guard.sh:
 * an agent writes only under its run's root — a swe under its task's
 * worktree, bro and pr-reviewer under the project — plus the model cache,
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
 * not parse) or `$(computed)` (a path built at run time) is always denied,
 * never through the literal-dir allowance.
 */
import { lstatSync, statSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { agentContext, pathCanonical } from './lib/agent-context.js';
import { auditAppend } from './lib/audit.js';
import { dbPath, dbState, denyDbUnavailable, projectRoot, sqlInt, sqliteRo, stripTrailingNewlines, sweContext, } from './lib/db.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { ctypeUtf8, posixDirname, shellPwd } from './lib/project-env.js';
import { normalizeRole } from './lib/role.js';
import { writePaths } from './cmd-analysis/index.js';
const HOOK = 'containment-guard';
const RUN_BUDGET_MS = '2500';
const JUDGED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);
const DEVICE = /^\/dev\/(null|stdout|stderr|tty)$|^\/dev\/fd\//;
const GLOB_CHAR = /[*?[]/;
const NEVER_JUDGED = {
    '$(parse)': 'the command could not be parsed, so its write targets are unknown; split it or fix its quoting.',
    '$(computed)': 'the program builds the path at run time (a computed or argv path, a program held in a variable, a substitution or stdin, or an exec placeholder under `sh -c`), so the guard cannot tell where it writes; write to a literal path.',
};
/** What a `$(...)` capture of a command's output keeps. */
function capture(text) {
    return stripTrailingNewlines(text.replace(/\0/g, ''));
}
function jqField(input, ...paths) {
    return capture(jqAlternatives(input, paths));
}
function canonical(path) {
    return capture(pathCanonical(path));
}
function stripSlash(dir) {
    return dir.endsWith('/') ? dir.slice(0, -1) : dir;
}
function under(path, dir) {
    return path === dir || path.startsWith(`${stripSlash(dir)}/`);
}
/** /tmp/claude-<uid> counts only when absent, or a real dir (not a link) this user owns. */
function harnessTmp(uid) {
    const dir = `/tmp/claude-${uid}`;
    let link;
    try {
        link = lstatSync(dir);
    }
    catch {
        link = undefined;
    }
    let target;
    try {
        target = statSync(dir);
    }
    catch {
        target = undefined;
    }
    const isLink = link?.isSymbolicLink() ?? false;
    if (!target && !isLink)
        return canonical(dir);
    if (target?.isDirectory() && !isLink && target.uid === (process.geteuid?.() ?? uid))
        return canonical(dir);
    return '';
}
/** `sed 's/[^A-Za-z0-9]/-/g'`: per code point under a UTF-8 locale, per byte otherwise. */
function ccSlug(dir, env) {
    const units = ctypeUtf8(env) ? [...dir] : [...Buffer.from(dir, 'utf8')].map((b) => String.fromCharCode(b));
    return capture(units.map((u) => (u === '\n' || /^[A-Za-z0-9]$/.test(u) ? u : '-')).join(''));
}
function ccProjectDir(ccHome, dir, env) {
    const slug = ccSlug(dir, env);
    return /[A-Za-z0-9]/.test(slug) ? canonical(`${ccHome}/projects/${slug}`) : '';
}
class Denied {
    result;
    constructor(result) {
        this.result = result;
    }
}
class Guard {
    env;
    uid = process.getuid?.() ?? 0;
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
    constructor(env) {
        this.env = env;
    }
    home() {
        return this.env.HOME ?? '';
    }
    allowed(path) {
        if (DEVICE.test(path))
            return true;
        if (this.unbound)
            return false;
        const c = canonical(path);
        return (under(c, this.rootC) ||
            under(c, this.cacheC) ||
            (this.hostTmpC !== '' && this.hostTmpC !== '/' && under(c, this.hostTmpC)) ||
            (this.harnessTmpC !== '' && under(c, this.harnessTmpC)) ||
            (this.ccProjectC !== '' && under(c, this.ccProjectC)) ||
            (this.ccSessionC !== '' && under(c, this.ccSessionC)) ||
            (this.ccPlansC !== '' && under(c, this.ccPlansC)));
    }
    deny(path, given = '') {
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
        if (taskId !== '')
            issue = sqlInt(sqliteRo(this.db, `SELECT issue_id FROM tasks WHERE id = ${taskId};`, this.env)) || '-1';
        const written = auditAppend(this.db, {
            issueId: issue,
            branchId: '',
            fromNode: `hook:${HOOK}`,
            eventType: 'containment_denied',
            summary: `${this.toolName} denied: ${path} is outside ${this.root || `any root (unbound swe ${this.agentId})`}`,
            contentJson: content,
        }, { caller: HOOK, env: this.env });
        if (written.error !== '')
            process.stderr.write(`${written.error}\n`);
        if (reason === '') {
            reason = `BLOCKED: containment — ${path} is outside this run's root ${this.root}. TMB agents write only under their root (the task worktree for swe, the project for bro); put scratch files in ${stripSlash(this.root)}/.claude/tmb/scratch/ (or /tmp/claude-${this.uid}).`;
        }
        const decision = jqCompact({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
        });
        throw new Denied({ stdout: `${written.stdout}${decision}\n`, code: 0 });
    }
    /** The absolute path a write-position word names; null behind an unresolvable variable or command. */
    expand(word) {
        const home = this.home();
        let p = word;
        if (p === '~')
            p = home;
        else if (p.startsWith('~/'))
            p = `${home}/${p.slice(2)}`;
        p = p.split('${HOME}').join(home).split('$HOME').join(home);
        p = p.split('${TMB_MODEL_CACHE_DIR}').join(this.cacheDir).split('$TMB_MODEL_CACHE_DIR').join(this.cacheDir);
        if (/[$`]/.test(p) || p.startsWith('~'))
            return null;
        const glob = p.search(GLOB_CHAR);
        if (glob >= 0) {
            p = p.slice(0, glob);
            if (!p.endsWith('/'))
                p = capture(posixDirname(p));
        }
        if (!p.startsWith('/'))
            p = `${this.cwd}/${p}`;
        return stripTrailingNewlines(p);
    }
    unresolved(raw, variable) {
        const cut = raw.search(/[$`]/);
        const lit = cut < 0 ? raw : raw.slice(0, cut);
        const slash = lit.lastIndexOf('/');
        const dir = slash < 0 ? '' : lit.slice(0, slash) || '/';
        if (dir !== '') {
            const expanded = this.expand(dir);
            if (expanded !== null && this.allowed(expanded))
                return;
        }
        this.deny(raw, `BLOCKED: write target "${raw}" ${unresolvedWhy(variable)}.`);
    }
    /** A .. leaves the root and a later name enters it again: the write lands on the root from outside. */
    climbsBack(path) {
        if (!`/${path}/`.includes('/../'))
            return false;
        if (this.root === '')
            return false;
        const line = (path.startsWith('/') ? path.slice(1) : path).split('\n')[0];
        let acc = '';
        let left = false;
        let inside = false;
        for (const part of line.split('/')) {
            if (part === '' || part === '.')
                continue;
            acc = part === '..' ? acc.slice(0, Math.max(0, acc.lastIndexOf('/'))) : `${acc}/${part}`;
            const at = acc || '/';
            if (under(at, stripSlash(this.root)) || under(at, stripSlash(this.rootC))) {
                inside = true;
            }
            else {
                if (inside)
                    left = true;
                inside = false;
            }
        }
        return left && inside;
    }
    judge(path) {
        if (this.climbsBack(path)) {
            this.deny(path, `BLOCKED: containment — write target "${path}" leaves this run's root ${this.root} with .. and comes back into it, so it lands on the root from outside. Name the path from inside the root.`);
        }
        if (!this.allowed(path))
            this.deny(path);
    }
}
function unresolvedWhy(variable) {
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
function globClimbs(word) {
    const glob = word.search(GLOB_CHAR);
    return glob >= 0 && `/${word.slice(glob + 1)}/`.includes('/../');
}
/** `${word#UNRESOLVED:*:}` and the <var> between the two colons. */
function splitUnresolved(word) {
    if (!word.startsWith('UNRESOLVED:'))
        return { variable: null, target: word };
    const rest = word.slice('UNRESOLVED:'.length);
    const colon = rest.indexOf(':');
    if (colon < 0)
        return { variable: rest, target: word };
    return { variable: rest.slice(0, colon), target: rest.slice(colon + 1) };
}
async function judgeBash(g, input, analyze) {
    const command = jqField(input, ['tool_input', 'command']);
    const writes = command === '' ? [] : await analyze(command, { cwd: g.cwd, raw: true, root: g.root, env: g.env });
    const lines = capture(writes.join('\n')).split('\n').filter((w) => w !== '');
    if (lines.length === 0)
        return;
    if (!g.unbound && !g.bound && !g.allowed(g.cwd))
        g.deny(g.cwd);
    const seen = new Set();
    for (const word of lines) {
        if (seen.has(word))
            continue;
        seen.add(word);
        const { variable, target } = splitUnresolved(word);
        if (variable !== null && Object.hasOwn(NEVER_JUDGED, variable)) {
            g.deny(target, `BLOCKED: write target "${target}" cannot be judged: ${NEVER_JUDGED[variable]}`);
        }
        if (globClimbs(target)) {
            g.deny(target, `BLOCKED: containment — write target "${target}" climbs with .. after a glob; the guard cannot tell where that lands. Name the directory without .. after a glob.`);
        }
        const path = g.expand(target);
        if (variable !== null) {
            if (path !== null)
                g.judge(path);
            else
                g.unresolved(target, variable);
            continue;
        }
        if (path !== null)
            g.judge(path);
    }
}
async function guard(input, env, analyze) {
    const g = new Guard(env);
    g.toolName = jqField(input, ['tool_name']);
    if (!JUDGED_TOOLS.has(g.toolName))
        return;
    const state = dbState(env);
    if (state === 'unresolved')
        return;
    if (state === 'error')
        throw new Denied({ stdout: `${denyDbUnavailable(HOOK, env)}\n`, code: 0 });
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
        }
        else if (ctx.code === 2) {
            throw new Denied({ stdout: `${denyDbUnavailable(HOOK, env)}\n`, code: 0 });
        }
        else {
            g.unbound = true;
            g.missing = ctx.missing;
        }
    }
    if (g.root === '' && !g.unbound)
        g.root = project;
    g.rootC = g.root === '' ? '' : canonical(g.root);
    g.cacheDir = env.TMB_MODEL_CACHE_DIR || env.HF_HOME || `${g.home()}/.cache/huggingface`;
    g.cacheC = canonical(g.cacheDir);
    const tmpdir = env.TMPDIR ?? '';
    if (/^\/./s.test(tmpdir))
        g.hostTmpC = canonical(tmpdir);
    g.harnessTmpC = harnessTmp(g.uid);
    if (agentType === '' || agentType === 'bro') {
        const ccHome = env.CLAUDE_CONFIG_DIR || `${g.home()}/.claude`;
        g.ccProjectC = ccProjectDir(ccHome, g.root, env);
        if (env.CLAUDE_PROJECT_DIR)
            g.ccSessionC = ccProjectDir(ccHome, env.CLAUDE_PROJECT_DIR, env);
        g.ccPlansC = canonical(`${ccHome}/plans`);
    }
    if (g.toolName !== 'Bash') {
        let target = jqField(input, ['tool_input', 'file_path'], ['tool_input', 'notebook_path']);
        if (target === '')
            return;
        if (!target.startsWith('/'))
            target = `${g.cwd}/${target}`;
        if (!g.allowed(target))
            g.deny(target);
        return;
    }
    await judgeBash(g, input, analyze);
}
export function containmentGuardWith(analyze) {
    return async (payload, env) => {
        try {
            await guard(payload, { ...env, TMB_DB_WRITE_RUN_BUDGET_MS: RUN_BUDGET_MS }, analyze);
            return ALLOW;
        }
        catch (e) {
            if (e instanceof Denied)
                return e.result;
            throw e;
        }
    };
}
export const containmentGuard = containmentGuardWith(writePaths);
//# sourceMappingURL=containment-guard.js.map