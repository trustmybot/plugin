// L1 lint: every skills/**/SKILL.md opens with a frontmatter block holding `name:` and `description:`, and `name` equals the parent directory name (CC discovers a skill by its dir, the body identifies it by name).
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function findSkills(root, rel, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) findSkills(root, child, out);
    else if (entry.isFile() && entry.name === 'SKILL.md') out.push(child);
  }
}

function frontmatter(lines) {
  let c = 0;
  const fm = [];
  for (const line of lines) {
    if (line === '---') c++;
    else if (c === 1) fm.push(line);
  }
  return fm.slice(0, 50);
}

export function skillProblems(root) {
  const skills = [];
  findSkills(root, 'skills', skills);
  return skills.sort().flatMap((skill) => {
    const dirnameBase = basename(dirname(skill));
    const lines = readFileSync(join(root, skill), 'utf8').split('\n');
    if (lines[0] !== '---') return [`  ✗ ${skill}: missing opening '---' (no frontmatter)`];
    const fm = frontmatter(lines);
    const nameLine = fm.find((l) => /^name:\s+/.test(l));
    if (!nameLine) return [`  ✗ ${skill}: missing 'name:' field in frontmatter`];
    if (!fm.some((l) => /^description:\s+/.test(l))) return [`  ✗ ${skill}: missing 'description:' field in frontmatter`];
    const name = nameLine.replace(/^name:\s+/, '').replace(/["']/g, '').trim();
    if (name !== dirnameBase) {
      return [`  ✗ ${skill}: name '${name}' != dirname '${dirnameBase}' (CC discovers by dir, body identifies by name)`];
    }
    return [];
  });
}

test('each malformed SKILL.md is caught with its reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-skill-frontmatter-'));
  try {
    const write = (name, text) => {
      mkdirSync(join(dir, 'skills', name), { recursive: true });
      writeFileSync(join(dir, 'skills', name, 'SKILL.md'), text);
    };
    write('good', '---\nname: "good"\ndescription: fine\n---\nbody\n');
    write('no-fm', 'body\n');
    write('no-name', '---\ndescription: x\n---\n');
    write('no-desc', '---\nname: no-desc\n---\n');
    write('renamed', '---\nname: other\ndescription: x\n---\n');
    assert.deepEqual(skillProblems(dir), [
      "  ✗ skills/no-desc/SKILL.md: missing 'description:' field in frontmatter",
      "  ✗ skills/no-fm/SKILL.md: missing opening '---' (no frontmatter)",
      "  ✗ skills/no-name/SKILL.md: missing 'name:' field in frontmatter",
      "  ✗ skills/renamed/SKILL.md: name 'other' != dirname 'renamed' (CC discovers by dir, body identifies by name)",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every skill has valid frontmatter and name = dirname', () => {
  const problems = skillProblems(ROOT);
  assert.deepEqual(problems, [], `${problems.join('\n')}\n\nSkill-frontmatter: FAIL`);
});
