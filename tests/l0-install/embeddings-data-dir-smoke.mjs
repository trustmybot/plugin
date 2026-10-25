// Embeddings reach ready in both L0 start scenarios (GH 1748).
//
//   node embeddings-data-dir-smoke.mjs --scenario cold|very-cold
//        [--entry <mcp/trajectory-server/dist/index.js>]
//        [--transformers <@huggingface/transformers package dir>]   (cold, without --data-dir)
//        [--data-dir <CLAUDE_PLUGIN_DATA>]
//
// Defaults: <plugin root>/mcp/trajectory-server/dist/index.js and
// <plugin root>/mcp/trajectory-server/node_modules/@huggingface/transformers.
//
// Both scenarios copy the plugin the entry belongs to (dist/, package.json,
// runtime-deps/, .claude-plugin/plugin.json) to a temp root with no
// node_modules, so the bare specifier does not resolve from the server, and
// boot it over MCP stdio with a temp DB.
//
//   cold       a new plugin version in a fresh cache dir with no bridge link,
//              while CLAUDE_PLUGIN_DATA already holds deps/<key>/ with
//              transformers (a temp data dir linked to --transformers, or an
//              existing --data-dir). No hook runs. trajectory_doctor must
//              report embeddings ready within 180 s, failing at once on
//              degraded. Negative control: the same boot with
//              CLAUDE_PLUGIN_DATA unset must degrade.
//   very-cold  nothing installed anywhere: an empty data dir (temp, or a
//              --data-dir that must be empty and is kept for a later cold
//              run). The server and the real ensure-mcp-deps-installed gate
//              (node dist/hooks.js, what dispatch.sh runs) start together with
//              the same CLAUDE_PLUGIN_DATA, as at SessionStart. Embeddings must
//              reach ready within 300 s; a transient degraded is allowed. Then
//              deps/<key>/ must be installed and the bridge link must exist.
//
// Prints every check and every embeddings state transition; exits non-zero on
// any failed expectation. The model cache is the default TMB_MODEL_CACHE_DIR.

import { spawn, spawnSync } from 'node:child_process';
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
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const COLD_TIMEOUT_MS = 180_000;
const VERY_COLD_TIMEOUT_MS = 300_000;
const POLL_MS = 1_000;
const PACKAGE = '@huggingface/transformers';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values: opts } = parseArgs({
  options: {
    scenario: { type: 'string' },
    entry: { type: 'string' },
    transformers: { type: 'string' },
    'data-dir': { type: 'string' },
  },
});
if (opts.scenario !== 'cold' && opts.scenario !== 'very-cold') {
  console.error('usage: embeddings-data-dir-smoke.mjs --scenario cold|very-cold [--entry <dist/index.js>] [--transformers <pkg dir>] [--data-dir <dir>]');
  process.exit(2);
}
const scenario = opts.scenario;
const entry = resolve(opts.entry ?? join(repoRoot, 'mcp', 'trajectory-server', 'dist', 'index.js'));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), `tmb-embed-${scenario}-`)));
const children = new Set();

function cleanup() {
  for (const c of children) c.kill();
  rmSync(scratch, { recursive: true, force: true });
}

function fail(message) {
  console.error(`FAIL [${scenario}]: ${message}`);
  cleanup();
  process.exit(1);
}

function check(message) {
  console.log(`ok [${scenario}] ${message}`);
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

if (!existsSync(entry)) fail(`server entry not found: ${entry}`);
const sourceMcp = dirname(dirname(entry));
const sourceRoot = dirname(dirname(sourceMcp));
const pinned = JSON.parse(readFileSync(join(sourceMcp, 'runtime-deps', 'package.json'), 'utf8')).dependencies[PACKAGE];
const key = `${pinned}-${process.platform}-${process.arch}`;
console.log(`scenario:           ${scenario}`);
console.log(`server entry:       ${entry}`);
console.log(`runtime-deps key:   ${key}`);

const pluginCopy = join(scratch, 'plugin');
const mcpCopy = join(pluginCopy, 'mcp', 'trajectory-server');
cpSync(join(sourceMcp, 'dist'), join(mcpCopy, 'dist'), { recursive: true });
cpSync(join(sourceMcp, 'package.json'), join(mcpCopy, 'package.json'));
cpSync(join(sourceMcp, 'runtime-deps'), join(mcpCopy, 'runtime-deps'), { recursive: true });
cpSync(join(sourceRoot, '.claude-plugin', 'plugin.json'), join(pluginCopy, '.claude-plugin', 'plugin.json'));
console.log(`plugin copy:        ${pluginCopy}`);

const probe = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', `process.stdout.write(import.meta.resolve(${JSON.stringify(PACKAGE)}))`],
  { cwd: mcpCopy, encoding: 'utf8' },
);
if (probe.status === 0) fail(`${PACKAGE} resolves from ${mcpCopy} (${probe.stdout}) — the smoke would prove nothing`);
check(`bare ${PACKAGE} does not resolve from the server copy`);

function project(label) {
  const dir = join(scratch, `project-${label}`);
  mkdirSync(join(dir, '.claude', 'tmb'), { recursive: true });
  return { dir, db: join(dir, '.claude', 'tmb', 'trajectory.db') };
}

function childEnv(proj, dataDir) {
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: pluginCopy,
    CLAUDE_PROJECT_DIR: proj.dir,
    TRAJECTORY_DB_PATH: proj.db,
  };
  delete env.TMB_EMBED_RETRY_MS;
  delete env.TMB_SKIP_MCP_DEPS_INSTALL;
  if (dataDir === undefined) delete env.CLAUDE_PLUGIN_DATA;
  else env.CLAUDE_PLUGIN_DATA = dataDir;
  return env;
}

function bootServer(label, env, cwd) {
  const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', join(mcpCopy, 'dist', 'index.js')], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    }
  });
  child.on('exit', (code, signal) => {
    if (children.has(child)) fail(`${label}: server exited (${code ?? signal})\n${stderr}`);
  });
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((res) => {
      pending.set(id, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  const call = async (name, args) => {
    const res = await request('tools/call', { name, arguments: args });
    const text = res.result?.content?.[0]?.text ?? '';
    if (res.error || res.result?.isError) fail(`${label}: ${name} failed: ${JSON.stringify(res.error ?? text)}`);
    return JSON.parse(text);
  };
  return {
    stderr: () => stderr,
    call,
    async init() {
      await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'embeddings-data-dir-smoke', version: '0' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    stop() {
      children.delete(child);
      child.kill();
    },
  };
}

function describe(e) {
  return e?.state === 'degraded' ? `degraded (${e.reason})` : String(e?.state);
}

/**
 * Polls trajectory_doctor until `done(embeddings)`; prints every state
 * transition. With `searching`, each poll also runs a semantic
 * discussion_search: an embed call is what re-attempts a degraded model.
 */
async function watchEmbeddings(label, server, { timeoutMs, done, onDegraded, searching = false }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    if (searching) await server.call('discussion_search', { agent: 'bro', query: 'embeddings smoke', mode: 'semantic', k: 1 });
    const embeddings = (await server.call('trajectory_doctor', { agent: 'bro' })).embeddings;
    const seen = describe(embeddings);
    if (seen !== last) {
      console.log(`  [${label}] embeddings → ${seen}`);
      last = seen;
    }
    if (done(embeddings)) return embeddings;
    if (embeddings?.state === 'degraded') onDegraded?.(embeddings);
    if (Date.now() > deadline) fail(`${label}: embeddings still ${seen} after ${timeoutMs / 1000} s\n${server.stderr()}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function isEmptyOrAbsent(dir) {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

async function cold() {
  let dataDir = opts['data-dir'] && resolve(opts['data-dir']);
  const depsPackage = (dir) => join(dir, 'deps', key, 'node_modules', PACKAGE);
  if (dataDir) {
    if (!existsSync(join(depsPackage(dataDir), 'package.json'))) fail(`--data-dir ${dataDir} holds no ${PACKAGE} for ${key}`);
  } else {
    const transformersDir = resolve(opts.transformers ?? join(repoRoot, 'mcp', 'trajectory-server', 'node_modules', PACKAGE));
    if (!existsSync(join(transformersDir, 'package.json'))) fail(`no ${PACKAGE} package at ${transformersDir} (run bun install)`);
    dataDir = join(scratch, 'plugin-data');
    mkdirSync(dirname(depsPackage(dataDir)), { recursive: true });
    symlinkSync(realpathSync(transformersDir), depsPackage(dataDir), 'dir');
    console.log(`transformers:       ${transformersDir}`);
  }
  console.log(`CLAUDE_PLUGIN_DATA: ${dataDir}`);
  console.log(`data-dir package:   ${depsPackage(dataDir)}`);
  if (existsSync(join(pluginCopy, 'node_modules'))) fail(`${pluginCopy}/node_modules exists — there must be no bridge link`);
  check('data dir holds the package and the new version has no bridge link');

  const positiveProject = project('cold');
  const positive = bootServer('cold', childEnv(positiveProject, dataDir), positiveProject.dir);
  await positive.init();
  await watchEmbeddings('cold', positive, {
    timeoutMs: COLD_TIMEOUT_MS,
    done: (e) => e?.state === 'ready',
    onDegraded: (e) => fail(`with CLAUDE_PLUGIN_DATA set, embeddings degraded: ${e.reason}`),
  });
  positive.stop();
  check('with CLAUDE_PLUGIN_DATA holding the package and no bridge link, embeddings reach ready');

  const negativeProject = project('no-data-dir');
  const negative = bootServer('no-data-dir', childEnv(negativeProject, undefined), negativeProject.dir);
  await negative.init();
  const degraded = await watchEmbeddings('no-data-dir', negative, {
    timeoutMs: COLD_TIMEOUT_MS,
    done: (e) => e?.state === 'ready' || e?.state === 'degraded',
  });
  negative.stop();
  if (degraded.state !== 'degraded') fail(`with CLAUDE_PLUGIN_DATA unset, embeddings are ${degraded.state}, expected degraded`);
  check(`with CLAUDE_PLUGIN_DATA unset, embeddings degrade: ${degraded.reason}`);
  console.log('✓ cold start: transformers from the plugin data dir, no bridge link → embeddings ready; no data dir → degraded');
}

async function veryCold() {
  const dataDir = opts['data-dir'] ? resolve(opts['data-dir']) : join(scratch, 'plugin-data');
  if (!isEmptyOrAbsent(dataDir)) fail(`--data-dir ${dataDir} is not empty — very cold start needs an empty data dir`);
  mkdirSync(dataDir, { recursive: true });
  console.log(`CLAUDE_PLUGIN_DATA: ${dataDir} (empty)`);
  if (existsSync(join(pluginCopy, 'node_modules'))) fail(`${pluginCopy}/node_modules exists before the hook ran`);
  check('empty data dir and no node_modules in the plugin copy');

  const proj = project('very-cold');
  const env = childEnv(proj, dataDir);
  const server = bootServer('very-cold', env, proj.dir);
  const hooksEntry = join(mcpCopy, 'dist', 'hooks.js');
  const hook = spawn(process.execPath, [hooksEntry, 'ensure-mcp-deps-installed'], { cwd: proj.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(hook);
  let hookOut = '';
  hook.stdout.on('data', (d) => {
    hookOut += d;
  });
  hook.stderr.on('data', (d) => {
    hookOut += d;
  });
  const hookExit = new Promise((res) => hook.on('exit', (code) => res(code)));
  hook.stdin.end(`${JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'l0-very-cold', source: 'startup' })}\n`);
  await server.init();
  const hookCode = await hookExit;
  children.delete(hook);
  console.log(`  [very-cold] ensure-mcp-deps-installed exit ${hookCode}: ${hookOut.trim() || '(no output)'}`);
  if (hookCode !== 0) fail(`ensure-mcp-deps-installed exited ${hookCode}`);

  const started = Date.now();
  const log = join(proj.dir, '.claude', 'tmb', 'logs', 'mcp-deps-install.log');
  const installLog = () => (existsSync(log) ? readFileSync(log, 'utf8') : `(no install log at ${log})`);
  await watchEmbeddings('very-cold', server, {
    timeoutMs: VERY_COLD_TIMEOUT_MS,
    done: (e) => e?.state === 'ready',
    searching: true,
  }).catch((e) => fail(`${e}\n${installLog()}`));
  server.stop();
  check(`embeddings reach ready ${Math.round((Date.now() - started) / 1000)} s after the hook started`);

  const lock = join(dataDir, 'deps', '.install.lock');
  const lockDeadline = started + VERY_COLD_TIMEOUT_MS;
  while (existsSync(lock) && Date.now() < lockDeadline) await new Promise((r) => setTimeout(r, POLL_MS));
  if (existsSync(lock)) fail(`the install worker still holds ${lock}\n${installLog()}`);

  const installDir = join(dataDir, 'deps', key);
  if (!existsSync(join(installDir, '.installed-at'))) fail(`${installDir} is not a finished install\n${installLog()}`);
  const installed = JSON.parse(readFileSync(join(installDir, 'node_modules', PACKAGE, 'package.json'), 'utf8')).version;
  if (installed !== pinned) fail(`${installDir} holds ${PACKAGE}@${installed}, expected ${pinned}`);
  check(`${installDir} holds ${PACKAGE}@${installed}`);

  const bridge = join(pluginCopy, 'node_modules', PACKAGE);
  let isLink = false;
  try {
    isLink = lstatSync(bridge).isSymbolicLink();
  } catch {
    fail(`no bridge link at ${bridge}\n${installLog()}`);
  }
  if (!isLink) fail(`${bridge} is not a symlink`);
  const target = realpathSync(bridge);
  if (!within(realpathSync(dataDir), target)) fail(`bridge ${bridge} → ${target}, outside the data dir`);
  check(`bridge ${bridge} → ${target}`);
  console.log('✓ very cold start: empty data dir + concurrent ensure-mcp-deps-installed → embeddings ready; deps/<key>/ and the bridge in place');
}

if (scenario === 'cold') await cold();
else await veryCold();
cleanup();
