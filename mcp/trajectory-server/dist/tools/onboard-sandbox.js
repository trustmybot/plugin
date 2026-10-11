// Native sandbox (containment Tier 0) — /onboard `sandbox_enforcement`, default no.
//
// Claude Code's Bash sandbox confines Bash writes, the main loop's and every
// subagent's, to the working directory plus `sandbox.filesystem.allowWrite`
// (verified live; docs/architecture/CONTAINMENT.md). On yes, /onboard merges
//
//   { "sandbox": { "enabled": true, "filesystem": { "allowWrite": [<project>, <model cache>] } } }
//
// into <project>/.claude/settings.local.json, keeping every other key and
// every allowWrite entry already there. What it added is returned as a record
// (stored in plugin_config.sandbox_settings) so answering no removes exactly
// that — never a key or path the user set. The block is written only on an
// explicit yes: Claude Code's sandbox network defaults then also apply to Bash,
// which has not been verified against gh / git push / package installs.
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
    const existing = Array.isArray(filesystem['allowWrite'])
        ? filesystem['allowWrite'].filter((p) => typeof p === 'string')
        : [];
    const wanted = sandboxAllowWrite(opts.projectRoot, opts.cacheDir);
    const ownedBefore = new Set(opts.previous?.allow_write ?? []);
    const added = wanted.filter((p) => !existing.includes(p) || ownedBefore.has(p));
    const enabledSet = sandbox['enabled'] === undefined || opts.previous?.enabled_set === true;
    if (sandbox['enabled'] === undefined)
        sandbox['enabled'] = true;
    filesystem['allowWrite'] = [...existing, ...wanted.filter((p) => !existing.includes(p))];
    sandbox['filesystem'] = filesystem;
    settings['sandbox'] = sandbox;
    const failure = writeSettings(path, settings);
    if (failure) {
        serverLog({ event: 'onboard_sandbox_skip', reason: failure });
        return { written: false, reason: failure };
    }
    const record = { enabled_set: enabledSet, allow_write: added };
    serverLog({ event: 'onboard_sandbox_written', settingsPath: path, allowWrite: wanted });
    return { written: true, settings_path: path, allow_write: wanted, record };
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