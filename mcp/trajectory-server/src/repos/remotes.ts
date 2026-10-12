import type { TrajectoryDB } from '../db.js';
import { classifyUrl } from '../utils/classify-url.js';

// The one TS accessor for a repo's git remotes (repo_remotes, schema v35).
// Every reader and writer of a repo's remotes goes through these functions.

export const REMOTE_PROVIDERS = ['github', 'gitlab', 'other'] as const;
export type RemoteProvider = (typeof REMOTE_PROVIDERS)[number];

export interface Remote {
  name: string;
  provider: RemoteProvider;
  url: string;
  is_primary: boolean;
}

export interface RemoteInput {
  name: string;
  url: string;
  provider?: string | null;
}

// The provider comes from the URL host. A blank or unrecognised URL keeps a
// declared github/gitlab provider (onboard records the chosen provider before
// the repo has a URL); anything else is 'other'.
export function remoteProvider(url: string, declared?: string | null): RemoteProvider {
  const fromHost = classifyUrl(url);
  if (fromHost === 'github' || fromHost === 'gitlab') return fromHost;
  if (declared === 'github' || declared === 'gitlab') return declared;
  return 'other';
}

// The primary remote is the one named `origin`, else the first.
export function primaryIndex(remotes: ReadonlyArray<{ name: string }>): number {
  if (remotes.length === 0) return -1;
  const origin = remotes.findIndex((r) => r.name === 'origin');
  return origin >= 0 ? origin : 0;
}

export type LegacyRemotesParse =
  | { ok: true; entries: RemoteInput[]; dropped: number }
  | { ok: false; reason: string };

// Decode a pre-v35 JSON value of the repos remotes column: an array of {name, provider, url}
// or a name → url map. Entries without a string url are dropped and counted;
// a missing name falls back to `origin` for the first entry, else `remote-<i>`.
// Duplicate names keep the first.
export function parseLegacyRemotes(raw: string): LegacyRemotesParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${(e as Error).message}` };
  }
  let entries: Array<{ name: unknown; url: unknown; provider: unknown }>;
  if (Array.isArray(parsed)) {
    entries = parsed.map((e) =>
      e !== null && typeof e === 'object'
        ? {
            name: (e as Record<string, unknown>)['name'],
            url: (e as Record<string, unknown>)['url'],
            provider: (e as Record<string, unknown>)['provider'],
          }
        : { name: undefined, url: undefined, provider: undefined },
    );
  } else if (parsed !== null && typeof parsed === 'object') {
    entries = Object.entries(parsed as Record<string, unknown>).map(([name, url]) => ({ name, url, provider: undefined }));
  } else {
    return { ok: false, reason: `expected an array or an object, got ${parsed === null ? 'null' : typeof parsed}` };
  }
  const remotes: RemoteInput[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  entries.forEach((e, i) => {
    if (typeof e.url !== 'string') {
      dropped++;
      return;
    }
    const name = typeof e.name === 'string' && e.name.trim() !== '' ? e.name.trim() : i === 0 ? 'origin' : `remote-${i}`;
    if (seen.has(name)) {
      dropped++;
      return;
    }
    seen.add(name);
    remotes.push({ name, url: e.url.trim(), provider: typeof e.provider === 'string' ? e.provider : null });
  });
  return { ok: true, entries: remotes, dropped };
}

// A repo's remotes, primary first, then in the order they were recorded.
export function repoRemotes(db: TrajectoryDB, repo: string): Remote[] {
  return db
    .all<{ name: string; provider: RemoteProvider; url: string; is_primary: number }>(
      `SELECT name, provider, url, is_primary FROM repo_remotes WHERE repo = ? ORDER BY is_primary DESC, rowid`,
      [repo],
    )
    .map((r) => ({ name: r.name, provider: r.provider, url: r.url, is_primary: r.is_primary === 1 }));
}

export function primaryRemote(db: TrajectoryDB, repo: string): Remote | null {
  return repoRemotes(db, repo).find((r) => r.is_primary) ?? null;
}

// The {name, provider, url} list tool results expose for a repo's remotes.
export function remotesView(remotes: ReadonlyArray<Remote>): Array<{ name: string; provider: RemoteProvider; url: string }> {
  return remotes.map(({ name, provider, url }) => ({ name, provider, url }));
}

// Replace a repo's remote set with `remotes`: rows for names no longer present
// go, the rest are upserted keeping their created_at, and the primary is
// re-chosen. Runs inside the caller's transaction.
export function upsertRepoRemotes(db: TrajectoryDB, repo: string, remotes: ReadonlyArray<RemoteInput>): void {
  const unique: RemoteInput[] = [];
  const seen = new Set<string>();
  for (const r of remotes) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    unique.push(r);
  }
  const primary = primaryIndex(unique);
  db.run(
    `DELETE FROM repo_remotes WHERE repo = ? AND name NOT IN (SELECT value FROM json_each(?))`,
    [repo, JSON.stringify(unique.map((r) => r.name))],
  );
  unique.forEach((r, i) => {
    db.run(
      `INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo, name) DO UPDATE SET provider = excluded.provider, url = excluded.url, is_primary = excluded.is_primary`,
      [repo, r.name, remoteProvider(r.url, r.provider), r.url, i === primary ? 1 : 0],
    );
  });
}
