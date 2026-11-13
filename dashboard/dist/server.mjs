// server/main.ts
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync as existsSync3, readFileSync as readFileSync6, statSync } from "node:fs";
import { extname, join as join11, normalize, sep as sep4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { DatabaseSync as DatabaseSync4 } from "node:sqlite";
import { Worker } from "node:worker_threads";

// ../mcp/trajectory-server/src/change-impact/providers.ts
var CHANGE_SOURCES = ["plugin_version", "agent_surface", "tmb_events"];

// ../mcp/trajectory-server/src/embeddings/model.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { pathToFileURL } from "node:url";

// ../mcp/trajectory-server/src/runtime-deps.ts
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
var TRANSFORMERS_VERSION = "3.8.1";
var TRANSFORMERS_PACKAGE = "@huggingface/transformers";
function runtimeDepsKey(platform = process.platform, arch = process.arch, version = TRANSFORMERS_VERSION) {
  return `${version}-${platform}-${arch}`;
}
function runtimeDepsRoot(dataDir = process.env.CLAUDE_PLUGIN_DATA, key = runtimeDepsKey()) {
  return dataDir ? join(dataDir, "deps", key) : void 0;
}
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function readPackageJson(pkgDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    return isObject(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function rootExport(exportsField) {
  if (!isObject(exportsField)) return exportsField;
  const subpaths = Object.keys(exportsField).some((k) => k.startsWith("."));
  return subpaths ? exportsField["."] : exportsField;
}
function nodeImportDefault(entry) {
  if (!isObject(entry)) return void 0;
  const node = entry["node"];
  if (!isObject(node)) return void 0;
  const imp = node["import"];
  if (typeof imp === "string") return imp;
  if (!isObject(imp)) return void 0;
  const target = imp["default"];
  return typeof target === "string" ? target : void 0;
}
function transformersPackageDir(root) {
  return join(root, "node_modules", TRANSFORMERS_PACKAGE);
}
function transformersEsmEntry(root) {
  const pkgDir = transformersPackageDir(root);
  const target = nodeImportDefault(rootExport(readPackageJson(pkgDir)?.["exports"]));
  if (!target) return void 0;
  const entry = resolve(pkgDir, target);
  return existsSync(entry) ? entry : void 0;
}

// ../mcp/trajectory-server/src/embeddings/model.ts
var TMB_MODEL_CACHE_DIR = process.env["TMB_MODEL_CACHE_DIR"] ?? process.env["HF_HOME"] ?? join2(homedir(), ".cache", "huggingface");
var MODEL_REPO = "Xenova/bge-small-en-v1.5";
var MODEL_DTYPE = "q8";
var MODEL_ID = `${MODEL_REPO}@${MODEL_DTYPE}`;
var EMBED_RETRY_SCHEDULE_MS = [6e4, 3e5, 6e5];
var EMBED_FAIL_THRESHOLD_DEFAULT = 5;
function transformersSources(dataDir = process.env["CLAUDE_PLUGIN_DATA"]) {
  const root = runtimeDepsRoot(dataDir);
  if (!root) return { specifiers: [TRANSFORMERS_PACKAGE], misses: ["CLAUDE_PLUGIN_DATA is unset"] };
  const entry = transformersEsmEntry(root);
  if (!entry) return { specifiers: [TRANSFORMERS_PACKAGE], misses: [`no ${TRANSFORMERS_PACKAGE} at ${transformersPackageDir(root)}`] };
  return { specifiers: [pathToFileURL(entry).href, TRANSFORMERS_PACKAGE], misses: [] };
}
async function importTransformers(sources = transformersSources(), importer = (s) => import(s)) {
  const failures = [...sources.misses];
  for (const specifier of sources.specifiers) {
    try {
      return await importer(specifier);
    } catch (e) {
      failures.push(`${specifier}: ${message(e)}`);
    }
  }
  throw new Error(`${TRANSFORMERS_PACKAGE} did not load (${failures.join("; ")})`);
}
async function defaultLoader() {
  const { pipeline, env } = await importTransformers();
  env.cacheDir = TMB_MODEL_CACHE_DIR;
  return await pipeline("feature-extraction", MODEL_REPO, { dtype: MODEL_DTYPE });
}
var now = Date.now;
var loader = defaultLoader;
var pipePromise = null;
var loadingSince = null;
var readySince = null;
var consecutiveFailures = 0;
var degraded = null;
var retrying = false;
var listeners = /* @__PURE__ */ new Set();
function embedRetryDelayMs(retries, env = process.env) {
  const raw = env["TMB_EMBED_RETRY_MS"];
  const override = raw === void 0 || raw === "" ? NaN : Number(raw);
  if (Number.isFinite(override) && override >= 0) return override;
  return EMBED_RETRY_SCHEDULE_MS[Math.min(retries, EMBED_RETRY_SCHEDULE_MS.length - 1)];
}
function embedFailThreshold(env = process.env) {
  const raw = Number(env["TMB_EMBED_FAIL_THRESHOLD"]);
  return Number.isInteger(raw) && raw > 0 ? raw : EMBED_FAIL_THRESHOLD_DEFAULT;
}
function emit(t) {
  for (const l of listeners) {
    try {
      l(t);
    } catch (e) {
      console.error("[embeddings] transition listener failed:", e);
    }
  }
}
function message(e) {
  return e instanceof Error ? e.message : String(e);
}
function loadPipe() {
  if (!pipePromise) {
    loadingSince = new Date(now()).toISOString();
    readySince = null;
    const p = loader();
    pipePromise = p;
    p.then(
      () => {
        if (pipePromise !== p) return;
        readySince = new Date(now()).toISOString();
        if (!degraded) emit({ kind: "ready" });
      },
      () => {
        if (pipePromise === p) pipePromise = null;
      }
    );
  }
  return pipePromise;
}
function enterDegraded(reason) {
  if (degraded) return;
  degraded = { since: new Date(now()).toISOString(), reason, retries: 0, nextRetryAt: now() + embedRetryDelayMs(0) };
  emit({ kind: "degraded", reason, consecutive_failures: consecutiveFailures });
}
async function retry(text2) {
  const d = degraded;
  retrying = true;
  pipePromise = null;
  try {
    const pipe = await loadPipe();
    const result = await pipe(text2, { pooling: "mean", normalize: true });
    consecutiveFailures = 0;
    degraded = null;
    emit({ kind: "recovered", degraded_since: d.since, reason: d.reason, retries: d.retries + 1 });
    return new Float32Array(result.data);
  } catch (e) {
    console.error("[embeddings] re-attempt failed:", e);
    consecutiveFailures++;
    d.retries++;
    d.reason = `re-attempt failed: ${message(e)}`;
    d.nextRetryAt = now() + embedRetryDelayMs(d.retries);
    return null;
  } finally {
    retrying = false;
  }
}
async function embed(text2) {
  if (degraded) {
    if (retrying || now() < degraded.nextRetryAt) return null;
    return retry(text2);
  }
  let pipe;
  try {
    pipe = await loadPipe();
  } catch (e) {
    if (degraded) return null;
    console.error("[embeddings] model load failed:", e);
    consecutiveFailures++;
    enterDegraded(`model load failed: ${message(e)}`);
    return null;
  }
  try {
    const result = await pipe(text2, { pooling: "mean", normalize: true });
    consecutiveFailures = 0;
    return new Float32Array(result.data);
  } catch (e) {
    console.error("[embeddings] embed failed:", e);
    if (degraded) return null;
    consecutiveFailures++;
    if (consecutiveFailures >= embedFailThreshold()) {
      enterDegraded(`${consecutiveFailures} consecutive embed failures: ${message(e)}`);
    }
    return null;
  }
}
function setEmbeddingLoader(next) {
  loader = next;
}

// ../mcp/trajectory-server/src/platform.ts
import {
  existsSync as existsSync2,
  readdirSync,
  readFileSync as readFileSync2,
  realpathSync
} from "node:fs";
import { homedir as homedir2, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  basename,
  dirname,
  isAbsolute,
  join as join3,
  relative,
  sep
} from "node:path";
function readClaudePluginMetadata(env = process.env) {
  const root = env["CLAUDE_PLUGIN_ROOT"] ?? null;
  if (!root) {
    return freezePlugin({ root: null, name: "tmb", version: null });
  }
  try {
    const manifest = JSON.parse(
      readFileSync2(join3(root, ".claude-plugin", "plugin.json"), "utf8")
    );
    const name = typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : "tmb";
    const version = typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : null;
    return freezePlugin({ root, name, version });
  } catch {
    return freezePlugin({ root, name: "tmb", version: null });
  }
}
function resolveClaudePluginName(env = process.env) {
  return readClaudePluginMetadata(env).name;
}
function resolveClaudePluginVersion(env = process.env) {
  return readClaudePluginMetadata(env).version;
}
function resolveClaudeProjectRoot(env = process.env) {
  const root = env["CLAUDE_PROJECT_DIR"];
  return root && root.trim().length > 0 ? root : null;
}
function resolveClaudeDbPath(opts) {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir2();
  const pluginName = resolveClaudePluginName(env);
  return resolveClaudeDbPathForPlugin(pluginName, { env, cwd, home });
}
function resolveClaudeDbPathForPlugin(pluginName, opts) {
  const { env, cwd, home } = opts;
  const override = env["TRAJECTORY_DB_PATH"];
  if (override && override.trim().length > 0) return override;
  const projectRoot = resolveClaudeProjectRoot(env);
  const found = findExistingClaudeDbUp(cwd, pluginName, { home, env, projectRoot });
  if (found) return found;
  return claudeDbLocation(projectRoot ?? cwd, pluginName);
}
var CLAUDE_STATE_HOST_DIR = ".claude";
function claudeDbLocation(root, pluginName) {
  return join3(root, CLAUDE_STATE_HOST_DIR, pluginName, "trajectory.db");
}
function claudeLogDirFor(trajectoryDb, pluginName) {
  if (trajectoryDb === ":memory:") return join3(tmpdir(), `${pluginName}-memory-logs`);
  return join3(dirname(trajectoryDb), "logs");
}
function resolveClaudeLogDir(opts) {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir2();
  const pluginName = resolveClaudePluginName(env);
  return claudeLogDirFor(resolveClaudeDbPathForPlugin(pluginName, { env, cwd, home }), pluginName);
}
function probeClaudeDb(path) {
  let db = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const cols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all();
    return cols.some((c) => c.name === "prompt_bearing") ? "current" : "stale";
  } catch {
    return "error";
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
var CLAUDE_STANDALONE_MARKER = "standalone";
function isStandaloneClaudeDb(dbPath) {
  return existsSync2(join3(dirname(dbPath), CLAUDE_STANDALONE_MARKER));
}
function walkClaudeDbs(start, pluginName, opts) {
  const home = opts?.home ?? homedir2();
  const probe = opts?.probe ?? probeClaudeDb;
  const found = [];
  for (let dir = start; dirname(dir) !== dir; dir = dirname(dir)) {
    if (dir === home && start !== home) break;
    const candidate = claudeDbLocation(dir, pluginName);
    if (!existsSync2(candidate) || probe(candidate) === "stale") continue;
    found.push(candidate);
    if (isStandaloneClaudeDb(candidate)) break;
  }
  return { resolved: found.length === 0 ? null : found[found.length - 1], candidates: found };
}
function claudeProjectRootOfDb(dbPath) {
  if (!dbPath || dbPath === ":memory:") return null;
  const hostDir = dirname(dirname(dbPath));
  return basename(hostDir) === CLAUDE_STATE_HOST_DIR ? dirname(hostDir) : null;
}
function canonicalExisting(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
function isPathWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
var STRAY_DB_MAX_DEPTH = 4;
function countRows(conn, table) {
  try {
    const row2 = conn.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id > 0`).get();
    return row2 === void 0 ? null : Number(row2.n);
  } catch {
    return null;
  }
}
function claudeDbCounts(path) {
  let conn = null;
  try {
    conn = new DatabaseSync(path, { readOnly: true });
    return { issues: countRows(conn, "issues"), tasks: countRows(conn, "tasks") };
  } catch {
    return { issues: null, tasks: null };
  } finally {
    try {
      conn?.close();
    } catch {
    }
  }
}
function claudeDbsBelow(root, pluginName, maxDepth, probe) {
  const found = [];
  let level = [root];
  for (let depth = 1; depth <= maxDepth && level.length > 0; depth += 1) {
    const next = [];
    for (const dir of level) {
      let entries2;
      try {
        entries2 = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries2) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const child = join3(dir, entry.name);
        const candidate = claudeDbLocation(child, pluginName);
        if (existsSync2(candidate) && isStandaloneClaudeDb(candidate)) continue;
        next.push(child);
        if (existsSync2(candidate) && probe(candidate) !== "stale") found.push(candidate);
      }
    }
    level = next;
  }
  return found;
}
function otherClaudeDbs(dbPath, opts) {
  const root = claudeProjectRootOfDb(dbPath);
  if (root === null) return null;
  const pluginName = basename(dirname(dbPath));
  const probe = opts.probe ?? probeClaudeDb;
  const seen = /* @__PURE__ */ new Set([canonicalExisting(dbPath)]);
  const paths = [];
  const add = (path) => {
    const key = canonicalExisting(path);
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(path);
  };
  if (isPathWithin(canonicalExisting(root), canonicalExisting(opts.sessionDir))) {
    walkClaudeDbs(opts.sessionDir, pluginName, { home: opts.home, probe }).candidates.forEach(add);
  }
  claudeDbsBelow(root, pluginName, STRAY_DB_MAX_DEPTH, probe).forEach(add);
  return paths.map((path) => {
    const { issues: issues2, tasks: tasks2 } = claudeDbCounts(path);
    return { path, issues: issues2, tasks: tasks2, empty: issues2 === 0 && tasks2 === 0 };
  });
}
function findExistingClaudeDbUp(startDir, pluginName, opts) {
  const env = opts?.env ?? process.env;
  const override = env["TRAJECTORY_DB_PATH"];
  if (override && override.trim().length > 0) {
    return existsSync2(override) ? override : null;
  }
  const projectRoot = opts?.projectRoot !== void 0 ? opts.projectRoot : resolveClaudeProjectRoot(env);
  return walkClaudeDbs(projectRoot ?? startDir, pluginName, opts).resolved;
}
function freezePlugin(plugin) {
  return Object.freeze(plugin);
}

// ../mcp/trajectory-server/src/db.ts
import { readFileSync as readFileSync3, readdirSync as readdirSync2 } from "node:fs";
import { basename as basename2, join as join5, dirname as dirname2 } from "node:path";
import { fileURLToPath } from "node:url";
import { performance as performance2 } from "node:perf_hooks";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// ../mcp/trajectory-server/src/logger.ts
import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync
} from "node:fs";
import { join as join4 } from "node:path";
function createLogger(opts, ensureLogDir, appendLine) {
  let logDirState = "pending";
  const logDirReady = () => {
    if (logDirState === "pending") {
      try {
        ensureLogDir();
        logDirState = "ready";
      } catch {
        logDirState = "failed";
      }
    }
    return logDirState === "ready";
  };
  const serverLogPath = join4(opts.logDir, "mcp-server.log");
  const sqlLogPath = join4(opts.logDir, "sql.log");
  const serverLog2 = (entry) => {
    if (!logDirReady()) return;
    try {
      const line = JSON.stringify({ ...entry, ts: (/* @__PURE__ */ new Date()).toISOString() }) + "\n";
      appendLine(serverLogPath, line);
    } catch {
    }
  };
  const sqlLog2 = opts.sqlEnabled === true ? (entry) => {
    if (!logDirReady()) return;
    try {
      const line = JSON.stringify({ ...entry, ts: (/* @__PURE__ */ new Date()).toISOString() }) + "\n";
      appendLine(sqlLogPath, line);
    } catch {
    }
  } : () => {
  };
  return Object.freeze({
    logDir: opts.logDir,
    serverLog: serverLog2,
    serverLogSync: serverLog2,
    sqlLog: sqlLog2
  });
}
var defaultLogger = null;
function getDefaultLogger() {
  if (defaultLogger === null) {
    const logDir = resolveClaudeLogDir();
    defaultLogger = createLogger(
      { logDir, sqlEnabled: process.env["TMB_DEBUG_SQL"] === "1" },
      () => mkdirSync(logDir, { recursive: true }),
      appendFileSync
    );
  }
  return defaultLogger;
}
function serverLog(entry) {
  getDefaultLogger().serverLog(entry);
}
function sqlLog(entry) {
  getDefaultLogger().sqlLog(entry);
}

// ../mcp/trajectory-server/src/audit-events.ts
var AUDIT_EVENT_TYPES = [
  { type: "agent_arg_mismatch", writers: ["hook"], description: "`agent-arg-matches-caller` denied a trajectory-server call whose `agent` argument named another role than the caller (the payload's `agent_type`, or bro for the main session); one row per denial on the task's issue when `tool_input` carries a `task_id`, else the system issue `-1`, from_node `hook:agent-arg-matches-caller`; `content_json` carries `tool`, `given`, `actual`, `task_id`. `audit_append` refuses this event" },
  { type: "agent_run_overrun_alerted", writers: ["hook"], description: "`task-overrun-alert` told bro that a live swe run of its session (an `agent_runs` row with a `spawn_id` and no `completed_at`) started more than `TMB_TASK_OVERRUN_MIN` minutes (default 60) ago while its task is missing or not `running` (GH 2190); one row per `spawn_id`, ever (the once-marker), on the task's issue (else the run's, else the system issue `-1`), from_node `hook:task-overrun-alert`; `content_json` carries `spawn_id`, `task_id`, `minutes`" },
  { type: "agent_runs_capture_skipped", writers: ["hook"], description: "`swe-atomic-close` could not bind a SWE spawn to a task (no `task_id=<N>` in the spawn transcript, or no such task) and wrote no `agent_runs` row; filed under the system issue `-1`; `content_json` carries `reason`, `transcript`, `spawn_id`, `task_id`" },
  { type: "agent_runs_backfilled", writers: ["bro"], description: "`agent_runs_backfill` (dry_run false) recovered `agent_runs` rows from archived Claude Code transcripts; one row per run on the system issue `-1`, from_node `bro`; `content_json` is the report: `transcripts_dir`, `transcripts_seen`, `sessions_seen`, `bound`, `unbound` (`count`, `first` \u2014 up to 20 `{path, reason}`), `rows_inserted`, `rows_updated`, `rows_skipped_measured`, `tokens_total_added`" },
  { type: "agent_runs_claimed", writers: ["server"], description: "Legacy type kept for historical rows: in v1.1.0-rc.1 `bro-turn-usage` claimed per-task bro `agent_runs` rows opened without a `session_id` for its session; bro is now metered per session, so nothing writes it and `audit_append` refuses it; `content_json` carries `run_ids`, `session_id`", reserved: true },
  { type: "branch_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_branch_gate`; `content_json` carries the waiver reason" },
  { type: "branch_id_proposed", writers: ["bro"], description: "`intent_start` proposed the issue's feature branch; `content_json` carries `branch_id`, `objective`; the scope and branch gates read it" },
  { type: "bro_compact_nudged", writers: ["hook"], description: "`activation-routine` told bro, once per session, that its context (the last main-thread call's input, cache-creation and cache-read tokens) is past `plugin_config.bro_compact_nudge_tokens` and to ask the Human to run /compact at the next natural break (GH 3029); one row per `session_id`, ever (the once-marker), on the system issue `-1`, from_node `hook:activation-routine`; `content_json` carries `session_id`, `context_tokens`, `threshold`" },
  { type: "bro_verification_fail", writers: ["bro"], description: "Bro task-gate found a V1/V2/V3 check that failed" },
  { type: "bro_verification_pass", writers: ["bro"], description: "`bro_atomic_close` closed the task after code-reviewer's pass (older rows: bro's task-gate checks passed before review); `content_json` carries `task_id`, `commit_sha`, and from `bro_atomic_close` a `scope` record (`extras_accepted`, `base_moved`, `recorded_base`, `merge_base`) that `task_brief` reads" },
  { type: "bug_report_filed", writers: ["bro"], description: "Bro filed a TMB bug report on github.com/trustmybot/plugin after the Human approved the `bug_report_draft` draft; written by bro via `audit_append`, and `bug_report_draft` returns the newest row with the same signature as `already_filed`; `content_json` carries `signature`, `url`, `mode` (`issue`, `comment`, `link`)", reserved: true },
  { type: "cheatcode_activate", writers: ["bro"], description: "`cheatcode_activate` confirmed or failed a cheatcode's load; `content_json` carries the resulting status" },
  { type: "cheatcode_approved", writers: ["bro"], description: "`cheatcode_approve` recorded the Human's install approval; the `cheatcode-install-approval` hook reads it" },
  { type: "cheatcode_healthcheck", writers: ["bro", "server"], description: "`cheatcode_reconcile` (bro) or the server startup reconcile (server) moved a cheatcode's status (e.g. `active` \u2192 `broken`); filed under the system issue `-1`; `content_json` carries `name`, `kind`, `from`, `to`" },
  { type: "cheatcode_install", writers: ["bro"], description: "`cheatcode_install` ran the install script; `content_json` carries `method` and the script outcome" },
  { type: "cheatcode_installed", writers: ["bro"], description: "`cheatcode_install` registered the installed cheatcode row; `content_json` carries `cheatcode_id`" },
  { type: "cheatcode_search", writers: ["bro"], description: "`cheatcode_search` finished; `content_json` carries `query`, `kind`, `candidate_count`, and `top` ranked candidates" },
  { type: "cheatcode_uninstalled", writers: ["bro"], description: "`cheatcode_uninstall` removed a cheatcode" },
  { type: "cheatcode_vet", writers: ["bro"], description: "`cheatcode_vet` classified a candidate; `content_json` carries `trust_tier` and the vet signals" },
  { type: "concept_proposal_applied", writers: ["bro"], description: "`scan_run` upserted an L2 concept a closed task proposed in its completion report (`report.concepts`), the task having a passing code-reviewer verdict for its current commit; `verified_by` is `swe`; one row per (task, concept name), on the task's issue, from_node `bro`; `content_json` carries `task_id`, `concept_id`, `name`" },
  { type: "concept_proposal_rejected", writers: ["bro"], description: "`scan_run` gave up on a reviewed task's concept proposal that still failed to upsert (an anchor not in the index, a failing claim) 14 days after the task closed; before that a failing proposal stays pending with no row; one row per (task, concept name), on the task's issue, from_node `bro`; `content_json` carries `task_id`, `name`, `error`" },
  { type: "config_changed", writers: ["bro"], description: "`writeConfigValueJson` (`setConfigValues` for `config_set`, and `onboard_apply`) stored a `plugin_config` key whose `value_json` differs from the stored one, a new key included; an identical re-set writes none; one row per key in the upsert's transaction, on the system issue `-1`, from_node the caller; `content_json` carries `key` only, never the value (it may hold a secret); `change_impact`'s tmb_events source reads it. The dashboard also writes one per Human config write that changed a value, from_node `dashboard`, `content_json` carrying `actor: human`, `source: dashboard`, `tool: config_set` and `fields` (the key) but no `key`, so `change_impact` counts the change once" },
  { type: "consultant_spawn_nudged", writers: ["hook"], description: "`prompt-intent-hints` emitted the consultant-spawn nudge; filed under the system issue `-1`" },
  { type: "containment_denied", writers: ["hook"], description: "`containment-guard` denied a write outside the run's root (on the task's issue, else the system issue `-1`); `content_json` carries `tool`, `path`, `root`, `task_id`" },
  { type: "decision_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_decision_gate`; `content_json` carries the waiver reason" },
  { type: "deep_scan_completed", writers: ["bro"], description: "`scan_run` finished; `content_json` carries `source`, `structural_change`, `repos_seen`, `top_dirs`, `errors`" },
  { type: "downstream_context_ab_enrolled", writers: ["hook"], description: "`swe-downstream-context` or `reviewer-downstream-context` enrolled a task in the opt-in downstream-context A/B (`plugin_config.downstream_context_ab`, GH 1990) on the first hook call for it while fewer than `target` tasks carried the label; its arm is `on` when floor(task_id / 2) is odd, else `off`; one row per task and label on the task's issue, from_node `hook:<gate>`; `content_json` carries `label`, `arm`, `task_id`" },
  { type: "downstream_context_injected", writers: ["hook"], description: "`swe-downstream-context` (on a swe's first Edit/Write/MultiEdit/NotebookEdit of an indexed file per run) or `reviewer-downstream-context` (on a code-reviewer start) emitted the direct downstream of the symbols in play, callers and readers of the tables they write, tests excluded, as additionalContext for a task in the A/B's `on` arm (GH 1990); one row per injection on the task's issue; `content_json` carries `task_id`, `role`, `agent_id`, `path` (swe) or `symbols` (code-reviewer), `refs_shown`, `refs_total`" },
  { type: "effort_ab_enrolled", writers: ["bro"], description: "`task_provision` or `task_create_batch` enrolled a new task in the opt-in swe effort A/B (`plugin_config.swe_effort_ab`, GH 1745): its computed effort was the default or an explicit `medium` and fewer than `target` tasks carried the label, so its effort became the arm of its id's parity (even `high`, odd `medium`) with `effort_reason` `ab_arm`; one row per task on its issue, in the insert's transaction; `content_json` carries `label`, `arm`, `task_id`" },
  { type: "effort_inputs_recorded", writers: ["bro"], description: "`task_provision` or `task_create_batch` recorded, in shadow mode (GH 1904), what the world model knows about the code a new task's spec names in backticks and the effort tier those inputs suggest; the task's effort is unchanged; one row per task on its issue, in the insert's transaction, after any `effort_ab_enrolled` row; `content_json` carries `task_id`, `inputs` (`files_in_scope`, `symbols_named`, `symbols_resolved`, `direct_callers`, `caller_files_outside_scope`, `tables_written`, `outside_table_readers`, `tests_reached`, `enforcement`, `prompt_bearing`, `rework`, `wm_available` \u2014 false with zero world-model counts when the repo has no world model or a lookup failed), `suggested_tier` (`low`, `medium`, `high`), `reason`, `effort` (the effort the task runs at)" },
  { type: "embeddings_degraded", writers: ["server"], description: "The embedding model entered the degraded state \u2014 it could not load, or `TMB_EMBED_FAIL_THRESHOLD` (default 5) consecutive embed calls failed \u2014 so semantic search falls back to FTS until a timed re-attempt (1 min, 5 min, then every 10 min) succeeds; one row per degraded episode on the system issue `-1`, from_node `trajectory-server`; `content_json` carries `reason`, `consecutive_failures`" },
  { type: "embeddings_recovered", writers: ["server"], description: "A re-attempt brought the degraded embedding model back, or a process loaded the model healthy while an earlier process left a degraded episode open (`reason` `process_start`, `retries` 0); one row per episode on the system issue `-1`, from_node `trajectory-server`; `content_json` carries `degraded_since`, `reason`, `retries`" },
  { type: "hook_block_bypassed", writers: ["hook"], description: "`swe-boundary` saw an Edit/Write to a path that a PreToolUse Bash gate had judged as a literal write target and denied in the same session within `TMB_BYPASS_WINDOW_MIN` minutes (default 10); a deny that could not judge its target records no path, so the literal-path write it prescribes is never counted (GH 1750); the write is still allowed (on the task's issue, else the system issue `-1`); `content_json` carries `tool`, `path`, `denied_gate`, `denied_at`, `session_id`, `task_id`" },
  { type: "hook_call", writers: ["hook"], description: "The router (`node dist/hooks.js <event>`, GH 1692) decided one call of a routed event (PreToolUse, PostToolUse, PermissionDenied, Stop, SubagentStop, SessionStart, UserPromptSubmit or WorktreeCreate): one row per call it decided (a replayed duplicate writes none), from_node `hook:router`, on the task's issue else the system issue `-1`; `content_json` carries `event`, `tool` (empty on an event with no tool, as Stop), `decision` (`allow`, `deny`, or `failed` on a WorktreeCreate that exited non-zero), `denied_gate`, `task_id`, and `gates`: one `{gate, ms, outcome}` per gate run, in group order, `ms` measured on that gate's own clock (from its start to its return or budget expiry, so no sibling's work is in it), `outcome` being `allow`, `deny`, `skipped_budget` or `error`" },
  { type: "hook_denied", writers: ["hook"], description: "The router (`node dist/hooks.js <event>`) returned a deny: a gate's exit 2, `permissionDecision: \"deny\"` or `decision: \"block\"`, or its own fail-closed decision; one row per deny (a replayed duplicate writes none), from_node `hook:dispatch`, on the task's issue else the system issue `-1`; `content_json` carries `hook` (the gate), `rule` (the first 200 characters of the deny reason), `tool`, `agent_type`, `task_id` (the calling swe's run, else `tool_input.task_id`; null when unknown), `cwd` (the payload's). `audit_append` refuses this event" },
  { type: "intent_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_intent_gate`; `content_json` carries the waiver reason" },
  { type: "issue_adopted", writers: ["bro"], description: "`issue_create`, `issue_adopt_remote` or `issue_sync_retry` adopted an existing remote issue as the local issue's twin (`issue_sync_retry`: the issue an earlier lost create made, found by its body marker); `content_json` carries `issue_id`, `backend`, `remote_iid`, plus `via: 'issue_sync_retry'` from that tool" },
  { type: "issue_auto_close_deferred", writers: ["hook"], description: "`close-issue-on-merge` left an issue named by a merged PR's closing-ref open because other tasks of it are still live; `content_json` carries `blocking_task_ids`, `gh_iid`" },
  { type: "issue_auto_close_remote_skipped", writers: ["hook"], description: "`close-issue-on-merge` closed an issue locally but not its GitHub twin because issue sync is off (`plugin_config.issue_sync` unset or `off`, or `TMB_DISABLE_REMOTE_SYNC` set); `content_json` carries `gh_iid`, `reason`" },
  { type: "issue_auto_closed_on_merge", writers: ["hook"], description: "`close-issue-on-merge` closed a local issue named by a merged PR's closing-ref; `content_json` carries `gh_iid`" },
  { type: "issue_close_remote_skipped", writers: ["server"], description: "`issue_close`, `bro_atomic_close` or `task_recover` closed an issue locally but no linked remote because the remote-sync gate is off: `reason` is `issue_sync_off` (`plugin_config.issue_sync` unset or `off`), `env_disabled` (`TMB_DISABLE_REMOTE_SYNC` set) or `no_backend` (no usable gh/glab for the issue repo's remotes); `content_json` carries `reason`, `remotes`" },
  { type: "issue_closed_from_remote", writers: ["bro"], description: "`issue_reconcile_remote` (`reconcileRemoteCloses`, `sync/issue-reconcile.ts`) closed an open local issue because its linked GitHub/GitLab twin reports closed and the issue has no live task; one row per close, in the close's transaction, on the issue, from_node `bro`; `content_json` carries `remote_kind`, `remote_iid`" },
  { type: "issue_linked", writers: ["bro"], description: "`issue_link` bound a local issue to a remote issue; `content_json` carries `issue_id`, `backend`, `iid`, `forced`" },
  { type: "issue_remote_closed_local_open", writers: ["bro"], description: "`issue_reconcile_remote` found an open local issue whose linked remote twin is closed but left it open because tasks of it are still live (`pending`/`running`/`needs_validation`/`completed`); one row per issue and blocking task set (a rerun with the same `blocking_task_ids` writes none), from_node `bro`; `content_json` carries `remote_kind`, `remote_iid`, `blocking_task_ids`; the `issues_open_after_remote_close` contract reads it" },
  { type: "issue_updated", writers: ["bro"], description: "bro changed an issue's milestone, labels or objective after creation; the dashboard also writes one per Human write (an edit, a comment or a close), from_node `dashboard`, `content_json` carrying `actor: human`, `source: dashboard`, `tool` (the trajectory-server handler it called) and `fields`" },
  { type: "legacy_event", writers: ["server"], description: "A migration re-typed a legacy audit row: v38 one whose `event_type` was outside the closed set (written by v1.0.x, before the set closed), v39 a swe-written `verification_gate_waived` row without a `commit_sha` that repeated an earlier one for its task; `content_json` keeps the original content and carries `legacy_event_type` (the old type), plus `legacy_content` when the old content was not valid JSON. Filed under the row's original issue; `audit_append` refuses this event" },
  { type: "mcp_unavailable_fallback_invoked", writers: ["bro", "swe", "code-reviewer", "consultant"], description: "An agent wrote the trajectory DB in place of an unavailable MCP server, recorded through `audit_append` and filed under the system issue `-1`; only agents write it. The fallback path, `dist/cli.js validation-record-fallback` (`src/cli/validation-record-fallback.ts`), writes no audit row: it marks its `validation_attempts` row `mcp_available = 0`", reserved: true },
  { type: "milestone_closed", writers: ["bro"], description: "`milestone_close` closed a milestone; `content_json` carries `name`, `repo`, `forced`, `open_issues`, `remote_closed`, `remote_results`" },
  { type: "milestone_reconcile_failed", writers: ["bro"], description: "`scan_run` could not read a repo's remote milestones; `content_json` carries `repo`, `backend`, `reason` (the scan still succeeds)" },
  { type: "milestone_seed_skipped", writers: ["bro"], description: "`scan_run` found no milestones and could not seed one; `content_json` carries `repo`, `reason` (`no_version_source` or `reconcile_failed`)" },
  { type: "milestone_seeded", writers: ["bro"], description: "`scan_run` seeded `v<next-patch>` for a repo with no milestones; `content_json` carries `name`, `repo`, `source`, `remote_created`" },
  { type: "milestones_reconciled", writers: ["bro"], description: "`scan_run` imported a repo's remote milestones; `content_json` carries `imported`, `closed`, `repo`" },
  { type: "persona_block_written", writers: ["server"], description: "Legacy type kept for historical rows: in v1.1.0-rc.1 `onboard_apply` copied bro's persona block into the project's `CLAUDE.md`; nothing writes it now and `audit_append` refuses it; `content_json` carries `action` (`appended`, `replaced`), `version`", reserved: true },
  { type: "planning_complete", writers: ["bro"], description: "Bro finished planning: batched `task_create_batch` + SWE spawn" },
  { type: "prompt_write_approved", writers: ["bro"], description: "Bro recorded the Human's AskUserQuestion Yes before writing a project skill or agent file (under `<project>/.claude/skills/` or `<project>/.claude/agents/`); `content_json` carries `path` (the absolute target path) and `scope` (`full`, or `skills-array` to change only an agent's `skills:` list); the `prompt-write-approval` hook reads it" },
  { type: "project_made_standalone", writers: ["bro"], description: "`onboard_apply(standalone=true)` made the session directory, nested below the workspace, its own TMB project: it wrote the `standalone` marker and a fresh trajectory DB in `<session_dir>/.claude/<plugin>/`, which the DB walk-up then picks over the workspace DB; filed under the system issue `-1` in the workspace DB; `content_json` carries `session_dir`, `db_path`, `marker`" },
  { type: "readme_staleness_surfaced", writers: ["hook"], description: "`post-atomic-close-readme` surfaced READMEs a closed task may have left stale" },
  { type: "registry_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_registry_gate`; `content_json` carries the waiver reason" },
  { type: "remote_id_guard_overrun", writers: ["hook"], description: "`remote-id-guard` killed its analysis at `TMB_REMOTE_ID_GUARD_DEADLINE_S` (default 3 s, inside the 6 s hooks.json timeout) and allowed the Bash command (GH 1821); one row per overrun on the system issue `-1`, from_node `hook:remote-id-guard`; `content_json` carries `deadline_s`, `elapsed_s`" },
  { type: "repo_remotes_migration_skipped", writers: ["server"], description: "The v35 migration could not move a repo's `repos.remotes` JSON into `repo_remotes` \u2014 the value did not parse as an array or a name \u2192 url map, or some entries carried no url or a duplicate name (the rest moved); one row per repo on the system issue `-1`, written by `system`; `content_json` carries `repo`, `reason`, `raw`" },
  { type: "repo_rename_detected", writers: ["bro"], description: "`scan_run` found a discovered repo whose canonical path or primary remote URL matches an existing row under another name; no second row is inserted and the old row is kept until `repo_rename`; filed under the system issue `-1` by `bro`; `content_json` carries `old`, `new`, `by` (`path` or `remote`)" },
  { type: "repo_renamed", writers: ["bro"], description: "`repo_rename` moved a repo to a new name: the `repos` row, its FK children, `pr_review_runs` host slugs and the world-model nodes; filed under the system issue `-1` by `bro` with `repo` = the new name; `content_json` carries `old`, `new`, `reason`, `rows_by_table`, `graph` (`rekeyed`, or `deferred` when the world model was unavailable or the re-key failed \u2014 the next `scan_run` rebuilds), `graph_nodes`, and `graph_error` when the re-key failed" },
  { type: "review_finding_wontfix", writers: ["bro"], description: "`task_reopen(wontfix)` set an open review finding of the task to `wontfix` (the Human accepted it), so the close gate stops probing it; one row per finding on the task's issue; `content_json` carries `task_id`, `finding_id`, `reason`" },
  { type: "review_findings_carried", writers: ["bro"], description: "`task_retry` copied the failed task's open review findings onto the retry task as `F<new_task_id>-<n>`; one row per retry that carried at least one; `content_json` carries `from_task_id`, `to_task_id`, `findings` (`from`, `id`)" },
  { type: "review_gate_bypassed", writers: ["bro", "hook"], description: "A task reached `closed` by a path other than `bro_atomic_close` (`close-issue-on-merge`, `task_recover`, `task_update_status`) with no passing code-reviewer verdict for its current commit; the task still closes. At most one row per task and commit (none when a `review_gate_waived` row already names them); `content_json` carries `task_id`, `commit_sha`, `closed_by`. A verdict counts as passing when `verdict = 'pass'` and its `created_at` is at or after the earliest `review_handoff` or `bro_verification_pass` row naming the task and its current `commit_sha`, and the task's newest `validation_attempts` row (highest `id`) is a pass: a newer `fail` or `escalate` row cancels it" },
  { type: "review_gate_waived", writers: ["bro"], description: "`issue_close(waive_review: true)` closed an issue over a closed task with no passing code-reviewer verdict for its current commit; one row per such task; `content_json` carries `skill`, `task_id`, `commit_sha`, `waive_review_reason`" },
  { type: "review_handoff", writers: ["bro"], description: "`review_handoff` handed a completed task's current commit to code-reviewer after the completion-report and verification gates passed; the task status does not change, except that a re-review of a FAIL-reopened `running` task's unchanged commit after a `re_review` rework analysis restores `completed` (GH 2866). One row per call on the task's issue, from_node `bro`; it is the review anchor a later passing verdict counts from, and `bro_atomic_close` refuses until such a pass exists. `content_json` carries `task_id`, `commit_sha`, `scope` (`extras` \u2014 each path outside `files[]` with swe's reason or null, `base_moved`, `recorded_base`, `merge_base`, `checked`) that `task_brief` reads, and `re_review_of` (the FAIL's validation id) on a re-review" },
  { type: "reviewer_effort_assigned", writers: ["bro"], description: "`review_handoff` assigned the effort the task's code-reviewer spawn runs at (GH 1955), returned as `reviewer_effort`; one row per handoff, in its transaction right after `review_handoff`, on the task's issue, from_node `bro`. The risk tier is `high` for a prompt-bearing task or a changed path overlapping a `high_effort_paths` prefix, `low` when every changed path is docs or tests, else `medium`; it applies with `plugin_config.reviewer_effort_tiers` true or in the `tiered` arm of `plugin_config.reviewer_effort_ab` (even task ids; odd ids are `fixed`), else the effort is `reviewer_effort` (reason `config`, also when the scope check did not run). A tier assignment takes the `model` and `effort` of the `plugin_config.reviewer_tier_settings` entry for its reason (GH 2932); the `config` reason never carries a model. `require-spawn-effort` and `swe-atomic-close` read the newest row for the task; `task_recover` writes none. `content_json` carries `task_id`, `commit_sha`, `effort` (`low`, `medium`, `high`), `model` (`opus`, `sonnet`, `haiku`, `fable`) only when a tier setting names one, `reason` (`prompt_bearing`, `high_effort_paths`, `docs_tests`, `default`, `config`) and, for a task enrolled in the A/B, `label` and `arm`" },
  { type: "reviewer_identity_observed", writers: ["hook"], description: "`reviewer-identity-observe` saw a code-reviewer subagent call `validation_record` (the payload carried `agent_id` and an `agent_type` that normalises to `code-reviewer`); one row per call on the task's issue, from_node `hook:reviewer-identity-observe`; `content_json` carries `task_id`, `attempt_n`, `session_id`, `agent_id`, `tool_use_id` (null when the payload has none), `observed_at`, `consumed` (0 until `validation_record` stamps `subagent_session_id` and `reviewer_agent_id` from it and sets 1; a row observed more than 600 s before the call is never consumed), and `superseded`, `superseded_by`, `superseded_at` (set when `validation_record` consumes a newer row for the same `(task_id, attempt_n)`: every older unconsumed row gets `superseded` 1, the audit id of the consumed row and the time; a superseded row is never consumed). `audit_append` refuses this event" },
  { type: "reviewer_spawn_observed", writers: ["hook"], description: "`record-reviewer-spawn`, the last PREPARE step of `agent-spawn-dispatch`, saw a code-reviewer Agent spawn every spawn gate allowed whose prompt carries integer `task_id=` and `attempt_n=` and a 7-40 hex `commit_sha=` (GH 2684); one row per spawn on the task's issue, from_node `hook:record-reviewer-spawn`; `content_json` carries `task_id`, `attempt_n`, `commit_sha`. `validation_record` copies the newest row's `commit_sha` for `(task_id, attempt_n)` into `validation_attempts.reviewed_sha`. `audit_append` refuses this event" },
  { type: "roundtable_slash_invoked", writers: ["hook"], description: "`roundtable-slash-detect` saw the Human type `/roundtable`; `roundtable_create` consumes the row" },
  { type: "roundtable_summary", writers: ["bro"], description: "Bro recorded a roundtable's outcome summary via `audit_append`; `roundtable-cleanup-postcheck` requires it", reserved: true },
  { type: "scan_discovered", writers: ["server", "hook"], description: "A scan registered a newly discovered cheatcode (`scan_run`, or its walker as `hook:scan`); filed under the system issue `-1`; `content_json` carries `name`, `kind`, `origin`, `source`" },
  { type: "scan_discovered_repair", writers: ["server"], description: "The v32 migration deleted `scan_discovered` rows whose `(name, kind)` has no `cheatcodes` row; filed under the system issue `-1` by `system`; `content_json` carries `deleted`" },
  { type: "scan_skipped", writers: ["hook"], description: "The scan walker left a git repo below the session dir out of the scan; one row per path and reason (a re-scan that skips it again writes none), filed under the system issue `-1` as `hook:scan`; `content_json` carries `path`, `reason` (`dot_dir`: a dot-prefixed path segment below the session dir; `git_ignored`: an enclosing repo ignores it; `linked_worktree`: a `git worktree add` checkout of another repo; `no_commits`: it has no commit)" },
  { type: "scope_gate_waived", writers: ["bro"], description: "`bro_atomic_close(waive_scope_gate: true)` accepted the task's changed paths outside its `files[]` with a `scope_waiver_reason`; `content_json` carries `skill`, `task_id`, `commit_sha`, `accepted_paths`, `reason`, `base_moved`, `recorded_base`, `merge_base`. `task_create_batch(waive_scope_gate: true)` writes one when it skips its question gate, `content_json` carrying `waive_scope_gate_reason`, `tasks_created`" },
  { type: "skill_creator_blocked", writers: ["bro"], description: "`tmb_skill-creator` halted before writing the skill (no Human approval); written by bro via `audit_append`", reserved: true },
  { type: "spec_shape_gate_waived", writers: ["bro"], description: "A task's spec-shape waiver, one row per task on its issue with from_node `bro`; `task_create_batch` and `task_provision` called with `waive_spec_shape` write one for every task they create, and bro records one for an existing task through `audit_append`; `content_json` carries `task_id`, `gate` (`spec_shape`), `reason`, `waived_by` (`bro`), `source` (`task_create_batch`, `task_provision`, or absent for `audit_append`); `require-task-spec` reads it as the spawn waiver" },
  { type: "stray_db_removed", writers: ["bro"], description: "`onboard_apply(remove_stray_dbs)` deleted an empty trajectory DB (0 issues, 0 tasks) below the project root, with its `-wal`/`-shm` files and its state dir, on the Human's yes; one row per DB on the system issue `-1`; `content_json` carries `path`, `state_dir`, `project_root`" },
  { type: "subagent_return_oversize", writers: ["hook"], description: "`swe-atomic-close` saw a swe or code-reviewer SubagentStop whose `last_assistant_message` runs over 600 characters, the budget of a `return_line` head plus at most 4 short lines (GH 1959); advisory only, the stop is never blocked or changed; one row per such stop, on the task's issue (the system issue `-1` when the spawn is bound to no task); `content_json` carries `task_id` (null when unbound), `agent_type`, `chars`" },
  { type: "swe_atomic_close_background_wait", writers: ["hook"], description: "`swe-atomic-close` saw a swe stop on a `pending`/`running` task while its transcript still holds a live background command (started, with no `<task-notification>` and no `TaskStop` for its id; GH 2206); the task keeps its status and is not auto-completed, so swe's resumed turn closes it; one row per such stop on the task's issue; `content_json` carries `task_id`, `commit_sha` (the worktree HEAD, null when none), `background_ids`" },
  { type: "swe_atomic_close_gate_pending", writers: ["hook"], description: "`swe-atomic-close` saw a swe stop with commits on a `pending`/`running` task but found no passing, not timed-out `verification_runs` row for (task, worktree HEAD) (GH 2866); the task keeps its status and is not auto-completed, so bro resumes swe to close through `swe-verification-gate`; one row per such stop on the task's issue; `content_json` carries `task_id`, `commit_sha`" },
  { type: "swe_atomic_close_auto_completed", writers: ["hook"], description: "`swe-atomic-close` auto-completed a `pending`/`running` task on SubagentStop because its worktree HEAD is neither equal to nor an ancestor of any parent tip (local or origin) and has a passing, not timed-out `verification_runs` row (GH 2866); one row per auto-complete on the task's issue, written in the same transaction as the status change; `content_json` carries `task_id`, `commit_sha`, `parent_tip_local`, `parent_tip_origin` (null when that ref is absent)" },
  { type: "swe_brief_fetched", writers: ["swe"], description: "`task_brief` recorded that a SWE fetched its brief (one row per task); swe-brief-gate reads it" },
  { type: "swe_resume_observed", writers: ["hook"], description: "`swe-brief-gate` saw a swe call `task_brief` with an `agent_id` whose `agent_runs` rows for the task are all closed: a swe resumed through SendMessage (GH 1742); one row per such call on the task's issue, from_node `hook:swe-brief-gate`; `content_json` carries `task_id`, `agent_id`, `observed_at`, `consumed` (0 until `task_brief`'s `openSweRun` opens the resumed run's row from it, with `resumed_from` its previous row, and sets 1; a row observed more than 600 s before the call is never consumed). `audit_append` refuses this event" },
  { type: "sync_skipped", writers: ["bro"], description: "Issue sync skipped a remote write because `issue_sync` is off; `content_json` carries `issue_id`, `reason`" },
  { type: "task_effort_raised", writers: ["bro", "code-reviewer"], description: "`task_reopen` or `task_retry` called with an `effort` above the task's (for `task_retry`, the failed task's) raised the effort swe runs it at, as does either call made with no `effort` (rework computes `high`); a code-reviewer `fail` verdict in `validation_record` raises a reopened or `running` task below `high` to `high` (GH 2866), from_node `code-reviewer`, dated the FAIL row's `created_at`, so it is no `rework-limit` proof; one row per raise on the task's issue; `content_json` carries `task_id`, `from`, `to`, and `failed_task_id` from `task_retry`" },
  { type: "task_escalated_by_issue_close", writers: ["bro"], description: "`issue_close(cascade: true)` escalated a live task (`pending`/`running`/`needs_validation`/`completed`) of the issue it closed and closed its open `agent_runs` rows as `issue_closed`; one row per task; `content_json` carries `task_id`, `from_status`, `reason`" },
  { type: "task_escalated_repair", writers: ["server"], description: "The v33 migration escalated a task still `pending`/`running`/`needs_validation`/`completed` whose issue was already `closed` and closed its open `agent_runs` rows as `issue_closed`; written by `system`; `content_json` carries `task_id`, `issue_id`, `from_status`" },
  { type: "task_integrated", writers: ["hook"], description: "`cli.js integrate` (`src/cli/integrate.ts`) moved the task branch to the rebased SHA and set `tasks.commit_sha` to it, in one transaction guarded on the reviewed `commit_sha`; one row per integration on the task's issue, from_node `hook:integrate`. It is a review anchor beside `bro_verification_pass` (`HAS_PASS_SQL`) whose time is its `review_anchor_at`, the anchor the reviewed SHA's pass was judged against, so that pass covers the integrated head (GH 2082); a row with no `review_anchor_at` (written before GH 2082) takes the anchor of its `reviewed_sha`, walking back through such rows of the task, and anchors at its `created_at` when that finds none (GH 2546). `content_json` carries `task_id`, `reviewed_sha`, `review_anchor_at`, `commit_sha` (the rebased SHA), `base`, `run_id` (the passing `verification_runs` row)" },
  { type: "liveness_finding_reported", writers: ["hook"], description: "`liveness-sentinel` or `liveness-alert` reported a subagent run or `tail -f` watcher that looks dead or hung (GH 2205); one row per `kind` (`subagent` or `shell`) and `finding_id` (the `agent_runs` id, else the background task id), ever (the once-marker), on the run's issue or the system issue, from_node `hook:<gate>`; `content_json` carries `kind`, `finding_id`, `run_id`, `task_id`, `agent_type`, `agent_id`, `shell_id`, `command`, `silent_min`, `reason`" },
  { type: "task_overrun_alerted", writers: ["hook"], description: "`task-overrun-alert` told bro that a `running` task passed `TMB_TASK_OVERRUN_MIN` minutes (default 60) since its running stint began (its newest `task_reopened` row, else its `created_at`); one row per task and stint (the once-marker), on the task's issue, from_node `hook:task-overrun-alert`; `content_json` carries `task_id`, `since` (the stint start), `minutes`, `attempts` (swe spawns), `blocker` (the first line of the latest FAIL feedback, else the status)" },
  { type: "task_recovered", writers: ["bro"], description: "`task_recover` closed a task stuck in `running`/`completed` at its commit; `content_json` carries `task_id`, `commit_sha`, `prior_status`" },
  { type: "task_reopened", writers: ["bro", "code-reviewer"], description: "`task_reopen` moved a `pending` / `closed` / `failed` / `escalated` / `running` task back to `running` for rework; `content_json` carries `task_id`, `from_status`, `reason`, `files_add`, `verification_add`. A code-reviewer `fail` verdict reopens a `completed` / `needs_validation` / `closed` task of an open issue the same way in `validation_record`'s transaction (GH 2866), from_node `code-reviewer`; its `content_json` carries `task_id`, `from_status`, `reason`, `validation_id`, `finding_ids` (the blocking findings), `auto` (true), and the cleared `completion_report` and `completed_at` a re-review restores" },
  { type: "task_rework_analysis", writers: ["bro"], description: "`task_rework_analysis` recorded bro's analysis of a task's review FAILs since its latest pass (GH 2830); one row per call on the task's issue, from_node the `agent` argument. The `rework-limit` gate admits a swe run past two FAILs only when the task's latest such row is newer than its latest FAIL and its `change` is proven by a row newer than that FAIL: `spec_update` by `task_spec_amended`, `effort_raise` by `task_effort_raised`, `world_model_fix` by `deep_scan_completed`, `wm_reindex`, a `world_model_concept_upsert` `wm_tool_called` row or an `Area: World Model` issue. A `design_drift` row denies every further swe run of the task, which bro redesigns as a new task by `task_retry` or a split. `content_json` carries `task_id`, `fail_validation_ids`, `finding_ids`, `root_cause`, `change`, `approach_shared_cause`, `rationale`" },
  { type: "task_retry_attempted", writers: ["bro"], description: "`task_retry` created a retry task for a failed one; `content_json` carries `failed_task_id`, `new_task_id`, `new_branch_id`" },
  { type: "task_spec_amended", writers: ["bro"], description: "`task_update_spec` replaced a live task's `files` / `verification` / `spec_body`; `content_json` carries `task_id`, `status`, `reason`, `changes`" },
  { type: "task_stale_swept", writers: ["bro"], description: "`task_recover` moved a `running` task with no open swe `agent_runs` row and no update for `TMB_STALE_RUNNING_HOURS` (default 6) to `failed` and closed its open runs as `swept_stale`; `content_json` carries `task_id`, `from_status`, `last_updated_at`, `stale_after_hours`" },
  { type: "tmb_agent_created", writers: ["server", "bro"], description: "`agent_register` registered a project-local consultant; `content_json` carries `name`, `mode`, `agent_id`" },
  { type: "tmb_branch_autocreated", writers: ["bro"], description: "`task_create_batch` created the task's feature branch ref" },
  { type: "tmb_skill_created", writers: ["bro"], description: "`tmb_skill-creator` landed a new skill; written by bro via `audit_append`", reserved: true },
  { type: "trajectory_doctor_run", writers: ["bro"], description: "`trajectory_doctor(record: true)` checked the trajectory DB against its data contracts (`mcp/trajectory-server/src/data-contracts.ts`); filed under the system issue `-1` by `bro`; `content_json` is the report: `healthy`, `checked_at`, `schema` (`stored`, `required`, `current`), `violations` (`id`, `severity`, `description`, `actual`, `expected`, `sample`), `skipped` (`id`, `reason`), `embeddings` (the server's `embeddingStatus()`: `state`, `since`, `reason`, `consecutive_failures`, `next_retry_at`)" },
  { type: "validation_session_unverified", writers: ["server"], description: "`validation_record` recorded an honor-system verdict (`mcp_available: false`) with no `reviewer_identity_observed` row, so `subagent_session_id` is the caller's unverified value and `reviewer_agent_id` is NULL; on the task's issue, from_node `trajectory-server`; `content_json` carries `task_id`, `attempt_n`, `subagent_session_id`" },
  { type: "verification_gate_waived", writers: ["hook"], description: "`swe-verification-gate` honoured a SWE's `waive_verification_gate_reason`; at most one row per task and commit; `content_json` carries `task_id`, `commit_sha`, `waiver_reason`" },
  { type: "wm_feedback", writers: ["swe", "code-reviewer"], description: "An agent said what the world model answered, missed or got wrong during a task (GH 2417): `task_update_status(status='completed')` writes one row when swe's `report.wm_feedback` is present (only swe may pass it; any other agent is refused with `wm_feedback_invalid`), and `validation_record` one when code-reviewer passes `wm_feedback`; a report whose `answered`, `missed` and `wrong` are all absent or blank writes no row; on the task's issue, from_node the `agent` argument; `content_json` carries `task_id`, `agent`, `answered`, `missed`, `wrong` (null when absent). `trajectory_doctor` counts the rows and those with a non-empty `missed` / `wrong`" },
  { type: "wm_provision_fetch_failed", writers: ["bro"], description: "`task_provision` fetches `origin/<target branch>` before it resolves the base, ignoring the 10-minute read window, then brings the world model to it (GH 2958); the fetch errored or ran past its 5 s cap, so the task was provisioned on the current index. One row per such provision, written in the transaction that creates the task (a refused provision writes none), on the task's issue and branch, from_node the `agent` argument; `content_json` carries `repo`, `branch` (the target branch, null when it never resolved), `error`" },
  { type: "wm_read_missing_before_provision", writers: ["hook"], description: "`wm-read-before-provision` denied a `task_provision` call (GH 2329, GH 2958): its session transcript holds no assistant `world_model_get`, `world_model_search`, `world_model_symbol`, `world_model_concepts`, `world_model_concept_get` or `scope_suggest` tool_use in the last 60 minutes that covers one of `tool_input.task.files[]` (a files[] path in the read's input or its tool_result text, or the read's `path` and a files[] entry where one is a directory prefix of the other; with no files[], any such read). A repo with no `wm_files` rows, or a DB that does not resolve, is allowed with a nudge and writes no row. One row per deny on `tool_input.issue_id`, else the system issue `-1`, from_node `hook:wm-read-before-provision`; `content_json` carries `tool`, `session_id`, `window_minutes`, `reason` (`no_read`, `no_covering_read` when every recent read misses files[], or `transcript_unreadable` when the transcript is missing or unreadable). `audit_append` refuses this event" },
  { type: "wm_reindex", writers: ["server"], description: "The world model of one repo was brought to a new commit (GH 2584): incrementally (only the paths `git diff` names re-parsed) or by a full rebuild of the repo; one row per repo reindex, a no-op writes none, on the system issue `-1`, from_node `system`; `content_json` carries `repo`, `mode` (`incremental` or `full`, or `mismatch`: the daily shadow compare found the index differs from a clean rebuild and wrote this row instead of reindexing, so every reindex rebuilds the repo in full until the repo's `indexed_stamp` changes), `reason` (`ref_moved` for incremental; `null_stamp`, `unreachable`, `stamp_changed`, `mismatch`, `scan` or `range_failed` for full; `mismatch` for a mismatch row, whose trigger is `startup_catchup`, `from_commit` and `to_commit` the compared commit, file counts 0 and `stamp` the repo's `indexed_stamp` when the verdict was written), `trigger` (`read`, `startup_catchup`, `scan`, `spawn`, `hook`, the ref-move hook after a Bash command moves the target ref, or `fetch`, a read whose periodic fetch moved `origin/<target branch>`), `from_commit` (empty when there was no stamp), `to_commit`, `files_diffed`, `files_parsed`, `dirs_touched`, `concepts_flagged` (concepts whose status or reason the concept refresh changed, 0 on a mismatch row), `ms`" },
  { type: "wm_shadow_compare", writers: ["server"], description: "The daily shadow compare checked one repo's world model against a clean full index built at its `indexed_commit` in a temp DB under the OS temp dir, removed afterwards (GH 2584, `src/world-model/shadow-compare.ts`): `startup_catchup` starts it in the background for at most one repo whose newest such row is 24 h old or absent; one row per compare, on the system issue `-1`, from_node `system`; `content_json` carries `repo`, `commit`, `stamp` (the repo's `indexed_stamp`), `verdict` (`match`, `mismatch`, or `skipped`), `tables` (those of `wm_files`, `wm_symbols` and `wm_edges` whose normalized rows differ), `ms`, `reason` (`moved` when `indexed_commit` changed during the compare, `error` when the clean build or the compare failed, else null) and `error` (the message, else null). A mismatch also writes a `wm_reindex` row with mode `mismatch` in the same transaction, so every reindex rebuilds the repo in full until its `indexed_stamp` changes. Nothing is filed outside the DB. `audit_append` refuses this event" },
  { type: "wm_tool_called", writers: ["server"], description: "A world-model tool (`world_model_get`, `world_model_search`, `world_model_symbol`, `world_model_concepts`, `world_model_concept_get`, `world_model_concept_upsert`, `scope_suggest`) answered a call, error results included; one row per call, from_node the `agent` argument, on the task's issue when exactly one open `agent_runs` row has the caller's role as `agent_type`, else the system issue `-1`; `content_json` carries `tool`, `agent`, `task_id`, `args` (only the present `query`, `path`, `id`, `qualified_name`, `name`, `mode`, `depth`, `repo`, `k`, plus `impact` and `source` for `world_model_symbol` and `objective` and `anchors` for `scope_suggest`), `result_count`, `empty`, `error`, `warning`, `match`, `derived`, `latency_ms`. `audit_append` refuses this event" }
];
var KNOWN = new Set(AUDIT_EVENT_TYPES.map((e) => e.type));
var WRITERS = new Map(AUDIT_EVENT_TYPES.map((e) => [e.type, e.writers]));
function isAuditEventType(value) {
  return typeof value === "string" && KNOWN.has(value);
}
function auditEventWriters(type) {
  return WRITERS.get(type) ?? [];
}
function isAuditEventWritableBy(type, writer) {
  return auditEventWriters(type).includes(writer);
}
function assertAuditEventType(value) {
  if (isAuditEventType(value)) return value;
  throw new Error(
    `unknown audit event_type '${String(value)}'. Allowed: ${AUDIT_EVENT_TYPES.map((e) => e.type).join(", ")}`
  );
}

// ../mcp/trajectory-server/src/utils/classify-url.ts
function extractHost(url) {
  const scpMatch = url.match(/^[^@]+@([^:/]+)[:/]/);
  if (scpMatch) return scpMatch[1].toLowerCase();
  try {
    const parsed = new URL(url);
    if (parsed.hostname) return parsed.hostname.toLowerCase();
  } catch {
  }
  return null;
}
function classifyHost(host) {
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host === "gitlab.com" || /(?:^|\.)gitlab\./i.test(host)) return "gitlab";
  if (host === "bitbucket.org" || host.endsWith(".bitbucket.org")) return "bitbucket";
  if (host === "codeberg.org" || host.endsWith(".codeberg.org")) return "codeberg";
  if (host === "dev.azure.com" || host.endsWith(".dev.azure.com")) return "azuredev";
  return "other";
}
function classifyUrl(url) {
  const host = extractHost(url);
  if (!host) return "other";
  return classifyHost(host);
}

// ../mcp/trajectory-server/src/repos/remotes.ts
function remoteProvider(url, declared) {
  const fromHost = classifyUrl(url);
  if (fromHost === "github" || fromHost === "gitlab") return fromHost;
  if (declared === "github" || declared === "gitlab") return declared;
  return "other";
}
function primaryIndex(remotes) {
  if (remotes.length === 0) return -1;
  const origin = remotes.findIndex((r) => r.name === "origin");
  return origin >= 0 ? origin : 0;
}
function parseLegacyRemotes(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${e.message}` };
  }
  let entries2;
  if (Array.isArray(parsed)) {
    entries2 = parsed.map(
      (e) => e !== null && typeof e === "object" ? {
        name: e["name"],
        url: e["url"],
        provider: e["provider"]
      } : { name: void 0, url: void 0, provider: void 0 }
    );
  } else if (parsed !== null && typeof parsed === "object") {
    entries2 = Object.entries(parsed).map(([name, url]) => ({ name, url, provider: void 0 }));
  } else {
    return { ok: false, reason: `expected an array or an object, got ${parsed === null ? "null" : typeof parsed}` };
  }
  const remotes = [];
  const seen = /* @__PURE__ */ new Set();
  let dropped = 0;
  entries2.forEach((e, i) => {
    if (typeof e.url !== "string") {
      dropped++;
      return;
    }
    const name = typeof e.name === "string" && e.name.trim() !== "" ? e.name.trim() : i === 0 ? "origin" : `remote-${i}`;
    if (seen.has(name)) {
      dropped++;
      return;
    }
    seen.add(name);
    remotes.push({ name, url: e.url.trim(), provider: typeof e.provider === "string" ? e.provider : null });
  });
  return { ok: true, entries: remotes, dropped };
}
function toRemote(r) {
  return { name: r.name, provider: r.provider, url: r.url, is_primary: r.is_primary === 1, sync: r.sync === 1 };
}
function repoRemotes(db, repo) {
  return db.all(
    `SELECT name, provider, url, is_primary, sync FROM repo_remotes WHERE repo = ? ORDER BY is_primary DESC, rowid`,
    [repo]
  ).map(toRemote);
}
function syncRemotes(db, repo) {
  return db.all(
    `SELECT name, provider, url, is_primary, sync FROM repo_remotes WHERE repo = ? AND sync = 1 ORDER BY is_primary DESC, rowid`,
    [repo]
  ).map(toRemote);
}

// ../mcp/trajectory-server/src/utils/test-paths.ts
var TEST_SEGMENTS = /* @__PURE__ */ new Set(["test", "tests", "__tests__", "spec", "e2e", "fixtures"]);
var TEST_BASENAMES = [
  /\.(?:test|spec|suite)\./,
  /_test\.go$/,
  /^test_.*\.py$/,
  /_test\.py$/,
  /_spec\.rb$/,
  /^conftest\.py$/
];
function segmentsOf(path) {
  return path.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
}
function isTestBasename(path) {
  const base = segmentsOf(path).at(-1) ?? "";
  return TEST_BASENAMES.some((re) => re.test(base));
}
function isDefaultTestPath(path) {
  return segmentsOf(path).slice(0, -1).some((s) => TEST_SEGMENTS.has(s)) || isTestBasename(path);
}
function isGlobList(value) {
  return Array.isArray(value) && value.every((el) => typeof el === "string" && el.trim().length > 0);
}
function isTestLaneConfig(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { extend, exclude, ...rest } = value;
  return Object.keys(rest).length === 0 && (extend === void 0 || isGlobList(extend)) && (exclude === void 0 || isGlobList(exclude));
}
var activeClassifier = isDefaultTestPath;
function isTestPath(path) {
  return activeClassifier(path);
}

// ../mcp/trajectory-server/src/db.ts
var TARGET_SCHEMA_VERSION = 72;
var BUSY_TIMEOUT_MS = 5e3;
function resolvePluginName(env = process.env) {
  return resolveClaudePluginName(env);
}
function resolvePluginVersion(env = process.env) {
  return resolveClaudePluginVersion(env);
}
var TrajectoryDB = class {
  db;
  pluginVersion;
  serverLog;
  sqlLog;
  migrate;
  dbPath;
  /**
   * True when the DB opened with user tables present but NO plugin_meta table
   * (a pre-stamp legacy shape that predates schema versioning). Such a DB is
   * adopted forward (its tables are kept; the schema is reapplied) rather than
   * treated as a clean fresh install — but the ambiguity is surfaced as a
   * degraded signal so the upgrade is not silent. Non-fatal.
   */
  legacyNoPluginMeta = false;
  constructor(dbPath, dependencies, options = {}) {
    const resolvedDependencies = resolveDependencies(dependencies);
    this.dbPath = dbPath;
    this.pluginVersion = resolvedDependencies.pluginVersion;
    this.serverLog = resolvedDependencies.serverLog;
    this.sqlLog = resolvedDependencies.sqlLog;
    this.migrate = options.migrate === true;
    this.db = new DatabaseSync2(dbPath);
    try {
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      if (!this.migrate) this.refuseUnsupportedVersionBeforeWrite();
      execRetryingLockUpgrade(this.db, "PRAGMA journal_mode = WAL");
      this.legacyNoPluginMeta = this.applySchema();
    } catch (error) {
      try {
        this.db.close();
      } catch {
      }
      throw error;
    }
  }
  /**
   * A non-migrating opener refuses an older or newer schema before anything
   * writes: the WAL switch rewrites the header of a rollback-journal DB, so
   * the version is read first and the refusal leaves the file byte-identical.
   * applySchemaLocked repeats the check under the write lock.
   */
  refuseUnsupportedVersionBeforeWrite() {
    const pluginMetaExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_meta'").get();
    if (pluginMetaExists === void 0) return;
    const versionRow = this.db.prepare("SELECT schema_version FROM plugin_meta LIMIT 1").get();
    if (versionRow !== void 0) assertOpenableVersion(versionRow.schema_version, false);
  }
  /**
   * Applies schema.sql, migrating first when the stored version is behind, and
   * stamps the plugin version — all under one BEGIN IMMEDIATE so concurrent
   * cold starts serialise: the first process migrates, the rest re-read the
   * version inside the lock and find it current. Table-rebuild migrations need
   * foreign_keys OFF, and the pragma is a no-op inside a transaction, so it is
   * switched off around the lock (the Django SQLite schema-editor pattern);
   * each rebuild still runs its own foreign_key_check before it is released.
   */
  applySchema() {
    const schemaDir = dirname2(fileURLToPath(import.meta.url));
    const sql = readFileSync3(join5(schemaDir, "schema.sql"), "utf8");
    this.db.exec("PRAGMA foreign_keys = OFF");
    let outcome;
    try {
      outcome = withImmediateTransaction(this.db, () => {
        const applied = this.applySchemaLocked(sql, schemaDir);
        this.syncPluginVersion();
        this.syncBuiltinVersions();
        return applied;
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    if (outcome.migratedFrom !== null) {
      this.serverLog({
        kind: "schema_migrated",
        level: "info",
        db_path: this.dbPath,
        from_version: outcome.migratedFrom,
        to_version: TARGET_SCHEMA_VERSION
      });
    }
    return outcome.isLegacy;
  }
  applySchemaLocked(sql, schemaDir) {
    const applyEvalIfNeeded = () => {
      if (process.env["TMB_EVAL_MODE"] === "1") {
        const evalSql = readFileSync3(join5(schemaDir, "schema-eval.sql"), "utf8");
        this.db.exec(evalSql);
      }
    };
    const verifySeed = () => {
      const row2 = this.db.prepare("SELECT schema_version FROM plugin_meta LIMIT 1").get();
      if (row2 === void 0) {
        throw new Error(
          "TrajectoryDB: schema applied but plugin_meta has no rows \u2014 verify schema.sql seeds it."
        );
      }
    };
    const pluginMetaExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_meta'").get();
    if (pluginMetaExists === void 0) {
      const userTableCount = this.db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).get();
      const isLegacy = userTableCount.n > 0;
      if (isLegacy) {
        this.serverLog({
          kind: "legacy_db_no_plugin_meta",
          level: "warn",
          db_path: this.dbPath,
          existing_tables: userTableCount.n,
          message: "TrajectoryDB: opened a DB with tables but no plugin_meta row (pre-stamp legacy shape). Adopting it forward and stamping schema_version \u2014 verify the upgrade and back up if unsure."
        });
      }
      this.db.exec(sql);
      applyEvalIfNeeded();
      verifySeed();
      return { isLegacy, migratedFrom: null };
    }
    const versionRow = this.db.prepare("SELECT schema_version FROM plugin_meta LIMIT 1").get();
    if (versionRow === void 0) {
      this.db.exec(sql);
      applyEvalIfNeeded();
      verifySeed();
      return { isLegacy: false, migratedFrom: null };
    }
    const storedVersion = versionRow.schema_version;
    assertOpenableVersion(storedVersion, this.migrate);
    if (storedVersion < TARGET_SCHEMA_VERSION) {
      backupDbBeforeMigration(this.dbPath, TARGET_SCHEMA_VERSION);
      runMigrations(this.db, storedVersion, TARGET_SCHEMA_VERSION);
      this.db.exec(sql);
      this.db.prepare("UPDATE plugin_meta SET schema_version = ? WHERE id = 1").run(TARGET_SCHEMA_VERSION);
      applyEvalIfNeeded();
      verifySeed();
      return { isLegacy: false, migratedFrom: storedVersion };
    }
    this.db.exec(sql);
    applyEvalIfNeeded();
    verifySeed();
    return { isLegacy: false, migratedFrom: null };
  }
  /**
   * Runs inside applySchema's BEGIN IMMEDIATE, so the write lock is already
   * held (acquired under busy_timeout) and the UPDATE cannot hit SQLITE_BUSY.
   * Any failure is logged and fails the open rather than passing as success.
   */
  syncPluginVersion() {
    if (!this.pluginVersion) return;
    this.runVersionSync("plugin_meta", `UPDATE plugin_meta SET plugin_version = ? WHERE id = 1`);
  }
  /**
   * Backfill the builtin cheatcodes' `version` to the plugin version (#111).
   * The schema-seed (schema.sql) and the v19→v20 migration both insert builtin
   * skill rows with version NULL — the SKILL.md body is the source of truth, but
   * the registry row should still record which plugin version shipped it so
   * cheatcode_list surfaces a version for every row. Runs every startup against
   * the resolved plugin version; a no-op when the version is unresolvable.
   */
  syncBuiltinVersions() {
    if (!this.pluginVersion) return;
    this.runVersionSync("cheatcodes", `UPDATE cheatcodes SET version = ? WHERE origin = 'builtin'`);
  }
  runVersionSync(target, sql) {
    try {
      this.db.prepare(sql).run(this.pluginVersion);
    } catch (err4) {
      this.serverLog({
        kind: "plugin_version_sync_failed",
        level: "error",
        db_path: this.dbPath,
        target,
        plugin_version: this.pluginVersion,
        message: err4 instanceof Error ? err4.message : String(err4)
      });
      throw err4;
    }
  }
  run(sql, params) {
    const start = performance2.now();
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(...params ?? []);
      const out = { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      this.sqlLog({
        kind: "run",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start),
        rows_affected: out.changes,
        ok: true
      });
      return out;
    } catch (err4) {
      this.sqlLog({
        kind: "run",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start),
        ok: false,
        error_message: err4 instanceof Error ? err4.message : String(err4)
      });
      throw err4;
    }
  }
  get(sql, params) {
    const start = performance2.now();
    try {
      const stmt = this.db.prepare(sql);
      const row2 = stmt.get(...params ?? []);
      this.sqlLog({
        kind: "get",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start),
        row_count: row2 === void 0 ? 0 : 1,
        ok: true
      });
      return row2;
    } catch (err4) {
      this.sqlLog({
        kind: "get",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start),
        ok: false,
        error_message: err4 instanceof Error ? err4.message : String(err4)
      });
      throw err4;
    }
  }
  all(sql, params) {
    const start = performance2.now();
    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params ?? []);
      this.sqlLog({
        kind: "all",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start),
        row_count: rows.length,
        ok: true
      });
      return rows;
    } catch (err4) {
      this.sqlLog({
        kind: "all",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start),
        ok: false,
        error_message: err4 instanceof Error ? err4.message : String(err4)
      });
      throw err4;
    }
  }
  /**
   * Wraps `fn` in a BEGIN IMMEDIATE transaction (a SAVEPOINT when nested).
   * node:sqlite has no `db.transaction(fn)` helper, so BEGIN/COMMIT/ROLLBACK
   * are issued explicitly.
   */
  transaction(fn) {
    return withImmediateTransaction(this.db, fn);
  }
  get isOpen() {
    return this.db.isOpen;
  }
  close() {
    this.db.close();
  }
};
function resolveDependencies(dependencies) {
  if (dependencies === void 0) {
    return {
      pluginVersion: resolvePluginVersion(process.env),
      serverLog: noThrowTrajectoryLog(serverLog),
      sqlLog: noThrowTrajectoryLog(sqlLog)
    };
  }
  if (dependencies.pluginVersion !== null && (typeof dependencies.pluginVersion !== "string" || dependencies.pluginVersion.trim().length === 0)) {
    throw new TypeError(
      "TrajectoryDB dependencies.pluginVersion must be a non-empty string or null"
    );
  }
  if (typeof dependencies.serverLog !== "function") {
    throw new TypeError("TrajectoryDB dependencies.serverLog must be a function");
  }
  if (typeof dependencies.sqlLog !== "function") {
    throw new TypeError("TrajectoryDB dependencies.sqlLog must be a function");
  }
  return {
    pluginVersion: dependencies.pluginVersion,
    serverLog: noThrowTrajectoryLog(dependencies.serverLog),
    sqlLog: noThrowTrajectoryLog(dependencies.sqlLog)
  };
}
function noThrowTrajectoryLog(log) {
  return (entry) => {
    try {
      log(entry);
    } catch {
    }
  };
}
function nowISO() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
var transactionDepth = /* @__PURE__ */ new WeakMap();
var SQLITE_BUSY = 5;
var backoffCell = new Int32Array(new SharedArrayBuffer(4));
function isBusyError(err4) {
  if (!(err4 instanceof Error)) return false;
  const errcode = err4.errcode;
  return typeof errcode === "number" && (errcode & 255) === SQLITE_BUSY || err4.message.includes("database is locked");
}
function assertOpenableVersion(storedVersion, migrate) {
  if (storedVersion > TARGET_SCHEMA_VERSION) {
    throw new Error(
      `TrajectoryDB: stored schema_version ${storedVersion} is newer than code's max ${TARGET_SCHEMA_VERSION}; downgrade not supported. Use a newer plugin version, or restore the .bak file from before the upgrade.`
    );
  }
  if (storedVersion < TARGET_SCHEMA_VERSION && !migrate) {
    throw new Error(
      `TrajectoryDB: schema v${storedVersion} is older than this code's v${TARGET_SCHEMA_VERSION}; only the trajectory-server migrates the DB. Open a Claude Code session to upgrade it, or point TRAJECTORY_DB_PATH at a copy.`
    );
  }
}
function execRetryingLockUpgrade(db, sql) {
  const deadline = performance2.now() + BUSY_TIMEOUT_MS;
  for (; ; ) {
    try {
      db.exec(sql);
      return;
    } catch (err4) {
      if (!isBusyError(err4) || performance2.now() >= deadline) throw err4;
      Atomics.wait(backoffCell, 0, 0, 5 + Math.random() * 45);
    }
  }
}
function beginImmediate(db) {
  const depth = transactionDepth.get(db) ?? 0;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT tmb_tx_${depth}`);
  transactionDepth.set(db, depth + 1);
}
function commitTransaction(db) {
  const depth = (transactionDepth.get(db) ?? 1) - 1;
  db.exec(depth === 0 ? "COMMIT" : `RELEASE tmb_tx_${depth}`);
  transactionDepth.set(db, depth);
}
function rollbackTransaction(db) {
  const depth = (transactionDepth.get(db) ?? 1) - 1;
  transactionDepth.set(db, depth);
  db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO tmb_tx_${depth}; RELEASE tmb_tx_${depth}`);
}
function withImmediateTransaction(db, fn) {
  beginImmediate(db);
  try {
    const result = fn();
    commitTransaction(db);
    return result;
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function backupDbBeforeMigration(dbPath, targetVersion) {
  if (!dbPath || dbPath === ":memory:") return;
  const dir = dirname2(dbPath);
  const base = basename2(dbPath);
  const prefix = `${base}.pre-v${targetVersion}.`;
  try {
    const existing = readdirSync2(dir).some(
      (f) => f.startsWith(prefix) && f.endsWith(".bak")
    );
    if (existing) return;
  } catch {
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.pre-v${targetVersion}.${timestamp}.bak`;
  const snapshot = new DatabaseSync2(dbPath);
  try {
    snapshot.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    snapshot.prepare("VACUUM INTO ?").run(backupPath);
  } finally {
    snapshot.close();
  }
}
function runMigrations(db, fromVersion, toVersion) {
  if (fromVersion < 2 && toVersion >= 2) {
    migrateV1toV2(db);
  }
  if (fromVersion < 3 && toVersion >= 3) {
    migrateV2toV3(db);
  }
  if (fromVersion < 4 && toVersion >= 4) {
    migrateV3toV4(db);
  }
  if (fromVersion < 5 && toVersion >= 5) {
    migrateV4toV5(db);
  }
  if (fromVersion < 6 && toVersion >= 6) {
    migrateV5toV6(db);
  }
  if (fromVersion < 7 && toVersion >= 7) {
    migrateV6toV7(db);
  }
  if (fromVersion < 8 && toVersion >= 8) {
    migrateV7toV8(db);
  }
  if (fromVersion < 9 && toVersion >= 9) {
    migrateV8toV9(db);
  }
  if (fromVersion < 10 && toVersion >= 10) {
    migrateV9toV10(db);
  }
  if (fromVersion < 11 && toVersion >= 11) {
    migrateV10toV11(db);
  }
  if (fromVersion < 12 && toVersion >= 12) {
    migrateV11toV12(db);
  }
  if (fromVersion < 13 && toVersion >= 13) {
    migrateV12toV13(db);
  }
  if (fromVersion < 14 && toVersion >= 14) {
    migrateV13toV14(db);
  }
  if (fromVersion < 15 && toVersion >= 15) {
    migrateV14toV15(db);
  }
  if (fromVersion < 16 && toVersion >= 16) {
    migrateV15toV16(db);
  }
  if (fromVersion < 17 && toVersion >= 17) {
    migrateV16toV17(db);
  }
  if (fromVersion < 18 && toVersion >= 18) {
    migrateV17toV18(db);
  }
  if (fromVersion < 19 && toVersion >= 19) {
    migrateV18toV19(db);
  }
  if (fromVersion < 20 && toVersion >= 20) {
    migrateV19toV20(db);
  }
  if (fromVersion < 21 && toVersion >= 21) {
    migrateV20toV21(db);
  }
  if (fromVersion < 22 && toVersion >= 22) {
    migrateV21toV22(db);
  }
  if (fromVersion < 23 && toVersion >= 23) {
    migrateV22toV23(db);
  }
  if (fromVersion < 24 && toVersion >= 24) {
    migrateV23toV24(db);
  }
  if (fromVersion < 25 && toVersion >= 25) {
    migrateV24toV25(db);
  }
  if (fromVersion < 26 && toVersion >= 26) {
    migrateV25toV26(db);
  }
  if (fromVersion < 27 && toVersion >= 27) {
    migrateV26toV27(db);
  }
  if (fromVersion < 28 && toVersion >= 28) {
    migrateV27toV28(db);
  }
  if (fromVersion < 29 && toVersion >= 29) {
    migrateV28toV29(db);
  }
  if (fromVersion < 30 && toVersion >= 30) {
    migrateV29toV30(db);
  }
  if (fromVersion < 31 && toVersion >= 31) {
    migrateV30toV31(db);
  }
  if (fromVersion < 32 && toVersion >= 32) {
    migrateV31toV32(db);
  }
  if (fromVersion < 33 && toVersion >= 33) {
    migrateV32toV33(db);
  }
  if (fromVersion < 34 && toVersion >= 34) {
    migrateV33toV34(db);
  }
  if (fromVersion < 35 && toVersion >= 35) {
    migrateV34toV35(db);
  }
  if (fromVersion < 36 && toVersion >= 36) {
    migrateV35toV36(db);
  }
  if (fromVersion < 37 && toVersion >= 37) {
    migrateV36toV37(db);
  }
  if (fromVersion < 38 && toVersion >= 38) {
    migrateV37toV38(db);
  }
  if (fromVersion < 39 && toVersion >= 39) {
    migrateV38toV39(db);
  }
  if (fromVersion < 40 && toVersion >= 40) {
    migrateV39toV40(db);
  }
  if (fromVersion < 41 && toVersion >= 41) {
    migrateV40toV41(db);
  }
  if (fromVersion < 42 && toVersion >= 42) {
    migrateV41toV42(db);
  }
  if (fromVersion < 43 && toVersion >= 43) {
    migrateV42toV43(db);
  }
  if (fromVersion < 44 && toVersion >= 44) {
    migrateV43toV44(db);
  }
  if (fromVersion < 45 && toVersion >= 45) {
    migrateV44toV45(db);
  }
  if (fromVersion < 46 && toVersion >= 46) {
    migrateV45toV46(db);
  }
  if (fromVersion < 47 && toVersion >= 47) {
    migrateV46toV47(db);
  }
  if (fromVersion < 48 && toVersion >= 48) {
    migrateV47toV48(db);
  }
  if (fromVersion < 49 && toVersion >= 49) {
    migrateV48toV49(db);
  }
  if (fromVersion < 50 && toVersion >= 50) {
    migrateV49toV50(db);
  }
  if (fromVersion < 51 && toVersion >= 51) {
    migrateV50toV51(db);
  }
  if (fromVersion < 52 && toVersion >= 52) {
    migrateV51toV52(db);
  }
  if (fromVersion < 53 && toVersion >= 53) {
    migrateV52toV53(db);
  }
  if (fromVersion < 54 && toVersion >= 54) {
    migrateV53toV54(db);
  }
  if (fromVersion < 55 && toVersion >= 55) {
    migrateV54toV55(db);
  }
  if (fromVersion < 56 && toVersion >= 56) {
    migrateV55toV56(db);
  }
  if (fromVersion < 57 && toVersion >= 57) {
    migrateV56toV57(db);
  }
  if (fromVersion < 58 && toVersion >= 58) {
    migrateV57toV58(db);
  }
  if (fromVersion < 59 && toVersion >= 59) {
    migrateV58toV59(db);
  }
  if (fromVersion < 60 && toVersion >= 60) {
    migrateV59toV60(db);
  }
  if (fromVersion < 61 && toVersion >= 61) migrateV60toV61(db);
  if (fromVersion < 62 && toVersion >= 62) migrateV61toV62(db);
  if (fromVersion < 63 && toVersion >= 63) migrateV62toV63(db);
  if (fromVersion < 64 && toVersion >= 64) migrateV63toV64(db);
  if (fromVersion < 65 && toVersion >= 65) migrateV64toV65(db);
  if (fromVersion < 66 && toVersion >= 66) migrateV65toV66(db);
  if (fromVersion < 67 && toVersion >= 67) migrateV66toV67(db);
  if (fromVersion < 68 && toVersion >= 68) migrateV67toV68(db);
  if (fromVersion < 69 && toVersion >= 69) migrateV68toV69(db);
  if (fromVersion < 70 && toVersion >= 70) migrateV69toV70(db);
  if (fromVersion < 71 && toVersion >= 71) migrateV70toV71(db);
  if (fromVersion < 72 && toVersion >= 72) migrateV71toV72(db);
}
function deleteBuiltinCheatcodeAttachments(db, name) {
  if (!tableExists(db, "cheatcode_attachments")) return;
  db.prepare(
    // LINT-ALLOW: mirrors the ON DELETE CASCADE that foreign_keys OFF suppresses during migration (GH 1624).
    `DELETE FROM cheatcode_attachments
      WHERE cheatcode_id IN (SELECT id FROM cheatcodes WHERE name = ? AND origin = 'builtin')`
  ).run(name);
}
function hasColumn(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}
function tableExists(db, table) {
  const row2 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row2 !== void 0;
}
function readTableSql(db, table) {
  const row2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row2?.sql ?? "";
}
function rebuildTable(db, table, createBody, columns) {
  const scratch = `${table}_new`;
  const select = columns.map(([name, fallback]) => hasColumn(db, table, name) ? name : `${fallback} AS ${name}`).join(", ");
  const seqRow = tableExists(db, "sqlite_sequence") ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) : void 0;
  db.exec(`DROP TABLE IF EXISTS ${scratch}`);
  db.exec(`CREATE TABLE ${scratch} (${createBody})`);
  db.exec(
    `INSERT INTO ${scratch} (${columns.map(([name]) => name).join(", ")}) SELECT ${select} FROM ${table}`
  );
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${scratch} RENAME TO ${table}`);
  if (seqRow !== void 0) {
    db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?").run(seqRow.seq, table);
  }
}
function migrateV8toV9(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs")) {
      if (!hasColumn(db, "agent_runs", "cache_read_tokens")) {
        db.exec("ALTER TABLE agent_runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0");
      }
      if (!hasColumn(db, "agent_runs", "cache_creation_tokens")) {
        db.exec("ALTER TABLE agent_runs ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0");
      }
    }
    if (tableExists(db, "pr_review_runs")) {
      if (!hasColumn(db, "pr_review_runs", "task_id")) {
        db.exec("ALTER TABLE pr_review_runs ADD COLUMN task_id INTEGER REFERENCES tasks(id)");
      }
      if (!hasColumn(db, "pr_review_runs", "verdict")) {
        db.exec("ALTER TABLE pr_review_runs ADD COLUMN verdict TEXT");
      }
      if (!hasColumn(db, "pr_review_runs", "attempt_n")) {
        db.exec("ALTER TABLE pr_review_runs ADD COLUMN attempt_n INTEGER");
      }
      db.exec("DROP INDEX IF EXISTS idx_pr_review_runs_pr");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_review_runs_pr ON pr_review_runs(pr_number, repo) WHERE pr_number > 0"
      );
      const taskIdxExists = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pr_review_runs_task'").get();
      if (!taskIdxExists) {
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_pr_review_runs_task ON pr_review_runs(task_id)"
        );
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV9toV10(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "tasks")) {
      if (!hasColumn(db, "tasks", "prompt_bearing")) {
        db.exec("ALTER TABLE tasks ADD COLUMN prompt_bearing INTEGER NOT NULL DEFAULT 0");
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV10toV11(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "repos")) {
      if (!hasColumn(db, "repos", "target_branch")) {
        db.exec("ALTER TABLE repos ADD COLUMN target_branch TEXT");
      }
      if (!hasColumn(db, "repos", "branching_model")) {
        db.exec("ALTER TABLE repos ADD COLUMN branching_model TEXT");
      }
      if (!hasColumn(db, "repos", "protected_branches")) {
        db.exec("ALTER TABLE repos ADD COLUMN protected_branches TEXT");
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV11toV12(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs")) {
      if (!hasColumn(db, "agent_runs", "usage_baseline_json")) {
        db.exec("ALTER TABLE agent_runs ADD COLUMN usage_baseline_json TEXT");
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV12toV13(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "tasks")) {
      if (!hasColumn(db, "tasks", "files")) {
        db.exec("ALTER TABLE tasks ADD COLUMN files TEXT NOT NULL DEFAULT '[]'");
      }
      if (!hasColumn(db, "tasks", "verification")) {
        db.exec("ALTER TABLE tasks ADD COLUMN verification TEXT NOT NULL DEFAULT '[]'");
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV13toV14(db) {
  beginImmediate(db);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cheatcodes (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          source_url   TEXT    NOT NULL,
          version      TEXT,
          trust_tier   TEXT,
          status       TEXT    NOT NULL DEFAULT 'installed',
          installed_at TEXT    NOT NULL,
          UNIQUE(name, source_url)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cheatcode_attachments (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          cheatcode_id INTEGER NOT NULL REFERENCES cheatcodes(id) ON DELETE CASCADE,
          target       TEXT    NOT NULL,
          artifact     TEXT    NOT NULL,
          created_at   TEXT    NOT NULL
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_cheatcode_attachments_cheatcode ON cheatcode_attachments(cheatcode_id)"
    );
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV14toV15(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "cheatcodes") && !hasColumn(db, "cheatcodes", "scope")) {
      db.exec("ALTER TABLE cheatcodes ADD COLUMN scope TEXT NOT NULL DEFAULT 'local'");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV15toV16(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS rule_invocations");
    db.exec("DROP TABLE IF EXISTS rules");
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV16toV17(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS commands");
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV17toV18(db) {
  if (!tableExists(db, "skills") || !(hasColumn(db, "skills", "uses") || hasColumn(db, "skills", "successes") || hasColumn(db, "skills", "effectiveness"))) {
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS skills_new");
    db.exec(`
      CREATE TABLE skills_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT    NOT NULL UNIQUE,
          description     TEXT    NOT NULL,
          file_path       TEXT    NOT NULL,
          scope           TEXT    NOT NULL DEFAULT 'global'
                            CHECK (scope IN ('global','template','project-local')),
          trust_tier      TEXT    NOT NULL DEFAULT 'curated',
          status          TEXT    NOT NULL DEFAULT 'active',
          created_at      TEXT    NOT NULL,
          updated_at      TEXT    NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO skills_new (id, name, description, file_path, scope, trust_tier, status, created_at, updated_at)
      SELECT id, name, description, file_path, scope, trust_tier, status, created_at, updated_at FROM skills
    `);
    db.exec("DROP TABLE skills");
    db.exec("ALTER TABLE skills_new RENAME TO skills");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV17toV18: foreign_key_check found ${violations.length} dangling reference(s) after skills rebuild`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV18toV19(db) {
  const skillsPresent = tableExists(db, "skills");
  const cheatcodesUnified = tableExists(db, "cheatcodes") && hasColumn(db, "cheatcodes", "origin");
  if (cheatcodesUnified && !skillsPresent) {
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (!cheatcodesUnified) {
      db.exec("DROP TABLE IF EXISTS cheatcodes_new");
      db.exec(`
        CREATE TABLE cheatcodes_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT    NOT NULL UNIQUE,
            kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
            origin       TEXT    NOT NULL DEFAULT 'installed' CHECK (origin IN ('builtin','installed')),
            description  TEXT    NOT NULL DEFAULT '',
            source_url   TEXT,
            file_path    TEXT,
            version      TEXT,
            trust_tier   TEXT,
            scope        TEXT    NOT NULL DEFAULT 'project-local'
                           CHECK (scope IN ('global','template','project-local')),
            status       TEXT    NOT NULL DEFAULT 'installed',
            installed_at TEXT    NOT NULL,
            created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            CHECK (kind != 'skill' OR file_path IS NOT NULL),
            CHECK (origin != 'installed' OR source_url IS NOT NULL),
            CHECK (origin != 'builtin' OR source_url IS NULL)
        )
      `);
      if (tableExists(db, "cheatcodes")) {
        db.exec(`
          INSERT INTO cheatcodes_new
            (id, name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
          SELECT
            id, name, kind, 'installed', '', source_url, NULL, version, trust_tier,
            CASE scope WHEN 'local' THEN 'project-local' WHEN 'global' THEN 'global' ELSE 'project-local' END,
            status, installed_at, installed_at, installed_at
          FROM cheatcodes
        `);
        db.exec("DROP TABLE cheatcodes");
      }
      db.exec("ALTER TABLE cheatcodes_new RENAME TO cheatcodes");
    }
    if (tableExists(db, "skills")) {
      db.exec(`
        INSERT OR IGNORE INTO cheatcodes
          (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
        SELECT
          name, 'skill', 'builtin', description, NULL, file_path, NULL, trust_tier, scope, status, created_at, created_at, updated_at
        FROM skills
      `);
    }
    if (tableExists(db, "skill_invocations")) {
      const agentRunFk = tableExists(db, "agent_runs") ? " REFERENCES agent_runs(id)" : "";
      const taskFk = tableExists(db, "tasks") ? " REFERENCES tasks(id)" : "";
      db.exec("DROP TABLE IF EXISTS skill_invocations_new");
      db.exec(`
        CREATE TABLE skill_invocations_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            skill_name    TEXT    NOT NULL REFERENCES cheatcodes(name),
            agent_name    TEXT    NOT NULL,
            agent_run_id  INTEGER${agentRunFk},
            task_id       INTEGER${taskFk},
            invoked_at    TEXT    NOT NULL,
            outcome       TEXT    NOT NULL DEFAULT 'completed'
                            CHECK (outcome IN ('completed','failed','partial'))
        )
      `);
      db.exec(`
        INSERT INTO skill_invocations_new (id, skill_name, agent_name, agent_run_id, task_id, invoked_at, outcome)
        SELECT id, skill_name, agent_name, agent_run_id, task_id, invoked_at, outcome FROM skill_invocations
      `);
      db.exec("DROP TABLE skill_invocations");
      db.exec("ALTER TABLE skill_invocations_new RENAME TO skill_invocations");
      db.exec("CREATE INDEX IF NOT EXISTS idx_skill_invocations_skill ON skill_invocations(skill_name)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_skill_invocations_task  ON skill_invocations(task_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_skill_invocations_agent_run ON skill_invocations(agent_run_id)");
    }
    db.exec("DROP TABLE IF EXISTS skills");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV18toV19: foreign_key_check found ${violations.length} dangling reference(s) after the skills\u2192cheatcodes unification`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV19toV20(db) {
  if (!tableExists(db, "cheatcodes")) {
    return;
  }
  beginImmediate(db);
  try {
    deleteBuiltinCheatcodeAttachments(db, "tmb_agent-creator");
    db.exec("DELETE FROM cheatcodes WHERE name = 'tmb_agent-creator' AND origin = 'builtin'");
    db.exec(`
      INSERT OR IGNORE INTO cheatcodes
        (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
      VALUES
        ('tmb_cheatcode', 'skill', 'builtin',
         'When bro hits a wall \u2014 a task leans on a capability the project lacks and a published skill / MCP toolkit / plugin would close the gap \u2014 name the gap, cheatcode_search for ranked candidates, judge the best fit, and recommend it for Human approval.',
         NULL, 'skills/tmb_cheatcode/SKILL.md', NULL, 'curated', 'global', 'active',
         datetime('now'), datetime('now'), datetime('now'))
    `);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV19toV20: foreign_key_check found ${violations.length} dangling reference(s) after the builtin-skill seed correction`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV20toV21(db) {
  db.exec("DROP TABLE IF EXISTS skill_invocations");
}
function migrateV21toV22(db) {
  if (tableExists(db, "issues") && !hasColumn(db, "issues", "milestone")) {
    db.exec("ALTER TABLE issues ADD COLUMN milestone TEXT");
  }
}
function migrateV27toV28(db) {
  if (tableExists(db, "issues") && !hasColumn(db, "issues", "labels")) {
    db.exec("ALTER TABLE issues ADD COLUMN labels TEXT");
  }
}
function migrateV28toV29(db) {
  const tableSql = (table) => readTableSql(db, table);
  const needsRebuild = (table, checkMarker, droppedColumn) => tableExists(db, table) && (droppedColumn !== void 0 && hasColumn(db, table, droppedColumn) || !tableSql(table).includes(checkMarker));
  const rebuild = (table, createBody, columns) => rebuildTable(db, table, createBody, columns);
  const TASK_STATUSES = "'pending','running','needs_validation','completed','closed','failed','escalated'";
  const OPEN_CLOSED = "'open','closed'";
  const VERDICTS = "'pass','fail','escalate'";
  const DISCUSSION_KINDS = "'intent','question','answer','decision','note','analysis'";
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (tableExists(db, "pr_review_runs")) {
      db.exec("DELETE FROM pr_review_runs WHERE pr_number = 0");
    }
    const probes = [
      ["tasks", "status", `status NOT IN (${TASK_STATUSES})`],
      ["issues", "status", `status NOT IN (${OPEN_CLOSED})`],
      ["validation_attempts", "verdict", `verdict NOT IN (${VERDICTS})`],
      ["validation_attempts", "mcp_available", "mcp_available IS NULL"],
      ["discussions", "kind", `kind NOT IN (${DISCUSSION_KINDS})`],
      ["milestones", "state", `state NOT IN (${OPEN_CLOSED})`],
      ["pr_review_runs", "pr_number", "pr_number IS NULL OR pr_number <= 0"],
      ["pr_review_runs", "repo", "repo IS NULL OR repo = ''"]
    ];
    const violations = [];
    for (const [table, column, predicate] of probes) {
      if (!tableExists(db, table) || !hasColumn(db, table, column)) continue;
      const bad = db.prepare(`SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${predicate} LIMIT 20`).all();
      if (bad.length > 0) {
        violations.push(`${table}.${column} = ${bad.map((r) => JSON.stringify(r.v)).join(", ")}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `migrateV28toV29: rows violate the new v29 constraints \u2014 fix or delete them, then reopen: ${violations.join("; ")}`
      );
    }
    if (needsRebuild("tasks", "CHECK (status IN", "attempts")) {
      rebuild(
        "tasks",
        `
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id          INTEGER NOT NULL REFERENCES issues(id),
          branch_id         TEXT    NOT NULL,
          parent_branch_id  TEXT,
          title             TEXT    NOT NULL DEFAULT '',
          description       TEXT    NOT NULL,
          status            TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN (${TASK_STATUSES})),
          spec_body         TEXT    NOT NULL DEFAULT '',
          commit_sha        TEXT,
          repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          prompt_bearing    INTEGER NOT NULL DEFAULT 0,
          files             TEXT    NOT NULL DEFAULT '[]',
          verification      TEXT    NOT NULL DEFAULT '[]',
          created_at        TEXT    NOT NULL,
          updated_at        TEXT    NOT NULL,
          completed_at      TEXT
        `,
        [
          ["id", "NULL"],
          ["issue_id", "NULL"],
          ["branch_id", "NULL"],
          ["parent_branch_id", "NULL"],
          ["title", "''"],
          ["description", "''"],
          ["status", "'pending'"],
          ["spec_body", "''"],
          ["commit_sha", "NULL"],
          ["repo", "NULL"],
          ["prompt_bearing", "0"],
          ["files", "'[]'"],
          ["verification", "'[]'"],
          ["created_at", "NULL"],
          ["updated_at", "NULL"],
          ["completed_at", "NULL"]
        ]
      );
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id)");
    }
    if (needsRebuild("issues", "CHECK (status IN", "remote_iid")) {
      if (hasColumn(db, "issues", "remote_iid")) {
        db.exec(
          "UPDATE issues SET gh_iid = remote_iid WHERE remote_kind = 'github' AND remote_iid IS NOT NULL AND gh_iid IS NULL"
        );
        db.exec(
          "UPDATE issues SET gl_iid = remote_iid WHERE remote_kind = 'gitlab' AND remote_iid IS NOT NULL AND gl_iid IS NULL"
        );
      }
      rebuild(
        "issues",
        `
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          objective         TEXT    NOT NULL,
          description       TEXT    NOT NULL DEFAULT '',
          status            TEXT    NOT NULL DEFAULT 'open' CHECK (status IN (${OPEN_CLOSED})),
          created_at        TEXT    NOT NULL,
          updated_at        TEXT    NOT NULL,
          closed_at         TEXT,
          remote_kind       TEXT CHECK(remote_kind IN ('github','gitlab')),
          gh_iid            INTEGER,
          gl_iid            INTEGER,
          repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          milestone         TEXT,
          labels            TEXT,
          FOREIGN KEY (milestone, repo) REFERENCES milestones(name, repo) ON DELETE RESTRICT
        `,
        [
          ["id", "NULL"],
          ["objective", "''"],
          ["description", "''"],
          ["status", "'open'"],
          ["created_at", "NULL"],
          ["updated_at", "NULL"],
          ["closed_at", "NULL"],
          ["remote_kind", "NULL"],
          ["gh_iid", "NULL"],
          ["gl_iid", "NULL"],
          ["repo", "NULL"],
          ["milestone", "NULL"],
          ["labels", "NULL"]
        ]
      );
    }
    if (needsRebuild("validation_attempts", "CHECK (verdict IN")) {
      rebuild(
        "validation_attempts",
        `
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id             INTEGER NOT NULL REFERENCES tasks(id),
          attempt_n           INTEGER NOT NULL,
          agent               TEXT    NOT NULL DEFAULT '',
          verdict             TEXT    NOT NULL CHECK (verdict IN (${VERDICTS})),
          feedback            TEXT    NOT NULL DEFAULT '',
          mcp_available       INTEGER NOT NULL,
          subagent_session_id TEXT,
          repo                TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          created_at          TEXT    NOT NULL,
          UNIQUE(task_id, attempt_n)
        `,
        [
          ["id", "NULL"],
          ["task_id", "NULL"],
          ["attempt_n", "NULL"],
          ["agent", "''"],
          ["verdict", "NULL"],
          ["feedback", "''"],
          ["mcp_available", "1"],
          ["subagent_session_id", "NULL"],
          ["repo", "NULL"],
          ["created_at", "NULL"]
        ]
      );
    }
    if (needsRebuild("discussions", "CHECK (kind IN")) {
      const embeddingsCount = () => tableExists(db, "discussions_embeddings") ? db.prepare("SELECT COUNT(*) AS n FROM discussions_embeddings").get().n : 0;
      const embeddingsBefore = embeddingsCount();
      rebuild(
        "discussions",
        `
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id       INTEGER NOT NULL REFERENCES issues(id),
          author         TEXT    NOT NULL,
          kind           TEXT    NOT NULL DEFAULT 'note'
                           CHECK (kind IN (${DISCUSSION_KINDS})),
          body           TEXT    NOT NULL,
          repo           TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          created_at     TEXT    NOT NULL
        `,
        [
          ["id", "NULL"],
          ["issue_id", "NULL"],
          ["author", "''"],
          ["kind", "'note'"],
          ["body", "''"],
          ["repo", "NULL"],
          ["created_at", "NULL"]
        ]
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_discussions_issue_created ON discussions(issue_id, created_at)"
      );
      if (tableExists(db, "discussions_fts")) {
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS discussions_ai AFTER INSERT ON discussions BEGIN
            INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
          END;
          CREATE TRIGGER IF NOT EXISTS discussions_ad AFTER DELETE ON discussions BEGIN
            INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
          END;
          CREATE TRIGGER IF NOT EXISTS discussions_au AFTER UPDATE ON discussions BEGIN
            INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
            INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
          END;
        `);
        db.exec("INSERT INTO discussions_fts(discussions_fts) VALUES('rebuild')");
      }
      const embeddingsAfter = embeddingsCount();
      if (embeddingsAfter !== embeddingsBefore) {
        throw new Error(
          `migrateV28toV29: discussions_embeddings changed from ${embeddingsBefore} to ${embeddingsAfter} rows across the discussions rebuild`
        );
      }
    }
    if (needsRebuild("milestones", "CHECK (state IN")) {
      rebuild(
        "milestones",
        `
          name   TEXT NOT NULL,
          repo   TEXT NOT NULL REFERENCES repos(name) ON DELETE RESTRICT,
          state  TEXT NOT NULL DEFAULT 'open' CHECK (state IN (${OPEN_CLOSED})),
          PRIMARY KEY (name, repo)
        `,
        [["name", "NULL"], ["repo", "NULL"], ["state", "'open'"]]
      );
    }
    if (tableExists(db, "agents") && hasColumn(db, "agents", "status")) {
      db.exec("ALTER TABLE agents DROP COLUMN status");
    }
    if (needsRebuild("pr_review_runs", "CHECK (pr_number > 0)", "verdict")) {
      rebuild(
        "pr_review_runs",
        `
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          pr_number       INTEGER NOT NULL CHECK (pr_number > 0),
          repo            TEXT    NOT NULL CHECK (repo <> ''),
          last_fetched_at DATETIME NOT NULL,
          last_comment_id TEXT,
          task_id         INTEGER REFERENCES tasks(id),
          UNIQUE (pr_number, repo)
        `,
        [
          ["id", "NULL"],
          ["pr_number", "NULL"],
          ["repo", "NULL"],
          ["last_fetched_at", "NULL"],
          ["last_comment_id", "NULL"],
          ["task_id", "NULL"]
        ]
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_pr_review_runs_task ON pr_review_runs(task_id)");
    }
    db.exec("DROP INDEX IF EXISTS idx_pr_review_runs_pr");
    db.exec("DROP INDEX IF EXISTS idx_pr_review_runs_audit");
    if (tableExists(db, "plugin_config")) {
      db.exec("DELETE FROM plugin_config WHERE key = 'tmb_default_repo'");
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV28toV29: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v29 rebuilds`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
var ISO_NOW_DEFAULT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
var TIMESTAMP_COLUMNS = [
  ["audit", "created_at"],
  ["tasks", "created_at"],
  ["tasks", "updated_at"],
  ["tasks", "completed_at"],
  ["issues", "created_at"],
  ["issues", "updated_at"],
  ["issues", "closed_at"],
  ["discussions", "created_at"],
  ["validation_attempts", "created_at"],
  ["agent_runs", "started_at"],
  ["agent_runs", "completed_at"],
  ["roundtables", "created_at"],
  ["roundtables", "closed_at"],
  ["roundtable_votes", "created_at"],
  ["agents", "created_at"],
  ["agents", "updated_at"],
  ["cheatcodes", "installed_at"],
  ["cheatcodes", "created_at"],
  ["cheatcodes", "updated_at"],
  ["cheatcode_attachments", "created_at"],
  ["repos", "last_scanned_at"],
  ["pr_review_runs", "last_fetched_at"],
  ["discussions_embeddings", "embedded_at"],
  ["audit_embeddings", "embedded_at"]
];
function migrateV29toV30(db) {
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    const probes = [
      ["agents", "kind", "kind NOT IN ('backbone','consultant')"],
      ["agents", "scope", "scope NOT IN ('global','template','project-local')"],
      ["cheatcodes", "kind", "kind NOT IN ('skill','mcp','plugin')"],
      ["cheatcodes", "origin", "origin NOT IN ('builtin','marketplace','external')"],
      ["cheatcodes", "scope", "scope NOT IN ('global','template','project-local')"],
      ["cheatcodes", "name", "kind = 'skill' AND file_path IS NULL"],
      ["cheatcodes", "name", "origin <> 'builtin' AND source_url IS NULL"],
      ["cheatcodes", "name", "origin = 'builtin' AND source_url IS NOT NULL"]
    ];
    const violations = [];
    for (const [table, column, predicate] of probes) {
      if (!tableExists(db, table) || !hasColumn(db, table, column)) continue;
      const bad = db.prepare(`SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${predicate} LIMIT 20`).all();
      if (bad.length > 0) {
        violations.push(`${table}.${column} = ${bad.map((r) => JSON.stringify(r.v)).join(", ")} (${predicate})`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `migrateV29toV30: rows violate the rebuilt v30 constraints \u2014 fix or delete them, then reopen: ${violations.join("; ")}`
      );
    }
    if (tableExists(db, "agent_runs") && !hasColumn(db, "agent_runs", "usage_source")) {
      rebuildTable(
        db,
        "agent_runs",
        `
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id               INTEGER REFERENCES tasks(id),
          issue_id              INTEGER REFERENCES issues(id),
          agent_type            TEXT    NOT NULL,
          tokens_in             INTEGER,
          tokens_out            INTEGER,
          tokens_total          INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens     INTEGER,
          cache_creation_tokens INTEGER,
          tool_uses             INTEGER NOT NULL DEFAULT 0,
          duration_ms           INTEGER NOT NULL DEFAULT 0,
          started_at            TEXT,
          completed_at          TEXT,
          usage_baseline_json   TEXT,
          repo                  TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          spawn_id              TEXT,
          session_id            TEXT,
          usage_source          TEXT CHECK (usage_source IN ('transcript','subagent_stop','unmeasured'))
        `,
        [
          ["id", "NULL"],
          ["task_id", "NULL"],
          ["issue_id", "NULL"],
          ["agent_type", "''"],
          ["tokens_in", "NULL"],
          ["tokens_out", "NULL"],
          ["tokens_total", "0"],
          ["cache_read_tokens", "NULL"],
          ["cache_creation_tokens", "NULL"],
          ["tool_uses", "0"],
          ["duration_ms", "0"],
          ["started_at", "NULL"],
          ["completed_at", "NULL"],
          ["usage_baseline_json", "NULL"],
          ["repo", "NULL"],
          ["spawn_id", "NULL"],
          ["session_id", "NULL"],
          ["usage_source", "NULL"]
        ]
      );
      db.exec(`
        UPDATE agent_runs
           SET tokens_in = NULL, tokens_out = NULL, cache_read_tokens = NULL, cache_creation_tokens = NULL,
               usage_source = 'unmeasured'
         WHERE completed_at IS NOT NULL
           AND tokens_in = 0 AND tokens_out = 0 AND cache_read_tokens = 0 AND cache_creation_tokens = 0
      `);
      db.exec(`
        UPDATE agent_runs
           SET usage_source = CASE agent_type WHEN 'bro' THEN 'transcript' ELSE 'subagent_stop' END
         WHERE completed_at IS NOT NULL AND usage_source IS NULL
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(agent_type) WHERE completed_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id) WHERE session_id IS NOT NULL;
      `);
    }
    if (tableExists(db, "discussions") && !hasColumn(db, "discussions", "remote_comment_id")) {
      db.exec("ALTER TABLE discussions ADD COLUMN remote_comment_id TEXT");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_discussions_remote_comment ON discussions(remote_comment_id) WHERE remote_comment_id IS NOT NULL"
      );
    }
    const needsIsoDefault = (table) => tableExists(db, table) && !readTableSql(db, table).includes("strftime(");
    if (needsIsoDefault("agents")) {
      rebuildTable(
        db,
        "agents",
        `
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT    NOT NULL UNIQUE,
          kind        TEXT    NOT NULL CHECK (kind IN ('backbone','consultant')),
          scope       TEXT    NOT NULL CHECK (scope IN ('global','template','project-local')),
          file_path   TEXT    NOT NULL,
          created_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          updated_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT}
        `,
        [
          ["id", "NULL"],
          ["name", "NULL"],
          ["kind", "NULL"],
          ["scope", "NULL"],
          ["file_path", "''"],
          ["created_at", ISO_NOW_DEFAULT],
          ["updated_at", ISO_NOW_DEFAULT]
        ]
      );
    }
    if (needsIsoDefault("cheatcodes")) {
      rebuildTable(
        db,
        "cheatcodes",
        `
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL UNIQUE,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          origin       TEXT    NOT NULL DEFAULT 'external' CHECK (origin IN ('builtin','marketplace','external')),
          description  TEXT    NOT NULL DEFAULT '',
          source_url   TEXT,
          file_path    TEXT,
          version      TEXT,
          trust_tier   TEXT,
          scope        TEXT    NOT NULL DEFAULT 'project-local'
                         CHECK (scope IN ('global','template','project-local')),
          status       TEXT    NOT NULL DEFAULT 'installed',
          installed_at TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          updated_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          CHECK (kind != 'skill' OR file_path IS NOT NULL),
          CHECK (origin = 'builtin' OR source_url IS NOT NULL),
          CHECK (origin != 'builtin' OR source_url IS NULL)
        `,
        [
          ["id", "NULL"],
          ["name", "NULL"],
          ["kind", "NULL"],
          ["origin", "'external'"],
          ["description", "''"],
          ["source_url", "NULL"],
          ["file_path", "NULL"],
          ["version", "NULL"],
          ["trust_tier", "NULL"],
          ["scope", "'project-local'"],
          ["status", "'installed'"],
          ["installed_at", ISO_NOW_DEFAULT],
          ["created_at", ISO_NOW_DEFAULT],
          ["updated_at", ISO_NOW_DEFAULT]
        ]
      );
    }
    if (needsIsoDefault("repos")) {
      rebuildTable(
        db,
        "repos",
        `
          name               TEXT PRIMARY KEY,
          path               TEXT    NOT NULL,
          file_count         INTEGER NOT NULL DEFAULT 0,
          last_scanned_at    TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          target_branch      TEXT,
          branching_model    TEXT,
          protected_branches TEXT,
          remotes            TEXT
        `,
        [
          ["name", "NULL"],
          ["path", "''"],
          ["file_count", "0"],
          ["last_scanned_at", ISO_NOW_DEFAULT],
          ["target_branch", "NULL"],
          ["branching_model", "NULL"],
          ["protected_branches", "NULL"],
          ["remotes", "NULL"]
        ]
      );
    }
    const presentTimestampColumns = TIMESTAMP_COLUMNS.filter(
      ([table, column]) => tableExists(db, table) && hasColumn(db, table, column)
    );
    for (const [table, column] of presentTimestampColumns) {
      db.exec(
        `UPDATE ${table} SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column})
          WHERE ${column} IS NOT NULL AND length(${column}) <> 24
            AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL`
      );
    }
    const malformed = [];
    for (const [table, column] of presentTimestampColumns) {
      const bad = db.prepare(
        `SELECT DISTINCT ${column} AS v FROM ${table}
            WHERE ${column} IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NULL LIMIT 5`
      ).all();
      if (bad.length > 0) {
        malformed.push(`${table}.${column} = ${bad.map((r) => JSON.stringify(r.v)).join(", ")}`);
      }
    }
    if (malformed.length > 0) {
      throw new Error(
        `migrateV29toV30: timestamps that cannot be parsed into YYYY-MM-DDTHH:MM:SS.sssZ \u2014 fix them, then reopen: ${malformed.join("; ")}`
      );
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV29toV30: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v30 rebuilds`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV30toV31(db) {
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs") && (hasColumn(db, "agent_runs", "tokens_total") || hasColumn(db, "agent_runs", "usage_baseline_json"))) {
      rebuildTable(
        db,
        "agent_runs",
        `
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id               INTEGER REFERENCES tasks(id),
          issue_id              INTEGER REFERENCES issues(id),
          agent_type            TEXT    NOT NULL,
          tokens_in             INTEGER,
          tokens_out            INTEGER,
          cache_read_tokens     INTEGER,
          cache_creation_tokens INTEGER,
          tool_uses             INTEGER NOT NULL DEFAULT 0,
          duration_ms           INTEGER NOT NULL DEFAULT 0,
          started_at            TEXT,
          completed_at          TEXT,
          repo                  TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          spawn_id              TEXT,
          session_id            TEXT,
          usage_source          TEXT CHECK (usage_source IN ('transcript','subagent_stop','unmeasured'))
        `,
        [
          ["id", "NULL"],
          ["task_id", "NULL"],
          ["issue_id", "NULL"],
          ["agent_type", "''"],
          ["tokens_in", "NULL"],
          ["tokens_out", "NULL"],
          ["cache_read_tokens", "NULL"],
          ["cache_creation_tokens", "NULL"],
          ["tool_uses", "0"],
          ["duration_ms", "0"],
          ["started_at", "NULL"],
          ["completed_at", "NULL"],
          ["repo", "NULL"],
          ["spawn_id", "NULL"],
          ["session_id", "NULL"],
          ["usage_source", "NULL"]
        ]
      );
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(agent_type) WHERE completed_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id) WHERE session_id IS NOT NULL;
      `);
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV30toV31: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v31 rebuild`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
var OWN_MCP_SERVER_NAME = "trajectory-server";
function migrateV31toV32(db) {
  if (!tableExists(db, "cheatcodes")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (!/UNIQUE\s*\(\s*name\s*,\s*kind\s*\)/.test(readTableSql(db, "cheatcodes"))) {
      rebuildTable(
        db,
        "cheatcodes",
        `
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          origin       TEXT    NOT NULL DEFAULT 'external' CHECK (origin IN ('builtin','marketplace','external')),
          description  TEXT    NOT NULL DEFAULT '',
          source_url   TEXT,
          file_path    TEXT,
          version      TEXT,
          trust_tier   TEXT,
          scope        TEXT    NOT NULL DEFAULT 'project-local'
                         CHECK (scope IN ('global','template','project-local')),
          status       TEXT    NOT NULL DEFAULT 'installed',
          installed_at TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          updated_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          CHECK (kind != 'skill' OR file_path IS NOT NULL),
          CHECK (origin = 'builtin' OR source_url IS NOT NULL),
          CHECK (origin != 'builtin' OR source_url IS NULL),
          UNIQUE (name, kind)
        `,
        [
          ["id", "NULL"],
          ["name", "NULL"],
          ["kind", "NULL"],
          ["origin", "'external'"],
          ["description", "''"],
          ["source_url", "NULL"],
          ["file_path", "NULL"],
          ["version", "NULL"],
          ["trust_tier", "NULL"],
          ["scope", "'project-local'"],
          ["status", "'installed'"],
          ["installed_at", ISO_NOW_DEFAULT],
          ["created_at", ISO_NOW_DEFAULT],
          ["updated_at", ISO_NOW_DEFAULT]
        ]
      );
    }
    const pluginRow = db.prepare("SELECT 1 FROM cheatcodes WHERE kind = 'plugin' AND name = ? LIMIT 1");
    const ownPlugin = resolvePluginName();
    const legacyServers = db.prepare("SELECT id, name FROM cheatcodes WHERE kind = 'mcp' AND source_url = 'mcp:' || name").all();
    for (const server of legacyServers) {
      let parent = null;
      if (pluginRow.get(server.name) !== void 0) {
        parent = server.name;
      } else if (server.name === OWN_MCP_SERVER_NAME && pluginRow.get(ownPlugin) !== void 0) {
        parent = ownPlugin;
      }
      if (parent === null) continue;
      db.prepare("UPDATE cheatcodes SET source_url = ? WHERE id = ?").run(`mcp:${parent}/${server.name}`, server.id);
    }
    let phantoms = 0;
    if (tableExists(db, "audit")) {
      const phantomIds = db.prepare(
        `SELECT a.id FROM audit a
            WHERE a.event_type = 'scan_discovered'
              AND json_valid(a.content_json)
              AND NOT EXISTS (
                SELECT 1 FROM cheatcodes c
                 WHERE c.name = json_extract(a.content_json, '$.name')
                   AND c.kind = json_extract(a.content_json, '$.kind'))`
      ).all();
      phantoms = phantomIds.length;
      if (phantoms > 0) {
        const ids = JSON.stringify(phantomIds.map((r) => r.id));
        if (tableExists(db, "audit_embeddings")) {
          db.prepare(
            // LINT-ALLOW: v31→v32 removes the embeddings of phantom scan_discovered audit rows (GH 1200).
            "DELETE FROM audit_embeddings WHERE audit_id IN (SELECT value FROM json_each(?))"
          ).run(ids);
        }
        db.prepare("DELETE FROM audit WHERE id IN (SELECT value FROM json_each(?))").run(ids);
        db.prepare(
          `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
           SELECT -1, NULL, 'system', 'scan_discovered_repair', ?, ?, (SELECT repo FROM issues WHERE id = -1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE EXISTS (SELECT 1 FROM issues WHERE id = -1)`
        ).run(
          `deleted ${phantoms} phantom scan_discovered audit row(s)`,
          JSON.stringify({ deleted: phantoms })
        );
      }
    }
    db.exec(`
      UPDATE cheatcodes
         SET status = 'installed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE kind = 'mcp' AND source_url LIKE 'mcp:%' AND status = 'broken'
    `);
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV31toV32: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v32 rebuild`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
var ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function migrateV32toV33(db) {
  if (!tableExists(db, "agent_runs")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (!hasColumn(db, "agent_runs", "exit_reason") || !/'backfill'/.test(readTableSql(db, "agent_runs"))) {
      rebuildTable(
        db,
        "agent_runs",
        `
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id               INTEGER REFERENCES tasks(id),
          issue_id              INTEGER REFERENCES issues(id),
          agent_type            TEXT    NOT NULL,
          tokens_in             INTEGER,
          tokens_out            INTEGER,
          cache_read_tokens     INTEGER,
          cache_creation_tokens INTEGER,
          tool_uses             INTEGER NOT NULL DEFAULT 0,
          duration_ms           INTEGER NOT NULL DEFAULT 0,
          started_at            TEXT,
          completed_at          TEXT,
          repo                  TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          spawn_id              TEXT,
          session_id            TEXT,
          usage_source          TEXT CHECK (usage_source IN ('transcript','subagent_stop','unmeasured','backfill')),
          root_dir              TEXT,
          model                 TEXT,
          host                  TEXT CHECK (host IN ('claude','codex')),
          exit_reason           TEXT CHECK (exit_reason IN ('completed','failed','escalated','swept_orphan','swept_stale','issue_closed'))
        `,
        [
          ["id", "NULL"],
          ["task_id", "NULL"],
          ["issue_id", "NULL"],
          ["agent_type", "''"],
          ["tokens_in", "NULL"],
          ["tokens_out", "NULL"],
          ["cache_read_tokens", "NULL"],
          ["cache_creation_tokens", "NULL"],
          ["tool_uses", "0"],
          ["duration_ms", "0"],
          ["started_at", "NULL"],
          ["completed_at", "NULL"],
          ["repo", "NULL"],
          ["spawn_id", "NULL"],
          ["session_id", "NULL"],
          ["usage_source", "NULL"],
          ["root_dir", "NULL"],
          ["model", "NULL"],
          ["host", "NULL"],
          ["exit_reason", "NULL"]
        ]
      );
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(agent_type) WHERE completed_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id) WHERE session_id IS NOT NULL;
      `);
    }
    db.exec("UPDATE agent_runs SET host = 'claude' WHERE host IS NULL");
    if (tableExists(db, "tasks")) db.exec(`
      UPDATE agent_runs
         SET exit_reason = CASE
               WHEN usage_source = 'unmeasured' THEN 'swept_orphan'
               ELSE (SELECT CASE t.status
                              WHEN 'closed' THEN 'completed'
                              WHEN 'completed' THEN 'completed'
                              WHEN 'failed' THEN 'failed'
                              WHEN 'escalated' THEN 'escalated'
                            END
                       FROM tasks t WHERE t.id = agent_runs.task_id)
             END
       WHERE completed_at IS NOT NULL AND exit_reason IS NULL
    `);
    if (tableExists(db, "tasks") && tableExists(db, "issues")) {
      const leaked = db.prepare(
        `SELECT t.id, t.issue_id, t.branch_id, t.status FROM tasks t JOIN issues i ON i.id = t.issue_id
            WHERE i.status = 'closed' AND t.status IN ('pending','running','needs_validation','completed')
            ORDER BY t.id`
      ).all();
      const insertRepairAudit = tableExists(db, "audit") ? db.prepare(
        `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
             VALUES (?, ?, 'system', 'task_escalated_repair', ?, ?, (SELECT repo FROM issues WHERE id = ?), ${ISO_NOW_SQL})`
      ) : null;
      const escalate = db.prepare(
        `UPDATE tasks SET status = 'escalated', completed_at = NULL, updated_at = ${ISO_NOW_SQL} WHERE id = ?`
      );
      const closeRuns = db.prepare(
        `UPDATE agent_runs
            SET completed_at = ${ISO_NOW_SQL},
                duration_ms = CASE WHEN duration_ms = 0
                                   THEN COALESCE(MAX(0, CAST(ROUND((julianday('now') - julianday(started_at)) * 86400000) AS INTEGER)), 0)
                                   ELSE duration_ms END,
                exit_reason = 'issue_closed'
          WHERE task_id = ? AND completed_at IS NULL`
      );
      for (const task of leaked) {
        insertRepairAudit?.run(
          task.issue_id,
          task.branch_id,
          `task ${task.id} escalated: its issue ${task.issue_id} is closed (was ${task.status})`,
          JSON.stringify({ task_id: task.id, issue_id: task.issue_id, from_status: task.status }),
          task.issue_id
        );
        escalate.run(task.id);
        closeRuns.run(task.id);
      }
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV32toV33: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v33 rebuild`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV33toV34(db) {
  if (!tableExists(db, "agents")) return;
  if (!hasColumn(db, "agents", "scope") && /file_path\s+LIKE\s+'plugin:%'/.test(readTableSql(db, "agents"))) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    const root = hasColumn(db, "agents", "scope") ? "CASE WHEN scope = 'project-local' THEN 'project:' ELSE 'plugin:' END" : "'plugin:'";
    db.exec(`
      UPDATE agents
         SET file_path = ${root} || file_path
       WHERE file_path NOT LIKE 'plugin:%' AND file_path NOT LIKE 'project:%'
    `);
    rebuildTable(
      db,
      "agents",
      `
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL UNIQUE,
        kind        TEXT    NOT NULL CHECK (kind IN ('backbone','consultant')),
        file_path   TEXT    NOT NULL CHECK (file_path LIKE 'plugin:%' OR file_path LIKE 'project:%'),
        created_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
        updated_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT}
      `,
      [
        ["id", "NULL"],
        ["name", "NULL"],
        ["kind", "NULL"],
        ["file_path", "''"],
        ["created_at", ISO_NOW_DEFAULT],
        ["updated_at", ISO_NOW_DEFAULT]
      ]
    );
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV33toV34: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v34 rebuild`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV34toV35(db) {
  if (!tableExists(db, "repos")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS repo_remotes (
        repo        TEXT    NOT NULL REFERENCES repos(name) ON DELETE CASCADE ON UPDATE CASCADE,
        name        TEXT    NOT NULL,
        provider    TEXT    NOT NULL CHECK (provider IN ('github','gitlab','other')),
        url         TEXT    NOT NULL,
        is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
        created_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
        PRIMARY KEY (repo, name)
      );
      CREATE INDEX IF NOT EXISTS idx_repo_remotes_primary ON repo_remotes(repo, is_primary);
    `);
    if (hasColumn(db, "repos", "remotes")) {
      const rows = db.prepare(`SELECT name, remotes AS legacy FROM repos WHERE remotes IS NOT NULL AND trim(remotes) <> '' ORDER BY name`).all();
      const insertRemote = db.prepare(
        `INSERT OR IGNORE INTO repo_remotes (repo, name, provider, url, is_primary) VALUES (?, ?, ?, ?, ?)`
      );
      const canAudit = tableExists(db, "audit") && tableExists(db, "issues");
      const skipped = (repo, raw, reason) => {
        if (!canAudit) return;
        db.exec(
          `INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
           VALUES (-1, 'system', 'parent issue for recovery / system-level audit and discussion events', 'open', ${ISO_NOW_SQL}, ${ISO_NOW_SQL})`
        );
        db.prepare(
          `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
           VALUES (-1, NULL, 'system', 'repo_remotes_migration_skipped', ?, ?, ?, ${ISO_NOW_SQL})`
        ).run(`v35 migration skipped remotes of repo ${repo}: ${reason}`, JSON.stringify({ repo, reason, raw }), repo);
      };
      for (const row2 of rows) {
        const parsed = parseLegacyRemotes(row2.legacy);
        if (!parsed.ok) {
          skipped(row2.name, row2.legacy, parsed.reason);
          continue;
        }
        const primary = primaryIndex(parsed.entries);
        parsed.entries.forEach((r, i) => {
          insertRemote.run(row2.name, r.name, remoteProvider(r.url, r.provider), r.url, i === primary ? 1 : 0);
        });
        if (parsed.dropped > 0) {
          skipped(row2.name, row2.legacy, `${parsed.dropped} remote entr${parsed.dropped === 1 ? "y" : "ies"} without a url or with a duplicate name`);
        }
      }
      rebuildTable(
        db,
        "repos",
        `
          name               TEXT PRIMARY KEY,
          path               TEXT    NOT NULL,
          file_count         INTEGER NOT NULL DEFAULT 0,
          last_scanned_at    TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          target_branch      TEXT,
          branching_model    TEXT,
          protected_branches TEXT
        `,
        [
          ["name", "NULL"],
          ["path", "''"],
          ["file_count", "0"],
          ["last_scanned_at", ISO_NOW_DEFAULT],
          ["target_branch", "NULL"],
          ["branching_model", "NULL"],
          ["protected_branches", "NULL"]
        ]
      );
    }
    if (tableExists(db, "validation_attempts") && !hasColumn(db, "validation_attempts", "reviewer_agent_id")) {
      db.exec("ALTER TABLE validation_attempts ADD COLUMN reviewer_agent_id TEXT");
    }
    if (tableExists(db, "audit")) {
      db.exec(`UPDATE audit SET branch_id = NULL WHERE branch_id = ''`);
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV34toV35: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v35 rebuild`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV35toV36(db) {
  if (!tableExists(db, "tasks")) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_runs (
      id           INTEGER PRIMARY KEY,
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      commit_sha   TEXT    NOT NULL,
      source       TEXT    NOT NULL CHECK (source IN ('gate','manual')),
      started_at   TEXT    NOT NULL,
      finished_at  TEXT,
      exit_code    INTEGER,
      budget_s     INTEGER NOT NULL,
      timed_out    INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0,1)),
      created_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT}
    );
    CREATE INDEX IF NOT EXISTS idx_verification_runs_task_commit
      ON verification_runs(task_id, commit_sha, finished_at);
    CREATE TABLE IF NOT EXISTS verification_run_commands (
      run_id       INTEGER NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
      ordinal      INTEGER NOT NULL,
      command      TEXT    NOT NULL,
      exit_code    INTEGER,
      elapsed_s    REAL,
      output_tail  TEXT,
      PRIMARY KEY (run_id, ordinal)
    );
  `);
}
function migrateV36toV37(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "tasks") && !hasColumn(db, "tasks", "effort")) {
      db.exec("ALTER TABLE tasks ADD COLUMN effort TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('low','medium','high'))");
    }
    if (tableExists(db, "agent_runs") && !hasColumn(db, "agent_runs", "effort")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN effort TEXT CHECK (effort IN ('low','medium','high'))");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV37toV38(db) {
  if (!tableExists(db, "audit")) return;
  const documented = AUDIT_EVENT_TYPES.map((e) => e.type);
  const placeholders = documented.map(() => "?").join(", ");
  beginImmediate(db);
  try {
    db.prepare(
      `UPDATE audit
          SET content_json = json_set(
                CASE WHEN json_valid(content_json) THEN content_json ELSE json_object('legacy_content', content_json) END,
                '$.legacy_event_type', event_type),
              event_type = 'legacy_event'
        WHERE event_type NOT IN (${placeholders})`
    ).run(...documented);
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV38toV39(db) {
  if (!tableExists(db, "audit")) return;
  const legacyWaiver = (alias) => `${alias}.event_type = 'verification_gate_waived' AND ${alias}.from_node = 'swe'
          AND (CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.commit_sha') END) IS NULL`;
  const taskId = (alias) => `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.task_id') END`;
  beginImmediate(db);
  try {
    db.exec(
      `UPDATE audit
          SET content_json = json_set(
                CASE WHEN json_valid(content_json) THEN content_json ELSE json_object('legacy_content', content_json) END,
                '$.legacy_event_type', event_type),
              event_type = 'legacy_event'
        WHERE ${legacyWaiver("audit")}
          AND EXISTS (SELECT 1 FROM audit k
                       WHERE ${legacyWaiver("k")}
                         AND ${taskId("k")} IS ${taskId("audit")}
                         AND k.id < audit.id)`
    );
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV39toV40(db) {
  if (!tableExists(db, "repos") || hasColumn(db, "repos", "onboard_scan")) return;
  db.exec("ALTER TABLE repos ADD COLUMN onboard_scan TEXT");
}
function migrateV40toV41(db) {
  if (!tableExists(db, "repo_remotes") || hasColumn(db, "repo_remotes", "sync")) return;
  beginImmediate(db);
  try {
    db.exec("ALTER TABLE repo_remotes ADD COLUMN sync INTEGER NOT NULL DEFAULT 0 CHECK (sync IN (0,1))");
    db.exec("UPDATE repo_remotes SET sync = 1 WHERE is_primary = 1");
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV41toV42(db) {
  beginImmediate(db);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wm_directories (
          id                 INTEGER PRIMARY KEY,
          repo               TEXT    NOT NULL,
          path               TEXT    NOT NULL,
          parent_path        TEXT,
          summary            TEXT,
          summary_source     TEXT    NOT NULL,
          summary_updated_at TEXT,
          file_count         INTEGER NOT NULL DEFAULT 0,
          UNIQUE (repo, path)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS wm_files (
          id              INTEGER PRIMARY KEY,
          repo            TEXT    NOT NULL,
          path            TEXT    NOT NULL,
          dir             TEXT    NOT NULL,
          purpose         TEXT    NOT NULL DEFAULT '',
          purpose_source  TEXT    NOT NULL DEFAULT 'none',
          content_md5     TEXT    NOT NULL DEFAULT '',
          size_bytes      INTEGER NOT NULL DEFAULT 0,
          last_commit_sha TEXT    NOT NULL DEFAULT '',
          updated_at      TEXT    NOT NULL,
          UNIQUE (repo, path)
      )
    `);
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV42toV43(db) {
  if (!tableExists(db, "wm_directories")) return;
  beginImmediate(db);
  try {
    for (const [column, type] of [
      ["summary_sha", "TEXT"],
      ["commits_behind", "INTEGER"],
      ["dead_refs", "TEXT"]
    ]) {
      if (!hasColumn(db, "wm_directories", column)) {
        db.exec(`ALTER TABLE wm_directories ADD COLUMN ${column} ${type}`);
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV43toV44(db) {
  if (!tableExists(db, "wm_files")) return;
  beginImmediate(db);
  try {
    if (!hasColumn(db, "wm_files", "symbols_md5")) {
      db.exec("ALTER TABLE wm_files ADD COLUMN symbols_md5 TEXT");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV44toV45(db) {
  if (!tableExists(db, "wm_symbols")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (tableExists(db, "wm_edges") && !hasColumn(db, "wm_edges", "hint")) {
      db.exec("ALTER TABLE wm_edges ADD COLUMN hint TEXT");
    }
    if (tableExists(db, "wm_files") && hasColumn(db, "wm_files", "symbols_md5")) {
      db.exec("UPDATE wm_files SET symbols_md5 = NULL");
    }
    if (!hasColumn(db, "wm_symbols", "run_order") || !readTableSql(db, "wm_symbols").includes("'hook'")) {
      rebuildTable(
        db,
        "wm_symbols",
        `
          id              INTEGER PRIMARY KEY,
          repo            TEXT    NOT NULL,
          path            TEXT    NOT NULL,
          kind            TEXT    NOT NULL CHECK (kind IN ('function','method','class','interface','type','const','sh_function','sql_table','sql_index','sql_trigger','module','hook')),
          qualified_name  TEXT    NOT NULL,
          signature       TEXT    NOT NULL DEFAULT '',
          doc             TEXT    NOT NULL DEFAULT '',
          start_line      INTEGER,
          end_line        INTEGER,
          body_hash       TEXT    NOT NULL,
          exported        INTEGER NOT NULL DEFAULT 0,
          terms           TEXT    NOT NULL DEFAULT '',
          run_order       INTEGER,
          UNIQUE (repo, path, kind, qualified_name)
        `,
        [
          ["id", "NULL"],
          ["repo", "''"],
          ["path", "''"],
          ["kind", "'module'"],
          ["qualified_name", "''"],
          ["signature", "''"],
          ["doc", "''"],
          ["start_line", "NULL"],
          ["end_line", "NULL"],
          ["body_hash", "''"],
          ["exported", "0"],
          ["terms", "''"],
          ["run_order", "NULL"]
        ]
      );
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check(wm_edges)").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV44toV45: foreign_key_check found ${fkViolations.length} dangling reference(s) after the wm_symbols rebuild`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV45toV46(db) {
  if (!tableExists(db, "discussions")) return;
  beginImmediate(db);
  try {
    if (!hasColumn(db, "discussions", "task_id")) {
      db.exec("ALTER TABLE discussions ADD COLUMN task_id INTEGER REFERENCES tasks(id)");
    }
    if (!hasColumn(db, "discussions", "supersedes")) {
      db.exec("ALTER TABLE discussions ADD COLUMN supersedes INTEGER REFERENCES discussions(id)");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV46toV47(db) {
  if (!tableExists(db, "tasks")) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_findings (
      id           TEXT    PRIMARY KEY,
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt_n    INTEGER NOT NULL,
      criterion_id TEXT,
      probe_cmd    TEXT    NOT NULL,
      expected     TEXT    NOT NULL,
      observed     TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','wontfix')),
      created_at   TEXT    NOT NULL,
      resolved_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_review_findings_task_status
      ON review_findings(task_id, status);
  `);
}
function migrateV47toV48(db) {
  if (!tableExists(db, "tasks")) return;
  beginImmediate(db);
  try {
    if (!hasColumn(db, "tasks", "completion_report")) {
      db.exec("ALTER TABLE tasks ADD COLUMN completion_report TEXT");
    }
    if (!hasColumn(db, "tasks", "spawn_note")) {
      db.exec("ALTER TABLE tasks ADD COLUMN spawn_note TEXT");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV48toV49(db) {
  if (!tableExists(db, "agent_runs")) return;
  beginImmediate(db);
  try {
    if (!hasColumn(db, "agent_runs", "resumed_from")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN resumed_from INTEGER REFERENCES agent_runs(id)");
    }
    db.exec(`
      DROP INDEX IF EXISTS idx_agent_runs_spawn;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL AND resumed_from IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_resumed ON agent_runs(resumed_from) WHERE resumed_from IS NOT NULL;
    `);
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV49toV50(db) {
  if (!tableExists(db, "agent_runs")) return;
  beginImmediate(db);
  try {
    if (!hasColumn(db, "agent_runs", "plugin_version")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN plugin_version TEXT");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
var OLD_REVIEWER = "pr-reviewer";
var OLD_REVIEWER_TITLE = "PR-reviewer";
var REVIEWER = "code-reviewer";
var REVIEWER_JSON_RENAMES = {
  [OLD_REVIEWER]: REVIEWER,
  [`tmb:${OLD_REVIEWER}`]: `tmb:${REVIEWER}`
};
function renameReviewerInAuditJson(db) {
  const hits = db.prepare(
    `SELECT a.id AS id, j.fullkey AS path, j.atom AS value
         FROM audit a, json_tree(a.content_json) j
        WHERE instr(a.content_json, ?) > 0
          AND json_valid(a.content_json)
          AND j.type = 'text'
          AND j.atom IN (?, ?)
        ORDER BY a.id`
  ).all(OLD_REVIEWER, OLD_REVIEWER, `tmb:${OLD_REVIEWER}`);
  const update = db.prepare("UPDATE audit SET content_json = json_set(content_json, ?, ?) WHERE id = ?");
  for (const hit of hits) {
    update.run(hit.path, REVIEWER_JSON_RENAMES[hit.value], hit.id);
  }
}
function migrateV50toV51(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs")) {
      db.prepare("UPDATE agent_runs SET agent_type = ? WHERE agent_type = ?").run(REVIEWER, OLD_REVIEWER);
    }
    if (tableExists(db, "validation_attempts")) {
      db.prepare("UPDATE validation_attempts SET agent = ? WHERE agent = ?").run(REVIEWER, OLD_REVIEWER);
    }
    if (tableExists(db, "agents")) {
      db.prepare(`DELETE FROM agents WHERE name = ? AND EXISTS (SELECT 1 FROM agents WHERE name = ?)`).run(
        OLD_REVIEWER,
        REVIEWER
      );
      db.prepare(
        `UPDATE agents
            SET name = ?,
                file_path = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE name = ?`
      ).run(REVIEWER, `plugin:agents/${REVIEWER}.md`, OLD_REVIEWER);
    }
    if (tableExists(db, "audit")) {
      renameReviewerInAuditJson(db);
    }
    if (tableExists(db, "cheatcodes")) {
      db.prepare(
        `UPDATE cheatcodes
            SET description = replace(replace(description, ?, ?), ?, ?)
          WHERE (origin = 'builtin' OR (kind = 'plugin' AND name = 'tmb'))
            AND (instr(description, ?) > 0 OR instr(description, ?) > 0)`
      ).run(OLD_REVIEWER, REVIEWER, OLD_REVIEWER_TITLE, "Code-reviewer", OLD_REVIEWER, OLD_REVIEWER_TITLE);
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV51toV52(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs")) {
      if (!hasColumn(db, "agent_runs", "stop_cause")) {
        db.exec("ALTER TABLE agent_runs ADD COLUMN stop_cause TEXT CHECK (stop_cause IN ('budget','hook_block'))");
      }
      if (!hasColumn(db, "agent_runs", "stop_detail")) {
        db.exec("ALTER TABLE agent_runs ADD COLUMN stop_detail TEXT");
      }
    }
    if (tableExists(db, "tasks") && !hasColumn(db, "tasks", "checkpoint")) {
      db.exec("ALTER TABLE tasks ADD COLUMN checkpoint TEXT");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV52toV53(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_run_tool_output (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id       INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
            tool_name    TEXT    NOT NULL,
            calls        INTEGER NOT NULL DEFAULT 0,
            result_chars INTEGER NOT NULL DEFAULT 0,
            est_tokens   INTEGER NOT NULL DEFAULT 0,
            UNIQUE (run_id, tool_name)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_run_tool_output_run ON agent_run_tool_output(run_id);
      `);
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV53toV54(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "tasks")) {
      if (!hasColumn(db, "tasks", "worktree_path")) {
        db.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
      }
      if (!hasColumn(db, "tasks", "worktree_adopted")) {
        db.exec(
          "ALTER TABLE tasks ADD COLUMN worktree_adopted INTEGER NOT NULL DEFAULT 0 CHECK (worktree_adopted IN (0,1))"
        );
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV54toV55(db) {
  beginImmediate(db);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_handoffs (
          session_id          TEXT PRIMARY KEY,
          cwd                 TEXT NOT NULL,
          issue_id            INTEGER REFERENCES issues(id),
          summary             TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          consumed_at         TEXT,
          consumed_by_session TEXT
      );
    `);
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV55toV56(db) {
  if (!tableExists(db, "wm_edges") || readTableSql(db, "wm_edges").includes("'bundles'")) return;
  beginImmediate(db);
  try {
    rebuildTable(
      db,
      "wm_edges",
      `
        src_id      INTEGER NOT NULL REFERENCES wm_symbols(id) ON DELETE CASCADE,
        dst_id      INTEGER REFERENCES wm_symbols(id) ON DELETE SET NULL,
        dst_name    TEXT    NOT NULL,
        kind        TEXT    NOT NULL CHECK (kind IN ('calls','imports','instantiates','sources','runs','reads_table','writes_table','indexes','triggers_on','bundles')),
        resolution  TEXT    NOT NULL DEFAULT 'unresolved' CHECK (resolution IN ('exact','name','unresolved')),
        line        INTEGER,
        hint        TEXT
      `,
      [
        ["src_id", "0"],
        ["dst_id", "NULL"],
        ["dst_name", "''"],
        ["kind", "'calls'"],
        ["resolution", "'unresolved'"],
        ["line", "NULL"],
        ["hint", "NULL"]
      ]
    );
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV56toV57(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "review_findings")) {
      if (!hasColumn(db, "review_findings", "severity")) {
        db.exec(
          "ALTER TABLE review_findings ADD COLUMN severity TEXT NOT NULL DEFAULT 'blocking' CHECK (severity IN ('blocking','nit','pre_existing'))"
        );
      }
      if (!hasColumn(db, "review_findings", "class")) {
        db.exec("ALTER TABLE review_findings ADD COLUMN class TEXT");
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV57toV58(db) {
  beginImmediate(db);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS repo_env (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          repo             TEXT    NOT NULL REFERENCES repos(name) ON DELETE CASCADE ON UPDATE CASCADE,
          package_path     TEXT    NOT NULL,
          ecosystem        TEXT    NOT NULL,
          package_manager  TEXT    NOT NULL,
          runner_prefix    TEXT,
          commands_json    TEXT    NOT NULL,
          globs_json       TEXT    NOT NULL,
          status           TEXT    NOT NULL CHECK (status IN ('ready','detected','missing_tool','stale')),
          confirmed_by     TEXT,
          detected_at      TEXT    NOT NULL,
          evidence_hash    TEXT    NOT NULL,
          overrides_json   TEXT,
          waivers_json     TEXT,
          declined_json    TEXT,
          updated_at       TEXT    NOT NULL,
          UNIQUE (repo, package_path, ecosystem)
      );
    `);
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV58toV59(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs") && !hasColumn(db, "agent_runs", "hook_block_tokens")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN hook_block_tokens INTEGER");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV59toV60(db) {
  const symbolsDone = !tableExists(db, "wm_symbols") || readTableSql(db, "wm_symbols").includes("'runner'");
  const edgesDone = !tableExists(db, "wm_edges") || readTableSql(db, "wm_edges").includes("'reads_config'");
  if (symbolsDone && edgesDone) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (!symbolsDone) {
      rebuildTable(
        db,
        "wm_symbols",
        `
          id              INTEGER PRIMARY KEY,
          repo            TEXT    NOT NULL,
          path            TEXT    NOT NULL,
          kind            TEXT    NOT NULL CHECK (kind IN ('function','method','class','interface','type','const','sh_function','sql_table','sql_index','sql_trigger','module','hook','runner')),
          qualified_name  TEXT    NOT NULL,
          signature       TEXT    NOT NULL DEFAULT '',
          doc             TEXT    NOT NULL DEFAULT '',
          start_line      INTEGER,
          end_line        INTEGER,
          body_hash       TEXT    NOT NULL,
          exported        INTEGER NOT NULL DEFAULT 0,
          terms           TEXT    NOT NULL DEFAULT '',
          run_order       INTEGER,
          UNIQUE (repo, path, kind, qualified_name)
        `,
        [
          ["id", "NULL"],
          ["repo", "''"],
          ["path", "''"],
          ["kind", "'module'"],
          ["qualified_name", "''"],
          ["signature", "''"],
          ["doc", "''"],
          ["start_line", "NULL"],
          ["end_line", "NULL"],
          ["body_hash", "''"],
          ["exported", "0"],
          ["terms", "''"],
          ["run_order", "NULL"]
        ]
      );
    }
    if (!edgesDone) {
      rebuildTable(
        db,
        "wm_edges",
        `
          src_id      INTEGER NOT NULL REFERENCES wm_symbols(id) ON DELETE CASCADE,
          dst_id      INTEGER REFERENCES wm_symbols(id) ON DELETE SET NULL,
          dst_name    TEXT    NOT NULL,
          kind        TEXT    NOT NULL CHECK (kind IN ('calls','imports','instantiates','sources','runs','reads_table','writes_table','indexes','triggers_on','bundles','reads_config','covers')),
          resolution  TEXT    NOT NULL DEFAULT 'unresolved' CHECK (resolution IN ('exact','name','unresolved')),
          line        INTEGER,
          hint        TEXT
        `,
        [
          ["src_id", "0"],
          ["dst_id", "NULL"],
          ["dst_name", "''"],
          ["kind", "'calls'"],
          ["resolution", "'unresolved'"],
          ["line", "NULL"],
          ["hint", "NULL"]
        ]
      );
    }
    if (tableExists(db, "wm_edges")) {
      const fkViolations = db.prepare("PRAGMA foreign_key_check(wm_edges)").all();
      if (fkViolations.length > 0) {
        throw new Error(
          `migrateV59toV60: foreign_key_check found ${fkViolations.length} dangling reference(s) after the wm_symbols rebuild`
        );
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV60toV61(db) {
  beginImmediate(db);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        repo        TEXT    NOT NULL,
        number      INTEGER NOT NULL CHECK (number > 0),
        state       TEXT    NOT NULL CHECK (state IN ('open','closed','merged')),
        created_at  DATETIME NOT NULL,
        merged_at   DATETIME,
        updated_at  DATETIME NOT NULL,
        synced_at   DATETIME NOT NULL,
        UNIQUE (repo, number)
      );
      CREATE TABLE IF NOT EXISTS pr_closes (
        pr_id         INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
        issue_number  INTEGER NOT NULL CHECK (issue_number > 0),
        PRIMARY KEY (pr_id, issue_number)
      );
    `);
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV61toV62(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "repos")) {
      if (!hasColumn(db, "repos", "indexed_commit")) db.exec("ALTER TABLE repos ADD COLUMN indexed_commit TEXT");
      if (!hasColumn(db, "repos", "indexed_stamp")) db.exec("ALTER TABLE repos ADD COLUMN indexed_stamp TEXT");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
var WM_FRESHNESS_DDL = `CREATE TABLE IF NOT EXISTS wm_freshness (
    repo                TEXT    PRIMARY KEY REFERENCES repos(name) ON DELETE CASCADE ON UPDATE CASCADE,
    target_ref          TEXT,
    target_commit       TEXT,
    target_fetched_at   TEXT,
    reindex_state       TEXT    NOT NULL DEFAULT 'idle' CHECK (reindex_state IN ('idle','running','failed')),
    reindex_mode        TEXT    CHECK (reindex_mode IN ('incremental','full')),
    reindex_trigger     TEXT    CHECK (reindex_trigger IN ('read','spawn','startup','scan','hook','fetch')),
    reindex_started_at  TEXT,
    reindex_finished_at TEXT,
    reindex_elapsed_ms  INTEGER,
    reindex_outcome     TEXT    CHECK (reindex_outcome IN ('ok','error')),
    updated_at          TEXT    NOT NULL
)`;
function migrateV62toV63(db) {
  beginImmediate(db);
  try {
    db.exec(WM_FRESHNESS_DDL);
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV63toV64(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "wm_directories") && !hasColumn(db, "wm_directories", "readme_review_pending")) {
      db.exec("ALTER TABLE wm_directories ADD COLUMN readme_review_pending INTEGER NOT NULL DEFAULT 0");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV64toV65(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "validation_attempts") && !hasColumn(db, "validation_attempts", "reviewed_sha")) {
      db.exec("ALTER TABLE validation_attempts ADD COLUMN reviewed_sha TEXT");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV65toV66(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "tasks") && !hasColumn(db, "tasks", "workflow_mode")) {
      db.exec(
        "ALTER TABLE tasks ADD COLUMN workflow_mode TEXT CHECK (workflow_mode IS NULL OR workflow_mode IN ('truest','agile'))"
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV66toV67(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "tasks")) {
      for (const column of ["base_sha", "wm_commit"]) {
        if (!hasColumn(db, "tasks", column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV67toV68(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "validation_attempts") && !hasColumn(db, "validation_attempts", "probes_json")) {
      db.exec("ALTER TABLE validation_attempts ADD COLUMN probes_json TEXT");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV68toV69(db) {
  if (!tableExists(db, "tasks")) return;
  beginImmediate(db);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lint_runs (
        id           INTEGER PRIMARY KEY,
        task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        commit_sha   TEXT    NOT NULL,
        base_sha     TEXT    NOT NULL,
        fingerprint  TEXT    NOT NULL,
        source       TEXT    NOT NULL CHECK (source IN ('gate','integrate')),
        started_at   TEXT    NOT NULL,
        finished_at  TEXT,
        exit_code    INTEGER,
        created_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT}
      );
      CREATE INDEX IF NOT EXISTS idx_lint_runs_task_commit
        ON lint_runs(task_id, commit_sha, finished_at);
      CREATE TABLE IF NOT EXISTS lint_run_results (
        run_id       INTEGER NOT NULL REFERENCES lint_runs(id) ON DELETE CASCADE,
        ordinal      INTEGER NOT NULL,
        name         TEXT    NOT NULL,
        exit_code    INTEGER,
        elapsed_s    REAL,
        output_tail  TEXT,
        PRIMARY KEY (run_id, ordinal)
      );
    `);
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV69toV70(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "wm_files") && !hasColumn(db, "wm_files", "lane")) {
      db.exec("ALTER TABLE wm_files ADD COLUMN lane TEXT NOT NULL DEFAULT 'product' CHECK (lane IN ('test','product'))");
      const markTest = db.prepare(`UPDATE wm_files SET lane = 'test' WHERE id = ?`);
      for (const f of db.prepare("SELECT id, path FROM wm_files").all()) {
        if (isDefaultTestPath(f.path)) markTest.run(f.id);
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV70toV71(db) {
  if (!tableExists(db, "agents")) return;
  beginImmediate(db);
  try {
    db.exec(`
      -- LINT-ALLOW: removes only the rows whose plugin template file was deleted (GH 3068).
      DELETE FROM agents
       WHERE name IN ('architect', 'cto', 'ceo', 'pm')
         AND file_path = 'plugin:templates/agents/' || name || '.md'
    `);
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV71toV72(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "tasks") && !hasColumn(db, "tasks", "no_code_class")) {
      db.exec("ALTER TABLE tasks ADD COLUMN no_code_class TEXT CHECK (no_code_class IS NULL OR no_code_class IN ('docs','prompts'))");
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV22toV23(db) {
  const soleRepo = () => {
    if (!tableExists(db, "repos")) return null;
    const rows = db.prepare("SELECT name FROM repos").all();
    return rows.length === 1 ? rows[0].name : null;
  };
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (tableExists(db, "repos")) {
      if (!hasColumn(db, "repos", "remotes")) {
        db.exec("ALTER TABLE repos ADD COLUMN remotes TEXT");
      }
    }
    const sole = soleRepo();
    db.exec(`
      CREATE TABLE IF NOT EXISTS milestones (
          name   TEXT NOT NULL,
          repo   TEXT NOT NULL REFERENCES repos(name) ON DELETE RESTRICT,
          state  TEXT NOT NULL DEFAULT 'open',
          PRIMARY KEY (name, repo)
      )
    `);
    if (tableExists(db, "issues") && hasColumn(db, "issues", "milestone")) {
      const issuesHasRepo = hasColumn(db, "issues", "repo");
      if (!issuesHasRepo) {
        db.exec("ALTER TABLE issues ADD COLUMN repo TEXT");
      }
      if (sole !== null) {
        db.prepare("UPDATE issues SET repo = ? WHERE repo IS NULL AND id <> -1").run(sole);
      }
      db.exec(`
        INSERT OR IGNORE INTO milestones (name, repo, state)
        SELECT DISTINCT milestone, repo, 'open'
          FROM issues
         WHERE milestone IS NOT NULL AND repo IS NOT NULL
      `);
      db.exec("DROP TABLE IF EXISTS issues_new");
      db.exec(`
        CREATE TABLE issues_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            objective         TEXT    NOT NULL,
            description       TEXT    NOT NULL DEFAULT '',
            status            TEXT    NOT NULL DEFAULT 'open',
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL,
            closed_at         TEXT,
            remote_iid        INTEGER,
            remote_kind       TEXT CHECK(remote_kind IN ('github','gitlab')),
            gh_iid            INTEGER,
            gl_iid            INTEGER,
            repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
            milestone         TEXT,
            FOREIGN KEY (milestone, repo) REFERENCES milestones(name, repo) ON DELETE RESTRICT
        )
      `);
      const issueCol = (name, expr = name) => hasColumn(db, "issues", name) ? expr : `NULL AS ${name}`;
      db.exec(`
        INSERT INTO issues_new
          (id, objective, description, status, created_at, updated_at, closed_at,
           remote_iid, remote_kind, gh_iid, gl_iid, repo, milestone)
        SELECT
           id, objective, description, status, created_at, updated_at,
           ${issueCol("closed_at")},
           ${issueCol("remote_iid")}, ${issueCol("remote_kind")},
           ${issueCol("gh_iid")}, ${issueCol("gl_iid")},
           repo, milestone
          FROM issues
      `);
      db.exec("DROP TABLE issues");
      db.exec("ALTER TABLE issues_new RENAME TO issues");
    }
    if (tableExists(db, "tasks") && hasColumn(db, "tasks", "repo")) {
      db.exec("DROP TABLE IF EXISTS tasks_new");
      db.exec(`
        CREATE TABLE tasks_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id          INTEGER NOT NULL REFERENCES issues(id),
            branch_id         TEXT    NOT NULL,
            parent_branch_id  TEXT,
            title             TEXT    NOT NULL DEFAULT '',
            description       TEXT    NOT NULL,
            status            TEXT    NOT NULL DEFAULT 'pending',
            attempts          INTEGER NOT NULL DEFAULT 0,
            spec_body         TEXT    NOT NULL DEFAULT '',
            commit_sha        TEXT,
            repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
            prompt_bearing    INTEGER NOT NULL DEFAULT 0,
            files             TEXT    NOT NULL DEFAULT '[]',
            verification      TEXT    NOT NULL DEFAULT '[]',
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL,
            completed_at      TEXT
        )
      `);
      const taskCol = (name, fallback) => hasColumn(db, "tasks", name) ? name : `${fallback} AS ${name}`;
      db.exec(`
        INSERT INTO tasks_new
          (id, issue_id, branch_id, parent_branch_id, title, description, status,
           attempts, spec_body, commit_sha, repo, prompt_bearing, files,
           verification, created_at, updated_at, completed_at)
        SELECT
           id, issue_id, branch_id,
           ${taskCol("parent_branch_id", "NULL")},
           ${taskCol("title", "''")},
           description, status, attempts,
           ${taskCol("spec_body", "''")},
           ${taskCol("commit_sha", "NULL")},
           repo,
           ${taskCol("prompt_bearing", "0")},
           ${taskCol("files", "'[]'")},
           ${taskCol("verification", "'[]'")},
           created_at, updated_at,
           ${taskCol("completed_at", "NULL")}
          FROM tasks
      `);
      db.exec("DROP TABLE tasks");
      db.exec("ALTER TABLE tasks_new RENAME TO tasks");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id)"
      );
    }
    if (tableExists(db, "discussions") && !hasColumn(db, "discussions", "repo")) {
      db.exec("ALTER TABLE discussions ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT");
      if (tableExists(db, "issues")) {
        db.exec(`
          UPDATE discussions
             SET repo = (SELECT i.repo FROM issues i WHERE i.id = discussions.issue_id)
           WHERE repo IS NULL
        `);
      }
    }
    if (tableExists(db, "audit") && !hasColumn(db, "audit", "repo")) {
      db.exec("ALTER TABLE audit ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT");
      if (tableExists(db, "issues")) {
        db.exec(`
          UPDATE audit
             SET repo = (SELECT i.repo FROM issues i WHERE i.id = audit.issue_id)
           WHERE repo IS NULL
        `);
      }
    }
    if (tableExists(db, "agent_runs") && !hasColumn(db, "agent_runs", "repo")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT");
      if (tableExists(db, "tasks")) {
        db.exec(`
          UPDATE agent_runs
             SET repo = (SELECT t.repo FROM tasks t WHERE t.id = agent_runs.task_id)
           WHERE repo IS NULL AND task_id IS NOT NULL
        `);
      }
      if (tableExists(db, "issues")) {
        db.exec(`
          UPDATE agent_runs
             SET repo = (SELECT i.repo FROM issues i WHERE i.id = agent_runs.issue_id)
           WHERE repo IS NULL AND issue_id IS NOT NULL
        `);
      }
    }
    if (tableExists(db, "validation_attempts") && !hasColumn(db, "validation_attempts", "repo")) {
      db.exec("ALTER TABLE validation_attempts ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT");
      if (tableExists(db, "tasks")) {
        db.exec(`
          UPDATE validation_attempts
             SET repo = (SELECT t.repo FROM tasks t WHERE t.id = validation_attempts.task_id)
           WHERE repo IS NULL
        `);
      }
    }
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV22toV23: foreign_key_check found ${violations.length} dangling reference(s) after the repos-centric migration`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV23toV24(db) {
  if (!tableExists(db, "cheatcodes")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    db.exec(`
      -- LINT-ALLOW: v23\u2192v24 WHERE-scoped cleanup of leaked scan-ingest rows (#150).
      DELETE FROM cheatcodes
       WHERE source_url = 'scan_discovered'
         AND (
           name GLOB '*[^A-Za-z0-9._-]*'
           OR name IN ('Installed','Version','Scope','Status','Location','Name','Source','Enabled')
         )
    `);
    db.exec("DROP TABLE IF EXISTS cheatcodes_new");
    db.exec(`
      CREATE TABLE cheatcodes_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL UNIQUE,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          origin       TEXT    NOT NULL DEFAULT 'external' CHECK (origin IN ('builtin','marketplace','external')),
          description  TEXT    NOT NULL DEFAULT '',
          source_url   TEXT,
          file_path    TEXT,
          version      TEXT,
          trust_tier   TEXT,
          scope        TEXT    NOT NULL DEFAULT 'project-local'
                         CHECK (scope IN ('global','template','project-local')),
          status       TEXT    NOT NULL DEFAULT 'installed',
          installed_at TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (kind != 'skill' OR file_path IS NOT NULL),
          CHECK (origin = 'builtin' OR source_url IS NOT NULL),
          CHECK (origin != 'builtin' OR source_url IS NULL)
      )
    `);
    db.exec(`
      INSERT INTO cheatcodes_new
        (id, name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
      SELECT
        id, name, kind,
        CASE
          WHEN origin = 'builtin' THEN 'builtin'
          WHEN name IN ('typescript-lsp','mcp-server-dev','plugin-dev') THEN 'marketplace'
          WHEN name = 'superpowers' THEN 'external'
          WHEN source_url LIKE '%@%' AND source_url NOT LIKE '%://%' AND source_url NOT LIKE '%@%:%' THEN 'marketplace'
          WHEN source_url LIKE './%' THEN 'marketplace'
          ELSE 'external'
        END,
        description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at
      FROM cheatcodes
    `);
    db.exec("DROP TABLE cheatcodes");
    db.exec("ALTER TABLE cheatcodes_new RENAME TO cheatcodes");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV23toV24: foreign_key_check found ${violations.length} dangling reference(s) after the cheatcodes rebuild`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV24toV25(db) {
  if (!tableExists(db, "cheatcodes")) {
    return;
  }
  beginImmediate(db);
  try {
    deleteBuiltinCheatcodeAttachments(db, "tmb_push-triage");
    db.exec("DELETE FROM cheatcodes WHERE name = 'tmb_push-triage' AND origin = 'builtin'");
    db.exec(`
      INSERT OR IGNORE INTO cheatcodes
        (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
      VALUES
        ('tmb_push-gate', 'skill', 'builtin',
         'Bro''s push-gate orchestration \u2014 reaping unsigned commits, spawning pr-reviewer per task, and the all-pass push + PR-create + post-merge cleanup path. Loaded by bro when the push hook blocks or the Human asks for review-before-push.',
         NULL, 'skills/tmb_push-gate/SKILL.md', NULL, 'curated', 'global', 'active',
         datetime('now'), datetime('now'), datetime('now')),
        ('tmb_comment-triage', 'skill', 'builtin',
         'Bro''s PR/MR comment triage \u2014 resolve the PR, fetch the comment threads, judge which are task-worthy, and dispatch SWE per group without waiting on the Human. Loaded by bro when review comments reach a PR it owns.',
         NULL, 'skills/tmb_comment-triage/SKILL.md', NULL, 'curated', 'global', 'active',
         datetime('now'), datetime('now'), datetime('now'))
    `);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV24toV25: foreign_key_check found ${violations.length} dangling reference(s) after the push-triage skill split`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV25toV26(db) {
  if (!tableExists(db, "validation_attempts")) return;
  if (hasColumn(db, "validation_attempts", "mcp_available")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS validation_attempts_new");
    db.exec(`
      CREATE TABLE validation_attempts_new (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id             INTEGER NOT NULL REFERENCES tasks(id),
          attempt_n           INTEGER NOT NULL,
          agent               TEXT    NOT NULL DEFAULT '',
          verdict             TEXT    NOT NULL,
          feedback            TEXT    NOT NULL DEFAULT '',
          mcp_available       INTEGER NOT NULL DEFAULT 1,
          subagent_session_id TEXT,
          repo                TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          created_at          TEXT    NOT NULL,
          UNIQUE(task_id, attempt_n)
      )
    `);
    db.exec(`
      INSERT INTO validation_attempts_new
        (id, task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, repo, created_at)
      SELECT
        id, task_id, attempt_n, agent, verdict, feedback,
        CASE WHEN feedback LIKE 'MCP available: no%' THEN 0 ELSE 1 END,
        subagent_session_id, repo, created_at
      FROM validation_attempts
    `);
    db.exec("DROP TABLE validation_attempts");
    db.exec("ALTER TABLE validation_attempts_new RENAME TO validation_attempts");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV25toV26: foreign_key_check found ${violations.length} dangling reference(s) after the validation_attempts rebuild`
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV26toV27(db) {
  if (!tableExists(db, "plugin_config")) return;
  beginImmediate(db);
  try {
    if (tableExists(db, "repos")) {
      const scalarFromConfig = (key) => {
        const row2 = db.prepare("SELECT value_json FROM plugin_config WHERE key = ?").get(key);
        if (!row2?.value_json) return null;
        try {
          const v = JSON.parse(row2.value_json);
          return typeof v === "string" && v.length > 0 ? v : null;
        } catch {
          return null;
        }
      };
      const rawFromConfig = (key) => {
        const row2 = db.prepare("SELECT value_json FROM plugin_config WHERE key = ?").get(key);
        return row2?.value_json ?? null;
      };
      const prTarget = scalarFromConfig("pr_target");
      const branchingModel = scalarFromConfig("branching_model");
      const protectedBranches = rawFromConfig("protected_branches");
      const remotes = rawFromConfig("remotes");
      if (hasColumn(db, "repos", "target_branch") && prTarget !== null) {
        db.prepare("UPDATE repos SET target_branch = ? WHERE target_branch IS NULL").run(prTarget);
      }
      if (hasColumn(db, "repos", "branching_model") && branchingModel !== null) {
        db.prepare("UPDATE repos SET branching_model = ? WHERE branching_model IS NULL").run(
          branchingModel
        );
      }
      if (hasColumn(db, "repos", "protected_branches") && protectedBranches !== null) {
        db.prepare("UPDATE repos SET protected_branches = ? WHERE protected_branches IS NULL").run(
          protectedBranches
        );
      }
      if (hasColumn(db, "repos", "remotes") && remotes !== null) {
        db.prepare("UPDATE repos SET remotes = ? WHERE remotes IS NULL").run(remotes);
      }
    }
    db.prepare(
      // LINT-ALLOW: v27 migration intentionally removes the drained global policy keys (#980).
      "DELETE FROM plugin_config WHERE key IN ('pr_target', 'branching_model', 'protected_branches', 'remotes')"
    ).run();
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV7toV8(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TRIGGER IF EXISTS directories_au_new");
    db.exec("DROP TRIGGER IF EXISTS directories_au");
    db.exec("DROP TRIGGER IF EXISTS directories_ad");
    db.exec("DROP TRIGGER IF EXISTS directories_ai");
    db.exec("DROP INDEX IF EXISTS idx_directories_embeddings_model");
    db.exec("DROP INDEX IF EXISTS idx_directories_parent");
    db.exec("DROP TABLE IF EXISTS directories_embeddings");
    db.exec("DROP TABLE IF EXISTS directories_fts");
    db.exec("DROP TABLE IF EXISTS directories");
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV6toV7(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TRIGGER IF EXISTS file_registry_au_new");
    db.exec("DROP TRIGGER IF EXISTS file_registry_au");
    db.exec("DROP TRIGGER IF EXISTS file_registry_ad");
    db.exec("DROP TRIGGER IF EXISTS file_registry_ai");
    db.exec("DROP INDEX IF EXISTS idx_file_registry_embeddings_model");
    db.exec("DROP TABLE IF EXISTS file_registry_embeddings");
    db.exec("DROP TABLE IF EXISTS file_registry_fts");
    db.exec("DROP TABLE IF EXISTS file_registry");
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV5toV6(db) {
  beginImmediate(db);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS directories (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL DEFAULT '', path TEXT NOT NULL, parent_path TEXT, summary TEXT, summary_source TEXT CHECK (summary_source IN ('readme','llm','manual')) DEFAULT 'llm', summary_updated_at TEXT, file_count INTEGER NOT NULL DEFAULT 0, UNIQUE(repo, path))"
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_directories_parent ON directories(repo, parent_path)"
    );
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS directories_fts USING fts5(summary, path, content='directories', tokenize='porter unicode61')"
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_ai AFTER INSERT ON directories WHEN new.summary IS NOT NULL BEGIN INSERT INTO directories_fts(rowid, summary, path) VALUES (new.id, new.summary, new.path); END"
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_ad AFTER DELETE ON directories WHEN old.summary IS NOT NULL BEGIN INSERT INTO directories_fts(directories_fts, rowid, summary, path) VALUES ('delete', old.id, old.summary, old.path); END"
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_au AFTER UPDATE ON directories WHEN old.summary IS NOT NULL BEGIN INSERT INTO directories_fts(directories_fts, rowid, summary, path) VALUES ('delete', old.id, old.summary, old.path); END"
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_au_new AFTER UPDATE ON directories WHEN new.summary IS NOT NULL BEGIN INSERT INTO directories_fts(rowid, summary, path) VALUES (new.id, new.summary, new.path); END"
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS directories_embeddings (directory_id INTEGER PRIMARY KEY, embedding BLOB NOT NULL, model_id TEXT NOT NULL, embedded_at TEXT NOT NULL)"
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_directories_embeddings_model ON directories_embeddings(model_id)"
    );
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV4toV5(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "issues")) {
      if (!hasColumn(db, "issues", "gh_iid")) {
        db.exec("ALTER TABLE issues ADD COLUMN gh_iid INTEGER");
      }
      if (!hasColumn(db, "issues", "gl_iid")) {
        db.exec("ALTER TABLE issues ADD COLUMN gl_iid INTEGER");
      }
      db.exec(
        "UPDATE issues SET gh_iid = remote_iid WHERE remote_kind = 'github' AND remote_iid IS NOT NULL AND gh_iid IS NULL"
      );
      db.exec(
        "UPDATE issues SET gl_iid = remote_iid WHERE remote_kind = 'gitlab' AND remote_iid IS NOT NULL AND gl_iid IS NULL"
      );
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV3toV4(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "discussions")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS discussions_embeddings (
          discussion_id INTEGER PRIMARY KEY REFERENCES discussions(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          model_id TEXT NOT NULL,
          embedded_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_discussions_embeddings_model
        ON discussions_embeddings(model_id)
      `);
    }
    if (tableExists(db, "audit")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_embeddings (
          audit_id INTEGER PRIMARY KEY REFERENCES audit(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          model_id TEXT NOT NULL,
          embedded_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_embeddings_model
        ON audit_embeddings(model_id)
      `);
    }
    if (tableExists(db, "file_registry")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_registry_embeddings (
          file_registry_id INTEGER PRIMARY KEY,
          embedding BLOB NOT NULL,
          model_id TEXT NOT NULL,
          embedded_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_file_registry_embeddings_model
        ON file_registry_embeddings(model_id)
      `);
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV2toV3(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "discussions")) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS discussions_fts USING fts5(
          body,
          content='discussions',
          content_rowid='id',
          tokenize='porter unicode61'
        )
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS discussions_ai AFTER INSERT ON discussions BEGIN
          INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS discussions_ad AFTER DELETE ON discussions BEGIN
          INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS discussions_au AFTER UPDATE ON discussions BEGIN
          INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
          INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
        END
      `);
      db.exec(`INSERT INTO discussions_fts(rowid, body) SELECT id, body FROM discussions`);
    }
    if (tableExists(db, "audit")) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5(
          summary,
          content_json,
          content='audit',
          content_rowid='id',
          tokenize='porter unicode61'
        )
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_ai AFTER INSERT ON audit BEGIN
          INSERT INTO audit_fts(rowid, summary, content_json) VALUES (new.id, new.summary, new.content_json);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_ad AFTER DELETE ON audit BEGIN
          INSERT INTO audit_fts(audit_fts, rowid, summary, content_json) VALUES ('delete', old.id, old.summary, old.content_json);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_au AFTER UPDATE ON audit BEGIN
          INSERT INTO audit_fts(audit_fts, rowid, summary, content_json) VALUES ('delete', old.id, old.summary, old.content_json);
          INSERT INTO audit_fts(rowid, summary, content_json) VALUES (new.id, new.summary, new.content_json);
        END
      `);
      db.exec(`INSERT INTO audit_fts(rowid, summary, content_json) SELECT id, summary, content_json FROM audit`);
    }
    if (tableExists(db, "file_registry")) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS file_registry_fts USING fts5(
          summary,
          path,
          content='file_registry',
          tokenize='porter unicode61'
        )
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_ai AFTER INSERT ON file_registry
        WHEN new.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(rowid, summary, path) VALUES (new.rowid, new.summary, new.path);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_ad AFTER DELETE ON file_registry
        WHEN old.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(file_registry_fts, rowid, summary, path) VALUES ('delete', old.rowid, old.summary, old.path);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_au AFTER UPDATE ON file_registry
        WHEN old.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(file_registry_fts, rowid, summary, path) VALUES ('delete', old.rowid, old.summary, old.path);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_au_new AFTER UPDATE ON file_registry
        WHEN new.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(rowid, summary, path) VALUES (new.rowid, new.summary, new.path);
        END
      `);
      db.exec(`INSERT INTO file_registry_fts(rowid, summary, path) SELECT rowid, summary, path FROM file_registry WHERE summary IS NOT NULL`);
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}
function migrateV1toV2(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "identity") && tableExists(db, "plugin_config")) {
      const row2 = db.prepare("SELECT COUNT(*) AS n FROM identity").get();
      if (row2 && row2.n > 0) {
        db.exec(
          "INSERT OR IGNORE INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')"
        );
      }
    }
    db.exec("DROP TABLE IF EXISTS identity");
    db.exec("DROP TABLE IF EXISTS regen_state");
    db.exec("DROP TABLE IF EXISTS project_metadata");
    if (tableExists(db, "skills") && !hasColumn(db, "skills", "scope")) {
      db.exec(
        "ALTER TABLE skills ADD COLUMN scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','template','project-local'))"
      );
    }
    if (tableExists(db, "tasks") && hasColumn(db, "tasks", "success_criteria")) {
      db.exec("DROP TABLE IF EXISTS tasks_new");
      db.exec(`
        CREATE TABLE tasks_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id          INTEGER NOT NULL REFERENCES issues(id),
            branch_id         TEXT    NOT NULL,
            parent_branch_id  TEXT,
            title             TEXT    NOT NULL DEFAULT '',
            description       TEXT    NOT NULL,
            status            TEXT    NOT NULL DEFAULT 'pending',
            attempts          INTEGER NOT NULL DEFAULT 0,
            spec_body         TEXT    NOT NULL DEFAULT '',
            commit_sha        TEXT,
            repo              TEXT,
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL,
            completed_at      TEXT
        )
      `);
      db.exec(`
        INSERT INTO tasks_new (id, issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, commit_sha, repo, created_at, updated_at, completed_at)
        SELECT id, issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, commit_sha, repo, created_at, updated_at, completed_at FROM tasks
      `);
      db.exec("DROP TABLE tasks");
      db.exec("ALTER TABLE tasks_new RENAME TO tasks");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id)"
      );
    }
    if (tableExists(db, "roundtables") && hasColumn(db, "roundtables", "agent")) {
      db.exec("DROP TABLE IF EXISTS roundtables_new");
      db.exec(`
        CREATE TABLE roundtables_new (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id                INTEGER NOT NULL REFERENCES issues(id),
            topic                   TEXT    NOT NULL,
            outcome                 TEXT    NOT NULL DEFAULT '',
            created_at              TEXT    NOT NULL,
            closed_at               TEXT,
            state                   TEXT    NOT NULL DEFAULT 'collecting'
                                      CHECK (state IN ('collecting','awaiting_human','closed','skipped')),
            expected_participants   INTEGER
        )
      `);
      const hasState = hasColumn(db, "roundtables", "state");
      const hasExpected = hasColumn(db, "roundtables", "expected_participants");
      const stateExpr = hasState ? "state" : "'collecting' AS state";
      const expectedExpr = hasExpected ? "expected_participants" : "NULL AS expected_participants";
      db.exec(`
        INSERT INTO roundtables_new (id, issue_id, topic, outcome, created_at, closed_at, state, expected_participants)
        SELECT id, issue_id, topic, outcome, created_at, closed_at, ${stateExpr}, ${expectedExpr} FROM roundtables
      `);
      db.exec("DROP TABLE roundtables");
      db.exec("ALTER TABLE roundtables_new RENAME TO roundtables");
    }
    if (tableExists(db, "roundtable_votes") && hasColumn(db, "roundtable_votes", "agent")) {
      db.exec("DROP TABLE IF EXISTS roundtable_votes_new");
      db.exec(`
        CREATE TABLE roundtable_votes_new (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            roundtable_id  INTEGER NOT NULL REFERENCES roundtables(id),
            participant    TEXT    NOT NULL,
            vote           TEXT    NOT NULL,
            rationale      TEXT    NOT NULL DEFAULT '',
            created_at     TEXT    NOT NULL
        )
      `);
      const hasParticipant = hasColumn(db, "roundtable_votes", "participant");
      const participantExpr = hasParticipant ? "participant" : "agent AS participant";
      db.exec(`
        INSERT INTO roundtable_votes_new (id, roundtable_id, participant, vote, rationale, created_at)
        SELECT id, roundtable_id, ${participantExpr}, vote, rationale, created_at FROM roundtable_votes
      `);
      db.exec("DROP TABLE roundtable_votes");
      db.exec("ALTER TABLE roundtable_votes_new RENAME TO roundtable_votes");
    }
    if (tableExists(db, "file_registry")) {
      const stale2 = [
        "size_bytes",
        "last_commit_sha",
        "language",
        "last_change_type",
        "last_change_at",
        "imports_json",
        "exports_json",
        "metadata_json"
      ];
      const hasStale = stale2.some((c) => hasColumn(db, "file_registry", c));
      if (hasStale) {
        db.exec("DROP TABLE IF EXISTS file_registry_new");
        db.exec(`
          CREATE TABLE file_registry_new (
              repo                TEXT NOT NULL DEFAULT '',
              path                TEXT NOT NULL,
              type                TEXT NOT NULL DEFAULT 'unknown',
              content_md5         TEXT,
              summary             TEXT,
              summary_updated_at  TEXT,
              PRIMARY KEY (repo, path)
          )
        `);
        const hasRepo = hasColumn(db, "file_registry", "repo");
        const hasType = hasColumn(db, "file_registry", "type");
        const hasContentMd5 = hasColumn(db, "file_registry", "content_md5");
        const hasSummary = hasColumn(db, "file_registry", "summary");
        const hasSummaryUpdated = hasColumn(db, "file_registry", "summary_updated_at");
        const repoExpr = hasRepo ? "repo" : "'' AS repo";
        const typeExpr = hasType ? "type" : "'unknown' AS type";
        const md5Expr = hasContentMd5 ? "content_md5" : "NULL AS content_md5";
        const summaryExpr = hasSummary ? "summary" : "NULL AS summary";
        const summaryUpdatedExpr = hasSummaryUpdated ? "summary_updated_at" : "NULL AS summary_updated_at";
        db.exec(`
          INSERT OR IGNORE INTO file_registry_new (repo, path, type, content_md5, summary, summary_updated_at)
          SELECT ${repoExpr}, path, ${typeExpr}, ${md5Expr}, ${summaryExpr}, ${summaryUpdatedExpr} FROM file_registry
        `);
        db.exec("DROP TABLE file_registry");
        db.exec("ALTER TABLE file_registry_new RENAME TO file_registry");
      }
    }
    if (tableExists(db, "agent_runs")) {
      if (!hasColumn(db, "agent_runs", "started_at")) {
        db.exec("ALTER TABLE agent_runs ADD COLUMN started_at TEXT");
      }
      const cols = db.prepare("PRAGMA table_info(agent_runs)").all();
      const completedCol = cols.find((c) => c.name === "completed_at");
      if (completedCol && completedCol.notnull === 1) {
        db.exec("DROP TABLE IF EXISTS agent_runs_new");
        db.exec(`
          CREATE TABLE agent_runs_new (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id      INTEGER REFERENCES tasks(id),
              issue_id     INTEGER REFERENCES issues(id),
              agent_type   TEXT    NOT NULL,
              tokens_in    INTEGER NOT NULL DEFAULT 0,
              tokens_out   INTEGER NOT NULL DEFAULT 0,
              tokens_total INTEGER NOT NULL DEFAULT 0,
              tool_uses    INTEGER NOT NULL DEFAULT 0,
              duration_ms  INTEGER NOT NULL DEFAULT 0,
              started_at   TEXT,
              completed_at TEXT
          )
        `);
        db.exec(`
          INSERT INTO agent_runs_new (id, task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, tool_uses, duration_ms, started_at, completed_at)
          SELECT id, task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, tool_uses, duration_ms, started_at, completed_at FROM agent_runs
        `);
        db.exec("DROP TABLE agent_runs");
        db.exec("ALTER TABLE agent_runs_new RENAME TO agent_runs");
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id)"
        );
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id)"
        );
      }
    }
    commitTransaction(db);
  } catch (err4) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err4;
  }
}

// ../mcp/trajectory-server/src/symbol-index.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// ../mcp/trajectory-server/src/parsing/extract.ts
var SH_BUILTINS = new Set(
  "echo printf local export declare readonly return exit set unset shift cd test [ [[ true false read eval exec trap wait source . if then else fi for do done while case esac cat grep sed awk tr cut head tail sort uniq wc mkdir rm cp mv ln chmod touch date sleep command type jq git basename dirname xargs find tee env mktemp pwd kill ps sqlite3 node bash sh python3 curl gh".split(
    " "
  )
);
var STOPWORDS = new Set(
  "a an the and or of to in on for with by is are was were be been when where what which who how why does do did it its this that these those from as at into per not no than then there their them our we you i set get".split(
    " "
  )
);
function splitWords(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").toLowerCase().trim();
}

// ../mcp/trajectory-server/src/symbol-index.ts
var EXTRACTOR_VERSION = 16;
var execFileAsync = promisify(execFile);
var OR_FALLBACK_MIN_HITS = 3;
var FAILED_SUFFIX = ":failed";
var SYMBOL_COLUMNS = "s.id, s.repo, s.path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, s.run_order";
var TABLE_EDGES = /* @__PURE__ */ new Set(["reads_table", "writes_table", "indexes", "triggers_on"]);
var TABLE_EDGES_JSON = JSON.stringify([...TABLE_EDGES]);
var NAME_ONLY_EDGES = /* @__PURE__ */ new Set(["reads_config", "covers"]);
var NAME_ONLY_JSON = JSON.stringify([...NAME_ONLY_EDGES]);
function outsideConceptLane(path) {
  return isTestPath(path) || /(^|\/)(__fixtures(__)?|fixtures__)\//.test(path);
}
function queryWords(query) {
  return [...new Set(splitWords(query).split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
}
function keywordSearchSymbols(db, repo, query, limit) {
  const words = queryWords(query);
  if (words.length === 0) return { hits: [], match: "all_terms" };
  const search2 = (op) => db.all(
    `SELECT ${SYMBOL_COLUMNS}, bm25(wm_symbols_fts, 10.0, 3.0, 4.0) AS rank
         FROM wm_symbols_fts CROSS JOIN wm_symbols s ON s.id = wm_symbols_fts.rowid
        WHERE wm_symbols_fts MATCH ? AND s.repo = ? AND s.kind <> 'module'
        ORDER BY rank, s.id
        LIMIT ?`,
    [words.map((w) => `"${w}"`).join(` ${op} `), repo, limit]
  );
  const all2 = search2("AND");
  const toHit = (r) => ({ ...normalizeRow(r), score: -r.rank });
  if (all2.length >= OR_FALLBACK_MIN_HITS || words.length < 2) return { hits: all2.map(toHit), match: "all_terms" };
  const seen = new Set(all2.map((r) => r.id));
  const any = search2("OR").filter((r) => !seen.has(r.id));
  return { hits: [...all2, ...any].slice(0, limit).map(toHit), match: any.length > 0 ? "any_term" : "all_terms" };
}
function normalizeRow(r) {
  return {
    id: Number(r.id),
    repo: r.repo,
    path: r.path,
    kind: r.kind,
    qualified_name: r.qualified_name,
    signature: r.signature,
    doc: r.doc,
    start_line: Number(r.start_line),
    end_line: Number(r.end_line),
    body_hash: r.body_hash,
    exported: Number(r.exported),
    run_order: r.run_order === null || r.run_order === void 0 ? null : Number(r.run_order)
  };
}
function symbolById(db, id) {
  const row2 = db.get(`SELECT ${SYMBOL_COLUMNS} FROM wm_symbols s WHERE s.id = ?`, [id]);
  return row2 ? normalizeRow(row2) : null;
}

// ../mcp/trajectory-server/src/utils/timeouts.ts
var SUBPROCESS_TIMEOUT_MS = 5e3;
var WORKTREE_SETUP_COMMAND_TIMEOUT_MS = 10 * 60 * 1e3;
var WORKTREE_DEPS_INSTALL_TIMEOUT_MS = 10 * 60 * 1e3;

// ../mcp/trajectory-server/src/commit-subject.ts
var TYPES = "feat|fix|improvement|refactor|docs|test|perf|chore|build|ci|style|revert|research";
var PICTOGRAPH = String.raw`\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?`;
var EMOJI = String.raw`(?::[a-z0-9_+-]+:|${PICTOGRAPH}(?:\u{200D}${PICTOGRAPH})*)`;
var SUBJECT_RE = new RegExp(`^${EMOJI} (?:${TYPES})(?:\\([a-z0-9._/-]+\\))?: \\S`, "u");

// ../mcp/trajectory-server/src/review-sql.ts
var LEGACY_CHAIN_HOPS = 10;
var jsonSql = (fn, alias, path) => `CASE WHEN json_valid(${alias}.content_json) THEN ${fn}(${alias}.content_json, '${path}') END`;
var integrateRowSql = (alias) => `${alias}.event_type = 'task_integrated' AND ${alias}.from_node = 'hook:integrate'`;
var carriesAnchorSql = (alias) => `${integrateRowSql(alias)} AND ${jsonSql("json_type", alias, "$.review_anchor_at")} = 'text'`;
var legacyIntegrateSql = (alias) => `${integrateRowSql(alias)} AND ${jsonSql("json_type", alias, "$.review_anchor_at")} IS NOT 'text'
          AND ${jsonSql("json_type", alias, "$.reviewed_sha")} = 'text'`;
var LEGACY_CHAIN_ANCHOR_SQL = `(WITH RECURSIVE chain(sha, hops) AS (
          SELECT ${jsonSql("json_extract", "a", "$.reviewed_sha")}, 1
          UNION
          SELECT ${jsonSql("json_extract", "c", "$.reviewed_sha")}, chain.hops + 1 FROM chain JOIN audit c
            ON json_valid(c.content_json) AND ${legacyIntegrateSql("c")}
              AND ${jsonSql("json_extract", "c", "$.task_id")} = t.id
              AND ${jsonSql("json_extract", "c", "$.commit_sha")} = chain.sha
          WHERE chain.hops < ${LEGACY_CHAIN_HOPS})
        SELECT MIN(CASE WHEN p.event_type = 'bro_verification_pass' THEN p.created_at
          ELSE ${jsonSql("json_extract", "p", "$.review_anchor_at")} END)
        FROM chain JOIN audit p
          ON json_valid(p.content_json)
            AND (p.event_type = 'bro_verification_pass' OR (${carriesAnchorSql("p")}))
            AND ${jsonSql("json_extract", "p", "$.task_id")} = t.id
            AND ${jsonSql("json_extract", "p", "$.commit_sha")} = chain.sha)`;
var REVIEW_ANCHOR_AT_SQL = `(SELECT MIN(CASE
      WHEN ${carriesAnchorSql("a")}
      THEN json_extract(a.content_json, '$.review_anchor_at')
      WHEN ${legacyIntegrateSql("a")}
      THEN COALESCE(${LEGACY_CHAIN_ANCHOR_SQL}, a.created_at)
      ELSE a.created_at END) FROM audit a
    WHERE a.event_type IN ('review_handoff', 'bro_verification_pass', 'task_integrated') AND json_valid(a.content_json)
      AND json_extract(a.content_json, '$.task_id') = t.id
      AND json_extract(a.content_json, '$.commit_sha') = t.commit_sha)`;
var HAS_PASS_SQL = `(EXISTS (SELECT 1 FROM validation_attempts va
  WHERE va.task_id = t.id AND va.verdict = 'pass' AND va.created_at >= ${REVIEW_ANCHOR_AT_SQL})
  AND ${newestVerdictPassSql("t")})`;
var reviewSkipAuthoredSql = (alias) => `((${alias}.event_type = 'review_gate_waived' AND ${alias}.from_node = 'bro')
      OR (${alias}.event_type = 'review_gate_bypassed' AND ${alias}.from_node IN ('bro', 'hook:close-issue-on-merge')))`;
var GATE_SKIP_RECORDED_SQL = `EXISTS (SELECT 1 FROM audit g
  WHERE ${reviewSkipAuthoredSql("g")}
    AND json_valid(g.content_json)
    AND json_extract(g.content_json, '$.task_id') = t.id
    AND COALESCE(json_extract(g.content_json, '$.commit_sha'), '') = COALESCE(t.commit_sha, ''))`;
function newestVerdictPassSql(alias) {
  return `COALESCE((SELECT v.verdict FROM validation_attempts v WHERE v.task_id = ${alias}.id ORDER BY v.id DESC LIMIT 1), '') = 'pass'`;
}

// ../mcp/trajectory-server/src/middleware/agent-scope.ts
var FIRST_CLASS_ROLES = /* @__PURE__ */ new Set(["bro", "swe", "code-reviewer"]);
function normalizeAgent(name) {
  if (typeof name !== "string") return "unknown";
  const lower = name.toLowerCase().replace(/^tmb:/, "");
  if (!lower) return "unknown";
  if (FIRST_CLASS_ROLES.has(lower)) return lower;
  if (/^[a-z][a-z0-9_-]*$/.test(lower)) return "consultant";
  return "unknown";
}
var VALID_AGENTS = ["bro", "swe", "code-reviewer", "consultant slug matching ^[a-z][a-z0-9_-]*$"];
function missingAgentDiagnostics(toolName, allowedRoles, received) {
  const agentReceived = received === void 0 ? null : received;
  return {
    reason: "agent_missing_or_invalid",
    agent_received: agentReceived,
    valid_agents: VALID_AGENTS,
    message: `\`agent\` was missing or invalid (received: ${JSON.stringify(agentReceived)}). This is a missing-argument error, not a role restriction \u2014 retry with agent set to your role: 'bro', 'swe', 'code-reviewer', or a consultant slug matching ^[a-z][a-z0-9_-]*$. ${toolName} accepts: ${allowedRoles.join(", ")}.`
  };
}
function forbidden(toolName, agent, allowedRoles, received) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          agent === "unknown" ? {
            error: "missing_argument",
            argument: "agent",
            tool: toolName,
            allowed_roles: [...allowedRoles],
            ...missingAgentDiagnostics(toolName, allowedRoles, received)
          } : { error: "forbidden", tool: toolName, caller_role: agent, allowed_roles: [...allowedRoles] }
        )
      }
    ]
  };
}
var gatedRoles = /* @__PURE__ */ new WeakMap();
function requireRoles(toolName, allowedRoles, handler) {
  const allowed = new Set(allowedRoles);
  const gated = async (args) => {
    const agent = normalizeAgent(args["agent"]);
    if (!allowed.has(agent)) return forbidden(toolName, agent, allowedRoles, args["agent"]);
    return handler(args);
  };
  gatedRoles.set(gated, [...allowedRoles]);
  return gated;
}
function redactIssue(issue, agent, opts) {
  if (agent === "swe" || agent === "unknown") {
    const { description: _, ...rest } = issue;
    void _;
    const truncated = rest.objective.length > 120 ? rest.objective.slice(0, 120) + "..." : rest.objective;
    return { ...rest, objective: truncated };
  }
  if (!opts?.include_description) {
    const { description: _, ...rest } = issue;
    void _;
    return rest;
  }
  return issue;
}

// ../mcp/trajectory-server/src/embeddings/store.ts
function packEmbedding(v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function unpackEmbedding(b) {
  const out = new Float32Array(b.byteLength / 4);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}
function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
var INSERT_SQL = {
  discussions: "INSERT OR REPLACE INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)",
  audit: "INSERT OR REPLACE INTO audit_embeddings (audit_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)",
  wm_directories: "INSERT OR REPLACE INTO wm_directories_embeddings (dir_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)",
  wm_files: "INSERT OR REPLACE INTO wm_files_embeddings (file_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)"
};
var SELECT_SQL = {
  discussions: "SELECT discussion_id AS rowid, embedding FROM discussions_embeddings WHERE model_id = ?",
  audit: "SELECT audit_id AS rowid, embedding FROM audit_embeddings WHERE model_id = ?",
  wm_directories: "SELECT e.dir_id AS rowid, e.embedding FROM wm_directories_embeddings e JOIN wm_directories d ON d.id = e.dir_id WHERE e.model_id = ? AND d.repo = ?",
  wm_files: "SELECT e.file_id AS rowid, e.embedding FROM wm_files_embeddings e JOIN wm_files f ON f.id = e.file_id WHERE e.model_id = ? AND f.repo = ?"
};
function worldModelEmbedText(path, body) {
  const text2 = (body ?? "").replace(/<\/?untrusted-content[^>]*>/g, "").trim();
  return text2 ? `${path}: ${text2}` : path;
}
function auditEmbedText(summary2, contentJson) {
  return contentJson && contentJson !== "{}" ? `${summary2} ${contentJson}` : summary2;
}
async function embedAndStore(db, table, rowid, text2) {
  const v = await embed(text2);
  if (v === null || !db.isOpen) return;
  const sql = INSERT_SQL[table];
  db.run(sql, [rowid, packEmbedding(v), MODEL_ID, (/* @__PURE__ */ new Date()).toISOString()]);
}
async function topKByCosine(db, table, query, k, filterParams = []) {
  const qv = await embed(query);
  if (qv === null) return [];
  const sql = SELECT_SQL[table];
  const rows = db.all(sql, [MODEL_ID, ...filterParams]);
  const scored = rows.map((r) => {
    const v = unpackEmbedding(r.embedding);
    if (v.length !== qv.length) return null;
    return { rowid: r.rowid, score: cosine(qv, v) };
  }).filter((r) => r !== null);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ../mcp/trajectory-server/src/hooks/ensure-mcp-deps-installed.ts
import { basename as basename3, delimiter, dirname as dirname3, isAbsolute as isAbsolute2, join as join6, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";

// ../mcp/trajectory-server/src/hooks/gate.ts
var ALLOW = Object.freeze({ stdout: "", code: 0 });

// ../mcp/trajectory-server/src/hooks/ensure-mcp-deps-installed.ts
var MCP_REL = join6("mcp", "trajectory-server");
var STAGING_STALE_MS = 60 * 60 * 1e3;

// ../mcp/trajectory-server/src/embeddings/backfill.ts
var MISSING_WHERE = {
  discussions: "id NOT IN (SELECT discussion_id FROM discussions_embeddings WHERE model_id = ?)",
  audit: "id NOT IN (SELECT audit_id FROM audit_embeddings WHERE model_id = ?)",
  wm_directories: "id NOT IN (SELECT dir_id FROM wm_directories_embeddings WHERE model_id = ?)",
  wm_files: "purpose <> '' AND id NOT IN (SELECT file_id FROM wm_files_embeddings WHERE model_id = ?)"
};
var MISSING_SQL = {
  discussions: `SELECT id, body AS text FROM discussions WHERE ${MISSING_WHERE.discussions} ORDER BY id DESC LIMIT ?`,
  audit: `SELECT id, summary AS text, content_json FROM audit WHERE ${MISSING_WHERE.audit} ORDER BY id DESC LIMIT ?`,
  wm_directories: `SELECT id, CASE WHEN path = '' THEN repo ELSE path END AS text, summary AS body FROM wm_directories WHERE ${MISSING_WHERE.wm_directories} ORDER BY id DESC LIMIT ?`,
  wm_files: `SELECT id, path AS text, purpose AS body FROM wm_files WHERE ${MISSING_WHERE.wm_files} ORDER BY id DESC LIMIT ?`
};
var RECHECK_BATCH = 50;
function embedText(table, r) {
  if (table === "audit") return auditEmbedText(r.text, r.content_json ?? null);
  if (table === "wm_directories" || table === "wm_files") return worldModelEmbedText(r.text, r.body ?? null);
  return r.text;
}
async function backfillMissing(db, table, limit = 50, onRow) {
  const rows = db.all(MISSING_SQL[table], [MODEL_ID, limit]);
  let attempted = 0;
  for (let i = 0; i < rows.length; i += RECHECK_BATCH) {
    if (!db.isOpen) break;
    const batch = rows.slice(i, i + RECHECK_BATCH);
    const ids = batch.map((r) => r.id);
    const stillMissing = new Set(
      db.all(
        `SELECT id FROM ${table} WHERE ${MISSING_WHERE[table]} AND id IN (${ids.map(() => "?").join(", ")})`,
        [MODEL_ID, ...ids]
      ).map((r) => r.id)
    );
    for (const r of batch) {
      if (!stillMissing.has(r.id)) continue;
      attempted++;
      await embedAndStore(db, table, r.id, embedText(table, r)).catch(
        (e) => console.error(`[embeddings] backfill ${table} #${r.id} failed:`, e)
      );
      onRow?.();
    }
  }
  return attempted;
}

// ../mcp/trajectory-server/src/fts-query.ts
function queryTokens(raw) {
  return Array.from(raw.matchAll(/"([^"]*)"|\S+/g), (m) => (m[1] ?? m[0].replace(/^"+|"+$/g, "")).trim()).filter(
    (token) => token.length > 0
  );
}
function quoted(token) {
  return `"${token.replace(/"/g, '""')}"`;
}
function toFtsQuery(raw) {
  const tokens = queryTokens(raw).map(quoted);
  return tokens.length > 0 ? tokens.join(" ") : '""';
}
function withFtsGuard(run) {
  try {
    return run();
  } catch (e) {
    const message2 = e instanceof Error ? e.message : String(e);
    if (/fts5|no such column/i.test(message2)) {
      throw new Error(`fts_query_invalid: ${message2}`);
    }
    throw e;
  }
}

// ../mcp/trajectory-server/src/tools/audit.ts
function resolveIssueRepo(db, issueId) {
  return db.get("SELECT repo FROM issues WHERE id = ?", [issueId])?.repo ?? null;
}
var AuditWriterError = class extends Error {
  constructor(eventType, writer) {
    super(
      `audit_event_not_writable_by_role: '${writer}' may not write '${eventType}' (writers: ${auditEventWriters(eventType).join(", ")})`
    );
    this.eventType = eventType;
    this.writer = writer;
  }
  eventType;
  writer;
};
function insertAudit(db, entry) {
  assertAuditEventType(entry.event_type);
  if (entry.writer !== void 0 && !isAuditEventWritableBy(entry.event_type, entry.writer)) {
    throw new AuditWriterError(entry.event_type, entry.writer);
  }
  const contentJson = entry.content_json ?? "{}";
  const repo = entry.repo ?? resolveIssueRepo(db, entry.issue_id);
  const res = db.run(
    `INSERT INTO audit
       (issue_id, branch_id, from_node, event_type, summary, content_json, created_at, repo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.issue_id,
      entry.branch_id ?? null,
      entry.from_node,
      entry.event_type,
      entry.summary,
      contentJson,
      entry.created_at ?? nowISO(),
      repo
    ]
  );
  const id = Number(res.lastInsertRowid);
  void embedAndStore(db, "audit", id, auditEmbedText(entry.summary, contentJson)).catch(
    (e) => console.error("[embeddings] insertAudit embed failed:", e)
  );
  return id;
}

// ../mcp/trajectory-server/src/world-model/concepts.ts
var DERIVED_LABEL = "derived, unverified";
var DERIVED_MAX_DEPTH = 4;
var DERIVED_MAX_STEPS = 8;
var DERIVED_SEED_HITS = 5;
var DERIVED_HELPER_FAN_IN = 5;
var DERIVED_EDGES = ["calls", "sources", "runs"];
var OR_FALLBACK_MIN_HITS2 = 3;
var SYMBOL_REF_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, qualified_name: { type: "string" } },
  required: ["path", "qualified_name"]
};
var CLAIM_ARGS_SCHEMA = {
  type: "object",
  description: "The claim's args. exists {path, qualified_name}: the symbol is indexed. calls {from: {path, qualified_name}, to: {path, qualified_name}}: an edge runs from one to the other. only_writers_of {table, writers: [path]}: no file outside writers writes table. tested_by {path, qualified_name, test_path}: a symbol in test_path references the symbol.",
  properties: {
    path: { type: "string", description: "exists, tested_by: the symbol's repo-relative file path." },
    qualified_name: { type: "string", description: "exists, tested_by: the symbol name as indexed." },
    from: { ...SYMBOL_REF_SCHEMA, description: "calls: the caller, {path, qualified_name}." },
    to: { ...SYMBOL_REF_SCHEMA, description: "calls: the callee, {path, qualified_name}." },
    table: { type: "string", description: "only_writers_of: the SQL table name." },
    writers: {
      type: "array",
      items: { type: "string" },
      description: "only_writers_of: the repo-relative paths of every file allowed to write table."
    },
    test_path: { type: "string", description: "tested_by: the repo-relative path of the test file." }
  }
};
function queryWords2(query) {
  return [...new Set(splitWords(query).split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
}
var WORD_MATCH_SQL = {
  wm_concepts_fts: "SELECT 1 AS hit FROM wm_concepts_fts WHERE wm_concepts_fts MATCH ? AND rowid = CAST(? AS INTEGER)",
  wm_symbols_fts: "SELECT 1 AS hit FROM wm_symbols_fts WHERE wm_symbols_fts MATCH ? AND rowid = CAST(? AS INTEGER)",
  wm_files_fts: "SELECT 1 AS hit FROM wm_files_fts WHERE wm_files_fts MATCH ? AND rowid = CAST(? AS INTEGER)"
};
function wordsMatched(db, table, rowid, words) {
  return words.filter((w) => db.get(WORD_MATCH_SQL[table], [`"${w}"`, rowid]) !== void 0).length;
}
function majority(words) {
  return Math.floor(words.length / 2) + 1;
}
function searchConcepts(db, repo, query, limit) {
  const words = queryWords2(query);
  if (words.length === 0) return [];
  const search2 = (op) => db.all(
    `SELECT c.id, c.name, c.body
         FROM wm_concepts_fts CROSS JOIN wm_concepts c ON c.id = wm_concepts_fts.rowid
        WHERE wm_concepts_fts MATCH ? AND c.repo = ? AND c.status <> 'retired'
        ORDER BY bm25(wm_concepts_fts, 10.0, 4.0, 2.0), c.id
        LIMIT ?`,
    [words.map((w) => `"${w}"`).join(` ${op} `), repo, limit]
  );
  let rows = search2("AND");
  if (rows.length < OR_FALLBACK_MIN_HITS2 && words.length > 1) {
    const seen = new Set(rows.map((r) => Number(r.id)));
    const covered = (id) => wordsMatched(db, "wm_concepts_fts", id, words) >= majority(words);
    rows = [...rows, ...search2("OR").filter((r) => !seen.has(Number(r.id)) && covered(Number(r.id)))].slice(0, limit);
  }
  return rows.map((r, i) => {
    const counts = db.all(
      `SELECT trust, COUNT(*) AS n FROM wm_concept_steps WHERE concept_id = ? GROUP BY trust`,
      [r.id]
    );
    const trust = { verified: 0, suspect: 0, broken: 0 };
    for (const c of counts) trust[c.trust] = Number(c.n);
    return {
      id: Number(r.id),
      name: r.name,
      body: r.body,
      step_count: trust.verified + trust.suspect + trust.broken,
      trust,
      rank: i + 1
    };
  });
}
function stepSymbol(s) {
  return {
    id: s.id,
    repo: s.repo,
    path: s.path,
    kind: s.kind,
    qualified_name: s.qualified_name,
    signature: s.signature,
    doc: s.doc,
    line_start: s.start_line,
    line_end: s.end_line
  };
}
function fileAnchor(db, a) {
  if (!db.get(`SELECT 1 AS hit FROM wm_files WHERE repo = ? AND path = ?`, [a.repo, a.path])) return null;
  return {
    id: null,
    repo: a.repo,
    path: a.path,
    kind: "file",
    qualified_name: a.path,
    signature: null,
    doc: null,
    line_start: null,
    line_end: null
  };
}
function anchorSymbol(db, a) {
  if (!a.kind) return fileAnchor(db, a);
  const row2 = db.get(
    `SELECT id FROM wm_symbols WHERE repo = ? AND path = ? AND kind = ? AND qualified_name = ?`,
    [a.repo, a.path, a.kind, a.qualified_name]
  );
  const symbol = row2 ? symbolById(db, Number(row2.id)) : null;
  return symbol ? stepSymbol(symbol) : null;
}
function getConcept(db, id) {
  const c = db.get(
    `SELECT id, name, body, status, status_reason, updated_at FROM wm_concepts WHERE id = ?`,
    [id]
  );
  if (!c) return null;
  const steps = db.all(`SELECT * FROM wm_concept_steps WHERE concept_id = ? ORDER BY ordinal`, [id]).map((s) => {
    const symbol = anchorSymbol(db, s);
    return {
      ordinal: Number(s.ordinal),
      description: s.description,
      trust: symbol === null && s.kind ? "broken" : s.trust,
      trust_reason: symbol === null && s.kind ? "anchor gone" : s.trust_reason,
      handoff: s.handoff,
      symbol
    };
  });
  return {
    id: Number(c.id),
    name: c.name,
    body: c.body,
    status: c.status,
    status_reason: c.status_reason,
    updated_at: c.updated_at,
    steps
  };
}
function outgoingDerived(db, id) {
  return Number(
    db.get(
      `SELECT COUNT(*) AS n FROM wm_edges
        WHERE src_id = ? AND resolution = 'exact' AND kind IN (SELECT value FROM json_each(?))`,
      [id, JSON.stringify(DERIVED_EDGES)]
    ).n
  );
}
function isLeafHelper(db, id) {
  const callers = db.get(
    `SELECT COUNT(DISTINCT src_id) AS n FROM wm_edges WHERE dst_id = ? AND kind = 'calls' AND resolution = 'exact'`,
    [id]
  ).n;
  return Number(callers) >= DERIVED_HELPER_FAN_IN && outgoingDerived(db, id) === 0;
}
function fileSeed(db, repo, path, words) {
  const ids = db.all(
    `SELECT id FROM wm_symbols WHERE repo = ? AND path = ? AND kind <> 'module' ORDER BY start_line, id`,
    [repo, path]
  );
  let best = null;
  for (const row2 of ids) {
    const id = Number(row2.id);
    const c = { id, matched: wordsMatched(db, "wm_symbols_fts", id, words), out: outgoingDerived(db, id) };
    if (!best || c.matched > best.matched || c.matched === best.matched && c.out > best.out) best = c;
  }
  return best ? symbolById(db, best.id) : null;
}
function seedSymbol(db, repo, query, candidates) {
  const words = queryWords2(query);
  if (words.length === 0) return null;
  for (const c of candidates) {
    if (c.kind === "symbol") {
      const s2 = symbolById(db, c.id);
      if (s2 && !outsideConceptLane(s2.path) && wordsMatched(db, "wm_symbols_fts", s2.id, words) >= majority(words)) return s2;
      continue;
    }
    if (outsideConceptLane(c.path)) continue;
    const file = db.get(`SELECT id FROM wm_files WHERE repo = ? AND path = ?`, [repo, c.path]);
    if (!file || wordsMatched(db, "wm_files_fts", Number(file.id), words) < majority(words)) continue;
    const s = fileSeed(db, repo, c.path, words);
    if (s) return s;
  }
  return null;
}
function derivedChain(db, repo, query, candidates = keywordSearchSymbols(db, repo, query, DERIVED_SEED_HITS).hits.map((h) => ({ kind: "symbol", id: h.id }))) {
  const seed = seedSymbol(db, repo, query, candidates);
  if (!seed) return null;
  const order = [];
  const seen = /* @__PURE__ */ new Set([seed.id]);
  let frontier = [seed];
  for (let depth = 0; frontier.length > 0 && order.length < DERIVED_MAX_STEPS; depth++) {
    const next = [];
    for (const s of frontier) {
      if (order.length >= DERIVED_MAX_STEPS) break;
      const via = /* @__PURE__ */ new Map();
      order.push({ symbol: s, via });
      if (depth >= DERIVED_MAX_DEPTH) continue;
      const out = db.all(
        `SELECT e.dst_id, e.kind, d.path
           FROM wm_edges e JOIN wm_symbols d ON d.id = e.dst_id
          WHERE e.src_id = ? AND e.resolution = 'exact' AND e.kind IN (SELECT value FROM json_each(?))
          ORDER BY e.line, e.rowid`,
        [s.id, JSON.stringify(DERIVED_EDGES)]
      );
      for (const e of out) {
        const dst = Number(e.dst_id);
        if (seen.has(dst) || outsideConceptLane(e.path)) continue;
        seen.add(dst);
        if (isLeafHelper(db, dst)) continue;
        const row2 = symbolById(db, dst);
        if (!row2) continue;
        via.set(dst, e.kind);
        next.push(row2);
      }
    }
    frontier = next;
  }
  const steps = order.map(({ symbol, via }, i) => {
    const following = order[i + 1]?.symbol.id;
    return {
      ordinal: i + 1,
      description: symbol.doc || symbol.signature,
      trust: null,
      trust_reason: null,
      handoff: following !== void 0 ? via.get(following) ?? null : null,
      symbol: stepSymbol(symbol)
    };
  });
  return { label: DERIVED_LABEL, steps };
}

// ../mcp/trajectory-server/src/utils/repo-paths.ts
import { dirname as dirname4, isAbsolute as isAbsolute4, resolve as resolve3 } from "node:path";

// ../mcp/trajectory-server/src/tools/containment.ts
import { isAbsolute as isAbsolute3, join as join7, parse, relative as relative3, sep as sep3 } from "node:path";
function projectRootFromDbPath(dbPath) {
  if (!dbPath || dbPath === ":memory:") return null;
  const segments = dbPath.split(sep3);
  const idx = segments.lastIndexOf(".claude");
  if (idx <= 0) return null;
  return segments.slice(0, idx).join(sep3) || sep3;
}

// ../mcp/trajectory-server/src/utils/repo-paths.ts
function repoRowPath(db, path) {
  if (isAbsolute4(path)) return path;
  const base = db.dbPath === ":memory:" ? process.cwd() : projectRootFromDbPath(db.dbPath) ?? dirname4(db.dbPath);
  return resolve3(base, path);
}
function resolveRepoForSync(db, repoName) {
  if (repoName) {
    const row2 = db.get(`SELECT name, path FROM repos WHERE name = ?`, [repoName]);
    return row2 ? { name: row2.name, path: repoRowPath(db, row2.path) } : null;
  }
  const rows = db.all(`SELECT name, path FROM repos`);
  if (rows.length !== 1) return null;
  return { name: rows[0].name, path: repoRowPath(db, rows[0].path) };
}

// ../mcp/trajectory-server/src/sync/backend.ts
import { spawnSync } from "node:child_process";

// ../mcp/trajectory-server/src/utils/live-cli-guard.ts
function liveCliBlockReason(env = process.env) {
  if (env.TMB_FORBID_LIVE_SYNC === "1") return "TMB_FORBID_LIVE_SYNC=1";
  if (env.NODE_TEST_CONTEXT) return `NODE_TEST_CONTEXT=${env.NODE_TEST_CONTEXT}`;
  return null;
}
function liveCliBlockedMessage(reason, cmd, args) {
  return `live CLI blocked in test context (${reason}) \u2014 refused to spawn "${cmd} ${args.join(" ")}"; inject _spawnFn`;
}

// ../mcp/trajectory-server/src/sync/backend.ts
var _availabilityCache = null;
function detectAvailable(_spawnFn) {
  if (_spawnFn === void 0 && _availabilityCache !== null) {
    return _availabilityCache;
  }
  const check = (cmd, args) => {
    try {
      if (_spawnFn) {
        const result3 = _spawnFn(cmd, args);
        return result3.status === 0;
      }
      if (liveCliBlockReason()) return false;
      const result2 = spawnSync(cmd, args, { timeout: SUBPROCESS_TIMEOUT_MS, encoding: "utf8" });
      return result2.status === 0;
    } catch {
      return false;
    }
  };
  const result = {
    gh: check("gh", ["auth", "status"]),
    glab: check("glab", ["auth", "status"])
  };
  if (_spawnFn === void 0) {
    _availabilityCache = result;
  }
  return result;
}
function detectPreferred(repoPath) {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      ...repoPath === null ? {} : { cwd: repoPath },
      timeout: SUBPROCESS_TIMEOUT_MS,
      encoding: "utf8"
    });
    if (result.status !== 0) return null;
    const url = (result.stdout ?? "").trim();
    const provider = classifyUrl(url);
    if (provider === "github") return "gh";
    if (provider === "gitlab") return "glab";
    return null;
  } catch {
    return null;
  }
}
function remoteSyncEnvDisabled() {
  const v = process.env.TMB_DISABLE_REMOTE_SYNC;
  return v === "1" || v?.toLowerCase() === "true";
}
function resolveBackend(configValue, repoRemotes2, hasSpawnFn = false, availability) {
  if (!hasSpawnFn && remoteSyncEnvDisabled()) {
    return null;
  }
  if (configValue === "off") return "off";
  if (configValue === "gh") return "gh";
  if (configValue === "glab") return "glab";
  if (configValue === "both") return "both";
  const available = availability ?? detectAvailable();
  const ghUsable = (repoRemotes2?.github ?? false) && available.gh;
  const glUsable = (repoRemotes2?.gitlab ?? false) && available.glab;
  if (ghUsable && glUsable) return "both";
  if (ghUsable) return "gh";
  if (glUsable) return "glab";
  return null;
}
function resolveBackendFor(configValue, repoRemotes2, spawnFn) {
  const availability = configValue === "auto" && spawnFn ? detectAvailable(spawnFn) : void 0;
  return resolveBackend(configValue, repoRemotes2, spawnFn !== void 0, availability);
}
function readIssueSyncConfig(db) {
  const row2 = db.get(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
  if (!row2) return "off";
  try {
    return String(JSON.parse(row2.value_json));
  } catch {
    return "off";
  }
}
function remoteSyncGate(db, opts = {}) {
  if (remoteSyncEnvDisabled()) return { enabled: false, reason: "env_disabled" };
  const config = readIssueSyncConfig(db);
  if (config === "off") return { enabled: false, reason: "issue_sync_off" };
  const explicit = config === "gh" || config === "glab" || config === "both";
  const availability = explicit ? void 0 : detectAvailable(opts.spawnFn);
  const backend = resolveBackend(config, opts.repoRemotes ?? null, true, availability);
  if (backend === null || backend === "off") return { enabled: false, reason: "no_backend" };
  return { enabled: true };
}

// ../mcp/trajectory-server/src/sync/issue_sync.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join8 } from "node:path";
function resolveLogDir() {
  if (process.env.TMB_SYNC_LOG_DIR) return process.env.TMB_SYNC_LOG_DIR;
  return resolveClaudeLogDir();
}
var readyLogDirs = /* @__PURE__ */ new Set();
function syncLog(entry) {
  try {
    const logDir = resolveLogDir();
    if (!readyLogDirs.has(logDir)) {
      mkdirSync2(logDir, { recursive: true });
      readyLogDirs.add(logDir);
    }
    const line = JSON.stringify({ ...entry, ts: (/* @__PURE__ */ new Date()).toISOString() }) + "\n";
    appendFileSync2(join8(logDir, "issue-sync.log"), line);
  } catch {
  }
}
function defaultSpawnFn(cmd, args, opts) {
  const blockReason = liveCliBlockReason();
  if (blockReason) {
    const message2 = liveCliBlockedMessage(blockReason, cmd, args);
    syncLog({ event: "live_cli_blocked", cmd, args, reason: blockReason });
    return { status: null, stdout: "", stderr: message2 };
  }
  const result = spawnSync2(cmd, args, opts);
  return {
    status: result.status,
    stdout: result.stdout ? String(result.stdout) : "",
    stderr: result.stderr ? String(result.stderr) : ""
  };
}
function parseRemoteIid(stdout, _kind) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const urlMatch = trimmed.match(
      /https?:\/\/([^/]+)\/([^/]+(?:\/[^/]+)+?)\/-?\/?(?:issues|work_items)\/(\d+)/
    );
    if (urlMatch) {
      const host = urlMatch[1];
      const repoPath = urlMatch[2];
      const iid = parseInt(urlMatch[3], 10);
      return { iid, host, repoPath };
    }
  }
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (/^#\d+$/.test(trimmed)) {
      const iid = parseInt(trimmed.slice(1), 10);
      return { iid, host: "", repoPath: "" };
    }
  }
  return null;
}
function extractRemoteHostAndRepo(remoteUrl) {
  if (!remoteUrl) return null;
  const httpMatch = remoteUrl.match(/https?:\/\/([^/]+)\/([^/]+(?:\/[^/]+)+?)(?:\.git)?$/);
  if (httpMatch) return { host: httpMatch[1], repoPath: httpMatch[2] };
  const sshMatch = remoteUrl.match(/git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return { host: sshMatch[1], repoPath: sshMatch[2] };
  return null;
}
async function readBackVerify(backend, iid, spawnFn, spawnOpts, repoSlug) {
  try {
    let result;
    if (backend === "gh") {
      const args = ["issue", "view", String(iid), "--json", "number,url"];
      if (repoSlug) args.push("--repo", repoSlug);
      result = spawnFn("gh", args, spawnOpts);
    } else {
      const args = ["issue", "view", String(iid)];
      if (repoSlug) args.push("-R", repoSlug);
      result = spawnFn("glab", args, spawnOpts);
    }
    if (result.status !== 0) {
      return { ok: false, reason: verifyFailureReason("read_back_non_zero_exit", result.stderr) };
    }
    if (backend === "gh") {
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return { ok: false, reason: "read_back_parse_failed" };
      }
      if (parsed.url && parsed.url.includes("/pull/")) {
        return { ok: false, reason: "read_back_is_pr" };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "read_back_error" };
  }
}
function repoSlugFromRemoteUrl(remoteUrl) {
  const parsed = extractRemoteHostAndRepo(remoteUrl);
  if (!parsed) return null;
  const repoPath = parsed.repoPath.replace(/\.git$/, "");
  return `${parsed.host}/${repoPath}`;
}
var MARKER_OPEN = "<!-- ";
var MARKER_CLOSE = " -->";
function issueSyncMarker(issueId, createdAt) {
  return `${MARKER_OPEN}tmb-issue:${issueId}:${createdAt}${MARKER_CLOSE}`;
}
function withMarker(body, marker) {
  if (!marker) return body;
  return body === "" ? marker : `${body}

${marker}`;
}
async function fetchRemoteLabelNames(backend, spawnFn, spawnOpts, repoSlug) {
  try {
    let result;
    if (backend === "gh") {
      const args = ["label", "list", "--json", "name"];
      if (repoSlug) args.push("--repo", repoSlug);
      result = spawnFn("gh", args, spawnOpts);
    } else {
      const args = ["label", "list", "-F", "json"];
      if (repoSlug) args.push("-R", repoSlug);
      result = spawnFn("glab", args, spawnOpts);
    }
    if (result.status !== 0) return null;
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const names = /* @__PURE__ */ new Set();
    for (const entry of parsed) {
      if (entry && typeof entry === "object" && typeof entry.name === "string") {
        names.add(entry.name);
      }
    }
    return names;
  } catch {
    return null;
  }
}
function parseRemoteMetadata(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const m = parsed.milestone;
  let milestone = null;
  if (typeof m === "string" && m !== "") milestone = m;
  else if (m && typeof m === "object" && typeof m.title === "string") {
    milestone = m.title || null;
  }
  const labels = [];
  if (Array.isArray(parsed.labels)) {
    for (const l of parsed.labels) {
      if (typeof l === "string") labels.push(l);
      else if (l && typeof l === "object" && typeof l.name === "string") {
        labels.push(l.name);
      }
    }
  }
  return { milestone, labels };
}
var VERIFY_STDERR_MAX = 200;
function verifyFailureReason(prefix, stderr) {
  const line = (stderr ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
  return line ? `${prefix}: ${line.slice(0, VERIFY_STDERR_MAX)}` : prefix;
}
async function verifyRemoteIssue(backend, iid, opts = {}) {
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;
  const spawnOpts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: "utf8" };
  if (opts.cwd) spawnOpts.cwd = opts.cwd;
  try {
    let result;
    if (backend === "gh") {
      const args = ["issue", "view", String(iid), "--json", "number,title,state,milestone,labels"];
      if (opts.repoSlug) args.push("--repo", opts.repoSlug);
      result = spawnFn("gh", args, spawnOpts);
    } else {
      const args = ["issue", "view", String(iid), "--output", "json"];
      if (opts.repoSlug) args.push("-R", opts.repoSlug);
      result = spawnFn("glab", args, spawnOpts);
    }
    if (result.status !== 0) return { ok: false, reason: verifyFailureReason("not_found_or_error", result.stderr) };
    if (backend === "gh") {
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return { ok: false, reason: "parse_failed" };
      }
      if (typeof parsed.number !== "number") return { ok: false, reason: "parse_failed" };
    }
    const metadata = parseRemoteMetadata(result.stdout);
    return metadata ? { ok: true, ...metadata } : { ok: true };
  } catch {
    return { ok: false, reason: "spawn_error" };
  }
}
function isFailure(r) {
  return r.ok === false;
}
async function createOnBackend(backend, opts, spawnFn) {
  const { title, labels = [], milestone } = opts;
  const body = withMarker(opts.body, opts.marker);
  const kind = backend === "gh" ? "github" : "gitlab";
  const spawnOpts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: "utf8" };
  if (opts._cwd) {
    spawnOpts.cwd = opts._cwd;
  }
  let effectiveLabels = labels;
  let unknownLabels = [];
  if (labels.length > 0) {
    const known = await fetchRemoteLabelNames(backend, spawnFn, spawnOpts, opts._repoSlug);
    if (known !== null) {
      effectiveLabels = labels.filter((l) => known.has(l));
      unknownLabels = labels.filter((l) => !known.has(l));
      if (unknownLabels.length > 0) {
        syncLog({
          event: "issue_create_labels_filtered",
          backend,
          issueId: opts.issueId,
          unknown: unknownLabels,
          kept: effectiveLabels
        });
      }
    }
  }
  let cmd;
  let args;
  if (backend === "gh") {
    cmd = "gh";
    args = ["issue", "create", "--title", title, "--body", body];
    if (opts._repoSlug) {
      args.push("--repo", opts._repoSlug);
    }
    for (const label of effectiveLabels) {
      args.push("--label", label);
    }
    if (milestone) {
      args.push("--milestone", milestone);
    }
  } else {
    cmd = "glab";
    args = ["issue", "create", "--title", title, "--description", body];
    if (opts._repoSlug) {
      args.push("-R", opts._repoSlug);
    }
    for (const label of effectiveLabels) {
      args.push("--label", label);
    }
    if (milestone) {
      args.push("--milestone", milestone);
    }
  }
  try {
    const result = spawnFn(cmd, args, spawnOpts);
    if (result.status !== 0) {
      const silent = result.stdout.trim() === "" && result.stderr.trim() === "";
      const outcome = result.status === null || silent ? "unknown" : "failed";
      syncLog({
        event: "issue_create_failed",
        backend,
        issueId: opts.issueId,
        outcome,
        stderr: result.stderr,
        exit_code: result.status
      });
      return {
        ok: false,
        reason: "non_zero_exit",
        outcome,
        backend,
        stderr: result.stderr,
        stdout: result.stdout,
        exit_code: result.status ?? void 0
      };
    }
    const parsed = parseRemoteIid(result.stdout, kind);
    if (parsed === null) {
      syncLog({
        event: "issue_create_parse_failed",
        backend,
        issueId: opts.issueId,
        outcome: "unknown",
        stdout: result.stdout
      });
      return {
        ok: false,
        reason: "parse_failed",
        outcome: "unknown",
        backend,
        stdout: result.stdout,
        message: `could not parse remote issue id from "${cmd} ${args.join(" ")}" output`
      };
    }
    if (opts._remoteUrl && parsed.host) {
      const configured = extractRemoteHostAndRepo(opts._remoteUrl);
      if (configured) {
        const hostMismatch = parsed.host !== configured.host;
        const repoMismatch = parsed.repoPath.replace(/\.git$/, "") !== configured.repoPath.replace(/\.git$/, "");
        if (hostMismatch || repoMismatch) {
          syncLog({
            event: "issue_create_verify_failed",
            backend,
            issueId: opts.issueId,
            reason: "host_repo_mismatch",
            outcome: "failed",
            parsed_host: parsed.host,
            parsed_repo: parsed.repoPath,
            configured_host: configured.host,
            configured_repo: configured.repoPath,
            stdout: result.stdout
          });
          return {
            ok: false,
            reason: "verify_failed",
            outcome: "failed",
            backend,
            stdout: result.stdout,
            message: `remote iid host/repo mismatch: got ${parsed.host}/${parsed.repoPath}, expected ${configured.host}/${configured.repoPath}`
          };
        }
      }
    }
    const verifyResult = await readBackVerify(backend, parsed.iid, spawnFn, spawnOpts, opts._repoSlug);
    if (!verifyResult.ok) {
      syncLog({
        event: "issue_create_verify_failed",
        backend,
        issueId: opts.issueId,
        reason: verifyResult.reason,
        outcome: "unknown",
        iid: parsed.iid,
        stdout: result.stdout
      });
      return {
        ok: false,
        reason: "verify_failed",
        outcome: "unknown",
        backend,
        stdout: result.stdout,
        message: `read-back verify failed for iid ${parsed.iid}: ${verifyResult.reason}`
      };
    }
    syncLog({
      event: "issue_create_success",
      backend,
      issueId: opts.issueId,
      iid: parsed.iid,
      stdout: result.stdout
    });
    return {
      remote_iid: parsed.iid,
      remote_kind: kind,
      unknown_labels: unknownLabels.length > 0 ? unknownLabels : void 0
    };
  } catch (e) {
    const message2 = e instanceof Error ? e.message : String(e);
    syncLog({
      event: "issue_create_error",
      backend,
      issueId: opts.issueId,
      outcome: "failed",
      error: message2
    });
    return {
      ok: false,
      reason: "spawn_error",
      outcome: "failed",
      backend,
      message: message2
    };
  }
}
async function syncIssueCreate(opts) {
  const spawnFn = opts._spawnFn ?? defaultSpawnFn;
  const backend = opts._backend;
  if (!backend) {
    return {
      ok: false,
      reason: "no_backend",
      outcome: "failed",
      backend: null,
      message: "no remote backend configured (issue_sync key resolved to null)"
    };
  }
  syncLog({
    kind: "issue_sync_active",
    backend,
    issue_id: opts.issueId,
    title: opts.title
  });
  if (backend === "gh") {
    return createOnBackend("gh", opts, spawnFn);
  }
  if (backend === "glab") {
    return createOnBackend("glab", opts, spawnFn);
  }
  return {
    ok: false,
    reason: "no_backend",
    outcome: "failed",
    backend: null,
    message: `unrecognised backend "${backend}" \u2014 use issue_create for dual-backend creates`
  };
}
var MARKER_LOOKUP_LIMIT = 50;
function markerToken(marker) {
  if (!marker.startsWith(MARKER_OPEN) || !marker.endsWith(MARKER_CLOSE)) return marker;
  return marker.slice(MARKER_OPEN.length, marker.length - MARKER_CLOSE.length);
}
function markerListArgs(backend, repoSlug, search2) {
  if (backend === "gh") {
    const args2 = ["issue", "list", "--state", "all", "--limit", String(MARKER_LOOKUP_LIMIT), "--json", "number,body"];
    if (search2 !== null) args2.push("--search", `"${search2}" in:body`);
    if (repoSlug) args2.push("--repo", repoSlug);
    return args2;
  }
  const args = ["issue", "list", "--all", "--per-page", String(MARKER_LOOKUP_LIMIT), "--output", "json"];
  if (search2 !== null) args.push("--search", search2, "--in", "description");
  if (repoSlug) args.push("-R", repoSlug);
  return args;
}
function matchMarker(backend, stdout, marker) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const iidKey = backend === "gh" ? "number" : "iid";
  const bodyKey = backend === "gh" ? "body" : "description";
  const iids = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const iid = entry[iidKey];
    const text2 = entry[bodyKey];
    if (typeof iid === "number" && typeof text2 === "string" && text2.includes(marker)) iids.push(iid);
  }
  return iids;
}
async function findIssuesByMarker(backend, marker, opts = {}) {
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;
  const spawnOpts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: "utf8" };
  if (opts.cwd) spawnOpts.cwd = opts.cwd;
  for (const search2 of [null, markerToken(marker)]) {
    let result;
    try {
      result = spawnFn(backend, markerListArgs(backend, opts.repoSlug, search2), spawnOpts);
    } catch (e) {
      const message2 = e instanceof Error ? e.message : String(e);
      syncLog({ event: "issue_marker_lookup_error", backend, marker, error: message2 });
      return { ok: false, reason: "spawn_error", message: message2 };
    }
    if (result.status !== 0) {
      syncLog({ event: "issue_marker_lookup_failed", backend, marker, exit_code: result.status, stderr: result.stderr });
      return { ok: false, reason: "non_zero_exit", exit_code: result.status ?? void 0, stderr: result.stderr };
    }
    const iids = matchMarker(backend, result.stdout, marker);
    if (iids === null) {
      syncLog({ event: "issue_marker_lookup_parse_failed", backend, marker, stdout: result.stdout });
      return { ok: false, reason: "parse_failed", message: `could not parse "${backend} issue list" output` };
    }
    if (iids.length > 0) {
      const sorted = [...new Set(iids)].sort((a, b) => a - b);
      syncLog({ event: "issue_marker_lookup_match", backend, marker, iids: sorted, searched: search2 !== null });
      return { ok: true, iids: sorted };
    }
  }
  return { ok: true, iids: [] };
}
async function syncIssueClose(opts) {
  const spawnFn = opts._spawnFn ?? defaultSpawnFn;
  const { remote_iid, remote_kind } = opts;
  const spawnOpts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: "utf8" };
  if (opts._cwd) {
    spawnOpts.cwd = opts._cwd;
  }
  let cmd;
  let args;
  if (remote_kind === "github") {
    cmd = "gh";
    args = ["issue", "close", String(remote_iid)];
    if (opts._repoSlug) {
      args.push("--repo", opts._repoSlug);
    }
  } else {
    cmd = "glab";
    args = ["issue", "close", String(remote_iid)];
    if (opts._repoSlug) {
      args.push("-R", opts._repoSlug);
    }
  }
  try {
    const result = spawnFn(cmd, args, spawnOpts);
    if (result.status !== 0) {
      syncLog({
        event: "issue_close_failed",
        remote_kind,
        remote_iid,
        stderr: result.stderr,
        exit_code: result.status
      });
      return {
        ok: false,
        reason: "non_zero_exit",
        stderr: result.stderr,
        stdout: result.stdout,
        exit_code: result.status ?? void 0
      };
    }
    return { ok: true };
  } catch (e) {
    const message2 = e instanceof Error ? e.message : String(e);
    syncLog({
      event: "issue_close_error",
      remote_kind,
      remote_iid,
      error: message2
    });
    return { ok: false, reason: "spawn_error", message: message2 };
  }
}
async function syncIssueUpdate(backend, iid, fields, opts = {}) {
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;
  const spawnOpts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: "utf8" };
  if (opts.cwd) spawnOpts.cwd = opts.cwd;
  const args = backend === "gh" ? ["issue", "edit", String(iid)] : ["issue", "update", String(iid)];
  if (opts.repoSlug) args.push(backend === "gh" ? "--repo" : "-R", opts.repoSlug);
  if (fields.milestone !== void 0) args.push(backend === "gh" ? "--milestone" : "-m", fields.milestone);
  if (fields.labels) {
    const addFlag = backend === "gh" ? "--add-label" : "--label";
    const removeFlag = backend === "gh" ? "--remove-label" : "--unlabel";
    for (const l of fields.labels.add) args.push(addFlag, l);
    for (const l of fields.labels.remove) args.push(removeFlag, l);
  }
  if (fields.title !== void 0) args.push(backend === "gh" ? "--title" : "-t", fields.title);
  if (fields.body !== void 0) {
    const body = withMarker(fields.body, fields.marker);
    if (backend === "gh") {
      args.push("--body-file", "-");
      spawnOpts.input = body;
    } else {
      args.push("-d", body);
    }
  }
  try {
    const result = spawnFn(backend, args, spawnOpts);
    if (result.status !== 0) {
      syncLog({ event: "issue_update_failed", backend, remote_iid: iid, stderr: result.stderr, exit_code: result.status });
      return {
        ok: false,
        reason: "non_zero_exit",
        stderr: result.stderr,
        stdout: result.stdout,
        exit_code: result.status ?? void 0
      };
    }
    return { ok: true };
  } catch (e) {
    const message2 = e instanceof Error ? e.message : String(e);
    syncLog({ event: "issue_update_error", backend, remote_iid: iid, error: message2 });
    return { ok: false, reason: "spawn_error", message: message2 };
  }
}

// ../mcp/trajectory-server/src/tools/agent-runs.ts
var SWE_ORPHAN_AFTER_MS = 10 * 60 * 1e3;
var WINDOW_MS_SQL = "COALESCE(CAST(ROUND((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER), duration_ms)";
var NO_USAGE_SQL = "COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0 AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0";
var UNMEASURED_IF_NO_USAGE_SQL = `usage_source = COALESCE(usage_source, CASE WHEN ${NO_USAGE_SQL} THEN 'unmeasured' END)`;
function finalizeOpenRuns(db, now2, exitReasonSql, where, params) {
  return db.run(
    `UPDATE agent_runs
        SET completed_at = ?,
            duration_ms = CASE WHEN duration_ms = 0 THEN ${WINDOW_MS_SQL} ELSE duration_ms END,
            exit_reason = ${exitReasonSql},
            ${UNMEASURED_IF_NO_USAGE_SQL}
      WHERE completed_at IS NULL
        AND (${where})`,
    [now2, now2, ...params]
  ).changes;
}
function closeOpenRunsForTask(db, taskId, now2, exitReason) {
  return finalizeOpenRuns(db, now2, "?", "task_id = ?", [exitReason, taskId]);
}

// ../mcp/trajectory-server/src/tools/lifecycle.ts
var LIVE_TASK_STATUSES = ["pending", "running", "needs_validation", "completed"];
var LIVE_IN = LIVE_TASK_STATUSES.map((s) => `'${s}'`).join(", ");
var WAIVE_REVIEW_REASON_MIN = 10;
function liveTasksOfIssue(db, issueId) {
  return db.all(
    `SELECT id, issue_id, branch_id, status, commit_sha FROM tasks
      WHERE issue_id = ? AND status IN (${LIVE_IN}) ORDER BY id`,
    [issueId]
  );
}
function closedTasksWithoutReview(db, issueId) {
  return db.all(
    `SELECT t.id, t.issue_id, t.branch_id, t.status, t.commit_sha FROM tasks t
      WHERE t.issue_id = ? AND t.status = 'closed'
        AND NOT ${HAS_PASS_SQL} AND NOT ${GATE_SKIP_RECORDED_SQL}
      ORDER BY t.id`,
    [issueId]
  );
}
function escalateLiveTasksForIssueClose(db, tasks2, reason, now2) {
  for (const task of tasks2) {
    db.run(
      `UPDATE tasks SET status = 'escalated', completed_at = NULL, updated_at = ? WHERE id = ?`,
      [now2, task.id]
    );
    insertAudit(db, {
      issue_id: task.issue_id,
      branch_id: task.branch_id,
      from_node: "bro",
      event_type: "task_escalated_by_issue_close",
      summary: `Task ${task.id} escalated from ${task.status} by issue_close cascade`,
      content_json: JSON.stringify({ task_id: task.id, from_status: task.status, reason }),
      created_at: now2
    });
    closeOpenRunsForTask(db, task.id, now2, "issue_closed");
  }
}
function markIssueClosed(db, issueId, now2) {
  db.run(
    `UPDATE issues SET status = 'closed', updated_at = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?`,
    [now2, now2, issueId]
  );
}
var STALE_RUNNING_HOURS_DEFAULT = 6;

// ../mcp/trajectory-server/src/sync/issue-reconcile.ts
var GH_RECONCILE_BATCH = 50;
function resolveRepoCtx(db, repo) {
  const resolved = resolveRepoForSync(db, repo);
  if (!resolved) return null;
  const remotes = syncRemotes(db, resolved.name);
  return {
    cwd: resolved.path,
    slugFor(kind) {
      const entry = remotes.find((r) => r.provider === kind);
      return entry ? { slug: repoSlugFromRemoteUrl(entry.url) } : null;
    }
  };
}
function spawnOptsFor(cwd) {
  const opts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: "utf8" };
  if (cwd) opts.cwd = cwd;
  return opts;
}
function splitGhSlug(slug) {
  const parts = slug.split("/");
  if (parts.length < 3 || parts.some((p) => p === "")) return null;
  return { host: parts[0], owner: parts[1], name: parts.slice(2).join("/") };
}
function gqlString(value) {
  return JSON.stringify(value);
}
function readGithubBatch(slug, iids, cwd, spawnFn) {
  const out = /* @__PURE__ */ new Map();
  const failAll = (error, message2) => {
    for (const iid of iids) out.set(iid, { error, ...message2 ? { message: message2 } : {} });
    return out;
  };
  const repo = splitGhSlug(slug);
  if (!repo) return failAll("slug_unresolved", `cannot split repo slug "${slug}"`);
  const fields = iids.map((n) => `i${n}: issue(number: ${n}) { state }`).join(" ");
  const query = `query { repository(owner: ${gqlString(repo.owner)}, name: ${gqlString(repo.name)}) { ${fields} } }`;
  let result;
  try {
    result = spawnFn("gh", ["api", "graphql", "--hostname", repo.host, "-f", `query=${query}`], spawnOptsFor(cwd));
  } catch (e) {
    return failAll("read_failed", e instanceof Error ? e.message : String(e));
  }
  let data = null;
  try {
    const parsed = JSON.parse(result.stdout);
    data = parsed?.data?.repository ?? null;
  } catch {
    data = null;
  }
  if (data === null) {
    if (result.status !== 0) return failAll("read_failed", (result.stderr || `gh exited ${String(result.status)}`).slice(0, 500));
    return failAll("parse_failed", "gh api graphql returned no repository data");
  }
  for (const iid of iids) {
    const node = data[`i${iid}`];
    const state = node && typeof node.state === "string" ? node.state.toUpperCase() : null;
    if (state === "CLOSED") out.set(iid, { state: "closed" });
    else if (state === "OPEN") out.set(iid, { state: "open" });
    else out.set(iid, { error: "not_found", message: `github #${iid} returned no issue state` });
  }
  return out;
}
function readGitlabIssue(slug, iid, cwd, spawnFn) {
  let result;
  try {
    result = spawnFn("glab", ["issue", "view", String(iid), "-R", slug, "--output", "json"], spawnOptsFor(cwd));
  } catch (e) {
    return { error: "read_failed", message: e instanceof Error ? e.message : String(e) };
  }
  if (result.status !== 0) {
    return { error: "read_failed", message: (result.stderr || `glab exited ${String(result.status)}`).slice(0, 500) };
  }
  let state;
  try {
    state = JSON.parse(result.stdout)?.state;
  } catch {
    return { error: "parse_failed", message: "glab issue view returned no JSON" };
  }
  if (state === "closed") return { state: "closed" };
  if (state === "opened" || state === "reopened") return { state: "open" };
  return { error: "parse_failed", message: `gitlab #${iid} returned state ${JSON.stringify(state)}` };
}
function sameIds(a, b) {
  if (!Array.isArray(b) || a.length !== b.length) return false;
  const sorted = [...b].map(Number).sort((x, y) => x - y);
  return a.every((v, i) => v === sorted[i]);
}
function lastDeferralIds(db, issueId) {
  const row2 = db.get(
    `SELECT content_json FROM audit WHERE issue_id = ? AND event_type = 'issue_remote_closed_local_open' ORDER BY id DESC LIMIT 1`,
    [issueId]
  );
  if (!row2) return null;
  try {
    return JSON.parse(row2.content_json).blocking_task_ids ?? null;
  } catch {
    return null;
  }
}
function reconcileRemoteCloses(db, opts = {}) {
  const spawnFn = opts._spawnFn ?? defaultSpawnFn;
  const probe = opts._spawnFn ? (cmd, args) => opts._spawnFn(cmd, args, { encoding: "utf8" }) : void 0;
  const result = { checked: 0, closed: [], deferred: [], errors: [], ...opts.dryRun ? { dry_run: true } : {} };
  const candidates = db.all(
    `SELECT id, repo, gh_iid, gl_iid FROM issues
      WHERE status = 'open' AND id > 0 AND (gh_iid IS NOT NULL OR gl_iid IS NOT NULL)
      ORDER BY id`
  );
  const ctxByRepo = /* @__PURE__ */ new Map();
  const ctxOf = (repo) => {
    const key = repo ?? "\0";
    if (!ctxByRepo.has(key)) ctxByRepo.set(key, resolveRepoCtx(db, repo));
    return ctxByRepo.get(key);
  };
  for (const c of candidates) ctxOf(c.repo);
  if (candidates.length === 0) ctxOf(null);
  const contexts = [...ctxByRepo.values()].filter((c) => c !== null);
  const gate = remoteSyncGate(db, {
    repoRemotes: contexts.length > 0 ? { github: contexts.some((c) => c.slugFor("github") !== null), gitlab: contexts.some((c) => c.slugFor("gitlab") !== null) } : null,
    spawnFn: probe
  });
  if (!gate.enabled) {
    return { ...result, skipped: gate.reason ?? "no_backend" };
  }
  result.checked = candidates.length;
  const targetsByIssue = /* @__PURE__ */ new Map();
  const states = /* @__PURE__ */ new Map();
  const ghBySlug = /* @__PURE__ */ new Map();
  for (const c of candidates) {
    const ctx = ctxOf(c.repo);
    const targets = [];
    if (c.gh_iid != null) targets.push({ issueId: c.id, kind: "github", iid: c.gh_iid, slug: null, cwd: ctx?.cwd ?? null });
    if (c.gl_iid != null) targets.push({ issueId: c.id, kind: "gitlab", iid: c.gl_iid, slug: null, cwd: ctx?.cwd ?? null });
    targetsByIssue.set(c.id, targets);
    for (const t of targets) {
      if (ctx === null) {
        states.set(t, { error: "repo_unresolved", message: `issue repo ${JSON.stringify(c.repo)} resolves to no repos row` });
        continue;
      }
      const remote = ctx.slugFor(t.kind);
      if (remote === null) {
        states.set(t, { error: "not_synced", message: `the repo has no synced ${t.kind} remote` });
        continue;
      }
      if (remote.slug === null) {
        states.set(t, { error: "slug_unresolved", message: `cannot derive a repo slug from the ${t.kind} remote url` });
        continue;
      }
      t.slug = remote.slug;
      if (t.kind === "github") {
        const list = ghBySlug.get(remote.slug) ?? [];
        list.push(t);
        ghBySlug.set(remote.slug, list);
      } else {
        states.set(t, readGitlabIssue(remote.slug, t.iid, t.cwd, spawnFn));
      }
    }
  }
  for (const [slug, targets] of ghBySlug) {
    for (let i = 0; i < targets.length; i += GH_RECONCILE_BATCH) {
      const batch = targets.slice(i, i + GH_RECONCILE_BATCH);
      const iids = [...new Set(batch.map((t) => t.iid))];
      const read = readGithubBatch(slug, iids, batch[0].cwd, spawnFn);
      for (const t of batch) states.set(t, read.get(t.iid));
    }
  }
  const now2 = nowISO();
  for (const [issueId, targets] of targetsByIssue) {
    const read = targets.map((t) => ({ t, s: states.get(t) }));
    const failed = read.filter((r) => "error" in r.s);
    if (failed.length > 0) {
      for (const { t, s } of failed) {
        const e = s;
        result.errors.push({ issue_id: issueId, remote_kind: t.kind, remote_iid: t.iid, reason: e.error, ...e.message ? { message: e.message } : {} });
      }
      continue;
    }
    if (read.some((r) => "state" in r.s && r.s.state === "open")) continue;
    const first = targets[0];
    const blocking = liveTasksOfIssue(db, issueId).map((t) => t.id);
    if (blocking.length > 0) {
      result.deferred.push({ issue_id: issueId, blocking_task_ids: blocking });
      if (!opts.dryRun && !sameIds(blocking, lastDeferralIds(db, issueId))) {
        insertAudit(db, {
          issue_id: issueId,
          from_node: "bro",
          writer: "bro",
          event_type: "issue_remote_closed_local_open",
          summary: `issue ${issueId}: ${first.kind} #${first.iid} is closed; left open for live tasks ${blocking.join(", ")}`,
          content_json: JSON.stringify({ remote_kind: first.kind, remote_iid: first.iid, blocking_task_ids: blocking }),
          created_at: now2
        });
      }
      continue;
    }
    if (!opts.dryRun) {
      const closedNow = db.transaction(() => {
        const still = db.get(`SELECT status FROM issues WHERE id = ?`, [issueId]);
        if (still?.status !== "open" || liveTasksOfIssue(db, issueId).length > 0) return false;
        markIssueClosed(db, issueId, now2);
        insertAudit(db, {
          issue_id: issueId,
          from_node: "bro",
          writer: "bro",
          event_type: "issue_closed_from_remote",
          summary: `issue ${issueId} closed: its ${first.kind} twin #${first.iid} is closed`,
          content_json: JSON.stringify({ remote_kind: first.kind, remote_iid: first.iid }),
          created_at: now2
        });
        return true;
      });
      if (!closedNow) continue;
    }
    result.closed.push({ issue_id: issueId, remote_kind: first.kind, remote_iid: first.iid });
  }
  return result;
}

// ../mcp/trajectory-server/src/sync/pr-sync.ts
var PR_FULL_LIMIT = 5e3;
var PR_INCREMENTAL_LIMIT = 1e3;
var PR_SYNC_TIMEOUT_MS = 12e4;
var PR_SYNC_MAX_BUFFER = 64 * 1024 * 1024;
var PR_JSON_FIELDS = "number,state,createdAt,mergedAt,updatedAt,closingIssuesReferences";
var STATES = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };
function nonEmptyString(v) {
  return typeof v === "string" && v !== "";
}
function sameRepo(ref, host, owner, name) {
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  const repo = ref.repository;
  if (repo && nonEmptyString(repo.name) && repo.owner && nonEmptyString(repo.owner.login)) {
    return eq(repo.owner.login, owner) && eq(repo.name, name);
  }
  if (!nonEmptyString(ref.url)) return false;
  try {
    const u = new URL(ref.url);
    const parts = u.pathname.split("/").filter((p) => p !== "");
    const at = parts.lastIndexOf("issues");
    return at >= 2 && eq(u.host, host) && eq(parts.slice(0, at - 1).join("/"), owner) && eq(parts[at - 1], name);
  } catch {
    return false;
  }
}
function toPrRow(raw, slugParts) {
  if (raw === null || typeof raw !== "object") return null;
  const pr = raw;
  const number = pr["number"];
  const state = typeof pr["state"] === "string" ? STATES[pr["state"].toUpperCase()] : void 0;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0 || state === void 0) return null;
  if (!nonEmptyString(pr["createdAt"]) || !nonEmptyString(pr["updatedAt"])) return null;
  let mergedAt = null;
  if (state === "merged") {
    if (!nonEmptyString(pr["mergedAt"])) return null;
    mergedAt = pr["mergedAt"];
  }
  const refs = Array.isArray(pr["closingIssuesReferences"]) ? pr["closingIssuesReferences"] : [];
  const closes = /* @__PURE__ */ new Set();
  for (const ref of refs) {
    if (ref === null || typeof ref !== "object") continue;
    const n = ref.number;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) continue;
    if (!sameRepo(ref, slugParts.host, slugParts.owner, slugParts.name)) continue;
    closes.add(n);
  }
  return {
    number,
    state,
    created_at: pr["createdAt"],
    merged_at: mergedAt,
    updated_at: pr["updatedAt"],
    closes: [...closes].sort((a, b) => a - b)
  };
}
function listArgs(slug, since) {
  const base = ["pr", "list", "-R", slug, "--state", "all", "--json", PR_JSON_FIELDS];
  if (since === null) return { args: [...base, "--limit", String(PR_FULL_LIMIT)], limit: PR_FULL_LIMIT };
  return {
    args: [...base, "--limit", String(PR_INCREMENTAL_LIMIT), "--search", `updated:>=${since} sort:updated-asc`],
    limit: PR_INCREMENTAL_LIMIT
  };
}
function prListSpawnOpts(cwd) {
  return { ...spawnOptsFor(cwd), timeout: PR_SYNC_TIMEOUT_MS, maxBuffer: PR_SYNC_MAX_BUFFER };
}
function sinceDate(db, repo) {
  const row2 = db.get(`SELECT MAX(updated_at) AS max FROM prs WHERE repo = ?`, [repo]);
  const m = row2?.max ? /^\d{4}-\d{2}-\d{2}/.exec(row2.max) : null;
  return m ? m[0] : null;
}
function writePrs(db, repo, rows, now2) {
  db.transaction(() => {
    for (const pr of rows) {
      db.run(
        `INSERT INTO prs (repo, number, state, created_at, merged_at, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo, number) DO UPDATE SET
             state = excluded.state, created_at = excluded.created_at, merged_at = excluded.merged_at,
             updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
        [repo, pr.number, pr.state, pr.created_at, pr.merged_at, pr.updated_at, now2]
      );
      const id = db.get(`SELECT id FROM prs WHERE repo = ? AND number = ?`, [repo, pr.number]).id;
      db.run(`DELETE FROM pr_closes WHERE pr_id = ?`, [id]);
      for (const n of pr.closes) db.run(`INSERT INTO pr_closes (pr_id, issue_number) VALUES (?, ?)`, [id, n]);
    }
  });
}
function syncRemotePrs(db, opts = {}) {
  const spawnFn = opts._spawnFn ?? defaultSpawnFn;
  const probe = opts._spawnFn ? (cmd, args) => opts._spawnFn(cmd, args, { encoding: "utf8" }) : void 0;
  const result = { repos: 0, upserted: 0, errors: [], ...opts.dryRun ? { dry_run: true } : {} };
  const contexts = [];
  for (const { name } of db.all(`SELECT name FROM repos ORDER BY name`)) {
    const ctx = resolveRepoCtx(db, name);
    if (ctx) contexts.push({ repo: name, ctx });
  }
  const gate = remoteSyncGate(db, {
    repoRemotes: contexts.length > 0 ? { github: contexts.some((c) => c.ctx.slugFor("github") !== null), gitlab: contexts.some((c) => c.ctx.slugFor("gitlab") !== null) } : null,
    spawnFn: probe
  });
  if (!gate.enabled) return { ...result, skipped: gate.reason ?? "no_backend" };
  for (const { repo, ctx } of contexts) {
    const remote = ctx.slugFor("github");
    if (remote === null) continue;
    result.repos += 1;
    const parts = remote.slug === null ? null : splitGhSlug(remote.slug);
    if (remote.slug === null || parts === null) {
      result.errors.push({ repo, reason: "slug_unresolved", message: "cannot derive a repo slug from the github remote url" });
      continue;
    }
    const { args, limit } = listArgs(remote.slug, sinceDate(db, repo));
    let out;
    try {
      out = spawnFn("gh", args, prListSpawnOpts(ctx.cwd));
    } catch (e) {
      result.errors.push({ repo, reason: "read_failed", message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (out.status !== 0) {
      result.errors.push({ repo, reason: "read_failed", message: (out.stderr || `gh exited ${String(out.status)}`).slice(0, 500) });
      continue;
    }
    let list;
    try {
      list = JSON.parse(out.stdout);
    } catch {
      list = null;
    }
    if (!Array.isArray(list)) {
      result.errors.push({ repo, reason: "parse_failed", message: "gh pr list returned no JSON array" });
      continue;
    }
    const rows = [];
    for (const raw of list) {
      const row2 = toPrRow(raw, parts);
      if (row2) rows.push(row2);
    }
    if (rows.length < list.length) {
      result.errors.push({ repo, reason: "parse_failed", message: `${list.length - rows.length} malformed PR entr${list.length - rows.length === 1 ? "y" : "ies"} skipped` });
    }
    if (list.length >= limit) {
      const rest = limit === PR_FULL_LIMIT ? "older PRs are not synced" : "the rest sync on the next run";
      result.errors.push({ repo, reason: "truncated", message: `gh pr list hit its ${limit}-PR limit; ${rest}` });
    }
    if (!opts.dryRun) writePrs(db, repo, rows, nowISO());
    result.upserted += rows.length;
  }
  return result;
}

// ../mcp/trajectory-server/src/tools/issues.ts
var DEFAULT_CLASSIFICATION_LABELS = [
  "Bug",
  "Feature",
  "Improvement",
  "Docs",
  "Test",
  "Chore"
];
var DEFAULT_PRIORITY_LABELS = [
  "Priority: Urgent",
  "Priority: High",
  "Priority: Medium",
  "Priority: Low"
];
function readStringArrayConfig(db, key) {
  const row2 = db.get(
    `SELECT value_json FROM plugin_config WHERE key = ?`,
    [key]
  );
  if (!row2) return null;
  try {
    const parsed = JSON.parse(row2.value_json);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((v) => typeof v === "string")) {
      return parsed;
    }
  } catch {
  }
  return null;
}
function readStringMapConfig(db, key) {
  const row2 = db.get(
    `SELECT value_json FROM plugin_config WHERE key = ?`,
    [key]
  );
  if (!row2) return null;
  try {
    const parsed = JSON.parse(row2.value_json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.values(parsed).every((v) => typeof v === "string")) {
      return parsed;
    }
  } catch {
  }
  return null;
}
function resolveLabelTaxonomy(db) {
  const classification = readStringArrayConfig(db, "issue_classification_labels") ?? [
    ...DEFAULT_CLASSIFICATION_LABELS
  ];
  const priorityLabels = readStringArrayConfig(db, "issue_priority_labels") ?? [
    ...DEFAULT_PRIORITY_LABELS
  ];
  const areaLabels = readStringArrayConfig(db, "issue_area_labels") ?? [];
  const areaPaths = readStringMapConfig(db, "issue_area_paths") ?? {};
  return { classification, priorityLabels, areaLabels, areaPaths };
}
function defaultSyncLabels(db) {
  const { classification, priorityLabels } = resolveLabelTaxonomy(db);
  const labels = [];
  if (classification.length > 0) labels.push(classification[0]);
  if (priorityLabels.length > 0) labels.push(priorityLabels[0]);
  return labels;
}
function validateIssueLabels(db, labels, taxonomy, tool = "issue_create") {
  const { classification, priorityLabels, areaLabels = [] } = taxonomy ?? resolveLabelTaxonomy(db);
  const classificationSet = new Set(classification);
  const prioritySet = new Set(priorityLabels);
  const areaSet = new Set(areaLabels);
  const hasPriority = labels.some((l) => prioritySet.has(l));
  const hasClassification = labels.some((l) => classificationSet.has(l));
  const areas = [...new Set(labels.filter((l) => areaSet.has(l)))];
  const hasArea = areaSet.size === 0 || areas.length > 0;
  if (hasPriority && hasClassification && hasArea) {
    if (areas.length > 1) {
      return `multiple_area_labels: ${tool} requires exactly one area label (one of: ${areaLabels.join(", ")}). Got areas: [${areas.join(", ")}]`;
    }
    return null;
  }
  const missing = [];
  if (!hasClassification) {
    missing.push(`a classification label (one of: ${classification.join(", ")})`);
  }
  if (!hasPriority) {
    missing.push(`a priority label (one of: ${priorityLabels.join(", ")})`);
  }
  if (!hasArea) {
    missing.push(`an area label (one of: ${areaLabels.join(", ")})`);
  }
  return `missing_required_labels: ${tool} requires ${missing.join(" AND ")}. Got labels: [${labels.join(", ")}]`;
}
var PATH_TOKEN_SPLIT = /[\s`'"()[\]{}<>,;|*]+/;
function pathTokens(text2) {
  return text2.split(PATH_TOKEN_SPLIT).map(
    (t) => t.replace(/#.*$/, "").replace(/[.:!?]+$/, "").replace(/(?::\d+)+$/, "").replace(/^\.\//, "")
  ).filter((t) => t.includes("/") || /\.[A-Za-z0-9]+$/.test(t));
}
function stripSlashes(path) {
  return path.replace(/^\.\//, "").replace(/\/+$/, "");
}
function inferIssueArea(db, labels, texts, taxonomy, tool = "issue_create") {
  const { areaLabels = [], areaPaths = {} } = taxonomy ?? resolveLabelTaxonomy(db);
  const areaSet = new Set(areaLabels);
  if (areaSet.size === 0 || labels.some((l) => areaSet.has(l))) {
    return { labels, areaInferred: null };
  }
  const prefixes = Object.entries(areaPaths).map(([prefix, area]) => ({ prefix: stripSlashes(prefix), area })).filter((p) => p.prefix.length > 0).sort((a, b) => b.prefix.length - a.prefix.length);
  const hits = /* @__PURE__ */ new Map();
  for (const token of texts.flatMap(pathTokens)) {
    const match = prefixes.find((p) => token === p.prefix || token.startsWith(`${p.prefix}/`));
    if (!match) continue;
    if (!areaSet.has(match.area)) {
      return {
        error: `invalid_area_config: issue_area_paths maps "${match.prefix}" to "${match.area}", which is not in issue_area_labels (${areaLabels.join(", ")})`
      };
    }
    const paths = hits.get(match.area) ?? [];
    if (!paths.includes(token)) paths.push(token);
    hits.set(match.area, paths);
  }
  if (hits.size > 1) {
    const candidates = [...hits.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([area, paths]) => `${area} (${paths.join(", ")})`).join("; ");
    return {
      error: `ambiguous_area: ${tool} found paths in more than one area: ${candidates}. Pass exactly one area label (one of: ${areaLabels.join(", ")})`
    };
  }
  const [inferred] = [...hits.keys()];
  if (inferred === void 0) return { labels, areaInferred: null };
  return { labels: [...labels, inferred], areaInferred: inferred };
}
function ensureMilestoneRow(db, milestone, repo) {
  if (repo === null) return;
  db.run(
    `INSERT INTO milestones (name, repo) VALUES (?, ?)
     ON CONFLICT(name, repo) DO NOTHING`,
    [milestone, repo]
  );
}
function resolveDefaultMilestone(db, explicitMilestone, repo) {
  if (explicitMilestone !== null && explicitMilestone !== "") {
    ensureMilestoneRow(db, explicitMilestone, repo);
    return { milestone: explicitMilestone, milestone_default: "explicit" };
  }
  if (repo === null) return { milestone: null, milestone_default: "none_open" };
  const open = db.all(
    `SELECT name FROM milestones WHERE repo = ? AND state = 'open' ORDER BY name`,
    [repo]
  );
  if (open.length === 1) return { milestone: open[0].name, milestone_default: "applied" };
  if (open.length === 0) return { milestone: null, milestone_default: "none_open" };
  return {
    milestone: null,
    milestone_default: "multiple_open",
    open_milestones: open.map((m) => m.name)
  };
}
function milestoneDefaultFields(resolution) {
  const fields = { milestone_default: resolution.milestone_default };
  if (resolution.open_milestones) fields["open_milestones"] = resolution.open_milestones;
  return fields;
}
var DEDUP_THRESHOLD = 0.6;
function normalizeObjective(text2) {
  return text2.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 0);
}
function objectiveSimilarity(a, b) {
  const setA = new Set(normalizeObjective(a));
  const setB = new Set(normalizeObjective(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}
function decodeIssue(row2) {
  return { ...row2 };
}
function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
function err(message2) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message2 }) }],
    isError: true
  };
}
function refusal(code, detail) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, ...detail }) }],
    isError: true
  };
}
function requireArg(args, name) {
  if (args[name] === void 0 || args[name] === null) {
    throw new Error(`Missing required arg: ${name}`);
  }
  return args[name];
}
function wrapHandler(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err(e.message);
    }
  };
}
function resolveIssueSyncContext(db, repoName) {
  const resolved = resolveRepoForSync(db, repoName);
  if (!resolved) return null;
  return {
    repoName: resolved.name,
    cwd: resolved.path,
    remoteFor(backend) {
      const provider = backend === "gh" ? "github" : "gitlab";
      const entry = syncRemotes(db, resolved.name).find((r) => r.provider === provider);
      if (!entry) return null;
      return { url: entry.url, slug: repoSlugFromRemoteUrl(entry.url) };
    }
  };
}
function probeSpawn(spawnFn) {
  return spawnFn ? (cmd, args) => spawnFn(cmd, args, { encoding: "utf8" }) : void 0;
}
function syncedBackends(backend, ctx) {
  const wanted = backend === "both" ? ["gh", "glab"] : [backend];
  return wanted.filter((b) => ctx.remoteFor(b) !== null);
}
var CLI_PROVIDER = { gh: "github", glab: "gitlab" };
var CLI_LABEL = { gh: "GitHub", glab: "GitLab" };
function unsyncedBackends(db, ctx, clis) {
  const providers = new Set(repoRemotes(db, ctx.repoName).map((r) => r.provider));
  return clis.filter((c) => ctx.remoteFor(c) === null && providers.has(CLI_PROVIDER[c]));
}
function notSyncedHint(clis) {
  const names = clis.map((c) => CLI_LABEL[c]).join(" and ");
  return `The ${names} remote is not the Remote chosen at onboard; re-run /onboard to change the Remote choice.`;
}
async function mirrorIssueEdit(db, row2, fields, spawnFn, cwdOverride) {
  await Promise.resolve();
  if (row2.gh_iid == null && row2.gl_iid == null) {
    return { sync_skipped: true, reason: "no_remote_iid", hint: "The issue has no gh_iid/gl_iid; the change is local only." };
  }
  const syncConfigRow = db.get(
    `SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`
  );
  const syncConfig = syncConfigRow ? JSON.parse(syncConfigRow.value_json) : "off";
  if (syncConfig === "off") {
    return { sync_skipped: true, reason: "issue_sync_off", hint: "The change is local only; enable issue_sync to mirror it." };
  }
  const syncCtx = resolveIssueSyncContext(db, row2.repo);
  const remoteProviders = syncCtx ? { github: syncCtx.remoteFor("gh") !== null, gitlab: syncCtx.remoteFor("glab") !== null } : null;
  const backend = resolveBackendFor(syncConfig, remoteProviders, probeSpawn(spawnFn));
  if (backend === null || backend === "off") {
    return { sync_skipped: true, reason: "no_remote_configured", hint: "The change is local only." };
  }
  if (syncCtx === null) {
    return {
      sync_failed: true,
      reason: "unresolvable_repo",
      repo: row2.repo,
      backend,
      hint: row2.repo ? `issue repo "${row2.repo}" has no matching repos row \u2014 run /scan.` : "multiple repos registered and the issue has no repo."
    };
  }
  const reachable = syncedBackends(backend, syncCtx);
  const targets = [];
  if (reachable.includes("gh") && row2.gh_iid != null) targets.push({ cli: "gh", iid: row2.gh_iid });
  if (reachable.includes("glab") && row2.gl_iid != null) targets.push({ cli: "glab", iid: row2.gl_iid });
  const wanted = backend === "both" ? ["gh", "glab"] : [backend];
  const unreachable = wanted.filter((cli) => !reachable.includes(cli) && (cli === "gh" ? row2.gh_iid : row2.gl_iid) != null);
  if (targets.length === 0 && unreachable.length > 0) {
    return { sync_skipped: true, reason: "not_synced", backend, hint: notSyncedHint(unreachable) };
  }
  if (targets.length === 0) {
    return { sync_skipped: true, reason: "no_remote_iid", backend, hint: "The issue has no remote iid for the resolved backend; the change is local only." };
  }
  const results = await Promise.all(targets.map(async (t) => ({
    target: t,
    result: await syncIssueUpdate(t.cli, t.iid, fields, {
      spawnFn,
      cwd: cwdOverride ?? syncCtx.cwd,
      repoSlug: syncCtx.remoteFor(t.cli)?.slug ?? void 0
    })
  })));
  const failed = results.filter((r) => !r.result.ok);
  if (failed.length === 0) {
    return { synced: true, backends: targets.map((t) => t.cli) };
  }
  for (const f of failed) {
    serverLog({ event: "issue_sync_failed", issueId: String(row2.id), backend: f.target.cli, reason: f.result.reason, exit_code: f.result.exit_code, stderr: f.result.stderr?.slice(0, 1024), message: f.result.message });
  }
  const first = failed[0];
  return {
    sync_failed: true,
    reason: first.result.reason,
    backend: first.target.cli,
    failed_backends: failed.map((f) => f.target.cli),
    exit_code: first.result.exit_code,
    stderr: first.result.stderr?.slice(0, 4096),
    message: first.result.message,
    hint: "The local row is updated; run the underlying gh/glab edit manually to mirror it."
  };
}
var SYNC_RETRY_HINT = "Try `issue_sync_retry` or run the underlying gh/glab command manually to debug.";
var SYNC_UNKNOWN_HINT = "The remote issue may already exist: the create's result was lost. Run `issue_sync_retry`; it looks for the issue by its body marker before it creates, so it adopts that issue rather than opening a duplicate. Do not re-create it by hand.";
function syncFailureHint(outcomes) {
  return outcomes.includes("unknown") ? SYNC_UNKNOWN_HINT : SYNC_RETRY_HINT;
}
function resolveAdoptionTarget(db, issueRepo, remoteBackendArg, remoteIid) {
  if (!Number.isInteger(remoteIid) || remoteIid <= 0) {
    return { ok: false, error: `invalid_remote_iid: must be a positive integer, got ${String(remoteIid)}` };
  }
  const syncCtx = resolveIssueSyncContext(db, issueRepo);
  let backend = remoteBackendArg;
  if (!backend) {
    const hasGh = syncCtx?.remoteFor("gh") != null;
    const hasGl = syncCtx?.remoteFor("glab") != null;
    if (hasGh && !hasGl) backend = "github";
    else if (hasGl && !hasGh) backend = "gitlab";
    else if (hasGh && hasGl) {
      return { ok: false, error: "remote_backend_ambiguous: repo has both github and gitlab remotes \u2014 pass remote_backend" };
    } else {
      return { ok: false, error: "remote_backend_unresolved: repo has no configured remote \u2014 pass remote_backend" };
    }
  }
  return { ok: true, target: { backend, remoteIid, syncCtx } };
}
async function verifyAdoptionTarget(target, spawnFn) {
  const { backend, remoteIid, syncCtx } = target;
  const cliBackend = backend === "github" ? "gh" : "glab";
  const remote = syncCtx?.remoteFor(cliBackend);
  const verify = await verifyRemoteIssue(cliBackend, remoteIid, {
    spawnFn,
    cwd: syncCtx?.cwd,
    repoSlug: remote?.slug ?? void 0
  });
  if (!verify.ok) {
    return {
      ok: false,
      error: `remote_verify_failed: ${backend} issue #${remoteIid} not found or not viewable (${verify.reason ?? "unknown"})`
    };
  }
  return { ok: true, backend, milestone: verify.milestone ?? null, labels: verify.labels ?? [] };
}
async function verifyAdoptionRemote(db, issueRepo, remoteBackendArg, remoteIid, spawnFn) {
  const resolved = resolveAdoptionTarget(db, issueRepo, remoteBackendArg, remoteIid);
  if (!resolved.ok) return resolved;
  return verifyAdoptionTarget(resolved.target, spawnFn);
}
async function syncIssueCloseRemotes(db, dbPath, issueId, spawnFn) {
  const remoteRow = db.get(
    `SELECT gh_iid, gl_iid, repo FROM issues WHERE id = ?`,
    [issueId]
  );
  const targets = [];
  if (remoteRow?.gh_iid != null) {
    targets.push({ remote_kind: "github", remote_iid: remoteRow.gh_iid, closed: false });
  }
  if (remoteRow?.gl_iid != null) {
    targets.push({ remote_kind: "gitlab", remote_iid: remoteRow.gl_iid, closed: false });
  }
  if (targets.length === 0) return { synced: false, remotes: [] };
  const closeCtx = resolveIssueSyncContext(db, remoteRow?.repo ?? null);
  const gate = remoteSyncGate(db, {
    repoRemotes: closeCtx ? { github: closeCtx.remoteFor("gh") !== null, gitlab: closeCtx.remoteFor("glab") !== null } : null,
    spawnFn: probeSpawn(spawnFn)
  });
  if (!gate.enabled) {
    const reason = gate.reason ?? "no_backend";
    insertAudit(db, {
      issue_id: issueId,
      from_node: "trajectory-server",
      event_type: "issue_close_remote_skipped",
      summary: `issue ${issueId} closed locally; remote close skipped (${reason})`,
      content_json: JSON.stringify({
        reason,
        remotes: targets.map(({ remote_kind, remote_iid }) => ({ remote_kind, remote_iid }))
      }),
      created_at: nowISO()
    });
    return { synced: false, skipped: reason, remotes: targets };
  }
  for (const target of targets) {
    const closeRemote = closeCtx?.remoteFor(target.remote_kind === "github" ? "gh" : "glab") ?? null;
    if (closeCtx === null) {
      target.skipped = "repo_unresolved";
      continue;
    }
    if (closeRemote === null) {
      target.skipped = "not_synced";
      continue;
    }
    const closeResult = await syncIssueClose({
      remote_iid: target.remote_iid,
      remote_kind: target.remote_kind,
      _cwd: closeCtx.cwd,
      _repoSlug: closeRemote.slug ?? void 0,
      _spawnFn: spawnFn
    });
    target.closed = closeResult.ok;
    if (!closeResult.ok) {
      serverLog({
        event: "issue_close_sync_failed",
        issueId,
        remote_iid: target.remote_iid,
        remote_kind: target.remote_kind,
        reason: closeResult.reason,
        exit_code: closeResult.exit_code,
        stderr: closeResult.stderr?.slice(0, 1024),
        message: closeResult.message
      });
    }
  }
  const attempted = targets.filter((t) => t.skipped === void 0);
  return { synced: attempted.length > 0 && attempted.every((t) => t.closed), remotes: targets };
}
function issueTools(db, dbPath = "", options = {}) {
  const definitions = [
    {
      name: "issue_create",
      description: "Create a new issue with an objective and an optional full markdown description.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Caller agent name" },
          objective: { type: "string", description: "Short one-liner summary" },
          description: { type: "string", description: "Full issue description: requirements, context, acceptance criteria. Markdown. Gated from SWE for info isolation." },
          labels: { type: "array", items: { type: "string" }, description: "Required. Must include at least one priority label AND at least one classification label, drawn from the project's configured taxonomy (plugin_config issue_priority_labels / issue_classification_labels) or the generic default (priority: Priority: Urgent|High|Medium|Low; classification: Bug, Feature, Improvement, Docs, Test, Chore), plus exactly one area label when the project configures issue_area_labels (inferred from issue_area_paths when omitted). Extra labels are allowed. Applied to the remote issue." },
          milestone: { type: "string", description: 'Optional milestone name (e.g. "v1.2.0"). Persisted on the issue row and set on the remote issue. Omit for no milestone.' },
          repo: { type: "string", description: "Optional repo name (matches a repos row) this issue belongs to. Drives issue-scoped sync (explicit gh --repo / glab -R from that repo's remotes). Defaults to the sole/managed repo when exactly one repos row exists; required when several exist (repo_required otherwise)." },
          allow_duplicate: { type: "boolean", description: "When true, skip the open-issue dedup pre-check and create even if an existing open issue closely matches the objective. Default false: a likely duplicate returns { duplicate: true, duplicate_of } instead of creating." },
          remote_iid: { type: "number", description: "Optional. Adopt an existing remote issue instead of creating one: verifies the remote issue exists, links it, and skips remote creation. A failed verification creates nothing." },
          remote_backend: { type: "string", enum: ["github", "gitlab"], description: "Optional backend for remote_iid adoption. Defaults to the repo's sole configured remote." },
          include_description: { type: "boolean", description: "Echo the full description in the result (default false)." }
        },
        required: ["agent", "objective", "labels"]
      }
    },
    {
      name: "issue_get",
      description: "Fetch a single issue by ID.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          issue_id: { type: "string", description: "The issue string ID" },
          include_description: { type: "boolean", description: "Include the full description (default false). swe callers never receive it." }
        },
        required: ["agent", "issue_id"]
      }
    },
    {
      name: "issue_resume",
      description: "Return an issue with its first actionable pending/failed task.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          issue_id: { type: "string" }
        },
        required: ["agent", "issue_id"]
      }
    },
    {
      name: "issue_close",
      description: "Close an issue locally, then mirror the close to its linked remote. Refuses with issue_has_open_tasks (task ids + statuses) while any task is live, unless cascade (open agent_runs closed issue_closed). Refuses with tasks_without_review while a closed task has no passing code-reviewer verdict for its current commit, unless waive_review.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          issue_id: { type: "string" },
          cascade: {
            type: "boolean",
            description: "When true, escalate every live task of the issue (pending/running/needs_validation/completed) and close their open agent_runs before closing the issue. Default false: refuse while tasks are live."
          },
          reason: {
            type: "string",
            description: "Optional reason stored on each task_escalated_by_issue_close audit row when cascade=true."
          },
          waive_review: {
            type: "boolean",
            description: "When true, close even though closed tasks lack a passing code-reviewer verdict; writes one review_gate_waived audit row per such task. Requires waive_review_reason."
          },
          waive_review_reason: {
            type: "string",
            description: "Required when waive_review is true (min 10 chars): why the review is skipped."
          }
        },
        required: ["agent", "issue_id"]
      }
    },
    {
      name: "issue_get_phase",
      description: "An issue's workflow phase and task counts: tasks_completed counts closed tasks only; tasks_awaiting_close counts tasks swe completed that bro has not closed. phase is ready_to_close once every task is closed.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          issue_id: { type: "string" }
        },
        required: ["agent", "issue_id"]
      }
    },
    {
      name: "issue_list",
      description: "List issues by updated_at DESC as a thin index (id, objective, status, created_at, updated_at).",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          status: {
            type: "string",
            enum: ["open", "closed"],
            description: "Optional status filter. Omit to return all issues."
          },
          milestone: { type: "string", description: "Optional milestone filter: a milestone name, or 'none' for issues with no milestone." },
          limit: { type: "number", description: "Max rows. Default 50, max 200." },
          offset: { type: "number", description: "Row offset. Default 0." },
          fields: {
            type: "array",
            items: { type: "string" },
            description: "Optional column projection. Allowed: id, objective, status, created_at, updated_at. Unknown fields return a named error. Default: all five columns."
          }
        },
        required: ["agent"]
      }
    },
    {
      name: "issue_update_description",
      description: "Replace an issue's description; issue sync mirrors it to the remote body.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["bro"], description: "Calling agent identity (bro only)" },
          issue_id: { type: "string", description: "Issue ID as string" },
          description: { type: "string", description: "Full markdown description (no length cap)" },
          include_description: { type: "boolean", description: "Echo the full description in the result (default false)." }
        },
        required: ["agent", "issue_id", "description"]
      }
    },
    {
      name: "issue_update",
      description: "Bro only. Change an issue's milestone, labels and/or objective (at least one) and mirror it to the linked remote when issue sync is on. labels are validated like issue_create and replace the whole set.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["bro"], description: "Calling agent identity (bro only)" },
          issue_id: { type: "string", description: "Issue ID as string" },
          milestone: { type: "string", description: "Milestone name; its milestones row is created for the issue repo when missing" },
          labels: { type: "array", items: { type: "string" }, description: "Full replacement label set; must include one classification and one priority label, plus exactly one area label when the project configures issue_area_labels" },
          objective: { type: "string", description: "New objective (the remote issue title)" },
          include_description: { type: "boolean", description: "Echo the full description in the result (default false)." }
        },
        required: ["agent", "issue_id"]
      }
    },
    {
      name: "issue_sync_retry",
      description: "Bro only. Retry a failed remote sync for an issue. It first looks on the remote for the issue's body marker and adopts a match (adopted, duplicates); when that lookup fails it creates nothing (lookup_failed).",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["bro"], description: "Calling agent identity (bro only)" },
          issue_id: { type: "string", description: "Issue ID as string" }
        },
        required: ["agent", "issue_id"]
      }
    },
    {
      name: "issue_adopt_remote",
      description: "Bro only. Link a local issue to a remote issue once verified to exist. Errors when already linked to a different iid; the same iid is a no-op.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["bro"], description: "Calling agent identity (bro only)" },
          issue_id: { type: "string", description: "Local issue ID" },
          remote_iid: { type: "number", description: "Remote issue number to adopt" },
          remote_backend: { type: "string", enum: ["github", "gitlab"], description: "Optional. Defaults to the repo's sole configured remote." },
          repo: { type: "string", description: "Optional repo name (matches a repos row) to verify against. Required when the issue has no repo and several repos exist; backfills a null issue repo on success." },
          include_description: { type: "boolean", description: "Echo the full description in the result (default false)." }
        },
        required: ["agent", "issue_id", "remote_iid"]
      }
    },
    {
      name: "issue_reconcile_remote",
      description: "Bro only. Close open local issues whose GitHub/GitLab issue is closed and sync GitHub PR rows; read-only on the remote; skipped when remote sync is off. Live-task issues stay open in deferred (rerun later); read failures land in errors.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["bro"], description: "Calling agent identity (bro only)" },
          dry_run: { type: "boolean", description: "Report what would close or defer and write nothing (default false)." }
        },
        required: ["agent"]
      }
    },
    {
      name: "issue_link",
      description: "Bro only. Record the remote iid (gh_iid/gl_iid) of a manually mirrored issue; refused when it is already set unless force.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["bro"], description: "Calling agent identity (bro only)" },
          issue_id: { type: "string", description: "Local issue ID" },
          backend: { type: "string", enum: ["github", "gitlab"], description: "Remote backend" },
          iid: { type: "number", description: "Remote issue number" },
          force: { type: "boolean", description: "Overwrite existing iid if already set (default false)" },
          include_description: { type: "boolean", description: "Echo the full description in the result (default false)." }
        },
        required: ["agent", "issue_id", "backend", "iid"]
      }
    }
  ];
  const handlers = {
    issue_create: requireRoles("issue_create", ["bro"], wrapHandler(async (args) => {
      const agent = normalizeAgent(args["agent"]);
      requireArg(args, "objective");
      const objective = args["objective"];
      const description = args["description"] ?? "";
      const includeDescription = args["include_description"] ?? false;
      const inference = inferIssueArea(
        db,
        args["labels"] ?? [],
        [objective, description],
        options.labelTaxonomy
      );
      if ("error" in inference) return err(inference.error);
      const { labels, areaInferred } = inference;
      const labelError = validateIssueLabels(db, labels, options.labelTaxonomy);
      if (labelError !== null) {
        return err(labelError);
      }
      const explicitRepo = args["repo"] ?? null;
      const issueRepo = explicitRepo ?? resolveRepoForSync(db, null)?.name ?? null;
      if (issueRepo === null) {
        const repoNames = db.all(`SELECT name FROM repos ORDER BY name`).map((r) => r.name);
        if (repoNames.length > 1) {
          return err(
            `repo_required: ${repoNames.length} repos are registered (${repoNames.join(", ")}) \u2014 pass repo= on issue_create to pick one`
          );
        }
      }
      const allowDuplicate = args["allow_duplicate"] ?? false;
      if (!allowDuplicate) {
        const openIssues = db.all(
          `SELECT id, objective FROM issues WHERE status = 'open' AND (repo IS NULL OR repo = ?)`,
          [issueRepo]
        );
        let best = null;
        for (const candidate of openIssues) {
          const similarity = objectiveSimilarity(objective, candidate.objective);
          if (best === null || similarity > best.similarity) {
            best = { id: candidate.id, objective: candidate.objective, similarity };
          }
        }
        if (best !== null && best.similarity >= DEDUP_THRESHOLD) {
          return ok({
            duplicate: true,
            duplicate_of: best.id,
            matched_objective: best.objective,
            similarity: best.similarity
          });
        }
      }
      const explicitMilestone = args["milestone"] ?? null;
      const milestoneResolution = resolveDefaultMilestone(db, explicitMilestone, issueRepo);
      const milestone = milestoneResolution.milestone;
      const spawnFn = args["_spawnFn"] ?? void 0;
      const now2 = nowISO();
      const remoteIidRaw = args["remote_iid"];
      if (remoteIidRaw !== void 0 && remoteIidRaw !== null) {
        const remoteIid = typeof remoteIidRaw === "number" ? remoteIidRaw : Number(remoteIidRaw);
        const remoteBackendArg = args["remote_backend"];
        const adoption = await verifyAdoptionRemote(db, issueRepo, remoteBackendArg, remoteIid, spawnFn);
        if (!adoption.ok) {
          return err(adoption.error);
        }
        db.run(
          `INSERT INTO issues (objective, description, status, created_at, updated_at, milestone, repo, labels)
           VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`,
          [objective, description, now2, now2, milestone, issueRepo, JSON.stringify(labels)]
        );
        const adoptRowId = db.get(
          `SELECT id FROM issues WHERE rowid = last_insert_rowid()`
        );
        if (!adoptRowId) {
          throw new Error("issue_create: failed to retrieve inserted row");
        }
        const adoptId = adoptRowId.id;
        const ghIid = adoption.backend === "github" ? remoteIid : null;
        const glIid = adoption.backend === "gitlab" ? remoteIid : null;
        db.run(
          `UPDATE issues SET remote_kind = ?, gh_iid = ?, gl_iid = ?, updated_at = ? WHERE id = ?`,
          [adoption.backend, ghIid, glIid, now2, adoptId]
        );
        insertAudit(db, {
          issue_id: adoptId,
          from_node: "executor",
          event_type: "issue_adopted",
          summary: `issue ${adoptId} adopted ${adoption.backend} #${remoteIid} at create`,
          content_json: JSON.stringify({ issue_id: adoptId, backend: adoption.backend, remote_iid: remoteIid, at_create: true }),
          created_at: now2
        });
        const adoptedRow = db.get("SELECT * FROM issues WHERE id = ?", [adoptId]);
        const adoptedIssue = decodeIssue(adoptedRow);
        const adoptedRedacted = redactIssue(adoptedIssue, agent, { include_description: includeDescription });
        const adoptedPayload = {
          ...adoptedRedacted,
          ...milestoneDefaultFields(milestoneResolution),
          area_inferred: areaInferred
        };
        adoptedPayload._adopted = { backend: adoption.backend, remote_iid: remoteIid };
        return ok(adoptedPayload);
      }
      db.run(
        `INSERT INTO issues (objective, description, status, created_at, updated_at, milestone, repo, labels)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`,
        [objective, description, now2, now2, milestone, issueRepo, JSON.stringify(labels)]
      );
      const rowId = db.get(
        `SELECT id FROM issues WHERE rowid = last_insert_rowid()`
      );
      if (!rowId) {
        throw new Error("issue_create: failed to retrieve inserted row");
      }
      const issueId = rowId.id;
      const marker = issueSyncMarker(issueId, now2);
      const syncConfigRow = db.get(
        `SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`
      );
      const syncConfig = syncConfigRow ? JSON.parse(syncConfigRow.value_json) : "off";
      let syncDiagnostic;
      if (syncConfig !== "off") {
        const syncCtx = resolveIssueSyncContext(db, issueRepo);
        const remoteProviders = syncCtx ? { github: syncCtx.remoteFor("gh") !== null, gitlab: syncCtx.remoteFor("glab") !== null } : null;
        const backend = resolveBackendFor(syncConfig, remoteProviders, probeSpawn(spawnFn));
        if (backend === null) {
          serverLog({ event: "issue_sync_skip", reason: "no_remote_configured", issueId });
        } else if (backend !== "off") {
          if (syncCtx === null) {
            serverLog({ event: "issue_sync_skip", reason: "unresolvable_repo", issueId, repo: issueRepo, backend });
            syncDiagnostic = {
              sync_failed: true,
              reason: "unresolvable_repo",
              repo: issueRepo,
              backend,
              hint: issueRepo ? `issue repo "${issueRepo}" has no matching repos row \u2014 run /scan or pass a valid repo.` : "no repos registered \u2014 run /scan to register this repo."
            };
            const row3 = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
            const issue2 = decodeIssue(row3);
            const redacted2 = redactIssue(issue2, agent, { include_description: includeDescription });
            const payload2 = {
              ...redacted2,
              ...milestoneDefaultFields(milestoneResolution),
              area_inferred: areaInferred
            };
            payload2._sync = syncDiagnostic;
            return ok(payload2);
          }
          const syncCwd = syncCtx.cwd;
          const reachable = syncedBackends(backend, syncCtx);
          const createBackend = reachable.length === 1 ? reachable[0] : backend;
          if (createBackend === "both") {
            const ghRemote = syncCtx.remoteFor("gh");
            const glRemote = syncCtx.remoteFor("glab");
            const ghRemoteUrl = ghRemote?.url ?? null;
            const glRemoteUrl = glRemote?.url ?? null;
            const ghBlank = !ghRemoteUrl;
            const glBlank = !glRemoteUrl;
            const unsynced = ghBlank && glBlank ? unsyncedBackends(db, syncCtx, ["gh", "glab"]) : [];
            if (ghBlank && glBlank && unsynced.length > 0) {
              serverLog({ event: "issue_sync_skip", reason: "not_synced", issueId, backend });
              syncDiagnostic = {
                sync_skipped: true,
                reason: "not_synced",
                backend,
                hint: notSyncedHint(unsynced)
              };
            } else if (ghBlank && glBlank) {
              serverLog({ event: "issue_sync_skip", reason: "blank_remote_url", issueId, backend });
              syncDiagnostic = {
                sync_skipped: true,
                reason: "blank_remote_url",
                backend,
                hint: "Configure remote URLs via /onboard before syncing issues."
              };
            } else {
              const [ghResult, glResult] = await Promise.all([
                !ghBlank ? syncIssueCreate({
                  issueId,
                  title: objective,
                  body: description,
                  marker,
                  labels,
                  milestone: milestone ?? void 0,
                  _backend: "gh",
                  _spawnFn: spawnFn,
                  _cwd: syncCwd,
                  _remoteUrl: ghRemoteUrl ?? void 0,
                  _repoSlug: ghRemote?.slug ?? void 0
                }) : Promise.resolve({ ok: false, reason: "no_backend", outcome: "failed", backend: "gh", message: "blank remote URL for gh" }),
                !glBlank ? syncIssueCreate({
                  issueId,
                  title: objective,
                  body: description,
                  marker,
                  labels,
                  milestone: milestone ?? void 0,
                  _backend: "glab",
                  _spawnFn: spawnFn,
                  _cwd: syncCwd,
                  _remoteUrl: glRemoteUrl ?? void 0,
                  _repoSlug: glRemote?.slug ?? void 0
                }) : Promise.resolve({ ok: false, reason: "no_backend", outcome: "failed", backend: "glab", message: "blank remote URL for glab" })
              ]);
              const ghIid = !isFailure(ghResult) && ghResult.remote_kind === "github" ? ghResult.remote_iid : null;
              const glIid = !isFailure(glResult) && glResult.remote_kind === "gitlab" ? glResult.remote_iid : null;
              const firstSuccess = !isFailure(ghResult) ? ghResult : !isFailure(glResult) ? glResult : null;
              const failureOutcomes = {};
              if (isFailure(ghResult)) failureOutcomes.gh = ghResult.outcome;
              if (isFailure(glResult)) failureOutcomes.glab = glResult.outcome;
              if (firstSuccess !== null) {
                db.run(
                  `UPDATE issues SET remote_kind = ?, gh_iid = ?, gl_iid = ?, updated_at = ? WHERE id = ?`,
                  [firstSuccess.remote_kind, ghIid, glIid, now2, issueId]
                );
              } else {
                const failures = [];
                if (isFailure(ghResult)) {
                  serverLog({ event: "issue_sync_failed", issueId, backend: "gh", reason: ghResult.reason, outcome: ghResult.outcome, exit_code: ghResult.exit_code, stderr: ghResult.stderr?.slice(0, 1024), message: ghResult.message });
                  failures.push("gh");
                }
                if (isFailure(glResult)) {
                  serverLog({ event: "issue_sync_failed", issueId, backend: "glab", reason: glResult.reason, outcome: glResult.outcome, exit_code: glResult.exit_code, stderr: glResult.stderr?.slice(0, 1024), message: glResult.message });
                  failures.push("glab");
                }
                syncDiagnostic = {
                  sync_failed: true,
                  reason: "both_remotes_failed",
                  backends: failures,
                  outcomes: failureOutcomes,
                  hint: syncFailureHint(Object.values(failureOutcomes))
                };
              }
              if (ghIid !== null || glIid !== null) {
                const partial = [];
                if (isFailure(ghResult)) partial.push("gh");
                if (isFailure(glResult)) partial.push("glab");
                if (partial.length > 0) {
                  syncDiagnostic = {
                    sync_partial: true,
                    failed_backends: partial,
                    outcomes: failureOutcomes,
                    gh_iid: ghIid,
                    gl_iid: glIid,
                    hint: Object.values(failureOutcomes).includes("unknown") ? SYNC_UNKNOWN_HINT : "Try `issue_sync_retry` to retry the failed remote."
                  };
                }
              }
              const droppedLabels = /* @__PURE__ */ new Set();
              if (!isFailure(ghResult) && ghResult.unknown_labels) {
                for (const l of ghResult.unknown_labels) droppedLabels.add(l);
              }
              if (!isFailure(glResult) && glResult.unknown_labels) {
                for (const l of glResult.unknown_labels) droppedLabels.add(l);
              }
              if (droppedLabels.size > 0 && !syncDiagnostic) {
                syncDiagnostic = {
                  labels_dropped: [...droppedLabels],
                  reason: "labels_not_in_remote_taxonomy",
                  hint: "These requested labels do not exist on the remote and were omitted from the remote issue; all labels are still kept on the local issue."
                };
              }
            }
          } else {
            const remote = syncCtx.remoteFor(createBackend);
            const remoteUrl = remote?.url ?? null;
            if (!remoteUrl && unsyncedBackends(db, syncCtx, [createBackend]).length > 0) {
              serverLog({ event: "issue_sync_skip", reason: "not_synced", issueId, backend: createBackend });
              syncDiagnostic = {
                sync_skipped: true,
                reason: "not_synced",
                backend: createBackend,
                hint: notSyncedHint([createBackend])
              };
            } else if (!remoteUrl) {
              serverLog({ event: "issue_sync_skip", reason: "blank_remote_url", issueId, backend: createBackend });
              syncDiagnostic = {
                sync_skipped: true,
                reason: "blank_remote_url",
                backend: createBackend,
                hint: "Configure remote URLs via /onboard before syncing issues."
              };
            } else {
              const syncResult = await syncIssueCreate({
                issueId,
                title: objective,
                body: description,
                marker,
                labels,
                milestone: milestone ?? void 0,
                _backend: createBackend,
                _spawnFn: spawnFn,
                _cwd: syncCwd,
                _remoteUrl: remoteUrl ?? void 0,
                _repoSlug: remote?.slug ?? void 0
              });
              if (!isFailure(syncResult)) {
                const ghIid = syncResult.remote_kind === "github" ? syncResult.remote_iid : null;
                const glIid = syncResult.remote_kind === "gitlab" ? syncResult.remote_iid : null;
                db.run(
                  `UPDATE issues SET remote_kind = ?, gh_iid = ?, gl_iid = ?, updated_at = ? WHERE id = ?`,
                  [syncResult.remote_kind, ghIid, glIid, now2, issueId]
                );
                if (syncResult.unknown_labels && syncResult.unknown_labels.length > 0) {
                  syncDiagnostic = {
                    labels_dropped: syncResult.unknown_labels,
                    reason: "labels_not_in_remote_taxonomy",
                    hint: "These requested labels do not exist on the remote and were omitted from the remote issue; all labels are still kept on the local issue."
                  };
                }
              } else {
                serverLog({
                  event: "issue_sync_failed",
                  issueId,
                  backend,
                  reason: syncResult.reason,
                  outcome: syncResult.outcome,
                  exit_code: syncResult.exit_code,
                  stderr: syncResult.stderr?.slice(0, 1024),
                  message: syncResult.message
                });
                syncDiagnostic = {
                  sync_failed: true,
                  reason: syncResult.reason,
                  outcome: syncResult.outcome,
                  backend: syncResult.backend,
                  exit_code: syncResult.exit_code,
                  stderr: syncResult.stderr?.slice(0, 4096),
                  stdout: syncResult.stdout?.slice(0, 4096),
                  message: syncResult.message,
                  hint: syncFailureHint([syncResult.outcome])
                };
              }
            }
          }
        }
      } else {
        insertAudit(db, {
          issue_id: issueId,
          from_node: "executor",
          event_type: "sync_skipped",
          summary: `issue ${issueId} sync skipped: issue_sync is off`,
          content_json: JSON.stringify({ issue_id: issueId, reason: "issue_sync_off" }),
          created_at: nowISO()
        });
        const preferred = detectPreferred(
          resolveRepoForSync(db, issueRepo)?.path ?? projectRootFromDbPath(dbPath || db.dbPath)
        );
        if (preferred !== null) {
          syncDiagnostic = {
            sync_skipped: true,
            reason: 'issue_sync is "off" but origin points at ' + preferred,
            hint: 'If this project should mirror issues to the remote, run `config_set(key="issue_sync", value="auto")`.'
          };
        }
      }
      const row2 = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      const issue = decodeIssue(row2);
      const redacted = redactIssue(issue, agent, { include_description: includeDescription });
      const payload = {
        ...redacted,
        ...milestoneDefaultFields(milestoneResolution),
        area_inferred: areaInferred
      };
      if (syncDiagnostic) payload._sync = syncDiagnostic;
      return ok(payload);
    })),
    issue_get: wrapHandler(async (args) => {
      const agent = normalizeAgent(args["agent"]);
      const issueId = requireArg(args, "issue_id");
      const includeDescription = args["include_description"] ?? false;
      const row2 = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row2) {
        throw new Error(`Not found: ${issueId}`);
      }
      const issue = decodeIssue(row2);
      return ok(redactIssue(issue, agent, { include_description: includeDescription }));
    }),
    issue_resume: wrapHandler(async (args) => {
      const agent = normalizeAgent(args["agent"]);
      const issueId = requireArg(args, "issue_id");
      const row2 = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row2) {
        throw new Error(`Not found: ${issueId}`);
      }
      const issue = decodeIssue(row2);
      const task = db.get(
        `SELECT * FROM tasks
         WHERE issue_id = ? AND status IN ('pending', 'failed')
         ORDER BY branch_id ASC
         LIMIT 1`,
        [issueId]
      );
      return ok({ issue: redactIssue(issue, agent), next_task: task ?? null });
    }),
    issue_close: requireRoles("issue_close", ["bro"], wrapHandler(async (args) => {
      requireArg(args, "agent");
      const agent = normalizeAgent(args["agent"]);
      const issueId = requireArg(args, "issue_id");
      const now2 = nowISO();
      const existing = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!existing) {
        throw new Error(`Not found: ${issueId}`);
      }
      const cascade = args["cascade"] === true;
      const waiveReview = args["waive_review"] === true;
      const waiveReason = args["waive_review_reason"];
      const cascadeReason = typeof args["reason"] === "string" && args["reason"].trim() !== "" ? args["reason"] : "issue closed with cascade";
      if (waiveReview && (typeof waiveReason !== "string" || waiveReason.trim().length < WAIVE_REVIEW_REASON_MIN)) {
        return err(`waive_review_reason must be a string \u2265${WAIVE_REVIEW_REASON_MIN} chars.`);
      }
      const live = liveTasksOfIssue(db, issueId);
      if (live.length > 0 && !cascade) {
        return refusal("issue_has_open_tasks", {
          message: `Issue ${issueId} has tasks not in closed|failed|escalated. Finish them, or pass cascade=true to escalate them and close the issue.`,
          tasks: live.map((t) => ({ task_id: t.id, status: t.status }))
        });
      }
      const unreviewed = closedTasksWithoutReview(db, issueId);
      if (unreviewed.length > 0 && !waiveReview) {
        return refusal("tasks_without_review", {
          message: `Issue ${issueId} has closed tasks with no passing code-reviewer verdict for their current commit. Run code-reviewer, or pass waive_review=true with waive_review_reason="<why>".`,
          tasks: unreviewed.map((t) => ({ task_id: t.id, commit_sha: t.commit_sha }))
        });
      }
      db.transaction(() => {
        if (waiveReview) {
          for (const t of unreviewed) {
            insertAudit(db, {
              issue_id: t.issue_id,
              branch_id: t.branch_id,
              from_node: "bro",
              event_type: "review_gate_waived",
              summary: `issue_close review gate waived for task ${t.id}`,
              content_json: JSON.stringify({
                skill: "issue_close",
                task_id: t.id,
                commit_sha: t.commit_sha,
                waive_review_reason: waiveReason
              }),
              created_at: now2
            });
          }
        }
        escalateLiveTasksForIssueClose(db, live, cascadeReason, now2);
        markIssueClosed(db, issueId, now2);
      });
      const remote = await syncIssueCloseRemotes(db, dbPath, issueId, args["_spawnFn"]);
      const updated = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      return ok({
        ...redactIssue(decodeIssue(updated), agent, { include_description: false }),
        tasks_escalated: live.map((t) => t.id),
        review_waived_tasks: waiveReview ? unreviewed.map((t) => t.id) : [],
        remote
      });
    })),
    issue_get_phase: wrapHandler(async (args) => {
      requireArg(args, "agent");
      const issueId = requireArg(args, "issue_id");
      const issueRow = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!issueRow) {
        throw new Error(`Not found: ${issueId}`);
      }
      const issue = decodeIssue(issueRow);
      const rawCounts = db.get(
        `SELECT
           COUNT(*) as tasks_total,
           SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as tasks_completed,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as tasks_awaiting_close,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as tasks_failed
         FROM tasks WHERE issue_id = ?`,
        [issueId]
      );
      const counts = {
        tasks_total: rawCounts?.tasks_total ?? 0,
        tasks_completed: rawCounts?.tasks_completed ?? 0,
        tasks_awaiting_close: rawCounts?.tasks_awaiting_close ?? 0,
        tasks_failed: rawCounts?.tasks_failed ?? 0
      };
      let phase;
      if (issue.status === "closed") {
        phase = "done";
      } else if (counts.tasks_total === 0) {
        phase = "discussion";
      } else if (counts.tasks_completed >= counts.tasks_total) {
        phase = "ready_to_close";
      } else {
        phase = "tasks";
      }
      return ok({ phase, counts });
    }),
    issue_list: wrapHandler(async (args) => {
      normalizeAgent(args["agent"]);
      const rawStatus = args["status"];
      const rawLimit = args["limit"] ?? 50;
      const rawOffset = args["offset"] ?? 0;
      const fieldsArg = args["fields"];
      const limit = Math.min(Math.max(1, rawLimit), 200);
      const offset = Math.max(0, rawOffset);
      const VALID_ISSUE_STATUSES = /* @__PURE__ */ new Set(["open", "closed"]);
      if (rawStatus !== void 0 && !VALID_ISSUE_STATUSES.has(rawStatus)) {
        return err(
          `Invalid status: "${rawStatus}". Allowed values: ${[...VALID_ISSUE_STATUSES].join(", ")}`
        );
      }
      const ALLOWED_ISSUE_LIST_FIELDS = /* @__PURE__ */ new Set(["id", "objective", "status", "created_at", "updated_at"]);
      if (fieldsArg !== void 0) {
        const unknown = fieldsArg.filter((f) => !ALLOWED_ISSUE_LIST_FIELDS.has(f));
        if (unknown.length > 0) {
          return err(`Unknown fields: ${unknown.join(", ")}. Allowed: ${[...ALLOWED_ISSUE_LIST_FIELDS].join(", ")}`);
        }
      }
      function projectRow(row2) {
        if (!fieldsArg) return row2;
        const out = {};
        for (const f of fieldsArg) out[f] = row2[f];
        return out;
      }
      const rawMilestone = args["milestone"];
      const conditions = [];
      const params = [];
      if (rawStatus !== void 0) {
        conditions.push("status = ?");
        params.push(rawStatus);
      }
      if (rawMilestone !== void 0 && rawMilestone !== "") {
        if (rawMilestone === "none") {
          conditions.push("milestone IS NULL");
        } else {
          conditions.push("milestone = ?");
          params.push(rawMilestone);
        }
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db.all(
        `SELECT id, objective, status, created_at, updated_at FROM issues ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      return ok(rows.map(projectRow));
    }),
    issue_update_description: requireRoles("issue_update_description", ["bro"], wrapHandler(async (args) => {
      const agent = normalizeAgent(args["agent"]);
      const issueId = requireArg(args, "issue_id");
      const description = requireArg(args, "description");
      const includeDescription = args["include_description"] ?? false;
      const spawnFn = args["_spawnFn"] ?? void 0;
      const cwdOverride = args["_cwd"];
      const MAX_DESCRIPTION_BYTES = 1024 * 1024;
      if (Buffer.byteLength(description, "utf8") > MAX_DESCRIPTION_BYTES) {
        return err("description exceeds 1MB limit");
      }
      const row2 = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row2) {
        return err(`not_found: issue ${issueId}`);
      }
      const now2 = nowISO();
      db.run(
        "UPDATE issues SET description = ?, updated_at = ? WHERE id = ?",
        [description, now2, issueId]
      );
      const syncDiagnostic = await mirrorIssueEdit(
        db,
        row2,
        { body: description, marker: issueSyncMarker(row2.id, row2.created_at) },
        spawnFn,
        cwdOverride
      );
      const updated = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      return ok({
        ...redactIssue(decodeIssue(updated), agent, { include_description: includeDescription }),
        _sync: syncDiagnostic
      });
    })),
    issue_update: requireRoles("issue_update", ["bro"], wrapHandler(async (args) => {
      const agent = normalizeAgent(args["agent"]);
      const issueId = requireArg(args, "issue_id");
      const includeDescription = args["include_description"] ?? false;
      const milestoneArg = args["milestone"];
      const labelsArg = args["labels"];
      const objectiveArg = args["objective"];
      const spawnFn = args["_spawnFn"] ?? void 0;
      const cwdOverride = args["_cwd"];
      if (milestoneArg === void 0 && labelsArg === void 0 && objectiveArg === void 0) {
        return err("no_fields: pass at least one of milestone, labels, objective");
      }
      if (milestoneArg !== void 0 && milestoneArg === "") {
        return err("invalid_milestone: milestone must be a non-empty string");
      }
      if (objectiveArg !== void 0 && objectiveArg.trim() === "") {
        return err("invalid_objective: objective must be a non-empty string");
      }
      const row2 = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row2) {
        return err(`not_found: issue ${issueId}`);
      }
      if (labelsArg !== void 0) {
        const labelError = validateIssueLabels(db, labelsArg, options.labelTaxonomy, "issue_update");
        if (labelError) return err(labelError);
      }
      let previousLabels = [];
      if (row2.labels != null) {
        try {
          const parsed = JSON.parse(row2.labels);
          if (Array.isArray(parsed)) previousLabels = parsed.filter((l) => typeof l === "string");
        } catch {
          previousLabels = [];
        }
      }
      const changed = [];
      const before = {};
      const after = {};
      const sets = [];
      const params = [];
      if (milestoneArg !== void 0) {
        ensureMilestoneRow(db, milestoneArg, row2.repo);
        changed.push("milestone");
        before["milestone"] = row2.milestone;
        after["milestone"] = milestoneArg;
        sets.push("milestone = ?");
        params.push(milestoneArg);
      }
      if (labelsArg !== void 0) {
        changed.push("labels");
        before["labels"] = previousLabels;
        after["labels"] = labelsArg;
        sets.push("labels = ?");
        params.push(JSON.stringify(labelsArg));
      }
      if (objectiveArg !== void 0) {
        changed.push("objective");
        before["objective"] = row2.objective;
        after["objective"] = objectiveArg;
        sets.push("objective = ?");
        params.push(objectiveArg);
      }
      const now2 = nowISO();
      db.run(
        `UPDATE issues SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
        [...params, now2, issueId]
      );
      insertAudit(db, {
        issue_id: row2.id,
        from_node: "executor",
        event_type: "issue_updated",
        summary: `issue ${issueId} updated: ${changed.join(", ")}`,
        content_json: JSON.stringify({ issue_id: issueId, changed, before, after }),
        created_at: now2
      });
      const fields = {};
      if (milestoneArg !== void 0) fields.milestone = milestoneArg;
      if (labelsArg !== void 0) {
        fields.labels = {
          add: labelsArg.filter((l) => !previousLabels.includes(l)),
          remove: previousLabels.filter((l) => !labelsArg.includes(l))
        };
      }
      if (objectiveArg !== void 0) fields.title = objectiveArg;
      const syncDiagnostic = await mirrorIssueEdit(db, row2, fields, spawnFn, cwdOverride);
      const updated = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      return ok({
        ...redactIssue(decodeIssue(updated), agent, { include_description: includeDescription }),
        _sync: syncDiagnostic
      });
    })),
    issue_sync_retry: requireRoles("issue_sync_retry", ["bro"], wrapHandler(async (args) => {
      const issueId = requireArg(args, "issue_id");
      const spawnFn = args["_spawnFn"] ?? void 0;
      const row2 = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row2) {
        return err(`not_found: issue ${issueId}`);
      }
      const syncConfigRow = db.get(
        `SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`
      );
      const syncConfig = syncConfigRow ? JSON.parse(syncConfigRow.value_json) : "off";
      if (syncConfig === "off") {
        return ok({ skipped: true, reason: "issue_sync is off" });
      }
      const retryCtx = resolveIssueSyncContext(db, row2.repo ?? null);
      const retryRemotes = retryCtx ? { github: retryCtx.remoteFor("gh") !== null, gitlab: retryCtx.remoteFor("glab") !== null } : null;
      const backend = resolveBackendFor(syncConfig, retryRemotes, probeSpawn(spawnFn));
      if (backend === null || backend === "off") {
        return ok({ skipped: true, reason: "no remote backend configured" });
      }
      if (retryCtx === null) {
        return ok({
          skipped: true,
          reason: "unresolvable_repo",
          repo: row2.repo ?? null,
          hint: row2.repo ? `issue repo "${row2.repo}" has no matching repos row.` : "multiple repos registered and no issue repo selected."
        });
      }
      const issue = decodeIssue(row2);
      if (row2.status === "closed") {
        const retryCwd2 = retryCtx.cwd;
        const retryTargets = [];
        if (row2.gh_iid != null) {
          retryTargets.push({ remote_iid: row2.gh_iid, remote_kind: "github" });
        }
        if (row2.gl_iid != null) {
          retryTargets.push({ remote_iid: row2.gl_iid, remote_kind: "gitlab" });
        }
        if (retryTargets.length === 0) {
          return ok({ action: "close", success: false, error: { reason: "no_remote_iid" } });
        }
        const syncedTargets = retryTargets.filter(
          (t) => retryCtx.remoteFor(t.remote_kind === "github" ? "gh" : "glab") !== null
        );
        if (syncedTargets.length === 0) {
          return ok({ action: "close", success: true, skipped: true, reason: "not_synced" });
        }
        const closeErrors = [];
        for (const target of syncedTargets) {
          const closeResult = await syncIssueClose({
            remote_iid: target.remote_iid,
            remote_kind: target.remote_kind,
            _spawnFn: spawnFn,
            _cwd: retryCwd2,
            _repoSlug: retryCtx.remoteFor(target.remote_kind === "github" ? "gh" : "glab")?.slug ?? void 0
          });
          if (!closeResult.ok) {
            closeErrors.push({
              remote_kind: target.remote_kind,
              reason: closeResult.reason,
              exit_code: closeResult.exit_code,
              stderr: closeResult.stderr?.slice(0, 4096),
              stdout: closeResult.stdout?.slice(0, 4096),
              message: closeResult.message
            });
          }
        }
        if (closeErrors.length === 0) {
          return ok({ action: "close", success: true });
        }
        return ok({ action: "close", success: false, errors: closeErrors });
      }
      const retryCwd = retryCtx.cwd;
      const reachable = syncedBackends(backend, retryCtx);
      if (reachable.length === 0) {
        return ok({ action: "create", success: true, skipped: true, reason: "not_synced" });
      }
      const createTargets = [];
      if (reachable.includes("gh") && row2.gh_iid == null) {
        createTargets.push("gh");
      }
      if (reachable.includes("glab") && row2.gl_iid == null) {
        createTargets.push("glab");
      }
      if (createTargets.length === 0) {
        return ok({ action: "create", success: true, skipped: true, reason: "already_synced" });
      }
      let retryLabels;
      if (row2.labels == null) {
        retryLabels = defaultSyncLabels(db);
      } else {
        try {
          const parsed = JSON.parse(row2.labels);
          retryLabels = Array.isArray(parsed) ? parsed : defaultSyncLabels(db);
        } catch {
          retryLabels = defaultSyncLabels(db);
        }
      }
      const marker = issueSyncMarker(row2.id, row2.created_at);
      const createErrors = [];
      const adoptions = [];
      let lastSuccess = null;
      for (const target of createTargets) {
        const retryRemote = retryCtx.remoteFor(target);
        const lookup = await findIssuesByMarker(target, marker, {
          spawnFn,
          cwd: retryCwd,
          repoSlug: retryRemote?.slug ?? void 0
        });
        if (!lookup.ok) {
          createErrors.push({
            backend: target,
            reason: "lookup_failed",
            lookup_reason: lookup.reason,
            exit_code: lookup.exit_code,
            stderr: lookup.stderr?.slice(0, 4096),
            message: lookup.message,
            hint: "Could not check the remote for an issue an earlier create may have made, so nothing was created. Fix the gh/glab access and retry."
          });
          continue;
        }
        if (lookup.iids.length > 0) {
          const adoptedIid = lookup.iids[0];
          const duplicates = lookup.iids.slice(1);
          const remoteKind = target === "gh" ? "github" : "gitlab";
          const adoptNow = nowISO();
          db.run(
            `UPDATE issues SET remote_kind = COALESCE(remote_kind, ?), gh_iid = COALESCE(gh_iid, ?), gl_iid = COALESCE(gl_iid, ?), updated_at = ? WHERE id = ?`,
            [remoteKind, target === "gh" ? adoptedIid : null, target === "glab" ? adoptedIid : null, adoptNow, issueId]
          );
          insertAudit(db, {
            issue_id: row2.id,
            from_node: "executor",
            event_type: "issue_adopted",
            summary: `issue ${row2.id} adopted ${remoteKind} #${adoptedIid} found by its sync marker`,
            content_json: JSON.stringify({ issue_id: row2.id, backend: remoteKind, remote_iid: adoptedIid, via: "issue_sync_retry" }),
            created_at: adoptNow
          });
          adoptions.push({ backend: target, remote_iid: adoptedIid, duplicates });
          lastSuccess = { remote_iid: adoptedIid, remote_kind: remoteKind };
          continue;
        }
        const syncResult = await syncIssueCreate({
          issueId: row2.id,
          title: issue.objective,
          body: row2.description,
          marker,
          labels: retryLabels,
          milestone: row2.milestone ?? void 0,
          _backend: target,
          _spawnFn: spawnFn,
          _cwd: retryCwd,
          _remoteUrl: retryRemote?.url ?? void 0,
          _repoSlug: retryRemote?.slug ?? void 0
        });
        if (!isFailure(syncResult)) {
          lastSuccess = { remote_iid: syncResult.remote_iid, remote_kind: syncResult.remote_kind };
          const retryGhIid = syncResult.remote_kind === "github" ? syncResult.remote_iid : null;
          const retryGlIid = syncResult.remote_kind === "gitlab" ? syncResult.remote_iid : null;
          db.run(
            `UPDATE issues SET remote_kind = COALESCE(remote_kind, ?), gh_iid = COALESCE(gh_iid, ?), gl_iid = COALESCE(gl_iid, ?), updated_at = ? WHERE id = ?`,
            [syncResult.remote_kind, retryGhIid, retryGlIid, nowISO(), issueId]
          );
        } else {
          createErrors.push({
            backend: syncResult.backend,
            reason: syncResult.reason,
            outcome: syncResult.outcome,
            exit_code: syncResult.exit_code,
            stderr: syncResult.stderr?.slice(0, 4096),
            stdout: syncResult.stdout?.slice(0, 4096),
            message: syncResult.message
          });
        }
      }
      const adoptionFields = adoptions.length === 0 ? {} : {
        adopted: true,
        duplicates: adoptions.flatMap((a) => a.duplicates),
        adoptions
      };
      if (createErrors.length === 0 && lastSuccess !== null) {
        return ok({ action: "create", success: true, remote_iid: lastSuccess.remote_iid, remote_kind: lastSuccess.remote_kind, ...adoptionFields });
      }
      if (lastSuccess !== null) {
        return ok({ action: "create", success: true, partial: true, errors: createErrors, remote_iid: lastSuccess.remote_iid, remote_kind: lastSuccess.remote_kind, ...adoptionFields });
      }
      return ok({
        action: "create",
        success: false,
        errors: createErrors
      });
    })),
    issue_link: requireRoles("issue_link", ["bro"], wrapHandler(async (args) => {
      const agent = normalizeAgent(args["agent"]);
      const includeDescription = args["include_description"] ?? false;
      const issueId = requireArg(args, "issue_id");
      const backend = requireArg(args, "backend");
      const iid = requireArg(args, "iid");
      const force = args["force"] ?? false;
      if (!Number.isInteger(iid) || iid <= 0) {
        return err(`invalid iid: must be a positive integer`);
      }
      const row2 = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row2) {
        return err(`not_found: issue ${issueId}`);
      }
      const iidColumn = backend === "github" ? "gh_iid" : "gl_iid";
      const existingIid = backend === "github" ? row2.gh_iid : row2.gl_iid;
      if (existingIid != null && !force) {
        return err(`already_linked: issue ${issueId} already has ${backend} iid ${existingIid} \u2014 pass force=true to overwrite`);
      }
      const now2 = nowISO();
      if (backend === "github") {
        db.run(
          `UPDATE issues SET gh_iid = ?, remote_kind = COALESCE(remote_kind, 'github'), updated_at = ? WHERE id = ?`,
          [iid, now2, issueId]
        );
      } else {
        db.run(
          `UPDATE issues SET gl_iid = ?, remote_kind = COALESCE(remote_kind, 'gitlab'), updated_at = ? WHERE id = ?`,
          [iid, now2, issueId]
        );
      }
      insertAudit(db, {
        issue_id: parseInt(issueId, 10),
        from_node: "executor",
        event_type: "issue_linked",
        summary: `issue ${issueId} linked to ${backend} #${iid}${force && existingIid != null ? ` (forced, was ${existingIid})` : ""}`,
        content_json: JSON.stringify({ issue_id: issueId, backend, iid, forced: force && existingIid != null }),
        created_at: now2
      });
      const updated = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      return ok({ linked: true, backend, iid, issue: redactIssue(decodeIssue(updated), agent, { include_description: includeDescription }) });
    })),
    issue_adopt_remote: requireRoles("issue_adopt_remote", ["bro"], wrapHandler(async (args) => {
      const agent = normalizeAgent(args["agent"]);
      const includeDescription = args["include_description"] ?? false;
      const repoArg = args["repo"] ?? null;
      const issueId = requireArg(args, "issue_id");
      const remoteIidRaw = requireArg(args, "remote_iid");
      const remoteIid = typeof remoteIidRaw === "number" ? remoteIidRaw : Number(remoteIidRaw);
      const remoteBackendArg = args["remote_backend"];
      const spawnFn = args["_spawnFn"] ?? void 0;
      const row2 = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row2) {
        return err(`not_found: issue ${issueId}`);
      }
      if (repoArg !== null && !db.get("SELECT name FROM repos WHERE name = ?", [repoArg])) {
        return err(`repo_not_found: no repos row named "${repoArg}"`);
      }
      const adoptRepo = repoArg ?? row2.repo ?? null;
      if (adoptRepo === null) {
        const repoCount = db.get("SELECT COUNT(*) AS n FROM repos")?.n ?? 0;
        if (repoCount > 1) {
          return err(`repo_unresolved: issue ${issueId} has no repo and the workspace has ${repoCount} repos \u2014 pass repo`);
        }
      }
      const resolved = resolveAdoptionTarget(db, adoptRepo, remoteBackendArg, remoteIid);
      if (!resolved.ok) {
        return err(resolved.error);
      }
      const existingIid = resolved.target.backend === "github" ? row2.gh_iid : row2.gl_iid;
      if (existingIid != null && existingIid !== remoteIid) {
        return err(`already_linked: issue ${issueId} already has a ${resolved.target.backend} link (#${existingIid}); re-adopt is only idempotent for the same iid`);
      }
      const idempotent = existingIid === remoteIid;
      const adoption = await verifyAdoptionTarget(resolved.target, spawnFn);
      if (!adoption.ok) {
        return err(adoption.error);
      }
      const now2 = nowISO();
      const ghIid = adoption.backend === "github" ? remoteIid : null;
      const glIid = adoption.backend === "gitlab" ? remoteIid : null;
      db.run(
        `UPDATE issues SET gh_iid = COALESCE(?, gh_iid), gl_iid = COALESCE(?, gl_iid), remote_kind = COALESCE(remote_kind, ?), repo = COALESCE(repo, ?), updated_at = ? WHERE id = ?`,
        [ghIid, glIid, adoption.backend, repoArg, now2, issueId]
      );
      const copied = {};
      const refreshed = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (adoption.milestone !== null && (refreshed.milestone === null || refreshed.milestone === "")) {
        ensureMilestoneRow(db, adoption.milestone, refreshed.repo);
        copied.milestone = adoption.milestone;
      }
      const localLabelsEmpty = refreshed.labels == null || refreshed.labels === "" || refreshed.labels === "[]";
      if (adoption.labels.length > 0 && localLabelsEmpty) {
        copied.labels = adoption.labels;
      }
      if (copied.milestone !== void 0) {
        db.run("UPDATE issues SET milestone = ? WHERE id = ?", [copied.milestone, issueId]);
      }
      if (copied.labels !== void 0) {
        db.run("UPDATE issues SET labels = ? WHERE id = ?", [JSON.stringify(copied.labels), issueId]);
      }
      if (!idempotent || copied.milestone !== void 0 || copied.labels !== void 0) {
        insertAudit(db, {
          issue_id: parseInt(issueId, 10),
          from_node: "executor",
          event_type: "issue_adopted",
          summary: `issue ${issueId} adopted ${adoption.backend} #${remoteIid}`,
          content_json: JSON.stringify({ issue_id: issueId, backend: adoption.backend, remote_iid: remoteIid, at_create: false, ...copied.milestone !== void 0 ? { milestone: copied.milestone } : {}, ...copied.labels !== void 0 ? { labels: copied.labels } : {} }),
          created_at: now2
        });
      }
      const updated = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      return ok({ adopted: true, backend: adoption.backend, remote_iid: remoteIid, idempotent, issue: redactIssue(decodeIssue(updated), agent, { include_description: includeDescription }) });
    })),
    issue_reconcile_remote: requireRoles("issue_reconcile_remote", ["bro"], wrapHandler(async (args) => {
      const dryRun = args["dry_run"];
      if (dryRun !== void 0 && typeof dryRun !== "boolean") {
        return err("invalid_dry_run: dry_run must be a boolean");
      }
      const spawnFn = args["_spawnFn"] ?? void 0;
      const opts = { dryRun: dryRun === true, _spawnFn: spawnFn };
      const closes = reconcileRemoteCloses(db, opts);
      return ok({ ...closes, prs: syncRemotePrs(db, opts) });
    }))
  };
  return { definitions, handlers };
}

// server/releases.ts
import { readFileSync as readFileSync4 } from "node:fs";
var HEADING = /^## v(\S+) — (\d{4}-\d{2}-\d{2})\s*$/;
function parseChangelog(text2) {
  const releases = [];
  for (const line of text2.split(/\r?\n/)) {
    const m = HEADING.exec(line);
    if (m) releases.push({ version: m[1], date: m[2] });
  }
  return releases.map((r, i) => ({ r, i })).sort((a, b) => b.r.date.localeCompare(a.r.date) || a.i - b.i).map(({ r }) => r);
}
function loadReleases(path) {
  try {
    return parseChangelog(readFileSync4(path, "utf8"));
  } catch {
    return [];
  }
}
function releaseAt(releases, at) {
  if (!at) return null;
  const day = at.slice(0, 10);
  return releases.find((r) => r.date <= day) ?? null;
}

// server/queries.ts
var RECENT_LIMIT = 200;
function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}
function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}
function dataVersion(db) {
  return Number(one(db, "PRAGMA data_version")?.["data_version"] ?? 0);
}
function summary(db) {
  return {
    issues: one(
      db,
      `SELECT SUM(status = 'open') AS open, SUM(status = 'closed') AS closed
         FROM issues WHERE id > 0`
    ),
    tasks_by_status: all(
      db,
      `SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY count DESC`
    ),
    open_runs: Number(
      one(db, `SELECT COUNT(*) AS n FROM agent_runs WHERE completed_at IS NULL`)?.["n"] ?? 0
    ),
    recent_runs: all(
      db,
      `SELECT r.id, r.agent_type, r.task_id, r.issue_id, t.title AS task_title,
              r.started_at, r.completed_at, r.exit_reason, r.duration_ms
         FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id
        ORDER BY r.id DESC LIMIT 10`
    )
  };
}
var LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
var HOST = `${LABEL}(?:\\.${LABEL})*`;
var SEGMENT = "(?!\\.+(?:/|$))[A-Za-z0-9_.-]+";
var REPO_PATH = `${SEGMENT}(?:/${SEGMENT})+`;
var REMOTE_FORMS = [
  new RegExp(`^https://(${HOST})/(${REPO_PATH})$`),
  new RegExp(`^git@(${HOST}):(${REPO_PATH})$`),
  new RegExp(`^ssh://git@(${HOST})/(${REPO_PATH})$`)
];
function remoteWebUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.replace(/\/+$/, "").replace(/\.git$/, "");
  for (const form of REMOTE_FORMS) {
    const m = form.exec(trimmed);
    if (m) return `https://${m[1].toLowerCase()}/${m[2]}`;
  }
  return null;
}
function webRemotes(db) {
  const byRepo = /* @__PURE__ */ new Map();
  const rows = all(
    db,
    `SELECT repo, provider, url FROM repo_remotes
      WHERE provider IN ('github', 'gitlab')
      ORDER BY repo, sync DESC, is_primary DESC, name`
  );
  for (const r of rows) {
    const base = remoteWebUrl(r["url"]);
    if (!base) continue;
    const repo = String(r["repo"]);
    const list = byRepo.get(repo) ?? [];
    list.push({ provider: r["provider"], base });
    byRepo.set(repo, list);
  }
  return byRepo;
}
var present = (v) => v !== null && v !== void 0;
function issueWebUrl(remotes, issue) {
  const provider = present(issue["gh_iid"]) ? "github" : present(issue["gl_iid"]) ? "gitlab" : null;
  if (!provider || !present(issue["repo"])) return null;
  return remotes.get(String(issue["repo"]))?.find((r) => r.provider === provider)?.base ?? null;
}
function prTablesAvailable(db) {
  const found = one(db, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('prs', 'pr_closes')`);
  return Number(found?.["n"] ?? 0) === 2;
}
var ISSUE_PRS_SQL = `(SELECT json_group_array(json_object('number', x.number, 'created_at', x.created_at, 'merged_at', x.merged_at))
              FROM (SELECT p.number, p.created_at, p.merged_at
                      FROM prs p JOIN pr_closes c ON c.pr_id = p.id
                     WHERE p.repo = i.repo AND c.issue_number = i.gh_iid
                     ORDER BY p.number) x)`;
function issues(db) {
  const remotes = webRemotes(db);
  const prs = prTablesAvailable(db) ? ISSUE_PRS_SQL : `'[]'`;
  const rows = all(
    db,
    `SELECT i.id, i.objective, i.status, i.repo, i.milestone, i.gh_iid, i.gl_iid,
            i.created_at, i.updated_at, i.closed_at, i.labels,
            (SELECT COUNT(*) FROM tasks t WHERE t.issue_id = i.id) AS task_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.issue_id = i.id
               AND t.status IN ('completed','closed')) AS tasks_done,
            (SELECT COUNT(*) FROM discussions d WHERE d.issue_id = i.id) AS discussion_count,
            ${prs} AS prs
       FROM issues i
      WHERE i.id > 0
      ORDER BY i.status = 'open' DESC, i.updated_at DESC`
  ).map((i) => ({ ...i, remote_web_url: issueWebUrl(remotes, i) }));
  return { issues: rows, label_taxonomy: effectiveLabelTaxonomy(db) };
}
function schemaVersion(db) {
  const row2 = one(db, `SELECT schema_version FROM plugin_meta WHERE id = 1`);
  return row2 ? Number(row2["schema_version"]) : null;
}
function issueUpdatedAt(db, id) {
  const row2 = one(db, `SELECT updated_at FROM issues WHERE id = ?`, id);
  return row2 ? String(row2["updated_at"]) : null;
}
function configStringList(db, key) {
  const row2 = one(db, `SELECT value_json FROM plugin_config WHERE key = ?`, key);
  if (!row2) return null;
  try {
    const parsed = JSON.parse(String(row2["value_json"]));
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : null;
  } catch {
    return null;
  }
}
function effectiveLabelTaxonomy(db) {
  return {
    classification: configStringList(db, "issue_classification_labels") ?? [...DEFAULT_CLASSIFICATION_LABELS],
    priority: configStringList(db, "issue_priority_labels") ?? [...DEFAULT_PRIORITY_LABELS],
    area: configStringList(db, "issue_area_labels") ?? []
  };
}
function issueDetail(db, id) {
  const issue = one(db, `SELECT * FROM issues WHERE id = ?`, id);
  if (!issue) return null;
  const repo = issue["repo"] === null ? null : String(issue["repo"]);
  return {
    issue: { ...issue, remote_web_url: issueWebUrl(webRemotes(db), issue) },
    label_taxonomy: effectiveLabelTaxonomy(db),
    milestones: all(
      db,
      `SELECT DISTINCT name FROM milestones WHERE repo IS ? OR ? IS NULL ORDER BY name`,
      repo,
      repo
    ).map((r) => String(r["name"])),
    discussions: all(
      db,
      `SELECT id, author, kind, body, task_id, created_at FROM discussions
        WHERE issue_id = ? ORDER BY created_at, id`,
      id
    ),
    tasks: all(
      db,
      `SELECT id, branch_id, title, status, repo, effort, commit_sha, created_at,
              updated_at, completed_at
         FROM tasks WHERE issue_id = ? ORDER BY id`,
      id
    )
  };
}
function blockingFindingFilter(db) {
  const severity = one(db, `SELECT COUNT(*) AS n FROM pragma_table_info('review_findings') WHERE name = 'severity'`);
  return Number(severity?.["n"]) === 1 ? ` AND f.severity = 'blocking'` : "";
}
function tasks(db) {
  const blockingOnly = blockingFindingFilter(db);
  return all(
    db,
    `SELECT t.id, t.issue_id, i.objective AS issue_objective, t.branch_id, t.title,
            t.status, t.repo, t.effort, t.commit_sha, t.created_at, t.updated_at,
            t.completed_at,
            (SELECT v.verdict FROM validation_attempts v WHERE v.task_id = t.id
              ORDER BY v.id DESC LIMIT 1) AS last_verdict,
            (SELECT COUNT(*) FROM review_findings f WHERE f.task_id = t.id
               AND f.status = 'open'${blockingOnly}) AS open_findings
       FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
      ORDER BY t.id DESC LIMIT ?`,
    RECENT_LIMIT * 5
  );
}
function parseJsonColumn(row2, key) {
  const raw = row2[key];
  if (raw === null || raw === void 0) return { [key]: null };
  try {
    return { [key]: JSON.parse(String(raw)) };
  } catch {
    return { [key]: null, [`${key}_raw`]: String(raw) };
  }
}
function taskDetail(db, id) {
  const task = one(
    db,
    `SELECT id, issue_id, branch_id, parent_branch_id, title, status, spec_body, commit_sha,
            repo, effort, files, verification, completion_report, created_at, updated_at,
            completed_at
       FROM tasks WHERE id = ?`,
    id
  );
  if (!task) return null;
  const remote = present(task["repo"]) ? webRemotes(db).get(String(task["repo"]))?.[0] : void 0;
  const commands = db.prepare(
    `SELECT ordinal, command, exit_code, elapsed_s, output_tail
       FROM verification_run_commands WHERE run_id = ? ORDER BY ordinal`
  );
  const runs = all(
    db,
    `SELECT id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out
       FROM verification_runs WHERE task_id = ? ORDER BY started_at DESC, id DESC`,
    id
  );
  return {
    task: {
      ...task,
      ...parseJsonColumn(task, "files"),
      ...parseJsonColumn(task, "verification"),
      ...parseJsonColumn(task, "completion_report"),
      remote_web_url: remote?.base ?? null,
      remote_provider: remote?.provider ?? null
    },
    issue: one(db, `SELECT id, objective FROM issues WHERE id = ?`, Number(task["issue_id"])) ?? null,
    validations: all(
      db,
      `SELECT id, attempt_n, agent, verdict, feedback, mcp_available, created_at
         FROM validation_attempts WHERE task_id = ? ORDER BY attempt_n, id`,
      id
    ),
    findings: all(
      db,
      `SELECT id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at,
              resolved_at
         FROM review_findings WHERE task_id = ? ORDER BY attempt_n, created_at, id`,
      id
    ),
    verifications: runs.map((r) => ({ ...r, commands: commands.all(Number(r["id"])) })),
    agent_runs: all(
      db,
      `SELECT id, agent_type, model, effort, tokens_in, tokens_out, cache_read_tokens,
              cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at,
              exit_reason
         FROM agent_runs WHERE task_id = ? ORDER BY id`,
      id
    )
  };
}
function agentRuns(db) {
  return all(
    db,
    `SELECT r.id, r.agent_type, r.task_id, r.issue_id, t.title AS task_title,
            r.model, r.effort, r.tokens_in, r.tokens_out, r.cache_read_tokens,
            r.cache_creation_tokens, r.tool_uses, r.duration_ms, r.started_at,
            r.completed_at, r.exit_reason
       FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id
      ORDER BY r.id DESC LIMIT ?`,
    RECENT_LIMIT
  );
}
function gates(db) {
  return {
    validations: all(
      db,
      `SELECT v.id, v.task_id, t.title AS task_title, v.attempt_n, v.agent, v.verdict,
              v.feedback, v.mcp_available, v.created_at
         FROM validation_attempts v LEFT JOIN tasks t ON t.id = v.task_id
        ORDER BY v.id DESC LIMIT ?`,
      RECENT_LIMIT
    ),
    verifications: all(
      db,
      `SELECT r.id, r.task_id, t.title AS task_title, r.commit_sha, r.source,
              r.started_at, r.finished_at, r.exit_code, r.timed_out,
              (SELECT COUNT(*) FROM verification_run_commands c WHERE c.run_id = r.id) AS commands,
              (SELECT COUNT(*) FROM verification_run_commands c
                WHERE c.run_id = r.id AND c.exit_code <> 0) AS failed_commands
         FROM verification_runs r LEFT JOIN tasks t ON t.id = r.task_id
        ORDER BY r.id DESC LIMIT ?`,
      RECENT_LIMIT
    )
  };
}
var GATE_BOARD_RECENT_DAYS = 14;
function gateTask(r) {
  const commit = r["commit_sha"] ?? null;
  const verifiedCommit = r["v_commit_sha"] ?? null;
  return {
    id: Number(r["id"]),
    title: String(r["title"] ?? ""),
    status: String(r["status"]),
    commit_sha: commit,
    verification: r["v_id"] === null ? null : {
      id: Number(r["v_id"]),
      exit_code: r["v_exit_code"] === null ? null : Number(r["v_exit_code"]),
      timed_out: Number(r["v_timed_out"]) === 1,
      commit_sha: verifiedCommit,
      matches_commit: commit !== null && verifiedCommit === commit
    },
    verdict: r["a_id"] === null ? null : { id: Number(r["a_id"]), verdict: String(r["a_verdict"]), attempt_n: Number(r["a_attempt_n"]) },
    open_findings: Number(r["open_findings"] ?? 0)
  };
}
var verificationFailed = (t) => t.verification !== null && (t.verification.timed_out || t.verification.exit_code !== null && t.verification.exit_code !== 0);
var taskBlocked = (t) => verificationFailed(t) || t.verdict?.verdict === "fail" || t.verdict?.verdict === "escalate" || t.open_findings > 0;
var taskReady = (t) => t.verification !== null && t.verification.matches_commit && t.verification.exit_code === 0 && !t.verification.timed_out && t.verdict?.verdict === "pass" && t.open_findings === 0;
function gateState(tasks2) {
  if (tasks2.some(taskBlocked)) return "blocked";
  const open = tasks2.filter((t) => t.status !== "closed");
  const gated = open.length > 0 ? open : tasks2;
  return gated.length > 0 && gated.every(taskReady) ? "ready" : "pending";
}
function gateBoard(db) {
  const branches = all(
    db,
    `SELECT branch_id, MAX(updated_at) AS updated_at
       FROM tasks
      GROUP BY branch_id
     HAVING SUM(status <> 'closed') > 0
         OR julianday(MAX(updated_at)) >= julianday('now', ?)
      ORDER BY MAX(updated_at) DESC, branch_id
      LIMIT ?`,
    `-${GATE_BOARD_RECENT_DAYS} days`,
    RECENT_LIMIT
  );
  if (branches.length === 0) return [];
  const ids = branches.map((b) => String(b["branch_id"]));
  const rows = all(
    db,
    `SELECT t.id, t.branch_id, t.title, t.status, t.commit_sha,
            v.id AS v_id, v.exit_code AS v_exit_code, v.timed_out AS v_timed_out, v.commit_sha AS v_commit_sha,
            a.id AS a_id, a.verdict AS a_verdict, a.attempt_n AS a_attempt_n,
            (SELECT COUNT(*) FROM review_findings f
              WHERE f.task_id = t.id AND f.status = 'open' AND f.severity = 'blocking') AS open_findings
       FROM tasks t
       LEFT JOIN verification_runs v ON v.id = (SELECT MAX(id) FROM verification_runs WHERE task_id = t.id)
       LEFT JOIN validation_attempts a ON a.id = (SELECT MAX(id) FROM validation_attempts WHERE task_id = t.id)
      WHERE t.branch_id IN (SELECT value FROM json_each(?))
      ORDER BY t.id`,
    JSON.stringify(ids)
  );
  const byBranch = new Map(ids.map((id) => [id, []]));
  for (const r of rows) byBranch.get(String(r["branch_id"])).push(gateTask(r));
  return branches.map((b) => {
    const tasks2 = byBranch.get(String(b["branch_id"]));
    return { branch_id: String(b["branch_id"]), state: gateState(tasks2), updated_at: String(b["updated_at"]), tasks: tasks2 };
  });
}
function audit(db, limit) {
  return all(
    db,
    `SELECT id, issue_id, branch_id, from_node, event_type, summary, created_at
       FROM audit ORDER BY id DESC LIMIT ?`,
    limit
  );
}
var WM_TABLE_COUNT = 4;
var WM_DEFAULT_DEPTH = 2;
var WM_MAX_DEPTH = 5;
var WM_DEFAULT_HITS = 20;
var WM_MAX_HITS = 100;
function worldModelAvailable(db) {
  const found = one(
    db,
    `SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('wm_directories', 'wm_files', 'wm_directories_fts', 'wm_files_fts')`
  );
  return Number(found?.["n"] ?? 0) === WM_TABLE_COUNT;
}
function clampDepth(raw) {
  if (raw === null || raw.trim() === "") return WM_DEFAULT_DEPTH;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, 0), WM_MAX_DEPTH) : WM_DEFAULT_DEPTH;
}
function clampHits(raw) {
  if (raw === null || raw.trim() === "") return WM_DEFAULT_HITS;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), WM_MAX_HITS) : WM_DEFAULT_HITS;
}
var SUMMARY_MAX = 160;
var HR_LINE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
function summaryLine(raw) {
  if (typeof raw !== "string") return null;
  const line = raw.replace(/<\/?untrusted-content[^>]*>/g, " ").split("\n").filter((l) => !HR_LINE.test(l)).map(
    (l) => l.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2").replace(/`+/g, "").replace(/\s+/g, " ").trim()
  ).find((l) => l !== "");
  if (line === void 0) return "";
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1).trimEnd()}\u2026` : line;
}
function worldModel(db, repo, path, depth) {
  if (!worldModelAvailable(db)) return { available: false, repos: [], nodes: [] };
  const repos = all(db, `SELECT DISTINCT repo FROM wm_directories ORDER BY repo`).map((r) => String(r["repo"]));
  const target = repo ?? repos[0];
  if (target === void 0) return { available: true, repos, nodes: [] };
  const cols = columnsOf(db, "wm_directories");
  const behind = cols.has("commits_behind") ? "d.commits_behind" : "NULL";
  const deadRefs = cols.has("dead_refs") ? "d.dead_refs" : "NULL";
  const nodes = all(
    db,
    `WITH RECURSIVE sub(id, path, lvl) AS (
       SELECT id, path, 0 FROM wm_directories WHERE repo = ? AND path = ?
       UNION
       SELECT c.id, c.path, s.lvl + 1
         FROM wm_directories c JOIN sub s ON c.parent_path = s.path
        WHERE c.repo = ? AND c.path <> s.path AND s.lvl < ?
     )
     SELECT d.repo, d.path, d.parent_path, d.summary, d.file_count,
            ${behind} AS commits_behind, ${deadRefs} AS dead_refs
       FROM wm_directories d
      WHERE d.id IN (SELECT id FROM sub)
      ORDER BY d.path`,
    target,
    path,
    target,
    depth
  );
  return {
    available: true,
    repos,
    nodes: nodes.map((n) => ({
      ...n,
      summary: summaryLine(n["summary"]),
      commits_behind: n["commits_behind"] === null ? null : Number(n["commits_behind"]),
      dead_refs: parseDeadRefs(n["dead_refs"])
    }))
  };
}
function parseDeadRefs(raw) {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : null;
  } catch {
    return null;
  }
}
var GRAPH_KINDS = ["calls", "imports", "runs", "sources", "instantiates"];
function symbolGraphAvailable(db) {
  const found = one(
    db,
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('wm_symbols', 'wm_edges')`
  );
  return Number(found?.["n"] ?? 0) === 2;
}
function graph(db, repo) {
  const scope = graphTarget(db, repo);
  if (scope === null) return { available: false, repo: null, repos: [], files: [], edges: [] };
  const { repos, target } = scope;
  if (target === void 0) return { available: true, repo: null, repos, files: [], edges: [] };
  return graphRollup(db, repos, target);
}
function graphTarget(db, repo) {
  if (!worldModelAvailable(db) || !symbolGraphAvailable(db)) return null;
  const repos = all(db, `SELECT DISTINCT repo FROM wm_directories ORDER BY repo`).map((r) => String(r["repo"]));
  return { repos, target: repo ?? repos[0] };
}
function graphRollup(db, repos, target) {
  const rows = all(
    db,
    `SELECT s.path AS src, d.path AS dst, e.kind AS kind, COUNT(*) AS weight,
            sf.purpose AS src_purpose, df.purpose AS dst_purpose
       FROM wm_edges e
       JOIN wm_symbols s ON s.id = e.src_id
       JOIN wm_symbols d ON d.id = e.dst_id
       LEFT JOIN wm_files sf ON sf.repo = s.repo AND sf.path = s.path
       LEFT JOIN wm_files df ON df.repo = d.repo AND df.path = d.path
      WHERE s.repo = ? AND d.repo = s.repo AND s.path <> d.path
        AND e.kind IN (${GRAPH_KINDS.map(() => "?").join(", ")})
      GROUP BY s.path, d.path, e.kind
      ORDER BY s.path, d.path, weight DESC, e.kind`,
    target,
    ...GRAPH_KINDS
  );
  const index = /* @__PURE__ */ new Map();
  const files = [];
  const fileOf = (path, purpose) => {
    let i = index.get(path);
    if (i === void 0) {
      i = files.length;
      index.set(path, i);
      files.push({ path, purpose: summaryLine(purpose) ?? "" });
    }
    return i;
  };
  const pairs = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const src = fileOf(String(r["src"]), r["src_purpose"]);
    const dst = fileOf(String(r["dst"]), r["dst_purpose"]);
    const kind = String(r["kind"]);
    const weight = Number(r["weight"]);
    const pair = pairs.get(`${src}>${dst}`);
    if (!pair) pairs.set(`${src}>${dst}`, { src, dst, kind, weight, top: weight });
    else {
      pair.weight += weight;
      if (weight > pair.top) {
        pair.kind = kind;
        pair.top = weight;
      }
    }
  }
  const edges = [...pairs.values()].map(({ src, dst, kind, weight }) => ({ src, dst, kind, weight }));
  return { available: true, repo: target, repos, files, edges };
}
function ftsPhrase(raw) {
  return `"${raw.replace(/"/g, '""')}"`;
}
function worldModelSearch(db, query, limit) {
  if (!worldModelAvailable(db)) return { available: false, hits: [] };
  if (query.trim() === "") return { available: true, hits: [] };
  const phrase = ftsPhrase(query.trim());
  const hits = all(
    db,
    `SELECT kind, repo, path, text, rank FROM (
       SELECT 'directory' AS kind, d.repo AS repo, d.path AS path, d.summary AS text,
              bm25(wm_directories_fts) AS rank
         FROM wm_directories_fts JOIN wm_directories d ON d.id = wm_directories_fts.rowid
        WHERE wm_directories_fts MATCH ?
       UNION ALL
       SELECT 'file', f.repo, f.path, f.purpose, bm25(wm_files_fts)
         FROM wm_files_fts JOIN wm_files f ON f.id = wm_files_fts.rowid
        WHERE wm_files_fts MATCH ?
     )
     ORDER BY rank, path
     LIMIT ?`,
    phrase,
    phrase,
    limit
  );
  return { available: true, hits: hits.map((h) => ({ ...h, text: summaryLine(h["text"]) })) };
}
var INSIGHT_RANGES = { "7d": 7, "30d": 30, "90d": 90, all: null };
var INSIGHT_AGENTS = ["swe", "code-reviewer", "bro"];
var isRange = (v) => Object.hasOwn(INSIGHT_RANGES, v);
var isAgent = (v) => INSIGHT_AGENTS.includes(v);
function insightFilter(p) {
  const range = p.get("range") || "30d";
  if (!isRange(range)) return { error: `range must be one of ${Object.keys(INSIGHT_RANGES).join(", ")}` };
  const agent = p.get("agent") || null;
  if (agent !== null && !isAgent(agent)) return { error: `agent must be one of ${INSIGHT_AGENTS.join(", ")}` };
  return { range, agent, repo: p.get("repo") || null, model: p.get("model") || null, effort: p.get("effort") || null };
}
var EARLY_DATA_MIN = 20;
var HISTOGRAM_BUCKETS = 10;
var TOP_N = 10;
function nearestRank(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
}
function metric(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const early = n < EARLY_DATA_MIN;
  return {
    p50: early ? null : nearestRank(sorted, 0.5),
    p95: early ? null : nearestRank(sorted, 0.95),
    max: n === 0 ? null : sorted[n - 1],
    avg: n === 0 ? null : sorted.reduce((s, v) => s + v, 0) / n
  };
}
function logEdges(domain) {
  if (domain.length === 0) return [];
  const lo = Math.max(1, Math.min(...domain));
  const hi = Math.max(lo, ...domain);
  if (hi === lo) return [lo, lo];
  const step = Math.log(hi / lo) / HISTOGRAM_BUCKETS;
  const edges = Array.from({ length: HISTOGRAM_BUCKETS + 1 }, (_, i) => Math.round(lo * Math.exp(step * i)));
  edges[0] = lo;
  edges[HISTOGRAM_BUCKETS] = hi;
  return edges.filter((e, i) => i === 0 || e > edges[i - 1]);
}
function histogram(values, edges) {
  if (edges.length < 2) return [];
  const buckets = edges.slice(0, -1).map((from, i) => ({ from, to: edges[i + 1], count: 0 }));
  for (const v of values) {
    const i = buckets.findIndex((b) => v < b.to);
    buckets[i === -1 ? buckets.length - 1 : i].count += 1;
  }
  return buckets;
}
var AGENT_OF_RUN = `CASE
    WHEN r.agent_type = 'swe' THEN 'swe'
    WHEN r.agent_type = 'code-reviewer' THEN 'code-reviewer'
    WHEN r.agent_type = 'bro' AND r.task_id IS NULL THEN 'bro'
  END`;
var DAY_MS = 864e5;
var sinceOf = (range, now2) => {
  const days = INSIGHT_RANGES[range];
  return days === null ? null : new Date(now2.getTime() - days * DAY_MS).toISOString();
};
var VERSION_PERIODS_ERROR = "version periods are not supported yet";
var PREV_RANGES = { prev7d: 7, prev30d: 30, prev90d: 90 };
var utcDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = /* @__PURE__ */ new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
};
var taskBound = (s) => {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
};
function parseSlice(s, now2) {
  const slice = (kind, since, until, from_task = null, to_task = null) => ({ key: s, kind, since, until, from_task, to_task });
  if (isRange(s)) return slice("range", sinceOf(s, now2), now2.toISOString());
  if (Object.hasOwn(PREV_RANGES, s)) {
    const days = PREV_RANGES[s];
    return slice("prev", new Date(now2.getTime() - 2 * days * DAY_MS).toISOString(), new Date(now2.getTime() - days * DAY_MS).toISOString());
  }
  if (s.startsWith("ver:")) return { error: VERSION_PERIODS_ERROR };
  const dates = /^dates:([^.]*)\.\.([^.]*)$/.exec(s);
  if (dates) {
    const [, a = "", b = ""] = dates;
    const from = a === "" ? null : utcDay(a);
    const to = b === "" ? null : utcDay(b);
    if (a !== "" && from === null || b !== "" && to === null) return { error: `${s}: dates must be real YYYY-MM-DD days` };
    if (from && to && from.getTime() > to.getTime()) return { error: `${s}: the start date is after the end date` };
    return slice("dates", from?.toISOString() ?? null, to ? new Date(to.getTime() + DAY_MS).toISOString() : null);
  }
  const tasks2 = /^tasks:([^-]*)-([^-]*)$/.exec(s);
  if (tasks2) {
    const [, a = "", b = ""] = tasks2;
    const from = a === "" ? 1 : taskBound(a);
    const to = b === "" ? null : taskBound(b);
    if (from === null || b !== "" && to === null) return { error: `${s}: task ids must be integers of at least 1` };
    if (to !== null && from > to) return { error: `${s}: the start task is after the end task` };
    return slice("tasks", null, null, from, to);
  }
  return { error: `${s || "an empty string"} is not a period` };
}
var periodOf = (s) => ({
  since: s.since,
  before: s.kind === "range" ? null : s.until,
  fromTask: s.from_task,
  toTask: s.to_task
});
function periodWhere(p, time, task) {
  return {
    sql: `(? IS NULL OR ${time} >= ?) AND (? IS NULL OR ${time} < ?) AND (? IS NULL OR ${task} >= ?) AND (? IS NULL OR ${task} <= ?)`,
    args: [p.since, p.since, p.before, p.before, p.fromTask, p.fromTask, p.toTask, p.toTask]
  };
}
var context = (r) => r.tokens_in + r.cache_read + r.cache_creation;
var cacheHit = (r) => context(r) > 0 ? r.cache_read / context(r) : 0;
var HISTOGRAM_METRICS = ["tokens_out", "context", "cache_hit", "tool_uses"];
var HISTOGRAM_VALUE = {
  tokens_out: (r) => r.tokens_out,
  context,
  cache_hit: cacheHit,
  tool_uses: (r) => r.tool_uses
};
var CACHE_HIT_EDGES = Array.from({ length: HISTOGRAM_BUCKETS + 1 }, (_, i) => i / HISTOGRAM_BUCKETS);
function edgesOf(measured) {
  const log = (m) => logEdges(measured.map(HISTOGRAM_VALUE[m]));
  return { tokens_out: log("tokens_out"), context: log("context"), cache_hit: [...CACHE_HIT_EDGES], tool_uses: log("tool_uses") };
}
function agentStats(runs, agent, edges) {
  const all2 = runs.filter((r) => r.agent === agent);
  const measured = all2.filter((r) => r.measured === 1);
  const contextSum = measured.reduce((s, r) => s + context(r), 0);
  const cacheRead = measured.reduce((s, r) => s + r.cache_read, 0);
  const hit = metric(measured.map(cacheHit));
  return {
    agent,
    per: agent === "bro" ? "session" : "run",
    n: measured.length,
    total: all2.length,
    tokens_out: metric(measured.map((r) => r.tokens_out)),
    context: metric(measured.map(context)),
    cache_hit: { ...hit, avg: contextSum > 0 ? cacheRead / contextSum : null },
    duration_ms: metric(measured.map((r) => r.duration_ms)),
    tool_uses: metric(measured.map((r) => r.tool_uses)),
    histograms: Object.fromEntries(HISTOGRAM_METRICS.map((m) => [m, histogram(measured.map(HISTOGRAM_VALUE[m]), edges[m])]))
  };
}
function priceOf(prices, r) {
  const price = r.model === null ? void 0 : prices.get(r.model);
  if (!price) return null;
  return (r.tokens_in * price.input + r.tokens_out * price.output + r.cache_read * price.cache_read + r.cache_creation * price.cache_creation) / 1e6;
}
var PRICE_FIELDS = ["input", "output", "cache_read", "cache_creation"];
function modelPrices(db) {
  const prices = /* @__PURE__ */ new Map();
  const row2 = one(db, `SELECT value_json FROM plugin_config WHERE key = 'model_prices'`);
  if (!row2) return prices;
  let parsed;
  try {
    parsed = JSON.parse(String(row2["value_json"]));
  } catch {
    return prices;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return prices;
  for (const [model, entry] of Object.entries(parsed)) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry;
    if (PRICE_FIELDS.every((f) => typeof e[f] === "number" && Number.isFinite(e[f]))) {
      prices.set(model, { input: e["input"], output: e["output"], cache_read: e["cache_read"], cache_creation: e["cache_creation"] });
    }
  }
  return prices;
}
function costOf(db, runs) {
  const prices = modelPrices(db);
  const measured = runs.filter((r) => r.measured === 1);
  if (prices.size === 0) return { priced: false, by_agent: [], by_model: [], unpriced_runs: measured.length };
  const byAgent = /* @__PURE__ */ new Map();
  const byModel = /* @__PURE__ */ new Map();
  let unpriced = 0;
  for (const r of measured) {
    const usd = priceOf(prices, r);
    if (usd === null) {
      unpriced += 1;
      continue;
    }
    for (const [map, key] of [[byAgent, r.agent], [byModel, r.model]]) {
      const g = map.get(key) ?? { usd: 0, runs: 0 };
      g.usd += usd;
      g.runs += 1;
      map.set(key, g);
    }
  }
  const list = (map, key) => [...map].map(([k, g]) => ({ [key]: k, usd: Math.round(g.usd * 1e4) / 1e4, runs: g.runs })).sort((a, b) => b.usd - a.usd);
  return { priced: true, by_agent: list(byAgent, "agent"), by_model: list(byModel, "model"), unpriced_runs: unpriced };
}
var wrapsWhole = (s) => {
  if (!s.startsWith("(") || !s.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth += 1;
    else if (s[i] === ")") depth -= 1;
    if (depth === 0 && i < s.length - 1) return false;
  }
  return depth === 0;
};
function normalizeCommand(command) {
  let s = command.trim();
  while (wrapsWhole(s)) s = s.slice(1, -1).trim();
  return s.replace(/\s+/g, " ");
}
function bySlowest(a, b) {
  const ranked = (c) => c.n >= EARLY_DATA_MIN;
  if (ranked(a) !== ranked(b)) return ranked(a) ? -1 : 1;
  const key = (c) => (ranked(c) ? c.p95 : c.max) ?? 0;
  return key(b) - key(a) || a.command.localeCompare(b.command);
}
function qualityOf(db, f, p) {
  const taskWhere = `(? IS NULL OR t.repo = ?) AND (? IS NULL OR t.effort = ?)`;
  const taskArgs = [f.repo, f.repo, f.effort, f.effort];
  const attemptIn = periodWhere(p, "v.created_at", "v.task_id");
  const runIn = periodWhere(p, "r.started_at", "r.task_id");
  const attempts = all(
    db,
    `SELECT v.task_id, v.attempt_n, v.verdict FROM validation_attempts v JOIN tasks t ON t.id = v.task_id
      WHERE ${attemptIn.sql} AND ${taskWhere}
      ORDER BY v.task_id, v.attempt_n, v.id`,
    ...attemptIn.args,
    ...taskArgs
  );
  const verdicts = { pass: 0, fail: 0, escalate: 0 };
  const perTask = /* @__PURE__ */ new Map();
  for (const a of attempts) {
    const verdict = String(a["verdict"]);
    if (verdict in verdicts) verdicts[verdict] += 1;
    const id = Number(a["task_id"]);
    const t = perTask.get(id);
    if (t) t.count += 1;
    else perTask.set(id, { first: verdict, count: 1 });
  }
  const attemptCounts = /* @__PURE__ */ new Map();
  for (const t of perTask.values()) attemptCounts.set(t.count, (attemptCounts.get(t.count) ?? 0) + 1);
  const verification = one(
    db,
    `SELECT COUNT(*) AS total, COALESCE(SUM(r.exit_code = 0), 0) AS passed
       FROM verification_runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.exit_code IS NOT NULL AND ${runIn.sql} AND ${taskWhere}`,
    ...runIn.args,
    ...taskArgs
  );
  const commands = /* @__PURE__ */ new Map();
  for (const c of all(
    db,
    `SELECT c.command, c.elapsed_s FROM verification_run_commands c
       JOIN verification_runs r ON r.id = c.run_id JOIN tasks t ON t.id = r.task_id
      WHERE c.elapsed_s IS NOT NULL AND ${runIn.sql} AND ${taskWhere}`,
    ...runIn.args,
    ...taskArgs
  )) {
    const command = normalizeCommand(String(c["command"]));
    const list = commands.get(command) ?? [];
    list.push(Number(c["elapsed_s"]));
    commands.set(command, list);
  }
  const slowest = [...commands].map(([command, values]) => ({ command, n: values.length, ...metric(values) })).sort(bySlowest).slice(0, TOP_N);
  return {
    first_pass: { passed: [...perTask.values()].filter((t) => t.first === "pass").length, total: perTask.size },
    attempts: [...attemptCounts].sort((a, b) => a[0] - b[0]).map(([attempts2, tasks2]) => ({ attempts: attempts2, tasks: tasks2 })),
    verdicts,
    verification: { passed: Number(verification?.["passed"] ?? 0), total: Number(verification?.["total"] ?? 0) },
    slowest_commands: slowest
  };
}
function throughputOf(db, f, p) {
  const closedIn = periodWhere(p, "COALESCE(t.completed_at, t.updated_at)", "t.id");
  return all(
    db,
    `SELECT substr(COALESCE(t.completed_at, t.updated_at), 1, 10) AS day, COUNT(*) AS closed
       FROM tasks t
      WHERE t.status = 'closed' AND ${closedIn.sql}
        AND (? IS NULL OR t.repo = ?) AND (? IS NULL OR t.effort = ?)
      GROUP BY day ORDER BY day`,
    ...closedIn.args,
    f.repo,
    f.repo,
    f.effort,
    f.effort
  ).map((r) => ({ day: String(r["day"]), closed: Number(r["closed"]) }));
}
var IDLE_MIN_MS = 30 * 6e4;
var IDLE_TOOL_USES_PER_MIN = 1;
var IDLE_TOKENS_OUT_PER_MIN = 500;
function likelyIdle(r) {
  if (!(r.duration_ms >= IDLE_MIN_MS)) return false;
  const minutes = r.duration_ms / 6e4;
  return r.tool_uses / minutes < IDLE_TOOL_USES_PER_MIN && r.tokens_out / minutes < IDLE_TOKENS_OUT_PER_MIN;
}
function outliersOf(runs) {
  const perRun = runs.filter((r) => r.measured === 1 && r.agent !== "bro");
  const row2 = (r, value) => ({ run_id: r.id, agent: r.agent, task_id: r.task_id, task_title: r.task_title, value });
  const byValue2 = (a, b) => b.value - a.value || a.run_id - b.run_id;
  const top = (value) => perRun.map((r) => row2(r, value(r))).sort(byValue2).slice(0, TOP_N);
  const durations = perRun.map((r) => ({ ...row2(r, r.duration_ms), tool_uses: r.tool_uses, tokens_out: r.tokens_out, idle: likelyIdle(r) })).sort(byValue2);
  const duration_ms = [...durations.filter((r) => !r.idle).slice(0, TOP_N), ...durations.filter((r) => r.idle).slice(0, TOP_N)];
  return { tokens_out: top((r) => r.tokens_out), context: top(context), duration_ms };
}
function insightRows(db, f, p) {
  const runIn = periodWhere(p, "COALESCE(r.started_at, r.completed_at)", "r.task_id");
  return all(
    db,
    `SELECT * FROM (
       SELECT r.id, ${AGENT_OF_RUN} AS agent, r.task_id, t.title AS task_title, r.model,
              (r.usage_source IS NOT NULL AND r.usage_source <> 'unmeasured') AS measured,
              COALESCE(r.tokens_in, 0) AS tokens_in, COALESCE(r.tokens_out, 0) AS tokens_out,
              COALESCE(r.cache_read_tokens, 0) AS cache_read, COALESCE(r.cache_creation_tokens, 0) AS cache_creation,
              r.duration_ms, r.tool_uses
         FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id
        WHERE ${runIn.sql}
          AND (? IS NULL OR r.repo = ?) AND (? IS NULL OR r.model = ?) AND (? IS NULL OR r.effort = ?)
     ) WHERE agent IS NOT NULL AND (? IS NULL OR agent = ?)
     ORDER BY id`,
    ...runIn.args,
    f.repo,
    f.repo,
    f.model,
    f.model,
    f.effort,
    f.effort,
    f.agent,
    f.agent
  );
}
var agentEdgesOf = (rows) => ({
  shared: edgesOf(rows.filter((r) => r.measured === 1 && r.agent !== "bro")),
  bro: edgesOf(rows.filter((r) => r.measured === 1 && r.agent === "bro"))
});
function insightsBody(db, f, p, rows, edges, range) {
  const names = (sql) => all(db, sql).map((r) => String(r["v"]));
  const maxTask = one(db, `SELECT MAX(task_id) AS v FROM agent_runs WHERE (? IS NULL OR repo = ?)`, f.repo, f.repo)?.["v"];
  return {
    range,
    filters: { repo: f.repo, agent: f.agent, model: f.model, effort: f.effort },
    options: {
      repos: names(`SELECT DISTINCT repo AS v FROM agent_runs WHERE repo IS NOT NULL ORDER BY repo`),
      models: names(`SELECT DISTINCT model AS v FROM agent_runs WHERE model IS NOT NULL ORDER BY model`),
      max_task_id: maxTask === null || maxTask === void 0 ? null : Number(maxTask)
    },
    agents: INSIGHT_AGENTS.map((a) => agentStats(rows, a, a === "bro" ? edges.bro : edges.shared)),
    cost: costOf(db, rows),
    quality: qualityOf(db, f, p),
    throughput: throughputOf(db, f, p),
    outliers: outliersOf(rows)
  };
}
function insights(db, f, now2 = /* @__PURE__ */ new Date()) {
  const since = sinceOf(f.range, now2);
  const period = { since, before: null, fromTask: null, toTask: null };
  const rows = insightRows(db, f, period);
  return insightsBody(db, f, period, rows, agentEdgesOf(rows), { key: f.range, since, until: now2.toISOString() });
}
var usd4 = (usd) => Math.round(usd * 1e4) / 1e4;
function perTaskOf(prices, rows) {
  const runs = rows.filter((r) => r.measured === 1 && r.agent !== "bro" && r.task_id !== null);
  const tasks2 = new Set(runs.map((r) => r.task_id)).size;
  const sum2 = (v) => runs.reduce((s, r) => s + v(r), 0);
  const contextSum = sum2(context);
  let usd = 0;
  let unpriced = 0;
  for (const r of runs) {
    const price = priceOf(prices, r);
    if (price === null) unpriced += 1;
    else usd += price;
  }
  const perTask = (total) => tasks2 === 0 ? null : total / tasks2;
  return {
    tasks: tasks2,
    runs: runs.length,
    tokens_out: perTask(sum2((r) => r.tokens_out)),
    context: perTask(contextSum),
    cache_hit: tasks2 === 0 || contextSum === 0 ? null : sum2((r) => r.cache_read) / contextSum,
    cost_usd: tasks2 === 0 || prices.size === 0 ? null : usd4(usd / tasks2),
    unpriced_runs: unpriced
  };
}
var PERIOD_HINT = "must be a period like 30d, prev30d, dates:2026-10-01..2026-10-15 or tasks:100-200";
function compareQuery(p, now2 = /* @__PURE__ */ new Date()) {
  const slices = [];
  for (const key of ["p1", "p2"]) {
    const raw = p.get(key);
    const s = raw === null ? { error: "" } : parseSlice(raw, now2);
    if ("error" in s) return { error: s.error === VERSION_PERIODS_ERROR ? `${key}: ${VERSION_PERIODS_ERROR}` : `${key} ${PERIOD_HINT}` };
    slices.push(s);
  }
  const rest = new URLSearchParams(p);
  rest.delete("range");
  const filter = insightFilter(rest);
  return "error" in filter ? filter : { filter, p1: slices[0], p2: slices[1] };
}
function compare(db, f, s1, s2) {
  const broExcluded = s1.kind === "tasks" || s2.kind === "tasks";
  const rowsOf = (s) => {
    const rows = insightRows(db, f, periodOf(s));
    return broExcluded ? rows.filter((r) => r.agent !== "bro") : rows;
  };
  const r1 = rowsOf(s1);
  const r2 = rowsOf(s2);
  const union = /* @__PURE__ */ new Map();
  for (const r of [...r1, ...r2]) union.set(r.id, r);
  const edges = agentEdgesOf([...union.values()]);
  const ids1 = new Set(r1.map((r) => r.id));
  const prices = modelPrices(db);
  const body = (s, rows) => ({
    ...insightsBody(db, f, periodOf(s), rows, edges, { key: s.key, since: s.since, until: s.until }),
    slice: s,
    per_task: perTaskOf(prices, rows)
  });
  const p1 = body(s1, r1);
  return { p1, p2: body(s2, r2), shared_runs: r2.filter((r) => ids1.has(r.id)).length, bro_excluded: broExcluded, options: p1["options"] };
}
var EXPLORE_MEASURES = ["tokens_out", "context", "cache_hit", "cost", "duration_ms", "tool_uses"];
var EXPLORE_AGGS = ["avg", "p50", "p95", "max", "sum", "count"];
var EXPLORE_DIMS = [
  "agent",
  "model",
  "effort",
  "repo",
  "exit_reason",
  "usage_source",
  "resumed",
  "prompt_bearing",
  "task_status",
  "day",
  "week",
  "review_round",
  "plugin_version"
];
var TOKEN_MEASURES = /* @__PURE__ */ new Set(["tokens_out", "context", "cache_hit", "cost"]);
var ONE_DIM_MAX = 10;
var PANELS_NAMED = 3;
var PANEL_BARS_NAMED = 6;
var OTHER = "Other";
var NOT_A_REVIEW = "Not a review";
var NO_TASK = "No task";
var UNKNOWN_VERSION = "unknown";
var estimatedVersion = (version) => `\u2248 v${version} (by date)`;
var oneOf = (list, v) => list.includes(v);
function exploreQuery(p) {
  const measure = p.get("m") || "tokens_out";
  if (!oneOf(EXPLORE_MEASURES, measure)) return { error: `m must be one of ${EXPLORE_MEASURES.join(", ")}` };
  const agg = p.get("a") || "p50";
  if (!oneOf(EXPLORE_AGGS, agg)) return { error: `a must be one of ${EXPLORE_AGGS.join(", ")}` };
  const dims = (p.get("g") || "agent").split(",");
  if (dims.length > 2) return { error: "g takes at most two dimensions" };
  for (const d of dims) if (!oneOf(EXPLORE_DIMS, d)) return { error: `g must be one or two of ${EXPLORE_DIMS.join(", ")}` };
  if (new Set(dims).size !== dims.length) return { error: "g names the same dimension twice" };
  if (measure === "cache_hit" && agg !== "avg") return { error: "cache_hit is a ratio of sums: a must be avg" };
  return { measure, agg, dims };
}
var columnsOf = (db, table) => new Set(all(db, `PRAGMA table_info(${table})`).map((c) => String(c["name"])));
function exploreRows(db, f, p) {
  const cols = columnsOf(db, "agent_runs");
  const version = cols.has("plugin_version") ? "r.plugin_version" : "NULL";
  const resumed = cols.has("resumed_from") ? "r.resumed_from IS NOT NULL" : "0";
  const runIn = periodWhere(p, "COALESCE(r.started_at, r.completed_at)", "r.task_id");
  return all(
    db,
    `WITH rounds AS (
       SELECT id, row_number() OVER (PARTITION BY task_id ORDER BY started_at, id) AS round
         FROM agent_runs WHERE agent_type = 'code-reviewer' AND task_id IS NOT NULL
     )
     SELECT * FROM (
       SELECT r.id, ${AGENT_OF_RUN} AS agent, r.task_id, t.title AS task_title, r.model, r.effort, r.repo,
              r.exit_reason, r.usage_source, ${resumed} AS resumed, t.prompt_bearing, t.status AS task_status,
              COALESCE(r.started_at, r.completed_at) AS at, ${version} AS plugin_version, w.round,
              (r.usage_source IS NOT NULL AND r.usage_source <> 'unmeasured') AS measured,
              COALESCE(r.tokens_in, 0) AS tokens_in, COALESCE(r.tokens_out, 0) AS tokens_out,
              COALESCE(r.cache_read_tokens, 0) AS cache_read, COALESCE(r.cache_creation_tokens, 0) AS cache_creation,
              r.duration_ms, r.tool_uses
         FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN rounds w ON w.id = r.id
        WHERE ${runIn.sql}
          AND (? IS NULL OR r.repo = ?) AND (? IS NULL OR r.model = ?) AND (? IS NULL OR r.effort = ?)
     ) WHERE agent IS NOT NULL AND (? IS NULL OR agent = ?)
     ORDER BY id`,
    ...runIn.args,
    f.repo,
    f.repo,
    f.model,
    f.model,
    f.effort,
    f.effort,
    f.agent,
    f.agent
  );
}
function mondayOf(at) {
  const t = at ? Date.parse(`${at.slice(0, 10)}T00:00:00Z`) : NaN;
  if (Number.isNaN(t)) return UNKNOWN_VERSION;
  const back = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - back * 864e5).toISOString().slice(0, 10);
}
function labelOf(dim, r, releases) {
  switch (dim) {
    case "agent":
      return r.agent;
    case "model":
      return r.model ?? "none";
    case "effort":
      return r.effort ?? "none";
    case "repo":
      return r.repo ?? "none";
    case "exit_reason":
      return r.exit_reason ?? "open";
    case "usage_source":
      return r.usage_source ?? "none";
    case "resumed":
      return r.resumed ? "resumed" : "fresh";
    case "prompt_bearing":
      return r.prompt_bearing === null ? NO_TASK : r.prompt_bearing ? "prompt-bearing" : "not prompt-bearing";
    case "task_status":
      return r.task_status ?? NO_TASK;
    case "day":
      return r.at?.slice(0, 10) ?? UNKNOWN_VERSION;
    case "week":
      return mondayOf(r.at);
    case "review_round":
      return r.round === null ? NOT_A_REVIEW : r.round >= 3 ? "3+" : String(r.round);
    case "plugin_version": {
      if (r.plugin_version !== null) return r.plugin_version;
      const release = releaseAt(releases, r.at);
      return release ? estimatedVersion(release.version) : UNKNOWN_VERSION;
    }
  }
}
function measureOf(measure, prices) {
  switch (measure) {
    case "tokens_out":
      return (r) => r.tokens_out;
    case "context":
    case "cache_hit":
      return context;
    case "cost":
      return (r) => priceOf(prices, r);
    case "duration_ms":
      return (r) => r.duration_ms;
    case "tool_uses":
      return (r) => r.tool_uses;
  }
}
function aggregate(runs, q, value) {
  if (q.measure === "cache_hit") {
    const ctx = runs.reduce((s, r) => s + context(r), 0);
    return ctx > 0 ? runs.reduce((s, r) => s + r.cache_read, 0) / ctx : null;
  }
  const values = runs.map((r) => value(r));
  if (q.agg === "count") return values.length;
  if (q.agg === "sum") return values.reduce((s, v) => s + v, 0);
  return metric(values)[q.agg];
}
var byValue = (a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || b.n - a.n || a.key.localeCompare(b.key);
function binsOf(runs, label, keep, named, total) {
  const byKey = /* @__PURE__ */ new Map();
  for (const r of runs) {
    const key = label(r);
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  const bins = [...byKey].map(([key, list]) => ({ key, runs: list, n: list.length, value: total(list) })).sort(byValue);
  if (bins.length <= keep) return bins;
  const rest = bins.slice(named).flatMap((b) => b.runs);
  return [...bins.slice(0, named), { key: OTHER, runs: rest, n: rest.length, value: total(rest) }];
}
function reviewRoundMismatch(db, taskIds) {
  if (taskIds.size === 0) return 0;
  return all(
    db,
    `SELECT c.task_id, c.runs, (SELECT MAX(v.attempt_n) FROM validation_attempts v WHERE v.task_id = c.task_id) AS attempts
       FROM (SELECT task_id, COUNT(*) AS runs FROM agent_runs
              WHERE agent_type = 'code-reviewer' AND task_id IS NOT NULL GROUP BY task_id) c`
  ).filter((t) => taskIds.has(Number(t["task_id"])) && Number(t["runs"]) !== Number(t["attempts"] ?? 0)).length;
}
function explorePivot(db, p) {
  const q = exploreQuery(p);
  if ("error" in q) return q;
  const prices = modelPrices(db);
  if (q.measure === "cost" && prices.size === 0) return { error: "cost needs model prices; none are set" };
  const value = measureOf(q.measure, prices);
  return {
    q,
    priced: prices.size > 0,
    counted: (r) => (!TOKEN_MEASURES.has(q.measure) || r.measured === 1) && value(r) !== null,
    total: (runs) => aggregate(runs, q, value)
  };
}
function exploreGroups(runs, pivot, releases) {
  const label = (dim) => (r) => labelOf(dim, r, releases);
  const [first, second] = pivot.q.dims;
  return second === void 0 ? binsOf(runs, label(first), ONE_DIM_MAX, ONE_DIM_MAX - 1, pivot.total).map((b) => ({ ...b, key: [b.key] })) : binsOf(runs, label(first), PANELS_NAMED, PANELS_NAMED, pivot.total).flatMap(
    (panel) => binsOf(panel.runs, label(second), PANEL_BARS_NAMED, PANEL_BARS_NAMED, pivot.total).map((b) => ({ ...b, key: [panel.key, b.key] }))
  );
}
var exploreOptions = (priced) => ({ measures: EXPLORE_MEASURES, aggs: EXPLORE_AGGS, dims: EXPLORE_DIMS, priced });
function explore(db, f, p, releases = [], now2 = /* @__PURE__ */ new Date()) {
  const pivot = explorePivot(db, p);
  if ("error" in pivot) return pivot;
  const { q } = pivot;
  const rows = exploreRows(db, f, { since: sinceOf(f.range, now2), before: null, fromTask: null, toTask: null });
  const groups = exploreGroups(rows.filter(pivot.counted), pivot, releases).map((g) => ({ key: g.key, n: g.n, value: g.value }));
  const reviewed = new Set(rows.filter((r) => r.agent === "code-reviewer" && r.task_id !== null).map((r) => r.task_id));
  const earliest = rows.reduce((min, r) => r.at !== null && (min === null || r.at < min) ? r.at : min, null);
  const rangeDays = INSIGHT_RANGES[f.range];
  return {
    measure: q.measure,
    agg: q.agg,
    dims: q.dims,
    groups,
    review_round_mismatch: reviewRoundMismatch(db, reviewed),
    days: rangeDays ?? (earliest === null ? 0 : Math.max(1, Math.ceil((now2.getTime() - Date.parse(earliest)) / 864e5))),
    options: exploreOptions(pivot.priced)
  };
}
function exploreCompare(db, f, s1, s2, p, releases = []) {
  const pivot = explorePivot(db, p);
  if ("error" in pivot) return pivot;
  const broExcluded = s1.kind === "tasks" || s2.kind === "tasks";
  const runsOf = (s) => exploreRows(db, f, periodOf(s)).filter((r) => (!broExcluded || r.agent !== "bro") && pivot.counted(r));
  const r1 = runsOf(s1);
  const r2 = runsOf(s2);
  const union = /* @__PURE__ */ new Map();
  for (const r of [...r1, ...r2]) union.set(r.id, r);
  const ids1 = new Set(r1.map((r) => r.id));
  const ids2 = new Set(r2.map((r) => r.id));
  const side = (runs, ids) => {
    const mine = runs.filter((r) => ids.has(r.id));
    return { n: mine.length, value: mine.length === 0 ? null : pivot.total(mine) };
  };
  const groups = exploreGroups([...union.values()], pivot, releases).map((g) => ({ key: g.key, p1: side(g.runs, ids1), p2: side(g.runs, ids2) }));
  return { measure: pivot.q.measure, agg: pivot.q.agg, dims: pivot.q.dims, groups, bro_excluded: broExcluded, options: exploreOptions(pivot.priced) };
}

// server/concepts.ts
var CONCEPTS_SCHEMA_VERSION = 45;
var CONCEPT_TABLES = ["wm_concepts", "wm_concept_steps", "wm_concepts_fts", "wm_symbols", "wm_symbols_fts", "wm_edges"];
var MIN_QUERY_LENGTH = 2;
var MAX_STEPS = 50;
var GRAPH_EDGES = ["calls", "sources", "runs", "imports"];
var LIMITS = {
  search: { fallback: 20, max: 50 },
  graph: { fallback: 60, max: 120 },
  neighbourhood: { fallback: 40, max: 100 }
};
function readOnly(db) {
  const params = (p) => p ?? [];
  const reader = {
    get: (sql, p) => db.prepare(sql).get(...params(p)),
    all: (sql, p) => db.prepare(sql).all(...params(p))
  };
  return reader;
}
function conceptsAvailable(db) {
  if ((schemaVersion(db) ?? 0) < CONCEPTS_SCHEMA_VERSION) return false;
  const row2 = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?))`).get(JSON.stringify(CONCEPT_TABLES));
  return Number(row2?.n ?? 0) === CONCEPT_TABLES.length;
}
function clamp(raw, { fallback, max }) {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), max) : fallback;
}
var dirOf = (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
var baseOf = (path) => path.slice(path.lastIndexOf("/") + 1);
function symbolNode(s, stepOrdinal) {
  return {
    id: Number(s.id),
    label: s.kind === "module" ? baseOf(s.path) : s.qualified_name,
    repo: s.repo,
    path: s.path,
    dir: dirOf(s.path),
    kind: s.kind,
    line_start: s.start_line === null ? null : Number(s.start_line),
    step_ordinal: stepOrdinal
  };
}
function fileNode(a, stepOrdinal) {
  return {
    id: `file:${a.repo}:${a.path}`,
    label: baseOf(a.path),
    repo: a.repo,
    path: a.path,
    dir: dirOf(a.path),
    kind: "file",
    line_start: null,
    step_ordinal: stepOrdinal
  };
}
function symbolLite(db, id) {
  const row2 = db.prepare(`SELECT id, repo, path, kind, qualified_name, start_line FROM wm_symbols WHERE id = ?`).get(id);
  return row2 ?? null;
}
function neighbourIds(db, id) {
  const rows = db.prepare(
    `SELECT CASE WHEN e.src_id = ? THEN e.dst_id ELSE e.src_id END AS other
         FROM wm_edges e
        WHERE (e.src_id = ? OR e.dst_id = ?) AND e.dst_id IS NOT NULL AND e.resolution = 'exact'
          AND e.kind IN (SELECT value FROM json_each(?))
        ORDER BY e.line, e.rowid`
  ).all(id, id, id, JSON.stringify(GRAPH_EDGES));
  return [...new Set(rows.map((r) => Number(r.other)).filter((o) => o !== id))];
}
function edgesAmong(db, ids) {
  if (ids.length === 0) return [];
  const set = JSON.stringify(ids);
  const rows = db.prepare(
    `SELECT DISTINCT e.src_id AS src, e.dst_id AS dst, e.kind
         FROM wm_edges e
        WHERE e.resolution = 'exact' AND e.src_id <> e.dst_id
          AND e.kind IN (SELECT value FROM json_each(?))
          AND e.src_id IN (SELECT value FROM json_each(?))
          AND e.dst_id IN (SELECT value FROM json_each(?))
        ORDER BY e.src_id, e.dst_id, e.kind`
  ).all(JSON.stringify(GRAPH_EDGES), set, set);
  return rows.map((r) => ({ src: Number(r.src), dst: Number(r.dst), kind: r.kind }));
}
function buildGraph(db, centres, limit) {
  const nodes = /* @__PURE__ */ new Map();
  for (const c of centres) if (!nodes.has(c.id)) nodes.set(c.id, c);
  let truncated = false;
  for (const c of centres) {
    if (typeof c.id !== "number") continue;
    for (const other of neighbourIds(db, c.id)) {
      if (nodes.has(other)) continue;
      const s = symbolLite(db, other);
      if (!s || outsideConceptLane(s.path)) continue;
      if (nodes.size >= limit) {
        truncated = true;
        break;
      }
      nodes.set(other, symbolNode(s, null));
    }
  }
  const ids = [...nodes.keys()].filter((k) => typeof k === "number");
  return { nodes: [...nodes.values()], edges: edgesAmong(db, ids), truncated };
}
function conceptGraph(db, id, limit) {
  const concept = getConcept(readOnly(db), id);
  if (!concept) return { status: 404, body: { error: "concept not found" } };
  const centres = [];
  for (const step of concept.steps.slice(0, MAX_STEPS)) {
    const anchor = step.symbol;
    if (!anchor) continue;
    if (anchor.id === null || anchor.kind === "file") {
      centres.push(fileNode(anchor, step.ordinal));
      continue;
    }
    if (centres.some((c) => c.id === anchor.id)) continue;
    const s = symbolLite(db, anchor.id);
    if (s) centres.push(symbolNode(s, step.ordinal));
  }
  return { status: 200, body: buildGraph(db, centres, limit) };
}
function neighbourhood(db, id, limit) {
  const s = symbolLite(db, id);
  if (!s) return { status: 404, body: { error: "symbol not found" } };
  return { status: 200, body: buildGraph(db, [symbolNode(s, null)], limit) };
}
function conceptDetail(db, id) {
  const concept = getConcept(readOnly(db), id);
  if (!concept) return { status: 404, body: { error: "concept not found" } };
  return {
    status: 200,
    body: { available: true, ...concept, steps: concept.steps.slice(0, MAX_STEPS), steps_truncated: concept.steps.length > MAX_STEPS }
  };
}
function search(db, params) {
  const repos = db.prepare(`SELECT repo FROM wm_concepts UNION SELECT repo FROM wm_symbols ORDER BY repo`).all().map((r) => r.repo);
  const repo = params.get("repo") || repos[0];
  const q = (params.get("q") ?? "").trim();
  if (repo === void 0 || q.length < MIN_QUERY_LENGTH) {
    return { status: 200, body: { available: true, repos, repo: repo ?? null, concepts: [], derived: null } };
  }
  const trajectory = readOnly(db);
  const concepts = searchConcepts(trajectory, repo, q, clamp(params.get("limit"), LIMITS.search));
  const derived = concepts.length === 0 ? derivedChain(trajectory, repo, q) : null;
  return { status: 200, body: { available: true, repos, repo, concepts, derived } };
}
var positiveId = (raw) => raw !== void 0 && /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
function conceptsApi(db, url) {
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [resource, rawId, sub] = parts;
  if (resource !== "concepts" && resource !== "symbols") return null;
  const notFound = { status: 404, body: { error: "unknown endpoint" } };
  if (resource === "symbols" && (parts.length !== 3 || sub !== "neighbourhood")) return notFound;
  if (resource === "concepts" && (parts.length > 3 || parts.length === 3 && sub !== "graph")) return notFound;
  if (!conceptsAvailable(db)) return { status: 200, body: { available: false, repos: [], concepts: [], derived: null } };
  if (parts.length === 1) return search(db, url.searchParams);
  const id = positiveId(rawId);
  if (id === null) return { status: 404, body: { error: `${resource === "symbols" ? "symbol" : "concept"} not found` } };
  const limit = url.searchParams.get("limit");
  if (resource === "symbols") return neighbourhood(db, id, clamp(limit, LIMITS.neighbourhood));
  return sub === "graph" ? conceptGraph(db, id, clamp(limit, LIMITS.graph)) : conceptDetail(db, id);
}

// server/config.ts
import { isDeepStrictEqual } from "node:util";

// ../mcp/trajectory-server/src/tools/config.ts
function ok2(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
function err2(message2) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message2 }) }],
    isError: true
  };
}
function wrapHandler2(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err2(e.message);
    }
  };
}
var KEY_REGEX = /^[a-z][a-z0-9_.-]{0,63}$/i;
var EFFORT_LEVELS = ["low", "medium", "high"];
var SWE_DEFAULT_EFFORT_KEY = "swe_default_effort";
var REVIEWER_EFFORT_KEY = "reviewer_effort";
var EFFORT_DEFAULTS = {
  [SWE_DEFAULT_EFFORT_KEY]: "medium",
  [REVIEWER_EFFORT_KEY]: "medium"
};
function isEffort(value) {
  return typeof value === "string" && EFFORT_LEVELS.includes(value);
}
var HIGH_EFFORT_PATHS_KEY = "high_effort_paths";
var SWE_EFFORT_AB_KEY = "swe_effort_ab";
function isEffortAbConfig(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { label, target } = value;
  return typeof label === "string" && label.trim().length > 0 && Number.isInteger(target) && target > 0;
}
var REVIEWER_EFFORT_TIERS_KEY = "reviewer_effort_tiers";
var REVIEWER_EFFORT_AB_KEY = "reviewer_effort_ab";
var REVIEWER_TIER_SETTINGS_KEY = "reviewer_tier_settings";
var REVIEWER_TIER_REASONS = ["prompt_bearing", "high_effort_paths", "docs_tests", "default"];
var REVIEWER_MODELS = ["opus", "sonnet", "haiku", "fable"];
function isReviewerModel(value) {
  return typeof value === "string" && REVIEWER_MODELS.includes(value);
}
function isReviewerTierSetting(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([field, v]) => field === "model" && isReviewerModel(v) || field === "effort" && isEffort(v)
  );
}
function isReviewerTierSettings(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([reason, setting]) => REVIEWER_TIER_REASONS.includes(reason) && isReviewerTierSetting(setting)
  );
}
var DOWNSTREAM_CONTEXT_AB_KEY = "downstream_context_ab";
function isDownstreamContextAbConfig(value) {
  if (!isEffortAbConfig(value)) return false;
  const shipped = value["tools_shipped_at"];
  return typeof shipped === "string" && !Number.isNaN(Date.parse(shipped));
}
function isEmptyObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}
var WORKFLOW_MODE_KEY = "workflow_mode";
var WORKFLOW_MODES = ["truest", "agile"];
function isWorkflowMode(value) {
  return typeof value === "string" && WORKFLOW_MODES.includes(value);
}
var WORLD_MODEL_TEST_LANE_KEY = "world_model_test_lane";
var BRO_COMPACT_NUDGE_TOKENS_KEY = "bro_compact_nudge_tokens";
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
var HUMAN_ONLY_CONFIG_KEYS = /* @__PURE__ */ new Set([WORKFLOW_MODE_KEY]);
var ISSUE_AREA_LABELS_KEY = "issue_area_labels";
var ISSUE_AREA_PATHS_KEY = "issue_area_paths";
function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.every((el) => typeof el === "string" && el.trim().length > 0);
}
function isAreaPathMap(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.entries(value).every(
    ([prefix, area]) => prefix.trim().length > 0 && typeof area === "string" && area.trim().length > 0
  );
}
function validateKnownConfigValue(key, value) {
  if (key === ISSUE_AREA_LABELS_KEY && !isNonEmptyStringArray(value)) {
    throw new Error(
      `typed_field_violation: config key ${JSON.stringify(key)} must be an array of non-empty strings, got ${JSON.stringify(value)}.`
    );
  }
  if (key === ISSUE_AREA_PATHS_KEY && !isAreaPathMap(value)) {
    throw new Error(
      `typed_field_violation: config key ${JSON.stringify(key)} must be an object mapping non-empty path prefixes to non-empty area labels, got ${JSON.stringify(value)}.`
    );
  }
  if (key === HIGH_EFFORT_PATHS_KEY) {
    if (!Array.isArray(value) || value.some((el) => typeof el !== "string" || el.trim().length === 0)) {
      throw new Error(
        `typed_field_violation: config key ${JSON.stringify(key)} must be an array of non-empty strings, got ${JSON.stringify(value)}.`
      );
    }
    return;
  }
  if (key === REVIEWER_EFFORT_TIERS_KEY && typeof value !== "boolean") {
    throw new Error(
      `typed_field_violation: config key ${JSON.stringify(key)} must be a boolean, got ${JSON.stringify(value)}.`
    );
  }
  if ((key === SWE_EFFORT_AB_KEY || key === REVIEWER_EFFORT_AB_KEY) && !isEffortAbConfig(value)) {
    throw new Error(
      `typed_field_violation: config key ${JSON.stringify(key)} must be an object {"label": non-empty string, "target": positive integer}, got ${JSON.stringify(value)}.`
    );
  }
  if (key === REVIEWER_TIER_SETTINGS_KEY && !isReviewerTierSettings(value)) {
    throw new Error(
      `typed_field_violation: config key ${JSON.stringify(key)} must be an object keyed by ${REVIEWER_TIER_REASONS.join(", ")}, each value {"model"?: ${REVIEWER_MODELS.join(" | ")}, "effort"?: ${EFFORT_LEVELS.join(" | ")}}, got ${JSON.stringify(value)}.`
    );
  }
  if (key === DOWNSTREAM_CONTEXT_AB_KEY && !isEmptyObject(value) && !isDownstreamContextAbConfig(value)) {
    throw new Error(
      `typed_field_violation: config key ${JSON.stringify(key)} must be {} (off) or an object {"label": non-empty string, "target": positive integer, "tools_shipped_at": ISO timestamp}, got ${JSON.stringify(value)}.`
    );
  }
  if (key === WORLD_MODEL_TEST_LANE_KEY && !isTestLaneConfig(value)) {
    throw new Error(
      `typed_field_violation: config key ${JSON.stringify(key)} must be an object {"extend"?: [glob...], "exclude"?: [glob...]} of non-empty strings, got ${JSON.stringify(value)}.`
    );
  }
  if (key === BRO_COMPACT_NUDGE_TOKENS_KEY && !isNonNegativeInteger(value)) {
    throw new Error(
      `typed_field_violation: config key ${JSON.stringify(key)} must be a non-negative integer (0 turns the nudge off), got ${JSON.stringify(value)}.`
    );
  }
  if (key === WORKFLOW_MODE_KEY && !isWorkflowMode(value)) {
    throw new Error(
      `typed_field_violation: config key ${JSON.stringify(key)} must be one of ${WORKFLOW_MODES.join(", ")}, got ${JSON.stringify(value)}.`
    );
  }
  if (Object.hasOwn(EFFORT_DEFAULTS, key) && !isEffort(value)) {
    throw new Error(
      `typed_field_violation: config key ${JSON.stringify(key)} must be one of ${EFFORT_LEVELS.join(", ")}, got ${JSON.stringify(value)}.`
    );
  }
}
function storedConfigParseErrorPrefix(key) {
  return `config key ${JSON.stringify(key)}: stored value is not valid JSON`;
}
function writeConfigValueJson(db, key, valueJson, fromNode) {
  db.transaction(() => {
    const stored = db.get("SELECT value_json FROM plugin_config WHERE key = ?", [key]);
    if (stored?.value_json === valueJson) return;
    db.run(
      `INSERT INTO plugin_config (key, value_json)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      [key, valueJson]
    );
    insertAudit(db, {
      issue_id: -1,
      from_node: fromNode,
      event_type: "config_changed",
      summary: `Config changed: ${key}`,
      content_json: JSON.stringify({ key })
    });
  });
}
function setConfigValues(db, entries2, fromNode = "bro") {
  const serialized = entries2.map(({ key, value }) => ({
    key,
    valueJson: serializeConfigValue(key, value)
  }));
  db.transaction(() => {
    for (const { key, valueJson } of serialized) writeConfigValueJson(db, key, valueJson, fromNode);
  });
}
function getConfigValues(db, keys) {
  if (keys.length === 0) return Object.freeze({});
  const placeholders = keys.map(() => "?").join(", ");
  const rows = db.all(
    `SELECT key, value_json
     FROM plugin_config
     WHERE key IN (${placeholders})`,
    [...keys]
  );
  const result = Object.fromEntries(
    keys.map((key) => [key, null])
  );
  for (const row2 of rows) {
    try {
      result[row2.key] = JSON.parse(row2.value_json);
    } catch {
      throw new Error(
        `${storedConfigParseErrorPrefix(row2.key)} \u2014 raw: ${row2.value_json.slice(0, 200)}`
      );
    }
  }
  return Object.freeze(result);
}
function serializeConfigValue(key, rawValue) {
  if (typeof key !== "string" || !KEY_REGEX.test(key)) {
    throw new Error(
      `Invalid config key ${JSON.stringify(key)}: must match /^[a-z][a-z0-9_.-]{0,63}$/i`
    );
  }
  if (rawValue === void 0 || rawValue === null) {
    throw new Error("Missing required arg: value");
  }
  validateKnownConfigValue(key, rawValue);
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]") || trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null) {
          throw new Error(
            `config value for key=${JSON.stringify(key)} looks like a pre-serialized JSON ${Array.isArray(parsed) ? "array" : "object"} (passed as a string). Pass the raw value directly \u2014 e.g. value=["main"], not value="[\\"main\\"]". The server calls JSON.stringify() on whatever you pass; double-encoding it breaks downstream consumers that expect the original shape.`
          );
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
        } else {
          throw error;
        }
      }
    }
  }
  try {
    return JSON.stringify(rawValue);
  } catch {
    throw new Error("config value not JSON-serializable");
  }
}
function configTools(db) {
  const definitions = [
    {
      name: "config_set",
      description: "Set a plugin config key to a JSON-serializable value.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Config key (1-64 chars, must match /^[a-z][a-z0-9_.-]{0,63}$/i)" },
          value: { description: "Any JSON-serializable value" }
        },
        required: ["key", "value"]
      }
    },
    {
      name: "config_get",
      description: "Get a plugin config value by key. Returns null if not set.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" }
        },
        required: ["key"]
      }
    },
    {
      name: "config_list",
      description: "List all plugin config entries as a key\u2192value object.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }
  ];
  const handlers = {
    config_set: requireRoles("config_set", ["bro"], wrapHandler2(async (args) => {
      const key = args["key"];
      if (typeof key === "string" && HUMAN_ONLY_CONFIG_KEYS.has(key)) {
        return err2(
          `human_only_config_key: config key ${JSON.stringify(key)} is set by the Human through /onboard, not config_set.`
        );
      }
      setConfigValues(db, [{ key, value: args["value"] }], normalizeAgent(args["agent"]));
      return ok2({ key });
    })),
    config_get: wrapHandler2(async (args) => {
      const key = args["key"];
      return ok2(getConfigValues(db, [key])[key] ?? null);
    }),
    config_list: wrapHandler2(async () => {
      const rows = db.all(
        `SELECT key, value_json FROM plugin_config ORDER BY key`
      );
      const result = {};
      for (const row2 of rows) {
        try {
          result[row2.key] = JSON.parse(row2.value_json);
        } catch {
          return err2(
            `${storedConfigParseErrorPrefix(row2.key)} \u2014 raw: ${row2.value_json.slice(0, 200)}`
          );
        }
      }
      return ok2(result);
    })
  };
  return { definitions, handlers };
}

// ../mcp/trajectory-server/src/tools/discussions.ts
var ALLOWED_KINDS = /* @__PURE__ */ new Set(["intent", "question", "answer", "decision", "note", "analysis"]);
var CROSS_ISSUE_TASK_KINDS = /* @__PURE__ */ new Set(["note", "analysis"]);
var MAX_BODY_BYTES = 65536;
var HUMAN_AUTHOR = "human";
var HUMAN_AUTHOR_REFUSED = "author_forbidden: discussion_append never writes author='human'. Write the row under your own name and quote the Human verbatim.";
function ok3(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
function err3(message2) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message2 }) }],
    isError: true
  };
}
function requireArg2(args, name) {
  if (args[name] === void 0 || args[name] === null) {
    throw new Error(`Missing required arg: ${name}`);
  }
  return args[name];
}
function optionalId(args, name) {
  const raw = args[name];
  if (raw === void 0 || raw === null || raw === "") return null;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^[1-9][0-9]*$/.test(raw)) return Number(raw);
  throw new Error(`${name} must be a positive integer id (got ${JSON.stringify(raw)})`);
}
function agentName(name) {
  return typeof name === "string" ? name.toLowerCase().replace(/^tmb:/, "") : "";
}
function wrapHandler3(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err3(e.message);
    }
  };
}
function resolveDefaultIssueId(db) {
  const latest = db.get(
    `SELECT id FROM issues WHERE status = 'open' AND id != -1 ORDER BY created_at DESC LIMIT 1`
  );
  return latest?.id ?? -1;
}
function insertDiscussion(db, entry) {
  const createdAt = entry.created_at ?? nowISO();
  const repo = entry.repo ?? resolveIssueRepo(db, entry.issue_id);
  const res = db.run(
    `INSERT INTO discussions (issue_id, author, kind, body, created_at, repo, remote_comment_id, task_id, supersedes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (remote_comment_id) WHERE remote_comment_id IS NOT NULL DO NOTHING`,
    [
      entry.issue_id,
      entry.author,
      entry.kind,
      entry.body,
      createdAt,
      repo,
      entry.remote_comment_id ?? null,
      entry.task_id ?? null,
      entry.supersedes ?? null
    ]
  );
  if (Number(res.changes) === 0) return null;
  const id = Number(res.lastInsertRowid);
  void embedAndStore(db, "discussions", id, entry.body).catch(
    (e) => console.error("[embeddings] insertDiscussion embed failed:", e)
  );
  return id;
}
function discussionTools(db) {
  const definitions = [
    {
      name: "discussion_search",
      description: "Search discussions, returning top-K ranked snippets rather than the full dump of issue_get_with_discussions.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          query: {
            type: "string",
            description: "Search query. For keyword/hybrid: FTS5 MATCH syntax. For semantic: natural language."
          },
          mode: {
            type: "string",
            enum: ["keyword", "semantic", "hybrid"],
            description: "Search mode. Default: hybrid (RRF combines FTS5 + cosine + recency-decay)."
          },
          issue_id: { type: "string", description: "Optional \u2014 restrict to one issue." },
          kind: {
            type: "string",
            enum: ["intent", "note", "question", "answer", "decision", "analysis"],
            description: "Optional \u2014 restrict to one discussion kind."
          },
          k: { type: "number", description: "Top-K rows to return. Default 5. Max 20." },
          recency_alpha: {
            type: "number",
            description: "Recency weight 0\u20131 (hybrid/keyword only). Default 0.3."
          }
        },
        required: ["agent", "query"]
      }
    },
    {
      name: "discussion_append",
      description: "Append an intent, question, answer, decision or note to an issue. issue_id defaults to the newest open issue other than -1, else -1. body is capped at 64 KB (a named error past it).",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Caller agent name" },
          issue_id: { type: "string", description: "The issue ID (integer as string). Optional \u2014 defaults to the newest open issue, else -1." },
          author: { type: "string", description: "Author of this entry: an agent name. 'human' is refused; quote the Human verbatim under your own name." },
          kind: {
            type: "string",
            enum: ["intent", "question", "answer", "decision", "note", "analysis"],
            description: "Entry kind. Default: note"
          },
          body: { type: "string", description: "Markdown body of the discussion entry" },
          task_id: {
            type: "string",
            description: "Optional \u2014 the task the entry belongs to, on this issue (a note or analysis row may name a task on another issue, e.g. world-model feedback). That task's task_brief carries its decision/intent rows; an entry without task_id is issue-level."
          },
          supersedes: {
            type: "string",
            description: "Optional \u2014 id of an earlier discussion on this issue that this entry replaces. Only bro or the author of the earlier row may set it. task_brief skips the superseded row; discussion_search still returns it."
          }
        },
        required: ["agent", "author", "body"]
      }
    },
    {
      name: "discussion_list",
      description: "An issue's discussion entries by created_at ASC.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          issue_id: { type: "string" },
          limit: { type: "number", description: "Max rows to return. Capped at 200. When omitted, returns up to 200 rows (legacy bare-array shape); when provided, response includes next_cursor." },
          offset: { type: "number", description: "Row offset for pagination. Default 0." },
          cursor: { type: "string", description: "Opaque cursor from a previous response. When provided, overrides offset." },
          fields: {
            type: "array",
            items: { type: "string" },
            description: "Optional column projection. Allowed: id, issue_id, author, kind, body, created_at. Unknown fields return an error. Default: all columns."
          }
        },
        required: ["agent", "issue_id"]
      }
    },
    {
      name: "issue_get_with_discussions",
      description: "An issue row with its discussions and tasks in one call: by default counts + the last_n discussions, all with include_full. The description is redacted per the calling agent's scope.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          issue_id: { type: "string" },
          include_full: {
            type: "boolean",
            description: "When true, return all discussions (no limit). Default false \u2014 compact mode returns last_n discussions + total_count."
          },
          last_n: {
            type: "number",
            description: "In compact mode: number of most-recent discussions to return. Default 10. Max 200."
          },
          limit: { type: "number", description: "Deprecated alias for last_n when include_full=false. When include_full=false and limit is provided, acts as last_n cap. Prefer last_n." },
          cursor: { type: "string", description: "Opaque cursor for paginating beyond last_n. When provided, returns next page of discussions." }
        },
        required: ["agent", "issue_id"]
      }
    }
  ];
  function decodeCursor(cursor) {
    try {
      return JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
  function encodeCursor(row2) {
    return Buffer.from(JSON.stringify({ created_at: row2.created_at, id: row2.id })).toString(
      "base64"
    );
  }
  const handlers = {
    discussion_search: wrapHandler3(async (args) => {
      normalizeAgent(args["agent"]);
      const query = requireArg2(args, "query");
      const mode = args["mode"] ?? "hybrid";
      const issueId = args["issue_id"] ?? null;
      const kind = args["kind"] ?? null;
      const k = Math.min(Math.max(1, args["k"] ?? 5), 20);
      const alpha = Math.min(1, Math.max(0, args["recency_alpha"] ?? 0.3));
      await backfillMissing(db, "discussions");
      const ftsQuery = toFtsQuery(query);
      const fetchFtsRows = (limitK) => withFtsGuard(() => db.all(
        `SELECT
             d.id, d.issue_id, d.kind, d.author, d.created_at,
             snippet(discussions_fts, 0, '[', ']', '...', 16) AS snippet,
             bm25(discussions_fts) AS bm25_score,
             (julianday('now') - julianday(d.created_at)) AS age_days
           FROM discussions_fts
           JOIN discussions d ON d.id = discussions_fts.rowid
           WHERE discussions_fts MATCH ?
             AND (? IS NULL OR d.issue_id = CAST(? AS INTEGER))
             AND (? IS NULL OR d.kind = ?)
           ORDER BY bm25(discussions_fts) ASC
           LIMIT ?`,
        [ftsQuery, issueId, issueId, kind, kind, limitK]
      ));
      const fetchRowById = (id) => db.get(
        `SELECT d.id, d.issue_id, d.kind, d.author, d.created_at,
                  '' AS snippet,
                  0.0 AS bm25_score,
                  (julianday('now') - julianday(d.created_at)) AS age_days
           FROM discussions d
           WHERE d.id = ?
             AND (? IS NULL OR d.issue_id = CAST(? AS INTEGER))
             AND (? IS NULL OR d.kind = ?)`,
        [id, issueId, issueId, kind, kind]
      );
      if (mode === "keyword") {
        const countRow = withFtsGuard(() => db.get(
          `SELECT COUNT(*) AS n
           FROM discussions_fts
           JOIN discussions d ON d.id = discussions_fts.rowid
           WHERE discussions_fts MATCH ?
             AND (? IS NULL OR d.issue_id = CAST(? AS INTEGER))
             AND (? IS NULL OR d.kind = ?)`,
          [ftsQuery, issueId, issueId, kind, kind]
        ));
        const total_matched = countRow?.n ?? 0;
        const rows = withFtsGuard(() => db.all(
          `SELECT
             d.id, d.issue_id, d.kind, d.author, d.created_at,
             snippet(discussions_fts, 0, '[', ']', '...', 16) AS snippet,
             bm25(discussions_fts) AS bm25_score,
             (julianday('now') - julianday(d.created_at)) AS age_days
           FROM discussions_fts
           JOIN discussions d ON d.id = discussions_fts.rowid
           WHERE discussions_fts MATCH ?
             AND (? IS NULL OR d.issue_id = CAST(? AS INTEGER))
             AND (? IS NULL OR d.kind = ?)
           ORDER BY (-bm25_score * (1 - ?) + exp(-age_days / 30.0) * ?) DESC
           LIMIT ?`,
          [ftsQuery, issueId, issueId, kind, kind, alpha, alpha, k]
        ));
        return ok3({
          results: rows.map((r) => ({
            id: r.id,
            issue_id: r.issue_id,
            kind: r.kind,
            author: r.author,
            created_at: r.created_at,
            snippet: r.snippet,
            score: -r.bm25_score * (1 - alpha) + Math.exp(-r.age_days / 30) * alpha
          })),
          total_matched
        });
      }
      if (mode === "semantic") {
        const cosineResults2 = await topKByCosine(db, "discussions", query, k);
        if (cosineResults2.length === 0) {
          return ok3({ results: [], total_matched: 0, warning: "semantic_unavailable" });
        }
        const results2 = [];
        for (const cr of cosineResults2) {
          const row2 = fetchRowById(cr.rowid);
          if (row2) {
            results2.push({
              id: row2.id,
              issue_id: row2.issue_id,
              kind: row2.kind,
              author: row2.author,
              created_at: row2.created_at,
              snippet: row2.snippet,
              score: cr.score
            });
          }
        }
        return ok3({ results: results2, total_matched: results2.length });
      }
      const RRF_K = 60;
      const ftsRows = fetchFtsRows(k * 4);
      const cosineResults = await topKByCosine(db, "discussions", query, k * 4);
      const semanticAvailable = cosineResults.length > 0;
      const scoreMap = /* @__PURE__ */ new Map();
      ftsRows.forEach((r, rank) => {
        const rrf = 1 / (RRF_K + rank + 1);
        const existing = scoreMap.get(r.id);
        if (existing) {
          existing.rrf += rrf;
        } else {
          scoreMap.set(r.id, { rrf, row: r });
        }
      });
      cosineResults.forEach((cr, rank) => {
        const rrf = 1 / (RRF_K + rank + 1);
        const existing = scoreMap.get(cr.rowid);
        if (existing) {
          existing.rrf += rrf;
        } else {
          const row2 = fetchRowById(cr.rowid);
          if (row2) scoreMap.set(cr.rowid, { rrf, row: row2 });
        }
      });
      const combined = Array.from(scoreMap.values()).map(({ rrf, row: row2 }) => {
        const ageDays = row2.age_days;
        const decayed = rrf * (Math.exp(-ageDays / 30) * alpha + (1 - alpha));
        return { row: row2, score: decayed };
      });
      combined.sort((a, b) => b.score - a.score);
      const topRows = combined.slice(0, k);
      const results = topRows.map(({ row: row2, score }) => ({
        id: row2.id,
        issue_id: row2.issue_id,
        kind: row2.kind,
        author: row2.author,
        created_at: row2.created_at,
        snippet: row2.snippet,
        score
      }));
      const response = { results, total_matched: results.length };
      if (!semanticAvailable) response["warning"] = "semantic_unavailable";
      return ok3(response);
    }),
    discussion_append: requireRoles(
      "discussion_append",
      ["bro", "swe", "code-reviewer", "consultant"],
      wrapHandler3(async (args) => {
        normalizeAgent(args["agent"]);
        const rawIssueId = args["issue_id"];
        const issueId = rawIssueId != null ? rawIssueId : String(resolveDefaultIssueId(db));
        const author = requireArg2(args, "author");
        if (String(author).trim().toLowerCase() === HUMAN_AUTHOR) return err3(HUMAN_AUTHOR_REFUSED);
        const body = requireArg2(args, "body");
        const kind = args["kind"] ?? "note";
        const bodyBytes = Buffer.byteLength(body, "utf8");
        if (bodyBytes > MAX_BODY_BYTES) {
          return err3(`body exceeds 64KB limit (${bodyBytes} bytes); truncate before calling discussion_append`);
        }
        if (!ALLOWED_KINDS.has(kind)) {
          return err3(
            `Invalid kind: "${kind}". Allowed values: ${[...ALLOWED_KINDS].join(", ")}`
          );
        }
        if (!author.trim()) {
          throw new Error("author must be a non-empty string");
        }
        const issue = db.get("SELECT id FROM issues WHERE id = ?", [issueId]);
        if (!issue) {
          throw new Error(`Not found: issue ${issueId}`);
        }
        const taskId = optionalId(args, "task_id");
        if (taskId !== null) {
          const task = db.get("SELECT issue_id FROM tasks WHERE id = ?", [taskId]);
          if (!task) throw new Error(`Not found: task ${taskId}`);
          if (task.issue_id !== issue.id && !CROSS_ISSUE_TASK_KINDS.has(kind)) {
            throw new Error(`task_id ${taskId} belongs to issue ${task.issue_id}, not issue ${issue.id}`);
          }
        }
        const supersedes = optionalId(args, "supersedes");
        if (supersedes !== null) {
          const prior = db.get(
            "SELECT issue_id, author FROM discussions WHERE id = ?",
            [supersedes]
          );
          if (!prior) throw new Error(`Not found: discussion ${supersedes}`);
          if (prior.issue_id !== issue.id) {
            throw new Error(`supersedes ${supersedes} belongs to issue ${prior.issue_id}, not issue ${issue.id}`);
          }
          if (normalizeAgent(args["agent"]) !== "bro" && agentName(prior.author) !== agentName(args["agent"])) {
            throw new Error(
              `supersedes_forbidden: only bro or the row's author (${prior.author}) may supersede discussion ${supersedes}`
            );
          }
        }
        const now2 = nowISO();
        const id = insertDiscussion(db, {
          issue_id: issueId,
          author,
          kind,
          body,
          created_at: now2,
          task_id: taskId,
          supersedes
        });
        const row2 = db.get("SELECT * FROM discussions WHERE id = ?", [id]);
        return ok3(row2);
      })
    ),
    discussion_list: wrapHandler3(async (args) => {
      normalizeAgent(args["agent"]);
      const issueId = requireArg2(args, "issue_id");
      const limitArg = args["limit"];
      const cursorArg = args["cursor"];
      const rawOffset = args["offset"] ?? 0;
      const fieldsArg = args["fields"];
      const ALLOWED_DISCUSSION_FIELDS = /* @__PURE__ */ new Set(["id", "issue_id", "author", "kind", "body", "created_at"]);
      if (fieldsArg !== void 0) {
        const unknown = fieldsArg.filter((f) => !ALLOWED_DISCUSSION_FIELDS.has(f));
        if (unknown.length > 0) {
          return err3(`Unknown fields: ${unknown.join(", ")}. Allowed: ${[...ALLOWED_DISCUSSION_FIELDS].join(", ")}`);
        }
      }
      function projectRow(row2) {
        if (!fieldsArg) return row2;
        const out = {};
        for (const f of fieldsArg) out[f] = row2[f];
        return out;
      }
      const issue = db.get("SELECT id FROM issues WHERE id = ?", [issueId]);
      if (!issue) {
        return ok3({ discussions: [], warning: "issue not found" });
      }
      if (limitArg === void 0 || limitArg === null) {
        const offset = Math.max(0, rawOffset);
        const rows2 = db.all(
          `SELECT * FROM discussions WHERE issue_id = ? ORDER BY created_at ASC LIMIT 200 OFFSET ?`,
          [issueId, offset]
        );
        return ok3(rows2.map(projectRow));
      }
      const limit = Math.min(Math.max(1, limitArg), 200);
      let cursorFilter = "";
      let cursorParams = [];
      if (cursorArg) {
        const decoded = decodeCursor(cursorArg);
        if (decoded) {
          cursorFilter = "AND (created_at > ? OR (created_at = ? AND id > ?))";
          cursorParams = [decoded.created_at, decoded.created_at, decoded.id];
        }
      }
      const sql = "SELECT * FROM discussions WHERE issue_id = ? " + cursorFilter + " ORDER BY created_at ASC, id ASC LIMIT ?";
      const fetchedRows = db.all(sql, [issueId, ...cursorParams, limit + 1]);
      const hasMore = fetchedRows.length > limit;
      const rows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
      const last = rows[rows.length - 1];
      const next_cursor = hasMore && last ? encodeCursor(last) : void 0;
      return ok3({ rows: rows.map(projectRow), next_cursor });
    }),
    issue_get_with_discussions: wrapHandler3(async (args) => {
      const agent = normalizeAgent(args["agent"]);
      const issueId = requireArg2(args, "issue_id");
      const includeFull = args["include_full"] ?? false;
      const lastNArg = args["last_n"];
      const limitArg = args["limit"];
      const cursorArg = args["cursor"];
      const issue = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!issue) {
        throw new Error(`Not found: issue ${issueId}`);
      }
      const tasks2 = db.all(
        `SELECT id, branch_id, status, title FROM tasks WHERE issue_id = ? ORDER BY branch_id ASC`,
        [issueId]
      );
      const redactedIssue = redactIssue(issue, agent);
      if (includeFull) {
        const discussions2 = db.all(
          `SELECT * FROM discussions WHERE issue_id = ? ORDER BY created_at ASC`,
          [issueId]
        );
        return ok3({ issue: redactedIssue, discussions: discussions2, tasks: tasks2 });
      }
      const totalCount = db.get(
        `SELECT COUNT(*) AS n FROM discussions WHERE issue_id = ?`,
        [issueId]
      )?.n ?? 0;
      const resolvedLastN = Math.min(
        Math.max(1, lastNArg ?? limitArg ?? 10),
        200
      );
      let cursorFilter = "";
      let cursorParams = [];
      if (cursorArg) {
        const decoded = decodeCursor(cursorArg);
        if (decoded) {
          cursorFilter = "AND (created_at < ? OR (created_at = ? AND id < ?))";
          cursorParams = [decoded.created_at, decoded.created_at, decoded.id];
        }
      }
      const sql = "SELECT * FROM discussions WHERE issue_id = ? " + cursorFilter + " ORDER BY created_at DESC, id DESC LIMIT ?";
      const fetchedDisc = db.all(sql, [issueId, ...cursorParams, resolvedLastN + 1]);
      const hasMore = fetchedDisc.length > resolvedLastN;
      const sliced = hasMore ? fetchedDisc.slice(0, resolvedLastN) : fetchedDisc;
      const oldest = sliced[sliced.length - 1];
      const next_cursor = hasMore && oldest ? encodeCursor(oldest) : void 0;
      const discussions = sliced.slice().reverse();
      return ok3({
        issue: redactedIssue,
        discussions,
        tasks: tasks2,
        total_discussion_count: totalCount,
        returned_count: discussions.length,
        ...next_cursor !== void 0 ? { next_cursor } : {}
      });
    })
  };
  return { definitions, handlers };
}

// server/writes.ts
var GATE_AGENT = "bro";
var WRITE_ACTIONS = ["edit", "comment", "close"];
function isWriteAction(value) {
  return WRITE_ACTIONS.includes(value);
}
var ALLOWED_KEYS = {
  edit: ["updated_at", "objective", "description", "labels", "milestone"],
  comment: ["body"],
  close: ["updated_at"]
};
var fail = (status, error, message2, extra = {}) => ({
  status,
  body: { error, message: message2, ...extra }
});
function openWriteDb(dbPath) {
  const noop = () => {
  };
  return new TrajectoryDB(dbPath, { pluginVersion: null, serverLog: noop, sqlLog: noop });
}
function schemaMismatch(readDb) {
  const dbVersion = schemaVersion(readDb);
  if (dbVersion === TARGET_SCHEMA_VERSION) return null;
  return fail(
    409,
    "schema_version_mismatch",
    `The DB is at schema version ${dbVersion ?? "unknown"} and this dashboard writes version ${TARGET_SCHEMA_VERSION}. Open a Claude Code session with the current plugin, then restart the dashboard.`,
    { db_version: dbVersion, dashboard_version: TARGET_SCHEMA_VERSION }
  );
}
function humanAudit(db, entry) {
  insertAudit(db, {
    issue_id: entry.issue_id,
    from_node: "dashboard",
    event_type: entry.event_type,
    summary: entry.summary,
    content_json: JSON.stringify({ actor: "human", source: "dashboard", ...entry.content }),
    created_at: nowISO()
  });
}
function parseHandlerResult(result) {
  const first = result.content[0];
  const text2 = first && first.type === "text" ? first.text : "{}";
  let data;
  try {
    data = JSON.parse(text2);
  } catch {
    data = { error: "unparseable_result", message: text2 };
  }
  return { ok: result.isError !== true, data };
}
function handlerError(tool, data, applied = []) {
  const code = typeof data["error"] === "string" ? data["error"] : "handler_error";
  const message2 = typeof data["message"] === "string" ? data["message"] : code;
  return fail(422, code, message2, { ...data, error: code, message: message2, tool, applied });
}
var stale = (current, applied = []) => fail(409, "stale", "The issue changed since you loaded it. Reload to see the latest, then retry.", {
  updated_at: current,
  applied
});
function parseEdit(body) {
  const update = {};
  for (const key of ["objective", "milestone"]) {
    if (body[key] === void 0) continue;
    if (typeof body[key] !== "string") return `${key} must be a string`;
    update[key] = body[key];
  }
  if (body["labels"] !== void 0) {
    const labels = body["labels"];
    if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) {
      return "labels must be an array of strings";
    }
    update["labels"] = labels;
  }
  const description = body["description"];
  if (description !== void 0 && typeof description !== "string") return "description must be a string";
  if (Object.keys(update).length === 0 && description === void 0) {
    return "pass at least one of objective, description, labels, milestone";
  }
  return description === void 0 ? { update } : { update, description };
}
var IssueWriter = class {
  constructor(dbPath, readDb) {
    this.dbPath = dbPath;
    this.readDb = readDb;
  }
  dbPath;
  readDb;
  writable = null;
  open() {
    if (this.writable) return this.writable;
    const db = openWriteDb(this.dbPath);
    this.writable = {
      db,
      handlers: { ...issueTools(db, this.dbPath).handlers, ...discussionTools(db).handlers }
    };
    return this.writable;
  }
  close() {
    this.writable?.db.close();
    this.writable = null;
  }
  async perform(action, issueId, body) {
    const unknown = Object.keys(body).filter((k) => !ALLOWED_KEYS[action].includes(k));
    if (unknown.length > 0) {
      return fail(400, "unknown_fields", `${action} does not take: ${unknown.join(", ")}`);
    }
    const mismatch = schemaMismatch(this.readDb);
    if (mismatch) return mismatch;
    if (issueUpdatedAt(this.readDb, issueId) === null) return fail(404, "not_found", `issue ${issueId} not found`);
    if (action === "comment") return this.comment(issueId, body);
    const rendered = body["updated_at"];
    if (typeof rendered !== "string") {
      return fail(400, "updated_at_required", "send the updated_at you rendered");
    }
    return action === "edit" ? this.edit(issueId, body, rendered) : this.closeIssue(issueId, rendered);
  }
  handler(tool) {
    const handler = this.open().handlers[tool];
    if (!handler) throw new Error(`trajectory-server handler ${tool} missing`);
    return handler;
  }
  async call(tool, args) {
    return parseHandlerResult(await this.handler(tool)({ agent: GATE_AGENT, ...args }));
  }
  updatedAt(issueId) {
    const row2 = this.open().db.get("SELECT updated_at FROM issues WHERE id = ?", [issueId]);
    return row2 ? row2.updated_at : null;
  }
  // The updated_at check and the handler's local write share one BEGIN IMMEDIATE,
  // so no other process can write the issue in between. The handlers write
  // before their first await (remote sync), so the write lands inside it and the
  // lock is released before any remote call.
  async callIfCurrent(issueId, tool, args, expected) {
    const handler = this.handler(tool);
    const step = this.open().db.transaction(() => {
      const current = this.updatedAt(issueId);
      if (current !== expected) return { stale: true, current };
      const pending = handler({ agent: GATE_AGENT, ...args });
      return { stale: false, pending, after: this.updatedAt(issueId) };
    });
    if (step.stale) return { stale: true, current: step.current };
    return { stale: false, ...parseHandlerResult(await step.pending), after: step.after };
  }
  audit(issueId, tool, fields, extra = {}) {
    humanAudit(this.open().db, {
      issue_id: issueId,
      event_type: "issue_updated",
      summary: `the Human ran ${tool} on issue ${issueId} from the dashboard (${fields.join(", ")})`,
      content: { tool, issue_id: issueId, fields, ...extra }
    });
  }
  done(issueId, tools, extra = {}) {
    return { status: 200, body: { ok: true, tools, updated_at: issueUpdatedAt(this.readDb, issueId), ...extra } };
  }
  async edit(issueId, body, rendered) {
    const fields = parseEdit(body);
    if (typeof fields === "string") return fail(400, "invalid_fields", fields);
    const applied = [];
    let expected = rendered;
    const updateKeys = Object.keys(fields.update);
    if (updateKeys.length > 0) {
      const res = await this.callIfCurrent(issueId, "issue_update", { issue_id: String(issueId), ...fields.update }, expected);
      if (res.stale) return stale(res.current, applied);
      if (!res.ok) return handlerError("issue_update", res.data, applied);
      this.audit(issueId, "issue_update", updateKeys);
      applied.push("issue_update");
      expected = res.after;
    }
    if (fields.description !== void 0) {
      if (expected === null) return stale(null, applied);
      const res = await this.callIfCurrent(
        issueId,
        "issue_update_description",
        { issue_id: String(issueId), description: fields.description },
        expected
      );
      if (res.stale) return stale(res.current, applied);
      if (!res.ok) return handlerError("issue_update_description", res.data, applied);
      this.audit(issueId, "issue_update_description", ["description"]);
      applied.push("issue_update_description");
    }
    return this.done(issueId, applied);
  }
  async comment(issueId, body) {
    const text2 = body["body"];
    if (typeof text2 !== "string" || text2.trim() === "") {
      return fail(400, "invalid_fields", "body must be a non-empty string");
    }
    const res = await this.call("discussion_append", {
      issue_id: String(issueId),
      author: "dashboard",
      kind: "note",
      body: text2
    });
    if (!res.ok) return handlerError("discussion_append", res.data);
    this.audit(issueId, "discussion_append", ["comment"], { discussion_id: res.data["id"] });
    return this.done(issueId, ["discussion_append"], { discussion_id: res.data["id"] });
  }
  async closeIssue(issueId, rendered) {
    const res = await this.callIfCurrent(issueId, "issue_close", { issue_id: String(issueId) }, rendered);
    if (res.stale) return stale(res.current);
    if (!res.ok) return handlerError("issue_close", res.data);
    this.audit(issueId, "issue_close", ["status"]);
    return this.done(issueId, ["issue_close"], { issue_status: res.data["status"] });
  }
};

// server/config.ts
var EDITABLE_CONFIG_KEYS = [
  "model_prices",
  "issue_area_labels",
  "issue_classification_labels",
  "issue_priority_labels"
];
function isEditableConfigKey(key) {
  return EDITABLE_CONFIG_KEYS.includes(key);
}
var BODY_KEYS = ["value", "expected"];
function storedValue(valueJson) {
  if (valueJson === void 0) return null;
  try {
    return JSON.parse(valueJson);
  } catch {
    return null;
  }
}
function editableConfig(db) {
  const rows = db.prepare("SELECT key, value_json FROM plugin_config WHERE key IN (SELECT value FROM json_each(?))").all(JSON.stringify(EDITABLE_CONFIG_KEYS));
  const stored = new Map(rows.map((r) => [r.key, r.value_json]));
  return { keys: EDITABLE_CONFIG_KEYS.map((key) => ({ key, value: storedValue(stored.get(key)) })) };
}
var invalid = (field, message2) => fail(422, "invalid_value", message2, { field });
function checkLabels(value) {
  if (!Array.isArray(value) || value.length === 0) return invalid("value", "labels must be a non-empty array of strings");
  const seen = /* @__PURE__ */ new Set();
  for (const [i, label] of value.entries()) {
    const field = `value[${i}]`;
    if (typeof label !== "string" || label.trim() === "") return invalid(field, `label ${i + 1} must be a non-empty string`);
    if (label !== label.trim()) return invalid(field, `label ${JSON.stringify(label)} has leading or trailing spaces`);
    if (seen.has(label)) return invalid(field, `label ${JSON.stringify(label)} is listed twice`);
    seen.add(label);
  }
  return null;
}
function checkPrices(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("value", "model_prices must be an object keyed by model name");
  }
  for (const [model, entry] of Object.entries(value)) {
    const at = `value[${JSON.stringify(model)}]`;
    if (model.trim() === "") return invalid(at, "a model name must be non-empty");
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return invalid(at, `${model} must be an object with ${PRICE_FIELDS.join(", ")}`);
    }
    const unknown = Object.keys(entry).filter((k) => !PRICE_FIELDS.includes(k));
    if (unknown.length > 0) return invalid(`${at}.${unknown[0]}`, `${model} has an unknown field: ${unknown.join(", ")}`);
    for (const f of PRICE_FIELDS) {
      const n = entry[f];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        return invalid(`${at}.${f}`, `${model} ${f} must be a number \u2265 0 (USD per 1M tokens)`);
      }
    }
  }
  return null;
}
function checkConfigValue(key, value) {
  return key === "model_prices" ? checkPrices(value) : checkLabels(value);
}
var ConfigWriter = class {
  constructor(dbPath, readDb) {
    this.dbPath = dbPath;
    this.readDb = readDb;
  }
  dbPath;
  readDb;
  writable = null;
  open() {
    if (this.writable) return this.writable;
    const db = openWriteDb(this.dbPath);
    const set = configTools(db).handlers["config_set"];
    if (!set) throw new Error("trajectory-server handler config_set missing");
    this.writable = { db, set };
    return this.writable;
  }
  close() {
    this.writable?.db.close();
    this.writable = null;
  }
  async perform(key, body) {
    const unknown = Object.keys(body).filter((k) => !BODY_KEYS.includes(k));
    if (unknown.length > 0) return fail(400, "unknown_fields", `config writes do not take: ${unknown.join(", ")}`);
    if (!Object.hasOwn(body, "expected")) {
      return fail(400, "expected_required", "send the value you loaded as expected (null when the key was unset)");
    }
    const mismatch = schemaMismatch(this.readDb);
    if (mismatch) return mismatch;
    const value = body["value"];
    const bad = checkConfigValue(key, value);
    if (bad) return bad;
    const step = this.writeIfCurrent(key, value, body["expected"]);
    if (step.stale) {
      return fail(409, "stale", `${key} changed since you loaded it. Reload to see the latest, then retry.`, { current: step.current });
    }
    const res = parseHandlerResult(await step.pending);
    if (!res.ok) return handlerError("config_set", res.data);
    return { status: 200, body: { ok: true, key, value: step.after, changed: step.changed } };
  }
  // The expected-value check, config_set's write and the Human audit row share
  // one BEGIN IMMEDIATE. config_set writes before its first await, so its write
  // lands inside it; an identical value writes nothing and leaves no audit row.
  writeIfCurrent(key, value, expected) {
    const { db, set } = this.open();
    const read = () => db.get("SELECT value_json FROM plugin_config WHERE key = ?", [key])?.value_json;
    return db.transaction(() => {
      const before = read();
      const current = storedValue(before);
      if (!isDeepStrictEqual(current, expected)) return { stale: true, current };
      const pending = set({ agent: GATE_AGENT, key, value });
      const afterJson = read();
      const changed = afterJson !== before;
      if (changed) {
        humanAudit(db, {
          issue_id: -1,
          event_type: "config_changed",
          summary: `the Human ran config_set on ${key} from the dashboard`,
          content: { tool: "config_set", fields: [key] }
        });
      }
      return { stale: false, pending, changed, after: storedValue(afterJson) };
    });
  }
};

// server/efficiency.ts
import { spawn } from "node:child_process";
import { isAbsolute as isAbsolute5 } from "node:path";
var CODE_TYPES = ["feat", "fix", "test", "refactor", "perf", "chore"];
var TASK_TYPES = [...CODE_TYPES, "docs"];
var FEW_MIN = 3;
var SHA = /^[0-9a-f]{7,40}$/;
var SUBJECT_TYPE = /^\W*([a-z]+)(\([^)]*\))?!?:/;
var NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t(.+)$/;
var GIT_TIMEOUT_MS = 15e3;
var GIT_MAX_BUFFER = 32 * 1024 * 1024;
var LOCKFILES = /* @__PURE__ */ new Set(["bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
var GENERATED_FILES = /* @__PURE__ */ new Set(["data-contracts.json"]);
var GENERATED_PATHS = /* @__PURE__ */ new Set(["docs/contributing/ENUMS.md", "docs/architecture/ERD.md", "docs/architecture/CONFIG_KEYS.md"]);
var GENERATED_DIRS = /* @__PURE__ */ new Set(["dist", "build"]);
var DOC_FILE = /\.(md|mdx|txt|rst)$/;
var isTaskType = (v) => TASK_TYPES.includes(v);
function commitType(subject) {
  const type = subject.match(SUBJECT_TYPE)?.[1];
  return type !== void 0 && isTaskType(type) ? type : "other";
}
function numstatPath(raw) {
  const braced = raw.replace(/\{[^{}]* => ([^{}]*)\}/g, "$1").replace(/\/{2,}/g, "/");
  const arrow = braced.indexOf(" => ");
  return arrow === -1 ? braced : braced.slice(arrow + 4);
}
function isGenerated(path) {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  return parts.slice(0, -1).some((p) => GENERATED_DIRS.has(p)) || name.endsWith(".map") || name.includes(".min.") || LOCKFILES.has(name) || GENERATED_FILES.has(name) || GENERATED_PATHS.has(path);
}
var isDoc = (path) => DOC_FILE.test(path) || path.split("/").slice(0, -1).includes("docs");
function parseNumstat(out) {
  const [subject = "", ...rest] = out.split("\n");
  const files = [];
  for (const line of rest) {
    const m = line.match(NUMSTAT_LINE);
    if (!m || m[1] === "-" || m[2] === "-") continue;
    files.push({ path: numstatPath(m[3]), added: Number(m[1]), deleted: Number(m[2]) });
  }
  return { subject, files };
}
function linesOf(stat, type) {
  return stat.files.filter((f) => !isGenerated(f.path) && (type === "docs" || !isDoc(f.path))).reduce((s, f) => s + f.added + f.deleted, 0);
}
function gitRun(path, args, input) {
  return new Promise((resolve4, reject) => {
    const child = spawn("git", ["-C", path, "-c", "core.quotePath=false", ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS
    });
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > GIT_MAX_BUFFER) child.kill();
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => {
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && size <= GIT_MAX_BUFFER) resolve4(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`git ${args[0]} exited ${code}`));
    });
    child.stdin.end(input);
  });
}
function commitsOf(shas, batchCheck) {
  const lines = batchCheck.split("\n");
  const full = /* @__PURE__ */ new Map();
  shas.forEach((sha, i) => {
    const [name, type] = (lines[i] ?? "").split(" ");
    if (type === "commit" && name !== void 0 && SHA.test(name)) full.set(sha, name);
  });
  return full;
}
function parseLog(out) {
  const parts = out.split("\0");
  const stats = /* @__PURE__ */ new Map();
  for (let i = 1; i + 1 < parts.length; i += 2) stats.set(parts[i], parseNumstat(parts[i + 1]));
  return stats;
}
var numstats = /* @__PURE__ */ new Map();
var cacheKey = (repo, sha) => `${repo}:${sha}`;
async function loadRepo(repo, path, shas) {
  try {
    const full = commitsOf(shas, await gitRun(path, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], shas.map((s) => `${s}
`).join("")));
    if (full.size === 0) return;
    const commits = [...new Set(full.values())];
    const log = parseLog(await gitRun(path, ["log", "--no-color", "--no-walk=unsorted", "--stdin", "--numstat", "--format=%x00%H%x00%s"], commits.map((c) => `${c}
`).join("")));
    for (const [sha, name] of full) {
      const stat = log.get(name);
      if (stat) numstats.set(cacheKey(repo, sha), stat);
    }
  } catch {
    return;
  }
}
var targetOf = (r) => SHA.test(r.commit_sha) && r.repo !== null && r.repo_path !== null && isAbsolute5(r.repo_path) ? { repo: r.repo, path: r.repo_path, sha: r.commit_sha } : null;
async function loadNumstats(rows) {
  const pending = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const t = targetOf(r);
    if (t === null || numstats.has(cacheKey(t.repo, t.sha))) continue;
    const entry = pending.get(t.repo) ?? { path: t.path, shas: /* @__PURE__ */ new Set() };
    entry.shas.add(t.sha);
    pending.set(t.repo, entry);
  }
  await Promise.all([...pending].map(([repo, { path, shas }]) => loadRepo(repo, path, [...shas])));
}
var pad = (n) => String(n).padStart(2, "0");
function localMonday(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7);
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
}
var sum = (tasks2, v) => tasks2.reduce((s, t) => s + v(t), 0);
var pooled = (tasks2, v) => tasks2.length === 0 ? null : sum(tasks2, v) / sum(tasks2, (t) => t.lines);
var median2 = (tasks2) => nearestRank(tasks2.map((t) => t.tokens / t.lines).sort((a, b) => a - b), 0.5);
var share = (part, whole) => whole === 0 ? null : part / whole;
function groupOf(all2) {
  const tasks2 = all2.filter((t) => t.lines > 0);
  const n = tasks2.length;
  const few = n < FEW_MIN;
  const fp = tasks2.filter((t) => t.first);
  const rw = tasks2.filter((t) => !t.first);
  const metric2 = (v) => few ? null : v();
  return {
    n,
    zero_line: all2.length - n,
    few,
    first_pass_rate: metric2(() => fp.length / n),
    fp_tok_line: metric2(() => pooled(fp, (t) => t.tokens)),
    fp_tok_line_median: metric2(() => median2(fp)),
    rw_tok_line: metric2(() => pooled(rw, (t) => t.tokens)),
    rw_tok_line_median: metric2(() => median2(rw)),
    rework_share: metric2(() => share(sum(rw, (t) => t.cost), sum(tasks2, (t) => t.cost))),
    cache_hit: metric2(() => share(sum(tasks2, (t) => t.cache_read), sum(tasks2, (t) => t.context))),
    fp_sec_line: metric2(() => pooled(fp, (t) => t.seconds)),
    rw_sec_line: metric2(() => pooled(rw, (t) => t.seconds))
  };
}
function grouped(tasks2, key) {
  const by = /* @__PURE__ */ new Map();
  for (const t of tasks2) {
    const list = by.get(key(t));
    if (list) list.push(t);
    else by.set(key(t), [t]);
  }
  return [...by].map(([k, list]) => [k, groupOf(list)]);
}
var fewLast = (a, b) => Number(a.few) - Number(b.few);
function taskRows(db, f, p) {
  const period = periodWhere(p, "t.completed_at", "t.id");
  return db.prepare(
    `SELECT t.id, t.repo, r.path AS repo_path, t.commit_sha, t.completed_at,
              COALESCE(a.swe_runs, 0) AS swe_runs, COALESCE(v.fails, 0) AS fails,
              COALESCE(a.tokens_in, 0) AS tokens_in, COALESCE(a.tokens_out, 0) AS tokens_out,
              COALESCE(a.cache_read, 0) AS cache_read, COALESCE(a.cache_creation, 0) AS cache_creation,
              COALESCE(a.duration_ms, 0) AS duration_ms
         FROM tasks t
         LEFT JOIN repos r ON r.name = t.repo
         LEFT JOIN (
           SELECT task_id, SUM(agent_type = 'swe') AS swe_runs,
                  SUM(COALESCE(tokens_in, 0)) AS tokens_in, SUM(COALESCE(tokens_out, 0)) AS tokens_out,
                  SUM(COALESCE(cache_read_tokens, 0)) AS cache_read, SUM(COALESCE(cache_creation_tokens, 0)) AS cache_creation,
                  SUM(COALESCE(duration_ms, 0)) AS duration_ms
             FROM agent_runs WHERE agent_type IN ('swe', 'code-reviewer') AND task_id IS NOT NULL GROUP BY task_id
         ) a ON a.task_id = t.id
         LEFT JOIN (SELECT task_id, COUNT(*) AS fails FROM validation_attempts WHERE verdict = 'fail' GROUP BY task_id) v ON v.task_id = t.id
        WHERE t.status = 'closed' AND t.commit_sha IS NOT NULL AND t.completed_at IS NOT NULL
          AND ${period.sql}
          AND (? IS NULL OR t.repo = ?) AND (? IS NULL OR t.effort = ?)
        ORDER BY t.id`
  ).all(...period.args, f.repo, f.repo, f.effort, f.effort);
}
function factsOf(r) {
  const week = localMonday(r.completed_at);
  const t = targetOf(r);
  const stat = t === null ? void 0 : numstats.get(cacheKey(t.repo, t.sha));
  if (week === null || stat === void 0) return null;
  const type = commitType(stat.subject);
  const context2 = r.tokens_in + r.cache_read + r.cache_creation;
  return {
    type,
    week,
    lines: linesOf(stat, type),
    tokens: context2 + r.tokens_out,
    context: context2,
    cache_read: r.cache_read,
    cost: r.tokens_in + 0.1 * r.cache_read + 1.25 * r.cache_creation + 5 * r.tokens_out,
    seconds: r.duration_ms / 1e3,
    first: r.swe_runs === 1 && r.fails === 0
  };
}
function bodyOf(rows) {
  const facts = [];
  let skipped = 0;
  for (const r of rows) {
    const t = factsOf(r);
    if (t === null) skipped += 1;
    else facts.push(t);
  }
  const codeFacts = facts.filter((t) => t.type !== "docs");
  const types = grouped(facts, (t) => t.type);
  const code = types.filter(([k]) => k !== "docs").sort(([ka, a], [kb, b]) => fewLast(a, b) || b.n - a.n || ka.localeCompare(kb));
  const docs = types.filter(([k]) => k === "docs");
  const weeks = grouped(codeFacts, (t) => t.week).sort(([ka, a], [kb, b]) => fewLast(a, b) || ka.localeCompare(kb));
  return {
    overall: groupOf(codeFacts),
    by_type: [...code, ...docs].map(([type, g]) => ({ type, ...g })),
    by_week: weeks.map(([week, g]) => ({ week, ...g })),
    skipped
  };
}
async function efficiency(db, f, now2 = /* @__PURE__ */ new Date()) {
  const since = sinceOf(f.range, now2);
  const rows = taskRows(db, f, { since, before: null, fromTask: null, toTask: null });
  await loadNumstats(rows);
  return {
    range: { key: f.range, since, until: now2.toISOString() },
    filters: { repo: f.repo, effort: f.effort },
    ...bodyOf(rows)
  };
}
async function efficiencyCompare(db, f, s1, s2) {
  const r1 = taskRows(db, f, periodOf(s1));
  const r2 = taskRows(db, f, periodOf(s2));
  const union = /* @__PURE__ */ new Map();
  for (const r of [...r1, ...r2]) union.set(r.id, r);
  await loadNumstats([...union.values()]);
  const ids1 = new Set(r1.map((r) => r.id));
  return {
    p1: { slice: s1, ...bodyOf(r1) },
    p2: { slice: s2, ...bodyOf(r2) },
    filters: { repo: f.repo, effort: f.effort },
    shared_tasks: r2.filter((r) => ids1.has(r.id)).length
  };
}

// server/freshness.ts
var HISTORY_DEFAULT = 20;
var HISTORY_MAX = 100;
function one2(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}
var text = (v) => v === null || v === void 0 ? null : String(v);
var num = (v) => v === null || v === void 0 ? null : Number(v);
function hasTable(db, name) {
  return one2(db, `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, name) !== void 0;
}
function hasColumn2(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c["name"] === column);
}
function freshnessReady(db) {
  const n = one2(db, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('wm_freshness', 'wm_concepts')`);
  if (Number(n?.["n"] ?? 0) !== 2) return false;
  return hasColumn2(db, "repos", "indexed_commit");
}
function needsReviewCount(db, repo) {
  const concepts = Number(one2(db, `SELECT COUNT(*) AS n FROM wm_concepts WHERE repo = ? AND status IN ('suspect','broken')`, repo)?.["n"] ?? 0);
  if (!hasColumn2(db, "wm_directories", "readme_review_pending")) return concepts;
  return concepts + Number(one2(db, "SELECT COUNT(*) AS n FROM wm_directories WHERE repo = ? AND readme_review_pending = 1", repo)?.["n"] ?? 0);
}
function wmRepos(db) {
  if (!hasTable(db, "wm_directories")) return [];
  return db.prepare("SELECT DISTINCT repo FROM wm_directories ORDER BY repo").all().map((r) => String(r["repo"]));
}
function resolveRepo(db, repo) {
  return repo ?? wmRepos(db)[0] ?? null;
}
function freshnessBlock(db, repo) {
  if (repo === null || !freshnessReady(db)) return null;
  const indexed = text(one2(db, "SELECT indexed_commit FROM repos WHERE name = ?", repo)?.["indexed_commit"]);
  const f = one2(db, "SELECT * FROM wm_freshness WHERE repo = ?", repo) ?? {};
  const targetCommit = text(f["target_commit"]);
  const state = text(f["reindex_state"]) ?? "idle";
  return {
    indexed_commit: indexed,
    target_ref: text(f["target_ref"]),
    target_commit: targetCommit,
    stale: indexed === null || indexed !== targetCommit || state === "running",
    reindex: {
      state,
      mode: text(f["reindex_mode"]),
      trigger: text(f["reindex_trigger"]),
      started_at: text(f["reindex_started_at"]),
      finished_at: text(f["reindex_finished_at"]),
      elapsed_ms: num(f["reindex_elapsed_ms"]),
      outcome: text(f["reindex_outcome"])
    },
    needs_review_count: needsReviewCount(db, repo)
  };
}
function freshnessFor(db, repo) {
  return freshnessBlock(db, resolveRepo(db, repo));
}
function clampHistory(raw) {
  if (raw === null || raw.trim() === "") return HISTORY_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), HISTORY_MAX) : HISTORY_DEFAULT;
}
function parseObject(raw) {
  try {
    const v = JSON.parse(String(raw));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function worldModelStatus(db, limit) {
  const repos = wmRepos(db).map((repo) => ({ repo, freshness: freshnessBlock(db, repo) }));
  const rows = db.prepare(`SELECT id, created_at, repo, content_json FROM audit WHERE event_type = 'wm_reindex' ORDER BY id DESC LIMIT ?`).all(limit);
  const history = rows.map(({ id, created_at, repo, content_json }) => ({ id, created_at, repo, ...parseObject(content_json) }));
  return { repos, history };
}
function withFreshness(body, freshness) {
  return `${body.slice(0, body.lastIndexOf("}"))},"freshness":${JSON.stringify(freshness)}}`;
}

// server/graph-cache.ts
import { createHash, randomUUID } from "node:crypto";
var MAX_ENTRIES = 8;
var entries = /* @__PURE__ */ new Map();
var rollups = 0;
function row(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}
function hasIndexedCommit(db) {
  return db.prepare("PRAGMA table_info(repos)").all().some((c) => c.name === "indexed_commit");
}
function graphStamp(db, repo) {
  if (hasIndexedCommit(db)) {
    const sha = row(db, "SELECT indexed_commit FROM repos WHERE name = ?", repo)?.["indexed_commit"];
    if (sha !== null && sha !== void 0 && String(sha) !== "") return String(sha);
  }
  const t = row(
    db,
    `SELECT (SELECT MAX(rowid) FROM wm_edges) AS em, (SELECT COUNT(*) FROM wm_edges) AS ec,
            (SELECT MAX(rowid) FROM wm_symbols) AS sm, (SELECT COUNT(*) FROM wm_symbols) AS sc,
            (SELECT MAX(updated_at) FROM wm_files WHERE repo = ?) AS files,
            (SELECT last_scanned_at FROM repos WHERE name = ?) AS scanned`,
    repo,
    repo
  );
  const version = row(db, "PRAGMA data_version")?.["data_version"];
  const part = (key) => String(t?.[key] ?? "");
  return `e${part("em")}.${part("ec")}-s${part("sm")}.${part("sc")}-f${part("files")}-t${part("scanned")}-v${String(version ?? "")}`;
}
var PROCESS_NONCE = randomUUID().slice(0, 8);
function graphEtag(repo, stamp, repos) {
  const list = createHash("sha1").update(repos.join("\n")).digest("hex").slice(0, 8);
  return `"${encodeURIComponent(repo)}@${encodeURIComponent(stamp)}.${list}.${PROCESS_NONCE}"`;
}
function etagMatches(header, etag) {
  if (header === void 0) return false;
  const tags = (Array.isArray(header) ? header.join(",") : header).split(",").map((t) => t.trim());
  return tags.some((t) => t === "*" || t.replace(/^W\//, "") === etag);
}
function cachedGraph(db, repo) {
  const scope = graphTarget(db, repo);
  const target = scope?.target;
  if (scope === null || target === void 0) return { body: JSON.stringify(graph(db, repo)), etag: null, hit: false };
  const etag = graphEtag(target, graphStamp(db, target), scope.repos);
  const key = JSON.stringify([target, etag]);
  const found = entries.get(key);
  if (found) {
    entries.delete(key);
    entries.set(key, found);
    return { body: found.body, etag: found.etag, hit: true };
  }
  rollups += 1;
  const entry = { repo: target, body: JSON.stringify(graphRollup(db, scope.repos, target)), etag };
  for (const [k, e] of entries) if (e.repo === target) entries.delete(k);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  return { body: entry.body, etag: entry.etag, hit: false };
}

// ../mcp/trajectory-server/src/tools/trajectory-doctor.ts
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

// ../mcp/trajectory-server/src/data-contracts.ts
import { readdirSync as readdirSync3 } from "node:fs";
import { dirname as dirname5, join as join10 } from "node:path";

// ../mcp/trajectory-server/src/prose-files.ts
var PROSE_SUFFIX = /\.(md|markdown|txt|rst)$/i;
function isProseFile(path) {
  return PROSE_SUFFIX.test(path);
}

// ../mcp/trajectory-server/src/utils/plugin-installs.ts
import { readFileSync as readFileSync5, realpathSync as realpathSync2 } from "node:fs";
import { join as join9 } from "node:path";
function claudeConfigDir(env) {
  return env["CLAUDE_CONFIG_DIR"] || join9(env["HOME"] || "", ".claude");
}
function installedPluginsJsonPath(env = process.env) {
  return env["TMB_INSTALLED_JSON"] || join9(claudeConfigDir(env), "plugins", "installed_plugins.json");
}
function canonicalDir(dir) {
  try {
    return realpathSync2(dir);
  } catch {
    return dir;
  }
}
function readJsonObject(path) {
  try {
    const parsed = JSON.parse(readFileSync5(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function enabledMap(project, env) {
  const files = [
    join9(claudeConfigDir(env), "settings.json"),
    join9(project, ".claude", "settings.json"),
    join9(project, ".claude", "settings.local.json")
  ];
  const merged = {};
  for (const file of files) {
    const plugins = readJsonObject(file)?.["enabledPlugins"];
    if (plugins !== null && typeof plugins === "object" && !Array.isArray(plugins)) Object.assign(merged, plugins);
  }
  return merged;
}
var str = (v) => typeof v === "string" && v !== "" ? v : null;
function enabledPluginCopies(env = process.env) {
  const projectRoot = resolveClaudeProjectRoot(env);
  if (projectRoot === null) return { skipped: "CLAUDE_PROJECT_DIR is unset" };
  const registryPath = installedPluginsJsonPath(env);
  const registry = readJsonObject(registryPath);
  if (registry === null) return { skipped: `cannot read ${registryPath}` };
  const project = canonicalDir(projectRoot);
  const enabled = enabledMap(project, env);
  const prefix = `${resolveClaudePluginName(env)}@`;
  const plugins = registry["plugins"];
  const copies = [];
  if (plugins === null || typeof plugins !== "object") return { copies };
  for (const [key, entries2] of Object.entries(plugins)) {
    if (!key.startsWith(prefix) || enabled[key] !== true || !Array.isArray(entries2)) continue;
    let chosen = null;
    for (const raw of entries2) {
      if (raw === null || typeof raw !== "object") continue;
      const e = raw;
      const scope = str(e["scope"]) ?? "user";
      let rank = 1;
      if (scope === "project" || scope === "local") {
        const projectPath = str(e["projectPath"]);
        if (projectPath === null || canonicalDir(projectPath) !== project) continue;
        rank = 0;
      }
      if (chosen !== null && chosen.rank <= rank) continue;
      chosen = {
        rank,
        copy: { key, marketplace: key.slice(prefix.length), version: str(e["version"]), install_path: str(e["installPath"]), scope }
      };
    }
    if (chosen !== null) copies.push(chosen.copy);
  }
  copies.sort((a, b) => a.marketplace.localeCompare(b.marketplace));
  return { copies };
}

// ../mcp/trajectory-server/src/data-contracts.ts
function singleTmbPluginEnabled(env) {
  const result = enabledPluginCopies(env);
  if ("skipped" in result) return { skipped: result.skipped };
  return { actual: result.copies.length, sample: result.copies.map((c) => ({ ...c })) };
}
function noOtherTrajectoryDbs(env, ctx) {
  const dbPath = ctx.dbPath;
  if (dbPath === void 0 || claudeProjectRootOfDb(dbPath) === null) {
    return { skipped: "the checked DB is not a <project>/.claude/<plugin>/trajectory.db file" };
  }
  const others = otherClaudeDbs(dbPath, {
    sessionDir: env["CLAUDE_PROJECT_DIR"] || process.cwd(),
    ...env["HOME"] ? { home: env["HOME"] } : {}
  });
  if (others === null) return { skipped: "the checked DB has no project root" };
  return {
    actual: others.length,
    sample: others.map((o) => ({ path: o.path, issues: o.issues, tasks: o.tasks }))
  };
}
var SCRATCH_PROSE_SAMPLE = 10;
function scratchNoProse(_env, ctx) {
  if (ctx.dbPath === void 0) return { skipped: "the checked DB has no file behind it" };
  const scratch = join10(dirname5(ctx.dbPath), "scratch");
  let entries2;
  try {
    entries2 = readdirSync3(scratch, { recursive: true, withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return { actual: 0, sample: [] };
    return { skipped: `the scratch folder cannot be read: ${e.message}` };
  }
  const prose = entries2.filter((e) => !e.isDirectory() && isProseFile(e.name)).map((e) => join10(e.parentPath, e.name)).sort();
  return { actual: prose.length, sample: prose.slice(0, SCRATCH_PROSE_SAMPLE).map((path) => ({ path })) };
}
var daysAgo = (days) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${days} days')`;
var hoursAgo = (hours) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${hours} hours')`;
var ts = (column) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column})`;
var auditTaskId = (alias) => `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.task_id') END`;
var auditCommitSha = (alias) => `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.commit_sha') END`;
var SPEC_SHAPE_WAIVER_NOT_READ_BY_GATE = (alias) => `${alias}.event_type = 'spec_shape_gate_waived'
               AND (NOT EXISTS (SELECT 1 FROM tasks t
                                 WHERE t.id = CAST(${auditTaskId(alias)} AS INTEGER)
                                   AND CAST(CAST(${auditTaskId(alias)} AS INTEGER) AS TEXT) = CAST(${auditTaskId(alias)} AS TEXT))
                    OR COALESCE(CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.gate') END, '') <> 'spec_shape')`;
var REVIEW_GRACE_HOURS_DEFAULT = 24;
var UNREVIEWED_CLOSED_TASK = (alias) => `${alias}.status = 'closed' AND ${ts(`${alias}.updated_at`)} >= ${daysAgo(30)}
               AND ${ts(`${alias}.updated_at`)} < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-' || :grace_hours || ' hours')
               AND NOT EXISTS (SELECT 1 FROM validation_attempts v WHERE v.task_id = ${alias}.id AND v.verdict = 'pass')
               AND NOT EXISTS (SELECT 1 FROM audit a WHERE ${reviewSkipAuthoredSql("a")}
                                AND ${auditTaskId("a")} = ${alias}.id)`;
var NOT_AGILE_TASK = (alias) => `COALESCE(${alias}.workflow_mode, 'truest') <> 'agile'`;
var runMatchesTaskCommit = (run, task) => `${run}.task_id = ${task}.id AND substr(${run}.commit_sha, 1, length(${task}.commit_sha)) = ${task}.commit_sha`;
var V36_RECORDING_SINCE = `(SELECT MIN(${ts("started_at")}) FROM verification_runs)`;
var VERIFIED_CLOSE_SCOPE = `t.status = 'closed' AND ${ts("t.updated_at")} >= ${daysAgo(7)}
               AND ${ts("t.updated_at")} >= ${V36_RECORDING_SINCE}
               AND COALESCE(t.commit_sha, '') <> '' AND COALESCE(t.verification, '[]') NOT IN ('', '[]')
               AND NOT EXISTS (SELECT 1 FROM audit w WHERE w.event_type = 'verification_gate_waived' AND ${auditTaskId("w")} = t.id)`;
var UNCONSUMED_STALE_OBSERVATION = (alias) => `${alias}.event_type = 'reviewer_identity_observed' AND ${ts(`${alias}.created_at`)} < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hours')
               AND COALESCE(CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.consumed') END, 0) = 0
               AND COALESCE(CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.superseded') END, 0) = 0`;
var LIVE_TASK_STATUSES2 = "'pending','running','needs_validation','completed'";
var CONCEPTS_SCHEMA = 45;
var COMPLETION_REPORT_SCHEMA = 48;
var PENDING_PROPOSAL_DAYS = 7;
var CONCEPTS_MIN_SYMBOLS = 100;
var SYMBOLS_SCHEMA = 44;
var UNINDEXED_SAMPLE_CAP = 20;
var IN_SYMBOL_SCOPE_SQL = `NOT (path GLOB 'dist/*' OR path GLOB '*/dist/*' OR path GLOB '*.map'
               OR path GLOB 'build/*' OR path GLOB '*/build/*'
               OR path GLOB 'node_modules/*' OR path GLOB '*/node_modules/*'
               OR path GLOB 'vendor/*' OR path GLOB '*/vendor/*' OR path GLOB '*.min.js'
               OR path = 'package-lock.json' OR path GLOB '*/package-lock.json'
               OR path GLOB '*.lock' OR path GLOB '*.lockb')`;
var UNINDEXED_FILES = `wm_files WHERE ${IN_SYMBOL_SCOPE_SQL}
               AND symbols_md5 IS NOT content_md5 || ':' || '${EXTRACTOR_VERSION}'`;
var auditField = (alias, field) => `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.${field}') END`;
var PENDING_PROPOSALS = `tasks t,
               json_each(CASE WHEN json_valid(t.completion_report) THEN t.completion_report ELSE '{}' END, '$.concepts') c
             WHERE t.status = 'closed' AND ${ts("t.updated_at")} < ${daysAgo(PENDING_PROPOSAL_DAYS)}
               AND ${HAS_PASS_SQL}
               AND NOT EXISTS (SELECT 1 FROM audit p
                                WHERE p.event_type IN ('concept_proposal_applied','concept_proposal_rejected')
                                  AND ${auditField("p", "task_id")} = t.id
                                  AND ${auditField("p", "name")} = json_extract(c.value, '$.name'))`;
var CONCEPT_AREA_MIN_FAN_IN_DEFAULT = 50;
var areaOf = (path) => `rtrim(${path}, replace(${path}, '/', ''))`;
var notTestPath = (path) => `${path} NOT LIKE '%test/%' AND ${path} NOT LIKE '%.test.%'`;
var UNCOVERED_HOT_AREAS = `(SELECT d.repo AS repo, ${areaOf("d.path")} AS area, COUNT(*) AS fan_in
               FROM wm_edges e
               JOIN wm_symbols s ON s.id = e.src_id
               JOIN wm_symbols d ON d.id = e.dst_id
              WHERE e.kind = 'calls' AND s.repo = d.repo
                AND ${areaOf("s.path")} <> ${areaOf("d.path")}
                AND ${notTestPath("s.path")} AND ${notTestPath("d.path")}
              GROUP BY d.repo, ${areaOf("d.path")}
             HAVING COUNT(*) >= :min_fan_in) h
             WHERE NOT EXISTS (SELECT 1 FROM wm_concepts k JOIN wm_concept_steps p ON p.concept_id = k.id
                                WHERE k.status = 'verified' AND p.repo = h.repo AND ${areaOf("p.path")} = h.area)`;
var UNCONCEPTUALIZED_REPOS = `(SELECT repo, COUNT(*) AS symbols FROM wm_symbols GROUP BY repo HAVING COUNT(*) >= ${CONCEPTS_MIN_SYMBOLS}) s
             WHERE NOT EXISTS (SELECT 1 FROM wm_concepts k WHERE k.repo = s.repo AND k.status <> 'retired')`;
var FIXTURE_INVENTORY_ROW = (alias) => `${alias}.kind IN ('plugin','mcp')
               AND (${alias}.name IN ('alpha','beta','alpha-server')
                    OR ${alias}.name GLOB 'fixture-*' OR ${alias}.name GLOB 'test-plugin*'
                    OR COALESCE(${alias}.source_url, '') LIKE '%@tmb-test-market')`;
var V33_RUN_WRITERS_SINCE = {
  sql: `(SELECT MIN(${ts("started_at")}) FROM agent_runs WHERE root_dir IS NOT NULL)`,
  label: "the first run carrying a root_dir",
  min_schema: 33
};
var NOT_PER_TASK_BRO_ROW = "NOT (agent_type = 'bro' AND task_id IS NOT NULL)";
var BRO_SESSION_ROW = "agent_type = 'bro' AND task_id IS NULL";
var POPULATED_COLUMNS = [
  { table: "agent_runs", column: "session_id", created_column: "started_at", writer_since: V33_RUN_WRITERS_SINCE, floor: 0.2, min_schema: 30 },
  { table: "agent_runs", column: "usage_source", created_column: "started_at", scope: "completed_at IS NOT NULL", scope_label: "completed rows", floor: 0.05, min_schema: 30 },
  { table: "agent_runs", column: "model", created_column: "started_at", scope: "usage_source IN ('transcript','subagent_stop','backfill')", scope_label: "measured rows", writer_since: V33_RUN_WRITERS_SINCE, floor: 0.1, min_schema: 33 },
  { table: "agent_runs", column: "host", created_column: "started_at", floor: 0, min_schema: 33 },
  { table: "agent_runs", column: "root_dir", created_column: "started_at", writer_since: V33_RUN_WRITERS_SINCE, floor: 0.05, min_schema: 33 },
  { table: "agent_runs", column: "exit_reason", created_column: "started_at", scope: "completed_at IS NOT NULL", scope_label: "completed rows", floor: 0.05, min_schema: 33 },
  { table: "tasks", column: "prompt_bearing", created_column: "created_at", floor: 0, min_schema: 0 },
  // The v37 migration keeps no applied-at timestamp, so the first run carrying
  // an effort anchors the window: runs metered before v37 stay NULL by design.
  {
    table: "agent_runs",
    column: "effort",
    created_column: "started_at",
    scope: `agent_type IN ('swe','code-reviewer') AND usage_source = 'subagent_stop'
               AND ${ts("started_at")} >= (SELECT MIN(${ts("started_at")}) FROM agent_runs WHERE effort IS NOT NULL)`,
    scope_label: "SubagentStop-metered swe/code-reviewer rows since the first run carrying an effort",
    floor: 0.05,
    min_schema: 37
  }
];
function populatedContract(c) {
  const where = [
    `${ts(c.created_column)} >= ${daysAgo(30)}`,
    ...c.writer_since ? [`${ts(c.created_column)} >= ${c.writer_since.sql}`] : [],
    ...c.table === "agent_runs" ? [NOT_PER_TASK_BRO_ROW] : [],
    ...c.scope ? [c.scope] : []
  ].join(" AND ");
  const since = c.writer_since ? ` and not before ${c.writer_since.label}` : "";
  const excluded = c.table === "agent_runs" ? ", per-task bro rows excluded" : "";
  const minSchema = Math.max(c.min_schema, c.writer_since?.min_schema ?? 0);
  return {
    id: `populated_${c.table}_${c.column}`,
    severity: "warn",
    description: `${c.table}.${c.column} NULL rate over ${c.scope_label ?? "rows"} created in the last 30 days${since}${excluded} stays at or under ${c.floor}`,
    sql: `SELECT COALESCE(AVG(CASE WHEN ${c.column} IS NULL THEN 1.0 ELSE 0.0 END), 0) FROM ${c.table} WHERE ${where}`,
    expect: { op: "<=", value: c.floor },
    sample_sql: `SELECT id FROM ${c.table} WHERE ${where} AND ${c.column} IS NULL ORDER BY id DESC LIMIT 5`,
    ...minSchema > 0 ? { min_schema: minSchema } : {}
  };
}
function eventTypeList(types) {
  for (const t of types) {
    if (!/^[a-z][a-z0-9_]*$/.test(t)) throw new Error(`data-contracts: invalid documented event type '${t}'`);
  }
  return types.map((t) => `'${t}'`).join(",");
}
function buildDataContracts(documentedEventTypes) {
  const events = eventTypeList(documentedEventTypes);
  return [
    {
      id: "fk_check_empty",
      severity: "error",
      description: "PRAGMA foreign_key_check reports no dangling foreign key",
      sql: "SELECT COUNT(*) FROM pragma_foreign_key_check",
      expect: { op: "=", value: 0 },
      sample_sql: 'SELECT "table" AS child_table, rowid, parent FROM pragma_foreign_key_check LIMIT 5'
    },
    {
      id: "event_type_documented",
      severity: "error",
      min_schema: 38,
      description: "every audit.event_type is in the documented event set",
      sql: `SELECT COUNT(*) FROM audit WHERE event_type NOT IN (${events})`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT event_type, COUNT(*) AS n FROM audit WHERE event_type NOT IN (${events}) GROUP BY event_type ORDER BY n DESC LIMIT 5`
    },
    {
      id: "swe_runs_metered",
      severity: "error",
      min_schema: 30,
      description: "swe/code-reviewer agent_runs completed in the last 7 days and not marked unmeasured carry tokens",
      sql: `SELECT COUNT(*) FROM agent_runs
             WHERE agent_type IN ('swe','code-reviewer') AND completed_at IS NOT NULL AND ${ts("completed_at")} >= ${daysAgo(7)}
               AND (usage_source IS NULL OR usage_source <> 'unmeasured')
               AND COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0
               AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT id, task_id, agent_type, usage_source, completed_at FROM agent_runs
             WHERE agent_type IN ('swe','code-reviewer') AND completed_at IS NOT NULL AND ${ts("completed_at")} >= ${daysAgo(7)}
               AND (usage_source IS NULL OR usage_source <> 'unmeasured')
               AND COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0
               AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0
             ORDER BY id DESC LIMIT 5`
    },
    {
      id: "bro_session_runs_metered",
      severity: "error",
      min_schema: 33,
      description: "bro session agent_runs (task_id NULL) started in the last 7 days carry session_id, model, tokens_out and usage_source",
      sql: `SELECT COUNT(*) FROM agent_runs
             WHERE ${BRO_SESSION_ROW} AND ${ts("started_at")} >= ${daysAgo(7)}
               AND (session_id IS NULL OR model IS NULL OR COALESCE(tokens_out, 0) = 0 OR usage_source IS NULL)`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT id, session_id, model, tokens_out, usage_source, started_at FROM agent_runs
             WHERE ${BRO_SESSION_ROW} AND ${ts("started_at")} >= ${daysAgo(7)}
               AND (session_id IS NULL OR model IS NULL OR COALESCE(tokens_out, 0) = 0 OR usage_source IS NULL)
             ORDER BY id DESC LIMIT 5`
    },
    {
      id: "closed_tasks_reviewed",
      severity: "error",
      min_schema: 66,
      description: "tasks closed in the last 30 days and more than TMB_REVIEW_GRACE_HOURS (default 24) ago have a passing code-reviewer verdict, a bro-written review_gate_waived row, or a review_gate_bypassed row from bro or hook:close-issue-on-merge (bro_atomic_close closes only after a pass, so an unreviewed close came another way: task_recover, task_update_status or a task closed before the review-first order; tasks has no closed_at, so the close time is updated_at). Tasks closed under workflow_mode agile are counted by agile_review_queued instead",
      sql: `SELECT COUNT(*) FROM tasks t
             WHERE ${UNREVIEWED_CLOSED_TASK("t")} AND ${NOT_AGILE_TASK("t")}`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT t.id, t.issue_id, t.branch_id, t.updated_at FROM tasks t
             WHERE ${UNREVIEWED_CLOSED_TASK("t")} AND ${NOT_AGILE_TASK("t")}
             ORDER BY t.id DESC LIMIT 5`,
      params: [{ name: "grace_hours", env: "TMB_REVIEW_GRACE_HOURS", default: REVIEW_GRACE_HOURS_DEFAULT }]
    },
    {
      id: "agile_review_queued",
      severity: "warn",
      min_schema: 66,
      description: "tasks closed under workflow_mode agile in the last 30 days and more than TMB_REVIEW_GRACE_HOURS (default 24) ago with no passing code-reviewer verdict, bro-written review_gate_waived row, or review_gate_bypassed row from bro or hook:close-issue-on-merge; the observed value is the size of the queued-review backlog",
      sql: `SELECT COUNT(*) FROM tasks t
             WHERE ${UNREVIEWED_CLOSED_TASK("t")} AND t.workflow_mode = 'agile'`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT t.id, t.issue_id, t.branch_id, t.updated_at FROM tasks t
             WHERE ${UNREVIEWED_CLOSED_TASK("t")} AND t.workflow_mode = 'agile'
             ORDER BY t.id DESC LIMIT 5`,
      params: [{ name: "grace_hours", env: "TMB_REVIEW_GRACE_HOURS", default: REVIEW_GRACE_HOURS_DEFAULT }]
    },
    {
      id: "no_stale_running",
      severity: "warn",
      description: "no running task has gone TMB_STALE_RUNNING_HOURS (default 6) without an update and without an open swe agent_runs row",
      sql: `SELECT COUNT(*) FROM tasks t
             WHERE t.status = 'running' AND ${ts("t.updated_at")} < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-' || :stale_hours || ' hours')
               AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.task_id = t.id AND r.agent_type = 'swe' AND r.completed_at IS NULL)`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT t.id, t.issue_id, t.updated_at FROM tasks t
             WHERE t.status = 'running' AND ${ts("t.updated_at")} < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-' || :stale_hours || ' hours')
               AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.task_id = t.id AND r.agent_type = 'swe' AND r.completed_at IS NULL)
             ORDER BY t.id LIMIT 5`,
      params: [{ name: "stale_hours", env: "TMB_STALE_RUNNING_HOURS", default: STALE_RUNNING_HOURS_DEFAULT }]
    },
    {
      id: "scan_fresh",
      severity: "warn",
      description: "some repo was scanned in the last 7 days (1 when fresh; passes with no repo row)",
      sql: `SELECT CASE WHEN COUNT(*) = 0 THEN 1 WHEN MAX(${ts("last_scanned_at")}) >= ${daysAgo(7)} THEN 1 ELSE 0 END FROM repos`,
      expect: { op: ">=", value: 1 },
      sample_sql: `SELECT name, last_scanned_at FROM repos ORDER BY last_scanned_at DESC LIMIT 5`
    },
    {
      id: "waiver_not_duplicated",
      severity: "warn",
      description: "no (task_id, commit_sha) carries more than one verification_gate_waived row",
      sql: `SELECT COUNT(*) FROM (SELECT 1 FROM audit a WHERE a.event_type = 'verification_gate_waived'
             GROUP BY ${auditTaskId("a")}, COALESCE(${auditCommitSha("a")}, '') HAVING COUNT(*) > 1)`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT ${auditTaskId("a")} AS task_id, ${auditCommitSha("a")} AS commit_sha, COUNT(*) AS n FROM audit a
             WHERE a.event_type = 'verification_gate_waived'
             GROUP BY ${auditTaskId("a")}, COALESCE(${auditCommitSha("a")}, '') HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 5`
    },
    {
      id: "spec_shape_waived_rows_name_a_task",
      severity: "warn",
      description: "every spec_shape_gate_waived row names an existing task with gate spec_shape: content_json.task_id is a positive integer (or its decimal string) matching a tasks row and content_json.gate is spec_shape, the only shape require-task-spec reads as a spawn waiver",
      sql: `SELECT COUNT(*) FROM audit a
             WHERE ${SPEC_SHAPE_WAIVER_NOT_READ_BY_GATE("a")}`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT a.id, a.issue_id, a.from_node, a.created_at, a.content_json FROM audit a
             WHERE ${SPEC_SHAPE_WAIVER_NOT_READ_BY_GATE("a")}
             ORDER BY a.id DESC LIMIT 5`
    },
    {
      id: "no_unconsumed_reviewer_observations",
      severity: "warn",
      description: "no reviewer_identity_observed row older than 1 hour is still unconsumed and unsuperseded (a code-reviewer validation_record call that never recorded a verdict)",
      sql: `SELECT COUNT(*) FROM audit o
             WHERE ${UNCONSUMED_STALE_OBSERVATION("o")}`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT o.id, o.issue_id, o.created_at, o.content_json FROM audit o
             WHERE ${UNCONSUMED_STALE_OBSERVATION("o")}
             ORDER BY o.id DESC LIMIT 5`
    },
    {
      id: "embeddings_not_degraded",
      severity: "warn",
      min_schema: 33,
      description: "no embeddings_degraded audit row from the last 24 hours lacks a later embeddings_recovered row (semantic search is falling back to FTS)",
      sql: `SELECT COUNT(*) FROM audit d
             WHERE d.event_type = 'embeddings_degraded' AND ${ts("d.created_at")} >= ${daysAgo(1)}
               AND NOT EXISTS (SELECT 1 FROM audit r WHERE r.event_type = 'embeddings_recovered' AND r.id > d.id)`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT d.id, d.created_at, d.content_json FROM audit d
             WHERE d.event_type = 'embeddings_degraded' AND ${ts("d.created_at")} >= ${daysAgo(1)}
               AND NOT EXISTS (SELECT 1 FROM audit r WHERE r.event_type = 'embeddings_recovered' AND r.id > d.id)
             ORDER BY d.id DESC LIMIT 5`
    },
    {
      id: "verification_recorded_for_closed_tasks",
      severity: "warn",
      min_schema: 36,
      description: "tasks closed in the last 7 days, and not before the first recorded verification run, with a commit_sha, a non-empty verification[] and no verification_gate_waived row have a verification_runs row for that commit (the close gate records one per run); skipped while no run is recorded",
      skip_when: { sql: "SELECT COUNT(*) = 0 FROM verification_runs", reason: "no_verification_runs_recorded" },
      sql: `SELECT COUNT(*) FROM tasks t
             WHERE ${VERIFIED_CLOSE_SCOPE}
               AND NOT EXISTS (SELECT 1 FROM verification_runs r WHERE ${runMatchesTaskCommit("r", "t")})`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT t.id, t.issue_id, t.commit_sha, t.updated_at FROM tasks t
             WHERE ${VERIFIED_CLOSE_SCOPE}
               AND NOT EXISTS (SELECT 1 FROM verification_runs r WHERE ${runMatchesTaskCommit("r", "t")})
             ORDER BY t.id DESC LIMIT 5`
    },
    {
      id: "no_unfinished_verification_runs",
      severity: "warn",
      min_schema: 36,
      description: "no verification_runs row started more than 2 hours ago is still unfinished (finished_at NULL: the gate was killed, or its finish write failed after its retries)",
      sql: `SELECT COUNT(*) FROM verification_runs
             WHERE finished_at IS NULL AND ${ts("started_at")} < ${hoursAgo(2)}`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT id, task_id, commit_sha, source, started_at FROM verification_runs
             WHERE finished_at IS NULL AND ${ts("started_at")} < ${hoursAgo(2)}
             ORDER BY id DESC LIMIT 5`
    },
    {
      id: "review_findings_resolved_at_matches_status",
      severity: "warn",
      min_schema: 47,
      description: "every fixed review_findings row has resolved_at and no open one does (the verification gate sets both when an open finding's probe passes)",
      sql: `SELECT COUNT(*) FROM review_findings
             WHERE (status = 'fixed' AND resolved_at IS NULL) OR (status = 'open' AND resolved_at IS NOT NULL)`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT id, task_id, attempt_n, status, resolved_at FROM review_findings
             WHERE (status = 'fixed' AND resolved_at IS NULL) OR (status = 'open' AND resolved_at IS NOT NULL)
             ORDER BY created_at DESC LIMIT 5`
    },
    {
      id: "no_fixture_rows_in_inventory",
      severity: "warn",
      description: "no plugin or MCP-server cheatcodes row carries a scan test-fixture name (alpha, beta, alpha-server, fixture-*, test-plugin*, or a <name>@tmb-test-market ref): such a row means a test's scan reached this DB; report only \u2014 agents never delete these rows, the Human decides",
      sql: `SELECT COUNT(*) FROM cheatcodes c
             WHERE ${FIXTURE_INVENTORY_ROW("c")}`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT c.id, c.name, c.kind, c.source_url, c.created_at FROM cheatcodes c
             WHERE ${FIXTURE_INVENTORY_ROW("c")}
             ORDER BY c.id DESC LIMIT 5`
    },
    ...POPULATED_COLUMNS.map(populatedContract),
    {
      id: "issues_closed_no_live_tasks",
      severity: "error",
      description: "no closed issue still has a pending/running/needs_validation/completed task",
      sql: `SELECT COUNT(DISTINCT i.id) FROM issues i JOIN tasks t ON t.issue_id = i.id
             WHERE i.status = 'closed' AND t.status IN (${LIVE_TASK_STATUSES2})`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT i.id AS issue_id, t.id AS task_id, t.status FROM issues i JOIN tasks t ON t.issue_id = i.id
             WHERE i.status = 'closed' AND t.status IN (${LIVE_TASK_STATUSES2}) ORDER BY i.id DESC, t.id LIMIT 5`
    },
    {
      id: "issues_open_after_remote_close",
      severity: "warn",
      description: "no open issue carries an issue_remote_closed_local_open audit row (issue_reconcile_remote found its GitHub/GitLab twin closed but left it open for live tasks): once those tasks close, rerun issue_reconcile_remote to close it",
      sql: `SELECT COUNT(DISTINCT i.id) FROM issues i JOIN audit a ON a.issue_id = i.id
             WHERE i.status = 'open' AND a.event_type = 'issue_remote_closed_local_open'`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT i.id AS issue_id, ${auditField("a", "remote_iid")} AS remote_iid, ${auditField("a", "blocking_task_ids")} AS blocking_task_ids
             FROM issues i JOIN audit a ON a.issue_id = i.id
             WHERE i.status = 'open' AND a.event_type = 'issue_remote_closed_local_open'
               AND a.id = (SELECT MAX(b.id) FROM audit b WHERE b.issue_id = i.id AND b.event_type = 'issue_remote_closed_local_open')
             ORDER BY i.id DESC LIMIT 5`
    },
    {
      id: "concepts_trusted",
      severity: "warn",
      min_schema: CONCEPTS_SCHEMA,
      description: "no L2 concept is suspect or broken (a scan found an anchored step changed or gone, or a claim failing): re-verify it with world_model_concept_upsert or retire it",
      sql: `SELECT COUNT(*) FROM wm_concepts WHERE status IN ('suspect','broken')`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT id, repo, name, status, status_reason FROM wm_concepts WHERE status IN ('suspect','broken') ORDER BY id DESC LIMIT 5`
    },
    {
      id: "concepts_cover_hot_areas",
      severity: "warn",
      min_schema: CONCEPTS_SCHEMA,
      description: `no directory reached by TMB_CONCEPT_AREA_MIN_FAN_IN (default ${CONCEPT_AREA_MIN_FAN_IN_DEFAULT}) or more calls from other directories of its repo (test code excluded on both ends) lacks a step of a verified L2 concept: write a concept for the area with world_model_concept_upsert, or raise TMB_CONCEPT_AREA_MIN_FAN_IN`,
      sql: `SELECT COUNT(*) FROM ${UNCOVERED_HOT_AREAS}`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT h.repo, h.area, h.fan_in FROM ${UNCOVERED_HOT_AREAS} ORDER BY h.fan_in DESC, h.repo, h.area LIMIT 5`,
      params: [{ name: "min_fan_in", env: "TMB_CONCEPT_AREA_MIN_FAN_IN", default: CONCEPT_AREA_MIN_FAN_IN_DEFAULT }]
    },
    {
      id: "concept_proposals_not_stale",
      severity: "warn",
      min_schema: COMPLETION_REPORT_SCHEMA,
      description: `no concept a closed, reviewed task proposed in its completion report (report.concepts) is still pending \u2014 no concept_proposal_applied or concept_proposal_rejected row for its task and name \u2014 ${PENDING_PROPOSAL_DAYS} days after the close (tasks has no closed_at, so the close time is updated_at): scan_run applies a proposal once its anchors are in the scanned checkout's index`,
      sql: `SELECT COUNT(*) FROM ${PENDING_PROPOSALS}`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT t.id AS task_id, json_extract(c.value, '$.name') AS name, t.updated_at FROM ${PENDING_PROPOSALS} ORDER BY t.id DESC LIMIT 5`
    },
    {
      id: "concept_proposals_not_rejected",
      severity: "warn",
      description: "no concept_proposal_rejected row from the last 30 days (a reviewed task's concept proposal still failed to upsert 14 days after its close; content_json.error names why)",
      sql: `SELECT COUNT(*) FROM audit a WHERE a.event_type = 'concept_proposal_rejected' AND ${ts("a.created_at")} >= ${daysAgo(30)}`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT a.id, a.issue_id, a.created_at, a.content_json FROM audit a
             WHERE a.event_type = 'concept_proposal_rejected' AND ${ts("a.created_at")} >= ${daysAgo(30)}
             ORDER BY a.id DESC LIMIT 5`
    },
    {
      id: "concepts_cover_indexed_repos",
      severity: "warn",
      min_schema: CONCEPTS_SCHEMA,
      description: `no repo with ${CONCEPTS_MIN_SYMBOLS} or more wm_symbols rows has no live (non-retired) wm_concepts row: the L1 index is there but nobody has written its L2 concepts`,
      sql: `SELECT COUNT(*) FROM ${UNCONCEPTUALIZED_REPOS}`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT s.repo, s.symbols FROM ${UNCONCEPTUALIZED_REPOS} ORDER BY s.symbols DESC LIMIT 5`
    },
    {
      id: "wm_files_symbols_indexed",
      severity: "warn",
      min_schema: SYMBOLS_SCHEMA,
      description: `every in-symbol-scope wm_files row is indexed at this extractor version (symbols_md5 = content_md5:${EXTRACTOR_VERSION}). A row stamped '${FAILED_SUFFIX}' threw on read or extraction and stays out of the symbol index until its content changes (indexRepoSymbols' failed_paths names the error); an unstamped or stale row was skipped because its repo's symbol pass threw (scan_run's symbols.error) \u2014 rerun scan_run`,
      sql: `SELECT COUNT(*) FROM ${UNINDEXED_FILES}`,
      expect: { op: "=", value: 0 },
      sample_sql: `SELECT repo, path,
             CASE WHEN symbols_md5 GLOB '*${FAILED_SUFFIX}' THEN 'failed' WHEN symbols_md5 IS NULL THEN 'unstamped' ELSE 'stale' END AS state,
             updated_at FROM ${UNINDEXED_FILES} ORDER BY updated_at DESC, repo, path LIMIT ${UNINDEXED_SAMPLE_CAP}`
    },
    {
      source: "files",
      id: "single_tmb_plugin_enabled",
      severity: "error",
      description: "at most one enabled copy of this plugin applies to CLAUDE_PROJECT_DIR (installed_plugins.json + enabledPlugins in the project settings.local.json / settings.json and the user settings.json, read-only); Claude Code registers the hooks of only one copy per manifest name, so a second copy silently drops TMB's gates \u2014 from the project root, run `claude plugin disable <plugin>@<marketplace> --scope <scope>` for the extra copy, then fully quit and relaunch Claude Code. Skipped when CLAUDE_PROJECT_DIR is unset or installed_plugins.json is unreadable",
      // cli-config-scope: printed
      expect: { op: "<=", value: 1 },
      check: singleTmbPluginEnabled
    },
    {
      source: "files",
      id: "no_other_trajectory_dbs",
      severity: "warn",
      description: `no other live trajectory DB sits on the walk from CLAUDE_PROJECT_DIR up to the project root, or below the project root within ${STRAY_DB_MAX_DEPTH} levels; a nested DB splits the project's issues and tasks \u2014 each sample names the DB path with its issue and task counts, and /onboard offers to remove an empty one. A DB marked standalone is its own project and is not counted. Skipped when the checked DB is not a <project>/.claude/<plugin>/trajectory.db file`,
      expect: { op: "=", value: 0 },
      check: noOtherTrajectoryDbs
    },
    {
      source: "files",
      id: "scratch_no_prose",
      severity: "warn",
      description: "no prose file (.md, .markdown, .txt, .rst) sits under the scratch folder beside the checked DB, at any depth: plans, decisions, specs and drafts live in the trajectory DB, so move each sampled file there with issue_update_description, discussion_append or task_update_spec, then delete it. Skipped when the checked DB has no file behind it",
      expect: { op: "=", value: 0 },
      check: scratchNoProse
    }
  ];
}
var DATA_CONTRACTS = buildDataContracts(AUDIT_EVENT_TYPES.map((e) => e.type));
var DATA_CONTRACTS_SCHEMA_VERSION = Math.max(0, ...DATA_CONTRACTS.map((c) => c.min_schema ?? 0));
function schemaTooOldReason(stored, required) {
  return `schema v${stored} < v${required} \u2014 start the trajectory server to migrate`;
}
function contractHolds(actual, expect) {
  if (actual === null || !Number.isFinite(actual)) return false;
  switch (expect.op) {
    case "=":
      return actual === expect.value;
    case "<=":
      return actual <= expect.value;
    case ">=":
      return actual >= expect.value;
  }
}
function contractParamValues(contract, env = process.env) {
  const values = {};
  for (const p of contract.params ?? []) {
    const raw = Number(env[p.env]);
    values[p.name] = Number.isFinite(raw) && raw > 0 ? raw : p.default;
  }
  return values;
}

// ../mcp/trajectory-server/src/tools/trajectory-doctor.ts
var STATEMENT_TIMEOUT_MS_DEFAULT = 2e3;
var bind = (params) => Object.keys(params).length > 0 ? [params] : [];
function sqliteReader(conn) {
  return {
    get: (sql, params) => conn.prepare(sql).get(...bind(params)),
    all: (sql, params) => conn.prepare(sql).all(...bind(params))
  };
}
function statementTimeoutMs(env = process.env) {
  const raw = Number(env["TMB_DOCTOR_STATEMENT_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : STATEMENT_TIMEOUT_MS_DEFAULT;
}
function readSchemaVersion(reader) {
  try {
    return firstNumber(reader.get("SELECT schema_version FROM plugin_meta LIMIT 1", {}));
  } catch {
    return null;
  }
}
function firstNumber(row2) {
  if (row2 === void 0) return null;
  const value = Object.values(row2)[0];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}
function runDataContracts(reader, contracts, opts = {}) {
  const timeoutMs = opts.statementTimeoutMs ?? statementTimeoutMs(opts.env);
  const now2 = opts.now ?? (() => performance.now());
  const stored = readSchemaVersion(reader);
  const required = Math.max(0, ...contracts.map((c) => c.min_schema ?? 0));
  const report = {
    healthy: true,
    checked_at: nowISO(),
    schema: { stored, required, current: stored === null || stored >= required },
    violations: [],
    skipped: []
  };
  for (const contract of contracts) {
    if (contract.source === "files") {
      const result = contract.check(opts.env ?? process.env, opts.dbPath === void 0 ? {} : { dbPath: opts.dbPath });
      if ("skipped" in result) {
        report.skipped.push({ id: contract.id, reason: result.skipped });
        continue;
      }
      if (contractHolds(result.actual, contract.expect)) continue;
      report.violations.push({
        id: contract.id,
        severity: contract.severity,
        description: contract.description,
        actual: result.actual,
        expected: contract.expect,
        sample: result.sample
      });
      if (contract.severity === "error") report.healthy = false;
      continue;
    }
    if (stored !== null && (contract.min_schema ?? 0) > stored) {
      report.skipped.push({ id: contract.id, reason: schemaTooOldReason(stored, contract.min_schema) });
      if (contract.severity === "error") report.healthy = false;
      continue;
    }
    const params = contractParamValues(contract, opts.env);
    const started = now2();
    let actual;
    try {
      if (contract.skip_when && firstNumber(reader.get(contract.skip_when.sql, params))) {
        report.skipped.push({ id: contract.id, reason: contract.skip_when.reason });
        continue;
      }
      actual = firstNumber(reader.get(contract.sql, params));
    } catch (e) {
      report.skipped.push({ id: contract.id, reason: `error: ${e.message}` });
      if (contract.severity === "error") report.healthy = false;
      continue;
    }
    const elapsed = Math.round(now2() - started);
    if (elapsed > timeoutMs) {
      report.skipped.push({ id: contract.id, reason: `timeout: ${elapsed}ms > ${timeoutMs}ms` });
      if (contract.severity === "error") report.healthy = false;
      continue;
    }
    if (contractHolds(actual, contract.expect)) continue;
    let sample = [];
    if (contract.sample_sql) {
      try {
        sample = reader.all(contract.sample_sql, params);
      } catch {
        sample = [];
      }
    }
    report.violations.push({
      id: contract.id,
      severity: contract.severity,
      description: contract.description,
      actual,
      expected: contract.expect,
      sample
    });
    if (contract.severity === "error") report.healthy = false;
  }
  return report;
}
function openReadOnly(dbPath, timeoutMs) {
  if (!dbPath || dbPath === ":memory:") return null;
  for (const readOnly2 of [true, false]) {
    let conn = null;
    try {
      conn = new DatabaseSync3(dbPath, { readOnly: readOnly2 });
      conn.exec(`PRAGMA busy_timeout = ${Math.floor(timeoutMs)}`);
      conn.exec("PRAGMA query_only = ON");
      conn.prepare("SELECT COUNT(*) FROM sqlite_master").get();
      return conn;
    } catch {
      conn?.close();
    }
  }
  return null;
}
function selectContracts(ids) {
  if (ids === void 0) return { contracts: DATA_CONTRACTS };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return { error: "ids must be an array of contract id strings" };
  }
  const known = DATA_CONTRACTS.map((c) => c.id);
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length > 0) return { error: `unknown contract id(s): ${unknown.join(", ")}`, known_ids: known };
  const wanted = new Set(ids);
  return { contracts: DATA_CONTRACTS.filter((c) => wanted.has(c.id)) };
}
function checkTrajectoryDbFile(dbPath, contracts = DATA_CONTRACTS, opts = {}) {
  const timeoutMs = statementTimeoutMs(opts.env);
  const conn = openReadOnly(dbPath, timeoutMs);
  if (!conn) throw new Error(`cannot open ${dbPath} read-only`);
  try {
    return runDataContracts(sqliteReader(conn), contracts, { statementTimeoutMs: timeoutMs, env: opts.env, dbPath });
  } finally {
    conn.close();
  }
}

// server/health.ts
var EMBEDDED_SOURCES = [
  ["discussions", "discussions_embeddings", "discussion_id"],
  ["audit", "audit_embeddings", "audit_id"],
  ["wm_directories", "wm_directories_embeddings", "dir_id"],
  ["wm_files", "wm_files_embeddings", "file_id"]
];
function hasTable2(db, name) {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== void 0;
}
function countBy(db, table, column) {
  if (!hasTable2(db, table)) return {};
  const rows = db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column} ORDER BY ${column}`).all();
  return Object.fromEntries(rows.map((r) => [String(r["k"]), Number(r["n"])]));
}
var bind2 = (params) => Object.keys(params).length > 0 ? [params] : [];
function connectionReader(db) {
  return {
    get: (sql, params) => db.prepare(sql).get(...bind2(params)),
    all: (sql, params) => db.prepare(sql).all(...bind2(params))
  };
}
function dbFile(db) {
  const main2 = db.prepare("PRAGMA database_list").all().find((r) => r["name"] === "main");
  return String(main2?.["file"] ?? "");
}
function doctorReport(db, dbPath, contracts) {
  try {
    return checkTrajectoryDbFile(dbPath, contracts);
  } catch {
    return runDataContracts(connectionReader(db), contracts, { dbPath });
  }
}
function contractResults(db, dbPath) {
  const selected = selectContracts(void 0);
  if ("error" in selected) throw new Error(selected.error);
  const report = doctorReport(db, dbPath, selected.contracts);
  const violations = new Map(report.violations.map((v) => [v.id, v]));
  const skipped = new Map(report.skipped.map((s) => [s.id, s.reason]));
  const contracts = selected.contracts.map((c) => {
    const violation = violations.get(c.id);
    const reason = skipped.get(c.id) ?? null;
    return {
      id: c.id,
      severity: c.severity,
      description: c.description,
      ok: violation ? false : reason === null ? true : null,
      skipped: reason,
      actual: violation?.actual ?? null,
      expected: c.expect
    };
  });
  return { healthy: report.healthy, checked_at: report.checked_at, contracts };
}
function embeddingCounts(db) {
  return EMBEDDED_SOURCES.filter(([source, vectors]) => hasTable2(db, source) && hasTable2(db, vectors)).map(([source, vectors, key]) => {
    const row2 = db.prepare(`SELECT (SELECT COUNT(*) FROM ${source}) AS rows, (SELECT COUNT(*) FROM ${vectors} v JOIN ${source} s ON s.id = v.${key}) AS embedded`).get();
    return { source, rows: Number(row2["rows"]), embedded: Number(row2["embedded"]) };
  });
}
function health(db, dbPath) {
  const { healthy, checked_at, contracts } = contractResults(db, dbPath);
  return {
    checked_at,
    healthy,
    schema: { version: schemaVersion(db), target: TARGET_SCHEMA_VERSION },
    contracts,
    freshness: wmRepos(db).map((repo) => ({ repo, freshness: freshnessBlock(db, repo) })),
    concepts: { by_status: countBy(db, "wm_concepts", "status"), steps_by_trust: countBy(db, "wm_concept_steps", "trust") },
    embeddings: embeddingCounts(db)
  };
}

// server/no-embeddings.ts
var noEmbeddings = () => Promise.reject(new Error("embeddings are not loaded in the dashboard"));

// server/main.ts
setEmbeddingLoader(noEmbeddings);
var HOST2 = "127.0.0.1";
var DEFAULT_PORT = 7477;
var WEB_ROOT = fileURLToPath2(new URL("./web/", import.meta.url));
var MAX_BODY_BYTES2 = 2 * 1024 * 1024;
var MAX_DRAIN_BYTES = 4 * MAX_BODY_BYTES2;
var DRAIN_TIMEOUT_MS = 2e3;
var TOKEN_HEADER = "x-tmb-token";
var CHANGELOG = process.env["TMB_DASHBOARD_CHANGELOG"] || fileURLToPath2(new URL("../../CHANGELOG.md", import.meta.url));
var RELEASES = loadReleases(CHANGELOG);
var INTERNAL_ERROR = { error: "internal_error", message: "the dashboard server hit an error; its terminal has the details" };
var CHANGE_IMPACT_WORKER = new URL("./change-impact-worker.mjs", import.meta.url);
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json"
};
function parsePort(raw) {
  if (raw === void 0 || raw.trim() === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`TMB_DASHBOARD_PORT must be an integer 0-65535, got "${raw}"`);
  }
  return port;
}
function openDb(path) {
  if (path === ":memory:" || !existsSync3(path)) {
    throw new Error(
      `No trajectory DB at ${path}. Run from an onboarded project or set TRAJECTORY_DB_PATH.`
    );
  }
  return new DatabaseSync4(path, { readOnly: true });
}
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function clampLimit(raw) {
  const n = Number(raw ?? 100);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), 1e3) : 100;
}
var CHANGE_IMPACT_LIMIT = 20;
var CHANGE_IMPACT_MAX_LIMIT = 100;
var UNKNOWN_CHANGE = /^unknown change /;
var AMBIGUOUS_CHANGE = /^ambiguous change /;
function workerError({ error, stack }) {
  const err4 = new Error(error);
  if (stack !== void 0) err4.stack = stack;
  return err4;
}
function runChangeImpact(job) {
  return new Promise((resolve4, reject) => {
    const worker = new Worker(CHANGE_IMPACT_WORKER, { workerData: job });
    worker.once("message", (reply) => "error" in reply ? reject(workerError(reply)) : resolve4(reply.result));
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`change impact worker exited with code ${code} before replying`)));
  });
}
async function changeImpact(dbPath, p) {
  const source = p.get("source");
  const id = p.get("id");
  const repo = p.get("repo");
  const rawLimit = p.get("limit");
  if (source !== null && !CHANGE_SOURCES.includes(source)) {
    return { status: 400, body: { error: `source must be one of ${CHANGE_SOURCES.join(", ")}` } };
  }
  if (id !== null && source === null) return { status: 400, body: { error: "id needs source" } };
  if (id === "") return { status: 400, body: { error: "id must be non-empty" } };
  if (repo !== null && id === null) return { status: 400, body: { error: "repo needs id" } };
  if (repo === "") return { status: 400, body: { error: "repo must be non-empty" } };
  if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) return { status: 400, body: { error: "limit must be a positive integer" } };
  const limit = rawLimit === null ? CHANGE_IMPACT_LIMIT : Math.min(Number(rawLimit), CHANGE_IMPACT_MAX_LIMIT);
  const opts = id !== null ? { change: { source, id, ...repo === null ? {} : { repo } }, series: true } : { ...source === null ? {} : { source }, limit };
  try {
    return { status: 200, body: await runChangeImpact({ dbPath, opts }) };
  } catch (err4) {
    if (err4 instanceof Error && UNKNOWN_CHANGE.test(err4.message)) return { status: 404, body: { error: err4.message } };
    if (err4 instanceof Error && AMBIGUOUS_CHANGE.test(err4.message)) return { status: 400, body: { error: err4.message } };
    throw err4;
  }
}
function sendGraph(res, graph2, freshness, ifNoneMatch) {
  if (graph2.etag === null) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(withFreshness(graph2.body, freshness()));
    return;
  }
  const headers = { etag: graph2.etag, "cache-control": "no-cache", "x-tmb-graph-cache": graph2.hit ? "hit" : "miss" };
  if (etagMatches(ifNoneMatch, graph2.etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(withFreshness(graph2.body, freshness()));
}
async function handleApi(db, dbPath, req, url, res) {
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [resource, id] = parts;
  const concepts = conceptsApi(db, url);
  if (concepts) return sendJson(res, concepts.status, concepts.body);
  if (parts.length === 1) {
    switch (resource) {
      case "summary":
        return sendJson(res, 200, summary(db));
      case "issues":
        return sendJson(res, 200, issues(db));
      case "tasks":
        return sendJson(res, 200, tasks(db));
      case "agent-runs":
        return sendJson(res, 200, agentRuns(db));
      case "gates":
        return sendJson(res, 200, gates(db));
      case "gate-board":
        return sendJson(res, 200, gateBoard(db));
      case "audit":
        return sendJson(res, 200, audit(db, clampLimit(url.searchParams.get("limit"))));
      case "version":
        return sendJson(res, 200, { data_version: dataVersion(db) });
      case "health":
        return sendJson(res, 200, health(db, dbFile(db)));
      case "config":
        return sendJson(res, 200, editableConfig(db));
      case "insights": {
        const filter = insightFilter(url.searchParams);
        return "error" in filter ? sendJson(res, 400, filter) : sendJson(res, 200, insights(db, filter));
      }
      case "world-model": {
        const p = url.searchParams;
        const repo = p.get("repo") || null;
        const body = worldModel(db, repo, p.get("path") ?? "", clampDepth(p.get("depth")));
        return sendJson(res, 200, { ...body, freshness: freshnessFor(db, repo) });
      }
    }
  }
  if (parts.length === 2 && resource === "insights" && id === "explore") {
    const filter = insightFilter(url.searchParams);
    const body = "error" in filter ? filter : explore(db, filter, url.searchParams, RELEASES);
    return sendJson(res, "error" in body ? 400 : 200, body);
  }
  if (parts.length === 3 && resource === "insights" && id === "explore" && parts[2] === "compare") {
    const query = compareQuery(url.searchParams);
    const body = "error" in query ? query : exploreCompare(db, query.filter, query.p1, query.p2, url.searchParams, RELEASES);
    return sendJson(res, "error" in body ? 400 : 200, body);
  }
  if (parts.length === 2 && resource === "insights" && id === "efficiency") {
    const filter = insightFilter(url.searchParams);
    return "error" in filter ? sendJson(res, 400, filter) : sendJson(res, 200, await efficiency(db, filter));
  }
  if (parts.length === 3 && resource === "insights" && id === "efficiency" && parts[2] === "compare") {
    const query = compareQuery(url.searchParams);
    return "error" in query ? sendJson(res, 400, query) : sendJson(res, 200, await efficiencyCompare(db, query.filter, query.p1, query.p2));
  }
  if (parts.length === 2 && resource === "insights" && id === "change-impact") {
    const result = await changeImpact(dbPath, url.searchParams);
    return sendJson(res, result.status, result.body);
  }
  if (parts.length === 2 && resource === "insights" && id === "compare") {
    const query = compareQuery(url.searchParams);
    return "error" in query ? sendJson(res, 400, query) : sendJson(res, 200, compare(db, query.filter, query.p1, query.p2));
  }
  if (parts.length === 2 && resource === "world-model" && id === "search") {
    const p = url.searchParams;
    const body = worldModelSearch(db, p.get("q") ?? "", clampHits(p.get("limit")));
    return sendJson(res, 200, { ...body, freshness: freshnessFor(db, p.get("repo") || null) });
  }
  if (parts.length === 2 && resource === "world-model" && id === "graph") {
    const repo = url.searchParams.get("repo") || null;
    return sendGraph(res, cachedGraph(db, repo), () => freshnessFor(db, repo), req.headers["if-none-match"]);
  }
  if (parts.length === 2 && resource === "world-model" && id === "status") {
    return sendJson(res, 200, worldModelStatus(db, clampHistory(url.searchParams.get("limit"))));
  }
  if (parts.length === 2 && resource === "issues" && /^-?\d+$/.test(id)) {
    const detail = issueDetail(db, Number(id));
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "issue not found" });
  }
  if (parts.length === 2 && resource === "tasks" && /^-?\d+$/.test(id)) {
    const detail = taskDetail(db, Number(id));
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "task not found" });
  }
  sendJson(res, 404, { error: "unknown endpoint" });
}
function serveStatic(ctx, pathname, res) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join11(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT) || rel.split(sep4).includes("..")) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync3(file) || !statSync(file).isFile()) file = join11(WEB_ROOT, "index.html");
  if (!existsSync3(file)) {
    res.writeHead(500, { "content-type": "text/plain" }).end("dashboard web bundle missing; run `bun run build` in dashboard/");
    return;
  }
  if (file.endsWith("index.html")) {
    const html = readFileSync6(file, "utf8").replace(
      "</head>",
      `<meta name="tmb-token" content="${ctx.token}" />
  </head>`
    );
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
    res.end(html);
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync6(file));
}
function tokenMatches(expected, given) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
function readBody(req) {
  return new Promise((resolve4, reject) => {
    const chunks = [];
    let size = 0;
    let drainTimer;
    const drop = () => {
      clearTimeout(drainTimer);
      req.off("data", onData);
      req.destroy();
      resolve4({ status: "dropped" });
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_DRAIN_BYTES) return drop();
      if (size > MAX_BODY_BYTES2) {
        chunks.length = 0;
        drainTimer ??= setTimeout(drop, DRAIN_TIMEOUT_MS);
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => {
      clearTimeout(drainTimer);
      resolve4(size > MAX_BODY_BYTES2 ? { status: "too_large" } : { status: "ok", text: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", (err4) => {
      clearTimeout(drainTimer);
      reject(err4);
    });
  });
}
async function readJsonBody(req, res) {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    sendJson(res, 415, { error: "unsupported_media_type", message: "send application/json" });
    return null;
  }
  const read = await readBody(req);
  if (read.status === "dropped") return null;
  if (read.status === "too_large") {
    res.setHeader("connection", "close");
    sendJson(res, 413, { error: "body_too_large", message: `the body is over ${MAX_BODY_BYTES2} bytes` });
    return null;
  }
  let body;
  try {
    body = JSON.parse(read.text);
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: "invalid_json", message: "body must be a JSON object" });
    return null;
  }
  return body;
}
async function handleWrite(ctx, req, url, res) {
  const origin = `http://${ctx.host}`;
  if (req.headers.origin !== origin) {
    return sendJson(res, 403, { error: "forbidden_origin", message: `writes are accepted only from ${origin}/` });
  }
  if (!tokenMatches(ctx.token, req.headers[TOKEN_HEADER])) {
    return sendJson(res, 403, { error: "bad_token", message: "missing or wrong dashboard token; reload the page" });
  }
  const configKey = /^\/api\/config\/(.*)$/.exec(url.pathname)?.[1];
  if (configKey !== void 0) {
    if (!isEditableConfigKey(configKey)) {
      return sendJson(res, 403, {
        error: "policy_key",
        message: `${configKey} is not editable from the dashboard; policy keys change through /onboard`,
        editable: EDITABLE_CONFIG_KEYS
      });
    }
    const body2 = await readJsonBody(req, res);
    if (body2 === null) return;
    const result2 = await ctx.config.perform(configKey, body2);
    return sendJson(res, result2.status, result2.body);
  }
  const match = /^\/api\/issues\/([1-9]\d*)\/([a-z]+)$/.exec(url.pathname);
  const action = match?.[2];
  if (!match || action === void 0 || !isWriteAction(action)) return sendJson(res, 404, { error: "unknown endpoint" });
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const result = await ctx.writer.perform(action, Number(match[1]), body);
  sendJson(res, result.status, result.body);
}
async function handle(ctx, req, res) {
  const url = new URL(req.url ?? "/", `http://${HOST2}`);
  try {
    if (req.headers.host !== ctx.host) {
      return sendJson(res, 403, { error: "forbidden_host", message: `requests are accepted only for host ${ctx.host}` });
    }
    if (req.method === "POST") return await handleWrite(ctx, req, url, res);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD, POST" }).end();
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) await handleApi(ctx.db, ctx.dbPath, req, url, res);
    else serveStatic(ctx, url.pathname, res);
  } catch (err4) {
    console.error("dashboard request failed:", err4);
    if (res.headersSent) res.end();
    else sendJson(res, 500, INTERNAL_ERROR);
  }
}
function main() {
  const dbPath = resolveClaudeDbPath();
  const db = openDb(dbPath);
  const ctx = {
    db,
    dbPath,
    writer: new IssueWriter(dbPath, db),
    config: new ConfigWriter(dbPath, db),
    token: randomBytes(32).toString("hex"),
    host: ""
  };
  const server = createServer((req, res) => void handle(ctx, req, res));
  server.on("error", (err4) => {
    console.error(`dashboard server failed: ${err4.message}`);
    process.exit(1);
  });
  server.listen(parsePort(process.env["TMB_DASHBOARD_PORT"]), HOST2, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : DEFAULT_PORT;
    ctx.host = `${HOST2}:${port}`;
    console.log(`TMB dashboard on ${dbPath}`);
    console.log(`http://${HOST2}:${port}/`);
  });
  const shutdown = () => {
    server.close();
    ctx.writer.close();
    ctx.config.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
try {
  main();
} catch (err4) {
  console.error(err4 instanceof Error ? err4.message : String(err4));
  process.exit(1);
}
//# sourceMappingURL=server.mjs.map
