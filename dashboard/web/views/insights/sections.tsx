import { FilterIcon } from '@primer/octicons-react';
import type { ReactNode } from 'react';
import type { Row } from '../../api.ts';
import { DataTable, type Column as TableColumn } from '../../DataTable.tsx';
import { agentCell, entityLink } from '../../shared/columns.tsx';
import { Blankslate } from '../../ui/Blankslate.tsx';
import { Box } from '../../ui/Box.tsx';
import { Button } from '../../ui/Button.tsx';
import { Flash } from '../../ui/Flash.tsx';
import { Label } from '../../ui/Label.tsx';
import { ProgressBar, StackedProgressBar } from '../../ui/ProgressBar.tsx';
import { ChartCard } from './ChartCard.tsx';
import { BarList, ColumnChart, Histogram, niceAxis, type Column } from './charts.tsx';
import { AGENT_COLOR, AGENT_FILL, SERIES_COLOR, compact, duration, durationTicks, pct, plain, ratio, shortDay, usd } from './format.ts';
import {
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
import type { AgentKey, AgentStats, Insights, Metric, Outlier } from './types.ts';
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

function Outliers({ kind, rows }: { kind: keyof typeof OUTLIER_TITLE; rows: Outlier[] }) {
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
    <section className="space-y-2" aria-label={OUTLIER_TITLE[kind]}>
      <h3 className="text-sm font-semibold text-fg">{OUTLIER_TITLE[kind]}</h3>
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

export function QualitySection({ data, params }: SectionProps) {
  const q = data.quality;
  const totalVerdicts = q.verdicts.pass + q.verdicts.fail + q.verdicts.escalate;
  const attempts: Column[] = q.attempts.map((a) => {
    const label = `${a.attempts} ${a.attempts === 1 ? 'attempt' : 'attempts'}`;
    return { key: String(a.attempts), label: String(a.attempts), value: a.tasks, color: AGENT_COLOR['code-reviewer'], aria: `${label}: ${a.tasks} ${a.tasks === 1 ? 'task' : 'tasks'}`, tip: `${label}: ${a.tasks}` };
  });
  const seconds = (v: number | null) => (v === null ? '—' : `${plain(v)}s`);
  const slowColumns: TableColumn[] = [
    { key: 'command', header: 'Command', cell: (r) => <code className="font-mono text-xs">{String(r['command'])}</code>, truncate: 'fill' },
    { key: 'n', header: 'Runs', cell: (r) => numeric(plain(Number(r['n']))), hideBelow: 'sm' },
    { key: 'p50', header: 'p50', cell: (r) => numeric(seconds(r['p50'] as number | null)), hideBelow: 'sm' },
    { key: 'p95', header: 'p95', cell: (r) => numeric(seconds(r['p95'] as number | null)) },
    { key: 'max', header: 'max', cell: (r) => numeric(seconds(r['max'] as number | null)) },
  ];
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
        <DataTable rows={q.slowest_commands as unknown as Row[]} columns={slowColumns} filter={false} />
      </section>
    </div>
  );
}

const DAY_MS = 86_400_000;

export function closedPerDay(data: Insights): Array<{ day: string; closed: number }> {
  const byDay = new Map(data.throughput.map((d) => [d.day, d.closed]));
  const first = data.range.since?.slice(0, 10) ?? data.throughput[0]?.day;
  if (!first) return [];
  const out: Array<{ day: string; closed: number }> = [];
  const end = Date.parse(`${data.range.until.slice(0, 10)}T00:00:00Z`);
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
