/**
 * TypeScript port of the install readers of scripts/hooks/lib/resolve-install.sh
 * (GH 1692): this plugin's installs recorded in installed_plugins.json, by
 * scope, and the enabled copies of it that apply to a project. The .sh's jq
 * filters keep jq 1.7's stream semantics (each JSON value of a file runs on
 * its own; an index error ends that value's rows), its rows stay @tsv-escaped
 * as `read -r` leaves them, and its sorts compare bytes (LC_ALL=C order).
 */
import { readFileSync, statSync } from 'node:fs';
import { realdir, stripTrailingNewlines } from './db.js';
import { byteCompare } from './host.js';
import { jsonStream } from './jq.js';
import { homeDir, pluginName, posixBasename } from './project-env.js';

const DEFAULT_NAME = 'tmb';

export interface InstallRow {
  scope: string;
  project: string;
  install: string;
  at: string;
  version: string;
}

export interface DuplicateRow {
  marketplace: string;
  version: string;
  install: string;
  scope: string;
}

class JqError extends Error {}

/** _tmb_install_plugin_name: the manifest's `.name`, else "tmb". */
export function installPluginName(env: NodeJS.ProcessEnv = process.env): string {
  return stripTrailingNewlines(pluginName(env)) || DEFAULT_NAME;
}

function configDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || `${homeDir(env)}/.claude`;
}

/** tmb_installed_json. */
export function installedJson(env: NodeJS.ProcessEnv = process.env): string {
  return env.TMB_INSTALLED_JSON || `${configDir(env)}/plugins/installed_plugins.json`;
}

/** _tmb_canonical_dir: `cd <dir> && pwd -P`, else <dir> as given. */
export function canonicalDir(dir: string): string {
  return realdir(dir);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function index(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new JqError(`Cannot index with ${key}`);
  const v = (value as Record<string, unknown>)[key];
  return v === undefined ? null : v;
}

function field(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** jq's @tsv escaping of one field. */
export function tsvEscape(text: string): string {
  return text.replace(/[\\\t\n\r]/g, (c) => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[c] ?? c);
}

/** `(.plugins // {}) | to_entries[] | select(.key | startswith(<prefix>))`, entry by entry. */
function* pluginEntries(doc: unknown, prefix: string): Generator<[string, unknown]> {
  let plugins = index(doc, 'plugins');
  if (plugins === null || plugins === false) plugins = {};
  if (Array.isArray(plugins)) {
    if (plugins.length > 0) throw new JqError('startswith on a number');
    return;
  }
  if (typeof plugins !== 'object') throw new JqError('has no keys');
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (key.startsWith(prefix)) yield [key, value];
  }
}

/** `.value[]?`: an object's values or an array's elements, nothing for anything else. */
function elements(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.values(value);
  return [];
}

/** Runs <rows> on each JSON value of <path>, keeping the rows a value gave before an index error. */
function jqRows<T>(path: string, rows: (doc: unknown, push: (row: T) => void) => void): T[] {
  const text = readText(path);
  if (text === null) return [];
  const out: T[] = [];
  for (const doc of jsonStream(text).values) {
    try {
      rows(doc, (row) => out.push(row));
    } catch (e) {
      if (!(e instanceof JqError)) throw e;
    }
  }
  return out;
}

/** tmb_install_candidates: every install of this plugin whose installPath is a dir. */
export function installCandidates(env: NodeJS.ProcessEnv = process.env): InstallRow[] {
  const json = installedJson(env);
  try {
    if (!statSync(json).isFile()) return [];
  } catch {
    return [];
  }
  const prefix = `${installPluginName(env)}@`;
  const raw = jqRows<string[]>(json, (doc, push) => {
    for (const [, value] of pluginEntries(doc, prefix)) {
      for (const e of elements(value)) {
        push([
          field(index(e, 'scope'), 'user'),
          field(index(e, 'projectPath'), '-'),
          field(index(e, 'installPath'), '-'),
          field(index(e, 'installedAt'), '-'),
          field(index(e, 'version'), '-'),
        ].map(tsvEscape));
      }
    }
  });
  const out: InstallRow[] = [];
  for (const [scope, project, install, at, version] of raw) {
    if (install === '-' || !isDir(install)) continue;
    out.push({ scope, project: project === '-' ? project : canonicalDir(project), install, at, version });
  }
  return out;
}

function rowLine(r: InstallRow): string {
  return [r.scope, r.project, r.install, r.at, r.version].join('\t');
}

/** `sort -t$'\t' -k4,4r`: installedAt descending, then the whole line ascending. */
function newestFirst(rows: InstallRow[]): InstallRow[] {
  return [...rows].sort((a, b) => byteCompare(b.at, a.at) || byteCompare(rowLine(a), rowLine(b)));
}

/** tmb_project_installs: project/local installs for CLAUDE_PROJECT_DIR, newest first. */
export function projectInstalls(env: NodeJS.ProcessEnv = process.env): InstallRow[] {
  const project = env.CLAUDE_PROJECT_DIR ?? '';
  if (project === '') return [];
  const here = canonicalDir(project);
  return newestFirst(installCandidates(env).filter((r) => (r.scope === 'project' || r.scope === 'local') && r.project === here));
}

/** tmb_user_installs: user-scope installs, newest first. */
export function userInstalls(env: NodeJS.ProcessEnv = process.env): InstallRow[] {
  return newestFirst(installCandidates(env).filter((r) => r.scope === 'user'));
}

/** The mcp-health-check notice's install_version: the version, else the installPath's basename. */
export function installVersion(row: InstallRow): string {
  return row.version !== '' && row.version !== '-' ? row.version : posixBasename(row.install);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The merged enabledPlugins of the user, project and local settings files, later files winning. */
function enabledPlugins(here: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const file of [`${configDir(env)}/settings.json`, `${here}/.claude/settings.json`, `${here}/.claude/settings.local.json`]) {
    for (const part of jqRows<Record<string, unknown>>(file, (doc, push) => {
      let v = index(doc, 'enabledPlugins');
      if (v === null || v === false) v = {};
      push(isObject(v) ? v : {});
    })) {
      for (const [k, v] of Object.entries(part)) {
        delete merged[k];
        merged[k] = v;
      }
    }
  }
  return merged;
}

/** tmb_duplicate_installs <project>: the enabled copies applying to <project>, when there are two or more. */
export function duplicateInstalls(project: string, env: NodeJS.ProcessEnv = process.env): DuplicateRow[] {
  if (project === '') return [];
  const name = installPluginName(env);
  const here = canonicalDir(project);
  const on = enabledPlugins(here, env);
  const prefix = `${name}@`;
  const raw = jqRows<string[]>(installedJson(env), (doc, push) => {
    for (const [key, value] of pluginEntries(doc, prefix)) {
      if (on[key] !== true) continue;
      for (const e of elements(value)) {
        push([
          key,
          field(index(e, 'scope'), 'user'),
          field(index(e, 'projectPath'), '-'),
          field(index(e, 'installPath'), '-'),
          field(index(e, 'version'), '-'),
        ].map(tsvEscape));
      }
    }
  });
  const ranked: { line: string; mkt: string; rank: number; row: DuplicateRow }[] = [];
  for (const [key, scope, proj, install, version] of raw) {
    let rank = 1;
    if (scope === 'project' || scope === 'local') {
      if (proj === '-' || canonicalDir(proj) !== here) continue;
      rank = 0;
    }
    const at = key.indexOf('@');
    const mkt = at < 0 ? key : key.slice(at + 1);
    ranked.push({
      line: [mkt, String(rank), version, install, scope].join('\t'),
      mkt,
      rank,
      row: { marketplace: mkt, version, install, scope },
    });
  }
  ranked.sort((a, b) => byteCompare(a.mkt, b.mkt) || a.rank - b.rank || byteCompare(a.line, b.line));
  const seen = new Set<string>();
  const rows = ranked.filter((r) => !seen.has(r.mkt) && seen.add(r.mkt)).map((r) => r.row);
  return rows.length > 1 ? rows : [];
}

/** tmb_duplicate_installs_names: "a@1.0.1, b@1.0.2". */
export function duplicateNames(rows: readonly DuplicateRow[]): string {
  return rows.map((r) => `${r.marketplace}@${r.version}`).join(', ');
}

/** tmb_duplicate_installs_disable_cmds: one `claude plugin disable` per copy, at its own scope. */
export function duplicateDisableCmds(rows: readonly DuplicateRow[], env: NodeJS.ProcessEnv = process.env): string {
  const name = installPluginName(env);
  return rows.map((r) => `claude plugin disable ${name}@${r.marketplace} --scope ${r.scope}`).join('; '); // cli-config-scope: printed
}

/** tmb_user_settings_json: the user-scope settings.json. */
export function userSettingsJson(env: NodeJS.ProcessEnv = process.env): string {
  return `${configDir(env)}/settings.json`;
}

/** tmb_legacy_user_hooks_doc. */
export const LEGACY_USER_HOOKS_DOC = 'docs/reference/UPGRADE.md#upgrading-into-v110--remove-leftover-user-wide-hooks';

export interface LegacyHook {
  line: string;
  name: string;
}

export interface LegacyProject {
  path: string;
  version: string;
}

export interface LegacyUserHooks {
  hooks: LegacyHook[];
  projects: LegacyProject[];
}

type JsonPath = (string | number)[];

const HOOK_NAME = /--hook[ \t]+([A-Za-z0-9._-]+)/;

function leftover(hook: Record<string, unknown>): boolean {
  return hook._tmb_managed === true || (typeof hook.command === 'string' && hook.command.includes('resolve-hook.sh'));
}

function hookName(command: unknown): string {
  if (typeof command !== 'string') return '?';
  const text = command.includes('resolve-hook.sh') ? (command.split('resolve-hook.sh')[1] ?? '') : command;
  return HOOK_NAME.exec(text)?.[1] ?? '?';
}

/** jq's `.hooks[ev][i].hooks[j]` leftover hook objects of one settings value, as paths. */
function leftoverPaths(doc: unknown): JsonPath[] {
  let hooks = index(doc, 'hooks');
  if (hooks === null || hooks === false) hooks = {};
  if (!isObject(hooks)) return [];
  const out: JsonPath[] = [];
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, i) => {
      if (!isObject(group)) return;
      const inner = group.hooks;
      if (!Array.isArray(inner)) return;
      inner.forEach((hook, j) => {
        if (isObject(hook) && leftover(hook)) out.push(['hooks', ev, i, 'hooks', j]);
      });
    });
  }
  return out;
}

/** jq's `paths | select(.[-1] == "command")`, in document order. */
function commandPaths(value: unknown, at: JsonPath = [], out: JsonPath[] = []): JsonPath[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => commandPaths(v, [...at, i], out));
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'command') out.push([...at, k]);
      commandPaths(v, [...at, k], out);
    }
  }
  return out;
}

function getPath(value: unknown, path: JsonPath): unknown {
  let v = value;
  for (const key of path) v = (v as Record<string | number, unknown>)[key];
  return v;
}

/** jq 1.7's `tonumber? // -1` over one version component ("nan" reads as null, so -1). */
function versionPart(text: string): number {
  const t = text.trim();
  if (/^[+-]?inf(inity)?$/i.test(t)) return t.startsWith('-') ? -Number.MAX_VALUE : Number.MAX_VALUE;
  return /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(t) ? Number(t) : -1;
}

/** jq's `(.version | split("-")[0] | split(".") | map(tonumber? // -1)) < [1, 1, 0]`. */
export function belowV110(version: string): boolean {
  const parts = (version.split('-')[0] ?? '').split('.').map(versionPart);
  const floor = [1, 1, 0];
  for (let i = 0; i < Math.min(parts.length, floor.length); i += 1) {
    if (parts[i] !== floor[i]) return parts[i] < floor[i];
  }
  return parts.length < floor.length;
}

function legacyHookRows(settings: string): LegacyHook[] | null {
  let text: string;
  try {
    text = readFileSync(settings, 'utf8');
  } catch {
    return null;
  }
  const stream = jsonStream(text);
  if (!stream.complete) return null;
  const want = new Map<number, string>();
  let n = 0;
  let orphans = 0;
  try {
    for (const doc of stream.values) {
      const left = leftoverPaths(doc);
      if (left.length === 0) continue;
      const keys = new Set(left.map((p) => JSON.stringify(p)));
      for (const path of commandPaths(doc)) {
        n += 1;
        const owner = path.slice(0, -1);
        if (keys.has(JSON.stringify(owner))) want.set(n, hookName((getPath(doc, owner) as Record<string, unknown>).command));
      }
      for (const p of left) if (!Object.hasOwn(getPath(doc, p) as object, 'command')) orphans += 1;
    }
  } catch (e) {
    if (e instanceof JqError) return null;
    throw e;
  }
  if (n === 0 && orphans === 0) return [];
  const rows: LegacyHook[] = [];
  let k = 0;
  text.split('\n').forEach((line, i) => {
    for (const _ of line.matchAll(/"command"[ \t]*:/g)) {
      k += 1;
      const name = want.get(k);
      if (name !== undefined) rows.push({ line: String(i + 1), name });
    }
  });
  for (let i = k + 1; i <= n; i += 1) {
    const name = want.get(i);
    if (name !== undefined) rows.push({ line: '?', name });
  }
  for (let i = 0; i < orphans; i += 1) rows.push({ line: '?', name: '?' });
  return rows;
}

/**
 * tmb_legacy_user_hooks [project]: the pre-1.1.0 TMB hook objects left in the
 * user-scope settings.json, and, when there are any, the other existing
 * projects whose recorded install of this plugin is below 1.1.0.
 */
export function legacyUserHooks(project: string, env: NodeJS.ProcessEnv = process.env): LegacyUserHooks {
  const none: LegacyUserHooks = { hooks: [], projects: [] };
  const hooks = legacyHookRows(userSettingsJson(env));
  if (hooks === null || hooks.length === 0) return none;
  const here = project === '' ? '' : canonicalDir(project);
  const prefix = `${installPluginName(env)}@`;
  const raw = jqRows<[string, string]>(installedJson(env), (doc, push) => {
    for (const [, value] of pluginEntries(doc, prefix)) {
      for (const e of elements(value)) {
        const p = index(e, 'projectPath');
        const v = index(e, 'version');
        if (typeof p !== 'string' || p === '' || typeof v !== 'string') continue;
        if (belowV110(v)) push([tsvEscape(p), tsvEscape(v)]);
      }
    }
  });
  const projects: LegacyProject[] = [];
  const seen = new Set<string>();
  for (const [p, v] of raw) {
    if (!isDir(p)) continue;
    const path = canonicalDir(p);
    if (path === here || seen.has(path)) continue;
    seen.add(path);
    projects.push({ path, version: v });
  }
  return { hooks, projects };
}

/** tmb_legacy_user_hooks_entries: "line 12 swe-scope-guard, line 20 bash-guard". */
export function legacyHookEntries(hooks: readonly LegacyHook[]): string {
  return hooks.map((h) => `line ${h.line} ${h.name}`).join(', ');
}

/** tmb_legacy_user_hooks_projects: "/a (1.0.2), /b (1.0.1)". */
export function legacyHookProjects(projects: readonly LegacyProject[]): string {
  return projects.map((p) => `${p.path} (${p.version})`).join(', ');
}

/**
 * tmb_active_install: the install every hook of this project runs. A
 * CLAUDE_PLUGIN_ROOT outside the plugins cache that no install names is
 * itself; else the newest project/local install for CLAUDE_PROJECT_DIR (two
 * of them: a stderr notice naming both), else the newest user install, else
 * CLAUDE_PLUGIN_ROOT.
 */
export function activeInstall(env: NodeJS.ProcessEnv = process.env, onStderr: (line: string) => void = () => {}): string {
  const self = env.CLAUDE_PLUGIN_ROOT ?? '';
  if (self !== '' && !/\/plugins\/cache\//.test(self) && !installCandidates(env).some((r) => r.install === self)) return self;
  const projects = projectInstalls(env);
  if (projects.length > 0) {
    if (projects.length > 1) {
      onStderr(`TMB: two project installs for ${env.CLAUDE_PROJECT_DIR ?? ''} — using ${projects[0].install} (newest), ignoring ${projects[1].install}\n`);
    }
    return projects[0].install;
  }
  return userInstalls(env)[0]?.install ?? self;
}
