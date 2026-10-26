// Theme test: re-run scripts/primer-tokens.mjs into a temp file and check it
// reproduces the committed web/theme/primer-tokens.css byte for byte, stays
// under 8 KB gzipped, declares every var() it uses and carries both the light
// and dark theme selectors; then render <AppHeader> and <UnderlineNav> to
// static HTML and check the tab links, the current tab and the toggle.
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const TOKENS = join(DASH, 'web/theme/primer-tokens.css');
const SERVER = join(DASH, 'dist/server.mjs');

describe('primer-tokens.css', () => {
  const css = readFileSync(TOKENS, 'utf8');

  test('the generator reproduces the committed file byte for byte', () => {
    const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-tokens-'));
    try {
      const out = join(tmp, 'primer-tokens.css');
      execFileSync(process.execPath, [join(DASH, 'scripts/primer-tokens.mjs'), out]);
      assert.ok(readFileSync(out).equals(readFileSync(TOKENS)), 'primer-tokens.css is stale; run bun run tokens in dashboard/');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('is at most 8192 bytes gzipped', () => {
    const size = gzipSync(css, { level: 9 }).length;
    assert.ok(size <= 8192, `${size} B gzipped`);
  });

  test('declares every custom property it references', () => {
    const declared = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
    const missing = [...new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))].filter((v) => !declared.has(v));
    assert.deepEqual(missing, []);
  });

  test('contains the light and dark theme selectors', () => {
    assert.ok(css.includes('[data-color-mode="light"][data-light-theme="light"]'));
    assert.ok(css.includes('[data-color-mode="dark"][data-dark-theme="dark"]'));
    assert.ok(css.includes('@media (prefers-color-scheme: dark)'));
  });
});

describe('dashboard shell', () => {
  let render;
  before(async () => {
    const out = await build({
      stdin: {
        contents: `import { renderToStaticMarkup } from 'react-dom/server';
          import { createElement, Fragment } from 'react';
          import { TABS } from './web/App.tsx';
          import { AppHeader } from './web/ui/AppHeader.tsx';
          import { UnderlineNav } from './web/ui/UnderlineNav.tsx';
          export const render = (active) => renderToStaticMarkup(
            createElement(Fragment, null, createElement(AppHeader), createElement(UnderlineNav, { tabs: TABS, active })),
          );`,
        resolveDir: DASH,
        loader: 'js',
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      jsx: 'automatic',
      banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(SERVER)});` },
      write: false,
      logLevel: 'silent',
    });
    const url = `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`;
    ({ render } = await import(url));
  });

  test('renders the 8 tab links, one current tab and the colour-mode toggle', () => {
    const html = render('tasks');
    const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ['#/overview', '#/issues', '#/tasks', '#/runs', '#/insights', '#/audit', '#/map', '#/concepts']);
    const current = [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>/g)];
    assert.equal(current.length, 1);
    assert.match(current[0][0], /href="#\/tasks"/);
    assert.match(html, /<button [^>]*aria-label="Colour mode: auto \(system\)[^"]*"/);
    assert.match(html, /TMB dashboard/);
  });
});
