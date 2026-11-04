// Explicit L0 installer check; importing this module does not install a plugin.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

interface SmokeOptions {
  artifactRoot?: string;
  codex?: { executable: string; args?: string[] };
  env?: NodeJS.ProcessEnv;
  scratchParent?: string;
  commandTimeoutMs?: number;
}

const prefix = 'codex-plugin-surface-smoke';

function fail(message: string): never {
  throw new Error(`${prefix}: ${message}`);
}

function requireRegular(path: string, directory: boolean): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || (directory ? !stat.isDirectory() : !stat.isFile())) {
    fail(`expected a regular ${directory ? 'directory' : 'file'}: ${path}`);
  }
}

function inventory(root: string, strict: boolean): { files: string[]; directories: string[] } {
  const files: string[] = [];
  const directories: string[] = [''];
  function visit(path: string): void {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        directories.push(child);
        visit(child);
      } else if (entry.isFile()) {
        files.push(child);
      } else if (strict) {
        fail(`non-regular entry in Codex payload: ${join(root, child)}`);
      }
    }
  }
  visit('');
  return { files: files.sort(), directories: directories.sort() };
}

function compareTrees(source: string, installed: string, strict: boolean): void {
  const expected = inventory(source, strict);
  const actual = inventory(installed, strict);
  if (strict && !isDeepStrictEqual(expected.directories, actual.directories)) {
    fail(`directory inventory changed for ${source}`);
  }
  if (!isDeepStrictEqual(expected.files, actual.files)) {
    fail(`regular-file inventory changed for ${source}`);
  }
  for (const path of expected.files) compareBytes(join(source, path), join(installed, path));
}

function compareBytes(source: string, installed: string): void {
  if (!readFileSync(source).equals(readFileSync(installed))) fail(`installed bytes changed for ${source}`);
}

function directories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function stringField(value: unknown, key: string): string {
  const result = field(value, key);
  if (typeof result !== 'string' || result.length === 0) fail(`installer returned no ${key}`);
  return result;
}

export function runCodexPluginSurfaceSmoke(options: SmokeOptions = {}): string {
  const env = options.env ?? process.env;
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs <= 0) fail('command timeout must be a positive integer');
  const artifact = realpathSync(options.artifactRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));
  for (const path of ['.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', 'commands', 'skills']) {
    if (!existsSync(join(artifact, path))) fail(`artifact is missing ${join(artifact, path)}`);
  }
  const parent = realpathSync(options.scratchParent ?? tmpdir());
  // Creation must succeed before any command or cleanup can use the owned path.
  const home = mkdtempSync(join(parent, 'tmb-codex-plugin-surface.'));
  const codex = options.codex ?? { executable: env.CODEX_BIN || 'codex' };
  function invoke(args: string[]): string {
    const result = spawnSync(codex.executable, [...(codex.args ?? []), ...args], {
      env: { ...env, CODEX_HOME: home },
      encoding: 'utf8',
      timeout: commandTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    if (result.error || result.status !== 0) {
      fail(`Codex ${args.join(' ')} failed: ${result.error?.message || result.stderr.trim() || result.signal || `exit ${result.status}`}`);
    }
    return result.stdout;
  }
  try {
    const marketplace = stringField(JSON.parse(invoke(['plugin', 'marketplace', 'add', artifact, '--json'])), 'marketplaceName');
    const installed = realpathSync(stringField(JSON.parse(invoke(['plugin', 'add', `tmb@${marketplace}`, '--json'])), 'installedPath'));
    const withinCache = relative(join(home, 'plugins', 'cache'), installed);
    if (!withinCache || withinCache === '..' || withinCache.startsWith(`..${sep}`) || isAbsolute(withinCache)) {
      fail(`installer returned an out-of-home cache path: ${installed}`);
    }

    for (const path of ['.codex-plugin', 'adapters', 'adapters/codex', 'adapters/codex/skills', 'hooks', 'hooks/codex', 'mcp', 'mcp/trajectory-server', 'mcp/trajectory-server/dist']) {
      for (const root of [artifact, installed]) requireRegular(join(root, path), true);
    }
    for (const path of ['.codex-plugin/plugin.json', 'adapters/codex/.mcp.json', 'hooks/codex/hooks.json', 'mcp/trajectory-server/dist/codex.js', 'mcp/trajectory-server/dist/schema.sql']) {
      for (const root of [artifact, installed]) requireRegular(join(root, path), false);
      compareBytes(join(artifact, path), join(installed, path));
    }
    const manifest = readJson(join(installed, '.codex-plugin/plugin.json'));
    if (!isDeepStrictEqual(field(manifest, 'commands'), []) ||
        field(manifest, 'skills') !== './adapters/codex/skills/' ||
        field(manifest, 'mcpServers') !== './adapters/codex/.mcp.json' ||
        field(manifest, 'hooks') !== './hooks/codex/hooks.json') {
      fail('unexpected Codex manifest routing');
    }
    if (!isDeepStrictEqual(readJson(join(installed, 'hooks/codex/hooks.json')), { hooks: {} })) fail('Codex Hooks must remain empty');
    if (!isDeepStrictEqual(readJson(join(installed, 'adapters/codex/.mcp.json')), {
      'trajectory-server': { command: 'node', args: ['--experimental-sqlite', 'mcp/trajectory-server/dist/codex.js'], cwd: '.' },
    })) fail('unexpected Codex MCP configuration');

    const skills = directories(join(installed, 'adapters/codex/skills'));
    if (!isDeepStrictEqual(skills, ['tmb-agent-setup', 'tmb-bro'])) fail(`unexpected Codex Skill directories:\n${skills.join('\n')}`);
    if (existsSync(join(installed, '.codex-plugin/migrated-command-skills')) ||
        inventory(installed, false).directories.some(path => path.split(sep).at(-1)?.startsWith('source-command-'))) {
      fail('Claude commands migrated into Codex Skills');
    }
    for (const path of ['.codex-plugin', 'adapters/codex', 'hooks/codex']) compareTrees(join(artifact, path), join(installed, path), true);
    if (!isDeepStrictEqual(directories(join(artifact, 'skills')), directories(join(installed, 'skills')))) {
      fail('root Claude Skill directories changed during installation');
    }
    for (const path of ['commands', 'skills']) compareTrees(join(artifact, path), join(installed, path), false);
    const version = invoke(['--version']).trim();
    return `${prefix}: PASS\n  Codex: ${version}\n  Codex Skills: ${skills.join(' ')}\n  Codex metadata, adapter and Hook trees: directory inventory and regular-file bytes preserved\n  Codex runtime and schema: regular-file bytes preserved; Hooks remain empty\n  Claude commands/ and skills/: regular files and Skill directories preserved\n  source-command-* migrations: absent\n`;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) fail('usage: node codex-plugin-surface-smoke.js [artifact-root]');
    process.stdout.write(runCodexPluginSurfaceSmoke({ artifactRoot: process.argv[2] }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
