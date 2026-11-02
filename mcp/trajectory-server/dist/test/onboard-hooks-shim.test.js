import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { countShimEntries, removeProjectEnforcementShim, writeProjectEnforcementShim, } from '../tools/onboard-hooks-shim.js';
const routerCommand = (event, part = '') => `node "\${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" ${event}${part === '' ? '' : ` ${part}`}`;
// A hooks.json in the real plugin's router shape: one router entry per
// PreToolUse group, fail-closed groups with `onFailure: block`, plus
// SessionStart and PostToolUse router entries that must NOT be copied.
const HOOKS_JSON = {
    hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: routerCommand('SessionStart', 'prescan'), timeout: 15 }] }],
        PreToolUse: [
            { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: routerCommand('PreToolUse'), timeout: 12, onFailure: 'block' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: routerCommand('PreToolUse'), timeout: 19, onFailure: 'block' }] },
            { matcher: 'mcp__.*trajectory-server__.*', hooks: [{ type: 'command', command: routerCommand('PreToolUse'), timeout: 1833, onFailure: 'block' }] },
            { matcher: 'Read|Skill', hooks: [{ type: 'command', command: routerCommand('PreToolUse'), timeout: 11 }] },
        ],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: routerCommand('PostToolUse'), timeout: 27 }] }],
    },
};
// The shim never writes outside the project: HOME is an empty temp dir for the
// whole file and must still be empty at the end.
const PLUGIN_SOURCE = fileURLToPath(new URL('../../../../', import.meta.url));
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'shim-home-'));
process.env['HOME'] = ISOLATED_HOME;
describe('project enforcement shim', () => {
    const MARKETPLACE = 'trustmybot';
    let base;
    let pluginRoot;
    let project;
    // A realistic install layout: <claude-home>/plugins/cache/<marketplace>/tmb/<version>.
    function makePluginRoot(at) {
        const root = join(at, '.claude', 'plugins', 'cache', MARKETPLACE, 'tmb', '0.0.0');
        mkdirSync(join(root, '.claude-plugin'), { recursive: true });
        writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tmb' }));
        mkdirSync(join(root, 'hooks'), { recursive: true });
        writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify(HOOKS_JSON));
        mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
        writeFileSync(join(root, 'scripts', 'lib', 'resolve-hook.sh'), '#!/usr/bin/env bash\nexit 0\n');
        return root;
    }
    const settingsPath = () => join(project, '.claude', 'settings.local.json');
    const resolverPath = () => join(project, '.claude', 'tmb', 'resolve-hook.sh');
    const readSettings = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));
    const entriesOf = (s) => (s.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
    const groupFor = (s, matcher) => (s.hooks?.PreToolUse ?? []).find((g) => g.matcher === matcher);
    const shimCommand = (hook, projectRoot = project) => `bash ${resolverPath()} --marketplace ${MARKETPLACE} --hook ${hook} --shim --project ${projectRoot}`;
    function write(root = pluginRoot, projectRoot = project) {
        return writeProjectEnforcementShim({ pluginRoot: root, projectRoot, headlessEnforcement: 'yes' });
    }
    function remove() {
        return removeProjectEnforcementShim({ pluginRoot, projectRoot: project });
    }
    function useHooksJson(hooks) {
        writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), typeof hooks === 'string' ? hooks : JSON.stringify(hooks));
    }
    beforeEach(() => {
        base = mkdtempSync(join(tmpdir(), 'shim-test-'));
        pluginRoot = makePluginRoot(join(base, 'claude-home'));
        project = join(base, 'project');
        mkdirSync(project, { recursive: true });
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });
    it('headless_enforcement off: writes nothing anywhere', () => {
        for (const flag of ['no', null]) {
            const res = writeProjectEnforcementShim({ pluginRoot, projectRoot: project, headlessEnforcement: flag });
            assert.equal(res.written, false);
            assert.equal(res.reason, 'headless_enforcement_off');
        }
        assert.deepEqual(readdirSync(project), []);
    });
    it('non-installed plugin roots (checkout, worktree, /tmp copy) are refused', () => {
        for (const rel of ['repo/plugin', 'repo/.claude/worktrees/feat-x', 'tmp-review/plugin']) {
            const root = join(base, rel);
            mkdirSync(join(root, 'hooks'), { recursive: true });
            writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify(HOOKS_JSON));
            const res = write(root);
            assert.equal(res.written, false);
            assert.equal(res.reason, 'plugin-root-not-installed');
        }
        assert.deepEqual(readdirSync(project), []);
        const nullRoot = write(null);
        assert.equal(nullRoot.written, false);
    });
    it('fresh write: one project-tagged --shim router entry per PreToolUse router entry, never dispatch.sh', () => {
        const res = write();
        assert.equal(res.written, true);
        assert.equal(res.settings_path, settingsPath());
        assert.ok(existsSync(resolverPath()), 'resolver not materialized in the project');
        const s = readSettings();
        const entries = entriesOf(s);
        assert.equal(res.entries, 4);
        assert.equal(entries.length, 4);
        assert.equal(countShimEntries(pluginRoot), 4);
        for (const h of entries) {
            assert.equal(h._tmb_managed, true);
            assert.equal(h._tmb_project, project);
            assert.equal(h.command, shimCommand('PreToolUse'));
            assert.ok(!h.command.includes('dispatch'), h.command);
            assert.ok(!/tmb\/\d+\.\d+\.\d+/.test(h.command), `version segment leaked: ${h.command}`);
        }
        assert.ok(!readFileSync(settingsPath(), 'utf8').includes('dispatch.sh'));
    });
    it('keeps each group matcher, its timeout and onFailure, in hooks.json order', () => {
        write();
        const s = readSettings();
        assert.deepEqual((s.hooks?.PreToolUse ?? []).map((g) => [g.matcher, g.hooks.length, g.hooks[0].timeout, g.hooks[0].onFailure]), [
            ['Write|Edit|MultiEdit|NotebookEdit', 1, 12, 'block'],
            ['Bash', 1, 19, 'block'],
            ['mcp__.*trajectory-server__.*', 1, 1833, 'block'],
            ['Read|Skill', 1, 11, undefined],
        ]);
        assert.equal(s.hooks?.PostToolUse, undefined);
        assert.equal(s.hooks?.SessionStart, undefined);
    });
    it('a router entry with a part passes it as --part', () => {
        useHooksJson({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: routerCommand('PreToolUse', 'guard'), timeout: 9, onFailure: 'block' }] }] } });
        write();
        assert.deepEqual(groupFor(readSettings(), 'Bash')?.hooks.map((h) => h.command), [
            `bash ${resolverPath()} --marketplace ${MARKETPLACE} --hook PreToolUse --part guard --shim --project ${project}`,
        ]);
    });
    it('the shipped hooks.json: one entry per PreToolUse router entry, no other event', () => {
        const shipped = readFileSync(join(PLUGIN_SOURCE, 'hooks', 'hooks.json'), 'utf8');
        useHooksJson(shipped);
        assert.equal(write().written, true);
        const s = readSettings();
        const real = JSON.parse(shipped).hooks.PreToolUse;
        assert.deepEqual((s.hooks?.PreToolUse ?? []).map((g) => [g.matcher, g.hooks.map((h) => [h.timeout, h.onFailure])]), real.map((g) => [g.matcher, g.hooks.map((h) => [h.timeout, h.onFailure])]));
        assert.equal(countShimEntries(pluginRoot), real.reduce((n, g) => n + g.hooks.length, 0));
        for (const event of Object.keys(s.hooks ?? {}))
            assert.equal(event, 'PreToolUse');
        assert.ok(!readFileSync(settingsPath(), 'utf8').includes('dispatch.sh'));
    });
    it('a hooks.json with no PreToolUse router entry writes nothing, with a reason', () => {
        useHooksJson({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" git-guards', timeout: 10 }] }] } });
        const res = write();
        assert.equal(res.written, false);
        assert.equal(res.reason, 'hooks/hooks.json has no PreToolUse router entry');
        assert.equal(existsSync(settingsPath()), false);
        assert.equal(countShimEntries(pluginRoot), 0);
    });
    it('replaces the per-gate entries an earlier /onboard wrote, keeping user hooks', () => {
        mkdirSync(join(project, '.claude'), { recursive: true });
        const oldEntry = (gate, stamped) => ({
            type: 'command',
            command: `bash ${resolverPath()} --marketplace ${MARKETPLACE} --hook ${gate} --shim --project ${project}`,
            timeout: 10,
            ...(stamped ? { _tmb_managed: true, _tmb_project: project } : {}),
        });
        const user = { type: 'command', command: '/usr/local/bin/my-user-hook.sh' };
        writeFileSync(settingsPath(), JSON.stringify({
            hooks: {
                PreToolUse: [
                    { matcher: 'Bash', hooks: [user, oldEntry('git-guards', true), oldEntry('swe-boundary', false)] },
                    { matcher: 'mcp__.*trajectory-server__.*', hooks: [oldEntry('trajectory-gates', true)] },
                ],
            },
        }));
        write();
        const s = readSettings();
        const all = entriesOf(s);
        assert.ok(!all.some((h) => /--hook [a-z]/.test(h.command)), 'no per-gate entry left');
        assert.deepEqual(s.hooks?.PreToolUse?.[0], { matcher: 'Bash', hooks: [user] });
        assert.equal(all.filter((h) => h._tmb_managed === true).length, 4);
        assert.ok(all.filter((h) => h._tmb_managed === true).every((h) => h.command === shimCommand('PreToolUse')));
    });
    it('quoted and unquoted placeholder commands yield the same shim', () => {
        write();
        const quoted = readFileSync(settingsPath(), 'utf8');
        rmSync(join(project, '.claude'), { recursive: true, force: true });
        const unquoted = JSON.stringify(HOOKS_JSON).replace(/\\"(\$\{CLAUDE_PLUGIN_ROOT\}[^\\]*)\\"/g, '$1');
        assert.ok(!unquoted.includes('hooks.js\\"'), 'fixture rewrite left a quoted command');
        useHooksJson(unquoted);
        write();
        assert.equal(readFileSync(settingsPath(), 'utf8'), quoted);
    });
    it('idempotent: repeated writes are byte-identical', () => {
        write();
        const first = readFileSync(settingsPath(), 'utf8');
        write();
        write();
        assert.equal(readFileSync(settingsPath(), 'utf8'), first);
    });
    it('preserves pre-existing settings.local.json keys and user hooks', () => {
        mkdirSync(join(project, '.claude'), { recursive: true });
        const existing = {
            permissions: { allow: ['Bash(ls:*)'] },
            hooks: {
                PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-user-hook.sh' }] }],
                PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: '/usr/local/bin/user-post.sh' }] }],
            },
        };
        writeFileSync(settingsPath(), JSON.stringify(existing, null, 2));
        write();
        const s = readSettings();
        assert.deepEqual(s.permissions, existing.permissions);
        assert.ok(entriesOf(s).some((h) => h.command === '/usr/local/bin/my-user-hook.sh' && h._tmb_managed === undefined));
        assert.equal((s.hooks?.PostToolUse ?? []).length, 1);
        const res = remove();
        assert.ok(res.removed > 0);
        assert.equal(res.resolver_removed, true);
        assert.deepEqual(readSettings(), existing);
        assert.ok(!existsSync(resolverPath()));
    });
    it('remove with nothing managed: settings.local.json byte-identical, never created', () => {
        const none = remove();
        assert.equal(none.removed, 0);
        assert.ok(!existsSync(settingsPath()));
        mkdirSync(join(project, '.claude'), { recursive: true });
        writeFileSync(settingsPath(), '{ "permissions": {} }\n');
        assert.equal(remove().removed, 0);
        assert.equal(readFileSync(settingsPath(), 'utf8'), '{ "permissions": {} }\n');
    });
    it('remove of a shim-only file leaves no hooks key behind', () => {
        write();
        remove();
        assert.deepEqual(readSettings(), {});
    });
    it('project roots with spaces are shell-quoted', () => {
        const spaced = join(base, 'my project');
        mkdirSync(spaced);
        write(pluginRoot, spaced);
        const s = JSON.parse(readFileSync(join(spaced, '.claude', 'settings.local.json'), 'utf8'));
        assert.ok(entriesOf(s).every((h) => h.command.endsWith(`--project '${spaced}'`)));
    });
    it('invalid settings.local.json is left alone', () => {
        mkdirSync(join(project, '.claude'), { recursive: true });
        writeFileSync(settingsPath(), '{ not json');
        const res = write();
        assert.equal(res.written, false);
        assert.equal(readFileSync(settingsPath(), 'utf8'), '{ not json');
    });
    it('missing hooks.json: skips', () => {
        rmSync(join(pluginRoot, 'hooks', 'hooks.json'));
        const res = write();
        assert.equal(res.written, false);
        assert.ok(!existsSync(settingsPath()));
    });
    it('never writes under HOME', () => {
        assert.deepEqual(readdirSync(ISOLATED_HOME), []);
    });
});
//# sourceMappingURL=onboard-hooks-shim.test.js.map