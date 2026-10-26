/**
 * Same-command VAR=<literal> tracking in statementsEnc against
 * _tmb_cmd_statements_enc (GH 1911): every row of
 * tests/fixtures/cmd-analysis/statement-vars.jsonl, which
 * tests/l3-integration/hooks/cmd-analysis.test.sh asserts on the bash side,
 * gives the same dir token per statement after encode(). A `parse: false` row
 * is one tree-sitter-bash rejects, so the TS refuses it outright; a `ts_dirs`
 * row records where the TS splits statements differently.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bashParser } from '../hooks/cmd-analysis/parser.js';
import { encode } from '../hooks/cmd-analysis/encode.js';
import { statementsEnc } from '../hooks/cmd-analysis/statements.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURE = join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis/statement-vars.jsonl');
const HOME = '/home/u';
const rows = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));
describe('statementsEnc keeps VAR=<literal> past data (GH 1911)', () => {
    let parser;
    before(async () => {
        parser = await bashParser();
    });
    it('the fixture covers resolving and unresolved rows', () => {
        assert.ok(rows.filter((r) => r.dirs.at(-1) === '-').length >= 60);
        assert.ok(rows.filter((r) => r.dirs.at(-1)?.startsWith('/')).length >= 14);
    });
    for (const row of rows) {
        it(`${row.why}: ${JSON.stringify(row.cmd)}`, () => {
            const encoded = encode(parser, row.cmd);
            if (row.parse === false) {
                assert.equal(encoded.ok, false);
                return;
            }
            assert.ok(encoded.ok);
            const dirs = statementsEnc(encoded.text, '@', HOME, false).map((r) => r.dir);
            assert.deepEqual(dirs, row.ts_dirs ?? row.dirs);
        });
    }
    it('the heredoc verdict marks never reach a statement', () => {
        const encoded = encode(parser, "W=/w; cat <<A\n$((W=0))\nA\ncat <<'B'\nx\nB\n");
        assert.ok(encoded.ok);
        for (const assign of [false, true]) {
            for (const r of statementsEnc(encoded.text, '@', HOME, assign))
                assert.doesNotMatch(r.stmt + r.dir, /[\x1a\x1e]/);
        }
    });
});
//# sourceMappingURL=cmd-analysis-statements.test.js.map