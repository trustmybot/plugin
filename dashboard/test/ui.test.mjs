// UI components test: bundle the web/ui components and the shared Badge with
// esbuild, render them to static HTML and check each Button variant uses its
// own --button-<variant>- tokens and the right element, each StateLabel shows
// its octicon and text, a danger Flash is an alert, Badge maps statuses to
// Label variants and RelativeTime switches from relative to absolute at 30
// days; then check index.html applies the stored colour mode before the CSS.
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const SERVER = join(DASH, 'dist/server.mjs');

let ui;
before(async () => {
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { Button } from './web/ui/Button.tsx';
        import { StateLabel } from './web/ui/StateLabel.tsx';
        import { Flash } from './web/ui/Flash.tsx';
        import { RelativeTime } from './web/ui/RelativeTime.tsx';
        import { Badge } from './web/shared/Badge.tsx';
        export const render = (el) => renderToStaticMarkup(el);
        export const h = createElement;
        export { Button, StateLabel, Flash, RelativeTime, Badge };`,
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
  ui = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
});

const html = (component, props, ...children) => ui.render(ui.h(ui[component], props, ...children));

describe('Button', () => {
  const VARIANTS = ['default', 'primary', 'danger', 'invisible'];

  test('each variant references only its own --button-<variant>- tokens', () => {
    for (const variant of VARIANTS) {
      const out = html('Button', { variant }, 'Go');
      assert.match(out, new RegExp(`--button-${variant}-bgColor-rest`), variant);
      for (const other of VARIANTS.filter((v) => v !== variant)) assert.doesNotMatch(out, new RegExp(`--button-${other}-`), `${variant} uses ${other}`);
    }
  });

  test('renders <button type="button"> without href and <a> with href', () => {
    assert.match(html('Button', {}, 'Save'), /^<button type="button"[^>]*>Save<\/button>$/);
    assert.match(html('Button', { type: 'submit' }, 'Save'), /^<button type="submit"/);
    const link = html('Button', { href: '#/issues' }, 'Issues');
    assert.match(link, /^<a [^>]*href="#\/issues"[^>]*>Issues<\/a>$/);
    assert.doesNotMatch(link, /<button/);
  });
});

describe('StateLabel', () => {
  for (const [status, text, icon] of [
    ['open', 'Open', 'octicon-issue-opened'],
    ['closed', 'Closed', 'octicon-issue-closed'],
    ['notPlanned', 'Not planned', 'octicon-skip'],
    ['draft', 'Draft', 'octicon-issue-draft'],
  ]) {
    test(`${status} shows its octicon and text`, () => {
      const out = html('StateLabel', { status });
      assert.match(out, new RegExp(`<svg [^>]*class="[^"]*\\b${icon}\\b`));
      assert.match(out, new RegExp(`</svg>${text}</span>$`));
    });
  }
});

test('Flash danger has role="alert" and the default variant does not', () => {
  assert.match(html('Flash', { variant: 'danger' }, 'Boom'), /^<div role="alert"/);
  assert.doesNotMatch(html('Flash', {}, 'Note'), /role="alert"/);
});

test('Badge renders the danger Label for failed and the success Label for completed', () => {
  const failed = html('Badge', { value: 'failed' });
  assert.match(failed, /--borderColor-danger-emphasis/);
  assert.match(failed, />failed<\/span>$/);
  assert.match(html('Badge', { value: 'completed' }), /--borderColor-success-emphasis/);
  assert.match(html('Badge', { value: 'whatever' }), /--borderColor-default/);
});

describe('RelativeTime', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();

  test('3 hours earlier reads "3 hours ago" with the full timestamp in title', () => {
    const iso = ago(3 * 3600_000);
    const out = html('RelativeTime', { value: iso, now });
    assert.match(out, new RegExp(`<time dateTime="${iso}"`));
    assert.match(out, />3 hours ago<\/time>$/);
    const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' }).format(new Date(iso));
    assert.ok(out.includes(`title="${full}"`), out);
  });

  test('45 days earlier reads as an absolute "on …" date', () => {
    const out = html('RelativeTime', { value: ago(45 * 86_400_000), now });
    assert.match(out, />on [^<]+<\/time>$/);
    assert.doesNotMatch(out, /ago/);
  });

  test('null renders the — fallback', () => {
    assert.match(html('RelativeTime', { value: null, now }), />—<\/span>$/);
  });
});

test('index.html reads tmb-color-mode in an inline script before the stylesheet', () => {
  const page = readFileSync(join(DASH, 'web/index.html'), 'utf8');
  const script = page.search(/<script>[^<]*tmb-color-mode/);
  const link = page.indexOf('<link rel="stylesheet"');
  assert.ok(script !== -1, 'no inline script reading tmb-color-mode');
  assert.ok(link !== -1 && script < link, 'inline script must come before the stylesheet');
});
