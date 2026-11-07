// L1 lint: guards the #300 Architect→SWE handoff on the shipped agents: agents/swe.md and agents/code-reviewer.md reference task_brief, and swe's tools: line lists neither task_get nor discussion_search, so swe reads its task context only through task_brief.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RETIRED = ['task_get', 'discussion_search'];

export function contractProblems(root) {
  const problems = [];
  for (const agent of ['swe', 'code-reviewer']) {
    const f = `agents/${agent}.md`;
    if (!existsSync(join(root, f))) {
      problems.push(`agent-task-brief-contract: ${f} missing`);
      continue;
    }
    if (!/(^|[^A-Za-z0-9_])task_brief([^A-Za-z0-9_]|$)/m.test(readFileSync(join(root, f), 'utf8'))) {
      problems.push(`agent-task-brief-contract: ${f} does not reference task_brief — #300 handoff contract broken`);
    }
  }
  const swe = join(root, 'agents', 'swe.md');
  const sweTools = existsSync(swe) ? (readFileSync(swe, 'utf8').split('\n').find((l) => l.startsWith('tools:')) ?? '') : '';
  for (const retired of RETIRED) {
    if (sweTools.includes(retired)) {
      problems.push(`agent-task-brief-contract: swe tools: line lists retired read tool "${retired}" — context goes through task_brief only (#300)`);
    }
  }
  return problems;
}

test('a missing agent, a body without task_brief and a retired swe tool are each caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-agent-task-brief-contract-'));
  try {
    mkdirSync(join(dir, 'agents'));
    writeFileSync(join(dir, 'agents', 'swe.md'), '---\ntools: Read, mcp__x__task_get, mcp__x__discussion_search\n---\nRead the task_briefing notes.\n');
    assert.deepEqual(contractProblems(dir), [
      'agent-task-brief-contract: agents/swe.md does not reference task_brief — #300 handoff contract broken',
      'agent-task-brief-contract: agents/code-reviewer.md missing',
      'agent-task-brief-contract: swe tools: line lists retired read tool "task_get" — context goes through task_brief only (#300)',
      'agent-task-brief-contract: swe tools: line lists retired read tool "discussion_search" — context goes through task_brief only (#300)',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shipped swe and code-reviewer keep the task_brief contract', () => {
  const problems = contractProblems(ROOT);
  assert.deepEqual(problems, [], `${problems.join('\n')}\n\nagent-task-brief-contract: FAIL`);
});
