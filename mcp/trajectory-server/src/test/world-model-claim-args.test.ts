import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { CLAIM_ARGS_SCHEMA, evalClaim } from '../world-model/concepts.js';
import { worldModelTools } from '../tools/world_model.js';
import { taskTools } from '../tools/tasks.js';
import { tempDB } from './helpers.js';

const REPO = 'r';
const FIELDS = ['path', 'qualified_name', 'from', 'to', 'table', 'writers', 'test_path'];

type Schema = { properties?: Record<string, Schema>; items?: Schema };

function claimArgs(tools: Tool[], name: string, path: string[]): Schema {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `${name} is defined`);
  let node = tool.inputSchema as Schema;
  for (const key of path) node = key === '[]' ? node.items! : node.properties![key]!;
  return node;
}

describe('concept claim args (GH 1840)', () => {
  let db: TrajectoryDB;

  before(() => {
    db = tempDB();
    const sym = (path: string, kind: string, name: string): number => {
      db.run(`INSERT INTO wm_symbols (repo, path, kind, qualified_name, body_hash) VALUES (?, ?, ?, ?, 'h')`, [REPO, path, kind, name]);
      return db.get<{ id: number }>(`SELECT id FROM wm_symbols WHERE repo = ? AND path = ? AND qualified_name = ?`, [REPO, path, name])!.id;
    };
    const edge = (src: number, dst: number, dstName: string, kind: string): void => {
      db.run(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution) VALUES (?, ?, ?, ?, 'exact')`, [src, dst, dstName, kind]);
    };
    const a = sym('src/a.ts', 'function', 'alpha');
    const b = sym('src/b.ts', 'function', 'beta');
    const table = sym('src/schema.sql', 'sql_table', 'things');
    const testFn = sym('src/test/a.test.ts', 'function', 'testAlpha');
    edge(a, b, 'beta', 'calls');
    edge(b, table, 'things', 'writes_table');
    edge(testFn, a, 'alpha', 'calls');
  });

  after(() => db.close());

  it('concept_upsert and task_update_status expose the one shared args schema', () => {
    const upsert = claimArgs(worldModelTools(db, null).definitions, 'world_model_concept_upsert', ['claims', '[]', 'args']);
    const report = claimArgs(taskTools(db).definitions, 'task_update_status', ['report', 'concepts', '[]', 'claims', '[]', 'args']);
    assert.equal(upsert, CLAIM_ARGS_SCHEMA);
    assert.equal(report, CLAIM_ARGS_SCHEMA);
    assert.deepEqual(Object.keys(CLAIM_ARGS_SCHEMA.properties).sort(), [...FIELDS].sort());
  });

  it('a wrong shape fails naming the field and its expected shape', () => {
    const fromString = evalClaim(db, REPO, 'calls', { from: 'src/a.ts', to: { path: 'src/b.ts', qualified_name: 'beta' } });
    assert.equal(fromString, 'fail: from must be {path, qualified_name}');
    assert.match(evalClaim(db, REPO, 'tested_by', { path: 'src/a.ts', qualified_name: 'alpha' }), /^fail: test_path must be /);
    assert.match(evalClaim(db, REPO, 'only_writers_of', { table: 'things', writers: 'src/b.ts' }), /^fail: writers must be /);
  });

  it('well-formed args evaluate as before', () => {
    const alpha = { path: 'src/a.ts', qualified_name: 'alpha' };
    const beta = { path: 'src/b.ts', qualified_name: 'beta' };
    const ghost = { path: 'src/a.ts', qualified_name: 'ghost' };

    assert.equal(evalClaim(db, REPO, 'exists', alpha), 'pass');
    assert.equal(evalClaim(db, REPO, 'exists', ghost), 'fail: no such symbol');

    assert.equal(evalClaim(db, REPO, 'calls', { from: alpha, to: beta }), 'pass');
    assert.equal(evalClaim(db, REPO, 'calls', { from: ghost, to: beta }), 'fail: no such caller');
    assert.equal(evalClaim(db, REPO, 'calls', { from: alpha, to: ghost }), 'fail: no such callee');

    assert.equal(evalClaim(db, REPO, 'only_writers_of', { table: 'things', writers: ['src/b.ts'] }), 'pass');
    assert.equal(evalClaim(db, REPO, 'only_writers_of', { table: 'things', writers: [] }), 'fail: also written by src/b.ts');

    assert.equal(evalClaim(db, REPO, 'tested_by', { ...alpha, test_path: 'src/test/a.test.ts' }), 'pass');
    assert.equal(evalClaim(db, REPO, 'tested_by', { ...ghost, test_path: 'src/test/a.test.ts' }), 'fail: no such symbol');
  });
});
