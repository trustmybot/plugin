import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConceptGraph, GraphNode, NodeId } from '../../api.ts';
import { Box, BoxHeader, BoxRow } from '../../ui/Box.tsx';
import { CopyButton } from '../../ui/CopyButton.tsx';
import { CONCEPT_COPY, MUTED, prefersReducedMotion, TARGET } from './copy.ts';
import { clip, clipLeft, edgePath, GROUP_PAD, layoutGraph, NODE_H, NODE_W } from './layout.ts';

const EDGE_STYLE: Record<string, { dash?: string; label: string }> = {
  calls: { label: 'calls' },
  imports: { dash: '6 4', label: 'imports' },
  runs: { dash: '2 3', label: 'runs' },
  sources: { dash: '2 3', label: 'sources' },
  then: { label: 'then' },
};

const LEGEND: Array<[string, string]> = [
  ['calls', 'calls'],
  ['imports', 'imports'],
  ['runs', 'runs or sources'],
  ['then', 'then (next step)'],
];

const DIR_HUES = [
  'fill-(--bgColor-accent-emphasis)',
  'fill-(--bgColor-success-emphasis)',
  'fill-(--bgColor-done-emphasis)',
  'fill-(--bgColor-attention-emphasis)',
  'fill-(--bgColor-severe-emphasis)',
  'fill-(--bgColor-sponsors-emphasis)',
  'fill-(--bgColor-danger-emphasis)',
  'fill-(--bgColor-neutral-emphasis)',
];

const EDGE_TONE = {
  hot: 'stroke-(--fgColor-accent)',
  then: 'stroke-(--borderColor-emphasis)',
  other: 'stroke-(--fgColor-muted)',
};

const NODE_TONE = {
  selected: 'fill-(--bgColor-accent-muted) stroke-(--borderColor-accent-emphasis)',
  step: 'fill-(--bgColor-default) stroke-(--fgColor-default)',
  other: 'fill-(--bgColor-default) stroke-(--borderColor-emphasis)',
};

export function GraphPanel({
  graph,
  selected,
  picked,
  canExpand,
  onExpand,
  onNode,
}: {
  graph: ConceptGraph;
  selected: NodeId | null;
  picked: GraphNode | null;
  canExpand: boolean;
  onExpand: () => void;
  onNode: (n: GraphNode) => void;
}) {
  const [table, setTable] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const hueOf = useMemo(() => {
    const dirs = [...new Set(layout.groups.map((g) => g.dir))].sort();
    return new Map(dirs.map((d, i) => [d, DIR_HUES[i % DIR_HUES.length]!]));
  }, [layout]);
  const dirs = new Set(graph.nodes.map((n) => n.dir)).size;
  const functions = graph.nodes.length;
  const at = selected === null ? undefined : layout.placed.get(selected);

  useEffect(() => {
    const el = box.current;
    if (!el || !at) return;
    el.scrollTo({
      left: at.x + NODE_W / 2 - el.clientWidth / 2,
      top: at.y + NODE_H / 2 - el.clientHeight / 2,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [at?.x, at?.y]);

  const labelOf = (id: NodeId) => layout.placed.get(id)?.node.label ?? String(id);
  const pathOf = (id: NodeId) => {
    const n = layout.placed.get(id)?.node;
    return n ? (n.line_start === null ? n.path : `${n.path}:${n.line_start}`) : '';
  };

  return (
    <Box className="min-w-0">
      <BoxHeader className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
        <span className={MUTED}>
          {functions} {functions === 1 ? 'function' : 'functions'} in {dirs} {dirs === 1 ? 'directory' : 'directories'}
        </span>
        {graph.truncated && <span className={MUTED}>Some neighbours are not shown.</span>}
        <button type="button" className={`${TARGET} ml-auto`} aria-pressed={table} onClick={() => setTable(!table)}>
          {CONCEPT_COPY.showTable}
        </button>
      </BoxHeader>
      {picked && (
        <BoxRow className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
          <span className="font-mono font-semibold break-all text-fg">{picked.label}</span>
          <span className="flex min-w-0 items-center gap-1">
            <span className={`font-mono text-xs break-all ${MUTED}`}>{pathOf(picked.id)}</span>
            <CopyButton value={pathOf(picked.id)} label={`Copy ${pathOf(picked.id)}`} />
          </span>
          {canExpand && <button type="button" className={TARGET} onClick={onExpand}>Show neighbours</button>}
        </BoxRow>
      )}
      <div ref={box} className="max-h-[70vh] overflow-auto border-t border-(--borderColor-muted) bg-canvas-inset">
        <svg
          role="img"
          aria-label={`${functions} ${functions === 1 ? 'function' : 'functions'} in ${dirs} ${dirs === 1 ? 'directory' : 'directories'}`}
          width={layout.width}
          height={layout.height}
          className="block"
        >
          <defs>
            <marker id="concept-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="fill-(--fgColor-muted)" />
            </marker>
          </defs>
          {layout.groups.map((g) => (
            <g key={`${g.x}:${g.y}`}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={6} className="fill-(--bgColor-muted) stroke-(--borderColor-default)" />
              <circle cx={g.x + GROUP_PAD + 4} cy={g.y + 9} r={4} className={hueOf.get(g.dir)} />
              <text x={g.x + GROUP_PAD + 12} y={g.y + 13} className="fill-(--fgColor-muted) font-mono text-[11px]">
                {clipLeft(g.dir || '(repo root)', 28)}
              </text>
            </g>
          ))}
          {graph.edges.map((e) => {
            const a = layout.placed.get(e.src);
            const b = layout.placed.get(e.dst);
            if (!a || !b) return null;
            const hot = selected !== null && (e.src === selected || e.dst === selected);
            const style = EDGE_STYLE[e.kind] ?? { label: e.kind };
            return (
              <path
                key={`${e.src}>${e.dst}>${e.kind}`}
                d={edgePath(a, b)}
                fill="none"
                strokeWidth={hot ? 2 : e.kind === 'then' ? 1 : 1.5}
                strokeDasharray={style.dash}
                markerEnd="url(#concept-arrow)"
                className={hot ? EDGE_TONE.hot : e.kind === 'then' ? EDGE_TONE.then : EDGE_TONE.other}
              />
            );
          })}
          {[...layout.placed.values()].map(({ node, x, y }) => {
            const isSelected = node.id === selected;
            const isStep = node.step_ordinal !== null;
            const text = `${isStep ? `${node.step_ordinal} ` : ''}${node.label}`;
            return (
              <g key={String(node.id)} onClick={() => onNode(node)} className="cursor-pointer">
                <title>{`${node.label} — ${node.line_start === null ? node.path : `${node.path}:${node.line_start}`}`}</title>
                <rect
                  x={x}
                  y={y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  strokeWidth={isSelected ? 2.5 : isStep ? 1.5 : 1}
                  className={isSelected ? NODE_TONE.selected : isStep ? NODE_TONE.step : NODE_TONE.other}
                />
                <text x={x + 8} y={y + NODE_H / 2 + 4} className={`fill-(--fgColor-default) font-mono text-xs ${isStep ? 'font-semibold' : ''}`}>
                  {clip(text, 26)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <BoxRow className="border-t border-(--borderColor-muted) px-3 py-2">
        <ul aria-label="Edge legend" className={`flex flex-wrap gap-3 text-xs ${MUTED}`}>
          {LEGEND.map(([kind, label]) => (
            <li key={kind} className="flex items-center gap-1">
              <svg aria-hidden="true" width="28" height="8">
                <line
                  x1="0"
                  y1="4"
                  x2="28"
                  y2="4"
                  strokeWidth={kind === 'then' ? 1 : 1.5}
                  strokeDasharray={EDGE_STYLE[kind]?.dash}
                  className={kind === 'then' ? EDGE_TONE.then : EDGE_TONE.other}
                />
              </svg>
              {label}
            </li>
          ))}
        </ul>
      </BoxRow>
      {table && (
        <div className="overflow-x-auto border-t border-(--borderColor-muted)">
          <table className="w-full text-left text-sm">
            <caption className={`px-3 pt-2 text-left text-xs ${MUTED}`}>Edges</caption>
            <thead>
              <tr className="border-b border-(--borderColor-default)">
                <th className="px-3 py-1.5 font-semibold">From</th>
                <th className="px-3 py-1.5 font-semibold">Kind</th>
                <th className="px-3 py-1.5 font-semibold">To</th>
              </tr>
            </thead>
            <tbody>
              {graph.edges.length === 0 && (
                <tr><td colSpan={3} className={`px-3 py-1.5 ${MUTED}`}>No edges between these functions.</td></tr>
              )}
              {graph.edges.map((e) => (
                <tr key={`${e.src}>${e.dst}>${e.kind}`} className="border-b border-(--borderColor-muted) last:border-b-0">
                  <td className="px-3 py-1.5"><span className="font-mono font-semibold">{labelOf(e.src)}</span> <span className={`font-mono text-xs ${MUTED}`}>{pathOf(e.src)}</span></td>
                  <td className="px-3 py-1.5">{(EDGE_STYLE[e.kind] ?? { label: e.kind }).label}</td>
                  <td className="px-3 py-1.5"><span className="font-mono font-semibold">{labelOf(e.dst)}</span> <span className={`font-mono text-xs ${MUTED}`}>{pathOf(e.dst)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Box>
  );
}
