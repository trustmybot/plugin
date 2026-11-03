/**
 * `cli.js prompt-author-lint` (GH 1692), the pre-write lint ported from
 * its shell script, run against the built dist/cli.js bundle on scratch drafts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRoot } from '../hooks/lib/project-env.js';

const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url))) as string;
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const USAGE = 'usage: cli.js prompt-author-lint <path-to-md-file>\n';

let dir: string;

function run(args: readonly string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'prompt-author-lint', ...args], { encoding: 'utf8', cwd: dir });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function lint(name: string, text: string): { code: number | null; stdout: string; stderr: string } {
  const path = join(dir, name);
  writeFileSync(path, text);
  return run([path]);
}

function draft(...body: string[]): string {
  return ['---', 'name: draft', 'description: never 2026-01-01 #12', '---', ...body, ''].join('\n');
}

describe('cli.js prompt-author-lint', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'prompt-author-lint-test.'));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const classes: [string, string, string[]][] = [
    ['pink-elephant', "Don't skip it.\nNever stop.\nDo not wait.\nDon'tstop.\n  Never indented.", ["Don't skip it.", 'Never stop.', 'Do not wait.']],
    ['pink-elephant-mid', 'Agents MUST NOT push.\nYou do not need it.\nIt never ends.\nNever-ending.\nDo nothing.', ['Agents MUST NOT push.', 'You do not need it.', 'It never ends.']],
    ['issue-number', 'See #123 here.\nSee (#GH12) too.\nAsk [bro #4].\nNot #abc or #123456.', ['See #123 here.', 'See (#GH12) too.', 'Ask [bro #4].']],
    ['memory-path', 'Read feedback_no_force-push.md.\nOr ~/.claude/projects/x.\nNot feedback_X.md.', ['Read feedback_no_force-push.md.', 'Or ~/.claude/projects/x.']],
    ['origin-attribution', 'Caught In review.\nA prior incident.\nA REGRESSION DURING tests.\nFailed 2× during runs.\nFailed 2X during runs.\nCaught on time.', ['Caught In review.', 'A prior incident.', 'A REGRESSION DURING tests.', 'Failed 2× during runs.', 'Failed 2X during runs.']],
    ['date', 'On 2026-11-02 it broke.\nNot 12026-11-02 or 2026-11-022.', ['On 2026-11-02 it broke.']],
    ['pr-url', 'See !42.\nhttps://gitlab.com/a/b/-/merge_requests/7\nNot gitlab.com/a b/merge_requests/.', ['See !42.', 'https://gitlab.com/a/b/-/merge_requests/7']],
  ];

  for (const [name, body, hits] of classes) {
    it(`flags the ${name} class`, () => {
      const r = lint(`${name}.md`, draft(...body.split('\n')));
      const lines = body.split('\n');
      const expected = hits.map((hit) => `[${name}] ${lines.indexOf(hit) + 1}:${hit}`);
      assert.deepEqual(r.stdout.split('\n').filter((line) => line.startsWith(`[${name}] `)), expected);
      assert.equal(r.code, 0);
    });
  }

  it('prints the classes in the script order, each in line order', () => {
    const r = lint('order.md', draft('See !1.', 'On 2026-01-01.', 'Caught in CI.', 'feedback_a.md', 'Ref #9.', 'We never stop.', "Don't go."));
    assert.equal(
      r.stdout,
      [
        "[pink-elephant] 7:Don't go.",
        '[pink-elephant-mid] 6:We never stop.',
        '[issue-number] 5:Ref #9.',
        '[memory-path] 4:feedback_a.md',
        '[origin-attribution] 3:Caught in CI.',
        '[date] 2:On 2026-01-01.',
        '[pr-url] 1:See !1.',
        '',
      ].join('\n'),
    );
    assert.equal(r.code, 0);
  });

  it('flags one line under every class it matches', () => {
    const r = lint('multi.md', draft('Never do not on 2026-01-01.'));
    assert.equal(r.stdout, "[pink-elephant] 1:Never do not on 2026-01-01.\n[pink-elephant-mid] 1:Never do not on 2026-01-01.\n[date] 1:Never do not on 2026-01-01.\n");
    assert.equal(r.code, 0);
  });

  it('exempts comment lines from the mid-sentence check only', () => {
    const r = lint('comments.md', draft('# never here', '  // do not here', '\t-- MUST NOT here', 'x # never here', '#123 never'));
    assert.equal(r.stdout, '[pink-elephant-mid] 4:x # never here\n[issue-number] 5:#123 never\n');
    assert.equal(r.code, 0);
  });

  it('exempts LOAD-BEARING-SAFETY lines from the mid-sentence check only', () => {
    const r = lint('safety.md', draft('Never bypass; you never do. <!-- LOAD-BEARING-SAFETY -->', 'you never bypass <!-- load-bearing-safety -->'));
    assert.equal(
      r.stdout,
      '[pink-elephant] 1:Never bypass; you never do. <!-- LOAD-BEARING-SAFETY -->\n[pink-elephant-mid] 2:you never bypass <!-- load-bearing-safety -->\n',
    );
    assert.equal(r.code, 0);
  });

  it('numbers lines from the first body line after the frontmatter', () => {
    const r = lint('numbering.md', ['Never before.', '---', 'name: x', '---', '', 'ok', 'Never after.', '---', 'Never later.', ''].join('\n'));
    assert.equal(r.stdout, '[pink-elephant] 3:Never after.\n[pink-elephant] 5:Never later.\n');
    assert.equal(r.code, 0);
  });

  it('finds nothing in a file with no frontmatter pair', () => {
    for (const [name, text] of [
      ['none.md', 'Never here.\nSee #1 on 2026-01-01.\n'],
      ['unclosed.md', '---\nNever here.\nSee #1.\n'],
      ['crlf.md', '---\r\nname: x\r\n---\r\nNever here.\r\n'],
    ]) {
      const r = lint(name, text);
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], name);
    }
  });

  it('prints the usage line for a missing or absent argument', () => {
    for (const args of [[], [''], [join(dir, 'missing.md')], [dir]]) {
      const r = run(args);
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', USAGE], JSON.stringify(args));
    }
  });
});
