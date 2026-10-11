// Headless enforcement shim — opt-in at /onboard (`headless_enforcement: yes`).
//
// Marketplace plugin hooks do not fire in non-interactive `claude -p` runs;
// user settings.json hooks do. On opt-in, /onboard copies the plugin's
// deny-capable PreToolUse gates into ~/.claude/settings.json and materializes
// one stable resolver at ~/.claude/tmb-hooks/resolve-hook.sh (outside the
// versioned cache, so a plugin upgrade never orphans it). Each entry is:
//
//   bash <stable-resolver> --marketplace <mp> --hook <basename> --shim --project <root>
//
// stamped `_tmb_managed: true` and `_tmb_project: <root>`. The resolver
// discovers the active plugin version at fire time and execs the real gate —
// except in shim mode it exits 0 without running the gate when the session
// belongs to another project (CLAUDE_PROJECT_DIR != --project) or when the
// plugin's own hooks are active in this session (the plugin's SessionStart
// hook left <project>/.claude/<plugin>/sessions/<session_id>.plugin-hooks).
// Interactive sessions therefore run each gate once, from the plugin; headless
// runs get the shim.
//
// Answering `no` (or re-onboarding to `no`) purges this project's entries and
// removes ~/.claude/tmb-hooks/ once no remaining entry references it. Entries
// tagged for other projects are left alone.
//
// Only PreToolUse gates are copied; the other events are side-effecting and
// must run once, from the plugin.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { serverLog } from '../logger.js';

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
  homeDir: string;
  projectRoot: string;
}

export interface ShimWriteOptions extends ShimOptions {
  /** plugin_config.headless_enforcement — the shim is written only on 'yes'. */
  headlessEnforcement: string | null;
}

export interface ShimWriteResult {
  written: boolean;
  entries?: number;
  reason?: string;
}

export interface ShimRemoveResult {
  removed: number;
  resolver_removed: boolean;
  reason?: string;
}

// Stable resolver location (outside the versioned cache so it never orphans).
const STABLE_RESOLVER_DIR = ['.claude', 'tmb-hooks'];
const STABLE_RESOLVER_NAME = 'resolve-hook.sh';
const STABLE_RESOLVER_SIGNATURE = '/.claude/tmb-hooks/resolve-hook.sh';
// Canonical resolver authored in the plugin, relative to the plugin root.
const CANONICAL_RESOLVER_REL = ['scripts', 'lib', 'resolve-hook.sh'];

// Every TMB-managed hook entry is stamped with `_tmb_managed: true`. The
// idempotency purge keys on THIS field, never on a path substring: dev/worktree
// command paths (e.g. .claude/worktrees/X/scripts/hooks/...) contain no /tmb/
// segment, so a substring purge missed them and every re-run appended (the
// 543KB/2268-entry accumulation incident). CC ignores unknown hook-object keys.

// As a settings-hook chain, the FIRST hook in a matcher group that returns a
// decision short-circuits the rest. hooks.json lists advisory / allow-returning
// hooks ahead of the deny-capable gates (e.g. swe-brief-gate before
// no-source-edit-from-main in the Edit|Write group), so copied verbatim they
// would swallow the deny. We exclude these advisory hooks by script basename so
// the deny-capable enforcement gates run first (no-source-edit-from-main becomes
// first in its group). Keep all genuine deny gates: no-source-edit-from-main,
// swe-boundary, swe-scope-fence, git-guards, git-push-guard,
// no-worktree-branch-create, stay-on-base-guard, no-remote-auth-guard,
// agent-spawn-dispatch, swe-verification-gate, roundtable-auq-shape.
const ADVISORY_HOOK_DENYLIST = new Set([
  'swe-brief-gate.sh',
  'naming-lint.sh',
  'code-quality-lint.sh',
  'commit-msg-lint.sh',
  'askuserquestion-length-lint.sh',
  'branch-up-to-date-with-remote.sh',
  'debug-trajectory.sh',
]);

function basename(command: string): string {
  const parts = command.split('/');
  return parts[parts.length - 1] ?? command;
}

// Hook script basename without the .sh extension — the value passed to the
// resolver's --hook arg (it re-appends scripts/hooks/<name>.sh).
function hookName(command: string): string {
  return basename(command).replace(/\.sh$/, '');
}

// Single-quote a word for the hook command line unless it is already shell-safe.
function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// The marketplace of an installed plugin. CC installs land at
// <home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>; any other root
// (a repo checkout, a worktree, a /tmp copy, a --plugin-dir) is a dev context
// and yields null, as does an install under a different home than the one the
// shim would write — so a test or dev server never touches a real settings.json.
function installedMarketplace(pluginRoot: string, homeDir: string): string | null {
  const cacheRoot = join(homeDir, '.claude', 'plugins', 'cache');
  const rel = relative(cacheRoot, pluginRoot);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const segs = rel.split(sep).filter((seg) => seg.length > 0);
  if (segs.length !== 3) return null;
  return segs[0] ?? null;
}

function readPreToolUseFromHooksJson(pluginRoot: string): HookGroup[] | null {
  const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
  if (!existsSync(hooksJsonPath)) return null;
  let parsed: { hooks?: { PreToolUse?: HookGroup[] } };
  try {
    parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
  } catch {
    return null;
  }
  const pre = parsed.hooks?.PreToolUse;
  if (!Array.isArray(pre)) return null;
  return pre;
}

function keptHooks(group: HookGroup): HookCommand[] {
  return (group.hooks ?? []).filter((h) => !ADVISORY_HOOK_DENYLIST.has(basename(h.command)));
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
      command: `bash ${shellWord(resolverPath)} --marketplace ${shellWord(marketplace)} --hook ${hookName(h.command)} --shim --project ${shellWord(projectRoot)}`,
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
 * N quoted in the onboard question. 0 when hooks.json is unreadable.
 */
export function countShimEntries(pluginRoot: string | null): number {
  if (!pluginRoot) return 0;
  const pre = readPreToolUseFromHooksJson(pluginRoot);
  if (!pre) return 0;
  return pre.reduce((n, g) => n + keptHooks(g).length, 0);
}

// Materialize the stable resolver at ~/.claude/tmb-hooks/resolve-hook.sh from
// the canonical copy authored in the plugin. Idempotent: always (re)writes the
// current canonical contents and chmod +x. Returns the absolute resolver path,
// or null if the canonical copy is missing.
function materializeResolver(pluginRoot: string, homeDir: string): string | null {
  const canonical = join(pluginRoot, ...CANONICAL_RESOLVER_REL);
  if (!existsSync(canonical)) return null;
  const resolverDir = join(homeDir, ...STABLE_RESOLVER_DIR);
  const resolverPath = join(resolverDir, STABLE_RESOLVER_NAME);
  mkdirSync(resolverDir, { recursive: true });
  writeFileSync(resolverPath, readFileSync(canonical, 'utf8'));
  chmodSync(resolverPath, 0o755);
  return resolverPath;
}

// Recognize a TMB-managed PreToolUse entry. The `_tmb_managed` sentinel is the
// primary key; the command-string signatures are the legacy backstop for entries
// written before the sentinel existed (so an already-polluted settings.json
// self-heals on the next /onboard). The signatures are deliberately specific —
// the #661 incident showed a broad `/tmb/` substring purge produced
// false-NEGATIVES (missed worktree paths → accumulation), and a broad purge here
// would risk false-POSITIVES against genuine user hooks. A signature never
// matches a path lacking `/scripts/hooks/` unless it is the stable resolver path.
function isTmbEntry(h: HookCommand, tmbHookNames: Set<string>): boolean {
  // (a) sentinel — the primary key.
  if (h._tmb_managed === true) return true;
  const command = h.command ?? '';
  // (b) stable resolver path (the version-agnostic invocation, no sentinel).
  if (command.includes(STABLE_RESOLVER_SIGNATURE) || command.includes('/resolve-headless-hook.sh')) {
    return true;
  }
  // (c) version-pinned cache install path.
  if (
    command.includes('/plugins/cache/') &&
    command.includes('/tmb/') &&
    command.includes('/scripts/hooks/')
  ) {
    return true;
  }
  // (d) a TMB hook basename under a /scripts/hooks/ dir (e.g. dev/worktree path).
  if (command.includes('/scripts/hooks/') && tmbHookNames.has(hookName(command))) {
    return true;
  }
  return false;
}

// An entry this project owns: TMB-managed and either tagged for this project or
// untagged (a legacy user-global entry, owned by whichever project re-onboards).
function isOwnedEntry(h: HookCommand, tmbHookNames: Set<string>, projectRoot: string): boolean {
  if (!isTmbEntry(h, tmbHookNames)) return false;
  return h._tmb_project === undefined || h._tmb_project === projectRoot;
}

// Remove every entry this project owns, dropping now-empty matcher groups.
// Non-TMB user entries and other projects' tagged entries are preserved.
function purgeOwnedEntries(
  pre: HookGroup[],
  tmbHookNames: Set<string>,
  projectRoot: string,
): { kept: HookGroup[]; removed: number } {
  const kept: HookGroup[] = [];
  let removed = 0;
  for (const group of pre) {
    const hooks = (group.hooks ?? []).filter((h) => !isOwnedEntry(h, tmbHookNames, projectRoot));
    removed += (group.hooks ?? []).length - hooks.length;
    if (hooks.length === 0) continue;
    kept.push({ ...group, hooks });
  }
  return { kept, removed };
}

function tmbHookNamesFor(pre: HookGroup[]): Set<string> {
  return new Set(pre.flatMap((g) => (g.hooks ?? []).map((h) => hookName(h.command))));
}

// Shared guard: only a plugin installed in <homeDir>'s plugins cache manages
// that home's settings.json. Dev checkouts, worktree builds and test servers
// never touch it.
function installedPluginGuard(
  pluginRoot: string | null,
  homeDir: string,
): { pre: HookGroup[]; marketplace: string } | { reason: string } {
  if (!pluginRoot) return { reason: 'plugin root unresolvable' };
  const marketplace = installedMarketplace(pluginRoot, homeDir);
  if (!marketplace) return { reason: 'plugin-root-not-installed' };
  const pre = readPreToolUseFromHooksJson(pluginRoot);
  if (!pre) return { reason: 'hooks/hooks.json missing or has no PreToolUse' };
  return { pre, marketplace };
}

function settingsFile(homeDir: string): string {
  return join(homeDir, '.claude', 'settings.json');
}

type SettingsRead = { settings: Record<string, unknown>; exists: boolean } | { reason: string };

function readSettings(path: string): SettingsRead {
  if (!existsSync(path)) return { settings: {}, exists: false };
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return { settings: raw.length > 0 ? JSON.parse(raw) : {}, exists: true };
  } catch {
    return { reason: 'existing settings.json is not valid JSON' };
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
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    return null;
  } catch (e) {
    return `settings.json write failed: ${(e as Error).message}`;
  }
}

function skip<T extends object>(event: string, reason: string, result: T): T {
  serverLog({ event, reason });
  return result;
}

export function writeUserSettingsEnforcementShim(opts: ShimWriteOptions): ShimWriteResult {
  const { pluginRoot, homeDir, projectRoot } = opts;
  if (opts.headlessEnforcement !== 'yes') {
    const reason = 'headless_enforcement_off';
    return skip('onboard_hooks_shim_skip', reason, { written: false, reason });
  }
  const guard = installedPluginGuard(pluginRoot, homeDir);
  if ('reason' in guard) {
    return skip('onboard_hooks_shim_skip', guard.reason, { written: false, reason: guard.reason });
  }

  const resolverPath = materializeResolver(pluginRoot as string, homeDir);
  if (!resolverPath) {
    const reason = 'canonical resolver script missing';
    return skip('onboard_hooks_shim_skip', reason, { written: false, reason });
  }

  const path = settingsFile(homeDir);
  const read = readSettings(path);
  if ('reason' in read) {
    return skip('onboard_hooks_shim_skip', read.reason, { written: false, reason: read.reason });
  }

  const tmbGroups = buildTmbGroups(guard.pre, resolverPath, guard.marketplace, projectRoot);
  const { hooks, pre } = preToolUseOf(read.settings);
  const { kept } = purgeOwnedEntries(pre, tmbHookNamesFor(guard.pre), projectRoot);
  hooks.PreToolUse = [...kept, ...tmbGroups];
  read.settings.hooks = hooks;

  const failure = writeSettings(path, read.settings);
  if (failure) return skip('onboard_hooks_shim_skip', failure, { written: false, reason: failure });

  const entries = tmbGroups.reduce((n, g) => n + g.hooks.length, 0);
  serverLog({ event: 'onboard_hooks_shim_written', settingsPath: path, groups: tmbGroups.length, entries });
  return { written: true, entries };
}

function referencesResolver(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups as HookGroup[]) {
      if ((g.hooks ?? []).some((h) => (h.command ?? '').includes(STABLE_RESOLVER_SIGNATURE))) return true;
    }
  }
  return false;
}

/**
 * Purge this project's shim entries from ~/.claude/settings.json and remove
 * ~/.claude/tmb-hooks/ when nothing references it any more. settings.json is
 * left byte-identical when it holds no entry this project owns.
 */
export function removeUserSettingsEnforcementShim(opts: ShimOptions): ShimRemoveResult {
  const { pluginRoot, homeDir, projectRoot } = opts;
  const guard = installedPluginGuard(pluginRoot, homeDir);
  if ('reason' in guard) {
    return skip('onboard_hooks_shim_remove_skip', guard.reason, { removed: 0, resolver_removed: false, reason: guard.reason });
  }

  const path = settingsFile(homeDir);
  const read = readSettings(path);
  if ('reason' in read) {
    return skip('onboard_hooks_shim_remove_skip', read.reason, { removed: 0, resolver_removed: false, reason: read.reason });
  }

  let removed = 0;
  if (read.exists) {
    const { hooks, pre } = preToolUseOf(read.settings);
    const purge = purgeOwnedEntries(pre, tmbHookNamesFor(guard.pre), projectRoot);
    removed = purge.removed;
    if (removed > 0) {
      if (purge.kept.length > 0) hooks.PreToolUse = purge.kept;
      else delete hooks.PreToolUse;
      read.settings.hooks = hooks;
      const failure = writeSettings(path, read.settings);
      if (failure) {
        return skip('onboard_hooks_shim_remove_skip', failure, { removed: 0, resolver_removed: false, reason: failure });
      }
    }
  }

  const resolverDir = join(homeDir, ...STABLE_RESOLVER_DIR);
  let resolver_removed = false;
  if (existsSync(resolverDir) && !referencesResolver(read.settings)) {
    rmSync(resolverDir, { recursive: true, force: true });
    resolver_removed = true;
  }

  serverLog({ event: 'onboard_hooks_shim_removed', settingsPath: path, removed, resolver_removed });
  return { removed, resolver_removed };
}
