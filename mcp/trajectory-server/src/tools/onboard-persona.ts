// The bro persona block in a user project's CLAUDE.md (/onboard, GH 1339).
//
// Claude Code loads the project's CLAUDE.md, never the plugin's, so onboarding
// copies the plugin's CLAUDE.md body into <project>/CLAUDE.md between the
// managed markers of persona-block.ts. When the project root is the plugin root
// (the TMB repo itself) that file IS the source and is never rewritten. Writes
// are atomic (temp file + rename) and keep the file's mode.

import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyPersonaBlock,
  personaBlockVersion,
  removePersonaBlock,
  renderPersonaBlock,
  type PersonaApplyAction,
  type PersonaRemoveAction,
} from '../persona-block.js';

// Resolve the installed plugin's source root: prefer CLAUDE_PLUGIN_ROOT (must
// have .claude-plugin/plugin.json), else walk up from this module until that
// manifest is found — correct for both the tsc layout (dist/tools/*.js) and
// the esbuild bundle (dist/index.js). Null when unresolvable.
export function resolvePluginRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env['CLAUDE_PLUGIN_ROOT'];
  if (fromEnv && existsSync(join(fromEnv, '.claude-plugin', 'plugin.json'))) return fromEnv;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface PersonaSource {
  readonly body: string;
  readonly version: string;
}

export function readPersonaSource(pluginRoot: string | null): PersonaSource | { reason: string } {
  if (!pluginRoot) return { reason: 'plugin root not resolved' };
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown };
    if (typeof manifest.version !== 'string' || manifest.version.length === 0) return { reason: 'plugin.json has no version' };
    const body = readFileSync(join(pluginRoot, 'CLAUDE.md'), 'utf8');
    return { body, version: manifest.version };
  } catch {
    return { reason: 'plugin CLAUDE.md or plugin.json unreadable' };
  }
}

function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export function isPluginRoot(projectRoot: string, pluginRoot: string): boolean {
  return canonical(projectRoot) === canonical(pluginRoot);
}

function writeAtomic(path: string, text: string): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o7777 : null;
  const tmp = join(dirname(path), `.CLAUDE.md.tmb-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, text);
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
}

export interface PersonaResult {
  readonly action: PersonaApplyAction | PersonaRemoveAction | 'skipped';
  readonly version: string | null;
  readonly path: string | null;
  readonly reason?: string;
}

/**
 * Write (`enabled`) or remove the persona block in <projectRoot>/CLAUDE.md.
 * Throws PersonaBlockError on malformed markers without touching the file.
 */
export function syncProjectPersona(opts: {
  pluginRoot: string | null;
  projectRoot: string | null;
  enabled: boolean;
}): PersonaResult {
  const { pluginRoot, projectRoot, enabled } = opts;
  if (!projectRoot) return { action: 'skipped', version: null, path: null, reason: 'no project root' };
  const path = join(projectRoot, 'CLAUDE.md');
  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    return { action: 'skipped', version: null, path, reason: 'project root does not exist' };
  }
  const source = readPersonaSource(pluginRoot);
  if (pluginRoot && isPluginRoot(projectRoot, pluginRoot)) {
    return { action: 'skipped_source', version: 'version' in source ? source.version : null, path };
  }
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;

  if (!enabled) {
    if (existing === null) return { action: 'unchanged', version: null, path };
    const removedVersion = personaBlockVersion(existing);
    const removed = removePersonaBlock(existing);
    if (removed.action === 'removed') writeAtomic(path, removed.text);
    return { action: removed.action, version: removedVersion, path };
  }

  if ('reason' in source) return { action: 'skipped', version: null, path, reason: source.reason };
  const applied = applyPersonaBlock(existing, renderPersonaBlock(source.body, source.version));
  if (applied.action !== 'unchanged') writeAtomic(path, applied.text);
  return { action: applied.action, version: source.version, path };
}
