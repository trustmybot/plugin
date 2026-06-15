// Headless enforcement shim (#57). Marketplace-installed plugin hooks do NOT
// fire in headless `claude -p` (CC trust-dialog gap), so TMB's PreToolUse gates
// are absent for headless marketplace users. USER settings.json hooks DO fire
// headless. So /onboard writes the plugin's PreToolUse hooks into the user
// settings.json with the ${CLAUDE_PLUGIN_ROOT} placeholder resolved to an
// absolute path.
//
// Only PreToolUse entries are copied — PostToolUse/SessionStart/UserPromptSubmit/
// Stop/SubagentStop would double-fire when the plugin hooks also run
// interactively (e.g. duplicate audit events). PreToolUse gates are idempotent
// under double-fire.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { serverLog } from '../logger.js';
const PLUGIN_ROOT_PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';
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
// agent-spawn-dispatch, swe-verification-gate, auq-headless-deny,
// roundtable-auq-shape.
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
// (so deny gates run first), substitute ${CLAUDE_PLUGIN_ROOT} with the absolute
// plugin root, stamp every entry with the sentinel, and drop any matcher group
// left empty. hooks.json order is preserved within each matcher.
function buildTmbGroups(pre, pluginRoot) {
    const groups = [];
    for (const group of pre) {
        const hooks = (group.hooks ?? [])
            .filter((h) => !ADVISORY_HOOK_DENYLIST.has(basename(h.command)))
            .map((h) => ({
            type: h.type,
            command: h.command.split(PLUGIN_ROOT_PLACEHOLDER).join(pluginRoot),
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
export function writeHeadlessEnforcementShim(opts) {
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
    const tmbGroups = buildTmbGroups(pre, pluginRoot);
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