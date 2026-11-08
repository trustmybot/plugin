#!/usr/bin/env node
// Layer 2: MCP integration tests. Spawns the real MCP server as a subprocess
// and exercises the actual JSON-RPC stdio protocol — catches bugs that
// unit tests (which call handlers directly) miss: schema drift, protocol
// plumbing, role-enforcement at the wire level.
//
// L4 workflow-simulation flows are run separately by run-all.ts via bun test
// (canonical). Both share the same harness + spawn the real MCP server.
// --experimental-sqlite is needed on Node 22 (no-op on 24+) for any direct
// node:sqlite use the test files might add.
//
// Footprint: the suite runs against an empty temp HOME with no inherited
// plugin root, so no server spawned here can reach the real ~/.claude, and
// TMPDIR is a fresh dir under that HOME. Afterwards HOME must hold nothing but
// that TMPDIR, TMPDIR nothing but the runner's own logs, and /tmp must have
// gained no entry named for this run (tests/lib/tmp-footprint.mjs).
// The embedding model cache is a shared user cache, not TMB state: keep using
// the real one so the suite never re-downloads the model.
//
// Live DB: hooks spawned by the suite see a sqlite3 shim first on PATH that
// refuses (and records) any argument under the real project's .claude/tmb/
// (tests/lib/live-db-shim.mjs); one refusal fails the suite.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { liveDbShimCheck, liveDbShimStart } from '../../lib/live-db-shim.mjs';
import { tmpFootprintCheck, tmpFootprintParent, tmpFootprintStart } from '../../lib/tmp-footprint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '../../..');
const SUITE = 'the L3 MCP suite';

const out = (s) => writeSync(1, s);
const err = (s) => writeSync(2, s);
const statusOf = (code, signal) => (signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));

if (!existsSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/index.js'))) {
  out('Building MCP server before integration tests...\n');
  const b = spawnSync('bun', ['run', 'build'], { cwd: join(PLUGIN_ROOT, 'mcp/trajectory-server'), stdio: 'inherit' });
  if (b.error || b.status !== 0) process.exit(b.error ? 127 : statusOf(b.status, b.signal));
}

const env = process.env;
const home = env.HOME ?? '';
env.TMB_MODEL_CACHE_DIR = env.TMB_MODEL_CACHE_DIR || env.HF_HOME || `${home}/.cache/huggingface`;
const runId = tmpFootprintStart('l3-mcp');
const FOOTPRINT_HOME = mkdtempSync(`${tmpFootprintParent()}/${runId}-home.`);
const RUN_TMPDIR = join(FOOTPRINT_HOME, 'tmp');
const RUNNER_LOGS = join(RUN_TMPDIR, 'l3-mcp-runner');
mkdirSync(RUNNER_LOGS, { recursive: true });
// mise shims resolve tools from the real install + config; their own state and
// caches go to a throwaway dir, not the footprint HOME.
const TOOL_STATE = mkdtempSync(`${tmpFootprintParent()}/${runId}-tools.`);

function cleanup() {
  rmSync(FOOTPRINT_HOME, { recursive: true, force: true });
  rmSync(TOOL_STATE, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cleanup();
    process.exit(128 + constants.signals[sig]);
  });
}

env.MISE_DATA_DIR = env.MISE_DATA_DIR || `${home}/.local/share/mise`;
env.MISE_CONFIG_DIR = env.MISE_CONFIG_DIR || `${home}/.config/mise`;
env.MISE_STATE_DIR = join(TOOL_STATE, 'mise-state');
env.MISE_CACHE_DIR = join(TOOL_STATE, 'mise-cache');
delete env.CLAUDE_PLUGIN_ROOT;
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CONFIG_DIR;
// Server startup runs the cheatcode reconcile, which shells out to the claude CLI; the CLI writes .claude.json under HOME, so the suite pins the documented bypass.
env.TMB_DISABLE_CHEATCODE_HEALTHCHECK = '1';

liveDbShimStart(PLUGIN_ROOT, join(RUNNER_LOGS, 'live-db-shim'));

const words = (s) => s.split(/\s+/).filter(Boolean);
const tests = env.L3_MCP_TEST_FILES
  ? words(env.L3_MCP_TEST_FILES)
  : readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join(HERE, f));
const scripts = env.L3_MCP_TEST_SCRIPTS === undefined ? [] : words(env.L3_MCP_TEST_SCRIPTS);
const childEnv = { ...env, HOME: FOOTPRINT_HOME, TMPDIR: RUN_TMPDIR };

/** Runs <cmd> with stdout+stderr merged, teed to the runner's stdout and <log>; resolves to its exit status. */
function tee(cmd, args, log) {
  const fd = openSync(log, 'w');
  const child = spawn(cmd, args, { cwd: PLUGIN_ROOT, env: childEnv, stdio: ['inherit', 'pipe', 'pipe'] });
  const write = (chunk) => {
    out(chunk);
    writeSync(fd, chunk);
  };
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  return new Promise((done) => {
    child.on('error', () => {
      closeSync(fd);
      done(127);
    });
    child.on('close', (code, signal) => {
      closeSync(fd);
      done(statusOf(code, signal));
    });
  });
}

let exitCode;
try {
  exitCode = await main();
} finally {
  cleanup();
}
process.exit(exitCode);

async function main() {
  let rc = 0;
  const failed = [];
  const nodeLog = join(RUNNER_LOGS, 'node-test.log');
  rc = await tee('node', ['--experimental-sqlite', '--test', '--test-reporter', 'spec', ...tests], nodeLog);
  if (rc !== 0) {
    for (const line of readFileSync(nodeLog, 'utf8').split('\n')) {
      const m = /^test at (.*):\d+:\d+$/.exec(line);
      if (!m) continue;
      const name = m[1].replace(/^file:\/\//, '').replace(/.*\//, '');
      if (!failed.includes(name)) failed.push(name);
    }
    if (failed.length === 0) failed.push('node --test (no failing file reported)');
  }
  for (const script of scripts) {
    const name = basename(script);
    if ((await tee('bash', [script], join(RUNNER_LOGS, `${name}.log`))) !== 0) {
      rc = 1;
      failed.push(name);
    }
  }

  let footprintFail = false;
  const leaked = walk(FOOTPRINT_HOME, RUN_TMPDIR).map((p) => `$HOME${p.slice(FOOTPRINT_HOME.length)}`);
  if (leaked.length) {
    err(`FAIL footprint: ${SUITE} wrote under HOME:\n${leaked.join('\n')}\n`);
    footprintFail = true;
  } else {
    out(`footprint: HOME untouched by ${SUITE}\n`);
  }
  const leakedTmp = walk(RUN_TMPDIR, RUNNER_LOGS).map((p) => `$TMPDIR${p.slice(RUN_TMPDIR.length)}`);
  if (leakedTmp.length) {
    err(`FAIL footprint: ${SUITE} left files in TMPDIR:\n${leakedTmp.join('\n')}\n`);
    footprintFail = true;
  } else {
    out(`footprint: TMPDIR left clean by ${SUITE}\n`);
  }
  if (!tmpFootprintCheck(SUITE, FOOTPRINT_HOME, TOOL_STATE)) footprintFail = true;
  if (!liveDbShimCheck(SUITE)) footprintFail = true;

  // Summary: every failing file with its last 10 lines — for a node test file,
  // the last 10 lines of its entries in node's "failing tests" report, stack
  // frames dropped.
  if (failed.length) {
    out('\nFailing test files:\n');
    for (const name of failed) {
      out(`\nFAIL ${name} — last 10 lines:\n`);
      const own = join(RUNNER_LOGS, `${name}.log`);
      const lines = existsSync(own) ? textLines(readFileSync(own, 'utf8')) : failingReport(readFileSync(nodeLog, 'utf8'), name);
      for (const line of lines.slice(-10)) out(`  | ${line}\n`);
    }
    out(`\nFAIL files: ${failed.join(' ')}\n`);
  }

  return footprintFail ? 1 : rc;
}

/** Every path under <root> in pre-order, <prune> and what is under it left out (a `find -path <prune> -prune -o -print`). */
function walk(root, prune) {
  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (p === prune) continue;
      found.push(p);
      if (e.isDirectory()) visit(p);
    }
  };
  visit(root);
  return found;
}

function textLines(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** <name>'s entries in node's "✖ failing tests:" report, stack frames dropped. */
function failingReport(log, name) {
  const kept = [];
  let report = false;
  let keep = false;
  for (const line of textLines(log)) {
    if (line.startsWith('✖ failing tests:')) {
      report = true;
      continue;
    }
    if (!report) continue;
    if (line.startsWith('test at ')) keep = line.includes(`/${name}:`) || line.includes(`at ${name}:`);
    if (keep && !/^\s+at /.test(line)) kept.push(line);
  }
  return kept;
}
