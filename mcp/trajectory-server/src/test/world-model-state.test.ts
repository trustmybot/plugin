// scan_run against the world-model state (GH 1593): no graph refuses to stamp
// repos, and refilling an empty graph counts as a structural change.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bagOfWordsLoader, pinScanEnv, tempDB } from './helpers.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import type { TrajectoryDB } from '../db.js';

const scanPin = pinScanEnv();
before(() => resetEmbeddingModelForTests(bagOfWordsLoader()));
after(() => {
  resetEmbeddingModelForTests();
  scanPin.restore();
});

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function mkWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'wm-state-'));
  const root = join(ws, 'app');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'app\n');
  writeFileSync(join(root, 'src', 'main.ts'), 'export const x = 1;\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return ws;
}

async function scan(db: TrajectoryDB, holder: GraphHolder | null, ws: string): Promise<RawResult> {
  const tools = scanTools(db, holder, ':memory:');
  return (await tools.handlers['scan_run']!({ agent: 'bro', session_dir: ws })) as unknown as RawResult;
}

function structuralChange(r: RawResult): boolean {
  return (JSON.parse(r.content[0]!.text) as { structural_change: boolean }).structural_change;
}

function dirCount(db: TrajectoryDB): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wm_directories')!.n;
}

describe('scan_run world-model state (GH 1593)', () => {
  it('a holder with no graph returns world_model_unavailable and stamps nothing', async () => {
    const ws = mkWorkspace();
    const db = tempDB({ seedScan: false });
    try {
      const r = await scan(db, GraphHolder.fixed(null), ws);
      assert.equal(r.isError, true, r.content[0]!.text);
      assert.match(r.content[0]!.text, /world_model_unavailable/);
      const stamp = db.get<{ last: string | null }>('SELECT MAX(last_scanned_at) AS last FROM repos');
      assert.equal(stamp!.last, null, 'repos.last_scanned_at stays NULL');
      const audits = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit WHERE event_type = 'deep_scan_completed'`,
      );
      assert.equal(audits!.n, 0, 'no deep_scan_completed row');
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('no holder writes the world model into the trajectory DB', async () => {
    const ws = mkWorkspace();
    const db = tempDB({ seedScan: false });
    try {
      const r = await scan(db, null, ws);
      assert.ok(!r.isError, r.content[0]!.text);
      assert.ok(dirCount(db) > 0, 'wm_directories filled');
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a scan refilling an empty graph returns structural_change: true', async () => {
    const ws = mkWorkspace();
    const db = tempDB({ seedScan: false });
    try {
      const holder = GraphHolder.fixed(new WorldModelGraph(db));
      assert.ok(!(await scan(db, holder, ws)).isError);
      const unchanged = await scan(db, holder, ws);
      assert.equal(structuralChange(unchanged), false, 'same shape, graph already filled');

      db.run('DELETE FROM wm_files');
      db.run('DELETE FROM wm_directories');
      const refill = await scan(db, holder, ws);
      assert.ok(!refill.isError, refill.content[0]!.text);
      assert.ok(dirCount(db) > 0, 'graph refilled');
      assert.equal(structuralChange(refill), true);
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
