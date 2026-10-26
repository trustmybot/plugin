/**
 * Splits a slow test file's per-row work across shard files (GH 1947):
 * `<name>.shard-<k>of<n>.test.ts` runs `shardOf(items, k, n)`, the items whose
 * index i has i % n === k - 1. The n shards of a list are disjoint and their
 * union is the list; node --test runs each shard file in its own process.
 */
export function shardOf<T>(items: readonly T[], k: number, n: number): T[] {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`shard count ${n} is not a positive integer`);
  if (!Number.isInteger(k) || k < 1 || k > n) throw new RangeError(`shard ${k} is outside 1..${n}`);
  return items.filter((_, i) => i % n === k - 1);
}
