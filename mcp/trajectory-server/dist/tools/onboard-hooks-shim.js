// User-settings enforcement shim (#57, #74/#680). Marketplace-installed plugin
// hooks do NOT fire in non-interactive `claude -p` runs (CC trust-dialog gap),
// so TMB's PreToolUse gates are absent for those marketplace users. USER
// settings.json hooks DO fire there. So /onboard writes the plugin's PreToolUse
// hooks into the user settings.json.
//
// Version-agnostic resolver (#74/#680): writing the ${CLAUDE_PLUGIN_ROOT}
// placeholder resolved to an absolute, version-PINNED cache path orphaned every
// entry on the next plugin upgrade or cache-clean (CC does not expand
// ${CLAUDE_PLUGIN_ROOT} in *user* settings.json hooks — only in plugin hooks).
// Instead onboard materializes ONE stable resolver script at
// ~/.claude/tmb-hooks/resolve-hook.sh (outside the versioned cache, so it never
// orphans) and writes version-agnostic commands:
//   bash <stable-resolver> --marketplace <mp> --hook <basename>
// The resolver discovers the active tmb version at hook-fire time and execs the
// real gate, forwarding stdin + argv untouched. A version bump no longer orphans
// the hooks.
//
// Only PreToolUse entries are copied — PostToolUse/SessionStart/UserPromptSubmit/
// Stop/SubagentStop would double-fire when the plugin hooks also run
// interactively (e.g. duplicate audit events). PreToolUse gates are idempotent
// under double-fire.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { serverLog } from '../logger.js';
// Stable resolver location (outside the versioned cache so it never orphans).
const STABLE_RESOLVER_DIR = ['.claude', 'tmb-hooks'];
const STABLE_RESOLVER_NAME = 'resolve-hook.sh';
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
function basename(command) {
    const parts = command.split('/');
    return parts[parts.length - 1] ?? command;
}
// Hook script basename without the .sh extension — the value passed to the
// resolver's --hook arg (it re-appends scripts/hooks/<name>.sh).
function hookName(command) {
    return basename(command).replace(/\.sh$/, '');
}
// Derive the marketplace name from the plugin root path. CC installs land at
// .../plugins/cache/<marketplace>/tmb/<version>, so the marketplace is the dir
// two segments above the version dir. Returns null when the path doesn't match
// (e.g. a non-cache install layout) so the caller can skip rather than guess.
function deriveMarketplace(pluginRoot) {
    const segs = pluginRoot.split('/').filter((s) => s.length > 0);
    const cacheIdx = segs.lastIndexOf('cache');
    if (cacheIdx === -1 || cacheIdx + 1 >= segs.length)
        return null;
    const mp = segs[cacheIdx + 1];
    return mp && mp.length > 0 ? mp : null;
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
// Build fresh TMB-managed PreToolUse groups: drop advisory/allow-returning hooks
// (so deny gates run first), rewrite each kept command to a version-agnostic
// resolver invocation (`bash <stable-resolver> --marketplace <mp> --hook
// <basename>`), stamp every entry with the sentinel, and drop any matcher group
// left empty. hooks.json order is preserved within each matcher.
function buildTmbGroups(pre, resolverPath, marketplace) {
    const groups = [];
    for (const group of pre) {
        const hooks = (group.hooks ?? [])
            .filter((h) => !ADVISORY_HOOK_DENYLIST.has(basename(h.command)))
            .map((h) => ({
            type: h.type,
            command: `bash ${resolverPath} --marketplace ${marketplace} --hook ${hookName(h.command)}`,
            ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
            _tmb_managed: true,
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
// Materialize the stable resolver at ~/.claude/tmb-hooks/resolve-hook.sh from
// the canonical copy authored in the plugin. Idempotent: always (re)writes the
// current canonical contents and chmod +x. Returns the absolute resolver path,
// or null if the canonical copy is missing.
function materializeResolver(pluginRoot, homeDir) {
    const canonical = join(pluginRoot, ...CANONICAL_RESOLVER_REL);
    if (!existsSync(canonical))
        return null;
    const resolverDir = join(homeDir, ...STABLE_RESOLVER_DIR);
    const resolverPath = join(resolverDir, STABLE_RESOLVER_NAME);
    mkdirSync(resolverDir, { recursive: true });
    writeFileSync(resolverPath, readFileSync(canonical, 'utf8'));
    chmodSync(resolverPath, 0o755);
    return resolverPath;
}
// Remove every prior TMB-managed entry by sentinel, dropping now-empty matcher
// groups. Non-TMB user entries are preserved untouched.
function purgeTmbEntries(pre) {
    const cleaned = [];
    for (const group of pre) {
        const hooks = (group.hooks ?? []).filter((h) => h._tmb_managed !== true);
        if (hooks.length === 0)
            continue;
        cleaned.push({ ...group, hooks });
    }
    return cleaned;
}
export function writeUserSettingsEnforcementShim(opts) {
    const { pluginRoot, homeDir } = opts;
    if (!pluginRoot) {
        const reason = 'plugin root unresolvable';
        serverLog({ event: 'onboard_hooks_shim_skip', reason });
        return { written: false, reason };
    }
    // Never write the real ~/.claude/settings.json from a dev/worktree context.
    // A plugin root under .claude/worktrees/ means we're running an SWE worktree
    // build, not a real install; writing there polluted the dev box's settings
    // (the 2268-entry incident). Skip — onboard still reports ok.
    if (pluginRoot.includes('/.claude/worktrees/')) {
        const reason = 'plugin-root-in-worktree';
        serverLog({ event: 'onboard_hooks_shim_skip', reason });
        return { written: false, reason };
    }
    const pre = readPreToolUseFromHooksJson(pluginRoot);
    if (!pre) {
        const reason = 'hooks/hooks.json missing or has no PreToolUse';
        serverLog({ event: 'onboard_hooks_shim_skip', reason });
        return { written: false, reason };
    }
    const marketplace = deriveMarketplace(pluginRoot);
    if (!marketplace) {
        const reason = 'cannot derive marketplace from plugin root';
        serverLog({ event: 'onboard_hooks_shim_skip', reason });
        return { written: false, reason };
    }
    const resolverPath = materializeResolver(pluginRoot, homeDir);
    if (!resolverPath) {
        const reason = 'canonical resolver script missing';
        serverLog({ event: 'onboard_hooks_shim_skip', reason });
        return { written: false, reason };
    }
    const tmbGroups = buildTmbGroups(pre, resolverPath, marketplace);
    const settingsDir = join(homeDir, '.claude');
    const settingsPath = join(settingsDir, 'settings.json');
    let settings = {};
    if (existsSync(settingsPath)) {
        try {
            const raw = readFileSync(settingsPath, 'utf8').trim();
            if (raw.length > 0)
                settings = JSON.parse(raw);
        }
        catch {
            const reason = 'existing settings.json is not valid JSON';
            serverLog({ event: 'onboard_hooks_shim_skip', reason });
            return { written: false, reason };
        }
    }
    const hooks = settings.hooks && typeof settings.hooks === 'object'
        ? settings.hooks
        : {};
    const existingPre = Array.isArray(hooks.PreToolUse)
        ? hooks.PreToolUse
        : [];
    const preserved = purgeTmbEntries(existingPre);
    hooks.PreToolUse = [...preserved, ...tmbGroups];
    settings.hooks = hooks;
    try {
        mkdirSync(settingsDir, { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
    catch (e) {
        const reason = `settings.json write failed: ${e.message}`;
        serverLog({ event: 'onboard_hooks_shim_skip', reason });
        return { written: false, reason };
    }
    serverLog({ event: 'onboard_hooks_shim_written', settingsPath, groups: tmbGroups.length });
    return { written: true };
}
//# sourceMappingURL=onboard-hooks-shim.js.map