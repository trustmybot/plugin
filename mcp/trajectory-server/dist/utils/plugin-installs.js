/**
 * Enabled copies of this plugin for the project, read from Claude Code's
 * `installed_plugins.json` and the `enabledPlugins` maps — the same rules as
 * `tmb_duplicate_installs` in `scripts/hooks/lib/resolve-install.sh`. Read-only.
 *
 * - applies: a user-scope entry, or a project/local entry whose canonical
 *   projectPath is the canonical project dir; a key with both reports its
 *   project/local entry (one key is one copy);
 * - enabled: `enabledPlugins[key] === true` in the first of
 *   `<project>/.claude/settings.local.json`, `<project>/.claude/settings.json`,
 *   `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json` that sets the key.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { resolveClaudePluginName, resolveClaudeProjectRoot } from '../platform.js';
function claudeConfigDir(env) {
    return env['CLAUDE_CONFIG_DIR'] || join(env['HOME'] || '', '.claude');
}
export function installedPluginsJsonPath(env = process.env) {
    return env['TMB_INSTALLED_JSON'] || join(claudeConfigDir(env), 'plugins', 'installed_plugins.json');
}
function canonicalDir(dir) {
    try {
        return realpathSync(dir);
    }
    catch {
        return dir;
    }
}
function readJsonObject(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function enabledMap(project, env) {
    const files = [
        join(claudeConfigDir(env), 'settings.json'),
        join(project, '.claude', 'settings.json'),
        join(project, '.claude', 'settings.local.json'),
    ];
    const merged = {};
    for (const file of files) {
        const plugins = readJsonObject(file)?.['enabledPlugins'];
        if (plugins !== null && typeof plugins === 'object' && !Array.isArray(plugins))
            Object.assign(merged, plugins);
    }
    return merged;
}
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
export function enabledPluginCopies(env = process.env) {
    const projectRoot = resolveClaudeProjectRoot(env);
    if (projectRoot === null)
        return { skipped: 'CLAUDE_PROJECT_DIR is unset' };
    const registryPath = installedPluginsJsonPath(env);
    const registry = readJsonObject(registryPath);
    if (registry === null)
        return { skipped: `cannot read ${registryPath}` };
    const project = canonicalDir(projectRoot);
    const enabled = enabledMap(project, env);
    const prefix = `${resolveClaudePluginName(env)}@`;
    const plugins = registry['plugins'];
    const copies = [];
    if (plugins === null || typeof plugins !== 'object')
        return { copies };
    for (const [key, entries] of Object.entries(plugins)) {
        if (!key.startsWith(prefix) || enabled[key] !== true || !Array.isArray(entries))
            continue;
        let chosen = null;
        for (const raw of entries) {
            if (raw === null || typeof raw !== 'object')
                continue;
            const e = raw;
            const scope = str(e['scope']) ?? 'user';
            let rank = 1;
            if (scope === 'project' || scope === 'local') {
                const projectPath = str(e['projectPath']);
                if (projectPath === null || canonicalDir(projectPath) !== project)
                    continue;
                rank = 0;
            }
            if (chosen !== null && chosen.rank <= rank)
                continue;
            chosen = {
                rank,
                copy: { key, marketplace: key.slice(prefix.length), version: str(e['version']), install_path: str(e['installPath']), scope },
            };
        }
        if (chosen !== null)
            copies.push(chosen.copy);
    }
    copies.sort((a, b) => a.marketplace.localeCompare(b.marketplace));
    return { copies };
}
//# sourceMappingURL=plugin-installs.js.map