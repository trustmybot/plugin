import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { issueTools } from '../tools/issues.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const handler = handlers[name];
  assert.ok(handler, `Handler not found: ${name}`);
  return handler(args) as unknown as RawResult;
}

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

async function seedIssue(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  description = 'short desc',
) {
  const result = await call(handlers, 'issue_create', {
    labels: ['Bug', 'Priority: High'],
    agent: 'bro',
    objective: 'seed issue',
    description,
  });
  return parseResult(result as RawResult);
}

describe('issue_update_description', () => {
  it('happy path — updates description and advances updated_at', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const issue = await seedIssue(tools.handlers, 'original description');
    const originalUpdatedAt = issue.updated_at;

    await new Promise((r) => setTimeout(r, 5));

    const result = await call(tools.handlers, 'issue_update_description', {
      agent: 'bro',
      issue_id: String(issue.id),
      description: 'updated full description with lots more content',
    });
    assert.ok(!result.isError, `Expected no error, got: ${JSON.stringify(parseResult(result))}`);
    const updated = parseResult(result);
    assert.equal(updated.description, 'updated full description with lots more content');
    assert.ok(
      updated.updated_at >= originalUpdatedAt,
      `updated_at should be >= original: ${updated.updated_at} vs ${originalUpdatedAt}`,
    );

    db.close();
  });

  it('missing issue — returns clear not_found error', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_update_description', {
      agent: 'bro',
      issue_id: '99999',
      description: 'does not matter',
    });
    assert.ok(result.isError, 'Should be an error result');
    const data = parseResult(result);
    assert.match(data.error, /not_found/);

    db.close();
  });

  it('empty description is allowed — sets to empty string', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const issue = await seedIssue(tools.handlers, 'some content');

    const result = await call(tools.handlers, 'issue_update_description', {
      agent: 'bro',
      issue_id: String(issue.id),
      description: '',
    });
    assert.ok(!result.isError, `Expected no error, got: ${JSON.stringify(parseResult(result))}`);
    const updated = parseResult(result);
    assert.equal(updated.description, '');

    db.close();
  });

  it('oversize description (>1MB) is rejected with clear error', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const issue = await seedIssue(tools.handlers);
    const oversizeDescription = 'a'.repeat(1024 * 1024 + 1);

    const result = await call(tools.handlers, 'issue_update_description', {
      agent: 'bro',
      issue_id: String(issue.id),
      description: oversizeDescription,
    });
    assert.ok(result.isError, 'Should be an error result for oversize description');
    const data = parseResult(result);
    assert.match(data.error, /1MB/);

    db.close();
  });

  it('role enforcement — bro passes, others are forbidden', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const issue = await seedIssue(tools.handlers);

    for (const wrongRole of ['swe', 'architect', 'pr-reviewer', 'unknown']) {
      const result = await call(tools.handlers, 'issue_update_description', {
        agent: wrongRole,
        issue_id: String(issue.id),
        description: 'attempted update',
      });
      assert.ok(result.isError, `${wrongRole} should be forbidden`);
      const data = parseResult(result);
      assert.equal(data.error, 'forbidden', `Expected forbidden for ${wrongRole}`);
    }

    const broResult = await call(tools.handlers, 'issue_update_description', {
      agent: 'bro',
      issue_id: String(issue.id),
      description: 'bro can update',
    });
    assert.ok(!broResult.isError, `bro should succeed, got: ${JSON.stringify(parseResult(broResult))}`);

    db.close();
  });
});
