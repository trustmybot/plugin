import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempDB } from './helpers.js';
import { architectureRegenTools } from '../tools/architecture-regen.js';

const execFileAsync = promisify(execFile);

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

async function initFixtureRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });

  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'index.ts'), `import { foo } from './foo.js';\nexport const bar = 1;\n`);
  await writeFile(join(dir, 'src', 'foo.ts'), `export const foo = 'hello';\n`);
  await writeFile(join(dir, 'README.md'), `# Fixture Repo\n`);

  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'feat: initial commit'], { cwd: dir });
}

describe('architectureRegenTools', () => {
  let fixtureDir: string;
  let autoDir: string;

  before(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'tmb-test-fixture-'));
    autoDir = join(fixtureDir, 'auto');
    await initFixtureRepo(fixtureDir);
  });

  after(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('scope:full produces all 4 auto/*.md files with generated-header', async () => {
    const db = tempDB();
    const tools = architectureRegenTools(db, fixtureDir);

    const schemaPath = join(fixtureDir, 'schema.sql');
    await writeFile(schemaPath, `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\n`);

    const result = await call(tools.handlers, 'architecture_regen', {
      scope: 'full',
      architecture_dir: autoDir,
      schema_path: schemaPath,
    });

    assert.ok(!result.isError, `Expected no error, got: ${result.content[0].text}`);
    const data = parseResult(result);
    assert.equal(data.scope, 'full');
    assert.deepEqual(data.targets_requested, ['codebase_tree', 'erd', 'module_graph', 'changelog']);
    assert.deepEqual(data.targets_completed.sort(), ['changelog', 'codebase_tree', 'erd', 'module_graph']);
    assert.deepEqual(data.targets_skipped, []);
    assert.ok(typeof data.head_sha === 'string');
    assert.ok(typeof data.duration_ms === 'number');

    const header = '<!-- Generated';
    for (const filename of ['codebase-tree.md', 'erd.md', 'module-graph.md', 'changelog.md']) {
      const content = await readFile(join(autoDir, filename), 'utf8');
      assert.ok(content.startsWith(header), `${filename} should start with generated header`);
      assert.ok(content.trim().length > header.length, `${filename} should have content beyond header`);
    }

    db.close();
  });

  it('regen_state rows written for all 4 targets after scope:full', async () => {
    const db = tempDB();
    const tools = architectureRegenTools(db, fixtureDir);
    const schemaPath = join(fixtureDir, 'schema.sql');
    await writeFile(schemaPath, `CREATE TABLE t (id INTEGER PRIMARY KEY);\n`);

    await call(tools.handlers, 'architecture_regen', {
      scope: 'full',
      architecture_dir: autoDir,
      schema_path: schemaPath,
    });

    for (const target of ['codebase_tree', 'erd', 'module_graph', 'changelog']) {
      const row = db.get<{ target: string; last_regen_at: string; last_seen_sha: string }>(
        `SELECT target, last_regen_at, last_seen_sha FROM regen_state WHERE target = ?`,
        [target],
      );
      assert.ok(row, `regen_state row missing for target: ${target}`);
      assert.equal(row.target, target);
      assert.ok(row.last_regen_at, `last_regen_at should be set for ${target}`);
    }

    db.close();
  });

  it('targets:[erd] regenerates only erd.md, only erd regen_state updated', async () => {
    const db = tempDB();
    const tools = architectureRegenTools(db, fixtureDir);
    const schemaPath = join(fixtureDir, 'schema.sql');
    await writeFile(schemaPath, `CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER);\n`);

    const erdOnlyDir = join(fixtureDir, 'erd-only-out');
    const result = await call(tools.handlers, 'architecture_regen', {
      scope: 'full',
      targets: ['erd'],
      architecture_dir: erdOnlyDir,
      schema_path: schemaPath,
    });

    assert.ok(!result.isError);
    const data = parseResult(result);
    assert.deepEqual(data.targets_completed, ['erd']);
    assert.deepEqual(data.targets_requested, ['erd']);

    const erdContent = await readFile(join(erdOnlyDir, 'erd.md'), 'utf8');
    assert.ok(erdContent.startsWith('<!-- Generated'));

    for (const other of ['codebase-tree.md', 'module-graph.md', 'changelog.md']) {
      let threw = false;
      try {
        await readFile(join(erdOnlyDir, other), 'utf8');
      } catch {
        threw = true;
      }
      assert.ok(threw, `${other} should not exist when only erd was requested`);
    }

    const erdState = db.get<{ target: string }>(
      `SELECT target FROM regen_state WHERE target = 'erd'`,
    );
    assert.ok(erdState, 'regen_state erd row should exist');

    for (const target of ['codebase_tree', 'module_graph', 'changelog']) {
      const row = db.get<{ target: string }>(
        `SELECT target FROM regen_state WHERE target = ?`,
        [target],
      );
      assert.equal(row, undefined, `regen_state row for ${target} should not exist`);
    }

    db.close();
  });

  it('missing schema_path → erd skipped with reason, no throw, no erd.md', async () => {
    const db = tempDB();
    const tools = architectureRegenTools(db, fixtureDir);
    const outDir = join(fixtureDir, 'no-schema-out');

    const result = await call(tools.handlers, 'architecture_regen', {
      scope: 'full',
      targets: ['erd'],
      architecture_dir: outDir,
    });

    assert.ok(!result.isError, 'should not throw even when schema_path is absent');
    const data = parseResult(result);
    assert.deepEqual(data.targets_completed, []);
    assert.equal(data.targets_skipped.length, 1);
    assert.equal(data.targets_skipped[0].target, 'erd');
    assert.ok(data.targets_skipped[0].reason.includes('schema_path not provided'));

    let threw = false;
    try {
      await readFile(join(outDir, 'erd.md'), 'utf8');
    } catch {
      threw = true;
    }
    assert.ok(threw, 'erd.md should not be written when schema_path absent');

    db.close();
  });

  it('path-traversal in architecture_dir is rejected', async () => {
    const db = tempDB();
    const tools = architectureRegenTools(db, fixtureDir);

    const result = await call(tools.handlers, 'architecture_regen', {
      architecture_dir: '../../etc',
    });

    assert.ok(result.isError, 'Expected error for path traversal');
    const data = parseResult(result);
    assert.ok(typeof data.error === 'string', 'Expected error message');
    assert.ok(
      data.error.includes('..') || data.error.includes('traversal') || data.error.includes('CWD'),
      `Expected traversal error but got: ${data.error}`,
    );

    db.close();
  });

  it('absolute architecture_dir outside CWD is rejected', async () => {
    const db = tempDB();
    const tools = architectureRegenTools(db, fixtureDir);

    const result = await call(tools.handlers, 'architecture_regen', {
      architecture_dir: '/etc/tmb-test',
    });

    assert.ok(result.isError, 'Expected error for absolute path outside CWD');
    const data = parseResult(result);
    assert.ok(typeof data.error === 'string');

    db.close();
  });

  it('architecture_dir pointing to manual/ is rejected', async () => {
    const db = tempDB();
    const tools = architectureRegenTools(db, fixtureDir);

    const result = await call(tools.handlers, 'architecture_regen', {
      architecture_dir: 'docs/trustmybot/architecture/manual',
    });

    assert.ok(result.isError, 'Expected error for manual/ directory');
    const data = parseResult(result);
    assert.ok(data.error.includes('manual'), `Expected manual/ rejection but got: ${data.error}`);

    db.close();
  });

  it('scope:incremental after noop produces idempotent output (no crash)', async () => {
    const db = tempDB();
    const tools = architectureRegenTools(db, fixtureDir);
    const schemaPath = join(fixtureDir, 'schema.sql');
    await writeFile(schemaPath, `CREATE TABLE items (id INTEGER PRIMARY KEY);\n`);
    const outDir = join(fixtureDir, 'incremental-out');

    await call(tools.handlers, 'architecture_regen', {
      scope: 'full',
      architecture_dir: outDir,
      schema_path: schemaPath,
    });

    const result2 = await call(tools.handlers, 'architecture_regen', {
      scope: 'incremental',
      architecture_dir: outDir,
      schema_path: schemaPath,
    });

    assert.ok(!result2.isError, `Expected no error on incremental run: ${result2.content[0].text}`);
    const data = parseResult(result2);
    assert.equal(data.scope, 'incremental');

    for (const filename of ['codebase-tree.md', 'module-graph.md', 'changelog.md']) {
      const content = await readFile(join(outDir, filename), 'utf8');
      assert.ok(content.startsWith('<!-- Generated'), `${filename} should still have header after incremental`);
    }

    db.close();
  });

  it('invalid scope returns error', async () => {
    const db = tempDB();
    const tools = architectureRegenTools(db, fixtureDir);

    const result = await call(tools.handlers, 'architecture_regen', {
      scope: 'partial',
    });

    assert.ok(result.isError, 'Expected error for invalid scope');
    assert.match(parseResult(result).error, /scope/);

    db.close();
  });

  it('invalid target in targets array returns error', async () => {
    const db = tempDB();
    const tools = architectureRegenTools(db, fixtureDir);

    const result = await call(tools.handlers, 'architecture_regen', {
      targets: ['codebase_tree', 'nonexistent_renderer'],
    });

    assert.ok(result.isError, 'Expected error for invalid target');
    assert.match(parseResult(result).error, /target/i);

    db.close();
  });

  it('all renderer outputs begin with exact generated-header format', async () => {
    const db = tempDB();
    const tools = architectureRegenTools(db, fixtureDir);
    const schemaPath = join(fixtureDir, 'schema.sql');
    await writeFile(schemaPath, `CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\n`);
    const outDir = join(fixtureDir, 'header-check-out');

    const result = await call(tools.handlers, 'architecture_regen', {
      scope: 'full',
      architecture_dir: outDir,
      schema_path: schemaPath,
    });

    assert.ok(!result.isError);

    const headerPrefix = '<!-- Generated ';
    const headerSuffix = ' via /tmb refresh-architecture. Do not edit; regenerate. -->';
    for (const filename of ['codebase-tree.md', 'erd.md', 'module-graph.md', 'changelog.md']) {
      const content = await readFile(join(outDir, filename), 'utf8');
      const firstLine = content.split('\n')[0];
      assert.ok(
        firstLine.startsWith(headerPrefix) && firstLine.includes(headerSuffix),
        `${filename} first line should match generated-header format. Got: "${firstLine}"`,
      );
    }

    db.close();
  });
});
