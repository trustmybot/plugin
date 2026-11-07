// L1 lint: every commands/*.md (README.md aside) is named ^[a-z][a-z0-9-]*\.md$, opens with a frontmatter block holding a non-empty `description:` and an `argument-hint:` key, and has a non-empty body.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function blocks(lines) {
  let c = 0;
  const fm = [];
  const body = [];
  for (const line of lines) {
    if (line === '---') {
      c++;
      continue;
    }
    if (c === 1) fm.push(line);
    else if (c >= 2) body.push(line);
  }
  return { fm: fm.slice(0, 50), body };
}

export function commandProblems(root) {
  const dir = join(root, 'commands');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
    .map((e) => e.name)
    .sort();
  return files.flatMap((filename) => {
    const cmd = `commands/${filename}`;
    if (!/^[a-z][a-z0-9-]*\.md$/.test(filename)) return [`  ✗ ${cmd}: filename must match ^[a-z][a-z0-9-]*\\.md$`];
    const lines = readFileSync(join(dir, filename), 'utf8').split('\n');
    if (lines[0] !== '---') return [`  ✗ ${cmd}: missing opening '---' (no frontmatter)`];
    const { fm, body } = blocks(lines);
    if (!fm.some((l) => /^description:\s+\S/.test(l))) return [`  ✗ ${cmd}: missing or empty 'description:' field in frontmatter`];
    if (!fm.some((l) => l.startsWith('argument-hint:'))) return [`  ✗ ${cmd}: missing 'argument-hint:' field in frontmatter`];
    if (!body.some((l) => /\S/.test(l))) return [`  ✗ ${cmd}: file body is empty (no content after frontmatter)`];
    return [];
  });
}

test('each malformed command file is caught with its reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-command-frontmatter-'));
  try {
    mkdirSync(join(dir, 'commands'));
    const write = (name, text) => writeFileSync(join(dir, 'commands', name), text);
    write('README.md', 'no frontmatter\n');
    write('Bad_Name.md', '---\ndescription: x\nargument-hint:\n---\nbody\n');
    write('good.md', '---\ndescription: does a thing\nargument-hint: <arg>\n---\nbody\n');
    write('no-fm.md', 'body\n');
    write('no-desc.md', '---\ndescription:\nargument-hint:\n---\nbody\n');
    write('no-hint.md', '---\ndescription: x\n---\nbody\n');
    write('no-body.md', '---\ndescription: x\nargument-hint:\n---\n\n');
    assert.deepEqual(commandProblems(dir), [
      '  ✗ commands/Bad_Name.md: filename must match ^[a-z][a-z0-9-]*\\.md$',
      "  ✗ commands/no-body.md: file body is empty (no content after frontmatter)",
      "  ✗ commands/no-desc.md: missing or empty 'description:' field in frontmatter",
      "  ✗ commands/no-fm.md: missing opening '---' (no frontmatter)",
      "  ✗ commands/no-hint.md: missing 'argument-hint:' field in frontmatter",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every command has valid frontmatter (description + argument-hint)', () => {
  const problems = commandProblems(ROOT);
  assert.deepEqual(problems, [], `${problems.join('\n')}\n\nCommand-frontmatter: FAIL`);
});
