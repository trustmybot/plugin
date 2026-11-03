/**
 * The write-path analyzer's work cap (GH 2090): a command is judged only if
 * its analysis finishes inside the bound, and past it writePaths prints the
 * cap line alone. Node's stack limit decides where a deep shape overflows, so
 * each shape is judged by outcome, not by depth. The gates' side of the cap is
 * in hooks-no-source-edit-from-main.test.ts and hooks-swe-boundary.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYSIS_WORK_CAP, CAP_REASON, isCapLine, writePaths } from '../hooks/cmd-analysis/index.js';
import { UNJUDGED_PHRASE } from '../hooks/containment-guard.js';
import { unjudgedDeny } from '../hooks/router/records.js';

const CAP_LINE = `UNRESOLVED:$(computed):analysis cap reached (${ANALYSIS_WORK_CAP} work units): split this command into smaller ones`;

const each = (n: number, line: (i: number) => string): string => Array.from({ length: n }, (_, i) => line(i)).join(' ');
const nestedSubstitutions = (n: number): string => `echo ${'$('.repeat(n)}x${')'.repeat(n)}`;
const nestedWhiles = (n: number): string => `${'while :; do '.repeat(n)}echo > f; ${'done; '.repeat(n)}`;
const drifts = (n: number): string => each(n, (i) => `cd d${i} && echo > f${i};`);
const loopAssigns = (n: number): string => `while :; do ${each(n, (i) => `v${i}=$v${i}+1;`)} done`;
/** A python program whose every process call runs its own shell command, each under the cap alone. */
const shellCalls = (calls: number): string => {
  const body = each(300, () => 'cd d && echo > f;');
  return `python3 -c "import os\n${Array.from({ length: calls }, () => `os.system('${body}')`).join('\n')}"`;
};

const run = (command: string): Promise<string[]> => writePaths(command, { cwd: '/w', root: '/w' });

describe('past the work cap writePaths prints only the cap line (GH 2090)', () => {
  const shapes: Record<string, string> = {
    '5000 nested $(': nestedSubstitutions(5000),
    '5000 nested while': nestedWhiles(5000),
    '20000 cd dN && echo > fN': drifts(20000),
    '2000 nested $(': nestedSubstitutions(2000),
    '10000 assignments in one while': loopAssigns(10000),
    'a 2 MB echo of words': `echo ${'word '.repeat(400_000)}`,
  };
  for (const [name, command] of Object.entries(shapes)) {
    it(name, async () => {
      assert.deepEqual(await run(command), [CAP_LINE]);
    });
  }

  it('shares one count with the commands a program runs', async () => {
    assert.ok(!(await run(shellCalls(1))).includes(CAP_LINE));
    assert.deepEqual(await run(shellCalls(5)), [CAP_LINE]);
  });

  it('leaves the parser usable after a stack overflow', async () => {
    assert.deepEqual(await run(nestedSubstitutions(5000)), [CAP_LINE]);
    assert.deepEqual(await run('echo > /w/f'), ['/w/f']);
  });

  it('isCapLine recognises only that line', () => {
    assert.equal(isCapLine(CAP_LINE), true);
    assert.equal(isCapLine('UNRESOLVED:$(computed):python3'), false);
    assert.equal(isCapLine('/w/f'), false);
  });
});

describe('under the work cap nothing changes (GH 2090)', () => {
  it('5-deep while … cd … keeps its PWD line', async () => {
    const command = `${'while :; do cd a; '.repeat(5)}echo > g; ${'done; '.repeat(5)}`;
    assert.deepEqual(await run(command), ['UNRESOLVED:PWD:$PWD/g']);
  });

  it('a 300 KB heredoc write keeps its path', async () => {
    assert.deepEqual(await run(`cat > /w/out <<EOF\n${'x'.repeat(300_000)}\nEOF`), ['/w/out']);
  });

  it('2000 cd d && echo > f written with absolute paths keep theirs', async () => {
    assert.deepEqual(await run(each(2000, () => 'cd /w/d && echo > /w/f;')), Array<string>(2000).fill('/w/f'));
  });
});

describe('the cap reason (GH 2090)', () => {
  it('reads as a deny that judged no path, so no bypass record is kept', () => {
    assert.ok(CAP_REASON.includes(UNJUDGED_PHRASE));
    assert.equal(unjudgedDeny(CAP_REASON), true);
  });
});
