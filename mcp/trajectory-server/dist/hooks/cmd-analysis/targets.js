/**
 * The paths one encoded statement writes, as written: its write targets, the
 * files it edits in place, the sources a mv / git mv removes and the tree a
 * git command writes.
 */
import { braceWords } from './brace.js';
import { decode, QO } from './encode.js';
import { splitWords, under, unwrap } from './unwrap.js';
const basename = (w) => w.replace(/.*\//, '');
const TAR = /^(tar|gtar|bsdtar)$/;
/** Whether <word> is GNU long option --<long>, spelled out or cut to a prefix of at least <min> chars. */
function longOption(word, long, min) {
    const name = word.startsWith('--') ? word.slice(2) : '';
    return name.length >= min && long.startsWith(name);
}
/** Whether tar's argument words extract: a bundled first word holding `x` (`tar xf a.tar`), or a `-x` cluster, `--extract` or `--get` before any `--`. */
function tarExtracts(args) {
    if (/^[A-Za-z]*x[A-Za-z]*$/.test(args[0] ?? ''))
        return true;
    for (const a of args) {
        if (a === '--')
            return false;
        if (/^-[A-Za-z]*x/.test(a) || longOption(a, 'extract', 3) || a === '--get')
            return true;
    }
    return false;
}
/** Whether cp's argument words copy recursively: an `-r` / `-R` / `-a` cluster, `--recursive` or `--archive` before any `--`. */
function cpRecursive(args) {
    for (const a of args) {
        if (a === '--')
            return false;
        if (/^-[A-Za-z]*[rRa]/.test(a) || longOption(a, 'recursive', 3) || longOption(a, 'archive', 2))
            return true;
    }
    return false;
}
/** A cp / mv / rsync's argument words: its `-t` / `--target-directory` values, its operands, and whether `-T` is given; <valued> options take the next word. */
function copyArgs(args, valued) {
    const r = { tdirs: [], operands: [], noTargetDir: false };
    let ended = false;
    for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (ended || a === '-' || !a.startsWith('-'))
            r.operands.push(a);
        else if (a === '--')
            ended = true;
        else if (a === '-t' || a === '--target-directory') {
            if (k + 1 < args.length)
                r.tdirs.push(args[k + 1]);
            k++;
        }
        else if (a.startsWith('--target-directory='))
            r.tdirs.push(a.slice('--target-directory='.length));
        else if (a === '--no-target-directory' || /^-[A-Za-z]*T/.test(a))
            r.noTargetDir = true;
        else if (valued?.test(a))
            k++;
    }
    return r;
}
/** The dirs a cp / rsync copies into: each `-t` / `--target-directory` value, else its last operand unless that is a remote `host:path`. */
function copyDestinations(args) {
    const { tdirs, operands } = copyArgs(args);
    if (tdirs.length > 0)
        return tdirs;
    const last = operands[operands.length - 1];
    return operands.length >= 2 && !/^[^/]*:/.test(last) ? [last] : [];
}
/** Where a source moved into <dir> lands: `<dir>/<its basename>`, or <dir> itself when the shell fills the name in. */
function landing(dir, source) {
    const name = basename(source.replace(/\/+$/, ''));
    if (name === '' || name === '.' || name === '..' || /[$`]/.test(name) || name.includes(QO))
        return dir;
    return `${dir.replace(/\/+$/, '')}/${name}`;
}
/**
 * The paths a mv / git mv's sources land at (each `<dest>/<source basename>`,
 * or with `-T` the destination itself): a move into a dir creates or
 * replaces only the entries named after its sources.
 */
function movedPaths(args, valued) {
    const { tdirs, operands, noTargetDir } = copyArgs(args, valued);
    if (tdirs.length > 0)
        return tdirs.flatMap((dir) => operands.map((source) => landing(dir, source)));
    if (operands.length < 2)
        return [];
    const dest = operands[operands.length - 1];
    return noTargetDir ? [dest] : operands.slice(0, -1).map((source) => landing(dest, source));
}
/**
 * Tree-writes mode: the dirs one command fills with a whole tree it copies,
 * moves or extracts: a recursive cp's and an rsync's destination, where a
 * mv's sources land, a tar extract's `-C` dirs, else its own dir, and an
 * unzip's `-d` dirs, else its own dir. Only these commands' arguments are
 * brace-expanded (braceWords, with <unresolvable> as its stand-in), as bash
 * passes them; no other command's words are.
 */
function treeTargetWords(w, out, unresolvable) {
    let pre = '';
    const u = unwrap(w, 0);
    for (const dir of u.dirs)
        pre = under(pre, dir);
    if (u.k >= w.length)
        return;
    const put = (p) => out.push(under(pre, p));
    const cmd = basename(w[u.k]);
    if (cmd !== 'mv' && cmd !== 'rsync' && cmd !== 'cp' && cmd !== 'unzip' && !TAR.test(cmd))
        return;
    const args = braceWords(w.slice(u.k + 1), unresolvable);
    if (cmd === 'mv')
        for (const p of movedPaths(args, /^(-S|--suffix)$/))
            put(p);
    else if (cmd === 'rsync' || (cmd === 'cp' && cpRecursive(args)))
        for (const d of copyDestinations(args))
            put(d);
    else if (cmd === 'unzip')
        for (const d of unzipDirs(args))
            put(d);
    else if (TAR.test(cmd) && tarExtracts(args))
        for (const d of tarDirs(args, '.'))
            put(d);
}
/** unzip's modes that write no file: list (`-l`, `-v`), test (`-t`), print to stdout (`-p`, `-c`), the comment (`-z`) and zipinfo (`-Z`). */
const UNZIP_NO_WRITE = 'lvtpczZ';
/** unzip's options besides `-d` that take a value: the password and the archive and file-name charsets. */
const UNZIP_VALUED = 'PIO';
/** The dirs an unzip extracts into, its options read in any order: each `-d` value, else its own dir; none in a mode that writes no file. */
function unzipDirs(args) {
    const dirs = [];
    for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (!a.startsWith('-') || a.startsWith('--') || a === '-')
            continue;
        for (let i = 1; i < a.length; i++) {
            const c = a[i];
            if (UNZIP_NO_WRITE.includes(c))
                return [];
            if (c !== 'd' && !UNZIP_VALUED.includes(c))
                continue;
            const value = i < a.length - 1 ? a.slice(i + 1) : args[++k];
            if (c === 'd' && value !== undefined)
                dirs.push(value);
            break;
        }
    }
    return dirs.length === 0 ? ['.'] : dirs;
}
/** Each dir tar's `-C` / `--directory` options move it to, composed in order, or [<none>] when there is none and <none> is given. */
function tarDirs(args, none) {
    const dirs = [];
    let cur = '';
    for (let k = 0; k < args.length; k++) {
        const a = args[k];
        let d = '';
        if (a === '--')
            break;
        if (a === '-C' || a === '--directory') {
            if (k < args.length - 1)
                d = args[k + 1];
            k++;
        }
        else if (a.startsWith('--directory='))
            d = a.slice('--directory='.length);
        else if (a.startsWith('-C') && a.length > 2)
            d = a.slice(2);
        if (d === '')
            continue;
        cur = under(cur, d);
        dirs.push(cur);
    }
    return dirs.length === 0 && none !== undefined ? [none] : dirs;
}
/**
 * The ln words from w[first + 1] on, read as GNU ln reads them: `-t` and
 * `-S` take a value (in their cluster or the next word), long options match
 * by unique prefix, and `--` ends the options.
 */
function lnArgs(w, first) {
    const r = { sym: false, tdirs: [], ops: [], late: false };
    let ended = false;
    for (let k = first + 1; k < w.length; k++) {
        const a = w[k];
        if (ended || a === '-' || !a.startsWith('-')) {
            r.ops.push(a);
            continue;
        }
        if (r.ops.length > 0)
            r.late = true;
        if (a === '--') {
            ended = true;
            continue;
        }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
            const value = eq < 0 ? undefined : a.slice(eq + 1);
            const is = (long, min) => name.length >= min && long.startsWith(name);
            if (is('target-directory', 1)) {
                const d = value ?? w[++k];
                if (d !== undefined)
                    r.tdirs.push(d);
            }
            else if (is('suffix', 2)) {
                if (value === undefined)
                    k++;
            }
            else if (is('symbolic', 2))
                r.sym = true;
            continue;
        }
        for (let j = 1; j < a.length; j++) {
            const c = a[j];
            if (c === 't' || c === 'S') {
                const v = j + 1 < a.length ? a.slice(j + 1) : w[++k];
                if (c === 't' && v !== undefined)
                    r.tdirs.push(v);
                break;
            }
            if (c === 's')
                r.sym = true;
        }
    }
    return r;
}
/**
 * With `final` (nothing runs after this statement), a symbolic ln writes only
 * its link paths: its TARGET is judged only where a later write through the
 * link could reach it (GH 1789).
 */
function writeTargetWords(w, out, final = false) {
    let pre = '';
    const u = unwrap(w, 0);
    for (const dir of u.dirs) {
        pre = under(pre, dir);
        out.push(pre);
    }
    const first = u.k;
    const nw = w.length;
    if (first >= nw)
        return;
    const put = (p) => out.push(under(pre, p));
    const cmd = basename(w[first]);
    const nonopt = [];
    const diropts = (short, long, compose) => {
        let cur = '';
        for (let k = first + 1; k < nw; k++) {
            const a = w[k];
            let d = '';
            if (a === '--')
                break;
            if (a === short || a === long) {
                if (k < nw - 1)
                    d = w[k + 1];
                k++;
            }
            else if (a.startsWith(long + '='))
                d = a.slice(long.length + 1);
            else if (a.startsWith(short) && a.length > 2)
                d = a.slice(2);
            if (d === '')
                continue;
            cur = compose ? under(cur, d) : d;
            put(cur);
        }
    };
    if (/^(tee|mkdir|rm|touch|rmdir)$/.test(cmd)) {
        for (let k = first + 1; k < nw; k++)
            if (!w[k].startsWith('-'))
                put(w[k]);
    }
    else if (TAR.test(cmd)) {
        for (const d of tarDirs(w.slice(first + 1), tarExtracts(w.slice(first + 1)) ? '.' : undefined))
            put(d);
    }
    else if (/^(make|gmake)$/.test(cmd)) {
        diropts('-C', '--directory', true);
    }
    else if (cmd === 'npm') {
        diropts('-C', '--prefix', false);
    }
    else if (cmd === 'ln' || cmd === 'link') {
        const { sym, tdirs, ops, late } = lnArgs(w, first);
        nonopt.push(...ops);
        const nn = nonopt.length;
        let last = nn;
        for (const d of tdirs)
            put(d);
        if (tdirs.length === 0 && nn >= 2) {
            put(nonopt[nn - 1]);
            last = nn - 1;
        }
        else if (tdirs.length === 0 && nn === 1)
            put('./' + basename(nonopt[0].replace(/\/+$/, '')));
        if (late) {
            put(w[nw - 1]);
            for (const a of nonopt)
                put(a);
        }
        if (cmd === 'ln' && sym && !late && final)
            return;
        for (let k = 0; k < last; k++) {
            const a = nonopt[k];
            if (!sym || a.startsWith('/')) {
                put(a);
                continue;
            }
            if (tdirs.length > 0) {
                for (const d of tdirs)
                    put(d + '/' + a);
                continue;
            }
            if (nn < 2) {
                put(a);
                continue;
            }
            let val = nonopt[nn - 1];
            if (val.includes('/')) {
                val = val.replace(/\/[^/]*\/?$/, '');
                if (val === '')
                    val = '/';
            }
            else
                val = '.';
            put(val + '/' + a);
            put(nonopt[nn - 1] + '/' + a);
        }
    }
    else if (/^(cp|mv|install|rsync)$/.test(cmd)) {
        let installdir = false;
        let linkcopy = false;
        for (let k = first + 1; k < nw; k++) {
            const a = w[k];
            if (a === '-t' || a === '--target-directory') {
                if (k < nw - 1)
                    put(w[k + 1]);
                k++;
                continue;
            }
            if (a.startsWith('--target-directory=')) {
                put(a.slice('--target-directory='.length));
                continue;
            }
            if (cmd === 'install' && a === '-d') {
                installdir = true;
                continue;
            }
            if (cmd === 'cp' && (a === '--symbolic-link' || a === '--link' || /^-[A-Za-z]*[sl]/.test(a))) {
                linkcopy = true;
                continue;
            }
            if (a.startsWith('-'))
                continue;
            nonopt.push(a);
        }
        const nn = nonopt.length;
        if (installdir || linkcopy)
            for (const a of nonopt)
                put(a);
        else if (nn >= 2 && !/^[^/]*:/.test(nonopt[nn - 1]))
            put(nonopt[nn - 1]);
    }
    else if (cmd === 'dd') {
        for (let k = first + 1; k < nw; k++)
            if (/^of=./.test(w[k]))
                put(w[k].slice(3));
    }
    else if (cmd === 'truncate') {
        for (let k = first + 1; k < nw; k++) {
            if (/^(-s|-r|--size|--reference)$/.test(w[k])) {
                k++;
                continue;
            }
            if (!w[k].startsWith('-'))
                put(w[k]);
        }
    }
    else if (cmd === 'git') {
        let k = first + 1;
        while (k < nw && w[k].startsWith('-')) {
            if (w[k] === '-C' || w[k] === '-c')
                k++;
            k++;
        }
        const at = (j) => (j < nw ? w[j] : undefined);
        if (at(k) === 'mv') {
            for (let j = k + 1; j < nw; j++)
                if (!w[j].startsWith('-'))
                    nonopt.push(w[j]);
            if (nonopt.length >= 2)
                put(nonopt[nonopt.length - 1]);
        }
        else if (at(k) === 'worktree' && at(k + 1) === 'add') {
            for (let j = k + 2; j < nw; j++) {
                if (/^(-b|-B|--reason)$/.test(w[j])) {
                    j++;
                    continue;
                }
                if (w[j].startsWith('-'))
                    continue;
                put(w[j]);
                break;
            }
        }
        else if (at(k) === 'worktree' && (at(k + 1) === 'remove' || at(k + 1) === 'move')) {
            for (let j = k + 2; j < nw; j++) {
                if (w[j] === '--reason') {
                    j++;
                    continue;
                }
                if (!w[j].startsWith('-'))
                    put(w[j]);
            }
        }
        else if (at(k) === 'clone') {
            let pos = 0;
            for (let j = k + 1; j < nw; j++) {
                if (/^(-b|-o|-c|-u|-j|--depth|--branch|--origin|--config|--reference|--jobs|--upload-pack|--template|--separate-git-dir)$/.test(w[j])) {
                    j++;
                    continue;
                }
                if (w[j].startsWith('-'))
                    continue;
                pos++;
                if (pos === 2) {
                    put(w[j]);
                    break;
                }
            }
        }
    }
}
/** tmb_cmd_write_targets of one encoded statement line; `final` holds for its last command only; with `tree`, only treeTargetWords' dirs. */
export function writeTargets(line, final = false, tree) {
    const out = [];
    let w = [];
    let want = 0;
    const flush = (last = false) => {
        if (tree)
            treeTargetWords(w, out, tree.unresolvable);
        else
            writeTargetWords(w, out, last && final);
        w = [];
    };
    const n = line.length;
    let i = 0;
    while (i < n) {
        let c = line[i];
        if (c === ' ' || c === '\t') {
            i++;
            continue;
        }
        if (c === ';' || c === '|' || c === '(' || c === ')') {
            flush();
            want = 0;
            i++;
            continue;
        }
        if (c === '&' && line[i + 1] === '>') {
            i += 2;
            if (line[i] === '>')
                i++;
            want = 1;
            continue;
        }
        if (c === '&') {
            flush();
            want = 0;
            i++;
            continue;
        }
        if (c === '<') {
            i++;
            while (line[i] === '<')
                i++;
            want = 2;
            continue;
        }
        if (c === '>') {
            i++;
            if (line[i] === '>' || line[i] === '|')
                i++;
            if (line[i] === '&') {
                i++;
                while (i < n && /[0-9-]/.test(line[i]))
                    i++;
                continue;
            }
            want = 1;
            continue;
        }
        let word = '';
        while (i < n) {
            c = line[i];
            if (/[ \t;|&()<]/.test(c))
                break;
            if (c === '>') {
                if (/^[0-9]+$/.test(word))
                    word = '';
                break;
            }
            word += c;
            i++;
        }
        if (word === '')
            continue;
        if (want === 1) {
            if (!tree)
                out.push(word);
            want = 0;
            continue;
        }
        if (want === 2) {
            want = 0;
            continue;
        }
        w.push(word);
    }
    flush(true);
    return out;
}
/** _tmb_cmd_unwrap: the dir the wrappers run a statement in, and its words from the real argv0 on. */
export function unwrapStatement(stmt) {
    const w = splitWords(stmt);
    const u = unwrap(w, 0);
    let pre = '';
    for (const dir of u.dirs)
        pre = under(pre, dir);
    return { pre, words: w.slice(u.k).filter((x) => x !== '') };
}
function inplaceFiles(tool, args) {
    let inplace = false;
    let hasprog = false;
    let skip = false;
    let ops = [];
    for (const w of args) {
        if (skip) {
            skip = false;
            continue;
        }
        if (w === '--')
            continue;
        if (tool === 'sed') {
            if (w.startsWith('--in-place') || w.startsWith('-i') || /^-[a-zA-Z].*i$/s.test(w))
                inplace = true;
            else if (/^(-e|-f|--expression|--file|-l)$/.test(w)) {
                hasprog = true;
                skip = true;
            }
            else if (w.startsWith('--expression=') || w.startsWith('--file='))
                hasprog = true;
            else if (/^-[a-zA-Z].*[ef]$/s.test(w)) {
                hasprog = true;
                skip = true;
            }
            else if (!w.startsWith('-'))
                ops.push(w);
        }
        else {
            if (w.startsWith('--'))
                continue;
            if (/^-.*[eE]$/s.test(w)) {
                if (w.includes('i'))
                    inplace = true;
                hasprog = true;
                skip = true;
            }
            else if (/^-.*i/s.test(w))
                inplace = true;
            else if (!w.startsWith('-'))
                ops.push(w);
        }
    }
    if (!inplace || ops.length === 0)
        return [];
    if (!hasprog)
        ops = ops.slice(1);
    return ops;
}
function gitTree(chain, words) {
    const n = words.length;
    let cdir = '';
    let tree = '';
    let k = 1;
    let usetree = true;
    let dir = '';
    let outs = [];
    const at = (j) => words[j] ?? '';
    while (k < n) {
        const w = words[k];
        if (w === '-C') {
            cdir = under(cdir, at(k + 1));
            k += 2;
        }
        else if (w === '--work-tree') {
            tree = at(k + 1);
            k += 2;
        }
        else if (w.startsWith('--work-tree=')) {
            tree = w.slice('--work-tree='.length);
            k++;
        }
        else if (/^(-c|--git-dir|--namespace|--config-env)$/.test(w))
            k += 2;
        else if (w.startsWith('-'))
            k++;
        else
            break;
    }
    const sub = at(k);
    const next = at(k + 1);
    if (/^(add|am|checkout|cherry-pick|clean|commit|merge|mergetool|pull|rebase|reset|restore|revert|rm|switch)$/.test(sub)) {
        // the working tree
    }
    else if (sub === 'stash') {
        if (next === 'list' || next === 'show')
            return [];
    }
    else if (sub === 'apply') {
        const all = ` ${words.slice(k).join(' ')} `;
        if (!all.includes(' --apply ') && /( --check | --stat | --numstat | --summary )/.test(all))
            return [];
    }
    else if (sub === 'bisect') {
        if (/^(|log|view|visualize|terms|help)$/.test(next))
            return [];
    }
    else if (sub === 'sparse-checkout') {
        if (/^(|list|check-rules)$/.test(next))
            return [];
    }
    else if (sub === 'submodule') {
        let j = k + 1;
        while (j < n && words[j].startsWith('-'))
            j++;
        if (!/^(update|add|deinit|absorbgitdirs)$/.test(at(j)))
            return [];
    }
    else if (sub === 'read-tree') {
        let j = k + 1;
        for (; j < n; j++) {
            const w = words[j];
            if (w === '--')
                break;
            if (w.startsWith('--'))
                continue;
            if (/^-.*u/s.test(w))
                break;
        }
        if (!(j < n && words[j] !== '--'))
            return [];
    }
    else if (sub === 'checkout-index') {
        for (let j = k + 1; j < n; j++) {
            if (/^--prefix=./s.test(words[j])) {
                outs.push(words[j].slice('--prefix='.length));
                usetree = false;
            }
        }
    }
    else if (sub === 'init') {
        usetree = false;
        for (let j = k + 1; j < n; j++) {
            const w = words[j];
            if (w === '--separate-git-dir') {
                outs.push(at(j + 1));
                j++;
            }
            else if (w.startsWith('--separate-git-dir='))
                outs.push(w.slice(w.indexOf('=') + 1));
            else if (/^(--template|-b|--initial-branch|--object-format|--ref-format)$/.test(w))
                j++;
            else if (w.startsWith('-'))
                continue;
            else if (dir === '')
                dir = w;
        }
        outs.push(dir || '.');
    }
    else if (sub === 'format-patch' || sub === 'archive') {
        usetree = false;
        const fp = sub === 'format-patch';
        for (let j = k + 1; j < n; j++) {
            const w = words[j];
            if (fp && w === '--stdout')
                return [];
            if (w === '-o' || w === '--output' || (fp && w === '--output-directory')) {
                outs.push(at(j + 1));
                j++;
            }
            else if (w.startsWith('--output=') || (fp && w.startsWith('--output-directory=')))
                outs.push(w.slice(w.indexOf('=') + 1));
            else if (/^-o./s.test(w))
                outs.push(w.slice(2));
            else if (w === '--')
                break;
        }
        if (outs.length === 0 && sub !== 'archive')
            outs.push('.');
    }
    else
        return [];
    if (usetree)
        outs = [tree || '.', ...outs];
    return outs.filter((w) => w !== '').map((w) => (chain ? under(cdir, w) : w));
}
/** The dir a pathspec body can write under: a glob cut to its leading literal dir. */
function globDir(spec) {
    const glob = spec.search(/[*?[]/);
    if (glob < 0)
        return spec === '' ? '.' : spec;
    const slash = spec.lastIndexOf('/', glob);
    return slash <= 0 ? (slash === 0 ? '/' : '.') : spec.slice(0, slash);
}
/**
 * A pathspec read as git reads its magic (gitglossary "pathspec"): the dir it
 * can write under, and whether that dir is named from the repository's top
 * (`:/…`, `:(top)…`, `:(glob,top)…`) rather than from the dir git runs in. An
 * exclusion (which git may widen to the whole tree) or a long form git cannot
 * parse reads as the whole tree from the top.
 */
function readPathspec(spec) {
    // A quoted `(` / `)` arrives encoded; decode maps each char to one char, so the magic read on `view` cuts `spec` at the same index.
    const view = decode(spec);
    if (!view.startsWith(':'))
        return { top: false, dir: globDir(spec) };
    let magic;
    let body;
    if (view[1] === '(') {
        const close = view.indexOf(')');
        if (close < 0)
            return { top: true, dir: '.' };
        magic = view.slice(2, close).split(',');
        body = spec.slice(close + 1);
    }
    else {
        const short = /^:([/!^]*):?/.exec(view) ?? ['', ''];
        magic = [...short[1]].map((c) => (c === '/' ? 'top' : 'exclude'));
        body = spec.slice(short[0].length);
    }
    if (magic.includes('exclude'))
        return { top: true, dir: '.' };
    return { top: magic.includes('top'), dir: magic.includes('literal') ? body || '.' : globDir(body) };
}
/**
 * Tree-writes mode: the paths a `git checkout` / `git restore` writes back
 * into its work tree, each operand brace-expanded and read as a pathspec (a tree-ish or branch
 * read so names no dir it writes), `--pathspec-from-file` as the whole tree
 * from the top, and where a `git mv`'s sources land. A `restore --staged`
 * without `--worktree` writes only the index. A pathspec named from the top,
 * or any pathspec under `--work-tree`, is a TopPath; under a `--git-dir`, or
 * with the tree mode's gitLocationSet and no `--work-tree`, its top cannot be told.
 */
function gitTreeWrites(chain, words, tree) {
    const out = { paths: [], tops: [] };
    const n = words.length;
    let cdir = '';
    let workTree = null;
    let gitDir = tree.gitLocationSet;
    let k = 1;
    const at = (j) => words[j] ?? '';
    while (k < n) {
        const w = words[k];
        if (w === '-C') {
            cdir = under(cdir, at(k + 1));
            k += 2;
        }
        else if (w === '--work-tree') {
            workTree = at(k + 1);
            k += 2;
        }
        else if (w.startsWith('--work-tree=')) {
            workTree = w.slice('--work-tree='.length);
            k++;
        }
        else if (w === '--git-dir' || w.startsWith('--git-dir=')) {
            gitDir = true;
            k += w === '--git-dir' ? 2 : 1;
        }
        else if (/^(-c|--namespace|--config-env)$/.test(w))
            k += 2;
        else if (w.startsWith('-'))
            k++;
        else
            break;
    }
    const rel = (p) => (chain ? under(cdir, p) : p);
    const sub = at(k);
    if (sub !== 'mv' && sub !== 'checkout' && sub !== 'restore')
        return out;
    const args = braceWords(words.slice(k + 1), tree.unresolvable);
    if (sub === 'mv') {
        out.paths.push(...movedPaths(args).map(rel));
        return out;
    }
    if (sub === 'restore' && args.includes('--staged') && !args.includes('--worktree') && !args.includes('-W'))
        return out;
    const valued = sub === 'checkout' ? /^(-b|-B|--orphan|--pathspec-from-file)$/ : /^(-s|--source|--pathspec-from-file)$/;
    const specs = [];
    let ended = false;
    for (let j = 0; j < args.length; j++) {
        const a = args[j];
        if (ended)
            specs.push(a);
        else if (a === '--')
            ended = true;
        else if (a === '--pathspec-from-file' || a.startsWith('--pathspec-from-file=')) {
            specs.push(':/');
            if (a === '--pathspec-from-file')
                j++;
        }
        else if (valued.test(a))
            j++;
        else if (!a.startsWith('-'))
            specs.push(a);
    }
    for (const spec of specs) {
        const { top, dir } = readPathspec(spec);
        if (workTree !== null) {
            // From outside the work tree git reads a plain pathspec from its top too.
            out.tops.push({ base: rel(workTree), find: false, rest: dir });
            if (!top)
                out.paths.push(rel(dir));
        }
        else if (gitDir)
            out.tops.push({ base: null, find: false, rest: dir });
        else if (top)
            out.tops.push({ base: rel('.'), find: true, rest: dir });
        else
            out.paths.push(rel(dir));
    }
    return out;
}
/** Tree-writes mode: a git command's tree writes and the interpreters' targets. */
function treeExtraWrites(chain, words, interp, tree) {
    const git = basename(words[0]) === 'git' ? gitTreeWrites(chain, words, tree) : { paths: [], tops: [] };
    return { paths: [...git.paths, ...interp(words)], tops: git.tops };
}
/** _tmb_cmd_stmt_extra_writes, the interpreter one-liners judged by `interp`. */
function extraWrites(chain, words, interp) {
    const out = [];
    let ops = [];
    const tool = basename(words[0]);
    if (tool === 'sed' || tool === 'perl')
        out.push(...inplaceFiles(tool, words.slice(1)));
    else if (tool === 'mv')
        ops = words.slice(1);
    else if (tool === 'git') {
        let k = 1;
        while (k < words.length) {
            if (words[k] === '-C' || words[k] === '-c')
                k += 2;
            else if (words[k].startsWith('-'))
                k++;
            else
                break;
        }
        if (words[k] === 'mv')
            ops = words.slice(k + 1);
        out.push(...gitTree(chain, words));
    }
    const srcs = ops.filter((w) => !w.startsWith('-'));
    if (srcs.length >= 2)
        out.push(...srcs.slice(0, -1));
    out.push(...interp(words));
    return out;
}
/** _tmb_cmd_stmt_write_paths: the encoded paths, and the words from the real argv0 on; `final` as in writeTargets; with `tree`, its tree writes only. */
export function stmtWritePaths(stmt, chain, interp, final = false, tree) {
    const paths = writeTargets(stmt, final, tree);
    const { pre, words } = unwrapStatement(stmt);
    if (words.length <= 1)
        return { paths, words, tops: [] };
    const fromPre = pre !== '' || chain;
    const extra = tree ? treeExtraWrites(fromPre, words, interp, tree) : { paths: extraWrites(fromPre, words, interp), tops: [] };
    if (pre === '')
        return { paths: [...paths, ...extra.paths], words, tops: extra.tops };
    for (const p of extra.paths)
        if (p !== '')
            paths.push(under(pre, p));
    const tops = extra.tops.map((t) => (t.base === null ? t : { ...t, base: under(pre, t.base) }));
    return { paths, words, tops };
}
//# sourceMappingURL=targets.js.map