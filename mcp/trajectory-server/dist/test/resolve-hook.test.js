/**
 * dist/resolve-hook.mjs, the headless-shim resolver (GH 1692): it runs the
 * resolved version's router, node mcp/trajectory-server/dist/hooks.js
 * <Event> [part] [--shim].
 *   - plain mode runs the router with the event, stdin forwarded
 *   - --part passes the part; --shim passes --shim and sets TMB_SHIM_PROJECT
 *     (the project's physical path)
 *   - through the real router: --shim yields when
 *     <project>/.claude/<plugin>/sessions/<sid>.plugin-hooks exists or
 *     CLAUDE_PROJECT_DIR is another project, and decides otherwise
 *   - a --hook that names a gate (an earlier /onboard's entry), no resolvable
 *     install or a version without dist/hooks.js fails open, loudly; a missing
 *     node is the hook runner's own non-blocking command-not-found
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ROOT = resolve(PACKAGE_ROOT, '../..');
const RESOLVER = join(PACKAGE_ROOT, 'dist', 'resolve-hook.mjs');
const PAYLOAD = '{"session_id":"sess-1","tool_name":"Bash"}';
describe('resolve-hook.mjs', () => {
    let tmp;
    let claudeHome;
    let versionRoot;
    let fired;
    let project;
    let baseEnv;
    const firedLines = () => existsSync(fired) ? readFileSync(fired, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    const firedCount = () => firedLines().length;
    const lastFired = () => firedLines().at(-1);
    function resolver(args, env = {}, input = PAYLOAD) {
        return spawnSync(process.execPath, [RESOLVER, ...args], { cwd: tmp, input, encoding: 'utf8', env: { ...baseEnv, ...env } });
    }
    function writeRouter(root) {
        mkdirSync(join(root, 'mcp', 'trajectory-server', 'dist'), { recursive: true });
        writeFileSync(join(root, 'mcp', 'trajectory-server', 'dist', 'hooks.js'), `const { appendFileSync, readFileSync } = require('node:fs');
const input = readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(fired)}, JSON.stringify({ argv: process.argv.slice(2), shimProject: process.env.TMB_SHIM_PROJECT ?? null, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT, input }) + '\\n');
process.stdout.write('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"probe"}}\\n');
if (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL);
process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
`);
    }
    before(() => {
        // Without CLAUDE_PROJECT_DIR the trajectory DB is found by walking up from
        // cwd; every run starts in tmp, outside any checkout.
        tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-resolve-hook-')));
        baseEnv = { ...process.env };
        delete baseEnv.CLAUDE_PROJECT_DIR;
        delete baseEnv.TMB_SHIM_PROJECT;
        delete baseEnv.FAKE_EXIT;
        delete baseEnv.FAKE_SIGNAL;
        claudeHome = join(tmp, 'claude');
        baseEnv.CLAUDE_CONFIG_DIR = claudeHome;
        versionRoot = join(claudeHome, 'plugins', 'cache', 'mp', 'tmb', '1.0.0');
        mkdirSync(join(versionRoot, '.claude-plugin'), { recursive: true });
        writeFileSync(join(versionRoot, '.claude-plugin', 'plugin.json'), '{"name":"tmb"}\n');
        fired = join(tmp, 'fired.log');
        writeRouter(versionRoot);
        project = join(tmp, 'project');
        mkdirSync(join(project, '.claude', 'tmb', 'sessions'), { recursive: true });
        symlinkSync(project, join(tmp, 'project-link'));
    });
    after(() => {
        rmSync(tmp, { recursive: true, force: true });
    });
    it('plain mode runs the router for the event, stdin forwarded', () => {
        const r = resolver(['--marketplace', 'mp', '--hook', 'PreToolUse']);
        assert.ok(r.stdout.includes('"permissionDecision":"deny"'), 'router decision forwarded');
        assert.equal(firedCount(), 1, 'router ran once');
        assert.deepEqual(lastFired().argv, ['PreToolUse'], 'argv is the event alone');
        assert.equal(lastFired().shimProject, null, 'no TMB_SHIM_PROJECT outside --shim');
        assert.equal(lastFired().pluginRoot, versionRoot, 'CLAUDE_PLUGIN_ROOT is the resolved version');
        assert.ok(lastFired().input.includes('sess-1'), 'stdin forwarded to the router');
    });
    it("--shim --part passes the part and --shim, with the project's physical path", () => {
        const r = resolver(['--marketplace', 'mp', '--hook', 'PreToolUse', '--part', 'guard', '--shim', '--project', join(tmp, 'project-link')]);
        assert.ok(r.stdout.includes('"permissionDecision":"deny"'), 'router decision forwarded');
        assert.deepEqual(lastFired().argv, ['PreToolUse', 'guard', '--shim'], 'argv: event, part, --shim');
        assert.equal(lastFired().shimProject, realpathSync(project), 'TMB_SHIM_PROJECT exported, symlink resolved');
    });
    for (const loc of ['C', 'en_US.UTF-8']) {
        it(`a --hook naming a gate (an earlier /onboard's entry) fails open, loudly (LC_ALL=${loc})`, () => {
            for (const gate of ['git-guards', 'swe-boundary', 'trajectory-gates']) {
                const r = resolver(['--marketplace', 'mp', '--hook', gate, '--shim', '--project', project], { LC_ALL: loc });
                assert.equal(r.status, 0, `${gate}: exit 0`);
                assert.ok(r.stderr.includes('not a hook event'), `${gate}: stderr names the stale entry`);
                assert.ok(r.stderr.includes('re-run /onboard'), `${gate}: stderr names the fix`);
            }
            const r = resolver(['--marketplace', 'mp', '--hook', 'PreToolUse', '--part', 'guärd'], { LC_ALL: loc });
            assert.equal(r.status, 0, 'non-ASCII part: exit 0');
            assert.ok(r.stderr.includes('invalid --hook/--part'), 'non-ASCII part: rejected');
            assert.equal(firedCount(), 2, 'router not run');
        });
    }
    it("node missing on PATH is the hook runner's non-blocking command-not-found", () => {
        const nodeless = join(tmp, 'nodeless-bin');
        mkdirSync(nodeless);
        const command = `node ${RESOLVER} --marketplace mp --hook PreToolUse`;
        const r = spawnSync('/bin/sh', ['-c', command], { cwd: tmp, input: PAYLOAD, encoding: 'utf8', env: { ...baseEnv, PATH: nodeless } });
        assert.notEqual(r.status, 2, 'exit is not 2, so Claude Code does not block the call');
        assert.match(r.stderr, /node.*not found/, 'stderr names the missing node');
        assert.equal(r.stdout, '', 'no decision: the call goes ahead');
        assert.equal(firedCount(), 2, 'router not run');
    });
    it('forwards pass-through argv and env, and returns the router exit code (128+signal when killed)', () => {
        const r = resolver(['--marketplace', 'mp', '--hook', 'PreToolUse', 'extra-arg'], { FAKE_EXIT: '3' });
        assert.equal(r.status, 3, "the router's exit code");
        assert.deepEqual(lastFired().argv, ['PreToolUse', 'extra-arg'], 'pass-through argv after the event');
        const killed = resolver(['--marketplace', 'mp', '--hook', 'PreToolUse'], { FAKE_SIGNAL: 'SIGTERM' });
        assert.equal(killed.status, 128 + 15, '128 + SIGTERM');
        assert.equal(firedCount(), 4);
    });
    it('the manifest installPath wins over the cache, and the cache fallback takes the highest version', () => {
        const other = join(tmp, 'elsewhere', 'tmb');
        writeRouter(other);
        const manifest = join(claudeHome, 'plugins', 'installed_plugins.json');
        writeFileSync(manifest, JSON.stringify({ version: 2, plugins: { 'tmb@mp': [{ installPath: versionRoot }, { installPath: other }] } }));
        resolver(['--marketplace', 'mp', '--hook', 'PreToolUse']);
        assert.equal(lastFired().pluginRoot, other, 'last installPath of tmb@mp');
        rmSync(manifest);
        for (const v of ['1.9.0', '1.10.0', '1.10.0-rc.1'])
            writeRouter(join(claudeHome, 'plugins', 'cache', 'mp', 'tmb', v));
        resolver(['--marketplace', 'mp', '--hook', 'PreToolUse']);
        assert.equal(lastFired().pluginRoot, join(claudeHome, 'plugins', 'cache', 'mp', 'tmb', '1.10.0-rc.1'), 'highest version dir');
        for (const v of ['1.9.0', '1.10.0', '1.10.0-rc.1'])
            rmSync(join(claudeHome, 'plugins', 'cache', 'mp', 'tmb', v), { recursive: true });
        rmSync(other, { recursive: true });
    });
    it('no resolvable install fails open, loudly', () => {
        const before = firedCount();
        const r = resolver(['--marketplace', 'nowhere', '--hook', 'PreToolUse']);
        assert.equal(r.status, 0, 'exit 0');
        assert.equal(r.stderr, 'TMB resolve-hook: no active tmb version resolved (manifest + cache fallback both empty) — failing OPEN (gate skipped) for marketplace=nowhere hook=PreToolUse\n');
        const missing = resolver(['--hook', 'PreToolUse']);
        assert.equal(missing.status, 0, 'missing --marketplace: exit 0');
        assert.ok(missing.stderr.includes('missing --marketplace/--hook arg — failing OPEN'), missing.stderr);
        assert.equal(firedCount(), before, 'router not run');
    });
    it('resolved version without dist/hooks.js fails open, loudly', () => {
        const before = firedCount();
        rmSync(join(versionRoot, 'mcp', 'trajectory-server', 'dist', 'hooks.js'));
        const r = resolver(['--marketplace', 'mp', '--hook', 'PreToolUse']);
        assert.equal(r.status, 0, 'exit 0');
        assert.ok(r.stderr.includes('no router'), 'stderr names the missing router');
        assert.equal(firedCount(), before, 'router not run');
    });
    describe('the real router: the resolved version is this checkout', () => {
        const AUQ = JSON.stringify({
            hook_event_name: 'PreToolUse',
            session_id: 'sess-real',
            tool_use_id: 'tu-real',
            tool_name: 'AskUserQuestion',
            tool_input: { questions: [{ question: 'q', multiSelect: false, options: [{ label: 'one two three four five six seven eight' }] }] },
        });
        let realHome;
        before(() => {
            realHome = join(tmp, 'real-claude');
            mkdirSync(join(realHome, 'plugins'), { recursive: true });
            writeFileSync(join(realHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tmb@real': [{ scope: 'user', installPath: PLUGIN_ROOT }] } }));
        });
        const real = (env = {}) => resolver(['--marketplace', 'real', '--hook', 'PreToolUse', '--shim', '--project', project], {
            CLAUDE_CONFIG_DIR: realHome,
            TMB_INSTALLED_JSON: join(tmp, 'none.json'),
            ...env,
        }, AUQ);
        it('decides a headless session under --shim', () => {
            assert.ok(real().stdout.includes('label is 8 words'), "the group's gates ran");
            assert.ok(real({ CLAUDE_PROJECT_DIR: project }).stdout.includes('label is 8 words'), "this project's CLAUDE_PROJECT_DIR runs the gates");
        });
        it('yields to the plugin-hooks marker under --shim', () => {
            const marker = join(project, '.claude', 'tmb', 'sessions', 'sess-real.plugin-hooks');
            writeFileSync(marker, '');
            const r = real();
            assert.equal(r.status, 0, 'exit 0');
            assert.equal(r.stdout, '', 'no decision');
            rmSync(marker);
        });
        it('yields for a foreign CLAUDE_PROJECT_DIR under --shim', () => {
            const other = join(tmp, 'other');
            mkdirSync(other, { recursive: true });
            const r = real({ CLAUDE_PROJECT_DIR: other });
            assert.equal(r.status, 0, 'exit 0');
            assert.equal(r.stdout, '', 'no decision');
        });
    });
});
//# sourceMappingURL=resolve-hook.test.js.map