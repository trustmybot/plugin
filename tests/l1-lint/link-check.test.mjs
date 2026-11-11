// L1 lint: every relative markdown link `[text](path)` in the checkout's .md files resolves to an existing file or directory. Skipped: http(s), mailto:, data: and tel: links, anchor-only refs, and links inside code spans or fenced blocks; a foo.md#section link only needs foo.md. node_modules/, .git/ and nested dist/ dirs are not scanned, nor the root CHANGELOG.md, whose released sections are immutable history that may name since-deleted paths (changelog.d/ fragments are scanned).
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_SCHEME = /^(https?:\/\/|mailto:|data:|tel:|#)/;

function skipped(rel) {
  return rel === 'CHANGELOG.md' || rel.startsWith('node_modules/') || rel.includes('/node_modules/') || rel.startsWith('.git/') || /^.+\/dist\//.test(rel);
}

function markdownFiles(root, rel, out) {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) markdownFiles(root, child, out);
    else if (entry.isFile() && entry.name.endsWith('.md') && !skipped(child)) out.push(child);
  }
}

function strippedLines(text) {
  const out = [];
  let inFence = false;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line.replace(/`[^`]*`/g, ''));
  }
  return out;
}

export function linkProblems(root) {
  const files = [];
  markdownFiles(root, '', files);
  const broken = [];
  let total = 0;
  for (const rel of files.sort()) {
    const mdfile = `./${rel}`;
    for (const line of strippedLines(readFileSync(join(root, rel), 'utf8'))) {
      for (const [, link] of line.matchAll(/\]\(([^)]+)\)/g)) {
        if (SKIP_SCHEME.test(link)) continue;
        const target = link.split('#')[0].split('?')[0];
        if (!target) continue;
        total++;
        const resolved = resolve(root, dirname(rel), target);
        if (!existsSync(resolved)) broken.push(`  ✗ ${mdfile} → ${link} (resolved: ${resolved}) [missing]`);
      }
    }
  }
  return { broken, total };
}

test('broken relative links are caught; URLs, anchors, code and skipped dirs are not checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-link-check-'));
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, 'pkg', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# r\n');
    writeFileSync(
      join(dir, 'docs', 'guide.md'),
      [
        '[ok](../README.md#top) and [dir](.) and [q](../README.md?x=1)',
        '[gone](missing.md) [web](https://example.com/x.md) [mail](mailto:a@b) [anchor](#here)',
        'inline `[code](nope.md)` span',
        '```',
        '[fenced](nope.md)',
        '```',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'node_modules', 'pkg', 'x.md'), '[x](nope.md)\n');
    writeFileSync(join(dir, 'pkg', 'dist', 'x.md'), '[x](nope.md)\n');
    const { broken, total } = linkProblems(dir);
    assert.deepEqual(broken, [`  ✗ ./docs/guide.md → missing.md (resolved: ${join(dir, 'docs', 'missing.md')}) [missing]`]);
    assert.equal(total, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the root CHANGELOG.md is skipped; a nested CHANGELOG.md and changelog.d/ fragments are checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-link-check-'));
  try {
    mkdirSync(join(dir, 'changelog.d'), { recursive: true });
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'CHANGELOG.md'), '[old](docs/deleted.md)\n');
    writeFileSync(join(dir, 'changelog.d', '1-x.md'), '[gone](../docs/deleted.md)\n');
    writeFileSync(join(dir, 'pkg', 'CHANGELOG.md'), '[gone](deleted.md)\n');
    const { broken, total } = linkProblems(dir);
    assert.deepEqual(broken, [
      `  ✗ ./changelog.d/1-x.md → ../docs/deleted.md (resolved: ${join(dir, 'docs', 'deleted.md')}) [missing]`,
      `  ✗ ./pkg/CHANGELOG.md → deleted.md (resolved: ${join(dir, 'pkg', 'deleted.md')}) [missing]`,
    ]);
    assert.equal(total, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every relative markdown link resolves', (t) => {
  const { broken, total } = linkProblems(ROOT);
  assert.deepEqual(broken, [], `${broken.join('\n')}\n\nLink-check: FAIL (${broken.length} broken / ${total} total)`);
  t.diagnostic(`Link-check: PASS (${total} links resolve)`);
});
