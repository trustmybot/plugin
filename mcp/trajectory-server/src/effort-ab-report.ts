/**
 * The read side of the swe effort A/B (GH 1745): the enrolled tasks of one
 * label, grouped by arm, with the median and mean of five per-task metrics.
 * Wall-clock and review FAILs are task_stats' own (reworkStats); tool calls
 * and cache-read tokens sum the task's swe spawns; time to merge runs from the
 * task's created_at to its issue's first issue_auto_closed_on_merge row at or
 * after it (null when none). Each task also shows the suggested_tier of its
 * newest effort_inputs_recorded row (GH 1904; null when none). Read-only:
 * scripts/maintenance/effort-ab-report.ts runs it on a DB opened read-only.
 */
import { reworkStats, sweRunTotals, type StatsReader } from './tools/stats.js';

export const EFFORT_AB_EVENT = 'effort_ab_enrolled';
export const EFFORT_INPUTS_EVENT = 'effort_inputs_recorded';
export const SUGGESTED_TIERS = ['low', 'medium', 'high'] as const;
export const EFFORT_AB_ARMS = ['high', 'medium'] as const;
export const EFFORT_AB_METRICS = [
  'wall_clock_ms',
  'tool_uses',
  'cache_read_tokens',
  'review_fail_count',
  'time_to_merge_ms',
] as const;

type Arm = (typeof EFFORT_AB_ARMS)[number];
type Metric = (typeof EFFORT_AB_METRICS)[number];

const LABEL_SQL = "event_type = ? AND json_valid(content_json) AND json_extract(content_json, '$.label') = ?";

export function effortAbEnrolledCount(db: Pick<StatsReader, 'get'>, label: string): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit WHERE ${LABEL_SQL}`, [EFFORT_AB_EVENT, label])?.n ?? 0;
}

export interface MetricSummary {
  readonly n: number;
  readonly median: number | null;
  readonly mean: number | null;
}

type SuggestedTier = (typeof SUGGESTED_TIERS)[number];

export interface ArmReport {
  readonly arm: Arm;
  readonly task_count: number;
  readonly task_ids: number[];
  readonly suggested_tiers: Array<{ task_id: number; suggested_tier: SuggestedTier | null }>;
  readonly suggested_tier_counts: Record<SuggestedTier | 'null', number>;
  readonly metrics: Record<Metric, MetricSummary>;
}

function suggestedTier(db: StatsReader, taskId: number): SuggestedTier | null {
  const row = db.get<{ tier: unknown }>(
    `SELECT json_extract(content_json, '$.suggested_tier') AS tier FROM audit
      WHERE event_type = ? AND json_valid(content_json)
        AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ?
      ORDER BY id DESC LIMIT 1`,
    [EFFORT_INPUTS_EVENT, taskId],
  );
  return (SUGGESTED_TIERS as readonly unknown[]).includes(row?.tier) ? (row!.tier as SuggestedTier) : null;
}

export interface EffortAbReport {
  readonly label: string;
  readonly arms: ArmReport[];
}

function summarize(values: ReadonlyArray<number | null>): MetricSummary {
  const xs = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (xs.length === 0) return { n: 0, median: null, mean: null };
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  return { n: xs.length, median, mean: xs.reduce((a, b) => a + b, 0) / xs.length };
}

function timeToMergeMs(db: StatsReader, issueId: number, createdAt: string): number | null {
  const start = Date.parse(createdAt);
  if (Number.isNaN(start)) return null;
  const merges = db
    .all<{ created_at: string }>(
      `SELECT created_at FROM audit WHERE event_type = 'issue_auto_closed_on_merge' AND issue_id = ?`,
      [issueId],
    )
    .map((r) => Date.parse(r.created_at))
    .filter((t) => !Number.isNaN(t) && t >= start)
    .sort((a, b) => a - b);
  return merges.length > 0 ? merges[0]! - start : null;
}

export function effortAbReport(db: StatsReader, label: string, now: Date): EffortAbReport {
  const enrolled = db.all<{ task_id: number; arm: string; issue_id: number; created_at: string }>(
    `SELECT t.id AS task_id, e.arm, t.issue_id, t.created_at
       FROM (SELECT CAST(json_extract(content_json, '$.task_id') AS INTEGER) AS task_id,
                    MIN(json_extract(content_json, '$.arm')) AS arm
               FROM audit WHERE ${LABEL_SQL} GROUP BY 1) e
       JOIN tasks t ON t.id = e.task_id
      ORDER BY t.id`,
    [EFFORT_AB_EVENT, label],
  );
  const arms = EFFORT_AB_ARMS.map((arm): ArmReport => {
    const rows = enrolled.filter((r) => r.arm === arm);
    const perTask = rows.map((r) => {
      const stats = reworkStats(db, r.task_id, now);
      const swe = sweRunTotals(db, r.task_id);
      return {
        wall_clock_ms: stats.wall_clock_ms,
        tool_uses: swe.tool_uses,
        cache_read_tokens: swe.cache_read_tokens,
        review_fail_count: stats.review_fail_count,
        time_to_merge_ms: timeToMergeMs(db, r.issue_id, r.created_at),
      };
    });
    const metrics = Object.fromEntries(
      EFFORT_AB_METRICS.map((m) => [m, summarize(perTask.map((t) => t[m]))]),
    ) as Record<Metric, MetricSummary>;
    const suggested = rows.map((r) => ({ task_id: r.task_id, suggested_tier: suggestedTier(db, r.task_id) }));
    const counts = { low: 0, medium: 0, high: 0, null: 0 };
    for (const s of suggested) counts[s.suggested_tier ?? 'null']++;
    return {
      arm,
      task_count: rows.length,
      task_ids: rows.map((r) => r.task_id),
      suggested_tiers: suggested,
      suggested_tier_counts: counts,
      metrics,
    };
  });
  return { label, arms };
}

function fmt(value: number | null): string {
  if (value === null) return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatEffortAbReport(report: EffortAbReport): string {
  const lines = [`effort A/B '${report.label}'`];
  for (const arm of report.arms) {
    lines.push('', `arm ${arm.arm}: ${arm.task_count} task(s)${arm.task_ids.length ? ` [${arm.task_ids.join(', ')}]` : ''}`);
    for (const m of EFFORT_AB_METRICS) {
      const s = arm.metrics[m];
      lines.push(`  ${m.padEnd(18)} median ${fmt(s.median).padStart(12)}  mean ${fmt(s.mean).padStart(12)}  n=${s.n}`);
    }
    const counts = arm.suggested_tier_counts;
    lines.push(`  ${'suggested_tier'.padEnd(18)} low=${counts.low} medium=${counts.medium} high=${counts.high} null=${counts.null}`);
    if (arm.suggested_tiers.length > 0) {
      lines.push(`  ${''.padEnd(18)} ${arm.suggested_tiers.map((s) => `${s.task_id}:${s.suggested_tier ?? 'null'}`).join(' ')}`);
    }
  }
  return lines.join('\n') + '\n';
}
