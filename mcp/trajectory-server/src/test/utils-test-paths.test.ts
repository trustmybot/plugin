import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { configTools, readTestLaneConfig, WORLD_MODEL_TEST_LANE_KEY } from '../tools/config.js';
import {
  configureTestLane,
  DEFAULT_TEST_LANE,
  isDefaultTestPath,
  isTestBasename,
  isTestPath,
  laneOf,
  parseTestLaneConfig,
  testLaneClassifier,
} from '../utils/test-paths.js';

describe('GH 2282, GH 2886: the default test lane', () => {
  it('GH 2886: flags the per-language test conventions', () => {
    for (const p of [
      'pkg/foo_test.go',
      'app/test_foo.py',
      'app/foo_test.py',
      'app/conftest.py',
      'web/a.spec.ts',
      'spec/models/user_spec.rb',
      'e2e/login.ts',
      'src/test/java/FooTest.java',
      'src/test/helpers.ts',
      'pkg/tests/run.py',
      'web/__tests__/a.tsx',
      'src/fixtures/data.ts',
      'src/a.test.ts',
      'src/a.spec.tsx',
      'src/a.suite.ts',
      'win\\tests\\a.ts',
    ]) {
      assert.equal(isDefaultTestPath(p), true, p);
      assert.equal(isTestPath(p), true, p);
      assert.equal(laneOf(p), 'test', p);
    }
  });

  it('GH 2886: leaves product paths alone', () => {
    for (const p of [
      'pkg/foo.go',
      'app/foo.py',
      'src/testing_utils.ts',
      'latest/x.ts',
      'mcp/trajectory-server/src/brief-locations.ts',
      'src/testing-utils/latest.ts',
      'src/schema.ts',
      'contest/a.ts',
      'src/test-paths.ts',
      'spec.md',
    ]) {
      assert.equal(isDefaultTestPath(p), false, p);
      assert.equal(laneOf(p), 'product', p);
    }
  });

  it('GH 2886: the TMB-only schema-v rule is no longer a default', () => {
    for (const p of ['src/schema-v12/tables.ts', 'src/schema-v3.sql', 'src/schema-v41-fixture.ts']) {
      assert.equal(isDefaultTestPath(p), false, p);
    }
  });

  it('GH 2886: the basename rules ignore directories', () => {
    assert.equal(isTestBasename('tests/helper.ts'), false);
    assert.equal(isTestBasename('dist/test/a.test.js'), true);
    assert.equal(isTestBasename('tests/test_x.py'), true);
    assert.equal(isTestBasename('pkg/foo_test.go'), true);
  });
});

describe('GH 2886: world_model_test_lane config', () => {
  afterEach(() => configureTestLane(DEFAULT_TEST_LANE));

  it('GH 2886: extend adds paths and exclude removes default matches', () => {
    const isTest = testLaneClassifier({ extend: ['qa/**'], exclude: ['e2e/**'] });
    assert.equal(isTest('qa/smoke/run.ts'), true);
    assert.equal(isTest('e2e/login.ts'), false);
    assert.equal(isTest('pkg/foo_test.go'), true);
    assert.equal(isTest('pkg/foo.go'), false);
  });

  it('GH 2886: exclude wins over extend', () => {
    const isTest = testLaneClassifier({ extend: ['qa/**'], exclude: ['qa/keep.ts'] });
    assert.equal(isTest('qa/keep.ts'), false);
    assert.equal(isTest('qa/other.ts'), true);
  });

  it('GH 2886: the schema-v globs restore the GH 2282 rule', () => {
    const isTest = testLaneClassifier({ extend: ['**/schema-v*', '**/schema-v*/**'], exclude: [] });
    for (const p of ['src/schema-v12/tables.ts', 'src/schema-v3.sql', 'src/schema-v41-fixture.ts', 'schema-v2.sql']) {
      assert.equal(isTest(p), true, p);
    }
    assert.equal(isTest('src/schema.ts'), false);
  });

  it('GH 2886: configureTestLane sets what isTestPath answers', () => {
    configureTestLane({ extend: ['app/foo.py'], exclude: ['web/**'] });
    assert.equal(isTestPath('app/foo.py'), true);
    assert.equal(isTestPath('web/a.spec.ts'), false);
    assert.equal(isDefaultTestPath('app/foo.py'), false, 'the default rules stay unconfigured');
    configureTestLane(DEFAULT_TEST_LANE);
    assert.equal(isTestPath('app/foo.py'), false);
  });

  it('GH 2886: a malformed value reads as the defaults without throwing', () => {
    for (const bad of [null, 'qa/**', ['qa/**'], 42, { extend: 'qa/**' }, { extend: [1] }, { exclude: [''] }, { extend: [], other: [] }]) {
      assert.deepEqual(parseTestLaneConfig(bad), DEFAULT_TEST_LANE, JSON.stringify(bad));
    }
    assert.deepEqual(parseTestLaneConfig({ extend: ['qa/**'] }), { extend: ['qa/**'], exclude: [] });
  });

  it('GH 2886: readTestLaneConfig reads plugin_config and falls back on a bad stored value', () => {
    const db = tempDB();
    try {
      assert.deepEqual(readTestLaneConfig(db), DEFAULT_TEST_LANE);
      db.run(`INSERT INTO plugin_config (key, value_json) VALUES (?, ?)`, [WORLD_MODEL_TEST_LANE_KEY, '{not json']);
      assert.deepEqual(readTestLaneConfig(db), DEFAULT_TEST_LANE);
      db.run(`UPDATE plugin_config SET value_json = ? WHERE key = ?`, ['{"extend": 3}', WORLD_MODEL_TEST_LANE_KEY]);
      assert.deepEqual(readTestLaneConfig(db), DEFAULT_TEST_LANE);
      db.run(`UPDATE plugin_config SET value_json = ? WHERE key = ?`, ['{"extend": ["qa/**"], "exclude": ["e2e/**"]}', WORLD_MODEL_TEST_LANE_KEY]);
      assert.deepEqual(readTestLaneConfig(db), { extend: ['qa/**'], exclude: ['e2e/**'] });
    } finally {
      db.close();
    }
  });

  it('GH 2886: config_set refuses a malformed value and stores a valid one', async () => {
    const db = tempDB();
    try {
      const set = configTools(db).handlers['config_set'];
      const bad = await set({ agent: 'bro', key: WORLD_MODEL_TEST_LANE_KEY, value: { extend: 'qa/**' } });
      assert.equal(bad.isError, true);
      const good = await set({ agent: 'bro', key: WORLD_MODEL_TEST_LANE_KEY, value: { extend: ['qa/**'] } });
      assert.notEqual(good.isError, true, JSON.stringify(good));
      assert.deepEqual(readTestLaneConfig(db), { extend: ['qa/**'], exclude: [] });
    } finally {
      db.close();
    }
  });
});
