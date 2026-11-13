import { braceExpand } from './brace.js';
import { DOLLAR, QM, decode, decodeKeepDollar, encode, heldKey, plainDollars } from './encode.js';
import { EXPANDED_COMMAND, MOVE_SUBCOMMANDS, REPEATED_STASH, UNREAD_BODY, gitMoveLine, gitStatementRead, parseGitMoveLine, } from './git-moves.js';
import { listerBind } from './lister.js';
import { MKTEMP_MARK, mktempCall } from './mktemp.js';
import { gitWorkTreeTop, pathCanonical } from './path.js';
import { COMPUTED, PARSE, UNPROVEN, heldProgram, interpWrites, progWrites, shown } from './programs.js';
import { ALT, LOOP_CLOSE, LOOP_OPEN, SEP, UNBALANCED, WSEP, isGitCommand, operandWords, statementsEnc } from './statements.js';
import { stmtWritePaths, unwrapStatement } from './targets.js';
import { under } from './unwrap.js';
const BAD = '\x01';
const MAX_DEPTH = 3;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROG_DIR = '/.tmb-prog-dir';
const XARGS_VALUE = /^(-d|-E|-L|-n|-P|-s|-R|-S|--delimiter|--max-lines|--max-args|--max-procs|--max-chars)$/;
const WATCH_VALUE = /^(-[A-Za-z]*[nq]|--interval|--equexit)$/;
const BODY_UNRESOLVED = /^UNRESOLVED:(?!\$\(|PWD:)/;
const GIT_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];
const GIT_LOCATION_SET = /\bGIT_(DIR|WORK_TREE|COMMON_DIR)\b/;
const NAMES_GIT = /\bgit\b/;
const MOVE_WORD = new RegExp(`(^|[^\\w-])(${MOVE_SUBCOMMANDS.join('|')})([^\\w-]|$)`);
/** The interpreters whose one-line programs interpWrites reads. */
const INTERPRETER = /^(python|python3|python[23]\..*|node|nodejs|perl|ruby)$/s;
/** A program line that leaves part of what the program runs unread: computed, unparsed, unproven, or a process it starts. */
const leavesRunUnread = (p) => [COMPUTED, PARSE, UNPROVEN, '$(proc)'].some((why) => p.startsWith(why));
/** Encoded text bash fills in: a parameter or substitution, a substitution frame, or a mktemp path. */
const SHELL_FILLED = new RegExp(`[$\`\\x07\\x08${MKTEMP_MARK}]`);
/**
 * Text that may run something after the command's last statement starts: a
 * background `&`, a pipe `|` or `|&` (every stage runs at once), a process
 * substitution, `trap`, `coproc`, `setsid` or a launcher that starts a job
 * detached or on a schedule (GH 1789).
 */
const RUNS_LATER = /(^|[^&>|<])&(?![&>])|(^|[^|>])\|(?!\|)|[<>]\(|\b(trap|coproc|setsid|at|batch|tmux|screen|systemd-run|daemonize|start-stop-daemon)\b/;
const MKTEMP_TEMPLATE = /^[A-Za-z0-9._-]*XXX+$/;
const MKTEMP_PATH = /^\/[^\s*?[\]{}~$`\\\x00-\x1f\x7f]*$/;
/** The options that make an interpreter print information and exit, judged only among its own options. */
const INFO = {
    py: /^(-V|-VV|--version|-h|--help|-\?)$/,
    node: /^(-v|--version|-h|--help|--v8-options|-c|--check)$/,
    perl: /^(-v|-V|-h)$/,
    ruby: /^(-v|--version|-h|--help|-c|-y)$/,
    sh: /^(--version|--help|-n)$/,
};
/** Characters read, scanned, printed or held in tracked variables, and syntax nodes walked, one unit each. */
export const ANALYSIS_WORK_CAP = 1_000_000;
const CAP_TEXT = `analysis cap reached (${ANALYSIS_WORK_CAP} work units): split this command into smaller ones`;
const CAP_LINE = `UNRESOLVED:${COMPUTED}${CAP_TEXT}`;
/** The deny of a gate that acts on the cap itself, in the shape router/records.ts reads as no path judged. */
export const CAP_REASON = `BLOCKED: write target "${CAP_TEXT}" cannot be judged: the analyzer stopped before it finished reading this command, so the guard cannot tell what it writes.`;
export const CAP_FIX = { allowed: 'the same work as several smaller commands' };
export const isCapLine = (line) => line === CAP_LINE;
class WorkCapReached extends Error {
}
const basename = (w) => w.replace(/.*\//, '');
const chomp = (s) => s.replace(/\n+$/, '');
const dec = (s) => chomp(decode(s));
/** A path or value to expand: decoded, each literal `$` kept as DOLLAR until `print` (GH 2443). */
const decPath = (s) => chomp(decodeKeepDollar(s));
const before = (s, sep) => {
    const k = s.indexOf(sep);
    return k < 0 ? s : s.slice(0, k);
};
const after = (s, sep) => {
    const k = s.indexOf(sep);
    return k < 0 ? s : s.slice(k + sep.length);
};
const shellWords = (s) => s.split(/[ \t\n]+/).filter((w) => w !== '');
export function dirPath(tok, cwd) {
    if (tok.startsWith('/'))
        return tok;
    if (tok === '@')
        return cwd;
    if (tok.startsWith('@/'))
        return cwd === '' ? '' : `${cwd.replace(/\/$/, '')}/${tok.slice(2)}`;
    return '';
}
function normalize(p) {
    const lead = p.startsWith('/') ? '/' : '';
    const out = [];
    for (const part of p === '' ? [] : p.split('/')) {
        if (part === '' || part === '.')
            continue;
        if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') {
            out.pop();
            continue;
        }
        if (part === '..' && lead === '/')
            continue;
        out.push(part);
    }
    const joined = out.join('/');
    return lead + (joined === '' && lead === '' ? '.' : joined);
}
/** One fail-closed line for a shape whose write target the analyzer cannot name. */
function computedLine(text) {
    return `UNRESOLVED:${COMPUTED}${shown(text)}\n`;
}
/** One fail-closed line for a program or command whose text the analyzer cannot prove. */
function unprovenLine(text) {
    return `UNRESOLVED:${UNPROVEN}${shown(text)}\n`;
}
/** The line for a command tree-sitter-bash cannot parse: its first 80 characters, on one line. */
function parseLine(cmd) {
    return `UNRESOLVED:${PARSE}${[...cmd].slice(0, 80).join('').replace(/[\r\n]/g, ' ')}\n`;
}
/** _tmb_cmd_inner: the -c string of a shell or the rest of an eval; for watch (TS only), the command it runs through sh -c. */
function inner(stmt) {
    const words = shellWords(stmt);
    const argv0 = words[0] ?? '';
    if (basename(argv0) === 'watch') {
        let i = 1;
        while (i < words.length && words[i].startsWith('-')) {
            const w = words[i++];
            if (w === '--')
                break;
            if (WATCH_VALUE.test(w))
                i++;
        }
        return words.slice(i).join(' ');
    }
    if (/^(.*\/)?(bash|sh|zsh|dash|ksh)$/.test(argv0)) {
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
        return stmt.slice(4).replace(/^ /, '');
    const builtin = /^(builtin|command)[ \t]+eval(?:[ \t]+|$)/.exec(stmt);
    return builtin ? stmt.slice(builtin[0].length) : '';
}
/** `eval`, `builtin eval` or `command eval`: the words after `eval`, or undefined. */
function evalArgs(words) {
    if (words[0] === 'eval')
        return words.slice(1);
    if ((words[0] === 'builtin' || words[0] === 'command') && words[1] === 'eval')
        return words.slice(2);
    return undefined;
}
const SET_IN_TEXT = /(?<![A-Za-z0-9_$-])([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?[ \t]*(?:[-+*/%&^|]|<<|>>)?=(?!=)/g;
const STEPPED = /(?:\+\+|--)[ \t]*([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:\+\+|--)/g;
/** The names a text may set where the tracking cannot follow: `name=` / `name op=` / `name[…]=` anywhere, `++` / `--` beside a name in arithmetic. */
function setInText(text) {
    const names = [...text.matchAll(SET_IN_TEXT)].map((m) => m[1]);
    if (/\(\(|\$\[|\[|^let\b/.test(text))
        for (const m of text.matchAll(STEPPED))
            names.push(m[1] ?? m[2]);
    return names;
}
const EQ_DEFAULT = /\$\{([A-Za-z_][A-Za-z0-9_]*)=/g;
/** How many times `text` expands `$name` or `${name…}`. */
function refCount(text, name) {
    return text.match(new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`, 'g'))?.length ?? 0;
}
/**
 * _tmb_cmd_stdin_interp: the interpreter kind that reads its program from
 * stdin, '' for none, walking the interpreter's own options up to the first
 * `-`, `--`, `sh -s` or operand. The TS also rules out `node --test` /
 * `--run` / `--watch` and `python -m<module>` with the module attached.
 */
function stdinProgram(words) {
    const argv0 = basename(words[0]);
    let kind;
    if (/^(python|python3|python[23]\..*)$/s.test(argv0))
        kind = 'py';
    else if (argv0 === 'node' || argv0 === 'nodejs')
        kind = 'node';
    else if (argv0 === 'perl')
        kind = 'perl';
    else if (argv0 === 'ruby')
        kind = 'ruby';
    else if (/^(sh|bash|zsh|dash|ksh)$/.test(argv0))
        kind = 'sh';
    else
        return { kind: '', info: false };
    const none = { kind: '', info: false };
    let info = false;
    let skip = false;
    for (let k = 1; k < words.length; k++) {
        const w = words[k];
        if (skip) {
            skip = false;
            continue;
        }
        if (w === '<<<') {
            skip = true;
            continue;
        }
        if (w.startsWith('<<'))
            continue;
        if (/^(<|>|>>|>\||&>|&>>|[0-9]<|[0-9]>|[0-9]>>)$/.test(w)) {
            skip = true;
            continue;
        }
        if (/^(<|>|&>|[0-9]<|[0-9]>)/.test(w))
            continue;
        if (w === '-' || w === '--')
            return { kind, info };
        if (INFO[kind].test(w))
            info = true;
        const kw = `${kind}:${w}`;
        if (w.startsWith('--')) {
            if (/^node:--(eval|print)(=.*)?$/s.test(kw))
                return none;
            if (/^node:--(test|run|watch|watch-path)(=.*)?$/s.test(kw))
                return none;
            if (/^node:--(require|import|loader|input-type)$/.test(kw))
                skip = true;
            continue;
        }
        if (w.startsWith('-')) {
            if (/^(py:-.*c|py:-.*m$|node:-[ep]$|perl:-.*[eE]|ruby:-.*e|sh:-.*c)/s.test(kw))
                return none;
            if (/^py:-[bBdEhiIOPqRsSuvVx]*m/.test(kw))
                return none;
            if (/^sh:-.*s/s.test(kw))
                return { kind, info };
            if (/^(py:-[WX]|node:-r|ruby:-[rI]|perl:-[IM]|sh:-[oO])$/.test(kw))
                skip = true;
            continue;
        }
        return none;
    }
    return { kind, info };
}
const stdinInterp = (words) => stdinProgram(words).kind;
class WritePaths {
    parser;
    opts;
    charge;
    out = '';
    pwd = '';
    rootc;
    /** The run's environment or any text it runs may set GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR, so a pathspec's repository top cannot be told. */
    gitLocationSet;
    claudeDir;
    /** Git-moves mode: the runners around the statement being read that may start it more than once (watch, find / fd / xargs, a loop). */
    repeats = 0;
    /** Git-moves mode: the statement being read starts in a dir that cannot be told (find -execdir / -okdir). */
    startsElsewhere = 0;
    /** The text of the first command this instance runs: the whole command it reads. */
    command = '';
    constructor(parser, opts, charge) {
        this.parser = parser;
        this.opts = opts;
        this.charge = charge;
        this.gitLocationSet = GIT_LOCATION_VARS.some((name) => opts.env[name] !== undefined);
        this.claudeDir = opts.claudeDir ?? (opts.root === '' ? '.claude' : `${opts.root.replace(/\/+$/, '')}/.claude`);
    }
    print(line) {
        this.charge(line.length);
        this.out += line.replaceAll(MKTEMP_MARK, '').replaceAll(DOLLAR, '$');
    }
    envVar(name, level) {
        const { env } = this.opts;
        let v = '';
        switch (name) {
            case 'PWD':
                v = this.pwd;
                break;
            case 'OLDPWD':
                v = dirPath(level.oldtok || '-', this.opts.cwd);
                break;
            case 'HOME':
                v = env.HOME ?? '';
                break;
            case 'TMPDIR':
                v = env.TMPDIR ?? '';
                break;
            case 'CLAUDE_PROJECT_DIR':
                v = env.CLAUDE_PROJECT_DIR ?? '';
                break;
            case 'TMB_MODEL_CACHE_DIR':
                v = env.TMB_MODEL_CACHE_DIR || env.HF_HOME || '';
                if (v === '' && env.HOME)
                    v = `${env.HOME}/.cache/huggingface`;
                break;
        }
        return v === '' ? null : chomp(v);
    }
    /** The run-env value a `${NAME-def}`-style default reads first, as bash does (GH 1912): undefined when unset or not an envVar name, null when PWD or OLDPWD is unknown. */
    envDefault(name, level) {
        if (name === 'PWD' || name === 'OLDPWD')
            return this.envVar(name, level);
        if (name !== 'HOME' && name !== 'TMPDIR' && name !== 'CLAUDE_PROJECT_DIR' && name !== 'TMB_MODEL_CACHE_DIR')
            return undefined;
        const v = this.opts.env[name];
        return v === undefined ? undefined : chomp(v);
    }
    /**
     * GH 1912: each path a framed mktemp call prints, or null when it cannot be
     * proven. No template: `<prefix or tmp>.XXXXXXXX` under the run env's
     * absolute TMPDIR, which the command must not set. A template: each value it
     * expands to, against this statement's dir when relative, its last
     * component `[A-Za-z0-9._-]*X{3,}`.
     */
    mktempPaths(body, level) {
        const call = /[()]/.test(body) || body.includes(MKTEMP_MARK) ? null : mktempCall(shellWords(body));
        if (call === null || this.unbalanced)
            return null;
        let paths;
        if (call.template === null) {
            const tmp = this.varGet(level.vars, 'TMPDIR') === null ? this.envVar('TMPDIR', level) : null;
            if (tmp === null || !tmp.startsWith('/'))
                return null;
            paths = [`${tmp.replace(/\/+$/, '')}/${call.prefix ?? 'tmp'}.XXXXXXXX`];
        }
        else {
            const e = this.expand(call.template, level);
            if (!e.ok || !e.values.every((t) => MKTEMP_TEMPLATE.test(basename(t))))
                return null;
            const pwd = this.pwd.replace(/\/$/, '');
            if (e.values.some((t) => !t.startsWith('/')) && !this.pwd.startsWith('/'))
                return null;
            paths = e.values.map((t) => (t.startsWith('/') ? t : `${pwd}/${t}`));
        }
        return paths.every((p) => MKTEMP_PATH.test(p)) ? paths : null;
    }
    /** _tmb_cmd_var_get: every recorded value of <name>, each once, or null when never assigned. */
    varGet(vars, name) {
        const values = new Set();
        for (const line of vars.split('\n'))
            if (line.startsWith(name + '\t'))
                values.add(after(line, '\t'));
        return values.size > 0 ? chomp([...values].join('\n') + '\n') : null;
    }
    /** _tmb_cmd_expand: every value a word expands to (at most 16), or the variable that stops it (any one in an unbalanced level). */
    expand(word, level) {
        let rest = word;
        let acc = [''];
        const fail = (unres) => ({ ok: false, unres });
        for (;;) {
            const at = rest.search(/[$`]/);
            if (at < 0) {
                acc = acc.map((a) => a + rest);
                break;
            }
            const lit = rest.slice(0, at);
            rest = rest.slice(at);
            acc = acc.map((a) => a + lit);
            let name;
            let def = null;
            let colon = false;
            let cut = '';
            if (rest.startsWith('$(proc)'))
                return fail('$(proc)');
            if (rest.startsWith('$(alias-write)'))
                return fail('$(alias-write)');
            if (rest.startsWith('$(' + MKTEMP_MARK)) {
                const close = rest.indexOf(')');
                const paths = close < 0 ? null : this.mktempPaths(rest.slice(3, close), level);
                if (paths === null)
                    return fail('$()');
                rest = rest.slice(close + 1);
                acc = acc.flatMap((a) => paths.map((p) => a + p));
                if (acc.length > 16)
                    return fail('$()');
                continue;
            }
            if (rest.startsWith('`') || rest.startsWith('$('))
                return fail('$()');
            if (rest.startsWith('${')) {
                let a = rest.slice(2);
                if (!a.includes('}'))
                    return fail(rest);
                rest = after(a, '}');
                a = before(a, '}');
                name = /^[A-Za-z0-9_]*/.exec(a)[0];
                const op = a.slice(name.length);
                if (name === '' || /^[0-9]/.test(name))
                    return fail('${' + a + '}');
                if (op === '') {
                    // plain ${NAME}
                }
                else if (op.startsWith(':-') || op.startsWith(':=')) {
                    def = op.slice(2);
                    colon = true;
                }
                else if (op.startsWith('-') || op.startsWith('='))
                    def = op.slice(1);
                else if (op.startsWith('%')) {
                    cut = op.slice(1).replace(/^%/, '');
                    if (cut === '' || /[^A-Za-z0-9._-]/.test(cut))
                        return fail(name);
                }
                else
                    return fail(name);
            }
            else if (/^\$[A-Za-z_]/.test(rest)) {
                const a = rest.slice(1);
                name = /^[A-Za-z0-9_]*/.exec(a)[0];
                rest = a.slice(name.length);
            }
            else if (/^\$[0-9@*#?$!-]/.test(rest))
                return fail(rest.slice(0, 2));
            else {
                acc = acc.map((a) => a + '$');
                rest = rest.slice(1);
                continue;
            }
            if (this.unbalanced)
                return fail(name);
            let vals = this.varGet(level.vars, name);
            if (vals !== null) {
                if (vals.includes(BAD))
                    return fail(name);
            }
            else if (def !== null) {
                const set = this.envDefault(name, level);
                if (set === null)
                    return fail(name);
                if (set !== undefined && (set !== '' || !colon))
                    vals = set;
                else if (/[$`]/.test(def))
                    return fail(name);
                else
                    vals = def;
            }
            else {
                vals = this.envVar(name, level);
                if (vals === null)
                    return fail(name);
            }
            const next = [];
            for (const a of acc) {
                for (const v of vals.split('\n'))
                    next.push(a + (cut !== '' && v.endsWith(cut) ? v.slice(0, -cut.length) : v));
            }
            if (next.length > 16)
                return fail(name);
            acc = next;
        }
        return { ok: true, values: acc };
    }
    poison(level, name) {
        if (VAR_NAME.test(name))
            level.vars += `${name}\t${BAD}\n`;
    }
    varSet(level, name, value) {
        for (const set of setInText(value))
            this.poison(level, set);
        if (!VAR_NAME.test(name)) {
            this.poison(level, /^[A-Za-z_][A-Za-z0-9_]*/.exec(name)?.[0] ?? '');
            return;
        }
        const e = this.expand(value, level);
        if (e.ok)
            for (const v of e.values)
                level.vars += `${name}\t${v}\n`;
        else
            level.vars += `${name}\t${BAD}\n`;
    }
    /** _tmb_cmd_join: <p> joined to its statement's dir and normalized, newline-terminated. */
    join(dir, p) {
        const { cwd, raw, env } = this.opts;
        if (/[$`]/.test(p))
            return p + '\n';
        if (p === '~' || p.startsWith('~/')) {
            if (!env.HOME)
                return p + '\n';
            p = env.HOME + p.slice(1);
        }
        let base = '';
        if (!p.startsWith('/')) {
            if (dir === '-')
                return p === '.' ? 'UNRESOLVED:PWD:$PWD\n' : `UNRESOLVED:PWD:$PWD/${p}\n`;
            if (dir === '@')
                base = cwd;
            else if (dir.startsWith('@/'))
                base = (cwd === '' ? '' : `${cwd.replace(/\/$/, '')}/`) + dir.slice(2);
            else
                base = dir;
        }
        if (raw) {
            if (p === '.' && base !== '')
                return base + '\n';
            return (base === '' ? '' : `${base.replace(/\/$/, '')}/`) + p + '\n';
        }
        return ((base === '' ? '' : base + '/') + p).split('\n').map(normalize).join('\n') + '\n';
    }
    /** stmtWritePaths of <stmt> emitted against its dir <d>, and each path it names from a repository's top. */
    emitStatement(level, d, stmt, chain, final) {
        const tree = this.opts.treeWrites ? { gitLocationSet: this.gitLocationSet, unresolvable: this.claudeDir } : undefined;
        const { paths, tops, words } = stmtWritePaths(stmt, chain, this.interp, final, tree);
        for (const p of paths)
            if (p !== '')
                this.emit(level, d, decPath(p));
        for (const t of tops)
            this.emit(level, d, this.fromTop(d, t));
        if (!this.opts.gitMoves)
            return;
        this.gitMove(d, stmt, chain);
        if (INTERPRETER.test(basename(words[0] ?? '')) && paths.some((p) => leavesRunUnread(decPath(p))))
            this.unreadBody(stmt);
    }
    /** Git-moves mode: the GIT_MOVE line of a statement that runs git and may rewrite its work tree or move a ref. */
    gitMove(d, stmt, chain) {
        const { pre, words } = unwrapStatement(stmt);
        const argv = words.slice(0, 1).concat(operandWords(words)).map((w) => this.sourceWord(w));
        const command = argv[0];
        if (command === undefined)
            return;
        const what = dec(stmt);
        if (!command.literal) {
            // A lone command substitution is cut from the words after it, which the listing gives as a tail record.
            const namesMove = argv.length === 1 ? MOVE_WORD.test(decode(this.command)) : argv.some((w) => w.literal && MOVE_SUBCOMMANDS.includes(w.text));
            if (namesMove)
                this.print(gitMoveLine({ what, dir: null, change: EXPANDED_COMMAND, refMover: true }));
            return;
        }
        if (!isGitCommand(command.text))
            return;
        const read = gitStatementRead(argv);
        if (read.change === null && !read.refMover)
            return;
        const change = read.change?.kind === 'stash' && this.repeats > 0 ? REPEATED_STASH : read.change;
        const located = read.located || this.gitLocationSet || this.startsElsewhere > 0;
        const dir = located || read.cdirs === null ? null : this.gitRunDir(d, pre, chain, read.cdirs);
        this.print(gitMoveLine({ what, dir, change, refMover: read.refMover }));
    }
    /** The absolute dir a git statement runs in, its `-C` dirs folded in as stmtWritePaths folds them; null when it cannot be told. */
    gitRunDir(d, pre, chain, cdirs) {
        let cdir = '';
        if (pre !== '' || chain)
            for (const c of cdirs)
                cdir = under(cdir, c);
        let p = cdir === '' ? '.' : cdir;
        if (pre !== '')
            p = under(dec(pre), p);
        const dir = normalize(chomp(this.join(d, p)));
        return dir.startsWith('/') && !/[$`]/.test(dir) ? dir : null;
    }
    /** A word as bash hands it on: literal when bash passes it as written, with no expansion, glob, tilde or brace to fill in. */
    sourceWord(word) {
        const text = decode(word).replaceAll(QM, '');
        const brace = braceExpand(text);
        const literal = !SHELL_FILLED.test(word) && !/[*?[]/.test(text) && !text.startsWith('~') && !this.isHeld(word) && brace?.length === 1 && brace[0] === text;
        return { text, literal };
    }
    /** Git-moves mode: a GIT_MOVE line for shell text the analyzer cannot read when it names git, so a move inside it fails closed. */
    unreadBody(text) {
        if (this.opts.gitMoves && NAMES_GIT.test(decode(text)))
            this.print(gitMoveLine({ what: shown(decode(text)), dir: null, change: UNREAD_BODY, refMover: true }));
    }
    /**
     * <t> resolved under its repository's top: the `.git` holder git finds from
     * its base dir, else the run root. When neither its base nor a top can be
     * told, the run root itself (`/` with none), so the write fails closed.
     */
    fromTop(d, t) {
        const { root } = this.opts;
        const failClosed = root || '/';
        if (t.base === null)
            return failClosed;
        const base = chomp(this.join(d, decPath(t.base)));
        if (!base.startsWith('/') || /[$`]/.test(base))
            return failClosed;
        const top = t.find ? (gitWorkTreeTop(base) ?? root) : base;
        if (top === '')
            return failClosed;
        return t.rest === '.' ? top : `${top.replace(/\/$/, '')}/${decPath(t.rest)}`;
    }
    /** _tmb_cmd_emit */
    emit(level, dir, p, why = level.why) {
        if (p.startsWith(COMPUTED)) {
            this.print(computedLine(p.slice(COMPUTED.length)));
            return;
        }
        if (p.startsWith(PARSE)) {
            this.print(parseLine(p.slice(PARSE.length)));
            return;
        }
        if (p.startsWith(UNPROVEN)) {
            this.print(unprovenLine(p.slice(UNPROVEN.length)));
            return;
        }
        if (dir === '-' && why !== '' && !/^[/~$`]/.test(p)) {
            let v = decPath(after(why, WSEP));
            if (p !== '.')
                v = `${v.replace(/\/$/, '')}/${p}`;
            this.emit(level, before(why, WSEP), v, '');
            return;
        }
        if (!/[$`]/.test(p)) {
            this.print(this.join(dir, p));
            return;
        }
        this.pwd = dirPath(dir, this.opts.cwd);
        const e = this.expand(p, level);
        if (e.ok) {
            for (const v of e.values)
                this.print(this.join(dir, v));
            return;
        }
        if (!/^[/~$`]/.test(p)) {
            if (dir === '-')
                p = '$PWD/' + p;
            else {
                const base = chomp(this.join(dir, '.'));
                if (base !== '.')
                    p = `${base.replace(/\/$/, '')}/${p}`;
            }
        }
        this.print(`UNRESOLVED:${e.unres}:${p}\n`);
    }
    listerHost(level) {
        const { cwd, root, env } = this.opts;
        return {
            cwd,
            root,
            home: env.HOME ?? '',
            rootc: () => (this.rootc ??= pathCanonical(root)),
            expand: (word) => {
                const e = this.expand(word, level);
                return e.ok ? e.values : null;
            },
        };
    }
    bind(level, name, values) {
        if (values === null)
            return false;
        for (const v of values)
            level.vars += `${name}\t${v}\n`;
        return true;
    }
    /** _tmb_cmd_loop_source: the variable bound from the lister of a source mark (\022<dir>\022<word>…). */
    loopSource(level, name, mark) {
        let m = mark.replace(/^\x12/, '');
        const dirtok = before(m, SEP);
        m = decPath(m.slice(dirtok.length).replace(/^\x12/, ''));
        const fields = before(m, '\n').split(SEP);
        if (fields[fields.length - 1] === '')
            fields.pop();
        if (fields.length === 0)
            return false;
        return this.bind(level, name, listerBind(this.listerHost(level), name, dirtok, 'loop', fields, []));
    }
    /** _tmb_cmd_exec_writes: what a find / fd / xargs statement writes through the command it runs. */
    execWrites(outer, dir, mark, words, tok, depth) {
        const level = { ...outer };
        const tool = basename(words[0]);
        const acts = [];
        let name;
        if (tool === 'find')
            name = 'find_path';
        else if (tool === 'fd' || tool === 'fdfind')
            name = 'fd_path';
        else if (tool === 'xargs') {
            name = 'xargs_arg';
            const n = words.length;
            let k = 1;
            let rep = '';
            let noin = false;
            while (k < n) {
                const p = words[k];
                if (p === '--') {
                    k++;
                    break;
                }
                if (p === '-I' || p === '-J') {
                    rep = words[k + 1] ?? '';
                    k += 2;
                    continue;
                }
                k++;
                if (p.startsWith('-I') || p.startsWith('-J'))
                    rep = p.slice(2);
                else if (p === '-i' || p === '--replace')
                    rep = '{}';
                else if (p.startsWith('-i'))
                    rep = p.slice(2);
                else if (p.startsWith('--replace='))
                    rep = p.slice(10);
                else if (p === '-a' || p === '--arg-file') {
                    noin = true;
                    k++;
                }
                else if (p.startsWith('-a') || p.startsWith('--arg-file='))
                    noin = true;
                else if (XARGS_VALUE.test(p))
                    k++;
                else if (!p.startsWith('-')) {
                    k--;
                    break;
                }
            }
            if (k >= n)
                return;
            const rv = '${' + name + '}';
            let cmd = words.slice(k).join(' ');
            cmd = rep !== '' ? cmd.split(rep).join(rv) : `${cmd} ${rv}`;
            acts.push('x' + cmd);
            if (noin || mark === '' || !this.loopSource(level, name, mark))
                level.vars += `${name}\t${BAD}\n`;
        }
        else
            return;
        if (tool !== 'xargs' && !this.bind(level, name, listerBind(this.listerHost(level), name, dir, 'exec', words, acts))) {
            level.vars += `${name}\t${BAD}\n`;
        }
        const rv = '${' + name + '}';
        this.repeats++;
        try {
            for (const act of acts) {
                if (act === 'd')
                    this.emit(level, dir, rv);
                else if (act.startsWith('f'))
                    this.emit(level, dir, decPath(act.slice(1)));
                else if (act.startsWith('x') || act.startsWith('e')) {
                    let cmd = act.slice(1);
                    if (tool === 'find')
                        cmd = cmd.split('{}').join(rv);
                    else if (tool !== 'xargs') {
                        for (const ph of ['{//}', '{.}', '{}'])
                            cmd = cmd.split(ph).join(rv);
                        for (const ph of ['{/.}', '{/}'])
                            cmd = cmd.split(ph).join('*');
                    }
                    const elsewhere = act.startsWith('e') ? 1 : 0;
                    this.startsElsewhere += elsewhere;
                    try {
                        this.emitStatement(level, dir, cmd, true, false);
                        this.execShell(level, cmd, tok, depth);
                    }
                    finally {
                        this.startsElsewhere -= elsewhere;
                    }
                }
            }
        }
        finally {
            this.repeats--;
        }
    }
    /**
     * TS only: the body of a shell that find / fd / xargs run (`-exec sh -c
     * '…"$0"…' {} \;`, `xargs -I % sh -c 'echo > %'`), judged as a command with
     * the placeholder bound. A target left on a variable (a positional
     * parameter, `for f;`, the unbound placeholder) fails closed as $(computed).
     */
    execShell(level, cmd, tok, depth) {
        const body = inner(unwrapStatement(cmd).words.join(' '));
        if (body === '')
            return;
        const text = dec(body);
        if (depth >= MAX_DEPTH) {
            this.print(computedLine(text));
            this.unreadBody(text);
            return;
        }
        const outer = this.out;
        this.out = '';
        this.run(text, tok, depth + 1, level.vars);
        const lines = this.out.split('\n');
        lines.pop();
        this.out = outer;
        let failed = false;
        for (const line of lines) {
            if (BODY_UNRESOLVED.test(line))
                failed = true;
            else
                this.print(line + '\n');
        }
        if (failed)
            this.print(computedLine(text));
    }
    /**
     * What a program's process call writes, relative paths under `$(proc)/`. A
     * nested `$(parse)` or `$(computed)` line keeps its reason rather than being
     * stripped to its text and judged as a path.
     */
    procWrites(cmd) {
        const out = [];
        for (const record of this.listing(cmd, '@', 0)) {
            if (record.dir.startsWith('='))
                continue;
            const { words } = unwrapStatement(record.stmt);
            if (words.length === 0)
                continue;
            if (!record.tail && /[$`]/.test(dec(words[0]))) {
                out.push('$(proc)');
                continue;
            }
            if (!cmd.includes('<<') && stdinInterp(words) !== '')
                out.push('$(proc)');
        }
        const nested = new WritePaths(this.parser, { cwd: PROG_DIR, raw: true, root: '', env: this.opts.env, treeWrites: this.opts.treeWrites, claudeDir: this.claudeDir, gitMoves: this.opts.gitMoves }, this.charge);
        nested.run(cmd, '@', 0, '');
        const lines = nested.out.split('\n');
        lines.pop();
        for (let p of lines) {
            const move = parseGitMoveLine(p);
            if (move !== null) {
                // A program's process call runs in a dir the analyzer does not follow.
                this.print(gitMoveLine({ ...move, dir: null }));
                continue;
            }
            if (p.startsWith(`UNRESOLVED:${COMPUTED}`) || p.startsWith(`UNRESOLVED:${PARSE}`) || p.startsWith(`UNRESOLVED:${UNPROVEN}`)) {
                out.push(p.slice('UNRESOLVED:'.length));
                continue;
            }
            if (p.startsWith('UNRESOLVED:PWD:'))
                p = '$(proc)';
            else if (p.startsWith('UNRESOLVED:') && p.indexOf(':', 11) >= 0)
                p = p.slice(p.indexOf(':', 11) + 1);
            if (p === '')
                continue;
            if (p === PROG_DIR)
                p = '.';
            else if (p.startsWith(PROG_DIR + '/'))
                p = p.slice(PROG_DIR.length + 1);
            else if (!/^[/~$]/.test(p))
                p = '$(proc)/' + p;
            out.push(p);
        }
        return out.join('\n');
    }
    /** _tmb_cmd_statements_enc to depth 3: bash -c / eval bodies listed as their own statements. */
    listing(cmd, base, depth) {
        this.charge(cmd.length);
        const encoded = encode(this.parser, cmd, this.charge, true);
        if (!encoded.ok)
            return [];
        const out = [];
        for (const record of statementsEnc(encoded.text, base, this.opts.env.HOME ?? '', true, this.charge)) {
            if (/^\t*$/.test(record.stmt))
                continue;
            const body = depth < MAX_DEPTH && !record.dir.startsWith('=') ? inner(record.stmt) : '';
            if (body !== '')
                out.push(...this.listing(dec(body), record.dir, depth + 1));
            else
                out.push(record);
        }
        return out;
    }
    /** The `heldKey` of every word of the command `run` is in whose text the shell fills in part of. */
    held = new Set();
    /** The `Encoded.spliced` keys of the command `run` is in. */
    spliced = new Set();
    /** _TMB_CMD_UNBAL: the level running, or one it runs within, has loop frames that do not balance. */
    unbalanced = false;
    isHeld(word) {
        return this.held.has(heldKey(word));
    }
    /**
     * GH 1913: each text an eval with held arguments runs, when the shell fills
     * them in only from `$NAME` / `${NAME}` variables whose every value is a
     * literal tracked in this command (no glob, brace, newline or tab, IFS
     * untouched), one per combination of values (at most 16), none changing
     * the directory; else null.
     */
    evalExpansions(level, args, body) {
        if (this.unbalanced || this.varGet(level.vars, 'IFS') !== null)
            return null;
        if (args.some((w) => /[$`]/.test(heldKey(w)) && !this.spliced.has(heldKey(w))))
            return null;
        const text = dec(body);
        if (/[`\x07\x08]/.test(text) || !plainDollars(text))
            return null;
        const ref = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
        let combos = [new Map()];
        for (const name of new Set([...text.matchAll(ref)].map((m) => m[1] ?? m[2]))) {
            const vals = this.varGet(level.vars, name);
            if (vals === null)
                return null;
            const values = vals.split('\n');
            if (values.some((v) => /[\x01$`*?[{\t\n\r]|[!@+]\(/.test(v)))
                return null;
            combos = combos.flatMap((c) => values.map((v) => new Map(c).set(name, v)));
            if (combos.length > 16)
                return null;
        }
        const texts = combos.map((c) => text.replace(ref, (_, braced, plain) => c.get(braced ?? plain ?? '') ?? ''));
        for (const t of texts) {
            for (const record of this.listing(t, '@', 0)) {
                if (/^(cd|pushd|popd)$/.test(basename(unwrapStatement(record.stmt).words[0] ?? '')))
                    return null;
            }
        }
        return texts;
    }
    /** The texts an eval runs: its own when no argument is held, else `evalExpansions`. */
    evalTexts(level, args, body) {
        return args.some((w) => this.isHeld(w)) ? this.evalExpansions(level, args, body) : [dec(body)];
    }
    /** Runs one eval text at depth + 1 in this shell: a name it sets is poisoned in `level`. */
    evalRun(level, text, tok, depth) {
        const seen = new Set(level.vars.split('\n'));
        for (const line of this.run(text, tok, depth + 1, level.vars).split('\n')) {
            if (line !== '' && !seen.has(line))
                this.poison(level, before(line, '\t'));
        }
    }
    interp = (words) => interpWrites(words, (cmd) => this.procWrites(cmd), (w) => this.isHeld(w));
    /**
     * _tmb_cmd_track_vars. The TS poisons the names a declare-like builtin sets
     * with an option other than -x / -r / -g / -t (`declare -n`, `-a`, `-i`,
     * ...), and those mapfile / readarray, getopts and unset set (GH 1739).
     */
    trackVars(level, words) {
        switch (basename(words[0])) {
            case 'export':
            case 'declare':
            case 'typeset':
            case 'local':
            case 'readonly': {
                const plain = words.slice(1).every((w) => !/^[-+]/.test(w) || /^[-+][xrgt]+$/.test(w));
                for (const w of words.slice(1)) {
                    if (!/^[A-Za-z_].*=/s.test(w))
                        continue;
                    if (plain)
                        this.varSet(level, before(w, '='), decPath(after(w, '=')));
                    else
                        this.poison(level, before(w, '='));
                }
                if (!plain)
                    for (const w of words.slice(1))
                        this.poison(level, w);
                return;
            }
            case 'mapfile':
            case 'readarray':
                for (const w of [...words.slice(1), 'MAPFILE'])
                    this.poison(level, w);
                return;
            case 'unset':
                for (const w of words.slice(1))
                    this.poison(level, w);
                return;
            case 'getopts':
                this.poison(level, words[2] ?? '');
                return;
            case 'for': {
                if (words[2] !== 'in') {
                    level.vars += `${words[1] ?? ''}\t${BAD}\n`;
                    return;
                }
                const name = words[1] ?? '';
                const rest = words.slice(3);
                if (rest.length === 1 && rest[0].startsWith('$\x0f\x10\x12')) {
                    if (!this.loopSource(level, name, rest[0].slice(3)))
                        level.vars += `${name}\t${BAD}\n`;
                    return;
                }
                for (const w of rest)
                    this.varSet(level, name, decPath(w));
                return;
            }
            case 'read': {
                let mk = '';
                let skip = false;
                const names = [];
                for (const w of words.slice(1)) {
                    if (skip) {
                        skip = false;
                        continue;
                    }
                    if (w.startsWith(SEP))
                        mk = w;
                    else if (w === '-d')
                        skip = true;
                    else if (w === '-r' || w === '-e')
                        continue;
                    else if (w.startsWith('-'))
                        mk = '!';
                    else if (/^[A-Za-z_]/.test(w))
                        names.push(w);
                }
                if (names.length === 1 && mk !== '' && mk !== '!' && this.loopSource(level, names[0], mk))
                    return;
                for (const w of names)
                    level.vars += `${w}\t${BAD}\n`;
                return;
            }
            case 'printf':
                if (words[1] === '-v')
                    level.vars += `${words[2] ?? ''}\t${BAD}\n`;
                return;
        }
    }
    /**
     * _tmb_cmd_write_paths_in; the TS returns the variables tracked when it
     * ends. `top` marks the whole Bash command: its last statement is judged
     * as the last that runs, unless RUNS_LATER matches the command.
     */
    run(cmd, base, depth, vars, top = false) {
        this.charge(cmd.length);
        if (GIT_LOCATION_SET.test(cmd))
            this.gitLocationSet = true;
        const encoded = encode(this.parser, cmd, this.charge, true);
        if (this.command === '')
            this.command = cmd;
        if (!encoded.ok) {
            this.print(parseLine(cmd));
            this.unreadBody(cmd);
            return vars;
        }
        const outer = { held: this.held, spliced: this.spliced, unbalanced: this.unbalanced, repeats: this.repeats };
        this.held = encoded.held;
        this.spliced = encoded.spliced;
        try {
            return this.runEncoded(encoded.text, encoded.heredocs, base, depth, vars, top && !RUNS_LATER.test(cmd));
        }
        finally {
            this.held = outer.held;
            this.spliced = outer.spliced;
            this.unbalanced = outer.unbalanced;
            this.repeats = outer.repeats;
        }
    }
    /**
     * The names a statement's words may set beyond what `trackVars` follows; a
     * declare-like builtin's own `name=` words are its to judge. With `defer`, a
     * `${NAME=def}` whose NAME the statement names nowhere else is returned
     * instead, for the caller to poison once the statement's own writes are
     * judged, so it reads the value NAME had before it (GH 2440).
     */
    poisonSet(level, words, defer) {
        const declares = /^(export|declare|typeset|local|readonly)$/.test(basename(words[0]));
        const texts = words.map(dec);
        const all = texts.join(' ');
        const deferred = [];
        texts.forEach((text, k) => {
            if (declares && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]))
                return;
            const own = text.replace(EQ_DEFAULT, (whole, name) => {
                if (!defer || refCount(all, name) !== 1)
                    return whole;
                deferred.push(name);
                return '${';
            });
            for (const name of setInText(own))
                this.poison(level, name);
        });
        return deferred;
    }
    /**
     * _tmb_cmd_loop_vars: at a loop's `{`, adds to the level every value its
     * records (`loop`, the first at 1-based index `from + 1`) assign, nested
     * loops included, pass after pass until one adds none, so a use that
     * precedes an in-body assignment also sees what a later pass assigns
     * (GH 1944). A name still gaining values after 8 passes is poisoned.
     */
    loopVars(level, loop, from, bodies, depth) {
        const { cwd } = this.opts;
        const saved = { pwd: this.pwd, oldtok: level.oldtok, why: level.why };
        level.vars = varsUniq(level.vars);
        const seed = new Set(level.vars.split('\n'));
        let converged = false;
        for (let pass = 0; pass < 8 && !converged; pass++) {
            const prev = level.vars;
            this.charge(prev.length + loop.length);
            loop.forEach((record, k) => {
                this.charge(level.vars.length);
                if (record.dir === LOOP_OPEN || record.dir === LOOP_CLOSE || record.dir === UNBALANCED)
                    return;
                let dir = record.dir;
                let old = dir.includes(SEP) ? after(dir, SEP) : '-';
                dir = before(dir, SEP);
                let why = '';
                if (old.includes(SEP)) {
                    why = after(old, SEP);
                    old = before(old, SEP);
                }
                level.oldtok = old;
                level.why = why;
                const words = shellWords(record.stmt);
                if (words.length === 0)
                    return;
                if (dir.startsWith('=')) {
                    if (!record.tail)
                        this.eachDir(level, dir.slice(1).split(ALT), why, (d) => {
                            this.pwd = dirPath(d, cwd);
                            for (const w of words)
                                this.varSet(level, before(w, '='), decPath(after(w, '=')));
                        });
                    return;
                }
                this.poisonSet(level, words, false);
                for (const h of bodies.get(from + k + 1) ?? [])
                    if (h.expands)
                        for (const name of setInText(h.body))
                            this.poison(level, name);
                const body = inner(record.stmt);
                const evaluated = evalArgs(words);
                if (body !== '' && evaluated && depth < MAX_DEPTH) {
                    const out = this.out;
                    const tok = dir + SEP + old + (why === '' ? '' : SEP + why);
                    for (const text of this.evalTexts(level, evaluated, body) ?? [])
                        this.evalRun(level, text, tok, depth);
                    this.out = out;
                }
                if (record.tail || (body !== '' && ((!evaluated && heldProgram(body)) || depth < MAX_DEPTH)))
                    return;
                this.eachDir(level, dir.split(ALT), why, (d) => {
                    this.pwd = dirPath(d, cwd);
                    this.trackVars(level, words);
                });
            });
            level.vars = varsUniq(level.vars);
            converged = level.vars === prev;
        }
        if (!converged)
            for (const line of level.vars.split('\n'))
                if (line !== '' && !seed.has(line))
                    this.poison(level, before(line, '\t'));
        this.pwd = saved.pwd;
        level.oldtok = saved.oldtok;
        level.why = saved.why;
    }
    /**
     * Runs `fn` for each dir a statement may run in (a loop's back-edge can
     * list more than one, GH 1977), with its why on the first only; each run
     * starts from the variables the statement found and keeps what it adds.
     */
    eachDir(level, dirs, why, fn) {
        const vars = level.vars;
        let added = '';
        dirs.forEach((d, n) => {
            level.vars = vars;
            level.why = n === 0 ? why : '';
            fn(d);
            added += level.vars.slice(vars.length);
        });
        level.vars = vars + added;
        level.why = why;
    }
    runEncoded(text, heredocs, base, depth, vars, endsLast) {
        const level = { vars, oldtok: '-', why: '' };
        const { cwd } = this.opts;
        const records = statementsEnc(text, base, this.opts.env.HOME ?? '', true, this.charge).filter((r) => !/^\t*$/.test(r.stmt));
        const bodies = heredocAlign(heredocs, records);
        if (records.some((r) => r.dir === UNBALANCED))
            this.unbalanced = true;
        let idx = 0;
        for (const record of records) {
            idx++;
            this.charge(level.vars.length);
            if (record.dir === LOOP_OPEN) {
                this.repeats++;
                this.loopVars(level, loopBody(records, idx), idx, bodies, depth);
                continue;
            }
            if (record.dir === LOOP_CLOSE)
                this.repeats = Math.max(0, this.repeats - 1);
            if (record.dir === LOOP_CLOSE || record.dir === UNBALANCED)
                continue;
            let dir = record.dir;
            let old = dir.includes(SEP) ? after(dir, SEP) : '-';
            dir = before(dir, SEP);
            let why = '';
            if (old.includes(SEP)) {
                why = after(old, SEP);
                old = before(old, SEP);
            }
            level.oldtok = old;
            level.why = why;
            let words = shellWords(record.stmt);
            if (words.length === 0)
                continue;
            if (dir.startsWith('=')) {
                if (!record.tail)
                    this.eachDir(level, dir.slice(1).split(ALT), why, (d) => {
                        this.pwd = dirPath(d, cwd);
                        for (const w of words)
                            this.varSet(level, before(w, '='), decPath(after(w, '=')));
                    });
                continue;
            }
            const tok = dir + SEP + old + (why === '' ? '' : SEP + why);
            const dirs = dir.split(ALT);
            const each = (fn) => this.eachDir(level, dirs, why, (d) => fn(d, d === '-' && level.why === '', d + SEP + old + (level.why === '' ? '' : SEP + level.why)));
            const final = endsLast && idx === records.length;
            const body = inner(record.stmt);
            const evaluated = evalArgs(words);
            const deferred = this.poisonSet(level, words, body === '');
            for (const h of bodies.get(idx) ?? [])
                if (h.expands)
                    for (const name of setInText(h.body))
                        this.poison(level, name);
            const texts = evaluated && body !== '' ? this.evalTexts(level, evaluated, body) : null;
            const argv0 = unwrapStatement(record.stmt).words[0] ?? '';
            if (!record.tail && /[$`\x07]/.test(decode(argv0)))
                this.print(unprovenLine(dec(record.stmt)));
            if (evaluated?.some((w) => this.isHeld(w)) && texts === null) {
                this.print(unprovenLine(dec(record.stmt)));
                this.unreadBody(record.stmt);
            }
            else if (body !== '' && !evaluated && this.isHeld(body)) {
                this.print(unprovenLine(`${basename(dec(words[0]))} ${dec(body)}`));
                this.unreadBody(record.stmt);
            }
            const watched = basename(words[0]) === 'watch';
            const ownWords = body !== '' && !evaluated && !watched;
            if (ownWords) {
                each((d, chain) => this.emitStatement(level, d, record.stmt, chain, final));
            }
            if (body !== '' && !evaluated && heldProgram(body)) {
                this.print(computedLine(`${basename(dec(words[0]))} ${dec(body)}`));
                this.unreadBody(record.stmt);
                continue;
            }
            if (body !== '' && depth < MAX_DEPTH) {
                if (watched)
                    this.repeats++;
                try {
                    if (texts)
                        for (const t of texts)
                            this.evalRun(level, t, tok, depth);
                    else
                        this.run(dec(body), tok, depth + 1, level.vars);
                }
                finally {
                    if (watched)
                        this.repeats--;
                }
                continue;
            }
            if (body !== '') {
                this.print(computedLine(dec(body)));
                this.unreadBody(body);
            }
            let stmt = record.stmt;
            let mark = '';
            if (basename(words[0]) === 'xargs' && words[words.length - 1].startsWith(SEP)) {
                mark = words[words.length - 1];
                words = words.slice(0, -1);
                stmt = words.join(' ');
            }
            if (!ownWords) {
                each((d, chain) => this.emitStatement(level, d, stmt, chain, final));
            }
            if (/^(find|fd|fdfind|xargs)$/.test(basename(words[0])))
                each((d, _, t) => this.execWrites(level, d, mark, words, t, depth));
            for (const name of deferred)
                this.poison(level, name);
            const { kind, info } = stdinProgram(words);
            if (kind !== '') {
                const progs = [];
                const herestring = (w) => {
                    progs.push({ prog: dec(w), held: heldProgram(w), partly: this.isHeld(w) });
                };
                for (let w = 0; w < words.length; w++) {
                    if (words[w] === '<<<')
                        herestring(words[w + 1] ?? '');
                    else if (words[w].startsWith('<<<'))
                        herestring(words[w].slice(3));
                }
                for (const h of bodies.get(idx) ?? [])
                    progs.push({ prog: h.body, held: heldProgram(h.body), partly: h.expands });
                if (progs.length === 0 && !info) {
                    this.print(computedLine(basename(dec(words[0]))));
                    this.unreadBody(this.command);
                }
                const shownArgv0 = basename(dec(words[0]));
                for (const { prog, held, partly } of progs) {
                    if (held) {
                        this.print(computedLine(`${shownArgv0} ${prog}`));
                        this.unreadBody(prog);
                    }
                    else if (kind === 'sh') {
                        if (partly) {
                            this.print(unprovenLine(`${shownArgv0} ${prog}`));
                            this.unreadBody(prog);
                        }
                        if (depth < MAX_DEPTH)
                            this.run(prog, tok, depth + 1, level.vars);
                        else {
                            this.print(computedLine(prog));
                            this.unreadBody(prog);
                        }
                    }
                    else {
                        const found = progWrites(kind, prog, false, (c) => this.procWrites(c));
                        each((d) => {
                            for (const p of found.lines)
                                if (p !== '')
                                    this.emit(level, d, p);
                        });
                        if (found.computed)
                            this.print(computedLine(shownArgv0));
                        if (partly || found.unproven)
                            this.print(unprovenLine(`${shownArgv0} ${prog}`));
                        if (found.computed || partly || found.unproven || found.lines.some(leavesRunUnread))
                            this.unreadBody(prog);
                    }
                }
            }
            if (!record.tail)
                each((d) => {
                    this.pwd = dirPath(d, cwd);
                    this.trackVars(level, words);
                });
        }
        return level.vars;
    }
}
/** The records of the loop whose `{` is records[from - 1], up to its `}`, nested loops included. */
function loopBody(records, from) {
    let depth = 0;
    let k = from;
    for (; k < records.length; k++) {
        if (records[k].dir === LOOP_OPEN)
            depth++;
        else if (records[k].dir === LOOP_CLOSE && depth-- === 0)
            break;
    }
    return records.slice(from, k);
}
/** Each line of `vars` once, in first-seen order. */
function varsUniq(vars) {
    const lines = [...new Set(vars.split('\n').filter((l) => l !== ''))];
    return lines.length === 0 ? '' : lines.join('\n') + '\n';
}
/** _tmb_cmd_heredoc_align: each heredoc body under the 1-based index of the statement whose `<<WORD` names its delimiter, in order. */
function heredocAlign(heredocs, records) {
    const out = new Map();
    if (heredocs.length === 0)
        return out;
    const used = new Set();
    let p = -1;
    records.forEach((record, i) => {
        for (const m of record.stmt.matchAll(/<<+([^ \t;&|<>()]*)/g)) {
            if (m[0].length - m[1].length !== 2 || m[1] === '')
                continue;
            let j = p + 1;
            while (j < heredocs.length && (used.has(j) || heredocs[j].delim !== m[1]))
                j++;
            if (j >= heredocs.length)
                continue;
            used.add(j);
            p = j;
            out.set(i + 1, [...(out.get(i + 1) ?? []), heredocs[j]]);
        }
    });
    return out;
}
/** The lines tmb_cmd_write_paths prints for `command`, parsed with the given tree-sitter-bash parser. */
export function writePathsWith(parser, command, opts) {
    if (command.length > ANALYSIS_WORK_CAP)
        return [CAP_LINE];
    let spent = 0;
    const w = new WritePaths(parser, opts, (units) => {
        spent += units;
        if (spent > ANALYSIS_WORK_CAP)
            throw new WorkCapReached();
    });
    try {
        w.run(command, '@', 0, '', true);
    }
    catch (e) {
        if (e instanceof WorkCapReached || e instanceof RangeError)
            return [CAP_LINE];
        throw e;
    }
    const lines = w.out.split('\n');
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
//# sourceMappingURL=write-paths.js.map