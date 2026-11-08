// L1 lint: project-local swe + code-reviewer overrides (<project>/.claude/agents/, the plugin root's parent) retain the critical workflow primitives. swe needs task_brief(, task_update_status( and an atomic close in its body; code-reviewer needs task_brief( and validation_record(; both list mcp__plugin_tmb_trajectory-server in their frontmatter tools. No-op when no local override exists. Every run also checks fixtures/local-agent/: valid passes, and each broken override fails naming the missing primitive.
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests/l1-lint/fixtures/local-agent');
const MCP_TOOL = 'mcp__plugin_tmb_trajectory-server';
const RULES = {
  swe: [
    ['task_brief(', /task_brief\(/i],
    ['task_update_status(', /task_update_status\(/i],
    ['atomic close', /atomic.{0,3}close/i],
  ],
  'code-reviewer': [
    ['task_brief(', /task_brief\(/i],
    ['validation_record(', /validation_record\(/i],
  ],
};

const missing = (file, primitive) => `local-agent-primitives FAIL: ${file} missing primitive '${primitive}' (e.g. expected reference to '${primitive}')`;

function frontmatter(text) {
  let c = 0;
  const out = [];
  for (const l of text.split('\n')) {
    if (l === '---') {
      c++;
      continue;
    }
    if (c === 1) out.push(l);
  }
  return out;
}

export function lint(dir) {
  const out = [];
  const checked = [];
  for (const name of ['swe', 'code-reviewer']) {
    const file = join(dir, `${name}.md`);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const [primitive, re] of RULES[name]) if (!text.split('\n').some((l) => re.test(l))) out.push(missing(file, primitive));
    if (!frontmatter(text).some((l) => new RegExp(`tools:.*${MCP_TOOL}`).test(l))) out.push(missing(file, MCP_TOOL));
    checked.push(name);
  }
  return { out, checked };
}

test('fixture valid: passes', () => {
  const { out } = lint(join(FIXTURES, 'valid'));
  assert.deepEqual(out, [], 'valid dir should pass but did not');
});

for (const [dir, primitive] of [
  ['swe-missing-task-brief', 'task_brief'],
  ['swe-missing-mcp-tool', MCP_TOOL],
  ['code-reviewer-missing-validation-record', 'validation_record'],
]) {
  test(`fixture ${dir}: fails and names ${primitive}`, () => {
    const { out } = lint(join(FIXTURES, dir));
    assert.ok(out.length > 0, `expected a failure for ${dir}`);
    assert.ok(out.some((l) => l.includes(primitive)), `expected mention of ${primitive} in output\n  got: ${out.join('\n')}`);
  });
}

test('local agent overrides retain workflow primitives', (t) => {
  const { out, checked } = lint(join(ROOT, '..', '.claude', 'agents'));
  assert.deepEqual(out, [], out.join('\n'));
  t.diagnostic(checked.length ? `local-agent-primitives: OK (checked: ${checked.join(' ')})` : 'local-agent-primitives: OK (no local overrides found — skipped)');
});
