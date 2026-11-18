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
const TEST_SCRIPT = /^test(:.+)?$/;
// Package-manager flags whose value is the next word (`npm --prefix web test`);
// a `--flag=value` form is one word. Any other flag is taken to have no value.
const PM_VALUE_FLAGS = new Set(['--prefix', '--cwd', '-C', '--dir', '--filter', '-F', '--workspace', '-w']);
// Whether flag takes the next word as its value under tool: pnpm's `-w` is
// `--workspace-root` and takes none.
function takesValue(tool, flag) {
    return PM_VALUE_FLAGS.has(flag) && !(tool === 'pnpm' && flag === '-w');
}
// The index of a package manager's first word at or after from that is neither
// a flag nor a value-taking flag's value; words.length when there is none.
function nextBare(tool, words, from) {
    let i = from;
    while (i < words.length && words[i].text.startsWith('-'))
        i += takesValue(tool, words[i].text) ? 2 : 1;
    return Math.min(i, words.length);
}
// The word indexes of a package-manager command that are names, subcommand
// first: the subcommand, yarn's `workspace <name>` and the script after `run`
// or after that name. script is the index of the script the command runs,
// words.length when there is none.
function packageManagerNames(tool, words) {
    const names = [];
    let script = nextBare(tool, words, 1);
    if (script >= words.length)
        return { names, script };
    names.push(script);
    if (tool === 'yarn' && words[script].text === 'workspace') {
        const workspace = nextBare(tool, words, script + 1);
        if (workspace >= words.length)
            return { names, script: workspace };
        names.push(workspace);
        script = nextBare(tool, words, workspace + 1);
        if (script >= words.length)
            return { names, script };
        names.push(script);
    }
    if (RUN_SCRIPT.has(words[script].text)) {
        script = nextBare(tool, words, script + 1);
        if (script < words.length)
            names.push(script);
    }
    return { names, script };
}
// Whether one simple command is a package manager running its test script:
// `npm test`, `pnpm test:unit`, `yarn run test`, `yarn workspace web test`,
// flags allowed before each name.
function isPackageManagerTest(words) {
    const tool = posix.basename(words[0].text);
    if (!PACKAGE_MANAGERS.has(tool))
        return false;
    const { script } = packageManagerNames(tool, words);
    return script < words.length && !words[script].dynamic && TEST_SCRIPT.test(words[script].text);
}
// The argument indexes of one simple command that are names, not paths: a
// package manager's subcommand when it has no '/', yarn's workspace name and
// the script it runs, each found past flags and the values of value-taking
// flags; every echo/printf argument; and each bare make/just/task target.
function nameArgs(words) {
    const out = new Set();
    const tool = posix.basename(words[0].text);
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
        // The subcommand is a name (`npm test`, `yarn lint`); one with a '/' is a
        // file the manager runs (`bun scripts/run.ts`).
        const [subcommand, ...rest] = packageManagerNames(tool, words).names;
        if (subcommand !== undefined && !words[subcommand].text.includes('/'))
            out.add(subcommand);
        for (const i of rest)
            out.add(i);
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
        let namedDir = false;
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
            namedDir = true;
            foundSinceCd = true;
        }
        // A bare package-manager test line checks the package it runs in.
        if (!namedDir && known.dirs.has(cwd) && isPackageManagerTest(words)) {
            out.add(cwd);
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