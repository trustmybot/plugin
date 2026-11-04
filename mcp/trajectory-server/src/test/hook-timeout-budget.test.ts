/**
 * Each hooks/hooks.json wrapper `timeout` covers the hook's own internal
 * budget (GH 1692). CC kills a hook process at the hooks.json timeout, so a
 * hook whose internal budget (retry loop, verification total) exceeds its
 * wrapper is silently neutered. Each gate's worst-case budget is derived from
 * its source (src/hooks/<gate>.ts); every registration runs through the
 * router, which runs each gate of a group until its own budget
 * (dist/hooks-router.txt), so a gate is held to that budget and each group's
 * registration to its group's (src/hooks/router/budgets.json).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { gateBudgetS, hookRegistrations, PLUGIN_ROOT, routerBudgetMax, routerCommand, routerTable } from './hooks-router-table.js';

const HOOKS_SRC = join(PLUGIN_ROOT, 'mcp/trajectory-server/src/hooks');
const TABLE = routerTable(PLUGIN_ROOT);
const BUDGETS = JSON.parse(readFileSync(join(HOOKS_SRC, 'router/budgets.json'), 'utf8')) as {
  parse_allowance_ms?: number;
  groups: Record<string, { group_budget_ms?: number }>;
};

const numbers = (src: string, re: RegExp): number[] => [...src.matchAll(re)].map((m) => Number(m[1]));

describe('hook-timeout-budget: gates writing through lib/audit.ts cover their per-run write budget', () => {
  // Every DB write in one gate run shares a run budget
  // (TMB_DB_WRITE_RUN_BUDGET_MS). The effective budget is the largest one the
  // gate's source sets (`TMB_DB_WRITE_RUN_BUDGET_MS: '<ms>'`, or a
  // `…RUN_BUDGET_MS = '<ms>'` constant), else the library default; the gate's
  // router budget must reach run budget + 1 s.
  const defaultRunMs = numbers(readFileSync(join(HOOKS_SRC, 'lib/audit.ts'), 'utf8'), /DEFAULT_RUN_BUDGET_MS = ([0-9]+)/g)[0];
  const gates = readdirSync(HOOKS_SRC)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => ({ gate: basename(f, '.ts'), src: readFileSync(join(HOOKS_SRC, f), 'utf8') }))
    .filter(({ src }) => /from '\.\/lib\/audit\.js'/.test(src))
    .map(({ gate, src }) => ({ gate, src, budgetS: gateBudgetS(TABLE, gate) }))
    .filter((g) => g.budgetS !== undefined);

  it('derives lib/audit.ts default run budget (DEFAULT_RUN_BUDGET_MS) and finds DB-writing router gates', () => {
    assert.ok(defaultRunMs !== undefined && defaultRunMs > 0, 'could not derive lib/audit.ts default run budget (DEFAULT_RUN_BUDGET_MS) from source');
    assert.ok(gates.length > 0, 'no gate importing ./lib/audit.js has a router budget');
  });

  for (const { gate, src, budgetS } of gates) {
    it(`${gate}: router budget >= run budget + 1 s`, () => {
      const ms = Math.max(...numbers(src, /(?:TMB_DB_WRITE_RUN_BUDGET_MS: '|RUN_BUDGET_MS = ')([0-9]+)/g), -1);
      const runMs = ms >= 0 ? ms : defaultRunMs;
      const floor = Number((runMs / 1000 + 1).toFixed(1));
      assert.ok((budgetS as number) >= floor, `${gate} budget ${budgetS}s < floor ${floor}s (run budget ${runMs}ms + 1s margin)`);
    });
  }
});

describe('hook-timeout-budget: swe-verification-gate covers its verification cap and run-record writes', () => {
  // The gate caps its budget at VERIFICATION_MAX_S, counting command time
  // only. The start and command writes share RECORD_POOL_MS, and the finish
  // write gets FINISH_ATTEMPTS tries of RECORD_BUDGET_MS with a backoff of
  // attempt × FINISH_BACKOFF_MS. So floor = cap + ceil((POOL + ATTEMPTS ×
  // RECORD + BACKOFF × ATTEMPTS × (ATTEMPTS-1) / 2) / 1000) + 5 s overhead
  // (reads, toolchain resolution, the decision). The default sits under the cap.
  const OVERHEAD_S = 5;
  const src = readFileSync(join(HOOKS_SRC, 'swe-verification-gate.ts'), 'utf8');
  const constant = (name: string): number | undefined => {
    const m = new RegExp(`^(?:export )?const ${name} = ([0-9]+)`, 'm').exec(src);
    return m === null ? undefined : Number(m[1]);
  };
  const budgetS = gateBudgetS(TABLE, 'swe-verification-gate');
  const c = {
    VERIFICATION_DEFAULT_S: constant('VERIFICATION_DEFAULT_S'),
    VERIFICATION_MAX_S: constant('VERIFICATION_MAX_S'),
    RECORD_BUDGET_MS: constant('RECORD_BUDGET_MS'),
    RECORD_POOL_MS: constant('RECORD_POOL_MS'),
    FINISH_ATTEMPTS: constant('FINISH_ATTEMPTS'),
    FINISH_BACKOFF_MS: constant('FINISH_BACKOFF_MS'),
  };

  it('derives the router budget and every budget constant from source', () => {
    assert.notEqual(budgetS, undefined, 'could not derive swe-verification-gate router budget');
    for (const [name, value] of Object.entries(c)) assert.notEqual(value, undefined, `could not derive verification-gate ${name} from source`);
  });

  it('router budget >= cap + record writes + overhead', () => {
    const v = c as Record<keyof typeof c, number>;
    const recordMs = v.RECORD_POOL_MS + v.FINISH_ATTEMPTS * v.RECORD_BUDGET_MS + Math.floor((v.FINISH_BACKOFF_MS * v.FINISH_ATTEMPTS * (v.FINISH_ATTEMPTS - 1)) / 2);
    const recordS = Math.floor((recordMs + 999) / 1000);
    const floor = v.VERIFICATION_MAX_S + recordS + OVERHEAD_S;
    assert.ok(
      (budgetS as number) >= floor,
      `swe-verification-gate budget ${budgetS}s < floor ${floor}s (budget cap ${v.VERIFICATION_MAX_S}s + record writes ${recordS}s + ${OVERHEAD_S}s overhead)`,
    );
  });

  it('the default budget does not exceed its cap', () => {
    assert.ok(
      (c.VERIFICATION_DEFAULT_S as number) <= (c.VERIFICATION_MAX_S as number),
      `swe-verification-gate default budget ${c.VERIFICATION_DEFAULT_S}s exceeds its cap ${c.VERIFICATION_MAX_S}s`,
    );
  });
});

describe('hook-timeout-budget: each router registration covers the parse and its group budget', () => {
  // The router runs a group's gates after the shared parse, each until the
  // smaller of its own budget and the group budget left, so each group's
  // registration timeout is the backstop over the parse allowance plus its
  // group budget, and the group budget leaves every gate its whole budget.
  const registrations = hookRegistrations(PLUGIN_ROOT)
    .map((r) => ({ ...r, router: routerCommand(r.command) }))
    .filter((r) => r.router !== null);

  it('hooks.json has router registrations', () => {
    assert.ok(registrations.length > 0);
  });

  for (const r of registrations) {
    const { event, part } = r.router as { event: string; part: string | undefined };
    it(`router ${event} ${r.matcher || '-'}${part === undefined ? '' : ` ${part}`}: group budget >= its largest gate budget, wrapper >= parse allowance + group budget`, () => {
      const max = routerBudgetMax(TABLE, event, r.matcher, part);
      const parse = BUDGETS.parse_allowance_ms;
      const group = BUDGETS.groups[`${event}:${r.matcher}${part === undefined ? '' : `:${part}`}`]?.group_budget_ms;
      assert.notEqual(max, undefined, `could not derive ${event} ${r.matcher} router gate budgets (dist/hooks-router.txt)`);
      assert.notEqual(parse, undefined, 'could not derive router parse_allowance_ms (budgets.json)');
      assert.notEqual(group, undefined, `could not derive router group_budget_ms of ${r.matcher} (budgets.json)`);
      assert.ok((group as number) >= (max as number), `router ${event} ${r.matcher} group budget ${group}ms < its largest gate budget ${max}ms`);
      const need = Math.floor(((parse as number) + (group as number) + 999) / 1000);
      assert.ok((r.timeout ?? 0) >= need, `router ${event} ${r.matcher} wrapper ${r.timeout ?? '?'}s < ${need}s (parse allowance ${parse}ms + group budget ${group}ms)`);
    });
  }
});
