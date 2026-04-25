import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { ledgerTools } from '../tools/ledger.js';
import { issueTools } from '../tools/issues.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  return (await handlers[name]!(args)) as RawResult;
}

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

async function createIssue(db: ReturnType<typeof tempDB>): Promise<number> {
  const tools = issueTools(db);
  const result = await call(tools.handlers, 'issue_create', {
    agent: 'bro',
    objective: 'Ledger test issue',
  });
  const data = parseResult(result);
  return data.id as number;
}

describe('ledgerTools', () => {
  it('ledger_log inserts a row with auto timestamp', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = ledgerTools(db);

    const before = new Date().toISOString();
    const result = await call(tools.handlers, 'ledger_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'swe',
      event_type: 'task_started',
      summary: 'SWE started working',
      content_json: JSON.stringify({ detail: 'context' }),
    });
    const after = new Date().toISOString();

    const entry = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(entry)}`);
    assert.equal(entry.issue_id, issueId);
    assert.equal(entry.from_node, 'swe');
    assert.equal(entry.event_type, 'task_started');
    assert.equal(entry.summary, 'SWE started working');
    assert.ok(entry.created_at >= before && entry.created_at <= after);

    db.close();
  });

  it('ledger_list paginates with limit and offset', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = ledgerTools(db);

    for (let i = 0; i < 5; i++) {
      await call(tools.handlers, 'ledger_log', {
        agent: 'bro',
        issue_id: String(issueId),
        from_node: 'swe',
        event_type: 'step',
        summary: `Step ${i}`,
      });
    }

    const page1Result = await call(tools.handlers, 'ledger_list', {
      agent: 'bro',
      issue_id: String(issueId),
      limit: 2,
      offset: 0,
    });
    const page1 = parseResult(page1Result);
    assert.ok(!page1Result.isError);
    assert.equal(page1.length, 2);
    assert.equal(page1[0].summary, 'Step 0');
    assert.equal(page1[1].summary, 'Step 1');

    const page2Result = await call(tools.handlers, 'ledger_list', {
      agent: 'bro',
      issue_id: String(issueId),
      limit: 2,
      offset: 2,
    });
    const page2 = parseResult(page2Result);
    assert.equal(page2.length, 2);
    assert.equal(page2[0].summary, 'Step 2');
    assert.equal(page2[1].summary, 'Step 3');

    db.close();
  });

  it('ledger_log with oversized content persists is_truncated = 1', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = ledgerTools(db);

    const bigContent = JSON.stringify({ data: 'x'.repeat(1_100_000) });

    const result = await call(tools.handlers, 'ledger_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'swe',
      event_type: 'large_event',
      summary: 'Oversized content',
      content_json: bigContent,
    });
    const entry = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(entry)}`);
    assert.equal(entry.is_truncated, 1, 'is_truncated should be 1 for oversized content');
    assert.ok(entry.content.length < bigContent.length, 'content should be truncated');

    db.close();
  });

  it('ledger_list returns is_truncated flag from persisted row', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = ledgerTools(db);

    const bigContent = JSON.stringify({ data: 'y'.repeat(1_100_000) });

    await call(tools.handlers, 'ledger_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'swe',
      event_type: 'large_event',
      summary: 'Truncated row',
      content_json: bigContent,
    });

    await call(tools.handlers, 'ledger_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'swe',
      event_type: 'small_event',
      summary: 'Normal row',
    });

    const listResult = await call(tools.handlers, 'ledger_list', {
      agent: 'bro',
      issue_id: String(issueId),
    });
    const entries = parseResult(listResult);
    assert.ok(!listResult.isError);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].is_truncated, 1, 'first row is_truncated should be 1');
    assert.equal(entries[1].is_truncated, 0, 'second row is_truncated should be 0');

    db.close();
  });

  it('ledger_list filtered by branch_id returns only matching rows', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = ledgerTools(db);

    await call(tools.handlers, 'ledger_log', {
      agent: 'bro',
      issue_id: String(issueId),
      branch_id: '1.1',
      from_node: 'swe',
      event_type: 'start',
      summary: 'Branch 1.1 entry',
    });

    await call(tools.handlers, 'ledger_log', {
      agent: 'bro',
      issue_id: String(issueId),
      branch_id: '1.2',
      from_node: 'architect',
      event_type: 'start',
      summary: 'Branch 1.2 entry',
    });

    await call(tools.handlers, 'ledger_log', {
      agent: 'bro',
      issue_id: String(issueId),
      branch_id: '1.1',
      from_node: 'swe',
      event_type: 'complete',
      summary: 'Branch 1.1 second entry',
    });

    const result = await call(tools.handlers, 'ledger_list', {
      agent: 'bro',
      issue_id: String(issueId),
      branch_id: '1.1',
    });
    const entries = parseResult(result);
    assert.ok(!result.isError);
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e: { branch_id: string }) => e.branch_id === '1.1'));

    db.close();
  });
});
