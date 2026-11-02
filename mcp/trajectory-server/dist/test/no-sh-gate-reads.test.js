import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const HOOKS = join(SRC, 'hooks');
const TESTS = join(SRC, 'test');
describe('TS suites read no scripts/hooks/<gate>.sh (GH 1692)', () => {
    it('no suite outside the golden-backed parity and diff suites names a gate .sh, in any path spelling', () => {
        const gates = readdirSync(HOOKS)
            .filter((f) => f.endsWith('.ts'))
            .map((f) => f.slice(0, -3));
        const patterns = gates.map((g) => new RegExp(`hooks(/|['"\`]\\s*,\\s*['"\`])${g}\\.sh\\b`));
        const hits = [];
        for (const f of readdirSync(TESTS)) {
            if (!f.endsWith('.ts') || /(parity|diff)\.suite\.ts$/.test(f) || f === 'golden.ts')
                continue;
            readFileSync(join(TESTS, f), 'utf8')
                .split('\n')
                .forEach((line, i) => {
                if (/^\s*(\*|\/\/|\/\*)/.test(line))
                    return;
                if (patterns.some((re) => re.test(line)))
                    hits.push(`${f}:${i + 1}: ${line.trim()}`);
            });
        }
        assert.deepEqual(hits, []);
    });
});
//# sourceMappingURL=no-sh-gate-reads.test.js.map