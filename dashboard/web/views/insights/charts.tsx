import { AxisBottom, AxisRight } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import { Bar, Line } from '@visx/shape';
import { Tooltip, useTooltip } from '@visx/tooltip';
import type { Bucket } from './types.ts';

export interface Column {
  key: string;
  label: string;
  value: number;
  color: string;
  aria: string;
  tip: string;
}

export interface Marker {
  at: number;
  label: string;
  dashed: boolean;
}

export interface Tick {
  at: number;
  label: string;
}

const HEIGHT = 224;
const MARGIN = { top: 20, right: 56, bottom: 28, left: 8 };
const MIN_TICK_GAP = 56;
const AXIS = 'var(--borderColor-emphasis)';
const GRID = 'var(--borderColor-muted)';
const TICK = 'var(--fgColor-muted)';
const MARK = 'var(--fgColor-default)';
const tickLabel = { fill: TICK, fontSize: 11, style: { fontVariantNumeric: 'tabular-nums' } } as const;

interface Tip {
  title: string;
}

export interface ColumnChartProps {
  label: string;
  unit: string;
  columns: Column[];
  yMax?: number;
  format: (v: number) => string;
  ticks?: Tick[];
  markers?: Marker[];
}

function Plot({ width, label, unit, columns, yMax, format, ticks, markers = [] }: ColumnChartProps & { width: number }) {
  const { tooltipOpen, tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } = useTooltip<Tip>();
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const n = Math.max(1, columns.length);
  const x = scaleLinear<number>({ domain: [0, n], range: [0, innerW] });
  const top = Math.max(1, yMax ?? 0, ...columns.map((c) => c.value));
  const y = scaleLinear<number>({ domain: [0, top], range: [innerH, 0], nice: true });
  const step = innerW / n;
  const gap = Math.min(4, step * 0.15);
  const every = Math.max(1, Math.ceil(n / Math.max(1, innerW / MIN_TICK_GAP)));
  const centred: Tick[] = columns.map((c, i) => ({ at: i + 0.5, label: c.label })).filter((_, i) => i % every === 0);
  const shown = ticks ?? centred;
  const labels = new Map(shown.map((t) => [t.at, t.label]));
  const show = (c: Column, i: number) => () =>
    showTooltip({ tooltipData: { title: c.tip }, tooltipLeft: MARGIN.left + x(i + 0.5), tooltipTop: MARGIN.top + y(c.value) - 8 });
  return (
    <div className="relative">
      <svg width={width} height={HEIGHT} role="img" aria-label={label} className="block max-w-full overflow-visible tabular-nums">
        <Group left={MARGIN.left} top={MARGIN.top}>
          <GridRows scale={y} width={innerW} numTicks={4} stroke={GRID} strokeDasharray="4 4" />
          {columns.map((c, i) => {
            const barY = y(c.value);
            return (
              <Bar
                key={c.key}
                x={x(i) + gap}
                y={barY}
                width={Math.max(1, step - 2 * gap)}
                height={Math.max(0, innerH - barY)}
                fill={c.color}
                rx={2}
                tabIndex={0}
                role="graphics-symbol"
                aria-label={c.aria}
                className="focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color)"
                onMouseMove={show(c, i)}
                onFocus={show(c, i)}
                onMouseLeave={hideTooltip}
                onBlur={hideTooltip}
              />
            );
          })}
          {markers.map((m, i) => (
            <g key={m.label}>
              <Line from={{ x: x(m.at), y: 0 }} to={{ x: x(m.at), y: innerH }} stroke={MARK} strokeWidth={2} strokeDasharray={m.dashed ? '6 4' : undefined} />
              <text x={x(m.at) + 4} y={i === 0 ? -6 : 12} fill={MARK} fontSize={11} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {m.label}
              </text>
            </g>
          ))}
          <AxisBottom
            top={innerH}
            scale={x}
            tickValues={shown.map((t) => t.at)}
            tickFormat={(v) => labels.get(Number(v)) ?? ''}
            stroke={AXIS}
            tickStroke={AXIS}
            tickLabelProps={() => ({ ...tickLabel, textAnchor: 'middle' })}
          />
          <AxisRight
            left={innerW}
            scale={y}
            numTicks={4}
            tickFormat={(v) => format(Number(v))}
            stroke={AXIS}
            tickStroke={AXIS}
            label={unit}
            labelOffset={28}
            labelProps={{ fill: TICK, fontSize: 11, textAnchor: 'middle' }}
            tickLabelProps={() => ({ ...tickLabel, textAnchor: 'start', dx: 2, dy: 3 })}
          />
        </Group>
      </svg>
      {tooltipOpen && tooltipData && (
        <Tooltip
          unstyled
          applyPositionStyle
          top={tooltipTop}
          left={tooltipLeft}
          offsetLeft={0}
          offsetTop={0}
          role="tooltip"
          className="pointer-events-none -translate-x-1/2 -translate-y-full rounded-md bg-(--overlay-bgColor) px-2 py-1 text-xs whitespace-nowrap text-fg tabular-nums shadow-(--shadow-floating-small) border border-(--borderColor-default)"
        >
          {tooltipData.title}
        </Tooltip>
      )}
    </div>
  );
}

export function ColumnChart(props: ColumnChartProps) {
  return (
    <div style={{ height: HEIGHT }}>
      <ParentSize initialSize={{ width: 480, height: HEIGHT }} debounceTime={50}>
        {({ width }) => <Plot {...props} width={width || 480} />}
      </ParentSize>
    </div>
  );
}

// Fractional column position of `v` inside log-spaced buckets.
export function bucketPosition(buckets: readonly Bucket[], v: number): number {
  const i = buckets.findIndex((b) => v < b.to);
  const at = i === -1 ? buckets.length - 1 : i;
  const b = buckets[at]!;
  if (b.to <= b.from || v <= b.from) return at;
  return at + Math.min(1, Math.log(v / b.from) / Math.log(b.to / b.from));
}

export interface HistogramProps {
  label: string;
  unit: string;
  buckets: Bucket[];
  color: string;
  who: string;
  yMax?: number;
  p50: number | null;
  p95: number | null;
  format: (v: number) => string;
}

export function Histogram({ label, unit, buckets, color, who, yMax, p50, p95, format }: HistogramProps) {
  const columns: Column[] = buckets.map((b) => {
    const range = `${format(b.from)}–${format(b.to)}`;
    return { key: `${b.from}`, label: format(b.from), value: b.count, color, aria: `${who}, ${range} output tokens: ${b.count} ${b.count === 1 ? 'run' : 'runs'}`, tip: `${range}: ${b.count}` };
  });
  const markers: Marker[] = [];
  if (p50 !== null && buckets.length > 0) markers.push({ at: bucketPosition(buckets, p50), label: `p50 ${format(p50)}`, dashed: false });
  if (p95 !== null && buckets.length > 0) markers.push({ at: bucketPosition(buckets, p95), label: `p95 ${format(p95)}`, dashed: true });
  const every = Math.max(1, Math.ceil(buckets.length / 5));
  const ticks = buckets
    .map((b, i) => ({ at: i, label: format(b.from) }))
    .filter((_, i) => i % every === 0)
    .concat(buckets.length > 0 ? [{ at: buckets.length, label: format(buckets.at(-1)!.to) }] : []);
  return <ColumnChart label={label} unit={unit} columns={columns} yMax={yMax} format={(v) => (Number.isInteger(v) ? String(v) : '')} ticks={ticks} markers={markers} />;
}
