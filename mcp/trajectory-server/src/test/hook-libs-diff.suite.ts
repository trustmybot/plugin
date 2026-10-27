/**
 * Differential test of the TS hook libs (src/hooks/lib/) against the shell
 * libs they port (scripts/hooks/lib/query-task.sh, db-write.sh,
 * normalize-role.sh, agent-context.sh), GH 1692. One bash process sources the
 * shell libs once and runs every case; the TS ports run the same cases twice,
 * through node:sqlite and through the sqlite3 CLI fallback. A case compares
 * what a `$(...)` capture of the .sh holds with what the TS returns; a recorded
 * divergence (tests/fixtures/hook-libs/divergences.jsonl) must still diverge
 * exactly as recorded. The two TS passes split across
 * hook-libs-diff.shard-<k>of<n>.test.ts (GH 1947), each shard running the .sh
 * over every case; shard 1 also runs the checks on the .sh side alone.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  branchSlug,
  callerRun,
  dbLocation,
  dbPath,
  dbProbe,
  dbProjectRoot,
  dbReadBudget,
  dbReadRo,
  dbState,
  dbUnavailableReason,
  denyDbUnavailable,
  gateRead,
  immutableUri,
  projectRoot,
  realdir,
  repoPathAbs,
  sqlInt,
  sqliteRo,
  sqlLikeEscape,
  sqlQuote,
  stateDir,
  stripTrailingNewlines,
  sweContext,
  taskBySlug,
  taskIdFromTranscript,
  testFlag,
  walCold,
} from '../hooks/lib/db.js';
import { auditAppend, auditSql, auditWriterCheck, dedupeGuard, dbWrite, nowIso } from '../hooks/lib/audit.js';
import { agentRole, normalizeRole } from '../hooks/lib/role.js';
import { agentContext, agentTranscript, ctxInWorktree, pathCanonical, taskLocation } from '../hooks/lib/agent-context.js';
import { pluginName } from '../hooks/lib/project-env.js';
import { loadNodeSqlite, sqliteBackend } from '../hooks/lib/sqlite-shell.js';
import { shardOf } from './shard.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LIB = join(PLUGIN_ROOT, 'scripts/hooks/lib');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const DIVERGENCES = join(PLUGIN_ROOT, 'tests/fixtures/hook-libs/divergences.jsonl');
const DIST_DB = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks/lib/db.js');
const NOW = '2026-01-02T03:04:05.000Z';
const CALLER = 'harness';
const COLD = ['state', 'gate', 'budget', 'probe', 'ro'];
const KNOWN_ENV = [
  'TRAJECTORY_DB_PATH',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_PLUGIN_ROOT',
  'TMB_FORBID_LIVE_SYNC',
  'TMB_TEST_RUN_ID',
  'TMB_DB_WRITE_TIMEOUT_MS',
  'TMB_DB_WRITE_RUN_BUDGET_MS',
  'HARNESS_EVENTS_FILE',
];
const STDERR_FNS = new Set([
  'tmb_db_path',
  'tmb_db_write',
  'tmb_audit_append',
  'tmb_audit_sql',
  'tmb_audit_dedupe_guard',
  'tmb_audit_writer_check',
  'tmb_task_by_slug',
]);

const HARNESS = `
LIB="$1"; CASES="$2"; OUT="$3"
. "$LIB/query-task.sh"
. "$LIB/db-write.sh"
. "$LIB/normalize-role.sh"
. "$LIB/agent-context.sh"
HARNESS_EVENTS_DEFAULT="$_TMB_AUDIT_EVENTS_FILE"
tmb_now_iso() { printf '%s\\n' "$HARNESS_NOW"; }
op_ctx() {
  local rc=0
  tmb_agent_context "$1" "$2" || rc=$?
  printf 'role=%s\\ntask=%s\\nrepo=%s\\nroot=%s\\nworktree=%s\\nmissing=%s' "$TMB_CTX_ROLE" "$TMB_CTX_TASK_ID" "$TMB_CTX_REPO" "$TMB_CTX_REPO_ROOT" "$TMB_CTX_WORKTREE" "$TMB_CTX_MISSING"
  return "$rc"
}
op_loc() {
  local rc=0
  tmb_task_location "$1" "$2" || rc=$?
  printf 'repo=%s\\nroot=%s\\nworktree=%s\\nmissing=%s' "$TMB_CTX_REPO" "$TMB_CTX_REPO_ROOT" "$TMB_CTX_WORKTREE" "$TMB_CTX_MISSING"
  return "$rc"
}
op_in_wt() { local TMB_CTX_WORKTREE="$2"; tmb_ctx_in_worktree "$1"; }
op_budget() { tmb_db_read_budget "$1" "$2" <<<"$3"; }
op_probe() { _tmb_db_probe "$1"; printf '%s' "$?"; }
op_wal_cold() { _tmb_db_wal_cold "$1"; printf '%s' "$?"; }
i=0
exec 9<"$CASES"
while IFS= read -r -d '' id <&9; do
  IFS= read -r -d '' cwd <&9
  IFS= read -r -d '' keep <&9
  IFS= read -r -d '' nenv <&9
  for v in ${KNOWN_ENV.join(' ')}; do unset "$v"; done
  k=0
  while [ "$k" -lt "$nenv" ]; do
    IFS= read -r -d '' key <&9
    IFS= read -r -d '' val <&9
    export "$key=$val"
    k=$((k + 1))
  done
  IFS= read -r -d '' fn <&9
  IFS= read -r -d '' nargs <&9
  args=()
  k=0
  while [ "$k" -lt "$nargs" ]; do
    IFS= read -r -d '' a <&9
    args[$k]="$a"
    k=$((k + 1))
  done
  if [ "$keep" != 1 ]; then _TMB_DB_PATH_CACHE=""; _TMB_DB_WRITE_SPENT_MS=0; fi
  _TMB_AUDIT_EVENTS_FILE="\${HARNESS_EVENTS_FILE:-$HARNESS_EVENTS_DEFAULT}"
  cd "$cwd" || exit 90
  "$fn" "\${args[@]}" >"$OUT/$i.out" 2>"$OUT/$i.err" </dev/null
  echo "$?" >"$OUT/$i.rc"
  i=$((i + 1))
done
`;

const HOLDER = `
import { DatabaseSync } from 'node:sqlite';
const [warm, walock, exlock] = process.argv.slice(2);
const w = new DatabaseSync(warm);
w.prepare('SELECT count(*) FROM sqlite_master').get();
const a = new DatabaseSync(walock);
a.exec('BEGIN IMMEDIATE');
const b = new DatabaseSync(exlock);
b.exec('BEGIN EXCLUSIVE');
process.stdout.write('ready\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  a.exec('ROLLBACK');
  b.exec('ROLLBACK');
  for (const db of [w, a, b]) db.close();
  process.exit(0);
});
`;

interface Case {
  id: string;
  fn: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  keep?: boolean;
}

interface Outcome {
  out: string;
  rc: number;
  err?: string;
}

interface Divergence {
  fn: string;
  case: string;
  sh: string;
  ts: string;
  reason: string;
}

type Adapter = (args: string[], env: NodeJS.ProcessEnv) => Outcome;

const ok = (out: string, rc = 0): Outcome => ({ out, rc });
const a = (args: string[], i: number): string => args[i] ?? '';

function eventsOpt(env: NodeJS.ProcessEnv): { eventsFile?: string } {
  return env.HARNESS_EVENTS_FILE ? { eventsFile: env.HARNESS_EVENTS_FILE } : {};
}

function ctxText(c: { role: string; taskId: string; repo: string; repoRoot: string; worktree: string; missing: string }): string {
  return `role=${c.role}\ntask=${c.taskId}\nrepo=${c.repo}\nroot=${c.repoRoot}\nworktree=${c.worktree}\nmissing=${c.missing}`;
}

const ADAPTERS: Record<string, Adapter> = {
  tmb_plugin_name: (_, env) => ok(pluginName(env)),
  tmb_db_location: (args, env) => ok(dbLocation(a(args, 0), env)),
  op_wal_cold: (args) => ok(walCold(a(args, 0)) ? '0' : '1'),
  tmb_gate_read: (args, env) => ok(gateRead(a(args, 0), a(args, 1), env)),
  op_budget: (args, env) => {
    const r = dbReadBudget(a(args, 0), a(args, 1), `${a(args, 2)}\n`, env);
    return ok(r.out, r.code);
  },
  _tmb_db_immutable_uri: (args, env) => ok(immutableUri(a(args, 0), env)),
  _tmb_db_read_ro: (args, env) => ok(dbReadRo(a(args, 0), a(args, 1), env)),
  op_probe: (args, env) => ok(String(dbProbe(a(args, 0), env))),
  tmb_test_flag: (_, env) => {
    const flag = testFlag(env);
    return ok(flag ?? '', flag ? 0 : 1);
  },
  tmb_db_path: (_, env) => {
    let err = '';
    const p = dbPath(env, (line) => (err = line));
    return { out: p ?? '', rc: p === null ? 1 : 0, err };
  },
  tmb_realdir: (args) => ok(realdir(a(args, 0))),
  tmb_db_project_root: (args) => ok(dbProjectRoot(a(args, 0))),
  tmb_repo_path_abs: (args) => ok(repoPathAbs(a(args, 0), a(args, 1))),
  tmb_project_root: (_, env) => ok(projectRoot(env)),
  tmb_state_dir: (_, env) => {
    const d = stateDir(env);
    return ok(d ?? '', d === null ? 1 : 0);
  },
  tmb_db_state: (_, env) => ok(dbState(env)),
  tmb_db_unavailable_reason: (args, env) => ok(dbUnavailableReason(a(args, 0), env)),
  tmb_deny_db_unavailable: (args, env) => ok(denyDbUnavailable(a(args, 0), env)),
  tmb_sqlite_ro: (args, env) => ok(sqliteRo(a(args, 0), a(args, 1), env)),
  tmb_swe_context: (args) => ok(sweContext(a(args, 0))),
  tmb_sql_int: (args) => ok(sqlInt(a(args, 0))),
  tmb_sql_quote: (args) => ok(sqlQuote(a(args, 0))),
  tmb_sql_like_escape: (args) => ok(sqlLikeEscape(a(args, 0))),
  tmb_task_by_slug: (args, env) => {
    const warnings: string[] = [];
    const out = taskBySlug(a(args, 0), a(args, 1), args[2] ?? 'id', a(args, 3), env, (line) => warnings.push(line));
    return { out, rc: 0, err: warnings.join('\n') };
  },
  tmb_branch_slug: (args) => ok(branchSlug(a(args, 0))),
  tmb_caller_run: (args, env) => ok(callerRun(a(args, 0), a(args, 1), env)),
  tmb_task_id_from_transcript: (args) => ok(taskIdFromTranscript(a(args, 0))),
  tmb_normalize_role: (args) => ok(normalizeRole(a(args, 0))),
  tmb_agent_role: (args) => ok(agentRole(a(args, 0))),
  tmb_agent_transcript: (args) => ok(agentTranscript(a(args, 0))),
  op_loc: (args, env) => {
    const r = taskLocation(a(args, 0), a(args, 1), env);
    return ok(`repo=${r.repo}\nroot=${r.repoRoot}\nworktree=${r.worktree}\nmissing=${r.missing}`, r.code);
  },
  op_ctx: (args, env) => {
    const r = agentContext(a(args, 0), a(args, 1), env);
    return ok(ctxText(r), r.code);
  },
  op_in_wt: (args) => ok('', ctxInWorktree(a(args, 0), a(args, 1)) ? 0 : 1),
  tmb_path_canonical: (args) => ok(pathCanonical(a(args, 0))),
  tmb_db_write: (args, env) => {
    const r = dbWrite(a(args, 0), a(args, 1), { caller: CALLER, env });
    return { out: stripTrailingNewlines(r.stdout), rc: r.code, err: r.error };
  },
  tmb_audit_writer_check: (args, env) => {
    const r = auditWriterCheck(a(args, 0), a(args, 1), a(args, 2), eventsOpt(env));
    return { out: '', rc: r.code, err: r.error };
  },
  tmb_audit_dedupe_guard: (args) => {
    const r = dedupeGuard(a(args, 0), a(args, 1), args.slice(2), { caller: CALLER });
    return { out: r.sql, rc: r.code, err: r.error };
  },
  tmb_audit_sql: (args, env) => {
    const row = {
      issueId: a(args, 0),
      branchId: a(args, 1),
      fromNode: a(args, 2),
      eventType: a(args, 3),
      summary: a(args, 4),
      contentJson: a(args, 5),
    };
    const r = auditSql(row, a(args, 6), { caller: CALLER, now: NOW, env, ...eventsOpt(env) });
    return { out: r.sql, rc: r.code, err: r.error };
  },
  tmb_audit_append: (args, env) => {
    const row = {
      issueId: a(args, 1),
      branchId: a(args, 2),
      fromNode: a(args, 3),
      eventType: a(args, 4),
      summary: a(args, 5),
      contentJson: a(args, 6),
      dedupePaths: args.slice(7),
    };
    const r = auditAppend(a(args, 0), row, { caller: CALLER, now: NOW, env, ...eventsOpt(env) });
    return { out: stripTrailingNewlines(r.stdout), rc: r.code, err: r.error };
  },
};

let R = '';
let holder: ChildProcess | undefined;

const P = () => join(R, 'persist');
const M = () => join(R, 'mut');
const T = () => join(R, 'template');
const stateDb = (root: string) => join(root, '.claude/tmb/trajectory.db');

function openDb(path: string, mode: 'wal' | 'delete'): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  if (mode === 'delete') db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA foreign_keys = OFF');
  return db;
}

function seedTasks(db: DatabaseSync): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.exec(`
    INSERT INTO repos (name, path) VALUES ('plugin', '${R}/repo-plugin'), ('other', '${R}/repo-other'), ('slash', '${R}/repo-slash/');
    INSERT INTO issues (id, objective, created_at, updated_at, repo) VALUES (1, 'i1', '${now}', '${now}', 'plugin');
    INSERT INTO tasks (id, issue_id, branch_id, description, created_at, updated_at, repo) VALUES
      (69, 1, 'feat/ts-hook-libs', 'd', '${now}', '${now}', 'plugin'),
      (70, 1, '', 'd', '${now}', '${now}', 'plugin'),
      (71, 1, 'fix/x', 'd', '${now}', '${now}', 'ghost'),
      (72, 1, 'chore/y', 'd', '${now}', '${now}', NULL),
      (73, 1, 'feat/a/b', 'd', '${now}', '${now}', 'other'),
      (74, 1, 'docs/z', 'd', '${now}', '${now}', 'slash');
    INSERT INTO agent_runs (task_id, agent_type, spawn_id, root_dir) VALUES
      (71, 'swe', 'agent-bound', '/old/wt'),
      (69, 'swe', 'agent-bound', '/x/wt'),
      (NULL, 'swe', 'agent-null', NULL),
      (73, 'code-reviewer', 'agent-rev', '/r');
  `);
}

function seedSlugs(db: DatabaseSync): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.exec(`INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, 'i1', '${now}', '${now}');`);
  const task = db.prepare(`INSERT INTO tasks (id, issue_id, branch_id, status, description, created_at, updated_at) VALUES (?, 1, ?, ?, 'd', '${now}', '${now}')`);
  const rows: [number, string, string][] = [
    [1, 'feat/one', 'running'],
    [2, 'fix/one', 'closed'],
    [3, 'feat/under_score', 'pending'],
    [4, 'feat/underXscore', 'pending'],
    [5, 'feat/pct%x', 'pending'],
    [6, "feat/it's", 'pending'],
    [7, 'feat/a/one', 'pending'],
    [8, 'feat/bar|ed', 'pending'],
    [9, 'feat/back\\slash', 'pending'],
  ];
  for (const r of rows) task.run(...r);
}

function seedAudit(db: DatabaseSync): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.exec(`
    INSERT INTO repos (name, path) VALUES ('plugin', '${R}/repo-plugin');
    INSERT INTO issues (id, objective, created_at, updated_at, repo) VALUES
      (1, 'i1', '${now}', '${now}', 'plugin');
    INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
      VALUES (1, NULL, 'hook:seed', 'hook_block_bypassed', 'seed', '{"task_id":7,"commit_sha":"abc"}', 'plugin', '${now}');
  `);
}

function makeDb(path: string, mode: 'wal' | 'delete', seed?: (db: DatabaseSync) => void): void {
  const db = openDb(path, mode);
  seed?.(db);
  db.close();
}

function makeStale(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = DELETE; CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT);');
  db.close();
}

function corruptHeader(path: string): void {
  makeDb(path, 'delete');
  const bytes = readFileSync(path);
  bytes.write('not a sqlite file', 0, 'utf8');
  writeFileSync(path, bytes);
}

function buildSandbox(): void {
  R = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-hook-libs-')));
  const p = P();
  const t = T();
  makeDb(stateDb(join(p, 'warm')), 'wal', seedTasks);
  mkdirSync(join(p, 'warm/sub'), { recursive: true });
  symlinkSync(join(p, 'warm'), join(p, 'link-warm'));
  makeDb(join(p, 'walock.db'), 'wal', seedAudit);
  makeDb(join(p, 'exlock.db'), 'delete', seedTasks);
  makeDb(join(p, 'slugs.db'), 'delete', seedSlugs);
  makeDb(stateDb(R), 'delete');
  mkdirSync(join(R, 'nodb'), { recursive: true });
  mkdirSync(join(R, 'repo-plugin/.claude/worktrees/ts-hook-libs/src'), { recursive: true });
  symlinkSync(join(R, 'repo-plugin/.claude/worktrees/ts-hook-libs'), join(R, 'wt-link'));
  mkdirSync(join(R, 'odd"dir\ttab'), { recursive: true });
  makeDb(join(R, 'odd"dir\ttab/x.db'), 'delete');
  mkdirSync(join(R, 'plug/.claude-plugin'), { recursive: true });
  writeFileSync(join(R, 'plug/.claude-plugin/plugin.json'), '{"name":"tmbdev"}');
  mkdirSync(join(R, 'plug-null/.claude-plugin'), { recursive: true });
  writeFileSync(join(R, 'plug-null/.claude-plugin/plugin.json'), '{"name":null}');
  mkdirSync(join(R, 'plug-bad/.claude-plugin'), { recursive: true });
  writeFileSync(join(R, 'plug-bad/.claude-plugin/plugin.json'), '{"name": ');

  for (const n of COLD) makeDb(join(t, `cold-${n}.db`), 'wal', seedTasks);
  writeFileSync(join(t, 'empty.db'), '');
  corruptHeader(join(t, 'corrupt.db'));
  makeDb(join(t, 'audit.db'), 'delete', seedAudit);
  makeDb(stateDb(join(t, 'nest/outer')), 'wal', seedTasks);
  makeDb(stateDb(join(t, 'nest/outer/inner')), 'wal', seedTasks);
  makeDb(stateDb(join(t, 'nest2/outer')), 'wal', seedTasks);
  makeDb(stateDb(join(t, 'nest2/outer/inner')), 'wal', seedTasks);
  writeFileSync(join(t, 'nest2/outer/inner/.claude/tmb/standalone'), '');
  makeDb(stateDb(join(t, 'legacy/outer')), 'delete', seedTasks);
  makeStale(stateDb(join(t, 'legacy/outer/inner')));
  makeStale(stateDb(join(t, 'stale-only')));
  mkdirSync(join(t, 'corrupt-proj/.claude/tmb'), { recursive: true });
  corruptHeader(stateDb(join(t, 'corrupt-proj')));
  makeDb(stateDb(join(t, 'solo')), 'delete', (db) => {
    const now = '2026-01-01T00:00:00.000Z';
    db.exec(`
      INSERT INTO repos (name, path) VALUES ('solo', 'rel/repo');
      INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, 'i', '${now}', '${now}');
      INSERT INTO tasks (id, issue_id, branch_id, description, created_at, updated_at) VALUES (5, 1, 'feat/solo', 'd', '${now}', '${now}');
    `);
  });
  mkdirSync(join(t, 'solo/real/repo'), { recursive: true });
  symlinkSync('real', join(t, 'solo/rel'));

  const tx = join(R, 'tx');
  mkdirSync(join(tx, 'main/subagents'), { recursive: true });
  writeFileSync(join(tx, 'main/subagents/agent-a1.jsonl'), '{"message":{"content":[{"type":"text","text":"go: task_id=69 now"}]}}\n');
  writeFileSync(join(tx, 'own.jsonl'), '{"message":{"content":"Implement task_id=73 please"}}\n');
  writeFileSync(join(tx, 'none.jsonl'), '{"message":{"content":"no id here"}}\n');
  writeFileSync(join(tx, 'mixed.jsonl'), '"str"\n{"message":"x"}\n{"message":null}\n{"message":{"content":"task_id=70"}}\n');
  writeFileSync(join(tx, 'broken.jsonl'), '{"message":{"content":"task_id=71"}}\n{bad json\n{"message":{"content":"task_id=72"}}\n');
  writeFileSync(join(tx, 'late.jsonl'), '{"message":{"content":[{"text":"task_id=abc"}]}}\n{"message":{"content":{"k":"task_id=12x"}}}\n');
}

function restoreMut(): void {
  rmSync(M(), { recursive: true, force: true });
  cpSync(T(), M(), { recursive: true, verbatimSymlinks: true });
}

async function startHolder(): Promise<void> {
  const script = join(R, 'holder.mjs');
  writeFileSync(script, HOLDER);
  const p = P();
  const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', script, stateDb(join(p, 'warm')), join(p, 'walock.db'), join(p, 'exlock.db')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  holder = child;
  await new Promise<void>((done, fail) => {
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('ready')) done();
    });
    child.on('exit', (code) => fail(new Error(`holder exited ${code}`)));
  });
}

async function stopHolder(): Promise<void> {
  const child = holder;
  if (!child || child.exitCode !== null) return;
  child.removeAllListeners('exit');
  await new Promise<void>((done) => {
    child.on('exit', () => done());
    child.stdin!.end();
  });
}

function buildCases(): Case[] {
  const p = P();
  const m = M();
  const warm = stateDb(join(p, 'warm'));
  const link = join(p, 'link-warm');
  const walock = join(p, 'walock.db');
  const exlock = join(p, 'exlock.db');
  const audit = join(m, 'audit.db');
  const corrupt = join(m, 'corrupt.db');
  const empty = join(m, 'empty.db');
  const missing = join(m, 'missing.db');
  const tx = join(R, 'tx');
  const fast = { TMB_DB_WRITE_TIMEOUT_MS: '50' };
  const cases: Case[] = [];
  const add = (fn: string, label: string, args: string[], extra: Omit<Case, 'id' | 'fn' | 'args'> = {}) =>
    cases.push({ id: `${fn}:${label}`, fn, args, ...extra });
  const swe = (o: Record<string, unknown>) => JSON.stringify({ agent_type: 'tmb:swe', ...o });

  add('tmb_plugin_name', 'no-root', []);
  add('tmb_plugin_name', 'manifest', [], { env: { CLAUDE_PLUGIN_ROOT: join(R, 'plug') } });
  add('tmb_plugin_name', 'null-name', [], { env: { CLAUDE_PLUGIN_ROOT: join(R, 'plug-null') } });
  add('tmb_plugin_name', 'malformed', [], { env: { CLAUDE_PLUGIN_ROOT: join(R, 'plug-bad') } });
  add('tmb_plugin_name', 'no-manifest', [], { env: { CLAUDE_PLUGIN_ROOT: join(R, 'nodb') } });
  add('tmb_db_location', 'root', [join(p, 'warm')]);
  add('tmb_db_location', 'plugin-root', ['/proj'], { env: { CLAUDE_PLUGIN_ROOT: join(R, 'plug') } });
  add('tmb_db_location', 'empty', ['']);

  for (const [label, db] of [
    ['warm', warm],
    ['cold', join(m, 'cold-state.db')],
    ['walock', walock],
    ['exlock', exlock],
    ['empty', empty],
    ['corrupt', corrupt],
    ['missing', missing],
  ] as const) {
    add('op_wal_cold', label, [db]);
  }

  add('tmb_db_state', 'unresolved', [], { cwd: join(R, 'nodb') });
  add('tmb_db_state', 'ok-warm', [], { env: { TRAJECTORY_DB_PATH: warm } });
  add('tmb_db_state', 'ok-cold', [], { env: { TRAJECTORY_DB_PATH: join(m, 'cold-state.db') } });
  add('tmb_db_state', 'ok-walock', [], { env: { TRAJECTORY_DB_PATH: walock } });
  add('tmb_db_state', 'ok-empty', [], { env: { TRAJECTORY_DB_PATH: empty } });
  add('tmb_db_state', 'error-exlock', [], { env: { TRAJECTORY_DB_PATH: exlock, ...fast } });
  add('tmb_db_state', 'error-corrupt', [], { env: { TRAJECTORY_DB_PATH: corrupt } });
  add('tmb_db_state', 'unresolved-missing', [], { env: { TRAJECTORY_DB_PATH: missing } });
  add('tmb_db_state', 'error-corrupt-walkup', [], { env: { CLAUDE_PROJECT_DIR: join(m, 'corrupt-proj') } });

  add('tmb_db_path', 'explicit', [], { env: { TRAJECTORY_DB_PATH: warm } });
  add('tmb_db_path', 'explicit-missing', [], { env: { TRAJECTORY_DB_PATH: missing } });
  add('tmb_db_path', 'symlinked-project', [], { env: { CLAUDE_PROJECT_DIR: link } });
  add('tmb_db_path', 'symlinked-cwd', [], { cwd: link });
  add('tmb_db_path', 'symlinked-cwd-sub', [], { cwd: join(link, 'sub') });
  add('tmb_db_path', 'nest-outermost', [], { env: { CLAUDE_PROJECT_DIR: join(m, 'nest/outer/inner') } });
  add('tmb_db_path', 'nest-standalone', [], { env: { CLAUDE_PROJECT_DIR: join(m, 'nest2/outer/inner') } });
  add('tmb_db_path', 'legacy-skipped', [], { env: { CLAUDE_PROJECT_DIR: join(m, 'legacy/outer/inner') } });
  add('tmb_db_path', 'stale-only', [], { env: { CLAUDE_PROJECT_DIR: join(m, 'stale-only') } });
  add('tmb_db_path', 'probe-error-kept', [], { env: { CLAUDE_PROJECT_DIR: join(m, 'corrupt-proj') } });
  add('tmb_db_path', 'home-start', [], { env: { CLAUDE_PROJECT_DIR: R } });
  add('tmb_db_path', 'home-stop', [], { env: { CLAUDE_PROJECT_DIR: join(R, 'nodb') } });
  add('tmb_db_path', 'flag-no-project', [], { env: { TMB_FORBID_LIVE_SYNC: '1' } });
  add('tmb_db_path', 'flag-run-id-project', [], { env: { TMB_TEST_RUN_ID: 'x', CLAUDE_PROJECT_DIR: join(p, 'warm') } });
  add('tmb_db_path', 'flag-no-walk', [], { env: { TMB_TEST_RUN_ID: 'x', CLAUDE_PROJECT_DIR: join(p, 'warm/sub') } });
  add('tmb_db_path', 'memo-first', [], { env: { CLAUDE_PROJECT_DIR: join(p, 'warm') } });
  add('tmb_db_path', 'memo-kept', [], { env: { TRAJECTORY_DB_PATH: missing }, keep: true });

  add('tmb_test_flag', 'none', []);
  add('tmb_test_flag', 'forbid', [], { env: { TMB_FORBID_LIVE_SYNC: '1' } });
  add('tmb_test_flag', 'forbid-0', [], { env: { TMB_FORBID_LIVE_SYNC: '0' } });
  add('tmb_test_flag', 'run-id', [], { env: { TMB_TEST_RUN_ID: 'r1' } });
  add('tmb_test_flag', 'both', [], { env: { TMB_FORBID_LIVE_SYNC: '1', TMB_TEST_RUN_ID: 'r1' } });

  add('tmb_realdir', 'empty', ['']);
  add('tmb_realdir', 'symlink', [link]);
  add('tmb_realdir', 'missing', [join(R, 'nope/x')]);
  add('tmb_realdir', 'file', [warm]);
  add('tmb_realdir', 'relative', ['link-warm/sub'], { cwd: p });
  add('tmb_db_project_root', 'shape', [warm]);
  add('tmb_db_project_root', 'no-shape', ['/a/b/c.db']);
  add('tmb_db_project_root', 'empty', ['']);
  add('tmb_db_project_root', 'relative', ['.claude/tmb/trajectory.db']);
  add('tmb_db_project_root', 'bare', ['x.db']);
  add('tmb_repo_path_abs', 'absolute', [warm, '/abs/repo']);
  add('tmb_repo_path_abs', 'project', [warm, 'rel/repo']);
  add('tmb_repo_path_abs', 'no-project', ['/tmp/a/x.db', 'rel']);
  add('tmb_project_root', 'resolved', [], { env: { TRAJECTORY_DB_PATH: warm } });
  add('tmb_project_root', 'no-shape', [], { env: { TRAJECTORY_DB_PATH: walock } });
  add('tmb_project_root', 'fallback-project-dir', [], { env: { CLAUDE_PROJECT_DIR: join(R, 'nodb') } });
  add('tmb_project_root', 'none', [], { cwd: join(R, 'nodb') });
  add('tmb_state_dir', 'resolved', [], { env: { CLAUDE_PROJECT_DIR: link } });
  add('tmb_state_dir', 'unresolved', [], { cwd: join(R, 'nodb') });

  add('tmb_db_unavailable_reason', 'hook', ['containment-guard'], { env: { TRAJECTORY_DB_PATH: exlock } });
  add('tmb_db_unavailable_reason', 'default-hook', [''], { env: { TRAJECTORY_DB_PATH: corrupt } });
  add('tmb_db_unavailable_reason', 'unresolved', ['g'], { cwd: join(R, 'nodb') });
  add('tmb_deny_db_unavailable', 'busy', ['containment-guard'], { env: { TRAJECTORY_DB_PATH: exlock } });
  add('tmb_deny_db_unavailable', 'corrupt', ['swe-boundary'], { env: { TRAJECTORY_DB_PATH: corrupt } });
  add('tmb_deny_db_unavailable', 'empty', [''], { env: { TRAJECTORY_DB_PATH: empty } });
  add('tmb_deny_db_unavailable', 'unresolved', [], { cwd: join(R, 'nodb') });
  add('tmb_deny_db_unavailable', 'escaped', ['a"b\\c'], { env: { TRAJECTORY_DB_PATH: join(R, 'odd"dir\ttab/x.db') } });
  add('tmb_deny_db_unavailable', 'del-escaped', ['g\x7fh'], { env: { TRAJECTORY_DB_PATH: exlock, ...fast } });

  const tasksSql = 'SELECT id, branch_id, repo FROM tasks ORDER BY id;';
  add('tmb_gate_read', 'warm', [warm, tasksSql]);
  add('tmb_gate_read', 'no-rows', [warm, 'SELECT 1 WHERE 0;']);
  add('tmb_gate_read', 'sql-error', [warm, 'SELECT nope FROM tasks;']);
  add('tmb_gate_read', 'missing', [missing, 'SELECT 1;']);
  add('tmb_gate_read', 'empty-path', ['', 'SELECT 1;']);
  add('tmb_gate_read', 'busy', [exlock, 'SELECT 1;'], { env: fast });
  add('tmb_gate_read', 'cold', [join(m, 'cold-gate.db'), tasksSql]);
  add('tmb_gate_read', 'corrupt', [corrupt, 'SELECT 1;']);
  add('tmb_gate_read', 'walock', [walock, 'SELECT event_type FROM audit;']);
  add('tmb_gate_read', 'bad-timeout', [warm, 'SELECT 7;'], { env: { TMB_DB_WRITE_TIMEOUT_MS: 'abc' } });
  add('tmb_gate_read', 'values', [warm, "SELECT 1.0, 2.5, 1e20, 1e-5, 0.1+0.2, -0.0, NULL, x'414200', 'a|b', 100000.0, 1e15;"]);
  add('tmb_gate_read', 'multi-statement', [warm, 'SELECT 1; SELECT 2;']);
  add('tmb_gate_read', 'partial-error', [warm, 'SELECT 1; SELECT nope;']);
  add('tmb_gate_read', 'double-quoted-literal', [warm, 'SELECT "dq";']);
  add('tmb_gate_read', 'foreign-keys-off', [warm, 'PRAGMA foreign_keys;']);
  add('tmb_sqlite_ro', 'warm', [warm, tasksSql]);
  add('tmb_sqlite_ro', 'timeout', [exlock, 'SELECT 1;']);
  add('tmb_sqlite_ro', 'sql-error', [warm, 'SELECT nope;']);
  add('tmb_sqlite_ro', 'missing', [missing, 'SELECT 1;']);

  const contracts = '.parameter set :n 5\n.parameter set :s abc\nSELECT :n, typeof(:n), :s, :unset;\nSELECT count(*) FROM tasks;';
  add('op_budget', 'warm', [warm, '1000', contracts]);
  add('op_budget', 'timeout', [exlock, '100', 'SELECT count(*) FROM tasks;']);
  add('op_budget', 'sql-error', [warm, '1000', 'SELECT 1;\nSELECT nope;\nSELECT 3;']);
  add('op_budget', 'missing', [missing, '1000', 'SELECT 1;']);
  add('op_budget', 'cold', [join(m, 'cold-budget.db'), '1000', 'SELECT count(*) FROM tasks;']);
  add('op_budget', 'bad-budget', [warm, 'x', 'SELECT 9;']);
  add('op_budget', 'meta-error', [warm, '1000', '.bogus\nSELECT 4;']);
  add('op_budget', 'param-single-quoted', [warm, '1000', ".parameter set :s 'a b'\nSELECT :s, typeof(:s);"]);
  add('op_budget', 'param-double-quoted', [warm, '1000', '.parameter set :s "a\\tb"\nSELECT :s;']);
  add('op_budget', 'param-sql-literal', [warm, '1000', `.parameter set :s "'x y'"\nSELECT :s, typeof(:s);`]);
  add('op_budget', 'killed-partial', [
    warm,
    '1000',
    'SELECT 1;\nWITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100000000) SELECT count(*) FROM c;',
  ]);

  add('_tmb_db_immutable_uri', 'absolute', ['/a/b%c?d#e.db']);
  add('_tmb_db_immutable_uri', 'relative', ['x/y.db'], { cwd: link });
  add('_tmb_db_read_ro', 'warm', [warm, 'SELECT count(*) FROM tasks;']);
  add('_tmb_db_read_ro', 'cold-immutable', [join(m, 'cold-ro.db'), 'SELECT count(*) FROM tasks;']);
  add('_tmb_db_read_ro', 'busy', [exlock, 'SELECT 1;'], { env: fast });
  add('_tmb_db_read_ro', 'missing', [missing, 'SELECT 1;']);
  add('op_probe', 'current', [warm]);
  add('op_probe', 'cold-current', [join(m, 'cold-probe.db')]);
  add('op_probe', 'stale', [stateDb(join(m, 'stale-only'))]);
  add('op_probe', 'missing', [missing]);
  add('op_probe', 'corrupt', [corrupt]);
  add('op_probe', 'busy', [exlock], { env: fast });
  add('op_probe', 'empty', [empty]);

  add('tmb_swe_context', 'swe', ['swe']);
  add('tmb_swe_context', 'prefixed', ['tmb:swe']);
  add('tmb_swe_context', 'empty', ['']);
  for (const [label, v] of [
    ['int', '12'],
    ['zero-padded', '007'],
    ['negative', '-1'],
    ['float', '1.5'],
    ['empty', ''],
    ['injection', '1;DROP'],
  ]) {
    add('tmb_sql_int', label, [v]);
  }
  for (const [label, v] of [
    ['quote', "it's"],
    ['doubled', "''"],
    ['empty', ''],
    ['inner-newline', "a\nb'c"],
    ['trailing-newline', "x'\n"],
    ['trailing-newlines', 'x\n\n'],
  ]) {
    add('tmb_sql_quote', label, [v]);
  }
  for (const [label, v] of [
    ['typed', 'feat/x'],
    ['bare', 'x'],
    ['nested', 'feat/a/b'],
    ['empty', ''],
    ['leading-slash', '/lead'],
  ]) {
    add('tmb_branch_slug', label, [v]);
  }
  for (const [label, v] of [
    ['plain', 'one'],
    ['underscore', 'a_b'],
    ['percent', '50%'],
    ['backslash', 'back\\slash'],
    ['quote', "it's"],
    ['empty', ''],
    ['trailing-newline', 'x_\n'],
  ]) {
    add('tmb_sql_like_escape', label, [v]);
  }
  const slugs = join(p, 'slugs.db');
  for (const [label, args] of [
    ['newest-of-three-id', [slugs, 'one']],
    ['newest-of-three-branch', [slugs, 'one', 'branch_id']],
    ['status-filter', [slugs, 'one', 'id', "'closed'"]],
    ['status-filter-none', [slugs, 'one', 'branch_id', "'failed', 'escalated'"]],
    ['underscore-literal', [slugs, 'under_score', 'branch_id']],
    ['percent-literal', [slugs, 'pct%x', 'branch_id']],
    ['quote', [slugs, "it's", 'branch_id']],
    ['bar-in-branch', [slugs, 'bar|ed', 'branch_id']],
    ['bar-in-branch-id', [slugs, 'bar|ed', 'id']],
    ['backslash', [slugs, 'back\\slash', 'branch_id']],
    ['no-match', [slugs, 'zzz', 'branch_id']],
    ['bad-column', [slugs, 'one', 'title']],
    ['bad-status-list', [slugs, 'one', 'id', '1); DROP TABLE tasks; --']],
    ['empty-slug', [slugs, '', 'branch_id']],
    ['empty-db', ['', 'one', 'branch_id']],
  ] as [string, string[]][]) {
    add('tmb_task_by_slug', label, args);
  }

  for (const v of ['tmb:swe', 'swe', 'tmb:code-reviewer', 'code-reviewer', '', 'a:b:c', ':x']) {
    add('tmb_normalize_role', v === '' ? 'empty' : v, [v]);
  }
  for (const [label, v] of [
    ['agent-type', '{"agent_type":"tmb:swe"}'],
    ['subagent-type', '{"subagent_type":"tmb:code-reviewer"}'],
    ['agent-first', '{"agent_type":"swe","subagent_type":"bro"}'],
    ['null-falls-through', '{"agent_type":null,"subagent_type":"swe"}'],
    ['empty-string', '{"agent_type":""}'],
    ['none', '{}'],
    ['invalid-json', '{not json'],
    ['string', '"swe"'],
    ['array', '[1]'],
    ['multi', '{"agent_type":"swe"}\n{"agent_type":"code-reviewer"}'],
    ['number', '{"agent_type":5}'],
    ['empty-input', ''],
  ]) {
    add('tmb_agent_role', label, [v]);
  }

  add('tmb_task_id_from_transcript', 'string-content', [join(tx, 'own.jsonl')]);
  add('tmb_task_id_from_transcript', 'block-content', [join(tx, 'main/subagents/agent-a1.jsonl')]);
  add('tmb_task_id_from_transcript', 'no-id', [join(tx, 'none.jsonl')]);
  add('tmb_task_id_from_transcript', 'mixed-values', [join(tx, 'mixed.jsonl')]);
  add('tmb_task_id_from_transcript', 'parse-error', [join(tx, 'broken.jsonl')]);
  add('tmb_task_id_from_transcript', 'object-content', [join(tx, 'late.jsonl')]);
  add('tmb_task_id_from_transcript', 'missing', [join(tx, 'nope.jsonl')]);
  add('tmb_task_id_from_transcript', 'empty', ['']);

  add('tmb_agent_transcript', 'own', [swe({ agent_transcript_path: join(tx, 'own.jsonl') })]);
  add('tmb_agent_transcript', 'derived', [swe({ transcript_path: join(tx, 'main.jsonl'), agent_id: 'a1' })]);
  add('tmb_agent_transcript', 'own-missing-derived', [
    swe({ agent_transcript_path: join(tx, 'nope.jsonl'), transcript_path: join(tx, 'main.jsonl'), agent_id: 'a1' }),
  ]);
  add('tmb_agent_transcript', 'bad-id', [swe({ transcript_path: join(tx, 'main.jsonl'), agent_id: '../a1' })]);
  add('tmb_agent_transcript', 'no-agent-id', [swe({ transcript_path: join(tx, 'main.jsonl') })]);
  add('tmb_agent_transcript', 'derived-missing', [swe({ transcript_path: join(tx, 'main.jsonl'), agent_id: 'zz' })]);
  add('tmb_agent_transcript', 'invalid-json', ['{oops']);

  add('tmb_caller_run', 'bro', [JSON.stringify({ agent_id: 'agent-bound' }), warm]);
  add('tmb_caller_run', 'no-agent-id', [swe({}), warm]);
  add('tmb_caller_run', 'bound-newest', [swe({ agent_id: 'agent-bound' }), warm]);
  add('tmb_caller_run', 'null-task', [swe({ agent_id: 'agent-null' }), warm]);
  add('tmb_caller_run', 'no-row', [swe({ agent_id: 'agent-none' }), warm]);
  add('tmb_caller_run', 'quoted-id', [swe({ agent_id: "a'b" }), warm]);
  add('tmb_caller_run', 'trailing-newline-id', [swe({ agent_id: 'agent-bound\n' }), warm]);
  add('tmb_caller_run', 'reviewer-row', [swe({ agent_id: 'agent-rev' }), warm]);
  add('tmb_caller_run', 'busy', [swe({ agent_id: 'agent-bound' }), exlock], { env: fast });

  for (const [label, id] of [
    ['resolved', '69'],
    ['no-branch', '70'],
    ['ghost-repo', '71'],
    ['no-repo', '72'],
    ['nested-slug', '73'],
    ['trailing-slash', '74'],
    ['no-row', '999'],
    ['not-int', 'abc'],
  ]) {
    add('op_loc', label, [warm, id]);
  }
  add('op_loc', 'busy', [exlock, '69'], { env: fast });
  add('op_loc', 'solo-relative', [stateDb(join(m, 'solo')), '5']);

  add('op_ctx', 'main', ['{}'], { env: { TRAJECTORY_DB_PATH: warm } });
  add('op_ctx', 'main-no-db', ['{"session_id":"s"}'], { env: { CLAUDE_PROJECT_DIR: join(R, 'nodb') } });
  add('op_ctx', 'reviewer', ['{"agent_type":"tmb:code-reviewer"}'], { env: { CLAUDE_PROJECT_DIR: link } });
  add('op_ctx', 'swe-own-transcript', [swe({ agent_transcript_path: join(tx, 'own.jsonl') })], { env: { TRAJECTORY_DB_PATH: warm } });
  add('op_ctx', 'swe-worktree', [swe({ transcript_path: join(tx, 'main.jsonl'), agent_id: 'a1' })], { env: { TRAJECTORY_DB_PATH: warm } });
  add('op_ctx', 'swe-subagent-type', [JSON.stringify({ subagent_type: 'swe', agent_transcript_path: join(tx, 'own.jsonl') })], {
    env: { TRAJECTORY_DB_PATH: warm },
  });
  add('op_ctx', 'swe-db-arg', [swe({ agent_transcript_path: join(tx, 'own.jsonl') }), stateDb(join(m, 'solo'))]);
  add('op_ctx', 'swe-bound-run', [swe({ agent_id: 'agent-bound' })], { env: { CLAUDE_PROJECT_DIR: link } });
  add('op_ctx', 'swe-unknown-transcript', [swe({ agent_transcript_path: join(tx, 'nope.jsonl') })], { env: { TRAJECTORY_DB_PATH: warm } });
  add('op_ctx', 'swe-transcript-no-id', [swe({ agent_transcript_path: join(tx, 'none.jsonl'), agent_id: 'agent-none' })], {
    env: { TRAJECTORY_DB_PATH: warm },
  });
  add('op_ctx', 'swe-null-run', [swe({ agent_id: 'agent-null' })], { env: { TRAJECTORY_DB_PATH: warm } });
  add('op_ctx', 'swe-run-busy', [swe({ agent_id: 'agent-bound' })], { env: { TRAJECTORY_DB_PATH: exlock, ...fast } });
  add('op_ctx', 'swe-no-db', [swe({ agent_id: 'agent-bound' })], { cwd: join(R, 'nodb') });
  add('op_ctx', 'swe-missing-piece', [swe({ agent_transcript_path: join(tx, 'mixed.jsonl') })], { env: { TRAJECTORY_DB_PATH: warm } });

  const wt = join(R, 'repo-plugin/.claude/worktrees/ts-hook-libs');
  add('op_in_wt', 'inside', [join(wt, 'src/a.ts'), wt]);
  add('op_in_wt', 'equal', [wt, wt]);
  add('op_in_wt', 'outside', [join(R, 'repo-plugin/src/a.ts'), wt]);
  add('op_in_wt', 'sibling-prefix', [`${wt}-other/a.ts`, wt]);
  add('op_in_wt', 'via-symlink', [join(R, 'wt-link/src/new.ts'), wt]);
  add('op_in_wt', 'dotdot-escape', [join(wt, 'src/../../x.ts'), wt]);
  add('op_in_wt', 'no-worktree', [join(wt, 'src'), '']);
  add('op_in_wt', 'relative', ['src/a.ts', wt]);
  add('op_in_wt', 'trailing-slash', [join(wt, 'src'), `${wt}/`]);
  add('tmb_path_canonical', 'symlink-missing-tail', [join(R, 'wt-link/src/new/deep.ts')]);
  add('tmb_path_canonical', 'relative', ['a/b']);
  add('tmb_path_canonical', 'root', ['/']);
  add('tmb_path_canonical', 'dotdot-past-root', ['/../..']);
  add('tmb_path_canonical', 'dots', [`${R}/./nodb/../tx//own.jsonl`]);

  const events = join(LIB, 'audit-events.txt');
  add('tmb_audit_writer_check', 'hook-listed', ['lbl', 'containment_denied', 'hook']);
  add('tmb_audit_writer_check', 'server-listed', ['lbl', 'agent_runs_claimed', 'server']);
  add('tmb_audit_writer_check', 'not-writable', ['lbl', 'branch_gate_waived', 'hook']);
  add('tmb_audit_writer_check', 'unknown', ['lbl', 'no_such_event', 'hook']);
  add('tmb_audit_writer_check', 'empty-event', ['lbl', '', 'hook']);
  add('tmb_audit_writer_check', 'list-missing', ['lbl', 'containment_denied', 'hook'], {
    env: { HARNESS_EVENTS_FILE: join(R, 'nope/audit-events.txt') },
  });
  add('tmb_audit_writer_check', 'explicit-list', ['lbl', 'hook_block_bypassed', 'hook'], { env: { HARNESS_EVENTS_FILE: events } });

  const content = '{"task_id":7,"commit_sha":"abc"}';
  add('tmb_audit_dedupe_guard', 'one-path', ['hook_block_bypassed', content, '$.task_id']);
  add('tmb_audit_dedupe_guard', 'two-paths', ['hook_block_bypassed', content, '$.task_id', '$.commit_sha']);
  add('tmb_audit_dedupe_guard', 'no-path', ['hook_block_bypassed', content]);
  add('tmb_audit_dedupe_guard', 'invalid-path', ['hook_block_bypassed', content, '$.a[0]']);
  add('tmb_audit_dedupe_guard', 'empty-content', ["it's", '', '$.x']);
  add('tmb_audit_dedupe_guard', 'trailing-newline-content', ['hook_block_bypassed', `${content}\n`, '$.task_id']);

  add('tmb_audit_sql', 'hook', ['1', 'feat/x', 'hook:containment-guard', 'containment_denied', "it's", content]);
  add('tmb_audit_sql', 'system', ['-1', '', 'system', 'agent_runs_claimed', 's', '']);
  add('tmb_audit_sql', 'guarded', ['1', '', 'hook:h', 'containment_denied', 's', '{}', '(SELECT changes()) > 0']);
  add('tmb_audit_sql', 'agent-role', ['1', '', 'bro', 'containment_denied', 's', '{}']);
  add('tmb_audit_sql', 'bare-hook', ['1', '', 'hook:', 'containment_denied', 's', '{}']);
  add('tmb_audit_sql', 'hook-underscore', ['1', '', 'hook:a_b', 'containment_denied', 's', '{}']);
  add('tmb_audit_sql', 'hook-upper', ['1', '', 'hook:Bad', 'containment_denied', 's', '{}']);
  add('tmb_audit_sql', 'unlisted', ['1', '', 'hook:h', 'no_such_event', 's', '{}']);
  add('tmb_audit_sql', 'not-writable', ['1', '', 'hook:h', 'branch_gate_waived', 's', '{}']);
  add('tmb_audit_sql', 'system-hook-event', ['1', '', 'system', 'containment_denied', 's', '{}']);
  add('tmb_audit_sql', 'bad-issue', ['x1', '', 'hook:h', 'containment_denied', 's', '{}']);
  add('tmb_audit_sql', 'empty-issue', ['', '', 'hook:h', 'containment_denied', 's', '{}']);
  add('tmb_audit_sql', 'trailing-newlines', ['1', '', 'hook:h', 'containment_denied', "s'\n\n", `${content}\n`]);

  add('tmb_db_write', 'insert', [audit, `INSERT INTO audit (issue_id, from_node, event_type, summary, created_at) VALUES (1, 'hook:w', 'raw_write', 'r', '${NOW}');`]);
  add('tmb_db_write', 'stdout', [audit, 'SELECT 40 + 2;\nSELECT count(*) FROM issues;']);
  add('tmb_db_write', 'fk-failure', [audit, `INSERT INTO audit (issue_id, event_type, summary, created_at) VALUES (999, 'x', 'y', '${NOW}');`]);
  add('tmb_db_write', 'syntax-error', [audit, 'INSRT INTO audit;']);
  add('tmb_db_write', 'rolled-back', [audit, `INSERT INTO audit (issue_id, event_type, summary, created_at) VALUES (1, 'rolled_back', 'y', '${NOW}');\nSELECT nope;`]);
  add('tmb_db_write', 'missing', [missing, 'SELECT 1;']);
  add('tmb_db_write', 'empty-path', ['', 'SELECT 1;']);
  add('tmb_db_write', 'trailing-newlines', [audit, 'SELECT 5;\n\n']);

  add('tmb_audit_append', 'listed', [audit, '1', 'feat/ts-hook-libs', 'hook:containment-guard', 'containment_denied', 'denied', '{"path":"/x"}']);
  add('tmb_audit_append', 'system-sentinel-issue', [audit, '-1', '', 'system', 'agent_runs_claimed', 'claimed', '']);
  add('tmb_audit_append', 'unlisted', [audit, '1', '', 'hook:h', 'no_such_event', 'nope', '{}']);
  add('tmb_audit_append', 'dedupe-hit', [audit, '1', '', 'hook:h', 'hook_block_bypassed', 'dup', content, '$.task_id', '$.commit_sha']);
  add('tmb_audit_append', 'dedupe-miss', [audit, '1', '', 'hook:h', 'hook_block_bypassed', 'new', '{"task_id":8,"commit_sha":"abc"}', '$.task_id']);
  add('tmb_audit_append', 'dedupe-bad-path', [audit, '1', '', 'hook:h', 'hook_block_bypassed', 'x', content, 'task_id']);
  add('tmb_audit_append', 'dedupe-empty-path', [audit, '1', '', 'hook:h', 'hook_block_bypassed', 'x', content, '']);
  add('tmb_audit_append', 'bad-from-node', [audit, '1', '', 'swe', 'containment_denied', 'x', '{}']);
  add('tmb_audit_append', 'missing-db', [missing, '1', '', 'hook:h', 'containment_denied', 'x', '{}']);
  add('tmb_audit_append', 'fk-issue', [audit, '42', '', 'hook:h', 'containment_denied', 'x', '{}']);
  const budget = { TMB_DB_WRITE_TIMEOUT_MS: '100', TMB_DB_WRITE_RUN_BUDGET_MS: '100' };
  add('tmb_audit_append', 'budget-locked', [walock, '1', '', 'hook:h', 'containment_denied', 'x', '{}'], { env: budget });
  add('tmb_audit_append', 'budget-spent', [walock, '1', '', 'hook:h', 'containment_denied', 'y', '{}'], { env: budget, keep: true });
  return cases;
}

function writeCaseFile(cases: Case[], file: string): void {
  const parts: string[] = [];
  for (const c of cases) {
    const env = Object.entries(c.env ?? {});
    parts.push(c.id, c.cwd ?? R, c.keep ? '1' : '0', String(env.length));
    for (const [k, v] of env) parts.push(k, v);
    parts.push(c.fn, String(c.args.length), ...c.args);
  }
  writeFileSync(file, parts.map((p) => `${p}\0`).join(''));
}

function runShell(cases: Case[]): Outcome[] {
  const dir = join(R, 'sh');
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(join(dir, 'harness.sh'), HARNESS);
  writeCaseFile(cases, join(dir, 'cases.bin'));
  const r = spawnSync('/bin/bash', [join(dir, 'harness.sh'), LIB, join(dir, 'cases.bin'), join(dir, 'out')], {
    env: { PATH: process.env.PATH, HOME: R, TMPDIR: process.env.TMPDIR ?? tmpdir(), HARNESS_NOW: NOW, LANG: process.env.LANG ?? '' },
    encoding: 'utf8',
    cwd: R,
  });
  assert.equal(r.status, 0, `harness failed: ${r.stderr}`);
  return cases.map((_, i) => ({
    out: stripTrailingNewlines(readFileSync(join(dir, 'out', `${i}.out`), 'utf8')),
    rc: Number(readFileSync(join(dir, 'out', `${i}.rc`), 'utf8').trim()),
    err: stripTrailingNewlines(readFileSync(join(dir, 'out', `${i}.err`), 'utf8')),
  }));
}

function runTs(cases: Case[], backend: 'node' | 'cli'): Outcome[] {
  const home = process.cwd();
  const results: Outcome[] = [];
  let env: NodeJS.ProcessEnv = {};
  try {
    for (const c of cases) {
      const cwd = c.cwd ?? R;
      if (!c.keep) env = {};
      for (const k of Object.keys(env)) delete env[k];
      Object.assign(env, { PATH: process.env.PATH, HOME: R, PWD: cwd }, c.env ?? {});
      if (backend === 'cli') env.TMB_HOOKS_SQLITE = 'cli';
      process.chdir(cwd);
      const adapter = ADAPTERS[c.fn];
      assert.ok(adapter, `no TS adapter for ${c.fn}`);
      results.push(adapter(c.args, env));
    }
  } finally {
    process.chdir(home);
  }
  return results;
}

function auditRows(): string[] {
  const db = new DatabaseSync(join(M(), 'audit.db'), { readOnly: true });
  try {
    return db
      .prepare('SELECT issue_id, branch_id, from_node, event_type, summary, content_json, repo FROM audit ORDER BY id')
      .all()
      .map((r) => JSON.stringify(r));
  } finally {
    db.close();
  }
}

function coldDbs(): string[] {
  return COLD.filter((n) => walCold(join(M(), `cold-${n}.db`)));
}

function loadDivergences(): Map<string, Divergence> {
  const map = new Map<string, Divergence>();
  for (const line of readFileSync(DIVERGENCES, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const d = JSON.parse(line) as Divergence;
    assert.ok(d.fn && d.case && typeof d.sh === 'string' && typeof d.ts === 'string' && d.reason, `malformed divergence: ${line}`);
    map.set(d.case, d);
  }
  return map;
}

export function hookLibsDiffShard(k: number, n: number): void {
  describe(`hook libs: TS ports vs the shell libs (shard ${k} of ${n})`, () => {
    let cases: Case[] = [];
    let sh: Outcome[] = [];
    let shRows: string[] = [];
    let shCold: string[] = [];
    const passes: { backend: 'node' | 'cli'; out: Outcome[]; rows: string[]; cold: string[] }[] = [];
    const backends: ('node' | 'cli')[] = loadNodeSqlite() ? ['node', 'cli'] : ['cli'];

    before(async () => {
      buildSandbox();
      await startHolder();
      cases = buildCases();
      restoreMut();
      sh = runShell(cases);
      shRows = auditRows();
      shCold = coldDbs();
      for (const backend of shardOf(backends, k, n)) {
        restoreMut();
        const out = runTs(cases, backend);
        passes.push({ backend, out, rows: auditRows(), cold: coldDbs() });
      }
    });

    after(async () => {
      await stopHolder();
      if (R) rmSync(R, { recursive: true, force: true });
    });

    if (k === 1) {
      it('runs the TS ports through node:sqlite and through the sqlite3 CLI', (t) => {
        assert.equal(sqliteBackend({ TMB_HOOKS_SQLITE: 'cli' }), 'cli');
        const counts = new Map<string, number>();
        for (const c of cases) counts.set(c.fn, (counts.get(c.fn) ?? 0) + 1);
        t.diagnostic(`cases: ${cases.length}; ${[...counts].map(([fn, n]) => `${fn}=${n}`).join(' ')}`);
        t.diagnostic(`backends: ${backends.join(', ')}`);
        if (loadNodeSqlite()) assert.equal(sqliteBackend({}), 'node');
        assert.ok(backends.includes('cli'));
      });

      it('every case id is unique and every recorded divergence matches a case', () => {
        const ids = new Set<string>();
        for (const c of cases) {
          assert.ok(!ids.has(c.id), `duplicate case id ${c.id}`);
          ids.add(c.id);
        }
        for (const id of loadDivergences().keys()) assert.ok(ids.has(id), `divergence ${id} matches no case`);
      });
    }

    it('every case matches the .sh, or diverges exactly as recorded', () => {
      const divergences = loadDivergences();
      const mismatches: string[] = [];
      const check = (actual: unknown, expected: unknown, label: string) => {
        if (actual !== expected) mismatches.push(`${label}: ts=${JSON.stringify(actual)} sh=${JSON.stringify(expected)}`);
      };
      for (const pass of passes) {
        cases.forEach((c, i) => {
          const s = sh[i];
          const ts = pass.out[i];
          const where = `${pass.backend} ${c.id}`;
          const d = divergences.get(c.id);
          if (d) {
            assert.equal(d.fn, c.fn, `${where}: divergence fn`);
            assert.equal(s.out, d.sh, `${where}: .sh output no longer as recorded`);
            assert.equal(ts.out, d.ts, `${where}: TS output no longer as recorded`);
            assert.notEqual(d.sh, d.ts, `${where}: recorded divergence does not diverge`);
            return;
          }
          check(ts.out, s.out, `${where}: output`);
          check(ts.rc, s.rc, `${where}: exit code`);
          if (STDERR_FNS.has(c.fn)) check(ts.err ?? '', s.err ?? '', `${where}: stderr`);
        });
      }
      assert.deepEqual(mismatches, []);
    });

    it('auditAppend writes the rows the .sh writes', () => {
      for (const pass of passes) assert.deepEqual(pass.rows, shRows, `${pass.backend}: audit rows`);
    });

    it('leaves a cold WAL DB cold wherever the .sh does', () => {
      for (const pass of passes) {
        if (pass.backend === 'cli') assert.deepEqual(pass.cold, shCold, 'cli: cold WAL DBs');
        else for (const n of shCold) assert.ok(pass.cold.includes(n), `${pass.backend}: cold-${n}.db warmed`);
      }
    });

    if (k !== 1) return;

    it('covers every dbState value, the run budget and the dedupe hit', () => {
      const byId = (id: string) => sh[cases.findIndex((c) => c.id === id)];
      assert.equal(byId('tmb_db_state:unresolved').out, 'unresolved');
      assert.equal(byId('tmb_db_state:ok-warm').out, 'ok');
      assert.equal(byId('tmb_db_state:ok-cold').out, 'ok');
      assert.equal(byId('tmb_db_state:error-exlock').out, 'error');
      assert.equal(byId('tmb_db_state:error-corrupt').out, 'error');
      assert.equal(byId('tmb_gate_read:busy').out, '__ERR__');
      assert.equal(byId('op_budget:timeout').rc, 124);
      assert.equal(byId('tmb_sqlite_ro:timeout').out, '');
      assert.equal(
        byId('tmb_audit_append:budget-locked').err,
        'tmb_db_write: harness: run budget spent (TMB_DB_WRITE_RUN_BUDGET_MS=100); last error: Runtime error near line 2: database is locked (5)',
      );
      assert.equal(byId('tmb_audit_append:budget-locked').rc, 5);
      assert.equal(byId('tmb_audit_append:budget-spent').err, 'tmb_db_write: harness: run budget spent (TMB_DB_WRITE_RUN_BUDGET_MS=100)');
      assert.match(byId('tmb_audit_append:unlisted').err ?? '', /unknown event_type 'no_such_event'/);
      assert.equal(byId('tmb_audit_append:unlisted').rc, 2);
    });

    it('the .sh writes no audit row for an unlisted event or a dedupe hit', () => {
      const parsed = shRows.map((r) => JSON.parse(r) as Record<string, unknown>);
      assert.equal(parsed.filter((r) => r.event_type === 'no_such_event').length, 0);
      assert.equal(parsed.filter((r) => r.event_type === 'rolled_back').length, 0);
      assert.equal(parsed.filter((r) => r.event_type === 'hook_block_bypassed').length, 2);
      assert.equal(parsed.filter((r) => r.event_type === 'containment_denied').length, 1);
      assert.equal(parsed.filter((r) => r.event_type === 'agent_runs_claimed' && r.issue_id === -1 && r.repo === null).length, 1);
    });

    it('nowIso keeps the second and zeroes the milliseconds', () => {
      assert.equal(nowIso(new Date('2026-01-02T03:04:05.678Z')), NOW);
    });

    it('a flagless node child imports dist/hooks/lib/db.js and reads the DB with an empty stderr', () => {
      const script = join(R, 'child.mjs');
      writeFileSync(
        script,
        `import { dbState } from ${JSON.stringify(DIST_DB)};\n` +
          `process.stdout.write(dbState({ TRAJECTORY_DB_PATH: process.argv[2], PATH: process.env.PATH, HOME: process.env.HOME }));\n`,
      );
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(process.execPath, [script, stateDb(join(P(), 'warm'))], { env, encoding: 'utf8', cwd: R });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'ok');
      assert.equal(r.stderr, '');
    });
  });
}
