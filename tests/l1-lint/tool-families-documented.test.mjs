// L1 lint: the MCP tool documentation lists what mcp/trajectory-server/src/tools/index.ts registers. Every tool module index.ts imports is a row of the tool-family table in mcp/trajectory-server/README.md (`tools/<module>.ts`) and of src/tools/README.md (`<module>.ts`); every tool those modules define (a `name: '<tool>'` definition) is named in src/tools/README.md and in the "MCP tools (full list)" section of docs/reference/REFERENCE.md, whose "<N> tools" count matches.
import { strict as assert } from 'node:assert';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS_REL = join('mcp', 'trajectory-server', 'src', 'tools');
const README_REL = join('mcp', 'trajectory-server', 'README.md');
const REFERENCE_REL = join('docs', 'reference', 'REFERENCE.md');

const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

function referenceSection(text) {
  const out = [];
  let on = false;
  for (const line of text.split('\n')) {
    if (/^## MCP tools/.test(line)) {
      on = true;
      out.push(line);
      continue;
    }
    if (on && /^## /.test(line)) on = false;
    if (on) out.push(line);
  }
  return out;
}

export function toolFamilyProblems(root) {
  const tools = join(root, TOOLS_REL);
  const readme = read(join(root, README_REL));
  const toolsReadme = read(join(tools, 'README.md'));
  const refLines = referenceSection(read(join(root, REFERENCE_REL)));
  const refSection = refLines.join('\n');
  const problems = [];
  let total = 0;
  const modules = [...read(join(tools, 'index.ts')).matchAll(/from '\.\/([a-z_-]+)\.js'/g)].map((m) => m[1]);
  for (const module of modules) {
    if (!readme.includes(`\`tools/${module}.ts\``)) problems.push(`  ✗ mcp/trajectory-server/README.md tool-family table has no row for tools/${module}.ts`);
    if (!toolsReadme.includes(`\`${module}.ts\``)) problems.push(`  ✗ src/tools/README.md has no row for ${module}.ts`);
    const names = read(join(tools, `${module}.ts`))
      .split('\n')
      .map((line) => /^\s+name: '([a-z_]+)'/.exec(line))
      .filter(Boolean)
      .map((m) => m[1]);
    for (const tool of names) {
      total++;
      if (!toolsReadme.includes(`\`${tool}\``)) problems.push(`  ✗ src/tools/README.md does not name ${tool} (${module}.ts)`);
      if (!refSection.includes(`\`${tool}\``)) problems.push(`  ✗ docs/reference/REFERENCE.md MCP tools list does not name ${tool} (${module}.ts)`);
    }
  }
  const statedLine = refLines.map((line) => /^([0-9]+) tools/.exec(line)).find(Boolean);
  const stated = statedLine ? statedLine[1] : '';
  if (stated !== String(total)) problems.push(`  ✗ docs/reference/REFERENCE.md says '${stated || '?'} tools'; index.ts registers ${total}`);
  return { problems, total };
}

test('a missing family row and a missing tool both fail, naming tools/stats.ts and trajectory_doctor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-tool-families-'));
  try {
    cpSync(join(ROOT, TOOLS_REL), join(dir, TOOLS_REL), { recursive: true });
    cpSync(join(ROOT, README_REL), join(dir, README_REL));
    cpSync(join(ROOT, REFERENCE_REL), join(dir, REFERENCE_REL));
    const readme = readFileSync(join(dir, README_REL), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('| Stats | `tools/stats.ts`'))
      .join('\n');
    writeFileSync(join(dir, README_REL), readme);
    const reference = readFileSync(join(dir, REFERENCE_REL), 'utf8')
      .split('\n')
      .map((line) => line.replace('`trajectory_doctor`', ''))
      .join('\n');
    writeFileSync(join(dir, REFERENCE_REL), reference);
    const { problems } = toolFamilyProblems(dir);
    assert.notDeepEqual(problems, [], 'a missing family row and a missing tool should fail');
    const text = problems.join('\n');
    assert.match(text, /tools\/stats\.ts/, `failure did not name tools/stats.ts:\n${text}`);
    assert.match(text, /trajectory_doctor/, `failure did not name trajectory_doctor:\n${text}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('README, src/tools/README.md and REFERENCE.md list every family and tool in tools/index.ts', (t) => {
  const { problems, total } = toolFamilyProblems(ROOT);
  assert.deepEqual(problems, [], `${problems.join('\n')}\nTool-families-documented: FAIL`);
  t.diagnostic(`README, src/tools/README.md and REFERENCE.md list every family and all ${total} tools in tools/index.ts`);
});
