/**
 * The L3 runners (tests/l3-integration/hooks/run.sh and mcp/run.sh), the l3
 * bash suite's cases in node:test (GH 1692), each runner spawned unchanged on
 * planted test files: the summary names each failing file with its last lines,
 * verbose mode prints per-file durations, the TMPDIR footprint assertion fires
 * on a file a test leaves behind, the /tmp check fails only on entries named
 * for the run itself (another session's entries are a warning), and the
 * sqlite3 shim refuses the real project's .claude/tmb/ (failing the run) while
 * passing every other call through.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeSandbox, PLUGIN_ROOT, type Sandbox } from './hook-sandbox.js';
import { has, hasNot } from './git-push-guard-l3.js';

const runner = (suite: string) => join(PLUGIN_ROOT, 'tests/l3-integration', suite, 'run.sh');
const HOOKS_RUNNER = runner('hooks');
const MCP_RUNNER = runner('mcp');
const CHECKOUT = realpathSync(PLUGIN_ROOT);
const PID = process.pid;
const FOREIGN = `/tmp/tmb-foreign-${PID}`;
const FOREIGN_CWD = `/tmp/claude-f00d${PID}-cwd`;

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

function cleanupForeign(): void {
  rmSync(FOREIGN, { recursive: true, force: true });
  rmSync(FOREIGN_CWD, { force: true });
  for (const entry of readdirSync('/tmp')) {
    if (entry.startsWith('tmb-l3-') && entry.endsWith(`-leak-${PID}`)) rmSync(join('/tmp', entry), { recursive: true, force: true });
  }
}

describe('l3 runners', () => {
  let sb: Sandbox;
  let work: string;
  let env: NodeJS.ProcessEnv;
  let failDir: string;
  let passDir: string;
  let shimDir: string;

  /** <dir> holding each named file with its body. */
  function plant(name: string, files: Record<string, string>): string {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
    return dir;
  }

  function run(runner: string, extra: NodeJS.ProcessEnv, args: string[] = []): RunnerRun {
    const r = spawnSync('bash', [runner, ...args], { env: { ...env, ...extra }, cwd: PLUGIN_ROOT, encoding: 'utf8', timeout: 300_000 });
    if (r.error) throw r.error;
    return { out: out(r.stdout, r.stderr), rc: r.status };
  }

  /** Runs <runner> in the background, plants a foreign /tmp entry a second in, and waits for it. */
  async function runWithForeign(runner: string, extra: NodeJS.ProcessEnv, plantCwd: boolean): Promise<RunnerRun> {
    const child = spawn('bash', [runner], { env: { ...env, ...extra }, cwd: PLUGIN_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const done = new Promise<number | null>((resolve) => child.on('close', resolve));
    await sleep(1000);
    mkdirSync(FOREIGN);
    if (plantCwd) writeFileSync(FOREIGN_CWD, '');
    const rc = await done;
    cleanupForeign();
    return { out: out(stdout, stderr), rc };
  }

  before(() => {
    sb = makeSandbox('l3-runners');
    work = join(sb.dir, 'work');
    env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_|TMB_|NODE_TEST_CONTEXT$)/.test(k)));
    env.TMPDIR = sb.tmp;
    const fine = 'echo "fine"\n';
    failDir = plant('failing', {
      'broken.test.sh': 'for i in $(seq 1 15); do echo "broken-line-$i"; done\necho "FAIL planted failure"\nexit 1\n',
      'fine.test.sh': fine,
    });
    passDir = plant('passing', { 'fine.test.sh': fine });
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

  it('hooks runner: summary names the failing file with its last 10 lines', () => {
    const r = run(HOOKS_RUNNER, { L3_HOOKS_TEST_DIR: failDir });
    assert.equal(r.rc, 1, 'a failing file exits 1');
    const summary = summaryOf(r.out);
    has(summary, 'FAIL broken.test.sh — last 10 lines:', 'summary names the failing file');
    has(summary, 'broken-line-15', "summary carries the file's last lines");
    has(summary, 'FAIL planted failure', "summary carries the file's final line");
    hasNot(summary, 'broken-line-6', 'summary stops at the last 10 lines');
    hasNot(summary, 'fine.test.sh', 'summary omits passing files');
    has(r.out, 'FAIL files: broken.test.sh', 'final line names the failing file');
    has(r.out, '1 of 2 hook test files had failures.', 'count line unchanged');
  });

  it('hooks runner: verbose mode prints per-file durations', () => {
    const r = run(HOOKS_RUNNER, { L3_HOOKS_TEST_DIR: failDir }, ['-v']);
    has(r.out, 'duration fine.test.sh:', "verbose prints each file's duration");
  });

  it('hooks runner: TMPDIR assertion fires on a planted file', () => {
    const leakDir = plant('leaking', { 'leaks.test.sh': 'touch "$TMPDIR/planted-leak"\n' });
    const r = run(HOOKS_RUNNER, { L3_HOOKS_TEST_DIR: leakDir });
    assert.equal(r.rc, 1, 'a file left in TMPDIR exits 1');
    has(r.out, 'FAIL footprint: hook tests left files in TMPDIR:', 'TMPDIR leak reported');
    has(r.out, '$TMPDIR/planted-leak', 'the planted file is named');
    has(r.out, 'footprint: HOME untouched by the hook suite', 'the TMPDIR under HOME is not a HOME leak');
  });

  it('hooks runner: a clean suite passes every footprint check', () => {
    const r = run(HOOKS_RUNNER, { L3_HOOKS_TEST_DIR: passDir });
    assert.equal(r.rc, 0, 'a clean suite exits 0');
    has(r.out, 'footprint: TMPDIR left clean by the hook suite', 'TMPDIR check reported');
    has(r.out, 'footprint: /tmp gained no entries from this run', '/tmp check reported');
  });

  it("hooks runner: another session's /tmp entries during the run do not fail it", async () => {
    const slowDir = plant('slow', { 'slow.test.sh': 'sleep 2\n' });
    const r = await runWithForeign(HOOKS_RUNNER, { L3_HOOKS_TEST_DIR: slowDir }, true);
    assert.equal(r.rc, 0, 'a concurrent foreign tmb-* entry does not fail the run');
    has(r.out, 'warning: /tmp gained entries not named for this run', 'foreign growth is a warning');
    has(r.out, FOREIGN, 'the foreign entry is named in the warning');
    hasNot(r.out, FOREIGN_CWD, 'claude-*-cwd entries are not counted');
    has(r.out, 'footprint: /tmp gained no entries from this run', "the run's own check still passes");
  });

  it('hooks runner: a /tmp entry named for the run fails it', () => {
    const ownDir = plant('own-leak', { 'own.test.sh': `mkdir "/tmp/$TMB_TEST_RUN_ID-leak-${PID}"\n` });
    const r = run(HOOKS_RUNNER, { L3_HOOKS_TEST_DIR: ownDir });
    cleanupForeign();
    assert.equal(r.rc, 1, "the run's own /tmp leak exits 1");
    has(r.out, 'FAIL footprint: the hook suite left entries in /tmp:', 'own leak reported');
    has(r.out, `-leak-${PID}`, 'the leaked entry is named');
  });

  it('hooks runner: the sqlite3 shim refuses the real project DB dir and fails the run', () => {
    const r = run(HOOKS_RUNNER, { L3_HOOKS_TEST_DIR: shimDir });
    assert.equal(r.rc, 1, 'a refused sqlite3 call exits 1');
    has(r.out, '42', 'other sqlite3 calls pass through to the real binary');
    has(r.out, `sqlite3-shim: refused ${CHECKOUT}/.claude/tmb/shim-probe.db`, 'the refusal is printed to the test');
    has(r.out, 'probe refused', 'the refused call exits non-zero');
    has(r.out, 'FAIL live DB: the hook suite ran sqlite3 against the real project DB (1 refusals', 'the runner fails with the refusal list');
  });

  it('hooks runner: a suite with no refusals reports zero', () => {
    const r = run(HOOKS_RUNNER, { L3_HOOKS_TEST_DIR: passDir });
    has(r.out, 'live DB: 0 sqlite3 refusals from the hook suite', 'zero refusals reported');
  });

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
    const r = await runWithForeign(MCP_RUNNER, { L3_MCP_TEST_FILES: mcp('slow.test.mjs'), L3_MCP_TEST_SCRIPTS: mcp('leak.test.sh') }, false);
    assert.equal(r.rc, 1, 'the TMPDIR leak still fails the run');
    has(r.out, 'FAIL footprint: the L3 MCP suite left files in TMPDIR:', 'TMPDIR leak reported');
    has(r.out, 'warning: /tmp gained entries not named for this run', 'foreign growth is a warning');
    has(r.out, 'footprint: /tmp gained no entries from this run', 'no own /tmp leak');
  });

  it('mcp runner: the sqlite3 shim refuses the real project DB dir and fails the run', () => {
    const r = run(MCP_RUNNER, { L3_MCP_TEST_FILES: mcp('slow.test.mjs'), L3_MCP_TEST_SCRIPTS: join(shimDir, 'probe.test.sh') });
    assert.equal(r.rc, 1, 'a refused sqlite3 call exits 1');
    has(r.out, 'FAIL live DB: the L3 MCP suite ran sqlite3 against the real project DB (1 refusals', 'the runner fails with the refusal list');
  });
});
