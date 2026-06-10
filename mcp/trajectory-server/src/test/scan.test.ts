import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempDB } from './helpers.js';
import { scanTools, preferredDefaultRepo } from '../tools/scan.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function parse(r: RawResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
}

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const h = handlers[name];
  assert.ok(h, `handler not found: ${name}`);
  return h(args) as unknown as RawResult;
}

function mkRepo(parent: string, name: string, files: Record<string, string>): string {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

describe('scan_run — workspace discovery + persistence', () => {
  it('discovers multiple inner repos under a non-git workspace, persists repos in SQLite', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-test-'));
    try {
      mkRepo(ws, 'app', { 'src/main.py': 'def main():\n    pass\n', 'README.md': 'app\n' });
      mkRepo(ws, 'lib', { 'core.ts': 'export const x = 1;\n' });

      const db = tempDB();
      // Pass null graph: world model writes are skipped (graph DB scope of
      // this test is covered by L3 kuzu integration fixtures — TBD post-v0.7).
      const tools = scanTools(db, null);
      const result = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!result.isError, `scan_run failed: ${JSON.stringify(result)}`);

      const repoNames = db
        .all<{ name: string }>('SELECT name FROM repos ORDER BY name')
        .map((r) => r.name);
      assert.deepEqual(repoNames, ['app', 'lib']);

      const auditRow = db.get<{ event_type: string }>(
        `SELECT event_type FROM audit WHERE event_type='deep_scan_completed' ORDER BY id DESC LIMIT 1`,
      );
      assert.ok(auditRow, 'deep_scan_completed audit row should exist');

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('scan_run completes without error when graph is null (workflow path stays clean)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-no-graph-'));
    try {
      mkRepo(ws, 'r', { 'a.txt': 'aaa\n', 'README.md': 'first version\n' });

      const db = tempDB();
      const tools = scanTools(db, null);

      const r1 = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r1.isError, `first scan_run must succeed: ${JSON.stringify(r1)}`);

      // Re-scan idempotency — without a graph the dirs_upserted count is 0
      // but the audit row + repos table updates still apply.
      const r2 = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r2.isError, `second scan_run must succeed: ${JSON.stringify(r2)}`);

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('sets tmb_default_repo on first scan if not already configured', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-default-'));
    try {
      mkRepo(ws, 'repo-c', { 'README.md': 'p\n' });

      const db = tempDB();
      const tools = scanTools(db, null);
      await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });

      const cfg = db.get<{ value_json: string }>(
        `SELECT value_json FROM plugin_config WHERE key='tmb_default_repo'`,
      );
      assert.ok(cfg, 'tmb_default_repo should be set');
      assert.equal(cfg!.value_json, "\"repo-c\"");

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // #2885: workspace-pattern with multiple sibling repos. Old behaviour picked
  // repos[0] alphabetically, so a user launching from ~/Git/GitHub/TMB/plugin
  // got tmb_default_repo='repo-a' just because it sorted first. New
  // behaviour: prefer the repo whose path encloses session_dir.
  it('prefers the cwd-enclosing repo as tmb_default_repo, not alphabetical-first (#2885)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-prefer-'));
    try {
      // Three sibling repos. Alphabetical-first is 'repo-a' (placeholder names — must be sorted alphabetically to test the bug correctly).
      mkRepo(ws, 'repo-a', { 'README.md': 'e\n' });
      mkRepo(ws, 'repo-b', { 'README.md': 'm\n' });
      mkRepo(ws, 'repo-c', { 'README.md': 'p\n' });

      const db = tempDB();
      const tools = scanTools(db, null);
      // Scan from inside the 'repo-c' subdir — user clearly working there.
      await call(tools.handlers, 'scan_run', {
        agent: 'bro',
        session_dir: join(ws, 'repo-c'),
      });

      const cfg = db.get<{ value_json: string }>(
        `SELECT value_json FROM plugin_config WHERE key='tmb_default_repo'`,
      );
      assert.ok(cfg, 'tmb_default_repo should be set');
      assert.equal(
        cfg!.value_json,
        '"repo-c"',
        'cwd-enclosing repo wins over alphabetical-first',
      );

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('picks largest-by-file-count when session_dir encloses no repo (#316)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-fallback-'));
    try {
      // repo-a has 1 file, repo-c has 3 files → repo-c wins despite sorting later.
      mkRepo(ws, 'repo-a', { 'README.md': 'e\n' });
      mkRepo(ws, 'repo-c', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });

      const db = tempDB();
      const tools = scanTools(db, null);
      await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });

      const cfg = db.get<{ value_json: string }>(
        `SELECT value_json FROM plugin_config WHERE key='tmb_default_repo'`,
      );
      assert.ok(cfg);
      assert.equal(cfg!.value_json, '"repo-c"', 'largest repo wins over alphabetical-first');

      // A default_repo_guessed audit row must exist.
      const audit = db.get<{ event_type: string }>(
        `SELECT event_type FROM audit WHERE event_type='default_repo_guessed' ORDER BY id DESC LIMIT 1`,
      );
      assert.ok(audit, 'default_repo_guessed audit row should be emitted when guessing');

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('repos_list returns rows ordered by name', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-list-'));
    try {
      mkRepo(ws, 'beta', { 'a.txt': 'a\n' });
      mkRepo(ws, 'alpha', { 'a.txt': 'a\n' });

      const db = tempDB();
      const tools = scanTools(db, null);
      await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      const result = await call(tools.handlers, 'repos_list', { agent: 'bro' });
      assert.ok(!result.isError);
      const data = parse(result) as { repos: Array<{ name: string }> };
      assert.deepEqual(data.repos.map((r) => r.name), ['alpha', 'beta']);

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // #2881: scan_run accepts a `source` arg + enriches the deep_scan_completed
  // audit content_json with source / structural_change / repos_seen / top_dirs.
  describe('scan_run source + audit enrichment (#2881)', () => {
    it('persists source=user_manual in audit content_json when caller passes it', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'scan-src-'));
      try {
        mkRepo(ws, 'app', { 'a.txt': 'a\n' });

        const db = tempDB();
        const tools = scanTools(db, null);
        const result = await call(tools.handlers, 'scan_run', {
          agent: 'bro',
          session_dir: ws,
          source: 'user_manual',
        });
        assert.ok(!result.isError);
        const data = parse(result) as { source: string; structural_change: boolean };
        assert.equal(data.source, 'user_manual');

        const audit = db.get<{ content_json: string }>(
          `SELECT content_json FROM audit WHERE event_type = 'deep_scan_completed' ORDER BY id DESC LIMIT 1`,
        );
        assert.ok(audit);
        const parsedAudit = JSON.parse(audit!.content_json);
        assert.equal(parsedAudit.source, 'user_manual');
        assert.ok(Array.isArray(parsedAudit.repos_seen));
        assert.ok(Array.isArray(parsedAudit.top_dirs));

        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('defaults source to bro_auto_initial when caller omits it', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'scan-src-default-'));
      try {
        mkRepo(ws, 'app', { 'a.txt': 'a\n' });

        const db = tempDB();
        const tools = scanTools(db, null);
        const result = await call(tools.handlers, 'scan_run', {
          agent: 'bro',
          session_dir: ws,
        });
        const data = parse(result) as { source: string };
        assert.equal(data.source, 'bro_auto_initial');

        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('rejects unknown source value by falling back to bro_auto_initial', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'scan-src-bad-'));
      try {
        mkRepo(ws, 'app', { 'a.txt': 'a\n' });

        const db = tempDB();
        const tools = scanTools(db, null);
        const result = await call(tools.handlers, 'scan_run', {
          agent: 'bro',
          session_dir: ws,
          source: 'definitely-not-a-real-value',
        });
        const data = parse(result) as { source: string };
        assert.equal(data.source, 'bro_auto_initial');

        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('flags structural_change=true on the first scan ever (no prior audit row)', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'scan-struct-first-'));
      try {
        mkRepo(ws, 'app', { 'a.txt': 'a\n' });

        const db = tempDB();
        const tools = scanTools(db, null);
        const result = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
        const data = parse(result) as { structural_change: boolean };
        assert.equal(data.structural_change, true);

        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('flags structural_change=false on an immediate rescan with no shape changes', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'scan-struct-stable-'));
      try {
        mkRepo(ws, 'app', { 'src/main.py': 'p\n' });

        const db = tempDB();
        const tools = scanTools(db, null);
        await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
        // Second scan — same repo, same files, same top-level dirs.
        const result = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
        const data = parse(result) as { structural_change: boolean };
        assert.equal(data.structural_change, false);

        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('flags structural_change=true when a new top-level dir appears between scans', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'scan-struct-newdir-'));
      try {
        mkRepo(ws, 'app', { 'src/main.py': 'p\n' });

        const db = tempDB();
        const tools = scanTools(db, null);
        await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });

        // Add a new top-level dir + commit.
        const appDir = join(ws, 'app');
        mkdirSync(join(appDir, 'docs'));
        writeFileSync(join(appDir, 'docs', 'README.md'), 'docs\n');
        execFileSync('git', ['add', '.'], { cwd: appDir });
        execFileSync('git', ['commit', '-qm', 'add docs'], { cwd: appDir });

        const result = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
        const data = parse(result) as { structural_change: boolean };
        assert.equal(data.structural_change, true, 'new top-level dir is a structural change');

        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });
});

describe('preferredDefaultRepo — unit', () => {
  it('returns cwd-enclosing repo when session_dir is inside one', () => {
    const repos = [
      { name: 'enterprise', path: '/ws/enterprise', file_count: 89 },
      { name: 'plugin', path: '/ws/plugin', file_count: 901 },
    ];
    assert.equal(
      preferredDefaultRepo(repos, '/ws/plugin/src'),
      'plugin',
      'enclosing repo wins regardless of file_count',
    );
  });

  it('returns largest repo by file_count when no repo encloses session_dir (#316)', () => {
    const repos = [
      { name: 'enterprise', path: '/ws/enterprise', file_count: 89 },
      { name: 'marketplace', path: '/ws/marketplace', file_count: 0 },
      { name: 'plugin', path: '/ws/plugin', file_count: 901 },
    ];
    const guesses: Array<{ chosen: string }> = [];
    const result = preferredDefaultRepo(repos, '/ws', (chosen, candidates) => {
      guesses.push({ chosen });
      assert.equal(candidates.length, 3);
    });
    assert.equal(result, 'plugin', 'largest repo wins over alphabetical-first (enterprise)');
    assert.equal(guesses.length, 1, 'onGuessed callback fires once');
  });

  it('returns single repo name regardless of file_count', () => {
    assert.equal(
      preferredDefaultRepo([{ name: 'solo', path: '/ws/solo', file_count: 0 }], '/other'),
      'solo',
    );
  });

  it('returns empty string for empty repos list', () => {
    assert.equal(preferredDefaultRepo([], '/any'), '');
  });
});

describe('scan_run lock contention + release (#339)', () => {
  function mkRepo(parent: string, name: string): string {
    const root = join(parent, name);
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'README.md'), 'r\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    return root;
  }

  it('lock file is absent after a successful scan (released on completion)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-lock-release-'));
    const dbDir = join(ws, '.claude', 'tmb');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, 'trajectory.db');
    try {
      mkRepo(ws, 'r');
      const db = tempDB();
      const tools = scanTools(db, null, dbPath);
      const r = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);
      const lockPath = join(dbDir, 'scan.lock');
      assert.ok(!existsSync(lockPath), 'lock file must be absent after scan completes');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('second scan_run while lock held by live pid returns error', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-lock-contend-'));
    const dbDir = join(ws, '.claude', 'tmb');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, 'trajectory.db');
    try {
      mkRepo(ws, 'r');
      const db = tempDB();
      const lockPath = join(dbDir, 'scan.lock');
      // Pre-write a lock with the current process pid (live pid).
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      const tools = scanTools(db, null, dbPath);
      const r = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(r.isError, 'scan_run should return error when lock is held');
      const data = parse(r);
      assert.ok(
        typeof data['error'] === 'string' && (data['error'] as string).includes('scan already running'),
        `error message should mention 'scan already running', got: ${data['error']}`,
      );
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('stale lock (dead pid) is cleared and scan proceeds', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-lock-stale-'));
    const dbDir = join(ws, '.claude', 'tmb');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, 'trajectory.db');
    try {
      mkRepo(ws, 'r');
      const db = tempDB();
      const lockPath = join(dbDir, 'scan.lock');
      // Write a stale lock with a dead pid (99999999 is almost certainly not alive).
      writeFileSync(lockPath, JSON.stringify({ pid: 99999999, started_at: new Date().toISOString() }));
      const tools = scanTools(db, null, dbPath);
      const r = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan should succeed past stale lock: ${JSON.stringify(r)}`);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('scan_run retired repos + dirs (#340)', () => {
  function mkRepo(parent: string, name: string): string {
    const root = join(parent, name);
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'f.txt'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    return root;
  }

  it('scan summary reports discovered/upserted/retired counts', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-retire-'));
    try {
      mkRepo(ws, 'repo-a');
      mkRepo(ws, 'repo-b');

      const db = tempDB();
      const tools = scanTools(db, null);

      // First scan: both repos discovered.
      const r1 = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r1.isError, `first scan failed: ${JSON.stringify(r1)}`);
      const d1 = parse(r1);
      assert.equal(d1['repos_discovered'], 2, 'discovered 2 repos on first scan');
      assert.equal(d1['repos_retired'], 0, 'none retired on first scan');

      // Remove repo-b from disk so it vanishes from the next scan.
      rmSync(join(ws, 'repo-b'), { recursive: true, force: true });

      // Second scan: repo-b is retired.
      const r2 = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r2.isError, `second scan failed: ${JSON.stringify(r2)}`);
      const d2 = parse(r2);
      assert.equal(d2['repos_discovered'], 1, 'only 1 repo discovered after removal');
      assert.equal(d2['repos_retired'], 1, 'repo-b retired on second scan');

      // repo-b should be gone from the repos table.
      const names = db.all<{ name: string }>('SELECT name FROM repos ORDER BY name').map((r) => r.name);
      assert.deepEqual(names, ['repo-a'], 'only repo-a remains in DB');

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
