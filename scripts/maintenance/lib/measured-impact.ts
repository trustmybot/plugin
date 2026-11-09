// Renders the `### Measured impact` bullets of a release section (GH 2600) from
// the `declared` outcomes `dist/change-impact/cli.js --source plugin_version --id <PR>`
// reports for each PR whose fragment ends with a Metric: line. Pure: bump-version.ts
// gathers the CLI results and calls it.

export type Direction = 'lower' | 'higher';
export type DeclaredOutcome = 'as_declared' | 'wrong_way' | 'not_moved' | 'not_enough_data';

export interface DeclaredMetric {
  metric: string;
  direction: Direction;
  outcome: DeclaredOutcome;
}

export interface MetricResult {
  id: string;
  ratio_of_medians: number | null;
  ratio_ci: [number, number] | null;
  verdict: string;
}

export interface PrImpact {
  pr: number;
  declared: DeclaredMetric[];
  metrics: MetricResult[];
}

const OUTCOME_WORDS: Record<DeclaredOutcome, string> = {
  as_declared: 'as declared',
  wrong_way: 'moved the wrong way',
  not_moved: 'did not move',
  not_enough_data: 'not enough data',
};

const number = (n: number): string => n.toFixed(2);

function ratioOf(metric: MetricResult | undefined): string {
  if (!metric || metric.verdict === 'not_enough_data' || metric.ratio_of_medians === null || metric.ratio_ci === null) return '';
  const [lo, hi] = metric.ratio_ci;
  return ` (median ratio ${number(metric.ratio_of_medians)}, 95% CI ${number(lo)}–${number(hi)})`;
}

/** One bullet per declared metric, sorted by PR then metric id. */
export function measuredImpactBullets(impacts: PrImpact[]): string[] {
  return impacts
    .flatMap((impact) => impact.declared.map((d) => ({ impact, d })))
    .sort((a, b) => a.impact.pr - b.impact.pr || (a.d.metric < b.d.metric ? -1 : a.d.metric > b.d.metric ? 1 : 0))
    .map(({ impact, d }) => {
      const words = OUTCOME_WORDS[d.outcome] ?? d.outcome;
      return `- #${impact.pr} \`${d.metric}\`, expected ${d.direction}: ${words}${ratioOf(impact.metrics.find((m) => m.id === d.metric))}`;
    });
}
