// Headless enforcement shim — opt-in at /onboard (`headless_enforcement: yes`).
//
// Marketplace plugin hooks do not fire in non-interactive `claude -p` runs;
// project settings hooks do. On opt-in, /onboard mirrors each PreToolUse
// router entry of the plugin's hooks.json (`node .../dist/hooks.js PreToolUse
// [part]`) into <project>/.claude/settings.local.json and materializes the
// resolver bundle at <project>/.claude/<plugin>/resolve-hook.mjs. Nothing is
// written outside the project. Each entry keeps its group's matcher, timeout
// and onFailure, and is:
//
//   node <project>/.claude/<plugin>/resolve-hook.mjs --marketplace <mp> --hook <Event> [--part <part>] --shim --project <root>
//
// stamped `_tmb_managed: true` and `_tmb_project: <root>`. The resolver
// discovers the active plugin version at fire time and runs its router,
// `node mcp/trajectory-server/dist/hooks.js <Event> [part] --shim`, which runs
// the group's gates as the plugin's own entry does — and exits 0 without
// running any when the session belongs to another project
// (CLAUDE_PROJECT_DIR != --project) or when the plugin's own hooks are active
// in this session (the plugin's SessionStart hook left
// <project>/.claude/<plugin>/sessions/<session_id>.plugin-hooks).
// Interactive sessions therefore run each gate once, from the plugin; headless
// runs get the shim.
//
// Every earlier managed entry, the per-gate `--hook <gate>` form and the
// `bash .../resolve-hook.sh` form included, is replaced on the next write, and
// the stale resolve-hook.sh copy is deleted. Answering `no` (or re-onboarding
// to `no`) purges the managed entries and both resolver copies. Only PreToolUse entries are
// copied; the other events are side-effecting and must run once, from the
// plugin.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serverLog } from '../logger.js';
import { ensureLocalSettingsIgnored } from './onboard-sandbox.js';
const RESOLVER_NAME = 'resolve-hook.mjs';
const LEGACY_RESOLVER_NAME = 'resolve-hook.sh';
// Canonical resolver bundle built in the plugin, relative to the plugin root.
const CANONICAL_RESOLVER_REL = ['mcp', 'trajectory-server', 'dist', RESOLVER_NAME];
const SETTINGS_REL = ['.claude', 'settings.local.json'];
// Every TMB-managed hook entry is stamped with `_tmb_managed: true`; the purge
// keys on that field (plus the resolver-invocation signature), never on a broad
// path substring. CC ignores unknown hook-object keys.
// Single-quote a word for the hook command line unless it is already shell-safe.
function shellWord(value) {
    if (/^[A-Za-z0-9_./:@%+=-]+$/.test(value))
        return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
// The marketplace of an installed plugin: CC installs land at
// .../plugins/cache/<marketplace>/<plugin>/<version>. Any other root (a repo
// checkout, a worktree, a /tmp copy, a --plugin-dir) is a dev context and
// yields null, so a dev or test server never writes the shim.
function installedMarketplace(pluginRoot) {
    const m = pluginRoot.match(/\/plugins\/cache\/([^/]+)\/[^/]+\/[^/]+\/?$/);
    return m?.[1] ?? null;
}
function pluginNameOf(pluginRoot) {
    try {
        const parsed = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
        if (typeof parsed.name === 'string' && /^[A-Za-z0-9_.-]+$/.test(parsed.name))
            return parsed.name;
    }
    catch {
        // fall through to the default name
    }
    return 'tmb';
}
const NO_PRE_TOOL_USE = 'hooks/hooks.json missing or has no PreToolUse';
const NO_ROUTER_ENTRY = 'hooks/hooks.json has no PreToolUse router entry';
// The router entry hooks.json registers, the placeholder quoted or not:
// `node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" <Event> [part]`.
const ROUTER_COMMAND = /^node ("?)\$\{CLAUDE_PLUGIN_ROOT\}\/mcp\/trajectory-server\/dist\/hooks\.js\1 ([A-Za-z]+)(?: ([a-z-]+))?$/;
// The PreToolUse router entries of hooks.json, by group in hooks.json order;
// any other command makes no shim entry. A reason when there is none, so no
// shim is written that enforces nothing.
function readPreToolUseFromHooksJson(pluginRoot) {
    const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
    if (!existsSync(hooksJsonPath))
        return { reason: NO_PRE_TOOL_USE };
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
    }
    catch {
        return { reason: NO_PRE_TOOL_USE };
    }
    const pre = parsed.hooks?.PreToolUse;
    if (!Array.isArray(pre))
        return { reason: NO_PRE_TOOL_USE };
    const groups = [];
    for (const group of pre) {
        const entries = [];
        for (const h of group.hooks ?? []) {
            const routed = ROUTER_COMMAND.exec(h.command ?? '');
            if (routed === null || routed[2] !== 'PreToolUse')
                continue;
            entries.push({
                event: routed[2],
                ...(routed[3] !== undefined ? { part: routed[3] } : {}),
                ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
                ...(h.onFailure !== undefined ? { onFailure: h.onFailure } : {}),
            });
        }
        if (entries.length > 0)
            groups.push({ ...(group.matcher !== undefined ? { matcher: group.matcher } : {}), entries });
    }
    return groups.length > 0 ? groups : { reason: NO_ROUTER_ENTRY };
}
// Build fresh TMB-managed PreToolUse groups: one project-tagged resolver
// invocation per router entry, with its group's matcher, its timeout and
// onFailure, stamped, in hooks.json order.
function buildTmbGroups(pre, resolverPath, marketplace, projectRoot) {
    return pre.map((group) => ({
        ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
        hooks: group.entries.map((e) => ({
            type: 'command',
            command: `node ${shellWord(resolverPath)} --marketplace ${shellWord(marketplace)} --hook ${e.event}${e.part !== undefined ? ` --part ${e.part}` : ''} --shim --project ${shellWord(projectRoot)}`,
            ...(e.timeout !== undefined ? { timeout: e.timeout } : {}),
            ...(e.onFailure !== undefined ? { onFailure: e.onFailure } : {}),
            _tmb_managed: true,
            _tmb_project: projectRoot,
        })),
    }));
}
/**
 * How many PreToolUse entries the shim would write for this plugin root — the
 * N quoted in the onboard question. 0 when hooks.json is unreadable or has no
 * PreToolUse router entry.
 */
export function countShimEntries(pluginRoot) {
    if (!pluginRoot)
        return 0;
    const pre = readPreToolUseFromHooksJson(pluginRoot);
    if ('reason' in pre)
        return 0;
    return pre.reduce((n, g) => n + g.entries.length, 0);
}
function resolverPathFor(projectRoot, pluginName, name = RESOLVER_NAME) {
    return join(projectRoot, '.claude', pluginName, name);
}
function removeFile(path) {
    if (!existsSync(path))
        return false;
    rmSync(path, { force: true });
    return true;
}
// Materialize the project resolver from the canonical copy authored in the
// plugin. Idempotent: always (re)writes the current canonical contents and
// chmod +x. Returns null if the canonical copy is missing.
function materializeResolver(pluginRoot, resolverPath) {
    const canonical = join(pluginRoot, ...CANONICAL_RESOLVER_REL);
    if (!existsSync(canonical))
        return null;
    mkdirSync(dirname(resolverPath), { recursive: true });
    writeFileSync(resolverPath, readFileSync(canonical, 'utf8'));
    chmodSync(resolverPath, 0o755);
    return resolverPath;
}
// Recognize a TMB-managed PreToolUse entry, in any form an earlier /onboard
// wrote (the per-gate `--hook <gate>` and `resolve-hook.sh` ones included):
// the `_tmb_managed` sentinel, or a resolver invocation written without it.
function isTmbEntry(h) {
    if (h._tmb_managed === true)
        return true;
    const command = h.command ?? '';
    return [RESOLVER_NAME, LEGACY_RESOLVER_NAME].some((name) => command.includes(`/${name} --marketplace `));
}
// Remove every TMB-managed entry, dropping now-empty matcher groups. Non-TMB
// user entries are preserved untouched.
function purgeTmbEntries(pre) {
    const kept = [];
    let removed = 0;
    for (const group of pre) {
        const hooks = (group.hooks ?? []).filter((h) => !isTmbEntry(h));
        removed += (group.hooks ?? []).length - hooks.length;
        if (hooks.length === 0)
            continue;
        kept.push({ ...group, hooks });
    }
    return { kept, removed };
}
// Shared guard: only an installed (plugins-cache) plugin manages the shim.
function installedPluginGuard(pluginRoot) {
    if (!pluginRoot)
        return { reason: 'plugin root unresolvable' };
    const marketplace = installedMarketplace(pluginRoot);
    if (!marketplace)
        return { reason: 'plugin-root-not-installed' };
    const pre = readPreToolUseFromHooksJson(pluginRoot);
    if ('reason' in pre)
        return { reason: pre.reason };
    return { root: pluginRoot, pre, marketplace, pluginName: pluginNameOf(pluginRoot) };
}
function settingsFile(projectRoot) {
    return join(projectRoot, ...SETTINGS_REL);
}
function readSettings(path) {
    if (!existsSync(path))
        return { settings: {}, exists: false };
    try {
        const raw = readFileSync(path, 'utf8').trim();
        return { settings: raw.length > 0 ? JSON.parse(raw) : {}, exists: true };
    }
    catch {
        return { reason: 'existing settings.local.json is not valid JSON' };
    }
}
function preToolUseOf(settings) {
    const hooks = settings.hooks && typeof settings.hooks === 'object'
        ? settings.hooks
        : {};
    const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
    return { hooks, pre };
}
function writeSettings(path, settings) {
    const created = !existsSync(path);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    }
    catch (e) {
        return `settings.local.json write failed: ${e.message}`;
    }
    if (created)
        ensureLocalSettingsIgnored(dirname(dirname(path)));
    return null;
}
function skip(event, reason, result) {
    serverLog({ event, reason });
    return result;
}
/**
 * Write this project's shim into <project>/.claude/settings.local.json —
 * only when headless enforcement is 'yes' and the plugin is an installed one.
 */
export function writeProjectEnforcementShim(opts) {
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
        const reason = 'canonical resolver bundle missing';
        return skip('onboard_hooks_shim_skip', reason, { written: false, reason });
    }
    const tmbGroups = buildTmbGroups(guard.pre, resolverPath, guard.marketplace, projectRoot);
    const { hooks, pre } = preToolUseOf(read.settings);
    hooks.PreToolUse = [...purgeTmbEntries(pre).kept, ...tmbGroups];
    read.settings.hooks = hooks;
    const failure = writeSettings(path, read.settings);
    if (failure)
        return skip('onboard_hooks_shim_skip', failure, { written: false, reason: failure });
    removeFile(resolverPathFor(projectRoot, guard.pluginName, LEGACY_RESOLVER_NAME));
    const entries = tmbGroups.reduce((n, g) => n + g.hooks.length, 0);
    serverLog({ event: 'onboard_hooks_shim_written', settingsPath: path, groups: tmbGroups.length, entries });
    return { written: true, entries, settings_path: path };
}
/**
 * Purge the managed entries from <project>/.claude/settings.local.json and
 * remove the project resolver, the legacy resolve-hook.sh copy included. The settings file is left byte-identical when
 * it holds no managed entry.
 */
export function removeProjectEnforcementShim(opts) {
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
            if (purge.kept.length > 0)
                hooks.PreToolUse = purge.kept;
            else
                delete hooks.PreToolUse;
            if (Object.keys(hooks).length > 0)
                read.settings.hooks = hooks;
            else
                delete read.settings.hooks;
            const failure = writeSettings(path, read.settings);
            if (failure) {
                return skip('onboard_hooks_shim_remove_skip', failure, { removed: 0, resolver_removed: false, reason: failure });
            }
        }
    }
    const name = pluginRoot ? pluginNameOf(pluginRoot) : 'tmb';
    const resolver_removed = [RESOLVER_NAME, LEGACY_RESOLVER_NAME]
        .map((file) => removeFile(resolverPathFor(projectRoot, name, file)))
        .includes(true);
    if (removed > 0 || resolver_removed) {
        serverLog({ event: 'onboard_hooks_shim_removed', settingsPath: path, removed, resolver_removed });
    }
    return { removed, resolver_removed };
}
//# sourceMappingURL=onboard-hooks-shim.js.map