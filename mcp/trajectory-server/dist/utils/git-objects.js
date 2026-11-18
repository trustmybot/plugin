// Git object reads for the world model (GH 2584): a repo is indexed at one
// commit, its file list from `git ls-tree` and its blobs from one
// `git cat-file --batch` process, never from the working tree.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitUnanswered, runGit } from './git-run.js';
const TREE_MAX_BUFFER = 256 * 1024 * 1024;
const TREE_TIMEOUT_MS = 60_000;
function out(repoPath, args, timeout) {
    const res = runGit(repoPath, args, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: TREE_MAX_BUFFER, ...(timeout ? { timeout } : {}) });
    if (gitUnanswered(res) || res.status !== 0)
        return null;
    return res.stdout;
}
export function revParseCommit(repoPath, ref) {
    const sha = out(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim();
    return sha ? sha : null;
}
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function gitDirsOf(repoPath) {
    const dotGit = join(repoPath, '.git');
    let gitDir;
    try {
        if (statSync(dotGit).isDirectory())
            gitDir = dotGit;
        else {
            const m = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'));
            if (!m)
                return null;
            gitDir = resolve(repoPath, m[1].trim());
        }
    }
    catch {
        return null;
    }
    let commonDir = gitDir;
    try {
        commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    }
    catch {
        /* not a linked worktree */
    }
    if (existsSync(join(commonDir, 'reftable')))
        return null;
    return { gitDir, commonDir };
}
function readOptional(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch (err) {
        const code = err.code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined;
    }
}
// A ref's sha read from the git dir: null when the ref does not exist,
// undefined when the files cannot say (the caller asks git instead).
function lookupRef(dirs, ref, depth = 0) {
    if (depth > 5 || !(ref === 'HEAD' || ref.startsWith('refs/')) || ref.split('/').includes('..'))
        return undefined;
    const loose = readOptional(join(ref === 'HEAD' ? dirs.gitDir : dirs.commonDir, ref));
    if (loose === undefined)
        return undefined;
    if (loose !== null) {
        const text = loose.trim();
        if (FULL_SHA.test(text))
            return text;
        const sym = /^ref: (\S+)$/.exec(text);
        return sym ? lookupRef(dirs, sym[1], depth + 1) : undefined;
    }
    if (ref === 'HEAD')
        return undefined;
    const packed = readOptional(join(dirs.commonDir, 'packed-refs'));
    if (packed === undefined)
        return undefined;
    if (packed === null)
        return null;
    for (const line of packed.split('\n')) {
        if (line.startsWith('#') || line.startsWith('^'))
            continue;
        const space = line.indexOf(' ');
        if (space > 0 && line.slice(space + 1).trim() === ref) {
            const sha = line.slice(0, space);
            return FULL_SHA.test(sha) ? sha : undefined;
        }
    }
    return null;
}
// revParseCommit for HEAD or a full refs/ name, read from the ref files when
// they answer, so the per-read freshness check spawns no git.
export function resolveRefCommit(repoPath, ref) {
    const dirs = gitDirsOf(repoPath);
    const fast = dirs ? lookupRef(dirs, ref) : undefined;
    return fast !== undefined ? fast : revParseCommit(repoPath, ref);
}
export function commitExists(repoPath, sha) {
    if (!/^[0-9a-f]{7,64}$/i.test(sha))
        return false;
    return out(repoPath, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}
export function isAncestor(repoPath, ancestor, descendant) {
    return out(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]) !== null;
}
export function mergeBase(repoPath, a, b) {
    const sha = out(repoPath, ['merge-base', a, b])?.trim();
    return sha ? sha : null;
}
// Regular files and symlinks git tracks at `commit`; submodule entries (type
// commit) carry no blob and are left out.
export function lsTree(repoPath, commit) {
    const text = out(repoPath, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit], TREE_TIMEOUT_MS);
    if (text === null)
        return null;
    const tree = new Map();
    for (const record of text.split('\0')) {
        const tab = record.indexOf('\t');
        if (tab < 0)
            continue;
        const [, type, sha, size] = record.slice(0, tab).split(/\s+/);
        if (type !== 'blob' || !sha)
            continue;
        tree.set(record.slice(tab + 1), { sha, size: Number.parseInt(size ?? '0', 10) || 0 });
    }
    return tree;
}
// Paths that differ between two commits. Renames come back as a delete of the
// old path plus an add of the new one.
export function diffNameStatus(repoPath, from, to) {
    const text = out(repoPath, ['diff', '--name-status', '-z', '--no-renames', from, to, '--'], TREE_TIMEOUT_MS);
    if (text === null)
        return null;
    const parts = text.split('\0');
    const entries = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const status = parts[i];
        const path = parts[i + 1];
        if (status && path)
            entries.push({ status: status.charAt(0), path });
    }
    return entries;
}
// The newest commit in `range` (a commit, or `a..b`) touching each path.
export function lastCommitByPath(repoPath, range) {
    const text = out(repoPath, ['-c', 'core.quotePath=false', 'log', '--format=%H', '--name-only', '--no-renames', range, '--'], TREE_TIMEOUT_MS);
    const byPath = new Map();
    if (text === null)
        return byPath;
    let current = '';
    for (const line of text.split('\n')) {
        if (/^[0-9a-f]{40,64}$/.test(line))
            current = line;
        else if (line !== '' && !byPath.has(line))
            byPath.set(line, current);
    }
    return byPath;
}
// Each commit's position in `git log` default order (newest committer date
// first), from one `git log --no-walk` call; null on a git failure, such as an
// unknown sha.
export function logOrder(repoPath, shas) {
    const list = [...new Set(shas)];
    if (list.length === 0)
        return new Map();
    const res = runGit(repoPath, ['log', '--no-walk', '--stdin', '--format=%H'], {
        input: `${list.join('\n')}\n`,
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: TREE_MAX_BUFFER,
        timeout: TREE_TIMEOUT_MS,
    });
    if (gitUnanswered(res) || res.status !== 0)
        return null;
    const rank = new Map();
    for (const line of res.stdout.split('\n'))
        if (line !== '' && !rank.has(line))
            rank.set(line, rank.size);
    return rank;
}
// A regular file's content at `commit`; null for a symlink (its blob is the
// link target, not file content), a missing path or a git failure.
export function readBlobSync(repoPath, commit, relPath) {
    const entry = out(repoPath, ['ls-tree', '-z', commit, '--', relPath]);
    if (!entry || !/^100[0-7]{3} blob /.test(entry))
        return null;
    return out(repoPath, ['cat-file', 'blob', `${commit}:${relPath}`]);
}
// One long-lived `git cat-file --batch`: read() queues an object name and
// resolves with its content, or null when git reports it missing or the
// process is gone.
export class BlobReader {
    child;
    chunks = [];
    buffered = 0;
    queue = [];
    closed = false;
    constructor(repoPath) {
        const dir = resolve(repoPath);
        let child = null;
        try {
            child = spawn('git', ['-C', dir, 'cat-file', '--batch'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
        }
        catch {
            child = null;
        }
        this.child = child;
        if (!child) {
            this.closed = true;
            return;
        }
        child.stdin.on('error', () => this.fail());
        child.stdout.on('data', (chunk) => {
            this.chunks.push(chunk);
            this.buffered += chunk.length;
            this.drain();
        });
        child.on('error', () => this.fail());
        child.on('close', () => this.fail());
        this.hold(false);
    }
    // The child keeps the event loop alive only while a read waits on it, so a
    // reader nobody closed never holds its process open.
    hold(on) {
        const c = this.child;
        if (!c)
            return;
        for (const h of [c, c.stdin, c.stdout]) {
            if (on)
                h.ref?.();
            else
                h.unref?.();
        }
    }
    read(objectName) {
        if (this.closed || !this.child || /[\n\r]/.test(objectName))
            return Promise.resolve(null);
        return new Promise((resolvePromise) => {
            if (this.queue.length === 0)
                this.hold(true);
            this.queue.push({ resolve: resolvePromise });
            this.child.stdin.write(`${objectName}\n`);
        });
    }
    settle(content) {
        this.queue.shift().resolve(content);
        if (this.queue.length === 0)
            this.hold(false);
    }
    async readText(objectName) {
        const buf = await this.read(objectName);
        return buf === null ? null : buf.toString('utf8');
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.child?.stdin.end();
        }
        catch {
            /* already gone */
        }
    }
    fail() {
        this.closed = true;
        for (const p of this.queue.splice(0))
            p.resolve(null);
        this.hold(false);
    }
    drain() {
        while (this.queue.length > 0) {
            const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
            this.chunks = [buf];
            const nl = buf.indexOf(10);
            if (nl < 0)
                return;
            const header = buf.subarray(0, nl).toString('utf8');
            const fields = header.split(' ');
            if (fields.length !== 3) {
                this.consume(buf, nl + 1);
                this.settle(null);
                continue;
            }
            const size = Number.parseInt(fields[2], 10);
            const end = nl + 1 + size;
            if (buf.length < end + 1)
                return;
            const content = Buffer.from(buf.subarray(nl + 1, end));
            this.consume(buf, end + 1);
            this.settle(content);
        }
    }
    consume(buf, n) {
        const rest = buf.subarray(n);
        this.chunks = rest.length > 0 ? [rest] : [];
        this.buffered = rest.length;
    }
}
// A repo's content at one commit: the tree plus a reader over its blobs. With
// `retain`, each blob read stays in memory, so a later read of it does no I/O.
export class CommitContent {
    repoPath;
    commit;
    tree;
    retain;
    reader = null;
    retained = new Map();
    constructor(repoPath, commit, tree, retain = false) {
        this.repoPath = repoPath;
        this.commit = commit;
        this.tree = tree;
        this.retain = retain;
    }
    has(relPath) {
        return this.tree.has(relPath);
    }
    async read(relPath) {
        const kept = this.retained.get(relPath);
        if (kept !== undefined)
            return kept;
        const entry = this.tree.get(relPath);
        if (!entry)
            return null;
        this.reader ??= new BlobReader(this.repoPath);
        const buf = await this.reader.read(entry.sha);
        if (this.retain)
            this.retained.set(relPath, buf);
        return buf;
    }
    async text(relPath) {
        const buf = await this.read(relPath);
        return buf === null ? null : buf.toString('utf8');
    }
    async head(relPath, bytes) {
        const buf = await this.read(relPath);
        return buf === null ? '' : buf.subarray(0, bytes).toString('utf8');
    }
    close() {
        this.reader?.close();
        this.reader = null;
    }
}
//# sourceMappingURL=git-objects.js.map