#!/usr/bin/env node
// Smoke test for the SQLite world model (GH 1632): scans a fixture repo into a
// temp trajectory DB, then checks the wm_ tables, world_model_get depth=2 and
// keyword + hybrid world_model_search. Exits non-zero on any failure.
// Run after `bun run build`: node mcp/trajectory-server/scripts/smoke-world-model.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const { TrajectoryDB } = await import(join(dist, 'db.js'));
const { WorldModelGraph, GraphHolder } = await import(join(dist, 'graph.js'));
const { scanTools } = await import(join(dist, 'tools/scan.js'));
const { worldModelTools } = await import(join(dist, 'tools/world_model.js'));
const { resetEmbeddingModelForTests } = await import(join(dist, 'embeddings/model.js'));

const KNOWN_FILE = 'billing/invoice.ts';
const FIXTURE = {
  'README.md': '# Shop\n\nFixture storefront.\n',
  'billing/README.md': '# Billing\n\nInvoices and tax rules.\n',
  [KNOWN_FILE]: '// Renders customer invoices with line-item tax totals.\nexport const invoice = 1;\n',
  'billing/tax/rates.ts': '// Regional sales tax rate table.\nexport const rates = {};\n',
  'auth/session.ts': '// Issues and refreshes login sessions.\nexport const session = 1;\n',
};

function bagOfWords() {
  return async () => async (text) => {
    const v = new Float32Array(64);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 2166136261;
      for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
      v[(h >>> 0) % 64] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return { data: v.map((x) => x / norm) };
  };
}

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const parse = (r) => JSON.parse(r.content[0].text);
const ws = mkdtempSync(join(tmpdir(), 'tmb-wm-smoke-'));
const dbPath = join(ws, 'trajectory.db');
const mcpJson = join(ws, 'mcp-servers.json');
writeFileSync(mcpJson, '{}');
process.env['TMB_FORBID_LIVE_SYNC'] = '1';
process.env['TRAJECTORY_DB_PATH'] = dbPath;
process.env['TMB_SCAN_MCP_JSON'] = mcpJson;

let db;
try {
  const repoRoot = join(ws, 'shop');
  for (const [rel, body] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(repoRoot, rel)), { recursive: true });
    writeFileSync(join(repoRoot, rel), body);
  }
  const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  git('config', 'user.email', 'smoke@example.com');
  git('config', 'user.name', 'smoke');
  git('add', '.');
  git('commit', '-qm', 'fixture');

  resetEmbeddingModelForTests(bagOfWords());
  db = new TrajectoryDB(dbPath);
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const scan = await scanTools(db, holder, dbPath).handlers.scan_run({ agent: 'bro', session_dir: ws });
  check('scan_run succeeds', !scan.isError, scan.content?.[0]?.text);

  const count = (table) => db.get(`SELECT COUNT(*) AS n FROM ${table}`).n;
  check('wm_directories has rows', count('wm_directories') > 0);
  check('wm_files has rows', count('wm_files') > 0);

  const wm = worldModelTools(db, holder).handlers;
  const tree = parse(await wm.world_model_get({ agent: 'bro', repo: 'shop', depth: 2 }));
  const billing = tree.root?.children?.find((c) => c.path === 'billing');
  check('world_model_get depth=2 returns the root', tree.root?.path === '', JSON.stringify(tree).slice(0, 300));
  check('world_model_get depth=2 reaches the second level', billing?.children?.some((c) => c.path === 'billing/tax') === true);

  for (const mode of ['keyword', 'hybrid']) {
    const res = parse(await wm.world_model_search({ agent: 'bro', repo: 'shop', query: 'invoice tax totals', mode }));
    const paths = res.results.map((r) => r.path);
    check(`${mode} search returns ${KNOWN_FILE}`, paths.includes(KNOWN_FILE), JSON.stringify(res).slice(0, 300));
    if (mode === 'hybrid') check('hybrid search used embeddings', res.warning === undefined, res.warning);
  }
} catch (e) {
  check('smoke run completes', false, e instanceof Error ? e.stack : String(e));
} finally {
  db?.close();
  resetEmbeddingModelForTests();
  rmSync(ws, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`world model smoke: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('world model smoke: all checks passed');
