import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { WorldModelGraph as ShimGraph, resolveGraphDbPath } from '../graph-db.js';
import { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';

function dir(repo: string, path: string, parent: string | null, summary = '') {
  return {
    repo,
    path,
    parent_path: parent,
    summary,
    summary_source: 'structural',
    summary_updated_at: '',
    file_count: 0,
  };
}

describe('GraphHolder', () => {
  it('fixed(graph) returns the same graph on every call', () => {
    const graph = new WorldModelGraph(tempDB());
    const holder = GraphHolder.fixed(graph);
    assert.equal(holder.ensureGraph(), graph);
    assert.equal(holder.ensureGraph(), graph);
    assert.equal(holder.openError, null);
  });

  it('fixed(null, msg) reports the error and returns null', () => {
    const holder = GraphHolder.fixed(null, 'graph unavailable');
    assert.equal(holder.ensureGraph(), null);
    assert.equal(holder.openError, 'graph unavailable');
  });
});

describe('WorldModelGraph on the trajectory DB', () => {
  it('lists the wm_ tables', () => {
    const graph = new WorldModelGraph(tempDB());
    const tables = graph.tableNames();
    for (const t of ['wm_directories', 'wm_files', 'wm_directories_fts', 'wm_files_fts']) {
      assert.ok(tables.includes(t), `${t} present in ${tables.join(',')}`);
    }
  });

  it('subtree honours depth and ancestors walk to the root', () => {
    const graph = new WorldModelGraph(tempDB());
    graph.transaction(() => {
      graph.upsertDirectory(dir('app', '', null, 'root'));
      graph.upsertDirectory(dir('app', 'src', ''));
      graph.upsertDirectory(dir('app', 'src/lib', 'src'));
      graph.upsertDirectory(dir('app', 'src/lib/deep', 'src/lib'));
      graph.upsertDirectory(dir('other', '', null));
    });

    const all = graph.subtree('app', '', null).map((d) => d.path).sort();
    assert.deepEqual(all, ['', 'src', 'src/lib', 'src/lib/deep']);
    const shallow = graph.subtree('app', '', 1).map((d) => d.path).sort();
    assert.deepEqual(shallow, ['', 'src']);
    const fromSrc = graph.subtree('app', 'src', 1).map((d) => d.path).sort();
    assert.deepEqual(fromSrc, ['src', 'src/lib']);

    assert.deepEqual(
      graph.ancestors('app', 'src/lib/deep').map((d) => d.path),
      ['', 'src', 'src/lib', 'src/lib/deep'],
    );
    assert.equal(graph.directoryCount('app'), 4);
    assert.equal(graph.directoryCount(), 5);
  });

  it('upserts keep row identity and keyword search ranks FTS matches', () => {
    const graph = new WorldModelGraph(tempDB());
    graph.upsertDirectory(dir('app', '', null));
    graph.upsertDirectory(dir('app', 'billing', '', 'Invoice rendering and tax rules'));
    graph.upsertDirectory(dir('app', 'auth', '', 'Login sessions'));
    const firstId = graph.keywordSearchDirectories('app', 'invoice', 5)[0];
    assert.equal(firstId?.path, 'billing');

    graph.upsertDirectory(dir('app', 'billing', '', 'Invoice rendering, tax rules and refunds'));
    const hits = graph.keywordSearchDirectories('app', 'refunds', 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.path, 'billing');
    assert.ok(hits[0]!.score > 0, 'an FTS hit carries a positive score');
  });

  it('renameRepo re-keys directories and files', () => {
    const graph = new WorldModelGraph(tempDB());
    graph.upsertDirectory(dir('old', '', null));
    graph.upsertFile({
      repo: 'old',
      path: WorldModelGraph.fileKey('old', 'a.ts'),
      dir: '',
      purpose: '',
      purpose_source: 'none',
      content_md5: 'x',
      size_bytes: 1,
      last_commit_sha: '',
      updated_at: '',
    });
    assert.equal(graph.renameRepo('old', 'new'), 1);
    assert.equal(graph.directoryCount('old'), 0);
    assert.equal(graph.directoryCount('new'), 1);
    assert.equal(graph.allFilesForRepo('new').length, 1);
  });
});

describe('graph-db.js compatibility shim', () => {
  it('opens its own handle from a path and doubles as a holder', () => {
    const ws = mkdtempSync(join(tmpdir(), 'wm-shim-'));
    try {
      const dbPath = join(ws, 'trajectory.db');
      assert.equal(resolveGraphDbPath(dbPath), dbPath);
      const graph = new ShimGraph(dbPath);
      assert.equal(graph.ensureGraph(), graph);
      assert.equal(graph.openError, null);
      graph.upsertDirectory(dir('app', '', null));
      graph.close();

      const db = new TrajectoryDB(dbPath);
      try {
        assert.equal(new WorldModelGraph(db).directoryCount('app'), 1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
