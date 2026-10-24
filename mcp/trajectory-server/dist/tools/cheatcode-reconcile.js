import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { nowISO } from '../db.js';
import { serverLog } from '../logger.js';
import { insertAudit } from './audit.js';
import { projectRootFromDbPath, projectSpawnOptions } from './containment.js';
const DEFAULT_TIMEOUT_SEC = 4;
const MAX_LISTING_BYTES = 8 * 1024 * 1024;
export function healthcheckTimeoutSec() {
    const raw = Number(process.env['TMB_CHEATCODE_HEALTHCHECK_TIMEOUT']);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_SEC;
}
export function probeChildEnv(projectRoot = null) {
    const base = projectRoot === null ? process.env : projectSpawnOptions(projectRoot).env;
    return { ...base, TMB_DISABLE_CHEATCODE_HEALTHCHECK: '1' };
}
function runClaude(args, timeoutSec, projectRoot) {
    return new Promise((resolve) => {
        try {
            const child = execFile('claude', args, {
                ...(projectRoot === null ? {} : { cwd: projectRoot }),
                env: probeChildEnv(projectRoot),
                timeout: timeoutSec * 1000,
                killSignal: 'SIGKILL',
                maxBuffer: MAX_LISTING_BYTES,
                encoding: 'utf8',
            }, (error, stdout) => resolve(error ? null : stdout));
            child.stdin?.end();
        }
        catch {
            resolve(null);
        }
    });
}
function parseMcpListing(text) {
    const names = new Set();
    for (const line of text.split('\n')) {
        const sep = line.indexOf(': ');
        if (sep > 0)
            names.add(line.slice(0, sep));
    }
    return names;
}
function claudeJsonMcpKeys() {
    try {
        const parsed = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
        const servers = parsed?.mcpServers;
        if (servers && typeof servers === 'object')
            return new Set(Object.keys(servers));
    }
    catch {
        return new Set();
    }
    return new Set();
}
function parsePluginListing(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!Array.isArray(parsed))
        return null;
    const plugins = new Map();
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object')
            continue;
        const { id, enabled, mcpServers } = entry;
        plugins.set(typeof id === 'string' ? id : '', {
            enabled: enabled === true,
            mcpServers: new Set(mcpServers && typeof mcpServers === 'object' ? Object.keys(mcpServers) : []),
        });
    }
    return plugins;
}
async function probeListings(timeoutSec, projectRoot) {
    const [mcpText, pluginText] = await Promise.all([
        runClaude(['mcp', 'list'], timeoutSec, projectRoot),
        runClaude(['plugin', 'list', '--json'], timeoutSec, projectRoot),
    ]);
    const mcpNames = new Set([...(mcpText === null ? [] : parseMcpListing(mcpText)), ...claudeJsonMcpKeys()]);
    const plugins = pluginText === null ? null : parsePluginListing(pluginText);
    return {
        evidence: { mcpServers: mcpNames.size > 0 ? mcpNames : null, plugins },
        listed: mcpText !== null || plugins !== null,
    };
}
export async function probeRuntime(timeoutSec, projectRoot = null) {
    return (await probeListings(timeoutSec, projectRoot)).evidence;
}
const PROBE_TTL_MS = 24 * 60 * 60 * 1000;
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
function field(value, key) {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value[key] ?? null) : null;
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.keys(value)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`);
        return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}
export function cliConfigFingerprint(projectRoot) {
    const home = homedir();
    const claudeJson = readJson(join(home, '.claude.json'));
    const inProject = (...parts) => (projectRoot === null ? null : readJson(join(projectRoot, ...parts)));
    const inputs = {
        claudeJsonMcpServers: field(claudeJson, 'mcpServers'),
        claudeJsonProjectMcpServers: projectRoot === null ? null : field(field(field(claudeJson, 'projects'), projectRoot), 'mcpServers'),
        projectMcpJson: inProject('.mcp.json'),
        enabledPlugins: {
            user: field(readJson(join(home, '.claude', 'settings.json')), 'enabledPlugins'),
            project: field(inProject('.claude', 'settings.json'), 'enabledPlugins'),
            local: field(inProject('.claude', 'settings.local.json'), 'enabledPlugins'),
        },
        installedPlugins: readJson(join(home, '.claude', 'plugins', 'installed_plugins.json')),
    };
    return createHash('sha256').update(stableJson(inputs)).digest('hex');
}
export function probeCachePath(projectRoot) {
    return join(projectRoot, '.claude', 'tmb', 'cheatcode-probe.json');
}
function readProbeCache(projectRoot) {
    if (projectRoot === null)
        return null;
    const parsed = readJson(probeCachePath(projectRoot));
    const fingerprint = field(parsed, 'fingerprint');
    const probedAt = field(parsed, 'probed_at');
    if (typeof fingerprint !== 'string' || typeof probedAt !== 'string' || Number.isNaN(Date.parse(probedAt)))
        return null;
    return { fingerprint, probed_at: probedAt };
}
function writeProbeCache(projectRoot, cache) {
    if (projectRoot === null)
        return;
    const path = probeCachePath(projectRoot);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(cache) + '\n');
    }
    catch (e) {
        serverLog({ kind: 'cheatcode_probe_cache_write_failed', error_message: e instanceof Error ? e.message : String(e) });
    }
}
function startupProbeReason(cache, fingerprint, nowMs) {
    if (cache === null)
        return 'no_cache';
    if (cache.fingerprint !== fingerprint)
        return 'fingerprint_changed';
    if (nowMs - Date.parse(cache.probed_at) > PROBE_TTL_MS)
        return 'ttl_expired';
    return 'fingerprint_unchanged';
}
function hasTrackedRuntimeRows(db) {
    return (db.get(`SELECT COUNT(*) AS n FROM cheatcodes WHERE status IN ('active', 'broken') AND kind IN ('mcp', 'plugin')`).n > 0);
}
function pluginName(id) {
    return id.split('@')[0] ?? '';
}
function computeStatus(row, evidence, pluginRoot) {
    switch (row.kind) {
        case 'skill': {
            if (!row.file_path)
                return 'broken';
            const resolved = isAbsolute(row.file_path) || !pluginRoot ? row.file_path : join(pluginRoot, row.file_path);
            return existsSync(resolved) ? 'active' : 'broken';
        }
        case 'mcp': {
            const bundled = /^mcp:([^/]+)\/(.+)$/.exec(row.source_url ?? '');
            if (bundled) {
                if (!evidence.plugins)
                    return null;
                const [, plugin, server] = bundled;
                for (const [id, entry] of evidence.plugins) {
                    if (pluginName(id) === plugin && entry.enabled && entry.mcpServers.has(server))
                        return 'active';
                }
                return 'broken';
            }
            if (!evidence.mcpServers)
                return null;
            return evidence.mcpServers.has(row.name) ? 'active' : 'broken';
        }
        case 'plugin': {
            if (!evidence.plugins)
                return null;
            for (const [id, entry] of evidence.plugins) {
                if (pluginName(id) === row.name && entry.enabled)
                    return 'active';
            }
            return 'broken';
        }
        default:
            return null;
    }
}
export function reconcileCheatcodes(db, evidence, opts) {
    const pluginRoot = opts.pluginRoot ?? process.env['CLAUDE_PLUGIN_ROOT'];
    const rows = db.all(`SELECT id, name, kind, status, source_url, file_path FROM cheatcodes WHERE status IN ('active', 'broken') ORDER BY id`);
    const transitions = [];
    for (const row of rows) {
        const next = computeStatus(row, evidence, pluginRoot);
        if (next === null || next === row.status)
            continue;
        db.run('UPDATE cheatcodes SET status = ?, updated_at = ? WHERE id = ?', [next, opts.now, row.id]);
        insertAudit(db, {
            issue_id: -1,
            branch_id: '',
            from_node: opts.fromNode,
            writer: opts.writer,
            event_type: 'cheatcode_healthcheck',
            summary: `${row.name} (${row.kind}): ${row.status} -> ${next}`,
            content_json: JSON.stringify({ name: row.name, kind: row.kind, from: row.status, to: next }),
            created_at: opts.now,
        });
        transitions.push({ id: row.id, name: row.name, kind: row.kind, from: row.status, to: next });
    }
    return transitions;
}
const NO_EVIDENCE = { mcpServers: null, plugins: null };
async function probeAndReconcile(db, identity, projectRoot, fingerprint) {
    const { evidence, listed } = await probeListings(healthcheckTimeoutSec(), projectRoot);
    const now = nowISO();
    if (listed)
        writeProbeCache(projectRoot, { fingerprint, probed_at: now });
    const transitions = reconcileCheatcodes(db, evidence, { ...identity, now });
    return { transitions, probed: { mcp: evidence.mcpServers !== null, plugin: evidence.plugins !== null } };
}
export async function reconcileNow(db, identity) {
    const projectRoot = projectRootFromDbPath(db.dbPath);
    return probeAndReconcile(db, identity, projectRoot, cliConfigFingerprint(projectRoot));
}
export async function reconcileAtStartup(db) {
    if (process.env['TMB_DISABLE_CHEATCODE_HEALTHCHECK'] === '1')
        return;
    const identity = { fromNode: 'server', writer: 'server' };
    try {
        const projectRoot = projectRootFromDbPath(db.dbPath);
        let reason = 'no_tracked_rows';
        let fingerprint = '';
        if (hasTrackedRuntimeRows(db)) {
            fingerprint = cliConfigFingerprint(projectRoot);
            reason = startupProbeReason(readProbeCache(projectRoot), fingerprint, Date.now());
        }
        const probed = reason !== 'no_tracked_rows' && reason !== 'fingerprint_unchanged';
        const { transitions } = probed
            ? await probeAndReconcile(db, identity, projectRoot, fingerprint)
            : { transitions: reconcileCheatcodes(db, NO_EVIDENCE, { ...identity, now: nowISO() }) };
        serverLog({ kind: 'cheatcode_reconcile', transitions: transitions.length, probed, reason });
    }
    catch (e) {
        serverLog({ kind: 'cheatcode_reconcile', error_message: e instanceof Error ? e.message : String(e) });
    }
}
//# sourceMappingURL=cheatcode-reconcile.js.map