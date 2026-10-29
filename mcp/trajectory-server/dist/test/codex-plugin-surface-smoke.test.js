// Exercise the smoke script through an offline installer test double, not a live Codex host.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(root, 'tests/l0-install/codex-plugin-surface-smoke.sh');
const files = {
    '.agents/plugins/marketplace.json': '{"name":"fixture","plugins":[]}\n',
    '.codex-plugin/plugin.json': JSON.stringify({
        name: 'tmb', version: '1.1.0', commands: [],
        mcpServers: './adapters/codex/.mcp.json',
        hooks: './hooks/codex/hooks.json',
        skills: './adapters/codex/skills/',
    }) + '\n',
    'adapters/codex/.mcp.json': JSON.stringify({
        'trajectory-server': {
            command: 'node',
            args: ['--experimental-sqlite', 'mcp/trajectory-server/dist/codex.js'],
            cwd: '.',
        },
    }) + '\n',
    'hooks/codex/hooks.json': '{"hooks":{}}\n',
    'adapters/codex/skills/tmb-bro/SKILL.md': '# Planning fixture\n',
    'adapters/codex/skills/tmb-bro/agents/openai.yaml': 'allow_implicit_invocation: false\n',
    'adapters/codex/skills/tmb-agent-setup/SKILL.md': '# Agent setup fixture\n',
    'mcp/trajectory-server/dist/codex.js': '// Runtime fixture; never executed.\n',
    'mcp/trajectory-server/dist/schema.sql': '-- Schema fixture; never executed.\n',
    'commands/help.md': '# Claude command fixture\n',
    'skills/example/SKILL.md': '# Claude Skill fixture\n',
};
function runSmoke(mutation, sourceOverrides = {}) {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-codex-smoke-test-')));
    const artifact = join(fixture, 'artifact with spaces');
    const scratch = join(fixture, 'scratch');
    const isolatedHome = join(fixture, 'home');
    const fakeCodex = join(fixture, 'codex-test-double.mjs');
    const sourceFiles = { ...files, ...sourceOverrides };
    try {
        for (const dir of [artifact, scratch, isolatedHome])
            mkdirSync(dir);
        for (const [path, content] of Object.entries(sourceFiles)) {
            mkdirSync(dirname(join(artifact, path)), { recursive: true });
            writeFileSync(join(artifact, path), content);
        }
        writeFileSync(join(scratch, 'keep.txt'), 'unowned sibling\n');
        writeFileSync(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, cpSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
const artifact = ${JSON.stringify(artifact)};
const mutation = ${JSON.stringify(mutation ?? null)};
const args = process.argv.slice(2);
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  process.stdout.write(JSON.stringify({ marketplaceName: 'fixture' }));
} else if (args[0] === 'plugin' && args[1] === 'add') {
  const installedPath = join(process.env.CODEX_HOME, 'plugins/cache/fixture/tmb/1.1.0');
  mkdirSync(installedPath, { recursive: true });
  cpSync(artifact, installedPath, { recursive: true });
  if (mutation?.kind === 'append') appendFileSync(join(installedPath, mutation.path), '\\n');
  if (mutation?.kind === 'remove') rmSync(join(installedPath, mutation.path), { recursive: true });
  if (mutation?.kind === 'mkdir') mkdirSync(join(installedPath, mutation.path), { recursive: true });
  if (mutation?.kind === 'symlink') {
    const target = join(process.env.CODEX_HOME, 'replacement');
    renameSync(join(installedPath, mutation.path), target);
    symlinkSync(target, join(installedPath, mutation.path));
  }
  process.stdout.write(JSON.stringify({ installedPath }));
} else if (args[0] === '--version') {
  process.stdout.write('offline-installer-test-double\\n');
} else {
  process.stderr.write('unexpected installer invocation\\n');
  process.exit(97);
}
`, { mode: 0o755 });
        const run = spawnSync('bash', [script, artifact], {
            cwd: fixture,
            env: { ...process.env, HOME: isolatedHome, TMPDIR: scratch, CODEX_BIN: fakeCodex, TMB_DISABLE_REMOTE_SYNC: '1' },
            encoding: 'utf8',
            timeout: 15_000,
        });
        assert.equal(run.error, undefined, String(run.error));
        for (const [path, content] of Object.entries(sourceFiles)) {
            assert.equal(readFileSync(join(artifact, path), 'utf8'), content, `source artifact changed: ${path}`);
        }
        assert.deepEqual(readdirSync(scratch), ['keep.txt'], 'smoke removes only its own temporary Codex home');
        assert.equal(readFileSync(join(scratch, 'keep.txt'), 'utf8'), 'unowned sibling\n');
        assert.deepEqual(readdirSync(isolatedHome), [], 'installer must use the temporary CODEX_HOME');
        return { status: run.status, output: run.stdout + run.stderr };
    }
    finally {
        rmSync(fixture, { recursive: true, force: true });
    }
}
describe('Codex install-smoke integrity checks (offline test double, GH 1187)', () => {
    it('accepts an unchanged installed artifact', () => {
        const run = runSmoke();
        assert.equal(run.status, 0, run.output);
        assert.match(run.output, /codex-plugin-surface-smoke: PASS/);
        assert.match(run.output, /offline-installer-test-double/);
    });
    for (const path of [
        '.codex-plugin/plugin.json',
        'adapters/codex/.mcp.json',
        'hooks/codex/hooks.json',
        'mcp/trajectory-server/dist/codex.js',
        'mcp/trajectory-server/dist/schema.sql',
        'adapters/codex/skills/tmb-bro/SKILL.md',
        'adapters/codex/skills/tmb-bro/agents/openai.yaml',
    ]) {
        for (const kind of ['append', 'remove', 'symlink']) {
            it(`rejects ${kind} of installed ${path}`, () => {
                const run = runSmoke({ path, kind });
                assert.notEqual(run.status, 0, run.output);
                assert.doesNotMatch(run.output, /codex-plugin-surface-smoke: PASS/);
            });
        }
    }
    for (const mutation of [
        { path: 'adapters/codex/unexpected-entry.mjs', kind: 'append' },
        { path: 'adapters/codex/skills/tmb-bro/unexpected-empty-dir', kind: 'mkdir' },
        { path: 'adapters', kind: 'symlink' },
        { path: 'mcp', kind: 'symlink' },
        { path: 'adapters/codex/skills', kind: 'symlink' },
        { path: 'commands/help.md', kind: 'append' },
        { path: 'skills/example/SKILL.md', kind: 'append' },
        { path: 'skills/unexpected', kind: 'mkdir' },
        { path: 'adapters/codex/skills/unexpected', kind: 'mkdir' },
        { path: 'source-command-unexpected', kind: 'mkdir' },
    ]) {
        it(`rejects ${mutation.kind} of installed ${mutation.path}`, () => {
            const run = runSmoke(mutation);
            assert.notEqual(run.status, 0, run.output);
            assert.doesNotMatch(run.output, /codex-plugin-surface-smoke: PASS/);
        });
    }
    for (const [label, path, content] of [
        ['active Hooks', 'hooks/codex/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'false' }] }] } })],
        ['another Hook manifest', '.codex-plugin/plugin.json', files['.codex-plugin/plugin.json'].replace('./hooks/codex/hooks.json', './hooks/hooks.json')],
        ['another MCP configuration', '.codex-plugin/plugin.json', files['.codex-plugin/plugin.json'].replace('./adapters/codex/.mcp.json', './.mcp.json')],
        ['another MCP command', 'adapters/codex/.mcp.json', files['adapters/codex/.mcp.json'].replace('"node"', '"sh"')],
        ['another MCP working directory', 'adapters/codex/.mcp.json', files['adapters/codex/.mcp.json'].replace('"cwd":"."', '"cwd":".."')],
        ['the Claude runtime', 'adapters/codex/.mcp.json', files['adapters/codex/.mcp.json'].replace('dist/codex.js', 'dist/index.js')],
        ['an extra MCP server', 'adapters/codex/.mcp.json', JSON.stringify({ ...JSON.parse(files['adapters/codex/.mcp.json']), unexpected: { command: 'node', args: [] } })],
    ]) {
        it(`rejects a byte-identical installed artifact configured with ${label}`, () => {
            const run = runSmoke(undefined, { [path]: content });
            assert.notEqual(run.status, 0, run.output);
            assert.doesNotMatch(run.output, /codex-plugin-surface-smoke: PASS/);
        });
    }
});
//# sourceMappingURL=codex-plugin-surface-smoke.test.js.map