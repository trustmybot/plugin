import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { SearchIcon } from '@primer/octicons-react';
import { query, useApi, type FileEdgeKind, type FileGraph } from './api.ts';
import { Flash } from './ui/Flash.tsx';

const NH = 28;
const GAP = 4;
const CPAD = 8;
const CHEAD = 22;
const CGAP = 12;
const TOP = 44;
const MAXSHOW = 4;
const DUR = 520;
const HIST_MAX = 8;
const RESIZE_DEBOUNCE = 120;

const DASH: Record<FileEdgeKind, string> = {
  calls: '',
  imports: '5 3',
  runs: '1.5 3',
  sources: '1.5 3',
  instantiates: '7 2 1.5 2',
};
const LANG: Record<string, string> = { tsx: 'ts', mjs: 'js', cjs: 'js' };

const HUES = [
  '--bgColor-accent-emphasis',
  '--bgColor-success-emphasis',
  '--bgColor-attention-emphasis',
  '--bgColor-done-emphasis',
  '--bgColor-severe-emphasis',
  '--bgColor-sponsors-emphasis',
  '--bgColor-danger-emphasis',
  '--bgColor-neutral-emphasis',
];

const MUTED = 'text-fg-muted';
const FAINT = 'text-(--fgColor-disabled)';
const SURFACE = 'bg-canvas';
const SURFACE2 = 'bg-(--bgColor-neutral-muted)';
const BORDER = 'border-(--borderColor-muted)';
const BORDER2 = 'border-(--borderColor-default)';
const HOVER = 'hover:bg-(--control-transparent-bgColor-hover) hover:text-fg';
const HOVER_BORDER = 'hover:border-(--borderColor-emphasis)';
const ACCENT_BORDER = 'border-(--borderColor-accent-emphasis)';
const EDGE = 'stroke-(--borderColor-default)';
const EDGE_HI = 'stroke-(--borderColor-accent-emphasis)';
const SEG = `inline-flex overflow-hidden rounded-md border ${BORDER2}`;
const SEG_BTN = `cursor-pointer border-0 bg-transparent ${MUTED} aria-pressed:bg-(--control-transparent-bgColor-selected) aria-pressed:font-semibold aria-pressed:text-fg`;

interface FileNode {
  i: number;
  path: string;
  name: string;
  dirPath: string;
  lang: string;
  summary: string;
}

interface Link {
  id: number;
  kind: FileEdgeKind;
  w: number;
}

interface Model {
  files: FileNode[];
  out: Map<number, Map<number, Link>>;
  inc: Map<number, Map<number, Link>>;
  byPath: Map<string, number>;
  top: number;
  hue: Map<string, string>;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Item = Box &
  (
    | { kind: 'cl'; label: string; count: number }
    | { kind: 'more'; ck: string; count: number }
    | { kind: 'n' | 'focus'; id: number }
  );

interface PairEdge {
  a: string;
  b: string;
  kind: FileEdgeKind;
  kw: number;
  w: number;
}

interface Layout {
  next: Map<string, Item>;
  edges: PairEdge[];
  H: number;
  hd: Array<{ x: number; w: number; t: string }>;
  CW: number;
}

interface Shown {
  item: Item;
  base: string;
  dying: boolean;
}

type Anim = Box & { a: number };

function buildModel(g: FileGraph): Model {
  const files = g.files.map((f, i) => {
    const cut = f.path.lastIndexOf('/');
    const name = f.path.slice(cut + 1);
    const ext = /\.(\w+)$/.exec(name)?.[1] ?? '';
    return { i, path: f.path, name, dirPath: cut < 0 ? '' : f.path.slice(0, cut), lang: LANG[ext] ?? ext, summary: f.purpose };
  });
  const out = new Map<number, Map<number, Link>>();
  const inc = new Map<number, Map<number, Link>>();
  const total = new Array<number>(files.length).fill(0);
  const add = (m: Map<number, Map<number, Link>>, a: number, b: number, kind: FileEdgeKind, w: number) => {
    if (!m.has(a)) m.set(a, new Map());
    m.get(a)!.set(b, { id: b, kind, w });
  };
  for (const e of g.edges) {
    if (e.src === e.dst) continue;
    add(out, e.src, e.dst, e.kind, e.weight);
    add(inc, e.dst, e.src, e.kind, e.weight);
    total[e.src]! += e.weight;
    total[e.dst]! += e.weight;
  }
  const top = total.reduce((best, w, i) => (w > total[best]! ? i : best), 0);
  const perLang = new Map<string, number>();
  for (const f of files) perLang.set(f.lang, (perLang.get(f.lang) ?? 0) + 1);
  const langs = [...perLang].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const hue = new Map(langs.map(([l], i) => [l, HUES[i % HUES.length]!]));
  return { files, out, inc, byPath: new Map(files.map((f) => [f.path, f.i])), top, hue };
}

const uses = (m: Model, i: number) => [...(m.out.get(i)?.values() ?? [])];
const usedBy = (m: Model, i: number) => [...(m.inc.get(i)?.values() ?? [])];
const dependents = (m: Model, i: number) => m.inc.get(i)?.size ?? 0;

function lanes(m: Model, f: number, depth: number): Map<number, number[]> {
  const L = new Map<number, number[]>([[0, [f]]]);
  const seen = new Set([f]);
  const d1o = uses(m, f).map((e) => e.id);
  const outSet = new Set(d1o);
  const d1i = usedBy(m, f).map((e) => e.id).filter((i) => !outSet.has(i));
  L.set(1, d1o);
  L.set(-1, d1i);
  d1o.forEach((i) => seen.add(i));
  d1i.forEach((i) => seen.add(i));
  if (depth > 1) {
    const n2o = new Set<number>();
    const n2i = new Set<number>();
    d1o.forEach((i) => uses(m, i).forEach((e) => { if (!seen.has(e.id)) n2o.add(e.id); }));
    n2o.forEach((i) => seen.add(i));
    d1i.forEach((i) => usedBy(m, i).forEach((e) => { if (!seen.has(e.id)) n2i.add(e.id); }));
    L.set(2, [...n2o]);
    L.set(-2, [...n2i]);
  }
  return L;
}

function weightTo(m: Model, focus: number, i: number, lane: number, L: Map<number, number[]>): number {
  if (lane === 1) return m.out.get(focus)?.get(i)?.w ?? 0;
  if (lane === -1) return m.inc.get(focus)?.get(i)?.w ?? 0;
  let w = 0;
  for (const p of L.get(lane > 0 ? lane - 1 : lane + 1)!) {
    const e = lane > 0 ? m.out.get(p)?.get(i) : m.inc.get(p)?.get(i);
    if (e) w += e.w;
  }
  return w;
}

function layout(m: Model, focus: number, depth: number, expanded: Set<string>, W: number): Layout {
  const L = lanes(m, focus, depth);
  const order = depth > 1 ? [-2, -1, 0, 1, 2] : [-1, 0, 1];
  const pad = 24;
  const gap = depth > 1 ? 44 : 72;
  const fw = depth > 1 ? 220 : 260;
  const lw = Math.max(160, Math.min(240, (W - pad * 2 - gap * (order.length - 1) - fw) / (order.length - 1)));
  const xs = new Map<number, number>();
  let x = pad;
  for (const l of order) {
    xs.set(l, x);
    x += (l === 0 ? fw : lw) + gap;
  }
  const span = x - gap - pad;
  const off = Math.max(0, (W - pad * 2 - span) / 2);
  for (const l of order) xs.set(l, xs.get(l)! + off);
  const next = new Map<string, Item>();
  const visKey = new Map<number, string>();
  const ypos = new Map<number, number>();
  let H = TOP;
  for (const l of [-1, 1, -2, 2].filter((v) => order.includes(v))) {
    const lx = xs.get(l)!;
    const groups = new Map<string, Array<{ i: number; w: number }>>();
    for (const i of L.get(l)!) {
      const k = m.files[i]!.dirPath;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push({ i, w: weightTo(m, focus, i, l, L) });
    }
    const gs = [...groups.entries()].map(([dir, arr]) => ({
      dir,
      arr: arr.sort((a, b) => b.w - a.w || m.files[a.i]!.name.localeCompare(m.files[b.i]!.name)),
      w: arr.reduce((s, a) => s + a.w, 0),
      bc: 0,
    }));
    if (Math.abs(l) === 2) {
      const prev = L.get(l > 0 ? 1 : -1)!;
      for (const g of gs) {
        let s = 0;
        let c = 0;
        for (const a of g.arr) {
          for (const p of prev) {
            const e = l > 0 ? m.out.get(p)?.get(a.i) : m.inc.get(p)?.get(a.i);
            if (e && ypos.has(p)) {
              s += ypos.get(p)!;
              c++;
            }
          }
        }
        g.bc = c ? s / c : 1e9;
      }
      gs.sort((a, b) => a.bc - b.bc);
    } else gs.sort((a, b) => b.w - a.w);
    let y = TOP;
    for (const g of gs) {
      const ck = `${l}:${g.dir}`;
      const open = expanded.has(ck) || g.arr.length <= MAXSHOW + 1;
      const shown = open ? g.arr : g.arr.slice(0, MAXSHOW);
      const rows = shown.length + (open ? 0 : 1);
      const h = CHEAD + rows * (NH + GAP) - GAP + CPAD;
      next.set(`c:${ck}`, { kind: 'cl', x: lx, y, w: lw, h, label: g.dir || '(root)', count: g.arr.length });
      let ny = y + CHEAD;
      for (const a of shown) {
        next.set(`n:${a.i}`, { kind: 'n', id: a.i, x: lx + CPAD, y: ny, w: lw - CPAD * 2, h: NH });
        visKey.set(a.i, `n:${a.i}`);
        ypos.set(a.i, ny);
        ny += NH + GAP;
      }
      if (!open) {
        const mk = `m:${ck}`;
        next.set(mk, { kind: 'more', ck, x: lx + CPAD, y: ny, w: lw - CPAD * 2, h: NH, count: g.arr.length - MAXSHOW });
        for (const a of g.arr.slice(MAXSHOW)) {
          visKey.set(a.i, mk);
          ypos.set(a.i, ny);
        }
      }
      y += h + CGAP;
    }
    H = Math.max(H, y);
  }
  const fh = Math.max(96, NH);
  H = Math.max(H, TOP + fh + 40);
  next.set(`n:${focus}`, { kind: 'focus', id: focus, x: xs.get(0)!, y: Math.max(TOP, Math.min(H / 2 - fh / 2, 220)), w: fw, h: fh });
  visKey.set(focus, `n:${focus}`);
  const hd = order.map((l) => {
    const n = L.get(l)!.length;
    const t = l === 0 ? 'Focus' : l === -1 ? `Used by · ${n}` : l === 1 ? `Uses · ${n}` : `2 hops · ${n}`;
    return { x: xs.get(l)!, w: l === 0 ? fw : lw, t };
  });
  const pairs = new Map<string, PairEdge>();
  const link = (s: number, t: number, e: Link | undefined) => {
    const a = visKey.get(s);
    const b = visKey.get(t);
    if (!e || !a || !b || a === b) return;
    const k = `${a}>${b}`;
    const p = pairs.get(k);
    if (p) {
      p.w += e.w;
      if (e.w > p.kw) {
        p.kind = e.kind;
        p.kw = e.w;
      }
    } else pairs.set(k, { a, b, kind: e.kind, kw: e.w, w: e.w });
  };
  const L1 = L.get(1)!;
  const Lm1 = L.get(-1)!;
  L1.forEach((i) => link(focus, i, m.out.get(focus)?.get(i)));
  Lm1.forEach((i) => link(i, focus, m.inc.get(focus)?.get(i)));
  if (depth > 1) {
    const L2 = new Set(L.get(2)!);
    const Lm2 = new Set(L.get(-2)!);
    L1.forEach((p) => uses(m, p).forEach((e) => { if (L2.has(e.id)) link(p, e.id, e); }));
    Lm1.forEach((p) => usedBy(m, p).forEach((e) => { if (Lm2.has(e.id)) link(e.id, p, e); }));
  }
  const L1set = new Set(L1);
  usedBy(m, focus).forEach((e) => { if (L1set.has(e.id)) link(e.id, focus, e); });
  return { next, edges: [...pairs.values()], H: H + 24, hd, CW: Math.max(W, x - gap + pad) };
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const short = (d: string) => d.split('/').slice(-2).join('/');
const composite = (key: string, item: Item) => `${key}|${item.kind}`;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const domId = (raw: string) => raw.replace(/[^a-zA-Z0-9_-]/g, '');

function edgePath(A: Anim, B: Anim): string {
  const back = A.x > B.x;
  const y1 = A.y + A.h / 2;
  const y2 = B.y + B.h / 2;
  if (back) {
    const x1 = A.x;
    const x2 = B.x + B.w + 2;
    return `M${x1},${y1} C${x1 - 40},${y1 + 60} ${x2 + 40},${y2 + 60} ${x2},${y2}`;
  }
  const x1 = A.x + A.w;
  const x2 = B.x - 2;
  const dx = Math.max(30, Math.abs(x2 - x1) * 0.5);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

export function DepGraph({ repo }: { repo: string }) {
  const q = useApi<FileGraph>(`world-model/graph?${query({ repo })}`);
  if (q.error) return <Flash variant="danger">{q.error.message}</Flash>;
  if (q.data === undefined) return <p className="text-fg-muted">Loading…</p>;
  if (!q.data.available) return <p className="text-fg-muted">No dependency graph yet — run /scan in a Claude Code session.</p>;
  if (q.data.files.length === 0) return <p className="text-fg-muted">No file dependencies recorded for {repo}.</p>;
  return <Graph data={q.data} />;
}

function Graph({ data }: { data: FileGraph }) {
  const m = useMemo(() => buildModel(data), [data]);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [depth, setDepth] = useState(1);
  const [hist, setHist] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [sort, setSort] = useState<{ in: 'w' | 'n'; out: 'w' | 'n' }>({ in: 'w', out: 'w' });
  const [hover, setHover] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; id: number; on: boolean } | null>(null);
  const [width, setWidth] = useState(0);
  const [settled, setSettled] = useState<Layout | null>(null);
  const [term, setTerm] = useState('');
  const stage = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLDivElement>());
  const paths = useRef(new Map<string, SVGPathElement>());
  const cur = useRef(new Map<string, Anim>());
  const rendered = useRef(new Map<string, Shown>());
  const uid = domId(useId());
  const focus = (focusPath === null ? undefined : m.byPath.get(focusPath)) ?? m.top;
  const node = m.files[focus]!;

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    setWidth(el.clientWidth);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setWidth(el.clientWidth), RESIZE_DEBOUNCE);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  const lay = useMemo(() => (width ? layout(m, focus, depth, expanded, width) : null), [m, focus, depth, expanded, width]);

  const view = useMemo(() => {
    const next = new Map<string, Shown>();
    if (!lay) return next;
    for (const [k, o] of lay.next) next.set(composite(k, o), { item: o, base: k, dying: false });
    for (const [ck, v] of rendered.current) {
      if (!next.has(ck) && !lay.next.has(v.base)) next.set(ck, { ...v, dying: true });
    }
    return next;
  }, [lay]);

  const shown = useMemo(
    () => (settled !== null && settled === lay ? new Map([...view].filter(([, v]) => !v.dying)) : view),
    [view, settled, lay],
  );

  useLayoutEffect(() => {
    rendered.current = shown;
  }, [shown]);

  useLayoutEffect(() => {
    if (!lay) return;
    const from = new Map<string, Anim>();
    const to = new Map<string, Anim>();
    for (const [ck, v] of view) {
      const c = cur.current.get(ck);
      const box = { x: v.item.x, y: v.item.y, w: v.item.w, h: v.item.h };
      to.set(ck, v.dying ? { ...(c ?? box), a: 0 } : { ...box, a: 1 });
      from.set(ck, c ? { ...c } : { ...box, a: 0 });
    }
    for (const ck of [...cur.current.keys()]) if (!view.has(ck)) cur.current.delete(ck);
    const edgeEnds = lay.edges.map((e) => ({
      e,
      a: composite(e.a, lay.next.get(e.a)!),
      b: composite(e.b, lay.next.get(e.b)!),
    }));
    const drawEdges = (t: number) => {
      for (const { e, a, b } of edgeEnds) {
        const A = cur.current.get(a);
        const B = cur.current.get(b);
        const p = paths.current.get(`${e.a}>${e.b}`);
        if (!A || !B || !p) continue;
        p.setAttribute('d', edgePath(A, B));
        p.style.opacity = (Math.min(A.a, B.a) * Math.max(0, (t - 0.35) / 0.65) * 0.85).toFixed(3);
      }
    };
    const reduce = reducedMotion();
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = reduce ? 1 : Math.min(1, (now - t0) / DUR);
      const k = ease(t);
      for (const [ck, f] of from) {
        const e = to.get(ck)!;
        const c = {
          x: f.x + (e.x - f.x) * k,
          y: f.y + (e.y - f.y) * k,
          w: f.w + (e.w - f.w) * k,
          h: f.h + (e.h - f.h) * k,
          a: f.a + (e.a - f.a) * k,
        };
        cur.current.set(ck, c);
        const el = els.current.get(ck);
        if (el) {
          el.style.transform = `translate(${c.x}px,${c.y}px)`;
          el.style.width = `${c.w}px`;
          el.style.height = `${c.h}px`;
          el.style.opacity = String(c.a);
        }
      }
      drawEdges(t);
      if (t < 1) raf = requestAnimationFrame(step);
      else setSettled(lay);
    };
    step(t0);
    return () => cancelAnimationFrame(raf);
  }, [lay, view]);

  const hiKeys = useMemo(() => {
    const hi = new Set<string>();
    if (!hover || !lay) return hi;
    hi.add(hover);
    for (const e of lay.edges) {
      if (e.a === hover || e.b === hover) {
        hi.add(e.a);
        hi.add(e.b);
      }
    }
    return hi;
  }, [hover, lay]);

  const clearHover = () => {
    setHover(null);
    setTip((t) => (t ? { ...t, on: false } : t));
  };

  const hoverNode = (key: string, item: Item, el: HTMLElement | undefined) => {
    setHover(key);
    if (item.kind !== 'n' || !el || !stage.current) {
      setTip((t) => (t ? { ...t, on: false } : t));
      return;
    }
    const r = el.getBoundingClientRect();
    const s = stage.current.getBoundingClientRect();
    let x = r.left - s.left + stage.current.scrollLeft;
    if (r.left - s.left + 320 > s.width) x = s.width - 326 + stage.current.scrollLeft;
    setTip({ x, y: r.bottom - s.top + 6, id: item.id, on: true });
  };

  const refocus = (id: number) => {
    if (id === focus) return;
    setHist((h) => [...h, node.path].slice(-HIST_MAX));
    setFocusPath(m.files[id]!.path);
    setExpanded(new Set());
    clearHover();
  };

  const backTo = (ix: number) => {
    setFocusPath(hist[ix]!);
    setHist(hist.slice(0, ix));
    setExpanded(new Set());
    clearHover();
  };

  const pick = () => {
    const v = term.trim().toLowerCase();
    if (!v) return;
    const hit =
      m.files.find((f) => f.path.toLowerCase() === v) ??
      m.files.find((f) => f.name.toLowerCase() === v) ??
      m.files.find((f) => f.path.toLowerCase().includes(v));
    if (hit) {
      refocus(hit.i);
      setTerm('');
    }
  };

  const hoverRow = (id: number) => {
    const key = `n:${id}`;
    const item = lay?.next.get(key);
    if (item) hoverNode(key, item, els.current.get(composite(key, item)));
  };

  const SH = Math.max(520, lay?.H ?? 0);
  const arrow = `${uid}-ah`;
  const arrowHi = `${uid}-ahh`;
  const tipNode = tip ? m.files[tip.id] : undefined;

  return (
    <section className={`min-w-0 overflow-hidden rounded-md border ${BORDER2} text-[13px] leading-[1.45]`}>
      <header className={`flex flex-wrap items-center gap-x-5 gap-y-3 border-b bg-canvas-muted px-4 py-3 sm:px-6 ${BORDER2}`}>
        <h2 className="m-0 text-[15px] font-semibold">Dependency graph</h2>
        <div className="relative">
          <SearchIcon size={14} aria-hidden="true" className="pointer-events-none absolute left-[9px] top-[9px] text-fg-muted" />
          <input
            list={`${uid}-paths`}
            placeholder={`Focus a file: ${node.name}`}
            autoComplete="off"
            aria-label="Focus a file"
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              if ((e.nativeEvent as InputEvent).inputType === undefined || (e.nativeEvent as InputEvent).inputType === 'insertReplacementText') {
                const v = e.target.value.trim().toLowerCase();
                const hit = m.files.find((f) => f.path.toLowerCase() === v);
                if (hit) {
                  refocus(hit.i);
                  setTerm('');
                  e.target.blur();
                }
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                pick();
                e.currentTarget.blur();
              }
            }}
            className="h-8 w-80 max-w-[60vw] rounded-md border border-(--control-borderColor-rest) bg-(--control-bgColor-rest) pl-[30px] pr-2.5 text-(--control-fgColor-rest) placeholder:text-(--control-fgColor-placeholder) focus-visible:border-(--borderColor-accent-emphasis) focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-1"
          />
          <datalist id={`${uid}-paths`}>
            {m.files.map((f) => <option key={f.path} value={f.path} />)}
          </datalist>
        </div>
        <span className={`text-xs ${MUTED}`}>Depth</span>
        <div className={SEG}>
          {[1, 2].map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={depth === d}
              className={`${SEG_BTN} px-[11px] py-1.5`}
              onClick={() => {
                setDepth(d);
                setExpanded(new Set());
              }}
            >
              {d === 1 ? '1 hop' : '2 hops'}
            </button>
          ))}
        </div>
        <div className={`flex items-center gap-3.5 text-xs lg:ml-auto ${MUTED}`} aria-label="Edge kinds">
          {([
            ['calls', ''],
            ['imports', '5 3'],
            ['runs, sources', '1.5 3'],
            ['instantiates', '7 2 1.5 2'],
          ] as const).map(([label, dash]) => (
            <span key={label}>
              <svg viewBox="0 0 26 8" className="mr-[5px] inline h-2 w-[26px] align-middle">
                <path d="M0 4h26" stroke="currentColor" strokeDasharray={dash || undefined} strokeLinecap={dash === '1.5 3' ? 'round' : undefined} />
              </svg>
              {label}
            </span>
          ))}
        </div>
      </header>
      <nav className={`flex min-h-[38px] flex-wrap items-center gap-1.5 px-4 py-2.5 text-xs sm:px-6 ${MUTED}`} aria-label="Focus history">
        {hist.map((p, ix) => {
          const i = m.byPath.get(p);
          if (i === undefined) return null;
          return (
            <span key={`${ix}:${p}`} className="contents">
              <button
                type="button"
                title={p}
                onClick={() => backTo(ix)}
                className={`cursor-pointer rounded px-1 py-0.5 font-mono text-xs ${MUTED} ${HOVER}`}
              >
                {m.files[i]!.name}
              </button>
              <span>›</span>
            </span>
          );
        })}
        <span className="break-all font-mono text-xs font-semibold text-fg">{node.path}</span>
      </nav>
      <div className={`grid border-t lg:grid-cols-[minmax(0,1fr)_340px] ${BORDER}`}>
        <div
          ref={stage}
          className="relative min-h-[520px] touch-pan-x overflow-x-auto overflow-y-hidden overscroll-x-contain"
          style={{ height: SH }}
          onMouseLeave={clearHover}
        >
          <svg className="pointer-events-none absolute left-0 top-0" style={{ width: lay?.CW ?? 0, height: SH }}>
            <defs>
              <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" markerUnits="userSpaceOnUse" orient="auto">
                <path d="M1 1L7 4L1 7" fill="none" strokeWidth="1.3" className={EDGE} />
              </marker>
              <marker id={arrowHi} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto">
                <path d="M1 1L7 4L1 7" fill="none" strokeWidth="1.4" className={EDGE_HI} />
              </marker>
            </defs>
            <g>
              {lay?.edges.map((e) => {
                const key = `${e.a}>${e.b}`;
                const on = hover !== null && (e.a === hover || e.b === hover);
                const tone = hover === null ? EDGE : on ? `${EDGE_HI} opacity-100!` : `${EDGE} opacity-[.12]!`;
                return (
                  <path
                    key={key}
                    ref={(el) => {
                      if (el) paths.current.set(key, el);
                      else paths.current.delete(key);
                    }}
                    fill="none"
                    strokeDasharray={DASH[e.kind] || undefined}
                    strokeLinecap={e.kind === 'calls' ? undefined : 'round'}
                    markerEnd={`url(#${on ? arrowHi : arrow})`}
                    style={{ strokeWidth: (1 + Math.min(1.2, Math.log10(e.w) * 0.6)).toFixed(2) }}
                    className={`transition-[stroke,opacity] duration-150 ${tone}`}
                  />
                );
              })}
            </g>
          </svg>
          {lay?.hd.map((h) => (
            <div
              key={`${h.x}:${h.t}`}
              className={`absolute top-3.5 text-center text-[11px] tracking-[.02em] ${FAINT}`}
              style={{ left: h.x, width: h.w }}
            >
              {h.t}
            </div>
          ))}
          <div>
            {[...shown].filter(([, v]) => v.item.kind === 'cl').map(([ck, v]) => (
              <Cluster key={ck} item={v.item} bind={(el) => bindEl(els.current, ck, el)} />
            ))}
            {[...shown].filter(([, v]) => v.item.kind !== 'cl').map(([ck, v]) => {
              const dim = hover !== null && !hiKeys.has(v.base);
              const hi = hover !== null && !dim && v.base !== hover;
              return (
                <GraphNode
                  key={ck}
                  m={m}
                  item={v.item}
                  dim={dim}
                  hi={hi}
                  bind={(el) => bindEl(els.current, ck, el)}
                  onEnter={() => hoverNode(v.base, v.item, els.current.get(ck))}
                  onLeave={clearHover}
                  onFocusFile={refocus}
                  onExpand={(k) => setExpanded((s) => new Set(s).add(k))}
                />
              );
            })}
          </div>
          {tip && tipNode && (
            <div
              className={`pointer-events-none absolute z-10 max-w-[320px] rounded-lg border px-2.5 py-2 text-xs shadow-(--shadow-floating-small) transition-opacity duration-100 ${BORDER2} ${SURFACE}`}
              style={{ left: tip.x, top: tip.y, opacity: tip.on ? 1 : 0 }}
            >
              <div className={`mb-1 break-all font-mono text-[11px] ${MUTED}`}>{tipNode.path}</div>
              {tipNode.summary && <div className="mb-1.5">{tipNode.summary}</div>}
              <div className={MUTED}>Used by {dependents(m, tip.id)} · uses {uses(m, tip.id).length}</div>
            </div>
          )}
        </div>
        <Panel
          m={m}
          focus={focus}
          sort={sort}
          onSort={(k, s) => setSort((cur) => ({ ...cur, [k]: s }))}
          onFocusFile={refocus}
          onRowEnter={hoverRow}
          onRowLeave={clearHover}
        />
      </div>
    </section>
  );
}

function bindEl(map: Map<string, HTMLDivElement>, key: string, el: HTMLDivElement | null) {
  if (el) map.set(key, el);
  else map.delete(key);
}

function Cluster({ item, bind }: { item: Item; bind: (el: HTMLDivElement | null) => void }) {
  if (item.kind !== 'cl') return null;
  return (
    <div ref={bind} className={`pointer-events-none absolute left-0 top-0 rounded-lg border border-dashed ${BORDER2}`}>
      <span title={item.label} className={`pointer-events-auto absolute left-2 right-2 top-1 truncate font-mono text-[11px] ${MUTED}`}>
        {short(item.label)} <b className={`font-normal ${FAINT}`}>{item.count}</b>
      </span>
    </div>
  );
}

function GraphNode({
  m,
  item,
  dim,
  hi,
  bind,
  onEnter,
  onLeave,
  onFocusFile,
  onExpand,
}: {
  m: Model;
  item: Item;
  dim: boolean;
  hi: boolean;
  bind: (el: HTMLDivElement | null) => void;
  onEnter: () => void;
  onLeave: () => void;
  onFocusFile: (id: number) => void;
  onExpand: (ck: string) => void;
}) {
  const shell = 'absolute left-0 top-0 flex rounded-md transition-[opacity,border-color,background-color] duration-150';
  const base = `${shell} cursor-pointer items-center gap-1.5 whitespace-nowrap border px-2`;
  const state = `${dim ? 'opacity-30!' : ''} ${hi ? ACCENT_BORDER : ''}`;
  const activate = (fn: () => void) => ({
    role: 'button',
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    },
  });
  if (item.kind === 'cl') return null;
  if (item.kind === 'more') {
    return (
      <div
        ref={bind}
        title="Expand this folder"
        {...activate(() => onExpand(item.ck))}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className={`${base} border-dashed bg-transparent ${MUTED} ${state} ${hi ? '' : `${BORDER2} ${HOVER_BORDER}`}`}
      >
        <span className="flex-1 truncate text-xs">+{item.count} more</span>
      </div>
    );
  }
  const n = m.files[item.id]!;
  const lang = (
    <span className={`inline-flex items-center gap-1 rounded-[3px] px-1 font-mono text-[10px] leading-4 ${MUTED} ${SURFACE2}`}>
      <span aria-hidden="true" className="size-2 rounded-full" style={{ background: `var(${m.hue.get(n.lang)})` }} />
      {n.lang}
    </span>
  );
  if (item.kind === 'focus') {
    return (
      <div
        ref={bind}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className={`${shell} cursor-default flex-col items-stretch justify-center gap-1 overflow-hidden whitespace-normal border-[1.5px] ${ACCENT_BORDER} bg-(--bgColor-accent-muted) px-3 py-2.5 ${dim ? 'opacity-30!' : ''}`}
      >
        <div className="flex items-center gap-1.5">
          {lang}
          <span className="flex-1 truncate font-mono text-[13px] font-semibold text-(--fgColor-accent)">{n.name}</span>
        </div>
        <div className={`truncate font-mono text-[11px] ${MUTED}`}>{n.dirPath}</div>
        {n.summary && <div className="line-clamp-3 text-xs">{n.summary}</div>}
      </div>
    );
  }
  const deps = dependents(m, item.id);
  return (
    <div
      ref={bind}
      {...activate(() => onFocusFile(item.id))}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className={`${base} ${SURFACE} ${state} ${hi ? '' : `${BORDER2} ${HOVER_BORDER}`}`}
    >
      {item.w >= 150 && lang}
      <span className="flex-1 truncate font-mono text-xs">{n.name}</span>
      <span title="dependents" className={`text-[11px] tabular-nums ${FAINT}`}>{deps || ''}</span>
    </div>
  );
}

function Panel({
  m,
  focus,
  sort,
  onSort,
  onFocusFile,
  onRowEnter,
  onRowLeave,
}: {
  m: Model;
  focus: number;
  sort: { in: 'w' | 'n'; out: 'w' | 'n' };
  onSort: (k: 'in' | 'out', s: 'w' | 'n') => void;
  onFocusFile: (id: number) => void;
  onRowEnter: (id: number) => void;
  onRowLeave: () => void;
}) {
  const n = m.files[focus]!;
  const ub = usedBy(m, focus);
  const us = uses(m, focus);
  const seg = (k: 'in' | 'out') => (
    <div className={SEG}>
      {(['w', 'n'] as const).map((s) => (
        <button key={s} type="button" aria-pressed={sort[k] === s} className={`${SEG_BTN} px-2 py-[3px] text-[11px]`} onClick={() => onSort(k, s)}>
          {s === 'w' ? 'Weight' : 'Name'}
        </button>
      ))}
    </div>
  );
  const list = (arr: Link[], k: 'in' | 'out') => {
    if (arr.length === 0) return <div className={`px-1 py-1.5 text-xs ${FAINT}`}>None</div>;
    const sorted = [...arr].sort((a, b) => (sort[k] === 'w' ? b.w - a.w : m.files[a.id]!.name.localeCompare(m.files[b.id]!.name)));
    return (
      <ul className="m-0 list-none p-0">
        {sorted.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => onFocusFile(e.id)}
              onMouseEnter={() => onRowEnter(e.id)}
              onMouseLeave={onRowLeave}
              className={`flex w-full cursor-pointer items-center gap-2 border-0 border-b bg-transparent px-1 py-1.5 text-left font-mono text-xs hover:bg-(--control-transparent-bgColor-hover) ${BORDER}`}
            >
              <span className="flex-1 truncate">
                {m.files[e.id]!.name} <span className={`text-[11px] ${FAINT}`}>{m.files[e.id]!.dirPath}</span>
              </span>
              <span className={`font-sans text-[11px] ${MUTED}`}>{e.kind}</span>
              <span className={`min-w-[22px] text-right font-sans text-[11px] tabular-nums ${FAINT}`}>{e.w}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  };
  return (
    <aside aria-live="polite" className={`min-w-0 border-t px-[18px] pb-[30px] pt-[18px] lg:border-l lg:border-t-0 ${BORDER} ${SURFACE}`}>
      <h2 className="m-0 mb-0.5 break-all font-mono text-sm font-semibold">{n.name}</h2>
      <div className={`break-all font-mono text-[11px] ${MUTED}`}>{n.dirPath}</div>
      {n.summary && <p className="mt-2.5">{n.summary}</p>}
      <div className="mb-[18px] mt-3.5 grid grid-cols-2 gap-2">
        {[
          [ub.length, 'Direct dependents'],
          [us.length, 'Direct dependencies'],
        ].map(([v, k]) => (
          <div key={k} className="rounded-md bg-canvas-muted px-2.5 py-2">
            <div className="text-lg font-semibold tabular-nums">{v}</div>
            <div className={`text-[11px] ${MUTED}`}>{k}</div>
          </div>
        ))}
      </div>
      <div className="mb-1.5 mt-4 flex items-center justify-between">
        <h3 className="m-0 text-xs font-semibold">Used by</h3>
        {seg('in')}
      </div>
      {list(ub, 'in')}
      <div className="mb-1.5 mt-4 flex items-center justify-between">
        <h3 className="m-0 text-xs font-semibold">Uses</h3>
        {seg('out')}
      </div>
      {list(us, 'out')}
    </aside>
  );
}
