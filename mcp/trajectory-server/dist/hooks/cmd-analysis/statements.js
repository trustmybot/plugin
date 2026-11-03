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
 * balance. With `assign`, a dir token may also list, each after an ALT, the
 * other dirs a loop's back-edge can bring its statement to (GH 1977): a
 * frame's statements run in every dir the frame can end a pass in, re-encoded
 * until those stop growing, and after its `}` the dir is the frame's entry
 * dirs plus those. A frame still growing after MAX_GROWTH runs, or a frame
 * edge that would leave more than MAX_DIRS dirs, leaves `-` alone, so a cd
 * that keeps drifting fails closed in bounded time.
 * The TS keeps `time NAME=value` an assignment
 * (GH 1739): `time` is a reserved word, so the shell still sets the name.
 */
import { ENC, HD_DATA, NO_CHARGE, QC, QM, QO, SUB_PC, SUB_PO, plainDollars } from './encode.js';
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
export function statementsEnc(buf, base, home, assign, charge = NO_CHARGE) {
    const frames = { ext: [], runs: [], grew: new Set(), lost: new Set() };
    for (;;) {
        frames.grew.clear();
        charge(buf.length);
        const records = scan(buf, base, home, assign, frames, charge);
        if (frames.grew.size === 0)
            return records;
        for (const fo of frames.grew)
            if (++frames.runs[fo] === MAX_GROWTH)
                frames.lost.add(fo);
    }
}
function scan(buf, base, home, assign, frames, charge) {
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
    let alts = base.split(ALT);
    let cur = alts.shift();
    let oalts = [];
    let sp = 0;
    let bt = false;
    let stmt = '';
    let qsp = 0;
    const stack = [];
    const ostack = [];
    const wstack = [];
    const owstack = [];
    const astack = [];
    const oastack = [];
    const q = [];
    const emit = (dir, text) => {
        charge(dir.length);
        records.push({ dir, stmt: text });
    };
    const loops = [];
    const fids = [];
    const fent = [];
    let nf = 0;
    let unbal = false;
    /** Per word of the statement being flushed: it held a QM, so it is never a reserved word. */
    let wq = [];
    /**
     * With `assign`, frames a loop's statements: `{` from its while / until or
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
            if (top === 'f') {
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
            if (top === 'b') {
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
        if (!vplainexp(stmt.replaceAll(QM, '')))
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
        asg = '';
        let cdw = '';
        const aw = [];
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
            if (w[first] === 'while')
                sawwhile = true;
            if (KEYWORD.test(w[first])) {
                if (assign && !wq[first])
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
                emit('=' + cur + altTok(alts) + SEP + (oalts.length > 0 ? '-' : old), asg);
                if (!chained) {
                    old = '-';
                    owhy = '';
                    oalts = [];
                }
            }
            vend(ok);
            return;
        }
        let a0 = w[first];
        if (assign && !wq[first] && (a0 === 'for' || a0 === 'select'))
            forhead(w, first);
        else if (assign && !wq[first] && (a0 === 'coproc' || a0 === 'function'))
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
        let da = alts;
        const o = oalts.length > 0 ? '-' : old;
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
        else if (a0 === 'popd') {
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
        else if (a0 === 'git') {
            for (let k = first + 1; k < n; k++) {
                if (w[k] === '')
                    continue;
                if (w[k] === '-C') {
                    const t = resolve(d, w[k + 1] ?? '');
                    dw = t === '-' ? whyof(d, dw, w[k + 1] ?? '') : '';
                    d = t;
                    [da, dw] = cdalts(da, w[k + 1] ?? '', d, dw);
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
        emit(d + altTok(da) + (assign ? SEP + o + (d === '-' && dw !== '' ? SEP + dw : '') : ''), out);
        if (!chained) {
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
            q[qsp] = { stmt, cur, old, start: i + 1, sp, why: cwhy, owhy, alts, oalts };
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