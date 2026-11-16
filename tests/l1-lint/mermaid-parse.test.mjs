// L1 lint (docs bundle, GH 3161): every ```mermaid fence in the tracked Markdown parses with mermaid.parse under jsdom, so no diagram renders as an error on GitHub. The file set is lib/markdown-files.mjs's (the markdownlint lint's). A fence opens with ``` or ~~~ (any indent, three or more) and closes on the same character at least as long; a mermaid fence inside another fence is example text and is skipped. A failure names the file and the fence's opening line. Every run also checks that fixtures/mermaid-parse/broken.md fails on its broken fence only.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { trackedMarkdown } from './lib/markdown-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BROKEN = 'tests/l1-lint/fixtures/mermaid-parse/broken.md';
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;

/** Each ```mermaid fence in text: its 1-based opening line and its body with the fence's indent removed. */
export function mermaidFences(text) {
  const fences = [];
  let open = null;
  text.split('\n').forEach((line, idx) => {
    const m = FENCE.exec(line);
    if (open === null) {
      if (m) open = { marker: m[2], indent: m[1].length, mermaid: m[3] === 'mermaid', line: idx + 1, body: [] };
      return;
    }
    if (m && m[2][0] === open.marker[0] && m[2].length >= open.marker.length && m[3] === '' && line.trim() === m[2]) {
      if (open.mermaid) fences.push({ line: open.line, source: open.body.join('\n') });
      open = null;
      return;
    }
    open.body.push(line.slice(Math.min(open.indent, line.length - line.trimStart().length)));
  });
  return fences;
}

let mermaidPromise;

/** mermaid, loaded once under a jsdom window and document. */
function loadMermaid() {
  mermaidPromise ??= (async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false });
    return mermaid;
  })();
  return mermaidPromise;
}

/** `<rel>:<line>: <first error line>` for each mermaid fence in the files that fails to parse, and the fence count. */
export async function mermaidProblems(root, files) {
  const mermaid = await loadMermaid();
  const problems = [];
  let total = 0;
  for (const rel of files) {
    for (const fence of mermaidFences(readFileSync(join(root, rel), 'utf8'))) {
      total++;
      try {
        await mermaid.parse(fence.source);
      } catch (e) {
        problems.push(`${rel}:${fence.line}: ${String(e?.message ?? e).split('\n')[0]}`);
      }
    }
  }
  return { problems, total };
}

test('fences are found by opening line; nested and non-mermaid fences are not', () => {
  const text = ['# x', '```mermaid', 'graph TD', '```', '````markdown', '```mermaid', 'nested', '```', '````', '  ~~~ mermaid', '  flowchart LR', '  ~~~', '```js', 'x', '```'].join('\n');
  assert.deepEqual(mermaidFences(text), [
    { line: 2, source: 'graph TD' },
    { line: 10, source: 'flowchart LR' },
  ]);
});

test('the broken-diagram fixture fails on its broken fence, naming file and line', async () => {
  const { problems, total } = await mermaidProblems(ROOT, [BROKEN]);
  assert.equal(total, 2);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], new RegExp(`^${BROKEN.replaceAll('.', '\\.')}:10: `));
});

test('every mermaid fence in the tracked Markdown parses', async (t) => {
  const files = trackedMarkdown(ROOT);
  assert.ok(!files.includes(BROKEN), 'fixtures are outside the file set');
  const { problems, total } = await mermaidProblems(ROOT, files);
  assert.ok(total > 0, 'no mermaid fence found in the tracked Markdown');
  assert.deepEqual(problems, [], `mermaid-parse: FAIL (${problems.length} / ${total})\n${problems.join('\n')}`);
  t.diagnostic(`mermaid-parse: PASS (${total} diagrams)`);
});
