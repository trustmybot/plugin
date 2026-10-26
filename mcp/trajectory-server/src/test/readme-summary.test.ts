import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanReadme } from '../readme-summary.js';

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

  it('keeps no state between calls', () => {
    assert.equal(cleanReadme(ROOT_README_HEAD), cleanReadme(ROOT_README_HEAD));
  });
});
