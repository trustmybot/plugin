// Treemap layout test: bundle web/views/map/treemap.ts with esbuild and check
// squarify gives each cell an area proportional to its value, keeps cells
// inside the rectangle without overlap, fills it, drops zero values, and
// matches a hand-computed squarified layout.
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;

let squarify;
before(async () => {
  const out = await build({
    entryPoints: [`${DASH}web/views/map/treemap.ts`],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  ({ squarify } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`));
});

const EPS = 1e-6;
const close = (a, b) => Math.abs(a - b) <= EPS * Math.max(1, Math.abs(b));
const rect = (c) => ({ x: c.x, y: c.y, w: c.w, h: c.h });

function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function assertLayout(values, box) {
  const cells = squarify(values.map((value, id) => ({ id, value })), box);
  const kept = values.filter((v) => v > 0);
  assert.equal(cells.length, kept.length, 'one cell per positive value');
  const total = kept.reduce((s, v) => s + v, 0);
  const area = box.w * box.h;
  for (const c of cells) {
    const want = (c.item.value / total) * area;
    assert.ok(Math.abs(c.w * c.h - want) <= EPS * want, `cell ${c.item.id}: area ${c.w * c.h} vs ${want}`);
    assert.ok(c.w >= -EPS && c.h >= -EPS);
    assert.ok(c.x >= box.x - EPS && c.y >= box.y - EPS, 'inside, top-left');
    assert.ok(c.x + c.w <= box.x + box.w + EPS && c.y + c.h <= box.y + box.h + EPS, 'inside, bottom-right');
  }
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i];
      const b = cells[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(ox <= EPS || oy <= EPS, `cells ${a.item.id} and ${b.item.id} overlap`);
    }
  }
  const covered = cells.reduce((s, c) => s + c.w * c.h, 0);
  assert.ok(Math.abs(covered - area) <= EPS * area, 'the cells fill the rectangle');
  return cells;
}

describe('squarify', () => {
  test('matches the hand-computed rows for [2, 1, 1] in a 4 x 2 rectangle', () => {
    const cells = squarify([{ id: 'b', value: 1 }, { id: 'a', value: 2 }, { id: 'c', value: 1 }], { x: 0, y: 0, w: 4, h: 2 });
    assert.deepEqual(
      cells.map((c) => [c.item.id, rect(c)]),
      [
        ['a', { x: 0, y: 0, w: 2, h: 2 }],
        ['b', { x: 2, y: 0, w: 2, h: 1 }],
        ['c', { x: 2, y: 1, w: 2, h: 1 }],
      ],
    );
  });

  test('matches the hand-computed rows for [6, 6, 4, 3, 2, 2, 1] in a 6 x 4 rectangle', () => {
    const cells = squarify([6, 6, 4, 3, 2, 2, 1].map((value, id) => ({ id, value })), { x: 0, y: 0, w: 6, h: 4 });
    const want = [
      [0, 0, 3, 2],
      [0, 2, 3, 2],
      [3, 0, 12 / 7, 7 / 3],
      [3 + 12 / 7, 0, 9 / 7, 7 / 3],
      [3, 7 / 3, 2.4, 5 / 6],
      [3, 7 / 3 + 5 / 6, 2.4, 5 / 6],
      [5.4, 7 / 3, 0.6, 5 / 3],
    ];
    assert.deepEqual(cells.map((c) => c.item.id), [0, 1, 2, 3, 4, 5, 6]);
    cells.forEach((c, i) => {
      [c.x, c.y, c.w, c.h].forEach((got, k) => assert.ok(close(got, want[i][k]), `cell ${i} coord ${k}: ${got} vs ${want[i][k]}`));
    });
    assertLayout([6, 6, 4, 3, 2, 2, 1], { x: 0, y: 0, w: 6, h: 4 });
  });

  test('drops zero, negative and non-finite values', () => {
    const cells = assertLayout([5, 0, 3, -1, 0], { x: 10, y: 20, w: 300, h: 100 });
    assert.deepEqual(cells.map((c) => c.item.id).sort(), [0, 2]);
    assert.deepEqual(squarify([{ value: Number.NaN }, { value: 0 }], { x: 0, y: 0, w: 10, h: 10 }), []);
    assert.deepEqual(squarify([], { x: 0, y: 0, w: 10, h: 10 }), []);
  });

  test('a single value fills the rectangle', () => {
    const [cell] = assertLayout([7], { x: 1, y: 2, w: 30, h: 40 });
    assert.deepEqual(rect(cell), { x: 1, y: 2, w: 30, h: 40 });
  });

  test('random inputs keep proportional, disjoint cells that fill wide and tall rectangles', () => {
    const rand = seeded(1347);
    for (let round = 0; round < 50; round++) {
      const n = 1 + Math.floor(rand() * 30);
      const values = Array.from({ length: n }, () => (rand() < 0.15 ? 0 : 1 + Math.floor(rand() * 500)));
      if (!values.some((v) => v > 0)) values[0] = 1;
      const box = round % 2 ? { x: 0, y: 0, w: 960, h: 400 } : { x: 5, y: 5, w: 200, h: 700 };
      assertLayout(values, box);
    }
  });
});
