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
import { join, dirname } from 'node:path';
import { serverLog } from '../logger.js';

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

const PLUGIN_ROOT_PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';

// A resolved command path is a prior TMB entry when it lives under a TMB plugin
// hooks dir — i.e. it contains both /tmb/ and /scripts/hooks/.
function isTmbHookCommand(command: string): boolean {
  return command.includes('/tmb/') && command.includes('/scripts/hooks/');
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

// Substitute ${CLAUDE_PLUGIN_ROOT} with the absolute plugin root in every
// command, producing fresh TMB-managed PreToolUse groups.
function buildTmbGroups(pre: HookGroup[], pluginRoot: string): HookGroup[] {
  return pre.map((group) => ({
    ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
    hooks: (group.hooks ?? []).map((h) => ({
      ...h,
      command: h.command.split(PLUGIN_ROOT_PLACEHOLDER).join(pluginRoot),
    })),
  }));
}

// Remove any existing PreToolUse hook command entries that resolve to a prior
// TMB hooks dir, dropping now-empty matcher groups. Non-TMB user entries are
// preserved untouched.
function purgeTmbEntries(pre: HookGroup[]): HookGroup[] {
  const cleaned: HookGroup[] = [];
  for (const group of pre) {
    const hooks = (group.hooks ?? []).filter(
      (h) => !(h.type === 'command' && typeof h.command === 'string' && isTmbHookCommand(h.command)),
    );
    if (hooks.length === 0) continue;
    cleaned.push({ ...group, hooks });
  }
  return cleaned;
}

export function writeHeadlessEnforcementShim(opts: {
  pluginRoot: string | null;
  homeDir: string;
}): { written: boolean; reason?: string } {
  const { pluginRoot, homeDir } = opts;

  if (!pluginRoot) {
    const reason = 'plugin root unresolvable';
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

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf8').trim();
      if (raw.length > 0) settings = JSON.parse(raw);
    } catch {
      const reason = 'existing settings.json is not valid JSON';
      serverLog({ event: 'onboard_hooks_shim_skip', reason });
      return { written: false, reason };
    }
  }

  const hooks: Record<string, unknown> =
    settings.hooks && typeof settings.hooks === 'object'
      ? (settings.hooks as Record<string, unknown>)
      : {};

  const existingPre: HookGroup[] = Array.isArray(hooks.PreToolUse)
    ? (hooks.PreToolUse as HookGroup[])
    : [];

  const preserved = purgeTmbEntries(existingPre);
  hooks.PreToolUse = [...preserved, ...tmbGroups];
  settings.hooks = hooks;

  try {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch (e) {
    const reason = `settings.json write failed: ${(e as Error).message}`;
    serverLog({ event: 'onboard_hooks_shim_skip', reason });
    return { written: false, reason };
  }

  serverLog({ event: 'onboard_hooks_shim_written', settingsPath, groups: tmbGroups.length });
  return { written: true };
}
