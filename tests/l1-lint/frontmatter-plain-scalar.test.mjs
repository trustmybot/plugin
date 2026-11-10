// L1 lint: no top-level frontmatter value in skills/*/SKILL.md, agents/*.md or commands/*.md is an unquoted plain scalar holding ': ', which YAML reads as a nested mapping indicator and rejects.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PLAIN_WITH_COLON = /^([A-Za-z][\w-]*): ([^\s"'>|[{].*: .*)$/;

function promptFiles(root) {
  const out = [];
  const skills = join(root, 'skills');
  if (existsSync(skills)) {
    for (const e of readdirSync(skills, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(skills, e.name, 'SKILL.md'))) out.push(`skills/${e.name}/SKILL.md`);
    }
  }
  for (const dir of ['agents', 'commands']) {
    if (!existsSync(join(root, dir))) continue;
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) out.push(`${dir}/${e.name}`);
    }
  }
  return out.sort();
}

export function plainScalarProblems(root) {
  return promptFiles(root).flatMap((rel) => {
    const lines = readFileSync(join(root, rel), 'utf8').split('\n');
    if (lines[0] !== '---') return [];
    const problems = [];
    for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
      const m = PLAIN_WITH_COLON.exec(lines[i]);
      if (m) problems.push(`  ✗ ${rel}:${i + 1}: '${m[1]}' is an unquoted value holding ': ' (quote it or drop the colon)`);
    }
    return problems;
  });
}

test('each unquoted colon-space value is caught; quoted, block and colon-free values pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-frontmatter-plain-scalar-'));
  try {
    const write = (rel, text) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    write('skills/bad/SKILL.md', '---\nname: bad\ndescription: the rule: docs hold architecture\n---\nbody: fine\n');
    write('skills/quoted/SKILL.md', '---\nname: quoted\ndescription: "the rule: quoted"\n---\n');
    write('skills/single/SKILL.md', "---\nname: single\ndescription: 'the rule: quoted'\n---\n");
    write('skills/block/SKILL.md', '---\nname: block\ndescription: >\n  the rule: folded\n---\n');
    write('skills/dash/SKILL.md', '---\nname: dash\ndescription: the rule — no colon, and a url http://x\n---\n');
    write('agents/a.md', '---\nname: a\ndescription: Use when: always\n---\n');
    write('commands/c.md', '---\ndescription: ok\nargument-hint: <x>: y\n---\n');
    write('commands/no-fm.md', 'description: a: b\n');
    assert.deepEqual(plainScalarProblems(dir), [
      "  ✗ agents/a.md:3: 'description' is an unquoted value holding ': ' (quote it or drop the colon)",
      "  ✗ commands/c.md:3: 'argument-hint' is an unquoted value holding ': ' (quote it or drop the colon)",
      "  ✗ skills/bad/SKILL.md:3: 'description' is an unquoted value holding ': ' (quote it or drop the colon)",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every skill, agent and command frontmatter value parses as YAML', () => {
  const problems = plainScalarProblems(ROOT);
  assert.deepEqual(problems, [], `${problems.join('\n')}\n\nFrontmatter-plain-scalar: FAIL`);
});
