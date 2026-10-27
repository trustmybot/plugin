/**
 * The router's own cost per Bash call (GH 1692 R1, SC5): routerMain over every
 * Bash payload of the 11 gates' corpora with instant gates, so what is timed is
 * the install check, the per-call dedupe lock, the decision and the hook_call
 * audit row against a real project DB. Exits 1 when p95 reaches 40 ms; at a
 * 1-minute load of 30 or more it prints `skipped: load <n>` and exits 0.
 *
 *   node --experimental-sqlite dist/test/router-overhead.bench.js [--rounds 5]
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { ALLOW } from '../hooks/gate.js';
import { routerMain } from '../hooks/router/main.js';
import { percentile } from './hook-transcripts.js';
import { PLUGIN_ROOT, ROUTER_CORPUS_GATES } from './router-sandboxes.js';

const P95_LIMIT_MS = 40;
const LOAD_LIMIT = 30;

function bashPayloads(): string[] {
  const out: string[] = [];
  for (const gate of ROUTER_CORPUS_GATES) {
    const dir = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus', gate);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      let o: { tool_name?: unknown; corpus_expect?: unknown };
      try {
        o = JSON.parse(readFileSync(join(dir, f), 'utf8')) as typeof o;
      } catch {
        continue;
      }
      if (o.tool_name !== 'Bash') continue;
      delete o.corpus_expect;
      out.push(JSON.stringify(o));
    }
  }
  return out;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { rounds: { type: 'string', default: '5' } } });
  const load = loadavg()[0];
  if (load >= LOAD_LIMIT) {
    console.log(`skipped: load ${load.toFixed(2)}`);
    return 0;
  }
  const payloads = bashPayloads();
  if (payloads.length === 0) throw new Error('no Bash payload in the router corpora');
  const base = mkdtempSync(join(tmpdir(), 'tmb-router-overhead-'));
  const project = join(base, 'project');
  const db = join(project, '.claude/tmb/trajectory.db');
  mkdirSync(join(project, '.claude/tmb'), { recursive: true });
  const d = new DatabaseSync(db);
  d.exec(readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
  d.close();
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, PWD: project, TMB_TEST_RUN_ID: 'router-overhead' };
  delete env.TRAJECTORY_DB_PATH;
  const ms: number[] = [];
  let n = 0;
  try {
    for (let round = 0; round < Math.max(1, Number(values.rounds)); round++) {
      for (const p of payloads) {
        const payload = JSON.stringify({ ...(JSON.parse(p) as object), session_id: 'overhead', tool_use_id: `overhead-${n++}` });
        const start = performance.now();
        await routerMain('PreToolUse', env, { readStdin: () => payload, writeStdout: async () => {}, writeStderr: () => {} }, { findGate: () => () => ALLOW, selfRoot: PLUGIN_ROOT });
        ms.push(performance.now() - start);
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const [p50, p95, p99] = [0.5, 0.95, 0.99].map((q) => (percentile(ms, q) as number).toFixed(2));
  console.log(`router-overhead: ${ms.length} calls over ${payloads.length} Bash payloads, 1-min load ${load.toFixed(2)}: p50 ${p50} ms, p95 ${p95} ms, p99 ${p99} ms (limit p95 < ${P95_LIMIT_MS} ms)`);
  if (Number(p95) >= P95_LIMIT_MS) {
    console.error(`router-overhead: p95 ${p95} ms >= ${P95_LIMIT_MS} ms`);
    return 1;
  }
  return 0;
}

process.exitCode = await main();
