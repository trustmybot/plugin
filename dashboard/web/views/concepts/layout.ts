import type { ConceptGraph, ConceptStep, GraphEdge, GraphNode, NodeId, Trust } from '../../api.ts';

export const TRUST_RANK: Record<Trust, number> = { verified: 0, suspect: 1, broken: 2 };
export const worseTrust = (a: Trust, b: Trust) => (TRUST_RANK[b] > TRUST_RANK[a] ? b : a);
export const headerTrust = (status: Trust, steps: ConceptStep[]) =>
  steps.reduce<Trust>((worst, s) => worseTrust(worst, s.symbol === null ? 'broken' : s.trust ?? 'verified'), status);

export const isFileAnchor = (s: ConceptStep['symbol']) => s !== null && (s.id === null || s.kind === 'file');
export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const stepNodeId = (s: NonNullable<ConceptStep['symbol']>): NodeId => (s.id === null || s.kind === 'file' ? `file:${s.repo}:${s.path}` : s.id);

export function derivedGraph(steps: ConceptStep[]): ConceptGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let prev: NodeId | null = null;
  let prevHandoff: string | null = null;
  for (const s of steps) {
    if (!s.symbol) continue;
    const id = stepNodeId(s.symbol);
    if (!nodes.some((n) => n.id === id)) {
      nodes.push({
        id,
        label: isFileAnchor(s.symbol) ? baseOf(s.symbol.path) : s.symbol.qualified_name,
        repo: s.symbol.repo,
        path: s.symbol.path,
        dir: dirOf(s.symbol.path),
        kind: isFileAnchor(s.symbol) ? 'file' : s.symbol.kind,
        line_start: isFileAnchor(s.symbol) ? null : s.symbol.line_start,
        step_ordinal: s.ordinal,
      });
    }
    if (prev !== null && prev !== id) edges.push({ src: prev, dst: id, kind: prevHandoff ?? 'then' });
    prev = id;
    prevHandoff = s.handoff;
  }
  return { nodes, edges, truncated: false };
}

export function mergeGraphs(base: ConceptGraph, extra: Array<ConceptGraph | undefined>): ConceptGraph {
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  const edges = new Map(base.edges.map((e) => [`${e.src}>${e.dst}>${e.kind}`, e]));
  for (const g of extra) {
    if (!g) continue;
    for (const n of g.nodes) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, step_ordinal: null });
    for (const e of g.edges) edges.set(`${e.src}>${e.dst}>${e.kind}`, e);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated: base.truncated || extra.some((g) => g?.truncated) };
}

export const stepLocation = (s: ConceptStep) => {
  if (!s.symbol) return null;
  return isFileAnchor(s.symbol) || s.symbol.line_start === null ? s.symbol.path : `${s.symbol.path}:${s.symbol.line_start}`;
};

export const NODE_W = 190;
export const NODE_H = 30;
export const COL_W = 236;
export const NODE_GAP = 8;
export const GROUP_PAD = 8;
export const LABEL_H = 18;
export const GROUP_GAP = 14;
export const PAD = 16;

export interface Placed {
  node: GraphNode;
  col: number;
  x: number;
  y: number;
}

export interface DirGroup {
  dir: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const clipLeft = (s: string, n: number) => (s.length > n ? `…${s.slice(s.length - n + 1)}` : s);

// Layered layout: a step's rank is its ordinal; every other node takes the
// lowest rank among its ranked neighbours, round by round outward from the
// steps. Within a rank, nodes sort by directory and each directory run is
// drawn as one group.
export function layoutGraph(graph: ConceptGraph) {
  const rank = new Map<NodeId, number>();
  for (const n of graph.nodes) if (n.step_ordinal !== null && !rank.has(n.id)) rank.set(n.id, n.step_ordinal);
  const adjacent = new Map<NodeId, NodeId[]>();
  for (const e of graph.edges) {
    adjacent.set(e.src, [...(adjacent.get(e.src) ?? []), e.dst]);
    adjacent.set(e.dst, [...(adjacent.get(e.dst) ?? []), e.src]);
  }
  for (let changed = true; changed; ) {
    const next = new Map<NodeId, number>();
    for (const n of graph.nodes) {
      if (rank.has(n.id)) continue;
      const ranks = (adjacent.get(n.id) ?? []).map((o) => rank.get(o)).filter((r): r is number => r !== undefined);
      if (ranks.length > 0) next.set(n.id, Math.min(...ranks));
    }
    for (const [k, v] of next) rank.set(k, v);
    changed = next.size > 0;
  }
  const fallback = Math.max(0, ...rank.values()) + 1;
  const ranks = [...new Set(graph.nodes.map((n) => rank.get(n.id) ?? fallback))].sort((a, b) => a - b);
  const placed = new Map<NodeId, Placed>();
  const groups: DirGroup[] = [];
  let height = 0;
  ranks.forEach((r, col) => {
    const members = graph.nodes
      .filter((n) => (rank.get(n.id) ?? fallback) === r)
      .sort(
        (a, b) =>
          a.dir.localeCompare(b.dir) ||
          (a.step_ordinal ?? Infinity) - (b.step_ordinal ?? Infinity) ||
          a.label.localeCompare(b.label),
      );
    const x = PAD + GROUP_PAD + col * COL_W;
    let y = PAD;
    let group: DirGroup | null = null;
    for (const node of members) {
      if (!group || group.dir !== node.dir) {
        if (group) y = group.y + group.h + GROUP_GAP;
        group = { dir: node.dir, x: x - GROUP_PAD, y, w: NODE_W + 2 * GROUP_PAD, h: 0 };
        groups.push(group);
        y += LABEL_H;
      }
      placed.set(node.id, { node, col, x, y });
      y += NODE_H + NODE_GAP;
      group.h = y - NODE_GAP + GROUP_PAD - group.y;
    }
    if (group) height = Math.max(height, group.y + group.h + PAD);
  });
  return { placed, groups, width: PAD * 2 + ranks.length * COL_W, height };
}

export function edgePath(a: Placed, b: Placed): string {
  const ay = a.y + NODE_H / 2;
  const by = b.y + NODE_H / 2;
  if (a.col === b.col) {
    const x = a.x + NODE_W;
    return `M${x},${ay} C${x + 40},${ay} ${x + 40},${by} ${x},${by}`;
  }
  const forward = a.col < b.col;
  const x1 = forward ? a.x + NODE_W : a.x;
  const x2 = forward ? b.x : b.x + NODE_W;
  const dx = Math.max(30, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
  return `M${x1},${ay} C${x1 + dx},${ay} ${x2 - dx},${by} ${x2},${by}`;
}
