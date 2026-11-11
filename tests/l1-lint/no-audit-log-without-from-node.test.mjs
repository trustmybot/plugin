// L1 lint: every audit_append() call in a prompt file passes from_node= (!2892 BLOCKER 1 — six prompt files crashed bro on its first call). Scans agents/*.md, commands/*.md, templates/agents/*.md, skills/**/SKILL.md and the top-level CLAUDE.md. A call runs from the line naming audit_append( to the first line holding a ')'; a call with no from_node= in it fails. Every run also checks fixtures/audit-log-from-node/missing.md is caught.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'audit-log-from-node');
const SCAN_DIRS = ['agents', 'commands', 'templates/agents'];
const TOP_LEVEL_MDS = ['CLAUDE.md'];

export function checkFile(base, file) {
  const out = [];
  const rel = file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file;
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let start = 0;
  let buf = null;
  const flush = () => {
    if (buf !== null && !buf.includes('from_node=')) out.push(`${rel}:${start}: audit_append() missing from_node=`);
    buf = null;
  };
  lines.forEach((line, idx) => {
    if (buf !== null) {
      buf += `\n${line}`;
      if (line.includes(')')) flush();
      return;
    }
    if (line.includes('audit_append(')) {
      start = idx + 1;
      buf = line;
      if (line.includes(')')) flush();
    }
  });
  flush();
  return out;
}

function findAll(dir, match, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) findAll(child, match, out);
    else if (entry.name === match) out.push(child);
  }
  return out;
}

test('fixture missing.md is caught', () => {
  const fixture = join(FIXTURES, 'missing.md');
  assert.ok(existsSync(fixture), `no-audit-log-without-from-node --self-test: fixture missing: ${fixture}`);
  assert.notDeepEqual(checkFile(FIXTURES, fixture), [], 'no-audit-log-without-from-node --self-test: FAIL (fixture not caught)');
});

test('no audit_append without from_node', () => {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) if (name.endsWith('.md') && statSync(join(abs, name)).isFile()) files.push(join(abs, name));
  }
  if (existsSync(join(ROOT, 'skills'))) files.push(...findAll(join(ROOT, 'skills'), 'SKILL.md', []).sort());
  for (const name of TOP_LEVEL_MDS) if (existsSync(join(ROOT, name)) && statSync(join(ROOT, name)).isFile()) files.push(join(ROOT, name));
  const out = files.flatMap((f) => checkFile(ROOT, f));
  assert.deepEqual(out, [], `${out.join('\n')}\n\nno-audit-log-without-from-node: FAIL`);
});
