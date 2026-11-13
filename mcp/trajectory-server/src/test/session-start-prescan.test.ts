/**
 * session-start-prescan (GH 1692): the output is valid JSON with a string
 * additionalContext, cache-friendly ordering (stable lines before volatile
 * ones), a cold world model printing the startup catch-up note and spawning
 * no scan, the warm / stale / cold world-model banner (cold = empty
 * wm_directories), the Top-level
 * dirs and Stacks detected lines, the Trajectory DB data-contract banner, the
 * duplicate-plugin line, the version-skew line, the pre-1.1.0 user-wide hooks
 * line (alone and next to mcp-health-check), the Tooling line naming a missing
 * jq, and no Persona line (the persona hooks own that). Every case runs
 * `node dist/hooks.js session-start-prescan` (or a copy of the bundle under a
 * fake install root) from a fixture git repo in a sandbox with its own HOME,
 * CLAUDE_CONFIG_DIR and TMB_INSTALLED_JSON, never the real ones.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { COLD_NOTE } from '../hooks/session-start-prescan.js';
import { contextOf, GIT_ENV, HOOKS_JS, jsonValues, lines, makeSandbox, noCmdPath, PLUGIN_ROOT, runGate, type Sandbox, without } from './hook-sandbox.js';

const GATE = 'session-start-prescan';
const IN_SESSION_CMD = /(^|[ `"'(])\/(plugin|reload-plugins|mcp)([ `"'),.;:]|$)/m;
const LEGACY_DOC = 'docs/architecture/INSTALL.md#upgrading-into-v110--remove-leftover-user-wide-hooks';
const LEGACY_ENTRIES = 'line 10 git-guards, line 23 agent-spawn-dispatch, line 33 swe-scope-guard';
const LEGACY_FIXTURE = join(PLUGIN_ROOT, 'tests/l3-integration/hooks/fixtures/legacy-user-settings.json');
const SCHEMA_VERSION = String((JSON.parse(readFileSync(join(PLUGIN_ROOT, 'scripts/hooks/lib/data-contracts.json'), 'utf8')) as { schema_version: unknown }).schema_version);

const RESET_SQL = `
  PRAGMA journal_mode=DELETE;
  CREATE TABLE issues (id INTEGER PRIMARY KEY AUTOINCREMENT, objective TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL);
  INSERT INTO issues (objective, status) VALUES ('test issue', 'open');
  INSERT INTO tasks (issue_id, status) VALUES (1, 'pending');
`;

const lineStarting = (text: string, prefix: string) => lines(text).filter((l) => l.startsWith(prefix)).join('\n');
const lineAfter = (text: string, prefix: string) => {
  const ls = lines(text);
  return ls[ls.findIndex((l) => l.startsWith(prefix)) + 1] ?? '';
};
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('session-start-prescan: the SessionStart inventory', () => {
  let sb: Sandbox;
  let ws: string;
  let db: string;
  let schemaDb: string;
  let base: NodeJS.ProcessEnv;
  let fakeHooksJs: string;
  let flag: string;
  let installedJson: string;
  let configDir: string;
  let out = '';
  let ctx = '';

  const git = (...args: string[]) => execFileSync('git', args, { env: { ...sb.env, ...GIT_ENV }, stdio: 'pipe', encoding: 'utf8' }).trim();

  function initRepo(dir: string, files: string[]): void {
    mkdirSync(dir, { recursive: true });
    git('-C', dir, 'init', '-q');
    git('-C', dir, 'config', 'user.email', 'test@example.com');
    git('-C', dir, 'config', 'user.name', 'Test');
    if (files.length === 0) return;
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), '');
    }
    git('-C', dir, 'add', '.');
    git('-C', dir, 'commit', '-q', '-m', 'initial commit');
  }

  function sql(path: string, text: string): void {
    const d = new DatabaseSync(path);
    try {
      d.exec(text);
    } finally {
      d.close();
    }
  }

  function insert(path: string, text: string, ...params: string[]): void {
    const d = new DatabaseSync(path);
    try {
      d.prepare(text).run(...params);
    } finally {
      d.close();
    }
  }

  function resetDb(): void {
    for (const s of ['', '-wal', '-shm']) rmSync(`${db}${s}`, { force: true });
    sql(db, RESET_SQL);
  }

  function makeSchemaDb(): void {
    for (const s of ['', '-wal', '-shm']) rmSync(`${schemaDb}${s}`, { force: true });
    const schema = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.startsWith('PRAGMA journal_mode'))
      .join('\n');
    sql(schemaDb, schema);
    sql(schemaDb, "INSERT INTO audit (issue_id, from_node, event_type, summary, created_at) VALUES (-1, 'system', 'deep_scan_completed', 'fixture', strftime('%Y-%m-%dT%H:%M:%fZ','now'));");
  }

  function killFixtureNode(): Promise<void> {
    spawnSync('pkill', ['-f', sb.dir]);
    return sleep(100);
  }

  function scanRows(path: string): number {
    const d = new DatabaseSync(path);
    try {
      return Number((d.prepare("SELECT count(*) AS n FROM audit WHERE event_type = 'deep_scan_completed'").get() as { n: number }).n);
    } finally {
      d.close();
    }
  }

  /** The prescan from <cwd> with the base env plus <extra>; the fake install root's bundle when <fake>. */
  function hook(extra: NodeJS.ProcessEnv, opts: { cwd?: string; fake?: boolean; env?: NodeJS.ProcessEnv } = {}) {
    return runGate(GATE, { cwd: opts.cwd ?? ws, env: { ...(opts.env ?? base), ...extra }, hooksJs: opts.fake ? fakeHooksJs : HOOKS_JS });
  }
  const wsEnv = (dbPath: string, extra: NodeJS.ProcessEnv = {}) => ({ CLAUDE_PROJECT_DIR: ws, TRAJECTORY_DB_PATH: dbPath, ...extra });
  const runHook = () => hook(wsEnv(db)).stdout;
  const doctorLine = (extra: NodeJS.ProcessEnv = {}) => lineStarting(contextOf(hook(wsEnv(schemaDb, { ...extra })).stdout), 'Trajectory DB:');

  before(() => {
    sb = makeSandbox(GATE);
    ws = join(sb.dir, 'fixture-workspace');
    db = join(sb.dir, 'trajectory.db');
    schemaDb = join(sb.dir, 'schema-trajectory.db');
    flag = join(sb.dir, 'invoked');
    installedJson = join(sb.dir, 'installed_plugins.json');
    configDir = join(sb.dir, 'claude-config');
    base = { ...sb.env, TMB_INSTALLED_JSON: installedJson, CLAUDE_CONFIG_DIR: configDir };
    initRepo(ws, ['README.txt', 'src/main.sh']);

    const fakeRoot = join(sb.dir, 'fake-root');
    const dist = join(fakeRoot, 'mcp/trajectory-server/dist');
    mkdirSync(join(fakeRoot, '.claude-plugin'), { recursive: true });
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(fakeRoot, 'scripts/hooks'), { recursive: true });
    mkdirSync(join(fakeRoot, 'scripts/maintenance'), { recursive: true });
    writeFileSync(join(fakeRoot, '.claude-plugin/plugin.json'), '{"name":"tmb"}\n');
    fakeHooksJs = join(dist, 'hooks.js');
    copyFileSync(HOOKS_JS, fakeHooksJs);
    const invoker = "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.INVOCATION_FLAG, process.env.TRAJECTORY_DB_PATH ?? '<unset>');\n";
    writeFileSync(join(dist, 'run-scan.js'), invoker);
    writeFileSync(join(fakeRoot, 'scripts/maintenance/run-scan.mjs'), invoker);

    resetDb();
    out = runHook();
    ctx = contextOf(out);
  });

  after(async () => {
    await killFixtureNode();
    sb.remove();
  });

  describe('output shape and order', () => {
    it('hook emits non-empty output', () => assert.notEqual(out, '', 'hook produced output'));

    it('output is valid JSON', () => assert.doesNotThrow(() => JSON.parse(out), `output is valid JSON: ${out}`));

    it('output contains hookSpecificOutput and the SessionStart event', () => {
      assert.ok(out.includes('hookSpecificOutput'), 'JSON has hookSpecificOutput');
      assert.ok(out.includes('SessionStart'), 'JSON has SessionStart');
    });

    it('additionalContext is a string', () => {
      assert.equal(typeof (JSON.parse(out) as { hookSpecificOutput: { additionalContext: unknown } }).hookSpecificOutput.additionalContext, 'string');
    });

    it('stable and volatile lines are present', () => {
      for (const m of ['Top-level dirs:', 'Stacks detected:', 'World model:', 'Git branch:', 'Open issues:', 'Pending tasks:', 'Last 5 commits:']) assert.ok(ctx.includes(m), `${m} line present`);
    });

    it('Top-level dirs: a root holding files and a dir lists only the dir', () => {
      assert.equal(lineStarting(ctx, 'Top-level dirs:'), 'Top-level dirs:    src', 'README.txt is not a dir');
    });

    it("ordering: 'Top-level dirs' (stable) appears before 'Git branch' (volatile)", () => {
      const stable = ctx.indexOf('Top-level dirs:');
      const volatile = ctx.indexOf('Git branch:');
      assert.ok(stable >= 0 && volatile >= 0, `markers located: ${stable} ${volatile}`);
      assert.ok(stable < volatile, `stable marker at ${stable} before volatile marker at ${volatile}`);
    });

    it("ordering: 'World model' (stable) appears before 'Open issues' (volatile)", () => {
      const wm = ctx.indexOf('World model:');
      const oi = ctx.indexOf('Open issues:');
      assert.ok(wm >= 0 && oi >= 0, `markers located: ${wm} ${oi}`);
      assert.ok(wm < oi, `world-model marker at ${wm} before open-issues marker at ${oi}`);
    });

    it('missing DB: hook exits silently (no output)', () => {
      for (const s of ['', '-wal', '-shm']) rmSync(`${db}${s}`, { force: true });
      assert.equal(hook(wsEnv(db)).stdout, '', 'no output when DB missing');
      resetDb();
    });
  });

  describe('cold session', () => {
    let coldCtx = '';
    let wsCtx = '';
    let wsRoot = '';
    let nonRepo = '';
    const wsHook = () => contextOf(hook({ CLAUDE_PROJECT_DIR: wsRoot, TRAJECTORY_DB_PATH: db }, { cwd: nonRepo }).stdout);

    it('cold: the banner reads cold and the note points at the startup catch-up', async () => {
      await killFixtureNode();
      rmSync(flag, { force: true });
      coldCtx = contextOf(hook(wsEnv(db, { INVOCATION_FLAG: flag }), { fake: true }).stdout);
      assert.ok(coldCtx.includes('World model:       cold'), 'cold banner when no scan row exists');
      assert.ok(coldCtx.includes(COLD_NOTE), 'cold note names the startup catch-up');
      assert.ok(!coldCtx.includes('scan is running in the background'), 'no background scan message');
      assert.ok(!coldCtx.includes('tell the Human to run /scan'), 'no manual scan instruction');
    });

    it('cold: spawns nothing (no invoker call, no scan.lock, no new deep_scan_completed row)', async () => {
      await killFixtureNode();
      rmSync(flag, { force: true });
      const projectDb = join(ws, '.claude/tmb/trajectory.db');
      mkdirSync(dirname(projectDb), { recursive: true });
      copyFileSync(db, projectDb);
      const before = scanRows(projectDb);
      const env = without(base, 'TRAJECTORY_DB_PATH', 'CLAUDE_PLUGIN_ROOT');
      const c = contextOf(hook({ CLAUDE_PROJECT_DIR: ws, TMB_FORBID_LIVE_SYNC: '1', INVOCATION_FLAG: flag }, { fake: true, env }).stdout);
      assert.ok(c.includes(COLD_NOTE), 'cold note printed');
      await sleep(1000);
      assert.ok(!existsSync(flag), 'no scan invoker was called');
      assert.ok(!existsSync(join(dirname(projectDb), 'scan.lock')), 'no scan.lock beside the project DB');
      assert.equal(scanRows(projectDb), before, 'no new deep_scan_completed row');
      rmSync(join(ws, '.claude'), { recursive: true, force: true });
    });

    it('cold workspace: source files are summed across registered repos on one line', async () => {
      await killFixtureNode();
      resetDb();
      wsRoot = join(sb.dir, 'ws');
      for (const [name, n] of [['alpha', 2], ['beta', 3]] as const) {
        initRepo(
          join(wsRoot, name),
          Array.from({ length: n }, (_, i) => `file${i + 1}.txt`),
        );
        insert(db, "INSERT INTO repos (name, path, last_scanned_at) VALUES (?, ?, '2026-01-01T00:00:00Z')", name, join(wsRoot, name));
      }
      wsCtx = contextOf(hook({ CLAUDE_PROJECT_DIR: wsRoot, TRAJECTORY_DB_PATH: db }, { cwd: wsRoot }).stdout);
      assert.ok(wsCtx.includes('cold (no scan yet; 5 source files)'), 'workspace sum of 2 + 3 files');
    });

    it('non-repo cwd: the inventory names every repos row with its own branch, stacks and commits', () => {
      writeFileSync(join(wsRoot, 'beta/package.json'), '{}\n');
      git('-C', join(wsRoot, 'beta'), 'checkout', '-q', '-b', 'feature-x');
      nonRepo = join(sb.dir, 'not-a-repo');
      mkdirSync(nonRepo);
      const nr = wsHook();
      const alphaBranch = git('-C', join(wsRoot, 'alpha'), 'rev-parse', '--abbrev-ref', 'HEAD');
      assert.ok(nr.includes('Top-level dirs:    alpha beta'), 'top-level dirs come from the project root');
      assert.ok(nr.includes('Stacks detected:   alpha: (none detected); beta: Node'), 'stacks per repos row');
      assert.ok(nr.includes(`Git branch:        alpha: ${alphaBranch} (1 commits, 0 dirty paths); beta: feature-x (1 commits, 1 dirty paths)`), 'branch per repos row');
      assert.ok(nr.includes('  [alpha] '), "alpha's commits are labelled");
      assert.ok(nr.includes('  [beta] '), "beta's commits are labelled");
      rmSync(join(wsRoot, 'beta/package.json'));
    });

    it('a repo whose only manifest sits in a subdir names the stack and the subdir', () => {
      mkdirSync(join(wsRoot, 'beta/framework'));
      writeFileSync(join(wsRoot, 'beta/framework/package.json'), '{}\n');
      assert.ok(wsHook().includes('Stacks detected:   alpha: (none detected); beta: Node (framework/)'), 'subdir stack labelled');
      rmSync(join(wsRoot, 'beta/framework'), { recursive: true });
    });

    it('a repos row whose dir is gone is reported missing; the World model row is one line', () => {
      insert(db, "INSERT INTO repos (name, path, last_scanned_at) VALUES ('gone', ?, '2026-01-01T00:00:00Z')", join(wsRoot, 'gone'));
      assert.ok(wsHook().includes(`gone: missing (${join(wsRoot, 'gone')})`), 'missing repo dir named');
      assert.equal(lines(wsCtx).filter((l) => l.startsWith('World model:')).length, 1, 'World model row starts once');
      assert.equal(lineAfter(wsCtx, 'World model:').slice(0, 14), 'Trajectory DB:', 'World model row is a single line');
    });

    it('cold empty tree: a single 0 source files and no cold note', async () => {
      await killFixtureNode();
      resetDb();
      const emptyRepo = join(sb.dir, 'empty-repo');
      initRepo(emptyRepo, []);
      rmSync(flag, { force: true });
      const c = contextOf(hook({ CLAUDE_PROJECT_DIR: emptyRepo, TRAJECTORY_DB_PATH: db, INVOCATION_FLAG: flag }, { cwd: emptyRepo, fake: true }).stdout);
      assert.ok(c.includes('cold (no scan yet; 0 source files)'), 'zero tracked files');
      assert.equal(count(c, '0 source files'), 1, '0 source files appears exactly once');
      assert.equal(lineStarting(c, 'World model:'), 'World model:       cold (no scan yet; 0 source files)', 'no doubled 0 in the World model row');
      assert.equal(lineAfter(c, 'World model:').slice(0, 14), 'Trajectory DB:', 'World model row is a single line');
      assert.ok(!c.includes(COLD_NOTE), 'no cold note on an empty tree');
      await sleep(300);
      assert.ok(!existsSync(flag), 'invoker not called for an empty tree');
      resetDb();
    });
  });

  describe('warm and stale world model', () => {
    let warmCtx = '';
    let staleCtx = '';

    it('scan row + repos but an empty wm_directories reads cold and spawns nothing', async () => {
      await killFixtureNode();
      rmSync(flag, { force: true });
      sql(
        db,
        `CREATE TABLE wm_directories (id INTEGER PRIMARY KEY, repo TEXT NOT NULL, path TEXT NOT NULL);
         INSERT INTO audit (event_type) VALUES ('deep_scan_completed');`,
      );
      insert(db, "INSERT INTO repos (name, path, file_count, last_scanned_at) VALUES ('fixture', ?, 42, strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'))", ws);
      const before = scanRows(db);
      const c = contextOf(hook(wsEnv(db, { INVOCATION_FLAG: flag }), { fake: true }).stdout);
      assert.ok(c.includes('World model:       cold'), 'empty graph reads cold');
      assert.ok(!c.includes('warm'), 'empty graph never reads warm');
      assert.ok(c.includes(COLD_NOTE), 'empty graph prints the cold note');
      await sleep(1000);
      assert.ok(!existsSync(flag), 'no scan invoker was called for an empty graph');
      assert.ok(!existsSync(join(dirname(db), 'scan.lock')), 'no scan.lock beside the DB');
      assert.equal(scanRows(db), before, 'no new deep_scan_completed row');
    });

    it('warm: context shows warm world model with file count and age, no scan or cold note', async () => {
      await killFixtureNode();
      sql(db, "INSERT INTO wm_directories (repo, path) VALUES ('fixture', '');");
      warmCtx = contextOf(hook(wsEnv(db)).stdout);
      assert.ok(warmCtx.includes('World model:       warm (42 files, last scan 3h ago)'), 'warm banner with age');
      assert.ok(!warmCtx.includes('scan is running in the background'), 'no scan note in warm session');
      assert.ok(!warmCtx.includes('world model is cold'), 'no cold message in warm session');
    });

    it('stale: last scan past 7 days reads stale with age and /scan hint, never warm', () => {
      sql(db, "UPDATE repos SET last_scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days');");
      staleCtx = contextOf(hook(wsEnv(db)).stdout);
      assert.ok(staleCtx.includes('World model:       stale (last scan 12d ago) — run /scan'), 'stale banner');
      assert.ok(!staleCtx.includes('warm'), 'stale model is not warm');
    });

    it('stale: a scan row with no repos row still reads stale, never warm', () => {
      sql(db, 'DELETE FROM repos;');
      assert.ok(contextOf(hook(wsEnv(db)).stdout).includes('World model:       stale (last scan unknown) — run /scan'), 'unknown age reads stale');
    });
  });

  describe('Trajectory DB data-contract banner', () => {
    it('clean schema DB reports healthy', () => {
      makeSchemaDb();
      assert.equal(doctorLine(), 'Trajectory DB:     healthy', 'healthy banner');
    });

    it('the line sits right after the World model line', () => {
      makeSchemaDb();
      const c = contextOf(hook(wsEnv(schemaDb)).stdout);
      assert.ok(lineAfter(c, 'World model:').includes('Trajectory DB:'), 'Trajectory DB line follows World model');
    });

    it('violations are counted and named', () => {
      makeSchemaDb();
      sql(
        schemaDb,
        `INSERT INTO issues (objective, status, created_at, updated_at) VALUES ('closed', 'closed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
         INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at)
           VALUES (last_insert_rowid(), 'feat/x', 'd', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
         INSERT INTO audit (issue_id, from_node, event_type, summary, created_at) VALUES (-1, 'system', 'made_up_event', 'x', strftime('%Y-%m-%dT%H:%M:%fZ','now'));`,
      );
      assert.equal(doctorLine(), 'Trajectory DB:     2 contract violation(s) [event_type_documented, issues_closed_no_live_tasks] — run trajectory_doctor', 'violations banner');
    });

    it('a spent budget reports unchecked (timeout), never healthy', () => {
      makeSchemaDb();
      assert.equal(doctorLine({ TMB_DOCTOR_BUDGET_MS: '1' }), 'Trajectory DB:     unchecked (timeout)', 'timeout banner');
    });

    it('an older schema names the version gap, never healthy', () => {
      makeSchemaDb();
      sql(schemaDb, 'UPDATE plugin_meta SET schema_version = 29 WHERE id = 1; ALTER TABLE agent_runs RENAME COLUMN session_id TO session_id_v29;');
      assert.equal(doctorLine(), `Trajectory DB:     unchecked (schema v29 < v${SCHEMA_VERSION} — start the trajectory server to migrate)`, 'schema banner');
    });

    it('an older schema with every contract column present still names the gap, never healthy', () => {
      makeSchemaDb();
      sql(schemaDb, 'UPDATE plugin_meta SET schema_version = 30 WHERE id = 1;');
      assert.equal(doctorLine(), `Trajectory DB:     unchecked (schema v30 < v${SCHEMA_VERSION} — start the trajectory server to migrate)`, 'schema banner with all columns');
    });

    it('a DB the contracts cannot read reports unchecked, never healthy', () => {
      resetDb();
      const line = lineStarting(contextOf(hook(wsEnv(db)).stdout), 'Trajectory DB:');
      assert.ok(!line.includes('healthy'), 'no healthy banner on read errors');
      assert.ok(line.includes('unchecked'), 'read errors leave contracts unchecked');
    });
  });

  describe('duplicate enabled plugin copies', () => {
    let dupHome = '';
    let localSettings = '';
    let dupErr = '';
    const entry = (scope: string, v: string) => JSON.stringify({ scope, projectPath: ws, installPath: `/cache/${v}`, version: v });
    function dupLine(): string {
      const r = hook(wsEnv(schemaDb, { HOME: dupHome }));
      dupErr = r.stderr;
      return lineStarting(contextOf(r.stdout), 'Plugin:');
    }

    before(() => {
      dupHome = join(sb.dir, 'dup-home');
      mkdirSync(dupHome);
      mkdirSync(join(ws, '.claude'), { recursive: true });
      localSettings = join(ws, '.claude/settings.local.json');
      makeSchemaDb();
    });

    it('one enabled copy is silent', () => {
      writeFileSync(installedJson, `{"plugins":{"tmb@trustmybot-dev":[${entry('local', '1.0.3')}]}}`);
      writeFileSync(localSettings, '{"enabledPlugins":{"tmb@trustmybot-dev":true}}\n');
      assert.equal(dupLine(), '', 'no Plugin line');
    });

    it('two enabled copies for this project add one line naming both', () => {
      writeFileSync(installedJson, `{"plugins":{"tmb@trustmybot-dev":[${entry('local', '1.0.3')}],"tmb@trustmybot-rc":[${entry('project', '1.0.2-rc.3')}]}}`);
      writeFileSync(localSettings, '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}\n');
      const line = dupLine();
      assert.equal(
        line,
        'Plugin: duplicate tmb copies enabled (trustmybot-dev, trustmybot-rc) — hooks from one are dropped; keep one and disable the others from the project root (claude plugin disable tmb@trustmybot-dev --scope local; claude plugin disable tmb@trustmybot-rc --scope project), then fully quit and relaunch Claude Code',
        'Plugin line names a scoped disable per copy and a full restart',
      );
      assert.ok(!IN_SESSION_CMD.test(line), 'Plugin line names no /plugin, /reload-plugins or /mcp');
    });

    it('two installed, one disabled is silent', () => {
      writeFileSync(localSettings, '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":false}}\n');
      assert.equal(dupLine(), '', 'no Plugin line');
    });

    it('a user and a project entry of one marketplace are one copy', () => {
      writeFileSync(installedJson, `{"plugins":{"tmb@trustmybot-dev":[${entry('user', '1.0.1')},${entry('local', '1.0.3')}]}}`);
      writeFileSync(localSettings, '{"enabledPlugins":{"tmb@trustmybot-dev":true}}\n');
      assert.equal(dupLine(), '', 'no Plugin line');
    });

    it('unreadable files are silent with no error', () => {
      writeFileSync(installedJson, `{"plugins":{"tmb@trustmybot-dev":[${entry('local', '1.0.3')}],"tmb@trustmybot-rc":[${entry('local', '1.0.2-rc.3')}]}}`);
      writeFileSync(localSettings, '{"enabledPlugins":\n');
      assert.equal(dupLine(), '', 'invalid settings.local.json: no Plugin line');
      assert.equal(dupErr, '', 'invalid settings.local.json: no stderr');
      writeFileSync(localSettings, '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}\n');
      chmodSync(installedJson, 0o000);
      try {
        assert.equal(dupLine(), '', 'unreadable installed_plugins.json: no Plugin line');
        assert.equal(dupErr, '', 'unreadable installed_plugins.json: no stderr');
      } finally {
        chmodSync(installedJson, 0o600);
        rmSync(installedJson, { force: true });
        rmSync(localSettings, { force: true });
      }
    });

    it('version skew: names a full quit and relaunch, no in-session command', () => {
      const skewRoot = join(sb.dir, 'skew-cache/trustmybot-dev/tmb/1.0.0');
      mkdirSync(join(skewRoot, '.claude-plugin'), { recursive: true });
      mkdirSync(join(sb.dir, 'skew-cache/trustmybot-dev/tmb/1.0.1'), { recursive: true });
      writeFileSync(join(skewRoot, '.claude-plugin/plugin.json'), '{"name":"tmb","version":"1.0.0"}\n');
      const c = contextOf(hook(wsEnv(schemaDb, { CLAUDE_PLUGIN_ROOT: skewRoot, HOME: dupHome })).stdout);
      assert.equal(lineStarting(c, 'newer plugin version'), 'newer plugin version 1.0.1 is installed but 1.0.0 is still running — fully quit and relaunch Claude Code to apply', 'skew line');
      assert.ok(!IN_SESSION_CMD.test(c), 'prescan output names no /plugin, /reload-plugins or /mcp');
    });
  });

  describe('pre-1.1.0 TMB hooks in the user-scope settings.json', () => {
    let settings = '';
    let oldProject = '';
    let legacyErr = '';
    const entry = (project: string, v: string) => JSON.stringify({ scope: 'local', projectPath: project, installPath: `/cache/${v}`, version: v });
    function legacyRun(): string {
      const r = hook(wsEnv(schemaDb));
      legacyErr = r.stderr;
      return r.stdout;
    }
    const legacyLines = () => lines(contextOf(legacyRun())).filter((l) => /^Plugin: .*pre-1\.1\.0 TMB hook/.test(l)).join('\n');
    const sums = () => [settings, installedJson].map((p) => (existsSync(p) ? readFileSync(p).toString('base64') : 'absent')).join('|');
    const head = () => `Plugin: ${settings} holds 3 pre-1.1.0 TMB hook(s) (${LEGACY_ENTRIES}) — they run in every project and can deny what this version allows; the Human removes them by hand, see ${LEGACY_DOC}`;

    before(() => {
      settings = join(configDir, 'settings.json');
      oldProject = join(sb.dir, 'old-project');
      for (const d of [configDir, oldProject, join(sb.dir, 'rc-project')]) mkdirSync(d, { recursive: true });
      makeSchemaDb();
    });

    it('resolve-hook.sh and _tmb_managed entries add one line naming the file, lines, hooks and other old projects', () => {
      copyFileSync(LEGACY_FIXTURE, settings);
      writeFileSync(
        installedJson,
        `{"plugins":{"tmb@trustmybot-dev":[${[entry(oldProject, '1.0.2'), entry(join(sb.dir, 'rc-project'), '1.1.0-rc.1'), entry(ws, '1.0.3'), entry(join(sb.dir, 'gone-project'), '1.0.1')].join(',')}]}}`,
      );
      const beforeSums = sums();
      assert.equal(legacyLines(), `${head()}; projects on TMB < 1.1.0 lose them too: ${oldProject} (1.0.2)`, 'one legacy line');
      assert.equal(legacyErr, '', 'no stderr');
      assert.equal(sums(), beforeSums, 'settings.json and installed_plugins.json unchanged');
    });

    it('no old project installs leaves the project clause off', () => {
      rmSync(installedJson, { force: true });
      assert.equal(legacyLines(), head(), 'no project clause');
      assert.ok(readFileSync(LEGACY_FIXTURE).equals(readFileSync(settings)), 'settings.json byte-identical');
    });

    it('both SessionStart hooks together give one warning naming each entry once', () => {
      copyFileSync(LEGACY_FIXTURE, settings);
      const health = runGate('mcp-health-check', {
        cwd: ws,
        input: '{"hook_event_name":"SessionStart","session_id":"legacy-1"}',
        env: { ...base, CLAUDE_PROJECT_DIR: ws, TMB_MCP_HEALTH_SAMPLES: '1' },
      });
      const both = jsonValues(`${legacyRun()}\n${health.stdout}`)
        .map((v) => String((v as { hookSpecificOutput?: { additionalContext?: unknown } }).hookSpecificOutput?.additionalContext ?? 'null'))
        .join('\n');
      assert.equal(lines(both).filter((l) => l.includes(settings)).length, 1, 'one warning names the settings file');
      for (const e of ['line 10 git-guards', 'line 23 agent-spawn-dispatch', 'line 33 swe-scope-guard']) assert.equal(count(both, e), 1, `${e} named once`);
      assert.ok(readFileSync(LEGACY_FIXTURE).equals(readFileSync(settings)), 'settings.json byte-identical');
    });

    it('a one-line settings file names each entry on line 1', () => {
      const legacyDir = '~/.claude/tmb-hooks';
      const stop = [
        { type: 'command', command: `bash ${legacyDir}/resolve-hook.sh --marketplace mp --hook a` },
        { type: 'command', command: `bash ${legacyDir}/resolve-hook.sh --marketplace mp --hook b`, _tmb_managed: true },
        { type: 'command', command: `bash ${legacyDir}/dispatch.sh --hook c`, _tmb_managed: true },
      ];
      writeFileSync(settings, `${JSON.stringify({ hooks: { Stop: [{ hooks: stop }] } })}\n`);
      assert.ok(legacyLines().includes('holds 3 pre-1.1.0 TMB hook(s) (line 1 a, line 1 b, line 1 c)'), 'each entry once');
    });

    it('a _tmb_managed entry without resolve-hook.sh or --hook is named by line', () => {
      writeFileSync(
        settings,
        '{\n  "statusLine": {"type": "command", "command": "echo status"},\n  "hooks": {"PreToolUse": [{"hooks": [\n    {"type": "command", "command": "/opt/old-tmb/gate.sh", "_tmb_managed": true}\n  ]}]}\n}\n',
      );
      assert.ok(legacyLines().includes('holds 1 pre-1.1.0 TMB hook(s) (line 4 ?)'), 'named by line');
    });

    it('clean, missing or unparsable settings print nothing', () => {
      writeFileSync(installedJson, `{"plugins":{"tmb@trustmybot-dev":[${entry(oldProject, '1.0.2')}]}}`);
      writeFileSync(
        settings,
        '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"},{"type":"command","command":"echo also-mine","_tmb_managed":false}]}]},"permissions":{"allow":["Bash(bash resolve-hook.sh)"]}}\n',
      );
      const beforeSums = sums();
      assert.equal(legacyLines(), '', 'clean settings: no line');
      assert.equal(sums(), beforeSums, 'clean settings: files unchanged');
      writeFileSync(settings, '{"hooks":');
      assert.equal(legacyLines(), '', 'unparsable settings: no line');
      assert.equal(legacyErr, '', 'unparsable settings: no stderr');
      rmSync(settings);
      assert.equal(legacyLines(), '', 'missing settings: no line');
      assert.equal(legacyErr, '', 'missing settings: no stderr');
      rmSync(installedJson, { force: true });
    });
  });

  describe('persona and tooling', () => {
    let personaPlugin = '';
    const personaLine = (project: string) =>
      lineStarting(
        contextOf(
          hook(
            { TRAJECTORY_DB_PATH: schemaDb, TMB_INSTALLED_JSON: join(sb.dir, 'none.json'), CLAUDE_PLUGIN_ROOT: personaPlugin, CLAUDE_PROJECT_DIR: project },
            { cwd: project },
          ).stdout,
        ),
        'Persona:',
      );

    before(() => {
      personaPlugin = join(sb.dir, 'persona-plugin');
      mkdirSync(join(personaPlugin, '.claude-plugin'), { recursive: true });
      writeFileSync(join(personaPlugin, '.claude-plugin/plugin.json'), '{"name":"tmb","version":"1.0.3"}\n');
      writeFileSync(join(personaPlugin, 'CLAUDE.md'), '# bro\n');
      makeSchemaDb();
    });

    it('no Persona line for any project CLAUDE.md', () => {
      const md = join(ws, 'CLAUDE.md');
      rmSync(md, { force: true });
      assert.equal(personaLine(ws), '', 'no CLAUDE.md');
      writeFileSync(md, '# Mine\n');
      assert.equal(personaLine(ws), '', 'CLAUDE.md without a block');
      writeFileSync(md, '# Mine\n\n<!-- tmb:persona start v1.0.2 -->\n# bro\n<!-- tmb:persona end -->\n');
      assert.equal(personaLine(ws), '', 'stale block');
      writeFileSync(md, '# Mine\r\n\r\n<!-- tmb:persona start v1.0.3 -->\r\n# bro\r\n<!-- tmb:persona end -->\r\n');
      assert.equal(personaLine(ws), '', 'current CRLF block');
      rmSync(md);
      assert.equal(personaLine(personaPlugin), '', 'plugin-root project');
    });

    it('jq present: no Tooling line', () => {
      assert.ok(!out.includes('Tooling:'), 'no Tooling line with jq on PATH');
    });

    it('jq off PATH: the Tooling line, as valid JSON', () => {
      const nojq = noCmdPath(join(sb.dir, 'nojq'), 'jq', base.PATH ?? '');
      const r = hook({ PATH: nojq, TRAJECTORY_DB_PATH: db });
      const v = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string; hookEventName: string } };
      assert.equal(v.hookSpecificOutput.additionalContext, 'Tooling: jq not found, so the session inventory is skipped; gates still run. Tell the Human to install jq for the inventory.', 'the one Tooling line');
      assert.equal(v.hookSpecificOutput.hookEventName, 'SessionStart', 'a SessionStart output');
    });
  });

  describe('cleanup', () => {
    it('no WAL/SHM sidecars linger in the sandbox', async () => {
      await killFixtureNode();
      const sidecars = (readdirSync(sb.dir, { recursive: true }) as string[]).filter((f) => /\.db-(wal|shm)$/.test(f));
      assert.deepEqual(sidecars, [], 'WAL/SHM sidecars left behind');
    });
  });
});
