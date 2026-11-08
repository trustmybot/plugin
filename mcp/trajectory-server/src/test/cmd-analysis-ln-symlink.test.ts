/**
 * A symbolic ln writes only the link it creates (GH 1789): as the last
 * statement of a command, its write paths are the link paths, the last
 * operand, the -t / --target-directory value or ./<basename TARGET> for a
 * single operand, with no TARGET-derived path. TARGET is still judged where a
 * later write could go through the link: a statement after the ln, something
 * that may run after the command (a background job, a pipeline stage, a
 * trap, a process substitution, a coprocess), a nested shell body, a hard
 * link, or an option word after an
 * operand, which BSD ln reads as an operand.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writePaths } from '../hooks/cmd-analysis/index.js';

const run = (command: string): Promise<string[]> => writePaths(command, { cwd: '/w', env: { HOME: '/h', PWD: '/w' } });

const LINK_ONLY: ReadonlyArray<readonly [string, string[]]> = [
  ['ln -s /abs/T LINK', ['/w/LINK']],
  ['ln -sf /abs/T LINK', ['/w/LINK']],
  ['ln -sfn /abs/T LINK', ['/w/LINK']],
  ['ln -s ../rel LINK', ['/w/LINK']],
  ['ln -s /abs/T', ['/w/T']],
  ['ln -s /abs/dir/', ['/w/dir']],
  ['ln -s -t DIR /a /b', ['/w/DIR']],
  ['ln --symbolic --target-directory=DIR /a', ['/w/DIR']],
  ['ln --sym --target DIR /a', ['/w/DIR']],
  ['ln -s /a /b DIR', ['/w/DIR']],
  ['ln -s -- /a -l', ['/w/-l']],
  ['cd sub && ln -s /o/x link', ['/w/sub/link']],
  ['ln -s /o link >/dev/null 2>&1', ['/dev/null', '/w/link']],
  ['true || ln -s /o link', ['/w/link']],
  ['ln -s /o link >| out', ['/w/out', '/w/link']],
];

const TARGET_KEPT: ReadonlyArray<readonly [string, string]> = [
  ['ln -s /o link && echo x > link/f', 'a statement after it'],
  ['ln -s /o link; touch link/f', 'a statement after it'],
  ['ln -s /o link | cat', 'a pipeline after it'],
  ['for i in 1; do ln -s /o link; done', 'a loop around it'],
  ['(sleep 1; echo x > link/f) & ln -s /o link', 'a background job'],
  ['(sleep 1; echo x > link/f) | ln -s /o link', 'a subshell pipeline stage before it'],
  ['{ sleep 1; echo x > link/f; } | ln -s /o link', 'a group pipeline stage before it'],
  ['while sleep 1; do echo x > link/f; done | ln -s /o link', 'a loop pipeline stage before it'],
  ['(sleep 1; echo x > link/f) |& ln -s /o link', 'a |& pipeline stage before it'],
  ['sleep 1 | ln -s /o link', 'a command pipeline stage before it'],
  ['coproc { sleep 1; echo x > link/f; }; ln -s /o link', 'a coprocess'],
  ['sleep 1 & wait; ln -s /o link', 'a background job and wait'],
  ['tmux new -d "sleep 1; echo x > link/f"; ln -s /o link', 'a detached tmux session'],
  ['at now <<< "echo x > link/f"; ln -s /o link', 'an at job'],
  ["trap 'echo x > link/f' EXIT; ln -s /o link", 'an EXIT trap'],
  ['cat <(sleep 1) ; ln -s /o link', 'a process substitution'],
  ["bash -c 'ln -s /o link'", 'a bash -c body'],
  ['ln /o link', 'a hard link'],
  ['ln /o link -s', 'an option word after an operand'],
];

describe('ln -s is judged by the link it creates (GH 1789)', () => {
  for (const [cmd, paths] of LINK_ONLY) {
    it(cmd, async () => assert.deepEqual(await run(cmd), paths));
  }

  for (const [cmd, why] of TARGET_KEPT) {
    it(`keeps TARGET /o with ${why}: ${cmd}`, async () => {
      const out = await run(cmd);
      assert.ok(out.includes('/o'), JSON.stringify(out));
      assert.ok(out.includes('/w/link'), JSON.stringify(out));
    });
  }

  it('reads -t and -S values, in a short-option cluster or the next word', async () => {
    assert.deepEqual(await run('ln -st /out /o'), ['/out']);
    assert.deepEqual(await run('ln -sS .bak /o /out/l'), ['/out/l']);
    const late = await run('ln -s /o /out/l -S suf');
    assert.ok(late.includes('/out/l') && late.includes('/o'), JSON.stringify(late));
  });

  it('after --, a word with a dash is an operand', async () => {
    assert.deepEqual(await run('ln -s -- /o -x/l'), ['/w/-x/l']);
    const late = await run('ln -s /o -- -x/../../out/l');
    assert.ok(late.includes('/out/l') && late.includes('/o'), JSON.stringify(late));
  });
});
