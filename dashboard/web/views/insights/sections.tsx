import { FilterIcon } from '@primer/octicons-react';
import type { ReactNode } from 'react';
import type { Row } from '../../api.ts';
import { DataTable, type Column as TableColumn } from '../../DataTable.tsx';
import { agentCell, entityLink } from '../../shared/columns.tsx';
import { Loading } from '../../shared/Loading.tsx';
import { Blankslate } from '../../ui/Blankslate.tsx';
import { Box } from '../../ui/Box.tsx';
import { Button } from '../../ui/Button.tsx';
import { Flash } from '../../ui/Flash.tsx';
import { Label } from '../../ui/Label.tsx';
import { ProgressBar, StackedProgressBar } from '../../ui/ProgressBar.tsx';
import { ChartCard } from './ChartCard.tsx';
import { BarList, ColumnChart, Histogram, OverlayHistogram, PairedBarList, niceAxis, shareOf, type Column, type OverlayPeriod, type PairedRow } from './charts.tsx';
import { POLARITY, compareSlug, delta, sliceLabel, type Compare, type DeltaMeasure } from './compare.ts';
import { CompareTile, DeltaLabel, PerTaskStrip, totalRuns } from './compare.tsx';
import {
  AGENT_HEADER,
  ATTEMPTS_HEADER,
  ATTEMPTS_SHARE_UNIT,
  AVERAGE_BARS,
  AVG_CLOSED_PER_DAY,
  AVG_CLOSED_SUBJECT,
  BRO_DURATION_PER_SESSION,
  BRO_TOOL_USES_PER_SESSION,
  CLOSED_HEADER,
  CLOSED_PER_DAY,
  DAY_HEADER,
  DURATION_PER_RUN,
  DURATION_UNIT,
  FIRST_PASS_RATE,
  FIRST_PASS_WHAT,
  NO_CLOSED_TASKS,
  PER_RUN,
  PER_SESSION,
  REVIEW_ATTEMPTS,
  SECTIONS,
  SLOWEST_COMMANDS,
  TASKS_PER_DAY_UNIT,
  TIME_SUBJECT,
  TOOL_USES_PER_RUN,
  TOOL_USES_UNIT,
  VERDICTS_WHAT,
  VERDICT_MIX,
  VERIFICATION_PASS_RATE,
  VERIFICATION_WHAT,
  attemptsLabel,
  attemptsSubject,
  averageSubject,
  closedAria,
  period1Value,
  periodBar,
  periodOf,
  periodTasks,
  rateSubject,
  type Section,
} from './params.ts';
import { AGENT_COLOR, AGENT_FILL, SERIES_COLOR, compact, duration, durationTicks, fine, pct, plain, ratio, shortDay, usd } from './format.ts';
import {
  BY_TYPE,
  BY_WEEK,
  EFFICIENCY_COLUMNS,
  EFFICIENCY_EMPTY,
  EFFICIENCY_FOOTNOTE,
  EFFICIENCY_SUBTITLE,
  EFFICIENCY_TITLE,
  FEW_CAPTION,
  FEW_TASKS,
  FEW_TASKS_TITLE,
  TYPE_HEADER,
  WEEK_HEADER,
  weekOf,
  BRO_COST_PER_SESSION,
  BRO_EXCLUDED_CAPTION,
  BRO_TASKS_CAPTION,
  CHANGE_HEADER,
  COMPARE_SUBTITLE,
  COST_PER_RUN_AGENT,
  COST_PER_RUN_MODEL,
  COST_PER_RUN_UNIT,
  COST_PER_SESSION_UNIT,
  HIGHER_BETTER,
  LOWER_BETTER,
  MEASURE_HEADER,
  NAME_HEADER,
  NO_RUNS_EITHER,
  OUTLIERS_P2,
  costPerRunSubject,
  costPerSessionSubject,
  compareMeasured,
  noRunsEither,
  noRunsIn,
  overlayAria,
  pairText,
  periodCost,
  periodEarly,
  periodLabel,
  periodName,
  periodRuns,
  periodShare,
  periodUnpriced,
  METRICS,
  METRIC_COPY,
  PERIOD_LOWER,
  RANGES,
  activeFilterCount,
  activeFilterList,
  clearFilters,
  histogramColumns,
  histogramSubtitle,
  insightHash,
  type InsightParams,
  type MetricKey,
} from './params.ts';
import type { AgentKey, AgentStats, Comparison, Efficiency, Insights, Metric, Outlier, PeriodInsights } from './types.ts';
import type { TableData } from './csv.ts';

export const NO_PRICES = 'Cost tracking is off: no model prices set. Ask bro to set your model prices to turn it on.';
export const EFFORT_CAPTION = 'Effort is set per task, so this compares task size, not the setting.';
export const TASK_LEVEL_CAPTION = "Agent and Model filters don't apply here. These charts count tasks, not agent runs.";
export const NO_MATCH_HEADING = 'No Runs Match These Filters';
export const BRO_CAPTION = 'bro is metered per session, not per run.';
export const IDLE_CAPTION = 'Likely idle: over 30 min with under 1 tool use and 500 output tokens a minute. Listed last.';
export const EARLY_MIN = 20;

interface SectionProps {
  data: Insights;
  params: InsightParams;
}

const period = (p: InsightParams) => RANGES.find(([k]) => k === p.range)![1];
const metricLabel = (m: MetricKey) => METRICS.find(([k]) => k === m)![1];
const formatFor = (m: MetricKey) => (m === 'cache_hit' ? pct : m === 'tool_uses' ? plain : compact);
const noun = (s: AgentStats, n: number) => (s.per === 'session' ? (n === 1 ? 'session' : 'sessions') : n === 1 ? 'run' : 'runs');

export const earlyData = (n: number) => `Early data · ${n} of ${EARLY_MIN} runs`;
export const measuredLine = (s: AgentStats) => `Tokens measured for ${s.n} of ${s.total} ${noun(s, s.total)}`;

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{children}</div>;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="border-b border-(--borderColor-muted) pb-2 text-base font-semibold text-fg">{children}</h2>;
}

function Stats({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
      {items.map(([term, value]) => (
        <div key={term} className="flex gap-1.5">
          <dt className="text-fg-muted">{term}</dt>
          <dd className="font-semibold text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const perRun = (agents: AgentStats[]) => agents.filter((a) => a.per === 'run');
const bro = (agents: AgentStats[]) => agents.find((a) => a.agent === 'bro');

// While any filter is set, agents it leaves without runs are not drawn.
const shownAgents = (data: Insights, params: InsightParams) => (activeFilterCount(params) > 0 ? data.agents.filter((a) => a.total > 0) : data.agents);

function NoMatch({ params }: { params: InsightParams }) {
  return (
    <Box>
      <Blankslate
        icon={FilterIcon}
        heading={NO_MATCH_HEADING}
        description={`Nothing in ${PERIOD_LOWER[params.range]} matches ${activeFilterList(params)}.`}
        action={<Button href={insightHash(clearFilters(params))}>Clear Filters</Button>}
      />
    </Box>
  );
}

const tableValue = (metric: MetricKey, v: number) => (metric === 'cache_hit' ? Math.round(v * 100) : v);

export function histogramTable(s: AgentStats, metric: MetricKey): TableData {
  return {
    columns: [...histogramColumns(metric), s.per === 'session' ? 'Sessions' : 'Runs'],
    rows: s.histograms[metric].map((b) => [tableValue(metric, b.from), tableValue(metric, b.to), b.count]),
  };
}

function AgentTokenCard({ s, params, rank, yMax }: { s: AgentStats; params: InsightParams; rank: string | null; yMax?: number }) {
  const m = s[params.metric];
  const fmt = formatFor(params.metric);
  const what = METRIC_COPY[params.metric].noun;
  const buckets = s.histograms[params.metric];
  const per = s.per === 'session' ? 'Per Session' : 'Per Run';
  const early = s.n < EARLY_MIN;
  return (
    <ChartCard
      title={s.agent}
      subtitle={`${period(params)} · ${per} · ${histogramSubtitle(params.metric, s.per)}`}
      section="tokens"
      range={params.range}
      table={histogramTable(s, params.metric)}
      caption={s.per === 'session' ? BRO_CAPTION : undefined}
    >
      <div className="space-y-2" data-agent={s.agent}>
        {rank && <p className="text-xs text-fg-muted">{rank}</p>}
        <p className="text-xs text-fg-muted tabular-nums">{measuredLine(s)}</p>
        <Stats items={[[`p50 ${metricLabel(params.metric)}`, fmt(m.p50)], ['p95', fmt(m.p95)], ['max', fmt(m.max)]]} />
        {early && <p className="text-xs font-semibold text-(--fgColor-attention)">{earlyData(s.n)}</p>}
        {!buckets.some((b) => b.count > 0) ? (
          <p className="text-sm text-fg-muted">{`No ${what} data in this period.`}</p>
        ) : (
          <Histogram
            label={`${s.agent} ${what} ${per.toLowerCase()}: ${s.n} measured, ${buckets.length} buckets${early ? '' : `, p50 ${fmt(m.p50)}, p95 ${fmt(m.p95)}`}`}
            measure={what}
            who={s.agent}
            noun={(n) => noun(s, n)}
            buckets={buckets}
            linear={params.metric === 'cache_hit'}
            color={AGENT_COLOR[s.agent]}
            yMax={yMax}
            p50={early ? null : m.p50}
            p95={early ? null : m.p95}
            format={fmt}
          />
        )}
      </div>
    </ChartCard>
  );
}

function rankOf(agents: AgentStats[], metric: MetricKey): Map<AgentKey, string> {
  const ranked = [...agents].sort((a, b) => (b[metric].avg ?? -1) - (a[metric].avg ?? -1));
  return new Map(ranked.map((a, i) => [a.agent, `Rank ${i + 1} of ${ranked.length} by average ${metricLabel(metric).toLowerCase()}`]));
}

const OUTLIER_TITLE = { tokens_out: 'Top Runs by Output Tokens', context: 'Top Runs by Context', duration_ms: 'Top Runs by Duration' } as const;

const count = (v: unknown) => (v === null || v === undefined ? '—' : plain(Number(v)));

const NUMERIC = 'whitespace-nowrap tabular-nums';
const numeric = (text: ReactNode) => <span className={NUMERIC}>{text}</span>;

function Outliers({ kind, rows, suffix = '' }: { kind: keyof typeof OUTLIER_TITLE; rows: Outlier[]; suffix?: string }) {
  const isDuration = kind === 'duration_ms';
  const fmt = isDuration ? duration : compact;
  const columns: TableColumn[] = [
    { key: 'run_id', header: 'Run', cell: (r) => numeric(String(r['run_id'])), hideBelow: 'sm' },
    { key: 'agent', header: 'Agent', cell: agentCell('agent') },
    { key: 'task_id', header: 'Task', cell: entityLink('task', 'task_id') },
    { key: 'task_title', header: 'Title', cell: entityLink('task', 'task_id', 'task_title'), truncate: 'fill', hideBelow: 'md' },
    {
      key: 'value',
      header: isDuration ? 'Duration' : 'Tokens',
      cell: (r) => (
        <span className={`inline-flex items-center gap-2 ${NUMERIC}`}>
          {fmt(Number(r['value']))}
          {r['idle'] === true && <Label variant="secondary">Likely Idle</Label>}
        </span>
      ),
    },
    ...(isDuration
      ? ([
          { key: 'tool_uses', header: 'Tool Uses', cell: (r) => numeric(count(r['tool_uses'])), hideBelow: 'sm' },
          { key: 'tokens_out', header: 'Output Tokens', cell: (r) => numeric(r['tokens_out'] == null ? '—' : compact(Number(r['tokens_out']))), hideBelow: 'sm' },
        ] satisfies TableColumn[])
      : []),
  ];
  return (
    <section className="space-y-2" aria-label={`${OUTLIER_TITLE[kind]}${suffix}`}>
      <h3 className="text-sm font-semibold text-fg">{`${OUTLIER_TITLE[kind]}${suffix}`}</h3>
      <DataTable rows={rows as unknown as Row[]} columns={columns} filter={false} />
      {isDuration && <p className="text-xs text-fg-muted">{IDLE_CAPTION}</p>}
    </section>
  );
}

export function TokensSection({ data, params }: SectionProps) {
  const agents = shownAgents(data, params);
  const runs = perRun(agents);
  const shared = Math.max(0, ...runs.flatMap((a) => a.histograms[params.metric].map((b) => b.count)));
  const ranks = runs.length >= 2 ? rankOf(runs, params.metric) : new Map<AgentKey, string>();
  const b = bro(agents);
  return (
    <div className="space-y-4">
      <SectionHeading>Tokens</SectionHeading>
      {agents.length === 0 ? (
        <NoMatch params={params} />
      ) : (
        <>
          <Grid>
            {runs.map((s) => (
              <AgentTokenCard key={s.agent} s={s} params={params} rank={ranks.get(s.agent) ?? null} yMax={shared} />
            ))}
            {b && <AgentTokenCard s={b} params={params} rank={null} />}
          </Grid>
          <Outliers kind="tokens_out" rows={data.outliers.tokens_out} />
          <Outliers kind="context" rows={data.outliers.context} />
        </>
      )}
    </div>
  );
}

function metricColumns(agents: AgentStats[], pick: (s: AgentStats) => Metric, fmt: (v: number | null) => string): Column[] {
  return agents.map((s) => {
    const m = pick(s);
    const value = m.avg ?? 0;
    return {
      key: s.agent,
      label: s.agent,
      value,
      color: AGENT_COLOR[s.agent],
      aria: `${s.agent}: average ${fmt(m.avg)} over ${s.n} ${noun(s, s.n)}`,
      tip: `${s.agent}: avg ${fmt(m.avg)} · p50 ${fmt(m.p50)} · p95 ${fmt(m.p95)} · max ${fmt(m.max)}`,
    };
  });
}

function metricTable(agents: AgentStats[], pick: (s: AgentStats) => Metric, fmt: (v: number | null) => string): TableData {
  return { columns: ['Agent', 'n', 'avg', 'p50', 'p95', 'max'], rows: agents.map((s) => { const m = pick(s); return [s.agent, s.n, fmt(m.avg), fmt(m.p50), fmt(m.p95), fmt(m.max)]; }) };
}

function StatTiles({ tiles }: { tiles: Array<{ key: string; title: string; items: Array<[string, string]> }> }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {tiles.map((t) => (
        <div key={t.key} className="rounded-md border border-(--borderColor-muted) px-3 py-2" data-tile="">
          <p className="text-xs font-semibold text-fg">{t.title}</p>
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
            {t.items.map(([term, value]) => (
              <div key={term}>
                <dt className="text-xs text-fg-muted">{term}</dt>
                <dd className="text-base font-semibold text-fg">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

const metricTiles = (agents: AgentStats[], pick: (s: AgentStats) => Metric, fmt: (v: number | null) => string) =>
  agents.map((s) => {
    const m = pick(s);
    return { key: s.agent, title: s.agent, items: [['p50', fmt(m.p50)], ['p95', fmt(m.p95)], ['max', fmt(m.max)]] as Array<[string, string]> };
  });

interface TimeCardProps {
  title: string;
  unit: string;
  agents: AgentStats[];
  pick: (s: AgentStats) => Metric;
  fmt: (v: number | null) => string;
  axis: (max: number) => { top: number; ticks: Array<{ at: number; label: string }> };
  params: InsightParams;
  bars: boolean;
}

function TimeCard({ title, unit, agents, pick, fmt, axis, params, bars }: TimeCardProps) {
  const per = agents[0]?.per === 'session' ? 'Per Session' : 'Per Run';
  const columns = metricColumns(agents, pick, fmt);
  return (
    <ChartCard
      title={title}
      subtitle={`${period(params)} · ${per} · ${unit}`}
      section="time"
      range={params.range}
      table={metricTable(agents, pick, fmt)}
      caption={agents[0]?.per === 'session' ? BRO_CAPTION : undefined}
    >
      <div className="space-y-3">
        <StatTiles tiles={metricTiles(agents, pick, fmt)} />
        {bars && <BarList label={`${title}: ${columns.map((c) => c.aria).join('; ')}`} rows={columns} format={(v) => fmt(v)} axis={axis} />}
      </div>
    </ChartCard>
  );
}

export function TimeSection({ data, params }: SectionProps) {
  const agents = shownAgents(data, params);
  const runs = perRun(agents);
  const b = bro(agents);
  const ms = (v: number | null) => duration(v);
  const durationAxis = (max: number) => durationTicks(max);
  const toolAxis = niceAxis((v) => plain(v));
  return (
    <div className="space-y-4">
      <SectionHeading>Time</SectionHeading>
      {agents.length === 0 ? (
        <NoMatch params={params} />
      ) : (
        <>
          <Grid>
            {runs.length > 0 && <TimeCard title="Duration per Run" unit="Duration; Bars Show the Average" agents={runs} pick={(s) => s.duration_ms} fmt={ms} axis={durationAxis} params={params} bars />}
            {runs.length > 0 && <TimeCard title="Tool Uses per Run" unit="Tool Uses; Bars Show the Average" agents={runs} pick={(s) => s.tool_uses} fmt={plain} axis={toolAxis} params={params} bars />}
            {b && <TimeCard title="bro Duration per Session" unit="Duration" agents={[b]} pick={(s) => s.duration_ms} fmt={ms} axis={durationAxis} params={params} bars={false} />}
            {b && <TimeCard title="bro Tool Uses per Session" unit="Tool Uses" agents={[b]} pick={(s) => s.tool_uses} fmt={plain} axis={toolAxis} params={params} bars={false} />}
          </Grid>
          <Outliers kind="duration_ms" rows={data.outliers.duration_ms} />
        </>
      )}
    </div>
  );
}

type CostRow = { key: string; usd: number; runs: number; color: string };

const costTable = (rows: CostRow[]): TableData => ({ columns: ['Name', 'USD', 'Runs'], rows: rows.map((r) => [r.key, r.usd, r.runs]) });

function CostCard({ title, rows, label, params }: { title: string; rows: CostRow[]; label: string; params: InsightParams }) {
  const columns: Column[] = rows.map((r) => ({ key: r.key, label: r.key, value: r.usd, color: r.color, aria: `${r.key}: ${usd(r.usd)} over ${r.runs} ${label}`, tip: `${r.key}: ${usd(r.usd)}` }));
  return (
    <ChartCard title={title} subtitle={`${period(params)} · USD`} section="cost" range={params.range} table={costTable(rows)}>
      <BarList label={`${title}: ${columns.map((c) => c.aria).join('; ') || 'no priced runs'}`} rows={columns} format={usd} axis={niceAxis(usd)} />
    </ChartCard>
  );
}

function CostTile({ title, rows, label, params }: { title: string; rows: CostRow[]; label: string; params: InsightParams }) {
  return (
    <ChartCard title={title} subtitle={`${period(params)} · USD`} section="cost" range={params.range} table={costTable(rows)} caption={BRO_CAPTION}>
      <StatTiles tiles={rows.map((r) => ({ key: r.key, title: r.key, items: [['USD', usd(r.usd)], [label[0]!.toUpperCase() + label.slice(1), plain(r.runs)]] }))} />
    </ChartCard>
  );
}

export function CostSection({ data, params }: SectionProps) {
  const { cost } = data;
  if (!cost.priced) {
    return (
      <div className="space-y-4">
        <SectionHeading>Cost</SectionHeading>
        <Flash>{NO_PRICES}</Flash>
      </div>
    );
  }
  const shown = new Set(shownAgents(data, params).map((a) => a.agent));
  if (shown.size === 0) {
    return (
      <div className="space-y-4">
        <SectionHeading>Cost</SectionHeading>
        <NoMatch params={params} />
      </div>
    );
  }
  const agentRows = (keys: AgentKey[]) =>
    cost.by_agent.filter((a) => keys.includes(a.agent)).map((a) => ({ key: a.agent, usd: a.usd, runs: a.runs, color: AGENT_COLOR[a.agent] }));
  const runAgents = (['swe', 'code-reviewer'] as const).filter((a) => shown.has(a));
  const broRows = shown.has('bro') ? agentRows(['bro']) : [];
  return (
    <div className="space-y-4">
      <SectionHeading>Cost</SectionHeading>
      {cost.unpriced_runs > 0 && (
        <Flash variant="warning">
          {cost.unpriced_runs} measured {cost.unpriced_runs === 1 ? 'run has' : 'runs have'} no price for their model and {cost.unpriced_runs === 1 ? 'is' : 'are'} left out.
        </Flash>
      )}
      <Grid>
        {runAgents.length > 0 && <CostCard title="Cost by Agent" rows={agentRows(runAgents)} label="runs" params={params} />}
        {broRows.length > 0 && <CostTile title="bro Cost" rows={broRows} label="sessions" params={params} />}
        <CostCard
          title="Cost by Model"
          rows={cost.by_model.map((m) => ({ key: m.model, usd: m.usd, runs: m.runs, color: SERIES_COLOR }))}
          label="runs"
          params={params}
        />
      </Grid>
    </div>
  );
}

interface RateTileProps {
  title: string;
  passed: number;
  total: number;
  what: string;
  bar: (caption: string) => ReactNode;
  children?: ReactNode;
}

function RateTile({ title, passed, total, what, bar, children }: RateTileProps) {
  const caption = `${passed} of ${total} ${what}`;
  return (
    <Box className="space-y-2 px-4 py-3" data-rate-tile="">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <p className="text-2xl font-semibold text-fg tabular-nums">{pct(ratio(passed, total))}</p>
      {bar(caption)}
      <p className="text-xs text-fg-muted tabular-nums">{caption}</p>
      {children}
    </Box>
  );
}

const progress = (passed: number, total: number, fill: string) => (caption: string) => <ProgressBar value={passed} max={total} label={caption} fill={fill} />;

const VERDICTS = [
  ['pass', 'Pass', AGENT_FILL['code-reviewer']],
  ['fail', 'Fail', AGENT_FILL.swe],
  ['escalate', 'Escalate', AGENT_FILL.bro],
] as const;

const seconds = (v: number | null) => (v === null ? '—' : `${plain(v)}s`);
const SLOW_COLUMNS: TableColumn[] = [
  { key: 'command', header: 'Command', cell: (r) => <code className="font-mono text-xs">{String(r['command'])}</code>, truncate: 'fill' },
  { key: 'n', header: 'Runs', cell: (r) => numeric(plain(Number(r['n']))), hideBelow: 'sm' },
  { key: 'p50', header: 'p50', cell: (r) => numeric(seconds(r['p50'] as number | null)), hideBelow: 'sm' },
  { key: 'p95', header: 'p95', cell: (r) => numeric(seconds(r['p95'] as number | null)) },
  { key: 'max', header: 'max', cell: (r) => numeric(seconds(r['max'] as number | null)) },
];

export function QualitySection({ data, params }: SectionProps) {
  const q = data.quality;
  const totalVerdicts = q.verdicts.pass + q.verdicts.fail + q.verdicts.escalate;
  const attempts: Column[] = q.attempts.map((a) => {
    const label = `${a.attempts} ${a.attempts === 1 ? 'attempt' : 'attempts'}`;
    return { key: String(a.attempts), label: String(a.attempts), value: a.tasks, color: AGENT_COLOR['code-reviewer'], aria: `${label}: ${a.tasks} ${a.tasks === 1 ? 'task' : 'tasks'}`, tip: `${label}: ${a.tasks}` };
  });
  return (
    <div className="space-y-4">
      <SectionHeading>Quality</SectionHeading>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <RateTile
          title="First-Pass Rate"
          passed={q.first_pass.passed}
          total={q.first_pass.total}
          what="tasks passed review on the first attempt"
          bar={progress(q.first_pass.passed, q.first_pass.total, AGENT_FILL['code-reviewer'])}
        />
        <RateTile
          title="Verification Pass Rate"
          passed={q.verification.passed}
          total={q.verification.total}
          what="verification runs passed"
          bar={progress(q.verification.passed, q.verification.total, AGENT_FILL.swe)}
        />
        <RateTile
          title="Verdict Mix"
          passed={q.verdicts.pass}
          total={totalVerdicts}
          what="review verdicts passed"
          bar={() => (
            <StackedProgressBar
              label={`Review verdicts: ${VERDICTS.map(([k, label]) => `${label} ${q.verdicts[k]}`).join(', ')} of ${totalVerdicts}`}
              segments={VERDICTS.map(([k, label, fill]) => ({ label, value: q.verdicts[k], fill }))}
            />
          )}
        >
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted tabular-nums">
            {VERDICTS.map(([k, label, fill]) => (
              <li key={k} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className={`inline-block size-2 rounded-full ${fill}`} />
                {label} {q.verdicts[k]}
              </li>
            ))}
          </ul>
        </RateTile>
      </div>
      <Grid>
        <ChartCard
          title="Review Attempts per Task"
          subtitle={`${period(params)} · Tasks by Attempt Count`}
          section="quality"
          range={params.range}
          table={{ columns: ['Attempts', 'Tasks'], rows: q.attempts.map((a) => [a.attempts, a.tasks]) }}
        >
          <ColumnChart label={`Review attempts per task: ${attempts.map((c) => c.aria).join('; ') || 'no reviews'}`} columns={attempts} format={(v) => (Number.isInteger(v) ? String(v) : '')} />
        </ChartCard>
      </Grid>
      <section className="space-y-2" aria-label="Slowest verification commands">
        <h3 className="text-sm font-semibold text-fg">Slowest Verification Commands</h3>
        <DataTable rows={q.slowest_commands as unknown as Row[]} columns={SLOW_COLUMNS} filter={false} />
      </section>
    </div>
  );
}

type EfficiencyKey = keyof typeof EFFICIENCY_COLUMNS;

const muted = (text: ReactNode) => <span className={`${NUMERIC} text-fg-muted`}>{text}</span>;

function efficiencyMetric(key: EfficiencyKey, fmt: (v: number) => string, opts: { median?: boolean; hideBelow?: 'md' } = {}): TableColumn {
  return {
    key,
    header: EFFICIENCY_COLUMNS[key].header,
    title: EFFICIENCY_COLUMNS[key].title,
    ...(opts.hideBelow ? { hideBelow: opts.hideBelow } : {}),
    cell: (r) => {
      const v = r[key];
      if (r['few'] === true || typeof v !== 'number') return muted('—');
      return opts.median ? muted(fmt(v)) : numeric(fmt(v));
    },
  };
}

const groupName = (label: (r: Row) => string) => (r: Row) => (
  <span className="inline-flex items-center gap-2 whitespace-nowrap">
    {label(r)}
    {r['few'] === true && (
      <span title={FEW_TASKS_TITLE}>
        <Label variant="secondary">{FEW_TASKS}</Label>
      </span>
    )}
  </span>
);

const efficiencyColumns = (name: TableColumn): TableColumn[] => [
  name,
  { key: 'n', header: EFFICIENCY_COLUMNS.n.header, title: EFFICIENCY_COLUMNS.n.title, cell: (r) => numeric(plain(Number(r['n']))) },
  efficiencyMetric('first_pass_rate', pct),
  efficiencyMetric('fp_tok_line', compact),
  efficiencyMetric('fp_tok_line_median', compact, { median: true, hideBelow: 'md' }),
  efficiencyMetric('rw_tok_line', compact, { hideBelow: 'md' }),
  efficiencyMetric('rw_tok_line_median', compact, { median: true, hideBelow: 'md' }),
  efficiencyMetric('rework_share', pct),
  efficiencyMetric('cache_hit', pct, { hideBelow: 'md' }),
  efficiencyMetric('fp_sec_line', fine, { hideBelow: 'md' }),
  efficiencyMetric('rw_sec_line', fine, { hideBelow: 'md' }),
];

const TYPE_COLUMNS = efficiencyColumns({ key: 'type', header: TYPE_HEADER, cell: groupName((r) => String(r['type'])) });
const WEEK_COLUMNS = efficiencyColumns({ key: 'week', header: WEEK_HEADER, cell: groupName((r) => weekOf(shortDay(String(r['week'])))) });

function EfficiencyTable({ title, rows, columns, divider }: { title: string; rows: object[]; columns: TableColumn[]; divider?: (r: Row) => boolean }) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <DataTable rows={rows as Row[]} columns={columns} filter={false} {...(divider ? { divider } : {})} />
      <p className="text-xs text-fg-muted">{FEW_CAPTION}</p>
    </section>
  );
}

function EfficiencyTables({ e }: { e: Efficiency }) {
  if (e.by_type.every((g) => g.n === 0)) return <p className="text-sm text-fg-muted">{EFFICIENCY_EMPTY}</p>;
  return (
    <>
      <EfficiencyTable title={BY_TYPE} rows={e.by_type} columns={TYPE_COLUMNS} divider={(r) => r['type'] === 'docs'} />
      <EfficiencyTable title={BY_WEEK} rows={e.by_week} columns={WEEK_COLUMNS} />
      <p className="text-xs text-fg-muted">{EFFICIENCY_FOOTNOTE}</p>
    </>
  );
}

export function EfficiencySection({ efficiency }: { efficiency?: { data?: Efficiency; error: Error | null } }) {
  return (
    <div className="space-y-4">
      <SectionHeading>{EFFICIENCY_TITLE}</SectionHeading>
      <p className="text-sm text-fg-muted">{EFFICIENCY_SUBTITLE}</p>
      <Loading q={efficiency ?? { error: null }}>{(e) => <EfficiencyTables e={e} />}</Loading>
    </div>
  );
}

const DAY_MS = 86_400_000;

// An open-ended period (until null) ends on its last closed day.
export function closedPerDay(data: Insights, until: string | null = data.range.until): Array<{ day: string; closed: number }> {
  const byDay = new Map(data.throughput.map((d) => [d.day, d.closed]));
  const first = data.range.since?.slice(0, 10) ?? data.throughput[0]?.day;
  const last = until?.slice(0, 10) ?? data.throughput.at(-1)?.day;
  if (!first || !last) return [];
  const out: Array<{ day: string; closed: number }> = [];
  const end = Date.parse(`${last}T00:00:00Z`);
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= end; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, closed: byDay.get(day) ?? 0 });
  }
  return out;
}

export function ThroughputSection({ data, params }: SectionProps) {
  const days = closedPerDay(data);
  const total = days.reduce((s, d) => s + d.closed, 0);
  const columns: Column[] = days.map((d) => ({
    key: d.day,
    label: shortDay(d.day),
    value: d.closed,
    color: SERIES_COLOR,
    aria: `${shortDay(d.day)}: ${d.closed} closed ${d.closed === 1 ? 'task' : 'tasks'}`,
    tip: `${shortDay(d.day)}: ${d.closed}`,
  }));
  return (
    <div className="space-y-4">
      <SectionHeading>Throughput</SectionHeading>
      <ChartCard
        title="Closed Tasks per Day"
        subtitle={`${period(params)} · Tasks per Day`}
        section="throughput"
        range={params.range}
        table={{ columns: ['Day', 'Closed Tasks'], rows: days.map((d) => [d.day, d.closed]) }}
      >
        <ColumnChart label={`Closed tasks per day: ${total} over ${days.length} days`} columns={columns} format={(v) => (Number.isInteger(v) ? String(v) : '')} />
      </ChartCard>
    </div>
  );
}

interface CompareProps {
  cmp: Comparison;
  params: InsightParams;
  compare: Compare;
}

const polarityCaption = (measure: DeltaMeasure) => (POLARITY[measure] === 'lower' ? LOWER_BETTER : POLARITY[measure] === 'higher' ? HIGHER_BETTER : undefined);

const withBro = (caption: string | undefined, s: AgentStats) => (s.per === 'session' ? [caption, BRO_CAPTION].filter(Boolean).join(' ') : caption);

interface AgentPair {
  agent: AgentKey;
  a1: AgentStats;
  a2: AgentStats;
}

function agentPairs({ cmp, params }: CompareProps): AgentPair[] {
  const pairs = cmp.p2.agents.flatMap((a2) => {
    const a1 = cmp.p1.agents.find((a) => a.agent === a2.agent);
    return a1 ? [{ agent: a2.agent, a1, a2 }] : [];
  });
  const kept = cmp.bro_excluded ? pairs.filter((p) => p.agent !== 'bro') : pairs;
  return activeFilterCount(params) > 0 ? kept.filter((p) => p.a1.total + p.a2.total > 0) : kept;
}

const broNote = ({ cmp, compare }: CompareProps) =>
  !cmp.bro_excluded ? null : compare.p1.kind === 'tasks' && compare.p2.kind === 'tasks' ? BRO_TASKS_CAPTION : BRO_EXCLUDED_CAPTION;

function BothEmpty({ params, compare }: { params: InsightParams; compare: Compare }) {
  return (
    <Box>
      <Blankslate
        icon={FilterIcon}
        heading={NO_RUNS_EITHER}
        description={noRunsEither(sliceLabel(compare.p1), sliceLabel(compare.p2))}
        action={<Button href={insightHash(clearFilters(params))}>Clear Filters</Button>}
      />
    </Box>
  );
}

function OneEmpty({ cmp, compare }: { cmp: Comparison; compare: Compare }) {
  const empty = ([1, 2] as const).filter((n) => totalRuns(n === 1 ? cmp.p1 : cmp.p2) === 0);
  return (
    <>
      {empty.map((n) => (
        <p key={n} className="text-sm text-fg-muted" data-period-empty={n}>
          {noRunsIn(n, sliceLabel(n === 1 ? compare.p1 : compare.p2))}
        </p>
      ))}
    </>
  );
}

const bothEmpty = (cmp: Comparison) => totalRuns(cmp.p1) === 0 && totalRuns(cmp.p2) === 0;

function CompareStats({ rows, measure, fmt, what }: { rows: Array<[string, number | null, number | null]>; measure: DeltaMeasure; fmt: (v: number | null) => string; what: string }) {
  const cell = 'px-1 py-1 whitespace-nowrap';
  return (
    <table className="w-full text-sm tabular-nums" data-compare-stats="">
      <thead>
        <tr className="border-b border-(--borderColor-muted) text-left text-xs text-fg-muted">
          {[MEASURE_HEADER, periodName(1), periodName(2), CHANGE_HEADER].map((h) => (
            <th key={h} scope="col" className={`${cell} font-semibold`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, v1, v2]) => (
          <tr key={k}>
            <th scope="row" className={`${cell} text-left font-normal text-fg-muted`}>
              {k}
            </th>
            <td className={`${cell} text-fg`}>{fmt(v1)}</td>
            <td className={`${cell} font-semibold text-fg`}>{fmt(v2)}</td>
            <td className={cell}>
              <DeltaLabel measure={measure} subject={`${k} ${what}`} p1={v1} p2={v2} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function compareHistogramTable(a1: AgentStats, a2: AgentStats, metric: MetricKey): TableData {
  const share = (count: number, n: number) => pct(shareOf(count, n) / 100);
  return {
    columns: [...histogramColumns(metric), periodRuns(1, a2.per), periodShare(1), periodRuns(2, a2.per), periodShare(2)],
    rows: a2.histograms[metric].map((b, i) => {
      const c1 = a1.histograms[metric][i]?.count ?? 0;
      return [tableValue(metric, b.from), tableValue(metric, b.to), c1, share(c1, a1.n), b.count, share(b.count, a2.n)];
    }),
  };
}

const maxShare = (pairs: AgentPair[], metric: MetricKey) =>
  Math.max(0, ...pairs.flatMap((p) => [p.a1, p.a2].flatMap((s) => s.histograms[metric].map((b) => shareOf(b.count, s.n)))));

function CompareAgentCard({ pair, params, compare, yMax }: { pair: AgentPair; params: InsightParams; compare: Compare; yMax?: number }) {
  const { a1, a2 } = pair;
  const metric = params.metric;
  const fmt = formatFor(metric);
  const what = METRIC_COPY[metric].noun;
  const per = a2.per === 'session' ? 'Per Session' : 'Per Run';
  const m1 = a1[metric];
  const m2 = a2[metric];
  const early = (s: AgentStats) => s.n < EARLY_MIN;
  const color = AGENT_COLOR[pair.agent];
  const hasData = [a1, a2].some((s) => s.histograms[metric].some((b) => b.count > 0));
  const period = (s: AgentStats, m: Metric): OverlayPeriod => ({ buckets: s.histograms[metric], n: s.n, p50: early(s) ? null : m.p50, p95: early(s) ? null : m.p95 });
  const markerText = (s: AgentStats, v: number | null) => (early(s) || v === null ? null : fmt(v));
  return (
    <ChartCard
      title={pair.agent}
      subtitle={`${COMPARE_SUBTITLE} · ${per} · ${histogramSubtitle(metric, a2.per)}`}
      section="tokens"
      range={compareSlug(compare)}
      table={compareHistogramTable(a1, a2, metric)}
      legend={[
        { label: periodLabel(1, sliceLabel(compare.p1)), color, kind: 'outline' },
        { label: periodLabel(2, sliceLabel(compare.p2)), color, kind: 'fill' },
      ]}
      caption={withBro(polarityCaption(metric), a2)}
    >
      <div className="space-y-2" data-agent={pair.agent}>
        <p className="text-xs text-fg-muted tabular-nums">{compareMeasured([{ n: a1.n, total: a1.total }, { n: a2.n, total: a2.total }], a2.per)}</p>
        <CompareStats rows={[['p50', m1.p50, m2.p50], ['p95', m1.p95, m2.p95], ['avg', m1.avg, m2.avg]]} measure={metric} fmt={fmt} what={what} />
        {([1, 2] as const).map((n) => {
          const s = n === 1 ? a1 : a2;
          return early(s) ? (
            <p key={n} className="text-xs font-semibold text-(--fgColor-attention)">
              {periodEarly(n, earlyData(s.n))}
            </p>
          ) : null;
        })}
        {!hasData ? (
          <p className="text-sm text-fg-muted">{`No ${what} data in this period.`}</p>
        ) : (
          <OverlayHistogram
            label={overlayAria(`${pair.agent} ${what} ${per.toLowerCase()}`, [
              { n: a1.n, p50: markerText(a1, m1.p50), p95: markerText(a1, m1.p95) },
              { n: a2.n, p50: markerText(a2, m2.p50), p95: markerText(a2, m2.p95) },
            ])}
            measure={what}
            who={pair.agent}
            per={a2.per}
            linear={metric === 'cache_hit'}
            color={color}
            yMax={yMax}
            format={fmt}
            p1={period(a1, m1)}
            p2={period(a2, m2)}
          />
        )}
      </div>
    </ChartCard>
  );
}

function CompareCaption({ text }: { text: string | null }) {
  return text ? (
    <p className="text-xs text-fg-muted" data-bro-caption="">
      {text}
    </p>
  ) : null;
}

export function CompareTokensSection(props: CompareProps) {
  const { cmp, params, compare } = props;
  const pairs = agentPairs(props);
  const runs = pairs.filter((p) => p.a2.per === 'run');
  const b = pairs.find((p) => p.agent === 'bro');
  const shared = maxShare(runs, params.metric);
  return (
    <div className="space-y-4">
      <SectionHeading>Tokens</SectionHeading>
      {bothEmpty(cmp) ? (
        <BothEmpty params={params} compare={compare} />
      ) : (
        <>
          <OneEmpty cmp={cmp} compare={compare} />
          <PerTaskStrip cmp={cmp} />
          <Grid>
            {runs.map((p) => (
              <CompareAgentCard key={p.agent} pair={p} params={params} compare={compare} yMax={shared} />
            ))}
            {b && <CompareAgentCard pair={b} params={params} compare={compare} />}
          </Grid>
          <CompareCaption text={broNote(props)} />
          <Outliers kind="tokens_out" rows={cmp.p2.outliers.tokens_out} suffix={OUTLIERS_P2} />
          <Outliers kind="context" rows={cmp.p2.outliers.context} suffix={OUTLIERS_P2} />
        </>
      )}
    </div>
  );
}

const costPer = (usdTotal: number | undefined, runs: number | undefined) => (usdTotal === undefined || !runs ? null : usdTotal / runs);

interface PairCost {
  key: string;
  color: string;
  p1: number | null;
  p2: number | null;
  runs1: number;
  runs2: number;
}

const money = (v: number | null) => (v === null ? '—' : usd(v));
const usdCell = (v: number | null) => (v === null ? '—' : Math.round(v * 10_000) / 10_000);

function CompareCostCard({ title, rows, compare }: { title: string; rows: PairCost[]; compare: Compare }) {
  const paired: PairedRow[] = rows.map((r) => {
    const subject = costPerRunSubject(r.key);
    const d = delta('cost', subject, r.p1, r.p2);
    const text = pairText(r.key, money(r.p1), money(r.p2));
    return { key: r.key, label: r.key, color: r.color, p1: r.p1, p2: r.p2, aria: `${text}. ${d.aria}`, tip: `${text}, ${d.text}`, deltaText: d.text, delta: <DeltaLabel measure="cost" subject={subject} p1={r.p1} p2={r.p2} /> };
  });
  return (
    <ChartCard
      title={title}
      subtitle={`${COMPARE_SUBTITLE} · ${COST_PER_RUN_UNIT}`}
      section="cost"
      range={compareSlug(compare)}
      table={{
        columns: [NAME_HEADER, periodCost(1), periodCost(2), periodRuns(1, 'run'), periodRuns(2, 'run')],
        rows: rows.map((r) => [r.key, usdCell(r.p1), usdCell(r.p2), r.runs1, r.runs2]),
      }}
      legend={[
        { label: periodLabel(1, sliceLabel(compare.p1)), color: LEGEND_COLOR, kind: 'outline' },
        { label: periodLabel(2, sliceLabel(compare.p2)), color: LEGEND_COLOR, kind: 'fill' },
      ]}
      caption={LOWER_BETTER}
    >
      <PairedBarList label={`${title}: ${paired.map((r) => r.aria).join('; ')}`} rows={paired} format={usd} axis={niceAxis(usd)} />
    </ChartCard>
  );
}

const LEGEND_COLOR = 'var(--fgColor-muted)';

export function CompareCostSection(props: CompareProps) {
  const { cmp, params, compare } = props;
  const { p1, p2 } = cmp;
  if (!p1.cost.priced && !p2.cost.priced) {
    return (
      <div className="space-y-4">
        <SectionHeading>Cost</SectionHeading>
        <Flash>{NO_PRICES}</Flash>
      </div>
    );
  }
  if (bothEmpty(cmp)) {
    return (
      <div className="space-y-4">
        <SectionHeading>Cost</SectionHeading>
        <BothEmpty params={params} compare={compare} />
      </div>
    );
  }
  const shown = new Set(agentPairs(props).map((p) => p.agent));
  const agentCost = (agent: AgentKey): PairCost => {
    const c1 = p1.cost.by_agent.find((a) => a.agent === agent);
    const c2 = p2.cost.by_agent.find((a) => a.agent === agent);
    return { key: agent, color: AGENT_COLOR[agent], p1: costPer(c1?.usd, c1?.runs), p2: costPer(c2?.usd, c2?.runs), runs1: c1?.runs ?? 0, runs2: c2?.runs ?? 0 };
  };
  const runAgents = (['swe', 'code-reviewer'] as const).filter((a) => shown.has(a));
  const models = [...new Set([...p1.cost.by_model, ...p2.cost.by_model].map((m) => m.model))];
  const modelRows = models.map((model): PairCost => {
    const c1 = p1.cost.by_model.find((m) => m.model === model);
    const c2 = p2.cost.by_model.find((m) => m.model === model);
    return { key: model, color: SERIES_COLOR, p1: costPer(c1?.usd, c1?.runs), p2: costPer(c2?.usd, c2?.runs), runs1: c1?.runs ?? 0, runs2: c2?.runs ?? 0 };
  });
  const broCost = shown.has('bro') ? agentCost('bro') : null;
  return (
    <div className="space-y-4">
      <SectionHeading>Cost</SectionHeading>
      {([1, 2] as const).map((n) => {
        const unpriced = (n === 1 ? p1 : p2).cost.unpriced_runs;
        return unpriced > 0 ? (
          <Flash key={n} variant="warning">
            {periodUnpriced(n, unpriced)}
          </Flash>
        ) : null;
      })}
      <OneEmpty cmp={cmp} compare={compare} />
      <Grid>
        {runAgents.length > 0 && <CompareCostCard title={COST_PER_RUN_AGENT} rows={runAgents.map(agentCost)} compare={compare} />}
        {broCost && (
          <ChartCard
            title={BRO_COST_PER_SESSION}
            subtitle={`${COMPARE_SUBTITLE} · ${COST_PER_SESSION_UNIT}`}
            section="cost"
            range={compareSlug(compare)}
            table={{ columns: [NAME_HEADER, periodName(1), periodName(2), periodRuns(1, 'session'), periodRuns(2, 'session')], rows: [['bro', usdCell(broCost.p1), usdCell(broCost.p2), broCost.runs1, broCost.runs2]] }}
            caption={`${LOWER_BETTER} ${BRO_CAPTION}`}
          >
            <CompareTile title="bro" measure="cost" subject={costPerSessionSubject('bro')} p1={broCost.p1} p2={broCost.p2} format={money} />
          </ChartCard>
        )}
        <CompareCostCard title={COST_PER_RUN_MODEL} rows={modelRows} compare={compare} />
      </Grid>
      <CompareCaption text={broNote(props)} />
    </div>
  );
}

const sectionTitle = (s: Section) => SECTIONS.find(([k]) => k === s)![1];

const periodLegend = (compare: Compare, color: string) => [
  { label: periodLabel(1, sliceLabel(compare.p1)), color, kind: 'outline' as const },
  { label: periodLabel(2, sliceLabel(compare.p2)), color, kind: 'fill' as const },
];

function CompareShell({ section, props, children }: { section: Section; props: CompareProps; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <SectionHeading>{sectionTitle(section)}</SectionHeading>
      {bothEmpty(props.cmp) ? (
        <BothEmpty params={props.params} compare={props.compare} />
      ) : (
        <>
          <OneEmpty cmp={props.cmp} compare={props.compare} />
          {children}
        </>
      )}
    </div>
  );
}

type TimeKey = 'duration_ms' | 'tool_uses';

const TIME_FORMAT: Record<TimeKey, (v: number | null) => string> = { duration_ms: duration, tool_uses: plain };
const TIME_AXIS: Record<TimeKey, (max: number) => { top: number; ticks: Array<{ at: number; label: string }> }> = {
  duration_ms: (max) => durationTicks(max),
  tool_uses: niceAxis((v) => plain(v)),
};
const STAT_KEYS = ['p50', 'p95', 'avg'] as const;

function pairedRow(key: string, color: string, measure: DeltaMeasure, subject: string, p1: number | null, p2: number | null, fmt: (v: number | null) => string): PairedRow {
  const d = delta(measure, subject, p1, p2);
  const text = pairText(key, fmt(p1), fmt(p2));
  return { key, label: key, color, p1, p2, aria: `${text}. ${d.aria}`, tip: `${text}, ${d.text}`, deltaText: d.text, delta: <DeltaLabel measure={measure} subject={subject} p1={p1} p2={p2} /> };
}

function CompareTimeCard({ title, unit, pairs, measure, compare, bars }: { title: string; unit: string; pairs: AgentPair[]; measure: TimeKey; compare: Compare; bars: boolean }) {
  const fmt = TIME_FORMAT[measure];
  const what = TIME_SUBJECT[measure];
  const per = pairs[0]!.a2.per;
  const rows = pairs.map((p) => pairedRow(p.agent, AGENT_COLOR[p.agent], measure, averageSubject(p.agent, what), p.a1[measure].avg, p.a2[measure].avg, fmt));
  return (
    <ChartCard
      title={title}
      subtitle={`${COMPARE_SUBTITLE} · ${per === 'session' ? PER_SESSION : PER_RUN} · ${bars ? `${unit}; ${AVERAGE_BARS}` : unit}`}
      section="time"
      range={compareSlug(compare)}
      table={{
        columns: [AGENT_HEADER, MEASURE_HEADER, periodName(1), periodName(2)],
        rows: pairs.flatMap((p) => STAT_KEYS.map((k) => [p.agent, k, fmt(p.a1[measure][k]), fmt(p.a2[measure][k])])),
      }}
      {...(bars ? { legend: periodLegend(compare, LEGEND_COLOR) } : {})}
      caption={withBro(polarityCaption(measure), pairs[0]!.a2)}
    >
      <div className="space-y-3">
        {pairs.map((p) => (
          <div key={p.agent} className="space-y-1" data-agent={p.agent}>
            <p className="text-xs font-semibold text-fg">{p.agent}</p>
            <CompareStats rows={STAT_KEYS.map((k) => [k, p.a1[measure][k], p.a2[measure][k]])} measure={measure} fmt={fmt} what={what} />
          </div>
        ))}
        {bars && <PairedBarList label={`${title}: ${rows.map((r) => r.aria).join('; ')}`} rows={rows} format={(v) => fmt(v)} axis={TIME_AXIS[measure]} />}
      </div>
    </ChartCard>
  );
}

export function CompareTimeSection(props: CompareProps) {
  const { cmp, compare } = props;
  const pairs = agentPairs(props);
  const runs = pairs.filter((p) => p.a2.per === 'run');
  const b = pairs.find((p) => p.agent === 'bro');
  return (
    <CompareShell section="time" props={props}>
      <Grid>
        {runs.length > 0 && <CompareTimeCard title={DURATION_PER_RUN} unit={DURATION_UNIT} pairs={runs} measure="duration_ms" compare={compare} bars />}
        {runs.length > 0 && <CompareTimeCard title={TOOL_USES_PER_RUN} unit={TOOL_USES_UNIT} pairs={runs} measure="tool_uses" compare={compare} bars />}
        {b && <CompareTimeCard title={BRO_DURATION_PER_SESSION} unit={DURATION_UNIT} pairs={[b]} measure="duration_ms" compare={compare} bars={false} />}
        {b && <CompareTimeCard title={BRO_TOOL_USES_PER_SESSION} unit={TOOL_USES_UNIT} pairs={[b]} measure="tool_uses" compare={compare} bars={false} />}
      </Grid>
      <CompareCaption text={broNote(props)} />
      <Outliers kind="duration_ms" rows={cmp.p2.outliers.duration_ms} suffix={OUTLIERS_P2} />
    </CompareShell>
  );
}

const PERIODS = [1, 2] as const;

function PeriodBars({ bar, captions }: { bar: (n: 1 | 2) => ReactNode; captions: [string, string] }) {
  return (
    <div className="space-y-1">
      {PERIODS.map((n) => (
        <div key={n} className="space-y-0.5" data-period-bar={n}>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="w-3 text-xs font-semibold text-fg-muted tabular-nums">
              {periodBar(n)}
            </span>
            <div className="min-w-0 flex-1">{bar(n)}</div>
          </div>
          <p className="text-xs text-fg-muted tabular-nums">{periodOf(n, captions[n - 1]!)}</p>
        </div>
      ))}
    </div>
  );
}

type Rate = { passed: number; total: number };

function CompareRateTile({ title, measure, rates, what, fill }: { title: string; measure: 'first_pass' | 'verification'; rates: [Rate, Rate]; what: string; fill: string }) {
  const [r1, r2] = rates.map((r) => ratio(r.passed, r.total)) as [number | null, number | null];
  const captions = rates.map((r) => `${r.passed} of ${r.total} ${what}`) as [string, string];
  return (
    <Box className="space-y-2 px-4 py-3" data-rate-tile={measure}>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <p className="text-2xl font-semibold text-fg tabular-nums">{pct(r2)}</p>
      <p className="text-xs text-fg-muted tabular-nums" data-period1-rate="">
        {period1Value(pct(r1))}
      </p>
      <DeltaLabel measure={measure} subject={rateSubject[measure]} p1={r1} p2={r2} />
      <PeriodBars captions={captions} bar={(n) => <ProgressBar value={rates[n - 1]!.passed} max={rates[n - 1]!.total} label={periodOf(n, captions[n - 1]!)} fill={fill} />} />
    </Box>
  );
}

type Verdicts = Insights['quality']['verdicts'];

const verdictTotal = (v: Verdicts) => v.pass + v.fail + v.escalate;

function CompareVerdictTile({ verdicts }: { verdicts: [Verdicts, Verdicts] }) {
  const captions = verdicts.map((v) => `${v.pass} of ${verdictTotal(v)} ${VERDICTS_WHAT}`) as [string, string];
  return (
    <Box className="space-y-2 px-4 py-3" data-rate-tile="verdicts">
      <h3 className="text-sm font-semibold text-fg">{VERDICT_MIX}</h3>
      <PeriodBars
        captions={captions}
        bar={(n) => {
          const v = verdicts[n - 1]!;
          return (
            <StackedProgressBar
              label={periodOf(n, `Review verdicts: ${VERDICTS.map(([k, label]) => `${label} ${v[k]}`).join(', ')} of ${verdictTotal(v)}`)}
              segments={VERDICTS.map(([k, label, fill]) => ({ label, value: v[k], fill }))}
            />
          );
        }}
      />
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted tabular-nums">
        {VERDICTS.map(([k, label, fill]) => (
          <li key={k} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`inline-block size-2 rounded-full ${fill}`} />
            {label}
          </li>
        ))}
      </ul>
    </Box>
  );
}

const shareOfTasks = (p: PeriodInsights, attempts: number) => {
  const total = p.quality.attempts.reduce((s, a) => s + a.tasks, 0);
  const tasks = p.quality.attempts.find((a) => a.attempts === attempts)?.tasks ?? 0;
  return { tasks, share: total > 0 ? tasks / total : null };
};

export function CompareQualitySection(props: CompareProps) {
  const { cmp, compare } = props;
  const { p1, p2 } = cmp;
  const buckets = [...new Set([...p1.quality.attempts, ...p2.quality.attempts].map((a) => a.attempts))].sort((a, b) => a - b);
  const shares = buckets.map((n) => ({ n, s1: shareOfTasks(p1, n), s2: shareOfTasks(p2, n) }));
  const color = AGENT_COLOR['code-reviewer'];
  const rows = shares.map(({ n, s1, s2 }) => pairedRow(attemptsLabel(n), color, 'share', attemptsSubject(n), s1.share, s2.share, pct));
  return (
    <CompareShell section="quality" props={props}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <CompareRateTile title={FIRST_PASS_RATE} measure="first_pass" rates={[p1.quality.first_pass, p2.quality.first_pass]} what={FIRST_PASS_WHAT} fill={AGENT_FILL['code-reviewer']} />
        <CompareRateTile title={VERIFICATION_PASS_RATE} measure="verification" rates={[p1.quality.verification, p2.quality.verification]} what={VERIFICATION_WHAT} fill={AGENT_FILL.swe} />
        <CompareVerdictTile verdicts={[p1.quality.verdicts, p2.quality.verdicts]} />
      </div>
      <Grid>
        <ChartCard
          title={REVIEW_ATTEMPTS}
          subtitle={`${COMPARE_SUBTITLE} · ${ATTEMPTS_SHARE_UNIT}`}
          section="quality"
          range={compareSlug(compare)}
          table={{
            columns: [ATTEMPTS_HEADER, periodTasks(1), periodShare(1), periodTasks(2), periodShare(2)],
            rows: shares.map(({ n, s1, s2 }) => [n, s1.tasks, pct(s1.share), s2.tasks, pct(s2.share)]),
          }}
          legend={periodLegend(compare, color)}
        >
          <PairedBarList label={`${REVIEW_ATTEMPTS}: ${rows.map((r) => r.aria).join('; ')}`} rows={rows} format={(v) => pct(v)} axis={niceAxis((v) => pct(v))} />
        </ChartCard>
      </Grid>
      <section className="space-y-2" aria-label={`${SLOWEST_COMMANDS}${OUTLIERS_P2}`}>
        <h3 className="text-sm font-semibold text-fg">{`${SLOWEST_COMMANDS}${OUTLIERS_P2}`}</h3>
        <DataTable rows={p2.quality.slowest_commands as unknown as Row[]} columns={SLOW_COLUMNS} filter={false} />
      </section>
    </CompareShell>
  );
}

// A dates period's until is the exclusive day after its To; an open one runs to today.
const periodUntil = (p: PeriodInsights): string | null => {
  if (p.slice.kind !== 'dates') return p.range.until;
  return p.range.until ? new Date(Date.parse(p.range.until) - DAY_MS).toISOString() : new Date().toISOString();
};

const closedColumns = (days: Array<{ day: string; closed: number }>): Column[] =>
  days.map((d) => ({
    key: d.day,
    label: shortDay(d.day),
    value: d.closed,
    color: SERIES_COLOR,
    aria: `${shortDay(d.day)}: ${d.closed} closed ${d.closed === 1 ? 'task' : 'tasks'}`,
    tip: `${shortDay(d.day)}: ${d.closed}`,
  }));

export function CompareThroughputSection(props: CompareProps) {
  const { cmp, compare } = props;
  const periods = PERIODS.map((n) => {
    const p = n === 1 ? cmp.p1 : cmp.p2;
    const days = closedPerDay(p, periodUntil(p));
    const total = days.reduce((s, d) => s + d.closed, 0);
    return { n, label: periodLabel(n, sliceLabel(n === 1 ? compare.p1 : compare.p2)), days, total, avg: days.length > 0 ? total / days.length : null };
  });
  const yMax = Math.max(0, ...periods.flatMap((p) => p.days.map((d) => d.closed)));
  const [a1, a2] = [periods[0]!.avg, periods[1]!.avg];
  return (
    <CompareShell section="throughput" props={props}>
      <div className="space-y-1" data-throughput-stats="">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm tabular-nums">
          <span className="font-semibold text-fg">{AVG_CLOSED_PER_DAY}</span>
          {periods.map((p) => (
            <span key={p.n} className="flex gap-1.5">
              <span className="text-fg-muted">{periodName(p.n)}</span>
              <span className="font-semibold text-fg">{plain(p.avg)}</span>
            </span>
          ))}
          <DeltaLabel measure="throughput" subject={AVG_CLOSED_SUBJECT} p1={a1} p2={a2} />
        </div>
        <p className="text-xs text-fg-muted">{HIGHER_BETTER}</p>
      </div>
      {periods.map((p) => (
        <ChartCard
          key={p.n}
          title={p.label}
          subtitle={`${CLOSED_PER_DAY} · ${TASKS_PER_DAY_UNIT}`}
          section="throughput"
          range={`${compareSlug(compare)}-p${p.n}`}
          table={{ columns: [DAY_HEADER, CLOSED_HEADER], rows: p.days.map((d) => [d.day, d.closed]) }}
        >
          <div data-throughput-period={p.n}>
            {p.days.length === 0 ? (
              <p className="text-sm text-fg-muted">{NO_CLOSED_TASKS}</p>
            ) : (
              <ColumnChart label={closedAria(p.label, p.total, p.days.length)} columns={closedColumns(p.days)} yMax={yMax} format={(v) => (Number.isInteger(v) ? String(v) : '')} />
            )}
          </div>
        </ChartCard>
      ))}
    </CompareShell>
  );
}
