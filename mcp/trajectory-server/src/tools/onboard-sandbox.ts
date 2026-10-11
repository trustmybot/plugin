// Native sandbox (containment Tier 0) — /onboard `sandbox_enforcement`, default yes.
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
// that — never a key or path the user set. The sandbox only restricts; it
// grants nothing the session did not already have.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TMB_MODEL_CACHE_DIR } from '../embeddings/model.js';
import { serverLog } from '../logger.js';

export interface SandboxRecord {
  /** True when TMB set sandbox.enabled (it was absent before). */
  readonly enabled_set: boolean;
  /** The allowWrite entries TMB added (absent before). */
  readonly allow_write: readonly string[];
}

export interface SandboxWriteResult {
  readonly written: boolean;
  readonly settings_path?: string;
  readonly allow_write?: readonly string[];
  readonly record?: SandboxRecord;
  readonly reason?: string;
}

export interface SandboxRemoveResult {
  readonly removed: boolean;
  readonly settings_path?: string;
  readonly reason?: string;
}

type Json = Record<string, unknown>;

function settingsPath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'settings.local.json');
}

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readSettings(path: string): { settings: Json } | { reason: string } {
  if (!existsSync(path)) return { settings: {} };
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : {};
    return isObject(parsed) ? { settings: parsed } : { reason: 'existing settings.local.json is not a JSON object' };
  } catch {
    return { reason: 'existing settings.local.json is not valid JSON' };
  }
}

function writeSettings(path: string, settings: Json): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    return null;
  } catch (e) {
    return `settings.local.json write failed: ${(e as Error).message}`;
  }
}

function projectUsable(projectRoot: string | null): projectRoot is string {
  if (!projectRoot) return false;
  try {
    return statSync(projectRoot).isDirectory();
  } catch {
    return false;
  }
}

/** The paths the sandbox block lets Bash write: the project and the model cache. */
export function sandboxAllowWrite(projectRoot: string, cacheDir: string = TMB_MODEL_CACHE_DIR): string[] {
  return [...new Set([projectRoot, cacheDir])];
}

export function writeProjectSandbox(opts: {
  projectRoot: string | null;
  cacheDir?: string;
  previous: SandboxRecord | null;
}): SandboxWriteResult {
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
  const sandbox: Json = isObject(settings['sandbox']) ? (settings['sandbox'] as Json) : {};
  const filesystem: Json = isObject(sandbox['filesystem']) ? (sandbox['filesystem'] as Json) : {};
  const existing = Array.isArray(filesystem['allowWrite'])
    ? (filesystem['allowWrite'] as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const wanted = sandboxAllowWrite(opts.projectRoot, opts.cacheDir);
  const ownedBefore = new Set(opts.previous?.allow_write ?? []);
  const added = wanted.filter((p) => !existing.includes(p) || ownedBefore.has(p));
  const enabledSet = sandbox['enabled'] === undefined || opts.previous?.enabled_set === true;

  if (sandbox['enabled'] === undefined) sandbox['enabled'] = true;
  filesystem['allowWrite'] = [...existing, ...wanted.filter((p) => !existing.includes(p))];
  sandbox['filesystem'] = filesystem;
  settings['sandbox'] = sandbox;

  const failure = writeSettings(path, settings);
  if (failure) {
    serverLog({ event: 'onboard_sandbox_skip', reason: failure });
    return { written: false, reason: failure };
  }
  const record: SandboxRecord = { enabled_set: enabledSet, allow_write: added };
  serverLog({ event: 'onboard_sandbox_written', settingsPath: path, allowWrite: wanted });
  return { written: true, settings_path: path, allow_write: wanted, record };
}

export function removeProjectSandbox(opts: {
  projectRoot: string | null;
  record: SandboxRecord | null;
}): SandboxRemoveResult {
  if (!projectUsable(opts.projectRoot)) return { removed: false, reason: 'no project directory' };
  const path = settingsPath(opts.projectRoot);
  if (!existsSync(path) || opts.record === null) return { removed: false, settings_path: path };
  const read = readSettings(path);
  if ('reason' in read) return { removed: false, reason: read.reason };
  const settings = read.settings;
  if (!isObject(settings['sandbox'])) return { removed: false, settings_path: path };
  const sandbox = settings['sandbox'] as Json;

  const owned = new Set(opts.record.allow_write);
  if (isObject(sandbox['filesystem'])) {
    const filesystem = sandbox['filesystem'] as Json;
    if (Array.isArray(filesystem['allowWrite'])) {
      const kept = (filesystem['allowWrite'] as unknown[]).filter((p) => !(typeof p === 'string' && owned.has(p)));
      if (kept.length > 0) filesystem['allowWrite'] = kept;
      else delete filesystem['allowWrite'];
    }
    if (Object.keys(filesystem).length === 0) delete sandbox['filesystem'];
  }
  if (opts.record.enabled_set) delete sandbox['enabled'];
  if (Object.keys(sandbox).length === 0) delete settings['sandbox'];

  const failure = writeSettings(path, settings);
  if (failure) return { removed: false, reason: failure };
  serverLog({ event: 'onboard_sandbox_removed', settingsPath: path });
  return { removed: true, settings_path: path };
}
