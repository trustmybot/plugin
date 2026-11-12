// L1 lint: the MCP server's tool descriptions, loaded from the built dist/ through registerTools, total at most TMB_TOOL_DESC_BUDGET bytes (default 22050: the post-diet total plus headroom); raise it only with a justification.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = join(ROOT, 'mcp', 'trajectory-server');
const SERVER_DIST = join(SERVER, 'dist', 'index.js');
const SERVER_SRC = join(SERVER, 'src');
const BUDGET_BYTES = Number(process.env.TMB_TOOL_DESC_BUDGET || 23010); // trimmed for v1.2.0, GH 1403; +200 for the task_rework_analysis tool, GH 2830; +500 for the verification-path guard four task tools document, GH 2581; +200 for the indexed_commit/target_commit/stale fields three world-model tools document, GH 2584; +150 for the freshness block four tools document, GH 2584; +200 for the needs_review key three world-model tools document, GH 2584; +100 for the environment gate and its base_sha/wm_commit/env_gate fields three task tools document, GH 2866; +350 for the review_handoff tool, the swe → code-reviewer handoff split out of bro_atomic_close, GH 2866; +50 for the FAIL-reopened re-review review_handoff documents, GH 2866; +60 for the probes field validation_record and validation_history document and the output_tail brief field, GH 2866; +50 for the frozen install pr_monitor_worktree runs when manifests differ from main, GH 3003; +150 for the verification_run_required pass refusal validation_record documents, GH 2897

const LOADER = `
import { TrajectoryDB } from './mcp/trajectory-server/dist/db.js';
import { registerTools, toolDefinitions } from './mcp/trajectory-server/dist/tools/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

const db = new TrajectoryDB(':memory:');
const server = new Server({ name: 'budget-lint', version: '1.0' }, { capabilities: { tools: {} } });
registerTools(server, db, ':memory:');
console.log(JSON.stringify(toolDefinitions.map((t) => ({ name: t.name, bytes: Buffer.byteLength(t.description || '', 'utf8') }))));
`;

function newestMtimeMs(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
  }
  return newest;
}

export function distIsStale(distFile, srcDir) {
  if (!existsSync(distFile)) return true;
  return newestMtimeMs(srcDir) > statSync(distFile).mtimeMs;
}

function loadTools() {
  if (distIsStale(SERVER_DIST, SERVER_SRC)) {
    console.log('Building MCP server...');
    execFileSync('bun', ['run', 'build'], { cwd: SERVER, stdio: 'inherit' });
  }
  try {
    const out = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module'], {
      cwd: ROOT,
      input: LOADER,
      encoding: 'utf8',
      env: { ...process.env, TRAJECTORY_DB_PATH: ':memory:' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (err) {
    throw new Error(`ERROR: Failed to load tool definitions from ${SERVER_DIST}\n${err.message}`);
  }
}

export function budgetReport(tools, budget) {
  const byLen = [...tools].sort((a, b) => b.bytes - a.bytes);
  const total = byLen.reduce((s, t) => s + t.bytes, 0);
  const lines = [
    'Tool description budget check',
    `  Budget:  ${budget} bytes`,
    `  Total:   ${total} bytes (${byLen.length} tools)`,
    '',
    'Per-tool (sorted by size):',
    ...byLen.map((t) => `  ${String(t.bytes).padStart(4)}  ${t.name}`),
    '',
  ];
  if (total > budget) {
    lines.push(
      `❌ FAIL: total ${total} bytes exceeds budget ${budget} by ${total - budget} bytes.`,
      '   Trim tool descriptions or raise BUDGET_BYTES (with justification).',
    );
    return { ok: false, text: lines.join('\n') };
  }
  lines.push(`✓ PASS: ${total} bytes within ${budget}-byte budget.`);
  return { ok: true, text: lines.join('\n') };
}

test('a total over the budget fails with the overage', () => {
  const report = budgetReport(
    [
      { name: 'small', bytes: 40 },
      { name: 'big', bytes: 70 },
    ],
    100,
  );
  assert.equal(report.ok, false);
  assert.match(report.text, /Per-tool \(sorted by size\):\n {4}70 {2}big\n {4}40 {2}small/);
  assert.match(report.text, /❌ FAIL: total 110 bytes exceeds budget 100 by 10 bytes\./);
  assert.equal(budgetReport([{ name: 'small', bytes: 40 }], 100).ok, true);
});

test('the dist is stale when missing or older than any nested src file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'budget-lint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'src');
  mkdirSync(join(src, 'tools'), { recursive: true });
  const dist = join(dir, 'index.js');
  const nested = join(src, 'tools', 'a.ts');
  writeFileSync(nested, '');
  assert.equal(distIsStale(dist, src), true);
  writeFileSync(dist, '');
  utimesSync(nested, 1000, 1000);
  utimesSync(dist, 2000, 2000);
  assert.equal(distIsStale(dist, src), false);
  utimesSync(nested, 3000, 3000);
  assert.equal(distIsStale(dist, src), true);
});

test('tool descriptions stay within the byte budget', (t) => {
  const report = budgetReport(loadTools(), BUDGET_BYTES);
  for (const line of report.text.split('\n')) t.diagnostic(line);
  assert.ok(report.ok, report.text);
});
