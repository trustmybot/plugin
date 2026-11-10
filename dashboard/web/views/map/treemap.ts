// Squarified treemap layout after d3-hierarchy's treemapSquarify (github.com/d3/d3-hierarchy, ISC):
// rows are filled greedily while the worst aspect ratio improves against the golden ratio.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cell<T> extends Rect {
  item: T;
  value: number;
}

const PHI = (1 + Math.sqrt(5)) / 2;

export function squarify<T extends { value: number }>(items: readonly T[], rect: Rect, ratio = PHI): Cell<T>[] {
  const nodes = items.filter((i) => Number.isFinite(i.value) && i.value > 0).sort((a, b) => b.value - a.value);
  const cells: Cell<T>[] = [];
  let x0 = rect.x;
  let y0 = rect.y;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  let remaining = nodes.reduce((s, n) => s + n.value, 0);
  let i0 = 0;
  while (i0 < nodes.length) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    let i1 = i0;
    let sum = nodes[i1++]!.value;
    let min = sum;
    let max = sum;
    const alpha = Math.max(dy / dx, dx / dy) / (remaining * ratio);
    let beta = sum * sum * alpha;
    let worst = Math.max(max / beta, beta / min);
    for (; i1 < nodes.length; i1++) {
      const v = nodes[i1]!.value;
      const nextMin = Math.min(min, v);
      const nextMax = Math.max(max, v);
      beta = (sum + v) * (sum + v) * alpha;
      const next = Math.max(nextMax / beta, beta / nextMin);
      if (next > worst) break;
      sum += v;
      min = nextMin;
      max = nextMax;
      worst = next;
    }
    const row = nodes.slice(i0, i1);
    const last = i1 === nodes.length;
    if (dx < dy) {
      const yEnd = last ? y1 : y0 + (dy * sum) / remaining;
      lay(row, sum, { x: x0, y: y0, w: dx, h: yEnd - y0 }, 'x', cells);
      y0 = yEnd;
    } else {
      const xEnd = last ? x1 : x0 + (dx * sum) / remaining;
      lay(row, sum, { x: x0, y: y0, w: xEnd - x0, h: dy }, 'y', cells);
      x0 = xEnd;
    }
    remaining -= sum;
    i0 = i1;
  }
  return cells;
}

function lay<T extends { value: number }>(row: readonly T[], sum: number, band: Rect, axis: 'x' | 'y', out: Cell<T>[]) {
  const span = axis === 'x' ? band.w : band.h;
  let at = axis === 'x' ? band.x : band.y;
  row.forEach((item, i) => {
    const end = i === row.length - 1 ? (axis === 'x' ? band.x + band.w : band.y + band.h) : at + (span * item.value) / sum;
    out.push(
      axis === 'x'
        ? { item, value: item.value, x: at, y: band.y, w: end - at, h: band.h }
        : { item, value: item.value, x: band.x, y: at, w: band.w, h: end - at },
    );
    at = end;
  });
}
