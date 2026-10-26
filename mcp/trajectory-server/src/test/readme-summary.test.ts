import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanReadme, README_CLEAN_MAX_CHARS } from '../readme-summary.js';

const ROOT_README_HEAD = [
  '# TMB Plugin',
  '',
  '<p align="center">',
  '  <img src="docs/assets/tmb-hero.svg" width="640" alt="Animated pixel-art story. Trust me bro, it works.">',
  '</p>',
  '',
  '> **Trust me bro, it works.**',
  '',
  '**An agentic engineering harness for Claude Code.**',
  '',
].join('\n');

describe('cleanReadme (GH 1834)', () => {
  it('drops the hero <p><img> block of the plugin root README and keeps the H1 and the first prose paragraph', () => {
    const out = cleanReadme(ROOT_README_HEAD);
    assert.ok(out.startsWith('# TMB Plugin\n\n> **Trust me bro, it works.**\n'), out);
    assert.ok(out.includes('**An agentic engineering harness for Claude Code.**'), out);
    assert.doesNotMatch(out, /</);
  });

  it('drops a badge row', () => {
    const out = cleanReadme(
      [
        '# Lib',
        '',
        '[![CI](https://ci.example/badge.svg)](https://ci.example) [![npm](https://img.shields.io/npm/v/x.svg)](https://npm.im/x)',
        '',
        'Lib parses things.',
        '',
      ].join('\n'),
    );
    assert.equal(out, '# Lib\n\nLib parses things.\n');
  });

  it('drops a leading block of links only and an HTML comment, keeping inner text of inline tags', () => {
    const out = cleanReadme(
      ['<!-- generated -->', '[Docs](docs/) · [API](api/)', '', 'Run <code>tool</code> to start.', ''].join('\n'),
    );
    assert.equal(out, 'Run tool to start.\n');
  });

  it('leaves a plain README unchanged', () => {
    const plain = '# Project\n\nRun `make` to build. See [docs](docs/README.md).\n\n\n## Usage\n\n- a < b\n';
    assert.equal(cleanReadme(plain), plain);
  });

  it('leaves no <p tag from a nested <<p>p>x', () => {
    const out = cleanReadme('<<p>p>x\n');
    assert.doesNotMatch(out, /<p/);
    assert.doesNotMatch(out, /</);
  });

  it('removes a multi-line <img> tag and a multi-line HTML comment entirely (F158-1)', () => {
    const out = cleanReadme(
      '# X\n\n<p align="center">\n  <img\n    src="a.svg"\n    alt="hero">\n</p>\n\n<!--\n  generated, do not edit\n-->\n\nReal prose.\n',
    );
    assert.equal(out, '# X\n\nReal prose.\n');
  });

  it('removes a multi-line <picture><source><img> block and keeps the prose after it', () => {
    const out = cleanReadme(
      [
        '<picture>',
        '  <source',
        '    media="(prefers-color-scheme: dark)"',
        '    srcset="logo-dark.svg"',
        '  />',
        '  <img',
        '    alt="Logo of the library"',
        '    src="logo.svg"',
        '  />',
        '</picture>',
        '',
        'Powerful asynchronous state management.',
        '',
      ].join('\n'),
    );
    assert.equal(out, 'Powerful asynchronous state management.\n');
  });

  it('keeps the prose and blockquote after a non-tag "<" in a paragraph (F158-2)', () => {
    const out = cleanReadme('# Lib\n\nWorks when x <y holds.\n\nMore prose here.\n\n> Note: something\n');
    assert.ok(out.includes('More prose here.'), out);
    assert.ok(out.includes('Note: something'), out);
  });

  it('keeps the prose after a heredoc "<<EOF" in a code fence (F158-2)', () => {
    const out = cleanReadme(
      '# Lib\n\nIntro prose.\n\n```bash\ncat <<EOF\nhi\nEOF\n```\n\nUsage prose here.\n\n```bash\nfoo > out.txt\n```\n',
    );
    assert.ok(out.includes('Usage prose here.'), out);
    assert.ok(out.includes('foo > out.txt'), out);
  });

  it('never lets a tag match cross a blank line', () => {
    assert.equal(cleanReadme('# A\n\nSee <b\n\nlater > text.\n'), '# A\n\nSee b\n\nlater > text.\n');
  });

  it('keeps the prose and blockquote after a non-tag "<" in CRLF text (F158-3)', () => {
    const a = cleanReadme('# Lib\r\n\r\nWorks when x <y holds.\r\n\r\nMore prose here.\r\n\r\n> Note: something\r\n');
    const b = cleanReadme('# Lib\r\n\r\nSee <b\r\n\r\nlater > text.\r\n');
    assert.ok(a.includes('More prose here.'), a);
    assert.ok(a.includes('> Note: something'), a);
    assert.ok(b.includes('later > text.'), b);
    assert.equal(b, '# Lib\n\nSee b\n\nlater > text.\n');
  });

  it('treats a lone CR as a line ending', () => {
    assert.equal(cleanReadme('# Lib\r\rSee <b\r\rlater > text.\r'), '# Lib\n\nSee b\n\nlater > text.\n');
  });

  it('fully strips a CRLF hero block and returns \\n endings throughout', () => {
    const out = cleanReadme(ROOT_README_HEAD.replace(/\n/g, '\r\n'));
    assert.equal(out, cleanReadme(ROOT_README_HEAD));
    assert.doesNotMatch(out, /[<\r]/);
  });

  it('leaves a plain CRLF README byte-identical', () => {
    const plain = '# Project\r\n\r\nRun `make` to build. See [docs](docs/README.md).\r\n\r\n## Usage\r\n\r\n- a < b\r\n';
    assert.equal(cleanReadme(plain), plain);
  });

  it(`clips the input to ${README_CLEAN_MAX_CHARS} chars before stripping`, () => {
    const out = cleanReadme(`# Big\n\n${'word '.repeat(README_CLEAN_MAX_CHARS)}\n`);
    assert.ok(out.length <= README_CLEAN_MAX_CHARS + 1, String(out.length));
  });

  for (const unit of ['<a', '<!--', '<a\n', '[![', '![a](', '[![a](', '<a b="']) {
    it(`strips a crafted ${JSON.stringify(unit)} input of 440 KB in bounded time`, () => {
      const start = Date.now();
      cleanReadme(unit.repeat(Math.ceil(440_000 / unit.length)));
      assert.ok(Date.now() - start < 500, `${Date.now() - start} ms`);
    });
  }

  it('keeps no state between calls', () => {
    assert.equal(cleanReadme(ROOT_README_HEAD), cleanReadme(ROOT_README_HEAD));
  });
});
