import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shardOf } from './shard.js';

describe('shardOf (GH 1947)', () => {
  for (const length of [0, 1, 2, 5, 7, 12, 100]) {
    for (const n of [1, 2, 3, 4, 8, 150]) {
      it(`splits ${length} items into ${n} disjoint shards whose union is the list`, () => {
        const items = Array.from({ length }, (_, i) => `row-${i}`);
        const shards = Array.from({ length: n }, (_, i) => shardOf(items, i + 1, n));
        const seen = shards.flat();
        assert.equal(seen.length, items.length, 'each item lands in exactly one shard');
        assert.equal(new Set(seen).size, items.length);
        assert.deepEqual([...seen].sort(), [...items].sort());
        for (const shard of shards) assert.deepEqual(shard, items.filter((x) => shard.includes(x)), 'a shard keeps list order');
        if (n > length) assert.ok(shards.slice(length).every((s) => s.length === 0));
      });
    }
  }

  it('gives the same shard on every call', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(shardOf(items, 2, 3), ['b', 'e']);
    assert.deepEqual(shardOf(items, 2, 3), shardOf([...items], 2, 3));
  });

  for (const [k, n] of [
    [0, 3],
    [4, 3],
    [-1, 2],
    [1.5, 2],
    [1, 0],
    [1, 2.5],
    [Number.NaN, 2],
  ]) {
    it(`throws for shard ${k} of ${n}`, () => {
      assert.throws(() => shardOf([1, 2, 3], k!, n!), RangeError);
    });
  }
});
