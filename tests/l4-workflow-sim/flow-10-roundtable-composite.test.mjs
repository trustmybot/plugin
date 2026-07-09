// Flow 10 — Roundtable composite (roundtable_close_with_decisions)
//
// Trajectory: bro creates an issue → seeds the slash gate → creates a
// roundtable → records participant votes (state auto-flips to awaiting_human)
// → calls roundtable_close_with_decisions (composite) → asserts the roundtable
// is closed and the canonical summary is returned in one call.
//
// Validates the composite collapses finalize_decisions + close + summarize
// correctly and that the individual originals remain callable on a separate
// roundtable (backwards-compat check).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from '../l3-integration/mcp/harness.mjs';

test('Flow 10 — roundtable_close_with_decisions composite: create→vote→composite-close', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // 1. bro creates a carrier issue
  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'Decide on new architecture approach',
    description: 'Roundtable composite test carrier.',
    labels: ['Feature', 'Priority: Medium'],
  });
  assert.equal(issue.ok, true, `issue_create: ${JSON.stringify(issue)}`);
  const issueId = issue.data.id;

  // 2. Seed a fresh slash-invoke audit row (gate consumed by roundtable_create)
  const slashSeed = await call(client, 'audit_append', {
    agent: 'bro',
    issue_id: issueId,
    from_node: 'system',
    event_type: 'roundtable_slash_invoked',
    summary: 'flow-10 fixture: gate cleared',
  });
  assert.equal(slashSeed.ok, true, `slash gate seed: ${JSON.stringify(slashSeed)}`);

  // 3. bro creates a roundtable (2 expected participants)
  const rt = await call(client, 'roundtable_create', {
    agent: 'bro',
    issue_id: issueId,
    topic: 'Microservices vs monolith for v2',
    expected_participants: 2,
  });
  assert.equal(rt.ok, true, `roundtable_create: ${JSON.stringify(rt)}`);
  const roundtableId = rt.data.roundtable_id;
  assert.ok(typeof roundtableId === 'number' && roundtableId > 0, 'roundtable_id must be a positive number');
  assert.equal(rt.data.state, 'collecting', 'initial state must be collecting');

  // 4. First participant votes (state stays collecting)
  const v1 = await call(client, 'roundtable_vote', {
    agent: 'bro',
    roundtable_id: roundtableId,
    participant: 'ceo',
    vote: 'microservices',
    rationale: 'Scales independently per service.',
  });
  assert.equal(v1.ok, true, `vote ceo: ${JSON.stringify(v1)}`);
  assert.equal(v1.data.state, 'collecting', 'Still collecting after 1st participant');

  // 5. Second participant votes (state auto-flips to awaiting_human)
  const v2 = await call(client, 'roundtable_vote', {
    agent: 'bro',
    roundtable_id: roundtableId,
    participant: 'cto',
    vote: 'monolith-first',
    rationale: 'Lower operational complexity for current scale.',
  });
  assert.equal(v2.ok, true, `vote cto: ${JSON.stringify(v2)}`);
  assert.equal(v2.data.state, 'awaiting_human', 'State must flip to awaiting_human after Nth participant');

  // 6. Call the composite — collapses finalize_decisions + close + summarize
  const composite = await call(client, 'roundtable_close_with_decisions', {
    agent: 'bro',
    roundtable_id: roundtableId,
    outcome: 'Human chose microservices-first with CTO caveat to reassess at 50k users.',
    decisions: {
      ratified: ['Use TypeScript for all new services', 'Adopt shared auth library'],
      unratified: ['Rewrite existing monolith immediately'],
      resolutions: [
        {
          topic_slug: 'arch',
          winning_stance: 'microservices',
          dissenter: 'cto',
          rationale: 'CTO preferred monolith but deferred to CEO + Human.',
        },
      ],
    },
  });
  assert.equal(composite.ok, true, `roundtable_close_with_decisions: ${JSON.stringify(composite)}`);

  // 7. Assert composite response shape
  const cd = composite.data;
  assert.equal(cd.roundtable_id, roundtableId, 'roundtable_id must match');
  assert.equal(cd.state, 'closed', 'state must be closed');
  assert.ok(cd.closed_at, 'closed_at must be set');
  assert.equal(cd.discussion_rows_written, 6, '2 ratified * 2 rows + 1 unratified + 1 resolution = 6');
  assert.equal(cd.vote_rows_written, 3, '2 ratified + 1 resolution = 3');

  // 8. Assert canonical summary is embedded in the composite response
  const summary = cd.summary;
  assert.ok(summary, 'summary must be present');
  assert.equal(summary.topic, 'Microservices vs monolith for v2');
  assert.ok(Array.isArray(summary.participants), 'participants must be an array');
  assert.ok(Array.isArray(summary.agreements_ratified), 'agreements_ratified must be an array');
  assert.ok(summary.agreements_ratified.includes('Use TypeScript for all new services'), 'ratified agreement present');
  assert.ok(summary.agreements_ratified.includes('Adopt shared auth library'), 'second ratified agreement present');
  assert.ok(Array.isArray(summary.unratified), 'unratified must be an array');
  assert.ok(summary.unratified.includes('Rewrite existing monolith immediately'), 'unratified item present');
  assert.ok(Array.isArray(summary.disagreements_resolved), 'disagreements_resolved must be an array');
  assert.equal(summary.disagreements_resolved.length, 1, 'one resolution');
  assert.ok(summary.outcome, 'outcome must be set');

  // 9. Verify the original three tools still work on a separate roundtable (backwards compat)
  const slashSeed2 = await call(client, 'audit_append', {
    agent: 'bro',
    issue_id: issueId,
    from_node: 'system',
    event_type: 'roundtable_slash_invoked',
    summary: 'flow-10 backwards-compat fixture',
  });
  assert.equal(slashSeed2.ok, true);

  const rt2 = await call(client, 'roundtable_create', {
    agent: 'bro',
    issue_id: issueId,
    topic: 'Backwards compat check',
    expected_participants: 2,
  });
  assert.equal(rt2.ok, true);
  const rt2Id = rt2.data.roundtable_id;

  await call(client, 'roundtable_vote', { agent: 'bro', roundtable_id: rt2Id, participant: 'ceo', vote: 'yes' });
  await call(client, 'roundtable_vote', { agent: 'bro', roundtable_id: rt2Id, participant: 'cto', vote: 'yes' });

  const finalize = await call(client, 'roundtable_finalize_decisions', {
    agent: 'bro',
    roundtable_id: rt2Id,
    ratified: ['Keep existing approach'],
    unratified: [],
    resolutions: [],
  });
  assert.equal(finalize.ok, true, `finalize_decisions: ${JSON.stringify(finalize)}`);

  const closeOrig = await call(client, 'roundtable_close', {
    agent: 'bro',
    roundtable_id: rt2Id,
    outcome: 'Status quo maintained.',
  });
  assert.equal(closeOrig.ok, true, `original close: ${JSON.stringify(closeOrig)}`);
  assert.equal(closeOrig.data.state, 'closed');

  const summarize = await call(client, 'roundtable_summarize', {
    agent: 'bro',
    roundtable_id: rt2Id,
  });
  assert.equal(summarize.ok, true, `summarize: ${JSON.stringify(summarize)}`);
  assert.equal(summarize.data.state, 'closed');

  // 10. Gate: composite rejects when state != awaiting_human
  const slashSeed3 = await call(client, 'audit_append', {
    agent: 'bro',
    issue_id: issueId,
    from_node: 'system',
    event_type: 'roundtable_slash_invoked',
    summary: 'flow-10 state gate fixture',
  });
  assert.equal(slashSeed3.ok, true);

  const rt3 = await call(client, 'roundtable_create', {
    agent: 'bro',
    issue_id: issueId,
    topic: 'State gate test',
    expected_participants: 2,
  });
  assert.equal(rt3.ok, true);
  const rt3Id = rt3.data.roundtable_id;

  const badComposite = await call(client, 'roundtable_close_with_decisions', {
    agent: 'bro',
    roundtable_id: rt3Id,
    outcome: 'Should be rejected',
    decisions: {
      ratified: ['something'],
      unratified: [],
      resolutions: [],
    },
  });
  assert.equal(badComposite.ok, false, 'Composite must reject when state=collecting');
  assert.ok(
    badComposite.error?.error?.includes('invalid_state') ||
    JSON.stringify(badComposite).includes('invalid_state'),
    `Must return invalid_state error: ${JSON.stringify(badComposite)}`,
  );
});
