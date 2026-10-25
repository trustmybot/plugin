import { decode, encode } from './encode.js';
import { SEP, WSEP, statementsEnc } from './statements.js';
import { stmtWritePaths } from './targets.js';
const BAD = '\x01';
const DEFERRED_VALUE = '\x1e';
const DEFERRED = '$(deferred)';
const MAX_DEPTH = 3;
const LISTERS = /^(find|ls|git|rg|fd|fdfind)$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIND_ACTIONS = /^(-exec|-execdir|-ok|-okdir|-delete|-fprint|-fprint0|-fprintf|-fls)$/;
const FD_ACTIONS = /^(-x|--exec|-X|--exec-batch)$/;
const PY_RUNNERS = /^(timeit|cProfile|profile|trace|pdb|runpy|code|doctest|pydoc|pickle|py_compile|compileall)$/;
const basename = (w) => w.replace(/.*\//, '');
const chomp = (s) => s.replace(/\n+$/, '');
const dec = (s) => chomp(decode(s));
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
/** _tmb_cmd_inner: the -c string of a shell or the rest of an eval. */
function inner(stmt) {
    const words = shellWords(stmt);
    const argv0 = words[0] ?? '';
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
    return '';
}
/** _tmb_cmd_interp_writes' trigger: the interpreter of a one-liner with a program, or of `python -m <runner>`. */
function interpreterProgram(words) {
    const argv0 = basename(words[0]);
    let flags;
    let pyopt = false;
    if (/^(python|python3|python[23]\..*)$/s.test(argv0)) {
        flags = ['-c'];
        pyopt = true;
    }
    else if (argv0 === 'node' || argv0 === 'nodejs')
        flags = ['-e', '--eval', '-p', '--print'];
    else if (argv0 === 'perl')
        flags = ['-e', '-E'];
    else if (argv0 === 'ruby')
        flags = ['-e'];
    else
        return false;
    let optarg = false;
    let k = 1;
    while (k < words.length) {
        const w = words[k++];
        if (pyopt) {
            const m = /^-[bBdEhiIOPqRsSuvx]*m(.*)$/s.exec(w);
            if (m) {
                pyopt = false;
                if (PY_RUNNERS.test(dec(m[1] || (words[k] ?? ''))))
                    return true;
            }
            else if (optarg)
                optarg = false;
            else if (w === '-W' || w === '-X')
                optarg = true;
            else if (!w.startsWith('-'))
                pyopt = false;
        }
        if (flags.includes(w))
            return dec(words[k] ?? '') !== '';
    }
    return false;
}
/** _tmb_cmd_stdin_interp: the interpreter kind that reads its program from stdin, '' for none. */
function stdinInterp(words) {
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
        return '';
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
            return kind;
        const kw = `${kind}:${w}`;
        if (w.startsWith('--')) {
            if (/^node:--(eval|print)(=.*)?$/s.test(kw))
                return '';
            if (/^node:--(require|import|loader|input-type)$/.test(kw))
                skip = true;
            continue;
        }
        if (w.startsWith('-')) {
            if (/^(py:-.*c|py:-.*m$|node:-[ep]$|perl:-.*[eE]|ruby:-.*e|sh:-.*c)/s.test(kw))
                return '';
            if (/^sh:-.*s/s.test(kw))
                return kind;
            if (/^(py:-[WX]|node:-r|ruby:-[rI]|perl:-[IM]|sh:-[oO])$/.test(kw))
                skip = true;
            continue;
        }
        return '';
    }
    return kind;
}
function stdinProgram(words) {
    return words.some((w) => w.startsWith('<<<') || (w.startsWith('<<') && w.length > 2));
}
/** _tmb_cmd_exec_writes' trigger: a find / fd action, or a command xargs runs. */
function runsCommand(words) {
    const tool = basename(words[0]);
    if (tool === 'find')
        return words.slice(1).some((w) => FIND_ACTIONS.test(w));
    if (tool === 'fd' || tool === 'fdfind')
        return words.slice(1).some((w) => FD_ACTIONS.test(w));
    if (tool !== 'xargs')
        return false;
    const n = words.length;
    let k = 1;
    while (k < n) {
        const p = words[k];
        if (p === '--') {
            k++;
            break;
        }
        if (p === '-I' || p === '-J' || p === '-a' || p === '--arg-file')
            k += 2;
        else if (/^(-d|-E|-L|-n|-P|-s|-R|-S|--delimiter|--max-lines|--max-args|--max-procs|--max-chars)$/.test(p))
            k += 2;
        else if (p.startsWith('-'))
            k++;
        else
            break;
    }
    return k < n;
}
class WritePaths {
    parser;
    opts;
    out = '';
    pwd = '';
    constructor(parser, opts) {
        this.parser = parser;
        this.opts = opts;
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
    varGet(vars, name) {
        let found = false;
        let out = '';
        for (const line of vars.split('\n')) {
            if (!line.startsWith(name + '\t'))
                continue;
            out += after(line, '\t') + '\n';
            found = true;
        }
        return found ? chomp(out) : null;
    }
    /** _tmb_cmd_expand: every value a word expands to (at most 16), or the variable that stops it. */
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
            let cut = '';
            if (rest.startsWith('$(proc)'))
                return fail('$(proc)');
            if (rest.startsWith('$(alias-write)'))
                return fail('$(alias-write)');
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
                else if (op.startsWith(':-') || op.startsWith(':='))
                    def = op.slice(2);
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
            let vals = this.varGet(level.vars, name);
            if (vals !== null) {
                if (vals.includes(BAD))
                    return fail(name);
                if (vals.includes(DEFERRED_VALUE))
                    return fail(DEFERRED);
            }
            else if (def !== null) {
                if (/[$`]/.test(def))
                    return fail(name);
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
    varSet(level, name, value) {
        if (!VAR_NAME.test(name))
            return;
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
    /** _tmb_cmd_emit */
    emit(level, dir, p, why = level.why) {
        if (dir === '-' && why !== '' && !/^[/~$`]/.test(p)) {
            let v = dec(after(why, WSEP));
            if (p !== '.')
                v = `${v.replace(/\/$/, '')}/${p}`;
            this.emit(level, before(why, WSEP), v, '');
            return;
        }
        if (!/[$`]/.test(p)) {
            this.out += this.join(dir, p);
            return;
        }
        this.pwd = dirPath(dir, this.opts.cwd);
        const e = this.expand(p, level);
        if (e.ok) {
            for (const v of e.values)
                this.out += this.join(dir, v);
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
        this.out += `UNRESOLVED:${e.unres}:${p}\n`;
    }
    deferred(word) {
        this.out += `UNRESOLVED:${DEFERRED}:${word}\n`;
    }
    /**
     * _tmb_cmd_loop_source, deferred: a source _tmb_cmd_lister_bind would try to
     * bind leaves the variable deferred; false, nothing recorded, for one it
     * would refuse before looking at the lister's arguments.
     */
    loopSource(level, name, mark, word) {
        let m = mark.replace(/^\x12/, '');
        const dirtok = before(m, SEP);
        m = dec(m.slice(dirtok.length).replace(/^\x12/, ''));
        const first = before(before(m, '\n'), SEP);
        if (this.opts.root === '' || !VAR_NAME.test(name))
            return false;
        if (dirPath(dirtok, this.opts.cwd) === '' || !LISTERS.test(basename(first)))
            return false;
        level.vars += `${name}\t${DEFERRED_VALUE}\n`;
        this.deferred(word);
        return true;
    }
    /** _tmb_cmd_track_vars */
    trackVars(level, words) {
        switch (basename(words[0])) {
            case 'export':
            case 'declare':
            case 'typeset':
            case 'local':
            case 'readonly':
                for (const w of words.slice(1)) {
                    if (/^[A-Za-z_].*=/s.test(w))
                        this.varSet(level, before(w, '='), dec(after(w, '=')));
                }
                return;
            case 'for': {
                if (words[2] !== 'in') {
                    level.vars += `${words[1] ?? ''}\t${BAD}\n`;
                    return;
                }
                const name = words[1] ?? '';
                const rest = words.slice(3);
                if (rest.length === 1 && rest[0].startsWith('$\x0f\x10\x12')) {
                    if (!this.loopSource(level, name, rest[0].slice(3), 'for'))
                        level.vars += `${name}\t${BAD}\n`;
                    return;
                }
                for (const w of rest)
                    this.varSet(level, name, dec(w));
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
                if (names.length === 1 && mk !== '' && mk !== '!' && this.loopSource(level, names[0], mk, 'read'))
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
    /** _tmb_cmd_write_paths_in */
    run(cmd, base, depth, vars) {
        const encoded = encode(this.parser, cmd);
        if (!encoded.ok) {
            this.out += `UNRESOLVED:$(parse):${[...cmd].slice(0, 80).join('').replace(/[\r\n]/g, ' ')}\n`;
            return;
        }
        const level = { vars, oldtok: '-', why: '' };
        const { cwd } = this.opts;
        for (const record of statementsEnc(encoded.text, base, this.opts.env.HOME ?? '', true)) {
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
                this.pwd = dirPath(dir.slice(1), cwd);
                for (const w of words)
                    this.varSet(level, before(w, '='), dec(after(w, '=')));
                continue;
            }
            const tok = dir + SEP + old + (why === '' ? '' : SEP + why);
            if (depth < MAX_DEPTH) {
                const body = inner(record.stmt);
                if (body !== '') {
                    this.run(dec(body), tok, depth + 1, level.vars);
                    continue;
                }
            }
            let stmt = record.stmt;
            if (basename(words[0]) === 'xargs' && words[words.length - 1].startsWith(SEP)) {
                words = words.slice(0, -1);
                stmt = words.join(' ');
            }
            const chain = dir === '-' && why === '';
            const written = stmtWritePaths(stmt, chain);
            for (const p of written.paths)
                if (p !== '')
                    this.emit(level, dir, dec(p));
            if (written.words.length > 1 && interpreterProgram(written.words))
                this.deferred(basename(written.words[0]));
            if (runsCommand(words))
                this.deferred(basename(words[0]));
            if (stdinInterp(words) !== '' && stdinProgram(words))
                this.deferred(basename(words[0]));
            this.pwd = dirPath(dir, cwd);
            this.trackVars(level, words);
        }
    }
}
/** The lines tmb_cmd_write_paths prints for `command`, parsed with the given tree-sitter-bash parser. */
export function writePathsWith(parser, command, opts) {
    const w = new WritePaths(parser, opts);
    w.run(command, '@', 0, '');
    const lines = w.out.split('\n');
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
//# sourceMappingURL=write-paths.js.map