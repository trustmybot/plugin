/**
 * A `$` bash keeps literal is judged as written (GH 2443): inside `'…'` or
 * `$'…'`, or after a backslash, unquoted or in `"…"`, the write-path analyzer
 * resolves the path text against cwd instead of expanding it. An unescaped `$`
 * in `"…"` and an unquoted `$` still expand. Without `marks` the encoder output
 * carries no DOLLAR byte, so stripLiterals and the other analyses are unchanged.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Parser } from 'web-tree-sitter';
import { writePaths } from '../hooks/cmd-analysis/index.js';
import { DOLLAR, decode, encode } from '../hooks/cmd-analysis/encode.js';
import { bashParser } from '../hooks/cmd-analysis/parser.js';

const run = (command: string): Promise<string[]> =>
  writePaths(command, { cwd: '/r/wt', root: '/r/wt', env: { HOME: '/h', PWD: '/r/wt' } });

const LITERAL: ReadonlyArray<readonly [string, string]> = [
  ["touch '$HOME/x'", '/r/wt/$HOME/x'],
  ["touch '../$PWD'", '/r/$PWD'],
  ["touch ..'/$PWD'/x", '/r/$PWD/x'],
  ['touch ../\\$PWD', '/r/$PWD'],
  ["touch '$HOME'/x", '/r/wt/$HOME/x'],
  ['touch "\\$HOME"/x', '/r/wt/$HOME/x'],
  ["touch $'$HOME'", '/r/wt/$HOME'],
  ["touch '${FOO-/d}'", '/r/wt/${FOO-/d}'],
  ['touch \\${FOO=/d}', '/r/wt/${FOO=/d}'],
];

const EXPANDED: ReadonlyArray<readonly [string, string]> = [
  ['touch "$HOME/x"', '/h/x'],
  ['touch $HOME/x', '/h/x'],
  ['touch "${FOO-/d}"', '/d'],
];

describe('a literal $ in a write path is judged as written (GH 2443)', () => {
  for (const [cmd, path] of LITERAL) {
    it(cmd, async () => assert.deepEqual(await run(cmd), [path]));
  }
});

describe('an unescaped $ in "…" and an unquoted $ still expand (GH 2443)', () => {
  for (const [cmd, path] of EXPANDED) {
    it(cmd, async () => assert.deepEqual(await run(cmd), [path]));
  }

  it("a quoted '${FOO=/d}' assigns nothing, so a later \"$FOO\" is judged as it is alone", async () => {
    const [first, ...rest] = await run(`touch '\${FOO=/d}' && touch "$FOO"`);
    assert.equal(first, '/r/wt/${FOO=/d}');
    assert.deepEqual(rest, await run('touch "$FOO"'));
  });
});

describe('a bare $ starts no expansion, so it is literal and resolves against the cwd (GH 2451)', () => {
  it('touch a$ resolves against the cwd', async () => {
    assert.deepEqual(await run('touch a$'), ['/r/wt/a$']);
  });

  it('cd /etc && touch a$ resolves against the new cwd', async () => {
    assert.deepEqual(await run('cd /etc && touch a$'), ['/etc/a$']);
  });

  it("a literal $ inside \"…\" resolves too", async () => {
    assert.deepEqual(await run("touch \"$'$HOME'\""), ["/r/wt/$'/h'"]);
  });

  it('$$ is the shell pid, so it stays UNRESOLVED and is not read as two literal $', async () => {
    assert.deepEqual(await run('touch a$$'), ['UNRESOLVED:$$:/r/wt/a$$']);
    assert.deepEqual(await run('touch "a$$"'), ['UNRESOLVED:$$:/r/wt/a$$']);
  });

  it('$$$ is a pid and a literal $, so it stays UNRESOLVED', async () => {
    assert.deepEqual(await run('touch a$$$'), ['UNRESOLVED:$$:/r/wt/a$$$']);
  });
});

describe('without marks the encoder carries no DOLLAR byte (GH 2443)', () => {
  let parser: Parser;
  before(async () => {
    parser = await bashParser();
  });

  for (const [cmd] of [...LITERAL, ...EXPANDED]) {
    it(cmd, () => {
      const plain = encode(parser, cmd);
      const marked = encode(parser, cmd, undefined, true);
      assert.ok(plain.ok && marked.ok);
      assert.ok(!plain.text.includes(DOLLAR));
      assert.equal(decode(marked.text), decode(plain.text));
    });
  }
});
