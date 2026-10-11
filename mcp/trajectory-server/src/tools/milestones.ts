import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { resolveBackend } from '../sync/backend.js';
import { repoSlugFromRemoteUrl } from '../sync/issue_sync.js';
import type { SpawnFn } from '../sync/issue_sync.js';
import {
  closeRemoteMilestone,
  createRemoteMilestone,
  fetchRemoteMilestones,
} from '../sync/milestone_sync.js';
import type { MilestoneRemoteFailure, MilestoneTarget, RemoteMilestone } from '../sync/milestone_sync.js';
import { resolveRepoForSync } from '../utils/repo-paths.js';
import { insertAudit } from './audit.js';
import type { AuditEventType } from '../audit-events.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function wrap(fn: Fn): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

// Milestone audit rows are session-level (system issue -1). The repo travels in
// content_json rather than audit.repo so these rows never pin a repo against
// scan retirement (audit.repo FKs repos ON DELETE RESTRICT).
function auditMilestone(db: TrajectoryDB, eventType: AuditEventType, summary: string, content: Record<string, unknown>): void {
  insertAudit(db, {
    issue_id: -1,
    from_node: 'bro',
    event_type: eventType,
    summary,
    content_json: JSON.stringify(content),
    repo: null,
  });
}

// The remotes a repo's milestones may be read from / written to, under the same
// gate as issue sync: plugin_config.issue_sync='off' or TMB_DISABLE_REMOTE_SYNC
// yields `gated: false` and no remote is touched. Each target needs a configured
// remote of its provider with a parseable slug.
export function resolveMilestoneTargets(
  db: TrajectoryDB,
  repoName: string,
  spawnFn?: SpawnFn,
): { gated: boolean; targets: MilestoneTarget[] } {
  const resolved = resolveRepoForSync(db, repoName);
  if (!resolved) return { gated: false, targets: [] };
  const row = db.get<{ value_json: string }>(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
  let syncConfig = 'off';
  if (row) {
    try {
      syncConfig = String(JSON.parse(row.value_json));
    } catch {
      syncConfig = 'off';
    }
  }
  const slugFor = (provider: string): string | null => {
    const entry = resolved.remotes.find((r) => r.provider === provider);
    return entry ? repoSlugFromRemoteUrl(entry.url) : null;
  };
  const ghSlug = slugFor('github');
  const glSlug = slugFor('gitlab');
  const backend = resolveBackend(syncConfig, { github: ghSlug !== null, gitlab: glSlug !== null }, !!spawnFn);
  if (backend === null || backend === 'off') return { gated: false, targets: [] };
  const targets: MilestoneTarget[] = [];
  if ((backend === 'gh' || backend === 'both') && ghSlug) {
    targets.push({ backend: 'gh', slug: ghSlug, cwd: resolved.path });
  }
  if ((backend === 'glab' || backend === 'both') && glSlug) {
    targets.push({ backend: 'glab', slug: glSlug, cwd: resolved.path });
  }
  return { gated: true, targets };
}

function failureContent(f: MilestoneRemoteFailure): Record<string, unknown> {
  return { backend: f.backend, reason: f.reason, exit_code: f.exit_code, stderr: f.stderr, message: f.message };
}

// Import a repo's remote milestones into `milestones`, carrying the remote state.
// A milestone open on any remote stays open. Returns whether every remote read
// succeeded; a failed read is audited and never thrown.
export function reconcileRepoMilestones(
  db: TrajectoryDB,
  repo: string,
  targets: MilestoneTarget[],
  spawnFn?: SpawnFn,
): { ok: boolean } {
  const merged = new Map<string, RemoteMilestone['state']>();
  let anyFetched = false;
  let allFetched = true;
  for (const target of targets) {
    const listed = fetchRemoteMilestones(target, spawnFn);
    if (!listed.ok) {
      allFetched = false;
      auditMilestone(db, 'milestone_reconcile_failed', `milestone reconcile failed for ${repo} via ${target.backend}: ${listed.reason}`, {
        repo,
        ...failureContent(listed),
      });
      continue;
    }
    anyFetched = true;
    for (const m of listed.milestones) {
      if (merged.get(m.title) !== 'open') merged.set(m.title, m.state);
    }
  }
  if (!anyFetched) return { ok: false };

  let imported = 0;
  let closed = 0;
  db.transaction(() => {
    for (const [name, state] of merged) {
      const existing = db.get<{ state: string }>(`SELECT state FROM milestones WHERE name = ? AND repo = ?`, [name, repo]);
      if (!existing) {
        db.run(`INSERT INTO milestones (name, repo, state) VALUES (?, ?, ?)`, [name, repo, state]);
        imported++;
        if (state === 'closed') closed++;
      } else if (existing.state !== state) {
        db.run(`UPDATE milestones SET state = ? WHERE name = ? AND repo = ?`, [state, name, repo]);
        if (state === 'closed') closed++;
      }
    }
  });
  auditMilestone(db, 'milestones_reconciled', `milestones reconciled for ${repo}: ${imported} imported, ${closed} closed`, {
    imported,
    closed,
    repo,
  });
  return { ok: allFetched };
}

// Version sources for the seed milestone, first match wins.
type VersionSource = 'package.json' | '.claude-plugin/plugin.json' | 'pyproject.toml' | 'Cargo.toml' | 'git_tag';

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function parseSemver(raw: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// v<major>.<minor>.<patch+1>, with any pre-release / build suffix stripped first.
export function nextPatchMilestone(version: string): string | null {
  const parts = parseSemver(version);
  if (!parts) return null;
  return `v${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function readJsonVersion(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parseSemver(parsed.version) ? parsed.version : null;
  } catch {
    return null;
  }
}

// `version = "x.y.z"` inside the named TOML table, before the next table header.
function readTomlVersion(path: string, table: string): string | null {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let inTable = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inTable = trimmed === `[${table}]`;
      continue;
    }
    if (!inTable) continue;
    const m = /^version\s*=\s*["']([^"']+)["']/.exec(trimmed);
    if (m) return parseSemver(m[1]!) ? m[1]! : null;
  }
  return null;
}

function highestVersionTag(repoPath: string): string | null {
  try {
    const r = spawnSync('git', ['-C', repoPath, 'tag', '--list', 'v*'], { encoding: 'utf8', timeout: 3000 });
    if (r.status !== 0) return null;
    let best: { tag: string; parts: [number, number, number] } | null = null;
    for (const tag of (r.stdout ?? '').split('\n').map((t) => t.trim())) {
      const parts = parseSemver(tag);
      if (!parts) continue;
      if (
        best === null ||
        parts[0] > best.parts[0] ||
        (parts[0] === best.parts[0] && parts[1] > best.parts[1]) ||
        (parts[0] === best.parts[0] && parts[1] === best.parts[1] && parts[2] > best.parts[2])
      ) {
        best = { tag, parts };
      }
    }
    return best?.tag ?? null;
  } catch {
    return null;
  }
}

export function readRepoVersion(repoPath: string): { version: string; source: VersionSource } | null {
  const candidates: Array<[VersionSource, () => string | null]> = [
    ['package.json', () => readJsonVersion(join(repoPath, 'package.json'))],
    ['.claude-plugin/plugin.json', () => readJsonVersion(join(repoPath, '.claude-plugin', 'plugin.json'))],
    ['pyproject.toml', () => readTomlVersion(join(repoPath, 'pyproject.toml'), 'project')],
    ['Cargo.toml', () => readTomlVersion(join(repoPath, 'Cargo.toml'), 'package')],
    ['git_tag', () => highestVersionTag(repoPath)],
  ];
  for (const [source, read] of candidates) {
    const version = read();
    if (version) return { version, source };
  }
  return null;
}

// When a repo has no milestone rows at all, seed one open v<next-patch> from its
// own version. Local always; on the remote only when the sync gate is on.
export function seedRepoMilestone(
  db: TrajectoryDB,
  repo: string,
  repoPath: string,
  gate: { gated: boolean; targets: MilestoneTarget[] },
  spawnFn?: SpawnFn,
): void {
  const count = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM milestones WHERE repo = ?`, [repo]);
  if ((count?.n ?? 0) > 0) return;
  const found = readRepoVersion(repoPath);
  const name = found ? nextPatchMilestone(found.version) : null;
  if (!found || !name) {
    auditMilestone(db, 'milestone_seed_skipped', `milestone seed skipped for ${repo}: no version source`, {
      repo,
      reason: 'no_version_source',
    });
    return;
  }
  db.run(`INSERT INTO milestones (name, repo, state) VALUES (?, ?, 'open')`, [name, repo]);
  const failures: Record<string, unknown>[] = [];
  if (gate.gated) {
    for (const target of gate.targets) {
      const created = createRemoteMilestone(target, name, spawnFn);
      if (!created.ok) failures.push(failureContent(created));
    }
  }
  const remoteCreated = gate.gated && gate.targets.length > 0 && failures.length === 0;
  const content: Record<string, unknown> = { name, repo, source: found.source, remote_created: remoteCreated };
  if (failures.length > 0) content['remote_failures'] = failures;
  auditMilestone(db, 'milestone_seeded', `milestone ${name} seeded for ${repo} from ${found.source}`, content);
}

// scan_run's milestone pass for one scanned repo: reconcile from the remote
// (under the sync gate), then seed when the repo still has none. A failed
// remote read skips the seed so a milestone the remote already has is never
// shadowed by a locally-invented one.
export function syncRepoMilestones(
  db: TrajectoryDB,
  repo: string,
  repoPath: string,
  spawnFn?: SpawnFn,
): void {
  const gate = resolveMilestoneTargets(db, repo, spawnFn);
  if (gate.gated && gate.targets.length > 0) {
    const reconciled = reconcileRepoMilestones(db, repo, gate.targets, spawnFn);
    if (!reconciled.ok) {
      const count = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM milestones WHERE repo = ?`, [repo]);
      if ((count?.n ?? 0) === 0) {
        auditMilestone(db, 'milestone_seed_skipped', `milestone seed skipped for ${repo}: remote reconcile failed`, {
          repo,
          reason: 'reconcile_failed',
        });
      }
      return;
    }
  }
  seedRepoMilestone(db, repo, repoPath, gate, spawnFn);
}

export function milestoneTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'milestone_close',
      description: 'Close a milestone locally and on the synced remote. Bro only. Refuses while the milestone has open issues unless force=true.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: ['bro'], description: 'Calling agent identity (bro only)' },
          name: { type: 'string', description: 'Milestone name, e.g. "v1.4.3"' },
          repo: { type: 'string', description: 'Repo the milestone belongs to. Defaults to the sole registered repo.' },
          force: { type: 'boolean', description: 'Close even when open issues still reference the milestone (default false).' },
        },
        required: ['agent', 'name'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    milestone_close: requireRoles('milestone_close', ['bro'], wrap(async (args) => {
      const name = args['name'];
      if (typeof name !== 'string' || name.trim() === '') {
        return err('name must be a non-empty string');
      }
      const explicitRepo = typeof args['repo'] === 'string' && args['repo'] !== '' ? (args['repo'] as string) : null;
      const repo = explicitRepo ?? resolveRepoForSync(db, null)?.name ?? null;
      if (repo === null) {
        return err('repo_unresolved: multiple or no repos registered — pass repo');
      }
      const existing = db.get<{ state: string }>(`SELECT state FROM milestones WHERE name = ? AND repo = ?`, [name, repo]);
      if (!existing) {
        return err(`milestone_not_found: no milestone "${name}" for repo "${repo}"`);
      }
      if (existing.state === 'closed') {
        return ok({ name, repo, state: 'closed', already_closed: true });
      }
      const force = args['force'] === true;
      const openIssues = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM issues WHERE milestone = ? AND repo = ? AND status = 'open'`,
        [name, repo],
      )?.n ?? 0;
      if (openIssues > 0 && !force) {
        return err(`milestone_has_open_issues: "${name}" still has ${openIssues} open issue(s) — move or close them, or pass force: true`);
      }

      db.run(`UPDATE milestones SET state = 'closed' WHERE name = ? AND repo = ?`, [name, repo]);

      const spawnFn = args['_spawnFn'] as SpawnFn | undefined;
      const gate = resolveMilestoneTargets(db, repo, spawnFn);
      const failures: Record<string, unknown>[] = [];
      if (gate.gated) {
        for (const target of gate.targets) {
          const closed = closeRemoteMilestone(target, name, spawnFn);
          if (!closed.ok) failures.push(failureContent(closed));
        }
      }
      const remoteClosed = gate.gated && gate.targets.length > 0 && failures.length === 0;
      const content: Record<string, unknown> = {
        name,
        repo,
        forced: force && openIssues > 0,
        open_issues: openIssues,
        remote_closed: remoteClosed,
      };
      if (failures.length > 0) content['remote_failures'] = failures;
      auditMilestone(db, 'milestone_closed', `milestone ${name} closed for ${repo}`, content);

      const payload: Record<string, unknown> = { name, repo, state: 'closed', open_issues: openIssues, remote_closed: remoteClosed };
      if (failures.length > 0) {
        payload['_sync'] = {
          sync_failed: true,
          failures,
          hint: 'The local milestone is closed; close it on the remote manually.',
        };
      }
      return ok(payload);
    })),
  };

  return { definitions, handlers };
}
