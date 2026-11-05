// Build reproducibility (GH 2353): esbuild names chunks by a hash over the
// module paths it resolves, and a worktree's node_modules is a symlink to the
// main checkout's (GH 1541), so every esbuild call keeps symlinked paths. The
// built dist/web then holds exactly the chunks app.js reaches: none missing,
// none left over from another build layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const DASH = new URL('..', import.meta.url).pathname;
const WEB = join(DASH, 'dist/web');
const IMPORT = /(?:from|import)\s*\(?\s*"(\.\/[^"]+\.js)"/g;

test('every esbuild call in package.json scripts preserves symlinks', () => {
  const { scripts } = JSON.parse(readFileSync(join(DASH, 'package.json'), 'utf8'));
  const calls = Object.values(scripts).flatMap((s) => s.split('&&').filter((c) => /^\s*esbuild\s/.test(c)));
  assert.ok(calls.length >= 2, `expected the server and web esbuild calls, found ${calls.length}`);
  for (const call of calls) assert.match(call, /\s--preserve-symlinks(\s|$)/, call.trim());
});

test('dist/web/chunks holds exactly the chunks app.js reaches', () => {
  const reached = new Set();
  const queue = ['app.js'];
  while (queue.length) {
    const rel = queue.shift();
    const file = join(WEB, rel);
    assert.ok(existsSync(file), `${rel} is imported but missing from dist/web`);
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const target = posix.join(posix.dirname(rel), spec);
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  const onDisk = readdirSync(join(WEB, 'chunks'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `chunks/${f}`)
    .sort();
  assert.deepEqual(onDisk, [...reached].filter((r) => r.startsWith('chunks/')).sort());
});
