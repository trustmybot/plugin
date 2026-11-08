// Inbound PR sync (GH 2513): GitHub → prs / pr_closes, so the dashboard can show
// PR open-to-merge time per issue label. Read-only toward the remote: the only
// command it spawns is `gh pr list`.
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { remoteSyncGate, type RemoteSyncGateReason } from './backend.js';
import { defaultSpawnFn, type SpawnFn } from './issue_sync.js';
import { resolveRepoCtx, spawnOptsFor, splitGhSlug, type RepoCtx } from './issue-reconcile.js';

export const PR_FULL_LIMIT = 5000;
export const PR_INCREMENTAL_LIMIT = 1000;
const PR_JSON_FIELDS = 'number,state,createdAt,mergedAt,updatedAt,closingIssuesReferences';

export interface PrSyncOpts {
  /** Read the remote and report the count, writing nothing. */
  dryRun?: boolean;
  _spawnFn?: SpawnFn;
}

export interface PrSyncError {
  repo: string;
  reason: 'slug_unresolved' | 'read_failed' | 'parse_failed' | 'truncated';
  message?: string;
}

export interface PrSyncResult {
  repos: number;
  upserted: number;
  errors: PrSyncError[];
  skipped?: RemoteSyncGateReason;
  dry_run?: true;
}

interface PrRow {
  number: number;
  state: 'open' | 'closed' | 'merged';
  created_at: string;
  merged_at: string | null;
  updated_at: string;
  closes: number[];
}

interface GhIssueRef {
  number?: unknown;
  url?: unknown;
  repository?: { name?: unknown; owner?: { login?: unknown } | null } | null;
}

const STATES: Record<string, PrRow['state']> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

function sameRepo(ref: GhIssueRef, host: string, owner: string, name: string): boolean {
  const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const repo = ref.repository;
  if (repo && nonEmptyString(repo.name) && repo.owner && nonEmptyString(repo.owner.login)) {
    return eq(repo.owner.login, owner) && eq(repo.name, name);
  }
  if (!nonEmptyString(ref.url)) return false;
  try {
    const u = new URL(ref.url);
    const parts = u.pathname.split('/').filter((p) => p !== '');
    const at = parts.lastIndexOf('issues');
    return at >= 2 && eq(u.host, host) && eq(parts.slice(0, at - 1).join('/'), owner) && eq(parts[at - 1]!, name);
  } catch {
    return false;
  }
}

function toPrRow(raw: unknown, slugParts: { host: string; owner: string; name: string }): PrRow | null {
  if (raw === null || typeof raw !== 'object') return null;
  const pr = raw as Record<string, unknown>;
  const number = pr['number'];
  const state = typeof pr['state'] === 'string' ? STATES[pr['state'].toUpperCase()] : undefined;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0 || state === undefined) return null;
  if (!nonEmptyString(pr['createdAt']) || !nonEmptyString(pr['updatedAt'])) return null;
  let mergedAt: string | null = null;
  if (state === 'merged') {
    if (!nonEmptyString(pr['mergedAt'])) return null;
    mergedAt = pr['mergedAt'];
  }
  const refs = Array.isArray(pr['closingIssuesReferences']) ? (pr['closingIssuesReferences'] as GhIssueRef[]) : [];
  const closes = new Set<number>();
  for (const ref of refs) {
    if (ref === null || typeof ref !== 'object') continue;
    const n = ref.number;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) continue;
    if (!sameRepo(ref, slugParts.host, slugParts.owner, slugParts.name)) continue;
    closes.add(n);
  }
  return {
    number,
    state,
    created_at: pr['createdAt'],
    merged_at: mergedAt,
    updated_at: pr['updatedAt'],
    closes: [...closes].sort((a, b) => a - b),
  };
}

function listArgs(slug: string, since: string | null): { args: string[]; limit: number } {
  const base = ['pr', 'list', '-R', slug, '--state', 'all', '--json', PR_JSON_FIELDS];
  if (since === null) return { args: [...base, '--limit', String(PR_FULL_LIMIT)], limit: PR_FULL_LIMIT };
  // Oldest-updated first, so a truncated page leaves the rest for the next run's cursor.
  return {
    args: [...base, '--limit', String(PR_INCREMENTAL_LIMIT), '--search', `updated:>=${since} sort:updated-asc`],
    limit: PR_INCREMENTAL_LIMIT,
  };
}

function sinceDate(db: TrajectoryDB, repo: string): string | null {
  const row = db.get<{ max: string | null }>(`SELECT MAX(updated_at) AS max FROM prs WHERE repo = ?`, [repo]);
  const m = row?.max ? /^\d{4}-\d{2}-\d{2}/.exec(row.max) : null;
  return m ? m[0] : null;
}

function writePrs(db: TrajectoryDB, repo: string, rows: PrRow[], now: string): void {
  db.transaction(() => {
    for (const pr of rows) {
      db.run(
        `INSERT INTO prs (repo, number, state, created_at, merged_at, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo, number) DO UPDATE SET
             state = excluded.state, created_at = excluded.created_at, merged_at = excluded.merged_at,
             updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
        [repo, pr.number, pr.state, pr.created_at, pr.merged_at, pr.updated_at, now],
      );
      const id = db.get<{ id: number }>(`SELECT id FROM prs WHERE repo = ? AND number = ?`, [repo, pr.number])!.id;
      db.run(`DELETE FROM pr_closes WHERE pr_id = ?`, [id]);
      for (const n of pr.closes) db.run(`INSERT INTO pr_closes (pr_id, issue_number) VALUES (?, ?)`, [id, n]);
    }
  });
}

/**
 * Upsert every GitHub PR of each repo with a synced GitHub remote into `prs`,
 * and its same-repo closing issue numbers into `pr_closes`. The remote-sync
 * gate must be on; off, the result is `{skipped: <reason>}` and nothing is read
 * or written. A repo with no `prs` rows reads up to PR_FULL_LIMIT PRs; after
 * that, up to PR_INCREMENTAL_LIMIT updated on or after its newest `updated_at`
 * date. Each repo writes in one transaction; a failed or unparseable read
 * lands in `errors[]` and leaves that repo's rows untouched. `dryRun` reads and
 * counts, and writes nothing.
 */
export function syncRemotePrs(db: TrajectoryDB, opts: PrSyncOpts = {}): PrSyncResult {
  const spawnFn = opts._spawnFn ?? defaultSpawnFn;
  const probe = opts._spawnFn
    ? (cmd: string, args: string[]) => opts._spawnFn!(cmd, args, { encoding: 'utf8' })
    : undefined;
  const result: PrSyncResult = { repos: 0, upserted: 0, errors: [], ...(opts.dryRun ? { dry_run: true as const } : {}) };

  const contexts: Array<{ repo: string; ctx: RepoCtx }> = [];
  for (const { name } of db.all<{ name: string }>(`SELECT name FROM repos ORDER BY name`)) {
    const ctx = resolveRepoCtx(db, name);
    if (ctx) contexts.push({ repo: name, ctx });
  }
  const gate = remoteSyncGate(db, {
    repoRemotes: contexts.length > 0
      ? { github: contexts.some((c) => c.ctx.slugFor('github') !== null), gitlab: contexts.some((c) => c.ctx.slugFor('gitlab') !== null) }
      : null,
    spawnFn: probe,
  });
  if (!gate.enabled) return { ...result, skipped: gate.reason ?? 'no_backend' };

  for (const { repo, ctx } of contexts) {
    const remote = ctx.slugFor('github');
    if (remote === null) continue;
    result.repos += 1;
    const parts = remote.slug === null ? null : splitGhSlug(remote.slug);
    if (remote.slug === null || parts === null) {
      result.errors.push({ repo, reason: 'slug_unresolved', message: 'cannot derive a repo slug from the github remote url' });
      continue;
    }
    const { args, limit } = listArgs(remote.slug, sinceDate(db, repo));
    let out: { status: number | null; stdout: string; stderr: string };
    try {
      out = spawnFn('gh', args, spawnOptsFor(ctx.cwd));
    } catch (e) {
      result.errors.push({ repo, reason: 'read_failed', message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (out.status !== 0) {
      result.errors.push({ repo, reason: 'read_failed', message: (out.stderr || `gh exited ${String(out.status)}`).slice(0, 500) });
      continue;
    }
    let list: unknown;
    try {
      list = JSON.parse(out.stdout);
    } catch {
      list = null;
    }
    if (!Array.isArray(list)) {
      result.errors.push({ repo, reason: 'parse_failed', message: 'gh pr list returned no JSON array' });
      continue;
    }
    const rows: PrRow[] = [];
    for (const raw of list) {
      const row = toPrRow(raw, parts);
      if (row) rows.push(row);
    }
    if (rows.length < list.length) {
      result.errors.push({ repo, reason: 'parse_failed', message: `${list.length - rows.length} malformed PR entr${list.length - rows.length === 1 ? 'y' : 'ies'} skipped` });
    }
    if (list.length >= limit) {
      const rest = limit === PR_FULL_LIMIT ? 'older PRs are not synced' : 'the rest sync on the next run';
      result.errors.push({ repo, reason: 'truncated', message: `gh pr list hit its ${limit}-PR limit; ${rest}` });
    }
    if (!opts.dryRun) writePrs(db, repo, rows, nowISO());
    result.upserted += rows.length;
  }
  return result;
}
