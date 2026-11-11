// L1 lint: no stale framing prose ("no longer", "was previously", "retired", "deprecated", "formerly", any case, whole words) in documentation (!2898 + !2901). Carve-out: a word inside an inline backtick span is an enum literal and passes; lines inside fenced code blocks (``` or ~~~, optionally indented, with an info string) are skipped. Scans docs/, agents/, commands/, templates/agents/ (*.md), skills/**/SKILL.md and the top-level CLAUDE.md, README.md, CONTRIBUTING.md, SECURITY.md. Every run also checks fixtures/stale-framing-prose/ (prose caught, enum literal allowed, fences allowed with prose after them caught).
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'stale-framing-prose');
const STALE = /\b(no longer|was previously|retired|deprecated|formerly)\b/i;
const FENCE = /^\s*(```+|~~~+)(.*)$/;
const SCAN_DIRS = ['docs', 'agents', 'commands', 'templates/agents'];
const TOP_LEVEL = ['CLAUDE.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md'];

export function checkFile(base, file) {
  const out = [];
  const rel = file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file;
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let fenceChar = '';
  let fenceLen = 0;
  lines.forEach((line, idx) => {
    const m = FENCE.exec(line);
    if (m) {
      const [, marker, rest] = m;
      if (!fenceChar) {
        if (marker[0] === '~' || !rest.includes('`')) {
          fenceChar = marker[0];
          fenceLen = marker.length;
          return;
        }
      } else if (marker[0] === fenceChar && marker.length >= fenceLen && /^\s*$/.test(rest)) {
        fenceChar = '';
        fenceLen = 0;
        return;
      }
    }
    if (fenceChar) return;
    if (STALE.test(line.replace(/`[^`]*`/g, ''))) out.push(`${rel}:${idx + 1}: stale framing prose`);
  });
  return out;
}

function findMd(dir, match, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) findMd(child, match, out);
    else if (match(entry.name)) out.push(child);
  }
  return out;
}

const SELF_TESTS = [
  ['has-stale-prose.md', [3, 4]],
  ['has-enum-literal.md', []],
  ['has-fenced-code.md', [11]],
];

for (const [name, want] of SELF_TESTS) {
  test(`fixture ${name} flags lines [${want.join(' ')}]`, () => {
    const fixture = join(FIXTURES, name);
    assert.ok(existsSync(fixture), `stale-framing-prose --self-test: FAIL (${name} missing)`);
    const got = checkFile(FIXTURES, fixture).map((l) => Number(l.split(':')[1]));
    assert.deepEqual(got, want, `stale-framing-prose --self-test: FAIL (${name} flags lines [${got.join(' ')}], expected [${want.join(' ')}])`);
  });
}

test('no stale framing prose', () => {
  const files = [];
  for (const dir of SCAN_DIRS) {
    if (existsSync(join(ROOT, dir))) files.push(...findMd(join(ROOT, dir), (n) => n.endsWith('.md'), []).sort());
  }
  if (existsSync(join(ROOT, 'skills'))) files.push(...findMd(join(ROOT, 'skills'), (n) => n === 'SKILL.md', []).sort());
  for (const name of TOP_LEVEL) if (existsSync(join(ROOT, name)) && statSync(join(ROOT, name)).isFile()) files.push(join(ROOT, name));
  const out = files.flatMap((f) => checkFile(ROOT, f));
  assert.deepEqual(out, [], `${out.join('\n')}\n\nstale-framing-prose: FAIL`);
});
