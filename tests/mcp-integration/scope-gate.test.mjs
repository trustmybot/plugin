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
    tasks: [{ branch_id: 'feat/gate-fail', description: 'd' }],
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
    waive_branch_gate: true,
    waive_branch_gate_reason: 'scope-gate test; branch gate not under test in this case',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'scope-gate test; intent gate not under test in this case',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'scope-gate test; decision gate not under test in this case',
    tasks: [{ branch_id: 'feat/gate-ok', description: 'd' }],
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
    waive_branch_gate: true,
    waive_branch_gate_reason: 'scope-gate test; branch gate not under test in this case',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'scope-gate test; intent gate not under test in this case',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'scope-gate test; decision gate not under test in this case',
    tasks: [{ branch_id: 'fix/readme-typo', description: 'fix recieve' }],
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
    tasks: [{ branch_id: 'fix/x', description: 'd' }],
  });
  assert.equal(noReason.ok, false);
  assert.match(noReason.error?.error ?? '', /waive_scope_gate_reason/);

  // Too-short reason (<10 chars)
  const shortReason = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'short',
    tasks: [{ branch_id: 'fix/x', description: 'd' }],
  });
  assert.equal(shortReason.ok, false);
  assert.match(shortReason.error?.error ?? '', /≥10|>=10|\b10 chars\b/);
});

// --- Registry-cold gate: ensures /scan ran before tasks land. The pre-seed
// in startClient() clears it; tests below use a custom client without the
// pre-seed to verify the gate's reject + waive paths.
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

async function startClientUnseeded() {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SERVER_DIST = path.resolve(HERE, '../../mcp/trajectory-server/dist/index.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_DIST],
    env: { ...process.env, TRAJECTORY_DB_PATH: ':memory:' },
  });
  const client = new Client({ name: 'tmb-gate-test', version: '1.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, async close() { await client.close(); } };
}

test('task_create_batch — registry_cold_gate rejects when no deep_scan_completed audit exists', async (t) => {
  const { client, close } = await startClientUnseeded();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'gated',
    description: 'gate test',
  });
  assert.equal(issue.ok, true);

  const result = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issue.data.id,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'gate-test: scope-gate not under test here',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'gate-test: branch-gate not under test here',
    tasks: [{ branch_id: 'fix/gate', description: 'd' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.error, 'registry_cold_violation');
  assert.match(result.error.message, /\/scan/);
});

test('task_create_batch — registry_cold_gate clears after a deep_scan_completed audit lands', async (t) => {
  const { client, close } = await startClientUnseeded();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'unlock',
    description: 'gate clear test',
  });
  assert.equal(issue.ok, true);

  const seed = await call(client, 'audit_log', {
    agent: 'bro',
    issue_id: '-1',
    from_node: 'bro',
    event_type: 'deep_scan_completed',
    summary: 'manual seed (gate test)',
  });
  assert.equal(seed.ok, true);

  const result = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issue.data.id,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'gate-test: scope-gate not under test here',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'gate-test: branch-gate not under test here',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'gate-test: intent-gate not under test here',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'gate-test: triage-gate not under test here',
    tasks: [{ branch_id: 'fix/unlock', description: 'd' }],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.data));
  assert.equal(result.data.length, 1);
});

test('task_create_batch — waive_registry_gate accepts an explicit reason ≥10 chars', async (t) => {
  const { client, close } = await startClientUnseeded();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'waive',
    description: 'waive test',
  });
  assert.equal(issue.ok, true);

  const result = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issue.data.id,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'gate-test: scope-gate not under test here',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'gate-test: branch-gate not under test here',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'gate-test: intent-gate not under test here',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'gate-test: triage-gate not under test here',
    waive_registry_gate: true,
    waive_registry_gate_reason: 'scratch fixture; scan cannot run here',
    tasks: [{ branch_id: 'fix/waived', description: 'd' }],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('task_create_batch — waive_registry_gate rejects too-short reason', async (t) => {
  const { client, close } = await startClientUnseeded();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'waive-bad',
    description: 'waive too short',
  });
  assert.equal(issue.ok, true);

  const result = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issue.data.id,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'gate-test: scope-gate not under test here',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'gate-test: branch-gate not under test here',
    waive_registry_gate: true,
    waive_registry_gate_reason: 'short',
    tasks: [{ branch_id: 'fix/waived', description: 'd' }],
  });
  assert.equal(result.ok, false);
  assert.match(result.error.error ?? '', /waive_registry_gate_reason|≥10/);
});

// --- Intent + Triage + Decision-when-difficult gates on task_create_batch ---

test('task_create_batch — intent_gate rejects when no kind=intent discussion exists', async (t) => {
  const { client, close } = await startClient();  // pre-seeds deep_scan_completed
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'intent-gate test',
    description: 'x',
  });
  const issueId = issue.data.id;

  // Pre-seed scope-question + branch_id_proposed audit so those gates clear.
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, kind: 'question', author: 'architect', body: 'Which lib?',
  });
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, kind: 'answer', author: 'human', body: 'argparse', verified_human: true,
  });
  await call(client, 'audit_log', {
    agent: 'bro', issue_id: issueId, from_node: 'bro',
    event_type: 'branch_id_proposed', branch_id: 'feat/x', summary: 'proposed',
  });
  // Triage note exists so decision gate clears; intent does NOT.
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, kind: 'note', author: 'bro', body: 'Triage: simple',
  });

  const result = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    tasks: [{ branch_id: 'feat/x', description: 'd' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.error, 'intent_gate_violation');
});

test('task_create_batch — decision_gate rejects when no kind=decision discussion exists', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'decision-gate universal test',
    description: 'x',
  });
  const issueId = issue.data.id;

  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, kind: 'question', author: 'architect', body: 'Which lib?',
  });
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, kind: 'answer', author: 'human', body: 'argparse', verified_human: true,
  });
  await call(client, 'audit_log', {
    agent: 'bro', issue_id: issueId, from_node: 'bro',
    event_type: 'branch_id_proposed', branch_id: 'feat/x', summary: 'proposed',
  });
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, kind: 'intent', author: 'bro', body: 'Human intent verbatim: ...',
  });
  // No kind='decision' discussion seeded — universal decision gate must fire.

  const result = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    tasks: [{ branch_id: 'feat/x', description: 'd' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.error, 'decision_gate_violation');
});

test('task_create_batch — decision_gate clears when a kind=decision discussion exists', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'decision-gate clear test',
    description: 'x',
  });
  const issueId = issue.data.id;

  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, kind: 'question', author: 'architect', body: 'Which lib?',
  });
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, kind: 'answer', author: 'human', body: 'argparse', verified_human: true,
  });
  await call(client, 'audit_log', {
    agent: 'bro', issue_id: issueId, from_node: 'bro',
    event_type: 'branch_id_proposed', branch_id: 'feat/x', summary: 'proposed',
  });
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, kind: 'intent', author: 'bro', body: 'Human intent verbatim: ...',
  });
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, kind: 'decision', author: 'bro',
    body: 'Plan: use argparse for CLI parsing. Trade-offs: stdlib (no deps); single-file ergonomics.',
  });

  const result = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    tasks: [{ branch_id: 'feat/x', description: 'd' }],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

// --- Roundtable slash-invoke gate (#08) ---

test('roundtable_create — slash-invoke gate rejects when no /roundtable was typed', async (t) => {
  const { client, close } = await startClient();  // no slash-invoke audit seeded
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'roundtable gate test',
    description: 'x',
  });
  const issueId = issue.data.id;

  const result = await call(client, 'roundtable_create', {
    agent: 'bro',
    issue_id: issueId,
    topic: 'auto-fired without /roundtable',
    expected_participants: 3,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.error, 'roundtable_slash_gate_violation');
});

test('roundtable_create — slash-invoke gate clears after a /roundtable audit lands', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'roundtable gate clear test',
    description: 'x',
  });
  const issueId = issue.data.id;

  await call(client, 'audit_log', {
    agent: 'bro',
    issue_id: '-1',
    from_node: 'system',
    event_type: 'roundtable_slash_invoked',
    summary: 'manual seed (gate test)',
  });

  const result = await call(client, 'roundtable_create', {
    agent: 'bro',
    issue_id: issueId,
    topic: 'Postgres vs SQLite',
    expected_participants: 3,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(typeof result.data.roundtable_id === 'number');
});

test('roundtable_create — waive_slash_gate accepts an explicit reason ≥10 chars', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'waive test',
    description: 'x',
  });
  const issueId = issue.data.id;

  const result = await call(client, 'roundtable_create', {
    agent: 'bro',
    issue_id: issueId,
    topic: 'waived',
    expected_participants: 3,
    waive_slash_gate: true,
    waive_slash_gate_reason: 'integration test fixture, slash-invoke gate not under test',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});
