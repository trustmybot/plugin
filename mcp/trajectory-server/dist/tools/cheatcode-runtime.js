// Shared runtime of the cheatcode search/vet/install/uninstall modules: fixtures, jq value semantics, fetch and the claude CLI.
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join, resolve } from 'node:path';
export class CheatcodeInputError extends Error {
    payload;
    constructor(payload) {
        super(JSON.stringify(payload));
        this.payload = payload;
        this.name = 'CheatcodeInputError';
    }
}
export const FETCH_TIMEOUT_MS = 8_000;
export const CLI_TIMEOUT_MS = 30_000;
export function requireProjectRoot(projectRoot) {
    if (!projectRoot) {
        throw new CheatcodeInputError({
            error: 'TMB_PROJECT_ROOT is unset — the trajectory server sets it to the project root',
        });
    }
}
export function isObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const PROJECT_SCOPE_RANK = new Map([['local', 3], ['project', 2]]);
function canonicalDir(dir) {
    try {
        return realpathSync(dir);
    }
    catch {
        return resolve(dir);
    }
}
/**
 * Per plugin id of a `claude plugin list --json` listing, the install in effect
 * for `projectRoot` by Claude Code's settings precedence: a local entry whose
 * canonical projectPath is the canonical project root, then such a project
 * entry, then an entry of any other scope (user, synced, managed or none), which
 * applies to every project. An id none of whose entries applies maps to null.
 */
export function selectProjectInstalls(list, projectRoot) {
    const root = projectRoot ? canonicalDir(projectRoot) : null;
    const chosen = new Map();
    for (const entry of list) {
        if (!isObject(entry))
            continue;
        const id = typeof entry['id'] === 'string' ? entry['id'] : '';
        const scopeRank = PROJECT_SCOPE_RANK.get(typeof entry['scope'] === 'string' ? entry['scope'] : '');
        const projectPath = entry['projectPath'];
        const here = scopeRank === undefined ||
            (root !== null && typeof projectPath === 'string' && projectPath !== '' && canonicalDir(projectPath) === root);
        const rank = here ? (scopeRank ?? 1) : 0;
        const prev = chosen.get(id);
        if (prev === undefined || rank > prev.rank)
            chosen.set(id, { rank, entry: rank > 0 ? entry : null });
    }
    return new Map([...chosen].map(([id, c]) => [id, c.entry]));
}
export function jqType(v) {
    if (v === null || v === undefined)
        return 'null';
    if (typeof v === 'boolean')
        return 'boolean';
    if (Array.isArray(v))
        return 'array';
    return typeof v;
}
export function get(v, key) {
    if (v === null || v === undefined)
        return null;
    if (!isObject(v))
        throw new Error(`Cannot index ${jqType(v)} with "${key}"`);
    return Object.prototype.hasOwnProperty.call(v, key) ? v[key] : null;
}
export function truthy(v) {
    return v !== null && v !== undefined && v !== false;
}
export function alt(...values) {
    for (const v of values.slice(0, -1))
        if (truthy(v))
            return v;
    return values[values.length - 1] ?? null;
}
export function iterate(v) {
    if (Array.isArray(v))
        return v;
    if (isObject(v))
        return Object.values(v);
    throw new Error(`Cannot iterate over ${jqType(v)}`);
}
export function iterateOpt(v) {
    if (Array.isArray(v))
        return v;
    if (isObject(v))
        return Object.values(v);
    return [];
}
export function jqLength(v) {
    if (v === null)
        return 0;
    if (typeof v === 'boolean')
        throw new Error('boolean has no length');
    if (typeof v === 'number')
        return Math.abs(v);
    if (typeof v === 'string')
        return Array.from(v).length;
    if (Array.isArray(v))
        return v.length;
    return Object.keys(v).length;
}
function typeRank(v) {
    if (v === null)
        return 0;
    if (v === false)
        return 1;
    if (v === true)
        return 2;
    if (typeof v === 'number')
        return 3;
    if (typeof v === 'string')
        return 4;
    if (Array.isArray(v))
        return 5;
    return 6;
}
export function jqCmp(a, b) {
    const ra = typeRank(a);
    const rb = typeRank(b);
    if (ra !== rb)
        return ra - rb;
    if (typeof a === 'number' && typeof b === 'number')
        return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'string' && typeof b === 'string')
        return Buffer.compare(Buffer.from(a), Buffer.from(b));
    if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const c = jqCmp(a[i], b[i]);
            if (c !== 0)
                return c;
        }
        return a.length - b.length;
    }
    if (isObject(a) && isObject(b)) {
        const ka = Object.keys(a).sort((x, y) => jqCmp(x, y));
        const kb = Object.keys(b).sort((x, y) => jqCmp(x, y));
        const keys = jqCmp(ka, kb);
        if (keys !== 0)
            return keys;
        for (const k of ka) {
            const c = jqCmp(a[k], b[k]);
            if (c !== 0)
                return c;
        }
    }
    return 0;
}
export function jqEq(a, b) {
    return jqCmp(a, b) === 0;
}
export function asciiLower(s) {
    return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
export function jqSplit(s, sep) {
    return s === '' ? [] : s.split(sep);
}
export function concatStrings(...parts) {
    for (const p of parts)
        if (typeof p !== 'string')
            throw new Error(`${jqType(p)} cannot be added to a string`);
    return parts.join('');
}
export function interpolate(v) {
    return typeof v === 'string' ? v : JSON.stringify(v);
}
// What `$(jq -r <expr>)` leaves in a shell variable.
export function rawText(v) {
    const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    return text.replace(/\n+$/, '');
}
export function parseJson(text) {
    try {
        return { value: JSON.parse(text) };
    }
    catch {
        return null;
    }
}
function isRegularFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
// The env var wins; else the project's default file, when it is a regular file.
export function fixturePath(envVar, defaultName, opts) {
    const fromEnv = (opts.env ?? process.env)[envVar] ?? '';
    if (fromEnv)
        return fromEnv;
    const fallback = `${opts.projectRoot}/${defaultName}`;
    return isRegularFile(fallback) ? fallback : null;
}
export function readFixture(path, projectRoot) {
    const abs = resolve(projectRoot, path);
    if (!isRegularFile(abs))
        throw new CheatcodeInputError({ error: `fixture not found: ${path}` });
    try {
        return readFileSync(abs, 'utf8');
    }
    catch {
        return '';
    }
}
function tierFromFlag(tier) {
    if (tier.length === 0)
        return null;
    const parsed = parseJson(tier);
    if (parsed === null || typeof parsed.value !== 'number')
        throw new Error(`Cannot parse '${tier}' as a number`);
    return parsed.value;
}
// --candidate (a JSON object, string or parsed) wins; the discrete flags fill in otherwise.
export function normalizeCandidate(input, defaultKind) {
    const raw = input.candidate;
    if (raw !== undefined && raw !== '') {
        const value = typeof raw === 'string' ? parseJson(raw)?.value : raw;
        if (!isObject(value))
            throw new CheatcodeInputError({ error: '--candidate is not a JSON object' });
        const tier = get(value, 'tier');
        return {
            name: alt(get(value, 'name'), ''),
            kind: alt(get(value, 'kind'), defaultKind),
            source_url: alt(get(value, 'source_url'), ''),
            tier: typeof tier === 'number' ? tier : null,
        };
    }
    if (!input.sourceUrl)
        throw new CheatcodeInputError({ error: '--source-url or --candidate is required' });
    return {
        name: input.name ?? '',
        kind: input.kind || defaultKind,
        source_url: input.sourceUrl,
        tier: tierFromFlag(input.tier ?? ''),
    };
}
export async function fetchText(url, opts, headers) {
    const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])];
    try {
        const res = await (opts.fetchImpl ?? fetch)(url, { headers, redirect: 'follow', signal: AbortSignal.any(signals) });
        if (res.status >= 400)
            return '';
        return await res.text();
    }
    catch {
        return '';
    }
}
// jq's @uri: every byte but A-Z a-z 0-9 - _ . ~ is percent-encoded.
export function uriEncode(s) {
    const wellFormed = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
    return encodeURIComponent(wellFormed).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
// `command -v <name>` against the caller's PATH.
export function findOnPath(name, opts) {
    const path = (opts.env ?? process.env)['PATH'] ?? '';
    for (const dir of path.split(':')) {
        const candidate = dir === '' ? join(opts.projectRoot, name) : join(dir, name);
        try {
            if (!statSync(candidate).isFile())
                continue;
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch {
            continue;
        }
    }
    return null;
}
// `(cd <root> && timeout 30 <bin> <args>)`: exit 1 when the root is not a directory, 124 on timeout, 128+n on a signal.
export function runCli(bin, args, output, opts) {
    return new Promise((done) => {
        try {
            if (!statSync(opts.projectRoot).isDirectory())
                return done({ code: 1, out: '' });
        }
        catch {
            return done({ code: 1, out: '' });
        }
        const env = { ...(opts.env ?? process.env), TMB_PROJECT_ROOT: opts.projectRoot };
        const stdio = output === 'none' ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'pipe', output === 'merged' ? 'pipe' : 'ignore'];
        const chunks = [];
        let timedOut = false;
        let settled = false;
        let timer;
        let child;
        const onAbort = () => {
            child?.kill('SIGKILL');
        };
        const finish = (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
            done({ code, out: Buffer.concat(chunks).toString('utf8') });
        };
        try {
            child = spawn(bin, args, { cwd: opts.projectRoot, env, stdio });
        }
        catch {
            return finish(126);
        }
        const running = child;
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
            timedOut = true;
            running.kill('SIGTERM');
        }, CLI_TIMEOUT_MS);
        running.stdout?.on('data', (c) => chunks.push(c));
        running.stderr?.on('data', (c) => chunks.push(c));
        running.on('error', (e) => finish(e.code === 'ENOENT' ? 127 : 126));
        running.on('close', (code, signal) => {
            if (timedOut)
                return finish(124);
            if (signal)
                return finish(128 + (osConstants.signals[signal] ?? 0));
            finish(code ?? 1);
        });
    });
}
//# sourceMappingURL=cheatcode-runtime.js.map