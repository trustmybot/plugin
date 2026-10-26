import { AxisBottom, AxisRight } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import { BarRounded, Line } from '@visx/shape';
import { Tooltip, useTooltip } from '@visx/tooltip';
import type { Tick } from './format.ts';
import type { Bucket } from './types.ts';

export type { Tick } from './format.ts';

export interface Column {
  key: string;
  label: string;
  value: number;
  color: string;
  aria: string;
  tip: string;
  note?: string;
}

export interface Marker {
  at: number;
  label: string;
}

interface EdgeTick extends Tick {
  anchor?: 'start' | 'middle' | 'end';
}

const HEIGHT = 224;
const MARGIN = { top: 20, right: 40, bottom: 24, left: 8 };
const BAND_TOP = 36;
const BAND_ROW = 15;
const LABEL_ASCENT = 11;
const LABEL_DESCENT = 3;
const MIN_TICK_GAP = 56;
const BAR_MAX = 24;
const BAR_GAP = 2;
const RADIUS = 4;
const CAP = 2;
const CHAR_PX = 6.6;
const LABEL_PAD = 4;
const BASELINE = 'var(--borderColor-default)';
const GRID = 'var(--borderColor-muted)';
const MUTED = 'var(--fgColor-muted)';
const TEXT = 'var(--fgColor-default)';
const WASH = { fillOpacity: 'var(--chart-wash)' } as const;
const tickLabel = { fill: MUTED, fontSize: 11, style: { fontVariantNumeric: 'tabular-nums' } } as const;
const FOCUS = 'focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color)';
const TIP_CLASS =
  'pointer-events-none -translate-x-1/2 -translate-y-full rounded-md bg-(--overlay-bgColor) px-2 py-1 text-xs whitespace-nowrap text-fg tabular-nums shadow-(--shadow-floating-small) border border-(--borderColor-default)';

export const barWidth = (band: number) => Math.max(0, Math.min(BAR_MAX, band - BAR_GAP));
export const textWidth = (text: string) => text.length * CHAR_PX;

// The 2px cap line along a bar's rounded data-end, inset 1px so it sits inside the bar.
export function capPath(x: number, y: number, width: number, height: number, horizontal: boolean): string {
  const r = Math.max(0, Math.max(1, Math.min(RADIUS, Math.min(width, height) / 2)) - CAP / 2);
  const i = CAP / 2;
  if (horizontal) {
    const xe = x + width - i;
    return `M${xe - r},${y + i}A${r},${r} 0 0 1 ${xe},${y + i + r}V${y + height - i - r}A${r},${r} 0 0 1 ${xe - r},${y + height - i}`;
  }
  const ye = y + i;
  return `M${x + i},${ye + r}A${r},${r} 0 0 1 ${x + i + r},${ye}H${x + width - i - r}A${r},${r} 0 0 1 ${x + width - i},${ye + r}`;
}

function Mark({ x, y, width, height, color, horizontal }: { x: number; y: number; width: number; height: number; color: string; horizontal: boolean }) {
  if (width <= 0 || height <= 0) return null;
  return (
    <g data-mark="">
      <BarRounded x={x} y={y} width={width} height={height} radius={RADIUS} top={!horizontal} right={horizontal} fill={color} style={WASH} />
      <path d={capPath(x, y, width, height, horizontal)} fill="none" stroke={color} strokeWidth={CAP} data-cap="" />
    </g>
  );
}

export interface PlacedLabel {
  x: number;
  anchor: 'start' | 'end';
  left: number;
  right: number;
  row: 0 | 1;
  baseline: number;
}

// Marker labels sit in a band above the plot, start-anchored on their rule or end-anchored
// in the right third, clamped to [0, innerW]; a label that would overlap an earlier one
// moves up to the band's second row.
export function placeMarkerLabels(markers: Array<{ x: number; label: string }>, innerW: number): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  for (const m of markers) {
    const w = textWidth(m.label);
    const anchor = m.x > (innerW * 2) / 3 ? 'end' : 'start';
    const left = Math.max(0, anchor === 'end' ? Math.min(m.x, innerW) - w : Math.min(m.x, innerW - w));
    const right = left + w;
    const row = placed.some((p) => p.row === 0 && left < p.right + LABEL_PAD && p.left < right + LABEL_PAD) ? 1 : 0;
    placed.push({ x: anchor === 'end' ? right : left, anchor, left, right, row, baseline: -6 - row * BAND_ROW });
  }
  return placed;
}

export const labelBox = (p: PlacedLabel) => ({ left: p.left, right: p.right, top: p.baseline - LABEL_ASCENT, bottom: p.baseline + LABEL_DESCENT });

export function thinEdgeTicks(ticks: Tick[], innerW: number): EdgeTick[] {
  if (ticks.length === 0) return [];
  const room = Math.max(2, Math.floor(innerW / MIN_TICK_GAP));
  const every = Math.max(1, Math.ceil(ticks.length / room));
  const kept = ticks.filter((_, i) => i % every === 0);
  if (kept.at(-1) !== ticks.at(-1)) kept[kept.length - 1] = ticks.at(-1)!;
  return kept.map((t, i) => ({ ...t, anchor: i === 0 ? 'start' : i === kept.length - 1 ? 'end' : 'middle' }));
}

interface Tip {
  title: string;
}

function ChartTooltip({ open, data, left, top }: { open: boolean; data: Tip | undefined; left: number | undefined; top: number | undefined }) {
  if (!open || !data) return null;
  return (
    <Tooltip unstyled applyPositionStyle top={top} left={left} offsetLeft={0} offsetTop={0} role="tooltip" className={TIP_CLASS}>
      {data.title}
    </Tooltip>
  );
}

export interface ColumnChartProps {
  label: string;
  columns: Column[];
  yMax?: number;
  format: (v: number) => string;
  edgeTicks?: Tick[];
  markers?: Marker[];
}

function Plot({ width, label, columns, yMax, format, edgeTicks, markers }: ColumnChartProps & { width: number }) {
  const { tooltipOpen, tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } = useTooltip<Tip>();
  const marginTop = markers ? BAND_TOP : MARGIN.top;
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - marginTop - MARGIN.bottom;
  const n = Math.max(1, columns.length);
  const x = scaleLinear<number>({ domain: [0, n], range: [0, innerW] });
  const top = Math.max(1, yMax ?? 0, ...columns.map((c) => c.value));
  const y = scaleLinear<number>({ domain: [0, top], range: [innerH, 0], nice: true });
  const band = innerW / n;
  const bar = barWidth(band);
  const every = Math.max(1, Math.ceil(n / Math.max(1, innerW / MIN_TICK_GAP)));
  const shown: EdgeTick[] = edgeTicks
    ? thinEdgeTicks(edgeTicks, innerW)
    : columns.map((c, i) => ({ at: i + 0.5, label: c.label })).filter((_, i) => i % every === 0);
  const labels = new Map(shown.map((t) => [t.at, t]));
  const markerX = (markers ?? []).map((m) => ({ x: x(m.at), label: m.label }));
  const placed = placeMarkerLabels(markerX, innerW);
  const show = (c: Column, i: number) => () =>
    showTooltip({ tooltipData: { title: c.tip }, tooltipLeft: MARGIN.left + x(i + 0.5), tooltipTop: marginTop + y(c.value) - 8 });
  return (
    <div className="relative">
      <svg width={width} height={HEIGHT} role="img" aria-label={label} className="block max-w-full overflow-visible tabular-nums">
        <Group left={MARGIN.left} top={marginTop}>
          <GridRows scale={y} width={innerW} numTicks={4} stroke={GRID} strokeWidth={1} />
          {columns.map((c, i) => {
            if (c.value <= 0) return null;
            const h = Math.max(CAP, innerH - y(c.value));
            return <Mark key={c.key} x={x(i) + (band - bar) / 2} y={innerH - h} width={bar} height={h} color={c.color} horizontal={false} />;
          })}
          {markerX.map((m, i) => {
            const p = placed[i]!;
            return (
              <g key={m.label} data-marker="">
                <Line from={{ x: m.x, y: 0 }} to={{ x: m.x, y: innerH }} stroke={MUTED} strokeWidth={1} />
                <text x={p.x} y={p.baseline} textAnchor={p.anchor} fill={MUTED} fontSize={11} style={{ fontVariantNumeric: 'tabular-nums' }} data-marker-label="">
                  {m.label}
                </text>
              </g>
            );
          })}
          <AxisBottom
            top={innerH}
            scale={x}
            tickValues={shown.map((t) => t.at)}
            tickFormat={(v) => labels.get(Number(v))?.label ?? ''}
            stroke={BASELINE}
            hideTicks
            tickLabelProps={(v) => ({ ...tickLabel, textAnchor: labels.get(Number(v))?.anchor ?? 'middle' })}
          />
          <AxisRight
            left={innerW}
            scale={y}
            numTicks={4}
            tickFormat={(v) => format(Number(v))}
            hideAxisLine
            hideTicks
            tickLabelProps={() => ({ ...tickLabel, textAnchor: 'start', dx: 4, dy: 3 })}
          />
          {columns.map((c, i) => (
            <rect
              key={c.key}
              x={x(i)}
              y={0}
              width={band}
              height={innerH}
              fill="transparent"
              data-hit=""
              tabIndex={0}
              role="graphics-symbol"
              aria-label={c.aria}
              className={FOCUS}
              onMouseMove={show(c, i)}
              onFocus={show(c, i)}
              onMouseLeave={hideTooltip}
              onBlur={hideTooltip}
            />
          ))}
        </Group>
      </svg>
      <ChartTooltip open={tooltipOpen} data={tooltipData} left={tooltipLeft} top={tooltipTop} />
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

const ROW = 36;
const BAR_THICK = 12;
const BAR_TOP = 18;
const AXIS_H = 20;

export interface BarListProps {
  label: string;
  rows: Column[];
  format: (v: number) => string;
  axis: (max: number) => { top: number; ticks: Tick[] };
  max?: number;
}

function BarListPlot({ width, label, rows, format, axis, max }: BarListProps & { width: number }) {
  const valueText = (r: Column) => r.note ?? format(r.value);
  const { tooltipOpen, tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } = useTooltip<Tip>();
  const reserve = Math.max(0, ...rows.map((r) => textWidth(valueText(r)))) + 2 * LABEL_PAD + 4;
  const innerW = Math.max(0, width - 1 - reserve);
  const { top, ticks } = axis(Math.max(0, max ?? 0, ...rows.map((r) => r.value)));
  const x = scaleLinear<number>({ domain: [0, Math.max(top, Number.EPSILON)], range: [0, innerW] });
  const shown = thinEdgeTicks(ticks, innerW);
  const labels = new Map(shown.map((t) => [t.at, t]));
  const plotH = rows.length * ROW;
  const height = plotH + AXIS_H;
  const show = (r: Column, i: number) => () =>
    showTooltip({ tooltipData: { title: r.tip }, tooltipLeft: 1 + x(r.value), tooltipTop: i * ROW + BAR_TOP - 4 });
  return (
    <div className="relative">
      <svg width={width} height={height} role="img" aria-label={label} className="block max-w-full overflow-visible tabular-nums">
        <Group left={1}>
          {rows.map((r, i) => {
            const rowY = i * ROW;
            const end = r.note === undefined && r.value > 0 ? Math.max(CAP, x(r.value)) : 0;
            return (
              <g key={r.key}>
                <text x={0} y={rowY + 12} fill={TEXT} fontSize={12}>
                  {r.label}
                </text>
                <Line from={{ x: 0, y: rowY + BAR_TOP - 2 }} to={{ x: 0, y: rowY + BAR_TOP + BAR_THICK + 2 }} stroke={BASELINE} strokeWidth={1} />
                <Mark x={0} y={rowY + BAR_TOP} width={end} height={BAR_THICK} color={r.color} horizontal />
                <text x={end + LABEL_PAD} y={rowY + BAR_TOP + 10} fill={MUTED} fontSize={11} style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {valueText(r)}
                </text>
              </g>
            );
          })}
          <AxisBottom
            top={plotH}
            scale={x}
            tickValues={shown.map((t) => t.at)}
            tickFormat={(v) => labels.get(Number(v))?.label ?? ''}
            hideAxisLine
            hideTicks
            tickLabelProps={(v) => ({ ...tickLabel, textAnchor: labels.get(Number(v))?.anchor ?? 'middle' })}
          />
          {rows.map((r, i) => (
            <rect
              key={r.key}
              x={0}
              y={i * ROW}
              width={innerW}
              height={ROW}
              fill="transparent"
              data-hit=""
              tabIndex={0}
              role="graphics-symbol"
              aria-label={r.aria}
              className={FOCUS}
              onMouseMove={show(r, i)}
              onFocus={show(r, i)}
              onMouseLeave={hideTooltip}
              onBlur={hideTooltip}
            />
          ))}
        </Group>
      </svg>
      <ChartTooltip open={tooltipOpen} data={tooltipData} left={tooltipLeft} top={tooltipTop} />
    </div>
  );
}

export function BarList(props: BarListProps) {
  const height = props.rows.length * ROW + AXIS_H;
  return (
    <div style={{ height }}>
      <ParentSize initialSize={{ width: 480, height }} debounceTime={50}>
        {({ width }) => <BarListPlot {...props} width={width || 480} />}
      </ParentSize>
    </div>
  );
}

// A .nice() linear axis for BarList, labelled with `format`.
export const niceAxis = (format: (v: number) => string) => (max: number) => {
  const s = scaleLinear<number>({ domain: [0, Math.max(max, Number.EPSILON)], nice: 4 });
  const ticks = s.ticks(4);
  return { top: s.domain()[1]!, ticks: ticks.map((at) => ({ at, label: format(at) })) };
};

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
  buckets: Bucket[];
  color: string;
  who: string;
  noun: (n: number) => string;
  yMax?: number;
  p50: number | null;
  p95: number | null;
  format: (v: number) => string;
}

export function Histogram({ label, buckets, color, who, noun, yMax, p50, p95, format }: HistogramProps) {
  const columns: Column[] = buckets.map((b) => {
    const range = `${format(b.from)}–${format(b.to)}`;
    return { key: `${b.from}`, label: format(b.from), value: b.count, color, aria: `${who}, ${range} output tokens: ${b.count} ${noun(b.count)}`, tip: `${range}: ${b.count} ${noun(b.count)}` };
  });
  const markers: Marker[] = [];
  if (p50 !== null && buckets.length > 0) markers.push({ at: bucketPosition(buckets, p50), label: `p50 ${format(p50)}` });
  if (p95 !== null && buckets.length > 0) markers.push({ at: bucketPosition(buckets, p95), label: `p95 ${format(p95)}` });
  const edges: Tick[] = buckets.map((b, i) => ({ at: i, label: format(b.from) })).concat(buckets.length > 0 ? [{ at: buckets.length, label: format(buckets.at(-1)!.to) }] : []);
  return <ColumnChart label={label} columns={columns} yMax={yMax} format={(v) => (Number.isInteger(v) ? String(v) : '')} edgeTicks={edges} markers={markers} />;
}
