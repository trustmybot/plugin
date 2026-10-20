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

export interface PluginCopy {
  readonly key: string;
  readonly marketplace: string;
  readonly version: string | null;
  readonly install_path: string | null;
  readonly scope: string;
}

export type PluginCopiesResult = { readonly copies: readonly PluginCopy[] } | { readonly skipped: string };

function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env['CLAUDE_CONFIG_DIR'] || join(env['HOME'] || '', '.claude');
}

export function installedPluginsJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['TMB_INSTALLED_JSON'] || join(claudeConfigDir(env), 'plugins', 'installed_plugins.json');
}

function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function enabledMap(project: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const files = [
    join(claudeConfigDir(env), 'settings.json'),
    join(project, '.claude', 'settings.json'),
    join(project, '.claude', 'settings.local.json'),
  ];
  const merged: Record<string, unknown> = {};
  for (const file of files) {
    const plugins = readJsonObject(file)?.['enabledPlugins'];
    if (plugins !== null && typeof plugins === 'object' && !Array.isArray(plugins)) Object.assign(merged, plugins);
  }
  return merged;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function enabledPluginCopies(env: NodeJS.ProcessEnv = process.env): PluginCopiesResult {
  const projectRoot = resolveClaudeProjectRoot(env);
  if (projectRoot === null) return { skipped: 'CLAUDE_PROJECT_DIR is unset' };
  const registryPath = installedPluginsJsonPath(env);
  const registry = readJsonObject(registryPath);
  if (registry === null) return { skipped: `cannot read ${registryPath}` };

  const project = canonicalDir(projectRoot);
  const enabled = enabledMap(project, env);
  const prefix = `${resolveClaudePluginName(env)}@`;
  const plugins = registry['plugins'];
  const copies: PluginCopy[] = [];
  if (plugins === null || typeof plugins !== 'object') return { copies };

  for (const [key, entries] of Object.entries(plugins as Record<string, unknown>)) {
    if (!key.startsWith(prefix) || enabled[key] !== true || !Array.isArray(entries)) continue;
    let chosen: { rank: number; copy: PluginCopy } | null = null;
    for (const raw of entries) {
      if (raw === null || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      const scope = str(e['scope']) ?? 'user';
      let rank = 1;
      if (scope === 'project' || scope === 'local') {
        const projectPath = str(e['projectPath']);
        if (projectPath === null || canonicalDir(projectPath) !== project) continue;
        rank = 0;
      }
      if (chosen !== null && chosen.rank <= rank) continue;
      chosen = {
        rank,
        copy: { key, marketplace: key.slice(prefix.length), version: str(e['version']), install_path: str(e['installPath']), scope },
      };
    }
    if (chosen !== null) copies.push(chosen.copy);
  }
  copies.sort((a, b) => a.marketplace.localeCompare(b.marketplace));
  return { copies };
}
