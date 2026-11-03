/**
 * A loop body's relative cd that keeps drifting (GH 1977, finding F210-1):
 * the dirs a frame's back-edge adds stay bounded, so sequential and nested
 * drifting loops fail closed with UNRESOLVED lines in bounded output instead
 * of a dir set that grows with every loop. tests/l3-integration/hooks/
 * cmd-analysis.test.sh asserts the same on cmd-analysis.sh.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { writePaths } from '../hooks/cmd-analysis/index.js';
import { bashParser } from '../hooks/cmd-analysis/parser.js';
import { encode } from '../hooks/cmd-analysis/encode.js';
import { ALT, statementsEnc } from '../hooks/cmd-analysis/statements.js';
const MAX_DIRS = 8;
const SEQUENTIAL = [1, 2, 3, 4].map((n) => `while :; do echo > f${n}; cd d${n}; done; `).join('') + 'echo > g';
const NESTED = 'while :; do cd n1; while :; do cd n2; echo > g; done; done';
const NESTED3 = 'while :; do cd n1; while :; do cd n2; while :; do cd n3; echo > g; done; done; done';
const absLoops = (n) => Array.from({ length: n }, (_, i) => `while false; do cd /a${i + 1}; done; `).join('') + 'echo > f';
const run = (cmd) => writePaths(cmd, { cwd: '/w', root: '/w' });
describe('a drifting loop-body cd stays bounded and fails closed (GH 1977)', () => {
    let parser;
    before(async () => {
        parser = await bashParser();
    });
    it('4 sequential drifting loops print one UNRESOLVED line per write', async () => {
        assert.deepEqual(await run(SEQUENTIAL), ['f1', 'f2', 'f3', 'f4', 'g'].map((f) => `UNRESOLVED:PWD:$PWD/${f}`));
    });
    it('2 and 3 nested drifting loops print one UNRESOLVED line', async () => {
        assert.deepEqual(await run(NESTED), ['UNRESOLVED:PWD:$PWD/g']);
        assert.deepEqual(await run(NESTED3), ['UNRESOLVED:PWD:$PWD/g']);
    });
    it(`gives no statement more than ${MAX_DIRS} dirs`, () => {
        for (const cmd of [SEQUENTIAL, NESTED, NESTED3, absLoops(7), absLoops(8), absLoops(30)]) {
            const encoded = encode(parser, cmd);
            assert.ok(encoded.ok, cmd);
            for (const r of statementsEnc(encoded.text, '@', '/home/u', true)) {
                assert.ok(r.dir.split(ALT).length <= MAX_DIRS, `${JSON.stringify(cmd)}: ${JSON.stringify(r)}`);
            }
        }
    });
    it(`resolves ${MAX_DIRS} dirs exactly and collapses a ${MAX_DIRS + 1}th to UNRESOLVED`, async () => {
        assert.deepEqual(await run(absLoops(7)), ['/w/f', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `/a${n}/f`)]);
        assert.deepEqual(await run(absLoops(8)), ['UNRESOLVED:PWD:$PWD/f', '/a8/f']);
    });
});
//# sourceMappingURL=cmd-analysis-loop-cd.test.js.map