// Git object reads for the world model (GH 2584): a repo is indexed at one
// commit, its file list from `git ls-tree` and its blobs from one
// `git cat-file --batch` process, never from the working tree.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { gitUnanswered, runGit } from './git-run.js';

const TREE_MAX_BUFFER = 256 * 1024 * 1024;
const TREE_TIMEOUT_MS = 60_000;

export interface TreeEntry {
  sha: string;
  size: number;
}

export type GitTree = Map<string, TreeEntry>;

export interface DiffEntry {
  status: string;
  path: string;
}

function out(repoPath: string, args: string[], timeout?: number): string | null {
  const res = runGit(repoPath, args, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: TREE_MAX_BUFFER, ...(timeout ? { timeout } : {}) });
  if (gitUnanswered(res) || res.status !== 0) return null;
  return res.stdout;
}

export function revParseCommit(repoPath: string, ref: string): string | null {
  const sha = out(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim();
  return sha ? sha : null;
}

export function commitExists(repoPath: string, sha: string): boolean {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false;
  return out(repoPath, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

export function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  return out(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]) !== null;
}

export function mergeBase(repoPath: string, a: string, b: string): string | null {
  const sha = out(repoPath, ['merge-base', a, b])?.trim();
  return sha ? sha : null;
}

// Regular files and symlinks git tracks at `commit`; submodule entries (type
// commit) carry no blob and are left out.
export function lsTree(repoPath: string, commit: string): GitTree | null {
  const text = out(repoPath, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit], TREE_TIMEOUT_MS);
  if (text === null) return null;
  const tree: GitTree = new Map();
  for (const record of text.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [, type, sha, size] = record.slice(0, tab).split(/\s+/);
    if (type !== 'blob' || !sha) continue;
    tree.set(record.slice(tab + 1), { sha, size: Number.parseInt(size ?? '0', 10) || 0 });
  }
  return tree;
}

// Paths that differ between two commits. Renames come back as a delete of the
// old path plus an add of the new one.
export function diffNameStatus(repoPath: string, from: string, to: string): DiffEntry[] | null {
  const text = out(repoPath, ['diff', '--name-status', '-z', '--no-renames', from, to, '--'], TREE_TIMEOUT_MS);
  if (text === null) return null;
  const parts = text.split('\0');
  const entries: DiffEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const path = parts[i + 1]!;
    if (status && path) entries.push({ status: status.charAt(0), path });
  }
  return entries;
}

// The newest commit in `range` (a commit, or `a..b`) touching each path.
export function lastCommitByPath(repoPath: string, range: string): Map<string, string> {
  const text = out(repoPath, ['-c', 'core.quotePath=false', 'log', '--format=%H', '--name-only', '--no-renames', range, '--'], TREE_TIMEOUT_MS);
  const byPath = new Map<string, string>();
  if (text === null) return byPath;
  let current = '';
  for (const line of text.split('\n')) {
    if (/^[0-9a-f]{40,64}$/.test(line)) current = line;
    else if (line !== '' && !byPath.has(line)) byPath.set(line, current);
  }
  return byPath;
}

export function readBlobSync(repoPath: string, commit: string, relPath: string): string | null {
  return out(repoPath, ['cat-file', 'blob', `${commit}:${relPath}`]);
}

interface Pending {
  resolve: (content: Buffer | null) => void;
}

// One long-lived `git cat-file --batch`: read() queues an object name and
// resolves with its content, or null when git reports it missing or the
// process is gone.
export class BlobReader {
  private readonly child: ChildProcessByStdio<Writable, Readable, null> | null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private readonly queue: Pending[] = [];
  private closed = false;

  constructor(repoPath: string) {
    const dir = resolve(repoPath);
    let child: ChildProcessByStdio<Writable, Readable, null> | null = null;
    try {
      child = spawn('git', ['-C', dir, 'cat-file', '--batch'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      child = null;
    }
    this.child = child;
    if (!child) {
      this.closed = true;
      return;
    }
    child.stdin.on('error', () => this.fail());
    child.stdout.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      this.drain();
    });
    child.on('error', () => this.fail());
    child.on('close', () => this.fail());
  }

  read(objectName: string): Promise<Buffer | null> {
    if (this.closed || !this.child || /[\n\r]/.test(objectName)) return Promise.resolve(null);
    return new Promise((resolvePromise) => {
      this.queue.push({ resolve: resolvePromise });
      this.child!.stdin.write(`${objectName}\n`);
    });
  }

  async readText(objectName: string): Promise<string | null> {
    const buf = await this.read(objectName);
    return buf === null ? null : buf.toString('utf8');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child?.stdin.end();
    } catch {
      /* already gone */
    }
  }

  private fail(): void {
    this.closed = true;
    for (const p of this.queue.splice(0)) p.resolve(null);
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const buf = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.buffered);
      this.chunks = [buf];
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      const header = buf.subarray(0, nl).toString('utf8');
      const fields = header.split(' ');
      if (fields.length !== 3) {
        this.consume(buf, nl + 1);
        this.queue.shift()!.resolve(null);
        continue;
      }
      const size = Number.parseInt(fields[2]!, 10);
      const end = nl + 1 + size;
      if (buf.length < end + 1) return;
      const content = Buffer.from(buf.subarray(nl + 1, end));
      this.consume(buf, end + 1);
      this.queue.shift()!.resolve(content);
    }
  }

  private consume(buf: Buffer, n: number): void {
    const rest = buf.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.buffered = rest.length;
  }
}

// A repo's content at one commit: the tree plus a reader over its blobs. With
// `retain`, each blob read stays in memory, so a later read of it does no I/O.
export class CommitContent {
  private reader: BlobReader | null = null;
  private readonly retained = new Map<string, Buffer | null>();

  constructor(
    readonly repoPath: string,
    readonly commit: string,
    readonly tree: GitTree,
    private readonly retain = false,
  ) {}

  has(relPath: string): boolean {
    return this.tree.has(relPath);
  }

  async read(relPath: string): Promise<Buffer | null> {
    const kept = this.retained.get(relPath);
    if (kept !== undefined) return kept;
    const entry = this.tree.get(relPath);
    if (!entry) return null;
    this.reader ??= new BlobReader(this.repoPath);
    const buf = await this.reader.read(entry.sha);
    if (this.retain) this.retained.set(relPath, buf);
    return buf;
  }

  async text(relPath: string): Promise<string | null> {
    const buf = await this.read(relPath);
    return buf === null ? null : buf.toString('utf8');
  }

  async head(relPath: string, bytes: number): Promise<string> {
    const buf = await this.read(relPath);
    return buf === null ? '' : buf.subarray(0, bytes).toString('utf8');
  }

  close(): void {
    this.reader?.close();
    this.reader = null;
  }
}
