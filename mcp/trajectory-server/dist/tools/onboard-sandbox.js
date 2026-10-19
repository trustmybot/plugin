// Native sandbox (containment Tier 0) — /onboard `sandbox_enforcement`.
//
// Claude Code's Bash sandbox confines Bash writes, the main loop's and every
// subagent's, to the working directory plus `sandbox.filesystem.allowWrite`
// (verified live; docs/architecture/CONTAINMENT.md), and routes Bash network
// traffic through a proxy that refuses, headless, any host not in
// `sandbox.network.allowedDomains`. On yes, /onboard merges
//
//   { "sandbox": { "enabled": true,
//                  "filesystem": { "allowWrite": [<project>, <model cache>] },
//                  "network": { "allowedDomains": [<TMB's hosts>, <HTTPS remote hosts>] } } }
//
// into <project>/.claude/settings.local.json, keeping every other key and
// every allowWrite path and domain already there. It never writes
// `excludedCommands`. What it added is returned as a record (stored in
// plugin_config.sandbox_settings) so answering no removes exactly that —
// never a key, path or domain the user set.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TMB_MODEL_CACHE_DIR } from '../embeddings/model.js';
import { serverLog } from '../logger.js';
function settingsPath(projectRoot) {
    return join(projectRoot, '.claude', 'settings.local.json');
}
function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function readSettings(path) {
    if (!existsSync(path))
        return { settings: {} };
    try {
        const raw = readFileSync(path, 'utf8').trim();
        const parsed = raw.length > 0 ? JSON.parse(raw) : {};
        return isObject(parsed) ? { settings: parsed } : { reason: 'existing settings.local.json is not a JSON object' };
    }
    catch {
        return { reason: 'existing settings.local.json is not valid JSON' };
    }
}
function writeSettings(path, settings) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
        return null;
    }
    catch (e) {
        return `settings.local.json write failed: ${e.message}`;
    }
}
function projectUsable(projectRoot) {
    if (!projectRoot)
        return false;
    try {
        return statSync(projectRoot).isDirectory();
    }
    catch {
        return false;
    }
}
/** The hosts every TMB project reaches from Bash: GitHub (git, gh, raw content) and the npm registry. */
export const TMB_ALLOWED_DOMAINS = [
    'github.com',
    'api.github.com',
    '*.githubusercontent.com',
    'registry.npmjs.org',
];
/**
 * The last run of tests/l5-l6/probes/sandbox-network-probe.sh: the setup-B
 * commands (filesystem block + allow-list) that failed. Each failure is local
 * to the sandbox, not a missing host: gh cannot reach the macOS TLS trust
 * service, npm cannot write its ~/.npm cache, bun cannot open its temp dir.
 */
export const SANDBOX_NETWORK_PROBE = {
    cc_version: '2.1.303',
    date: '2026-10-18',
    failed: ['gh api user --jq .login', 'npm view is-number version', 'bun add is-number'],
};
/** Git over SSH bypasses the sandbox's network proxy. */
export function isSshRemote(url) {
    return /^ssh:\/\//i.test(url) || /^[^@/:\s]+@[^:/\s]+:/.test(url);
}
function httpsHost(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname ? parsed.hostname.toLowerCase() : null;
    }
    catch {
        return null;
    }
}
/** TMB's hosts plus the host of every HTTPS remote. */
export function sandboxAllowedDomains(remoteUrls) {
    const hosts = remoteUrls.map(httpsHost).filter((h) => h !== null);
    return [...new Set([...TMB_ALLOWED_DOMAINS, ...hosts])];
}
/** A fresh onboard recommends yes only when the probe passed every command and no remote is SSH. */
export function sandboxRecommended(remoteUrls, probeFailed = SANDBOX_NETWORK_PROBE.failed) {
    return probeFailed.length === 0 && !remoteUrls.some(isSshRemote);
}
function stringList(v) {
    return Array.isArray(v) ? v.filter((p) => typeof p === 'string') : [];
}
/** The paths the sandbox block lets Bash write: the project and the model cache. */
export function sandboxAllowWrite(projectRoot, cacheDir = TMB_MODEL_CACHE_DIR) {
    return [...new Set([projectRoot, cacheDir])];
}
export function writeProjectSandbox(opts) {
    if (!projectUsable(opts.projectRoot)) {
        return { written: false, reason: 'no project directory' };
    }
    const path = settingsPath(opts.projectRoot);
    const read = readSettings(path);
    if ('reason' in read) {
        serverLog({ event: 'onboard_sandbox_skip', reason: read.reason });
        return { written: false, reason: read.reason };
    }
    const settings = read.settings;
    const sandbox = isObject(settings['sandbox']) ? settings['sandbox'] : {};
    const filesystem = isObject(sandbox['filesystem']) ? sandbox['filesystem'] : {};
    const existing = stringList(filesystem['allowWrite']);
    const wanted = sandboxAllowWrite(opts.projectRoot, opts.cacheDir);
    const ownedBefore = new Set(opts.previous?.allow_write ?? []);
    const added = wanted.filter((p) => !existing.includes(p) || ownedBefore.has(p));
    const enabledSet = sandbox['enabled'] === undefined || opts.previous?.enabled_set === true;
    const network = isObject(sandbox['network']) ? sandbox['network'] : {};
    const wantedDomains = sandboxAllowedDomains(opts.remoteUrls ?? []);
    const ownedDomainsBefore = new Set(opts.previous?.allowed_domains ?? []);
    const existingDomains = stringList(network['allowedDomains']).filter((d) => !ownedDomainsBefore.has(d) || wantedDomains.includes(d));
    const addedDomains = wantedDomains.filter((d) => !existingDomains.includes(d) || ownedDomainsBefore.has(d));
    if (sandbox['enabled'] === undefined)
        sandbox['enabled'] = true;
    filesystem['allowWrite'] = [...existing, ...wanted.filter((p) => !existing.includes(p))];
    sandbox['filesystem'] = filesystem;
    network['allowedDomains'] = [...existingDomains, ...wantedDomains.filter((d) => !existingDomains.includes(d))];
    sandbox['network'] = network;
    settings['sandbox'] = sandbox;
    const failure = writeSettings(path, settings);
    if (failure) {
        serverLog({ event: 'onboard_sandbox_skip', reason: failure });
        return { written: false, reason: failure };
    }
    const record = { enabled_set: enabledSet, allow_write: added, allowed_domains: addedDomains };
    serverLog({ event: 'onboard_sandbox_written', settingsPath: path, allowWrite: wanted, allowedDomains: wantedDomains });
    return { written: true, settings_path: path, allow_write: wanted, allowed_domains: wantedDomains, record };
}
export function removeProjectSandbox(opts) {
    if (!projectUsable(opts.projectRoot))
        return { removed: false, reason: 'no project directory' };
    const path = settingsPath(opts.projectRoot);
    if (!existsSync(path) || opts.record === null)
        return { removed: false, settings_path: path };
    const read = readSettings(path);
    if ('reason' in read)
        return { removed: false, reason: read.reason };
    const settings = read.settings;
    if (!isObject(settings['sandbox']))
        return { removed: false, settings_path: path };
    const sandbox = settings['sandbox'];
    const owned = new Set(opts.record.allow_write);
    if (isObject(sandbox['filesystem'])) {
        const filesystem = sandbox['filesystem'];
        if (Array.isArray(filesystem['allowWrite'])) {
            const kept = filesystem['allowWrite'].filter((p) => !(typeof p === 'string' && owned.has(p)));
            if (kept.length > 0)
                filesystem['allowWrite'] = kept;
            else
                delete filesystem['allowWrite'];
        }
        if (Object.keys(filesystem).length === 0)
            delete sandbox['filesystem'];
    }
    const ownedDomains = new Set(opts.record.allowed_domains ?? []);
    if (isObject(sandbox['network'])) {
        const network = sandbox['network'];
        if (Array.isArray(network['allowedDomains'])) {
            const kept = network['allowedDomains'].filter((d) => !(typeof d === 'string' && ownedDomains.has(d)));
            if (kept.length > 0)
                network['allowedDomains'] = kept;
            else
                delete network['allowedDomains'];
        }
        if (Object.keys(network).length === 0)
            delete sandbox['network'];
    }
    if (opts.record.enabled_set)
        delete sandbox['enabled'];
    if (Object.keys(sandbox).length === 0)
        delete settings['sandbox'];
    const failure = writeSettings(path, settings);
    if (failure)
        return { removed: false, reason: failure };
    serverLog({ event: 'onboard_sandbox_removed', settingsPath: path });
    return { removed: true, settings_path: path };
}
//# sourceMappingURL=onboard-sandbox.js.map