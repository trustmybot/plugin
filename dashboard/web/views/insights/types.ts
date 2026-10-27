import type { MetricKey } from './params.ts';

export type AgentKey = 'swe' | 'code-reviewer' | 'bro';

export interface Metric {
  p50: number | null;
  p95: number | null;
  max: number | null;
  avg: number | null;
}

export interface Bucket {
  from: number;
  to: number;
  count: number;
}

export interface AgentStats {
  agent: AgentKey;
  per: 'run' | 'session';
  n: number;
  total: number;
  tokens_out: Metric;
  context: Metric;
  cache_hit: Metric;
  duration_ms: Metric;
  tool_uses: Metric;
  histograms: Record<MetricKey, Bucket[]>;
}

export interface Outlier {
  run_id: number;
  agent: AgentKey;
  task_id: number | null;
  task_title: string | null;
  value: number;
}

export interface DurationOutlier extends Outlier {
  tool_uses: number;
  tokens_out: number;
  idle: boolean;
}

export interface SlowCommand extends Metric {
  command: string;
  n: number;
}

export interface Insights {
  range: { key: string; since: string | null; until: string };
  filters: { repo: string | null; agent: AgentKey | null; model: string | null; effort: string | null };
  options: { repos: string[]; models: string[]; max_task_id?: number | null };
  agents: AgentStats[];
  cost: {
    priced: boolean;
    by_agent: Array<{ agent: AgentKey; usd: number; runs: number }>;
    by_model: Array<{ model: string; usd: number; runs: number }>;
    unpriced_runs: number;
  };
  quality: {
    first_pass: { passed: number; total: number };
    attempts: Array<{ attempts: number; tasks: number }>;
    verdicts: { pass: number; fail: number; escalate: number };
    verification: { passed: number; total: number };
    slowest_commands: SlowCommand[];
  };
  throughput: Array<{ day: string; closed: number }>;
  outliers: { tokens_out: Outlier[]; context: Outlier[]; duration_ms: DurationOutlier[] };
}

export interface ServerSlice {
  key: string;
  kind: 'range' | 'prev' | 'dates' | 'tasks';
  since: string | null;
  until: string | null;
  from_task: number | null;
  to_task: number | null;
}

export interface PerTask {
  tasks: number;
  runs: number;
  tokens_out: number | null;
  context: number | null;
  cache_hit: number | null;
  cost_usd: number | null;
  unpriced_runs: number;
}

export interface PeriodInsights extends Insights {
  slice: ServerSlice;
  per_task: PerTask;
}

export interface Comparison {
  p1: PeriodInsights;
  p2: PeriodInsights;
  shared_runs: number;
  bro_excluded: boolean;
  options: Insights['options'];
}

export interface ExploreGroup {
  key: string[];
  n: number;
  value: number | null;
}

export interface Explore {
  measure: string;
  agg: string;
  dims: string[];
  groups: ExploreGroup[];
  review_round_mismatch: number;
  days: number;
  options: { measures: string[]; aggs: string[]; dims: string[]; priced: boolean };
}
