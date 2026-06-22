import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeUserSettingsEnforcementShim } from '../tools/onboard-hooks-shim.js';

// A hooks.json mirroring the real plugin's PreToolUse shape: each deny-capable
// gate is preceded by advisory/allow-returning hooks that must be excluded so
// the deny gate runs first. Plus a PostToolUse + SessionStart that must NOT be
// copied into settings.json.
const HOOKS_JSON = {
  hooks: {
    SessionStart: [
      { matcher: '', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start-prescan.sh', timeout: 5 }] },
    ],
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/git-guards.sh', timeout: 10 },
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/git-push-guard.sh', timeout: 10 },
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/swe-boundary.sh', timeout: 5 },
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/branch-up-to-date-with-remote.sh', timeout: 10 },
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/commit-msg-lint.sh', timeout: 5 },
        ],
      },
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/swe-brief-gate.sh', timeout: 5 },
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/no-source-edit-from-main.sh', timeout: 5 },
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/swe-boundary.sh', timeout: 5 },
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/swe-scope-fence.sh', timeout: 5 },
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/naming-lint.sh', timeout: 5 },
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/code-quality-lint.sh', timeout: 5 },
        ],
      },
      {
        matcher: 'mcp__.*trajectory-server__.*',
        hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/swe-brief-gate.sh', timeout: 5 }],
      },
      {
        matcher: 'mcp__.*trajectory-server__task_update_status',
        hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/swe-verification-gate.sh', timeout: 260 }],
      },
      {
        matcher: 'Bash|Read|Write|Edit|MultiEdit|Agent|Skill',
        hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/debug-trajectory.sh', timeout: 5 }],
      },
    ],
    PostToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/attribution-footer.sh', timeout: 15 }] },
    ],
  },
};

interface HookCmd {
  type: string;
  command: string;
  timeout?: number;
  _tmb_managed?: boolean;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCmd[];
}

describe('writeUserSettingsEnforcementShim', () => {
  let pluginRoot: string;
  let homeDir: string;
  let base: string;

  const MARKETPLACE = 'trustmybot';

  // A realistic install layout: .../plugins/cache/<marketplace>/tmb/<version>.
  // The marketplace is derived from this path; the canonical resolver must exist
  // under the plugin root so onboard can materialize it.
  function makePluginRoot(base: string): string {
    const root = join(base, 'cache', MARKETPLACE, 'tmb', '0.0.0');
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tmb' }));
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify(HOOKS_JSON));
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'lib', 'resolve-hook.sh'), '#!/usr/bin/env bash\nexit 0\n');
    return root;
  }

  function resolverPath(): string {
    return join(homeDir, '.claude', 'tmb-hooks', 'resolve-hook.sh');
  }

  function settingsPath(): string {
    return join(homeDir, '.claude', 'settings.json');
  }
  function readSettings(): { hooks?: { PreToolUse?: HookGroup[]; PostToolUse?: HookGroup[]; SessionStart?: HookGroup[] } } & Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath(), 'utf8'));
  }
  function allPreCommands(s: { hooks?: { PreToolUse?: HookGroup[] } }): string[] {
    return (s.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks.map((h) => h.command));
  }
  function groupFor(s: { hooks?: { PreToolUse?: HookGroup[] } }, matcher: string): HookGroup | undefined {
    return (s.hooks?.PreToolUse ?? []).find((g) => g.matcher === matcher);
  }
  // Extract the resolver's --hook value (re-appending .sh) so the existing
  // name-based assertions keep reading like "no-source-edit-from-main.sh".
  function basename(c: string): string {
    const m = c.match(/--hook\s+(\S+)/);
    if (m) return `${m[1]}.sh`;
    return c.split('/').pop() ?? c;
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'shim-test-'));
    homeDir = mkdtempSync(join(base, 'home-'));
    pluginRoot = makePluginRoot(base);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('fresh write: version-agnostic resolver commands, no version segment, resolver materialized', () => {
    const res = writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    assert.equal(res.written, true);
    assert.ok(existsSync(settingsPath()));

    // The stable resolver is materialized outside the versioned cache.
    assert.ok(existsSync(resolverPath()), 'resolver not materialized');

    const s = readSettings();
    const cmds = allPreCommands(s);
    const stable = resolverPath();
    for (const c of cmds) {
      // Every command invokes the stable resolver with marketplace + hook args.
      assert.ok(c.startsWith(`bash ${stable} --marketplace ${MARKETPLACE} --hook `), `expected resolver command, got ${c}`);
      // No version-pinned cache path leaks in (Success Criterion 1).
      assert.ok(!/tmb\/\d+\.\d+\.\d+/.test(c), `version segment leaked: ${c}`);
      assert.ok(!c.includes('/tmb/0.0.0/'), `version-pinned path leaked: ${c}`);
      assert.ok(!c.includes('${CLAUDE_PLUGIN_ROOT}'), 'placeholder not substituted');
    }
  });

  // Success Criterion 1 + Bug A: the Edit|Write group has no-source-edit-from-main
  // FIRST and excludes swe-brief-gate and the advisory lints.
  it('excludes advisory hooks; no-source-edit-from-main runs first in Edit|Write group', () => {
    writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    const s = readSettings();
    const editGroup = groupFor(s, 'Edit|Write|MultiEdit|NotebookEdit');
    assert.ok(editGroup, 'Edit|Write group missing');
    const names = editGroup.hooks.map((h) => basename(h.command));
    assert.equal(names[0], 'no-source-edit-from-main.sh', `expected no-source-edit first, got ${names[0]}`);
    assert.ok(!names.includes('swe-brief-gate.sh'), 'swe-brief-gate leaked into Edit group');
    assert.ok(!names.includes('naming-lint.sh'), 'naming-lint leaked');
    assert.ok(!names.includes('code-quality-lint.sh'), 'code-quality-lint leaked');
    assert.deepEqual(names, ['no-source-edit-from-main.sh', 'swe-boundary.sh', 'swe-scope-fence.sh']);

    // Denylisted advisory hooks are gone everywhere.
    const allNames = allPreCommands(s).map(basename);
    for (const denied of ['swe-brief-gate.sh', 'naming-lint.sh', 'code-quality-lint.sh', 'commit-msg-lint.sh', 'branch-up-to-date-with-remote.sh', 'debug-trajectory.sh']) {
      assert.ok(!allNames.includes(denied), `${denied} should be excluded`);
    }
    // Deny-capable gates are kept.
    for (const kept of ['no-source-edit-from-main.sh', 'swe-boundary.sh', 'swe-scope-fence.sh', 'git-guards.sh', 'git-push-guard.sh', 'swe-verification-gate.sh']) {
      assert.ok(allNames.includes(kept), `${kept} should be kept`);
    }

    // A group whose only hook was advisory (debug-trajectory) is dropped entirely.
    assert.equal(groupFor(s, 'Bash|Read|Write|Edit|MultiEdit|Agent|Skill'), undefined, 'all-advisory group should be dropped');
    // A group whose only hook was swe-brief-gate is dropped.
    assert.equal(groupFor(s, 'mcp__.*trajectory-server__.*'), undefined, 'brief-gate-only group should be dropped');
  });

  // Success Criterion 2 + Bug B: every TMB entry carries _tmb_managed:true.
  it('stamps _tmb_managed:true on every written TMB hook entry', () => {
    writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    const s = readSettings();
    const entries = (s.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
    assert.ok(entries.length > 0);
    for (const h of entries) {
      assert.equal(h._tmb_managed, true, `entry ${h.command} missing sentinel`);
    }
  });

  it('excludes PostToolUse and SessionStart entries from hooks.json', () => {
    writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    const s = readSettings();
    assert.equal(s.hooks?.PostToolUse, undefined);
    assert.equal(s.hooks?.SessionStart, undefined);
    const cmds = allPreCommands(s);
    assert.ok(!cmds.some((c) => c.includes('attribution-footer')), 'PostToolUse leaked');
    assert.ok(!cmds.some((c) => c.includes('session-start-prescan')), 'SessionStart leaked');
  });

  it('idempotent re-write: running twice yields one TMB block, byte-identical, no version refs', () => {
    writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    const first = readFileSync(settingsPath(), 'utf8');
    writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    const second = readFileSync(settingsPath(), 'utf8');
    assert.equal(first, second);
    // Idempotent re-run never leaves a version-pinned path segment.
    assert.ok(!/tmb\/\d+\.\d+\.\d+/.test(second), 'version segment present after re-run');
  });

  // Success Criterion 2 + Bug B: no accumulation across 3 writes, including when
  // prior entries used dev/worktree command paths (no /tmb/ segment).
  it('sentinel idempotency: no accumulation across 3 writes incl. prior worktree-path entries', () => {
    // Seed a prior TMB block whose command paths look like a dev/worktree build
    // (no /tmb/ segment) — the old substring purge would have missed these and
    // accumulated. Sentinel purge removes them.
    const dir = join(homeDir, '.claude');
    mkdirSync(dir, { recursive: true });
    const stale = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit',
            hooks: [
              { type: 'command', command: '/Users/dev/.claude/worktrees/old/scripts/hooks/no-source-edit-from-main.sh', _tmb_managed: true },
              { type: 'command', command: '/Users/dev/.claude/worktrees/old/scripts/hooks/swe-boundary.sh', _tmb_managed: true },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(stale, null, 2));

    writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    const after1 = allPreCommands(readSettings()).length;
    writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    const after3 = allPreCommands(readSettings());

    assert.equal(after3.length, after1, 'entries accumulated across writes');
    // No stale worktree-path entries survived.
    assert.ok(!after3.some((c) => c.includes('/Users/dev/.claude/worktrees/old/')), 'stale worktree TMB entries not purged');
  });

  it('preserves a pre-existing unrelated user hook and other settings keys', () => {
    const dir = join(homeDir, '.claude');
    mkdirSync(dir, { recursive: true });
    const existing = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-user-hook.sh' }] },
        ],
        PostToolUse: [
          { matcher: 'Write', hooks: [{ type: 'command', command: '/usr/local/bin/user-post.sh' }] },
        ],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(existing, null, 2));

    const res = writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    assert.equal(res.written, true);

    const s = readSettings();
    assert.equal(s.model, 'sonnet');
    const cmds = allPreCommands(s);
    assert.ok(cmds.includes('/usr/local/bin/my-user-hook.sh'), 'user PreToolUse hook lost');
    // User PostToolUse untouched.
    assert.equal((s.hooks?.PostToolUse ?? []).length, 1);

    // Re-running purges only TMB entries; user hook survives, still no dup.
    writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    const cmds2 = allPreCommands(readSettings());
    assert.equal(cmds2.length, cmds.length, 'entry count drifted on re-run');
    assert.ok(cmds2.includes('/usr/local/bin/my-user-hook.sh'));
    // The user hook is not stamped as TMB-managed.
    const userEntry = (readSettings().hooks?.PreToolUse ?? [])
      .flatMap((g) => g.hooks)
      .find((h) => h.command === '/usr/local/bin/my-user-hook.sh');
    assert.equal(userEntry?._tmb_managed, undefined);
  });

  // #978: legacy pre-sentinel TMB entries are purged by command-string signature.
  // Block A: literal dev .../plugin/scripts/hooks/*.sh (basename in TMB set, under
  //          /scripts/hooks/, no sentinel) → signature (d).
  // Block B: .../cache/<mp>/tmb/<version>/scripts/hooks/*.sh → signature (c).
  // Block C: stable resolver invocation, no sentinel → signature (b).
  // Block D: stable resolver invocation + _tmb_managed:true → signature (a).
  // All four collapse to exactly ONE sentinel-stamped TMB block.
  it('legacy purge: Blocks A/B/C/D collapse to one sentinel-stamped TMB block', () => {
    const dir = join(homeDir, '.claude');
    mkdirSync(dir, { recursive: true });
    const stableResolver = resolverPath();
    const stale = {
      hooks: {
        PreToolUse: [
          // Block A: literal dev plugin path, no sentinel.
          {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit',
            hooks: [
              { type: 'command', command: '/Users/dev/Git/TMB/plugin/scripts/hooks/no-source-edit-from-main.sh' },
              { type: 'command', command: '/Users/dev/Git/TMB/plugin/scripts/hooks/swe-boundary.sh' },
            ],
          },
          // Block B: version-pinned cache path, no sentinel.
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: '/Users/u/.claude/plugins/cache/trustmybot/tmb/0.10.0-alpha/scripts/hooks/git-guards.sh' },
              { type: 'command', command: '/Users/u/.claude/plugins/cache/trustmybot/tmb/0.10.0-alpha/scripts/hooks/git-push-guard.sh' },
            ],
          },
          // Block C: stable resolver, no sentinel.
          {
            matcher: 'mcp__.*trajectory-server__task_update_status',
            hooks: [
              { type: 'command', command: `bash ${stableResolver} --marketplace trustmybot --hook swe-verification-gate` },
            ],
          },
          // Block D: stable resolver + sentinel.
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: `bash ${stableResolver} --marketplace trustmybot --hook git-guards`, _tmb_managed: true },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(stale, null, 2));

    const res = writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    assert.equal(res.written, true);

    const s = readSettings();
    const all = (s.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
    // No legacy entry survived.
    assert.ok(!all.some((h) => h.command.includes('/Users/dev/Git/TMB/plugin/scripts/hooks/')), 'Block A survived');
    assert.ok(!all.some((h) => h.command.includes('0.10.0-alpha')), 'Block B survived');
    // Every surviving entry is freshly written + sentinel-stamped.
    for (const h of all) {
      assert.equal(h._tmb_managed, true, `non-TMB-stamped entry survived: ${h.command}`);
      assert.ok(h.command.startsWith(`bash ${stableResolver} --marketplace `), `non-resolver entry survived: ${h.command}`);
    }

    // Re-running is idempotent (no accumulation).
    const before = readFileSync(settingsPath(), 'utf8');
    writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    assert.equal(readFileSync(settingsPath(), 'utf8'), before, 'legacy re-run not idempotent');
  });

  // Success Criterion 3: genuine non-TMB hooks survive, including a same-dir
  // /scripts/hooks/ entry whose basename is NOT in the TMB hook-name set.
  it('legacy purge: preserves arbitrary AND same-dir non-TMB-basename user hooks', () => {
    const dir = join(homeDir, '.claude');
    mkdirSync(dir, { recursive: true });
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              // Arbitrary path — not TMB.
              { type: 'command', command: '/Users/u/myhooks/custom.sh' },
              // Same /scripts/hooks/ dir but basename not in the TMB set.
              { type: 'command', command: '/Users/u/work/scripts/hooks/my-notes.sh' },
              // A legacy TMB entry alongside them (basename IS in the TMB set).
              { type: 'command', command: '/Users/dev/Git/TMB/plugin/scripts/hooks/git-guards.sh' },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(existing, null, 2));

    const res = writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    assert.equal(res.written, true);

    const cmds = allPreCommands(readSettings());
    assert.ok(cmds.includes('/Users/u/myhooks/custom.sh'), 'arbitrary user hook lost');
    assert.ok(cmds.includes('/Users/u/work/scripts/hooks/my-notes.sh'), 'same-dir non-TMB-basename hook lost');
    // The legacy TMB entry was purged.
    assert.ok(!cmds.includes('/Users/dev/Git/TMB/plugin/scripts/hooks/git-guards.sh'), 'legacy TMB entry not purged');

    // These user hooks are not stamped TMB-managed.
    const userEntries = (readSettings().hooks?.PreToolUse ?? [])
      .flatMap((g) => g.hooks)
      .filter((h) => h.command === '/Users/u/myhooks/custom.sh' || h.command === '/Users/u/work/scripts/hooks/my-notes.sh');
    assert.equal(userEntries.length, 2);
    for (const h of userEntries) assert.equal(h._tmb_managed, undefined);
  });

  // Success Criterion 3 + Bug C: a worktree plugin root must not touch settings.
  it('worktree plugin root: returns {written:false} and does NOT touch settings.json', () => {
    const dir = join(homeDir, '.claude');
    mkdirSync(dir, { recursive: true });
    const existing = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/keep.sh' }] }] } };
    writeFileSync(settingsPath(), JSON.stringify(existing, null, 2));
    const before = readFileSync(settingsPath(), 'utf8');

    const worktreeRoot = join(base, 'repo', '.claude', 'worktrees', 'feat-x', 'tmb', '0.0.0');
    mkdirSync(join(worktreeRoot, 'hooks'), { recursive: true });
    writeFileSync(join(worktreeRoot, 'hooks', 'hooks.json'), JSON.stringify(HOOKS_JSON));

    const res = writeUserSettingsEnforcementShim({ pluginRoot: worktreeRoot, homeDir });
    assert.equal(res.written, false);
    assert.equal(res.reason, 'plugin-root-in-worktree');

    // settings.json untouched, byte-identical.
    assert.equal(readFileSync(settingsPath(), 'utf8'), before);
  });

  it('worktree plugin root with no pre-existing settings: does not create settings.json', () => {
    const worktreeRoot = join(base, 'repo', '.claude', 'worktrees', 'feat-y', 'tmb', '0.0.0');
    mkdirSync(join(worktreeRoot, 'hooks'), { recursive: true });
    writeFileSync(join(worktreeRoot, 'hooks', 'hooks.json'), JSON.stringify(HOOKS_JSON));

    const res = writeUserSettingsEnforcementShim({ pluginRoot: worktreeRoot, homeDir });
    assert.equal(res.written, false);
    assert.equal(res.reason, 'plugin-root-in-worktree');
    assert.ok(!existsSync(settingsPath()));
  });

  it('unresolvable plugin root: returns {written:false} and does not corrupt settings.json', () => {
    const dir = join(homeDir, '.claude');
    mkdirSync(dir, { recursive: true });
    const existing = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/keep.sh' }] }] } };
    writeFileSync(settingsPath(), JSON.stringify(existing, null, 2));

    const res = writeUserSettingsEnforcementShim({ pluginRoot: null, homeDir });
    assert.equal(res.written, false);
    assert.ok(res.reason);

    const s = readSettings();
    assert.equal(s.model, 'opus');
    assert.deepEqual(allPreCommands(s), ['/usr/local/bin/keep.sh']);
  });

  it('missing hooks.json: returns {written:false} reason and skips', () => {
    rmSync(join(pluginRoot, 'hooks', 'hooks.json'));
    const res = writeUserSettingsEnforcementShim({ pluginRoot, homeDir });
    assert.equal(res.written, false);
    assert.ok(res.reason);
    assert.ok(!existsSync(settingsPath()));
  });
});
