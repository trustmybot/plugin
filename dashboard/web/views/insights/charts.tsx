import { AxisBottom, AxisRight } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import { BarRounded, Line } from '@visx/shape';
import { Tooltip, useTooltip } from '@visx/tooltip';
import { OUTLINE_DASH } from './ChartCard.tsx';
import type { Tick } from './format.ts';
import { overlayTip } from './params.ts';
import type { Bucket } from './types.ts';
import type { ReactNode } from 'react';

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
  hollow?: boolean;
}

interface EdgeTick extends Tick {
  anchor?: 'start' | 'middle' | 'end';
}

const HEIGHT = 224;
const MARGIN = { top: 20, right: 40, bottom: 24, left: 8 };
const MARKER_TOP = 40;
const LABEL_ASCENT = 11;
const LABEL_DESCENT = 3;
const MIN_TICK_GAP = 56;
const BAR_MAX = 24;
const BAR_GAP = 2;
const RADIUS = 4;
const CAP = 2;
const ARROW_W = 8;
const ARROW_H = 5;
const ARROW_GAP = 3;
const LABEL_GAP = 2;
const LABEL_H = LABEL_ASCENT + LABEL_DESCENT;
const BAR_CLEAR = 2;
const PAD_X = 4;
const PAD_Y = 2;
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
export const histBarWidth = (band: number) => Math.max(1, band - BAR_GAP);
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

export interface BarTop {
  left: number;
  right: number;
  top: number;
}

export interface Callout {
  ax: number;
  tip: number;
  labelX: number;
  anchor: 'start' | 'middle' | 'end';
  baseline: number;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// The highest bar top under x, padded by half the bar gap so a marker in a gap rests on the taller neighbour.
function surfaceTop(x: number, bars: readonly BarTop[], innerH: number): number {
  const reach = 0.5 + BAR_GAP / 2;
  return Math.min(innerH, ...bars.filter((b) => b.left - reach <= x && x <= b.right + reach).map((b) => b.top));
}

const collides = (a: Box, b: Box) => a.left < b.right + PAD_X && b.left < a.right + PAD_X && a.top < b.bottom + PAD_Y && b.top < a.bottom + PAD_Y;

// Each marker is an arrow resting on the bar top with its label on the arrow. The label tries
// middle, start, then end anchoring, keeps the one bars lift least, prefers one clear of earlier
// labels, and otherwise lifts above them. Earlier labels never move.
export function placeMarkerCallouts(markers: ReadonlyArray<{ x: number; label: string }>, bars: readonly BarTop[], innerW: number, innerH: number): Callout[] {
  const placed: Box[] = [];
  return markers.map((m) => {
    const ax = Math.round(clamp(m.x, 0, innerW));
    const tip = surfaceTop(ax, bars, innerH) - ARROW_GAP;
    const rest = tip - ARROW_H - LABEL_GAP;
    const w = textWidth(m.label);
    const starts = [
      ['middle', ax - w / 2],
      ['start', ax - ARROW_W / 2],
      ['end', ax + ARROW_W / 2 - w],
    ] as const;
    const ranked = starts
      .map(([anchor, at], i) => {
        const left = clamp(at, 0, innerW - w);
        const right = left + w;
        const bottom = Math.min(rest, ...bars.filter((b) => b.left < right && left < b.right).map((b) => b.top - BAR_CLEAR));
        return { anchor, i, left, right, bottom };
      })
      .sort((a, b) => b.bottom - a.bottom || a.i - b.i);
    const boxAt = (c: (typeof ranked)[number], bottom = c.bottom): Box => ({ left: c.left, right: c.right, top: bottom - LABEL_H, bottom });
    const pick = ranked.find((c) => !placed.some((p) => collides(boxAt(c), p))) ?? ranked[0]!;
    let bottom = pick.bottom;
    for (let hit = placed.find((p) => collides(boxAt(pick, bottom), p)); hit; hit = placed.find((p) => collides(boxAt(pick, bottom), p))) {
      bottom = hit.top - PAD_Y;
    }
    bottom = Math.max(bottom, -MARKER_TOP + PAD_Y + LABEL_H);
    placed.push(boxAt(pick, bottom));
    const labelX = pick.anchor === 'start' ? pick.left : pick.anchor === 'end' ? pick.right : pick.left + w / 2;
    return { ax, tip, labelX, anchor: pick.anchor, baseline: bottom - LABEL_DESCENT };
  });
}

export const arrowPath = (ax: number, tip: number) => `M${ax - ARROW_W / 2},${tip - ARROW_H}H${ax + ARROW_W / 2}L${ax},${tip}Z`;

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
  contiguous?: boolean;
  outline?: { values: number[]; color: string };
}

export const OUTLINE_WIDTH = 1.5;

// A step line along each band's top, dropping to the baseline at both ends.
export function stepPath(values: readonly number[], x: (i: number) => number, y: (v: number) => number, baseline: number): string {
  if (values.length === 0) return '';
  const steps = values.map((v, i) => `V${y(v)}H${x(i + 1)}`).join('');
  return `M${x(0)},${baseline}${steps}V${baseline}`;
}

function Plot({ width, label, columns, yMax, format, edgeTicks, markers, contiguous, outline }: ColumnChartProps & { width: number }) {
  const { tooltipOpen, tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } = useTooltip<Tip>();
  const marginTop = markers?.length ? MARKER_TOP : MARGIN.top;
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - marginTop - MARGIN.bottom;
  const n = Math.max(1, columns.length);
  const x = scaleLinear<number>({ domain: [0, n], range: [0, innerW] });
  const top = Math.max(1, yMax ?? 0, ...columns.map((c) => c.value), ...(outline?.values ?? []));
  const y = scaleLinear<number>({ domain: [0, top], range: [innerH, 0], nice: true });
  const band = innerW / n;
  const bar = contiguous ? histBarWidth(band) : barWidth(band);
  const every = Math.max(1, Math.ceil(n / Math.max(1, innerW / MIN_TICK_GAP)));
  const shown: EdgeTick[] = edgeTicks
    ? thinEdgeTicks(edgeTicks, innerW)
    : columns.map((c, i) => ({ at: i + 0.5, label: c.label })).filter((_, i) => i % every === 0);
  const labels = new Map(shown.map((t) => [t.at, t]));
  const markerX = (markers ?? []).map((m) => ({ x: x(m.at), label: m.label }));
  const bars = columns.flatMap((c, i) => {
    if (c.value <= 0) return [];
    const h = Math.max(CAP, innerH - y(c.value));
    const left = x(i) + (band - bar) / 2;
    return [{ c, left, right: left + bar, top: innerH - h, h }];
  });
  const outlineTops: BarTop[] = (outline?.values ?? []).flatMap((v, i) => (v > 0 ? [{ left: x(i), right: x(i + 1), top: y(v) }] : []));
  const callouts = placeMarkerCallouts(markerX, [...bars, ...outlineTops], innerW, innerH);
  const show = (c: Column, i: number) => () =>
    showTooltip({ tooltipData: { title: c.tip }, tooltipLeft: MARGIN.left + x(i + 0.5), tooltipTop: marginTop + y(c.value) - 8 });
  return (
    <div className="relative">
      <svg width={width} height={HEIGHT} role="img" aria-label={label} className="block max-w-full overflow-visible tabular-nums">
        <Group left={MARGIN.left} top={marginTop}>
          <GridRows scale={y} width={innerW} numTicks={4} stroke={GRID} strokeWidth={1} />
          {bars.map((b) => (
            <Mark key={b.c.key} x={b.left} y={b.top} width={bar} height={b.h} color={b.c.color} horizontal={false} />
          ))}
          {outline && (
            <path
              d={stepPath(outline.values, x, y, innerH)}
              fill="none"
              stroke={outline.color}
              strokeWidth={OUTLINE_WIDTH}
              strokeDasharray={OUTLINE_DASH}
              pointerEvents="none"
              data-outline=""
            />
          )}
          {markerX.map((m, i) => {
            const c = callouts[i]!;
            const hollow = markers![i]!.hollow;
            return (
              <g key={`${i}-${m.label}`} data-marker={hollow ? 'hollow' : ''}>
                <path
                  d={arrowPath(c.ax, c.tip)}
                  fill={hollow ? 'none' : MUTED}
                  stroke={hollow ? MUTED : 'none'}
                  strokeWidth={hollow ? 1 : undefined}
                  pointerEvents="none"
                  data-marker-arrow=""
                />
                <text x={c.labelX} y={c.baseline} textAnchor={c.anchor} fill={MUTED} fontSize={11} style={{ fontVariantNumeric: 'tabular-nums' }} data-marker-label="">
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

// Fractional column position of `v` inside log-spaced (or, with `linear`, evenly spaced) buckets.
export function bucketPosition(buckets: readonly Bucket[], v: number, linear = false): number {
  const i = buckets.findIndex((b) => v < b.to);
  const at = i === -1 ? buckets.length - 1 : i;
  const b = buckets[at]!;
  if (b.to <= b.from || v <= b.from) return at;
  const within = linear ? (v - b.from) / (b.to - b.from) : Math.log(v / b.from) / Math.log(b.to / b.from);
  return at + Math.min(1, within);
}

export interface HistogramProps {
  label: string;
  measure: string;
  buckets: Bucket[];
  linear?: boolean;
  color: string;
  who: string;
  noun: (n: number) => string;
  yMax?: number;
  p50: number | null;
  p95: number | null;
  format: (v: number) => string;
}

export function Histogram({ label, measure, buckets, linear = false, color, who, noun, yMax, p50, p95, format }: HistogramProps) {
  const columns: Column[] = buckets.map((b) => {
    const range = `${format(b.from)}–${format(b.to)}`;
    return { key: `${b.from}`, label: format(b.from), value: b.count, color, aria: `${who}, ${range} ${measure}: ${b.count} ${noun(b.count)}`, tip: `${range}: ${b.count} ${noun(b.count)}` };
  });
  const markers: Marker[] = [];
  if (p50 !== null && buckets.length > 0) markers.push({ at: bucketPosition(buckets, p50, linear), label: `p50 ${format(p50)}` });
  if (p95 !== null && buckets.length > 0) markers.push({ at: bucketPosition(buckets, p95, linear), label: `p95 ${format(p95)}` });
  const edges: Tick[] = buckets.map((b, i) => ({ at: i, label: format(b.from) })).concat(buckets.length > 0 ? [{ at: buckets.length, label: format(buckets.at(-1)!.to) }] : []);
  return <ColumnChart label={label} columns={columns} yMax={yMax} format={(v) => (Number.isInteger(v) ? String(v) : '')} edgeTicks={edges} markers={markers} contiguous />;
}

export interface OverlayPeriod {
  buckets: Bucket[];
  n: number;
  p50: number | null;
  p95: number | null;
}

export const shareOf = (count: number, n: number) => (n > 0 ? (100 * count) / n : 0);
const shareText = (v: number) => `${Math.round(v)}%`;

export interface OverlayHistogramProps {
  label: string;
  measure: string;
  who: string;
  per: 'run' | 'session';
  linear?: boolean;
  color: string;
  yMax?: number;
  format: (v: number) => string;
  p1: OverlayPeriod;
  p2: OverlayPeriod;
}

const periodMarkers = (p: OverlayPeriod, buckets: readonly Bucket[], linear: boolean, format: (v: number) => string, hollow: boolean): Marker[] =>
  (['p50', 'p95'] as const).flatMap((k) => {
    const v = p[k];
    return v === null || buckets.length === 0 ? [] : [{ at: bucketPosition(buckets, v, linear), label: `${k} ${format(v)}`, hollow }];
  });

// Period 2 as filled bars and Period 1 as a dashed step outline, both as the
// share of their period's measured runs on the shared buckets.
export function OverlayHistogram({ label, measure, who, per, linear = false, color, yMax, format, p1, p2 }: OverlayHistogramProps) {
  const buckets = p2.buckets;
  const columns: Column[] = buckets.map((b, i) => {
    const range = `${format(b.from)}–${format(b.to)}`;
    const c1 = p1.buckets[i]?.count ?? 0;
    const shares = [
      { share: shareText(shareOf(c1, p1.n)), count: c1 },
      { share: shareText(shareOf(b.count, p2.n)), count: b.count },
    ];
    const tip = overlayTip(range, shares, per);
    return { key: `${b.from}`, label: format(b.from), value: shareOf(b.count, p2.n), color, aria: `${who}, ${measure} ${tip}`, tip };
  });
  const markers = [...periodMarkers(p2, buckets, linear, format, false), ...periodMarkers(p1, buckets, linear, format, true)];
  const edges: Tick[] = buckets.map((b, i) => ({ at: i, label: format(b.from) })).concat(buckets.length > 0 ? [{ at: buckets.length, label: format(buckets.at(-1)!.to) }] : []);
  const outline = { values: buckets.map((_, i) => shareOf(p1.buckets[i]?.count ?? 0, p1.n)), color };
  return <ColumnChart label={label} columns={columns} yMax={yMax} format={shareText} edgeTicks={edges} markers={markers} contiguous outline={outline} />;
}

const PAIR_ROW = 48;
const PAIR_THICK = 10;
const PAIR_P1 = 18;
const PAIR_P2 = 32;
const DELTA_H = 20;
const DELTA_GAP = 6;
const DELTA_ICON = 24;

export interface PairedRow {
  key: string;
  label: string;
  color: string;
  p1: number | null;
  p2: number | null;
  aria: string;
  tip: string;
  delta: ReactNode;
  deltaText: string;
}

export interface PairedBarListProps {
  label: string;
  rows: PairedRow[];
  format: (v: number) => string;
  axis: (max: number) => { top: number; ticks: Tick[] };
}

const pairText = (v: number | null, format: (v: number) => string) => (v === null ? '—' : format(v));

function PairedBarListPlot({ width, label, rows, format, axis }: PairedBarListProps & { width: number }) {
  const { tooltipOpen, tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } = useTooltip<Tip>();
  const deltaW = (r: PairedRow) => textWidth(r.deltaText) + DELTA_ICON;
  const reserve =
    Math.max(0, ...rows.map((r) => Math.max(textWidth(pairText(r.p1, format)), textWidth(pairText(r.p2, format)) + DELTA_GAP + deltaW(r)))) + 2 * LABEL_PAD + 4;
  const innerW = Math.max(0, width - 1 - reserve);
  const { top, ticks } = axis(Math.max(0, ...rows.map((r) => Math.max(r.p1 ?? 0, r.p2 ?? 0))));
  const x = scaleLinear<number>({ domain: [0, Math.max(top, Number.EPSILON)], range: [0, innerW] });
  const shown = thinEdgeTicks(ticks, innerW);
  const labels = new Map(shown.map((t) => [t.at, t]));
  const plotH = rows.length * PAIR_ROW;
  const end = (v: number | null) => (v !== null && v > 0 ? Math.max(CAP, x(v)) : 0);
  const show = (r: PairedRow, i: number) => () =>
    showTooltip({ tooltipData: { title: r.tip }, tooltipLeft: 1 + Math.max(end(r.p1), end(r.p2)), tooltipTop: i * PAIR_ROW + PAIR_P1 - 4 });
  return (
    <div className="relative">
      <svg width={width} height={plotH + AXIS_H} role="img" aria-label={label} className="block max-w-full overflow-visible tabular-nums">
        <Group left={1}>
          {rows.map((r, i) => {
            const rowY = i * PAIR_ROW;
            const e1 = end(r.p1);
            const e2 = end(r.p2);
            const v2 = pairText(r.p2, format);
            return (
              <g key={r.key} data-pair="">
                <text x={0} y={rowY + 12} fill={TEXT} fontSize={12}>
                  {r.label}
                </text>
                <Line from={{ x: 0, y: rowY + PAIR_P1 - 2 }} to={{ x: 0, y: rowY + PAIR_P2 + PAIR_THICK + 2 }} stroke={BASELINE} strokeWidth={1} />
                {e1 > 0 && (
                  <rect
                    x={OUTLINE_WIDTH / 2}
                    y={rowY + PAIR_P1 + OUTLINE_WIDTH / 2}
                    width={Math.max(0, e1 - OUTLINE_WIDTH)}
                    height={PAIR_THICK - OUTLINE_WIDTH}
                    fill="none"
                    stroke={r.color}
                    strokeWidth={OUTLINE_WIDTH}
                    strokeDasharray={OUTLINE_DASH}
                    data-outline=""
                  />
                )}
                <text x={e1 + LABEL_PAD} y={rowY + PAIR_P1 + 9} fill={MUTED} fontSize={11} style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {pairText(r.p1, format)}
                </text>
                <Mark x={0} y={rowY + PAIR_P2} width={e2} height={PAIR_THICK} color={r.color} horizontal />
                <text x={e2 + LABEL_PAD} y={rowY + PAIR_P2 + 9} fill={MUTED} fontSize={11} style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {v2}
                </text>
                <foreignObject x={e2 + LABEL_PAD + textWidth(v2) + DELTA_GAP} y={rowY + PAIR_P2 + PAIR_THICK / 2 - DELTA_H / 2} width={deltaW(r)} height={DELTA_H}>
                  {r.delta}
                </foreignObject>
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
              y={i * PAIR_ROW}
              width={innerW}
              height={PAIR_ROW}
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

export function PairedBarList(props: PairedBarListProps) {
  const height = props.rows.length * PAIR_ROW + AXIS_H;
  return (
    <div style={{ height }}>
      <ParentSize initialSize={{ width: 480, height }} debounceTime={50}>
        {({ width }) => <PairedBarListPlot {...props} width={width || 480} />}
      </ParentSize>
    </div>
  );
}
