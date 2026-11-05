/**
 * `cli.js stale-docs` (GH 1955): the advisory pre-close check for docs and
 * comments a change left stale.
 *
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" stale-docs <base> [--head <sha>] [--max-hits <n>]
 *
 * Diffs `git merge-base <base> <head>` against <head>'s tree with --head, else
 * against the working tree's tracked files, in the current directory's repo.
 * Takes identifiers from the added and removed lines of changed non-doc files
 * (snake_case, camelCase, kebab-case of 8+ chars, and each changed file's
 * basename), then searches the doc lines: every line of tracked `*.md` files
 * and the comment lines of tracked `.ts`, `.sh`, `.sql` and `.mjs` files,
 * outside changelogs, `dist/`, `node_modules/` and generated docs. A line the
 * diff left untouched is a candidate for every token it names; a line the
 * diff added or changed only for a token its hunk's removed lines also name,
 * a mention the edit kept unchanged. A token on more than --max-hits (default 15) doc lines is
 * skipped as too common. Prints `<path>:<line>: <token>[, <token>...]` per
 * flagged line, sorted by path then line. Exit 0 whether or not anything is
 * flagged; 2 on bad usage or a git failure.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parseArgs } from 'node:util';
const USAGE = 'usage: cli.js stale-docs <base> [--head <sha>] [--max-hits <n>]\n';
const DEFAULT_MAX_HITS = 15;
const MIN_TOKEN_LENGTH = 6;
const MIN_KEBAB_LENGTH = 8;
const COMMENT_EXTENSIONS = new Set(['.ts', '.sh', '.sql', '.mjs']);
const COMMENT_LINE = /^\s*(\/\/|#|--|\*|\/\*)/;
const GENERATED_DOCS = new Set(['docs/contributing/ENUMS.md']);
const EXCLUDED_SEGMENTS = ['changelog.d', 'dist', 'node_modules'];
const EXCLUDED_PATHSPECS = EXCLUDED_SEGMENTS.map((segment) => `:(exclude,glob)**/${segment}/**`);
const COMMON_WORDS = new Set([
    'console_log',
    'forEach',
    'hasOwnProperty',
    'toString',
    'toLowerCase',
    'toUpperCase',
    'startsWith',
    'endsWith',
    'indexOf',
    'readFileSync',
    'writeFileSync',
    'existsSync',
    'spawnSync',
    'execFileSync',
    'mkdtempSync',
    'JSON_EXTRACT',
    'CURRENT_TIMESTAMP',
    'PRIMARY_KEY',
    'NOT_NULL',
    'node_modules',
    'README.md',
    'index.ts',
    'package.json',
]);
const WORD = /[A-Za-z0-9_]+/g;
const KEBAB = /\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g;
class GitError extends Error {
}
function git(cwd, args) {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (r.error)
        throw new GitError(`git ${args[0]}: ${r.error.message}`);
    if (r.status !== 0)
        throw new GitError(`git ${args[0]} failed: ${r.stderr.trim()}`);
    return r.stdout;
}
function isDoc(path) {
    return path.endsWith('.md');
}
function excluded(path) {
    if (GENERATED_DOCS.has(path) || posix.basename(path) === 'CHANGELOG.md')
        return true;
    return path.split('/').some((segment) => EXCLUDED_SEGMENTS.includes(segment));
}
function parseDiff(text) {
    const files = [];
    let file;
    let newLine = 0;
    let hunkRemoved = new Set();
    let inHunk = false;
    for (const line of text.split('\n')) {
        if (line.startsWith('diff --git ')) {
            file = { paths: [], added: [], removed: [], touched: new Map() };
            files.push(file);
            inHunk = false;
        }
        else if (!file) {
            continue;
        }
        else if (line.startsWith('@@')) {
            newLine = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
            hunkRemoved = new Set();
            inHunk = true;
        }
        else if (!inHunk) {
            if (line.startsWith('--- ') || line.startsWith('+++ ')) {
                const path = line.slice(4);
                if (path !== '/dev/null')
                    file.paths.push(path.replace(/^[ab]\//, ''));
            }
            else if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
                file.paths.push(line.replace(/^rename (from|to) /, ''));
            }
        }
        else if (line.startsWith('+')) {
            file.added.push(line.slice(1));
            file.touched.set(newLine++, hunkRemoved);
        }
        else if (line.startsWith('-')) {
            file.removed.push(line.slice(1));
            for (const span of spans(line.slice(1)))
                hunkRemoved.add(span);
        }
    }
    for (const f of files)
        f.paths = [...new Set(f.paths)];
    return files;
}
function keep(token) {
    return token.length >= MIN_TOKEN_LENGTH && !COMMON_WORDS.has(token);
}
function identifiers(files) {
    const tokens = new Set();
    for (const file of files) {
        if (file.paths.some((p) => isDoc(p) || excluded(p)))
            continue;
        for (const p of file.paths)
            if (keep(posix.basename(p)))
                tokens.add(posix.basename(p));
        for (const line of [...file.added, ...file.removed]) {
            for (const word of line.match(WORD) ?? []) {
                const token = word.replace(/^_+|_+$/g, '');
                if ((token.includes('_') || /[a-z][A-Z]/.test(token)) && /[A-Za-z]/.test(token) && keep(token))
                    tokens.add(token);
            }
            for (const token of line.match(KEBAB) ?? [])
                if (token.length >= MIN_KEBAB_LENGTH && keep(token))
                    tokens.add(token);
        }
    }
    return tokens;
}
function isDocLine(path, text) {
    if (excluded(path))
        return false;
    if (isDoc(path))
        return true;
    return COMMENT_EXTENSIONS.has(posix.extname(path)) && COMMENT_LINE.test(text);
}
// Every span of a line that starts and ends on a whole word and joins words
// only with `.` or `-`, so a token matches where it stands between non-word
// characters.
function spans(text) {
    const out = new Set();
    for (const run of text.match(/[A-Za-z0-9_.-]+/g) ?? []) {
        const parts = run.split(/([.-])/);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i] === '')
                continue;
            let span = parts[i];
            out.add(span);
            for (let j = i + 2; j < parts.length && parts[j] !== ''; j += 2) {
                span += parts[j - 1] + parts[j];
                out.add(span);
            }
        }
    }
    return out;
}
function docFiles(root, head) {
    const listed = git(root, head ? ['ls-tree', '-r', '-z', '--name-only', head] : ['ls-files', '-z']).split('\0');
    const paths = listed.filter((p) => p !== '' && !excluded(p) && (isDoc(p) || COMMENT_EXTENSIONS.has(posix.extname(p))));
    if (!head) {
        return paths.flatMap((path) => {
            try {
                return [{ path, text: readFileSync(join(root, path), 'utf8') }];
            }
            catch {
                return [];
            }
        });
    }
    const r = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: paths.map((p) => `${head}:${p}\n`).join(''), maxBuffer: 1024 * 1024 * 1024 });
    if (r.status !== 0)
        throw new GitError(`git cat-file failed: ${r.stderr.toString().trim()}`);
    const out = r.stdout;
    const files = [];
    let at = 0;
    for (const path of paths) {
        const eol = out.indexOf(0x0a, at);
        const header = out.subarray(at, eol).toString().split(' ');
        const size = Number(header[2]);
        if (header[1] !== 'blob')
            throw new GitError(`git cat-file: no blob for ${path}`);
        files.push({ path, text: out.subarray(eol + 1, eol + 1 + size).toString('utf8') });
        at = eol + 1 + size + 1;
    }
    return files;
}
function parseCount(raw) {
    if (raw === undefined)
        return DEFAULT_MAX_HITS;
    return /^\d+$/.test(raw) ? Number(raw) : undefined;
}
export function staleDocs(argv, _env, io) {
    let base;
    let head;
    let maxHits;
    try {
        const { values, positionals } = parseArgs({
            args: [...argv],
            allowPositionals: true,
            options: { head: { type: 'string' }, 'max-hits': { type: 'string' } },
        });
        if (positionals.length !== 1)
            throw new Error('expected one <base>');
        base = positionals[0];
        head = values.head;
        maxHits = parseCount(values['max-hits']);
        if (maxHits === undefined)
            throw new Error('--max-hits takes a non-negative integer');
    }
    catch (e) {
        io.err(`stale-docs: ${e.message}\n${USAGE}`);
        return 2;
    }
    try {
        const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
        const mergeBase = git(root, ['merge-base', base, head ?? 'HEAD']).trim();
        const files = parseDiff(git(root, ['diff', '--no-color', '--no-ext-diff', '-M', '--unified=0', mergeBase, ...(head ? [head] : []), '--', '.', ...EXCLUDED_PATHSPECS]));
        const touched = new Map();
        for (const f of files)
            touched.set(f.paths[f.paths.length - 1] ?? '', f.touched);
        const tokens = identifiers(files);
        if (tokens.size === 0)
            return 0;
        const hits = new Map();
        for (const { path, text } of docFiles(root, head)) {
            if (text.includes('\0'))
                continue;
            text.split('\n').forEach((lineText, i) => {
                const line = i + 1;
                if (!isDocLine(path, lineText))
                    return;
                const kept = touched.get(path)?.get(line);
                for (const span of spans(lineText)) {
                    if (!tokens.has(span) || (kept && !kept.has(span)))
                        continue;
                    const list = hits.get(span) ?? [];
                    list.push({ path, line });
                    hits.set(span, list);
                }
            });
        }
        const flagged = new Map();
        for (const [token, list] of hits) {
            if (list.length > maxHits)
                continue;
            for (const { path, line } of list) {
                const key = `${path}\0${line}`;
                const entry = flagged.get(key) ?? { path, line, tokens: [] };
                entry.tokens.push(token);
                flagged.set(key, entry);
            }
        }
        const rows = [...flagged.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
        io.out(rows.map((r) => `${r.path}:${r.line}: ${r.tokens.sort().join(', ')}\n`).join(''));
        return 0;
    }
    catch (e) {
        if (!(e instanceof GitError))
            throw e;
        io.err(`stale-docs: ${e.message}\n`);
        return 2;
    }
}
//# sourceMappingURL=stale-docs.js.map