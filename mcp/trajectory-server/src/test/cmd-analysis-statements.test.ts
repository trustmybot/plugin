/**
 * Same-command VAR=<literal> tracking in statementsEnc against
 * _tmb_cmd_statements_enc (GH 1911): every row of
 * tests/fixtures/cmd-analysis/statement-vars.jsonl, which
 * cmd-analysis-l3-helpers.test.ts asserts on the bash side,
 * gives the same dir token per statement after encode(). A `parse: false` row
 * is one tree-sitter-bash rejects, so the TS refuses it outright; a `ts_dirs`
 * row records where the TS splits statements differently, or keeps a literal
 * past a literal redirect the bash lib does not (GH 2404).
 * cmdStatements keeps `git -C $W`'s literal across such a redirect in a
 * checkout with a linked worktree. A backslash-newline joins the words bash
 * joins, the words tree-sitter-bash splits there held as one (GH 2646,
 * GH 1978), and a `$'…'` word reads as bash decodes it (GH 2640).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Parser } from 'web-tree-sitter';
import { bashParser } from '../hooks/cmd-analysis/parser.js';
import { CONTROL_SHOWN, NO_CHARGE, QM, ansiCChars, decode, encode, utf8Run } from '../hooks/cmd-analysis/encode.js';
import { cmdStatements, gitSubcommand } from '../hooks/cmd-analysis/git.js';
import { statementsEnc } from '../hooks/cmd-analysis/statements.js';
import { GIT_ENV } from './hook-sandbox.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURE = join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis/statement-vars.jsonl');
const HOME = '/home/u';

interface Row {
  cmd: string;
  dirs: string[];
  why: string;
  parse?: boolean;
  ts_dirs?: string[];
}

const rows: Row[] = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => JSON.parse(l) as Row);

describe('statementsEnc keeps VAR=<literal> past data (GH 1911)', () => {
  let parser: Parser;
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
      for (const r of statementsEnc(encoded.text, '@', HOME, assign)) assert.doesNotMatch(r.stmt + r.dir, /[\x1a\x1e]/);
    }
  });
});

describe('encode joins line continuations and decodes $\'…\' as bash does (GH 2646, GH 2640, GH 1978)', () => {
  let parser: Parser;
  before(async () => {
    parser = await bashParser();
  });
  const stmts = (cmd: string): string[] => {
    const encoded = encode(parser, cmd);
    assert.ok(encoded.ok);
    return statementsEnc(encoded.text, '@', HOME, false).map((r) => decode(r.stmt).replaceAll(QM, ''));
  };
  const held = (cmd: string): string[] => {
    const encoded = encode(parser, cmd);
    assert.ok(encoded.ok);
    return [...encoded.held];
  };
  const spliced = (cmd: string): string[] => {
    const encoded = encode(parser, cmd);
    assert.ok(encoded.ok);
    return [...encoded.spliced];
  };

  for (const [cmd, out] of [
    ['git \\\npush origin dev', ['git push origin dev']],
    ['git pu\\\nsh origin dev', ['git push origin dev']],
    ['git pu\\\n\\\nsh origin dev', ['git push origin dev']],
    ['git "pu\\\nsh" origin dev', ['git push origin dev']],
    ['echo a\\\\\nb', ['echo a\\', 'b']],
    ["echo 'a\\\nb'", ['echo a\\\nb']],
    ["echo $'a\\\nb'", ['echo a\\\nb']],
    ['i\\\nf true; then echo y; fi', ['true', 'echo y']],
    ["git $'\\x70ush' origin dev", ['git push origin dev']],
    ["git $'\\160u\\163h'", ['git push']],
    ["git $'\\u0070\\U00000075sh'", ['git push']],
    ["echo $'a\\tb\\nc\\\\d\\'e\\\"f\\?g\\qh'", ["echo a\tb\nc\\d'e\"f?g\\qh"]],
  ] as const)
    it(`${JSON.stringify(cmd)} reads as ${JSON.stringify(out)}`, () => {
      assert.deepEqual(stmts(cmd), out);
    });

  it('the reason text is the command as written', async () => {
    const res = await cmdStatements('git pu\\\nsh origin dev', '/nonexistent', { ...process.env, ...GIT_ENV });
    assert.ok(res.ok);
    assert.deepEqual(
      res.statements.map((s) => s.src),
      ['git pu\\\nsh origin dev'],
    );
  });

  for (const [body, chars] of [
    ['\\a\\b\\e\\E\\f\\n\\r\\t\\v', ['\x07', '\b', '\x1b', '\x1b', '\f', '\n', '\r', '\t', '\v']],
    ['\\101\\0101\\7', ['A', '\b', '1', '\x07']],
    ['\\x41\\x4142\\xg', ['A', 'A', '4', '2', null, 'g']],
    ['\\u00e9\\U0001F600\\u', ['é', '\u{1F600}', null]],
    ['\\x7f\\177\\x80\\xf0\\200\\377', ['\x7f', '\x7f', null, null, null, null]],
    ['\\cA\\ca\\c?\\c\\\\', ['\x01', '\x01', null, null, null]],
    ['\\0\\x00\\u0000\\c@\\777\\ud800\\U00110000', [null, null, null, null, null, null, null]],
    ['\\q\\8\\', ['\\', 'q', '\\', '8', null]],
  ] as const)
    it(`ansiCChars(${JSON.stringify(body)})`, () => {
      assert.deepEqual(ansiCChars(body), chars);
    });

  for (const cmd of ["git $'pu\\csh'", "git $'pu\\x00sh'", "echo $'\\a\\b'"])
    it(`${cmd}: an unknown escape or control char reads as computed text`, () => {
      const encoded = encode(parser, cmd);
      assert.ok(encoded.ok);
      assert.match(encoded.text, /\$\(\)/);
      assert.doesNotMatch(encoded.text.replaceAll(QM, ''), /[\x00-\x08\x0e-\x1f]/);
    });

  it('with shownControls a control char reads as CONTROL_SHOWN, an undecodable escape still as computed text', () => {
    const shown = encode(parser, "git commit -m $'\\x01 feat\\x80'", NO_CHARGE, false, true);
    assert.ok(shown.ok);
    assert.equal(decode(shown.text).replaceAll(QM, ''), `git commit -m ${CONTROL_SHOWN} feat$()`);
  });

  for (const [body, before, utf8] of [
    ['\\xe2\\x9c\\xa8 x', [null, null, null, ' ', 'x'], ['✨', ' ', 'x']],
    ['\\342\\234\\250', [null, null, null], ['✨']],
    ['\\x41\\342\\x9c\\250B', ['A', null, null, null, 'B'], ['A', '✨', 'B']],
    ['\\xef\\xbb\\xbf', [null, null, null], ['﻿']],
    ['\\xc3\\xa9\\x01\\x00', [null, null, '\x01', null], ['é', '\x01', null]],
    ['\\xc3\\xa9\\u0041', [null, null, 'A'], ['é', 'A']],
    ['\\xff x', [null, ' ', 'x'], [null, ' ', 'x']],
    ['\\xe2\\x9c x', [null, null, ' ', 'x'], [null, null, ' ', 'x']],
    ['\\xe2\\x9c\\u00a8', [null, null, '¨'], [null, null, '¨']],
    ['\\xe2a\\x9c\\xa8', [null, 'a', null, null], [null, 'a', null, null]],
    ['\\xed\\xa0\\x80', [null, null, null], [null, null, null]],
    ['\\xc3\\777', [null, null], [null, null]],
  ] as const) {
    it(`ansiCChars(${JSON.stringify(body)}) keeps each byte past 0x7F null without utf8 (GH 2765)`, () => {
      assert.deepEqual(ansiCChars(body), before);
    });
    it(`ansiCChars(${JSON.stringify(body)}, utf8) decodes only a valid UTF-8 run of byte escapes (GH 2765)`, () => {
      assert.deepEqual(ansiCChars(body, true), utf8);
    });
  }

  for (const escape of ['\\x41', '\\101'])
    it(`utf8Run consumes 10000 ${escape} escapes in one call, so ansiCChars with utf8 is linear (GH 2793)`, () => {
      const body = escape.repeat(10000);
      const all = Array<string>(10000).fill('A');
      const run = utf8Run(body, 0);
      assert.ok(run);
      assert.equal(run.end, body.length);
      assert.deepEqual(run.chars, all);
      assert.deepEqual(ansiCChars(body, true), all);
    });

  for (const [body, chars] of [
    ['\\x41\\101 \\xe2\\x9c\\xa8', ['A', 'A', ' ', '✨']],
    ['\\x41\\101\\xe2\\x9c\\xa8', ['A', 'A', '✨']],
    ['\\x41\\x42z\\xff\\x43', ['A', 'B', 'z', null, 'C']],
    ['\\x41\\x42\\xff\\x43', ['A', 'B', null, 'C']],
    ['\\x41\\x00\\x42', ['A', null, 'B']],
    ['\\x41\\n\\x42\\u00e9\\101\\777\\x4', ['A', '\n', 'B', 'é', 'A', null, '\x04']],
    ['\\x41\\x42\\', ['A', 'B', null]],
  ] as const)
    it(`ansiCChars(${JSON.stringify(body)}, utf8) reads an ASCII run of byte escapes as each escape alone (GH 2793)`, () => {
      assert.deepEqual(ansiCChars(body, true), chars);
    });

  it('encode without shownControls reads a byte escape past 0x7F as computed text (GH 2765)', () => {
    const plain = encode(parser, "git commit -m $'\\xe2\\x9c\\xa8 bad'");
    assert.ok(plain.ok);
    assert.equal(decode(plain.text).replaceAll(QM, ''), 'git commit -m $()$()$() bad');
  });

  it('with shownControls a valid UTF-8 run of byte escapes reads as its chars, an invalid one as computed text (GH 2765)', () => {
    const shown = encode(parser, "git commit -m $'\\xe2\\x9c\\xa8 feat(x): y\\xff'", NO_CHARGE, false, true);
    assert.ok(shown.ok);
    assert.equal(decode(shown.text).replaceAll(QM, ''), 'git commit -m ✨ feat(x): y$()');
  });

  it('a word tree-sitter-bash splits at a backslash-newline is held as the joined word', () => {
    assert.ok(held('eval $x\\\ny').includes('$xy'));
    assert.ok(held('cat <<<$a\\\nb').includes('$ab'));
    assert.ok(held('eval a\\\n$x').includes('a$x'));
    assert.ok(held("eval $'\\ca'").includes('$()'));
  });

  it('a joined word is never spliced', () => {
    assert.deepEqual(spliced('eval $x\\\ny'), []);
    assert.deepEqual(spliced('eval $x'), ['$x']);
  });
});

describe('cmdStatements keeps git -C $W past a literal redirect (GH 2404)', () => {
  let root: string;
  let repo: string;
  let wt: string;
  const env = { ...process.env, ...GIT_ENV };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const dirs = async (cmd: string): Promise<string[]> => {
    const res = await cmdStatements(cmd, repo, env);
    assert.ok(res.ok);
    return res.statements.map((s) => s.dir);
  };
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2404-')));
    repo = join(root, 'repo');
    git(root, 'init', '-q', '-b', 'dev', repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'fix/x', wt);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('the checkout has a linked worktree, so a bare git is ambiguous', async () => {
    assert.deepEqual(await dirs('git merge x'), ['?']);
    assert.deepEqual(await dirs(`W=${wt}; git -C $W merge x`), [wt]);
  });

  for (const redirect of ['2>&1', '2>/dev/null', '>out.log', '&>/dev/null'])
    it(`W=<wt>; git -C $W merge x ${redirect} resolves to <wt>`, async () => {
      assert.deepEqual(await dirs(`W=${wt}; git -C $W merge x ${redirect}`), [wt]);
    });

  it('W=<wt>; git -C "$W" commit -m x 2>&1 | tail -3 resolves to <wt>', async () => {
    assert.deepEqual(await dirs(`W=${wt}; git -C "$W" commit -m x 2>&1 | tail -3`), [wt, '?']);
  });

  for (const redirect of ['>$(W=0)', '2>$((W=0))', '>"$W"/log', '2>$[W=0]', '>f`W=0`', '{W}>f'])
    it(`W=<wt>; git -C $W merge x ${redirect} stays unresolved`, async () => {
      assert.equal((await dirs(`W=${wt}; git -C $W merge x ${redirect}`))[0], '-');
    });
});

describe("cmdStatements keeps an empty quoted git -C '' value (GH 2549)", () => {
  let root: string;
  let single: string;
  let linked: string;
  const env = { ...process.env, ...GIT_ENV };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const listed = async (cmd: string, cwd: string) => {
    const res = await cmdStatements(cmd, cwd, env);
    assert.ok(res.ok);
    return res.statements;
  };
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2549-')));
    single = join(root, 'single');
    linked = join(root, 'linked');
    for (const repo of [single, linked]) {
      git(root, 'init', '-q', '-b', 'dev', repo);
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    }
    git(linked, 'worktree', 'add', '-q', '-b', 'fix/x', join(linked, 'wt'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  for (const [cmd, sub] of [
    ["git -C '' push origin dev", 'push origin dev'],
    ['git -C "" push origin dev', 'push origin dev'],
    ["git -C $'' push origin dev", 'push origin dev'],
    ["git -c '' push origin dev", 'push origin dev'],
  ])
    it(`${cmd}: the subcommand is ${sub}`, async () => {
      const [stmt] = await listed(cmd, single);
      assert.equal(gitSubcommand(stmt.stmt), sub);
    });

  it("git -C '' commit -m 'a b': the subcommand starts with commit", async () => {
    const [stmt] = await listed("git -C '' commit -m 'a b'", single);
    assert.match(gitSubcommand(stmt.stmt), /^commit /);
  });

  for (const sub of ['push origin dev', 'merge x', 'commit -m x'])
    it(`git -C '' ${sub} runs in the dir git ${sub} runs in`, async () => {
      for (const [repo, dir] of [
        [single, single],
        [linked, '?'],
      ]) {
        const bare = await listed(`git ${sub}`, repo);
        const empty = await listed(`git -C '' ${sub}`, repo);
        assert.equal(bare[0].dir, dir);
        assert.equal(empty[0].dir, bare[0].dir);
      }
    });

  it("git -C '' -C wt merge x runs in <linked>/wt", async () => {
    const [stmt] = await listed("git -C '' -C wt merge x", linked);
    assert.equal(stmt.dir, join(linked, 'wt'));
  });

  it('an empty -m value after the subcommand is still dropped', async () => {
    const [stmt] = await listed("git commit -m ''", single);
    assert.equal(stmt.stmt, 'git commit -m');
  });
});

describe('cmdStatements leaves a heredoc body $((W=0)) out of the statement and kills W only when it expands (GH 2876)', () => {
  let root: string;
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2876-')));
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  const listed = async (cmd: string): Promise<string[]> => {
    const res = await cmdStatements(cmd, root, {});
    assert.ok(res.ok, cmd);
    return res.statements.map((s) => `${s.dir === root ? '@' : s.dir}#${s.stmt}`);
  };

  for (const [form, body] of [
    ['<<EOM', '$((W=0))\nEOM'],
    ['<<-EOM', '\t$((W=0))\n\tEOM'],
  ] as const)
    it(`an unquoted ${form} body lists cat ${form} alone and makes W unknown`, async () => {
      assert.deepEqual(await listed(`W=/w/r; cat ${form}\n${body}\ngit -C $W status`), ['@#cat <<EOM', '-#git -C $W status']);
    });

  for (const form of ["<<'EOM'", '<<"EOM"', '<<\\EOM'])
    it(`a quoted ${form} data body lists cat <<EOM alone and leaves W alive`, async () => {
      assert.deepEqual(await listed(`W=/w/r; cat ${form}\n$((W=0))\nEOM\ngit -C $W status`), ['@#cat <<EOM', '/w/r#git -C $W status']);
    });
});
