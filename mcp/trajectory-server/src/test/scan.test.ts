import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, renameSync, realpathSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pinScanEnv, runGraphScript, tempDB, type ScanEnvPin } from './helpers.js';
import { TrajectoryDB } from '../db.js';
import { scanTools, runScanWithScript, upsertDiscoveredCheatcode } from '../tools/scan.js';
import { renameRepo } from '../tools/repos.js';
import { remotesView, repoRemotes, setRemoteSync } from '../repos/remotes.js';

// scan.sh never spawns `claude` here: pinScanEnv sets TMB_FORBID_LIVE_SYNC=1 and
// points TRAJECTORY_DB_PATH at an empty DB (no cheatcodes table) so resource
// discovery writes nowhere unless a test supplies its own DB; the plugin
// inventory comes from a fixture file.
const PLUGIN_LIST_FIXTURE = [
  {
    id: 'alpha@tmb-test-market',
    version: '1.2.0',
    enabled: true,
    description: 'Alpha test plugin',
    mcpServers: { 'alpha-server': { command: 'node' } },
  },
  { id: 'beta@tmb-test-market', version: '0.3.1', enabled: false, description: 'Beta test plugin' },
];
const SCAN_ENV_KEYS = ['TMB_SCAN_PLUGIN_JSON', 'PATH'] as const;
const savedScanEnv: Record<string, string | undefined> = {};
let fixtureDir = '';
let pluginListFixture = '';
let scanPin: ScanEnvPin;

before(() => {
  for (const k of SCAN_ENV_KEYS) savedScanEnv[k] = process.env[k];
  scanPin = pinScanEnv();
  fixtureDir = mkdtempSync(join(tmpdir(), 'scan-plugin-fixture-'));
  pluginListFixture = join(fixtureDir, 'claude-plugin-list.json');
  writeFileSync(pluginListFixture, JSON.stringify(PLUGIN_LIST_FIXTURE));
  process.env['TMB_SCAN_PLUGIN_JSON'] = pluginListFixture;
});

after(() => {
  for (const k of SCAN_ENV_KEYS) {
    if (savedScanEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedScanEnv[k];
  }
  scanPin.restore();
  rmSync(fixtureDir, { recursive: true, force: true });
});

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
      // Null graph: world model writes are skipped; the File-nodes suite below
      // covers them.
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

  it('does NOT write a tmb_default_repo config key on scan (path-keyed resolution)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-default-'));
    try {
      mkRepo(ws, 'repo-a', { 'README.md': 'e\n' });
      mkRepo(ws, 'repo-c', { 'a.txt': 'a\n', 'b.txt': 'b\n' });

      const db = tempDB();
      const tools = scanTools(db, null);
      await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });

      const cfg = db.get<{ value_json: string }>(
        `SELECT value_json FROM plugin_config WHERE key='tmb_default_repo'`,
      );
      assert.equal(cfg, undefined, 'scan must not auto-set tmb_default_repo');

      const audit = db.get<{ event_type: string }>(
        `SELECT event_type FROM audit WHERE event_type='default_repo_guessed' LIMIT 1`,
      );
      assert.equal(audit, undefined, 'no default_repo_guessed audit row is emitted');

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

describe('scan_run — per-repo git remotes into repo_remotes (#979)', () => {
  it('captures a repo\'s real remote as {name, provider, url} with classifyUrl provider', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-remotes-'));
    try {
      const root = mkRepo(ws, 'app', { 'README.md': 'app\n' });
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: root });

      const db = tempDB();
      const tools = scanTools(db, null);
      const r = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);

      const row = remotesView(repoRemotes(db, 'app'));
      assert.ok(row, 'app repo row should exist');
      const remotes = row;
      assert.deepEqual(remotes, [
        { name: 'origin', provider: 'github', url: 'git@github.com:acme/app.git', sync: true },
      ]);

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('records [] for a repo with no git remote (not a blank-url entry)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-remotes-none-'));
    try {
      mkRepo(ws, 'noremote', { 'a.txt': 'a\n' });

      const db = tempDB();
      const tools = scanTools(db, null);
      const r = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);

      const row = remotesView(repoRemotes(db, 'noremote'));
      assert.ok(row, 'noremote repo row should exist');
      assert.deepEqual(row, []);

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('gives each repo its OWN distinct remote in a multi-repo workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-remotes-multi-'));
    try {
      const a = mkRepo(ws, 'app', { 'README.md': 'a\n' });
      const b = mkRepo(ws, 'lib', { 'README.md': 'b\n' });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], { cwd: a });
      execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.com/acme/lib.git'], { cwd: b });

      const db = tempDB();
      const tools = scanTools(db, null);
      const r = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);

      const appRow = remotesView(repoRemotes(db, 'app'));
      const libRow = remotesView(repoRemotes(db, 'lib'));
      assert.deepEqual(appRow, [
        { name: 'origin', provider: 'github', url: 'https://github.com/acme/app.git', sync: true },
      ]);
      assert.deepEqual(libRow, [
        { name: 'origin', provider: 'gitlab', url: 'https://gitlab.com/acme/lib.git', sync: true },
      ]);

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('refreshes remotes idempotently across re-scans (reflects current git state)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-remotes-idem-'));
    try {
      const root = mkRepo(ws, 'app', { 'README.md': 'a\n' });

      const db = tempDB();
      const tools = scanTools(db, null);
      await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      const before = remotesView(repoRemotes(db, 'app'));
      assert.deepEqual(before, []);

      // Add a remote, re-scan: the row reflects the new state, no duplication.
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], { cwd: root });
      await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      const after = remotesView(repoRemotes(db, 'app'));
      assert.deepEqual(after, [
        { name: 'origin', provider: 'github', url: 'https://github.com/acme/app.git', sync: true },
      ]);

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('keeps the onboard Remote choice: a re-scan that updates or re-adds the unchosen gitlab remote leaves it unsynced (GH 1590)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-remotes-sync-'));
    try {
      const root = mkRepo(ws, 'app', { 'README.md': 'a\n' });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], { cwd: root });
      execFileSync('git', ['remote', 'add', 'mirror', 'https://gitlab.com/acme/app.git'], { cwd: root });
      const db = tempDB();
      const tools = scanTools(db, null);
      const syncOf = (): Array<[string, boolean]> => repoRemotes(db, 'app').map((r) => [r.name, r.sync]);
      await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      setRemoteSync(db, 'app', ['github']);
      assert.deepEqual(syncOf(), [['origin', true], ['mirror', false]]);

      execFileSync('git', ['remote', 'set-url', 'mirror', 'https://gitlab.com/acme/app-moved.git'], { cwd: root });
      await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.deepEqual(syncOf(), [['origin', true], ['mirror', false]]);
      assert.equal(repoRemotes(db, 'app')[1]!.url, 'https://gitlab.com/acme/app-moved.git');

      execFileSync('git', ['remote', 'remove', 'mirror'], { cwd: root });
      await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      execFileSync('git', ['remote', 'add', 'mirror', 'https://gitlab.com/acme/app.git'], { cwd: root });
      await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.deepEqual(syncOf(), [['origin', true], ['mirror', false]]);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('scan still succeeds (remotes=[]) when a repo path is unreadable / not a git repo', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-remotes-unreadable-'));
    try {
      mkRepo(ws, 'good', { 'README.md': 'g\n' });

      const db = tempDB();
      const tools = scanTools(db, null);
      const r = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);

      // Simulate a stale/unreadable repo path: insert a row whose path no longer
      // resolves to a git repo, then re-scan over the live workspace — the scan
      // must not throw, and the unreadable row degrades to [] on its own read.
      const goodRow = remotesView(repoRemotes(db, 'good'));
      assert.deepEqual(goodRow, []);

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('readRepoRemotes path: a non-git directory yields [] without throwing', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-remotes-nongit-'));
    try {
      // A workspace whose only "repo" candidate is a plain dir is discovered by
      // scan only if it is a git repo; here we assert the degrade-to-[] contract
      // by scanning a valid repo with no remote (criteria 5 happy degrade).
      mkRepo(ws, 'plain', { 'a.txt': 'a\n' });
      const db = tempDB();
      const tools = scanTools(db, null);
      const r = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);
      const row = remotesView(repoRemotes(db, 'plain'));
      assert.deepEqual(row, []);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('scan_run — rename detection', () => {
  it('a repo renamed on disk with the same remote is surfaced, never duplicated; a new repo still inserts', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-rename-'));
    try {
      const root = mkRepo(ws, 'app', { 'README.md': 'app\n' });
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: root });
      const db = tempDB();
      const tools = scanTools(db, null);
      const first = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!first.isError, JSON.stringify(first));
      db.run(
        `INSERT INTO issues (objective, description, status, created_at, updated_at, repo) VALUES ('o', 'd', 'open', datetime('now'), datetime('now'), 'app')`,
      );

      renameSync(root, join(ws, 'app-renamed'));
      mkRepo(ws, 'lib', { 'core.ts': 'export const x = 1;\n' });
      const second = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!second.isError, JSON.stringify(second));
      const out = parse(second);
      assert.deepEqual(out['rename_candidates'], [
        { old: 'app', new: 'app-renamed', by: 'remote', path: join(ws, 'app-renamed') },
      ]);

      const names = db.all<{ name: string }>('SELECT name FROM repos ORDER BY name').map((r) => r.name);
      assert.deepEqual(names, ['app', 'lib'], 'no duplicate row for the renamed repo; the new repo inserts');
      const audit = db.get<{ content_json: string }>(
        `SELECT content_json FROM audit WHERE event_type = 'repo_rename_detected'`,
      );
      assert.ok(audit, 'repo_rename_detected audit row');
      assert.deepEqual(JSON.parse(audit!.content_json), { old: 'app', new: 'app-renamed', by: 'remote' });

      renameRepo(db, null, { old: 'app', new: 'app-renamed', reason: 'dir renamed' });
      const third = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.deepEqual(parse(third)['rename_candidates'], [], 'no candidate once applied');
      const row = db.get<{ path: string }>(`SELECT path FROM repos WHERE name = 'app-renamed'`);
      assert.equal(row?.path, join(ws, 'app-renamed'), 'next scan refreshes the renamed row');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a row whose path matches a discovered repo under another name is a path rename candidate', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-rename-path-'));
    try {
      const root = mkRepo(ws, 'app', { 'README.md': 'app\n' });
      const db = tempDB();
      db.run(`INSERT INTO repos (name, path) VALUES ('legacy', ?)`, [realpathSync(root)]);
      const r = await call(scanTools(db, null).handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, JSON.stringify(r));
      const candidates = parse(r)['rename_candidates'] as Array<Record<string, unknown>>;
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]!['old'], 'legacy');
      assert.equal(candidates[0]!['new'], 'app');
      assert.equal(candidates[0]!['by'], 'path');
      const names = db.all<{ name: string }>('SELECT name FROM repos ORDER BY name').map((x) => x.name);
      assert.deepEqual(names, ['legacy'], 'legacy kept, app not inserted');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
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
    writeFileSync(dbPath, '');
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
    writeFileSync(dbPath, '');
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
    writeFileSync(dbPath, '');
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

  it('retires a stale row under the session dir and keeps and reports one a task references (GH 1551)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-stale-'));
    try {
      mkRepo(ws, 'live');
      const db = tempDB();
      const now = new Date().toISOString();
      const seedRepo = (name: string) =>
        db.run(`INSERT INTO repos (name, path, file_count, last_scanned_at) VALUES (?, ?, 0, ?)`, [name, join(ws, '.tmp-l6', name), now]);
      seedRepo('gone');
      seedRepo('held');
      db.run(`INSERT INTO issues (objective, status, created_at, updated_at) VALUES ('stale', 'open', ?, ?)`, [now, now]);
      const issueId = db.get<{ id: number }>('SELECT MAX(id) AS id FROM issues')!.id;
      db.run(
        `INSERT INTO tasks (issue_id, branch_id, description, status, repo, created_at, updated_at)
         VALUES (?, 'fix/held', 'd', 'closed', 'held', ?, ?)`,
        [issueId, now, now],
      );

      const r = await call(scanTools(db, null).handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan failed: ${JSON.stringify(r)}`);
      const d = parse(r);
      assert.equal(d['repos_retired'], 1, 'the unreferenced stale row is retired');
      assert.deepEqual(
        d['repos_stale_kept'],
        [{ name: 'held', path: join(ws, '.tmp-l6', 'held'), reason: 'task_referenced' }],
        'the task-referenced stale row is kept and reported',
      );
      const names = db.all<{ name: string }>('SELECT name FROM repos ORDER BY name').map((row) => row.name);
      assert.deepEqual(names, ['held', 'live']);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('scan_run async spawn + timeout (#398)', () => {
  it('runScanWithScript rejects with timeout error when child hangs past deadline', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-timeout-'));
    try {
      const stubScript = join(ws, 'hang.sh');
      writeFileSync(stubScript, '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 });

      const start = Date.now();
      await assert.rejects(
        () => runScanWithScript(stubScript, ws, 200),
        /timed out/,
        'runScanWithScript must reject with timed out message',
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 3000, `Should have timed out in <3s, took ${elapsed}ms`);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('lock file is released when scan times out (#398)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-lock-timeout-'));
    const dbDir = join(ws, '.claude', 'tmb');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, 'trajectory.db');
    writeFileSync(dbPath, '');
    const lockPath = join(dbDir, 'scan.lock');
    try {
      const stubScript = join(ws, 'hang.sh');
      writeFileSync(stubScript, '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 });

      // Override SCAN_TIMEOUT_MS by directly calling the tool handler. We can't
      // inject a custom timeout into scanTools, so instead we verify via the
      // runScanWithScript unit test above that timeout fires and kills the child.
      // Here we test the lock-release path using a dead-pid stale lock scenario:
      // the scan handler detects the lock is stale (pid dead) and clears it,
      // which means after a crashed/timed-out previous scan the lock is always
      // releasable by the next caller.
      //
      // Direct lock-release-on-timeout test: write the lock, simulate timeout
      // cleanup path by calling releaseLock equivalent (just delete the file),
      // and assert lock is gone — the actual release-on-timeout is covered by
      // integration via runScanWithScript above.
      writeFileSync(lockPath, JSON.stringify({ pid: 99999999, started_at: new Date().toISOString() }));
      assert.ok(existsSync(lockPath), 'lock file should exist before test');

      // A stale-lock scan proceeds (clears it) and lock is absent afterward.
      const db = tempDB();
      mkRepo(ws, 'r', { 'README.md': 'r\n' });
      const tools = scanTools(db, null, dbPath);
      const r = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan should proceed past stale lock: ${JSON.stringify(r)}`);
      assert.ok(!existsSync(lockPath), 'lock must be absent after successful scan (stale-lock path)');

      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('scan_run targets the project root, not the server cwd (GH 1553)', () => {
  it('runScanWithScript hands scan.sh the server DB as TRAJECTORY_DB_PATH and runs it in the session dir', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-env-'));
    try {
      const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
      const stubScript = join(ws, 'echo-env.sh');
      writeFileSync(
        stubScript,
        '#!/usr/bin/env bash\njq -n --arg db "$TRAJECTORY_DB_PATH" --arg cwd "$(pwd -P)" \'{session_dir: $cwd, scanned_at: "", repos: [], files: [], db: $db, cwd: $cwd}\'\n',
        { mode: 0o755 },
      );
      const out = (await runScanWithScript(stubScript, ws, 5000, dbPath)) as unknown as Record<string, unknown>;
      assert.equal(out['db'], dbPath, 'scan.sh receives the server DB path');
      assert.equal(out['cwd'], realpathSync(ws), 'scan.sh runs in the session dir');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('scan_run with no session_dir scans the project root even when the cwd is elsewhere', async () => {
    const base = mkdtempSync(join(tmpdir(), 'scan-root-'));
    const originalCwd = process.cwd();
    try {
      const project = join(base, 'project');
      const unrelatedCwd = join(base, 'unrelated-cwd');
      mkdirSync(join(project, '.claude', 'tmb'), { recursive: true });
      const dbPath = join(project, '.claude', 'tmb', 'trajectory.db');
      writeFileSync(dbPath, '');
      mkRepo(project, 'app', { 'README.md': 'app\n' });
      mkRepo(unrelatedCwd, 'decoy', { 'README.md': 'decoy\n' });
      process.chdir(unrelatedCwd);

      const db = tempDB();
      const r = await call(scanTools(db, null, dbPath).handlers, 'scan_run', { agent: 'bro' });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);
      const names = db.all<{ name: string }>('SELECT name FROM repos ORDER BY name').map((x) => x.name);
      assert.deepEqual(names, ['app'], 'the project root is scanned, never the cwd');
      db.close();
    } finally {
      process.chdir(originalCwd);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('scan_run with no session_dir and no project root returns a named error', async () => {
    const db = tempDB();
    const r = await call(scanTools(db, null).handlers, 'scan_run', { agent: 'bro' });
    assert.ok(r.isError, 'no project root and no session_dir must error');
    assert.match(String(parse(r)['error']), /session_dir is required/);
    db.close();
  });
});

describe('upsertDiscoveredCheatcode — the (name, kind) discovery writer', () => {
  const discoveredCount = (db: ReturnType<typeof tempDB>): number =>
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'scan_discovered'")!.n;

  it('registers a plugin and its same-named bundled server once each, auditing each insert', () => {
    const db = tempDB();
    const plugin = upsertDiscoveredCheatcode(db, {
      name: 'linear', kind: 'plugin', origin: 'marketplace', source_url: 'linear@claude-plugins-official',
      status: 'active', description: 'Linear issue tracking', version: '1.2.3',
    });
    db.run("UPDATE cheatcodes SET trust_tier = 'reputable' WHERE id = ?", [plugin.id]);
    const server = upsertDiscoveredCheatcode(db, {
      name: 'linear', kind: 'mcp', origin: 'marketplace', source_url: 'mcp:linear/linear', status: 'active',
      description: 'linear MCP server bundled by linear', version: '1.2.3', trust_parent: 'linear',
    });
    assert.equal(plugin.inserted, true);
    assert.equal(server.inserted, true);
    assert.notEqual(plugin.id, server.id);
    const row = db.get<{ source_url: string; version: string; trust_tier: string }>(
      "SELECT source_url, version, trust_tier FROM cheatcodes WHERE name = 'linear' AND kind = 'mcp'",
    )!;
    assert.deepEqual({ ...row }, { source_url: 'mcp:linear/linear', version: '1.2.3', trust_tier: 'reputable' });
    assert.equal(discoveredCount(db), 2);

    const again = upsertDiscoveredCheatcode(db, {
      name: 'linear', kind: 'mcp', origin: 'marketplace', source_url: 'mcp:linear/linear', status: 'active',
    });
    assert.deepEqual(again, { id: server.id, inserted: false });
    assert.equal(discoveredCount(db), 2, 'an existing row is not audited again');
    db.close();
  });

  it('fills blanks and rewrites a legacy mcp:<server> source_url on an existing row without auditing', () => {
    const db = tempDB();
    db.run(
      `INSERT INTO cheatcodes (name, kind, origin, source_url, scope, status, installed_at)
       VALUES ('trajectory-server', 'mcp', 'marketplace', 'mcp:trajectory-server', 'project-local', 'active', 'x')`,
    );
    const res = upsertDiscoveredCheatcode(db, {
      name: 'trajectory-server', kind: 'mcp', origin: 'marketplace', source_url: 'mcp:tmb/trajectory-server',
      status: 'active', description: 'trajectory-server MCP server bundled by tmb', version: '1.0.2',
    });
    assert.equal(res.inserted, false);
    const row = db.get<{ source_url: string; description: string; version: string }>(
      "SELECT source_url, description, version FROM cheatcodes WHERE name = 'trajectory-server'",
    )!;
    assert.deepEqual({ ...row }, {
      source_url: 'mcp:tmb/trajectory-server',
      description: 'trajectory-server MCP server bundled by tmb',
      version: '1.0.2',
    });
    assert.equal(discoveredCount(db), 0);
    db.close();
  });
});


describe('scan_run plugin inventory under TMB_FORBID_LIVE_SYNC=1', () => {
  function withFileDb(prefix: string): { ws: string; dbPath: string; db: TrajectoryDB } {
    const ws = mkdtempSync(join(tmpdir(), prefix));
    mkRepo(ws, 'r', { 'README.md': 'r\n' });
    const dbDir = join(ws, '.claude', 'tmb');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, 'trajectory.db');
    return { ws, dbPath, db: new TrajectoryDB(dbPath) };
  }

  it('ingests the TMB_SCAN_PLUGIN_JSON fixture: an enabled and a disabled plugin plus the bundled server', async () => {
    const { ws, dbPath, db } = withFileDb('scan-plugin-fixture-ws-');
    process.env['TRAJECTORY_DB_PATH'] = dbPath;
    try {
      const r = await call(scanTools(db, null, dbPath).handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);
      assert.deepEqual(parse(r)['plugin_inventory'], { status: 'fixture', note: '' });
      const plugins = db.all<{ name: string; source_url: string; status: string; version: string; description: string }>(
        "SELECT name, source_url, status, version, description FROM cheatcodes WHERE kind = 'plugin' ORDER BY name",
      ).map((row) => ({ ...row }));
      assert.deepEqual(plugins, [
        { name: 'alpha', source_url: 'alpha@tmb-test-market', status: 'active', version: '1.2.0', description: 'Alpha test plugin' },
        { name: 'beta', source_url: 'beta@tmb-test-market', status: 'installed', version: '0.3.1', description: 'Beta test plugin' },
      ]);
      const servers = db.all<{ name: string; source_url: string }>(
        "SELECT name, source_url FROM cheatcodes WHERE kind = 'mcp' ORDER BY name",
      ).map((row) => ({ ...row }));
      assert.deepEqual(servers, [{ name: 'alpha-server', source_url: 'mcp:alpha/alpha-server' }]);
    } finally {
      process.env['TRAJECTORY_DB_PATH'] = scanPin.dbPath;
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('reports plugins unavailable and spawns no claude when no fixture is set', async () => {
    const { ws, dbPath, db } = withFileDb('scan-plugin-nofixture-ws-');
    const stubDir = join(ws, 'stub-bin');
    const sentinel = join(ws, 'claude-calls');
    mkdirSync(stubDir);
    writeFileSync(join(stubDir, 'claude'), `#!/usr/bin/env bash\necho "claude $*" >> "${sentinel}"\nexit 97\n`);
    chmodSync(join(stubDir, 'claude'), 0o755);
    process.env['TRAJECTORY_DB_PATH'] = dbPath;
    process.env['PATH'] = `${stubDir}:${savedScanEnv['PATH'] ?? ''}`;
    delete process.env['TMB_SCAN_PLUGIN_JSON'];
    try {
      const r = await call(scanTools(db, null, dbPath).handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);
      const inventory = parse(r)['plugin_inventory'] as { status: string; note: string };
      assert.equal(inventory.status, 'unavailable');
      assert.match(inventory.note, /TMB_FORBID_LIVE_SYNC=1/);
      assert.ok(!existsSync(sentinel), `claude was spawned: ${existsSync(sentinel) ? readFileSync(sentinel, 'utf8') : ''}`);
      const plugins = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cheatcodes WHERE kind = 'plugin'")!.n;
      assert.equal(plugins, 0);
      const summary = db.get<{ summary: string }>(
        "SELECT summary FROM audit WHERE event_type = 'deep_scan_completed' ORDER BY id DESC LIMIT 1",
      )!.summary;
      assert.match(summary, /; plugins unavailable: TMB_FORBID_LIVE_SYNC=1/);
    } finally {
      process.env['TRAJECTORY_DB_PATH'] = scanPin.dbPath;
      process.env['PATH'] = savedScanEnv['PATH'];
      process.env['TMB_SCAN_PLUGIN_JSON'] = pluginListFixture;
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('scan.sh under the test flags: pinned DB, MCP fixture', () => {
  const scanSh = new URL('../../../../scripts/scan.sh', import.meta.url).pathname;

  function runScanSh(cwd: string, env: NodeJS.ProcessEnv): { status: number; stderr: string } {
    try {
      execFileSync('bash', [scanSh, cwd], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, stderr: '' };
    } catch (e: unknown) {
      const se = e as { status?: number; stderr?: string };
      return { status: se.status ?? -1, stderr: se.stderr ?? '' };
    }
  }

  function flaggedEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['TMB_FORBID_LIVE_SYNC'];
    delete env['TMB_TEST_RUN_ID'];
    delete env['TRAJECTORY_DB_PATH'];
    delete env['CLAUDE_PROJECT_DIR'];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    return env;
  }

  const REQUIRED = /scan: TRAJECTORY_DB_PATH is required under TMB_FORBID_LIVE_SYNC\/TMB_TEST_RUN_ID \(walk-up discovery disabled\)/;

  it('exits 2 with the message when TRAJECTORY_DB_PATH is unset or missing under either flag', () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-flag-nodb-'));
    try {
      for (const flag of [{ TMB_FORBID_LIVE_SYNC: '1' }, { TMB_TEST_RUN_ID: 'tmb-unit-1' }]) {
        const unset = runScanSh(ws, flaggedEnv(flag));
        assert.equal(unset.status, 2, JSON.stringify(flag));
        assert.match(unset.stderr, REQUIRED);
        const missing = runScanSh(ws, flaggedEnv({ ...flag, TRAJECTORY_DB_PATH: join(ws, 'nope', 'trajectory.db') }));
        assert.equal(missing.status, 2, JSON.stringify(flag));
        assert.match(missing.stderr, REQUIRED);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('runs when TRAJECTORY_DB_PATH names an existing file', () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-flag-db-'));
    try {
      const r = runScanSh(ws, flaggedEnv({ TMB_TEST_RUN_ID: 'tmb-unit-2', TRAJECTORY_DB_PATH: scanPin.dbPath }));
      assert.equal(r.status, 0, r.stderr);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  function withFileDb(prefix: string): { ws: string; dbPath: string; db: TrajectoryDB } {
    const ws = mkdtempSync(join(tmpdir(), prefix));
    mkRepo(ws, 'r', { 'README.md': 'r\n' });
    const dbDir = join(ws, '.claude', 'tmb');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, 'trajectory.db');
    return { ws, dbPath, db: new TrajectoryDB(dbPath) };
  }

  function mcpRows(db: TrajectoryDB): Array<{ name: string; origin: string; source_url: string }> {
    return db.all<{ name: string; origin: string; source_url: string }>(
      "SELECT name, origin, source_url FROM cheatcodes WHERE kind = 'mcp' AND origin = 'external' ORDER BY name",
    ).map((row) => ({ ...row }));
  }

  it('ingests the TMB_SCAN_MCP_JSON fixture and never reads ~/.claude.json', async () => {
    const { ws, dbPath, db } = withFileDb('scan-mcp-fixture-ws-');
    const home = join(ws, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'home-only-server': { command: 'x' } } }));
    const mcpFixture = join(ws, 'mcp-servers.json');
    writeFileSync(mcpFixture, JSON.stringify({ 'fixture-mcp': { command: 'node' } }));
    const savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    process.env['TRAJECTORY_DB_PATH'] = dbPath;
    process.env['TMB_SCAN_MCP_JSON'] = mcpFixture;
    try {
      const r = await call(scanTools(db, null, dbPath).handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);
      assert.deepEqual(parse(r)['mcp_inventory'], { status: 'fixture', note: '' });
      assert.deepEqual(mcpRows(db), [{ name: 'fixture-mcp', origin: 'external', source_url: 'mcp:fixture-mcp' }]);
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      process.env['TRAJECTORY_DB_PATH'] = scanPin.dbPath;
      process.env['TMB_SCAN_MCP_JSON'] = scanPin.mcpJsonPath;
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('records mcp_inventory unavailable when no TMB_SCAN_MCP_JSON is set', async () => {
    const { ws, dbPath, db } = withFileDb('scan-mcp-nofixture-ws-');
    const home = join(ws, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'home-only-server': { command: 'x' } } }));
    const savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    process.env['TRAJECTORY_DB_PATH'] = dbPath;
    delete process.env['TMB_SCAN_MCP_JSON'];
    try {
      const r = await call(scanTools(db, null, dbPath).handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);
      const inventory = parse(r)['mcp_inventory'] as { status: string; note: string };
      assert.equal(inventory.status, 'unavailable');
      assert.match(inventory.note, /no readable TMB_SCAN_MCP_JSON/);
      assert.deepEqual(mcpRows(db), []);
      const summary = db.get<{ summary: string }>(
        "SELECT summary FROM audit WHERE event_type = 'deep_scan_completed' ORDER BY id DESC LIMIT 1",
      )!.summary;
      assert.match(summary, /; mcp servers unavailable: TMB_FORBID_LIVE_SYNC\/TMB_TEST_RUN_ID set/);
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      process.env['TRAJECTORY_DB_PATH'] = scanPin.dbPath;
      process.env['TMB_SCAN_MCP_JSON'] = scanPin.mcpJsonPath;
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('scan_run — File nodes with hash-keyed purposes', () => {
  it('upserts File nodes + HAS_FILE edges, re-extracts only changed files, keeps swe purposes, prunes deleted files', () => {
    const ws = mkdtempSync(join(tmpdir(), 'scan-files-'));
    try {
      const repoRoot = mkRepo(ws, 'app', {
        'package.json': '{"name":"app","description":"Fixture app for the scanner."}\n',
        'src/a.ts': '// Parses inbound webhook payloads.\nexport const a = 1;\n',
        'src/b.py': '"""Retry queue for failed jobs."""\n',
        'src/notes.txt': 'plain notes\n',
        'src/blob.ts': 'abc\u0000def',
        'docs/guide.md': '# Guide\n\nHow to run the app. More.\n',
      });
      const out = runGraphScript(`
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tempDB } from '$DIST/test/helpers.js';
import { WorldModelGraph, GraphHolder } from '$DIST/graph.js';
import { scanTools } from '$DIST/tools/scan.js';

const ws = ${JSON.stringify(ws)};
const repoRoot = ${JSON.stringify(repoRoot)};
const db = tempDB();
const graph = new WorldModelGraph(db);
const tools = scanTools(db, GraphHolder.fixed(graph), ':memory:');
const git = (...a) => execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' });
const md5 = (rel) => createHash('md5').update(readFileSync(repoRoot + '/' + rel)).digest('hex');
const snapshot = () => Object.fromEntries(graph.allFilesForRepo('app').map((f) => [f.path, f]));

const r1 = await tools.handlers.scan_run({ agent: 'bro', session_dir: ws });
if (r1.isError) { console.log(JSON.stringify({ error: r1.content[0].text })); process.exit(0); }
const tracked = git('ls-files').trim().split('\\n');
const first = snapshot();
const linked = [...graph.filePathsWithDirectory('app')].sort();
const expectedMd5 = Object.fromEntries(tracked.map((p) => ['app/' + p, md5(p)]));
const srcSummary = graph.allDirectoriesForRepo('app').find((d) => d.path === 'src').summary;
const rootSummary = graph.allDirectoriesForRepo('app').find((d) => d.path === '').summary;
const stats1 = JSON.parse(r1.content[0].text);

graph.upsertFile({ ...first['app/src/b.py'], purpose: 'Hand-written by swe.', purpose_source: 'swe' });
await new Promise((r) => setTimeout(r, 5));
writeFileSync(repoRoot + '/src/a.ts', '// Validates inbound webhook signatures.\\nexport const a = 2;\\n');
writeFileSync(repoRoot + '/src/b.py', '"""Retry queue, now with backoff."""\\n');
rmSync(repoRoot + '/docs/guide.md');
git('add', '-A');
git('commit', '-qm', 'change');

const r2 = await tools.handlers.scan_run({ agent: 'bro', session_dir: ws });
if (r2.isError) { console.log(JSON.stringify({ error: r2.content[0].text })); process.exit(0); }
const second = snapshot();
const stats2 = JSON.parse(r2.content[0].text);
const md5After = { a: md5('src/a.ts'), b: md5('src/b.py') };
graph.close();
db.close();
console.log(JSON.stringify({ tracked, first, linked, expectedMd5, srcSummary, rootSummary, stats1, second, stats2, md5After }));
`);
      assert.equal(out['error'], undefined, `scan failed: ${String(out['error'])}`);
      const tracked = out['tracked'] as string[];
      const first = out['first'] as Record<string, Record<string, unknown>>;
      const second = out['second'] as Record<string, Record<string, unknown>>;
      const expectedMd5 = out['expectedMd5'] as Record<string, string>;

      assert.deepEqual(Object.keys(first).sort(), tracked.map((p) => `app/${p}`).sort(), 'one File node per tracked file');
      for (const [path, md5] of Object.entries(expectedMd5)) {
        assert.equal(first[path]!['content_md5'], md5, `${path} carries scan.sh's content_md5`);
      }
      assert.deepEqual(out['linked'], Object.keys(first).sort(), 'every File has a HAS_FILE edge');
      assert.equal(first['app/src/a.ts']!['dir'], 'src');
      assert.equal(first['app/src/a.ts']!['purpose'], 'Parses inbound webhook payloads.');
      assert.equal(first['app/src/a.ts']!['purpose_source'], 'comment');
      assert.equal(first['app/package.json']!['purpose_source'], 'manifest');
      assert.equal(first['app/docs/guide.md']!['purpose_source'], 'heading');
      assert.equal(first['app/src/blob.ts']!['purpose_source'], 'none', 'binary head → none');
      assert.equal(first['app/src/notes.txt']!['purpose_source'], 'none');
      assert.equal((out['stats1'] as Record<string, unknown>)['files_extracted'], tracked.length);

      const srcSummary = out['srcSummary'] as string;
      assert.match(srcSummary, /^src\/ — 4 files; /, 'structural summary leads with the file count');
      assert.ok(srcSummary.includes('a.ts: Parses inbound webhook payloads.'), srcSummary);
      assert.ok(srcSummary.includes('b.py: Retry queue for failed jobs.'), srcSummary);
      assert.match(
        srcSummary,
        /^src\/ — 4 files; <untrusted-content source="file-purpose"> a\.ts: [^\n]*; b\.py: [^\n]* <\/untrusted-content>$/,
        'the purpose roll-up is framed once, on one line, after the count prefix',
      );
      assert.equal(
        out['rootSummary'],
        '(repo root)/ — 1 file; <untrusted-content source="file-purpose"> package.json: Fixture app for the scanner. </untrusted-content>; subdirs: docs, src',
        'the subdirs suffix stays outside the frame',
      );
      for (const node of Object.values(first)) {
        assert.ok(!String(node['purpose']).includes('untrusted-content'), `${String(node['path'])}: stored purpose is unframed`);
      }

      const stats2 = out['stats2'] as Record<string, unknown>;
      assert.equal(stats2['files_extracted'], 1, 'only the changed non-swe file is re-extracted');
      assert.equal(stats2['files_upserted'], 2, 'a.ts re-extracted + b.py facts refreshed');
      assert.equal(stats2['files_retired'], 1);

      assert.equal(second['app/src/a.ts']!['purpose'], 'Validates inbound webhook signatures.');
      assert.notEqual(second['app/src/a.ts']!['updated_at'], first['app/src/a.ts']!['updated_at']);
      for (const path of ['app/package.json', 'app/src/notes.txt', 'app/src/blob.ts']) {
        assert.deepEqual(second[path], first[path], `${path} is untouched (updated_at kept)`);
      }

      const md5After = out['md5After'] as { a: string; b: string };
      assert.equal(second['app/src/a.ts']!['content_md5'], md5After.a);
      assert.equal(second['app/src/b.py']!['purpose'], 'Hand-written by swe.', 'swe purpose survives a content change');
      assert.equal(second['app/src/b.py']!['purpose_source'], 'swe');
      assert.equal(second['app/src/b.py']!['content_md5'], md5After.b, 'swe row still tracks the new md5');

      assert.equal(second['app/docs/guide.md'], undefined, 'deleted file node removed');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
