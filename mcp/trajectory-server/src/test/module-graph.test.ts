import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderModuleGraph } from '../renderers/module-graph.js';
import type { FileRegistryRow } from '../types.js';

const OPTS = { generatedAt: '2026-04-21' };

function makeRow(path: string, language: string, imports: string[]): FileRegistryRow {
  return {
    path,
    type: 'source',
    language,
    size_bytes: null,
    last_commit_sha: null,
    last_change_type: null,
    last_change_at: null,
    imports_json: JSON.stringify(imports),
    exports_json: '[]',
    metadata_json: '{}',
  };
}

describe('renderModuleGraph', () => {
  it('empty input → Modules: 0, Edges: 0, valid empty graph LR, no throw', () => {
    const out = renderModuleGraph([], OPTS);
    assert.ok(out.startsWith('<!-- Generated 2026-04-21 via /tmb refresh-architecture.'));
    assert.ok(out.includes('Modules: 0'));
    assert.ok(out.includes('Edges: 0'));
    assert.ok(out.includes('graph LR'));
  });

  it('non-TS/JS-only input → "no TS/JS modules indexed", no throw', () => {
    const rows: FileRegistryRow[] = [
      makeRow('src/main.py', 'python', []),
      makeRow('src/app.rb', 'ruby', []),
    ];
    const out = renderModuleGraph(rows, OPTS);
    assert.ok(out.includes('no TS/JS modules indexed'));
    assert.ok(!out.includes('graph LR'));
  });

  it('non-source rows filtered out even if language matches', () => {
    const row: FileRegistryRow = {
      path: 'src/x.ts',
      type: 'test',
      language: 'ts',
      size_bytes: null,
      last_commit_sha: null,
      last_change_type: null,
      last_change_at: null,
      imports_json: '[]',
      exports_json: '[]',
      metadata_json: '{}',
    };
    const out = renderModuleGraph([row], OPTS);
    assert.ok(out.includes('no TS/JS modules indexed'));
  });

  it('relative import resolution: src/a.ts imports ./b.js, edge drawn to resolved path', () => {
    const rows = [
      makeRow('src/a.ts', 'ts', ['./b.js']),
      makeRow('src/b.ts', 'ts', []),
    ];
    const out = renderModuleGraph(rows, OPTS);
    assert.ok(out.includes('n_src_a_ts --> n_src_b_js'), `expected edge in:\n${out}`);
    assert.ok(out.includes('Modules: 2'));
  });

  it('relative import to known registry path draws edge (no dangling)', () => {
    const rows = [
      makeRow('src/a.ts', 'ts', ['./b.ts']),
      makeRow('src/b.ts', 'ts', []),
    ];
    const out = renderModuleGraph(rows, OPTS);
    assert.ok(out.includes('n_src_a_ts --> n_src_b_ts'), `expected edge in:\n${out}`);
    assert.ok(!out.includes('Dangling imports'));
  });

  it('dangling import surfaced in dedicated section', () => {
    const rows = [makeRow('src/foo.ts', 'ts', ['./missing.ts'])];
    const out = renderModuleGraph(rows, OPTS);
    assert.ok(out.includes('## Dangling imports'));
    assert.ok(out.includes('`src/foo.ts` → `./missing.ts` (not in registry)'));
  });

  it('external package grouped under subgraph external, one node per package root', () => {
    const rows = [
      makeRow('src/a.ts', 'ts', ['@modelcontextprotocol/sdk/types.js', 'express']),
    ];
    const out = renderModuleGraph(rows, OPTS);
    assert.ok(out.includes('subgraph external'));
    assert.ok(out.includes('@modelcontextprotocol/sdk'));
    assert.ok(out.includes('express'));
    assert.ok(out.includes('(2 external packages)'));
  });

  it('multiple imports to same external package emit only one edge', () => {
    const rows = [
      makeRow('src/a.ts', 'ts', ['@modelcontextprotocol/sdk/types.js', '@modelcontextprotocol/sdk/server.js']),
    ];
    const out = renderModuleGraph(rows, OPTS);
    const edgeMatch = out.match(/Edges: (\d+)/);
    assert.ok(edgeMatch);
    assert.equal(parseInt(edgeMatch[1], 10), 1, 'two imports to same package = one edge');
  });

  it('node ID sanitization: no special chars in Mermaid node IDs', () => {
    const rows = [
      makeRow('src/some-file.tsx', 'tsx', []),
      makeRow('src/tools/issues.ts', 'ts', []),
    ];
    const out = renderModuleGraph(rows, OPTS);
    assert.ok(out.includes('n_src_some_file_tsx'), `expected n_src_some_file_tsx in:\n${out}`);
    assert.ok(out.includes('n_src_tools_issues_ts'), `expected n_src_tools_issues_ts in:\n${out}`);
  });

  it('output is deterministic across two calls', () => {
    const rows = [
      makeRow('src/b.ts', 'ts', ['./a.ts']),
      makeRow('src/a.ts', 'ts', ['express']),
    ];
    const out1 = renderModuleGraph(rows, OPTS);
    const out2 = renderModuleGraph(rows, OPTS);
    assert.equal(out1, out2);
  });

  it('edges and nodes are sorted by ID', () => {
    const rows = [
      makeRow('src/z.ts', 'ts', ['./a.ts']),
      makeRow('src/a.ts', 'ts', []),
    ];
    const out = renderModuleGraph(rows, OPTS);
    const nodeZDeclPos = out.indexOf('n_src_z_ts[');
    const nodeADeclPos = out.indexOf('n_src_a_ts[');
    assert.ok(nodeADeclPos >= 0, 'n_src_a_ts node declaration must exist');
    assert.ok(nodeZDeclPos >= 0, 'n_src_z_ts node declaration must exist');
    assert.ok(nodeADeclPos < nodeZDeclPos, 'nodes sorted: a before z');
  });

  it('custom languages filter: only rows matching filter language are included', () => {
    const rows = [
      makeRow('src/a.ts', 'ts', []),
      makeRow('src/b.jsx', 'jsx', []),
      makeRow('src/c.py', 'python', []),
    ];
    const out = renderModuleGraph(rows, { generatedAt: '2026-04-21', languages: ['ts'] });
    assert.ok(out.includes('Modules: 1'));
    assert.ok(out.includes('Languages: ts'));
  });

  it('output starts with generated-header comment', () => {
    const out = renderModuleGraph([], OPTS);
    assert.ok(out.startsWith('<!-- Generated'));
  });

  it('header contains generatedAt value', () => {
    const out = renderModuleGraph([], { generatedAt: '2099-01-01' });
    assert.ok(out.includes('2099-01-01'));
  });

  it('parent directory traversal in imports resolved correctly', () => {
    const rows = [
      makeRow('src/tools/a.ts', 'ts', ['../db.ts']),
      makeRow('src/db.ts', 'ts', []),
    ];
    const out = renderModuleGraph(rows, OPTS);
    assert.ok(out.includes('n_src_tools_a_ts --> n_src_db_ts'), `expected edge in:\n${out}`);
    assert.ok(!out.includes('Dangling imports'));
  });

  it('scoped package root extracted correctly for @scope/pkg/sub/path', () => {
    const rows = [
      makeRow('src/a.ts', 'ts', ['@scope/pkg/deep/file.js']),
    ];
    const out = renderModuleGraph(rows, OPTS);
    assert.ok(out.includes('@scope/pkg'), `expected @scope/pkg label in:\n${out}`);
  });

  it('node labels show original path with slashes and dots', () => {
    const rows = [makeRow('src/tools/issues.ts', 'ts', [])];
    const out = renderModuleGraph(rows, OPTS);
    assert.ok(out.includes('"src/tools/issues.ts"'));
  });

  it('malformed imports_json does not throw', () => {
    const row: FileRegistryRow = {
      path: 'src/x.ts',
      type: 'source',
      language: 'ts',
      size_bytes: null,
      last_commit_sha: null,
      last_change_type: null,
      last_change_at: null,
      imports_json: 'not valid json',
      exports_json: '[]',
      metadata_json: '{}',
    };
    assert.doesNotThrow(() => renderModuleGraph([row], OPTS));
  });

  it('non-array imports_json does not throw', () => {
    const row: FileRegistryRow = {
      path: 'src/x.ts',
      type: 'source',
      language: 'ts',
      size_bytes: null,
      last_commit_sha: null,
      last_change_type: null,
      last_change_at: null,
      imports_json: '"not an array"',
      exports_json: '[]',
      metadata_json: '{}',
    };
    assert.doesNotThrow(() => renderModuleGraph([row], OPTS));
  });

  it('single external package uses singular "external package"', () => {
    const rows = [makeRow('src/a.ts', 'ts', ['express'])];
    const out = renderModuleGraph(rows, OPTS);
    assert.ok(out.includes('(1 external package)'));
    assert.ok(!out.includes('external packages)'));
  });
});
