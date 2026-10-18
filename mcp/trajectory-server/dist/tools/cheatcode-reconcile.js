import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { nowISO } from '../db.js';
import { serverLog } from '../logger.js';
import { insertAudit } from './audit.js';
const DEFAULT_TIMEOUT_SEC = 4;
const MAX_LISTING_BYTES = 8 * 1024 * 1024;
export function healthcheckTimeoutSec() {
    const raw = Number(process.env['TMB_CHEATCODE_HEALTHCHECK_TIMEOUT']);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_SEC;
}
export function probeChildEnv() {
    return { ...process.env, TMB_DISABLE_CHEATCODE_HEALTHCHECK: '1' };
}
function runClaude(args, timeoutSec) {
    return new Promise((resolve) => {
        try {
            const child = execFile('claude', args, {
                env: probeChildEnv(),
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
export async function probeRuntime(timeoutSec) {
    const [mcpText, pluginText] = await Promise.all([
        runClaude(['mcp', 'list'], timeoutSec),
        runClaude(['plugin', 'list', '--json'], timeoutSec),
    ]);
    const mcpNames = new Set([...(mcpText === null ? [] : parseMcpListing(mcpText)), ...claudeJsonMcpKeys()]);
    return {
        mcpServers: mcpNames.size > 0 ? mcpNames : null,
        plugins: pluginText === null ? null : parsePluginListing(pluginText),
    };
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
export async function reconcileNow(db, identity) {
    const evidence = await probeRuntime(healthcheckTimeoutSec());
    const transitions = reconcileCheatcodes(db, evidence, { ...identity, now: nowISO() });
    return { transitions, probed: { mcp: evidence.mcpServers !== null, plugin: evidence.plugins !== null } };
}
export async function reconcileAtStartup(db) {
    if (process.env['TMB_DISABLE_CHEATCODE_HEALTHCHECK'] === '1')
        return;
    try {
        const { transitions } = await reconcileNow(db, { fromNode: 'server', writer: 'server' });
        serverLog({ kind: 'cheatcode_reconcile', transitions: transitions.length });
    }
    catch (e) {
        serverLog({ kind: 'cheatcode_reconcile', error_message: e instanceof Error ? e.message : String(e) });
    }
}
//# sourceMappingURL=cheatcode-reconcile.js.map