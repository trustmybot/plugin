/**
 * _tmb_cmd_prog_calls (cmd-analysis.sh): the awk call scanner over a python /
 * node / perl / ruby program, ported state for state. It runs on the
 * program's UTF-8 bytes, as awk does under LC_ALL=C, and prints the same
 * lines: `W` and `T<TAB><literal>` / `F` per write call, `S<TAB><command>`,
 * except that a python or node target that is one bare name, a python
 * write_text / write_bytes receiver that is one, or one `sys.argv[<n>]` /
 * `process.argv[<n>]` prints `F<TAB><name>` (GH 1692) where the awk prints `F`,
 * `R<TAB><code>`, `U`, `H`, `C`, `Q<TAB><quoted literal>` and `A`.
 */
const Q1 = "'";
const PROCOS = /^(system|popen|exec[lv]p?e?|spawn[lv]p?e?|posix_spawnp?)$/;
const HIDMODS = 'runpy|code|codeop|doctest|pickle|marshal|shelve|importlib|pydoc|types|inspect';
const MODS = `subprocess|os|builtins|cProfile|profile|pdb|trace|timeit|bdb|sys|${HIDMODS}`;
const PYMODS = new RegExp(`^(${MODS})$`);
const HIDRE = new RegExp(`^(${HIDMODS})$`);
const RUNRE = /^((cProfile|profile)[.](run|runctx)|pdb[.](run|runeval|runctx)|timeit[.](timeit|repeat))$/;
const CLSRE = /^(trace[.]Trace|(cProfile|profile)[.]Profile|pdb[.]Pdb|bdb[.]Bdb|timeit[.]Timer)([.]|$)/;
const MAINRE = /^((timeit|cProfile|profile|trace|pdb)[.]main|pdb[.](set_trace|post_mortem|pm))([.]|$)/;
const WMODS = /^(os|io|shutil|pathlib|zipfile)$/;
const WRECV = /^(os|io|shutil|pathlib[.]Path|zipfile)$/;
const HELDRE = /^(exec|eval|compile|open|__import__|getattr|setattr|delattr|globals|locals|vars|type|breakpoint|input)([.]|$)/;
const DUNRE = /(^|[.])(__subclasses__|__globals__|__code__|__dict__|__class__|__bases__|__mro__)([.]|$)/;
const ALIASRE = new RegExp(`from[ \\t]+(${MODS})[ \\t]+import|import([ \\t][^\\n;]*)?[ \\t,](${MODS})[ \\t]+as[ \\t]`);
const PY_IMPORT_FROM = '(^|[\\n;:])[ \\t]*from[ \\t]+[A-Za-z_][A-Za-z0-9_.]*[ \\t]+import[ \\t]*';
const PY_IMPORT = [
    new RegExp(`${PY_IMPORT_FROM}[(][^)]*[)]`, 'y'),
    new RegExp(`${PY_IMPORT_FROM}[^\\n;]*`, 'y'),
    /(^|[\n;:])[ \t]*import[ \t]+[^\n;]*/y,
];
const PY_IMPORT_ANY = new RegExp(PY_IMPORT.map((r) => r.source).join('|'));
const QQ = `['"]`;
const NODE_IMPORT = new RegExp(`((const|let|var)[ \\t]+([A-Za-z_$][A-Za-z0-9_$]*|[{][^}]*[}])[ \\t\\n]*=[ \\t\\n]*require[ \\t]*[(][ \\t]*${QQ}(node:)?child_process${QQ}[ \\t]*[)]|import[ \\t]+[^;\\n]*from[ \\t]*${QQ}(node:)?child_process${QQ})`);
const NODE_REQUIRE_CHAIN = new RegExp(`require[ \\t]*[(][ \\t]*${QQ}(node:)?child_process${QQ}[ \\t]*[)][ \\t\\n]*[.]`);
const NODE_CP = new RegExp(`${QQ}(node:)?child_process${QQ}`);
const CALLBACK = /^[ \t\n]*(async[ \t\n]+)?(function[^A-Za-z0-9_$]|[(][^()]*[)][ \t\n]*=>|[A-Za-z_$][A-Za-z0-9_$]*[ \t\n]*=>)/;
const RUN_KEYS = ['statement', 'cmd', 'expression', 'expr', 'stmt', 'setup', 'source'];
/** awk substr(s, m[, n]), 1-based and clipped. */
function substr(s, m, n) {
    const start = Math.max(m, 1);
    const end = n === undefined ? s.length + 1 : Math.min(m + n, s.length + 1);
    return end <= start ? '' : s.slice(start - 1, end - 1);
}
/** awk index(s, t): 1-based, 0 when absent. */
function index(s, t) {
    return s.indexOf(t) + 1;
}
/** awk split(s, a, sep) with a one-char literal sep, or " " for blank runs. */
function split(s, sep) {
    if (sep === ' ')
        return s.split(/[ \t\n]+/).filter((x) => x !== '');
    return s === '' ? [] : s.split(sep);
}
const trim = (x) => x.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
/** awk match(s, re): [RSTART, RLENGTH], RSTART 0 when no match. */
function match(s, re) {
    const m = re.exec(s);
    return m ? [m.index + 1, m[0].length] : [0, -1];
}
const key = (t, k) => `${t}\x1c${k}`;
class Scanner {
    lang;
    out = [];
    s = '';
    ip = 1;
    d = 0;
    pc = 0;
    anom = false;
    spx = 0;
    nimp = 0;
    nf = 0;
    exeset = false;
    fid = [];
    ftype = [];
    fclose = [];
    isopt = [];
    role = [];
    nat = [];
    fname = [];
    frecv = [];
    frecvv = [];
    np = [];
    frun = [];
    fout = [];
    fcs = [];
    fcn = [];
    atok = [];
    aoth = [];
    alit = [];
    anam = [];
    aargv = [];
    akw = [];
    acode = [];
    alam = [];
    pk = new Map();
    pv = new Map();
    pn = new Map();
    pcd = new Map();
    plam = new Map();
    kk = new Map();
    kv = new Map();
    kn = new Map();
    kcd = new Map();
    klam = new Map();
    spbad = 0;
    spai = 0;
    spkind = '';
    spe = 0;
    splist = 0;
    spshell = 0;
    spraw = 0;
    spcw = '';
    spcwh = 0;
    sr = [];
    sq = [];
    snPre = '';
    snLast = '';
    wlast = '';
    wpre = '';
    lastk = '';
    lastv = '';
    rbad = 0;
    nrc = 0;
    rc = [];
    ims = [];
    ime = [];
    fal = new Map();
    mal = new Map();
    star = new Set();
    impd = new Set();
    wal = new Map();
    wimp = new Set();
    wstar = new Set();
    constructor(lang) {
        this.lang = lang;
    }
    get py() {
        return this.lang === 'py';
    }
    print(line) {
        this.out.push(line);
    }
    at(k, n = 1) {
        return substr(this.s, k, n);
    }
    fidAt(d) {
        return this.fid[d] ?? 0;
    }
    tok(k, v) {
        if (this.d === 0)
            return;
        const t = this.fidAt(this.d);
        this.atok[t] = (this.atok[t] ?? 0) + 1;
        this.anam[t] = '';
        if (k === 'L')
            this.alit[t] = v;
        else
            this.aoth[t] = 1;
    }
    oth() {
        if (this.d > 0) {
            const t = this.fidAt(this.d);
            this.aoth[t] = 1;
            this.anam[t] = '';
        }
    }
    resetarg(t) {
        this.atok[t] = 0;
        this.aoth[t] = 0;
        this.alit[t] = '';
        this.anam[t] = '';
        this.aargv[t] = '';
        this.akw[t] = '';
        this.acode[t] = '';
        this.alam[t] = 0;
    }
    opn(type, cl, name, rk, rv) {
        const d = ++this.d;
        const nf = ++this.nf;
        this.fid[d] = nf;
        this.ftype[d] = type;
        this.fclose[d] = cl;
        this.fname[nf] = name;
        this.frecv[nf] = rk;
        this.frecvv[nf] = rv;
        this.np[nf] = 0;
        this.frun[nf] = '';
        this.fout[nf] = 0;
        this.resetarg(nf);
        this.fcs[nf] = type === 'group' ? 0 : this.contentstart(name, rk);
        this.isopt[d] = 0;
        if (this.spx) {
            this.spnest(type, cl, name);
            return;
        }
        if (type !== 'group' && this.isproc(this.canon(name)))
            this.spstart(this.canon(name));
    }
    spnest(type, cl, name) {
        const { d } = this;
        const pr = this.role[d - 1] ?? '';
        this.role[d] = 'ign';
        if (pr === 'ign') {
            if (type !== 'group' && this.isproc(this.canon(name)))
                this.spbad = 1;
            return;
        }
        if (type !== 'group' || pr === 'key') {
            this.spbad = 1;
            return;
        }
        this.nat[d - 1] = (this.nat[d - 1] ?? 0) + 1;
        if (this.nat[d - 1] > 1) {
            this.spbad = 1;
            return;
        }
        this.nat[d] = 0;
        if (pr === 'cmd' && cl !== '}') {
            this.role[d] = 'elem';
            this.splist = 1;
        }
        else if (cl === '}' && (pr === 'opt' || (pr === 'cmd' && (this.lang === 'node' || this.lang === 'ruby')))) {
            this.role[d] = 'key';
            this.isopt[d] = 1;
        }
        else
            this.spbad = 1;
    }
    spstart(cn) {
        this.spx = this.d;
        this.spbad = 0;
        this.spai = 1;
        this.spkind = '';
        this.spe = 0;
        this.splist = 0;
        this.spshell = 0;
        this.spraw = 0;
        this.spcw = '';
        this.spcwh = 0;
        this.splitname(cn);
        if (this.py) {
            if (/(^|[.])os$/.test(this.snPre))
                this.spkind = this.snLast;
            this.spraw = /^(system|popen|getoutput|getstatusoutput)$/.test(this.snLast) ? 1 : 0;
        }
        else if (this.lang === 'node') {
            this.spkind = this.snLast;
            this.spraw = /^(exec|execSync)$/.test(this.snLast) ? 1 : 0;
        }
        this.slotstart(this.ip);
    }
    slotstart(p) {
        const { spkind, spai } = this;
        let r = 'cmd';
        if (this.py) {
            if (/^spawn/.test(spkind))
                r = spai === 1 ? 'lit' : 'cmd';
            else if (/^posix_spawn/.test(spkind))
                r = spai <= 2 ? 'cmd' : spai === 3 ? 'lit' : 'none';
            else if (spkind === 'popen')
                r = spai === 1 ? 'cmd' : 'lit';
            else if (!/^exec/.test(spkind))
                r = spai === 1 ? 'cmd' : 'none';
        }
        else if (this.lang === 'node') {
            if (/^(exec|execSync)$/.test(spkind))
                r = spai === 1 ? 'cmd' : spai <= 3 ? 'opt' : 'none';
            else
                r = spai <= 2 ? 'cmd' : spai <= 4 ? 'opt' : 'none';
            if (r === 'opt' || (r === 'cmd' && spai === 2)) {
                if (CALLBACK.test(substr(this.s, p)))
                    r = 'ign';
            }
        }
        this.role[this.spx] = r;
        this.nat[this.spx] = 0;
    }
    keyrole(nm) {
        if (this.py) {
            if (nm === 'args')
                return 'cmd';
            if (nm === 'cwd')
                return 'cwd';
            if (nm === 'shell')
                return 'shell';
            if (/^(stdin|stdout|stderr|input|timeout|check|text|capture_output|encoding|errors|universal_newlines|env|bufsize|close_fds|pass_fds|restore_signals|start_new_session|process_group|startupinfo|creationflags|user|group|extra_groups|umask|pipesize)$/.test(nm))
                return 'ign';
            if (/^(executable|preexec_fn)$/.test(nm))
                return 'bad';
            return 'lit';
        }
        if (this.lang === 'node') {
            if (nm === 'cwd')
                return 'cwd';
            if (nm === 'shell')
                return 'shell';
            if (/^(stdio|env|encoding|timeout|maxBuffer|killSignal|windowsHide|windowsVerbatimArguments|detached|uid|gid|input|signal|serialization|argv0|silent)$/.test(nm))
                return 'ign';
            if (/^(execArgv|execPath)$/.test(nm))
                return 'bad';
            return 'lit';
        }
        if (nm === 'chdir')
            return 'cwd';
        if (/^(in|out|err)$/.test(nm))
            return 'redir';
        if (/^(unsetenv_others|pgroup|new_pgroup|umask|close_others|exception|rlimit_[a-z]+)$/.test(nm))
            return 'ign';
        return 'lit';
    }
    setkey(nm) {
        let r = this.keyrole(nm);
        if (r === 'bad') {
            this.spbad = 1;
            r = 'ign';
        }
        this.role[this.d] = r;
        this.nat[this.d] = 0;
    }
    skey(v) {
        let k = this.ip;
        while (/[ \t\n]/.test(this.at(k)))
            k++;
        if (this.at(k) === ':' && this.at(k + 1) !== ':' && (this.lang === 'node' || this.lang === 'ruby')) {
            this.setkey(v);
            this.ip = k + 1;
        }
        else if (this.lang === 'ruby' && this.at(k, 2) === '=>') {
            this.role[this.d] = 'ign';
            this.ip = k + 2;
        }
        else
            this.spbad = 1;
    }
    satom(kind, v) {
        if (!this.spx)
            return;
        const { d } = this;
        const r = this.role[d] ?? '';
        if (r === 'ign')
            return;
        if (r === 'key') {
            this.spbad = 1;
            return;
        }
        this.nat[d] = (this.nat[d] ?? 0) + 1;
        if (this.nat[d] > 1) {
            this.spbad = 1;
            return;
        }
        if (r === 'cmd' || r === 'elem') {
            if (/^[SNX]$/.test(kind)) {
                this.spe++;
                this.sr[this.spe] = v;
                this.sq[this.spe] = sqt(v);
            }
            else
                this.spbad = 1;
        }
        else if (r === 'cwd') {
            if (kind === 'S') {
                this.spcw = sqt(v);
                this.spcwh = 1;
            }
            else if (!(kind === 'K' && /^(None|null|undefined|nil)$/.test(v)))
                this.spbad = 1;
        }
        else if (r === 'shell') {
            if (/^[SNK]$/.test(kind)) {
                if (!/^(False|false|None|null|undefined|nil)$/.test(v))
                    this.spshell = 1;
            }
            else
                this.spbad = 1;
        }
        else if (r === 'redir') {
            if (kind !== 'K' && kind !== 'N')
                this.spbad = 1;
        }
        else if (r === 'lit' || r === 'opt') {
            if (!/^[SNK]$/.test(kind))
                this.spbad = 1;
        }
        else
            this.spbad = 1;
    }
    spfin() {
        if (!this.spbad && this.spe > 0) {
            const plain = this.spshell || this.spraw || (this.spe === 1 && !this.splist);
            let cmd = '';
            for (let j = 1; j <= this.spe; j++)
                cmd += (j > 1 ? ' ' : '') + (plain ? this.sr[j] : this.sq[j]);
            if (this.spcwh)
                cmd = `cd ${this.spcw} && ${cmd}`;
            this.print('S\t' + cmd.replace(/\n/g, '\x1f'));
            this.print('W');
        }
        else
            this.unres();
        this.spx = 0;
    }
    bt(v, interp) {
        if (interp)
            this.unres();
        else {
            this.print('S\t' + v.replace(/\n/g, '\x1f'));
            this.print('W');
        }
        if (this.spx && this.role[this.d] !== 'ign')
            this.spbad = 1;
    }
    qlike(p) {
        const o = this.at(p);
        let c = o;
        if (o === '(')
            c = ')';
        else if (o === '[')
            c = ']';
        else if (o === '{')
            c = '}';
        else if (o === '<')
            c = '>';
        let dep = 1;
        let v = '';
        let j = p + 1;
        while (j <= this.s.length) {
            const ch = this.at(j);
            if (ch === '\\') {
                v += this.at(j, 2);
                j += 2;
                continue;
            }
            if (ch === c && c !== o) {
                if (--dep === 0)
                    break;
            }
            else if (ch === c) {
                dep = 0;
                break;
            }
            else if (ch === o)
                dep++;
            v += ch;
            j++;
        }
        if (dep) {
            this.anom = true;
            this.ip = this.s.length + 1;
            return;
        }
        this.ip = j + 1;
        this.pc = 0;
        this.bt(v, this.lang === 'perl' ? o !== Q1 && /[$@]/.test(v) : index(v, '#{') > 0);
        this.tok('E', '');
    }
    canon(nm) {
        const al = this.fal.get(nm);
        if (al !== undefined)
            return al;
        const [st, len] = match(nm, /^[A-Za-z_$][A-Za-z0-9_$]*/);
        if (!st)
            return nm;
        const f = nm.slice(0, len);
        const r = nm.slice(len);
        const m = this.mal.get(f);
        if (m !== undefined)
            return m + r;
        const ff = this.fal.get(f);
        if (this.py && ff !== undefined && CLSRE.test(ff))
            return ff + r;
        if (this.py && r !== '') {
            for (const g of this.star)
                if (CLSRE.test(`${g}.${f}`) || `${g}.${f}` === 'sys.modules')
                    return `${g}.${f}${r}`;
        }
        if (this.py && r === '') {
            if (this.star.has('subprocess') && /^(run|call|check_call|check_output|Popen|getoutput|getstatusoutput)$/.test(nm))
                return 'subprocess.' + nm;
            if (this.star.has('os') && (PROCOS.test(nm) || /^f?chdir$/.test(nm)))
                return 'os.' + nm;
            for (const g of this.star) {
                const q = `${g}.${nm}`;
                if (RUNRE.test(q) || CLSRE.test(q) || MAINRE.test(q) || q === 'sys.modules')
                    return q;
            }
        }
        return nm;
    }
    pyref(nm, cn, ch, k, st, rk) {
        if (this.inimport(st))
            return;
        const b = cn.replace(/^(builtins|__builtins__)[.]/, '');
        if (DUNRE.test(cn) || /^sys[.]modules([.]|$)/.test(cn) || MAINRE.test(cn) || /^breakpoint([.]|$)/.test(b)) {
            this.unres();
            return;
        }
        if (ch === '=' && this.at(k + 1) !== '=')
            return;
        const m = cn.replace(/[.].*$/s, '');
        if (/^(builtins|__builtins__)$/.test(cn) ||
            /(^|[.])__self__([.]|$)/.test(cn) ||
            CLSRE.test(cn) ||
            /^(builtins|__builtins__)[.]__/.test(cn) ||
            (this.impd.has(m) && (cn === m || /^[^.]+[.]__/.test(cn))) ||
            (RUNRE.test(cn) && ch !== '('))
            this.unres();
        else if (HELDRE.test(b) && (ch !== '(' || /[.]/.test(b)))
            this.held(b);
        else if (this.wheld(nm, ch, rk) && !this.cbarg(nm, cn))
            this.aw();
    }
    wres(nm) {
        const [st, len] = match(nm, /^[A-Za-z_][A-Za-z0-9_]*/);
        if (!st)
            return nm;
        const w = this.wal.get(nm.slice(0, len));
        return w !== undefined ? w + nm.slice(len) : nm;
    }
    wq(nm, rk) {
        const [st, len] = match(nm, /^[A-Za-z_][A-Za-z0-9_]*/);
        if (!st)
            return '';
        const f = nm.slice(0, len);
        const r = nm.slice(len);
        const w = this.wal.get(f);
        if (w !== undefined)
            return w + r;
        if (this.wimp.has(f) || rk === 'M')
            return nm;
        for (const g of this.wstar)
            if ((g === 'pathlib' && f === 'Path') || wkind(f, g) !== '')
                return `${g}.${f}${r}`;
        return '';
    }
    pywriter(nm) {
        this.splitname(nm);
        return WRECV.test(this.snPre) && wkind(this.snLast, this.snPre) !== '';
    }
    wheld(nm, ch, rk) {
        const q = this.wq(nm, rk);
        if (q === '')
            return false;
        if (/^(io|shutil|pathlib|zipfile)$/.test(q))
            return true;
        const a = split(q, '.');
        let p = a[0];
        for (let i = 2; i <= a.length; i++) {
            p += '.' + a[i - 1];
            if ((i < a.length || ch !== '(') && this.pywriter(p))
                return true;
        }
        return false;
    }
    cbarg(nm, cn) {
        if (this.d === 0 || this.ftype[this.d] !== 'call')
            return false;
        const t = this.fidAt(this.d);
        return (this.akw[t] === 'copy_function' &&
            /^(dst|mv)$/.test(this.pykind(this.fname[t] ?? '')) &&
            (this.pykind(nm) === 'dst' || this.pykind(cn) === 'dst'));
    }
    pykind(raw) {
        this.splitname(raw);
        this.wlast = this.snLast;
        this.wpre = this.snPre;
        let k = wkind(this.wlast, this.wpre);
        if (k !== '' || !this.py)
            return k;
        this.splitname(this.wres(raw));
        k = wkind(this.snLast, this.snPre);
        if (k !== '') {
            this.wlast = this.snLast;
            this.wpre = this.snPre;
        }
        return k;
    }
    pycallref(t, cn) {
        const b = cn.replace(/^(builtins|__builtins__)[.]/, '');
        const np = this.np[t] ?? 0;
        if (/^(getattr|setattr|delattr)$/.test(b) && !(np >= 2 && this.pk.get(key(t, 2)) === 'L'))
            this.unres();
        if (/(^|[.])(__import__|import_module)$/.test(this.fname[t] ?? '') && !(np >= 1 && this.pk.get(key(t, 1)) === 'L'))
            this.unres();
        if (/^(globals|locals|vars)$/.test(b)) {
            let k = this.ip + 1;
            while (/[ \t\n\\]/.test(this.at(k)))
                k++;
            const c = this.at(k);
            if (c === '[' || c === '.')
                this.unres();
        }
    }
    runcode(k, v, lam, kind) {
        if (kind === 't' && lam)
            return;
        if (k !== 'L' || v === '\x01' || ALIASRE.test(v))
            this.rbad = 1;
        else
            this.rc[++this.nrc] = v;
    }
    runjudge(t, kind) {
        this.rbad = 0;
        this.nrc = 0;
        const np = this.np[t] ?? 0;
        for (let i = 1; i <= np && i <= (kind === 't' ? 2 : 1); i++) {
            this.runcode(this.pk.get(key(t, i)) ?? '', this.pcd.get(key(t, i)) ?? '', this.plam.get(key(t, i)) ?? 0, kind);
        }
        for (const a of RUN_KEYS) {
            const kt = key(t, a);
            if (this.kk.has(kt))
                this.runcode(this.kk.get(kt) ?? '', this.kcd.get(kt) ?? '', this.klam.get(kt) ?? 0, kind);
        }
        if (this.rbad) {
            this.unres();
            return;
        }
        let p = '';
        for (let j = 1; j <= this.nimp; j++)
            p += this.at(this.ims[j], this.ime[j] - this.ims[j]) + '\n';
        for (let j = 1; j <= this.nrc; j++)
            this.print('R\t' + (p + this.rc[j]).replace(/\n/g, '\x1f'));
    }
    procref(cn) {
        this.splitname(cn);
        if (this.py) {
            return (cn === 'os' ||
                (/^subprocess([.]|$)/.test(cn) &&
                    !/^(PIPE|STDOUT|DEVNULL|CalledProcessError|TimeoutExpired|SubprocessError|CompletedProcess|list2cmdline)$/.test(this.snLast)) ||
                (this.snPre === 'os' && PROCOS.test(this.snLast)));
        }
        if (this.lang === 'node') {
            return /^child_process([.]|$)/.test(cn) || /^[?][(][)][.](exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)$/.test(cn);
        }
        return false;
    }
    inimport(p) {
        for (let j = 1; j <= this.nimp; j++)
            if (p >= this.ims[j] && p < this.ime[j])
                return true;
        return false;
    }
    unres() {
        this.print('W');
        this.print('U');
    }
    aw() {
        this.print('W');
        this.print('H');
    }
    held(nm) {
        if (/^open([.]|$)/.test(nm))
            this.aw();
        else
            this.unres();
    }
    addrange(st, ln) {
        this.nimp++;
        this.ims[this.nimp] = st;
        this.ime[this.nimp] = st + ln;
    }
    static alias(piece) {
        let nm = trim(piece);
        let al = nm;
        if (/[ \t]as[ \t]/.test(nm)) {
            al = al.replace(/^.*[ \t]as[ \t]+/s, '');
            nm = nm.replace(/[ \t].*$/s, '');
        }
        return [nm, al];
    }
    pyimport(text) {
        const m = text.replace(/^[\n;: \t]+/, '');
        if (/^from/.test(m)) {
            const mod = m.replace(/^from[ \t]+/, '').replace(/[ \t].*$/s, '');
            const top = mod.replace(/[.].*$/s, '');
            if (HIDRE.test(top)) {
                this.unres();
                return;
            }
            const x = m.replace(/^from[ \t]+[^ \t]+[ \t]+import[ \t]*/, '').replace(/[()\\\n]/g, ' ');
            for (const piece of split(x, ',')) {
                const [nm, al] = Scanner.alias(piece);
                if (WMODS.test(mod) && nm === '*')
                    this.wstar.add(mod);
                else if (WMODS.test(mod) && nm !== '')
                    this.wal.set(al, `${mod}.${nm}`);
                if (!PYMODS.test(mod)) {
                    if (al === 'compile')
                        this.fal.set(al, `${mod}.${nm}`);
                    continue;
                }
                if (mod === 'builtins' && HELDRE.test(nm) && al !== nm)
                    this.held(nm);
                if (nm === '*')
                    this.star.add(mod);
                else if (nm !== '')
                    this.fal.set(al, `${mod}.${nm}`);
            }
            return;
        }
        const x = m.replace(/^import[ \t]+/, '');
        for (const piece of split(x, ',')) {
            const [nm, al] = Scanner.alias(piece);
            const top = nm.replace(/[.].*$/s, '');
            if (HIDRE.test(top))
                this.unres();
            if (PYMODS.test(nm) && !/^(subprocess|os|builtins)$/.test(nm))
                this.impd.add(nm);
            if (al !== nm && PYMODS.test(nm))
                this.mal.set(al, nm);
            if (al !== nm)
                this.wal.set(al, nm);
            else
                this.wimp.add(top);
        }
    }
    nodeimport(m) {
        const ident = (x) => x.replace(/[^A-Za-z0-9_$].*$/s, '');
        if (/^(const|let|var)[ \t]+[A-Za-z_$]/.test(m)) {
            this.mal.set(ident(m.replace(/^(const|let|var)[ \t]+/, '')), 'child_process');
            return;
        }
        if (/^import[ \t]*[*]/.test(m)) {
            this.mal.set(ident(m.replace(/^import[ \t]*[*][ \t]*as[ \t]+/, '')), 'child_process');
            return;
        }
        if (/^import[ \t]+[A-Za-z_$]/.test(m))
            this.mal.set(ident(m.replace(/^import[ \t]+/, '')), 'child_process');
        const [st, len] = match(m, /[{][^}]*[}]/);
        if (!st)
            return;
        for (const piece of split(substr(m, st + 1, len - 2), ',')) {
            let nm = trim(piece);
            let al = nm;
            if (/:/.test(nm)) {
                al = al.replace(/^[^:]*:[ \t\n]*/, '');
                nm = nm.replace(/[ \t\n]*:.*$/s, '');
            }
            else if (/[ \t]as[ \t]/.test(nm)) {
                al = al.replace(/^.*[ \t]as[ \t]+/s, '');
                nm = nm.replace(/[ \t].*$/s, '');
            }
            if (nm !== '' && al !== '')
                this.fal.set(al, 'child_process.' + nm);
        }
    }
    /** The python import statement match at `rest`'s start of a match, leftmost-longest as awk's match(). */
    static pyImportMatch(rest) {
        const at = rest.search(PY_IMPORT_ANY);
        if (at < 0)
            return [0, -1];
        let len = -1;
        for (const re of PY_IMPORT) {
            re.lastIndex = at;
            const m = re.exec(rest);
            if (m && m[0].length > len)
                len = m[0].length;
        }
        return [at + 1, len];
    }
    prescan() {
        const { s } = this;
        this.exeset = (this.py && /sys[.]executable[ \t]*=[^=]/.test(s)) || (this.lang === 'node' && /process[.]execPath[ \t]*=[^=]/.test(s));
        if (this.py) {
            let off = 1;
            while (off <= s.length) {
                const [st0, ln] = Scanner.pyImportMatch(substr(s, off));
                if (!st0)
                    break;
                const st = off + st0 - 1;
                this.addrange(st, ln);
                this.pyimport(substr(s, st, ln));
                off = st + (ln > 0 ? ln : 1);
            }
            return;
        }
        if (this.lang !== 'node')
            return;
        let off = 1;
        let seen = 0;
        while (off <= s.length) {
            const [st0, ln] = match(substr(s, off), NODE_IMPORT);
            if (!st0)
                break;
            const st = off + st0 - 1;
            this.addrange(st, ln);
            this.nodeimport(substr(s, st, ln));
            seen++;
            off = st + (ln > 0 ? ln : 1);
        }
        off = 1;
        while (off <= s.length) {
            const [st0, ln] = match(substr(s, off), NODE_REQUIRE_CHAIN);
            if (!st0)
                break;
            seen++;
            off += st0 + ln - 1;
        }
        off = 1;
        let cnt = 0;
        while (off <= s.length) {
            const [st0, ln] = match(substr(s, off), NODE_CP);
            if (!st0)
                break;
            cnt++;
            off += st0 + ln - 1;
        }
        if (cnt > seen)
            this.unres();
    }
    endarg(t) {
        const atok = this.atok[t] ?? 0;
        const aoth = this.aoth[t] ?? 0;
        const akw = this.akw[t] ?? '';
        if (atok === 0 && !aoth && akw === '')
            return;
        const k = atok === 1 && !aoth ? 'L' : 'E';
        const nm = this.anam[t] || (atok === 2 ? (this.aargv[t] ?? '') : '');
        if (akw !== '') {
            const kt = key(t, akw);
            this.kk.set(kt, k);
            this.kv.set(kt, this.alit[t] ?? '');
            this.kn.set(kt, nm);
            this.kcd.set(kt, this.acode[t] ?? '');
            this.klam.set(kt, this.alam[t] ?? 0);
        }
        else {
            const np = (this.np[t] = (this.np[t] ?? 0) + 1);
            const kt = key(t, np);
            this.pk.set(kt, k);
            this.pv.set(kt, this.alit[t] ?? '');
            this.pn.set(kt, nm);
            this.pcd.set(kt, this.acode[t] ?? '');
            this.plam.set(kt, this.alam[t] ?? 0);
        }
        this.resetarg(t);
    }
    endone() {
        const t = this.fidAt(this.d);
        const ty = this.ftype[this.d] ?? '';
        this.endarg(t);
        if (this.spx === this.d)
            this.spfin();
        this.d--;
        this.lastk = 'U';
        this.lastv = '';
        if (ty === 'call' || ty === 'pseudo') {
            this.classify(t);
            const fname = this.fname[t] ?? '';
            const np = this.np[t] ?? 0;
            const pk1 = this.pk.get(key(t, 1)) ?? '';
            const pv1 = this.pv.get(key(t, 1)) ?? '';
            if (ty === 'call' && /(^|\.)(Path|PurePath|PosixPath|WindowsPath)$/.test(fname)) {
                this.lastk = np === 1 && pk1 === 'L' ? 'P' : 'PE';
                this.lastv = pv1;
            }
            if (ty === 'call' && this.py && /(^|[.])(__import__|import_module)$/.test(fname) && np >= 1 && pk1 === 'L' && WMODS.test(pv1)) {
                if (this.at(this.ip + 1) === '.' && /[A-Za-z_]/.test(this.at(this.ip + 2))) {
                    this.lastk = 'M';
                    this.lastv = pv1;
                }
                else
                    this.aw();
            }
            if ((this.frun[t] ?? '') !== '')
                this.runjudge(t, this.frun[t]);
            if (this.py && ty === 'call')
                this.pycallref(t, this.fcn[t] ?? '');
            const fout = this.fout[t] ?? 0;
            if (fout && ((this.np[t] ?? 0) >= fout || this.kk.has(key(t, 'filename'))))
                this.arg(t, fout, 'filename');
        }
        this.tok('E', '');
    }
    endpseudo() {
        while (this.d > 0 && this.ftype[this.d] === 'pseudo')
            this.endone();
        this.pc = 0;
    }
    /** A literal target prints `T<TAB><value>`; a lone name prints `F<TAB><name>` for programs.ts to resolve; anything else prints `F`. */
    hit(k, v, nm = '') {
        this.print('W');
        if (k === 'L' && v !== '' && !(this.py && pyesc(v)))
            this.print('T\t' + v);
        else if (k !== 'L' && nm !== '')
            this.print('F\t' + nm);
        else
            this.print('F');
    }
    arg(t, i, kws) {
        if ((this.np[t] ?? 0) >= i) {
            const kt = key(t, i);
            this.hit(this.pk.get(kt) ?? '', this.pv.get(kt) ?? '', this.pn.get(kt) ?? '');
            return;
        }
        for (const a of split(kws, ' ')) {
            const kt = key(t, a);
            if (this.kk.has(kt)) {
                this.hit(this.kk.get(kt) ?? '', this.kv.get(kt) ?? '', this.kn.get(kt) ?? '');
                return;
            }
        }
        this.hit('E', '');
    }
    splitname(nm) {
        this.snLast = nm;
        this.snPre = '';
        const at = nm.search(/(\.|::)[^.:]*$/);
        if (at >= 0) {
            this.snPre = nm.slice(0, at);
            this.snLast = nm.slice(at + (nm[at] === ':' ? 2 : 1));
        }
    }
    isproc(nm) {
        this.splitname(nm);
        const { snPre: pre, snLast: last } = this;
        if (this.py) {
            return ((/(^|\.)subprocess$/.test(pre) && /^(run|call|check_call|check_output|Popen|getoutput|getstatusoutput)$/.test(last)) ||
                (pre === '' && /^(check_call|check_output|Popen|getoutput|getstatusoutput)$/.test(last)) ||
                (/(^|\.)os$/.test(pre) && PROCOS.test(last)));
        }
        if (this.lang === 'node') {
            return (/^(execSync|execFile|execFileSync|spawn|spawnSync|fork)$/.test(last) ||
                (last === 'exec' && (pre === '' || pre === '?()' || /(^|\.)(child_process|cp|childProcess)$/.test(pre))));
        }
        return ((pre === '' && /^(system|exec|spawn)$/.test(last)) ||
            /^(IO\.popen|Open3\.[a-z0-9_]+|Kernel\.(system|exec|spawn)|Process\.spawn)$/.test(nm));
    }
    contentstart(nm, rk) {
        this.splitname(nm);
        const { snPre: pre, snLast: last } = this;
        if (/^(writeFileSync|appendFileSync|writeFile|appendFile|writeSync|outputFile|outputFileSync)$/.test(last))
            return 2;
        if (!/^(write|writelines|write_text|write_bytes|binwrite|syswrite)$/.test(last))
            return 0;
        if (rk === 'P' || rk === 'PE')
            return 1;
        return pre === '' || /(^|[.:])(os|fs|fsp|promises|File|IO)$/.test(pre) ? 2 : 1;
    }
    incontent() {
        for (let k = this.d; k >= 1; k--) {
            const t = this.fidAt(k);
            const fcs = this.fcs[t] ?? 0;
            const akw = this.akw[t] ?? '';
            if (fcs > 0 && (/^(data|text|content|contents|lines|buffer)$/.test(akw) || (akw === '' && (this.np[t] ?? 0) + 1 >= fcs)))
                return true;
        }
        return false;
    }
    perlopen(t) {
        const np = this.np[t] ?? 0;
        if (np < 2)
            return;
        if (this.pk.get(key(t, 2)) !== 'L') {
            if (np >= 3)
                this.arg(t, 3, '');
            else
                this.hit('E', '');
            return;
        }
        const r = (this.pv.get(key(t, 2)) ?? '').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        if (/^(\||-\|)/.test(r) || /\|$/.test(r))
            return;
        const [st, len] = match(r, /^(\+<|\+>>|\+>|>>|>|<)/);
        if (!st)
            return;
        const mm = r.slice(0, len);
        const rest = r.slice(len).replace(/^[ \t]+/, '');
        if (mm === '<' || /^&/.test(rest))
            return;
        if (rest === '' || /^:/.test(rest)) {
            if (np >= 3)
                this.arg(t, 3, '');
            else
                this.hit('E', '');
            return;
        }
        this.hit('L', rest);
    }
    mode(t, i) {
        if ((this.np[t] ?? 0) >= i)
            return [this.pk.get(key(t, i)) ?? '', this.pv.get(key(t, i)) ?? ''];
        const kt = key(t, 'mode');
        if (this.kk.has(kt))
            return [this.kk.get(kt) ?? '', this.kv.get(kt) ?? ''];
        return null;
    }
    classify(t) {
        const nm = this.fname[t] ?? '';
        let last = nm;
        const at = nm.search(/(\.|::)[^.:]*$/);
        if (at >= 0)
            last = nm.slice(at + (nm[at] === ':' ? 2 : 1));
        const rk = this.frecv[t] ?? '';
        const np = this.np[t] ?? 0;
        if (rk === 'P' || rk === 'PE') {
            if (/^(write_text|write_bytes|touch|mkdir|rmdir|unlink|rename|replace|symlink_to|hardlink_to)$/.test(last)) {
                this.hit(rk === 'P' ? 'L' : 'E', this.frecvv[t] ?? '');
                if (last === 'rename' || last === 'replace')
                    this.arg(t, 1, 'target');
            }
            else if (last === 'open') {
                const md = this.mode(t, 1);
                if (!md)
                    return;
                if (md[0] === 'L' && !wmode(md[1]))
                    return;
                this.hit(rk === 'P' ? 'L' : 'E', this.frecvv[t] ?? '');
            }
            return;
        }
        const k = this.pykind(nm);
        const pre = this.wpre;
        if (k === 'open') {
            if (this.lang === 'perl' && pre === '') {
                this.perlopen(t);
                return;
            }
            if (pre !== '' && np === 1 && this.pk.get(key(t, 1)) === 'L' && wmode(this.pv.get(key(t, 1)) ?? '')) {
                this.hit('E', '');
                return;
            }
            const md = this.mode(t, 2);
            if (!md)
                return;
            if (md[0] === 'L' && !wmode(md[1]))
                return;
            this.arg(t, 1, 'file path');
        }
        else if (k === 'trunc')
            this.arg(t, 1, 'path');
        else if (k === 'zip') {
            const md = this.mode(t, 2);
            if (!md)
                return;
            if (md[0] === 'L' && !wmode(md[1]))
                return;
            this.arg(t, 1, 'file');
        }
        else if (k === 'p1')
            this.arg(t, 1, 'path name file');
        else if (k === 'fw')
            this.arg(t, 1, '');
        else if (k === 'wt')
            this.hit('E', '', this.py && /^[A-Za-z_][A-Za-z0-9_]*$/.test(pre) ? pre : '');
        else if (k === 'pn')
            this.arg(t, 1, 'path name');
        else if (k === 'dst')
            this.arg(t, 2, 'dst dest');
        else if (k === 'mv') {
            this.arg(t, 1, 'src');
            this.arg(t, 2, 'dst dest');
        }
    }
    str(qc, pfx) {
        const { s } = this;
        const n = s.length;
        let tq = false;
        let closed = false;
        let v = '';
        let j;
        const q3 = qc + qc + qc;
        if (this.py && this.at(this.ip, 3) === q3) {
            tq = true;
            j = this.ip + 3;
        }
        else
            j = this.ip + 1;
        while (j <= n) {
            const ch = this.at(j);
            if (ch === '\\') {
                v += this.at(j, 2);
                j += 2;
                continue;
            }
            if (tq && this.at(j, 3) === q3) {
                j += 3;
                closed = true;
                break;
            }
            if (!tq && ch === qc) {
                j++;
                closed = true;
                break;
            }
            v += ch;
            j++;
        }
        if (!closed) {
            this.anom = true;
            this.ip = n + 1;
            return;
        }
        let interp = false;
        if (this.py && /[fF]/.test(pfx) && index(v, '{'))
            interp = true;
        if (this.lang === 'perl' && (qc === '"' || qc === '`') && /[$@]/.test(v))
            interp = true;
        if (this.lang === 'ruby' && (qc === '"' || qc === '`') && index(v, '#{'))
            interp = true;
        if (this.lang === 'node' && qc === '`' && index(v, '${'))
            interp = true;
        const { d } = this;
        if (this.py && d > 0 && /(^|[.])(__import__|import_module)$/.test(this.fname[this.fidAt(d)] ?? '') && PYMODS.test(v))
            this.unres();
        if (this.py &&
            (/^(__builtins__|builtins|__self__|__subclasses__|__globals__|__code__|__dict__|__class__|__bases__|__mro__)$/.test(v) ||
                (!/[rR]/.test(pfx) && pyesc(v))))
            this.unres();
        if (!this.incontent())
            this.print(`Q\t${qc}${v.replace(/\n/g, ' ')}${qc}`);
        this.tok(interp ? 'E' : 'L', v);
        if (this.py && d > 0 && !interp)
            this.acode[this.fidAt(d)] = /[rR]/.test(pfx) ? v : unesc(v);
        this.ip = j;
        this.pc = 0;
        if (qc === '`' && (this.lang === 'perl' || this.lang === 'ruby'))
            this.bt(v, interp);
        else if (this.spx && this.role[this.d] === 'key')
            this.skey(v);
        else
            this.satom(interp ? 'I' : 'S', v);
    }
    name(rk, rv, pfx) {
        const { s, lang } = this;
        const n = s.length;
        let j = this.ip + 1;
        const st = this.ip;
        while (j <= n) {
            const c = this.at(j);
            if (/[A-Za-z0-9_]/.test(c)) {
                j++;
                continue;
            }
            if (c === '.' && /[A-Za-z_$]/.test(this.at(j + 1))) {
                j++;
                continue;
            }
            if (c === ':' && /^:[A-Za-z_]/.test(this.at(j + 1, 2))) {
                j += 2;
                continue;
            }
            break;
        }
        const nm = pfx + this.at(this.ip, j - this.ip);
        this.ip = j;
        this.pc = 0;
        if (this.d > 0 && this.ftype[this.d] === 'pseudo' && /^(or|and|xor|if|unless|do|while|until|then)$/.test(nm)) {
            this.endpseudo();
            return;
        }
        let k = this.ip;
        while (/[ \t]/.test(this.at(k)))
            k++;
        const ch = this.at(k);
        if (this.py && k === this.ip && (ch === Q1 || ch === '"') && /^[rRbBuUfF][rRbBfF]?$/.test(nm)) {
            this.str(ch, nm);
            return;
        }
        if (lang === 'perl' && nm === 'qx' && ch !== '' && index(`()[]{}<>/|!~^%+@:-"${Q1}`, ch)) {
            this.qlike(k);
            return;
        }
        const cn = this.py ? this.canon(nm) : nm;
        if ((this.py || lang === 'node') && !this.inimport(st) && this.procref(this.canon(nm)) && !(ch === '(' && this.isproc(this.canon(nm))))
            this.unres();
        if (this.py)
            this.pyref(nm, cn, ch, k, st, rk);
        if ((this.py && ch === '(' && /^((builtins|__builtins__)[.])?(exec|eval)$/.test(cn)) ||
            (lang === 'node' && ((nm === 'eval' && ch === '(') || nm === 'Function')) ||
            (lang === 'perl' && nm === 'eval' && ch !== '{') ||
            (lang === 'ruby' && nm === 'eval'))
            this.unres();
        if ((this.py && /^os[.]f?chdir$/.test(cn)) ||
            (lang === 'node' && nm === 'process.chdir') ||
            (lang === 'perl' && nm === 'chdir') ||
            (lang === 'ruby' && /^(Dir[.]chdir|FileUtils[.](cd|chdir))$/.test(nm)))
            this.print('C');
        if (ch === '(') {
            const rn = this.py ? runner(cn) : '';
            this.opn('call', ')', nm, rk, rv);
            this.frun[this.nf] = rn;
            this.fcn[this.nf] = cn;
            if (this.py)
                this.fout[this.nf] = /^(cProfile|profile)[.]run$/.test(cn) ? 2 : /^(cProfile|profile)[.]runctx$/.test(cn) ? 4 : 0;
            this.ip = k + 1;
            return;
        }
        if (ch === '=' && this.at(k + 1) !== '=' && this.d > 0 && this.ftype[this.d] === 'call' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) {
            const t = this.fidAt(this.d);
            if ((this.atok[t] ?? 0) === 0 && !this.aoth[t] && (this.akw[t] ?? '') === '') {
                this.akw[t] = nm;
                this.ip = k + 1;
                if (this.spx === this.d)
                    this.setkey(nm);
                return;
            }
        }
        const role = this.role[this.d] ?? '';
        if (ch === ':' &&
            this.at(k + 1) !== ':' &&
            this.spx &&
            role !== 'ign' &&
            ((lang === 'node' && role === 'key') || (lang === 'ruby' && (this.d === this.spx || role === 'key')))) {
            this.setkey(nm);
            this.ip = k + 1;
            return;
        }
        if ((lang === 'perl' || lang === 'ruby') &&
            k > this.ip &&
            (ch === Q1 || ch === '`' || /["$@A-Za-z_]/.test(ch)) &&
            /^(open|unlink|mkdir|rmdir|rename|link|symlink|copy|move|mkpath|make_path|remove_tree|rmtree|system|exec|spawn|(File|IO|FileUtils|Dir)\.[a-z_]+|File::(Copy|Path)::[a-z_]+)$/.test(nm)) {
            this.opn('pseudo', '', nm, '', '');
            this.ip = k;
            return;
        }
        if (this.spx && role !== 'ign') {
            if (role === 'key') {
                if (this.keyrole(nm) !== 'ign')
                    this.spbad = 1;
            }
            else if (/^(True|False|None|true|false|nil|null|undefined)$/.test(nm))
                this.satom('K', nm);
            else if (!this.exeset && ((this.py && nm === 'sys.executable') || (lang === 'node' && nm === 'process.execPath')))
                this.satom('X', this.py ? 'python3' : 'node');
            else if (this.py && /^(os[.](environ|P_[A-Z]+)|subprocess[.](PIPE|STDOUT|DEVNULL))$/.test(cn))
                this.satom('K', cn);
            else
                this.spbad = 1;
        }
        if (this.py && nm === 'lambda' && this.d > 0) {
            const t = this.fidAt(this.d);
            if ((this.atok[t] ?? 0) === 0 && !this.aoth[t])
                this.alam[t] = 1;
        }
        const lone = this.d > 0 && (this.py || lang === 'node') && (this.atok[this.fidAt(this.d)] ?? 0) === 0 && !this.aoth[this.fidAt(this.d)];
        this.tok('E', '');
        if (lone && /^[A-Za-z_][A-Za-z0-9_]*$/.test(nm))
            this.anam[this.fidAt(this.d)] = nm;
        const argv = lone && nm === (this.py ? 'sys.argv' : 'process.argv') ? /^[ \t]*\[[ \t]*([0-9]+)[ \t]*\][ \t]*[,)]/.exec(substr(this.s, this.ip)) : null;
        if (argv)
            this.aargv[this.fidAt(this.d)] = `${nm}[${Number(argv[1])}]`;
    }
    scan(program) {
        this.s = program;
        const { s, lang } = this;
        const n = s.length;
        this.prescan();
        while (this.ip <= n && !this.anom) {
            const { ip } = this;
            const c = this.at(ip);
            if (c === ' ' || c === '\t' || c === '\r') {
                this.ip++;
                continue;
            }
            if (c === '\n') {
                if (lang === 'ruby' && this.d > 0 && this.ftype[this.d] === 'pseudo') {
                    const t = this.fidAt(this.d);
                    if ((this.atok[t] ?? 0) > 0 || this.aoth[t])
                        this.endpseudo();
                }
                this.ip++;
                continue;
            }
            if (c === '\\') {
                this.ip += 2;
                continue;
            }
            if ((c === '#' && (this.py || ((lang === 'perl' || lang === 'ruby') && (ip === 1 || !/[A-Za-z0-9_$@.#/{(]/.test(this.at(ip - 1)))))) ||
                (lang === 'node' && this.at(ip, 2) === '//')) {
                const j = index(substr(s, ip), '\n');
                if (!j)
                    break;
                this.ip += j - 1;
                continue;
            }
            if (lang === 'node' && this.at(ip, 2) === '/*') {
                const j = index(substr(s, ip + 2), '*/');
                if (!j) {
                    this.anom = true;
                    break;
                }
                this.ip += j + 3;
                continue;
            }
            if (c === Q1 || c === '"' || (c === '`' && !this.py)) {
                this.str(c, '');
                continue;
            }
            if (lang === 'ruby' && c === '%' && this.at(ip + 1) === 'x' && /[\][(){}<>/|!~^]/.test(this.at(ip + 2))) {
                this.qlike(ip + 2);
                continue;
            }
            if (lang === 'ruby' && c === ':' && /[A-Za-z_]/.test(this.at(ip + 1)) && this.spx && this.role[this.d] !== 'ign') {
                let j = ip + 1;
                while (/[A-Za-z0-9_]/.test(this.at(j)))
                    j++;
                let k = j;
                while (/[ \t\n]/.test(this.at(k)))
                    k++;
                if (this.at(k, 2) === '=>' && (this.d === this.spx || this.role[this.d] === 'key')) {
                    this.setkey(this.at(ip + 1, j - ip - 1));
                    this.ip = k + 2;
                }
                else {
                    this.satom('K', this.at(ip, j - ip));
                    this.ip = j;
                }
                this.oth();
                this.pc = 0;
                continue;
            }
            if (/[A-Za-z_]/.test(c) || (!this.py && /[$@]/.test(c))) {
                this.name('', '', '');
                continue;
            }
            if (c === '.' && /[A-Za-z_]/.test(this.at(ip + 1))) {
                const rk = this.pc ? this.lastk : 'U';
                const rv = this.pc ? this.lastv : '';
                this.ip++;
                this.name(rk, rv, rk === 'P' || rk === 'PE' ? 'Path().' : rk === 'M' ? rv + '.' : '?().');
                continue;
            }
            if (/[0-9]/.test(c)) {
                const j = ip;
                while (this.ip <= n && /[0-9A-Za-z_.]/.test(this.at(this.ip)))
                    this.ip++;
                this.satom('N', this.at(j, this.ip - j));
                this.tok('E', '');
                this.pc = 0;
                continue;
            }
            if (c === '(' || c === '[' || c === '{') {
                this.opn('group', c === '(' ? ')' : c === '[' ? ']' : '}', '', '', '');
                this.ip++;
                this.pc = 0;
                continue;
            }
            if (c === ')' || c === ']' || c === '}') {
                while (this.d > 0 && this.ftype[this.d] === 'pseudo')
                    this.endone();
                if (this.d === 0 || this.fclose[this.d] !== c) {
                    this.anom = true;
                    break;
                }
                this.endone();
                this.pc = 1;
                this.ip++;
                continue;
            }
            if (c === ',') {
                if (this.d > 0 && (this.ftype[this.d] === 'call' || this.ftype[this.d] === 'pseudo'))
                    this.endarg(this.fidAt(this.d));
                else
                    this.oth();
                if (this.spx) {
                    if (this.d === this.spx) {
                        this.spai++;
                        this.slotstart(this.ip + 1);
                    }
                    else if (this.isopt[this.d]) {
                        this.role[this.d] = 'key';
                        this.nat[this.d] = 0;
                    }
                    else if (this.role[this.d] === 'elem')
                        this.nat[this.d] = 0;
                }
                this.ip++;
                this.pc = 0;
                continue;
            }
            if (c === ';' || this.at(ip, 2) === '||' || this.at(ip, 2) === '&&') {
                this.endpseudo();
                this.oth();
                this.ip += c === ';' ? 1 : 2;
                if (this.spx && this.role[this.d] !== 'ign')
                    this.spbad = 1;
                continue;
            }
            if (this.spx && this.role[this.d] !== 'ign')
                this.spbad = 1;
            this.oth();
            this.pc = 0;
            this.ip++;
        }
        if (!this.anom)
            this.endpseudo();
        if (this.anom || this.d > 0)
            this.print('A');
        return this.out;
    }
}
function sqt(v) {
    return Q1 + v.split(Q1).join(`${Q1}\\${Q1}${Q1}`) + Q1;
}
function unesc(v) {
    let o = '';
    let i;
    while ((i = index(v, '\\')) > 0) {
        let ch = substr(v, i + 1, 1);
        if (ch === 'n')
            ch = '\n';
        else if (ch === 't')
            ch = '\t';
        else if (ch === '\n')
            ch = '';
        else if (ch !== '\\' && ch !== Q1 && ch !== '"')
            return '\x01';
        o += substr(v, 1, i - 1) + ch;
        v = substr(v, i + 2);
    }
    return o + v;
}
function pyesc(v) {
    let i;
    while ((i = index(v, '\\')) > 0) {
        const ch = substr(v, i + 1, 1);
        if (/[xuU0-7]/.test(ch) || (ch === 'N' && substr(v, i + 2, 1) === '{'))
            return true;
        v = substr(v, i + 2);
    }
    return false;
}
function runner(cn) {
    if (RUNRE.test(cn))
        return /^timeit[.]/.test(cn) ? 't' : 'c';
    if (/^((builtins|__builtins__)[.])?compile$/.test(cn))
        return 'c';
    return '';
}
function wmode(m) {
    const x = m.replace(/[:|].*$/s, '');
    return /^[rwxabtUs+]+$/.test(x) && /[wax+]/.test(x);
}
function wkind(last, pre) {
    if (last === 'open' || last === 'openSync')
        return 'open';
    if (last === 'truncate' && /(^|[.:])(os|fs|fsp|promises|File)$/.test(pre))
        return 'trunc';
    if (last === 'ZipFile' || last === 'PyZipFile')
        return 'zip';
    if (/^(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|rmSync|rmdirSync|unlinkSync|truncateSync|makedirs|removedirs|rmtree|mkdtemp|mkdtempSync|mkfifo|mkpath|make_path|remove_tree|mkdir_p|rm_rf|rm_r|rm_f|dump_stats)$/.test(last))
        return 'p1';
    if ((last === 'write' || last === 'binwrite') && /(^|[.:])(File|IO)$/.test(pre))
        return 'fw';
    if (last === 'write_text' || last === 'write_bytes')
        return 'wt';
    if (/^(mkdir|rmdir|unlink|rm|touch)$/.test(last) || (last === 'remove' && /(^|\.)os$/.test(pre)) || (last === 'delete' && /(^|[.:])File$/.test(pre)))
        return 'pn';
    if (/^(copyFileSync|cpSync|copyFile|copyfile|copy2|copytree|symlinkSync|linkSync|symlink|link)$/.test(last) ||
        (/^(copy|cp|cp_r)$/.test(last) && (pre === '' || /(^|[.:])(shutil|fs|fsp|promises|\?\(\)|FileUtils|Copy)$/.test(pre))))
        return 'dst';
    if (/^(renameSync|rename|renames)$/.test(last) ||
        (last === 'replace' && /(^|\.)os$/.test(pre)) ||
        (/^(move|mv)$/.test(last) && (pre === '' || /(^|[.:])(shutil|FileUtils|Copy)$/.test(pre))))
        return 'mv';
    return '';
}
/** The lines _tmb_cmd_prog_calls prints for `program`, as the line stream bash reads them. */
export function progCalls(lang, program) {
    const bytes = Buffer.from(program, 'utf8').toString('latin1');
    const out = new Scanner(lang).scan(bytes);
    if (out.length === 0)
        return [];
    return Buffer.from(out.join('\n'), 'latin1').toString('utf8').split('\n');
}
//# sourceMappingURL=prog-calls.js.map