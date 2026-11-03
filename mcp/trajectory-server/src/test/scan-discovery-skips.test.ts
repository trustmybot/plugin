// scan_run repo discovery skips scratch, ignored and commit-less repos (GH 1551).
// A temp session holds a real repo (the session root, which ignores
// build-cache/), .tmp-x/proj with a commit, build-cache/repo with a commit and
// a commit-less empty/. scan_run must give only the session root a repos row,
// and the walker must write one scan_skipped audit row per skipped repo, with
// reasons dot_dir, git_ignored and no_commits; a re-scan writes no further
// scan_skipped row.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { scanTools } from '../tools/scan.js';
import { pinScanEnv, type ScanEnvPin } from './helpers.js';

function mkRepo(dir: string, commit: boolean): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  if (commit) {
    writeFileSync(join(dir, 'f.txt'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  }
}

describe('scan_run discovery skips scratch, ignored and commit-less repos (GH 1551)', () => {
  let pin: ScanEnvPin;
  let base = '';
  let ws = '';
  let db: TrajectoryDB;

  before(() => {
    pin = pinScanEnv();
    base = mkdtempSync(join(tmpdir(), 'tmb-scan-discovery-skips-'));
    ws = join(base, 'ws');
    mkRepo(ws, false);
    writeFileSync(join(ws, '.gitignore'), 'build-cache/\n');
    writeFileSync(join(ws, 'README.md'), 'real\n');
    execFileSync('git', ['add', '.'], { cwd: ws });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: ws });
    mkRepo(join(ws, '.tmp-x', 'proj'), true);
    mkRepo(join(ws, 'build-cache', 'repo'), true);
    mkRepo(join(ws, 'empty'), false);
    db = new TrajectoryDB(join(base, 'trajectory.db'));
  });

  after(() => {
    db.close();
    pin.restore();
    rmSync(base, { recursive: true, force: true });
  });

  const scan = async (): Promise<{ isError?: boolean; content: Array<{ text: string }> }> =>
    (await scanTools(db, null).handlers['scan_run']!({ agent: 'bro', session_dir: ws })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

  const skipped = (): string[] =>
    db.all<{ line: string }>(
      `SELECT json_extract(content_json, '$.reason') || ' ' || json_extract(content_json, '$.path') AS line
         FROM audit WHERE event_type = 'scan_skipped' AND from_node = 'hook:scan' AND issue_id = -1
        ORDER BY 1`,
    ).map((r) => r.line);

  it('scan_run succeeds', async () => {
    const r = await scan();
    assert.ok(!r.isError, r.content[0]?.text);
  });

  it('only the real repo gets a repos row', () => {
    const paths = db.get<{ paths: string }>('SELECT group_concat(path, \',\') AS paths FROM repos')!.paths;
    assert.equal(paths, ws);
  });

  it('one scan_skipped row per skipped repo, with its reason', () => {
    assert.deepEqual(skipped(), [
      `dot_dir ${ws}/.tmp-x/proj`,
      `git_ignored ${ws}/build-cache/repo`,
      `no_commits ${ws}/empty`,
    ]);
  });

  it('a re-scan writes no further scan_skipped row', async () => {
    const r = await scan();
    assert.ok(!r.isError, r.content[0]?.text);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'scan_skipped'")!.n, 3);
  });
});
