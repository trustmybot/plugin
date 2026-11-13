// Lint and test runners as L1 symbols (GH 2326): each runner target (a
// package.json script, a Makefile, justfile or Taskfile target, a pyproject
// script) and each CI step (GitHub Actions `run:`, GitLab `script:`) the env
// readers parse becomes a kind='runner' row, with a name-only 'covers' edge to
// every repo directory its command names. Precision over recall: a token
// counts only when it resolves to an indexed directory, or names an indexed
// file (its parent directory counts); a `cd X` with nothing after it naming a
// directory covers X. A CI step runs from the repo root, a runner target from
// its manifest's directory.
import { posix } from 'node:path';
import { clip, DOC_MAX, md5, oneLine } from './extract.js';
const GLOB = /[*?[{]/;
const NOT_A_PATH = /[\s^$|()\\<>'"`;&]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT_ALONE = /^\d*(>>?|<)&?$/;
const REDIRECT = /^\d*[<>]/;
const SIGNATURE_MAX = 200;
// The indexed directories (every ancestor of an indexed file, '.' for the
// root) and files of a repo.
export function repoPaths(files) {
    const out = { dirs: new Set(['.']), files: new Set() };
    for (const f of files) {
        out.files.add(f);
        for (let d = posix.dirname(f); d !== '.' && !out.dirs.has(d); d = posix.dirname(d))
            out.dirs.add(d);
    }
    return out;
}
// A shell-word split into simple commands: quotes and backslashes are
// honoured, a word holding an unquoted or double-quoted $ or backtick is
// dynamic, and &&, ||, |, ;, &, parentheses, newlines and # comments end a
// command.
export function shellCommands(command) {
    const commands = [];
    let words = [];
    let text = '';
    let started = false;
    let dynamic = false;
    const endWord = () => {
        if (started)
            words.push({ text, dynamic });
        text = '';
        started = false;
        dynamic = false;
    };
    const endCommand = () => {
        endWord();
        if (words.length > 0)
            commands.push(words);
        words = [];
    };
    for (let i = 0; i < command.length; i++) {
        const c = command[i];
        if (c === '\\') {
            if (command[i + 1] === '\n') {
                i++;
                continue;
            }
            if (i + 1 < command.length)
                text += command[++i];
            started = true;
        }
        else if (c === "'") {
            const close = command.indexOf("'", i + 1);
            const end = close < 0 ? command.length : close;
            text += command.slice(i + 1, end);
            started = true;
            i = end;
        }
        else if (c === '"') {
            started = true;
            for (i++; i < command.length && command[i] !== '"'; i++) {
                const d = command[i];
                if (d === '\\' && i + 1 < command.length)
                    text += command[++i];
                else {
                    if (d === '$' || d === '`')
                        dynamic = true;
                    text += d;
                }
            }
        }
        else if (c === '$' || c === '`') {
            dynamic = true;
            started = true;
            text += c;
        }
        else if (c === '#' && !started) {
            while (i + 1 < command.length && command[i + 1] !== '\n')
                i++;
        }
        else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
            endCommand();
        }
        else if (c === ' ' || c === '\t' || c === '\r') {
            endWord();
        }
        else {
            text += c;
            started = true;
        }
    }
    endCommand();
    return commands;
}
// base joined with rel and normalized, without a trailing slash; null when it
// leaves the repo root.
function joinRepo(base, rel) {
    if (posix.isAbsolute(rel) || rel.startsWith('~'))
        return null;
    const p = posix.normalize(posix.join(base, rel)).replace(/\/+$/, '') || '.';
    return p === '..' || p.startsWith('../') ? null : p;
}
// The directory one argument names: a bare word only when it is a directory;
// a word with a separator by its static prefix (the segments before the first
// *?[{), when that is a directory or, with no glob, an indexed file. A glob
// with no separator (`*.js`, `v[0-9]*`, `[`, `{`) names nothing: in a shell
// step it is as often a pattern or a builtin as a path.
function dirOfWord(word, base, known) {
    if (NOT_A_PATH.test(word))
        return null;
    const segments = word.split('/');
    const globAt = segments.findIndex((s) => GLOB.test(s));
    if (globAt >= 0 && segments.length === 1)
        return null;
    const target = joinRepo(base, (globAt < 0 ? segments : segments.slice(0, globAt)).join('/'));
    if (target === null)
        return null;
    if (known.dirs.has(target))
        return target;
    if (globAt < 0 && word.includes('/') && known.files.has(target))
        return posix.dirname(target);
    return null;
}
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUN_SCRIPT = new Set(['run', 'run-script']);
const PRINTERS = new Set(['echo', 'printf']);
const TARGET_RUNNERS = new Set(['make', 'just', 'task']);
// The argument indexes of one simple command that are names, not paths: a
// package manager's `run <script>`, every echo/printf argument, and each bare
// make/just/task target.
function nameArgs(words) {
    const out = new Set();
    const tool = posix.basename(words[0].text);
    const nextBare = (from) => {
        let i = from;
        while (i < words.length && words[i].text.startsWith('-'))
            i++;
        return i;
    };
    if (PRINTERS.has(tool)) {
        for (let i = 1; i < words.length; i++)
            out.add(i);
    }
    else if (TARGET_RUNNERS.has(tool)) {
        for (let i = 1; i < words.length; i++)
            if (!words[i].text.includes('/'))
                out.add(i);
    }
    else if (PACKAGE_MANAGERS.has(tool)) {
        const run = nextBare(1);
        if (run < words.length && RUN_SCRIPT.has(words[run].text)) {
            out.add(run);
            const script = nextBare(run + 1);
            if (script < words.length)
                out.add(script);
        }
    }
    return out;
}
// The repo directories a runner's command checks, run from base, in first
// mention order.
export function coveredDirs(command, base, known) {
    const out = new Set();
    let cwd = base;
    let cdDir = null;
    let ranSinceCd = false;
    let foundSinceCd = false;
    const closeCd = () => {
        if (cdDir !== null && ranSinceCd && !foundSinceCd)
            out.add(cdDir);
        cdDir = null;
    };
    for (const raw of shellCommands(command)) {
        let at = 0;
        while (at < raw.length && !raw[at].dynamic && ASSIGNMENT.test(raw[at].text))
            at++;
        const words = raw.slice(at);
        if (words.length === 0)
            continue;
        if (words[0].text === 'cd') {
            closeCd();
            const arg = words[1];
            cwd = !arg || arg.dynamic || arg.text.startsWith('-') || cwd === null ? null : joinRepo(cwd, arg.text);
            cdDir = cwd !== null && known.dirs.has(cwd) ? cwd : null;
            ranSinceCd = false;
            foundSinceCd = false;
            continue;
        }
        if (cwd === null)
            continue;
        ranSinceCd = true;
        const names = nameArgs(words);
        for (let i = 1; i < words.length; i++) {
            const w = words[i];
            if (REDIRECT_ALONE.test(w.text)) {
                i++;
                continue;
            }
            if (names.has(i))
                continue;
            if (w.dynamic || w.text === '' || w.text.startsWith('-') || REDIRECT.test(w.text) || ASSIGNMENT.test(w.text))
                continue;
            const dir = dirOfWord(w.text, cwd, known);
            if (dir === null)
                continue;
            out.add(dir);
            foundSinceCd = true;
        }
    }
    closeCd();
    return [...out];
}
// One file's runners: its runner targets by name and its CI steps as
// ci:<line>, a name met twice keeping its first line with the commands joined.
function runnersOf(out) {
    const byName = new Map();
    const add = (name, line, command) => {
        const seen = byName.get(name);
        if (seen)
            seen.command = `${seen.command}\n${command}`;
        else
            byName.set(name, { name, line, command });
    };
    for (const t of out.runner_targets ?? [])
        add(t.name, t.line, t.command);
    for (const s of out.ci_steps ?? [])
        add(`ci:${s.line}`, s.line, s.run);
    return [...byName.values()];
}
// The runner rows and covers edges of one manifest or CI file, given what its
// env reader returned; null when it declares no runner.
export function extractRunners(path, read, ci, known) {
    const runners = runnersOf(read);
    if (runners.length === 0)
        return null;
    const base = ci ? '.' : posix.dirname(path);
    const out = { symbols: [], edges: [] };
    for (const r of runners) {
        const dirs = coveredDirs(r.command, base, known);
        out.symbols.push({
            kind: 'runner',
            qualified_name: r.name,
            signature: clip(oneLine(r.command), SIGNATURE_MAX),
            doc: clip(`${ci ? 'CI step' : 'runner target'} in ${path}${dirs.length > 0 ? `; covers ${dirs.join(', ')}` : ''}`, DOC_MAX),
            start_line: r.line,
            end_line: r.line,
            body_hash: md5(r.command),
            exported: 1,
        });
        const src = out.symbols.length - 1;
        for (const d of dirs)
            out.edges.push({ src, kind: 'covers', dst_name: d, line: r.line, hint: null });
    }
    return out;
}
//# sourceMappingURL=runners.js.map