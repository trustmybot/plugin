/**
 * _tmb_cmd_statements_enc (cmd-analysis.sh) on an encoded skeleton: one
 * `<dir-token>\t<encoded statement>` record per executable statement, the
 * effective dir tracked through cd / pushd / popd / cd - / git -C / subshells
 * and $VAR dirs resolved from a flat allowlisted prefix. With `assign`,
 * assignment-only statements come out as `=<dir-token>` records, every dir
 * token carries \022<old-dir-token>[\022<why>], an unquoted $( ) or backtick
 * leaves `$()` (encoded) where it stood, and a loop's source is attached as a
 * \022<dir>\022<word>… mark, and a loop's statements sit between a `{` and a
 * `}` record (GH 1944), with a last `!` record when those frames do not
 * balance. The TS keeps `time NAME=value` an assignment
 * (GH 1739): `time` is a reserved word, so the shell still sets the name.
 */
import { ENC, HD_DATA, QC, QO, SUB_PC, SUB_PO, plainDollars } from './encode.js';
import { ASSIGNMENT, WRAPPER, splitWords, unwrap } from './unwrap.js';
export const SEP = '\x12';
export const LOOP_OPEN = '{';
export const LOOP_CLOSE = '}';
export const UNBALANCED = '!';
export const WSEP = '\x14';
const VSEP = '\x1c';
const VEQ = '\x1d';
const BAD = '\x01';
const VPLAIN = /^(cd|git|echo|true|false|ls|cat|pwd|mkdir|touch)$/;
const VBAD = '*?[](){<>`';
const HD_MARK = /<<[\x1a\x1e]/g;
const VSPECIAL = /^(IFS|PWD|OLDPWD|RANDOM|SRANDOM|SECONDS|LINENO|EPOCHSECONDS|EPOCHREALTIME|BASHPID|PPID|UID|EUID|GROUPS|HISTCMD|PIPESTATUS|FUNCNAME|BASH_[A-Z_]*)$/;
const KEYWORD = /^(\{|\}|!|if|then|else|elif|do|while|until|fi|done|esac)$/;
const ENCODED = /[\x01-\x06\x0e-\x13]/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const BRACED = /^\{[A-Za-z_][A-Za-z0-9_]*\}/;
const FOR_HEAD = /^[ \t]*(((do|then|else|elif|\{|!)[ \t]+)*)for[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]+in[ \t]+\$$/;
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
    body = unmark(body);
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
export function statementsEnc(buf, base, home, assign) {
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
    let cur = base;
    let sp = 0;
    let bt = false;
    let stmt = '';
    let qsp = 0;
    const stack = [];
    const ostack = [];
    const wstack = [];
    const owstack = [];
    const q = [];
    const emit = (dir, text) => records.push({ dir, stmt: text });
    const loops = [];
    let unbal = false;
    /**
     * With `assign`, frames a loop's statements: `{` from its while / until or
     * from the `do` or `{` that ends a for / select header, and `}` at the done
     * or `}` that closes it. A `do` no header waits for, or a `done` / `}` that
     * does not close the innermost frame, marks the command unbalanced.
     */
    function loopkw(k) {
        const top = loops.length > 0 ? loops[loops.length - 1] : '';
        if (k === 'while' || k === 'until') {
            loops.push('w');
            emit(LOOP_OPEN, 'do');
        }
        else if (k === 'do') {
            if (top === 'w')
                loops[loops.length - 1] = 'o';
            else if (top === 'f') {
                loops[loops.length - 1] = 'o';
                emit(LOOP_OPEN, 'do');
            }
            else {
                unbal = true;
                loops.push('o');
                emit(LOOP_OPEN, 'do');
            }
        }
        else if (k === '{') {
            if (top === 'f') {
                loops[loops.length - 1] = 'b';
                emit(LOOP_OPEN, 'do');
            }
            else
                loops.push('g');
        }
        else if (k === 'done') {
            if (top === 'o') {
                loops.pop();
                emit(LOOP_CLOSE, 'done');
            }
            else
                unbal = true;
        }
        else if (k === '}') {
            if (top === 'b') {
                loops.pop();
                emit(LOOP_CLOSE, 'done');
            }
            else if (top === 'g')
                loops.pop();
            else
                unbal = true;
        }
    }
    /** A for / select header at w[k]: waits for its `do` or `{`, which the statement holds itself when that word comes right after NAME. */
    function forhead(w, k) {
        loops.push('f');
        let c = 0;
        for (k++; k < w.length && c < 2; k++) {
            if (w[k] === '')
                continue;
            if (++c === 2 && (w[k] === 'do' || w[k] === '{'))
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
        return srcmark(buf.slice(pos + 1, j), cur);
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
                const mark = srcmark(buf.slice(k + 2, j), cur);
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
    /** Quoted operator chars are data; each `<<` must carry encode.ts's HD_DATA mark. */
    function vplainexp(text) {
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
    function flush() {
        const chained = fsep === '&&';
        fsep = '';
        vtop = sp === 0 && qsp === 0 && !bt;
        if (!vplainexp(stmt))
            vok = false;
        stmt = unmark(stmt);
        const csure = !cond;
        cond = false;
        const w = splitWords(stmt);
        const n = w.length;
        stmt = '';
        let first = 0;
        asg = '';
        let cdw = '';
        const aw = [];
        let plain = true;
        const waspiped = piped;
        piped = false;
        lastout = '';
        lastdir = cur;
        let sawwhile = false;
        while (first < n) {
            if (w[first] === '') {
                first++;
                continue;
            }
            if (w[first] === 'while')
                sawwhile = true;
            if (KEYWORD.test(w[first])) {
                if (assign)
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
            if (w[first] === 'time') {
                let k = first + 1;
                while (k < n && w[k].startsWith('-'))
                    k++;
                if (k < n && ASSIGNMENT.test(w[k])) {
                    first = k;
                    plain = false;
                    continue;
                }
            }
            if (WRAPPER.test(w[first])) {
                const u = unwrap(w, first);
                first = u.k;
                plain = false;
                for (const dir of u.dirs)
                    cdw += (cdw === '' ? '' : ' ') + '--chdir=' + dir;
                continue;
            }
            break;
        }
        if (first >= n) {
            let ok = plain;
            if (vtop && plain)
                for (const a of aw)
                    if (!assignword(a, !csure))
                        ok = false;
            if (assign && asg !== '') {
                emit('=' + cur + SEP + old, asg);
                if (!chained) {
                    old = '-';
                    owhy = '';
                }
            }
            vend(ok);
            return;
        }
        let a0 = w[first];
        if (assign && (a0 === 'for' || a0 === 'select'))
            forhead(w, first);
        else if (assign && (a0 === 'coproc' || a0 === 'function'))
            loopprefix(w, first);
        let ok = plain && aw.length === 0;
        if (ok && a0 === 'export') {
            for (let k = first + 1; k < n; k++) {
                if (w[k] === '')
                    continue;
                if (!ASSIGNMENT.test(w[k]))
                    ok = false;
                else if (vtop && !assignword(w[k], !csure))
                    ok = false;
            }
        }
        else if (ok) {
            ok = VPLAIN.test(a0);
        }
        let out = a0;
        for (let k = first + 1; k < n; k++)
            if (w[k] !== '')
                out += ' ' + w[k];
        if (cdw !== '') {
            out = cdw + ' ' + out;
            a0 = '';
        }
        lastout = out;
        let d = cur;
        const o = old;
        let dw = cwhy;
        if (a0 === 'cd' || a0 === 'pushd') {
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
            }
            else if (p === '' || p === '-') {
                old = cur;
                owhy = cwhy;
                cur = '-';
                cwhy = p === '' && a0 === 'cd' ? '-' + WSEP + '$HOME' : '';
            }
            else {
                old = cur;
                owhy = cwhy;
                const t = resolve(cur, p);
                cwhy = t === '-' ? whyof(cur, cwhy, p) : '';
                cur = t;
            }
        }
        else if (a0 === 'popd') {
            old = cur;
            owhy = cwhy;
            cur = '-';
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
        else if (a0 === 'git') {
            for (let k = first + 1; k < n; k++) {
                if (w[k] === '')
                    continue;
                if (w[k] === '-C') {
                    const t = resolve(d, w[k + 1] ?? '');
                    dw = t === '-' ? whyof(d, dw, w[k + 1] ?? '') : '';
                    d = t;
                    k++;
                    continue;
                }
                if (w[k] === '-c') {
                    k++;
                    continue;
                }
                if (w[k].startsWith('-'))
                    continue;
                break;
            }
        }
        emit(d + (assign ? SEP + o + (d === '-' && dw !== '' ? SEP + dw : '') : ''), out);
        if (!chained) {
            old = '-';
            owhy = '';
        }
        vend(ok);
    }
    function push() {
        ostack[sp + 1] = old;
        wstack[sp + 1] = cwhy;
        owstack[sp + 1] = owhy;
        stack[++sp] = cur;
    }
    function pop() {
        if (sp > 0) {
            old = ostack[sp];
            cwhy = wstack[sp];
            owhy = owstack[sp];
            cur = stack[sp--];
        }
    }
    for (i = 0; i < buf.length; i++) {
        const c = buf[i];
        const nx = buf[i + 1] ?? '';
        const prev = i > 0 ? buf[i - 1] : '';
        if (c === QO) {
            qsp++;
            q[qsp] = { stmt, cur, old, start: i + 1, sp, why: cwhy, owhy };
            vkill = true;
            stmt = '';
            continue;
        }
        if (c === QC) {
            if (qsp === 0)
                continue;
            flush();
            const f = q[qsp];
            stmt = f.stmt + '$' + ENC[8] + rawword(buf.slice(f.start, i)) + ENC[9];
            cur = f.cur;
            old = f.old;
            sp = f.sp;
            cwhy = f.why;
            owhy = f.owhy;
            qsp--;
            continue;
        }
        if (c === '\n' || c === ';') {
            flush();
            continue;
        }
        if (c === '&') {
            if (nx === '>' || prev === '>') {
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
            vkill = true;
            const last = stmt.slice(-1);
            if (last === '$' || last === '<' || last === '>') {
                if (assign && last === '$')
                    stmt = stmt + ENC[8] + ENC[9] + forsrc(i);
                else
                    stmt = stmt.slice(0, -1);
            }
            flush();
            push();
            continue;
        }
        if (c === ')') {
            flush();
            if (sp === 0)
                vok = false;
            pop();
            continue;
        }
        if (c === '`') {
            vkill = true;
            if (assign && !bt)
                stmt += '$' + ENC[8] + ENC[9];
            flush();
            if (bt) {
                bt = false;
                pop();
            }
            else {
                bt = true;
                push();
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