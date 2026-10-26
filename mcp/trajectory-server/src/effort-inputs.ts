/**
 * World-model effort inputs (GH 1904), in shadow mode: for a new task, what the
 * world model knows about the code its spec names in backticks (callers
 * outside files[], tables written and their outside readers, tests), with a
 * suggested tier. Recorded as one effort_inputs_recorded audit row per task;
 * the effort the task runs at is unchanged. Never throws: a missing world
 * model or a failed lookup records wm_available false.
 */
import type { TrajectoryDB } from './db.js';
import { extractSpecRefs } from './brief-locations.js';
import { isTestPath, symbolById, symbolCard, symbolsByName, type SymbolRow } from './symbol-index.js';
import { computeEffort, type Effort } from './tools/config.js';
import { insertAudit } from './tools/audit.js';
import { resolveSoleRepo } from './utils/repo-paths.js';
import { EFFORT_INPUTS_EVENT, type SUGGESTED_TIERS } from './effort-ab-report.js';

// Provisional until fitted from the GH 1745 A/B arms.
export const CALLER_SPREAD_HIGH = 2;
export const LOW_MAX_FILES = 1;
const MAX_MATCHES_PER_NAME = 3;

export type EffortTier = (typeof SUGGESTED_TIERS)[number];

export interface EffortInputs {
  files_in_scope: number;
  symbols_named: number;
  symbols_resolved: number;
  direct_callers: number;
  caller_files_outside_scope: number;
  tables_written: number;
  outside_table_readers: number;
  tests_reached: number;
  enforcement: boolean;
  prompt_bearing: boolean;
  rework: boolean;
  wm_available: boolean;
}

const ZERO_COUNTS = {
  files_in_scope: 0,
  symbols_named: 0,
  symbols_resolved: 0,
  direct_callers: 0,
  caller_files_outside_scope: 0,
  tables_written: 0,
  outside_table_readers: 0,
  tests_reached: 0,
} as const;

export interface EffortInputsTask {
  spec_body: string;
  files: readonly string[];
  prompt_bearing: boolean;
  rework: boolean;
}

export interface EffortSuggestion {
  suggested_tier: EffortTier;
  reason: string;
}

// The files[] rule of composites.pathInFiles: an entry covers itself and
// everything beneath it, and any tests/ entry covers all of tests/.
function inScope(path: string, files: readonly string[]): boolean {
  const entries = files.map((e) => e.replace(/^\.\//, '').replace(/\/+$/, '')).filter((e) => e.length > 0);
  if (entries.some((e) => e === 'tests' || e.startsWith('tests/'))) entries.push('tests');
  return entries.some((e) => e === '.' || path === e || path.startsWith(`${e}/`));
}

function hasWorldModel(db: TrajectoryDB, repo: string): boolean {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM wm_symbols WHERE repo = ? LIMIT 1)`, [repo])?.n === 1;
}

function namedSymbols(db: TrajectoryDB, repo: string, name: string, files: readonly string[]): SymbolRow[] {
  const rank = (s: SymbolRow) => (inScope(s.path, files) ? 0 : isTestPath(s.path) ? 2 : 1);
  const matches = symbolsByName(db, repo, name).filter((s) => s.kind !== 'module');
  if (matches.length === 0) return [];
  const best = Math.min(...matches.map(rank));
  return matches.filter((s) => rank(s) === best).slice(0, MAX_MATCHES_PER_NAME);
}

export function effortInputs(db: TrajectoryDB, repo: string | null, task: EffortInputsTask): EffortInputs {
  const inputs: EffortInputs = {
    ...ZERO_COUNTS,
    enforcement: false,
    prompt_bearing: task.prompt_bearing,
    rework: task.rework,
    wm_available: false,
  };
  try {
    const files = task.files;
    inputs.files_in_scope = files.length;
    inputs.enforcement = computeEffort(db, { prompt_bearing: 0, files }).reason === 'high_effort_paths';
    const { identifiers } = extractSpecRefs(task.spec_body);
    inputs.symbols_named = identifiers.length;
    if (!repo || !hasWorldModel(db, repo)) return inputs;

    const callerFiles = new Set<string>();
    const tables = new Set<number>();
    const tests = new Set<number>();
    const seen = new Set<number>();
    for (const name of identifiers) {
      const symbols = namedSymbols(db, repo, name, files).filter((s) => !seen.has(s.id));
      if (symbols.length > 0) inputs.symbols_resolved++;
      for (const symbol of symbols) {
        seen.add(symbol.id);
        const card = symbolCard(db, symbol);
        inputs.direct_callers += card.callers.total;
        for (const caller of card.callers.refs) if (!inScope(caller.path, files)) callerFiles.add(caller.path);
        for (const test of card.tests.refs) tests.add(test.id);
        if (symbol.kind !== 'sql_table') for (const table of card.writes_table.refs) tables.add(table.id);
      }
    }
    const readers = new Set<number>();
    for (const id of tables) {
      const table = symbolById(db, id);
      if (!table) continue;
      for (const reader of symbolCard(db, table).reads_table.refs) {
        if (!inScope(reader.path, files) && !isTestPath(reader.path)) readers.add(reader.id);
      }
    }
    inputs.caller_files_outside_scope = callerFiles.size;
    inputs.tables_written = tables.size;
    inputs.outside_table_readers = readers.size;
    inputs.tests_reached = tests.size;
    inputs.wm_available = true;
    return inputs;
  } catch {
    return { ...inputs, ...ZERO_COUNTS, wm_available: false };
  }
}

export function effortTier(inputs: EffortInputs): { tier: EffortTier; reason: string } {
  if (inputs.enforcement) return { tier: 'high', reason: 'high_effort_paths' };
  if (inputs.prompt_bearing) return { tier: 'high', reason: 'prompt_bearing' };
  if (inputs.rework) return { tier: 'high', reason: 'rework' };
  if (!inputs.wm_available) return { tier: 'medium', reason: 'no_world_model' };
  if (inputs.caller_files_outside_scope >= CALLER_SPREAD_HIGH) {
    return { tier: 'high', reason: `callers in ${inputs.caller_files_outside_scope} files outside files[]` };
  }
  if (inputs.outside_table_readers > 0) {
    return { tier: 'high', reason: `${inputs.outside_table_readers} reader(s) outside files[] of a table it writes` };
  }
  if (inputs.files_in_scope <= LOW_MAX_FILES && inputs.caller_files_outside_scope === 0 && inputs.tables_written === 0) {
    return { tier: 'low', reason: 'one file in scope, no outside caller, no table written' };
  }
  return { tier: 'medium', reason: 'default' };
}

interface StoredTask {
  id: number;
  issue_id: number;
  branch_id: string;
  repo: string | null;
  spec_body: string | null;
  files: string | null;
  prompt_bearing: number;
  effort: Effort;
  created_at: string;
}

function parseFiles(json: string | null): string[] {
  try {
    const value: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

export interface TaskEffortInputs {
  task: StoredTask;
  inputs: EffortInputs;
  tier: EffortTier;
  reason: string;
}

/**
 * The inputs and suggested tier of a stored task as at its creation (rework
 * false), against repoOverride's world model or else the task's repo; null
 * when no such task.
 */
export function taskEffortInputs(db: TrajectoryDB, taskId: number, repoOverride?: string): TaskEffortInputs | null {
  const task = db.get<StoredTask>(
    `SELECT id, issue_id, branch_id, repo, spec_body, files, prompt_bearing, effort, created_at FROM tasks WHERE id = ?`,
    [taskId],
  );
  if (!task) return null;
  let repo = repoOverride ?? task.repo;
  if (!repo) {
    try {
      repo = resolveSoleRepo(db)?.name ?? null;
    } catch {
      repo = null;
    }
  }
  const inputs = effortInputs(db, repo, {
    spec_body: task.spec_body ?? '',
    files: parseFiles(task.files),
    prompt_bearing: Number(task.prompt_bearing) === 1,
    rework: false,
  });
  const { tier, reason } = effortTier(inputs);
  return { task, inputs, tier, reason };
}

/**
 * Writes the effort_inputs_recorded row of a just-inserted task. Call inside
 * the insert's transaction, after enrollEffortAb; it reads the task row and
 * leaves it unchanged. A failure is logged and returns null so the insert
 * goes through.
 */
export function recordEffortInputs(db: TrajectoryDB, task: { id: number; from_node: string }): EffortSuggestion | null {
  try {
    const computed = taskEffortInputs(db, task.id);
    if (!computed) return null;
    const { task: row, inputs, tier, reason } = computed;
    insertAudit(db, {
      issue_id: row.issue_id,
      branch_id: row.branch_id,
      from_node: task.from_node,
      event_type: EFFORT_INPUTS_EVENT,
      summary: `Task ${row.id} effort inputs: suggested ${tier} (${reason}); runs at ${row.effort}.`,
      content_json: JSON.stringify({ task_id: row.id, inputs, suggested_tier: tier, reason, effort: row.effort }),
      created_at: row.created_at,
    });
    return { suggested_tier: tier, reason };
  } catch (e) {
    console.error(`[effort-inputs] task ${task.id}: not recorded:`, e);
    return null;
  }
}
