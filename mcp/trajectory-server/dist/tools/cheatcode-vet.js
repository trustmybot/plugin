// cheatcode_vet's engine: gathers reputation and security-surface signals for one candidate and classifies its trust tier.
import { alt, asciiLower, CheatcodeInputError, fetchText, fixturePath, get, interpolate, isObject, iterateOpt, jqCmp, jqLength, jqSplit, normalizeCandidate, parseJson, rawText, readFixture, requireProjectRoot, } from './cheatcode-runtime.js';
export const VET_FIXTURE_ENV = 'TMB_CHEATCODE_VET_FIXTURE';
export const VET_FIXTURE_FILE = '.tmb-cheatcode-vet-fixture.json';
const GITHUB_HEADERS = { Accept: 'application/vnd.github+json' };
const MAX_MANIFESTS = 20;
const WHY_NESTED = 'nested folders not inspected';
const WHY_OPAQUE = 'submodule or symlink not inspected';
const WHY_MANIFEST = 'plugin manifest could not be read';
const WHY_MANY_MANIFESTS = `more than ${MAX_MANIFESTS} plugin manifests, the rest not inspected`;
const WHY_EXTERNAL = 'external plugin source not inspected';
const WHY_OUTSIDE = 'plugin source outside the folder not inspected';
const WHY_DEPENDENCIES = 'external dependencies not inspected';
const WHY_UNSAFE_PATH = 'plugin manifest with an unusual path not inspected';
export function ownerRepo(url) {
    const m = /^https?:\/\/github\.com\/([^/]+)\/([^/.]+)(\.git)?\/?.*$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : '';
}
// <ref> and <path> of a github.com .../tree/<ref>/<path> URL (path may be empty); null without a /tree/ part.
export function treeRefPath(url) {
    const m = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/tree\/([^/]+)\/?(.*)$/.exec(url.replace(/[?#].*$/, ''));
    if (!m)
        return null;
    const line = `${m[1]}\t${m[2]}`.replace(/\/+$/, '');
    const tab = line.indexOf('\t');
    return { ref: line.slice(0, tab), path: line.slice(tab + 1) };
}
// Entries of a git/trees listing at or under p, with paths relative to p.
function filterTree(tree, p) {
    const plen = Array.from(p).length;
    return iterateOpt(tree)
        .filter((e) => isObject(e) && typeof e['path'] === 'string')
        .filter((e) => e['path'] === p || e['path'].startsWith(`${p}/`))
        .map((e) => {
        const path = e['path'];
        return {
            path: path === p ? (jqSplit(path, '/').at(-1) ?? null) : Array.from(path).slice(plen + 1).join(''),
            type: alt(get(e, 'type'), null),
            mode: alt(get(e, 'mode'), null),
        };
    });
}
const hasDir = (entries) => entries.some((e) => isObject(e) && get(e, 'type') === 'dir');
const treeOpaque = (entries) => entries.some((e) => {
    const type = get(e, 'type');
    const mode = get(e, 'mode');
    return type === 'commit' || mode === '160000' || mode === '120000';
});
const contentsOpaque = (entries) => entries.some((e) => {
    if (!isObject(e))
        return false;
    const type = get(e, 'type');
    return (type !== 'file' && type !== 'dir') || (type === 'file' && get(e, 'download_url') === null);
});
function contentsEntries(listing) {
    return listing.map((e) => isObject(e) ? { path: alt(get(e, 'name'), get(e, 'path')), type: get(e, 'type') === 'dir' ? 'tree' : 'blob', mode: null } : e);
}
const isContents = (v) => Array.isArray(v) && v.length > 0;
// Plugin manifests listed in the surface at any depth, unique and sorted, one per line as the shell loop read them.
function manifestPaths(surface) {
    const paths = surface
        .map((e) => (typeof e === 'string' ? e : isObject(e) ? get(e, 'path') : null))
        .filter((p) => typeof p === 'string')
        .filter((p) => /(^|\/)\.claude-plugin\/(plugin|marketplace)\.json$/i.test(p));
    const unique = [...new Set(paths)].sort((a, b) => jqCmp(a, b));
    return unique.flatMap((p) => p.split('\n')).filter((p) => p.length > 0);
}
function objectsDeep(v, out = []) {
    if (isObject(v)) {
        out.push(v);
        for (const child of Object.values(v))
            objectsDeep(child, out);
    }
    else if (Array.isArray(v)) {
        for (const child of v)
            objectsDeep(child, out);
    }
    return out;
}
const has = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
function manifestFlags(m) {
    const all = objectsDeep(m);
    const plugins = iterateOpt(get(m, 'plugins')).filter(isObject);
    const depsOf = (o) => {
        const d = get(o, 'dependencies');
        return (Array.isArray(d) || isObject(d) || typeof d === 'string') && jqLength(d) > 0;
    };
    return {
        code: all.some((o) => ['hooks', 'mcpServers', 'lspServers', 'monitors', 'settings', 'subagentStatusLine'].some((k) => has(o, k))),
        net: all.some((o) => has(o, 'mcpServers')),
        external: plugins.some((p) => {
            const s = get(p, 'source');
            return typeof s !== 'string' || (s !== '.' && !s.startsWith('./'));
        }),
        outside: plugins.some((p) => {
            const s = get(p, 'source');
            return typeof s === 'string' && s.startsWith('./') && jqSplit(s, '/').includes('..');
        }),
        deps: [m, ...plugins].some(depsOf),
    };
}
function decodeManifest(body) {
    const parsed = parseJson(body);
    if (parsed === null || !isObject(parsed.value) || parsed.value['encoding'] !== 'base64')
        return null;
    const content = parsed.value['content'];
    if (typeof content !== 'string')
        return null;
    const decoded = parseJson(Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8'));
    return decoded !== null && isObject(decoded.value) ? decoded.value : null;
}
// Days since an ISO-8601 UTC timestamp, as jq's fromdateiso8601 reads it.
function ageDays(pushed, nowMs) {
    if (typeof pushed !== 'string')
        throw new Error('strptime/1 requires string inputs and arguments');
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})Z\s*$/.exec(pushed);
    const [y, mo, d, h, mi, s] = (m?.slice(1) ?? []).map(Number);
    if (!m || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 61) {
        throw new Error(`date "${pushed}" does not match format "%Y-%m-%dT%H:%M:%SZ"`);
    }
    const t = Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
    return Math.floor((nowMs / 1000 - t) / 86400);
}
export function classify(candidate, kind, s, nowMs = Date.now()) {
    const rtier = candidate.tier;
    const repo = s.repo;
    const haveRepo = jqLength(repo) > 0;
    const stars = alt(get(repo, 'stargazers_count'), null);
    const forks = alt(get(repo, 'forks_count'), null);
    const pushed = alt(get(repo, 'pushed_at'), null);
    const archived = alt(get(repo, 'archived'), false) === true;
    const license = alt(get(get(repo, 'license'), 'spdx_id'), null);
    const ownerLogin = alt(get(get(repo, 'owner'), 'login'), null);
    const ownerType = alt(get(get(repo, 'owner'), 'type'), null);
    const age = pushed === null ? null : ageDays(pushed, nowMs);
    const active = age === null ? null : archived ? false : age <= 365;
    const entries = s.surface
        .map((e) => (typeof e === 'string' ? { path: e } : e))
        .filter((e) => isObject(e) && typeof e['path'] === 'string');
    const segments = entries.map((e) => jqSplit(asciiLower(e['path']), '/'));
    const shipsLocalCode = segments.some((seg) => seg.some((x) => x === 'hooks' || x === 'scripts' || x === 'bin' || x === '.lsp.json')) ||
        segments.some((seg) => seg.length >= 2 && seg.at(-2) === 'monitors' && seg.at(-1) === 'monitors.json') ||
        segments.some((seg) => seg.at(-1) === 'settings.json') ||
        entries.some((e) => get(e, 'mode') === '100755') ||
        entries.some((e) => alt(get(e, 'type'), 'blob') !== 'tree' &&
            /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe)$/.test(asciiLower(e['path'])));
    const shipsMcpServer = segments.some((seg) => seg.some((x) => x === 'mcp' || x === 'servers' || x === '.mcp.json'));
    const codeExecution = kind === 'mcp' || shipsLocalCode || shipsMcpServer || s.manifestCode || s.manifestMcp;
    const network = kind === 'mcp' || shipsMcpServer || s.manifestMcp;
    const surface = { code_execution: codeExecution, network, fs_writes: shipsLocalCode };
    const capabilities = Object.entries(surface)
        .filter(([, v]) => v)
        .map(([k]) => k);
    const why = s.why;
    const staleOrUnknownTier = rtier !== null && rtier > 2;
    let trustTier;
    if (rtier === null && !haveRepo)
        trustTier = 'unknown';
    else if (archived)
        trustTier = 'untrusted';
    else if (staleOrUnknownTier)
        trustTier = 'untrusted';
    else if (age !== null && age > 730)
        trustTier = 'untrusted';
    else if (codeExecution)
        trustTier = 'caution';
    else if (!s.listed)
        trustTier = 'caution';
    else if (why.length > 0)
        trustTier = 'caution';
    else if (rtier === 1)
        trustTier = 'trusted';
    else if (stars !== null && jqCmp(stars, 500) >= 0 && active === true)
        trustTier = 'trusted';
    else
        trustTier = 'caution';
    let rationale;
    if (trustTier === 'unknown')
        rationale = 'No reputation signal (offline, web-denied, or unrecognized source) — tier withheld.';
    else if (trustTier === 'untrusted') {
        rationale = archived
            ? 'Repository is archived.'
            : staleOrUnknownTier
                ? `Unrecognized registry tier ${interpolate(rtier)}.`
                : 'Stale: no push in over 730 days.';
    }
    else if (trustTier === 'caution') {
        rationale = codeExecution
            ? `Ships executable surface (${capabilities.join(', ')}) — not trusted on popularity alone.`
            : !s.listed
                ? 'Security surface could not be inspected (file listing unavailable) — not trusted unseen.'
                : why.length > 0
                    ? `Security surface partly inspected: ${why.join('; ')} — not trusted unseen.`
                    : 'Signals present but below the trusted bar.';
    }
    else {
        rationale =
            rtier === 1
                ? 'Official registry (tier 1) with no code-execution surface.'
                : `Popular (${interpolate(stars)} stars), actively maintained, no code-execution surface.`;
    }
    return {
        candidate,
        signals: {
            reputation: { registry_tier: rtier, stars, forks },
            maintenance: { pushed_at: pushed, archived, active },
            license,
            maintainer: { login: ownerLogin, type: ownerType },
            security_surface: surface,
        },
        trust_tier: trustTier,
        rationale,
        capabilities,
    };
}
export async function cheatcodeVet(input, opts) {
    requireProjectRoot(opts.projectRoot);
    const candidate = normalizeCandidate(input, 'any');
    const srcUrl = rawText(candidate.source_url);
    const kind = rawText(candidate.kind);
    const why = [];
    const markPartial = (reason) => {
        if (!why.includes(reason))
            why.push(reason);
    };
    const noteTree = (entries) => {
        if (treeOpaque(entries))
            markPartial(WHY_OPAQUE);
    };
    const noteContents = (entries) => {
        if (hasDir(entries))
            markPartial(WHY_NESTED);
        if (contentsOpaque(entries))
            markPartial(WHY_OPAQUE);
    };
    const fixtureFile = fixturePath(VET_FIXTURE_ENV, VET_FIXTURE_FILE, opts);
    const refPath = treeRefPath(srcUrl);
    const treeRef = refPath?.ref ?? '';
    const treePath = refPath?.path ?? '';
    let repo = {};
    let surface = [];
    let listed = false;
    let slug = '';
    let fixture = {};
    if (fixtureFile !== null) {
        const parsed = parseJson(readFixture(fixtureFile, opts.projectRoot));
        if (parsed === null || !isObject(parsed.value))
            throw new CheatcodeInputError({ error: 'fixture is not a JSON object' });
        fixture = parsed.value;
        repo = alt(get(fixture, 'repo'), {});
        const tree = get(fixture, 'tree');
        const contents = get(fixture, 'contents');
        if (treePath && Array.isArray(tree)) {
            surface = filterTree(tree, treePath);
            if (surface.length > 0) {
                listed = true;
                noteTree(surface);
            }
        }
        else if (isContents(contents)) {
            surface = contentsEntries(contents);
            listed = true;
            noteContents(surface);
        }
    }
    else {
        slug = ownerRepo(srcUrl);
        if (slug) {
            const body = parseJson(await fetchText(`https://api.github.com/repos/${slug}`, opts, GITHUB_HEADERS));
            if (body !== null && isObject(body.value))
                repo = body.value;
            let contentsUrl;
            if (treePath) {
                const tbody = parseJson(await fetchText(`https://api.github.com/repos/${slug}/git/trees/${treeRef}?recursive=1`, opts, GITHUB_HEADERS));
                if (tbody !== null && isObject(tbody.value) && Array.isArray(tbody.value['tree']) && tbody.value['truncated'] !== true) {
                    surface = filterTree(tbody.value['tree'], treePath);
                    if (surface.length > 0) {
                        listed = true;
                        noteTree(surface);
                    }
                }
                contentsUrl = `https://api.github.com/repos/${slug}/contents/${treePath}?ref=${treeRef}`;
            }
            else if (treeRef) {
                contentsUrl = `https://api.github.com/repos/${slug}/contents?ref=${treeRef}`;
            }
            else {
                contentsUrl = `https://api.github.com/repos/${slug}/contents`;
            }
            if (!listed) {
                const cbody = parseJson(await fetchText(contentsUrl, opts, GITHUB_HEADERS));
                if (cbody !== null && isContents(cbody.value)) {
                    surface = contentsEntries(cbody.value);
                    listed = true;
                    noteContents(cbody.value);
                }
            }
        }
    }
    const prefix = treePath ? `${treePath}/` : '';
    const readManifest = async (m) => {
        if (fixtureFile !== null) {
            try {
                const manifests = alt(get(fixture, 'manifests'), {});
                const found = alt(alt(get(manifests, m), get(manifests, `${prefix}${m}`)), null);
                return isObject(found) ? found : null;
            }
            catch {
                return null;
            }
        }
        if (!slug)
            return null;
        const query = treeRef ? `?ref=${treeRef}` : '';
        return decodeManifest(await fetchText(`https://api.github.com/repos/${slug}/contents/${prefix}${m}${query}`, opts, GITHUB_HEADERS));
    };
    let manifestCode = false;
    let manifestMcp = false;
    if (listed) {
        let readCount = 0;
        for (const m of manifestPaths(surface)) {
            if (readCount >= MAX_MANIFESTS) {
                markPartial(WHY_MANY_MANIFESTS);
                break;
            }
            readCount++;
            if (!/^[A-Za-z0-9._/-]+$/.test(m)) {
                markPartial(WHY_UNSAFE_PATH);
                continue;
            }
            const manifest = await readManifest(m);
            if (manifest === null) {
                markPartial(WHY_MANIFEST);
                continue;
            }
            const flags = manifestFlags(manifest);
            if (flags.code)
                manifestCode = true;
            if (flags.net)
                manifestMcp = true;
            if (flags.external)
                markPartial(WHY_EXTERNAL);
            if (flags.outside)
                markPartial(WHY_OUTSIDE);
            if (flags.deps)
                markPartial(WHY_DEPENDENCIES);
        }
    }
    return classify(candidate, kind, { repo, surface, listed, why, manifestCode, manifestMcp });
}
//# sourceMappingURL=cheatcode-vet.js.map