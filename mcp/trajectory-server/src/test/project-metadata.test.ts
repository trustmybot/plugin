import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDB } from './helpers.js';
import { projectMetadataTools } from '../tools/project-metadata.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PLUGIN_ROOT = join(__dirname, '..', '..', '..', '..', '..');

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

describe('projectMetadataTools', () => {
  it('project_metadata_get returns null before any detect', async () => {
    const db = tempDB();
    const tools = projectMetadataTools(db);

    const result = await call(tools.handlers, 'project_metadata_get', { agent: 'bro' });
    assert.ok(!result.isError, `Unexpected error: ${JSON.stringify(parseResult(result))}`);
    assert.equal(parseResult(result), null);

    db.close();
  });

  it('project_metadata_detect persists stack and returns detected + changed=true on first run', async () => {
    const db = tempDB();
    const tools = projectMetadataTools(db);

    const result = await call(tools.handlers, 'project_metadata_detect', {
      agent: 'bro',
      repo_path: PLUGIN_ROOT,
    });
    assert.ok(!result.isError, `Unexpected error: ${JSON.stringify(parseResult(result))}`);
    const data = parseResult(result);

    assert.ok('detected' in data, 'result must have detected field');
    assert.ok('changed' in data, 'result must have changed field');
    assert.ok('previous_detected_at' in data, 'result must have previous_detected_at field');
    assert.equal(data.changed, true, 'First run must return changed=true');
    assert.equal(data.previous_detected_at, null, 'First run: previous_detected_at must be null');

    const detected = data.detected as Record<string, unknown>;
    assert.ok(Array.isArray(detected['languages']), 'detected.languages must be an array');
    assert.ok(Array.isArray(detected['package_managers']), 'detected.package_managers must be an array');
    assert.ok(Array.isArray(detected['test_runners']), 'detected.test_runners must be an array');
    assert.ok(Array.isArray(detected['linters']), 'detected.linters must be an array');
    assert.ok(Array.isArray(detected['git_remotes']), 'detected.git_remotes must be an array');
    assert.ok(typeof detected['detector'] === 'string', 'detected.detector must be a string');
    assert.ok(typeof detected['detected_at'] === 'string', 'detected.detected_at must be a string');

    db.close();
  });

  it('project_metadata_get reads back what detect persisted', async () => {
    const db = tempDB();
    const tools = projectMetadataTools(db);

    await call(tools.handlers, 'project_metadata_detect', {
      agent: 'bro',
      repo_path: PLUGIN_ROOT,
    });

    const getResult = await call(tools.handlers, 'project_metadata_get', { agent: 'bro' });
    assert.ok(!getResult.isError, `Unexpected error: ${JSON.stringify(parseResult(getResult))}`);
    const data = parseResult(getResult);
    assert.ok(data !== null, 'get must return non-null after detect');
    assert.ok(Array.isArray(data['languages']), 'returned object must have languages array');

    db.close();
  });

  it('project_metadata_detect returns changed=false on second identical run', async () => {
    const db = tempDB();
    const tools = projectMetadataTools(db);

    await call(tools.handlers, 'project_metadata_detect', {
      agent: 'bro',
      repo_path: PLUGIN_ROOT,
    });

    const result2 = await call(tools.handlers, 'project_metadata_detect', {
      agent: 'bro',
      repo_path: PLUGIN_ROOT,
    });
    const data2 = parseResult(result2);

    assert.equal(data2.changed, false, 'Second run on same repo must return changed=false');
    assert.ok(typeof data2.previous_detected_at === 'string', 'previous_detected_at must be a string on second run');

    db.close();
  });

  it('project_metadata_detect is bro-only — swe is forbidden', async () => {
    const db = tempDB();
    const tools = projectMetadataTools(db);

    const result = await call(tools.handlers, 'project_metadata_detect', {
      agent: 'swe',
      repo_path: PLUGIN_ROOT,
    });
    assert.ok(result.isError, 'Expected forbidden for swe');
    const data = parseResult(result);
    assert.equal(data.error, 'forbidden');
    assert.equal(data.caller_role, 'swe');

    db.close();
  });

  it('project_metadata_detect is bro-only — consultant (architect) is forbidden', async () => {
    const db = tempDB();
    const tools = projectMetadataTools(db);

    const result = await call(tools.handlers, 'project_metadata_detect', {
      agent: 'architect',
      repo_path: PLUGIN_ROOT,
    });
    assert.ok(result.isError, 'Expected forbidden for consultant');
    const data = parseResult(result);
    assert.equal(data.error, 'forbidden');
    assert.equal(data.caller_role, 'consultant');

    db.close();
  });

  it('project_metadata_get is accessible to swe', async () => {
    const db = tempDB();
    const tools = projectMetadataTools(db);

    const result = await call(tools.handlers, 'project_metadata_get', { agent: 'swe' });
    assert.ok(!result.isError, `Expected swe to be allowed: ${JSON.stringify(parseResult(result))}`);

    db.close();
  });

  it('project_metadata_get is accessible to pr-reviewer', async () => {
    const db = tempDB();
    const tools = projectMetadataTools(db);

    const result = await call(tools.handlers, 'project_metadata_get', { agent: 'pr-reviewer' });
    assert.ok(!result.isError, `Expected pr-reviewer to be allowed: ${JSON.stringify(parseResult(result))}`);

    db.close();
  });

  it('project_metadata_get consultant equivalence — cto and legal-reviewer both succeed', async () => {
    const db = tempDB();
    const tools = projectMetadataTools(db);

    for (const agent of ['cto', 'legal-reviewer']) {
      const result = await call(tools.handlers, 'project_metadata_get', { agent });
      assert.ok(
        !result.isError,
        `Expected ${agent} (consultant) to be allowed: ${JSON.stringify(parseResult(result))}`,
      );
    }

    db.close();
  });
});
