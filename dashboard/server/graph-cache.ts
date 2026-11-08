import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { graph, graphRollup, graphTarget } from './queries.ts';

const MAX_ENTRIES = 8;

export interface GraphResponse {
  body: string;
  etag: string | null;
  hit: boolean;
}

interface Entry {
  repo: string;
  body: string;
  etag: string;
}

const entries = new Map<string, Entry>();
let rollups = 0;

export function graphRollups(): number {
  return rollups;
}

function row(db: DatabaseSync, sql: string, ...params: string[]): Record<string, unknown> | undefined {
  return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
}

function hasIndexedCommit(db: DatabaseSync): boolean {
  return db.prepare('PRAGMA table_info(repos)').all().some((c) => (c as { name?: unknown }).name === 'indexed_commit');
}

// repos.indexed_commit when the column exists and is set for `repo`, else a
// fingerprint of the symbol tables plus the repo's last scan time.
export function graphStamp(db: DatabaseSync, repo: string): string {
  if (hasIndexedCommit(db)) {
    const sha = row(db, 'SELECT indexed_commit FROM repos WHERE name = ?', repo)?.['indexed_commit'];
    if (sha !== null && sha !== undefined && String(sha) !== '') return String(sha);
  }
  const t = row(
    db,
    `SELECT (SELECT MAX(rowid) FROM wm_edges) AS em, (SELECT COUNT(*) FROM wm_edges) AS ec,
            (SELECT MAX(rowid) FROM wm_symbols) AS sm, (SELECT COUNT(*) FROM wm_symbols) AS sc,
            (SELECT MAX(updated_at) FROM wm_files WHERE repo = ?) AS files,
            (SELECT last_scanned_at FROM repos WHERE name = ?) AS scanned`,
    repo,
    repo,
  );
  const part = (key: string): string => String(t?.[key] ?? '');
  return `e${part('em')}.${part('ec')}-s${part('sm')}.${part('sc')}-f${part('files')}-t${part('scanned')}`;
}

// The body also lists every repo, so the tag carries a hash of that list.
export function graphEtag(repo: string, stamp: string, repos: string[]): string {
  const list = createHash('sha1').update(repos.join('\n')).digest('hex').slice(0, 8);
  return `"${encodeURIComponent(repo)}@${encodeURIComponent(stamp)}.${list}"`;
}

// RFC 9110 If-None-Match: `*`, or a list of entity tags compared weakly.
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const tags = (Array.isArray(header) ? header.join(',') : header).split(',').map((t) => t.trim());
  return tags.some((t) => t === '*' || t.replace(/^W\//, '') === etag);
}

export function cachedGraph(db: DatabaseSync, repo: string | null): GraphResponse {
  const scope = graphTarget(db, repo);
  const target = scope?.target;
  if (scope === null || target === undefined) return { body: JSON.stringify(graph(db, repo)), etag: null, hit: false };
  const etag = graphEtag(target, graphStamp(db, target), scope.repos);
  const key = JSON.stringify([target, etag]);
  const found = entries.get(key);
  if (found) {
    entries.delete(key);
    entries.set(key, found);
    return { body: found.body, etag: found.etag, hit: true };
  }
  rollups += 1;
  const entry: Entry = { repo: target, body: JSON.stringify(graphRollup(db, scope.repos, target)), etag };
  for (const [k, e] of entries) if (e.repo === target) entries.delete(k);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  return { body: entry.body, etag: entry.etag, hit: false };
}
