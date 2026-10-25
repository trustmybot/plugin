/**
 * Unproven programs fail closed (GH 1739): every row of
 * tests/fixtures/cmd-analysis/unproven-probes.jsonl and of
 * unproven-review-probes.jsonl (the bypasses review found) runs through
 * writePaths with cwd and root /w. A fail_closed row prints an `UNRESOLVED:` line, its
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
const FIXTURES = join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis');
const PROBE_FILES = ['unproven-probes.jsonl', 'unproven-review-probes.jsonl'];
const probes = PROBE_FILES.flatMap((f) => readFileSync(join(FIXTURES, f), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l)));
const outside = (l) => l.startsWith('/') && l !== '/w' && !l.startsWith('/w/');
describe('unproven programs fail closed (GH 1739)', () => {
    it('has every expectation kind', () => {
        assert.deepEqual([...new Set(probes.map((p) => p.expect))].sort(), ['empty', 'fail_closed', 'resolves']);
    });
    for (const [i, p] of probes.entries()) {
        it(`${p.expect} #${i + 1} (${p.src}): ${JSON.stringify(p.cmd).slice(0, 100)}`, async () => {
            const out = await writePaths(p.cmd, { cwd: '/w', root: '/w', env: { HOME: '/h' } });
            if (p.expect === 'empty')
                assert.deepEqual(out, []);
            else if (p.expect === 'resolves')
                assert.deepEqual(out, p.paths);
            else
                assert.ok(out.some((l) => l.startsWith('UNRESOLVED:') || l === p.danger || outside(l)), `not fail closed: ${JSON.stringify(out)}`);
        });
    }
});
//# sourceMappingURL=cmd-analysis-unproven.test.js.map