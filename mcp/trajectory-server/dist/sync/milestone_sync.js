import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { defaultSpawnFn } from './issue_sync.js';
function splitSlug(slug) {
    const i = slug.indexOf('/');
    if (i <= 0 || i === slug.length - 1)
        return null;
    return { host: slug.slice(0, i), path: slug.slice(i + 1) };
}
// The API collection path for a target's milestones: GitHub's
// repos/{owner}/{repo}/milestones, GitLab's projects/{url-encoded path}/milestones.
function collectionPath(target) {
    const parts = splitSlug(target.slug);
    if (!parts)
        return null;
    const path = target.backend === 'gh'
        ? `repos/${parts.path}/milestones`
        : `projects/${encodeURIComponent(parts.path)}/milestones`;
    return { host: parts.host, path };
}
function runApi(target, apiArgs, spawnFn) {
    const opts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' };
    if (target.cwd)
        opts.cwd = target.cwd;
    try {
        return spawnFn(target.backend, ['api', ...apiArgs], opts);
    }
    catch (e) {
        return { thrown: e instanceof Error ? e.message : String(e) };
    }
}
function failure(target, result) {
    if ('thrown' in result) {
        return { ok: false, backend: target.backend, reason: 'spawn_error', message: result.thrown };
    }
    return {
        ok: false,
        backend: target.backend,
        reason: 'non_zero_exit',
        exit_code: result.status ?? undefined,
        stderr: result.stderr.slice(0, 1024),
    };
}
function badSlug(target) {
    return { ok: false, backend: target.backend, reason: 'bad_slug', message: `cannot derive an API path from "${target.slug}"` };
}
// List every milestone (open and closed) on the remote. GitLab reports
// `active`/`closed`; `active` maps to `open`.
export function fetchRemoteMilestones(target, spawnFn = defaultSpawnFn) {
    const coll = collectionPath(target);
    if (!coll)
        return badSlug(target);
    const query = target.backend === 'gh' ? '?state=all&per_page=100' : '?per_page=100';
    const result = runApi(target, ['--hostname', coll.host, `${coll.path}${query}`], spawnFn);
    if ('thrown' in result || result.status !== 0)
        return failure(target, result);
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch {
        return { ok: false, backend: target.backend, reason: 'parse_failed', message: 'milestone list is not JSON' };
    }
    if (!Array.isArray(parsed)) {
        return { ok: false, backend: target.backend, reason: 'parse_failed', message: 'milestone list is not an array' };
    }
    const milestones = [];
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object')
            continue;
        const e = entry;
        const title = e['title'];
        const rawState = e['state'];
        const id = target.backend === 'gh' ? e['number'] : e['id'];
        if (typeof title !== 'string' || title === '' || typeof id !== 'number')
            continue;
        const state = rawState === 'closed' ? 'closed' : rawState === 'open' || rawState === 'active' ? 'open' : null;
        if (state === null)
            continue;
        milestones.push({ id, title, state });
    }
    return { ok: true, milestones };
}
export function createRemoteMilestone(target, title, spawnFn = defaultSpawnFn) {
    const coll = collectionPath(target);
    if (!coll)
        return badSlug(target);
    const result = runApi(target, ['--hostname', coll.host, '-X', 'POST', coll.path, '-f', `title=${title}`], spawnFn);
    if ('thrown' in result || result.status !== 0)
        return failure(target, result);
    return { ok: true };
}
// Close a remote milestone by title: look up its number/id, then PATCH
// (GitHub `state=closed`) or PUT (GitLab `state_event=close`).
export function closeRemoteMilestone(target, title, spawnFn = defaultSpawnFn) {
    const coll = collectionPath(target);
    if (!coll)
        return badSlug(target);
    const listed = fetchRemoteMilestones(target, spawnFn);
    if (!listed.ok)
        return listed;
    const match = listed.milestones.find((m) => m.title === title);
    if (!match) {
        return { ok: false, backend: target.backend, reason: 'not_found', message: `no remote milestone titled "${title}"` };
    }
    if (match.state === 'closed')
        return { ok: true };
    const apiArgs = target.backend === 'gh'
        ? ['--hostname', coll.host, '-X', 'PATCH', `${coll.path}/${match.id}`, '-f', 'state=closed']
        : ['--hostname', coll.host, '-X', 'PUT', `${coll.path}/${match.id}`, '-f', 'state_event=close'];
    const result = runApi(target, apiArgs, spawnFn);
    if ('thrown' in result || result.status !== 0)
        return failure(target, result);
    return { ok: true };
}
//# sourceMappingURL=milestone_sync.js.map