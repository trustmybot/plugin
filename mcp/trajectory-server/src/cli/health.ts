/**
 * `cli.js health` (GH 1692): TMB's deterministic health check, ported from
 * the former bash health script.
 *
 * Deliberately NOT an MCP tool. It must be able to diagnose states in which
 * the MCP server itself is DOWN (chicken-and-egg), so it reads only the
 * trajectory DB (through node:sqlite), the server log, and the plugin cache
 * filesystem. No LLM, no MCP round-trip, no guessing. Every DB read goes
 * through dbReadRo: the DB is never opened writable.
 *
 * Runs 8 checks; each prints exactly one `PASS`/`FAIL` line (or `WARN` for
 * embeddings, `UNVERIFIED` for an unlistable process table), and every FAIL
 * prints the ONE correct remediation directly under it.
 *
 *   1. server-reachable   — is the trajectory-server process alive?
 *   2. cache-version      — DB-recorded plugin_version == installed (intended) version?
 *   3. schema-version     — DB schema_version == the installed server's TARGET?
 *   4. world-model        — wm_ tables present in the trajectory DB? (read-only)
 *   5. label-config       — issue_classification_labels configured, not the bare default?
 *   6. stale-state        — orphaned worktrees / pending|running tasks?
 *   7. hook-cache-drift   — running hooks load from the cache, not the dev checkout?
 *   8. embeddings         — no unrecovered embeddings_degraded row in the last
 *      24 h (the doctor's embeddings_not_degraded contract)? A WARN, not a
 *      FAIL: the exit code stays 0, but the footer no longer says all passed.
 *
 * Plus warnings and info lines, printed only when they apply and never counted
 * as a FAIL:
 *   world-model (WARN) — the world-model tables are empty; run /scan.
 *   world-model (INFO) — a leftover graph file from the old store sits beside
 *   the DB; the user may delete it (the health check never deletes or writes).
 *   duplicate-plugin — more than one enabled copy of this plugin applies to the
 *   project; Claude Code registers the hooks of only one of them.
 *   legacy-user-hooks — the user-scope settings.json still runs pre-1.1.0
 *   TMB hooks in every project (read only; never edited).
 *
 * LOAD-BEARING REMEDIATION RULE
 * ----------------------------
 * Every remediation names a scoped `claude plugin …` command run from the
 * project root and/or a FULL Claude Code quit + relaunch — never an in-session
 * slash command (managing or reloading plugins, reconnecting an MCP server). A
 * plugin change applies only after a full restart, which also respawns the
 * long-lived MCP server, and the in-session plugin command does not work in
 * Claude Desktop.
 *
 * Env overrides (primarily for tests; production auto-resolves all of these):
 *   TRAJECTORY_DB_PATH         — pin the trajectory DB.
 *   TMB_HEALTH_INSTALLED_JSON  — path to CC's installed_plugins.json.
 *   TMB_HEALTH_CACHE_DIR       — the installed plugin cache dir (installPath).
 *                                Without CLAUDE_PROJECT_DIR it defaults to the
 *                                plugin root running this command.
 *   TMB_HEALTH_SERVER_LOG      — path to mcp-server.log.
 *   TMB_HEALTH_PGREP_COUNT     — stub the server-reachable probe (>=0 process count).
 *   TMB_HEALTH_INTENDED_VERSION— stub the intended plugin version.
 *   CLAUDE_PLUGIN_ROOT         — the dev checkout (drives hook/cache-drift check).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dbPath, dbReadRo, GATE_READ_ERROR, haveSqlite, projectRoot } from '../hooks/lib/db.js';
import { byteCompare, commandOnPath } from '../hooks/lib/host.js';
import {
  duplicateDisableCmds,
  duplicateInstalls,
  duplicateNames,
  LEGACY_USER_HOOKS_DOC,
  legacyHookEntries,
  legacyHookProjects,
  legacyUserHooks,
  userSettingsJson,
} from '../hooks/lib/install.js';
import { installRoot, jqRawText, posixDirname, TMB_DB_FILENAME } from '../hooks/lib/project-env.js';
import type { CliIo } from './fallback-db.js';

const SCOPE_DOC = 'docs/architecture/INSTALL.md#recommended-scope-project-or-local';
const DB_READ_TIMEOUT_MS = '500';
const MEMORY = ':memory:';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** jq's `.<key> // <fallback>` rendered by `-r`. */
function jqField(doc: unknown, key: string, fallback: string): string {
  if (!isObject(doc)) return fallback;
  const v = doc[key];
  return v === undefined || v === null || v === false ? fallback : jqRawText(v);
}

/** jq's string interpolation `\(.<key>)`. */
function jqInterp(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return 'null';
  return JSON.stringify(v);
}

function selfRoot(env: NodeJS.ProcessEnv): string {
  if ((env.CLAUDE_PLUGIN_ROOT ?? '') !== '') return env.CLAUDE_PLUGIN_ROOT as string;
  return installRoot(posixDirname(fileURLToPath(import.meta.url))) ?? '';
}

function manifestName(root: string): string {
  const manifest = `${root}/.claude-plugin/plugin.json`;
  if (!isFile(manifest)) return 'tmb';
  return jqField(readJson(manifest), 'name', 'tmb');
}

interface InstallEntry {
  version: string;
  installPath: string;
  key: string;
  scope: string;
}

/** The entry installed at <root>, else the first <name>@ entry, of installed_plugins.json. */
function installEntry(installed: string, name: string, root: string): InstallEntry | null {
  if (!isFile(installed)) return null;
  const doc = readJson(installed);
  if (!isObject(doc) || !isObject(doc.plugins)) return null;
  const entries: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(doc.plugins)) {
    if (!key.startsWith(`${name}@`)) continue;
    const first = Array.isArray(value) ? (value[0] ?? null) : value === null ? null : undefined;
    if (first === undefined) return null;
    if (first !== null && !isObject(first)) return null;
    entries.push({ ...(first ?? {}), key });
  }
  const picked = entries.find((e) => e.installPath === root) ?? entries[0];
  if (picked === undefined) return null;
  return {
    version: jqInterp(picked.version),
    installPath: jqInterp(picked.installPath),
    key: jqInterp(picked.key),
    scope: jqField(picked, 'scope', ''),
  };
}

export function pgrepProbe(env: NodeJS.ProcessEnv): { count: string; rc: number } {
  if (!commandOnPath('pgrep', env)) return { count: '-1', rc: 0 };
  const root = env.CLAUDE_PLUGIN_ROOT ?? '';
  const pattern = root !== '' ? `${root}/mcp/trajectory-server/dist/index.js` : 'trajectory-server/dist/index.js';
  const r = spawnSync('pgrep', ['-f', pattern], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const signal = r.signal ? (constants.signals[r.signal] ?? 0) : 0;
  const rc = r.status ?? (signal > 0 ? 128 + signal : 1);
  const count = (r.stdout ?? '').split('\n').filter((line) => line !== '').length;
  return { count: String(count), rc };
}

function bashInt(text: string): number | null {
  return /^\s*[+-]?[0-9]+\s*$/.test(text) ? Number(text) : null;
}

function targetSchema(cacheDir: string): string {
  if (cacheDir === '') return '';
  for (const f of [`${cacheDir}/mcp/trajectory-server/src/db.ts`, `${cacheDir}/mcp/trajectory-server/dist/db.js`]) {
    if (!isFile(f)) continue;
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const m = /TARGET_SCHEMA_VERSION[ \t\v\f\r]*=[ \t\v\f\r]*([0-9]+)/.exec(text);
    if (m) return m[1];
  }
  return '';
}

function labelCount(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? String(parsed.length) : '0';
  } catch {
    return '0';
  }
}

function worktreeDirs(wsRoot: string): string[] {
  const dir = `${wsRoot}/.claude/worktrees`;
  if (wsRoot === '' || !isDir(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.') && isDir(`${dir}/${n}`))
    .sort(byteCompare)
    .map((n) => `${dir}/${n}/`);
}

class Report {
  failed = 0;
  degraded = 0;

  constructor(private readonly io: CliIo) {}

  line(text: string): void {
    this.io.out(`${text}\n`);
  }

  pass(text: string): void {
    this.line(`PASS  ${text}`);
  }

  fail(text: string): void {
    this.failed += 1;
    this.line(`FAIL  ${text}`);
  }

  remediate(...lines: string[]): void {
    for (const l of lines) this.line(`      -> ${l}`);
  }
}

/** Runs the health check; returns 1 when a check FAILED, else 0. */
export function health(_argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): number {
  const r = new Report(io);
  const self = selfRoot(env);
  const name = manifestName(self);
  const projectDir = env.CLAUDE_PROJECT_DIR ?? '';
  const sqliteOk = haveSqlite(env);
  const roEnv: NodeJS.ProcessEnv = { ...env, TMB_DB_WRITE_TIMEOUT_MS: DB_READ_TIMEOUT_MS };

  const db = env.TRAJECTORY_DB_PATH === MEMORY ? MEMORY : (dbPath(env) ?? '');
  const dbRead = (sql: string): string => {
    const out = dbReadRo(db, sql, roEnv);
    return out === GATE_READ_ERROR ? '' : out;
  };

  const installed = env.TMB_HEALTH_INSTALLED_JSON || `${env.HOME ?? ''}/.claude/plugins/installed_plugins.json`;
  let intended = env.TMB_HEALTH_INTENDED_VERSION ?? '';
  let cacheDir = env.TMB_HEALTH_CACHE_DIR ?? '';
  let installKey = '';
  let installScope = '';
  const entry = installEntry(installed, name, self);
  if (entry) {
    if (projectDir !== '' || entry.installPath === self) {
      if (intended === '') intended = entry.version;
      if (cacheDir === '') cacheDir = entry.installPath;
    }
    installKey = entry.key;
    installScope = entry.scope;
  }
  if (cacheDir === '' && projectDir === '') cacheDir = self;

  let updateCmd: string;
  if (installKey !== '') {
    if (installScope !== 'project' && installScope !== 'local') {
      installScope = installKey.endsWith('@trustmybot') ? 'project' : 'local';
    }
    updateCmd = `claude plugin update ${installKey} --scope ${installScope}`; // cli-config-scope: printed
  } else {
    updateCmd = `claude plugin update ${name}@<marketplace> --scope project (stable) or --scope local (rc/dev)`; // cli-config-scope: printed
  }

  let serverLog = env.TMB_HEALTH_SERVER_LOG ?? '';
  if (serverLog === '') {
    if (db === MEMORY) {
      serverLog = `${(env.TMPDIR || '/tmp').replace(/\/+$/, '')}/${name}-memory-logs/mcp-server.log`;
    } else if (db !== '') {
      serverLog = `${posixDirname(db)}/logs/mcp-server.log`;
    }
  }

  r.line('== TMB health-check ==');
  r.line(`db:        ${db || '<unresolved>'}`);
  r.line(`cache:     ${cacheDir || '<unresolved>'}`);
  r.line(`server-log:${serverLog || '<unresolved>'}`);
  r.line('');

  // 1. server-reachable
  let pgrepCount = env.TMB_HEALTH_PGREP_COUNT ?? '';
  let pgrepRc = 0;
  if (pgrepCount === '') ({ count: pgrepCount, rc: pgrepRc } = pgrepProbe(env));
  const alive = bashInt(pgrepCount);
  if (pgrepRc >= 2) {
    r.line(
      `UNVERIFIED  server-reachable: pgrep exited ${pgrepRc} — the process table cannot be listed here (e.g. the Claude Code sandbox)`,
    );
    r.remediate('Re-run outside the sandbox to probe the server, or check that trajectory-server MCP tools respond.');
  } else if (pgrepCount === '-1') {
    r.pass('server-reachable: pgrep unavailable — cannot probe (assuming reachable)');
  } else if (alive !== null && alive > 0) {
    r.pass(`server-reachable: trajectory-server process alive (${pgrepCount})`);
  } else {
    r.fail('server-reachable: NO trajectory-server process found');
    r.remediate(
      'Fully quit Claude Code (Cmd-Q) and relaunch — a dead MCP server needs a full restart.',
      'If it does not come back after relaunch, see skills/tmb_recovery (CC plugin MCP-config cache bug).',
      `Forensics: tail -n 50 ${serverLog || `<project>/.claude/${name}/logs/mcp-server.log`}`,
    );
  }

  // 2. cache-version — DB plugin_version vs installed (intended) version
  const dbPluginVersion = db !== '' && sqliteOk ? dbRead('SELECT plugin_version FROM plugin_meta WHERE id = 1;') : '';
  if (intended === '') {
    r.pass('cache-version: intended version unknown — skipping (no installed_plugins.json)');
  } else if (dbPluginVersion === '') {
    r.fail(`cache-version: DB plugin_version unreadable (intended=${intended})`);
    r.remediate(`Cannot read plugin_meta — is the DB present/queryable? db=${db || '<unresolved>'}`);
  } else if (dbPluginVersion === intended) {
    r.pass(`cache-version: DB matches installed version (${intended})`);
  } else {
    r.fail(`cache-version: server booted ${dbPluginVersion} but ${intended} is installed`);
    r.remediate(
      `From the project root, run ${updateCmd}; then fully quit + relaunch Claude Code so the server reboots on the new cache.`,
      `Scope rule: ${SCOPE_DOC}`,
      'Only a full restart picks up the new server — the MCP process is long-lived.',
    );
  }

  // 3. schema-version — DB schema_version vs the installed server's TARGET
  const dbSchema = db !== '' && sqliteOk ? dbRead('SELECT schema_version FROM plugin_meta WHERE id = 1;') : '';
  const target = targetSchema(cacheDir);
  if (target === '') {
    r.pass('schema-version: target schema unknown — skipping (no cache db source)');
  } else if (dbSchema === '') {
    r.fail(`schema-version: DB schema_version unreadable (target=${target})`);
    r.remediate(`Cannot read plugin_meta.schema_version — is the DB present/queryable? db=${db || '<unresolved>'}`);
  } else if (dbSchema === target) {
    r.pass(`schema-version: DB at current schema (v${dbSchema})`);
  } else {
    r.fail(`schema-version: DB at v${dbSchema} but installed server targets v${target}`);
    r.remediate('Fully quit + relaunch Claude Code — the migration runs on the next SERVER start.');
  }

  // 4. world-model — wm_ tables in the trajectory DB (read-only probe)
  let wmTableCount = '';
  let wmCounts = '';
  if (db !== '' && db !== MEMORY && sqliteOk) {
    wmTableCount = dbReadRo(
      db,
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('wm_directories','wm_files');",
      env,
    );
    if (wmTableCount === '2') {
      wmCounts = dbReadRo(db, "SELECT (SELECT COUNT(*) FROM wm_directories) || ' ' || (SELECT COUNT(*) FROM wm_files);", env);
    }
  }
  const space = wmCounts.indexOf(' ');
  const wmDirs = space < 0 ? wmCounts : wmCounts.slice(0, space);
  const wmFiles = wmCounts.slice(wmCounts.lastIndexOf(' ') + 1);
  if (db === '') {
    r.pass('world-model: trajectory DB unresolved — skipping');
  } else if (db === MEMORY) {
    r.pass('world-model: in-memory trajectory DB — nothing on disk to probe');
  } else if (!sqliteOk) {
    r.pass('world-model: sqlite3 unavailable — skipping');
  } else if (wmTableCount === GATE_READ_ERROR || wmCounts === GATE_READ_ERROR || wmTableCount === '') {
    r.fail('world-model: cannot read the world-model tables');
    r.remediate(`Is the DB present/queryable? db=${db}`);
  } else if (wmTableCount !== '2') {
    r.fail('world-model: wm_directories / wm_files missing from the trajectory DB');
    r.remediate(
      'Fully quit + relaunch Claude Code — the server creates the tables when it migrates the DB on start.',
      'Then build the world model: run /scan.',
    );
  } else if (wmDirs === '0') {
    r.pass('world-model: tables present');
    r.line('WARN  world-model: empty — no directories scanned yet');
    r.remediate('Build the world model: run /scan.');
  } else {
    r.pass(`world-model: ${wmDirs} directories, ${wmFiles} files`);
  }

  // The world model used to live in a separate graph file beside the DB
  // (<dir>/world-model.kuzu, or <db>.world-model.kuzu for a custom DB name).
  // Nothing reads it any more; report it, never delete it.
  let legacyGraph = '';
  if (db !== '' && db !== MEMORY) {
    legacyGraph =
      db.slice(db.lastIndexOf('/') + 1) === TMB_DB_FILENAME
        ? `${db.slice(0, -TMB_DB_FILENAME.length)}world-model.kuzu`
        : `${db}.world-model.kuzu`;
  }
  if (legacyGraph !== '' && existsSync(legacyGraph)) {
    r.line(
      `INFO  world-model: ${legacyGraph} is an unused leftover from the old graph store — TMB no longer reads it; you may delete it (and any ${legacyGraph.slice(legacyGraph.lastIndexOf('/') + 1)}.* files beside it).`,
    );
  }

  // 5. label-config — issue_classification_labels sane (not bare default)
  const labelsRaw =
    db !== '' && sqliteOk ? dbRead("SELECT value_json FROM plugin_config WHERE key = 'issue_classification_labels';") : '';
  const labels = labelsRaw === '' ? '0' : labelCount(labelsRaw);
  if (labelsRaw === '' || labels === '0') {
    r.fail('label-config: issue_classification_labels is unset/empty');
    r.remediate(
      'Set it via /onboard, or with the config_set MCP tool (key=issue_classification_labels).',
      'Until set, issue auto-classification falls back to the generic default.',
    );
  } else {
    r.pass(`label-config: issue_classification_labels set (${labels} labels)`);
  }

  // 6. stale-state — orphaned worktrees / pending|running tasks
  const wsRoot = db === '' ? '' : posixDirname(posixDirname(posixDirname(db)));
  const worktrees = worktreeDirs(wsRoot);
  const pending =
    db !== '' && sqliteOk
      ? dbRead(
          "SELECT id || ' [' || status || '] ' || COALESCE(branch_id,'') FROM tasks WHERE status IN ('pending','running');",
        )
      : '';
  if (worktrees.length === 0 && pending === '') {
    r.pass('stale-state: no orphaned worktrees or pending/running tasks');
  } else {
    r.fail('stale-state: orphaned worktrees and/or pending|running tasks present');
    if (pending !== '') {
      r.remediate('Pending/running tasks (recover or close):');
      for (const t of pending.split('\n')) if (t !== '') r.remediate(`    task ${t}`);
    }
    if (worktrees.length > 0) {
      r.remediate(`Worktrees under ${wsRoot}/.claude/worktrees/ (clean up once the task is done):`);
      for (const w of worktrees) r.remediate(`    ${w}`);
    }
  }

  // 7. hook-cache-drift — running hooks load from the cache, not the dev checkout
  // CC executes hooks/skills/agents/commands from the marketplace CACHE, not
  // from a dev checkout. If the dev checkout (CLAUDE_PLUGIN_ROOT) is at a
  // different version than the installed cache, the hook definitions you are
  // editing are NOT the ones running this session.
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT ?? '';
  const devManifest = `${pluginRoot}/.claude-plugin/plugin.json`;
  const driftVersion = pluginRoot !== '' && isFile(devManifest) ? jqField(readJson(devManifest), 'version', '') : '';
  if (driftVersion === '' || intended === '') {
    r.pass('hook-cache-drift: no dev checkout vs cache comparison available');
  } else if (pluginRoot === cacheDir) {
    r.pass('hook-cache-drift: running directly from the cache (no drift)');
  } else if (driftVersion === intended) {
    r.pass(`hook-cache-drift: dev checkout version matches the installed cache (${intended})`);
  } else {
    r.fail(`hook-cache-drift: dev checkout is ${driftVersion} but the cache runs ${intended}`);
    r.remediate(
      'Your edits to hooks/skills/agents/commands are NOT live until the cache updates.',
      `Once the cache is at your version (from the project root: ${updateCmd}), fully quit + relaunch Claude Code to load the new hook/skill/agent/command definitions.`,
    );
  }

  // 8. embeddings — the doctor's embeddings_not_degraded contract
  //    (mcp/trajectory-server/src/data-contracts.ts): an embeddings_degraded row
  //    from the last 24 h with no later embeddings_recovered row.
  const onDisk = db !== '' && db !== MEMORY && sqliteOk;
  const embDegraded = onDisk
    ? dbReadRo(
        db,
        `SELECT d.created_at || ' ' || COALESCE(json_extract(d.content_json, '$.reason'), '')
      FROM audit d
     WHERE d.event_type = 'embeddings_degraded'
       AND strftime('%Y-%m-%dT%H:%M:%fZ', d.created_at) >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 days')
       AND NOT EXISTS (SELECT 1 FROM audit r WHERE r.event_type = 'embeddings_recovered' AND r.id > d.id)
     ORDER BY d.id DESC LIMIT 1;`,
        roEnv,
      )
    : '';
  if (!onDisk) {
    r.pass('embeddings: no on-disk trajectory DB to read — skipping');
  } else if (embDegraded === GATE_READ_ERROR) {
    r.pass('embeddings: audit table unreadable — skipping');
  } else if (embDegraded !== '') {
    r.degraded += 1;
    r.line(`WARN  embeddings: degraded since ${embDegraded} — semantic search is falling back to FTS`);
    r.remediate(
      'The embedding model failed to load or kept failing; the server re-attempts on its own (1 min, 5 min, then every 10 min).',
      `Check the embeddings_state lines in ${serverLog || 'mcp-server.log'}; trajectory_doctor reports the live state.`,
    );
  } else {
    r.pass('embeddings: no unrecovered embeddings_degraded event in the last 24 h');
  }

  // duplicate-plugin (warning) — more than one enabled copy for this project
  const libEnv: NodeJS.ProcessEnv = { ...env, TMB_INSTALLED_JSON: installed };
  const dupProject = projectDir !== '' || db !== MEMORY ? projectRoot(env) : '';
  if (dupProject === '') {
    r.line('WARN  duplicate-plugin: skipped — no project resolves (no CLAUDE_PROJECT_DIR and no trajectory DB)');
    r.remediate('Run from a Claude Code session in the project, or set CLAUDE_PROJECT_DIR (or TRAJECTORY_DB_PATH) to it.');
  }
  const dups = dupProject === '' ? [] : duplicateInstalls(dupProject, libEnv);
  if (dups.length > 0) {
    r.line(`WARN  duplicate-plugin: ${dups.length} enabled ${name} copies for ${dupProject}: ${duplicateNames(dups)}`);
    r.remediate(
      "Claude Code registers the hooks of only one of them (which one is not documented) and skips the other's with a plugin load error — TMB's gates may be missing while its MCP tools still work.",
      `Keep one copy and disable the others from the project root, one of: ${duplicateDisableCmds(dups, libEnv)}`,
      'Then fully quit + relaunch Claude Code.',
    );
  }

  // legacy-user-hooks (warning) — pre-1.1.0 hooks left in the user settings.json
  const legacy = legacyUserHooks(dupProject, libEnv);
  if (legacy.hooks.length > 0) {
    r.line(
      `WARN  legacy-user-hooks: ${userSettingsJson(env)} holds ${legacy.hooks.length} pre-1.1.0 TMB hook(s): ${legacyHookEntries(legacy.hooks)}`,
    );
    r.remediate(
      'They run in every project, so a pre-1.1.0 gate can deny what this version allows. TMB does not edit that file.',
      `Remove them by hand: ${LEGACY_USER_HOOKS_DOC}`,
    );
    if (legacy.projects.length > 0) r.remediate(`Projects on TMB < 1.1.0 lose them too: ${legacyHookProjects(legacy.projects)}`);
  }

  r.line('');
  if (r.failed === 0 && r.degraded > 0) {
    r.line(`== no check FAILED, ${r.degraded} degraded (see WARN above) ==`);
    return 0;
  }
  if (r.failed === 0) {
    r.line('== all checks passed ==');
    return 0;
  }
  r.line(`== ${r.failed} check(s) FAILED ==`);
  return 1;
}
