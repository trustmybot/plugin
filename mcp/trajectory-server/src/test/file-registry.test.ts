import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { fileRegistryTools } from '../tools/file-registry.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const handler = handlers[name];
  assert.ok(handler, `Handler not found: ${name}`);
  const argsWithAgent = 'agent' in args ? args : { agent: 'architect', ...args };
  return handler(argsWithAgent) as unknown as RawResult;
}

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

describe('fileRegistryTools', () => {
  describe('file_registry_upsert', () => {
    it('upsert a minimal row and get it back', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'src/index.ts',
        type: 'source',
      });
      assert.ok(!result.isError);
      const row = parseResult(result);
      assert.equal(row.path, 'src/index.ts');
      assert.equal(row.type, 'source');
      assert.deepEqual(row.imports, []);
      assert.deepEqual(row.exports, []);
      assert.deepEqual(row.metadata, {});

      db.close();
    });

    it('upsert is idempotent: calling twice with same path replaces without error', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      await call(tools.handlers, 'file_registry_upsert', {
        path: 'src/index.ts',
        type: 'source',
        language: 'typescript',
      });

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'src/index.ts',
        type: 'test',
        language: 'typescript',
      });
      assert.ok(!result.isError);
      const row = parseResult(result);
      assert.equal(row.type, 'test', 'second upsert should update type');

      const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM file_registry');
      assert.equal(count?.n, 1, 'must remain 1 row after two upserts of same path');

      db.close();
    });

    it('stores and returns imports/exports/metadata correctly (JSON round-trip)', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'lib/utils.ts',
        type: 'source',
        imports: ['node:fs', 'lodash'],
        exports: ['readFile', 'writeFile'],
        metadata: { owner: 'team-a', deprecated: false },
      });
      assert.ok(!result.isError);
      const row = parseResult(result);
      assert.deepEqual(row.imports, ['node:fs', 'lodash']);
      assert.deepEqual(row.exports, ['readFile', 'writeFile']);
      assert.deepEqual(row.metadata, { owner: 'team-a', deprecated: false });

      db.close();
    });

    it('upsert with all optional fields', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'src/server.ts',
        type: 'source',
        language: 'typescript',
        size_bytes: 1024,
        last_commit_sha: 'abc123',
        last_change_type: 'modified',
        last_change_at: '2026-04-21T00:00:00.000Z',
        imports: ['express'],
        exports: ['app'],
        metadata: { version: 2 },
      });
      assert.ok(!result.isError);
      const row = parseResult(result);
      assert.equal(row.language, 'typescript');
      assert.equal(row.size_bytes, 1024);
      assert.equal(row.last_commit_sha, 'abc123');
      assert.equal(row.last_change_type, 'modified');

      db.close();
    });
  });

  describe('file_registry_upsert validation', () => {
    it('rejects missing path', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', { type: 'source' });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, /path/i);

      db.close();
    });

    it('rejects empty path', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', { path: '', type: 'source' });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, /path/i);

      db.close();
    });

    it('rejects path exceeding 1024 chars', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'a'.repeat(1025),
        type: 'source',
      });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, /1024/);

      db.close();
    });

    it('accepts path exactly 1024 chars', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'a'.repeat(1024),
        type: 'source',
      });
      assert.ok(!result.isError);

      db.close();
    });

    it('rejects path with .. traversal segment', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'src/../etc/passwd',
        type: 'source',
      });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, /traversal/i);

      db.close();
    });

    it('rejects invalid type', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'src/x.ts',
        type: 'binary',
      });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, /Invalid type/);

      db.close();
    });

    it('rejects invalid last_change_type', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'src/x.ts',
        type: 'source',
        last_change_type: 'moved',
      });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, /Invalid last_change_type/);

      db.close();
    });

    it('accepts null last_change_type', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'src/x.ts',
        type: 'source',
        last_change_type: null,
      });
      assert.ok(!result.isError);
      assert.equal(parseResult(result).last_change_type, null);

      db.close();
    });

    it('rejects imports that is not an array of strings', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'src/x.ts',
        type: 'source',
        imports: ['ok', 42],
      });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, /imports/);

      db.close();
    });

    it('rejects metadata that is an array (not a plain object)', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_upsert', {
        path: 'src/x.ts',
        type: 'source',
        metadata: ['not', 'an', 'object'],
      });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, /metadata/);

      db.close();
    });

    it('accepts all valid types', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      for (const type of ['source', 'test', 'config', 'doc', 'unknown']) {
        const result = await call(tools.handlers, 'file_registry_upsert', {
          path: `file-${type}.ts`,
          type,
        });
        assert.ok(!result.isError, `type ${type} should be valid`);
      }

      db.close();
    });

    it('accepts all valid last_change_type values', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      for (const changeType of ['added', 'modified', 'deleted', 'renamed']) {
        const result = await call(tools.handlers, 'file_registry_upsert', {
          path: `change-${changeType}.ts`,
          type: 'source',
          last_change_type: changeType,
        });
        assert.ok(!result.isError, `last_change_type ${changeType} should be valid`);
      }

      db.close();
    });
  });

  describe('file_registry_list', () => {
    it('list with no filters returns all rows', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      await call(tools.handlers, 'file_registry_upsert', { path: 'a.ts', type: 'source' });
      await call(tools.handlers, 'file_registry_upsert', { path: 'b.test.ts', type: 'test' });
      await call(tools.handlers, 'file_registry_upsert', { path: 'tsconfig.json', type: 'config' });

      const result = await call(tools.handlers, 'file_registry_list', {});
      assert.ok(!result.isError);
      const data = parseResult(result);
      assert.equal(data.count, 3);
      assert.equal(data.total, 3);
      assert.equal(data.rows.length, 3);

      db.close();
    });

    it('list with type=source returns only source rows', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      await call(tools.handlers, 'file_registry_upsert', { path: 'a.ts', type: 'source' });
      await call(tools.handlers, 'file_registry_upsert', { path: 'b.test.ts', type: 'test' });
      await call(tools.handlers, 'file_registry_upsert', { path: 'c.ts', type: 'source' });

      const result = await call(tools.handlers, 'file_registry_list', { type: 'source' });
      assert.ok(!result.isError);
      const data = parseResult(result);
      assert.equal(data.count, 2);
      assert.equal(data.total, 2);
      assert.ok(data.rows.every((r: { type: string }) => r.type === 'source'));

      db.close();
    });

    it('list with language filter returns only matching rows', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      await call(tools.handlers, 'file_registry_upsert', { path: 'a.ts', type: 'source', language: 'typescript' });
      await call(tools.handlers, 'file_registry_upsert', { path: 'b.py', type: 'source', language: 'python' });

      const result = await call(tools.handlers, 'file_registry_list', { language: 'typescript' });
      assert.ok(!result.isError);
      const data = parseResult(result);
      assert.equal(data.count, 1);
      assert.equal(data.rows[0].path, 'a.ts');

      db.close();
    });

    it('list with limit paginates correctly', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      for (let i = 0; i < 5; i++) {
        await call(tools.handlers, 'file_registry_upsert', { path: `file${i}.ts`, type: 'source' });
      }

      const result = await call(tools.handlers, 'file_registry_list', { limit: 2, offset: 0 });
      assert.ok(!result.isError);
      const data = parseResult(result);
      assert.equal(data.count, 2);
      assert.equal(data.total, 5);

      db.close();
    });

    it('list with offset skips rows', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      for (let i = 0; i < 3; i++) {
        await call(tools.handlers, 'file_registry_upsert', { path: `f${i}.ts`, type: 'source' });
      }

      const result = await call(tools.handlers, 'file_registry_list', { limit: 10, offset: 2 });
      assert.ok(!result.isError);
      const data = parseResult(result);
      assert.equal(data.count, 1);
      assert.equal(data.total, 3);

      db.close();
    });

    it('list decodes imports/exports/metadata as arrays/objects (not strings)', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      await call(tools.handlers, 'file_registry_upsert', {
        path: 'src/lib.ts',
        type: 'source',
        imports: ['react', 'lodash'],
        exports: ['Component'],
        metadata: { lines: 42 },
      });

      const result = await call(tools.handlers, 'file_registry_list', {});
      assert.ok(!result.isError);
      const row = parseResult(result).rows[0];
      assert.ok(Array.isArray(row.imports), 'imports must be an array');
      assert.ok(Array.isArray(row.exports), 'exports must be an array');
      assert.equal(typeof row.metadata, 'object', 'metadata must be an object');
      assert.ok(!Array.isArray(row.metadata), 'metadata must not be an array');
      assert.deepEqual(row.imports, ['react', 'lodash']);
      assert.deepEqual(row.exports, ['Component']);
      assert.deepEqual(row.metadata, { lines: 42 });

      db.close();
    });

    it('list on empty table returns empty rows with count=0', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_list', {});
      assert.ok(!result.isError);
      const data = parseResult(result);
      assert.equal(data.count, 0);
      assert.equal(data.total, 0);
      assert.deepEqual(data.rows, []);

      db.close();
    });

    it('list rejects invalid type filter', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_list', { type: 'invalid' });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, /Invalid type/);

      db.close();
    });

    it('list clamps limit to MAX_LIMIT (5000)', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_list', { limit: 99999 });
      assert.ok(!result.isError);

      db.close();
    });
  });

  describe('file_registry_delete', () => {
    it('delete returns { deleted: 0 } for non-existent path', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_delete', { path: 'nonexistent.ts' });
      assert.ok(!result.isError);
      assert.deepEqual(parseResult(result), { deleted: 0 });

      db.close();
    });

    it('delete returns { deleted: 1 } after successful upsert then delete', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      await call(tools.handlers, 'file_registry_upsert', { path: 'to-delete.ts', type: 'source' });
      const result = await call(tools.handlers, 'file_registry_delete', { path: 'to-delete.ts' });
      assert.ok(!result.isError);
      assert.deepEqual(parseResult(result), { deleted: 1 });

      const row = db.get('SELECT * FROM file_registry WHERE path = ?', ['to-delete.ts']);
      assert.equal(row, undefined, 'row must be gone after delete');

      db.close();
    });

    it('delete then list shows row is gone', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      await call(tools.handlers, 'file_registry_upsert', { path: 'keep.ts', type: 'source' });
      await call(tools.handlers, 'file_registry_upsert', { path: 'gone.ts', type: 'test' });
      await call(tools.handlers, 'file_registry_delete', { path: 'gone.ts' });

      const result = await call(tools.handlers, 'file_registry_list', {});
      const data = parseResult(result);
      assert.equal(data.count, 1);
      assert.equal(data.rows[0].path, 'keep.ts');

      db.close();
    });

    it('delete rejects empty path', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_delete', { path: '' });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, /path/i);

      db.close();
    });

    it('delete rejects path with .. traversal', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      const result = await call(tools.handlers, 'file_registry_delete', { path: '../etc/shadow' });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, /traversal/i);

      db.close();
    });

    it('rename is delete old + upsert new', async () => {
      const db = tempDB();
      const tools = fileRegistryTools(db);

      await call(tools.handlers, 'file_registry_upsert', {
        path: 'old-name.ts',
        type: 'source',
        exports: ['foo'],
      });

      await call(tools.handlers, 'file_registry_delete', { path: 'old-name.ts' });
      await call(tools.handlers, 'file_registry_upsert', {
        path: 'new-name.ts',
        type: 'source',
        exports: ['foo'],
        last_change_type: 'renamed',
      });

      const result = await call(tools.handlers, 'file_registry_list', {});
      const data = parseResult(result);
      assert.equal(data.count, 1);
      assert.equal(data.rows[0].path, 'new-name.ts');
      assert.equal(data.rows[0].last_change_type, 'renamed');

      db.close();
    });
  });
});
