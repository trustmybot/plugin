/**
 * Unproven programs fail closed (GH 1739): every row of
 * tests/fixtures/cmd-analysis/unproven-probes.jsonl runs through writePaths
 * with cwd and root /w. A fail_closed row prints an `UNRESOLVED:` line, its
 * danger path, or a path outside /w; an empty row prints nothing; a resolves
 * row prints exactly its paths.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePaths } from '../hooks/cmd-analysis/index.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PROBES = join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis/unproven-probes.jsonl');

interface Probe {
  src: string;
  cmd: string;
  expect: 'fail_closed' | 'empty' | 'resolves';
  danger?: string;
  paths?: string[];
}

const probes: Probe[] = readFileSync(PROBES, 'utf8')
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => JSON.parse(l) as Probe);

const outside = (l: string): boolean => l.startsWith('/') && l !== '/w' && !l.startsWith('/w/');

describe('unproven programs fail closed (GH 1739)', () => {
  it('has every expectation kind', () => {
    assert.deepEqual([...new Set(probes.map((p) => p.expect))].sort(), ['empty', 'fail_closed', 'resolves']);
  });

  for (const [i, p] of probes.entries()) {
    it(`${p.expect} #${i + 1} (${p.src}): ${JSON.stringify(p.cmd).slice(0, 100)}`, async () => {
      const out = await writePaths(p.cmd, { cwd: '/w', root: '/w', env: { HOME: '/h' } });
      if (p.expect === 'empty') assert.deepEqual(out, []);
      else if (p.expect === 'resolves') assert.deepEqual(out, p.paths);
      else
        assert.ok(
          out.some((l) => l.startsWith('UNRESOLVED:') || l === p.danger || outside(l)),
          `not fail closed: ${JSON.stringify(out)}`,
        );
    });
  }
});
