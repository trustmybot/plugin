// L1 lint (warn only): reports negative directive patterns (start-of-line Don't / do not, never, MUST NOT, mid-sentence do not; mid-sentence don't as INFO) in CLAUDE.md, skills/**/SKILL.md, agents/**/*.md and templates/agents/**/*.md. Lines carrying <!-- LOAD-BEARING-SAFETY: ... --> are exempt. Findings print as diagnostics; the run never fails on them.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { files as promptFiles, findings, ROOT } from './lib/no-negative-directives.mjs';

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
  const out = promptFiles().flatMap((f) => findings(f, f.slice(ROOT.length + 1)));
  for (const line of out) t.diagnostic(line);
  t.diagnostic(`no-negative-directives: ${out.length} finding(s). (warn-only; exit 0)`);
});
