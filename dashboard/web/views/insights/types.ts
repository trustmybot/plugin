export type AgentKey = 'swe' | 'reviewer' | 'bro';

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
  histogram: Bucket[];
}

export interface Outlier {
  run_id: number;
  agent: AgentKey;
  task_id: number | null;
  task_title: string | null;
  value: number;
}

export interface SlowCommand extends Metric {
  command: string;
  n: number;
}

export interface Insights {
  range: { key: string; since: string | null; until: string };
  filters: { repo: string | null; agent: AgentKey | null; model: string | null; effort: string | null };
  options: { repos: string[]; models: string[] };
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
  outliers: { tokens_out: Outlier[]; context: Outlier[]; duration_ms: Outlier[] };
}
