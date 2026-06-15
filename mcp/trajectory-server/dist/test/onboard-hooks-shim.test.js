import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeHeadlessEnforcementShim } from '../tools/onboard-hooks-shim.js';
// A minimal hooks.json mirroring the real plugin's shape: PreToolUse plus a
// PostToolUse + SessionStart that must NOT be copied into settings.json.
const HOOKS_JSON = {
    hooks: {
        SessionStart: [
            { matcher: '', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start-prescan.sh', timeout: 5 }] },
        ],
        PreToolUse: [
            {
                matcher: 'Edit|Write|MultiEdit|NotebookEdit',
                hooks: [
                    { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/swe-brief-gate.sh', timeout: 5 },
                    { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/swe-scope-fence.sh', timeout: 5 },
                ],
            },
            {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/git-guards.sh', timeout: 10 }],
            },
            {
                matcher: 'mcp__.*trajectory-server__task_update_status',
                hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/swe-verification-gate.sh', timeout: 260 }],
            },
        ],
        PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/attribution-footer.sh', timeout: 15 }] },
        ],
    },
};
describe('writeHeadlessEnforcementShim', () => {
    let pluginRoot;
    let homeDir;
    let base;
    function makePluginRoot(base) {
        // Mirror the marketplace cache layout (.../tmb/<version>/...) so the
        // purge heuristic (path contains /tmb/ and /scripts/hooks/) matches.
        const root = join(mkdtempSync(join(base, 'cache-')), 'tmb', '0.0.0');
        mkdirSync(join(root, '.claude-plugin'), { recursive: true });
        writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tmb' }));
        mkdirSync(join(root, 'hooks'), { recursive: true });
        writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify(HOOKS_JSON));
        return root;
    }
    function settingsPath() {
        return join(homeDir, '.claude', 'settings.json');
    }
    function readSettings() {
        return JSON.parse(readFileSync(settingsPath(), 'utf8'));
    }
    function allPreCommands(s) {
        return (s.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    }
    beforeEach(() => {
        base = mkdtempSync(join(tmpdir(), 'shim-test-'));
        homeDir = mkdtempSync(join(base, 'home-'));
        pluginRoot = makePluginRoot(base);
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });
    it('fresh write: creates settings.json with absolute PreToolUse commands', () => {
        const res = writeHeadlessEnforcementShim({ pluginRoot, homeDir });
        assert.equal(res.written, true);
        assert.ok(existsSync(settingsPath()));
        const s = readSettings();
        const cmds = allPreCommands(s);
        assert.equal(cmds.length, 4);
        // ${CLAUDE_PLUGIN_ROOT} substituted with the absolute plugin root.
        for (const c of cmds) {
            assert.ok(c.startsWith(pluginRoot + '/scripts/hooks/'), `expected absolute path, got ${c}`);
            assert.ok(!c.includes('${CLAUDE_PLUGIN_ROOT}'), 'placeholder not substituted');
        }
        // Matchers mirror hooks.json.
        const matchers = (s.hooks?.PreToolUse ?? []).map((g) => g.matcher);
        assert.deepEqual(matchers, ['Edit|Write|MultiEdit|NotebookEdit', 'Bash', 'mcp__.*trajectory-server__task_update_status']);
    });
    it('excludes PostToolUse and SessionStart entries from hooks.json', () => {
        writeHeadlessEnforcementShim({ pluginRoot, homeDir });
        const s = readSettings();
        assert.equal(s.hooks?.PostToolUse, undefined);
        assert.equal(s.hooks?.SessionStart, undefined);
        const cmds = allPreCommands(s);
        assert.ok(!cmds.some((c) => c.includes('attribution-footer')), 'PostToolUse leaked');
        assert.ok(!cmds.some((c) => c.includes('session-start-prescan')), 'SessionStart leaked');
    });
    it('idempotent re-write: running twice yields one TMB block, byte-identical', () => {
        writeHeadlessEnforcementShim({ pluginRoot, homeDir });
        const first = readFileSync(settingsPath(), 'utf8');
        writeHeadlessEnforcementShim({ pluginRoot, homeDir });
        const second = readFileSync(settingsPath(), 'utf8');
        assert.equal(first, second);
        const cmds = allPreCommands(readSettings());
        assert.equal(cmds.length, 4);
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
        const res = writeHeadlessEnforcementShim({ pluginRoot, homeDir });
        assert.equal(res.written, true);
        const s = readSettings();
        assert.equal(s.model, 'sonnet');
        const cmds = allPreCommands(s);
        assert.ok(cmds.includes('/usr/local/bin/my-user-hook.sh'), 'user PreToolUse hook lost');
        // User PostToolUse untouched.
        assert.equal((s.hooks?.PostToolUse ?? []).length, 1);
        // TMB entries appended (4 commands) + 1 user command.
        assert.equal(cmds.length, 5);
        // Re-running purges only TMB entries; user hook survives, still no dup.
        writeHeadlessEnforcementShim({ pluginRoot, homeDir });
        const cmds2 = allPreCommands(readSettings());
        assert.equal(cmds2.length, 5);
        assert.ok(cmds2.includes('/usr/local/bin/my-user-hook.sh'));
    });
    it('unresolvable plugin root: returns {written:false} and does not corrupt settings.json', () => {
        const dir = join(homeDir, '.claude');
        mkdirSync(dir, { recursive: true });
        const existing = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/keep.sh' }] }] } };
        writeFileSync(settingsPath(), JSON.stringify(existing, null, 2));
        const res = writeHeadlessEnforcementShim({ pluginRoot: null, homeDir });
        assert.equal(res.written, false);
        assert.ok(res.reason);
        const s = readSettings();
        assert.equal(s.model, 'opus');
        assert.deepEqual(allPreCommands(s), ['/usr/local/bin/keep.sh']);
    });
    it('missing hooks.json: returns {written:false} reason and skips', () => {
        rmSync(join(pluginRoot, 'hooks', 'hooks.json'));
        const res = writeHeadlessEnforcementShim({ pluginRoot, homeDir });
        assert.equal(res.written, false);
        assert.ok(res.reason);
        assert.ok(!existsSync(settingsPath()));
    });
});
//# sourceMappingURL=onboard-hooks-shim.test.js.map