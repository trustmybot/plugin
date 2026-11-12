import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  claudeCommand,
  copyFilter,
  findInstalledEntry,
  installRootOf,
  isolatedEnv,
  localMarketplace,
  mcpDirDepsProblems,
  runDirs,
  stepPlan,
  targetSchemaVersion,
  isWithin,
} from './install-smoke.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'install-smoke-test-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

function fixture(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(path: string, body = ''): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

const ids = (platform: NodeJS.Platform, prebuilt = false) => stepPlan(platform, { prebuilt }).map((s) => s.id);
const SHARED_TAIL = ['A0c', 'install', 'A1', 'A2', 'A3', 'A3b', 'A3c', 'A4', 'A6', 'A7'];

test('darwin and linux run the data-dir embeddings scenarios A0d and A0e after the install', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(ids(platform), ['build', 'A0', 'A0b', 'A0d', 'A0e', ...SHARED_TAIL]);
  }
});

test('win32 replaces A0d/A0e with the MCP-dir deps contract and keeps every other assertion', () => {
  assert.deepEqual(ids('win32'), ['build', 'A0', 'A0b', 'A0d-win32', ...SHARED_TAIL]);
  const contract = stepPlan('win32').find((s) => s.id === 'A0d-win32');
  assert.match(contract?.title ?? '', /no bridge link/);
  assert.match(contract?.title ?? '', /installed MCP dir/);
});

test('--prebuilt drops only the build step', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    assert.deepEqual(ids(platform, true), ids(platform).filter((id) => id !== 'build'));
  }
});

test('isolatedEnv moves HOME, USERPROFILE, CLAUDE_CONFIG_DIR and CLAUDE_PLUGIN_DATA into the temp root', () => {
  const dirs = runDirs(join(scratch, 'run'));
  const base: NodeJS.ProcessEnv = {
    HOME: homedir(),
    USERPROFILE: homedir(),
    CLAUDE_CONFIG_DIR: join(homedir(), '.claude'),
    CLAUDE_PLUGIN_DATA: join(homedir(), '.claude', 'plugins', 'data', 'tmb'),
    CLAUDE_PLUGIN_ROOT: '/real/plugin',
    CLAUDE_PROJECT_DIR: '/real/project',
    TRAJECTORY_DB_PATH: '/real/trajectory.db',
    TMB_SKIP_MCP_DEPS_INSTALL: '1',
    PATH: '/usr/bin',
  };
  const env = isolatedEnv(base, dirs);
  for (const name of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PLUGIN_DATA']) {
    assert.ok(isWithin(dirs.root, env[name] ?? ''), `${name}=${env[name]} is outside ${dirs.root}`);
    assert.notEqual(env[name], base[name]);
  }
  assert.equal(env.HOME, env.USERPROFILE);
  assert.equal(env.CLAUDE_CONFIG_DIR, join(env.HOME ?? '', '.claude'));
  for (const name of ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'TRAJECTORY_DB_PATH', 'TMB_SKIP_MCP_DEPS_INSTALL']) {
    assert.equal(env[name], undefined, `${name} leaked from the caller`);
  }
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(base.HOME, homedir(), 'the caller env is not mutated');
});

test('every run dir, the plugin copy included, sits inside the temp root', () => {
  const dirs = runDirs(join(scratch, 'run'));
  for (const [name, dir] of Object.entries(dirs)) assert.ok(isWithin(dirs.root, dir), `${name} outside root`);
});

test('the plugin copy leaves out node_modules, .git and the top-level .claude only', () => {
  const root = join(scratch, 'src');
  const keep = copyFilter(root);
  assert.equal(keep(join(root, 'node_modules')), false);
  assert.equal(keep(join(root, 'mcp', 'trajectory-server', 'node_modules')), false);
  assert.equal(keep(join(root, '.git')), false);
  assert.equal(keep(join(root, '.claude')), false);
  assert.equal(keep(join(root, 'templates', '.claude')), true);
  assert.equal(keep(join(root, 'mcp', 'trajectory-server', 'dist')), true);
});

test('findInstalledEntry picks the tmb version entry under the plugins cache', () => {
  const cache = fixture('cache');
  touch(join(cache, 'mkt', 'other', '1.0.0', 'mcp', 'trajectory-server', 'dist', 'index.js'));
  touch(join(cache, 'mkt', 'tmb', '1.2.0', 'node_modules', 'x', 'mcp', 'trajectory-server', 'dist', 'index.js'));
  const entry = join(cache, 'mkt', 'tmb', '1.2.0', 'mcp', 'trajectory-server', 'dist', 'index.js');
  touch(entry);
  assert.equal(findInstalledEntry(cache), entry);
  assert.equal(installRootOf(entry), join(cache, 'mkt', 'tmb', '1.2.0'));
  assert.equal(findInstalledEntry(fixture('empty-cache')), undefined);
  assert.equal(findInstalledEntry(join(scratch, 'missing')), undefined);
});

test('localMarketplace points tmb at the tree under test and keeps the catalog name', () => {
  const m = localMarketplace({ name: 'trustmybot', plugins: [{ name: 'tmb', source: { source: 'url', url: 'x' } }] });
  assert.deepEqual(m, { name: 'trustmybot', plugins: [{ name: 'tmb', source: './' }] });
});

test('claudeCommand runs claude by name off win32', () => {
  assert.deepEqual(claudeCommand({ PATH: '/nowhere' }, 'darwin'), ['claude']);
  assert.deepEqual(claudeCommand({ PATH: '/nowhere' }, 'linux'), ['claude']);
});

test('claudeCommand on win32 runs the npm shim package bin, never the .cmd', () => {
  const prefix = fixture('npm-prefix');
  touch(join(prefix, 'claude.cmd'));
  const pkg = join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  touch(join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'bin/claude.exe' } }));
  assert.deepEqual(claudeCommand({ Path: `C:\\empty;${prefix}` }, 'win32'), [join(pkg, 'bin', 'claude.exe')]);

  touch(join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'cli.js' } }));
  assert.deepEqual(claudeCommand({ PATH: prefix }, 'win32', 'node.exe'), ['node.exe', join(pkg, 'cli.js')]);

  const native = fixture('native');
  touch(join(native, 'claude.exe'));
  assert.deepEqual(claudeCommand({ PATH: `${native};${prefix}` }, 'win32'), [join(native, 'claude.exe')]);
});

test('targetSchemaVersion reads the constant from db.ts', () => {
  assert.equal(targetSchemaVersion('export const TARGET_SCHEMA_VERSION = 70;\n'), 70);
  assert.throws(() => targetSchemaVersion('nothing here'), /TARGET_SCHEMA_VERSION/);
});

function win32Layout(name: string) {
  const installRoot = fixture(join(name, 'cache', 'tmb', '1.2.0'));
  const dataDir = fixture(join(name, 'data'));
  const resolved = join(installRoot, 'mcp', 'trajectory-server', 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
  touch(resolved);
  return { installRoot, dataDir, key: '3.8.1-win32-x64', resolved };
}

test('win32 contract holds: transformers in the install root, no bridge link, no data-dir install', () => {
  assert.deepEqual(mcpDirDepsProblems(win32Layout('ok')), []);
});

test('win32 contract fails on a bridge link into the data dir', () => {
  const layout = win32Layout('bridge');
  const target = fixture(join('bridge', 'data', 'deps', 'elsewhere'));
  mkdirSync(join(layout.installRoot, 'node_modules', '@huggingface'), { recursive: true });
  symlinkSync(target, join(layout.installRoot, 'node_modules', '@huggingface', 'transformers'), 'dir');
  assert.deepEqual(
    mcpDirDepsProblems(layout).map((p) => p.split(' at ')[0]),
    ['bridge link present'],
  );
});

test('win32 contract fails on a data-dir install for the key', () => {
  const layout = win32Layout('data-install');
  mkdirSync(join(layout.dataDir, 'deps', layout.key), { recursive: true });
  assert.match(mcpDirDepsProblems(layout).join('\n'), /data-dir install present/);
});

test('win32 contract fails when transformers is missing or resolves outside the install root', () => {
  const layout = win32Layout('outside');
  assert.match(mcpDirDepsProblems({ ...layout, resolved: undefined }).join('\n'), /does not resolve/);
  const outside = join(fixture('outside-pkg'), 'transformers.node.mjs');
  touch(outside);
  assert.match(mcpDirDepsProblems({ ...layout, resolved: outside }).join('\n'), /outside the install root/);
});
