// Headless enforcement shim — opt-in at /onboard (`headless_enforcement: yes`).
//
// Marketplace plugin hooks do not fire in non-interactive `claude -p` runs;
// project settings hooks do. On opt-in, /onboard copies the plugin's
// deny-capable PreToolUse gates into <project>/.claude/settings.local.json and
// materializes the resolver at <project>/.claude/<plugin>/resolve-hook.sh.
// Nothing is written outside the project. Each entry is:
//
//   bash <project>/.claude/<plugin>/resolve-hook.sh --marketplace <mp> --hook <basename> --shim --project <root>
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
// Answering `no` (or re-onboarding to `no`) purges the managed entries and the
// project resolver. Only PreToolUse gates are copied; the other events are
// side-effecting and must run once, from the plugin.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serverLog } from '../logger.js';
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
function basename(command) {
    const parts = command.split('/');
    return parts[parts.length - 1] ?? command;
}
// Hook script basename without the .sh extension — the value passed to the
// resolver's --hook arg (it re-appends scripts/hooks/<name>.sh).
function hookName(command) {
    return basename(command).replace(/\.sh$/, '');
}
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
function readPreToolUseFromHooksJson(pluginRoot) {
    const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
    if (!existsSync(hooksJsonPath))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
    }
    catch {
        return null;
    }
    const pre = parsed.hooks?.PreToolUse;
    if (!Array.isArray(pre))
        return null;
    return pre;
}
function keptHooks(group) {
    return (group.hooks ?? []).filter((h) => !ADVISORY_HOOK_DENYLIST.has(basename(h.command)));
}
// Build fresh TMB-managed PreToolUse groups: drop advisory/allow-returning hooks
// (so deny gates run first), rewrite each kept command to a project-tagged shim
// resolver invocation, stamp every entry, and drop any matcher group left
// empty. hooks.json order is preserved within each matcher.
function buildTmbGroups(pre, resolverPath, marketplace, projectRoot) {
    const groups = [];
    for (const group of pre) {
        const hooks = keptHooks(group).map((h) => ({
            type: h.type,
            command: `bash ${shellWord(resolverPath)} --marketplace ${shellWord(marketplace)} --hook ${hookName(h.command)} --shim --project ${shellWord(projectRoot)}`,
            ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
            _tmb_managed: true,
            _tmb_project: projectRoot,
        }));
        if (hooks.length === 0)
            continue;
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
export function countShimEntries(pluginRoot) {
    if (!pluginRoot)
        return 0;
    const pre = readPreToolUseFromHooksJson(pluginRoot);
    if (!pre)
        return 0;
    return pre.reduce((n, g) => n + keptHooks(g).length, 0);
}
function resolverPathFor(projectRoot, pluginName) {
    return join(projectRoot, '.claude', pluginName, RESOLVER_NAME);
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
// Recognize a TMB-managed PreToolUse entry: the `_tmb_managed` sentinel, or a
// resolver invocation written without it.
function isTmbEntry(h) {
    if (h._tmb_managed === true)
        return true;
    const command = h.command ?? '';
    return command.includes(`/${RESOLVER_NAME} --marketplace `);
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
    if (!pre)
        return { reason: 'hooks/hooks.json missing or has no PreToolUse' };
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
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
        return null;
    }
    catch (e) {
        return `settings.local.json write failed: ${e.message}`;
    }
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
        const reason = 'canonical resolver script missing';
        return skip('onboard_hooks_shim_skip', reason, { written: false, reason });
    }
    const tmbGroups = buildTmbGroups(guard.pre, resolverPath, guard.marketplace, projectRoot);
    const { hooks, pre } = preToolUseOf(read.settings);
    hooks.PreToolUse = [...purgeTmbEntries(pre).kept, ...tmbGroups];
    read.settings.hooks = hooks;
    const failure = writeSettings(path, read.settings);
    if (failure)
        return skip('onboard_hooks_shim_skip', failure, { written: false, reason: failure });
    const entries = tmbGroups.reduce((n, g) => n + g.hooks.length, 0);
    serverLog({ event: 'onboard_hooks_shim_written', settingsPath: path, groups: tmbGroups.length, entries });
    return { written: true, entries, settings_path: path };
}
/**
 * Purge the managed entries from <project>/.claude/settings.local.json and
 * remove the project resolver. The settings file is left byte-identical when
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
//# sourceMappingURL=onboard-hooks-shim.js.map