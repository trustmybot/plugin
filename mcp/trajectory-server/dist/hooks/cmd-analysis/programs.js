/**
 * The interpreter-program half of cmd-analysis.sh: _tmb_cmd_interp_writes,
 * _tmb_cmd_prog_writes, _tmb_cmd_prog_scan and _tmb_cmd_prog_literals. A
 * process call's command is judged by the caller's `procWrites`
 * (_tmb_cmd_proc_writes), which needs the whole analyzer.
 */
import { decode } from './encode.js';
import { progCalls } from './prog-calls.js';
const PY_RUNNERS = /^(timeit|cProfile|profile|trace|pdb|runpy|code|doctest|pydoc|pickle|py_compile|compileall)$/;
const SP = '[ \\t\\n\\v\\f\\r]*';
const Q = `['"]`;
const LIT = `${Q}[^'"]+${Q}`;
const FN = 'writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|renameSync|rmSync|rmdirSync|unlinkSync|copyFileSync|cpSync|fs\\.(mkdir|rename|rm|rmdir|unlink|copyFile|cp)|makedirs|rmtree|dump_stats|(File|IO)\\.(bin)?write|os\\.(remove|unlink|mkdir|rename|replace|rmdir)|shutil\\.(copy|copyfile|copy2|copytree|move)';
const SHAPE = new RegExp(`open${SP}\\([^)]*,${SP}(mode${SP}=${SP})?${Q}[rbt]*[wax+]|open${SP}\\(?[^,;()]*,${SP}${Q}[+]?>|write_text|write_bytes|createWriteStream|(${FN})${SP}\\(`);
const WRITES = new RegExp(`open${SP}\\(${SP}${LIT}${SP},${SP}(mode${SP}=${SP})?${Q}[rbt]*[wax+]|(${FN})${SP}\\(${SP}${LIT}|Path${SP}\\(${SP}${LIT}${SP}\\)${SP}\\.${SP}(write_text|write_bytes|mkdir|touch|unlink|rmdir|rename)`, 'g');
const READS = new RegExp(`open${SP}\\(${SP}${LIT}${SP}(,${SP}${Q}r[bt]?${Q}${SP})?\\)|(readFileSync|readFile|createReadStream|existsSync|statSync)${SP}\\(${SP}${LIT}|Path${SP}\\(${SP}${LIT}${SP}\\)${SP}\\.${SP}(read_text|read_bytes|exists)`, 'g');
const QUOTED = new RegExp(LIT, 'g');
const RAW_TOKEN = /['"][^'"\t\n\v\f\r ]+['"]/g;
const chomp = (s) => s.replace(/\n+$/, '');
const basename = (w) => w.replace(/.*\//, '');
const blank = (line) => !/[^ \t\n]/.test(line);
/** grep -o over the lines of `text`: every match, line by line. */
function grepO(text, re) {
    const out = [];
    for (const line of text.split('\n'))
        for (const m of line.matchAll(re))
            if (m[0] !== '')
                out.push(m[0]);
    return out;
}
/** _tmb_cmd_prog_scan: the scanner's lines, a code-string runner's `R<TAB><code>` replaced by `R` and the scan of the code. */
export function progScan(lang, program, depth = 0) {
    if (depth > 3)
        return ['W', 'U'];
    const out = [];
    for (const line of progCalls(lang, program)) {
        if (line.startsWith('R\t'))
            out.push('R', ...progScan(lang, chomp(line.slice(2).replace(/\x1f/g, '\n')), depth + 1));
        else
            out.push(line);
    }
    return out;
}
/** _tmb_cmd_prog_literals: every path-like literal not only read, one per line. */
function progLiterals(src, reads, writes, raw) {
    const lits = raw ? grepO(src, RAW_TOKEN) : src.split('\n');
    const out = [];
    for (let lit of lits) {
        if (lit.length < 2)
            continue;
        if (reads.includes(lit) && !writes.includes(lit))
            continue;
        lit = lit.slice(1, -1).replace(/^\+/, '').replace(/^>/, '').replace(/^>/, '');
        if (lit === '' || lit === '.' || lit === '..' || /[^A-Za-z0-9_./~-]/.test(lit))
            continue;
        if (lit.includes('/') || /\.[A-Za-z0-9]/.test(lit))
            out.push(lit);
    }
    return out;
}
/** _tmb_cmd_prog_writes: the lines it prints; `-` with `operands` for a program that writes but names no literal. */
export function progWrites(lang, program, operands, procWrites) {
    const scan = chomp(progScan(lang, program).join('\n'));
    const has = (line) => `\n${scan}\n`.includes(`\n${line}\n`);
    let fail = has('A') || has('F');
    const cd = has('C');
    const run = has('R');
    if (!has('W')) {
        if (!program.split('\n').some((line) => SHAPE.test(line)))
            return [];
        fail = true;
    }
    let out = '';
    let src = '';
    for (const line of scan.split('\n')) {
        const rest = line.slice(2);
        if (line === 'U')
            out += '$(proc)\n';
        else if (line === 'H')
            out += '$(alias-write)\n';
        else if (rest === '' || line[1] !== '\t')
            continue;
        else if (line[0] === 'T')
            out += rest + '\n';
        else if (line[0] === 'S')
            out += (cd ? '$(proc)' : chomp(procWrites(chomp(rest.replace(/\x1f/g, '\n'))))) + '\n';
        else if (line[0] === 'Q')
            src += rest + '\n';
    }
    let raw = false;
    if (has('A')) {
        src = program;
        raw = true;
    }
    if (fail) {
        const writes = grepO(program, WRITES)
            .map((m) => /^[^'"]*['"][^'"]+['"]/.exec(m)?.[0])
            .filter((m) => m !== undefined)
            .map((m) => /['"][^'"]+['"]$/.exec(m)?.[0])
            .filter((m) => m !== undefined);
        const reads = grepO(grepO(program, READS).join('\n'), QUOTED);
        out += progLiterals(src, reads, writes, raw).join('\n');
        if (run)
            out += '\n$(proc)';
    }
    let lines = out.split('\n');
    if (cd)
        lines = lines.filter((l) => !blank(l)).map((l) => (/^[/~$]/.test(l) ? '' : '$(proc)/') + l);
    const seen = new Set();
    lines = lines.filter((l) => !blank(l) && !seen.has(l) && seen.add(l) !== undefined);
    if (lines.length > 0)
        return lines;
    return operands ? ['-'] : [];
}
/** _tmb_cmd_interp_writes: the lines an interpreter one-liner's statement words add. */
export function interpWrites(words, procWrites) {
    const argv0 = basename(words[0] ?? '');
    let flags;
    let lang;
    let pyopt = false;
    if (/^(python|python3|python[23]\..*)$/s.test(argv0)) {
        flags = ['-c'];
        lang = 'py';
        pyopt = true;
    }
    else if (argv0 === 'node' || argv0 === 'nodejs') {
        flags = ['-e', '--eval', '-p', '--print'];
        lang = 'node';
    }
    else if (argv0 === 'perl') {
        flags = ['-e', '-E'];
        lang = 'perl';
    }
    else if (argv0 === 'ruby') {
        flags = ['-e'];
        lang = 'ruby';
    }
    else
        return [];
    const n = words.length;
    let k = 1;
    let optarg = false;
    let program = '';
    while (k < n) {
        const w = words[k++];
        if (pyopt) {
            const m = /^-[bBdEhiIOPqRsSuvx]*m(.*)$/s.exec(w);
            if (m) {
                pyopt = false;
                if (PY_RUNNERS.test(chomp(decode(m[1] || (words[k] ?? '')))))
                    return ['$(proc)'];
            }
            else if (optarg)
                optarg = false;
            else if (w === '-W' || w === '-X')
                optarg = true;
            else if (!w.startsWith('-'))
                pyopt = false;
        }
        if (flags.includes(w)) {
            program = chomp(decode(words[k] ?? ''));
            k++;
            break;
        }
    }
    if (program === '')
        return [];
    const found = progWrites(lang, program, true, procWrites);
    if (found.length === 0)
        return [];
    const out = found[0] === '-' && found.length === 1 ? [] : [...found];
    for (; k < n; k++)
        if (!words[k].startsWith('-'))
            out.push(...decode(words[k]).split('\n'));
    return out;
}
//# sourceMappingURL=programs.js.map