// L1 lint: no parenthetical issue/MR/PR citation — (#NNNN), (GL #NNNN), (MR !NNNN), (PR !NNNN) — in a prompt file, since prompts load every turn and the citation is noise. Scans the *.md files directly in agents/, commands/ and templates/agents/, every skills/**/SKILL.md, and the top-level CLAUDE.md. Every run also checks that fixtures/citations-in-prompts/has-citations.md is caught.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'citations-in-prompts', 'has-citations.md');
const CITATION = /\((#|GL #|MR !|PR !)[0-9]+\)/;
const TOP_LEVEL = ['CLAUDE.md'];

const isFile = (abs) => existsSync(abs) && statSync(abs).isFile();

export function citationLines(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.flatMap((line, i) => (CITATION.test(line) ? [i + 1] : []));
}

function mdInDir(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => name.endsWith('.md') && isFile(join(abs, name)))
    .sort()
    .map((name) => `${rel}/${name}`);
}

function skillFiles(root, rel, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) skillFiles(root, child, out);
    else if (entry.name === 'SKILL.md' && isFile(join(root, child))) out.push(child);
  }
  return out;
}

export function citationProblems(root) {
  const files = [
    ...mdInDir(root, 'agents'),
    ...mdInDir(root, 'commands'),
    ...mdInDir(root, 'templates/agents'),
    ...skillFiles(root, 'skills', []),
    ...TOP_LEVEL.filter((name) => isFile(join(root, name))),
  ];
  return files.flatMap((rel) => citationLines(readFileSync(join(root, rel), 'utf8')).map((n) => `${rel}:${n}: citation in prompt`));
}

test('the has-citations fixture is caught', () => {
  assert.ok(existsSync(FIXTURE), `no-citations-in-prompts self-test: fixture missing: ${FIXTURE}`);
  assert.ok(citationLines(readFileSync(FIXTURE, 'utf8')).length > 0, 'no-citations-in-prompts self-test: FAIL (fixture not caught)');
});

test('citations in each scanned prompt location are caught, other files are not scanned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-no-citations-'));
  try {
    for (const d of ['agents/sub', 'commands', 'templates/agents', 'skills/a/b', 'docs']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'agents', 'swe.md'), 'fine\nSee (#123).\n');
    writeFileSync(join(dir, 'agents', 'sub', 'deep.md'), '(#1)\n');
    writeFileSync(join(dir, 'commands', 'go.md'), 'Done (MR !45).\n');
    writeFileSync(join(dir, 'templates', 'agents', 'cto.md'), '(GL #7) and (PR !8)\n');
    writeFileSync(join(dir, 'skills', 'a', 'b', 'SKILL.md'), 'x\ny\n(#9)\n');
    writeFileSync(join(dir, 'skills', 'a', 'notes.md'), '(#10)\n');
    writeFileSync(join(dir, 'CLAUDE.md'), '(#11)\n');
    writeFileSync(join(dir, 'README.md'), '(#12)\n');
    writeFileSync(join(dir, 'docs', 'x.md'), '(#13) #14 (GH 15)\n');
    assert.deepEqual(citationProblems(dir), [
      'agents/swe.md:2: citation in prompt',
      'commands/go.md:1: citation in prompt',
      'templates/agents/cto.md:1: citation in prompt',
      'skills/a/b/SKILL.md:3: citation in prompt',
      'CLAUDE.md:1: citation in prompt',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no citations in prompts', () => {
  const problems = citationProblems(ROOT);
  assert.deepEqual(problems, [], `${problems.join('\n')}\n\nno-citations-in-prompts: FAIL`);
});
