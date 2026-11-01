import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { countShimEntries, removeProjectEnforcementShim, writeProjectEnforcementShim, } from '../tools/onboard-hooks-shim.js';
// A hooks.json mirroring the real plugin's PreToolUse shape (every command is
// `"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" <gate>`): each deny-capable
// gate is preceded by advisory/allow-returning hooks that must be excluded so
// the deny gate runs first. Plus a PostToolUse + SessionStart that must NOT be
// copied into settings.json.
const HOOKS_JSON = {
    hooks: {
        SessionStart: [
            { matcher: '', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" session-start-prescan', timeout: 5 }] },
        ],
        PreToolUse: [
            {
                matcher: 'Bash',
                hooks: [
                    { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" git-guards', timeout: 10 },
                    { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" git-push-guard', timeout: 10 },
                    { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" swe-boundary', timeout: 5 },
                    { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" branch-up-to-date-with-remote', timeout: 10 },
                    { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" commit-msg-lint', timeout: 5 },
                ],
            },
            {
                matcher: 'Edit|Write|MultiEdit|NotebookEdit',
                hooks: [
                    { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" swe-brief-gate', timeout: 5 },
                    { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" no-source-edit-from-main', timeout: 5 },
                    { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" swe-boundary', timeout: 5 },
                    { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" swe-scope-fence', timeout: 5 },
                    { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" naming-lint', timeout: 5 },
                    { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" code-quality-lint', timeout: 5 },
                ],
            },
            {
                matcher: 'mcp__.*trajectory-server__.*',
                hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" swe-brief-gate', timeout: 5 }],
            },
            {
                matcher: 'mcp__.*trajectory-server__task_update_status',
                hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" swe-verification-gate', timeout: 260 }],
            },
            {
                matcher: 'Bash|Read|Write|Edit|MultiEdit|Agent|Skill',
                hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" debug-trajectory', timeout: 5 }],
            },
        ],
        PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" attribution-footer', timeout: 15 }] },
        ],
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
    const hookOf = (c) => {
        const m = c.match(/--hook\s+(\S+)/);
        return m ? `${m[1]}.sh` : (c.split('/').pop() ?? c);
    };
    function write(root = pluginRoot, projectRoot = project) {
        return writeProjectEnforcementShim({ pluginRoot: root, projectRoot, headlessEnforcement: 'yes' });
    }
    function remove() {
        return removeProjectEnforcementShim({ pluginRoot, projectRoot: project });
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
    it('fresh write: project settings.local.json + project resolver, project-tagged --shim commands', () => {
        const res = write();
        assert.equal(res.written, true);
        assert.equal(res.settings_path, settingsPath());
        assert.ok(existsSync(resolverPath()), 'resolver not materialized in the project');
        const entries = entriesOf(readSettings());
        assert.equal(res.entries, entries.length);
        assert.equal(countShimEntries(pluginRoot), entries.length);
        for (const h of entries) {
            assert.equal(h._tmb_managed, true);
            assert.equal(h._tmb_project, project);
            assert.ok(h.command.startsWith(`bash ${resolverPath()} --marketplace ${MARKETPLACE} --hook `), h.command);
            assert.ok(h.command.endsWith(` --shim --project ${project}`), h.command);
            const gate = h.command.match(/--hook (\S+) --shim/)?.[1] ?? '';
            assert.match(gate, /^[a-z0-9-]+$/, `--hook carries a bare gate name: ${h.command}`);
            assert.notEqual(gate, 'dispatch', h.command);
            assert.ok(!h.command.includes('dispatch.sh'), `resolver resolves the dispatcher itself: ${h.command}`);
            assert.ok(!/tmb\/\d+\.\d+\.\d+/.test(h.command), `version segment leaked: ${h.command}`);
        }
    });
    it('excludes advisory hooks; no-source-edit-from-main runs first in Edit|Write group', () => {
        write();
        const s = readSettings();
        const editGroup = groupFor(s, 'Edit|Write|MultiEdit|NotebookEdit');
        assert.ok(editGroup);
        assert.deepEqual(editGroup.hooks.map((h) => hookOf(h.command)), ['no-source-edit-from-main.sh', 'swe-boundary.sh', 'swe-scope-fence.sh']);
        const all = entriesOf(s).map((h) => hookOf(h.command));
        for (const denied of ['swe-brief-gate.sh', 'naming-lint.sh', 'code-quality-lint.sh', 'commit-msg-lint.sh', 'branch-up-to-date-with-remote.sh', 'debug-trajectory.sh']) {
            assert.ok(!all.includes(denied), `${denied} should be excluded`);
        }
        for (const kept of ['git-guards.sh', 'git-push-guard.sh', 'swe-verification-gate.sh']) {
            assert.ok(all.includes(kept), `${kept} should be kept`);
        }
        assert.equal(groupFor(s, 'Bash|Read|Write|Edit|MultiEdit|Agent|Skill'), undefined);
        assert.equal(groupFor(s, 'mcp__.*trajectory-server__.*'), undefined);
        assert.equal(s.hooks?.PostToolUse, undefined);
        assert.equal(s.hooks?.SessionStart, undefined);
    });
    it('the router entry becomes one shim entry per enforcement gate dist/hooks-router.txt lists, at its budget', () => {
        const router = {
            hooks: {
                PreToolUse: [
                    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" PreToolUse', timeout: 18, onFailure: 'block' }] },
                ],
            },
        };
        writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify(router));
        mkdirSync(join(pluginRoot, 'mcp', 'trajectory-server', 'dist'), { recursive: true });
        writeFileSync(join(pluginRoot, 'mcp', 'trajectory-server', 'dist', 'hooks-router.txt'), 'containment-guard 5000 enforcement PreToolUse Bash\ngit-guards 10200 enforcement PreToolUse Bash\ncommit-msg-lint 4000 advisory PreToolUse Bash\nother 3000 enforcement PostToolUse Bash\n');
        write();
        const bash = groupFor(readSettings(), 'Bash');
        assert.ok(bash);
        assert.deepEqual(bash.hooks.map((h) => [hookOf(h.command), h.timeout]), [['containment-guard.sh', 5], ['git-guards.sh', 11]]);
    });
    it('router entries of the post-tool and stop events make no shim entry, and their sentinel rows read as an empty matcher', () => {
        const routed = (event, matcher, block = false) => ({
            ...(matcher === undefined ? {} : { matcher }),
            hooks: [{ type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" ${event}`, timeout: 9, ...(block ? { onFailure: 'block' } : {}) }],
        });
        const hooks = {
            hooks: {
                PreToolUse: [routed('PreToolUse', 'Bash', true)],
                PostToolUse: [routed('PostToolUse', 'Bash'), routed('PostToolUse', 'mcp__.*trajectory-server__.*'), routed('PostToolUse', 'Agent')],
                PermissionDenied: [routed('PermissionDenied', 'Agent')],
                Stop: [routed('Stop', '')],
                SubagentStop: [routed('SubagentStop', '', true)],
            },
        };
        writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify(hooks));
        mkdirSync(join(pluginRoot, 'mcp', 'trajectory-server', 'dist'), { recursive: true });
        writeFileSync(join(pluginRoot, 'mcp', 'trajectory-server', 'dist', 'hooks-router.txt'), 'git-guards 10200 enforcement PreToolUse Bash *\nattribution-footer 16000 advisory PostToolUse Bash *\nswe-spawn-rollback 6000 advisory PermissionDenied Agent *\nbro-turn-usage 6000 advisory Stop - *\nconsultant-persistence-gate 6000 enforcement SubagentStop - *\n');
        assert.equal(write().written, true);
        const s = readSettings();
        assert.deepEqual(groupFor(readSettings(), 'Bash')?.hooks.map((h) => hookOf(h.command)), ['git-guards.sh']);
        for (const event of ['PostToolUse', 'PermissionDenied', 'Stop', 'SubagentStop'])
            assert.equal(s.hooks?.[event], undefined, event);
    });
    it('every router group becomes its own gates, advisory ones dropped, and the trajectory-server group its chain', () => {
        const entry = (matcher, timeout, block = true) => ({
            matcher,
            hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" PreToolUse', timeout, ...(block ? { onFailure: 'block' } : {}) }],
        });
        const realDist = join(PLUGIN_SOURCE, 'mcp', 'trajectory-server', 'dist', 'hooks-router.txt');
        const realHooks = JSON.parse(readFileSync(join(PLUGIN_SOURCE, 'hooks', 'hooks.json'), 'utf8'));
        const realMatchers = realHooks.hooks.PreToolUse.map((g) => g.matcher);
        writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: realMatchers.map((m) => entry(m, 40, m !== 'AskUserQuestion' && m !== 'Read|Skill')) } }));
        mkdirSync(join(pluginRoot, 'mcp', 'trajectory-server', 'dist'), { recursive: true });
        writeFileSync(join(pluginRoot, 'mcp', 'trajectory-server', 'dist', 'hooks-router.txt'), readFileSync(realDist, 'utf8'));
        assert.equal(write().written, true);
        const settings = readSettings();
        const gatesOf = (matcher) => groupFor(settings, matcher)?.hooks.map((h) => hookOf(h.command));
        assert.deepEqual(gatesOf('Write|Edit|MultiEdit|NotebookEdit'), ['containment-guard.sh', 'no-source-edit-from-main.sh', 'swe-boundary.sh', 'swe-scope-fence.sh']);
        assert.deepEqual(gatesOf('Agent'), ['agent-spawn-dispatch.sh']);
        assert.deepEqual(gatesOf('SendMessage'), ['swe-resume-gate.sh']);
        assert.deepEqual(gatesOf('AskUserQuestion'), ['roundtable-auq-shape.sh']);
        assert.deepEqual(gatesOf('mcp__.*trajectory-server__.*'), ['trajectory-gates.sh']);
        assert.ok((groupFor(settings, 'mcp__.*trajectory-server__.*')?.hooks[0].timeout ?? 0) >= 1842, 'every unfiltered gate plus the verification budget');
        assert.equal(groupFor(settings, 'Read|Skill'), undefined, 'debug-trajectory alone: nothing to enforce');
        assert.ok(gatesOf('Bash')?.includes('git-guards.sh'));
    });
    describe('fails closed when the router entry cannot be expanded (F271-2)', () => {
        const ROUTER_HOOKS_JSON = {
            hooks: {
                PreToolUse: [
                    { matcher: 'Write|Edit', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" containment-guard', timeout: 5 }] },
                    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" PreToolUse', timeout: 18, onFailure: 'block' }] },
                ],
            },
        };
        const manifestPath = () => join(pluginRoot, 'mcp', 'trajectory-server', 'dist', 'hooks-router.txt');
        beforeEach(() => {
            writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify(ROUTER_HOOKS_JSON));
        });
        it('refuses to write, with a reason, when dist/hooks-router.txt is missing', () => {
            const res = write();
            assert.equal(res.written, false);
            assert.equal(res.reason, 'dist/hooks-router.txt missing or unreadable');
            assert.equal(existsSync(settingsPath()), false);
            assert.equal(countShimEntries(pluginRoot), 0);
        });
        it('refuses to write, with a reason, when dist/hooks-router.txt lists no gate for the event', () => {
            mkdirSync(dirname(manifestPath()), { recursive: true });
            writeFileSync(manifestPath(), 'other 3000 enforcement PostToolUse Bash\n');
            const res = write();
            assert.equal(res.written, false);
            assert.equal(res.reason, 'dist/hooks-router.txt lists no gate for PreToolUse Bash');
            assert.equal(existsSync(settingsPath()), false);
        });
        it('never reports a written shim with no Bash entry', () => {
            mkdirSync(dirname(manifestPath()), { recursive: true });
            writeFileSync(manifestPath(), 'git-guards 10200 enforcement PreToolUse Bash\n');
            const res = write();
            assert.equal(res.written, true);
            assert.equal(groupFor(readSettings(), 'Bash')?.hooks.length, 1);
        });
    });
    it('quoted and unquoted placeholder commands yield the same shim', () => {
        write();
        const quoted = readFileSync(settingsPath(), 'utf8');
        rmSync(join(project, '.claude'), { recursive: true, force: true });
        const unquoted = JSON.stringify(HOOKS_JSON).replace(/\\"(\$\{CLAUDE_PLUGIN_ROOT\}[^\\]*)\\"/g, '$1');
        assert.ok(!unquoted.includes('dispatch.sh\\"'), 'fixture rewrite left a quoted command');
        writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), unquoted);
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