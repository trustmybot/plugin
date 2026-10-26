import type { ReactNode } from 'react';
import type { Row } from '../../api.ts';
import { DataTable, type Column as TableColumn } from '../../DataTable.tsx';
import { agentCell, entityLink } from '../../shared/columns.tsx';
import { Box } from '../../ui/Box.tsx';
import { Flash } from '../../ui/Flash.tsx';
import { ProgressBar, StackedProgressBar } from '../../ui/ProgressBar.tsx';
import { ChartCard } from './ChartCard.tsx';
import { ColumnChart, Histogram, type Column } from './charts.tsx';
import { AGENT_COLOR, THROUGHPUT_COLOR, compact, duration, pct, plain, ratio, shortDay, usd } from './format.ts';
import { METRICS, RANGES, type InsightParams, type MetricKey } from './params.ts';
import type { AgentKey, AgentStats, Insights, Metric, Outlier } from './types.ts';
import type { TableData } from './csv.ts';

export const NO_PRICES = 'Cost tracking is off: no model prices set. Ask bro to set your model prices to turn it on.';
export const EFFORT_CAPTION = 'Effort is set per task, so this compares task size, not the setting.';
export const BRO_CAPTION = 'bro is metered per session, not per run.';
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

function histogramTable(s: AgentStats): TableData {
  return { columns: ['From (tokens)', 'To (tokens)', s.per === 'session' ? 'Sessions' : 'Runs'], rows: s.histogram.map((b) => [b.from, b.to, b.count]) };
}

function AgentTokenCard({ s, params, rank, yMax }: { s: AgentStats; params: InsightParams; rank: string | null; yMax?: number }) {
  const m = s[params.metric];
  const fmt = formatFor(params.metric);
  const per = s.per === 'session' ? 'Per session' : 'Per run';
  const early = s.n < EARLY_MIN;
  return (
    <ChartCard
      title={s.agent}
      subtitle={`${period(params)} · ${per} · output tokens`}
      section="tokens"
      range={params.range}
      table={histogramTable(s)}
      caption={s.per === 'session' ? BRO_CAPTION : undefined}
    >
      <div className="space-y-2" data-agent={s.agent}>
        {rank && <p className="text-xs text-fg-muted">{rank}</p>}
        <p className="text-xs text-fg-muted tabular-nums">{measuredLine(s)}</p>
        <Stats items={[[`p50 ${metricLabel(params.metric)}`, fmt(m.p50)], ['p95', fmt(m.p95)], ['max', fmt(m.max)]]} />
        {early && <p className="text-xs font-semibold text-(--fgColor-attention)">{earlyData(s.n)}</p>}
        <Histogram
          label={`${s.agent} output tokens ${per.toLowerCase()}: ${s.n} measured, ${s.histogram.length} buckets${early ? '' : `, p50 ${compact(s.tokens_out.p50)}, p95 ${compact(s.tokens_out.p95)}`}`}
          unit={s.per === 'session' ? 'Sessions' : 'Runs'}
          who={s.agent}
          buckets={s.histogram}
          color={AGENT_COLOR[s.agent]}
          yMax={yMax}
          p50={early ? null : s.tokens_out.p50}
          p95={early ? null : s.tokens_out.p95}
          format={compact}
        />
      </div>
    </ChartCard>
  );
}

function rankOf(agents: AgentStats[], metric: MetricKey): Map<AgentKey, string> {
  const ranked = [...agents].sort((a, b) => (b[metric].avg ?? -1) - (a[metric].avg ?? -1));
  return new Map(ranked.map((a, i) => [a.agent, `Rank ${i + 1} of ${ranked.length} by average ${metricLabel(metric).toLowerCase()}`]));
}

const OUTLIER_TITLE = { tokens_out: 'Top runs by output tokens', context: 'Top runs by context', duration_ms: 'Top runs by duration' } as const;

function Outliers({ kind, rows }: { kind: keyof typeof OUTLIER_TITLE; rows: Outlier[] }) {
  const fmt = kind === 'duration_ms' ? duration : compact;
  const columns: TableColumn[] = [
    { key: 'run_id', header: 'Run', hideBelow: 'sm' },
    { key: 'agent', header: 'Agent', cell: agentCell('agent') },
    { key: 'task_id', header: 'Task', cell: entityLink('task', 'task_id') },
    { key: 'task_title', header: 'Title', cell: entityLink('task', 'task_id', 'task_title'), truncate: true, hideBelow: 'md' },
    { key: 'value', header: kind === 'duration_ms' ? 'Duration' : 'Tokens', cell: (r) => <span className="tabular-nums">{fmt(Number(r['value']))}</span> },
  ];
  return (
    <section className="space-y-2" aria-label={OUTLIER_TITLE[kind]}>
      <h3 className="text-sm font-semibold text-fg">{OUTLIER_TITLE[kind]}</h3>
      <DataTable rows={rows as unknown as Row[]} columns={columns} filter={false} />
    </section>
  );
}

export function TokensSection({ data, params }: SectionProps) {
  const runs = perRun(data.agents);
  const shared = Math.max(0, ...runs.flatMap((a) => a.histogram.map((b) => b.count)));
  const ranks = rankOf(runs, params.metric);
  const b = bro(data.agents);
  return (
    <div className="space-y-4">
      <SectionHeading>Tokens</SectionHeading>
      <Grid>
        {runs.map((s) => (
          <AgentTokenCard key={s.agent} s={s} params={params} rank={ranks.get(s.agent) ?? null} yMax={shared} />
        ))}
        {b && <AgentTokenCard s={b} params={params} rank={null} />}
      </Grid>
      <Outliers kind="tokens_out" rows={data.outliers.tokens_out} />
      <Outliers kind="context" rows={data.outliers.context} />
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

function MetricCard({ title, unit, agents, pick, fmt, params, section }: { title: string; unit: string; agents: AgentStats[]; pick: (s: AgentStats) => Metric; fmt: (v: number | null) => string; params: InsightParams; section: string }) {
  const per = agents[0]?.per === 'session' ? 'Per session' : 'Per run';
  const columns = metricColumns(agents, pick, fmt);
  return (
    <ChartCard
      title={title}
      subtitle={`${period(params)} · ${per} · average ${unit}`}
      section={section}
      range={params.range}
      table={metricTable(agents, pick, fmt)}
      caption={agents[0]?.per === 'session' ? BRO_CAPTION : undefined}
    >
      <ColumnChart label={`${title}: ${columns.map((c) => c.aria).join('; ')}`} unit={unit} columns={columns} format={(v) => fmt(v)} />
    </ChartCard>
  );
}

export function TimeSection({ data, params }: SectionProps) {
  const runs = perRun(data.agents);
  const b = bro(data.agents);
  const ms = (v: number | null) => duration(v);
  return (
    <div className="space-y-4">
      <SectionHeading>Time</SectionHeading>
      <Grid>
        <MetricCard title="Duration per run" unit="Duration" agents={runs} pick={(s) => s.duration_ms} fmt={ms} params={params} section="time" />
        <MetricCard title="Tool uses per run" unit="Tool uses" agents={runs} pick={(s) => s.tool_uses} fmt={plain} params={params} section="time" />
        {b && <MetricCard title="bro duration per session" unit="Duration" agents={[b]} pick={(s) => s.duration_ms} fmt={ms} params={params} section="time" />}
        {b && <MetricCard title="bro tool uses per session" unit="Tool uses" agents={[b]} pick={(s) => s.tool_uses} fmt={plain} params={params} section="time" />}
      </Grid>
      <Outliers kind="duration_ms" rows={data.outliers.duration_ms} />
    </div>
  );
}

function CostCard({ title, rows, label, params }: { title: string; rows: Array<{ key: string; usd: number; runs: number; color: string }>; label: string; params: InsightParams }) {
  const columns: Column[] = rows.map((r) => ({ key: r.key, label: r.key, value: r.usd, color: r.color, aria: `${r.key}: ${usd(r.usd)} over ${r.runs} ${label}`, tip: `${r.key}: ${usd(r.usd)}` }));
  return (
    <ChartCard title={title} subtitle={`${period(params)} · USD`} section="cost" range={params.range} table={{ columns: ['Name', 'USD', 'Runs'], rows: rows.map((r) => [r.key, r.usd, r.runs]) }}>
      <ColumnChart label={`${title}: ${columns.map((c) => c.aria).join('; ') || 'no priced runs'}`} unit="USD" columns={columns} format={usd} />
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
  const agentRows = (keys: AgentKey[]) =>
    cost.by_agent.filter((a) => keys.includes(a.agent)).map((a) => ({ key: a.agent, usd: a.usd, runs: a.runs, color: AGENT_COLOR[a.agent] }));
  const broRows = agentRows(['bro']);
  return (
    <div className="space-y-4">
      <SectionHeading>Cost</SectionHeading>
      {cost.unpriced_runs > 0 && (
        <Flash variant="warning">
          {cost.unpriced_runs} measured {cost.unpriced_runs === 1 ? 'run has' : 'runs have'} no price for their model and {cost.unpriced_runs === 1 ? 'is' : 'are'} left out.
        </Flash>
      )}
      <Grid>
        <CostCard title="Cost by agent" rows={agentRows(['swe', 'reviewer'])} label="runs" params={params} />
        {broRows.length > 0 && <CostCard title="bro cost" rows={broRows} label="sessions" params={params} />}
        <CostCard
          title="Cost by model"
          rows={cost.by_model.map((m) => ({ key: m.model, usd: m.usd, runs: m.runs, color: THROUGHPUT_COLOR }))}
          label="runs"
          params={params}
        />
      </Grid>
    </div>
  );
}

function RateTile({ title, passed, total, what }: { title: string; passed: number; total: number; what: string }) {
  const r = ratio(passed, total);
  return (
    <Box className="space-y-2 px-4 py-3">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <p className="text-2xl font-semibold text-fg tabular-nums">{pct(r)}</p>
      <ProgressBar value={passed} max={total} label={`${passed} of ${total} ${what}`} />
      <p className="text-xs text-fg-muted tabular-nums">{`${passed} of ${total} ${what}`}</p>
    </Box>
  );
}

const VERDICTS = [
  ['pass', 'Pass', 'bg-(--bgColor-success-emphasis)'],
  ['fail', 'Fail', 'bg-(--bgColor-danger-emphasis)'],
  ['escalate', 'Escalate', 'bg-(--bgColor-severe-emphasis)'],
] as const;

export function QualitySection({ data, params }: SectionProps) {
  const q = data.quality;
  const totalVerdicts = q.verdicts.pass + q.verdicts.fail + q.verdicts.escalate;
  const attempts: Column[] = q.attempts.map((a) => {
    const label = `${a.attempts} ${a.attempts === 1 ? 'attempt' : 'attempts'}`;
    return { key: String(a.attempts), label: String(a.attempts), value: a.tasks, color: THROUGHPUT_COLOR, aria: `${label}: ${a.tasks} ${a.tasks === 1 ? 'task' : 'tasks'}`, tip: `${label}: ${a.tasks}` };
  });
  const seconds = (v: number | null) => (v === null ? '—' : `${plain(v)}s`);
  const slowColumns: TableColumn[] = [
    { key: 'command', header: 'Command', cell: (r) => <code className="font-mono text-xs">{String(r['command'])}</code>, truncate: true },
    { key: 'n', header: 'Runs', hideBelow: 'sm' },
    { key: 'p50', header: 'p50', cell: (r) => seconds(r['p50'] as number | null), hideBelow: 'sm' },
    { key: 'p95', header: 'p95', cell: (r) => seconds(r['p95'] as number | null) },
    { key: 'max', header: 'max', cell: (r) => seconds(r['max'] as number | null) },
  ];
  return (
    <div className="space-y-4">
      <SectionHeading>Quality</SectionHeading>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <RateTile title="First-pass rate" passed={q.first_pass.passed} total={q.first_pass.total} what="tasks passed review on the first attempt" />
        <RateTile title="Verification pass rate" passed={q.verification.passed} total={q.verification.total} what="verification runs passed" />
        <Box className="space-y-2 px-4 py-3">
          <h3 className="text-sm font-semibold text-fg">Verdict mix</h3>
          <StackedProgressBar
            label={`Review verdicts: ${VERDICTS.map(([k, label]) => `${label} ${q.verdicts[k]}`).join(', ')} of ${totalVerdicts}`}
            segments={VERDICTS.map(([k, label, fill]) => ({ label, value: q.verdicts[k], fill }))}
          />
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted tabular-nums">
            {VERDICTS.map(([k, label, fill]) => (
              <li key={k} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className={`inline-block size-2 rounded-full ${fill}`} />
                {label} {q.verdicts[k]}
              </li>
            ))}
          </ul>
        </Box>
      </div>
      <Grid>
        <ChartCard
          title="Review attempts per task"
          subtitle={`${period(params)} · tasks by attempt count`}
          section="quality"
          range={params.range}
          table={{ columns: ['Attempts', 'Tasks'], rows: q.attempts.map((a) => [a.attempts, a.tasks]) }}
        >
          <ColumnChart label={`Review attempts per task: ${attempts.map((c) => c.aria).join('; ') || 'no reviews'}`} unit="Tasks" columns={attempts} format={(v) => (Number.isInteger(v) ? String(v) : '')} />
        </ChartCard>
      </Grid>
      <section className="space-y-2" aria-label="Slowest verification commands">
        <h3 className="text-sm font-semibold text-fg">Slowest verification commands (by p95)</h3>
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
    color: THROUGHPUT_COLOR,
    aria: `${shortDay(d.day)}: ${d.closed} closed ${d.closed === 1 ? 'task' : 'tasks'}`,
    tip: `${shortDay(d.day)}: ${d.closed}`,
  }));
  return (
    <div className="space-y-4">
      <SectionHeading>Throughput</SectionHeading>
      <ChartCard
        title="Closed tasks per day"
        subtitle={`${period(params)} · tasks per day`}
        section="throughput"
        range={params.range}
        table={{ columns: ['Day', 'Closed tasks'], rows: days.map((d) => [d.day, d.closed]) }}
      >
        <ColumnChart label={`Closed tasks per day: ${total} over ${days.length} days`} unit="Tasks" columns={columns} format={(v) => (Number.isInteger(v) ? String(v) : '')} />
      </ChartCard>
    </div>
  );
}
