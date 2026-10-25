import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConceptGraph, GraphNode, NodeId } from '../../api.ts';
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
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className={TARGET} aria-pressed={table} onClick={() => setTable(!table)}>
          {CONCEPT_COPY.showTable}
        </button>
        <span className={MUTED}>
          {functions} {functions === 1 ? 'function' : 'functions'} in {dirs} {dirs === 1 ? 'directory' : 'directories'}
        </span>
        {graph.truncated && <span className={MUTED}>Some neighbours are not shown.</span>}
      </div>
      {picked && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-800">
          <span className="font-medium break-all">{picked.label}</span>
          <span className={`font-mono text-xs break-all ${MUTED}`}>{pathOf(picked.id)}</span>
          {canExpand && <button type="button" className={TARGET} onClick={onExpand}>Show neighbours</button>}
        </div>
      )}
      <div ref={box} className="max-h-[70vh] overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
        <svg
          role="img"
          aria-label={`${functions} ${functions === 1 ? 'function' : 'functions'} in ${dirs} ${dirs === 1 ? 'directory' : 'directories'}`}
          width={layout.width}
          height={layout.height}
          className="block"
        >
          <defs>
            <marker id="concept-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="fill-zinc-500 dark:fill-zinc-400" />
            </marker>
          </defs>
          {layout.groups.map((g) => (
            <g key={`${g.x}:${g.y}`}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={8} className="fill-zinc-50 stroke-zinc-300 dark:fill-zinc-900 dark:stroke-zinc-700" />
              <text x={g.x + GROUP_PAD} y={g.y + 13} className="fill-zinc-600 font-mono text-[11px] dark:fill-zinc-400">
                {clipLeft(g.dir || '(repo root)', 30)}
              </text>
            </g>
          ))}
          {graph.edges.map((e) => {
            const a = layout.placed.get(e.src);
            const b = layout.placed.get(e.dst);
            if (!a || !b) return null;
            const hot = selected !== null && (e.src === selected || e.dst === selected);
            const style = EDGE_STYLE[e.kind] ?? { label: e.kind };
            const tone = hot
              ? 'stroke-blue-600 dark:stroke-blue-400'
              : e.kind === 'then'
                ? 'stroke-zinc-400 dark:stroke-zinc-500'
                : 'stroke-zinc-600 dark:stroke-zinc-300';
            return (
              <path
                key={`${e.src}>${e.dst}>${e.kind}`}
                d={edgePath(a, b)}
                fill="none"
                strokeWidth={hot ? 2 : e.kind === 'then' ? 1 : 1.5}
                strokeDasharray={style.dash}
                markerEnd="url(#concept-arrow)"
                className={tone}
              />
            );
          })}
          {[...layout.placed.values()].map(({ node, x, y }) => {
            const isSelected = node.id === selected;
            const isStep = node.step_ordinal !== null;
            const shape = isSelected
              ? 'fill-blue-100 stroke-blue-700 dark:fill-blue-950 dark:stroke-blue-400'
              : isStep
                ? 'fill-white stroke-zinc-700 dark:fill-zinc-950 dark:stroke-zinc-300'
                : 'fill-white stroke-zinc-400 dark:fill-zinc-950 dark:stroke-zinc-600';
            const text = `${isStep ? `${node.step_ordinal} ` : ''}${node.label}`;
            return (
              <g key={String(node.id)} onClick={() => onNode(node)} className="cursor-pointer">
                <title>{`${node.label} — ${node.line_start === null ? node.path : `${node.path}:${node.line_start}`}`}</title>
                <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={4} strokeWidth={isSelected ? 2.5 : isStep ? 1.5 : 1} className={shape} />
                <text x={x + 8} y={y + NODE_H / 2 + 4} className={`fill-zinc-900 font-mono text-xs dark:fill-zinc-100 ${isStep ? 'font-semibold' : ''}`}>
                  {clip(text, 26)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
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
                className={kind === 'then' ? 'stroke-zinc-400 dark:stroke-zinc-500' : 'stroke-zinc-600 dark:stroke-zinc-300'}
              />
            </svg>
            {label}
          </li>
        ))}
      </ul>
      {table && (
        <table className="w-full text-left text-sm">
          <caption className={`text-left text-xs ${MUTED}`}>Edges</caption>
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th className="py-1 pr-2 font-medium">From</th>
              <th className="py-1 pr-2 font-medium">Kind</th>
              <th className="py-1 font-medium">To</th>
            </tr>
          </thead>
          <tbody>
            {graph.edges.length === 0 && (
              <tr><td colSpan={3} className={`py-1 ${MUTED}`}>No edges between these functions.</td></tr>
            )}
            {graph.edges.map((e) => (
              <tr key={`${e.src}>${e.dst}>${e.kind}`} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-1 pr-2"><span className="font-medium">{labelOf(e.src)}</span> <span className={`font-mono text-xs ${MUTED}`}>{pathOf(e.src)}</span></td>
                <td className="py-1 pr-2">{(EDGE_STYLE[e.kind] ?? { label: e.kind }).label}</td>
                <td className="py-1"><span className="font-medium">{labelOf(e.dst)}</span> <span className={`font-mono text-xs ${MUTED}`}>{pathOf(e.dst)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
