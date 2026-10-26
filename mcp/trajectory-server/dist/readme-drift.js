// README drift for the world model (GH 1680, GH 1833): how many commits since
// a directory's README last changed edited, deleted or renamed a file the
// README names, and which paths the README names that git has since deleted.
// Every git call is bounded; any failure yields null so the scan stores NULL
// instead of failing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { SUBPROCESS_TIMEOUT_MS } from './utils/timeouts.js';
const HISTORY_TIMEOUT_MS = 30_000;
const HISTORY_MAX_BUFFER = 64 * 1024 * 1024;
function git(root, args, timeout = SUBPROCESS_TIMEOUT_MS) {
    try {
        const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout, maxBuffer: HISTORY_MAX_BUFFER });
        return r.status === 0 && !r.error ? r.stdout : null;
    }
    catch {
        return null;
    }
}
function basename(p) {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
}
function lines(out) {
    return out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}
// One `git log --diff-filter=DR` per repo per scan for every path ever deleted
// and every path ever renamed away, and one `git ls-files` for the files
// tracked today and their basenames.
export function readRepoHistory(root, trackedDirs) {
    const out = git(root, ['log', '--diff-filter=DR', '--name-status', '--format='], HISTORY_TIMEOUT_MS);
    if (out === null)
        return null;
    const tracked = git(root, ['-c', 'core.quotePath=false', 'ls-files'], HISTORY_TIMEOUT_MS);
    if (tracked === null)
        return null;
    const deleted = new Set();
    const renamedAway = new Set();
    for (const [status, path] of lines(out).map((l) => l.split('\t'))) {
        if (!path)
            continue;
        if (status === 'D')
            deleted.add(path);
        else if (status?.startsWith('R'))
            renamedAway.add(path);
    }
    const trackedFiles = new Set(lines(tracked));
    const trackedBasenames = new Set([...trackedFiles].map(basename));
    const deletedByBasename = new Map();
    for (const p of [...deleted].sort()) {
        const name = basename(p);
        const list = deletedByBasename.get(name);
        if (list)
            list.push(p);
        else
            deletedByBasename.set(name, [p]);
    }
    return { root, deleted, deletedByBasename, renamedAway, trackedBasenames, trackedDirs, trackedFiles };
}
function stripUntrustedFraming(text) {
    return text.replace(/<\/?untrusted-content\b[^>]*>/g, '');
}
const LINK_TARGET = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const BACKTICK_SPAN = /(?<!`)`([^`\n]+)`(?!`)/g;
const PATH_SHAPE = /^[A-Za-z0-9_.\-/@+]+$/;
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
function skipped(ref) {
    return (ref.length === 0 ||
        ref.startsWith('..') ||
        /(^|\/)dist\//.test(ref) ||
        ref.includes('${') ||
        ref.includes('<') ||
        ref.includes('*'));
}
function linkCandidate(target) {
    if (URL_SCHEME.test(target) || target.startsWith('#'))
        return null;
    const path = target.replace(/[?#].*$/, '').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    return path.length > 0 ? path : null;
}
function backtickCandidate(span, dir, trackedDirs) {
    const ref = span.trim().replace(/:\d+(-\d+)?$/, '').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!PATH_SHAPE.test(ref) || ref.startsWith('/') || ref.includes('://'))
        return null;
    const slash = ref.indexOf('/');
    if (slash < 0)
        return FILE_EXTENSION.test(ref) ? ref : null;
    const first = ref.slice(0, slash);
    const tracked = trackedDirs.has(first) || (dir !== '' && trackedDirs.has(`${dir}/${first}`));
    return tracked ? ref : null;
}
export function readmeCandidates(readme, dir, trackedDirs) {
    const text = stripUntrustedFraming(readme);
    const seen = new Map();
    for (const m of text.matchAll(LINK_TARGET)) {
        const ref = linkCandidate(m[1]);
        if (ref && !skipped(ref))
            seen.set(ref, { ref, link: true });
    }
    for (const m of text.matchAll(BACKTICK_SPAN)) {
        const ref = backtickCandidate(m[1], dir, trackedDirs);
        if (ref && !skipped(ref) && !seen.has(ref))
            seen.set(ref, { ref, link: false });
    }
    return [...seen.values()];
}
function relativeToDir(dir, ref) {
    return dir === '' ? posix.normalize(ref) : posix.normalize(`${dir}/${ref}`);
}
// A candidate is dead when it exists neither relative to the README's dir nor
// to the repo root, and it is a markdown link or git deleted it: a ref with a
// `/` must match a deleted path exactly; a bare filename matches a deleted
// basename only when no file tracked today has that basename. Reported as the
// repo-relative path git deleted when there is one, else the README-relative
// resolution.
function deletedBareName(ref, history) {
    if (ref.includes('/') || history.trackedBasenames.has(ref))
        return undefined;
    return history.deletedByBasename.get(ref)?.[0];
}
export function deadRefs(readme, dir, history) {
    const dead = new Set();
    for (const { ref, link } of readmeCandidates(readme, dir, history.trackedDirs)) {
        const fromDir = relativeToDir(dir, ref);
        if (existsSync(join(history.root, fromDir)) || existsSync(join(history.root, ref)))
            continue;
        const deletedHit = history.deleted.has(fromDir)
            ? fromDir
            : history.deleted.has(ref)
                ? ref
                : deletedBareName(ref, history);
        if (deletedHit)
            dead.add(deletedHit);
        else if (link)
            dead.add(fromDir);
    }
    return [...dead].sort();
}
const MAX_REFERENCED_PATHSPECS = 200;
// The README's candidates that resolve to a file tracked today, deleted or
// renamed away, relative to its directory or else to the repo root, without
// the README itself. A directory ref resolves to no file, so it feeds only
// dead_refs.
export function referencedFiles(readme, dir, readmePath, history) {
    const isFile = (p) => history.trackedFiles.has(p) || history.deleted.has(p) || history.renamedAway.has(p);
    const files = new Set();
    for (const { ref } of readmeCandidates(readme, dir, history.trackedDirs)) {
        const fromDir = relativeToDir(dir, ref);
        const fromRoot = posix.normalize(ref);
        const hit = isFile(fromDir) ? fromDir : isFile(fromRoot) ? fromRoot : undefined;
        if (hit && hit !== readmePath)
            files.add(hit);
    }
    return [...files].sort();
}
// summary_sha: the last commit touching the README. commits_behind: the
// distinct commits since then that change a file the README references (the
// first 200 of them) other than by adding it. Adds, and changes to files the
// README does not name, never count, so a directory that grows by design
// stays current.
export function readmeDrift(history, dir, readmeName, readme) {
    const readmePath = dir === '' ? readmeName : `${dir}/${readmeName}`;
    const sha = git(history.root, ['log', '-1', '--format=%H', '--', `:(literal)${readmePath}`])?.trim();
    if (!sha)
        return null;
    const range = `${sha}..HEAD`;
    const refs = referencedFiles(readme, dir, readmePath, history).slice(0, MAX_REFERENCED_PATHSPECS);
    const pathspecs = refs.map((r) => `:(literal)${r}`);
    const touched = refs.length === 0 ? '' : git(history.root, ['log', '--diff-filter=a', '--format=%H', range, '--', ...pathspecs]);
    if (touched === null)
        return null;
    const commits_behind = new Set(lines(touched)).size;
    return { summary_sha: sha, commits_behind, dead_refs: deadRefs(readme, dir, history) };
}
//# sourceMappingURL=readme-drift.js.map