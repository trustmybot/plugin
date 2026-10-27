/**
 * The Bash router gates' budgets (GH 1692 R1, GH 1861). 4 workers each run
 * every gate on its hook-corpus payloads in-process, in its parity sandbox,
 * for at least 20 rounds; the main process prints p50/p95/p99 per gate next to
 * the transcript p99 of the same gate under dispatch.sh, and with --write
 * records both in src/hooks/router/budgets.json with the floor and
 * budget_ms = max(floor_ms, ceil(2 x max(bench_p99, transcript_p99)) + 200),
 * plus parse_allowance_ms and group_budget_ms = max(max_budget_ms,
 * ceil(1.5 x p99_sum_ms)) with its two inputs, p99_sum_ms summing each gate's
 * max(bench_p99, transcript_p99): the time one call's gates share and, with
 * the parse allowance, the router's registration timeout.
 *
 *   node --experimental-sqlite dist/test/router-p99.bench.js [--rounds 20]
 *     [--workers 4] [--transcripts ~/.claude/projects] [--days 14] [--write]
 */
import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findGate, routerGates } from '../hooks/registry.js';
import { DEFAULT_DAYS, DEFAULT_TRANSCRIPTS, percentile, transcriptStats } from './hook-transcripts.js';
import { PLUGIN_ROOT, routerSandbox, underUid } from './router-sandboxes.js';
import { budgetMs, floorMs, groupBudgetMs, PARSE_ALLOWANCE_MS, p99Term } from './router-floors.js';

const MIN_ROUNDS = 20;
const BUDGETS = join(PLUGIN_ROOT, 'mcp/trajectory-server/src/hooks/router/budgets.json');

type Samples = Record<string, number[]>;

async function worker(rounds: number): Promise<Samples> {
  const sandbox = routerSandbox(mkdtempSync(join(tmpdir(), 'tmb-router-p99-')));
  const samples: Samples = {};
  try {
    for (let round = 0; round < rounds; round++) {
      for (const c of sandbox.cases) {
        const fn = findGate(c.gate);
        if (!fn) throw new Error(`unknown gate ${c.gate}`);
        c.reset?.();
        process.chdir(c.cwd);
        const ms = await underUid(c.fakeUid, async () => {
          const start = performance.now();
          await fn(c.input, c.env);
          return performance.now() - start;
        });
        (samples[c.gate] ??= []).push(ms);
      }
    }
  } finally {
    process.chdir(tmpdir());
    sandbox.cleanup();
  }
  return samples;
}

function runWorkers(n: number, rounds: number): Promise<Samples[]> {
  const self = fileURLToPath(import.meta.url);
  return Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<Samples>((resolve, reject) => {
          const child = fork(self, ['--worker', '--rounds', String(rounds)], { execArgv: ['--experimental-sqlite', '--no-warnings'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
          let got: Samples | null = null;
          child.on('message', (m) => {
            got = m as Samples;
          });
          child.on('error', reject);
          child.on('exit', (code) => (got !== null ? resolve(got) : reject(new Error(`worker exited ${code} without samples`))));
        }),
    ),
  );
}

const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      worker: { type: 'boolean', default: false },
      rounds: { type: 'string', default: String(MIN_ROUNDS) },
      workers: { type: 'string', default: '4' },
      transcripts: { type: 'string', default: DEFAULT_TRANSCRIPTS },
      days: { type: 'string', default: String(DEFAULT_DAYS) },
      write: { type: 'boolean', default: false },
    },
  });
  const rounds = Math.max(MIN_ROUNDS, Number(values.rounds));
  if (values.worker) {
    const samples = await worker(rounds);
    process.send?.(samples, () => process.exit(0));
    return;
  }
  const workers = Math.max(1, Number(values.workers));
  const days = Number(values.days);
  const loads: number[] = [loadavg()[0]];
  const sampler = setInterval(() => loads.push(loadavg()[0]), 1000);
  const started = performance.now();
  const results = await runWorkers(workers, rounds);
  clearInterval(sampler);
  loads.push(loadavg()[0]);
  const loadAvg = Math.round((loads.reduce((a, b) => a + b, 0) / loads.length) * 100) / 100;
  const transcripts = await transcriptStats(values.transcripts, days);
  const date = new Date().toISOString().slice(0, 10);
  const gates: Record<string, unknown> = {};
  console.log(`router-p99: ${workers} workers x ${rounds} rounds in ${Math.round((performance.now() - started) / 1000)} s, mean 1-min load ${loadAvg}; transcripts: ${transcripts.files} files, last ${days} days`);
  console.log(`${'gate'.padEnd(30)} ${'runs'.padStart(6)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} | ${'tx n'.padStart(6)} ${'tx p99'.padStart(8)} ${'tx t/o'.padStart(6)} | ${'floor'.padStart(6)} ${'budget'.padStart(6)}`);
  for (const gate of routerGates('PreToolUse', 'Bash')) {
    const ms = results.flatMap((r) => r[gate.name] ?? []);
    if (ms.length === 0) throw new Error(`no bench samples for ${gate.name}`);
    const p50 = round1(percentile(ms, 0.5));
    const p95 = round1(percentile(ms, 0.95));
    const p99 = round1(percentile(ms, 0.99)) as number;
    const tx = transcripts.gates.get(gate.name);
    const txP99 = tx ? percentile(tx.ms, 0.99) : null;
    const floor = floorMs(gate.name);
    const budget = budgetMs(floor, p99, txP99);
    gates[gate.name] = {
      kind: gate.kind,
      bench_p50: p50,
      bench_p95: p95,
      bench_p99: p99,
      bench_runs: ms.length,
      bench_load_avg: loadAvg,
      transcript_p99: txP99,
      ...(txP99 === null ? { reason: `no ${gate.name} PreToolUse hook attachment in ${transcripts.files} transcript files of the last ${days} days` } : {}),
      transcript_samples: tx?.ms.length ?? 0,
      transcript_timed_out: tx?.timedOut ?? 0,
      window_days: days,
      floor_ms: floor,
      budget_ms: budget,
      date,
    };
    console.log(
      `${gate.name.padEnd(30)} ${String(ms.length).padStart(6)} ${String(p50).padStart(8)} ${String(p95).padStart(8)} ${String(p99).padStart(8)} | ${String(tx?.ms.length ?? 0).padStart(6)} ${String(txP99 ?? '-').padStart(8)} ${String(tx?.timedOut ?? 0).padStart(6)} | ${String(floor).padStart(6)} ${String(budget).padStart(6)}`,
    );
  }
  const recorded = Object.values(gates as Record<string, { bench_p99: number; transcript_p99: number | null; budget_ms: number }>);
  const maxBudget = Math.max(...recorded.map((g) => g.budget_ms));
  const p99Sum = round1(recorded.reduce((n, g) => n + p99Term(g.bench_p99, g.transcript_p99), 0)) as number;
  const groupBudget = groupBudgetMs(maxBudget, p99Sum);
  console.log(`group_budget_ms ${groupBudget} = max(max_budget_ms ${maxBudget}, ceil(1.5 x p99_sum_ms ${p99Sum})); router timeout ${Math.ceil((PARSE_ALLOWANCE_MS + groupBudget) / 1000) + 1} s with parse_allowance_ms ${PARSE_ALLOWANCE_MS}`);
  if (values.write) {
    const top = { rounds, workers, parse_allowance_ms: PARSE_ALLOWANCE_MS, max_budget_ms: maxBudget, p99_sum_ms: p99Sum, group_budget_ms: groupBudget };
    writeFileSync(BUDGETS, `${JSON.stringify({ ...top, gates }, null, 2)}\n`);
    console.log(`wrote ${BUDGETS}`);
  }
}

await main();
