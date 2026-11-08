/**
 * The change-impact metric registry (GH 2600): each metric turns the trajectory
 * DB into timestamped, versioned samples that attribution.ts sorts into the
 * before and after sides of a change.
 *
 * A swe run here is a swe spawn (`SWE_SPAWN_SQL`: no `swept_orphan` rows). A
 * run's tokens are the sum of its four token columns; a run whose `tokens_in`
 * is NULL was never measured and adds no sample and no tokens.
 */
import type { StatsReader } from '../tools/stats.js';
import { SWE_SPAWN_SQL } from '../task-rework.js';

export interface Sample {
  at: string;
  version: string | null;
  value: number;
}

export interface Metric {
  id: string;
  label: string;
  unit: string;
  direction: 'lower' | 'higher';
  samples(reader: StatsReader): Sample[];
}

interface RunRow {
  id: number;
  task_id: number | null;
  session_id: string | null;
  started_at: string | null;
  plugin_version: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  hook_block_tokens: number | null;
}

const RUN_COLUMNS =
  'id, task_id, session_id, started_at, plugin_version, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, hook_block_tokens';

const DONE_TASK_SQL = "status = 'closed' AND commit_sha IS NOT NULL AND commit_sha <> '' AND completed_at IS NOT NULL";

function measured(r: RunRow): boolean {
  return r.tokens_in !== null;
}

function tokens(r: RunRow): number {
  return (r.tokens_in ?? 0) + (r.tokens_out ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_creation_tokens ?? 0);
}

function time(at: string | null): number {
  return at === null ? Number.NaN : Date.parse(at);
}

function groupBy<K, T>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function sweRunsByTask(reader: StatsReader): Map<number, RunRow[]> {
  const rows = reader.all<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE ${SWE_SPAWN_SQL} AND task_id IS NOT NULL ORDER BY task_id, id`,
  );
  return groupBy(rows, (r) => r.task_id as number);
}

function doneTaskIds(reader: StatsReader): Set<number> {
  return new Set(reader.all<{ id: number }>(`SELECT id FROM tasks WHERE ${DONE_TASK_SQL}`).map((r) => r.id));
}

/** The latest run in <runs> started at or before <at>, by start time. */
function latestRunAtOrBefore(runs: RunRow[], at: string): RunRow | undefined {
  const t = time(at);
  let best: RunRow | undefined;
  for (const r of runs) {
    const rt = time(r.started_at);
    if (Number.isNaN(rt) || rt > t) continue;
    if (!best || rt >= time(best.started_at)) best = r;
  }
  return best;
}

const sweReworkRatio: Metric = {
  id: 'swe_rework_ratio',
  label: 'swe rework ratio',
  unit: 'x first run tokens',
  direction: 'lower',
  samples(reader) {
    const out: Sample[] = [];
    for (const runs of sweRunsByTask(reader).values()) {
      const first = runs[0]!;
      if (!measured(first)) continue;
      const base = tokens(first);
      if (base <= 0) continue;
      for (const r of runs.slice(1)) {
        if (!measured(r) || r.started_at === null) continue;
        out.push({ at: r.started_at, version: r.plugin_version, value: tokens(r) / base });
      }
    }
    return out;
  },
};

const tokensPerTask: Metric = {
  id: 'tokens_per_task',
  label: 'tokens per task',
  unit: 'tokens',
  direction: 'lower',
  samples(reader) {
    const done = doneTaskIds(reader);
    const swe = sweRunsByTask(reader);
    const all = groupBy(
      reader.all<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE task_id IS NOT NULL AND COALESCE(exit_reason, '') <> 'swept_orphan'`,
      ),
      (r) => r.task_id as number,
    );
    const out: Sample[] = [];
    for (const [taskId, runs] of swe) {
      if (!done.has(taskId)) continue;
      const first = runs[0]!;
      if (first.started_at === null) continue;
      const taskRuns = (all.get(taskId) ?? []).filter(measured);
      if (taskRuns.length === 0) continue;
      out.push({ at: first.started_at, version: first.plugin_version, value: taskRuns.reduce((s, r) => s + tokens(r), 0) });
    }
    return out;
  },
};

const reworksPerTask: Metric = {
  id: 'reworks_per_task',
  label: 'reworks per task',
  unit: 'swe spawns after the first',
  direction: 'lower',
  samples(reader) {
    const done = doneTaskIds(reader);
    const out: Sample[] = [];
    for (const [taskId, runs] of sweRunsByTask(reader)) {
      if (!done.has(taskId)) continue;
      const first = runs[0]!;
      if (first.started_at === null) continue;
      out.push({ at: first.started_at, version: first.plugin_version, value: runs.length - 1 });
    }
    return out;
  },
};

const reviewFailRate: Metric = {
  id: 'review_fail_rate',
  label: 'review fail rate',
  unit: 'share of verdicts',
  direction: 'lower',
  samples(reader) {
    const reviewers = groupBy(
      reader.all<RunRow>(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE agent_type = 'code-reviewer' AND task_id IS NOT NULL`),
      (r) => r.task_id as number,
    );
    const attempts = reader.all<{ task_id: number; verdict: string; created_at: string }>(
      'SELECT task_id, verdict, created_at FROM validation_attempts ORDER BY id',
    );
    return attempts.map((a) => ({
      at: a.created_at,
      version: latestRunAtOrBefore(reviewers.get(a.task_id) ?? [], a.created_at)?.plugin_version ?? null,
      value: a.verdict === 'fail' ? 1 : 0,
    }));
  },
};

const verificationPassRate: Metric = {
  id: 'verification_pass_rate',
  label: 'verification pass rate',
  unit: 'share of first gate runs',
  direction: 'higher',
  samples(reader) {
    const swe = sweRunsByTask(reader);
    const firsts = reader.all<{ task_id: number; started_at: string; exit_code: number | null; timed_out: number }>(
      "SELECT v.task_id, v.started_at, v.exit_code, v.timed_out FROM verification_runs v WHERE v.source = 'gate'" +
        " AND v.id = (SELECT w.id FROM verification_runs w WHERE w.task_id = v.task_id AND w.source = 'gate' ORDER BY w.started_at, w.id LIMIT 1)",
    );
    return firsts.map((v) => ({
      at: v.started_at,
      version: latestRunAtOrBefore(swe.get(v.task_id) ?? [], v.started_at)?.plugin_version ?? null,
      value: v.exit_code === 0 && v.timed_out === 0 ? 1 : 0,
    }));
  },
};

const hookBlockTokensPerRun: Metric = {
  id: 'hook_block_tokens_per_run',
  label: 'hook-block tokens per swe run',
  unit: 'tokens',
  direction: 'lower',
  samples(reader) {
    return reader
      .all<RunRow>(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE ${SWE_SPAWN_SQL} AND hook_block_tokens IS NOT NULL AND started_at IS NOT NULL`)
      .map((r) => ({ at: r.started_at as string, version: r.plugin_version, value: r.hook_block_tokens as number }));
  },
};

const broTokensPerSession: Metric = {
  id: 'bro_tokens_per_session',
  label: 'bro tokens per session',
  unit: 'tokens',
  direction: 'lower',
  samples(reader) {
    const rows = reader.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE agent_type = 'bro' AND session_id IS NOT NULL ORDER BY session_id, started_at, id`,
    );
    const out: Sample[] = [];
    for (const runs of groupBy(rows, (r) => r.session_id as string).values()) {
      const first = runs[0]!;
      const counted = runs.filter(measured);
      if (first.started_at === null || counted.length === 0) continue;
      out.push({ at: first.started_at, version: first.plugin_version, value: counted.reduce((s, r) => s + tokens(r), 0) });
    }
    return out;
  },
};

export const METRICS: readonly Metric[] = [
  sweReworkRatio,
  tokensPerTask,
  reworksPerTask,
  reviewFailRate,
  verificationPassRate,
  hookBlockTokensPerRun,
  broTokensPerSession,
];
