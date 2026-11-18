/**
 * The statement lister on an encoded skeleton: one
 * `<dir-token>\t<encoded statement>` record per executable statement, the
 * effective dir tracked through cd / pushd / popd / cd - / git -C / subshells
 * and $VAR dirs resolved from a flat allowlisted prefix. With `assign`,
 * assignment-only statements come out as `=<dir-token>` records, every dir
 * token carries \022<old-dir-token>[\022<why>], an unquoted $( ) or backtick
 * leaves `$()` (encoded) where it stood, and a loop's source is attached as a
 * \022<dir>\022<word>… mark, and a last `!` record marks loop frames that do
 * not balance. With `frame` (by default `assign`), a loop's statements sit
 * between a `{` and a `}` record (GH 1944, GH 2065), and a dir token may also
 * list, each after an ALT, the other dirs a loop's back-edge can bring its
 * statement to (GH 1977): a
 * frame's statements run in every dir the frame can end a pass in, re-encoded
 * until those stop growing, and after its `}` the dir is the frame's entry
 * dirs plus those. A frame still growing after MAX_GROWTH runs, or a frame
 * edge that would leave more than MAX_DIRS dirs, leaves `-` alone, so a cd
 * that keeps drifting fails closed in bounded time.
 * The TS keeps `time NAME=value` an assignment
 * (GH 1739): `time` is a reserved word, so the shell still sets the name.
 */
import { ENC, HD_DATA, NO_CHARGE, QC, QM, QO, SUB_PC, SUB_PO, plainDollars } from './encode.js';
import { gitWord } from './git-word.js';
import { ASSIGNMENT, WRAPPER, splitWords, unwrap } from './unwrap.js';
export const SEP = '\x12';
export const LOOP_OPEN = '{';
export const LOOP_CLOSE = '}';
export const UNBALANCED = '!';
export const WSEP = '\x14';
export const ALT = '\x13';
const MAX_GROWTH = 8;
const MAX_DIRS = 8;
const VSEP = '\x1c';
const VEQ = '\x1d';
const BAD = '\x01';
const EMPTY_WORD = "''";
/** git's global options that take the next word as their value (`git --help`). */
export const GIT_VALUE_OPTION = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--attr-source', '--super-prefix', '--config-env', '--list-cmds']);
/** A git global option and its value in one word, which cannot take the next word. */
export const GIT_VALUE_JOINED = /^--[a-z][a-z0-9-]*=/;
const WORD_BREAKER = /[$`*?[\]{}'"\\]/;
/** Whether bash's word splitting and pathname expansion leave <value> as the one word it is: not empty, no IFS blank or other control byte, no expansion left, no glob, brace, quote or backslash character. */
function isOneWord(value) {
    if (value === '' || WORD_BREAKER.test(value))
        return false;
    for (let i = 0; i < value.length; i++)
        if (value.charCodeAt(i) <= 0x20)
            return false;
    return true;
}
const VPLAIN = /^(cd|git|echo|true|false|ls|cat|pwd|mkdir|touch)$/;
const VBAD = '*?[](){<>`';
const HD_MARK = /<<[\x1a\x1e]/g;
const VSPECIAL = /^(IFS|PWD|OLDPWD|RANDOM|SRANDOM|SECONDS|LINENO|EPOCHSECONDS|EPOCHREALTIME|BASHPID|PPID|UID|EUID|GROUPS|HISTCMD|PIPESTATUS|FUNCNAME|BASH_[A-Z_]*)$/;
const KEYWORD = /^(\{|\}|!|if|then|else|elif|do|while|until|fi|done|esac)$/;
const ENCODED = /[\x01-\x06\x0e-\x13]/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const BRACED = /^\{[A-Za-z_][A-Za-z0-9_]*\}/;
/** A redirect whose target is a literal word or an fd duplication (GH 2404): it expands nothing, so it cannot reassign a variable. */
const LITERAL_REDIRECT = /(^|[ \t])([0-9]*(>>|>\||>&|<&|<>|>|<)|&>>|&>)[ \t]*[A-Za-z0-9_./,:@%+-]+(?=[ \t]|$)/g;
/** A statement cut at `(` whose last word may name a function: no `=`, so no array assignment. */
const FN_HEAD = /(^|[ \t])[^ \t=]+[ \t]*$/;
/** Command words that may call a function the scan cannot pin (GH 2630). */
const DYN_CALLS = new Set(['eval', 'trap', 'alias', 'add-zsh-hook']);
/** Builtins that call a function or command an option names (GH 2630): mapfile / readarray -C, compgen / complete -F and -C. */
const CB_FLAGS = new Map([
    ['mapfile', /C/],
    ['readarray', /C/],
    ['compgen', /[CF]/],
    ['complete', /[CF]/],
]);
/** Functions the shell itself calls by name (GH 2630): bash and zsh command-not-found handlers and zsh hook functions and traps. */
const HOOK_FN = /^(command_not_found_handler?|chpwd|precmd|preexec|periodic|zshexit|zshaddhistory|zsh_directory_name|TRAP[A-Z0-9]+)$/;
/** A zsh hook array, whose entries name functions the shell calls (GH 2630). */
const HOOK_ARRAY = /(^|[^A-Za-z0-9_])(chpwd|precmd|preexec|periodic|zshexit|zshaddhistory|zsh_directory_name)_functions([^A-Za-z0-9_]|$)/;
const FOR_HEAD = /^[ \t]*(((do|then|else|elif|\{|!)[ \t]+)*)for[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]+in[ \t]+\$$/;
/** A redirect word: its operator, after an optional fd number or `{name}`; a heredoc's `<<` always carries its delimiter (GH 2635). */
export const REDIRECT_WORD = /^([0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\})?(&>>?|<<<|<<|<>|<&|>&|>>|>\||<|>)/;
/** A statement's source words past argv0, a redirect and its target dropped. */
export function operandWords(words) {
    const out = [];
    for (let i = 1; i < words.length; i++) {
        const redirect = REDIRECT_WORD.exec(words[i]);
        if (redirect && redirect[0] === words[i])
            i++;
        else if (!redirect)
            out.push(words[i]);
    }
    return out;
}
/** A command word that runs git: `git`, or a path to it (`/usr/bin/git`, `./git`) (GH 2987). */
export const isGitCommand = (word) => /^(.*\/)?git$/.test(word);
/** Command words whose statement keeps `cut`: git (GH 2634), and the shells, eval and builtins that run a code string the git listing reads or set a variable an operand names (GH 2635). */
const CUT_KEPT = /^(git|(.*\/)?(bash|sh|zsh|dash|ksh)|eval|trap|alias|mapfile|readarray|compgen|complete|export|declare|typeset|local|readonly|read|printf|getopts)$/;
/** A PS4 assignment word: bash expands its value before each `set -x` trace line (GH 2635). */
export const PS4_WORD = /^PS4(\[[^\]]*\])?\+?=/;
export const DECLARE = /^(export|declare|typeset|local|readonly)$/;
function norm(p) {
    let lead = '';
    if (p.startsWith('@')) {
        lead = '@';
        p = p.slice(1);
    }
    const out = [];
    for (const part of p.split('/')) {
        if (part === '' || part === '.')
            continue;
        if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') {
            out.pop();
            continue;
        }
        if (part === '..' && out.length === 0 && lead === '')
            continue;
        out.push(part);
    }
    const joined = out.map((x) => '/' + x).join('');
    if (lead === '@')
        return '@' + joined;
    return joined === '' ? '/' : joined;
}
/** A double-quoted substitution's body as one word; its quoted parens become SUB_PO / SUB_PC so `heldProgram` can tell them from the frame (TS only). */
function rawword(t) {
    t = unmark(t);
    let out = '';
    for (const ch of t) {
        if (ch === QO)
            out += '$' + ENC[8];
        else if (ch === QC)
            out += ENC[9];
        else if (ch === ENC[8])
            out += SUB_PO;
        else if (ch === ENC[9])
            out += SUB_PC;
        else if (ch === '\n')
            out += ENC[12];
        else {
            const x = ' \t<>|;&()`'.indexOf(ch);
            out += x >= 0 ? ENC[x + 1] : ch;
        }
    }
    return out;
}
/** The encoded text without the heredoc verdict marks of encode.ts. */
function unmark(t) {
    return t.replace(HD_MARK, '<<');
}
function srcmark(body, dir) {
    body = unmark(body).replaceAll(QM, '');
    if (/[;&|()`\n]/.test(body) || body.includes(QO) || body.includes(QC))
        return '';
    body = body.replace(/[ \t]+/g, SEP);
    if (body.startsWith(SEP))
        body = body.slice(1);
    if (body.endsWith(SEP))
        body = body.slice(0, -1);
    if (body === '')
        return '';
    return SEP + dir + SEP + body;
}
/**
 * The indices of the quoted empty words (`''`, `""`) that are the value of
 * one of git's global options from w[first]. Without `assign` the statement
 * keeps each as EMPTY_WORD, so a reader of git's words still finds the
 * subcommand after `git -C ''` (GH 2549).
 */
function gitEmptyWords(w, wq, first) {
    const kept = new Set();
    for (let k = first + 1; k < w.length; k++) {
        if (w[k] === '')
            continue;
        if (GIT_VALUE_OPTION.has(w[k])) {
            if (w[k + 1] === '' && wq[k + 1])
                kept.add(k + 1);
            k++;
            continue;
        }
        if (!w[k].startsWith('-'))
            break;
    }
    return kept;
}
/** `export -f`, `declare` / `typeset` with `-f` and `-x`, or `set -a` / `-o allexport`: functions reach the environment of what runs next. */
function fnexport(name, args) {
    const flags = args.filter((a) => /^-[A-Za-z]/.test(a)).join('');
    if (name === 'export')
        return flags.includes('f');
    if (name === 'declare' || name === 'typeset')
        return flags.includes('f') && flags.includes('x');
    if (name === 'set')
        return flags.includes('a') || args.includes('allexport');
    return false;
}
/** A builtin that may call a function an option names: a flag cluster holding its callback option, or a word the shell fills in, which may be one. */
function cbcall(name, args) {
    const flag = CB_FLAGS.get(name);
    if (flag === undefined)
        return false;
    return args.some((a) => /[$`]/.test(a) || ENCODED.test(a) || (a.startsWith('-') && flag.test(a)));
}
export function statementsEnc(buf, base, home, assign, charge = NO_CHARGE, frame = assign) {
    const frames = { ext: [], runs: [], grew: new Set(), lost: new Set(), fnames: new Map(), dyn: false };
    for (;;) {
        frames.grew.clear();
        charge(buf.length);
        const records = scan(buf, base, home, assign, frame, frames, charge);
        if (frames.grew.size === 0)
            return records;
        for (const fo of frames.grew)
            if (++frames.runs[fo] === MAX_GROWTH)
                frames.lost.add(fo);
    }
}
function scan(buf, base, home, assign, frame, frames, charge) {
    const calls = frame === 'calls' || frame === 'escaped';
    const records = [];
    let old = '-';
    let cwhy = '';
    let owhy = '';
    let cond = false;
    let vok = true;
    let vkill = false;
    let vtop = true;
    let vs = '';
    let fsep = '';
    let asg = '';
    let lastout = '';
    let lastdir = '';
    let piped = false;
    let pipesrc = '';
    let cut = false;
    let i = 0;
    let s = base.indexOf(SEP);
    if (s >= 0) {
        old = base.slice(s + 1);
        base = base.slice(0, s);
    }
    s = old.indexOf(SEP);
    if (s >= 0) {
        cwhy = old.slice(s + 1);
        old = old.slice(0, s);
    }
    let alts = base.split(ALT);
    let cur = alts.shift();
    let oalts = [];
    let sp = 0;
    let bt = false;
    let stmt = '';
    let tail = false;
    let owns = false;
    let qsp = 0;
    const stack = [];
    const ostack = [];
    const wstack = [];
    const owstack = [];
    const astack = [];
    const oastack = [];
    const sstack = [];
    const q = [];
    const emit = (dir, text, args = false, cut, wrappers = '', literals = []) => {
        charge(dir.length);
        records.push({
            dir,
            stmt: text,
            ...(args ? { tail: true } : {}),
            ...(cut ? { cut } : {}),
            ...(wrappers !== '' ? { wrappers } : {}),
            ...(literals.length > 0 ? { literals } : {}),
        });
    };
    const loops = [];
    const fids = [];
    const fent = [];
    let nf = 0;
    let unbal = false;
    /** The name of a function whose header was read and whose body has not opened yet. */
    let fpend = null;
    /** The flush reads a statement cut at `(` that may be a function header. */
    let fhead = false;
    const defs = [];
    const fnstack = [];
    const called = new Set();
    /** Per word of the statement being flushed: it held a QM, so it is never a reserved word. */
    let wq = [];
    /**
     * With `frame`, frames a loop's statements: `{` from its while / until or
     * from the `do` or `{` that ends a for / select header, and `}` at the done
     * or `}` that closes it. A `do` no header waits for, or a `done` / `}` that
     * does not close the innermost frame, marks the command unbalanced. A
     * quoted or escaped word is never one of these (POSIX 2.4).
     */
    function loopkw(k) {
        const top = loops.length > 0 ? loops[loops.length - 1] : '';
        if (k === 'while' || k === 'until') {
            loops.push('w');
            fopen();
        }
        else if (k === 'do') {
            if (top === 'w')
                loops[loops.length - 1] = 'o';
            else if (top === 'f') {
                loops[loops.length - 1] = 'o';
                fopen();
            }
            else {
                unbal = true;
                loops.push('o');
                fopen();
            }
        }
        else if (k === '{') {
            if (fpend !== null) {
                loops.push('u');
                fnopen('u');
            }
            else if (top === 'f') {
                loops[loops.length - 1] = 'b';
                fopen();
            }
            else
                loops.push('g');
        }
        else if (k === 'done') {
            if (top === 'o') {
                loops.pop();
                fclose();
            }
            else
                unbal = true;
        }
        else if (k === '}') {
            if (top === 'u') {
                loops.pop();
                fnclose();
            }
            else if (top === 'b') {
                loops.pop();
                fclose();
            }
            else if (top === 'g')
                loops.pop();
            else
                unbal = true;
        }
    }
    /** A frame's `{`: its statements also run in every dir an earlier run saw it end a pass in. */
    function fopen() {
        const fo = nf++;
        fids.push(fo);
        frames.ext[fo] ??= [];
        frames.runs[fo] ??= 0;
        alts = [...alts];
        for (const t of frames.ext[fo])
            altadd(alts, t, cur, cwhy);
        if (frames.lost.has(fo))
            lose();
        bound();
        fent[fo] = { cur, why: cwhy, alts: [...alts] };
        emit(LOOP_OPEN, 'do');
    }
    /** A frame's `}`: an end-of-pass dir its entry lacks grows the frame for the next run; after it, the entry dirs and those. */
    function fclose() {
        const fo = fids.pop();
        const e = fent[fo];
        const ends = cur === e.cur && cwhy === e.why ? [...alts] : [cur, ...alts];
        const known = e.cur === '-' && e.why !== '' ? e.alts : [e.cur, ...e.alts];
        alts = [...e.alts];
        for (const t of ends) {
            if (!known.includes(t) && frames.runs[fo] < MAX_GROWTH && !frames.ext[fo].includes(t)) {
                frames.ext[fo].push(t);
                frames.grew.add(fo);
            }
            altadd(alts, t, e.cur, e.why);
        }
        cur = e.cur;
        cwhy = e.why;
        bound();
        emit(LOOP_CLOSE, 'done');
    }
    /** A new frame's id, with no dirs added yet. */
    function falloc() {
        const fo = nf++;
        frames.ext[fo] ??= [];
        frames.runs[fo] ??= 0;
        return fo;
    }
    /** A frame whose call dirs cannot be pinned: from the next run on its statements run in `-`. */
    function flost(fo) {
        if (frames.lost.has(fo))
            return;
        frames.lost.add(fo);
        frames.grew.add(fo);
    }
    /** The pending function's name, now bound to frame `fo`. */
    function fname(fo) {
        const name = fpend;
        fpend = null;
        const fos = frames.fnames.get(name);
        if (!fos)
            frames.fnames.set(name, [fo]);
        else if (!fos.includes(fo))
            fos.push(fo);
        return name;
    }
    /**
     * A function body's `{` or `(` (GH 2630): its statements also run in every
     * dir a call to it started in on an earlier run. Unpinned (`-`) in an eval
     * body, after a command `fnword` cannot pin, or when a call to the
     * name came before this definition.
     */
    function fnopen(kind) {
        const fo = falloc();
        const name = fname(fo);
        if (frame === 'escaped' || frames.dyn || called.has(name) || HOOK_FN.test(name))
            flost(fo);
        const entry = cur === '-' && cwhy !== '' ? [...alts] : [cur, ...alts];
        const def = { kind, open: true, moved: false, sp, qsp, pre: { cur, why: cwhy, alts }, entry, entered: { cur, alts }, exits: [] };
        defs[fo] = def;
        fnstack.push(fo);
        alts = [...alts];
        for (const t of frames.ext[fo])
            altadd(alts, t, cur, cwhy);
        if (frames.lost.has(fo))
            lose();
        bound();
        def.entered = { cur, alts };
    }
    /**
     * A function body's close: a `{ }` body that moved may return in any dir it
     * ends or runs `return` in, one that never did in the dir it was called in;
     * the definition itself runs nothing, so the dir is the one before it.
     */
    function fnclose() {
        const def = defs[fnstack.pop()];
        def.open = false;
        const { entered } = def;
        if (cur !== entered.cur || alts.length !== entered.alts.length || alts.some((t) => !entered.alts.includes(t)))
            def.moved = true;
        def.exits = def.kind === 'u' && def.moved ? [...new Set([...def.exits, cur, ...alts])] : [];
        cur = def.pre.cur;
        cwhy = def.pre.why;
        alts = def.pre.alts;
    }
    /** A function body that is no `{ }` or `( )`: its statements and every call to it run in `-`. */
    function fnodef() {
        const fo = falloc();
        fname(fo);
        defs[fo] = { kind: 'x', open: false, moved: true, sp, qsp, pre: { cur, why: cwhy, alts }, entry: [], entered: { cur, alts }, exits: [] };
        lose();
    }
    /**
     * A call to `name`: each function frame of that name also runs in the
     * call's dirs, and after it the dir is the call's or any its `{ }` body
     * returns in. A call to a frame still open (recursion), not yet defined
     * this run, or with an unmodeled body leaves `-`.
     */
    function fncall(name) {
        called.add(name);
        const fos = frames.fnames.get(name);
        if (!fos)
            return;
        const here = [cur, ...alts];
        const ends = [];
        let blind = false;
        for (const fo of fos) {
            const def = defs[fo];
            if (def === undefined || def.open || def.kind === 'x') {
                if (def?.kind !== 'x')
                    flost(fo);
                blind = true;
                continue;
            }
            for (const t of here) {
                if (def.entry.includes(t) || frames.ext[fo].includes(t) || frames.runs[fo] >= MAX_GROWTH)
                    continue;
                frames.ext[fo].push(t);
                frames.grew.add(fo);
            }
            if (def.kind === 'u')
                ends.push(...def.exits);
        }
        old = '-';
        owhy = '';
        oalts = [];
        if (blind)
            return lose();
        if (ends.length === 0)
            return;
        alts = [...alts];
        for (const t of ends)
            altadd(alts, t, cur, cwhy);
        bound();
    }
    /** A command `fnword` cannot pin may call any function, so every one runs in `-`, and so does what follows in this shell (`here`) once there are any. */
    function fndyn(here = true) {
        if (!frames.dyn) {
            frames.dyn = true;
            for (const fos of frames.fnames.values())
                for (const fo of fos)
                    flost(fo);
        }
        if (here && frames.fnames.size > 0) {
            lose();
            old = '-';
            owhy = '';
            oalts = [];
        }
    }
    /**
     * The command word of a statement under `calls`: a function call, a
     * `return` from the innermost body, or a word that may call any function:
     * an eval, a trap, an alias, a word from a variable, a builtin's callback
     * option, or a function export, which a `bash -c` body or a script can call
     * in a dir this scan never sees.
     */
    function fnword(w, first) {
        let name = w[first];
        if (name === 'coproc')
            name = w.slice(first + 1).find((x) => x !== '') ?? '';
        if (DYN_CALLS.has(name) || /[$`]/.test(name) || ENCODED.test(name))
            return fndyn();
        if (cbcall(name, w.slice(first + 1)))
            return fndyn();
        if (fnexport(name, w.slice(first + 1)))
            return fndyn(false);
        if (name === 'return' && fnstack.length > 0) {
            const def = defs[fnstack[fnstack.length - 1]];
            for (const t of [cur, ...alts])
                if (!def.exits.includes(t))
                    def.exits.push(t);
            return;
        }
        if (name !== '')
            fncall(name);
    }
    /** The dir becomes `-`, which no why resolves. */
    function lose() {
        cur = '-';
        cwhy = '';
        alts = [];
    }
    /** More than MAX_DIRS dirs collapse to `-`. */
    function bound() {
        if (alts.length >= MAX_DIRS)
            lose();
    }
    /** Adds `t` to the alternate dirs `as` of a dir `d` (why `dw`): once, and not `d` itself unless `d` is a `-` its why resolves. */
    function altadd(as, t, d, dw) {
        if (t === d && (t !== '-' || dw === ''))
            return;
        if (!as.includes(t))
            as.push(t);
    }
    /**
     * The alternate dirs `as` after a `cd p` that took the dir to `d` (why
     * `dw`), and the why: an alternate that `p` alone may resolve (`cd "$d"`)
     * shares `d`'s why, its base `-` when the two bases differ.
     */
    function cdalts(as, p, d, dw) {
        const out = [];
        for (const a of as) {
            const t = resolve(a, p);
            if (t === '-' && d === '-' && dw.includes(WSEP)) {
                const aw = whyof(a, '', p);
                if (aw.includes(WSEP) && aw.slice(aw.indexOf(WSEP)) === dw.slice(dw.indexOf(WSEP))) {
                    if (aw.slice(0, aw.indexOf(WSEP)) !== dw.slice(0, dw.indexOf(WSEP)))
                        dw = '-' + dw.slice(dw.indexOf(WSEP));
                    continue;
                }
            }
            altadd(out, t, d, dw);
        }
        return [out, dw];
    }
    /** The dir token of a statement's dirs: `-` when a loop leaves it more than one. */
    function here() {
        return alts.length > 0 ? '-' : cur;
    }
    function altTok(as) {
        return as.map((a) => ALT + a).join('');
    }
    /** A for / select header at w[k]: waits for its `do` or `{`, which the statement holds itself when that word comes right after NAME. */
    function forhead(w, k) {
        loops.push('f');
        let c = 0;
        for (k++; k < w.length && c < 2; k++) {
            if (w[k] === '')
                continue;
            if (++c === 2 && !wq[k] && (w[k] === 'do' || w[k] === '{'))
                loopkw(w[k]);
        }
    }
    /** The compound command after coproc [NAME] or function NAME: a for / select header, or a while / until / `{`. */
    function loopprefix(w, first) {
        let c = 0;
        for (let k = first + 1; k < w.length && c < 2; k++) {
            if (w[k] === '')
                continue;
            c++;
            if (wq[k])
                continue;
            if (w[k] === 'for' || w[k] === 'select') {
                forhead(w, k);
                return;
            }
            if (/^(while|until|\{)$/.test(w[k])) {
                loopkw(w[k]);
                return;
            }
        }
    }
    function closepar(pos) {
        let d = 0;
        for (let k = pos; k < buf.length; k++) {
            const ch = buf[k];
            if (ch === '(')
                d++;
            else if (ch === ')') {
                d--;
                if (d === 0)
                    return k;
            }
        }
        return -1;
    }
    function forsrc(pos) {
        if (!FOR_HEAD.test(stmt))
            return '';
        const j = closepar(pos);
        if (j < 0)
            return '';
        let k = j + 1;
        while (k < buf.length && /[ \t]/.test(buf[k]))
            k++;
        if (k < buf.length && !/[;\n]/.test(buf[k]))
            return '';
        return srcmark(buf.slice(pos + 1, j), here());
    }
    function donesrc(pos) {
        let depth = 0;
        let atcmd = true;
        let pd = 0;
        let k = pos;
        const m = buf.length;
        while (k < m) {
            let ch = buf[k];
            if (/[ \t]/.test(ch)) {
                k++;
                continue;
            }
            if (/[;\n&|`]/.test(ch) || ch === QO || ch === QC) {
                atcmd = true;
                k++;
                continue;
            }
            if (ch === '(') {
                pd++;
                atcmd = true;
                k++;
                continue;
            }
            if (ch === ')') {
                if (--pd < 0)
                    return '';
                atcmd = false;
                k++;
                continue;
            }
            if (ch === '<' || ch === '>') {
                atcmd = false;
                k++;
                continue;
            }
            let w = '';
            while (k < m) {
                ch = buf[k];
                if (/[ \t;\n&|()<>`]/.test(ch) || ch === QO || ch === QC)
                    break;
                w += ch;
                k++;
            }
            if (atcmd && w === 'do') {
                depth++;
                continue;
            }
            if (atcmd && w === 'done') {
                if (--depth < 0)
                    return '';
                if (depth > 0) {
                    atcmd = false;
                    continue;
                }
                while (k < m && /[ \t]/.test(buf[k]))
                    k++;
                if (buf[k] !== '<')
                    return '';
                k++;
                while (k < m && /[ \t]/.test(buf[k]))
                    k++;
                if (buf.slice(k, k + 2) !== '<(')
                    return '!';
                const j = closepar(k + 1);
                if (j < 0)
                    return '!';
                const mark = srcmark(buf.slice(k + 2, j), here());
                return mark === '' ? '!' : mark;
            }
            atcmd = atcmd && /^(then|else|elif|if|while|until|!|\{|\}|time)$/.test(w);
        }
        return '';
    }
    function getvar(name) {
        if (!vok || !vtop)
            return BAD;
        let v = BAD;
        const entries = vs.split(VSEP);
        for (let k = 1; k < entries.length; k++) {
            const j = entries[k].indexOf(VEQ);
            if ((j < 0 ? '' : entries[k].slice(0, j)) === name)
                v = entries[k].slice(j + 1);
        }
        return v;
    }
    function subst(p) {
        let out = '';
        let m;
        while ((m = p.indexOf('$')) >= 0) {
            out += p.slice(0, m);
            const rest = p.slice(m + 1);
            let name;
            let len;
            let hit = BRACED.exec(rest);
            if (hit) {
                name = hit[0].slice(1, -1);
                len = hit[0].length;
            }
            else if ((hit = NAME.exec(rest))) {
                name = hit[0];
                len = hit[0].length;
            }
            else
                return BAD;
            const v = getvar(name);
            if (v === BAD)
                return BAD;
            out += v;
            p = rest.slice(len);
        }
        return out + p;
    }
    /** Whether <word> holds a `$NAME` or `${NAME}` and every expansion in it resolves to a value that leaves <word> one literal word, unquoted (GH 2643). */
    function literalword(word) {
        return word.includes('$') && isOneWord(subst(word));
    }
    function assignword(a, uncertain) {
        const j = a.indexOf('=');
        const nm = a.slice(0, j);
        let v = a.slice(j + 1);
        if (VSPECIAL.test(nm))
            return false;
        if (uncertain || /[$`*?[~\\\x01-\x13]/.test(v))
            v = BAD;
        vs += VSEP + nm + VEQ + v;
        return true;
    }
    function whyof(d, dw, p) {
        if (/^[$`/~]/.test(p) || d !== '-')
            return d + WSEP + p;
        if (dw === '')
            return '';
        return dw + '/' + p;
    }
    function resolve(d, p) {
        if (p.includes('$') && !/[`\x01-\x06\x0e-\x13]/.test(p)) {
            p = subst(p);
            if (p === BAD)
                return '-';
        }
        if (p === '' || /[$`\x01-\x06\x0e-\x13]/.test(p))
            return '-';
        if (p === '~')
            p = home;
        else if (p.startsWith('~/'))
            p = home + p.slice(1);
        if (p.startsWith('/'))
            return norm(p);
        if (d === '-')
            return '-';
        return norm(d + '/' + p);
    }
    function vend(ok) {
        if (vtop) {
            if (!ok || vkill)
                vok = false;
            vkill = false;
        }
    }
    /**
     * Quoted operator chars are data; each `<<` must carry encode.ts's HD_DATA
     * mark. A literal redirect is plain unless a `(` or backtick cut the
     * statement short, where its target runs on into the substitution.
     */
    function vplainexp(text, whole) {
        if (whole)
            text = text.replace(LITERAL_REDIRECT, '$1');
        const parts = text.split('<<');
        for (let k = 1; k < parts.length; k++) {
            if (!parts[k].startsWith(HD_DATA))
                return false;
            parts[k] = parts[k].slice(1);
        }
        text = parts.join('');
        const t = text.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '');
        for (const ch of VBAD)
            if (t.includes(ch))
                return false;
        return plainDollars(text);
    }
    /**
     * Sets `owns`: the statement's command word comes before its last word, or
     * it is itself a tail. `sub`: without `assign`, an unquoted $( ) or backtick
     * follows without leaving a word of its own, so a blank right before it
     * makes it a word after the command word (GH 2381).
     */
    function flush(sub = false) {
        const args = tail;
        tail = false;
        owns = args;
        const chained = fsep === '&&';
        fsep = '';
        vtop = sp === 0 && qsp === 0 && !bt;
        const whole = !cut;
        cut = false;
        if (!vplainexp(stmt.replaceAll(QM, ''), whole))
            vok = false;
        stmt = unmark(stmt);
        const csure = !cond;
        cond = false;
        const w = splitWords(stmt);
        wq = w.map((word) => word.includes(QM));
        for (let k = 0; k < w.length; k++)
            w[k] = w[k].replaceAll(QM, '');
        const n = w.length;
        stmt = '';
        let first = 0;
        let wrapAt = -1;
        asg = '';
        let cdw = '';
        const chdirs = [];
        const aw = [];
        const wrapped = [];
        let plain = true;
        const waspiped = piped;
        piped = false;
        lastout = '';
        lastdir = here();
        let sawwhile = false;
        while (first < n) {
            if (w[first] === '') {
                first++;
                continue;
            }
            if (fpend !== null && (w[first] !== '{' || wq[first]))
                fnodef();
            if (calls && fpend === null && w[first] === 'function' && !wq[first]) {
                let k = first + 1;
                while (k < n && w[k] === '')
                    k++;
                if (k < n) {
                    fpend = w[k];
                    first = k + 1;
                    continue;
                }
            }
            if (w[first] === 'while')
                sawwhile = true;
            if (KEYWORD.test(w[first])) {
                if (frame && !wq[first])
                    loopkw(w[first]);
                plain = false;
                first++;
                continue;
            }
            if (ASSIGNMENT.test(w[first])) {
                asg += (asg === '' ? '' : ' ') + w[first];
                aw.push(w[first]);
                first++;
                continue;
            }
            const op = assign ? null : REDIRECT_WORD.exec(w[first]);
            if (op) {
                first++;
                if (op[0] === w[first - 1] && op[2] !== '<<') {
                    while (first < n && w[first] === '')
                        first++;
                    first++;
                }
                plain = false;
                continue;
            }
            if (w[first] === 'time') {
                let k = first + 1;
                while (k < n && w[k].startsWith('-'))
                    k++;
                if (k < n && ASSIGNMENT.test(w[k])) {
                    if (wrapAt < 0)
                        wrapAt = first;
                    first = k;
                    plain = false;
                    continue;
                }
            }
            if (WRAPPER.test(w[first])) {
                if (wrapAt < 0)
                    wrapAt = first;
                const u = unwrap(w, first);
                for (let k = first; k < u.k; k++)
                    if (PS4_WORD.test(w[k]))
                        wrapped.push(w[k]);
                first = u.k;
                plain = false;
                for (const dir of u.dirs) {
                    chdirs.push(dir);
                    cdw += (cdw === '' ? '' : ' ') + '--chdir=' + dir;
                }
                continue;
            }
            break;
        }
        if (!assign) {
            const decl = first < n && !wq[first] && DECLARE.test(w[first]) ? w.slice(first + 1) : [];
            for (const word of [...aw, ...wrapped, ...decl])
                if (PS4_WORD.test(word))
                    emit(here(), word, args, sub ? (w[n - 1] === '' ? 'word' : 'glued') : undefined);
        }
        if (calls && w.some((x) => HOOK_ARRAY.test(x)))
            fndyn();
        if (fhead && fpend === null && first < n && w.slice(first + 1).every((x) => x === '')) {
            fpend = w[first];
            vend(true);
            return;
        }
        if (first >= n) {
            let ok = plain;
            if (vtop && plain && !args)
                for (const a of aw)
                    if (fnstack.length > 0 || !assignword(a, !csure))
                        ok = false;
            if (assign && asg !== '') {
                emit('=' + cur + altTok(alts) + SEP + (oalts.length > 0 ? '-' : old), asg, args);
                if (!chained && !args) {
                    old = '-';
                    owhy = '';
                    oalts = [];
                }
            }
            vend(ok);
            return;
        }
        let a0 = w[first];
        if (!args)
            owns = w.slice(first + 1).some((x) => x !== '') || (sub && w[n - 1] === '');
        if (frame && !wq[first] && (a0 === 'for' || a0 === 'select'))
            forhead(w, first);
        else if (frame && !wq[first] && (a0 === 'coproc' || a0 === 'function'))
            loopprefix(w, first);
        let ok = plain && aw.length === 0;
        if (ok && a0 === 'export') {
            for (let k = first + 1; k < n; k++) {
                if (w[k] === '')
                    continue;
                if (!ASSIGNMENT.test(w[k]))
                    ok = false;
                else if (vtop && !args && (fnstack.length > 0 || !assignword(w[k], !csure)))
                    ok = false;
            }
        }
        else if (ok) {
            ok = VPLAIN.test(a0);
        }
        const shown = (k) => (w[k] === '' && wq[k] ? EMPTY_WORD : w[k]);
        const gitAt = (from) => {
            const live = [];
            for (let k = from; k < n; k++)
                if (shown(k) !== '')
                    live.push(k);
            const found = gitWord(live.map(shown));
            return found === null ? -1 : live[found.at];
        };
        let gi = gitAt(first);
        if (gi < 0 && wrapAt >= 0) {
            const wrappedGit = gitAt(wrapAt);
            if (wrappedGit >= first)
                gi = wrappedGit;
        }
        const kept = !assign && gi >= 0 ? gitEmptyWords(w, wq, gi) : new Set();
        if (!assign)
            for (let k = first + 1; k < gi; k++)
                if (w[k] === '' && wq[k])
                    kept.add(k);
        const cutAt = sub && (gi >= 0 || CUT_KEPT.test(a0)) ? (w[n - 1] === '' ? 'word' : 'glued') : undefined;
        const wrappers = !assign && gi >= 0 && wrapAt >= 0 ? Array.from({ length: first - wrapAt }, (_, j) => shown(wrapAt + j)).filter((word) => word !== '').join(' ') : '';
        const literals = [];
        let out = a0;
        for (let k = first + 1; k < n; k++) {
            if (w[k] !== '')
                out += ' ' + w[k];
            else if (kept.has(k))
                out += ' ' + EMPTY_WORD;
        }
        if (cdw !== '' && assign) {
            out = cdw + ' ' + out;
            a0 = '';
        }
        else if (cdw !== '' && /^(cd|pushd|popd)$/.test(a0))
            a0 = '';
        lastout = out;
        const at = { cur, alts };
        let d = cur;
        let da = alts;
        const o = oalts.length > 0 ? '-' : old;
        let dw = cwhy;
        if (!assign) {
            for (const p of chdirs) {
                const t = resolve(d, p);
                dw = t === '-' ? whyof(d, dw, p) : '';
                d = t;
                [da, dw] = cdalts(da, p, d, dw);
            }
        }
        if (!args && (a0 === 'cd' || a0 === 'pushd')) {
            let p = '';
            for (let k = first + 1; k < n; k++) {
                if (w[k] === '')
                    continue;
                if (/^-[LPe@]+$/.test(w[k]))
                    continue;
                p = w[k];
                break;
            }
            if (p === '-' && a0 === 'cd') {
                [cur, old] = [old, cur];
                [cwhy, owhy] = [owhy, cwhy];
                [alts, oalts] = [oalts, alts];
            }
            else if (p === '' || p === '-') {
                old = cur;
                owhy = cwhy;
                oalts = alts;
                cur = '-';
                alts = [];
                cwhy = p === '' && a0 === 'cd' ? '-' + WSEP + '$HOME' : '';
            }
            else {
                old = cur;
                owhy = cwhy;
                oalts = alts;
                const t = resolve(cur, p);
                cwhy = t === '-' ? whyof(cur, cwhy, p) : '';
                cur = t;
                [alts, cwhy] = cdalts(oalts, p, cur, cwhy);
            }
        }
        else if (!args && a0 === 'popd') {
            old = cur;
            owhy = cwhy;
            oalts = alts;
            cur = '-';
            alts = [];
            cwhy = '';
        }
        else if (assign && a0 === 'read') {
            let mk = sawwhile ? donesrc(i) : '';
            if (mk === '' && waspiped)
                mk = pipesrc;
            if (mk !== '' && mk !== '!')
                out += ' ' + mk;
        }
        else if (assign && a0 === 'xargs') {
            if (waspiped && pipesrc !== '')
                out += ' ' + pipesrc;
        }
        if (gi >= 0 && (cdw === '' || !assign)) {
            const literal = (value) => {
                if (!assign && literalword(value))
                    literals.push(value);
            };
            for (let k = gi + 1; k < n; k++) {
                if (w[k] === '')
                    continue;
                if (w[k] === '-C') {
                    if (kept.has(k + 1)) {
                        k++;
                        continue;
                    }
                    literal(w[k + 1] ?? '');
                    const t = resolve(d, w[k + 1] ?? '');
                    dw = t === '-' ? whyof(d, dw, w[k + 1] ?? '') : '';
                    d = t;
                    [da, dw] = cdalts(da, w[k + 1] ?? '', d, dw);
                    k++;
                    continue;
                }
                if (GIT_VALUE_OPTION.has(w[k])) {
                    literal(w[k + 1] ?? '');
                    k++;
                    continue;
                }
                if (GIT_VALUE_JOINED.test(w[k]))
                    literal(w[k].replace(GIT_VALUE_JOINED, ''));
                if (w[k].startsWith('-'))
                    continue;
                break;
            }
        }
        if (calls && !args)
            fnword(w, first);
        if (cur !== at.cur || alts !== at.alts)
            for (const fo of fnstack)
                if (defs[fo].sp === sp && defs[fo].qsp === qsp)
                    defs[fo].moved = true;
        emit(d + altTok(da) + (assign ? SEP + o + (d === '-' && dw !== '' ? SEP + dw : '') : ''), out, args, cutAt, wrappers, literals);
        if (!chained && !args) {
            old = '-';
            owhy = '';
            oalts = [];
        }
        vend(ok);
    }
    function push() {
        ostack[sp + 1] = old;
        wstack[sp + 1] = cwhy;
        owstack[sp + 1] = owhy;
        astack[sp + 1] = alts;
        oastack[sp + 1] = oalts;
        stack[++sp] = cur;
    }
    function pop() {
        if (sp > 0) {
            old = ostack[sp];
            cwhy = wstack[sp];
            owhy = owstack[sp];
            alts = astack[sp];
            oalts = oastack[sp];
            cur = stack[sp--];
        }
    }
    for (i = 0; i < buf.length; i++) {
        const c = buf[i];
        const nx = buf[i + 1] ?? '';
        const prev = i > 0 ? buf[i - 1] : '';
        if (c === QO) {
            qsp++;
            q[qsp] = { stmt, tail, cur, old, start: i + 1, sp, why: cwhy, owhy, alts, oalts };
            vkill = true;
            stmt = '';
            tail = false;
            continue;
        }
        if (c === QC) {
            if (qsp === 0)
                continue;
            flush();
            const f = q[qsp];
            stmt = f.stmt + '$' + ENC[8] + rawword(buf.slice(f.start, i)) + ENC[9];
            tail = f.tail;
            cur = f.cur;
            old = f.old;
            sp = f.sp;
            cwhy = f.why;
            owhy = f.owhy;
            alts = f.alts;
            oalts = f.oalts;
            qsp--;
            continue;
        }
        if (c === '\n' || c === ';') {
            flush();
            continue;
        }
        if (c === '&') {
            if (nx === '>' || prev === '>' || prev === '<') {
                stmt += c;
                continue;
            }
            if (nx === '&') {
                i++;
                fsep = '&&';
                flush();
                cond = true;
            }
            else {
                vkill = true;
                flush();
            }
            continue;
        }
        if (c === '|') {
            if (prev === '>') {
                stmt += c;
                continue;
            }
            const p1 = nx !== '|' && nx !== '&';
            if (!p1)
                i++;
            vkill = true;
            flush();
            if (assign && p1) {
                piped = true;
                pipesrc = lastout !== '' ? srcmark(lastout, lastdir) : '';
            }
            continue;
        }
        if (c === '(') {
            const last = stmt.slice(-1);
            if (calls && last !== '$' && last !== '<' && last !== '>' && FN_HEAD.test(stmt)) {
                let j = i + 1;
                while (buf[j] === ' ' || buf[j] === '\t')
                    j++;
                if (buf[j] === ')') {
                    fhead = true;
                    flush();
                    fhead = false;
                    if (fpend !== null) {
                        i = j;
                        continue;
                    }
                }
            }
            vkill = true;
            if (last === '$' || last === '<' || last === '>') {
                if (assign && last === '$')
                    stmt = stmt + ENC[8] + ENC[9] + forsrc(i);
                else
                    stmt = stmt.slice(0, -1);
            }
            cut = true;
            flush(!assign && last === '$');
            push();
            sstack[sp] = last === '$' && owns;
            if (fpend !== null)
                fnopen('p');
            continue;
        }
        if (c === ')') {
            flush();
            if (sp === 0)
                vok = false;
            const top = fnstack.length > 0 ? defs[fnstack[fnstack.length - 1]] : undefined;
            if (top?.kind === 'p' && top.sp === sp)
                fnclose();
            const closes = sp > 0 && sstack[sp];
            pop();
            tail = closes;
            continue;
        }
        if (c === '`') {
            vkill = true;
            if (assign && !bt)
                stmt += '$' + ENC[8] + ENC[9];
            cut = true;
            flush(!assign && !bt);
            if (bt) {
                bt = false;
                const closes = sp > 0 && sstack[sp];
                pop();
                tail = closes;
            }
            else {
                bt = true;
                push();
                sstack[sp] = owns;
            }
            continue;
        }
        stmt += c;
    }
    flush();
    if (assign && (unbal || loops.length > 0))
        emit(UNBALANCED, 'unbalanced');
    return records.filter((r) => r.stmt !== '');
}
//# sourceMappingURL=statements.js.map