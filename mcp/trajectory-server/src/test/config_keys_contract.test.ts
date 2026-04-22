import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDB } from './helpers.js';
import { configTools } from '../tools/config.js';

const docsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../docs/CONFIG_KEYS.md',
);

const docContent = readFileSync(docsPath, 'utf8');

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const handler = handlers[name];
  assert.ok(handler, `Handler not found: ${name}`);
  return handler(args) as unknown as RawResult;
}

describe('config_keys_contract', () => {
  it('docs/CONFIG_KEYS.md names all three registered keys', () => {
    assert.ok(docContent.includes('branching_model'), 'branching_model missing from docs');
    assert.ok(docContent.includes('pr_target'), 'pr_target missing from docs');
    assert.ok(docContent.includes('protected_branches'), 'protected_branches missing from docs');
  });

  it('docs/CONFIG_KEYS.md names all three branching_model values', () => {
    assert.ok(docContent.includes('github-flow'), 'github-flow missing from docs');
    assert.ok(docContent.includes('gitflow'), 'gitflow missing from docs');
    assert.ok(docContent.includes('custom'), 'custom missing from docs');
  });

  it('round-trips branching_model = "github-flow" (string)', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { key: 'branching_model', value: 'github-flow' });
    const result = await call(tools.handlers, 'config_get', { key: 'branching_model' });
    assert.ok(!result.isError);
    const value = parseResult(result);
    assert.equal(typeof value, 'string');
    assert.equal(value, 'github-flow');

    db.close();
  });

  it('round-trips pr_target = "main" (string)', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { key: 'pr_target', value: 'main' });
    const result = await call(tools.handlers, 'config_get', { key: 'pr_target' });
    assert.ok(!result.isError);
    const value = parseResult(result);
    assert.equal(typeof value, 'string');
    assert.equal(value, 'main');

    db.close();
  });

  it('round-trips protected_branches = ["main"] (array)', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { key: 'protected_branches', value: ['main'] });
    const result = await call(tools.handlers, 'config_get', { key: 'protected_branches' });
    assert.ok(!result.isError);
    const value = parseResult(result);
    assert.ok(Array.isArray(value), 'protected_branches must be an array');
    assert.deepEqual(value, ['main']);

    db.close();
  });
});
