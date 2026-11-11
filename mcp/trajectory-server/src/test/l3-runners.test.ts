/**
 * The L3 MCP runner (tests/l3-integration/mcp/run.mjs) in node:test (GH 1692),
 * spawned unchanged on planted test files: the summary names each failing file
 * with its last lines, the TMPDIR footprint assertion fires on a file a test
 * leaves behind, another session's entries in the footprint root
 * (TMB_TMP_FOOTPRINT_ROOT, here under the sandbox) are only a warning, and the
 * sqlite3 shim refuses the real project's .claude/tmb/, failing the run.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeSandbox, PLUGIN_ROOT, type Sandbox } from './hook-sandbox.js';
import { has } from './git-push-guard-l3.js';

const MCP_RUNNER = join(PLUGIN_ROOT, 'tests/l3-integration/mcp/run.mjs');
const CHECKOUT = realpathSync(PLUGIN_ROOT);
const PID = process.pid;

interface RunnerRun {
  out: string;
  rc: number | null;
}

/** Everything a runner wrote to stdout and stderr (a `2>&1`), trailing newlines gone. */
const out = (stdout: string, stderr: string) => (stdout + stderr).replace(/\n+$/, '');

/** The lines from "Failing test files:" on (a `sed -n '/^Failing test files:/,$p'`). */
function summaryOf(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('Failing test files:'));
  return start === -1 ? '' : lines.slice(start).join('\n');
}

describe('l3 runners', () => {
  let sb: Sandbox;
  let work: string;
  let env: NodeJS.ProcessEnv;
  let shimDir: string;
  let footprintRoot: string;
  let foreign: string;

  function cleanupForeign(): void {
    if (foreign) rmSync(foreign, { recursive: true, force: true });
  }

  /** <dir> holding each named file with its body. */
  function plant(name: string, files: Record<string, string>): string {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
    return dir;
  }

  function run(runner: string, extra: NodeJS.ProcessEnv): RunnerRun {
    const r = spawnSync('node', [runner], { env: { ...env, ...extra }, cwd: PLUGIN_ROOT, encoding: 'utf8', timeout: 300_000 });
    if (r.error) throw r.error;
    return { out: out(r.stdout, r.stderr), rc: r.status };
  }

  /** Runs <runner> in the background, plants a foreign entry in the footprint root a second in, and waits for it. */
  async function runWithForeign(runner: string, extra: NodeJS.ProcessEnv): Promise<RunnerRun> {
    const child = spawn('node', [runner], { env: { ...env, ...extra }, cwd: PLUGIN_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const done = new Promise<number | null>((resolve) => child.on('close', resolve));
    await sleep(1000);
    mkdirSync(foreign);
    const rc = await done;
    cleanupForeign();
    return { out: out(stdout, stderr), rc };
  }

  before(() => {
    sb = makeSandbox('l3-runners');
    work = join(sb.dir, 'work');
    env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_|TMB_|NODE_TEST_CONTEXT$)/.test(k)));
    env.TMPDIR = sb.tmp;
    footprintRoot = join(sb.dir, 'footprint-root');
    mkdirSync(footprintRoot);
    env.TMB_TMP_FOOTPRINT_ROOT = footprintRoot;
    foreign = join(footprintRoot, `tmb-foreign-${PID}`);
    shimDir = plant('live-db', {
      'probe.test.sh': `sqlite3 :memory: 'select 41 + 1'\nsqlite3 -readonly "${CHECKOUT}/.claude/tmb/shim-probe.db" 'select 1' || echo "probe refused"\n`,
    });
    plant('mcp', {
      'broken.test.mjs':
        "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('planted mcp failure', () => { assert.equal('planted-actual', 'planted-expected'); });\n",
      'leak.test.sh': 'touch "$TMPDIR/planted-mcp-leak"\n',
      'slow.test.mjs': "import { test } from 'node:test';\ntest('slow pass', async () => { await new Promise((r) => setTimeout(r, 2500)); });\n",
    });
  });

  after(() => {
    cleanupForeign();
    sb.remove();
  });

  const mcp = (file: string) => join(work, 'mcp', file);

  it('mcp runner: summary names the failing node test file with its lines', () => {
    const r = run(MCP_RUNNER, { L3_MCP_TEST_FILES: mcp('broken.test.mjs'), L3_MCP_TEST_SCRIPTS: '' });
    assert.equal(r.rc, 1, 'a failing node test file exits 1');
    const summary = summaryOf(r.out);
    has(summary, 'FAIL broken.test.mjs — last 10 lines:', 'summary names the failing file');
    has(summary, 'planted mcp failure', "summary carries the failing test's lines");
    has(r.out, 'FAIL files: broken.test.mjs', 'final line names the failing file');
  });

  it('mcp runner: TMPDIR assertion fires on a planted file', () => {
    const r = run(MCP_RUNNER, { L3_MCP_TEST_FILES: mcp('broken.test.mjs'), L3_MCP_TEST_SCRIPTS: mcp('leak.test.sh') });
    assert.equal(r.rc, 1, 'a file left in TMPDIR exits 1');
    has(r.out, 'FAIL footprint: the L3 MCP suite left files in TMPDIR:', 'TMPDIR leak reported');
    has(r.out, '$TMPDIR/planted-mcp-leak', 'the planted file is named');
  });

  it('mcp runner: a concurrent foreign entry is a warning, a TMPDIR leak still fails', async () => {
    const r = await runWithForeign(MCP_RUNNER, { L3_MCP_TEST_FILES: mcp('slow.test.mjs'), L3_MCP_TEST_SCRIPTS: mcp('leak.test.sh') });
    assert.equal(r.rc, 1, 'the TMPDIR leak still fails the run');
    has(r.out, 'FAIL footprint: the L3 MCP suite left files in TMPDIR:', 'TMPDIR leak reported');
    has(r.out, `warning: ${footprintRoot} gained entries not named for this run`, 'foreign growth is a warning');
    has(r.out, `${foreign}\n`, 'the planted foreign entry is named');
    has(r.out, `footprint: ${footprintRoot} gained no entries from this run`, 'no own footprint-root leak');
  });

  it('mcp runner: the sqlite3 shim refuses the real project DB dir and fails the run', () => {
    const r = run(MCP_RUNNER, { L3_MCP_TEST_FILES: mcp('slow.test.mjs'), L3_MCP_TEST_SCRIPTS: join(shimDir, 'probe.test.sh') });
    assert.equal(r.rc, 1, 'a refused sqlite3 call exits 1');
    has(r.out, 'FAIL live DB: the L3 MCP suite ran sqlite3 against the real project DB (1 refusals', 'the runner fails with the refusal list');
  });
});
