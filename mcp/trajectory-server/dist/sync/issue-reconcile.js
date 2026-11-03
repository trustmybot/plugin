import { nowISO } from '../db.js';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { resolveRepoForSync } from '../utils/repo-paths.js';
import { syncRemotes } from '../repos/remotes.js';
import { insertAudit } from '../tools/audit.js';
import { liveTasksOfIssue, markIssueClosed } from '../tools/lifecycle.js';
import { remoteSyncGate } from './backend.js';
import { defaultSpawnFn, repoSlugFromRemoteUrl } from './issue_sync.js';
export const GH_RECONCILE_BATCH = 50;
function resolveRepoCtx(db, repo) {
    const resolved = resolveRepoForSync(db, repo);
    if (!resolved)
        return null;
    const remotes = syncRemotes(db, resolved.name);
    return {
        cwd: resolved.path,
        slugFor(kind) {
            const entry = remotes.find((r) => r.provider === kind);
            return entry ? { slug: repoSlugFromRemoteUrl(entry.url) } : null;
        },
    };
}
function spawnOptsFor(cwd) {
    const opts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' };
    if (cwd)
        opts.cwd = cwd;
    return opts;
}
// `host/owner/repo` (repoSlugFromRemoteUrl) → the parts a GraphQL
// repository(owner, name) lookup needs.
function splitGhSlug(slug) {
    const parts = slug.split('/');
    if (parts.length < 3 || parts.some((p) => p === ''))
        return null;
    return { host: parts[0], owner: parts[1], name: parts.slice(2).join('/') };
}
function gqlString(value) {
    return JSON.stringify(value);
}
// One `gh api graphql` call for up to GH_RECONCILE_BATCH issue numbers of one
// repo, each aliased `i<N>: issue(number: N) { state }`. A partial response
// (an alias that resolved to null: a deleted issue, a PR number) still answers
// for the aliases that came back; a call with no parseable data fails the batch.
function readGithubBatch(slug, iids, cwd, spawnFn) {
    const out = new Map();
    const failAll = (error, message) => {
        for (const iid of iids)
            out.set(iid, { error, ...(message ? { message } : {}) });
        return out;
    };
    const repo = splitGhSlug(slug);
    if (!repo)
        return failAll('slug_unresolved', `cannot split repo slug "${slug}"`);
    const fields = iids.map((n) => `i${n}: issue(number: ${n}) { state }`).join(' ');
    const query = `query { repository(owner: ${gqlString(repo.owner)}, name: ${gqlString(repo.name)}) { ${fields} } }`;
    let result;
    try {
        result = spawnFn('gh', ['api', 'graphql', '--hostname', repo.host, '-f', `query=${query}`], spawnOptsFor(cwd));
    }
    catch (e) {
        return failAll('read_failed', e instanceof Error ? e.message : String(e));
    }
    let data = null;
    try {
        const parsed = JSON.parse(result.stdout);
        data = parsed?.data?.repository ?? null;
    }
    catch {
        data = null;
    }
    if (data === null) {
        if (result.status !== 0)
            return failAll('read_failed', (result.stderr || `gh exited ${String(result.status)}`).slice(0, 500));
        return failAll('parse_failed', 'gh api graphql returned no repository data');
    }
    for (const iid of iids) {
        const node = data[`i${iid}`];
        const state = node && typeof node.state === 'string' ? node.state.toUpperCase() : null;
        if (state === 'CLOSED')
            out.set(iid, { state: 'closed' });
        else if (state === 'OPEN')
            out.set(iid, { state: 'open' });
        else
            out.set(iid, { error: 'not_found', message: `github #${iid} returned no issue state` });
    }
    return out;
}
// `glab issue view <iid> -R <slug> --output json`: state is opened / closed.
function readGitlabIssue(slug, iid, cwd, spawnFn) {
    let result;
    try {
        result = spawnFn('glab', ['issue', 'view', String(iid), '-R', slug, '--output', 'json'], spawnOptsFor(cwd));
    }
    catch (e) {
        return { error: 'read_failed', message: e instanceof Error ? e.message : String(e) };
    }
    if (result.status !== 0) {
        return { error: 'read_failed', message: (result.stderr || `glab exited ${String(result.status)}`).slice(0, 500) };
    }
    let state;
    try {
        state = JSON.parse(result.stdout)?.state;
    }
    catch {
        return { error: 'parse_failed', message: 'glab issue view returned no JSON' };
    }
    if (state === 'closed')
        return { state: 'closed' };
    if (state === 'opened' || state === 'reopened')
        return { state: 'open' };
    return { error: 'parse_failed', message: `gitlab #${iid} returned state ${JSON.stringify(state)}` };
}
function sameIds(a, b) {
    if (!Array.isArray(b) || a.length !== b.length)
        return false;
    const sorted = [...b].map(Number).sort((x, y) => x - y);
    return a.every((v, i) => v === sorted[i]);
}
function lastDeferralIds(db, issueId) {
    const row = db.get(`SELECT content_json FROM audit WHERE issue_id = ? AND event_type = 'issue_remote_closed_local_open' ORDER BY id DESC LIMIT 1`, [issueId]);
    if (!row)
        return null;
    try {
        return JSON.parse(row.content_json).blocking_task_ids ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Close every open DB issue (`id > 0`, linked by `gh_iid` / `gl_iid`) whose
 * remote twin is closed. The remote-sync gate (`remoteSyncGate`) must be on;
 * when it is off the result is `{skipped: <reason>}` and nothing is read or
 * written. An issue closes only when every linked remote that could be read
 * reports closed and none failed to read; a read failure lands in `errors[]`
 * and closes nothing. An issue with live tasks stays open and is listed in
 * `deferred[]`, with one `issue_remote_closed_local_open` audit row per change
 * of its blocking task set. Each close writes the issue UPDATE and one
 * `issue_closed_from_remote` audit row in one transaction. `dryRun` reports
 * the same lists and writes nothing.
 */
export function reconcileRemoteCloses(db, opts = {}) {
    const spawnFn = opts._spawnFn ?? defaultSpawnFn;
    const probe = opts._spawnFn
        ? (cmd, args) => opts._spawnFn(cmd, args, { encoding: 'utf8' })
        : undefined;
    const result = { checked: 0, closed: [], deferred: [], errors: [], ...(opts.dryRun ? { dry_run: true } : {}) };
    const candidates = db.all(`SELECT id, repo, gh_iid, gl_iid FROM issues
      WHERE status = 'open' AND id > 0 AND (gh_iid IS NOT NULL OR gl_iid IS NOT NULL)
      ORDER BY id`);
    const ctxByRepo = new Map();
    const ctxOf = (repo) => {
        const key = repo ?? '\u0000';
        if (!ctxByRepo.has(key))
            ctxByRepo.set(key, resolveRepoCtx(db, repo));
        return ctxByRepo.get(key);
    };
    for (const c of candidates)
        ctxOf(c.repo);
    if (candidates.length === 0)
        ctxOf(null);
    const contexts = [...ctxByRepo.values()].filter((c) => c !== null);
    const gate = remoteSyncGate(db, {
        repoRemotes: contexts.length > 0
            ? { github: contexts.some((c) => c.slugFor('github') !== null), gitlab: contexts.some((c) => c.slugFor('gitlab') !== null) }
            : null,
        spawnFn: probe,
    });
    if (!gate.enabled) {
        return { ...result, skipped: gate.reason ?? 'no_backend' };
    }
    result.checked = candidates.length;
    const targetsByIssue = new Map();
    const states = new Map();
    const ghBySlug = new Map();
    for (const c of candidates) {
        const ctx = ctxOf(c.repo);
        const targets = [];
        if (c.gh_iid != null)
            targets.push({ issueId: c.id, kind: 'github', iid: c.gh_iid, slug: null, cwd: ctx?.cwd ?? null });
        if (c.gl_iid != null)
            targets.push({ issueId: c.id, kind: 'gitlab', iid: c.gl_iid, slug: null, cwd: ctx?.cwd ?? null });
        targetsByIssue.set(c.id, targets);
        for (const t of targets) {
            if (ctx === null) {
                states.set(t, { error: 'repo_unresolved', message: `issue repo ${JSON.stringify(c.repo)} resolves to no repos row` });
                continue;
            }
            const remote = ctx.slugFor(t.kind);
            if (remote === null) {
                states.set(t, { error: 'not_synced', message: `the repo has no synced ${t.kind} remote` });
                continue;
            }
            if (remote.slug === null) {
                states.set(t, { error: 'slug_unresolved', message: `cannot derive a repo slug from the ${t.kind} remote url` });
                continue;
            }
            t.slug = remote.slug;
            if (t.kind === 'github') {
                const list = ghBySlug.get(remote.slug) ?? [];
                list.push(t);
                ghBySlug.set(remote.slug, list);
            }
            else {
                states.set(t, readGitlabIssue(remote.slug, t.iid, t.cwd, spawnFn));
            }
        }
    }
    for (const [slug, targets] of ghBySlug) {
        for (let i = 0; i < targets.length; i += GH_RECONCILE_BATCH) {
            const batch = targets.slice(i, i + GH_RECONCILE_BATCH);
            const iids = [...new Set(batch.map((t) => t.iid))];
            const read = readGithubBatch(slug, iids, batch[0].cwd, spawnFn);
            for (const t of batch)
                states.set(t, read.get(t.iid));
        }
    }
    const now = nowISO();
    for (const [issueId, targets] of targetsByIssue) {
        const read = targets.map((t) => ({ t, s: states.get(t) }));
        const failed = read.filter((r) => 'error' in r.s);
        if (failed.length > 0) {
            for (const { t, s } of failed) {
                const e = s;
                result.errors.push({ issue_id: issueId, remote_kind: t.kind, remote_iid: t.iid, reason: e.error, ...(e.message ? { message: e.message } : {}) });
            }
            continue;
        }
        if (read.some((r) => 'state' in r.s && r.s.state === 'open'))
            continue;
        const first = targets[0];
        const blocking = liveTasksOfIssue(db, issueId).map((t) => t.id);
        if (blocking.length > 0) {
            result.deferred.push({ issue_id: issueId, blocking_task_ids: blocking });
            if (!opts.dryRun && !sameIds(blocking, lastDeferralIds(db, issueId))) {
                insertAudit(db, {
                    issue_id: issueId,
                    from_node: 'bro',
                    writer: 'bro',
                    event_type: 'issue_remote_closed_local_open',
                    summary: `issue ${issueId}: ${first.kind} #${first.iid} is closed; left open for live tasks ${blocking.join(', ')}`,
                    content_json: JSON.stringify({ remote_kind: first.kind, remote_iid: first.iid, blocking_task_ids: blocking }),
                    created_at: now,
                });
            }
            continue;
        }
        if (!opts.dryRun) {
            const closedNow = db.transaction(() => {
                const still = db.get(`SELECT status FROM issues WHERE id = ?`, [issueId]);
                if (still?.status !== 'open' || liveTasksOfIssue(db, issueId).length > 0)
                    return false;
                markIssueClosed(db, issueId, now);
                insertAudit(db, {
                    issue_id: issueId,
                    from_node: 'bro',
                    writer: 'bro',
                    event_type: 'issue_closed_from_remote',
                    summary: `issue ${issueId} closed: its ${first.kind} twin #${first.iid} is closed`,
                    content_json: JSON.stringify({ remote_kind: first.kind, remote_iid: first.iid }),
                    created_at: now,
                });
                return true;
            });
            if (!closedNow)
                continue;
        }
        result.closed.push({ issue_id: issueId, remote_kind: first.kind, remote_iid: first.iid });
    }
    return result;
}
//# sourceMappingURL=issue-reconcile.js.map