// L1 lint (warn only): reports negative directive patterns (start-of-line Don't / do not, never, MUST NOT, mid-sentence do not; mid-sentence don't as INFO) in CLAUDE.md, skills/**/SKILL.md, agents/**/*.md and templates/agents/**/*.md. Lines carrying <!-- LOAD-BEARING-SAFETY: ... --> are exempt. Findings print as diagnostics; the run never fails on them.
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir, keep, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) walk(child, keep, out);
    else if (keep(entry.name)) out.push(child);
  }
}

function stripMarkers(line) {
  let s = line.replace(/^ */, '');
  for (const prefix of ['- ', '* ', '+ ', '> ', '- ']) if (s.startsWith(prefix)) s = s.slice(prefix.length);
  return s;
}

export function classify(line) {
  if (line.includes('<!-- LOAD-BEARING-SAFETY:')) return null;
  const s = stripMarkers(line);
  if (s.startsWith("Don't ")) return ['WARN', "start-of-line Don't"];
  if (s.startsWith("DON'T ")) return ['WARN', "start-of-line DON'T"];
  if (s.startsWith('Do not ') || s.startsWith('do not ')) return ['WARN', 'start-of-line do not'];
  if (/\bnever\b/i.test(line)) return ['WARN', 'never'];
  if (/(MUST NOT|must not)/.test(line)) return ['WARN', 'MUST NOT / must not'];
  if (/\bdo not\b/i.test(line)) return ['WARN', 'mid-sentence do not'];
  if (/\bdon't\b/i.test(line)) return ['INFO', "mid-sentence don't"];
  return null;
}

export function findings(file, rel) {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out = [];
  lines.forEach((line, i) => {
    const hit = classify(line);
    if (hit) out.push(`${rel}:${i + 1}: [${hit[0]}] ${hit[1]}`);
  });
  return out;
}

test('each negative directive pattern is reported; the safety marker exempts a line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-no-negative-directives-'));
  try {
    const file = join(dir, 'SKILL.md');
    writeFileSync(
      file,
      [
        "- Don't push.",
        "DON'T merge.",
        '> do not edit.',
        'You never commit.',
        'You MUST NOT commit.',
        'Please do not commit.',
        "We don't commit.",
        'You never commit. <!-- LOAD-BEARING-SAFETY: kept -->',
        'Commit when ready.',
        '',
      ].join('\n'),
    );
    assert.deepEqual(findings(file, 'SKILL.md'), [
      "SKILL.md:1: [WARN] start-of-line Don't",
      "SKILL.md:2: [WARN] start-of-line DON'T",
      'SKILL.md:3: [WARN] start-of-line do not',
      'SKILL.md:4: [WARN] never',
      'SKILL.md:5: [WARN] MUST NOT / must not',
      'SKILL.md:6: [WARN] mid-sentence do not',
      "SKILL.md:7: [INFO] mid-sentence don't",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('negative directives in prompts (warn only)', (t) => {
  const files = [join(ROOT, 'CLAUDE.md')];
  walk(join(ROOT, 'skills'), (name) => name === 'SKILL.md', files);
  walk(join(ROOT, 'agents'), (name) => name.endsWith('.md'), files);
  walk(join(ROOT, 'templates', 'agents'), (name) => name.endsWith('.md'), files);
  const out = files.flatMap((f) => findings(f, f.slice(ROOT.length + 1)));
  for (const line of out) t.diagnostic(line);
  t.diagnostic(`no-negative-directives: ${out.length} finding(s). (warn-only; exit 0)`);
});
