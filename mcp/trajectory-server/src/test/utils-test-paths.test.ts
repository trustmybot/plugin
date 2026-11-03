import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTestPath } from '../utils/test-paths.js';

describe('GH 2282: isTestPath', () => {
  it('GH 2282: flags each test or fixture pattern', () => {
    for (const p of [
      'src/test/helpers.ts',
      'pkg/tests/run.py',
      'web/__tests__/a.tsx',
      'src/fixtures/data.ts',
      'src/a.test.ts',
      'src/a.spec.tsx',
      'src/a.suite.ts',
      'src/schema-v12/tables.ts',
      'src/schema-v3.sql',
      'src/schema-v41-fixture.ts',
    ]) {
      assert.equal(isTestPath(p), true, p);
    }
  });

  it('GH 2282: leaves source paths alone', () => {
    assert.equal(isTestPath('mcp/trajectory-server/src/brief-locations.ts'), false);
    assert.equal(isTestPath('src/testing-utils/latest.ts'), false);
    assert.equal(isTestPath('src/schema.ts'), false);
  });
});
