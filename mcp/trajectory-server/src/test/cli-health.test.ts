/**
 * `cli.js health` (GH 1692), ported with every assertion of the former bash
 * health test (L3): run
 * against the built dist/cli.js bundle in a temp sandbox. Each scenario gets
 * its own fixture (a node:sqlite DB seeded with plugin_meta/tasks/repos/
 * plugin_config/wm_ tables, a fake mcp-server.log, a fake cache tree) and an
 * explicit env, so the real plugin DB, cache, log, HOME and the caller's cwd
 * never leak in. A stub pgrep shadows the real one on PATH.
 *
 * LOAD-BEARING (#144, GH 1730): every remediation names a scoped `claude
 * plugin …` command and/or a FULL Claude Code quit + relaunch, and none names
 * an in-session command: each failing scenario asserts that with
 * assertNoInSessionCmd.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { installRoot } from '../hooks/lib/project-env.js';

const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url))) as string;
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const LEGACY_FIXTURE = join(PLUGIN_ROOT, 'tests/l3-integration/hooks/fixtures/legacy-user-settings.json');
const TARGET_SCHEMA = 24;
const HEALTHY_VERSION = '0.10.0-delta';
const IN_SESSION_CMD = /(^|[ `"'(])\/(plugin|reload-plugins|mcp)([ `"'),.;:]|$)/m;

let sandbox: string;
let stubDir: string;

function assertNoInSessionCmd(text: string, message: string): void {
  assert.equal(IN_SESSION_CMD.exec(text)?.[0] ?? '', '', message);
}

function stub(dir: string, rc: number): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pgrep');
  writeFileSync(path, `#!/bin/sh\nexit ${rc}\n`);
  chmodSync(path, 0o755);
  return dir;
}

function sql(db: string, script: string, ...params: (string | number)[]): void {
  const d = new DatabaseSync(db);
  try {
    if (params.length === 0) d.exec(script);
    else d.prepare(script).run(...params);
  } finally {
    d.close();
  }
}

function seedDb(db: string, pv: string, sv: number, labels = ''): void {
  sql(
    db,
    `CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY, plugin_version TEXT, schema_version INTEGER);
CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT);
INSERT INTO repos (name, path) VALUES ('plugin', '/tmp/plugin');
CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT, branch_id TEXT, commit_sha TEXT, prompt_bearing INTEGER DEFAULT 0);
CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT);
CREATE TABLE wm_directories (id INTEGER PRIMARY KEY, repo TEXT, path TEXT, parent_path TEXT, summary TEXT);
CREATE TABLE wm_files (id INTEGER PRIMARY KEY, repo TEXT, path TEXT, dir TEXT, purpose TEXT);`,
  );
  sql(db, 'INSERT INTO plugin_meta (id, plugin_version, schema_version) VALUES (1, ?, ?);', pv, sv);
  if (labels !== '') sql(db, "INSERT INTO plugin_config (key, value_json) VALUES ('issue_classification_labels', ?);", labels);
}

function seedWorldModel(db: string): void {
  sql(
    db,
    `INSERT INTO wm_directories (repo, path, parent_path, summary) VALUES ('plugin', '', NULL, 'root'), ('plugin', 'src', '', 'sources');
INSERT INTO wm_files (repo, path, dir, purpose) VALUES ('plugin', 'src/main.ts', 'src', 'entry point');`,
  );
}

function makeCache(cache: string, target: number): void {
  mkdirSync(join(cache, 'mcp/trajectory-server/src'), { recursive: true });
  writeFileSync(join(cache, 'mcp/trajectory-server/src/db.ts'), `const TARGET_SCHEMA_VERSION = ${target};\n`);
}

function addAudit(db: string, eventType: string, hoursAgo: number): void {
  sql(
    db,
    'CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER, event_type TEXT, from_node TEXT, content_json TEXT, created_at TEXT);',
  );
  sql(
    db,
    `INSERT INTO audit (issue_id, event_type, from_node, content_json, created_at)
  VALUES (-1, ?, 'trajectory-server', '{"reason":"model_load_failed"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?));`,
    eventType,
    `-${hoursAgo} hours`,
  );
}

/** Bytes, mtime and sidecar files of <db>. */
function dbState(db: string): string {
  const sum = createHash('sha256').update(readFileSync(db)).digest('hex');
  const dir = dirname(db);
  const base = db.slice(dir.length + 1);
  const sidecars = readdirSync(dir).filter((n) => n.startsWith(`${base}-`));
  return `${sum} ${statSync(db).mtimeMs} ${sidecars.join(' ')}`;
}

function cksum(path: string): string {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '-';
}

/** The `-> ...` lines under the first line containing <needle>, up to a blank / PASS / FAIL / `== ` line. */
function remediationAfter(output: string, needle: string): string {
  const out: string[] = [];
  let grab = false;
  for (const line of output.split('\n')) {
    if (line.includes(needle)) {
      grab = true;
      continue;
    }
    if (grab && /^\s*-> /.test(line)) {
      out.push(line);
      continue;
    }
    if (grab && (/^(PASS|FAIL|== )/.test(line) || /^\s*$/.test(line))) grab = false;
  }
  return out.join('\n');
}

interface Scenario {
  root: string;
  db: string;
  log: string;
  cache: string;
  intended: string;
  pgrep: string;
  pluginRoot: string;
}

function resetScenario(slug: string): Scenario {
  const root = join(sandbox, slug);
  mkdirSync(join(root, '.claude/tmb'), { recursive: true });
  const f: Scenario = {
    root,
    db: join(root, '.claude/tmb/trajectory.db'),
    log: join(root, 'server.log'),
    cache: join(root, 'cache'),
    intended: HEALTHY_VERSION,
    pgrep: '1',
    pluginRoot: '',
  };
  seedDb(f.db, HEALTHY_VERSION, TARGET_SCHEMA, '["Bug","Feature","Docs"]');
  seedWorldModel(f.db);
  makeCache(f.cache, TARGET_SCHEMA);
  writeFileSync(f.log, '');
  return f;
}

interface Run {
  out: string;
  rc: number;
}

function runCli(env: NodeJS.ProcessEnv, cli = CLI, cwd = sandbox): Run {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', cli, 'health'], {
    env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: join(sandbox, 'home'), ...env },
    cwd,
    encoding: 'utf8',
  });
  return { out: `${r.stdout}${r.stderr}`.replace(/\n+$/, ''), rc: r.status ?? -1 };
}

function scenarioEnv(f: Scenario): NodeJS.ProcessEnv {
  return {
    TRAJECTORY_DB_PATH: f.db,
    TMB_HEALTH_SERVER_LOG: f.log,
    TMB_HEALTH_CACHE_DIR: f.cache,
    TMB_HEALTH_INTENDED_VERSION: f.intended,
    TMB_HEALTH_PGREP_COUNT: f.pgrep,
    CLAUDE_PLUGIN_ROOT: f.pluginRoot,
  };
}

function runHealth(f: Scenario, extra: NodeJS.ProcessEnv = {}): Run {
  return runCli({ ...scenarioEnv(f), ...extra });
}

describe('cli.js health', () => {
  before(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-health-')));
    stubDir = stub(join(sandbox, 'bin'), 1);
  });
  after(() => rmSync(sandbox, { recursive: true, force: true }));

  it('baseline: every check PASSes, no FAIL lines, all checks passed footer', () => {
    const { out } = runHealth(resetScenario('healthy'));
    for (const check of ['server-reachable', 'cache-version', 'schema-version', 'world-model', 'label-config', 'stale-state', 'hook-cache-drift']) {
      assert.ok(out.includes(`PASS  ${check}`), `${check} PASS`);
    }
    assert.ok(!out.includes('FAIL  '), 'no FAIL lines in healthy run');
    assert.ok(out.includes('== all checks passed =='), 'healthy footer');
  });

  it('check1 server-reachable: zero processes → FAIL, full quit + relaunch, no in-session command', () => {
    const f = resetScenario('server-down');
    f.pgrep = '0';
    const { out } = runHealth(f);
    assert.ok(out.includes('FAIL  server-reachable: NO trajectory-server process found'), 'server-down FAIL line');
    const rem = remediationAfter(out, 'FAIL  server-reachable');
    assert.ok(rem.includes('Fully quit Claude Code'), 'server-down restart remediation');
    assertNoInSessionCmd(rem, 'server-down remediation names no /plugin, /reload-plugins or /mcp');
  });

  it('check2 cache-version: DB version != installed → FAIL, scoped update + full relaunch', () => {
    const f = resetScenario('cache-stale');
    sql(f.db, "UPDATE plugin_meta SET plugin_version='0.10.0-gamma' WHERE id=1;");
    f.intended = '0.10.0-delta';
    const { out } = runHealth(f);
    assert.ok(out.includes('FAIL  cache-version: server booted 0.10.0-gamma but 0.10.0-delta is installed'), 'cache-version FAIL line');
    const rem = remediationAfter(out, 'FAIL  cache-version');
    assert.ok(
      rem.includes('claude plugin update tmb@<marketplace> --scope project (stable) or --scope local (rc/dev)'),
      'no installed entry: generic scoped update',
    );
    assert.ok(rem.includes('quit + relaunch'), 'cache-version restart remediation');
    assert.ok(rem.includes('INSTALL.md#recommended-scope-project-or-local'), 'cache-version links the scope rule');
    assert.ok(rem.includes('Only a full restart picks up the new server'), 'cache-version names the full restart');
    assertNoInSessionCmd(rem, 'cache-version remediation names no /plugin, /reload-plugins or /mcp');

    const scopedRem = (key: string, scope: string): string => {
      const installed = join(f.root, 'installed.json');
      writeFileSync(installed, `{"plugins":{"${key}":[{${scope}"installPath":"/c/x","version":"0.10.0-delta"}]}}`);
      const r = runCli({
        TRAJECTORY_DB_PATH: f.db,
        TMB_HEALTH_SERVER_LOG: f.log,
        TMB_HEALTH_CACHE_DIR: f.cache,
        TMB_HEALTH_INTENDED_VERSION: f.intended,
        TMB_HEALTH_PGREP_COUNT: '1',
        TMB_HEALTH_INSTALLED_JSON: installed,
      });
      return remediationAfter(r.out, 'FAIL  cache-version');
    };
    assert.ok(scopedRem('tmb@trustmybot', '"scope":"local",').includes('claude plugin update tmb@trustmybot --scope local'), 'recorded local scope wins');
    assert.ok(
      scopedRem('tmb@trustmybot', '"scope":"user",').includes('claude plugin update tmb@trustmybot --scope project'),
      'user scope falls back to stable default',
    );
    assert.ok(scopedRem('tmb@trustmybot-dev', '').includes('claude plugin update tmb@trustmybot-dev --scope local'), 'no scope falls back to dev default');
  });

  it('check3 schema-version: DB schema < installed target → FAIL, full quit + relaunch', () => {
    const f = resetScenario('schema-stale');
    sql(f.db, 'UPDATE plugin_meta SET schema_version=23 WHERE id=1;');
    makeCache(f.cache, 24);
    const { out } = runHealth(f);
    assert.ok(out.includes('FAIL  schema-version: DB at v23 but installed server targets v24'), 'schema-version FAIL line');
    const rem = remediationAfter(out, 'FAIL  schema-version');
    assert.ok(rem.includes('Fully quit + relaunch Claude Code'), 'schema restart remediation');
    assert.ok(rem.includes('migration runs on the next SERVER start'), 'schema migration framing');
    assertNoInSessionCmd(rem, 'schema remediation names no /plugin, /reload-plugins or /mcp');
  });

  it('check4a world-model: scanned tables → PASS with counts', () => {
    const { out } = runHealth(resetScenario('wm-scanned'));
    assert.ok(out.includes('PASS  world-model: 2 directories, 1 files'), 'world-model PASS line');
    assert.ok(!out.includes('WARN  world-model'), 'no empty warning');
    assert.ok(!out.includes('INFO  world-model'), 'no leftover line without a leftover file');
  });

  it('check4b world-model: empty tables → WARN pointing at /scan, exit 0', () => {
    const f = resetScenario('wm-empty');
    sql(f.db, 'DELETE FROM wm_files; DELETE FROM wm_directories;');
    const { out, rc } = runHealth(f);
    assert.ok(out.includes('WARN  world-model: empty'), 'empty WARN line');
    assert.ok(remediationAfter(out, 'WARN  world-model').includes('run /scan'), 'empty remediation prescribes /scan');
    assert.ok(!out.includes('FAIL  world-model'), 'an empty world model is not a FAIL');
    assert.ok(out.includes('== all checks passed =='), 'a warning is not a failed check');
    assert.equal(rc, 0, 'exit code unchanged');
  });

  it('check4c world-model: tables missing → FAIL, restart then /scan', () => {
    const f = resetScenario('wm-missing');
    sql(f.db, 'DROP TABLE wm_files; DROP TABLE wm_directories;');
    const { out } = runHealth(f);
    assert.ok(out.includes('FAIL  world-model: wm_directories / wm_files missing'), 'missing-tables FAIL line');
    const rem = remediationAfter(out, 'FAIL  world-model');
    assert.ok(rem.includes('quit + relaunch'), 'missing-tables remediation restarts');
    assert.ok(rem.includes('run /scan'), 'missing-tables remediation then scans');
    assertNoInSessionCmd(rem, 'missing-tables remediation names no /plugin, /reload-plugins or /mcp');
  });

  it('check4d world-model: a leftover graph file → INFO line, file kept; a custom DB name looks for <db>.world-model.kuzu', () => {
    const f = resetScenario('wm-leftover');
    const legacy = join(f.root, '.claude/tmb/world-model.kuzu');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'data'), '');
    writeFileSync(`${legacy}.wal`, '');
    let { out } = runHealth(f);
    assert.ok(out.includes(`INFO  world-model: ${legacy} is an unused leftover`), 'leftover INFO line names the file');
    assert.ok(out.includes('you may delete it'), 'leftover INFO line says the user may delete it');
    assert.ok(out.includes('PASS  world-model: 2 directories, 1 files'), 'leftover does not change the verdict');
    assert.ok(out.includes('== all checks passed =='), 'an info line is not a failed check');
    assert.ok(existsSync(join(legacy, 'data')) && existsSync(`${legacy}.wal`), 'leftover files are never deleted');

    const customDb = join(f.root, '.claude/tmb/custom.db');
    copyFileSync(f.db, customDb);
    f.db = customDb;
    ({ out } = runHealth(f));
    assert.ok(!out.includes('INFO  world-model'), 'the standard-name leftover belongs to trajectory.db, not custom.db');
    writeFileSync(`${customDb}.world-model.kuzu`, '');
    ({ out } = runHealth(f));
    assert.ok(out.includes(`INFO  world-model: ${customDb}.world-model.kuzu is an unused leftover`), 'custom DB leftover INFO line');
  });

  it('check4e world-model: the probe leaves a rollback-journal DB and a cold WAL DB untouched', () => {
    const f = resetScenario('wm-readonly');
    utimesSync(f.db, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    let before = dbState(f.db);
    let { out } = runHealth(f);
    assert.ok(out.includes('PASS  world-model'), 'world-model PASS on the probed DB');
    assert.equal(dbState(f.db), before, 'rollback-journal DB: bytes, mtime and sidecars unchanged');

    const w = resetScenario('wm-readonly-wal');
    sql(w.db, 'PRAGMA journal_mode=WAL;');
    rmSync(`${w.db}-wal`, { force: true });
    rmSync(`${w.db}-shm`, { force: true });
    utimesSync(w.db, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    before = dbState(w.db);
    ({ out } = runHealth(w));
    assert.ok(out.includes('PASS  world-model: 2 directories, 1 files'), 'world-model reads a cold WAL DB');
    assert.equal(dbState(w.db), before, 'WAL DB: bytes, mtime and sidecars unchanged');
  });

  it('check4f world-model: :memory: → PASS without a probe', () => {
    const f = resetScenario('wm-memory');
    f.db = ':memory:';
    const { out } = runHealth(f);
    assert.ok(out.includes('db:        :memory:'), ':memory: override is preserved');
    assert.ok(out.includes('PASS  world-model: in-memory trajectory DB'), ':memory: world model PASS');
    assert.ok(!out.includes('INFO  world-model'), ':memory: has no leftover graph file');
  });

  it('server-log default: resolves to <db-dir>/logs/mcp-server.log, never under HOME', () => {
    const f = resetScenario('log-default');
    f.log = '';
    const { out } = runHealth(f);
    assert.ok(out.includes(`server-log:${f.root}/.claude/tmb/logs/mcp-server.log`), 'default server log sits beside the DB');
    assert.ok(!out.includes(join(sandbox, 'home')), 'default server log is not under HOME');
  });

  it('check5 label-config: empty labels → FAIL pointing to /onboard or config_set', () => {
    const f = resetScenario('labels-unset');
    sql(f.db, "DELETE FROM plugin_config WHERE key='issue_classification_labels';");
    const { out } = runHealth(f);
    assert.ok(out.includes('FAIL  label-config: issue_classification_labels is unset/empty'), 'label-config FAIL line');
    const rem = remediationAfter(out, 'FAIL  label-config');
    assert.ok(rem.includes('/onboard'), 'label remediation mentions /onboard');
    assert.ok(rem.includes('config_set'), 'label remediation mentions config_set');
  });

  it('check6 stale-state: pending task + orphan worktree → FAIL listing both', () => {
    const f = resetScenario('stale');
    sql(f.db, "INSERT INTO tasks (status, branch_id) VALUES ('pending', 'feat/some-thing');");
    mkdirSync(join(f.root, '.claude/worktrees/some-thing'), { recursive: true });
    const { out } = runHealth(f);
    assert.ok(out.includes('FAIL  stale-state: orphaned worktrees and/or pending|running tasks present'), 'stale-state FAIL line');
    assert.ok(out.includes('[pending]'), 'stale remediation names the pending task status');
    assert.ok(out.includes('feat/some-thing'), 'stale remediation names the branch');
    assert.ok(out.includes('.claude/worktrees/some-thing'), 'stale remediation names the worktree');
    assert.ok(!out.includes('Cleanup helper'), 'stale remediation names no cleanup helper');
    assert.doesNotMatch(out, /cleanup-stale-[a-z]+/, 'stale remediation names no deleted cleanup script');
  });

  it('check7 hook-cache-drift: dev checkout != cache → FAIL, scoped update + full relaunch', () => {
    const f = resetScenario('hook-drift');
    const devRoot = join(f.root, 'devcheckout');
    mkdirSync(join(devRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(devRoot, '.claude-plugin/plugin.json'), '{"name":"tmb","version":"0.10.0-epsilon"}\n');
    f.pluginRoot = devRoot;
    f.intended = '0.10.0-delta';
    const { out } = runHealth(f);
    assert.ok(out.includes('FAIL  hook-cache-drift: dev checkout is 0.10.0-epsilon but the cache runs 0.10.0-delta'), 'hook-drift FAIL line');
    const rem = remediationAfter(out, 'FAIL  hook-cache-drift');
    assert.ok(
      rem.includes('claude plugin update tmb@<marketplace> --scope project (stable) or --scope local (rc/dev)'),
      'drift remediation names the scoped update',
    );
    assert.ok(rem.includes('fully quit + relaunch Claude Code'), 'drift remediation prescribes a full restart');
    assertNoInSessionCmd(rem, 'drift remediation names no /plugin, /reload-plugins or /mcp');
  });

  it('sweep: the whole output of every failing scenario names no in-session command', () => {
    const server = resetScenario('sweep-server');
    server.pgrep = '0';
    assertNoInSessionCmd(runHealth(server).out, 'server-down output names no /plugin, /reload-plugins or /mcp');

    const schema = resetScenario('sweep-schema');
    sql(schema.db, 'UPDATE plugin_meta SET schema_version=23 WHERE id=1;');
    makeCache(schema.cache, 24);
    assertNoInSessionCmd(runHealth(schema).out, 'schema-stale output names no /plugin, /reload-plugins or /mcp');

    const wm = resetScenario('sweep-world-model');
    sql(wm.db, 'DROP TABLE wm_files; DROP TABLE wm_directories;');
    assertNoInSessionCmd(runHealth(wm).out, 'world-model output names no /plugin, /reload-plugins or /mcp');
  });

  it('duplicate-plugin: two enabled copies warn naming both, one copy is silent, no project is reported and never guessed from the cwd', () => {
    const f = resetScenario('duplicate-plugin');
    const installed = join(f.root, 'installed.json');
    writeFileSync(
      installed,
      `{"plugins":{"tmb@trustmybot-dev":[{"scope":"local","projectPath":"${f.root}","installPath":"/c/dev","version":"1.0.3"}],"tmb@trustmybot-rc":[{"scope":"local","projectPath":"${f.root}","installPath":"/c/rc","version":"1.0.2-rc.3"}]}}`,
    );
    const settings = join(f.root, '.claude/settings.local.json');
    writeFileSync(settings, '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}\n');
    const dupEnv = {
      TRAJECTORY_DB_PATH: f.db,
      TMB_HEALTH_SERVER_LOG: f.log,
      TMB_HEALTH_CACHE_DIR: f.cache,
      TMB_HEALTH_INTENDED_VERSION: f.intended,
      TMB_HEALTH_PGREP_COUNT: '1',
      TMB_HEALTH_INSTALLED_JSON: installed,
      CLAUDE_PROJECT_DIR: f.root,
    };
    let { out, rc } = runCli(dupEnv);
    assert.ok(out.includes('WARN  duplicate-plugin: 2 enabled tmb copies'), 'WARN line');
    assert.ok(out.includes('trustmybot-dev@1.0.3, trustmybot-rc@1.0.2-rc.3'), 'names both copies');
    assert.ok(
      out.includes('claude plugin disable tmb@trustmybot-dev --scope local; claude plugin disable tmb@trustmybot-rc --scope local'),
      'remedy names a scoped disable per copy',
    );
    assert.ok(out.includes('Then fully quit + relaunch Claude Code.'), 'remedy restarts');
    assertNoInSessionCmd(out, 'duplicate-plugin output names no /plugin, /reload-plugins or /mcp');
    assert.ok(out.includes('== all checks passed =='), 'a warning is not a failed check');
    assert.equal(rc, 0, 'exit code unchanged');

    writeFileSync(settings, '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":false}}\n');
    ({ out } = runCli(dupEnv));
    assert.ok(!out.includes('WARN  duplicate-plugin'), 'one enabled copy: no warning');

    writeFileSync(settings, '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}\n');
    ({ out } = runCli(
      {
        TMB_TEST_RUN_ID: 'health-unresolved',
        TMB_HEALTH_SERVER_LOG: f.log,
        TMB_HEALTH_CACHE_DIR: f.cache,
        TMB_HEALTH_INTENDED_VERSION: f.intended,
        TMB_HEALTH_PGREP_COUNT: '1',
        TMB_HEALTH_INSTALLED_JSON: installed,
      },
      CLI,
      f.root,
    ));
    assert.ok(out.includes('WARN  duplicate-plugin: skipped — no project resolves'), 'unresolved project reported');
    assert.ok(!out.includes('enabled tmb copies for'), 'cwd not used as the project');
  });

  it('legacy-user-hooks: leftover entries warn with lines, hooks and old projects; files unchanged; clean or missing settings print nothing', () => {
    const f = resetScenario('legacy-user-hooks');
    const home = join(f.root, 'home');
    const settings = join(home, '.claude/settings.json');
    const installed = join(f.root, 'installed.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(f.root, 'old-project'), { recursive: true });
    const oldReal = realpathSync(join(f.root, 'old-project'));
    copyFileSync(LEGACY_FIXTURE, settings);
    writeFileSync(
      installed,
      `{"plugins":{"tmb@trustmybot-dev":[{"scope":"local","projectPath":"${f.root}/old-project","installPath":"/c/old","version":"1.0.2"},{"scope":"local","projectPath":"${f.root}","installPath":"/c/new","version":"1.1.0"}]}}`,
    );
    const legacyHealth = (): Run =>
      runCli({
        HOME: home,
        TRAJECTORY_DB_PATH: f.db,
        TMB_HEALTH_SERVER_LOG: f.log,
        TMB_HEALTH_CACHE_DIR: f.cache,
        TMB_HEALTH_INTENDED_VERSION: f.intended,
        TMB_HEALTH_PGREP_COUNT: '1',
        TMB_HEALTH_INSTALLED_JSON: installed,
        CLAUDE_PROJECT_DIR: f.root,
      });
    const sums = (): string => `${cksum(settings)} ${cksum(installed)}`;
    let before = sums();
    let { out, rc } = legacyHealth();
    assert.ok(
      out.includes(
        `WARN  legacy-user-hooks: ${settings} holds 3 pre-1.1.0 TMB hook(s): line 10 git-guards, line 23 agent-spawn-dispatch, line 33 swe-scope-guard`,
      ),
      'WARN line',
    );
    assert.equal(out.split('\n').filter((l) => l.includes('WARN  legacy-user-hooks')).length, 1, 'one warning');
    assert.ok(out.includes('Remove them by hand: docs/architecture/INSTALL.md#upgrading-into-v110--remove-leftover-user-wide-hooks'), 'points to UPGRADE.md');
    assert.ok(out.includes(`Projects on TMB < 1.1.0 lose them too: ${oldReal} (1.0.2)`), 'names the old project only');
    assert.ok(out.includes('== all checks passed =='), 'a warning is not a failed check');
    assert.equal(rc, 0, 'exit code unchanged');
    assert.equal(sums(), before, 'settings.json and installed_plugins.json unchanged');
    assert.ok(readFileSync(LEGACY_FIXTURE).equals(readFileSync(settings)), 'settings.json byte-identical');

    writeFileSync(
      settings,
      '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"bash ~/.claude/tmb-hooks/dispatch.sh --hook bash-guard","_tmb_managed":true}]}]}}\n',
    );
    ({ out } = legacyHealth());
    assert.ok(out.includes('holds 1 pre-1.1.0 TMB hook(s): line 1 bash-guard'), 'a _tmb_managed entry without resolve-hook.sh warns by line and --hook name');

    writeFileSync(
      settings,
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"},{"type":"command","command":"echo also-mine","_tmb_managed":false}]}]}}\n',
    );
    before = sums();
    ({ out } = legacyHealth());
    assert.ok(!out.includes('WARN  legacy-user-hooks'), 'clean settings: no warning');
    assert.equal(sums(), before, 'clean settings: files unchanged');
    rmSync(settings);
    ({ out } = legacyHealth());
    assert.ok(!out.includes('WARN  legacy-user-hooks'), 'missing settings: no warning');
  });

  it('check8 embeddings: an unrecovered degraded row WARNs with exit 0; a later recovery PASSes', () => {
    const f = resetScenario('emb-degraded');
    addAudit(f.db, 'embeddings_degraded', 1);
    let { out, rc } = runHealth(f);
    assert.ok(out.includes('WARN  embeddings: degraded since'), 'embeddings WARN line');
    assert.ok(out.includes('model_load_failed'), 'WARN names the degraded reason');
    assert.ok(!out.includes('all checks passed'), 'degraded embeddings are not all-passed');
    assert.ok(out.includes('== no check FAILED, 1 degraded'), 'degraded footer');
    assert.ok(!out.includes('FAIL  '), 'a warn contract is not a FAIL');
    assert.equal(rc, 0, 'exit code unchanged');

    addAudit(f.db, 'embeddings_recovered', 0);
    ({ out } = runHealth(f));
    assert.ok(out.includes('PASS  embeddings: no unrecovered embeddings_degraded event'), 'recovered → PASS');
    assert.ok(out.includes('== all checks passed =='), 'recovered → all passed');
  });

  it('check8 embeddings: a degraded row older than 24 h PASSes; no audit table skips, never FAILs', () => {
    const old = resetScenario('emb-old');
    addAudit(old.db, 'embeddings_degraded', 48);
    assert.ok(runHealth(old).out.includes('PASS  embeddings'), 'stale degraded row ignored');
    assert.ok(runHealth(resetScenario('emb-noaudit')).out.includes('PASS  embeddings: audit table unreadable'), 'missing audit table skipped');
  });

  it('cache: run from a dev cache with no CLAUDE_PROJECT_DIR → cache is that dev root, not stable', () => {
    const f = resetScenario('self-cache');
    const fakeDev = join(sandbox, 'home/.claude/plugins/cache/trustmybot-dev/tmb/9.9.9-dev.1');
    const stable = join(sandbox, 'home/.claude/plugins/cache/trustmybot/tmb/1.1.0');
    mkdirSync(join(fakeDev, 'mcp/trajectory-server/dist'), { recursive: true });
    mkdirSync(join(fakeDev, '.claude-plugin'), { recursive: true });
    mkdirSync(stable, { recursive: true });
    writeFileSync(join(fakeDev, '.claude-plugin/plugin.json'), '{"name":"tmb","version":"9.9.9-dev.1"}\n');
    const devCli = join(fakeDev, 'mcp/trajectory-server/dist/cli.js');
    copyFileSync(CLI, devCli);
    const installed = join(f.root, 'installed.json');
    writeFileSync(installed, `{"plugins":{"tmb@trustmybot":[{"scope":"project","projectPath":"/elsewhere","installPath":"${stable}","version":"1.1.0"}]}}`);
    const { out } = runCli(
      {
        TRAJECTORY_DB_PATH: f.db,
        TMB_HEALTH_SERVER_LOG: f.log,
        TMB_HEALTH_PGREP_COUNT: '1',
        TMB_HEALTH_INSTALLED_JSON: installed,
      },
      devCli,
    );
    assert.ok(out.includes(`cache:     ${fakeDev}`), 'cache is the dev root holding the command');
    assert.ok(!out.includes('trustmybot/tmb'), 'stable cache never resolved');
    assert.ok(!out.includes('FAIL  cache-version'), 'no false cache-version FAIL from the stable entry');
  });

  it('check1 server-reachable: pgrep exit 3 → UNVERIFIED with exit 0; pgrep exit 1 → still FAIL', () => {
    const f = resetScenario('pgrep-sandboxed');
    f.pgrep = '';
    const pgrep3 = stub(join(sandbox, 'bin-pgrep3'), 3);
    let { out, rc } = runHealth(f, { PATH: `${pgrep3}:${stubDir}:/usr/bin:/bin` });
    assert.ok(out.includes('UNVERIFIED  server-reachable: pgrep exited 3'), 'UNVERIFIED line');
    assert.ok(!out.includes('FAIL  server-reachable'), 'no server-reachable FAIL');
    assert.ok(out.includes('== all checks passed =='), 'unverified does not fail the run');
    assert.equal(rc, 0, 'exit code unchanged');

    ({ out } = runHealth(f));
    assert.ok(out.includes('FAIL  server-reachable: NO trajectory-server process found'), 'exit 1 keeps its meaning');
  });

  it('exit code: healthy → 0, a failing check → 1', () => {
    const ok = resetScenario('exit-ok');
    assert.equal(runHealth(ok).rc, 0, 'healthy exit code');
    const bad = resetScenario('exit-fail');
    bad.pgrep = '0';
    assert.equal(runHealth(bad).rc, 1, 'failing exit code');
  });
});
