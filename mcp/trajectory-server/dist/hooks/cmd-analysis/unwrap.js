/**
 * The wrapper skipping shared by the scanners (_TMB_CMD_UNWRAP_AWK in
 * cmd-analysis.sh): VAR=value words and sudo / env / command / nohup / time /
 * exec with their own options, each wrapper by its own option table. The TS
 * analyzer also skips timeout (and its duration), stdbuf and nice, and their
 * Homebrew coreutils names gtimeout, gstdbuf and gnice, which the .sh does not
 * (GH 1692).
 */
const NO_SPEC = { short: '', dirShort: '', long: ' ', dirLong: ' ' };
const SPECS = {
    sudo: {
        short: 'CDRTUcghprtu',
        dirShort: 'D',
        long: ' chdir chroot close-from command-timeout group host login-class other-user prompt role type user ',
        dirLong: ' chdir ',
    },
    env: { short: 'CPSu', dirShort: 'C', long: ' chdir split-string unset ', dirLong: ' chdir ' },
    time: { short: 'fo', dirShort: '', long: ' format output ', dirLong: ' ' },
    exec: { short: 'a', dirShort: '', long: ' ', dirLong: ' ' },
    timeout: { short: 'ks', dirShort: '', long: ' kill-after signal ', dirLong: ' ' },
    stdbuf: { short: 'eio', dirShort: '', long: ' error input output ', dirLong: ' ' },
    nice: { short: 'n', dirShort: '', long: ' adjustment ', dirLong: ' ' },
};
SPECS.gtimeout = SPECS.timeout;
SPECS.gstdbuf = SPECS.stdbuf;
SPECS.gnice = SPECS.nice;
export const WRAPPER = /^(sudo|env|command|nohup|time|exec|g?timeout|g?stdbuf|g?nice)$/;
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** <b> under dir <a>, as written: an absolute, ~ or $ path stands alone. */
export function under(a, b) {
    if (a === '' || /^[/~$]/.test(b))
        return b;
    if (b === '.')
        return a;
    return `${a}/${b}`;
}
/** awk split(s, w, /[ \t]+/), 0-based. */
export function splitWords(s) {
    return s === '' ? [] : s.split(/[ \t]+/);
}
/**
 * From index k of w, the index of the real argv0 and the dirs the skipped
 * wrappers run it in (env -C / --chdir, sudo -D / --chdir, a `--chdir=<dir>` word).
 */
export function unwrap(w, k) {
    const dirs = [];
    const n = w.length;
    while (k < n) {
        const a = w[k];
        if (a === '' || ASSIGNMENT.test(a)) {
            k++;
            continue;
        }
        if (/^--chdir=./.test(a)) {
            dirs.push(a.slice(8));
            k++;
            continue;
        }
        if (!WRAPPER.test(a))
            break;
        const spec = SPECS[a] ?? NO_SPEC;
        k++;
        while (k < n && w[k].startsWith('-')) {
            const opt = w[k];
            k++;
            if (opt === '--')
                break;
            if (opt === '-')
                continue;
            if (opt.startsWith('--')) {
                let name = opt.slice(2);
                let value = '';
                const eq = name.indexOf('=');
                if (eq >= 0) {
                    value = name.slice(eq + 1);
                    name = name.slice(0, eq);
                }
                if (!spec.long.includes(` ${name} `))
                    continue;
                if (eq < 0) {
                    value = w[k] ?? '';
                    k++;
                }
                if (spec.dirLong.includes(` ${name} `) && value !== '')
                    dirs.push(value);
                continue;
            }
            for (let j = 1; j < opt.length; j++) {
                const ch = opt[j];
                if (!spec.short.includes(ch))
                    continue;
                let value = opt.slice(j + 1);
                if (value === '') {
                    value = w[k] ?? '';
                    k++;
                }
                if (spec.dirShort.includes(ch) && value !== '')
                    dirs.push(value);
                break;
            }
        }
        if ((a === 'timeout' || a === 'gtimeout') && k < n)
            k++;
    }
    return { k, dirs };
}
//# sourceMappingURL=unwrap.js.map