#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STATES = Object.freeze(['absent', 'current', 'conflict']);
const WARMUP_COUNT = 10;
const WARM_SAMPLE_COUNT = 100;
const THRESHOLD_NS = 100_000_000;
const MCP_SHUTDOWN_GRACE_MS = 1_000;
const MCP_RESPONSE_TIMEOUT_MS = 10_000;
const ARTIFACT_PROVENANCE_FILE = '.tmb-artifact-provenance.json';

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      (key !== '--installed-plugin-root' && key !== '--output-dir') ||
      typeof value !== 'string' ||
      value.length === 0
    ) {
      throw new Error(usage());
    }
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
  }
  if (values.size !== 2) throw new Error(usage());
  const installedPluginRoot = values.get('--installed-plugin-root');
  const outputDir = values.get('--output-dir');
  if (!isAbsolute(installedPluginRoot) || !isAbsolute(outputDir)) {
    throw new Error('Both benchmark paths must be absolute.');
  }
  return { installedPluginRoot, outputDir };
}

export function nearestRank(values, percentile) {
  if (values.length === 0) throw new Error('Cannot summarize an empty sample.');
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(percentile * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

export function summarizeDurations(cold, warm) {
  if (warm.length !== WARM_SAMPLE_COUNT) {
    throw new Error(`Expected ${WARM_SAMPLE_COUNT} warm samples.`);
  }
  return {
    cold_ns: cold,
    warm_p50_ns: nearestRank(warm, 0.5),
    warm_p95_ns: nearestRank(warm, 0.95),
    warm_max_ns: Math.max(...warm),
  };
}

export function thresholdStatusFor(summaries) {
  return Object.values(summaries).some(
    (entry) => entry.warm_p95_ns > THRESHOLD_NS,
  )
    ? 'investigate'
    : 'pass';
}

export function writeEvidence(outputDir, samples, summary) {
  const samplesPath = join(
    outputDir,
    'codex-agent-materialization.samples.jsonl',
  );
  const summaryPath = join(
    outputDir,
    'codex-agent-materialization.summary.json',
  );
  writeFileSync(
    samplesPath,
    `${samples.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    { flag: 'wx' },
  );
  writeFileSync(
    summaryPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    { flag: 'wx' },
  );
  return { samplesPath, summaryPath };
}

export function parseArtifactProvenance(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Installed artifact provenance must be valid JSON.');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.source_sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.source_sha)
  ) {
    throw new Error(
      `Installed artifact ${ARTIFACT_PROVENANCE_FILE} must contain one 40-character lowercase source_sha.`,
    );
  }
  return { source_sha: value.source_sha };
}

export function readArtifactProvenance(installedPluginRoot) {
  const provenancePath = join(installedPluginRoot, ARTIFACT_PROVENANCE_FILE);
  if (!lstatSync(provenancePath).isFile()) {
    throw new Error(`Installed artifact ${ARTIFACT_PROVENANCE_FILE} must be a regular file.`);
  }
  return parseArtifactProvenance(readFileSync(provenancePath, 'utf8'));
}

export function sanitizedGitEnvironment(environment = process.env) {
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('GIT_')),
  );
  sanitized.GIT_TERMINAL_PROMPT = '0';
  sanitized.GIT_CONFIG_NOSYSTEM = '1';
  sanitized.GIT_CONFIG_GLOBAL = '/dev/null';
  sanitized.LC_ALL = 'C';
  return sanitized;
}

export function resolveOutputCandidate(installedPluginRoot, outputDir) {
  const outputParent = realpathSync(dirname(outputDir));
  const canonicalOutputCandidate = join(outputParent, basename(outputDir));
  if (isWithin(installedPluginRoot, canonicalOutputCandidate)) {
    throw new Error('--output-dir must not be inside the installed plugin artifact.');
  }
  return canonicalOutputCandidate;
}

export function assertInstalledArtifactIsolation(installedPluginRoot) {
  for (const forbiddenEntry of ['.git', 'node_modules']) {
    try {
      lstatSync(join(installedPluginRoot, forbiddenEntry));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`Installed artifact must not contain ${forbiddenEntry}.`);
  }
  recursiveEntries(installedPluginRoot);
}

export function assertArtifactMatchesSource(
  installedPluginRoot,
  sourceRoot,
  sourceSha,
) {
  const sourceHead = gitHead(sourceRoot);
  if (sourceHead !== sourceSha) {
    throw new Error(
      `Installed artifact source_sha ${sourceSha} does not match harness HEAD ${sourceHead}.`,
    );
  }
  try {
    runGit(['-C', sourceRoot, 'diff', '--quiet', 'HEAD', '--']);
  } catch {
    throw new Error(
      'The benchmark harness checkout must have no tracked changes from HEAD.',
    );
  }

  const tracked = trackedEntries(sourceRoot);
  const artifactLeaves = recursiveEntries(installedPluginRoot)
    .filter((entry) => entry.type !== 'directory')
    .filter((entry) => entry.relativePath !== ARTIFACT_PROVENANCE_FILE);
  const artifactByPath = new Map(
    artifactLeaves.map((entry) => [entry.relativePath, entry]),
  );
  const trackedPaths = new Set(tracked.map((entry) => entry.relativePath));

  const missing = tracked
    .filter((entry) => !artifactByPath.has(entry.relativePath))
    .map((entry) => entry.relativePath);
  const extra = artifactLeaves
    .filter((entry) => !trackedPaths.has(entry.relativePath))
    .map((entry) => entry.relativePath);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Installed artifact file set does not match source_sha: missing=${summarizePaths(missing)} extra=${summarizePaths(extra)}.`,
    );
  }

  for (const trackedEntry of tracked) {
    const artifactEntry = artifactByPath.get(trackedEntry.relativePath);
    const sourcePath = join(sourceRoot, trackedEntry.relativePath);
    const sourceStat = lstatSync(sourcePath);
    const sourceType = sourceStat.isSymbolicLink()
      ? 'symlink'
      : sourceStat.isFile()
        ? 'file'
        : 'unsupported';
    const sourceMode = sourceType === 'symlink'
      ? '120000'
      : sourceStat.mode & 0o111
        ? '100755'
        : '100644';
    if (
      sourceType === 'unsupported' ||
      artifactEntry.type !== sourceType ||
      trackedEntry.mode !== sourceMode ||
      artifactEntry.gitMode !== trackedEntry.mode
    ) {
      throw new Error(
        `Installed artifact entry type or mode does not match source_sha: ${trackedEntry.relativePath}.`,
      );
    }
    if (sourceType === 'symlink') {
      if (readlinkSync(sourcePath) !== artifactEntry.linkTarget) {
        throw new Error(
          `Installed artifact symlink does not match source_sha: ${trackedEntry.relativePath}.`,
        );
      }
    } else if (
      !readFileSync(sourcePath).equals(readFileSync(artifactEntry.path))
    ) {
      throw new Error(
        `Installed artifact file does not match source_sha: ${trackedEntry.relativePath}.`,
      );
    }
  }
}

async function main() {
  const { installedPluginRoot: inputRoot, outputDir } = parseArguments(
    process.argv.slice(2),
  );
  const installedPluginRoot = realpathSync(inputRoot);
  if (!statSync(installedPluginRoot).isDirectory()) {
    throw new Error('--installed-plugin-root must identify a directory.');
  }
  assertInstalledArtifactIsolation(installedPluginRoot);
  const manifest = JSON.parse(
    readFileSync(join(installedPluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
  );
  const mcpConfig = JSON.parse(
    readFileSync(join(installedPluginRoot, 'adapters', 'codex', '.mcp.json'), 'utf8'),
  )['trajectory-server'];
  const provenance = readArtifactProvenance(installedPluginRoot);
  if (
    !mcpConfig ||
    typeof mcpConfig.command !== 'string' ||
    !Array.isArray(mcpConfig.args) ||
    typeof mcpConfig.cwd !== 'string'
  ) {
    throw new Error('The installed Codex MCP configuration is invalid.');
  }

  const scriptPath = fileURLToPath(import.meta.url);
  const sourceRoot = resolve(dirname(scriptPath), '..', '..');
  assertArtifactMatchesSource(
    installedPluginRoot,
    sourceRoot,
    provenance.source_sha,
  );
  const harnessSourceSha = gitHead(sourceRoot);

  const canonicalOutputCandidate = resolveOutputCandidate(
    installedPluginRoot,
    outputDir,
  );
  mkdirSync(canonicalOutputCandidate, { recursive: false, mode: 0o755 });
  const canonicalOutputDir = realpathSync(canonicalOutputCandidate);
  if (
    canonicalOutputDir !== canonicalOutputCandidate ||
    isWithin(installedPluginRoot, canonicalOutputDir)
  ) {
    throw new Error('--output-dir could not be contained outside the installed artifact.');
  }
  const fixtureRoot = join(canonicalOutputDir, 'fixtures');
  mkdirSync(fixtureRoot);
  const isolatedHome = join(canonicalOutputDir, 'isolated-home');
  mkdirSync(isolatedHome);

  const environment = {
    plugin_sha: provenance.source_sha,
    harness_source_sha: harnessSourceSha,
    plugin_version: manifest.version,
    artifact_sha256: hashDirectory(installedPluginRoot),
    harness_sha256: sha256(readFileSync(scriptPath)),
    codex_version: commandVersion('codex', ['--version']),
    node_version: process.version,
    operating_system: platform(),
    architecture: arch(),
    file_system: fileSystemName(canonicalOutputDir),
  };

  const samples = [];
  const summaries = {};
  for (const state of STATES) {
    const project = createProject(join(fixtureRoot, state));
    if (state === 'current') {
      await withClient(
        installedPluginRoot,
        mcpConfig,
        isolatedHome,
        async (client) => {
          assertToolSuccess(
            await client.callTool({
              name: 'agent_materialization_set',
              arguments: { project_root: project, desired_state: 'present' },
            }),
          );
        },
      );
    } else if (state === 'conflict') {
      const agentsDir = join(project, '.codex', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'tmb_swe.toml'), 'name = "user_swe"\n');
    }

    await withClient(
      installedPluginRoot,
      mcpConfig,
      isolatedHome,
      async (client) => {
        const cold = await timedGet(client, project, state);
        samples.push(sampleRow(environment, state, 'cold', 1, cold));
        for (let index = 0; index < WARMUP_COUNT; index += 1) {
          await timedGet(client, project, state);
        }
        const warm = [];
        for (let index = 1; index <= WARM_SAMPLE_COUNT; index += 1) {
          const duration = await timedGet(client, project, state);
          warm.push(duration);
          samples.push(sampleRow(environment, state, 'warm', index, duration));
        }
        summaries[state] = summarizeDurations(cold, warm);
      },
    );
  }

  const thresholdStatus = thresholdStatusFor(summaries);
  const { summaryPath } = writeEvidence(canonicalOutputDir, samples, {
    environment,
    protocol: {
      states: STATES,
      warmup_count: WARMUP_COUNT,
      warm_sample_count: WARM_SAMPLE_COUNT,
      threshold_ns: THRESHOLD_NS,
      percentile_method: 'nearest-rank',
      process_lifecycle:
        'one fresh measurement MCP process per state; current uses one separate preparation process',
    },
    states: summaries,
    threshold_status: thresholdStatus,
  });
  process.stdout.write(`${summaryPath}\n`);
}

async function timedGet(client, projectRoot, expectedStatus) {
  const started = process.hrtime.bigint();
  const result = await client.callTool({
    name: 'agent_materialization_get',
    arguments: { project_root: projectRoot },
  });
  const elapsed = process.hrtime.bigint() - started;
  assertMaterializationStatus(result, expectedStatus);
  return Number(elapsed);
}

async function withClient(installedRoot, config, isolatedHome, operation) {
  const client = await openJsonRpcClient({
    command: config.command,
    args: config.args,
    cwd: join(installedRoot, config.cwd),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: isolatedHome,
      NODE_PATH: '',
    },
  });
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

export async function openJsonRpcClient(options) {
  const responseTimeoutMs =
    options.responseTimeoutMs ?? MCP_RESPONSE_TIMEOUT_MS;
  if (!Number.isInteger(responseTimeoutMs) || responseTimeoutMs <= 0) {
    throw new Error('MCP response timeout must be a positive integer.');
  }
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  let stderr = '';
  let terminalError;
  let closing = false;
  let shutdownPromise;
  const childClosed = new Promise((resolveChildClose) => {
    child.once('close', (code, signal) => resolveChildClose({ code, signal }));
  });

  const failPending = (error) => {
    terminalError ??= error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-64 * 1024);
  });
  child.on('error', (error) => failPending(error));
  child.stdin.on('error', (error) => failPending(error));
  child.on('exit', (code, signal) => {
    if (!closing || pending.size > 0) {
      const detail = stderr.trim();
      failPending(new Error(
        `Installed MCP exited before the benchmark completed (code=${String(code)}, signal=${String(signal)})${detail ? `: ${detail}` : ''}`,
      ));
    }
  });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failPending(new Error('Installed MCP returned malformed JSON-RPC output.'));
      return;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      failPending(new Error('Installed MCP returned a malformed JSON-RPC message.'));
      return;
    }
    if (!Object.hasOwn(message, 'id')) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(new Error(`MCP JSON-RPC error: ${JSON.stringify(message.error)}`));
    } else {
      request.resolve(message.result);
    }
  });

  const send = (message) => {
    if (terminalError) throw terminalError;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method, params) => new Promise((resolveRequest, rejectRequest) => {
    if (terminalError) {
      rejectRequest(terminalError);
      return;
    }
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      failPending(new Error(
        `Installed MCP did not respond to ${method} within ${responseTimeoutMs} ms.`,
      ));
    }, responseTimeoutMs);
    pending.set(id, {
      resolve: resolveRequest,
      reject: rejectRequest,
      timer,
    });
    try {
      send({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      const failedRequest = pending.get(id);
      if (failedRequest) clearTimeout(failedRequest.timer);
      pending.delete(id);
      rejectRequest(error);
    }
  });

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      closing = true;
      lines.close();
      if (!child.stdin.destroyed) child.stdin.end();

      let outcome = await waitForChildClose(
        childClosed,
        MCP_SHUTDOWN_GRACE_MS,
      );
      if (!outcome) {
        child.kill('SIGTERM');
        outcome = await waitForChildClose(
          childClosed,
          MCP_SHUTDOWN_GRACE_MS,
        );
      }
      if (!outcome) {
        child.kill('SIGKILL');
        outcome = await waitForChildClose(
          childClosed,
          MCP_SHUTDOWN_GRACE_MS,
        );
      }
      if (!outcome) {
        throw new Error('Installed MCP did not exit after forced shutdown.');
      }
      return outcome;
    })();
    return shutdownPromise;
  };

  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'tmb-scope4-materialization-benchmark',
        version: '1.0.0',
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  } catch (initializationError) {
    try {
      await shutdown();
    } catch (shutdownError) {
      throw new AggregateError(
        [initializationError, shutdownError],
        'Installed MCP initialization and cleanup both failed.',
      );
    }
    throw initializationError;
  }

  return {
    callTool: ({ name, arguments: args }) => request('tools/call', {
      name,
      arguments: args,
    }),
    async close() {
      const outcome = await shutdown();
      if (
        !terminalError &&
        (outcome.code !== 0 || outcome.signal !== null)
      ) {
        const detail = stderr.trim();
        throw new Error(
          `Installed MCP exited with code ${String(outcome.code)} and signal ${String(outcome.signal)}${detail ? `: ${detail}` : ''}`,
        );
      }
    },
  };
}

async function waitForChildClose(childClosed, timeoutMs) {
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(null), timeoutMs);
  });
  const outcome = await Promise.race([childClosed, timeout]);
  clearTimeout(timer);
  return outcome;
}

function createProject(path) {
  mkdirSync(path);
  runGit([
    '-c',
    'init.defaultBranch=test/scope4-agent-benchmark',
    'init',
    '--quiet',
    path,
  ]);
  writeFileSync(join(path, '.gitignore'), '.tmb/\n');
  writeFileSync(join(path, 'README.md'), '# Benchmark fixture\n');
  runGit([
    '-C',
    path,
    '-c',
    'user.name=Scope 4 Benchmark',
    '-c',
    'user.email=scope4-benchmark@example.com',
    'add',
    '.gitignore',
    'README.md',
  ]);
  runGit([
    '-C',
    path,
    '-c',
    'user.name=Scope 4 Benchmark',
    '-c',
    'user.email=scope4-benchmark@example.com',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  return realpathSync(path);
}

function sampleRow(environment, state, kind, index, duration) {
  return {
    plugin_sha: environment.plugin_sha,
    harness_source_sha: environment.harness_source_sha,
    artifact_sha256: environment.artifact_sha256,
    harness_sha256: environment.harness_sha256,
    codex_version: environment.codex_version,
    node_version: environment.node_version,
    operating_system: environment.operating_system,
    architecture: environment.architecture,
    file_system: environment.file_system,
    state,
    sample_type: kind,
    sample_index: index,
    duration_ns: duration,
  };
}

function assertToolSuccess(result) {
  if (result?.isError === true) {
    throw new Error(`MCP benchmark call failed: ${JSON.stringify(result.content)}`);
  }
}

export function assertMaterializationStatus(result, expectedStatus) {
  assertToolSuccess(result);
  const content = result?.content?.[0];
  if (content?.type !== 'text' || typeof content.text !== 'string') {
    throw new Error('MCP benchmark call did not return a text payload.');
  }
  let payload;
  try {
    payload = JSON.parse(content.text);
  } catch {
    throw new Error('MCP benchmark call returned malformed JSON.');
  }
  const actual = payload?.data?.overall_status;
  if (payload?.ok !== true || actual !== expectedStatus) {
    throw new Error(
      `MCP benchmark expected ${expectedStatus}, received ${String(actual)}.`,
    );
  }
}

export function hashDirectory(root) {
  const hash = createHash('sha256');
  for (const entry of recursiveEntries(root)) {
    hash.update(entry.relativePath);
    hash.update('\0');
    hash.update(entry.type);
    hash.update('\0');
    hash.update(entry.gitMode);
    hash.update('\0');
    if (entry.type === 'file') hash.update(readFileSync(entry.path));
    if (entry.type === 'symlink') hash.update(entry.linkTarget);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function recursiveEntries(root, current) {
  if (current === undefined) {
    const canonicalRoot = realpathSync(root);
    return recursiveEntries(canonicalRoot, canonicalRoot);
  }
  const entries = [];
  for (const dirent of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, dirent.name);
    const relativePath = relative(root, path);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      entries.push({
        path,
        relativePath,
        type: 'directory',
        gitMode: '040000',
      });
      entries.push(...recursiveEntries(root, path));
    } else if (stat.isFile()) {
      entries.push({
        path,
        relativePath,
        type: 'file',
        gitMode: stat.mode & 0o111 ? '100755' : '100644',
      });
    } else if (stat.isSymbolicLink()) {
      let resolvedTarget;
      try {
        resolvedTarget = realpathSync(path);
      } catch {
        throw new Error(`Installed artifact contains a broken symlink: ${relativePath}.`);
      }
      if (!isWithin(root, resolvedTarget)) {
        throw new Error(`Installed artifact symlink escapes its root: ${relativePath}.`);
      }
      entries.push({
        path,
        relativePath,
        type: 'symlink',
        gitMode: '120000',
        linkTarget: readlinkSync(path),
      });
    } else {
      throw new Error(`Installed artifact contains an unsupported file type: ${relativePath}.`);
    }
  }
  return entries.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0);
}

function trackedEntries(sourceRoot) {
  const output = runGit(['-C', sourceRoot, 'ls-files', '-s', '-z']);
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      if (tab === -1) throw new Error('Could not parse tracked source files.');
      const [mode, , stage] = record.slice(0, tab).split(' ');
      if (stage !== '0' || (mode !== '100644' && mode !== '100755' && mode !== '120000')) {
        throw new Error(`Unsupported tracked source entry: ${record.slice(tab + 1)}.`);
      }
      return { mode, relativePath: record.slice(tab + 1) };
    })
    .sort((left, right) =>
      left.relativePath < right.relativePath
        ? -1
        : left.relativePath > right.relativePath
          ? 1
          : 0);
}

function summarizePaths(paths) {
  if (paths.length === 0) return 'none';
  const visible = paths.slice(0, 5).join(',');
  return paths.length > 5 ? `${visible},...(${paths.length} total)` : visible;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitHead(root) {
  return runGit(['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

function runGit(args, options = {}) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.excludesFile=/dev/null',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { ...options, env: sanitizedGitEnvironment() },
  );
}

function commandVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

function fileSystemName(path) {
  if (platform() === 'darwin') {
    try {
      const dfLines = execFileSync('df', ['-P', path], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n');
      const device = dfLines.at(-1)?.trim().split(/\s+/)[0];
      if (device) {
        const diskInfo = execFileSync('diskutil', ['info', device], {
          encoding: 'utf8',
        });
        const bundle = diskInfo.match(/^\s*Type \(Bundle\):\s*(.+)$/m)?.[1];
        if (bundle) return bundle.trim();
      }
    } catch {
      return 'unknown';
    }
  }
  try {
    const value = execFileSync('stat', ['-f', '-c', '%T', path], {
      encoding: 'utf8',
    }).trim();
    if (value.length > 0) return value;
  } catch {
    // The host does not expose a supported filesystem-type command.
  }
  return 'unknown';
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function usage() {
  return [
    'Usage:',
    'node tests/benchmarks/codex-agent-materialization.mjs',
    '  --installed-plugin-root /absolute/path/to/fixed-sha-installed-artifact',
    '  --output-dir /absolute/path/to/disposable-evidence-dir',
  ].join('\n');
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href
  : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
