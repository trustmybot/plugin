// L1 lint: Lego cap on the agent templates that ship with the plugin. In templates/agents/, template.md (the full TMB integration contract) stays within 26 total lines (raised from 25 when the persona opening was added, #426 prompt rewrite), and every <consultant role>.md other than swe.md and code-reviewer.md within 15 body lines after the frontmatter: role flavor only, the contract lives in template.md. agents/*.md and the swe.md/code-reviewer.md template copies carry no line cap (GH 2827). report(root) checks the plugin tree at root; the planted cases below build trees through it.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE_TEMPLATE_LIMIT = 26;
const ROLE_BODY_LIMIT = 15;
const BACKBONE_NAMES = ['swe', 'code-reviewer'];

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function totalLines(file) {
  const text = readFileSync(file, 'utf8');
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

function bodyLines(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let fences = 0;
  let count = 0;
  for (const line of lines) {
    if (line === '---') fences++;
    else if (fences >= 2) count++;
  }
  return count;
}

function markdown(dir, skip = []) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !skip.includes(e.name))
    .map((e) => join(dir, e.name))
    .sort();
}

function checkTemplates(dir, out) {
  if (!isDir(dir)) return 0;
  let fail = 0;
  out.push(`Enforcing Lego caps on ${dir}`);

  const base = join(dir, 'template.md');
  if (isFile(base)) {
    const lines = totalLines(base);
    if (lines > BASE_TEMPLATE_LIMIT) {
      out.push(`  ❌ template.md: ${lines} total lines (cap ${BASE_TEMPLATE_LIMIT}) — trim the TMB integration contract in templates/agents/template.md`);
      fail++;
    } else {
      out.push(`  ✓ template.md: ${lines} total lines`);
    }
  }

  for (const f of markdown(dir, ['template.md', ...BACKBONE_NAMES.map((n) => `${n}.md`)])) {
    const blines = bodyLines(f);
    if (blines > ROLE_BODY_LIMIT) {
      out.push(`  ❌ ${f}: ${blines} body lines (cap ${ROLE_BODY_LIMIT}) — role flavor should be ≤${ROLE_BODY_LIMIT} lines; shared contract belongs in templates/agents/template.md (Lego model)`);
      fail++;
    } else {
      out.push(`  ✓ ${f}: ${blines} body lines`);
    }
  }
  out.push('');
  return fail;
}

export function report(root = ROOT) {
  const out = [];
  const fail = checkTemplates(join(root, 'templates', 'agents'), out);
  out.push(fail === 0 ? 'All agent files within Lego cap.' : `${fail} agent file(s) over budget.`);
  return { fail, out: out.join('\n') };
}

test('agent files within Lego cap', () => {
  const r = report();
  assert.equal(r.fail, 0, r.out);
});

describe('planted agent trees', () => {
  let tmp;
  before(() => {
    tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-agent-line-budget.'));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  function plant(name, rel, text) {
    const root = join(tmp, name);
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    return root;
  }

  const lines = (n) => 'x\n'.repeat(n);
  const role = (n) => `---\nname: x\n---\n${lines(n)}`;

  for (const [label, name, rel, text, phrase] of [
    ['template.md over 26 lines', 'base', 'templates/agents/template.md', lines(27), '❌ template.md: 27 total lines (cap 26)'],
    ['a consultant role over 15 body lines', 'role', 'templates/agents/pm.md', role(16), 'templates/agents/pm.md: 16 body lines (cap 15)'],
  ]) {
    test(`fails on ${label}`, () => {
      const r = report(plant(name, rel, text));
      assert.equal(r.fail, 1, r.out);
      assert.ok(r.out.includes(phrase), r.out);
      assert.ok(r.out.endsWith('1 agent file(s) over budget.'), r.out);
    });
  }

  test('passes uncapped agents at any length and roles at their caps, counting only lines after the second fence', () => {
    plant('at-cap', 'agents/swe.md', lines(200));
    plant('at-cap', 'templates/agents/swe.md', lines(200));
    plant('at-cap', 'templates/agents/code-reviewer.md', lines(200));
    plant('at-cap', 'templates/agents/template.md', lines(26));
    const r = report(plant('at-cap', 'templates/agents/cto.md', `${role(15)}---\n`));
    assert.equal(r.fail, 0, r.out);
    assert.ok(r.out.includes('cto.md: 15 body lines'), r.out);
  });
});
