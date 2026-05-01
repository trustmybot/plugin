// Layer 2 integration: verify issue_create returns a single, unambiguous id field.
// Related to the dogfood bug where issue_create returned `{ id: 1, issue_string_id: "iss_..." }`
// and main Claude used the wrong one, causing 2 ghost discussion_append calls.
//
// Also verifies the discussions table invariant: kind='answer' rows must
// follow a kind='question' row for the same issue (chronologically). This
// structural test complements the prompt-level scope-ambiguity gate in
// tmb_planning-simple/-difficult — they can't catch "bro skipped asking" (that's
// LLM behavior, Layer 3), but it catches schema/contract regressions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from './harness.mjs';

test('issue_create returns a single id (no issue_string_id ghost field)', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const result = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'smoke',
    description: 'x',
  });

  assert.equal(result.ok, true, `issue_create: ${JSON.stringify(result)}`);
  assert.ok(typeof result.data.id === 'number', `id must be number; got ${typeof result.data.id}`);
  assert.equal(
    'issue_string_id' in result.data,
    false,
    'issue_create must NOT return issue_string_id — it caused main Claude to use wrong ID field',
  );
});

test('discussion_append chronology: answer rows have a preceding question row', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'chronology test',
    description: 'x',
  });
  const issueId = issue.data.id;

  // Valid sequence: note → question → answer → decision.
  for (const entry of [
    { kind: 'note',     author: 'architect', body: 'Triage' },
    { kind: 'question', author: 'architect', body: 'Which lib?\n1. argparse\n2. click' },
    { kind: 'answer',   author: 'human',     body: '1', verified_human: true },
    { kind: 'decision', author: 'architect', body: 'Going with argparse' },
  ]) {
    const res = await call(client, 'discussion_append', {
      agent: 'bro',
      issue_id: issueId,
      ...entry,
    });
    assert.equal(res.ok, true, `append ${entry.kind}: ${JSON.stringify(res)}`);
  }

  const listed = await call(client, 'discussion_list', {
    agent: 'bro', issue_id: issueId,
  });
  assert.equal(listed.ok, true);
  const rows = Array.isArray(listed.data) ? listed.data : listed.data.discussions ?? [];

  // Every 'answer' must have a 'question' earlier in the same issue.
  const answers = rows.filter((r) => r.kind === 'answer');
  const questionIdx = rows.reduce(
    (acc, r, i) => { if (r.kind === 'question') acc.push(i); return acc; },
    [],
  );
  for (const a of answers) {
    const aIdx = rows.indexOf(a);
    assert.ok(
      questionIdx.some((qi) => qi < aIdx),
      `answer row at index ${aIdx} has no preceding question`,
    );
  }

  // Every 'decision' on a plan-shaping issue SHOULD have at least one
  // question somewhere earlier. We can't enforce "must" here because
  // truly trivial tasks skip alignment — but we verify the positive
  // sequence worked.
  const decisions = rows.filter((r) => r.kind === 'decision');
  assert.equal(decisions.length, 1);
  assert.ok(questionIdx.length >= 1, 'expected at least one question row to precede the decision');
});

test('task_create_batch — rejects when issue has 0 question rows and no waiver', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'gate test — no questions seeded',
    description: 'x',
  });
  const issueId = issue.data.id;

  // Only a note, no question rows → gate must fire.
  await call(client, 'discussion_append', {
    agent: 'bro',
    issue_id: issueId,
    kind: 'note',
    author: 'architect',
    body: 'Triage: simple',
  });

  const attempt = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    tasks: [{ branch_id: 'feat/gate-fail', description: 'd', success_criteria: 'x' }],
  });

  assert.equal(attempt.ok, false, 'must be rejected');
  assert.equal(attempt.error?.error, 'scope_gate_violation');
  assert.equal(attempt.error?.questions_found, 0);
});

test('task_create_batch — accepts when a kind=question row exists', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'gate test — questions seeded',
    description: 'x',
  });
  const issueId = issue.data.id;

  await call(client, 'discussion_append', {
    agent: 'bro',
    issue_id: issueId,
    kind: 'question',
    author: 'architect',
    body: 'Which lib?',
  });
  await call(client, 'discussion_append', {
    agent: 'bro',
    issue_id: issueId,
    kind: 'answer',
    author: 'human',
    body: 'argparse',
    verified_human: true,
  });

  const attempt = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    tasks: [{ branch_id: 'feat/gate-ok', description: 'd', success_criteria: 'x' }],
  });

  assert.equal(attempt.ok, true, `should be accepted with question present: ${JSON.stringify(attempt)}`);
});

test('task_create_batch — accepts with waiver + reason ≥10 chars', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'typo fix',
    description: 'x',
  });
  const issueId = issue.data.id;

  const attempt = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'typo in README line 12; no interpretation needed',
    tasks: [{ branch_id: 'fix/readme-typo', description: 'fix recieve', success_criteria: 'green spellcheck' }],
  });

  assert.equal(attempt.ok, true, `waiver with valid reason must be accepted: ${JSON.stringify(attempt)}`);
});

test('task_create_batch — rejects waiver with missing/short reason', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'trivial',
    description: 'x',
  });
  const issueId = issue.data.id;

  // Missing reason
  const noReason = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    waive_scope_gate: true,
    tasks: [{ branch_id: 'fix/x', description: 'd', success_criteria: 'x' }],
  });
  assert.equal(noReason.ok, false);
  assert.match(noReason.error?.error ?? '', /waive_scope_gate_reason/);

  // Too-short reason (<10 chars)
  const shortReason = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'short',
    tasks: [{ branch_id: 'fix/x', description: 'd', success_criteria: 'x' }],
  });
  assert.equal(shortReason.ok, false);
  assert.match(shortReason.error?.error ?? '', /≥10|>=10|\b10 chars\b/);
});
