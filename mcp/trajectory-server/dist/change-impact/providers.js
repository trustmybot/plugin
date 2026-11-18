import { baseRef, BuildHistory, defaultGit, DEV_VERSION, gitSourceFor, hasOriginRemote, } from './attribution.js';
import { METRICS } from './metrics.js';
export const CHANGE_SOURCES = ['plugin_version', 'agent_surface', 'tmb_events'];
export const AGENT_SURFACE_KEY = 'change_impact_agent_surface';
export const DEFAULT_AGENT_SURFACE = ['CLAUDE.md', '.claude/agents/**', '.claude/skills/**', '.claude/settings*.json'];
export function providerContext(reader, git = defaultGit) {
    const repos = reader.all('SELECT name, path, target_branch FROM repos ORDER BY name');
    return { reader, repos, git };
}
const caches = new WeakMap();
function memo(ctx, key, fn) {
    let cache = caches.get(ctx);
    if (!cache) {
        cache = new Map();
        caches.set(ctx, cache);
    }
    if (!cache.has(key))
        cache.set(key, fn());
    return cache.get(key);
}
function samplesOf(ctx, metric) {
    return memo(ctx, `samples:${metric.id}`, () => metric.samples(ctx.reader).filter((s) => !Number.isNaN(Date.parse(s.at))));
}
function iso(at) {
    return new Date(Date.parse(at)).toISOString();
}
const SQUASH_SUFFIX = /\(#(\d+)\)\s*$/;
const MERGE_REQUEST = /See merge request \S+!(\d+)/;
/** A commit's change id: the PR or MR number when the repo has a remote and the commit names one, else the 12-char SHA prefix. */
export function changeIdOf(hasRemote, subject, body, sha) {
    if (hasRemote) {
        const m = SQUASH_SUFFIX.exec(subject) ?? MERGE_REQUEST.exec(body);
        if (m)
            return m[1];
    }
    return sha.slice(0, 12);
}
function versionState(ctx) {
    return memo(ctx, 'plugin_version', () => {
        const firstSeen = new Map();
        for (const metric of METRICS) {
            for (const s of samplesOf(ctx, metric)) {
                if (s.version === null)
                    continue;
                const t = Date.parse(s.at);
                if (!firstSeen.has(s.version) || t < firstSeen.get(s.version))
                    firstSeen.set(s.version, t);
            }
        }
        const versions = [...firstSeen.entries()]
            .map(([version, at]) => ({ version, at }))
            .sort((a, b) => a.at - b.at || a.version.localeCompare(b.version));
        const devPrs = versions.flatMap((v) => {
            const m = DEV_VERSION.exec(v.version);
            return m ? [Number(m[1])] : [];
        });
        return { resolver: devPrs.length > 0 ? resolveDevBuilds(ctx, devPrs) : null, versions };
    });
}
/** The repo whose base history holds the most of <prs> as `(#N)` subjects; null when none holds any. */
function resolveDevBuilds(ctx, prs) {
    let best = null;
    for (const row of ctx.repos) {
        let history;
        try {
            history = new BuildHistory(gitSourceFor(ctx.git, row.path, baseRef(ctx.git, row.path, row.target_branch)));
        }
        catch {
            continue;
        }
        const hits = prs.filter((pr) => history.indexOfPr(pr) !== undefined).length;
        if (hits > 0 && (best === null || hits > best.hits))
            best = { repo: row.name, path: row.path, history, hits };
    }
    return best && { repo: best.repo, path: best.path, history: best.history };
}
/** The dev-build resolver when samples carry dev-build versions and a repo holds their PRs, else null (user mode). */
export function devResolver(ctx) {
    return versionState(ctx).resolver;
}
function attributed(ctx, resolver, metric) {
    return memo(ctx, `build:${metric.id}`, () => samplesOf(ctx, metric).map((s) => {
        const a = resolver.history.attribute(s.version, s.at);
        return { t: Date.parse(s.at), value: s.value, idx: a?.idx ?? null, estimated: a?.estimated ?? false };
    }));
}
function plain(s) {
    return { t: Date.parse(s.at), value: s.value, estimated: false };
}
export const pluginVersionProvider = {
    source: 'plugin_version',
    list(ctx) {
        const { resolver, versions } = versionState(ctx);
        if (resolver) {
            const { history, repo } = resolver;
            return history.prs().map(({ pr, idx }) => ({
                source: 'plugin_version',
                id: String(pr),
                label: history.commits[idx].subject,
                at: iso(history.commits[idx].at),
                kind: 'build',
                repo,
            }));
        }
        return versions.slice(1).map((v) => ({
            source: 'plugin_version',
            id: v.version,
            label: v.version,
            at: new Date(v.at).toISOString(),
            kind: 'version',
            repo: null,
        }));
    },
    split(event, ctx, metric) {
        const { resolver, versions } = versionState(ctx);
        if (resolver && event.kind === 'build') {
            const idxC = resolver.history.indexOfPr(Number(event.id));
            const samples = attributed(ctx, resolver, metric);
            return {
                before: samples.filter((s) => s.idx !== null && s.idx < idxC),
                after: samples.filter((s) => s.idx !== null && s.idx >= idxC),
                unattributed: samples.filter((s) => s.idx === null),
            };
        }
        const i = versions.findIndex((v) => v.version === event.id);
        const previous = versions[i - 1]?.version;
        const samples = samplesOf(ctx, metric);
        return {
            before: samples.filter((s) => s.version === previous).map(plain),
            after: samples.filter((s) => s.version === event.id).map(plain),
            unattributed: samples.filter((s) => s.version === null).map(plain),
        };
    },
    measuredWith(event, ctx) {
        const { resolver } = versionState(ctx);
        if (!resolver || event.kind !== 'build')
            return [];
        const idxC = resolver.history.indexOfPr(Number(event.id));
        let lo = -1;
        let hi = Number.POSITIVE_INFINITY;
        for (const metric of METRICS) {
            for (const s of attributed(ctx, resolver, metric)) {
                if (s.idx === null)
                    continue;
                if (s.idx < idxC)
                    lo = Math.max(lo, s.idx);
                else
                    hi = Math.min(hi, s.idx);
            }
        }
        return resolver.history
            .prs()
            .filter((p) => p.idx > lo && p.idx < hi && String(p.pr) !== event.id)
            .map((p) => ({ source: 'plugin_version', id: String(p.pr), repo: event.repo }));
    },
};
/** The configured surface globs (`<repo>:<glob>` scopes one to a repo); unset or malformed reads as the default. */
export function agentSurfaceGlobs(reader, repo) {
    const row = reader.get('SELECT value_json FROM plugin_config WHERE key = ?', [AGENT_SURFACE_KEY]);
    let entries = DEFAULT_AGENT_SURFACE;
    if (row) {
        try {
            const value = JSON.parse(row.value_json);
            if (Array.isArray(value) && value.every((el) => typeof el === 'string'))
                entries = value;
        }
        catch {
            // An unparseable stored value reads as unset.
        }
    }
    return entries.flatMap((entry) => {
        const scoped = /^([^:*?[\]/]+):(.+)$/.exec(entry);
        if (!scoped)
            return [entry];
        return scoped[1] === repo ? [scoped[2]] : [];
    });
}
function surfaceCommits(ctx, row) {
    const globs = agentSurfaceGlobs(ctx.reader, row.name);
    if (globs.length === 0)
        return [];
    const base = baseRef(ctx.git, row.path, row.target_branch);
    const remote = hasOriginRemote(ctx.git, row.path);
    const out = ctx.git(row.path, [
        'log',
        '--first-parent',
        '--format=%x1e%H%x09%cI%x09%s%x09%b',
        base,
        '--',
        ...globs.map((g) => `:(glob)${g}`),
    ]);
    return out
        .split('\x1e')
        .filter((r) => r.trim().length > 0)
        .map((record) => {
        const [sha, at, subject, ...body] = record.split('\t');
        return {
            source: 'agent_surface',
            id: changeIdOf(remote, subject, body.join('\t'), sha),
            label: subject,
            at: iso(at),
            kind: 'commit',
            repo: row.name,
        };
    });
}
function surfaceEvents(ctx) {
    return memo(ctx, 'agent_surface', () => ctx.repos.flatMap((row) => {
        try {
            return surfaceCommits(ctx, row);
        }
        catch {
            return [];
        }
    }));
}
/** Splits a metric's samples at <event>'s time: before is t < at, after is t >= at. */
function timeSplit(event, ctx, metric) {
    const at = Date.parse(event.at);
    const samples = samplesOf(ctx, metric).map(plain);
    return { before: samples.filter((s) => s.t < at), after: samples.filter((s) => s.t >= at), unattributed: [] };
}
/** The other <events> at or after <event> and within <windowMs> of it. */
function timeMeasuredWith(events, event, windowMs) {
    const at = Date.parse(event.at);
    return events
        .filter((e) => e !== event && !(e.id === event.id && e.repo === event.repo))
        .filter((e) => {
        const t = Date.parse(e.at);
        return t >= at && t <= at + windowMs;
    })
        .map((e) => ({ source: e.source, id: e.id, repo: e.repo }));
}
export const agentSurfaceProvider = {
    source: 'agent_surface',
    list: surfaceEvents,
    split: timeSplit,
    measuredWith(event, ctx, windowMs) {
        return timeMeasuredWith(surfaceEvents(ctx), event, windowMs);
    },
};
const QUOTED_NAME = /'([^']+)'/;
function rowsOrNone(ctx, sql) {
    try {
        return ctx.reader.all(sql);
    }
    catch {
        return [];
    }
}
function objectOf(json) {
    if (json === null)
        return null;
    try {
        const value = JSON.parse(json);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
function tmbEvent(id, kind, label, at) {
    if (Number.isNaN(Date.parse(at)))
        return [];
    return [{ source: 'tmb_events', id, label, at: iso(at), kind, repo: null }];
}
function auditEvent(row) {
    const content = objectOf(row.content_json);
    if (content === null)
        return [];
    const id = `audit-${row.id}`;
    if (row.event_type === 'config_changed') {
        return typeof content['key'] === 'string' ? tmbEvent(id, 'config', `config changed: ${content['key']}`, row.created_at) : [];
    }
    const fromContent = typeof content['name'] === 'string' && content['name'].length > 0 ? content['name'] : undefined;
    const name = fromContent ?? QUOTED_NAME.exec(row.summary ?? '')?.[1] ?? 'cheatcode';
    return tmbEvent(id, 'cheatcode_uninstall', `cheatcode uninstalled: ${name}`, row.created_at);
}
/** Cheatcode installs (builtin rows ship with the plugin and are its version's change), uninstalls and config changes. */
function tmbEvents(ctx) {
    return memo(ctx, 'tmb_events', () => [
        ...rowsOrNone(ctx, "SELECT id, name, installed_at FROM cheatcodes WHERE installed_at IS NOT NULL AND status IN ('active', 'installed') AND origin != 'builtin' ORDER BY id").flatMap((r) => tmbEvent(`cheatcode-${r.id}`, 'cheatcode_install', `cheatcode installed: ${r.name}`, r.installed_at)),
        ...rowsOrNone(ctx, "SELECT id, event_type, summary, content_json, created_at FROM audit WHERE event_type IN ('cheatcode_uninstalled', 'config_changed') ORDER BY id").flatMap(auditEvent),
    ]);
}
export const tmbEventsProvider = {
    source: 'tmb_events',
    list: tmbEvents,
    split: timeSplit,
    measuredWith(event, ctx, windowMs) {
        return timeMeasuredWith(tmbEvents(ctx), event, windowMs);
    },
};
export const PROVIDERS = [pluginVersionProvider, agentSurfaceProvider, tmbEventsProvider];
//# sourceMappingURL=providers.js.map