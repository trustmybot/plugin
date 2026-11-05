// Scan resource discovery (#124/#846): after the repo/file walk, the walker
// reconciles locally-present resources (project-local skills, plugins, MCP
// servers) into the cheatcodes table: each not-already-tracked resource is
// INSERTed with its lifecycle-correct provenance (a local skill is
// origin=external, source_url='skill:<name>', status=active; #150) plus a
// scan_discovered audit row.
//
// Cases:
//   - a new local skill on disk          → registered + audited
//   - re-run                             → no duplicate (idempotent on name+kind)
//   - already-tracked skill              → untouched, no audit (left to #113)
//   - absent `claude` CLI                → graceful (skills still from disk)
//   - a DB without a cheatcodes table    → graceful skip, the walk still returns
//   - a plugin bundling a same-named MCP server (stub `claude plugin list
//     --json`) → both rows registered once with description/version, exactly
//     two scan_discovered rows; a re-scan adds nothing and writes no stderr
//   - a legacy 'mcp:<server>' row → rewritten to 'mcp:<plugin>/<server>', blank
//     plugin version filled, no audit; a new bundled server inherits the
//     parent plugin's trust_tier
//   - test flags (TMB_FORBID_LIVE_SYNC=1 / TMB_TEST_RUN_ID), each: the walk
//     writes only the DB it is handed, never the session's own
//     .claude/tmb/trajectory.db; the live `claude` is never spawned (plugins
//     from TMB_SCAN_PLUGIN_JSON, else unavailable); MCP servers come from
//     TMB_SCAN_MCP_JSON, never ~/.claude.json; absent → mcp_inventory
//     unavailable. Unflagged, ~/.claude.json is still read (mcp_inventory home).
//   - one plugin listed once per install (GH 2136) → version, enabled and
//     bundled servers come from this project's install (local > project >
//     user); a rescan of the same listing writes nothing
//
// Every walk gets an explicit env (the bash suite's `env -i`), so the runner's
// own test flags never leak into the unflagged cases.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TrajectoryDB } from '../db.js';
import { walkProject, type ScanOutput } from '../tools/scan-walk.js';
import { pinScanEnv, type ScanEnvPin } from './helpers.js';

const TIMEOUT_MS = 60_000;

describe('scan resource discovery (#124/#846)', () => {
  let pin: ScanEnvPin;
  let base = '';
  let ws = '';
  let home = '';
  let noClaudeBin = '';
  let stubBin = '';
  let spyBin = '';
  let spyLog = '';
  let db: TrajectoryDB;

  const seedDb = (): void => {
    db?.close();
    db = new TrajectoryDB(':memory:');
  };
  const mkSkill = (name: string): void => {
    mkdirSync(join(ws, '.claude', 'skills', name), { recursive: true });
    writeFileSync(join(ws, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\nbody\n`);
  };
  const walk = (env: NodeJS.ProcessEnv): Promise<ScanOutput> => walkProject(db, ws, { timeoutMs: TIMEOUT_MS, env });
  const plain = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ HOME: home, PATH: noClaudeBin, ...extra });

  const ccRow = (name: string, kind: string): string =>
    db.get<{ v: string }>(
      "SELECT origin||'|'||COALESCE(source_url,'')||'|'||status||'|'||COALESCE(file_path,'') AS v FROM cheatcodes WHERE name = ? AND kind = ?",
      [name, kind],
    )?.v ?? '';
  const ccCount = (name: string, kind: string): number =>
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cheatcodes WHERE name = ? AND kind = ?', [name, kind])!.n;
  const ccFields = (name: string, kind: string): string =>
    db.get<{ v: string }>(
      "SELECT origin||'|'||source_url||'|'||status||'|'||description||'|'||COALESCE(version,'')||'|'||COALESCE(trust_tier,'') AS v FROM cheatcodes WHERE name = ? AND kind = ?",
      [name, kind],
    )?.v ?? '';
  const auditCount = (prefix: string): number =>
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'scan_discovered' AND summary LIKE ?", [`${prefix}%`])!.n;
  const discoveredTotal = (): number =>
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'scan_discovered'")!.n;
  const rowTotal = (): string =>
    db.get<{ v: string }>("SELECT (SELECT COUNT(*) FROM cheatcodes) || '/' || (SELECT COUNT(*) FROM audit) AS v")!.v;

  async function stderrOf(fn: () => Promise<unknown>): Promise<string> {
    const write = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await fn();
    } finally {
      process.stderr.write = write;
    }
    return captured;
  }

  before(() => {
    pin = pinScanEnv();
    base = mkdtempSync(join(tmpdir(), 'tmb-scan-resource-discovery-'));
    ws = join(base, 'ws');
    home = join(base, 'home');
    mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
    mkdirSync(home);

    noClaudeBin = join(base, 'nocl_bin');
    mkdirSync(noClaudeBin);
    for (const tool of ['git', 'cat']) {
      symlinkSync(execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), join(noClaudeBin, tool));
    }

    stubBin = join(base, 'stub_bin');
    mkdirSync(stubBin);
    writeFileSync(
      join(stubBin, 'claude'),
      '#!/bin/sh\ncase "$*" in\n  "plugin list --json") cat "$STUB_PLUGIN_JSON" ;;\n  *) exit 1 ;;\nesac\n',
    );
    chmodSync(join(stubBin, 'claude'), 0o755);
    mkdirSync(join(base, 'install', 'linear', '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(base, 'install', 'linear', '.claude-plugin', 'plugin.json'),
      '{"name": "linear", "description": "Linear issue tracking"}',
    );
    writeFileSync(
      join(base, 'bundled.json'),
      JSON.stringify([
        {
          id: 'linear@claude-plugins-official',
          version: '1.2.3',
          scope: 'user',
          enabled: true,
          installPath: join(base, 'install', 'linear'),
          mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
        },
      ]),
    );
    writeFileSync(
      join(base, 'legacy.json'),
      JSON.stringify([
        {
          id: 'tmb@trustmybot-dev',
          version: '1.0.2',
          description: 'Trust me bro',
          scope: 'user',
          enabled: true,
          mcpServers: { 'trajectory-server': { command: 'node' }, helper: { command: 'node' } },
        },
      ]),
    );

    spyBin = join(base, 'spy_bin');
    spyLog = join(base, 'claude-calls');
    mkdirSync(spyBin);
    writeFileSync(join(spyBin, 'claude'), `#!/bin/sh\necho "claude $*" >> "${spyLog}"\nexit 97\n`);
    chmodSync(join(spyBin, 'claude'), 0o755);
  });

  after(() => {
    db?.close();
    pin.restore();
    rmSync(base, { recursive: true, force: true });
  });

  describe('Case 1 — a new local skill on disk is registered + audited', () => {
    let out: ScanOutput;
    before(async () => {
      seedDb();
      mkSkill('alpha-skill');
      out = await walk(plain());
    });
    it('scan still emits the world-model JSON', () => {
      assert.equal(out.session_dir, ws);
    });
    it('new local skill registered as external/skill:<name> row', () => {
      assert.equal(ccRow('alpha-skill', 'skill'), 'external|skill:alpha-skill|active|.claude/skills/alpha-skill/SKILL.md');
    });
    it('discovery emits a scan_discovered audit row for the skill', () => {
      assert.equal(auditCount('alpha-skill'), 1);
    });
  });

  describe('Case 2 — re-run is idempotent', () => {
    before(async () => {
      await walk(plain());
    });
    it('re-scan inserts no duplicate cheatcodes row', () => {
      assert.equal(ccCount('alpha-skill', 'skill'), 1);
    });
    it('re-scan emits no second audit row', () => {
      assert.equal(auditCount('alpha-skill'), 1);
    });
  });

  describe('Case 3 — an already-tracked skill is left untouched', () => {
    before(async () => {
      seedDb();
      mkSkill('tracked-skill');
      db.run(
        `INSERT INTO cheatcodes (name, kind, origin, source_url, file_path, status, installed_at)
         VALUES ('tracked-skill', 'skill', 'builtin', NULL, 'skills/tracked-skill/SKILL.md', 'active', 'x')`,
      );
      await walk(plain());
    });
    it('already-tracked skill not duplicated', () => {
      assert.equal(ccCount('tracked-skill', 'skill'), 1);
    });
    it('already-tracked row left untouched (origin/status unchanged)', () => {
      assert.equal(db.get<{ v: string }>("SELECT origin||'|'||status AS v FROM cheatcodes WHERE name = 'tracked-skill'")!.v, 'builtin|active');
    });
    it('already-tracked skill emits no audit row', () => {
      assert.equal(auditCount('tracked-skill'), 0);
    });
  });

  describe('Case 4 — absent claude: skills still reconcile from disk', () => {
    let out: ScanOutput;
    before(async () => {
      seedDb();
      mkSkill('beta-skill');
      rmSync(join(home, '.claude.json'), { force: true });
      out = await walk(plain());
    });
    it('absent claude: scan still emits the world-model JSON', () => {
      assert.equal(out.session_dir, ws);
      assert.deepEqual(out.plugin_inventory, { status: 'unavailable', note: 'claude CLI not on PATH' });
    });
    it('absent claude: local skill still registered from disk', () => {
      assert.equal(ccCount('beta-skill', 'skill'), 1);
    });
    it('absent claude: local skill audited', () => {
      assert.equal(auditCount('beta-skill'), 1);
    });
  });

  it('Case 5 — a DB without a cheatcodes table: scan still returns (graceful skip)', async () => {
    const noTables = { get: () => undefined } as unknown as TrajectoryDB;
    const out = await walkProject(noTables, ws, { timeoutMs: TIMEOUT_MS, env: plain() });
    assert.equal(out.session_dir, ws);
    const skipped = { status: 'skipped', note: 'no trajectory DB with a cheatcodes table' };
    assert.deepEqual(out.plugin_inventory, skipped);
    assert.deepEqual(out.mcp_inventory, skipped);
  });

  describe('Cases 6-7 — a stub claude answers plugin list --json', () => {
    const stubEnv = (fixture: string): NodeJS.ProcessEnv =>
      plain({ PATH: `${stubBin}:${noClaudeBin}`, STUB_PLUGIN_JSON: join(base, fixture) });

    describe('a plugin bundling a same-named server', () => {
      let err = '';
      let out: ScanOutput | null = null;
      before(async () => {
        rmSync(join(ws, '.claude', 'skills'), { recursive: true, force: true });
        seedDb();
        err = await stderrOf(async () => {
          out = await walk(stubEnv('bundled.json'));
        });
      });
      it('first scan writes no stderr', () => {
        assert.equal(err, '');
        assert.deepEqual(out!.plugin_inventory, { status: 'cli', note: '' });
      });
      it('plugin row registered with manifest description + version', () => {
        assert.equal(ccFields('linear', 'plugin'), 'marketplace|linear@claude-plugins-official|active|Linear issue tracking|1.2.3|');
      });
      it('same-named bundled server registered as mcp:<plugin>/<server>', () => {
        assert.equal(ccFields('linear', 'mcp'), 'marketplace|mcp:linear/linear|active|linear MCP server bundled by linear|1.2.3|');
      });
      it('exactly two scan_discovered audit rows', () => {
        assert.equal(discoveredTotal(), 2);
      });
      it('re-scan adds zero cheatcodes and zero audit rows, and writes no stderr', async () => {
        const before = rowTotal();
        const rescanErr = await stderrOf(() => walk(stubEnv('bundled.json')));
        assert.equal(rowTotal(), before);
        assert.equal(rescanErr, '');
      });
    });

    describe('a legacy mcp:<server> row', () => {
      let err = '';
      before(async () => {
        seedDb();
        db.run(
          `INSERT INTO cheatcodes (name, kind, origin, source_url, trust_tier, scope, status, installed_at)
             VALUES ('tmb', 'plugin', 'marketplace', 'tmb@trustmybot-dev', 'reputable', 'project-local', 'active', 'x'),
                    ('trajectory-server', 'mcp', 'marketplace', 'mcp:trajectory-server', NULL, 'project-local', 'active', 'x')`,
        );
        err = await stderrOf(() => walk(stubEnv('legacy.json')));
      });
      it('legacy scan writes no stderr', () => {
        assert.equal(err, '');
      });
      it('legacy mcp:<server> row rewritten to mcp:<plugin>/<server> with manifest fields', () => {
        assert.equal(
          ccFields('trajectory-server', 'mcp'),
          'marketplace|mcp:tmb/trajectory-server|active|trajectory-server MCP server bundled by tmb|1.0.2|',
        );
      });
      it('existing plugin row gains its blank description + NULL version, keeps trust_tier', () => {
        assert.equal(ccFields('tmb', 'plugin'), 'marketplace|tmb@trustmybot-dev|active|Trust me bro|1.0.2|reputable');
      });
      it("new bundled server inherits the parent plugin's trust_tier", () => {
        assert.equal(ccFields('helper', 'mcp'), 'marketplace|mcp:tmb/helper|active|helper MCP server bundled by tmb|1.0.2|reputable');
      });
      it('only the new server is audited', () => {
        assert.equal(discoveredTotal(), 1);
        assert.equal(auditCount('helper'), 1);
      });
    });
  });

  describe('Cases 8-11 — test flags never reach the live CLI or ~/.claude.json', () => {
    before(() => {
      writeFileSync(join(home, '.claude.json'), '{"mcpServers": {"home-server": {"command": "x"}}}');
      writeFileSync(join(base, 'mcp-servers.json'), '{"fixture-server": {"command": "node"}}');
    });

    for (const [flag, value] of [['TMB_FORBID_LIVE_SYNC', '1'], ['TMB_TEST_RUN_ID', 'tmb-l3-scan']] as const) {
      it(`${flag}: the walk writes only the DB it is handed, never the session's own DB (no walk-up)`, async () => {
        const projectDbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
        const projectDb = new TrajectoryDB(projectDbPath);
        const projectRows = (): string =>
          projectDb.get<{ v: string }>("SELECT (SELECT COUNT(*) FROM cheatcodes) || '/' || (SELECT COUNT(*) FROM audit) AS v")!.v;
        const originalCwd = process.cwd();
        try {
          const rowsBefore = projectRows();
          seedDb();
          mkSkill('walk-skill');
          process.chdir(ws);
          await walk(plain({ [flag]: value }));
          assert.equal(ccCount('walk-skill', 'skill'), 1, 'the handed DB gets the skill');
          assert.equal(projectRows(), rowsBefore, "the session's own DB is untouched");
        } finally {
          process.chdir(originalCwd);
          rmSync(join(ws, '.claude', 'skills'), { recursive: true, force: true });
          projectDb.close();
          rmSync(projectDbPath, { force: true });
          rmSync(`${projectDbPath}-wal`, { force: true });
          rmSync(`${projectDbPath}-shm`, { force: true });
        }
      });

      it(`${flag}, claude on PATH: never spawned, plugins unavailable`, async () => {
        seedDb();
        rmSync(spyLog, { force: true });
        const out = await walk(plain({ [flag]: value, PATH: `${spyBin}:${noClaudeBin}` }));
        assert.equal(out.plugin_inventory!.status, 'unavailable');
        assert.match(out.plugin_inventory!.note, /claude plugin list skipped/);
        assert.equal(existsSync(spyLog), false, 'claude not spawned');
      });

      it(`${flag}, TMB_SCAN_PLUGIN_JSON: plugins from the fixture, claude never spawned`, async () => {
        seedDb();
        rmSync(spyLog, { force: true });
        const out = await walk(plain({
          [flag]: value, PATH: `${spyBin}:${noClaudeBin}`, TMB_SCAN_PLUGIN_JSON: join(base, 'bundled.json'),
        }));
        assert.equal(out.plugin_inventory!.status, 'fixture');
        assert.equal(ccCount('linear', 'plugin'), 1);
        assert.equal(existsSync(spyLog), false, 'claude not spawned with a fixture');
      });
    }

    it('flagged with TMB_SCAN_MCP_JSON: fixture server registered, ~/.claude.json unread', async () => {
      seedDb();
      const out = await walk(plain({ TMB_TEST_RUN_ID: 'tmb-l3-scan', TMB_SCAN_MCP_JSON: join(base, 'mcp-servers.json') }));
      assert.deepEqual(out.mcp_inventory, { status: 'fixture', note: '' });
      assert.equal(ccRow('fixture-server', 'mcp'), 'external|mcp:fixture-server|active|');
      assert.equal(ccCount('home-server', 'mcp'), 0);
    });

    it('flagged without TMB_SCAN_MCP_JSON: mcp_inventory unavailable, nothing registered', async () => {
      seedDb();
      const out = await walk(plain({ TMB_FORBID_LIVE_SYNC: '1' }));
      assert.equal(out.mcp_inventory!.status, 'unavailable');
      assert.match(out.mcp_inventory!.note, /no readable TMB_SCAN_MCP_JSON/);
      assert.equal(ccCount('home-server', 'mcp'), 0);
    });

    it('unflagged: ~/.claude.json still read', async () => {
      seedDb();
      const out = await walk(plain());
      assert.equal(out.mcp_inventory!.status, 'home');
      assert.equal(ccRow('home-server', 'mcp'), 'external|mcp:home-server|active|');
    });
  });
});

describe('scan plugin version follows this project\'s install (GH 2136)', () => {
  it('GH 2136: a local install at the project root beats user and other-project installs, and a rescan writes nothing', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-scan-gh2136-')));
    mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
    const db = new TrajectoryDB(join(ws, '.claude', 'tmb', 'trajectory.db'));
    const elsewhere = join(ws, '..', 'gh2136-other-project');
    const fixture = join(ws, 'plugins.json');
    const servers = { 'traj-server': {} };
    writeFileSync(fixture, JSON.stringify([
      { id: 'tmb@m', version: '1.0.0', scope: 'local', enabled: true, projectPath: elsewhere, mcpServers: servers },
      { id: 'tmb@m', version: '3.0.0', scope: 'user', enabled: false, mcpServers: servers },
      { id: 'tmb@m', version: '2.0.0', scope: 'local', enabled: true, projectPath: `${ws}/.`, mcpServers: servers },
      { id: 'tmb@m', version: '1.5.0', scope: 'local', enabled: true, projectPath: elsewhere, mcpServers: servers },
      { id: 'proj@m', version: '1.0.0', scope: 'user', enabled: true },
      { id: 'proj@m', version: '1.1.0', scope: 'project', enabled: true, projectPath: ws },
      { id: 'away@m', version: '9.0.0', scope: 'local', enabled: true, projectPath: elsewhere, mcpServers: { 'away-server': {} } },
    ]));
    const env = { HOME: join(ws, 'home'), PATH: process.env['PATH'], TMB_FORBID_LIVE_SYNC: '1', TMB_SCAN_PLUGIN_JSON: fixture };
    const OLD = '2000-01-01T00:00:00.000Z';
    const rows = () =>
      db.all<{ name: string; kind: string; status: string; version: string | null; updated_at: string }>(
        "SELECT name, kind, status, version, updated_at FROM cheatcodes WHERE kind IN ('plugin', 'mcp') ORDER BY kind, name",
      ).map((r) => ({ ...r }));
    try {
      await walkProject(db, ws, { timeoutMs: TIMEOUT_MS, env });
      assert.deepEqual(rows().map(({ name, kind, status, version }) => ({ name, kind, status, version })), [
        { name: 'traj-server', kind: 'mcp', status: 'active', version: '2.0.0' },
        { name: 'away', kind: 'plugin', status: 'installed', version: null },
        { name: 'proj', kind: 'plugin', status: 'active', version: '1.1.0' },
        { name: 'tmb', kind: 'plugin', status: 'active', version: '2.0.0' },
      ]);
      db.run("UPDATE cheatcodes SET updated_at = ? WHERE kind IN ('plugin', 'mcp')", [OLD]);
      await walkProject(db, ws, { timeoutMs: TIMEOUT_MS, env });
      assert.ok(rows().every((r) => r.updated_at === OLD), JSON.stringify(rows()));
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('GH 2136: an enabled synced or managed install registers active at its version with its bundled MCP row', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-scan-gh2136-synced-')));
    mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
    const db = new TrajectoryDB(join(ws, '.claude', 'tmb', 'trajectory.db'));
    const fixture = join(ws, 'plugins.json');
    writeFileSync(fixture, JSON.stringify([
      { id: 'dc@synced', version: '0.2.0', scope: 'synced', enabled: true, mcpServers: { 'dc-server': {} } },
      { id: 'mg@m', version: '0.3.0', scope: 'managed', enabled: true },
    ]));
    const env = { HOME: join(ws, 'home'), PATH: process.env['PATH'], TMB_FORBID_LIVE_SYNC: '1', TMB_SCAN_PLUGIN_JSON: fixture };
    try {
      await walkProject(db, ws, { timeoutMs: TIMEOUT_MS, env });
      const rows = db.all<{ name: string; kind: string; status: string; version: string | null }>(
        "SELECT name, kind, status, version FROM cheatcodes WHERE kind IN ('plugin', 'mcp') ORDER BY kind, name",
      ).map((r) => ({ ...r }));
      assert.deepEqual(rows, [
        { name: 'dc-server', kind: 'mcp', status: 'active', version: '0.2.0' },
        { name: 'dc', kind: 'plugin', status: 'active', version: '0.2.0' },
        { name: 'mg', kind: 'plugin', status: 'active', version: '0.3.0' },
      ]);
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
