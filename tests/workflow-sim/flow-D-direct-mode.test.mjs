// Flow D — Direct Mode (FLOWS.md §D)
//
// Trajectory: bro receives a trivial single-file ≤3-line ask. Detects scope
// matches Direct Mode preconditions (single file, ≤3 lines, no public API,
// no docs/architecture/ touched, no test required). Edits the file directly,
// commits, and logs `event_type='direct_mode_used'` to the ledger.
//
// Key: NO issue_create, NO task_create_batch, NO SWE spawn. Bro acts as both
// planner and editor for this narrow case. The audit trail lives entirely in
// `ledger`, not in `tasks` / `validation_attempts`.
//
// Asserts: bro can write a direct_mode_used event without an issue context;
// the ledger filter / report tools surface this event distinctly from the
// regular workflow events.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from '../mcp-integration/harness.mjs';

test('Flow D — Direct Mode: bro logs direct_mode_used to ledger; no issue/task created', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  await call(client, 'identity_set', { agent: 'bro', human_name: 'Test' });

  // Direct Mode requires an issue scope to attach the ledger event to (the
  // ledger is per-issue). Bro creates a trivial issue first, logs the event,
  // and immediately closes it. The discipline is the brevity of the issue,
  // not the absence of one.
  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'Direct Mode: typo fix in README.md',
    description: 'Single-line typo, no API/test/architecture impact.',
  });
  assert.equal(issue.ok, true);
  const issueId = issue.data.id;

  // The defining event of Direct Mode
  const direct = await call(client, 'ledger_log', {
    agent: 'bro', issue_id: issueId, branch_id: 'chore/typo',
    from_node: 'bro',
    event_type: 'direct_mode_used',
    summary: 'Direct Mode: fixed "recieve" → "receive" in README.md (1 line, 1 file).',
  });
  assert.equal(direct.ok, true);

  // Bro closes the issue right away — no task, no SWE, no validation needed
  const closed = await call(client, 'issue_close', { agent: 'bro', issue_id: issueId });
  assert.equal(closed.ok, true);

  // Confirm: NO task rows for this issue
  const fresh = await call(client, 'issue_get', { agent: 'bro', issue_id: issueId });
  assert.equal(fresh.data.status, 'closed');

  // Ledger has exactly one direct_mode_used event for this issue
  const ledger = await call(client, 'ledger_list', { agent: 'bro', issue_id: issueId });
  assert.equal(ledger.ok, true);
  const direct_events = ledger.data.filter(e => e.event_type === 'direct_mode_used');
  assert.equal(direct_events.length, 1, 'exactly one direct_mode_used event recorded');
  assert.match(direct_events[0].summary, /Direct Mode/);

  // No validation_attempts rows possible (no task to validate)
  // (We don't query because validation_history needs a task_id.)
});
