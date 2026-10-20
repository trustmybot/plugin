// Native sandbox (containment Tier 0) — /onboard `sandbox_enforcement`.
//
// Claude Code's Bash sandbox confines Bash writes, the main loop's and every
// subagent's, to the working directory plus `sandbox.filesystem.allowWrite`
// (verified live; docs/architecture/CONTAINMENT.md), and routes Bash network
// traffic through a proxy that refuses, headless, any host not in
// `sandbox.network.allowedDomains`. On yes, /onboard merges
//
//   { "sandbox": { "enabled": true,
//                  "enableWeakerNetworkIsolation": true,            (macOS only)
//                  "filesystem": { "allowWrite": [<project>, <model cache>] },
//                  "network": { "allowedDomains": [<TMB's hosts>, <HTTPS remote hosts>] } },
//     "env": { "npm_config_cache": <plugin state dir>/cache/npm,
//              "BUN_INSTALL_CACHE_DIR": <plugin state dir>/cache/bun } }
//
// into <project>/.claude/settings.local.json, keeping every other key and
// every allowWrite path, domain and env value already there. It never writes
// `excludedCommands`. What it added is returned as a record (stored in
// plugin_config.sandbox_settings) so answering no removes exactly that —
// never a key, path, domain or env value the user set.
//
// When a TMB writer creates settings.local.json in a git work tree that does
// not already ignore it, ensureLocalSettingsIgnored appends the path to the
// project's .gitignore: Claude Code ignores the file only when it creates it.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TMB_MODEL_CACHE_DIR } from '../embeddings/model.js';
import { serverLog } from '../logger.js';
import { resolveClaudePluginName } from '../platform.js';
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
const LOCAL_SETTINGS_REL = '.claude/settings.local.json';
/**
 * Append `.claude/settings.local.json` to `<projectRoot>/.gitignore` when the
 * root is inside a git work tree that does not already ignore that path.
 */
export function ensureLocalSettingsIgnored(projectRoot) {
    const opts = { encoding: 'utf8', timeout: 3000 };
    const inTree = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], opts);
    if (inTree.status !== 0 || (inTree.stdout ?? '').trim() !== 'true')
        return { appended: false };
    const ignored = spawnSync('git', ['-C', projectRoot, 'check-ignore', '-q', LOCAL_SETTINGS_REL], opts);
    if (ignored.status !== 1)
        return { appended: false };
    const gitignore = join(projectRoot, '.gitignore');
    try {
        const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
        const lead = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
        appendFileSync(gitignore, `${lead}${LOCAL_SETTINGS_REL}\n`);
    }
    catch (e) {
        serverLog({ event: 'onboard_gitignore_skip', reason: e.message });
        return { appended: false };
    }
    serverLog({ event: 'onboard_gitignore_appended', gitignore });
    return { appended: true };
}
function writeSettings(path, settings) {
    const created = !existsSync(path);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    }
    catch (e) {
        return { failure: `settings.local.json write failed: ${e.message}` };
    }
    return { gitignore_appended: created && ensureLocalSettingsIgnored(dirname(dirname(path))).appended };
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
 * The last run of tests/l5-l6/probes/sandbox-network-probe.sh, whose setup B
 * is the block writeProjectSandbox writes. Hand-recorded from its output.
 */
export const SANDBOX_NETWORK_PROBE = {
    cc_version: '2.1.303',
    date: '2026-10-19',
    platform: 'darwin',
    failed: [],
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
/**
 * A fresh onboard recommends yes only on the platform the probe ran on, when
 * it passed every command, and when no remote is SSH.
 */
export function sandboxRecommended(remoteUrls, platform = process.platform, probe = SANDBOX_NETWORK_PROBE) {
    return platform === probe.platform && probe.failed.length === 0 && !remoteUrls.some(isSshRemote);
}
/** Where sandboxed npm and bun keep their caches: inside the project, which the sandbox lets Bash write. */
export function sandboxToolCacheDir(projectRoot) {
    return join(projectRoot, '.claude', resolveClaudePluginName(), 'cache');
}
/**
 * The env the block sets so npm and bun cache inside the project: the sandbox
 * denies writes to ~/.npm, and bun needs its temp dir on the same volume as
 * a writable install cache.
 */
export function sandboxToolEnv(toolCacheDir) {
    return { npm_config_cache: join(toolCacheDir, 'npm'), BUN_INSTALL_CACHE_DIR: join(toolCacheDir, 'bun') };
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
    if (settings['env'] !== undefined && !isObject(settings['env'])) {
        const reason = 'existing settings.local.json env is not a JSON object';
        serverLog({ event: 'onboard_sandbox_skip', reason });
        return { written: false, reason };
    }
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
    const env = isObject(settings['env']) ? settings['env'] : {};
    const wantedEnv = sandboxToolEnv(opts.toolCacheDir ?? sandboxToolCacheDir(opts.projectRoot));
    const ownedEnvBefore = opts.previous?.env ?? {};
    for (const [name, value] of Object.entries(ownedEnvBefore)) {
        if (!(name in wantedEnv) && env[name] === value)
            delete env[name];
    }
    const addedEnv = {};
    for (const [name, value] of Object.entries(wantedEnv)) {
        if (env[name] === undefined || env[name] === ownedEnvBefore[name]) {
            env[name] = value;
            addedEnv[name] = value;
        }
    }
    const weaker = (opts.platform ?? process.platform) === 'darwin';
    const weakerOwnedBefore = opts.previous?.weaker_network_isolation_set === true;
    const weakerSet = weaker && (sandbox['enableWeakerNetworkIsolation'] === undefined || weakerOwnedBefore);
    if (weakerSet)
        sandbox['enableWeakerNetworkIsolation'] = true;
    else if (!weaker && weakerOwnedBefore)
        delete sandbox['enableWeakerNetworkIsolation'];
    if (sandbox['enabled'] === undefined)
        sandbox['enabled'] = true;
    filesystem['allowWrite'] = [...existing, ...wanted.filter((p) => !existing.includes(p))];
    sandbox['filesystem'] = filesystem;
    network['allowedDomains'] = [...existingDomains, ...wantedDomains.filter((d) => !existingDomains.includes(d))];
    sandbox['network'] = network;
    settings['sandbox'] = sandbox;
    settings['env'] = env;
    const write = writeSettings(path, settings);
    if ('failure' in write) {
        serverLog({ event: 'onboard_sandbox_skip', reason: write.failure });
        return { written: false, reason: write.failure };
    }
    const record = {
        enabled_set: enabledSet,
        allow_write: added,
        allowed_domains: addedDomains,
        weaker_network_isolation_set: weakerSet,
        env: addedEnv,
    };
    serverLog({ event: 'onboard_sandbox_written', settingsPath: path, allowWrite: wanted, allowedDomains: wantedDomains, env: wantedEnv });
    return {
        written: true,
        settings_path: path,
        allow_write: wanted,
        allowed_domains: wantedDomains,
        env: wantedEnv,
        weaker_network_isolation: sandbox['enableWeakerNetworkIsolation'] === true,
        record,
        gitignore_appended: write.gitignore_appended,
    };
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
    if (opts.record.weaker_network_isolation_set)
        delete sandbox['enableWeakerNetworkIsolation'];
    if (Object.keys(sandbox).length === 0)
        delete settings['sandbox'];
    if (isObject(settings['env'])) {
        const env = settings['env'];
        for (const [name, value] of Object.entries(opts.record.env ?? {})) {
            if (env[name] === value)
                delete env[name];
        }
        if (Object.keys(env).length === 0)
            delete settings['env'];
    }
    const write = writeSettings(path, settings);
    if ('failure' in write)
        return { removed: false, reason: write.failure };
    serverLog({ event: 'onboard_sandbox_removed', settingsPath: path });
    return { removed: true, settings_path: path };
}
//# sourceMappingURL=onboard-sandbox.js.map