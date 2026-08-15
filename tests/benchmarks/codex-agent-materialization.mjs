#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const STATES = Object.freeze(['absent', 'current', 'conflict']);
const WARMUP_COUNT = 10;
const WARM_SAMPLE_COUNT = 100;
const THRESHOLD_NS = 100_000_000;
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

async function main() {
  const { installedPluginRoot: inputRoot, outputDir } = parseArguments(
    process.argv.slice(2),
  );
  const installedPluginRoot = realpathSync(inputRoot);
  if (!statSync(installedPluginRoot).isDirectory()) {
    throw new Error('--installed-plugin-root must identify a directory.');
  }
  const manifest = JSON.parse(
    readFileSync(join(installedPluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
  );
  const mcpConfig = JSON.parse(
    readFileSync(join(installedPluginRoot, 'adapters', 'codex', '.mcp.json'), 'utf8'),
  )['trajectory-server'];
  const provenance = parseArtifactProvenance(
    readFileSync(join(installedPluginRoot, ARTIFACT_PROVENANCE_FILE), 'utf8'),
  );
  if (
    !mcpConfig ||
    typeof mcpConfig.command !== 'string' ||
    !Array.isArray(mcpConfig.args) ||
    typeof mcpConfig.cwd !== 'string'
  ) {
    throw new Error('The installed Codex MCP configuration is invalid.');
  }

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

  const scriptPath = fileURLToPath(import.meta.url);
  const sourceRoot = resolve(dirname(scriptPath), '..', '..');
  const environment = {
    plugin_sha: provenance.source_sha,
    harness_source_sha: gitHead(sourceRoot),
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
      process_lifecycle: 'one fresh installed-cache MCP process per state',
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
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: join(installedRoot, config.cwd),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: isolatedHome,
      NODE_PATH: '',
    },
    stderr: 'pipe',
  });
  const client = new Client({
    name: 'tmb-scope4-materialization-benchmark',
    version: '1.0.0',
  });
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close();
  }
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

function hashDirectory(root) {
  const hash = createHash('sha256');
  for (const file of recursiveFiles(root)) {
    const rel = relative(root, file);
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function recursiveFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...recursiveFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
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
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
