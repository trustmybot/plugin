/**
 * The write-path analyzer loads tree-sitter-bash on its first non-blank
 * command and never again (GH 1692), and loadParsers() still compiles all
 * four grammars. Each check runs in a fresh node process so its counters
 * start at 0.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const DIST = fileURLToPath(new URL('..', import.meta.url));
const ANALYZER = new URL('hooks/cmd-analysis/index.js', `file://${DIST}`).href;
const LOADER = new URL('parsing/loader.js', `file://${DIST}`).href;
function run(script) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}
describe('bash parser laziness (GH 1692)', () => {
    it('loads nothing on import or a blank command, then once over 50 commands', () => {
        const counts = run(`
      const { writePaths, bashParserLoads } = await import(${JSON.stringify(ANALYZER)});
      const counts = [bashParserLoads()];
      await writePaths('   ');
      counts.push(bashParserLoads());
      for (let i = 0; i < 50; i++) await writePaths('echo ' + i + ' > out' + i + '.txt', { cwd: '/w' });
      counts.push(bashParserLoads());
      console.log(JSON.stringify(counts));
    `);
        assert.deepEqual(counts, [0, 0, 1]);
    });
    it('shares the bash grammar with loadParsers, which still loads all four', () => {
        const out = run(`
      const { writePaths } = await import(${JSON.stringify(ANALYZER)});
      const { loadParsers, loadParser, parserLoadCount } = await import(${JSON.stringify(LOADER)});
      const first = await writePaths('touch a', { cwd: '/w' });
      const parsers = await loadParsers();
      console.log(JSON.stringify({
        first,
        grammars: Object.keys(parsers).sort(),
        loads: parserLoadCount(),
        shared: parsers.bash === (await loadParser('bash')),
      }));
    `);
        assert.deepEqual(out, {
            first: ['/w/a'],
            grammars: ['bash', 'javascript', 'tsx', 'typescript'],
            loads: 1,
            shared: true,
        });
    });
});
//# sourceMappingURL=cmd-analysis-lazy.test.js.map