// Headless enforcement shim — opt-in at /onboard (`headless_enforcement: yes`).
//
// Marketplace plugin hooks do not fire in non-interactive `claude -p` runs;
// project settings hooks do. On opt-in, /onboard copies the plugin's
// deny-capable PreToolUse gates into <project>/.claude/settings.local.json and
// materializes the resolver at <project>/.claude/<plugin>/resolve-hook.sh.
// Nothing is written outside the project. Each entry is:
//
//   bash <project>/.claude/<plugin>/resolve-hook.sh --marketplace <mp> --hook <gate> --shim --project <root>
//
// stamped `_tmb_managed: true` and `_tmb_project: <root>`, where <gate> is the
// argument of the hooks.json command `dispatch.sh <gate>`. The resolver
// discovers the active plugin version at fire time and execs its
// `scripts/hooks/dispatch.sh <gate> --shim`, which runs the gate once per
// event — and exits 0 without running it when the session belongs to another
// project (CLAUDE_PROJECT_DIR != --project) or when the plugin's own hooks are
// active in this session (the plugin's SessionStart hook left
// <project>/.claude/<plugin>/sessions/<session_id>.plugin-hooks).
// Interactive sessions therefore run each gate once, from the plugin; headless
// runs get the shim.
//
// Answering `no` (or re-onboarding to `no`) purges the managed entries and the
// project resolver. Only PreToolUse gates are copied; the other events are
// side-effecting and must run once, from the plugin.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { matcherOfColumn } from '../hooks/router/table.js';
import { serverLog } from '../logger.js';
import { ensureLocalSettingsIgnored } from './onboard-sandbox.js';

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  _tmb_managed?: boolean;
  _tmb_project?: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface ShimOptions {
  pluginRoot: string | null;
  projectRoot: string;
}

export interface ShimWriteOptions extends ShimOptions {
  /** plugin_config.headless_enforcement — the shim is written only on 'yes'. */
  headlessEnforcement: string | null;
}

export interface ShimWriteResult {
  written: boolean;
  entries?: number;
  settings_path?: string;
  reason?: string;
}

export interface ShimRemoveResult {
  removed: number;
  resolver_removed: boolean;
  reason?: string;
}

const RESOLVER_NAME = 'resolve-hook.sh';
// Canonical resolver authored in the plugin, relative to the plugin root.
const CANONICAL_RESOLVER_REL = ['scripts', 'lib', RESOLVER_NAME];
const SETTINGS_REL = ['.claude', 'settings.local.json'];

// Every TMB-managed hook entry is stamped with `_tmb_managed: true`; the purge
// keys on that field (plus the resolver-invocation signature), never on a broad
// path substring. CC ignores unknown hook-object keys.

// As a settings-hook chain, the FIRST hook in a matcher group that returns a
// decision short-circuits the rest. hooks.json lists advisory / allow-returning
// hooks ahead of the deny-capable gates (e.g. swe-brief-gate before
// no-source-edit-from-main in the Edit|Write group), so copied verbatim they
// would swallow the deny. We exclude these advisory hooks by gate name so
// the deny-capable enforcement gates run first (no-source-edit-from-main becomes
// first in its group). Keep all genuine deny gates: no-source-edit-from-main,
// swe-boundary, git-guards, git-push-guard,
// no-worktree-branch-create, stay-on-base-guard, no-remote-auth-guard,
// agent-spawn-dispatch, swe-resume-gate, roundtable-auq-shape, and the
// trajectory-gates chain, which runs swe-brief-gate and swe-verification-gate
// in its own order.
const ADVISORY_HOOK_DENYLIST = new Set([
  'swe-brief-gate',
  'naming-lint',
  'code-quality-lint',
  'commit-msg-lint',
  'askuserquestion-length-lint',
  'branch-up-to-date-with-remote',
  'debug-trajectory',
]);

// The gate a hooks.json command runs — the value passed to the resolver's
// --hook arg. hooks.json registers `"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" <gate>`
// (the unquoted form maps alike); a direct `.../scripts/hooks/<gate>.sh`
// command maps to the same gate.
function gateName(command: string): string {
  const dispatched = command.match(/\/dispatch\.sh"?\s+([a-z0-9-]+)\s*$/);
  if (dispatched?.[1]) return dispatched[1];
  const parts = command.trim().split('/');
  return (parts[parts.length - 1] ?? command).replace(/\.sh$/, '');
}

// Single-quote a word for the hook command line unless it is already shell-safe.
function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// The marketplace of an installed plugin: CC installs land at
// .../plugins/cache/<marketplace>/<plugin>/<version>. Any other root (a repo
// checkout, a worktree, a /tmp copy, a --plugin-dir) is a dev context and
// yields null, so a dev or test server never writes the shim.
function installedMarketplace(pluginRoot: string): string | null {
  const m = pluginRoot.match(/\/plugins\/cache\/([^/]+)\/[^/]+\/[^/]+\/?$/);
  return m?.[1] ?? null;
}

function pluginNameOf(pluginRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (typeof parsed.name === 'string' && /^[A-Za-z0-9_.-]+$/.test(parsed.name)) return parsed.name;
  } catch {
    // fall through to the default name
  }
  return 'tmb';
}

const NO_PRE_TOOL_USE = 'hooks/hooks.json missing or has no PreToolUse';

function readPreToolUseFromHooksJson(pluginRoot: string): HookGroup[] | { reason: string } {
  const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
  if (!existsSync(hooksJsonPath)) return { reason: NO_PRE_TOOL_USE };
  let parsed: { hooks?: { PreToolUse?: HookGroup[] } };
  try {
    parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
  } catch {
    return { reason: NO_PRE_TOOL_USE };
  }
  const pre = parsed.hooks?.PreToolUse;
  if (!Array.isArray(pre)) return { reason: NO_PRE_TOOL_USE };
  const groups: HookGroup[] = [];
  for (const group of pre) {
    const hooks: HookCommand[] = [];
    for (const h of group.hooks ?? []) {
      const gates = routerGateHooks(pluginRoot, group.matcher ?? '', h);
      if (gates !== null && 'reason' in gates) return gates;
      hooks.push(...(gates ?? [h]));
    }
    groups.push({ ...group, hooks });
  }
  return groups;
}

const ROUTER_COMMAND = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/mcp\/trajectory-server\/dist\/hooks\.js" ([A-Za-z]+)$/;

// The chain a router group's tool-filtered gates run through outside the
// router: the shim's separate entries could not keep their order or filter.
const GROUP_CHAIN: Readonly<Record<string, string>> = { 'mcp__.*trajectory-server__.*': 'trajectory-gates' };

// A router entry (GH 1692) as one `dispatch.sh <gate>` entry per gate
// dist/hooks-router.txt lists for its event and matcher, timed out at the
// gate's budget, so the shim runs each gate as it ran before the router; a
// group with a chain as one `dispatch.sh <chain>` entry, timed out at its
// gates in sequence (every unfiltered one plus the largest filtered one). Null
// for any other entry, and a reason when the manifest is unreadable or lists
// no gate for the group, so no shim is written without the router's gates.
function routerGateHooks(pluginRoot: string, matcher: string, h: HookCommand): HookCommand[] | { reason: string } | null {
  const event = ROUTER_COMMAND.exec(h.command ?? '')?.[1];
  if (event === undefined) return null;
  let manifest: string;
  try {
    manifest = readFileSync(join(pluginRoot, 'mcp', 'trajectory-server', 'dist', 'hooks-router.txt'), 'utf8');
  } catch {
    return { reason: 'dist/hooks-router.txt missing or unreadable' };
  }
  const rows = manifest
    .split('\n')
    .map((line) => line.split(' '))
    .filter((f) => f.length >= 5 && f[3] === event && matcherOfColumn(f[4]) === matcher && /^[a-z0-9-]+$/.test(f[0]));
  if (rows.length === 0) return { reason: `dist/hooks-router.txt lists no gate for ${event} ${matcher}` };
  const dispatched = (name: string, budgetMs: number): HookCommand => ({ type: 'command', command: `"\${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" ${name}`, timeout: Math.ceil(budgetMs / 1000) });
  const chain = event === 'PreToolUse' ? GROUP_CHAIN[matcher] : undefined;
  if (chain === undefined) return rows.map(([gate, budgetMs]) => dispatched(gate, Number(budgetMs)));
  const filtered = (f: string[]): boolean => (f[5] ?? '*') !== '*';
  const unfilteredMs = rows.filter((f) => !filtered(f)).reduce((n, f) => n + Number(f[1]), 0);
  const largestFilteredMs = Math.max(0, ...rows.filter(filtered).map((f) => Number(f[1])));
  return [dispatched(chain, unfilteredMs + largestFilteredMs)];
}

function keptHooks(group: HookGroup): HookCommand[] {
  return (group.hooks ?? []).filter((h) => !ADVISORY_HOOK_DENYLIST.has(gateName(h.command)));
}

// Build fresh TMB-managed PreToolUse groups: drop advisory/allow-returning hooks
// (so deny gates run first), rewrite each kept command to a project-tagged shim
// resolver invocation, stamp every entry, and drop any matcher group left
// empty. hooks.json order is preserved within each matcher.
function buildTmbGroups(
  pre: HookGroup[],
  resolverPath: string,
  marketplace: string,
  projectRoot: string,
): HookGroup[] {
  const groups: HookGroup[] = [];
  for (const group of pre) {
    const hooks = keptHooks(group).map((h) => ({
      type: h.type,
      command: `bash ${shellWord(resolverPath)} --marketplace ${shellWord(marketplace)} --hook ${gateName(h.command)} --shim --project ${shellWord(projectRoot)}`,
      ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
      _tmb_managed: true,
      _tmb_project: projectRoot,
    }));
    if (hooks.length === 0) continue;
    groups.push({
      ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
      hooks,
    });
  }
  return groups;
}

/**
 * How many PreToolUse entries the shim would write for this plugin root — the
 * N quoted in the onboard question. 0 when hooks.json, or the router manifest it needs, is unreadable.
 */
export function countShimEntries(pluginRoot: string | null): number {
  if (!pluginRoot) return 0;
  const pre = readPreToolUseFromHooksJson(pluginRoot);
  if ('reason' in pre) return 0;
  return pre.reduce((n, g) => n + keptHooks(g).length, 0);
}

function resolverPathFor(projectRoot: string, pluginName: string): string {
  return join(projectRoot, '.claude', pluginName, RESOLVER_NAME);
}

// Materialize the project resolver from the canonical copy authored in the
// plugin. Idempotent: always (re)writes the current canonical contents and
// chmod +x. Returns null if the canonical copy is missing.
function materializeResolver(pluginRoot: string, resolverPath: string): string | null {
  const canonical = join(pluginRoot, ...CANONICAL_RESOLVER_REL);
  if (!existsSync(canonical)) return null;
  mkdirSync(dirname(resolverPath), { recursive: true });
  writeFileSync(resolverPath, readFileSync(canonical, 'utf8'));
  chmodSync(resolverPath, 0o755);
  return resolverPath;
}

// Recognize a TMB-managed PreToolUse entry: the `_tmb_managed` sentinel, or a
// resolver invocation written without it.
function isTmbEntry(h: HookCommand): boolean {
  if (h._tmb_managed === true) return true;
  const command = h.command ?? '';
  return command.includes(`/${RESOLVER_NAME} --marketplace `);
}

// Remove every TMB-managed entry, dropping now-empty matcher groups. Non-TMB
// user entries are preserved untouched.
function purgeTmbEntries(pre: HookGroup[]): { kept: HookGroup[]; removed: number } {
  const kept: HookGroup[] = [];
  let removed = 0;
  for (const group of pre) {
    const hooks = (group.hooks ?? []).filter((h) => !isTmbEntry(h));
    removed += (group.hooks ?? []).length - hooks.length;
    if (hooks.length === 0) continue;
    kept.push({ ...group, hooks });
  }
  return { kept, removed };
}

// Shared guard: only an installed (plugins-cache) plugin manages the shim.
function installedPluginGuard(
  pluginRoot: string | null,
): { root: string; pre: HookGroup[]; marketplace: string; pluginName: string } | { reason: string } {
  if (!pluginRoot) return { reason: 'plugin root unresolvable' };
  const marketplace = installedMarketplace(pluginRoot);
  if (!marketplace) return { reason: 'plugin-root-not-installed' };
  const pre = readPreToolUseFromHooksJson(pluginRoot);
  if ('reason' in pre) return { reason: pre.reason };
  return { root: pluginRoot, pre, marketplace, pluginName: pluginNameOf(pluginRoot) };
}

function settingsFile(projectRoot: string): string {
  return join(projectRoot, ...SETTINGS_REL);
}

type SettingsRead = { settings: Record<string, unknown>; exists: boolean } | { reason: string };

function readSettings(path: string): SettingsRead {
  if (!existsSync(path)) return { settings: {}, exists: false };
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return { settings: raw.length > 0 ? JSON.parse(raw) : {}, exists: true };
  } catch {
    return { reason: 'existing settings.local.json is not valid JSON' };
  }
}

function preToolUseOf(settings: Record<string, unknown>): { hooks: Record<string, unknown>; pre: HookGroup[] } {
  const hooks: Record<string, unknown> =
    settings.hooks && typeof settings.hooks === 'object'
      ? (settings.hooks as Record<string, unknown>)
      : {};
  const pre: HookGroup[] = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as HookGroup[]) : [];
  return { hooks, pre };
}

function writeSettings(path: string, settings: Record<string, unknown>): string | null {
  const created = !existsSync(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  } catch (e) {
    return `settings.local.json write failed: ${(e as Error).message}`;
  }
  if (created) ensureLocalSettingsIgnored(dirname(dirname(path)));
  return null;
}

function skip<T extends object>(event: string, reason: string, result: T): T {
  serverLog({ event, reason });
  return result;
}

/**
 * Write this project's shim into <project>/.claude/settings.local.json —
 * only when headless enforcement is 'yes' and the plugin is an installed one.
 */
export function writeProjectEnforcementShim(opts: ShimWriteOptions): ShimWriteResult {
  const { pluginRoot, projectRoot } = opts;
  if (opts.headlessEnforcement !== 'yes') {
    const reason = 'headless_enforcement_off';
    return skip('onboard_hooks_shim_skip', reason, { written: false, reason });
  }
  const guard = installedPluginGuard(pluginRoot);
  if ('reason' in guard) {
    return skip('onboard_hooks_shim_skip', guard.reason, { written: false, reason: guard.reason });
  }

  const path = settingsFile(projectRoot);
  const read = readSettings(path);
  if ('reason' in read) {
    return skip('onboard_hooks_shim_skip', read.reason, { written: false, reason: read.reason });
  }

  const resolverPath = materializeResolver(guard.root, resolverPathFor(projectRoot, guard.pluginName));
  if (!resolverPath) {
    const reason = 'canonical resolver script missing';
    return skip('onboard_hooks_shim_skip', reason, { written: false, reason });
  }

  const tmbGroups = buildTmbGroups(guard.pre, resolverPath, guard.marketplace, projectRoot);
  const { hooks, pre } = preToolUseOf(read.settings);
  hooks.PreToolUse = [...purgeTmbEntries(pre).kept, ...tmbGroups];
  read.settings.hooks = hooks;

  const failure = writeSettings(path, read.settings);
  if (failure) return skip('onboard_hooks_shim_skip', failure, { written: false, reason: failure });

  const entries = tmbGroups.reduce((n, g) => n + g.hooks.length, 0);
  serverLog({ event: 'onboard_hooks_shim_written', settingsPath: path, groups: tmbGroups.length, entries });
  return { written: true, entries, settings_path: path };
}

/**
 * Purge the managed entries from <project>/.claude/settings.local.json and
 * remove the project resolver. The settings file is left byte-identical when
 * it holds no managed entry.
 */
export function removeProjectEnforcementShim(opts: ShimOptions): ShimRemoveResult {
  const { pluginRoot, projectRoot } = opts;
  const path = settingsFile(projectRoot);
  const read = readSettings(path);
  if ('reason' in read) {
    return skip('onboard_hooks_shim_remove_skip', read.reason, { removed: 0, resolver_removed: false, reason: read.reason });
  }

  let removed = 0;
  if (read.exists) {
    const { hooks, pre } = preToolUseOf(read.settings);
    const purge = purgeTmbEntries(pre);
    removed = purge.removed;
    if (removed > 0) {
      if (purge.kept.length > 0) hooks.PreToolUse = purge.kept;
      else delete hooks.PreToolUse;
      if (Object.keys(hooks).length > 0) read.settings.hooks = hooks;
      else delete read.settings.hooks;
      const failure = writeSettings(path, read.settings);
      if (failure) {
        return skip('onboard_hooks_shim_remove_skip', failure, { removed: 0, resolver_removed: false, reason: failure });
      }
    }
  }

  const resolverPath = resolverPathFor(projectRoot, pluginRoot ? pluginNameOf(pluginRoot) : 'tmb');
  let resolver_removed = false;
  if (existsSync(resolverPath)) {
    rmSync(resolverPath, { force: true });
    resolver_removed = true;
  }

  if (removed > 0 || resolver_removed) {
    serverLog({ event: 'onboard_hooks_shim_removed', settingsPath: path, removed, resolver_removed });
  }
  return { removed, resolver_removed };
}
