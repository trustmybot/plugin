// L0 install-smoke driver (GH 1749): the install-smoke assertions on the host it runs on,
// macOS, Linux or Windows. install-smoke.Dockerfile runs it for Linux; release-gate runs it
// host-native on macOS and Windows.
//
// Usage:
//   node --experimental-strip-types tests/l0-install/install-smoke.ts [--prebuilt]
//
// It copies the plugin tree (no node_modules, .git or .claude) into a temp root and points HOME,
// USERPROFILE, CLAUDE_CONFIG_DIR and CLAUDE_PLUGIN_DATA at dirs inside it, so the contributor's own
// ~/.claude is never read or written. Without --prebuilt it builds the payload in the copy first;
// --prebuilt trusts the copied dist/ (the Docker image built it). Needs network, bun and the
// claude CLI. Each failed assertion prints `FAIL <step>: ...` and exits 1; the temp root is removed
// on exit.

import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export type StepId =
  | 'build'
  | 'A0'
  | 'A0b'
  | 'A0d'
  | 'A0e'
  | 'A0d-win32'
  | 'A0c'
  | 'install'
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A3b'
  | 'A3c'
  | 'A4'
  | 'A6'
  | 'A7';

export interface Step {
  id: StepId;
  title: string;
}

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EMBEDDINGS_SMOKE = join(dirname(fileURLToPath(import.meta.url)), 'embeddings-data-dir-smoke.mjs');
const MCP_REL = join('mcp', 'trajectory-server');
const TRANSFORMERS = '@huggingface/transformers';
const SDK = '@modelcontextprotocol/sdk';
const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';
const BOOT_TIMEOUT_MS = 15_000;
const SEMANTIC_TIMEOUT_MS = 60_000;
const DEPS_INSTALL_TIMEOUT_MS = 300_000;
const POLL_MS = 1_000;
const USAGE = 'Usage: node --experimental-strip-types tests/l0-install/install-smoke.ts [--prebuilt]\n';

const STEPS: Record<StepId, string> = {
  build: 'bun install, then build:payload in the plugin copy, then strip node_modules',
  A0: 'cold MCP boot with zero node_modules: tools/list served, SDK inlined',
  A0b: 'claude plugin marketplace add + install, MCP boots from the installed cache with no node_modules',
  A0d: 'very cold start: empty data dir + concurrent ensure-mcp-deps-installed → embeddings ready; deps/<key>/ and the bridge in place',
  A0e: 'cold start: transformers in the plugin data dir, no bridge link → embeddings ready; no data dir → degraded',
  'A0d-win32':
    'win32 has no data-dir bridge: ensure-mcp-deps-installed with CLAUDE_PLUGIN_DATA set installs transformers into the installed MCP dir, no bridge link, nothing under deps/<key>/; embeddings ready',
  A0c: 'one ensure-mcp-deps-installed run → transformers resolves from the installed MCP dir; dist/ untouched',
  install: 'bun install --frozen-lockfile --ignore-scripts in the plugin copy',
  A1: 'mcp/trajectory-server/dist/index.js present',
  A2: 'mcp/trajectory-server/dist/schema.sql present',
  A3: 'MCP server answers tools/list with onboard_state_get',
  A3b: 'SQLite open + onboard_state_get round-tripped',
  A3c: 'discussion_search(mode=semantic): results, semantic_unavailable or cold-load timeout; no MCP error',
  A4: 'agent-line-budget lint passes in the clean install',
  A6: 'every ${CLAUDE_PLUGIN_ROOT} arg in .mcp.json resolves',
  A7: 'legacy v1 DB upgraded to TARGET_SCHEMA_VERSION; onboarded marker kept; backup written; gh_iid + gl_iid present',
};

/** The steps in run order. win32 has no data-dir bridge, so its A0d/A0e become the MCP-dir contract. */
export function stepPlan(platform: NodeJS.Platform, { prebuilt = false }: { prebuilt?: boolean } = {}): Step[] {
  const embeddings: StepId[] = platform === 'win32' ? ['A0d-win32'] : ['A0d', 'A0e'];
  const ids: StepId[] = [
    ...(prebuilt ? [] : (['build'] as StepId[])),
    'A0',
    'A0b',
    ...embeddings,
    'A0c',
    'install',
    'A1',
    'A2',
    'A3',
    'A3b',
    'A3c',
    'A4',
    'A6',
    'A7',
  ];
  return ids.map((id) => ({ id, title: STEPS[id] }));
}

export interface RunDirs {
  root: string;
  home: string;
  config: string;
  pluginData: string;
  plugin: string;
  work: string;
}

export function runDirs(root: string): RunDirs {
  const home = join(root, 'home');
  return {
    root,
    home,
    config: join(home, '.claude'),
    pluginData: join(root, 'plugin-data'),
    plugin: join(root, 'plugin'),
    work: join(root, 'work'),
  };
}

const INHERITED_PLUGIN_VARS = [
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PROJECT_DIR',
  'TRAJECTORY_DB_PATH',
  'TMB_SKIP_MCP_DEPS_INSTALL',
  'TMB_EMBED_RETRY_MS',
];

/** The base env with every home and Claude config location moved into the run's temp root. */
export function isolatedEnv(base: NodeJS.ProcessEnv, dirs: RunDirs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of INHERITED_PLUGIN_VARS) delete env[name];
  env.HOME = dirs.home;
  env.USERPROFILE = dirs.home;
  env.CLAUDE_CONFIG_DIR = dirs.config;
  env.CLAUDE_PLUGIN_DATA = dirs.pluginData;
  return env;
}

/** cpSync filter: the plugin tree as served, without dependency installs, VCS data or local Claude state. */
export function copyFilter(sourceRoot: string): (src: string) => boolean {
  const topClaude = join(sourceRoot, '.claude');
  return (src) => {
    const name = basename(src);
    if (name === 'node_modules' || name === '.git') return false;
    return src !== topClaude;
  };
}

/** The committed catalog points tmb at a remote git URL; `./` makes claude copy the tree under test. */
export function localMarketplace(manifest: Record<string, unknown>): Record<string, unknown> {
  return { ...manifest, plugins: [{ name: 'tmb', source: './' }] };
}

/** The first `<...>/tmb/<version>/mcp/trajectory-server/dist/index.js` under the plugins cache. */
export function findInstalledEntry(cacheDir: string): string | undefined {
  const tail = ['mcp', 'trajectory-server', 'dist', 'index.js'];
  const walk = (dir: string): string | undefined => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return undefined;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isFile()) {
        const parts = relative(cacheDir, path).split(sep);
        const n = parts.length;
        if (n >= tail.length + 2 && parts.slice(n - tail.length).join('/') === tail.join('/') && parts[n - tail.length - 2] === 'tmb') {
          return path;
        }
      } else if (e.isDirectory() && e.name !== 'node_modules') {
        const found = walk(path);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(cacheDir);
}

/** `<version root>` for an entry at `<version root>/mcp/trajectory-server/dist/index.js`. */
export function installRootOf(entry: string): string {
  return dirname(dirname(dirname(dirname(entry))));
}

/**
 * argv[0..] that runs the claude CLI without a shell. On win32 npm leaves only a claude.cmd shim
 * on PATH, which node cannot spawn without a shell, so the shim's package bin is run instead.
 */
export function claudeCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, execPath: string = process.execPath): string[] {
  if (platform !== 'win32') return ['claude'];
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(';')) {
    if (!dir) continue;
    const exe = join(dir, 'claude.exe');
    if (existsSync(exe)) return [exe];
    const pkgDir = join(dir, 'node_modules', ...CLAUDE_PACKAGE.split('/'));
    if (!existsSync(join(dir, 'claude.cmd')) || !existsSync(join(pkgDir, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
    if (!bin) continue;
    const target = join(pkgDir, bin);
    return /\.[cm]?js$/.test(target) ? [execPath, target] : [target];
  }
  return ['claude.exe'];
}

/** TARGET_SCHEMA_VERSION as declared in the shipped db.ts source. */
export function targetSchemaVersion(dbSource: string): number {
  const match = /TARGET_SCHEMA_VERSION = ([0-9]+)/.exec(dbSource);
  if (!match) throw new Error('TARGET_SCHEMA_VERSION not found in db.ts');
  return Number(match[1]);
}

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface McpDirDepsLayout {
  installRoot: string;
  dataDir: string;
  key: string;
  /** Where the bare transformers specifier resolves from the installed MCP dir, as a file path. */
  resolved: string | undefined;
}

/** The win32 contract: transformers lives in the install root, with no bridge link and no data-dir install. */
export function mcpDirDepsProblems({ installRoot, dataDir, key, resolved }: McpDirDepsLayout): string[] {
  const problems: string[] = [];
  if (resolved === undefined) problems.push(`${TRANSFORMERS} does not resolve from ${join(installRoot, MCP_REL)}`);
  else if (!isWithin(realpathSync(installRoot), realpathSync(resolved))) {
    problems.push(`${TRANSFORMERS} resolves outside the install root ${installRoot}: ${resolved}`);
  }
  const bridge = join(installRoot, 'node_modules', ...TRANSFORMERS.split('/'));
  let bridgeIsLink = false;
  try {
    bridgeIsLink = lstatSync(bridge).isSymbolicLink();
  } catch {
    bridgeIsLink = false;
  }
  if (bridgeIsLink) problems.push(`bridge link present at ${bridge}`);
  const dataInstall = join(dataDir, 'deps', key);
  if (existsSync(dataInstall)) problems.push(`data-dir install present at ${dataInstall}`);
  return problems;
}

class StepFailure extends Error {}

function fail(message: string, detail?: string): never {
  throw new StepFailure(detail ? `${message}\n${detail}` : message);
}

function run(argv: string[], options: SpawnSyncOptions & { label: string }): void {
  const [command, ...args] = argv as [string, ...string[]];
  const r = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (r.error) fail(`${options.label}: could not start ${command}: ${r.error.message}`);
  if (r.status !== 0) fail(`${options.label}: ${argv.join(' ')} exited ${r.status ?? r.signal}`);
}

function capture(argv: string[], options: SpawnSyncOptions): { ok: boolean; out: string } {
  const [command, ...args] = argv as [string, ...string[]];
  const r = spawnSync(command, args, { encoding: 'utf8', ...options });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`;
  return { ok: !r.error && r.status === 0, out };
}

function stripNodeModules(root: string): void {
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(dir, e.name);
      if (e.name === 'node_modules') rmSync(path, { recursive: true, force: true });
      else walk(path);
    }
  };
  walk(root);
}

interface JsonRpcResponse {
  id?: number;
  result?: { content?: { text?: string }[]; isError?: boolean; tools?: { name: string }[] };
  error?: unknown;
}

interface McpServer {
  request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse | undefined>;
  initialize(): Promise<void>;
  log(): string;
  stop(): void;
}

function startMcp(entry: string, env: NodeJS.ProcessEnv, cwd: string): McpServer {
  const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', entry], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let exited = false;
  const pending = new Map<number, (r: JsonRpcResponse | undefined) => void>();
  child.on('error', (err) => {
    stderr += `spawn error: ${err.message}\n`;
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  child.on('exit', () => {
    exited = true;
    for (const resolveWaiter of pending.values()) resolveWaiter(undefined);
    pending.clear();
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    stdout += `${line}\n`;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    }
  });
  let nextId = 1;
  const send = (msg: unknown) => {
    if (!exited) child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  const request = (method: string, params: unknown, timeoutMs: number) => {
    const id = nextId++;
    return new Promise<JsonRpcResponse | undefined>((done) => {
      if (exited) return done(undefined);
      const timer = setTimeout(() => {
        pending.delete(id);
        done(undefined);
      }, timeoutMs);
      pending.set(id, (r) => {
        clearTimeout(timer);
        done(r);
      });
      send({ jsonrpc: '2.0', id, method, params });
    });
  };
  return {
    request,
    async initialize() {
      const r = await request(
        'initialize',
        { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'install-smoke', version: '0' } },
        BOOT_TIMEOUT_MS,
      );
      if (!r) fail('MCP initialize got no response', this.log());
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    log: () => `--- stdout ---\n${stdout}--- stderr ---\n${stderr}`,
    stop() {
      child.kill();
    },
  };
}

function toolText(r: JsonRpcResponse | undefined): string {
  return r?.result?.content?.[0]?.text ?? '';
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>, timeoutMs = BOOT_TIMEOUT_MS) {
  return server.request('tools/call', { name, arguments: args }, timeoutMs);
}

/** A0 / A0b / A3: one boot serves tools/list with onboard_state_get and never misses the SDK. */
async function assertColdBoot(entry: string, env: NodeJS.ProcessEnv, cwd: string, where: string): Promise<void> {
  const server = startMcp(entry, { ...env, TRAJECTORY_DB_PATH: ':memory:' }, cwd);
  try {
    await server.initialize();
    const tools = await server.request('tools/list', {}, BOOT_TIMEOUT_MS);
    const log = server.log();
    if (log.split('\n').some((l) => l.includes('ERR_MODULE_NOT_FOUND') && l.includes(SDK))) {
      fail(`${where}: ERR_MODULE_NOT_FOUND for ${SDK} — dist/index.js is not self-contained (#647)`, log);
    }
    if (!tools?.result?.tools?.some((t) => t.name === 'onboard_state_get')) {
      fail(`${where}: tools/list did not include onboard_state_get`, log);
    }
  } finally {
    server.stop();
  }
}

function resolveFrom(dir: string, env: NodeJS.ProcessEnv): string | undefined {
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `process.stdout.write(import.meta.resolve(${JSON.stringify(TRANSFORMERS)}))`],
    { cwd: dir, env, encoding: 'utf8' },
  );
  return r.status === 0 && r.stdout ? fileURLToPath(r.stdout) : undefined;
}

function hashTree(dir: string): string {
  const lines: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) lines.push(`${relative(dir, path)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  };
  walk(dir);
  return lines.sort().join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the real ensure-mcp-deps-installed gate on the install root and waits for its MCP-dir install lock. */
async function runDepsGate(installRoot: string, env: NodeJS.ProcessEnv, project: string): Promise<string> {
  const db = join(project, '.claude', 'tmb', 'trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  writeFileSync(db, '');
  const hookEnv = { ...env, CLAUDE_PLUGIN_ROOT: installRoot, CLAUDE_PROJECT_DIR: project, TRAJECTORY_DB_PATH: db };
  const hook = capture([process.execPath, join(installRoot, MCP_REL, 'dist', 'hooks.js'), 'ensure-mcp-deps-installed'], {
    env: hookEnv,
    cwd: project,
    input: `${JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'l0-install-smoke' })}\n`,
  });
  const logPath = join(project, '.claude', 'tmb', 'logs', 'mcp-deps-install.log');
  const installLog = () => `hook output: ${hook.out.trim() || '(none)'}\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : `(no install log at ${logPath})`}`;
  if (!hook.ok) fail('ensure-mcp-deps-installed did not exit 0', installLog());
  const lock = join(installRoot, MCP_REL, '.deps-install.lock');
  const deadline = Date.now() + DEPS_INSTALL_TIMEOUT_MS;
  while (existsSync(lock) && Date.now() < deadline) await sleep(POLL_MS);
  if (existsSync(lock)) fail(`the hook's background install did not finish within ${DEPS_INSTALL_TIMEOUT_MS / 1000} s`, installLog());
  return installLog();
}

function runtimeDepsKey(mcpDir: string): string {
  const manifest = JSON.parse(readFileSync(join(mcpDir, 'runtime-deps', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  return `${manifest.dependencies[TRANSFORMERS]}-${process.platform}-${process.arch}`;
}

interface Context {
  dirs: RunDirs;
  env: NodeJS.ProcessEnv;
  entry?: string;
}

function installedEntry(ctx: Context): string {
  if (!ctx.entry) fail('no installed entry: A0b did not run');
  return ctx.entry;
}

function sourceEntry(ctx: Context): string {
  return join(ctx.dirs.plugin, MCP_REL, 'dist', 'index.js');
}

/** The env A0c runs the gate in: CLAUDE_PLUGIN_DATA unset, the MCP-dir install path the Docker image always took. */
function withoutDataDir(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.CLAUDE_PLUGIN_DATA;
  return copy;
}

async function onboardState(entry: string, env: NodeJS.ProcessEnv, cwd: string, db: string): Promise<{ response?: JsonRpcResponse; log: string }> {
  const server = startMcp(entry, { ...env, TRAJECTORY_DB_PATH: db }, cwd);
  try {
    await server.initialize();
    const response = await callTool(server, 'onboard_state_get', { agent: 'bro' });
    return { response, log: server.log() };
  } finally {
    server.stop();
  }
}

const STEP_RUNNERS: Record<StepId, (ctx: Context) => Promise<void> | void> = {
  build(ctx) {
    const cwd = ctx.dirs.plugin;
    run(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], { cwd, env: ctx.env, label: 'bun install' });
    run(['bun', 'install', '--frozen-lockfile'], { cwd: join(cwd, 'dashboard'), env: ctx.env, label: 'dashboard bun install' });
    run(['bun', 'run', 'build:payload'], { cwd, env: ctx.env, label: 'build:payload' });
    stripNodeModules(cwd);
  },

  async A0(ctx) {
    if (existsSync(join(ctx.dirs.plugin, MCP_REL, 'node_modules'))) fail('node_modules present — the cold-MCP assertion must run on a cold tree');
    await assertColdBoot(sourceEntry(ctx), ctx.env, ctx.dirs.work, 'cold MCP boot (no node_modules)');
  },

  async A0b(ctx) {
    const claude = claudeCommand(ctx.env, process.platform);
    const version = capture([...claude, '--version'], { env: ctx.env });
    if (!version.ok) fail(`claude CLI not runnable as ${claude.join(' ')}`, version.out);
    const manifestPath = join(ctx.dirs.plugin, '.claude-plugin', 'marketplace.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify(localMarketplace(manifest), null, 2));
    if (existsSync(join(ctx.dirs.plugin, MCP_REL, 'node_modules'))) fail('node_modules present before claude plugin install — it must run on a cold tree');

    const add = capture([...claude, 'plugin', 'marketplace', 'add', ctx.dirs.plugin], { env: ctx.env, cwd: ctx.dirs.work });
    if (!add.ok || !add.out.includes('Successfully added marketplace')) fail(`claude plugin marketplace add ${ctx.dirs.plugin} failed`, add.out);
    const target = `tmb@${String(manifest.name)}`;
    const install = capture([...claude, 'plugin', 'install', target], { env: ctx.env, cwd: ctx.dirs.work });
    if (!install.ok || !install.out.includes('Successfully installed plugin')) fail(`claude plugin install ${target} failed`, install.out);

    const cache = join(ctx.dirs.config, 'plugins', 'cache');
    const entry = findInstalledEntry(cache);
    if (!entry) fail(`installed dist/index.js not found under ${cache}`);
    console.log(`Installed MCP entrypoint: ${entry}`);
    stripNodeModules(installRootOf(entry));
    ctx.entry = entry;
    await assertColdBoot(entry, ctx.env, ctx.dirs.work, 'MCP booted from the claude plugin install location');
  },

  A0d(ctx) {
    run([process.execPath, EMBEDDINGS_SMOKE, '--scenario', 'very-cold', '--entry', installedEntry(ctx), '--data-dir', ctx.dirs.pluginData], {
      env: ctx.env,
      label: 'very cold start: embeddings did not reach ready after ensure-mcp-deps-installed (GH 1748)',
    });
  },

  A0e(ctx) {
    run([process.execPath, EMBEDDINGS_SMOKE, '--scenario', 'cold', '--entry', installedEntry(ctx), '--data-dir', ctx.dirs.pluginData], {
      env: ctx.env,
      label: 'cold start: embeddings did not load transformers from the plugin data dir (GH 1748)',
    });
  },

  async 'A0d-win32'(ctx) {
    const installRoot = installRootOf(installedEntry(ctx));
    const mcpDir = join(installRoot, MCP_REL);
    stripNodeModules(installRoot);
    if (resolveFrom(mcpDir, ctx.env)) fail(`${TRANSFORMERS} resolves from ${mcpDir} before the hook ran — the step would prove nothing`);
    const log = await runDepsGate(installRoot, ctx.env, join(ctx.dirs.work, 'a0d-win32-project'));
    const problems = mcpDirDepsProblems({
      installRoot,
      dataDir: ctx.dirs.pluginData,
      key: runtimeDepsKey(mcpDir),
      resolved: resolveFrom(mcpDir, ctx.env),
    });
    if (problems.length > 0) fail(problems.join('; '), log);

    const project = join(ctx.dirs.work, 'a0d-win32-server');
    mkdirSync(project, { recursive: true });
    const server = startMcp(installedEntry(ctx), { ...ctx.env, CLAUDE_PLUGIN_ROOT: installRoot, TRAJECTORY_DB_PATH: join(project, 'trajectory.db') }, project);
    try {
      await server.initialize();
      const deadline = Date.now() + DEPS_INSTALL_TIMEOUT_MS;
      let state = 'unknown';
      while (Date.now() < deadline) {
        await callTool(server, 'discussion_search', { agent: 'bro', query: 'embeddings smoke', mode: 'semantic', k: 1 }, SEMANTIC_TIMEOUT_MS);
        const doctor = toolText(await callTool(server, 'trajectory_doctor', { agent: 'bro' }, SEMANTIC_TIMEOUT_MS));
        state = doctor ? String((JSON.parse(doctor) as { embeddings?: { state?: string } }).embeddings?.state) : 'no response';
        if (state === 'ready') return;
        await sleep(POLL_MS);
      }
      fail(`embeddings still ${state} after ${DEPS_INSTALL_TIMEOUT_MS / 1000} s with transformers in the MCP dir`, server.log());
    } finally {
      server.stop();
    }
  },

  async A0c(ctx) {
    const installRoot = realpathSync(installRootOf(installedEntry(ctx)));
    const mcpDir = join(installRoot, MCP_REL);
    const env = withoutDataDir(ctx.env);
    stripNodeModules(installRoot);
    if (resolveFrom(mcpDir, env)) fail(`${TRANSFORMERS} resolves from ${mcpDir} before the hook ran — A0c would prove nothing`);
    const before = hashTree(join(mcpDir, 'dist'));
    const log = await runDepsGate(installRoot, env, join(ctx.dirs.work, 'a0c-project'));
    const resolved = resolveFrom(mcpDir, env);
    if (!resolved) fail(`${TRANSFORMERS} does not resolve from ${mcpDir} after one hook run (GH 1669)`, log);
    console.log(`transformers from ${mcpDir} → ${resolved}`);
    if (!isWithin(installRoot, realpathSync(resolved))) fail(`transformers resolved outside the install root (${installRoot}): ${resolved}`);
    if (hashTree(join(mcpDir, 'dist')) !== before) {
      fail('the installed dist/ changed during the dependency install — the root postinstall build ran in the plugin cache', log);
    }
  },

  install(ctx) {
    run(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], { cwd: ctx.dirs.plugin, env: ctx.env, label: 'bun install' });
  },

  A1(ctx) {
    if (!existsSync(sourceEntry(ctx))) fail('mcp/trajectory-server/dist/index.js missing after install');
  },

  A2(ctx) {
    if (!existsSync(join(ctx.dirs.plugin, MCP_REL, 'dist', 'schema.sql'))) fail('dist/schema.sql missing — the build did not copy the schema');
  },

  async A3(ctx) {
    await assertColdBoot(sourceEntry(ctx), ctx.env, ctx.dirs.work, 'MCP server after install');
  },

  async A3b(ctx) {
    const { response, log } = await onboardState(sourceEntry(ctx), ctx.env, ctx.dirs.work, join(ctx.dirs.work, 'smoke-test.db'));
    if (!response || response.error || response.result?.isError || !toolText(response).includes('first_run')) {
      fail('onboard_state_get call failed — DB open or first write broken', log);
    }
  },

  async A3c(ctx) {
    const server = startMcp(sourceEntry(ctx), { ...ctx.env, TRAJECTORY_DB_PATH: join(ctx.dirs.work, 'smoke-semantic.db') }, ctx.dirs.work);
    try {
      await server.initialize();
      const r = await callTool(server, 'discussion_search', { agent: 'bro', query: 'storage backend interface', mode: 'semantic', k: 3 }, SEMANTIC_TIMEOUT_MS);
      if (r?.error) fail('discussion_search(mode=semantic) returned an MCP error payload', server.log());
    } finally {
      server.stop();
    }
  },

  A4(ctx) {
    run([process.execPath, '--test', join('tests', 'l1-lint', 'agent-line-budget.test.mjs')], {
      cwd: ctx.dirs.plugin,
      env: ctx.env,
      label: 'agent-line-budget lint failed in the clean install',
    });
  },

  A6(ctx) {
    const mcp = JSON.parse(readFileSync(join(ctx.dirs.plugin, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    for (const arg of mcp.mcpServers['trajectory-server']?.args ?? []) {
      if (!arg.includes('${CLAUDE_PLUGIN_ROOT}')) continue;
      const path = arg.replace('${CLAUDE_PLUGIN_ROOT}', ctx.dirs.plugin);
      if (!existsSync(path)) fail(`.mcp.json arg references a missing path: ${arg} → ${path}`);
    }
  },

  async A7(ctx) {
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = join(ctx.dirs.work, 'legacy-v1.db');
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, plugin_version TEXT NOT NULL);
      CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE identity (id INTEGER PRIMARY KEY);
      INSERT INTO plugin_meta VALUES (1, 1, '0.5.0');
      INSERT INTO identity VALUES (1);`);
    seed.close();

    const { response, log } = await onboardState(sourceEntry(ctx), ctx.env, ctx.dirs.work, dbPath);
    const expected = targetSchemaVersion(readFileSync(join(ctx.dirs.plugin, MCP_REL, 'src', 'db.ts'), 'utf8'));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const actual = (db.prepare('SELECT schema_version FROM plugin_meta').get() as { schema_version: number }).schema_version;
      if (actual !== expected) fail(`schema_version=${actual} after upgrade, expected ${expected}`, log);
      const onboarded = db.prepare("SELECT value_json FROM plugin_config WHERE key='onboarded'").get() as { value_json: string } | undefined;
      if (onboarded?.value_json !== 'true') fail('onboarded marker not translated from the legacy identity table', log);
      const columns = (db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map((c) => c.name);
      for (const column of ['gh_iid', 'gl_iid']) if (!columns.includes(column)) fail(`${column} column missing after the v1 upgrade`, log);
    } finally {
      db.close();
    }
    const backups = readdirSync(ctx.dirs.work).filter((f) => f.startsWith('legacy-v1.db.pre-v') && f.endsWith('.bak'));
    if (backups.length === 0) fail('no pre-migration .bak file written', log);
    if (!/first_run[^a-zA-Z]+false/.test(toolText(response))) fail('post-upgrade onboard_state_get did not return first_run=false', log);
  },
};

function prepare(prebuilt: boolean): Context {
  const dirs = runDirs(realpathSync(mkdtempSync(join(tmpdir(), 'tmb-l0-install-'))));
  for (const dir of [dirs.config, dirs.pluginData, dirs.work]) mkdirSync(dir, { recursive: true });
  cpSync(PLUGIN_ROOT, dirs.plugin, { recursive: true, filter: copyFilter(PLUGIN_ROOT) });
  console.log(`temp root:   ${dirs.root}`);
  console.log(`plugin copy: ${dirs.plugin}${prebuilt ? ' (prebuilt dist/)' : ''}`);
  return { dirs, env: isolatedEnv(process.env, dirs) };
}

export async function main(args: string[]): Promise<number> {
  if (args.some((a) => a !== '--prebuilt')) {
    process.stderr.write(USAGE);
    return 2;
  }
  const prebuilt = args.includes('--prebuilt');
  const ctx = prepare(prebuilt);
  try {
    for (const step of stepPlan(process.platform, { prebuilt })) {
      console.log(`\n=== ${step.id}: ${step.title} ===`);
      try {
        await STEP_RUNNERS[step.id](ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`❌ FAIL ${step.id}: ${message}`);
        return 1;
      }
      console.log(`✓ ${step.id}: ${step.title}`);
    }
    console.log(`\n✓ Layer 0 install-smoke: all assertions passed on ${process.platform}/${process.arch}`);
    return 0;
  } finally {
    rmSync(ctx.dirs.root, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
