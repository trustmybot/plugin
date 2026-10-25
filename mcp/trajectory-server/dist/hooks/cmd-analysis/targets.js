/**
 * The paths one encoded statement writes, as written: tmb_cmd_write_targets,
 * _tmb_cmd_inplace_files, the sources a mv / git mv removes and
 * _tmb_cmd_git_tree (cmd-analysis.sh).
 */
import { splitWords, under, unwrap } from './unwrap.js';
const basename = (w) => w.replace(/.*\//, '');
function writeTargetWords(w, out) {
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
    else if (/^(tar|gtar|bsdtar|make|gmake)$/.test(cmd)) {
        diropts('-C', '--directory', true);
    }
    else if (cmd === 'npm') {
        diropts('-C', '--prefix', false);
    }
    else if (cmd === 'ln' || cmd === 'link') {
        let sym = false;
        let tdir = '';
        for (let k = first + 1; k < nw; k++) {
            const a = w[k];
            if (a === '-t' || a === '--target-directory') {
                if (k < nw - 1)
                    tdir = w[k + 1];
                k++;
                continue;
            }
            if (a.startsWith('--target-directory=')) {
                tdir = a.slice('--target-directory='.length);
                continue;
            }
            if (a === '--symbolic') {
                sym = true;
                continue;
            }
            if (a.startsWith('--'))
                continue;
            if (a.startsWith('-')) {
                if (a.includes('s'))
                    sym = true;
                continue;
            }
            nonopt.push(a);
        }
        const nn = nonopt.length;
        let last = nn;
        if (tdir !== '')
            put(tdir);
        else if (nn >= 2) {
            put(nonopt[nn - 1]);
            last = nn - 1;
        }
        for (let k = 0; k < last; k++) {
            const a = nonopt[k];
            if (!sym || a.startsWith('/')) {
                put(a);
                continue;
            }
            if (tdir !== '') {
                put(tdir + '/' + a);
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
/** tmb_cmd_write_targets of one encoded statement line. */
export function writeTargets(line) {
    const out = [];
    let w = [];
    let want = 0;
    const flush = () => {
        writeTargetWords(w, out);
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
    flush();
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
/** _tmb_cmd_stmt_write_paths: the encoded paths, and the words from the real argv0 on. */
export function stmtWritePaths(stmt, chain, interp) {
    const paths = writeTargets(stmt);
    const { pre, words } = unwrapStatement(stmt);
    if (words.length <= 1)
        return { paths, words };
    if (pre === '')
        paths.push(...extraWrites(chain, words, interp));
    else
        for (const p of extraWrites(true, words, interp))
            if (p !== '')
                paths.push(under(pre, p));
    return { paths, words };
}
//# sourceMappingURL=targets.js.map