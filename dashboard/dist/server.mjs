// server/main.ts
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync as existsSync3, readFileSync as readFileSync5, statSync as statSync2 } from "node:fs";
import { extname, join as join8, normalize, sep as sep3 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

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
async function retry(text) {
  const d = degraded;
  retrying = true;
  pipePromise = null;
  try {
    const pipe = await loadPipe();
    const result = await pipe(text, { pooling: "mean", normalize: true });
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
async function embed(text) {
  if (degraded) {
    if (retrying || now() < degraded.nextRetryAt) return null;
    return retry(text);
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
    const result = await pipe(text, { pooling: "mean", normalize: true });
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
  lstatSync,
  readdirSync,
  readFileSync as readFileSync2,
  realpathSync,
  statSync
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
var UnsafeProjectWritePathError = class extends Error {
  constructor(message2) {
    super(message2);
    this.name = "UnsafeProjectWritePathError";
  }
};
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
function assertSafeProjectWritePath(projectRoot, path, label = "Codex writable path", expectedKind = "either") {
  if (!isAbsolute(projectRoot)) {
    throw new UnsafeProjectWritePathError(
      `${label} project root must be an absolute path`
    );
  }
  if (!isAbsolute(path)) {
    throw new UnsafeProjectWritePathError(`${label} must be an absolute path`);
  }
  let rootStat;
  try {
    rootStat = lstatSync(projectRoot);
  } catch {
    throw new UnsafeProjectWritePathError(
      `${label} project root must remain an existing directory`
    );
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new UnsafeProjectWritePathError(
      `${label} project root must remain a real directory`
    );
  }
  const canonicalRoot = realpathSync(projectRoot);
  if (canonicalRoot !== projectRoot) {
    throw new UnsafeProjectWritePathError(
      `${label} project root changed after canonicalization`
    );
  }
  assertPathContained(canonicalRoot, path, label);
  assertExistingAncestorContained(
    canonicalRoot,
    path,
    label,
    expectedKind
  );
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
function findExistingClaudeDbUp(startDir, pluginName, opts) {
  const env = opts?.env ?? process.env;
  const override = env["TRAJECTORY_DB_PATH"];
  if (override && override.trim().length > 0) {
    return existsSync2(override) ? override : null;
  }
  const projectRoot = opts?.projectRoot !== void 0 ? opts.projectRoot : resolveClaudeProjectRoot(env);
  return walkClaudeDbs(projectRoot ?? startDir, pluginName, opts).resolved;
}
function assertPathContained(root, path, label) {
  const rel = relative(root, path);
  if (rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) {
    return;
  }
  throw new UnsafeProjectWritePathError(
    `${label} escapes the trusted project root`
  );
}
function assertExistingAncestorContained(root, path, label, expectedKind) {
  const rel = relative(root, path);
  const parts = rel === "" ? [] : rel.split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join3(current, parts[index]);
    let currentStat;
    try {
      currentStat = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (currentStat.isSymbolicLink()) {
      throw new UnsafeProjectWritePathError(
        `${label} contains a symbolic link in writable state`
      );
    }
    if (index === parts.length - 1) {
      if (expectedKind === "file" && !currentStat.isFile()) {
        throw new UnsafeProjectWritePathError(
          `${label} must be a regular file`
        );
      }
      if (expectedKind === "directory" && !currentStat.isDirectory()) {
        throw new UnsafeProjectWritePathError(
          `${label} must be a directory`
        );
      }
      if (currentStat.isFile() && currentStat.nlink !== 1) {
        throw new UnsafeProjectWritePathError(
          `${label} must not be a multiply linked writable file`
        );
      }
    }
    if (index < parts.length - 1 && !currentStat.isDirectory()) {
      throw new UnsafeProjectWritePathError(
        `${label} has a non-directory ancestor`
      );
    }
  }
  if (parts.length > 0) {
    assertPathContained(root, realpathSync(path), label);
  }
}
function freezePlugin(plugin) {
  return Object.freeze(plugin);
}

// ../mcp/trajectory-server/src/db.ts
import { readFileSync as readFileSync3, readdirSync as readdirSync2 } from "node:fs";
import { basename as basename2, join as join5, dirname as dirname2 } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// ../mcp/trajectory-server/src/logger.ts
import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync as lstatSync2,
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
  { type: "agent_runs_capture_skipped", writers: ["hook"], description: "`swe-atomic-close` could not bind a SWE spawn to a task (no `task_id=<N>` in the spawn transcript, or no such task) and wrote no `agent_runs` row; filed under the system issue `-1`; `content_json` carries `reason`, `transcript`, `spawn_id`, `task_id`" },
  { type: "agent_runs_backfilled", writers: ["bro"], description: "`agent_runs_backfill` (dry_run false) recovered `agent_runs` rows from archived Claude Code transcripts; one row per run on the system issue `-1`, from_node `bro`; `content_json` is the report: `transcripts_dir`, `transcripts_seen`, `sessions_seen`, `bound`, `unbound` (`count`, `first` \u2014 up to 20 `{path, reason}`), `rows_inserted`, `rows_updated`, `rows_skipped_measured`, `tokens_total_added`" },
  { type: "agent_runs_claimed", writers: ["server"], description: "Legacy type kept for historical rows: in v1.1.0-rc.1 `bro-turn-usage` claimed per-task bro `agent_runs` rows opened without a `session_id` for its session; bro is now metered per session, so nothing writes it and `audit_append` refuses it; `content_json` carries `run_ids`, `session_id`", reserved: true },
  { type: "branch_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_branch_gate`; `content_json` carries the waiver reason" },
  { type: "branch_id_proposed", writers: ["bro"], description: "`intent_start` proposed the issue's feature branch; `content_json` carries `branch_id`, `objective`; the scope and branch gates read it" },
  { type: "bro_verification_fail", writers: ["bro"], description: "Bro task-gate found a V1/V2/V3 check that failed" },
  { type: "bro_verification_pass", writers: ["bro"], description: "Bro task-gate V1/V2/V3 all passed; `content_json` carries `task_id`, `commit_sha`, and from `bro_atomic_close` a `scope` record (`extras_accepted`, `base_moved`, `recorded_base`, `merge_base`) that `task_brief` reads" },
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
  { type: "config_changed", writers: ["bro"], description: "An agent changed a `plugin_config` key through `/onboard`; written by bro via `audit_append`", reserved: true },
  { type: "consultant_spawn_nudged", writers: ["hook"], description: "`prompt-intent-hints` emitted the consultant-spawn nudge; filed under the system issue `-1`" },
  { type: "containment_denied", writers: ["hook"], description: "`containment-guard` denied a write outside the run's root (on the task's issue, else the system issue `-1`); `content_json` carries `tool`, `path`, `root`, `task_id`" },
  { type: "decision_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_decision_gate`; `content_json` carries the waiver reason" },
  { type: "deep_scan_completed", writers: ["bro"], description: "`scan_run` finished; `content_json` carries `source`, `structural_change`, `repos_seen`, `top_dirs`" },
  { type: "effort_ab_enrolled", writers: ["bro"], description: "`task_provision` or `task_create_batch` enrolled a new task in the opt-in swe effort A/B (`plugin_config.swe_effort_ab`, GH 1745): its computed effort was the default or an explicit `medium` and fewer than `target` tasks carried the label, so its effort became the arm of its id's parity (even `high`, odd `medium`) with `effort_reason` `ab_arm`; one row per task on its issue, in the insert's transaction; `content_json` carries `label`, `arm`, `task_id`" },
  { type: "effort_inputs_recorded", writers: ["bro"], description: "`task_provision` or `task_create_batch` recorded, in shadow mode (GH 1904), what the world model knows about the code a new task's spec names in backticks and the effort tier those inputs suggest; the task's effort is unchanged; one row per task on its issue, in the insert's transaction, after any `effort_ab_enrolled` row; `content_json` carries `task_id`, `inputs` (`files_in_scope`, `symbols_named`, `symbols_resolved`, `direct_callers`, `caller_files_outside_scope`, `tables_written`, `outside_table_readers`, `tests_reached`, `enforcement`, `prompt_bearing`, `rework`, `wm_available` \u2014 false with zero world-model counts when the repo has no world model or a lookup failed), `suggested_tier` (`low`, `medium`, `high`), `reason`, `effort` (the effort the task runs at)" },
  { type: "embeddings_degraded", writers: ["server"], description: "The embedding model entered the degraded state \u2014 it could not load, or `TMB_EMBED_FAIL_THRESHOLD` (default 5) consecutive embed calls failed \u2014 so semantic search falls back to FTS until a timed re-attempt (1 min, 5 min, then every 10 min) succeeds; one row per degraded episode on the system issue `-1`, from_node `trajectory-server`; `content_json` carries `reason`, `consecutive_failures`" },
  { type: "embeddings_recovered", writers: ["server"], description: "A re-attempt brought the degraded embedding model back, or a process loaded the model healthy while an earlier process left a degraded episode open (`reason` `process_start`, `retries` 0); one row per episode on the system issue `-1`, from_node `trajectory-server`; `content_json` carries `degraded_since`, `reason`, `retries`" },
  { type: "hook_block_bypassed", writers: ["hook"], description: "`swe-boundary` saw an Edit/Write to a path that a PreToolUse Bash gate had judged as a literal write target and denied in the same session within `TMB_BYPASS_WINDOW_MIN` minutes (default 10); a deny that could not judge its target records no path, so the literal-path write it prescribes is never counted (GH 1750); the write is still allowed (on the task's issue, else the system issue `-1`); `content_json` carries `tool`, `path`, `denied_gate`, `denied_at`, `session_id`, `task_id`" },
  { type: "hook_call", writers: ["hook"], description: "The router (`node dist/hooks.js <event>`, GH 1692) decided one call of a routed event (PreToolUse, PostToolUse, PermissionDenied, Stop or SubagentStop): one row per call it decided (a replayed duplicate writes none), from_node `hook:router`, on the task's issue else the system issue `-1`; `content_json` carries `event`, `tool` (empty on an event with no tool, Stop and SubagentStop), `decision` (`allow` or `deny`), `denied_gate`, `task_id`, and `gates`: one `{gate, ms, outcome}` per gate run, in group order, `ms` measured on that gate's own clock (from its start to its return or budget expiry, so no sibling's work is in it), `outcome` being `allow`, `deny`, `skipped_budget` or `error`" },
  { type: "hook_denied", writers: ["hook"], description: "`dispatch.sh` returned a deny: a gate's exit 2, `permissionDecision: \"deny\"` or `decision: \"block\"`, or the dispatcher's own fail-closed decision; one row per deny (a replayed duplicate writes none), from_node `hook:dispatch`, on the task's issue else the system issue `-1`; `content_json` carries `hook` (the gate), `rule` (the first 200 characters of the deny reason), `tool`, `agent_type`, `task_id` (the calling swe's run, else `tool_input.task_id`; null when unknown), `cwd` (the payload's). `audit_append` refuses this event" },
  { type: "intent_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_intent_gate`; `content_json` carries the waiver reason" },
  { type: "issue_adopted", writers: ["bro"], description: "`issue_create`, `issue_adopt_remote` or `issue_sync_retry` adopted an existing remote issue as the local issue's twin (`issue_sync_retry`: the issue an earlier lost create made, found by its body marker); `content_json` carries `issue_id`, `backend`, `remote_iid`, plus `via: 'issue_sync_retry'` from that tool" },
  { type: "issue_auto_close_deferred", writers: ["hook"], description: "`close-issue-on-merge` left an issue named by a merged PR's closing-ref open because other tasks of it are still live; `content_json` carries `blocking_task_ids`, `gh_iid`" },
  { type: "issue_auto_close_remote_skipped", writers: ["hook"], description: "`close-issue-on-merge` closed an issue locally but not its GitHub twin because issue sync is off (`plugin_config.issue_sync` unset or `off`, or `TMB_DISABLE_REMOTE_SYNC` set); `content_json` carries `gh_iid`, `reason`" },
  { type: "issue_auto_closed_on_merge", writers: ["hook"], description: "`close-issue-on-merge` closed a local issue named by a merged PR's closing-ref; `content_json` carries `gh_iid`" },
  { type: "issue_close_remote_skipped", writers: ["server"], description: "`issue_close`, `bro_atomic_close` or `task_recover` closed an issue locally but no linked remote because the remote-sync gate is off: `reason` is `issue_sync_off` (`plugin_config.issue_sync` unset or `off`), `env_disabled` (`TMB_DISABLE_REMOTE_SYNC` set) or `no_backend` (no usable gh/glab for the issue repo's remotes); `content_json` carries `reason`, `remotes`" },
  { type: "issue_linked", writers: ["bro"], description: "`issue_link` bound a local issue to a remote issue; `content_json` carries `issue_id`, `backend`, `iid`, `forced`" },
  { type: "issue_updated", writers: ["bro"], description: "bro changed an issue's milestone, labels or objective after creation; the dashboard also writes one per Human write (an edit, a comment or a close), from_node `dashboard`, `content_json` carrying `actor: human`, `source: dashboard`, `tool` (the trajectory-server handler it called) and `fields`" },
  { type: "legacy_event", writers: ["server"], description: "A migration re-typed a legacy audit row: v38 one whose `event_type` was outside the closed set (written by v1.0.x, before the set closed), v39 a swe-written `verification_gate_waived` row without a `commit_sha` that repeated an earlier one for its task; `content_json` keeps the original content and carries `legacy_event_type` (the old type), plus `legacy_content` when the old content was not valid JSON. Filed under the row's original issue; `audit_append` refuses this event" },
  { type: "mcp_unavailable_fallback_invoked", writers: ["bro", "swe", "code-reviewer", "consultant"], description: "The sqlite3 fallback (`scripts/lib/sqlite3-fallback.sh`) wrote in place of an unavailable MCP server; filed under the system issue `-1`" },
  { type: "milestone_closed", writers: ["bro"], description: "`milestone_close` closed a milestone; `content_json` carries `name`, `repo`, `forced`, `open_issues`, `remote_closed`, `remote_results`" },
  { type: "milestone_reconcile_failed", writers: ["bro"], description: "`scan_run` could not read a repo's remote milestones; `content_json` carries `repo`, `backend`, `reason` (the scan still succeeds)" },
  { type: "milestone_seed_skipped", writers: ["bro"], description: "`scan_run` found no milestones and could not seed one; `content_json` carries `repo`, `reason` (`no_version_source` or `reconcile_failed`)" },
  { type: "milestone_seeded", writers: ["bro"], description: "`scan_run` seeded `v<next-patch>` for a repo with no milestones; `content_json` carries `name`, `repo`, `source`, `remote_created`" },
  { type: "milestones_reconciled", writers: ["bro"], description: "`scan_run` imported a repo's remote milestones; `content_json` carries `imported`, `closed`, `repo`" },
  { type: "persona_block_written", writers: ["server"], description: "Legacy type kept for historical rows: in v1.1.0-rc.1 `onboard_apply` copied bro's persona block into the project's `CLAUDE.md`; nothing writes it now and `audit_append` refuses it; `content_json` carries `action` (`appended`, `replaced`), `version`", reserved: true },
  { type: "planning_complete", writers: ["bro"], description: "Bro finished planning: batched `task_create_batch` + SWE spawn" },
  { type: "project_made_standalone", writers: ["bro"], description: "`onboard_apply(standalone=true)` made the session directory, nested below the workspace, its own TMB project: it wrote the `standalone` marker and a fresh trajectory DB in `<session_dir>/.claude/<plugin>/`, which the DB walk-up then picks over the workspace DB; filed under the system issue `-1` in the workspace DB; `content_json` carries `session_dir`, `db_path`, `marker`" },
  { type: "readme_staleness_surfaced", writers: ["hook"], description: "`post-atomic-close-readme` surfaced READMEs a closed task may have left stale" },
  { type: "registry_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_registry_gate`; `content_json` carries the waiver reason" },
  { type: "remote_id_guard_overrun", writers: ["hook"], description: "`remote-id-guard` killed its analysis at `TMB_REMOTE_ID_GUARD_DEADLINE_S` (default 3 s, inside the 6 s hooks.json timeout) and allowed the Bash command (GH 1821); one row per overrun on the system issue `-1`, from_node `hook:remote-id-guard`; `content_json` carries `deadline_s`, `elapsed_s`" },
  { type: "repo_remotes_migration_skipped", writers: ["server"], description: "The v35 migration could not move a repo's `repos.remotes` JSON into `repo_remotes` \u2014 the value did not parse as an array or a name \u2192 url map, or some entries carried no url or a duplicate name (the rest moved); one row per repo on the system issue `-1`, written by `system`; `content_json` carries `repo`, `reason`, `raw`" },
  { type: "repo_rename_detected", writers: ["bro"], description: "`scan_run` found a discovered repo whose canonical path or primary remote URL matches an existing row under another name; no second row is inserted and the old row is kept until `repo_rename`; filed under the system issue `-1` by `bro`; `content_json` carries `old`, `new`, `by` (`path` or `remote`)" },
  { type: "repo_renamed", writers: ["bro"], description: "`repo_rename` moved a repo to a new name: the `repos` row, its FK children, `pr_review_runs` host slugs and the world-model nodes; filed under the system issue `-1` by `bro` with `repo` = the new name; `content_json` carries `old`, `new`, `reason`, `rows_by_table`, `graph` (`rekeyed`, or `deferred` when the world model was unavailable or the re-key failed \u2014 the next `scan_run` rebuilds), `graph_nodes`, and `graph_error` when the re-key failed" },
  { type: "review_finding_wontfix", writers: ["bro"], description: "`task_reopen(wontfix)` set an open review finding of the task to `wontfix` (the Human accepted it), so the close gate stops probing it; one row per finding on the task's issue; `content_json` carries `task_id`, `finding_id`, `reason`" },
  { type: "review_findings_carried", writers: ["bro"], description: "`task_retry` copied the failed task's open review findings onto the retry task as `F<new_task_id>-<n>`; one row per retry that carried at least one; `content_json` carries `from_task_id`, `to_task_id`, `findings` (`from`, `id`)" },
  { type: "review_gate_bypassed", writers: ["bro", "hook"], description: "A task reached `closed` by a path other than `bro_atomic_close` (`close-issue-on-merge`, `task_recover`, `task_update_status`) with no passing code-reviewer verdict for its current commit; the task still closes. At most one row per task and commit (none when a `review_gate_waived` row already names them); `content_json` carries `task_id`, `commit_sha`, `closed_by`. A verdict counts as passing when `verdict = 'pass'` and its `created_at` is at or after the earliest `bro_verification_pass` row naming the task and its current `commit_sha`" },
  { type: "review_gate_waived", writers: ["bro"], description: "`issue_close(waive_review: true)` closed an issue over a closed task with no passing code-reviewer verdict for its current commit; one row per such task; `content_json` carries `skill`, `task_id`, `commit_sha`, `waive_review_reason`" },
  { type: "reviewer_identity_observed", writers: ["hook"], description: "`reviewer-identity-observe` saw a code-reviewer subagent call `validation_record` (the payload carried `agent_id` and an `agent_type` that normalises to `code-reviewer`); one row per call on the task's issue, from_node `hook:reviewer-identity-observe`; `content_json` carries `task_id`, `attempt_n`, `session_id`, `agent_id`, `tool_use_id` (null when the payload has none), `observed_at`, `consumed` (0 until `validation_record` stamps `subagent_session_id` and `reviewer_agent_id` from it and sets 1; a row observed more than 600 s before the call is never consumed), and `superseded`, `superseded_by`, `superseded_at` (set when `validation_record` consumes a newer row for the same `(task_id, attempt_n)`: every older unconsumed row gets `superseded` 1, the audit id of the consumed row and the time; a superseded row is never consumed). `audit_append` refuses this event" },
  { type: "roundtable_slash_invoked", writers: ["hook"], description: "`roundtable-slash-detect` saw the Human type `/roundtable`; `roundtable_create` consumes the row" },
  { type: "roundtable_summary", writers: ["bro"], description: "Bro recorded a roundtable's outcome summary via `audit_append`; `roundtable-cleanup-postcheck` requires it", reserved: true },
  { type: "scan_discovered", writers: ["server", "hook"], description: "A scan registered a newly discovered cheatcode (`scan_run`, or `scan.sh` as `hook:scan`); filed under the system issue `-1`; `content_json` carries `name`, `kind`, `origin`, `source`" },
  { type: "scan_discovered_repair", writers: ["server"], description: "The v32 migration deleted `scan_discovered` rows whose `(name, kind)` has no `cheatcodes` row; filed under the system issue `-1` by `system`; `content_json` carries `deleted`" },
  { type: "scan_skipped", writers: ["hook"], description: "`scan.sh` left a git repo below the session dir out of the scan; one row per path and reason (a re-scan that skips it again writes none), filed under the system issue `-1` as `hook:scan`; `content_json` carries `path`, `reason` (`dot_dir`: a dot-prefixed path segment below the session dir; `git_ignored`: an enclosing repo ignores it; `no_commits`: it has no commit)" },
  { type: "scope_gate_waived", writers: ["bro"], description: "`bro_atomic_close(waive_scope_gate: true)` accepted the task's changed paths outside its `files[]` with a `scope_waiver_reason`; `content_json` carries `skill`, `task_id`, `commit_sha`, `accepted_paths`, `reason`, `base_moved`, `recorded_base`, `merge_base`. `task_create_batch(waive_scope_gate: true)` writes one when it skips its question gate, `content_json` carrying `waive_scope_gate_reason`, `tasks_created`" },
  { type: "skill_creator_blocked", writers: ["bro"], description: "`tmb_skill-creator` halted before writing the skill (no Human approval); written by bro via `audit_append`", reserved: true },
  { type: "spec_shape_gate_waived", writers: ["bro"], description: "A task's spec-shape waiver, one row per task on its issue with from_node `bro`; `task_create_batch` and `task_provision` called with `waive_spec_shape` write one for every task they create, and bro records one for an existing task through `audit_append`; `content_json` carries `task_id`, `gate` (`spec_shape`), `reason`, `waived_by` (`bro`), `source` (`task_create_batch`, `task_provision`, or absent for `audit_append`); `require-task-spec` reads it as the spawn waiver" },
  { type: "stray_db_removed", writers: ["bro"], description: "`onboard_apply(remove_stray_dbs)` deleted an empty trajectory DB (0 issues, 0 tasks) below the project root, with its `-wal`/`-shm` files and its state dir, on the Human's yes; one row per DB on the system issue `-1`; `content_json` carries `path`, `state_dir`, `project_root`" },
  { type: "swe_atomic_close_auto_completed", writers: ["hook"], description: "`swe-atomic-close` auto-completed a `pending`/`running` task on SubagentStop because its worktree HEAD is neither equal to nor an ancestor of any parent tip (local or origin); one row per auto-complete on the task's issue, written in the same transaction as the status change; `content_json` carries `task_id`, `commit_sha`, `parent_tip_local`, `parent_tip_origin` (null when that ref is absent)" },
  { type: "swe_brief_fetched", writers: ["swe"], description: "`task_brief` recorded that a SWE fetched its brief (one row per task); swe-brief-gate reads it" },
  { type: "swe_resume_observed", writers: ["hook"], description: "`swe-brief-gate` saw a swe call `task_brief` with an `agent_id` whose `agent_runs` rows for the task are all closed: a swe resumed through SendMessage (GH 1742); one row per such call on the task's issue, from_node `hook:swe-brief-gate`; `content_json` carries `task_id`, `agent_id`, `observed_at`, `consumed` (0 until `task_brief`'s `openSweRun` opens the resumed run's row from it, with `resumed_from` its previous row, and sets 1; a row observed more than 600 s before the call is never consumed). `audit_append` refuses this event" },
  { type: "sync_skipped", writers: ["bro"], description: "Issue sync skipped a remote write because `issue_sync` is off; `content_json` carries `issue_id`, `reason`" },
  { type: "task_effort_raised", writers: ["bro"], description: "`task_reopen` or `task_retry` called with an `effort` above the task's (for `task_retry`, the failed task's) raised the effort swe runs it at, as does either call made with no `effort` (rework computes `high`); one row per raise on the task's issue; `content_json` carries `task_id`, `from`, `to`, and `failed_task_id` from `task_retry`" },
  { type: "task_escalated_by_issue_close", writers: ["bro"], description: "`issue_close(cascade: true)` escalated a live task (`pending`/`running`/`needs_validation`/`completed`) of the issue it closed and closed its open `agent_runs` rows as `issue_closed`; one row per task; `content_json` carries `task_id`, `from_status`, `reason`" },
  { type: "task_escalated_repair", writers: ["server"], description: "The v33 migration escalated a task still `pending`/`running`/`needs_validation`/`completed` whose issue was already `closed` and closed its open `agent_runs` rows as `issue_closed`; written by `system`; `content_json` carries `task_id`, `issue_id`, `from_status`" },
  { type: "task_overrun_alerted", writers: ["hook"], description: "`task-overrun-alert` told bro that a `running` task passed `TMB_TASK_OVERRUN_MIN` minutes (default 60) since its `created_at`; one row per task, ever (the once-marker), on the task's issue, from_node `hook:task-overrun-alert`; `content_json` carries `task_id`, `minutes`, `attempts` (swe spawns), `blocker` (the first line of the latest FAIL feedback, else the status)" },
  { type: "task_recovered", writers: ["bro"], description: "`task_recover` closed a task stuck in `running`/`completed` at its commit; `content_json` carries `task_id`, `commit_sha`, `prior_status`" },
  { type: "task_reopened", writers: ["bro"], description: "`task_reopen` moved a `pending` / `closed` / `failed` / `escalated` / `running` task back to `running` for rework; `content_json` carries `task_id`, `from_status`, `reason`, `files_add`, `verification_add`" },
  { type: "task_retry_attempted", writers: ["bro"], description: "`task_retry` created a retry task for a failed one; `content_json` carries `failed_task_id`, `new_task_id`, `new_branch_id`" },
  { type: "task_spec_amended", writers: ["bro"], description: "`task_update_spec` replaced a live task's `files` / `verification` / `spec_body`; `content_json` carries `task_id`, `status`, `reason`, `changes`" },
  { type: "task_stale_swept", writers: ["bro"], description: "`task_recover` moved a `running` task with no open swe `agent_runs` row and no update for `TMB_STALE_RUNNING_HOURS` (default 6) to `failed` and closed its open runs as `swept_stale`; `content_json` carries `task_id`, `from_status`, `last_updated_at`, `stale_after_hours`" },
  { type: "tmb_agent_created", writers: ["server", "bro"], description: "`agent_register` registered a project-local consultant; `content_json` carries `name`, `mode`, `agent_id`" },
  { type: "tmb_branch_autocreated", writers: ["bro"], description: "`task_create_batch` created the task's feature branch ref" },
  { type: "tmb_skill_created", writers: ["bro"], description: "`tmb_skill-creator` landed a new skill; written by bro via `audit_append`", reserved: true },
  { type: "trajectory_doctor_run", writers: ["bro"], description: "`trajectory_doctor(record: true)` checked the trajectory DB against its data contracts (`mcp/trajectory-server/src/data-contracts.ts`); filed under the system issue `-1` by `bro`; `content_json` is the report: `healthy`, `checked_at`, `schema` (`stored`, `required`, `current`), `violations` (`id`, `severity`, `description`, `actual`, `expected`, `sample`), `skipped` (`id`, `reason`), `embeddings` (the server's `embeddingStatus()`: `state`, `since`, `reason`, `consecutive_failures`, `next_retry_at`)" },
  { type: "validation_session_unverified", writers: ["server"], description: "`validation_record` recorded an honor-system verdict (`mcp_available: false`) with no `reviewer_identity_observed` row, so `subagent_session_id` is the caller's unverified value and `reviewer_agent_id` is NULL; on the task's issue, from_node `trajectory-server`; `content_json` carries `task_id`, `attempt_n`, `subagent_session_id`" },
  { type: "verification_gate_waived", writers: ["hook"], description: "`swe-verification-gate` honoured a SWE's `waive_verification_gate_reason`; at most one row per task and commit; `content_json` carries `task_id`, `commit_sha`, `waiver_reason`" },
  { type: "wm_tool_called", writers: ["server"], description: "A world-model tool (`world_model_get`, `world_model_search`, `world_model_symbol`, `world_model_concepts`, `world_model_concept_get`, `world_model_concept_upsert`) answered a call, error results included; one row per call, from_node the `agent` argument, on the task's issue when exactly one open `agent_runs` row has the caller's role as `agent_type`, else the system issue `-1`; `content_json` carries `tool`, `agent`, `task_id`, `args` (only the present `query`, `path`, `id`, `qualified_name`, `name`, `mode`, `depth`, `repo`, `k`, plus `impact` and `source` for `world_model_symbol`), `result_count`, `empty`, `error`, `warning`, `match`, `derived`, `latency_ms`. `audit_append` refuses this event" }
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
  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed.map(
      (e) => e !== null && typeof e === "object" ? {
        name: e["name"],
        url: e["url"],
        provider: e["provider"]
      } : { name: void 0, url: void 0, provider: void 0 }
    );
  } else if (parsed !== null && typeof parsed === "object") {
    entries = Object.entries(parsed).map(([name, url]) => ({ name, url, provider: void 0 }));
  } else {
    return { ok: false, reason: `expected an array or an object, got ${parsed === null ? "null" : typeof parsed}` };
  }
  const remotes = [];
  const seen = /* @__PURE__ */ new Set();
  let dropped = 0;
  entries.forEach((e, i) => {
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

// ../mcp/trajectory-server/src/db.ts
var TARGET_SCHEMA_VERSION = 54;
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
    if (dbPath !== ":memory:" && resolvedDependencies.trustedProjectRoot !== void 0) {
      assertSafeProjectWritePath(
        resolvedDependencies.trustedProjectRoot,
        dbPath,
        "Trajectory database",
        "file"
      );
    }
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
      const row = this.db.prepare("SELECT schema_version FROM plugin_meta LIMIT 1").get();
      if (row === void 0) {
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
    } catch (err3) {
      this.serverLog({
        kind: "plugin_version_sync_failed",
        level: "error",
        db_path: this.dbPath,
        target,
        plugin_version: this.pluginVersion,
        message: err3 instanceof Error ? err3.message : String(err3)
      });
      throw err3;
    }
  }
  run(sql, params) {
    const start = performance.now();
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(...params ?? []);
      const out = { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      this.sqlLog({
        kind: "run",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        rows_affected: out.changes,
        ok: true
      });
      return out;
    } catch (err3) {
      this.sqlLog({
        kind: "run",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        ok: false,
        error_message: err3 instanceof Error ? err3.message : String(err3)
      });
      throw err3;
    }
  }
  get(sql, params) {
    const start = performance.now();
    try {
      const stmt = this.db.prepare(sql);
      const row = stmt.get(...params ?? []);
      this.sqlLog({
        kind: "get",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        row_count: row === void 0 ? 0 : 1,
        ok: true
      });
      return row;
    } catch (err3) {
      this.sqlLog({
        kind: "get",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        ok: false,
        error_message: err3 instanceof Error ? err3.message : String(err3)
      });
      throw err3;
    }
  }
  all(sql, params) {
    const start = performance.now();
    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params ?? []);
      this.sqlLog({
        kind: "all",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        row_count: rows.length,
        ok: true
      });
      return rows;
    } catch (err3) {
      this.sqlLog({
        kind: "all",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        ok: false,
        error_message: err3 instanceof Error ? err3.message : String(err3)
      });
      throw err3;
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
    sqlLog: noThrowTrajectoryLog(dependencies.sqlLog),
    trustedProjectRoot: dependencies.trustedProjectRoot
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
function isBusyError(err3) {
  if (!(err3 instanceof Error)) return false;
  const errcode = err3.errcode;
  return typeof errcode === "number" && (errcode & 255) === SQLITE_BUSY || err3.message.includes("database is locked");
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
  const deadline = performance.now() + BUSY_TIMEOUT_MS;
  for (; ; ) {
    try {
      db.exec(sql);
      return;
    } catch (err3) {
      if (!isBusyError(err3) || performance.now() >= deadline) throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row !== void 0;
}
function readTableSql(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row?.sql ?? "";
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV14toV15(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "cheatcodes") && !hasColumn(db, "cheatcodes", "scope")) {
      db.exec("ALTER TABLE cheatcodes ADD COLUMN scope TEXT NOT NULL DEFAULT 'local'");
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV15toV16(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS rule_invocations");
    db.exec("DROP TABLE IF EXISTS rules");
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV16toV17(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS commands");
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
      for (const row of rows) {
        const parsed = parseLegacyRemotes(row.legacy);
        if (!parsed.ok) {
          skipped(row.name, row.legacy, parsed.reason);
          continue;
        }
        const primary = primaryIndex(parsed.entries);
        parsed.entries.forEach((r, i) => {
          insertRemote.run(row.name, r.name, remoteProvider(r.url, r.provider), r.url, i === primary ? 1 : 0);
        });
        if (parsed.dropped > 0) {
          skipped(row.name, row.legacy, `${parsed.dropped} remote entr${parsed.dropped === 1 ? "y" : "ies"} without a url or with a duplicate name`);
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
         'Bro''s PR/MR comment triage \u2014 resolve the PR, fetch the comment threads, judge which are task-worthy, and dispatch SWE per ratified group. Loaded by bro when /monitor surfaces PR/MR comments.',
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
        const row = db.prepare("SELECT value_json FROM plugin_config WHERE key = ?").get(key);
        if (!row?.value_json) return null;
        try {
          const v = JSON.parse(row.value_json);
          return typeof v === "string" && v.length > 0 ? v : null;
        } catch {
          return null;
        }
      };
      const rawFromConfig = (key) => {
        const row = db.prepare("SELECT value_json FROM plugin_config WHERE key = ?").get(key);
        return row?.value_json ?? null;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV1toV2(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "identity") && tableExists(db, "plugin_config")) {
      const row = db.prepare("SELECT COUNT(*) AS n FROM identity").get();
      if (row && row.n > 0) {
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
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}

// ../mcp/trajectory-server/src/utils/repo-paths.ts
import { dirname as dirname3, isAbsolute as isAbsolute3, resolve as resolve2 } from "node:path";

// ../mcp/trajectory-server/src/tools/containment.ts
import { isAbsolute as isAbsolute2, join as join6, parse, relative as relative2, sep as sep2 } from "node:path";
function projectRootFromDbPath(dbPath) {
  if (!dbPath || dbPath === ":memory:") return null;
  const segments = dbPath.split(sep2);
  const idx = segments.lastIndexOf(".claude");
  if (idx <= 0) return null;
  return segments.slice(0, idx).join(sep2) || sep2;
}

// ../mcp/trajectory-server/src/utils/repo-paths.ts
function repoRowPath(db, path) {
  if (isAbsolute3(path)) return path;
  const base = db.dbPath === ":memory:" ? process.cwd() : projectRootFromDbPath(db.dbPath) ?? dirname3(db.dbPath);
  return resolve2(base, path);
}
function resolveRepoForSync(db, repoName) {
  if (repoName) {
    const row = db.get(`SELECT name, path FROM repos WHERE name = ?`, [repoName]);
    return row ? { name: row.name, path: repoRowPath(db, row.path) } : null;
  }
  const rows = db.all(`SELECT name, path FROM repos`);
  if (rows.length !== 1) return null;
  return { name: rows[0].name, path: repoRowPath(db, rows[0].path) };
}

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
var OR_FALLBACK_MIN_HITS = 3;
var SYMBOL_COLUMNS = "s.id, s.repo, s.path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, s.run_order";
function isTestPath(path) {
  return /(^|\/)(tests?|__tests__)\/|\.test\.[a-z]+$/.test(path);
}
function outsideConceptLane(path) {
  return isTestPath(path) || /(^|\/)(__)?fixtures(__)?\//.test(path);
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
  const row = db.get(`SELECT ${SYMBOL_COLUMNS} FROM wm_symbols s WHERE s.id = ?`, [id]);
  return row ? normalizeRow(row) : null;
}

// ../mcp/trajectory-server/src/utils/timeouts.ts
var SUBPROCESS_TIMEOUT_MS = 5e3;

// ../mcp/trajectory-server/src/review-sql.ts
var HAS_PASS_SQL = `EXISTS (SELECT 1 FROM validation_attempts va
  WHERE va.task_id = t.id AND va.verdict = 'pass' AND va.created_at >= (
    SELECT MIN(a.created_at) FROM audit a
      WHERE a.event_type = 'bro_verification_pass' AND json_valid(a.content_json)
        AND json_extract(a.content_json, '$.task_id') = t.id
        AND json_extract(a.content_json, '$.commit_sha') = t.commit_sha))`;
var reviewSkipAuthoredSql = (alias) => `((${alias}.event_type = 'review_gate_waived' AND ${alias}.from_node = 'bro')
      OR (${alias}.event_type = 'review_gate_bypassed' AND ${alias}.from_node IN ('bro', 'hook:close-issue-on-merge')))`;
var GATE_SKIP_RECORDED_SQL = `EXISTS (SELECT 1 FROM audit g
  WHERE ${reviewSkipAuthoredSql("g")}
    AND json_valid(g.content_json)
    AND json_extract(g.content_json, '$.task_id') = t.id
    AND COALESCE(json_extract(g.content_json, '$.commit_sha'), '') = COALESCE(t.commit_sha, ''))`;

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
        text: JSON.stringify({
          error: "forbidden",
          tool: toolName,
          caller_role: agent,
          allowed_roles: [...allowedRoles],
          ...agent === "unknown" ? missingAgentDiagnostics(toolName, allowedRoles, received) : {}
        })
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
  const text = (body ?? "").replace(/<\/?untrusted-content[^>]*>/g, "").trim();
  return text ? `${path}: ${text}` : path;
}
function auditEmbedText(summary2, contentJson) {
  return contentJson && contentJson !== "{}" ? `${summary2} ${contentJson}` : summary2;
}
async function embedAndStore(db, table, rowid, text) {
  const v = await embed(text);
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
function embedText(table, r) {
  if (table === "audit") return auditEmbedText(r.text, r.content_json ?? null);
  if (table === "wm_directories" || table === "wm_files") return worldModelEmbedText(r.text, r.body ?? null);
  return r.text;
}
async function backfillMissing(db, table, limit = 50, onRow) {
  const rows = db.all(MISSING_SQL[table], [MODEL_ID, limit]);
  for (const r of rows) {
    await embedAndStore(db, table, r.id, embedText(table, r)).catch(
      (e) => console.error(`[embeddings] backfill ${table} #${r.id} failed:`, e)
    );
    onRow?.();
  }
  return rows.length;
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
  const row = db.get(
    `SELECT id FROM wm_symbols WHERE repo = ? AND path = ? AND kind = ? AND qualified_name = ?`,
    [a.repo, a.path, a.kind, a.qualified_name]
  );
  const symbol = row ? symbolById(db, Number(row.id)) : null;
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
  for (const row of ids) {
    const id = Number(row.id);
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
        const row = symbolById(db, dst);
        if (!row) continue;
        via.set(dst, e.kind);
        next.push(row);
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

// server/releases.ts
import { readFileSync as readFileSync4 } from "node:fs";
var HEADING = /^## v(\S+) — (\d{4}-\d{2}-\d{2})\s*$/;
function parseChangelog(text) {
  const releases = [];
  for (const line of text.split(/\r?\n/)) {
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
function issues(db) {
  const remotes = webRemotes(db);
  return all(
    db,
    `SELECT i.id, i.objective, i.status, i.repo, i.milestone, i.gh_iid, i.gl_iid,
            i.created_at, i.updated_at, i.closed_at, i.labels,
            (SELECT COUNT(*) FROM tasks t WHERE t.issue_id = i.id) AS task_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.issue_id = i.id
               AND t.status IN ('completed','closed')) AS tasks_done,
            (SELECT COUNT(*) FROM discussions d WHERE d.issue_id = i.id) AS discussion_count
       FROM issues i
      WHERE i.id > 0
      ORDER BY i.status = 'open' DESC, i.updated_at DESC`
  ).map((i) => ({ ...i, remote_web_url: issueWebUrl(remotes, i) }));
}
function schemaVersion(db) {
  const row = one(db, `SELECT schema_version FROM plugin_meta WHERE id = 1`);
  return row ? Number(row["schema_version"]) : null;
}
function issueUpdatedAt(db, id) {
  const row = one(db, `SELECT updated_at FROM issues WHERE id = ?`, id);
  return row ? String(row["updated_at"]) : null;
}
function configStringList(db, key) {
  const row = one(db, `SELECT value_json FROM plugin_config WHERE key = ?`, key);
  if (!row) return null;
  try {
    const parsed = JSON.parse(String(row["value_json"]));
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : null;
  } catch {
    return null;
  }
}
function issueDetail(db, id) {
  const issue = one(db, `SELECT * FROM issues WHERE id = ?`, id);
  if (!issue) return null;
  const repo = issue["repo"] === null ? null : String(issue["repo"]);
  return {
    issue: { ...issue, remote_web_url: issueWebUrl(webRemotes(db), issue) },
    label_taxonomy: {
      classification: configStringList(db, "issue_classification_labels"),
      priority: configStringList(db, "issue_priority_labels")
    },
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
function tasks(db) {
  return all(
    db,
    `SELECT t.id, t.issue_id, i.objective AS issue_objective, t.branch_id, t.title,
            t.status, t.repo, t.effort, t.commit_sha, t.created_at, t.updated_at,
            t.completed_at,
            (SELECT v.verdict FROM validation_attempts v WHERE v.task_id = t.id
              ORDER BY v.id DESC LIMIT 1) AS last_verdict,
            (SELECT COUNT(*) FROM review_findings f WHERE f.task_id = t.id
               AND f.status = 'open') AS open_findings
       FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
      ORDER BY t.id DESC LIMIT ?`,
    RECENT_LIMIT * 5
  );
}
function parseJsonColumn(row, key) {
  const raw = row[key];
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
  const nodes = all(
    db,
    `WITH RECURSIVE sub(id, path, lvl) AS (
       SELECT id, path, 0 FROM wm_directories WHERE repo = ? AND path = ?
       UNION
       SELECT c.id, c.path, s.lvl + 1
         FROM wm_directories c JOIN sub s ON c.parent_path = s.path
        WHERE c.repo = ? AND c.path <> s.path AND s.lvl < ?
     )
     SELECT d.repo, d.path, d.parent_path, d.summary, d.file_count
       FROM wm_directories d
      WHERE d.id IN (SELECT id FROM sub)
      ORDER BY d.path`,
    target,
    path,
    target,
    depth
  );
  return { available: true, repos, nodes: nodes.map((n) => ({ ...n, summary: summaryLine(n["summary"]) })) };
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
  if (!worldModelAvailable(db) || !symbolGraphAvailable(db)) {
    return { available: false, repo: null, repos: [], files: [], edges: [] };
  }
  const repos = all(db, `SELECT DISTINCT repo FROM wm_directories ORDER BY repo`).map((r) => String(r["repo"]));
  const target = repo ?? repos[0];
  if (target === void 0) return { available: true, repo: null, repos, files: [], edges: [] };
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
  const row = one(db, `SELECT value_json FROM plugin_config WHERE key = 'model_prices'`);
  if (!row) return prices;
  let parsed;
  try {
    parsed = JSON.parse(String(row["value_json"]));
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
  const row = (r, value) => ({ run_id: r.id, agent: r.agent, task_id: r.task_id, task_title: r.task_title, value });
  const byValue2 = (a, b) => b.value - a.value || a.run_id - b.run_id;
  const top = (value) => perRun.map((r) => row(r, value(r))).sort(byValue2).slice(0, TOP_N);
  const durations = perRun.map((r) => ({ ...row(r, r.duration_ms), tool_uses: r.tool_uses, tokens_out: r.tokens_out, idle: likelyIdle(r) })).sort(byValue2);
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
  const sum = (v) => runs.reduce((s, r) => s + v(r), 0);
  const contextSum = sum(context);
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
    tokens_out: perTask(sum((r) => r.tokens_out)),
    context: perTask(contextSum),
    cache_hit: tasks2 === 0 || contextSum === 0 ? null : sum((r) => r.cache_read) / contextSum,
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
function exploreRows(db, f, since) {
  const cols = columnsOf(db, "agent_runs");
  const version = cols.has("plugin_version") ? "r.plugin_version" : "NULL";
  const resumed = cols.has("resumed_from") ? "r.resumed_from IS NOT NULL" : "0";
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
        WHERE (? IS NULL OR COALESCE(r.started_at, r.completed_at) >= ?)
          AND (? IS NULL OR r.repo = ?) AND (? IS NULL OR r.model = ?) AND (? IS NULL OR r.effort = ?)
     ) WHERE agent IS NOT NULL AND (? IS NULL OR agent = ?)
     ORDER BY id`,
    since,
    since,
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
function explore(db, f, p, releases = [], now2 = /* @__PURE__ */ new Date()) {
  const q = exploreQuery(p);
  if ("error" in q) return q;
  const prices = modelPrices(db);
  if (q.measure === "cost" && prices.size === 0) return { error: "cost needs model prices; none are set" };
  const since = sinceOf(f.range, now2);
  const rows = exploreRows(db, f, since);
  const value = measureOf(q.measure, prices);
  const runs = rows.filter((r) => (!TOKEN_MEASURES.has(q.measure) || r.measured === 1) && value(r) !== null);
  const total = (list) => aggregate(list, q, value);
  const label = (dim) => (r) => labelOf(dim, r, releases);
  const [first, second] = q.dims;
  const groups = second === void 0 ? binsOf(runs, label(first), ONE_DIM_MAX, ONE_DIM_MAX - 1, total).map((b) => ({ key: [b.key], n: b.n, value: b.value })) : binsOf(runs, label(first), PANELS_NAMED, PANELS_NAMED, total).flatMap(
    (panel) => binsOf(panel.runs, label(second), PANEL_BARS_NAMED, PANEL_BARS_NAMED, total).map((b) => ({ key: [panel.key, b.key], n: b.n, value: b.value }))
  );
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
    options: { measures: EXPLORE_MEASURES, aggs: EXPLORE_AGGS, dims: EXPLORE_DIMS, priced: prices.size > 0 }
  };
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
  const row = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?))`).get(JSON.stringify(CONCEPT_TABLES));
  return Number(row?.n ?? 0) === CONCEPT_TABLES.length;
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
  const row = db.prepare(`SELECT id, repo, path, kind, qualified_name, start_line FROM wm_symbols WHERE id = ?`).get(id);
  return row ?? null;
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

// server/no-embeddings.ts
var noEmbeddings = () => Promise.reject(new Error("embeddings are not loaded in the dashboard"));

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
  const row = db.get(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
  if (!row) return "off";
  try {
    return String(JSON.parse(row.value_json));
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
import { join as join7 } from "node:path";
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
    appendFileSync2(join7(logDir, "issue-sync.log"), line);
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
      return { ok: false, reason: "read_back_non_zero_exit" };
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
    if (result.status !== 0) return { ok: false, reason: "not_found_or_error" };
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
    const text = entry[bodyKey];
    if (typeof iid === "number" && typeof text === "string" && text.includes(marker)) iids.push(iid);
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
  const row = db.get(
    `SELECT value_json FROM plugin_config WHERE key = ?`,
    [key]
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((v) => typeof v === "string")) {
      return parsed;
    }
  } catch {
  }
  return null;
}
function readStringMapConfig(db, key) {
  const row = db.get(
    `SELECT value_json FROM plugin_config WHERE key = ?`,
    [key]
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json);
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
function pathTokens(text) {
  return text.split(PATH_TOKEN_SPLIT).map(
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
function normalizeObjective(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 0);
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
function decodeIssue(row) {
  return { ...row };
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
var SYNC_RETRY_HINT = "Try `issue_sync_retry` or run the underlying gh/glab command manually to debug.";
var SYNC_UNKNOWN_HINT = "The remote issue may already exist: the create's result was lost. Run `issue_sync_retry`; it looks for the issue by its body marker before it creates, so it adopts that issue rather than opening a duplicate. Do not re-create it by hand.";
function syncFailureHint(outcomes) {
  return outcomes.includes("unknown") ? SYNC_UNKNOWN_HINT : SYNC_RETRY_HINT;
}
async function verifyAdoptionRemote(db, issueRepo, remoteBackendArg, remoteIid, spawnFn) {
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
          repo: { type: "string", description: "Optional repo name (matches a repos row) this issue belongs to. Drives issue-scoped sync (explicit gh --repo / glab -R from that repo's remotes). Defaults to the sole/managed repo when exactly one repos row exists." },
          allow_duplicate: { type: "boolean", description: "When true, skip the open-issue dedup pre-check and create even if an existing open issue closely matches the objective. Default false: a likely duplicate returns { duplicate: true, duplicate_of } instead of creating." },
          remote_iid: { type: "number", description: "Optional. Adopt an existing remote issue instead of creating one: verifies the remote issue exists, links it, and skips remote creation. A failed verification creates nothing." },
          remote_backend: { type: "string", enum: ["github", "gitlab"], description: "Optional backend for remote_iid adoption. Defaults to the repo's sole configured remote." },
          include_description: { type: "boolean", description: "Echo the full description in the result (default false). Architect + bro only." }
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
          include_description: { type: "boolean", description: "Whether to include the full description (default false). Architect + bro only." }
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
      description: "Close an issue locally, then mirror the close to its linked remote. Refuses with issue_has_open_tasks (task ids + statuses) while any task is pending/running/needs_validation/completed, unless cascade=true escalates those tasks first (one task_escalated_by_issue_close audit row each, open agent_runs closed issue_closed). Refuses with tasks_without_review while a closed task has no passing code-reviewer verdict for its current commit, unless waive_review=true + waive_review_reason records review_gate_waived per task.",
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
      description: "Return the current workflow phase and task counts for an issue. tasks_completed counts closed tasks only; tasks_awaiting_close counts tasks the SWE reported completed that bro has not closed yet. phase is ready_to_close once every task is closed.",
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
      description: "List issues ordered by updated_at DESC. Returns a thin index (id, objective, status, created_at, updated_at). Optional fields projection via fields=['id','status','objective']; unknown fields return a named error.",
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
      description: "Update an issue's description. Used by bro to backfill issues whose descriptions were truncated on import (e.g., from Linear).",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["bro"], description: "Calling agent identity (bro only)" },
          issue_id: { type: "string", description: "Issue ID as string" },
          description: { type: "string", description: "Full markdown description (no length cap)" },
          include_description: { type: "boolean", description: "Echo the full description in the result (default false). Architect + bro only." }
        },
        required: ["agent", "issue_id", "description"]
      }
    },
    {
      name: "issue_update",
      description: "Change an issue's milestone, labels or objective after creation and mirror the change to the linked remote issue when issue sync is on. Bro only. At least one of milestone, labels, objective is required; labels are validated like issue_create (one classification + one priority) and replace the whole set; objective maps to the remote title.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["bro"], description: "Calling agent identity (bro only)" },
          issue_id: { type: "string", description: "Issue ID as string" },
          milestone: { type: "string", description: "Milestone name; its milestones row is created for the issue repo when missing" },
          labels: { type: "array", items: { type: "string" }, description: "Full replacement label set; must include one classification and one priority label, plus exactly one area label when the project configures issue_area_labels" },
          objective: { type: "string", description: "New objective (the remote issue title)" },
          include_description: { type: "boolean", description: "Echo the full description in the result (default false). Architect + bro only." }
        },
        required: ["agent", "issue_id"]
      }
    },
    {
      name: "issue_sync_retry",
      description: "Manually retry remote sync for an issue where auto-sync failed. Bro only. Before it creates, it looks on the remote for the issue's body marker and adopts a match (adopted, duplicates); when that lookup fails it creates nothing (reason lookup_failed).",
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
      description: "Link an existing local issue to an existing remote issue after verifying it exists. Bro only. Errors if the row is already linked to a different iid; re-adopting the same iid is idempotent.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["bro"], description: "Calling agent identity (bro only)" },
          issue_id: { type: "string", description: "Local issue ID" },
          remote_iid: { type: "number", description: "Remote issue number to adopt" },
          remote_backend: { type: "string", enum: ["github", "gitlab"], description: "Optional. Defaults to the repo's sole configured remote." },
          repo: { type: "string", description: "Optional repo name (matches a repos row) to verify against. Required when the issue has no repo and several repos exist; backfills a null issue repo on success." },
          include_description: { type: "boolean", description: "Echo the full description in the result (default false). Architect + bro only." }
        },
        required: ["agent", "issue_id", "remote_iid"]
      }
    },
    {
      name: "issue_link",
      description: "Record a remote issue linkage (gh_iid/gl_iid) for a manually-mirrored issue. Bro only. Rejects if the backend iid is already set unless force=true.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["bro"], description: "Calling agent identity (bro only)" },
          issue_id: { type: "string", description: "Local issue ID" },
          backend: { type: "string", enum: ["github", "gitlab"], description: "Remote backend" },
          iid: { type: "number", description: "Remote issue number" },
          force: { type: "boolean", description: "Overwrite existing iid if already set (default false)" },
          include_description: { type: "boolean", description: "Echo the full description in the result (default false). Architect + bro only." }
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
              hint: issueRepo ? `issue repo "${issueRepo}" has no matching repos row \u2014 run /scan or pass a valid repo.` : "multiple repos registered and no issue repo selected \u2014 pass repo= on issue_create."
            };
            const row2 = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
            const issue2 = decodeIssue(row2);
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
      const row = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      const issue = decodeIssue(row);
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
      const row = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row) {
        throw new Error(`Not found: ${issueId}`);
      }
      const issue = decodeIssue(row);
      return ok(redactIssue(issue, agent, { include_description: includeDescription }));
    }),
    issue_resume: wrapHandler(async (args) => {
      const agent = normalizeAgent(args["agent"]);
      const issueId = requireArg(args, "issue_id");
      const row = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row) {
        throw new Error(`Not found: ${issueId}`);
      }
      const issue = decodeIssue(row);
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
      function projectRow(row) {
        if (!fieldsArg) return row;
        const out = {};
        for (const f of fieldsArg) out[f] = row[f];
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
      const MAX_DESCRIPTION_BYTES = 1024 * 1024;
      if (Buffer.byteLength(description, "utf8") > MAX_DESCRIPTION_BYTES) {
        return err("description exceeds 1MB limit");
      }
      const existing = db.get("SELECT id FROM issues WHERE id = ?", [issueId]);
      if (!existing) {
        return err(`not_found: issue ${issueId}`);
      }
      const now2 = nowISO();
      db.run(
        "UPDATE issues SET description = ?, updated_at = ? WHERE id = ?",
        [description, now2, issueId]
      );
      const updated = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      return ok(redactIssue(decodeIssue(updated), agent, { include_description: includeDescription }));
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
      const row = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row) {
        return err(`not_found: issue ${issueId}`);
      }
      if (labelsArg !== void 0) {
        const labelError = validateIssueLabels(db, labelsArg, options.labelTaxonomy, "issue_update");
        if (labelError) return err(labelError);
      }
      let previousLabels = [];
      if (row.labels != null) {
        try {
          const parsed = JSON.parse(row.labels);
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
        ensureMilestoneRow(db, milestoneArg, row.repo);
        changed.push("milestone");
        before["milestone"] = row.milestone;
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
        before["objective"] = row.objective;
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
        issue_id: row.id,
        from_node: "executor",
        event_type: "issue_updated",
        summary: `issue ${issueId} updated: ${changed.join(", ")}`,
        content_json: JSON.stringify({ issue_id: issueId, changed, before, after }),
        created_at: now2
      });
      let syncDiagnostic;
      if (row.gh_iid == null && row.gl_iid == null) {
        syncDiagnostic = { sync_skipped: true, reason: "no_remote_iid", hint: "The issue has no gh_iid/gl_iid; the change is local only." };
      } else {
        const syncConfigRow = db.get(
          `SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`
        );
        const syncConfig = syncConfigRow ? JSON.parse(syncConfigRow.value_json) : "off";
        if (syncConfig === "off") {
          syncDiagnostic = { sync_skipped: true, reason: "issue_sync_off", hint: "The change is local only; enable issue_sync to mirror it." };
        } else {
          const syncCtx = resolveIssueSyncContext(db, row.repo);
          const remoteProviders = syncCtx ? { github: syncCtx.remoteFor("gh") !== null, gitlab: syncCtx.remoteFor("glab") !== null } : null;
          const backend = resolveBackendFor(syncConfig, remoteProviders, probeSpawn(spawnFn));
          if (backend === null || backend === "off") {
            syncDiagnostic = { sync_skipped: true, reason: "no_remote_configured", hint: "The change is local only." };
          } else if (syncCtx === null) {
            syncDiagnostic = {
              sync_failed: true,
              reason: "unresolvable_repo",
              repo: row.repo,
              backend,
              hint: row.repo ? `issue repo "${row.repo}" has no matching repos row \u2014 run /scan.` : "multiple repos registered and the issue has no repo."
            };
          } else {
            const fields = {};
            if (milestoneArg !== void 0) fields.milestone = milestoneArg;
            if (labelsArg !== void 0) {
              fields.labels = {
                add: labelsArg.filter((l) => !previousLabels.includes(l)),
                remove: previousLabels.filter((l) => !labelsArg.includes(l))
              };
            }
            if (objectiveArg !== void 0) fields.title = objectiveArg;
            const reachable = syncedBackends(backend, syncCtx);
            const targets = [];
            if (reachable.includes("gh") && row.gh_iid != null) targets.push({ cli: "gh", iid: row.gh_iid });
            if (reachable.includes("glab") && row.gl_iid != null) targets.push({ cli: "glab", iid: row.gl_iid });
            const wanted = backend === "both" ? ["gh", "glab"] : [backend];
            const unreachable = wanted.filter((cli) => !reachable.includes(cli) && (cli === "gh" ? row.gh_iid : row.gl_iid) != null);
            if (targets.length === 0 && unreachable.length > 0) {
              syncDiagnostic = { sync_skipped: true, reason: "not_synced", backend, hint: notSyncedHint(unreachable) };
            } else if (targets.length === 0) {
              syncDiagnostic = { sync_skipped: true, reason: "no_remote_iid", backend, hint: "The issue has no remote iid for the resolved backend; the change is local only." };
            } else {
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
                syncDiagnostic = { synced: true, backends: targets.map((t) => t.cli) };
              } else {
                for (const f of failed) {
                  serverLog({ event: "issue_sync_failed", issueId, backend: f.target.cli, reason: f.result.reason, exit_code: f.result.exit_code, stderr: f.result.stderr?.slice(0, 1024), message: f.result.message });
                }
                const first = failed[0];
                syncDiagnostic = {
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
            }
          }
        }
      }
      const updated = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      return ok({
        ...redactIssue(decodeIssue(updated), agent, { include_description: includeDescription }),
        _sync: syncDiagnostic
      });
    })),
    issue_sync_retry: requireRoles("issue_sync_retry", ["bro"], wrapHandler(async (args) => {
      const issueId = requireArg(args, "issue_id");
      const spawnFn = args["_spawnFn"] ?? void 0;
      const row = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row) {
        return err(`not_found: issue ${issueId}`);
      }
      const syncConfigRow = db.get(
        `SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`
      );
      const syncConfig = syncConfigRow ? JSON.parse(syncConfigRow.value_json) : "off";
      if (syncConfig === "off") {
        return ok({ skipped: true, reason: "issue_sync is off" });
      }
      const retryCtx = resolveIssueSyncContext(db, row.repo ?? null);
      const retryRemotes = retryCtx ? { github: retryCtx.remoteFor("gh") !== null, gitlab: retryCtx.remoteFor("glab") !== null } : null;
      const backend = resolveBackendFor(syncConfig, retryRemotes, probeSpawn(spawnFn));
      if (backend === null || backend === "off") {
        return ok({ skipped: true, reason: "no remote backend configured" });
      }
      if (retryCtx === null) {
        return ok({
          skipped: true,
          reason: "unresolvable_repo",
          repo: row.repo ?? null,
          hint: row.repo ? `issue repo "${row.repo}" has no matching repos row.` : "multiple repos registered and no issue repo selected."
        });
      }
      const issue = decodeIssue(row);
      if (row.status === "closed") {
        const retryCwd2 = retryCtx.cwd;
        const retryTargets = [];
        if (row.gh_iid != null) {
          retryTargets.push({ remote_iid: row.gh_iid, remote_kind: "github" });
        }
        if (row.gl_iid != null) {
          retryTargets.push({ remote_iid: row.gl_iid, remote_kind: "gitlab" });
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
      if (reachable.includes("gh") && row.gh_iid == null) {
        createTargets.push("gh");
      }
      if (reachable.includes("glab") && row.gl_iid == null) {
        createTargets.push("glab");
      }
      if (createTargets.length === 0) {
        return ok({ action: "create", success: true, skipped: true, reason: "already_synced" });
      }
      let retryLabels;
      if (row.labels == null) {
        retryLabels = defaultSyncLabels(db);
      } else {
        try {
          const parsed = JSON.parse(row.labels);
          retryLabels = Array.isArray(parsed) ? parsed : defaultSyncLabels(db);
        } catch {
          retryLabels = defaultSyncLabels(db);
        }
      }
      const marker = issueSyncMarker(row.id, row.created_at);
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
            issue_id: row.id,
            from_node: "executor",
            event_type: "issue_adopted",
            summary: `issue ${row.id} adopted ${remoteKind} #${adoptedIid} found by its sync marker`,
            content_json: JSON.stringify({ issue_id: row.id, backend: remoteKind, remote_iid: adoptedIid, via: "issue_sync_retry" }),
            created_at: adoptNow
          });
          adoptions.push({ backend: target, remote_iid: adoptedIid, duplicates });
          lastSuccess = { remote_iid: adoptedIid, remote_kind: remoteKind };
          continue;
        }
        const syncResult = await syncIssueCreate({
          issueId: row.id,
          title: issue.objective,
          body: row.description,
          marker,
          labels: retryLabels,
          milestone: row.milestone ?? void 0,
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
      const row = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row) {
        return err(`not_found: issue ${issueId}`);
      }
      const iidColumn = backend === "github" ? "gh_iid" : "gl_iid";
      const existingIid = backend === "github" ? row.gh_iid : row.gl_iid;
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
      const row = db.get("SELECT * FROM issues WHERE id = ?", [issueId]);
      if (!row) {
        return err(`not_found: issue ${issueId}`);
      }
      if (repoArg !== null && !db.get("SELECT name FROM repos WHERE name = ?", [repoArg])) {
        return err(`repo_not_found: no repos row named "${repoArg}"`);
      }
      const adoptRepo = repoArg ?? row.repo ?? null;
      if (adoptRepo === null) {
        const repoCount = db.get("SELECT COUNT(*) AS n FROM repos")?.n ?? 0;
        if (repoCount > 1) {
          return err(`repo_unresolved: issue ${issueId} has no repo and the workspace has ${repoCount} repos \u2014 pass repo`);
        }
      }
      const adoption = await verifyAdoptionRemote(db, adoptRepo, remoteBackendArg, remoteIid, spawnFn);
      if (!adoption.ok) {
        return err(adoption.error);
      }
      const existingIid = adoption.backend === "github" ? row.gh_iid : row.gl_iid;
      if (existingIid != null && existingIid !== remoteIid) {
        return err(`already_linked: issue ${issueId} already has a ${adoption.backend} link (#${existingIid}); re-adopt is only idempotent for the same iid`);
      }
      const idempotent = existingIid === remoteIid;
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
    }))
  };
  return { definitions, handlers };
}

// ../mcp/trajectory-server/src/tools/discussions.ts
var ALLOWED_KINDS = /* @__PURE__ */ new Set(["intent", "question", "answer", "decision", "note", "analysis"]);
var MAX_BODY_BYTES = 65536;
var HUMAN_AUTHOR = "human";
var HUMAN_AUTHOR_REFUSED = "author_forbidden: discussion_append never writes author='human'. Human rows come only from the rework-waiver-capture hook, which records the Human's own prompt. Write the row under your own name and quote the Human verbatim.";
function ok2(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
function err2(message2) {
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
function wrapHandler2(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err2(e.message);
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
      description: "Search discussions via keyword (FTS5), semantic (cosine), or hybrid (RRF) ranking. Default mode is hybrid. Returns top-K snippets. Use instead of issue_get_with_discussions when you want ranked snippets, not a full dump.",
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
      description: "Append a discussion entry to an issue. Captures conversational intent, questions, answers, decisions, or notes into the SQLite log. issue_id is optional \u2014 defaults to the newest open issue (excluding -1), or -1 if no open issues exist. body is capped at 64 KB; larger payloads return a named validation error.",
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
            description: "Optional \u2014 the task (on this issue) the entry belongs to. That task's task_brief carries its decision/intent rows; an entry without task_id is issue-level."
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
      description: "Return discussion entries for an issue ordered by created_at ASC. Supports optional fields projection: pass fields=['id','kind','author','body'] to return only those columns (unknown fields return a named error). Used by bro at session resume and by snapshot generation.",
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
      description: "Convenience call: returns the issue row + its discussion list + its task list in one round-trip. Default compact mode returns counts + last 10 discussions (configurable via last_n). Pass include_full=true to return all discussions (current full behavior). Respects agent-scoped description redaction.",
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
  function encodeCursor(row) {
    return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id })).toString(
      "base64"
    );
  }
  const handlers = {
    discussion_search: wrapHandler2(async (args) => {
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
        return ok2({
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
          return ok2({ results: [], total_matched: 0, warning: "semantic_unavailable" });
        }
        const results2 = [];
        for (const cr of cosineResults2) {
          const row = fetchRowById(cr.rowid);
          if (row) {
            results2.push({
              id: row.id,
              issue_id: row.issue_id,
              kind: row.kind,
              author: row.author,
              created_at: row.created_at,
              snippet: row.snippet,
              score: cr.score
            });
          }
        }
        return ok2({ results: results2, total_matched: results2.length });
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
          const row = fetchRowById(cr.rowid);
          if (row) scoreMap.set(cr.rowid, { rrf, row });
        }
      });
      const combined = Array.from(scoreMap.values()).map(({ rrf, row }) => {
        const ageDays = row.age_days;
        const decayed = rrf * (Math.exp(-ageDays / 30) * alpha + (1 - alpha));
        return { row, score: decayed };
      });
      combined.sort((a, b) => b.score - a.score);
      const topRows = combined.slice(0, k);
      const results = topRows.map(({ row, score }) => ({
        id: row.id,
        issue_id: row.issue_id,
        kind: row.kind,
        author: row.author,
        created_at: row.created_at,
        snippet: row.snippet,
        score
      }));
      const response = { results, total_matched: results.length };
      if (!semanticAvailable) response["warning"] = "semantic_unavailable";
      return ok2(response);
    }),
    discussion_append: requireRoles(
      "discussion_append",
      ["bro", "swe", "code-reviewer", "consultant"],
      wrapHandler2(async (args) => {
        normalizeAgent(args["agent"]);
        const rawIssueId = args["issue_id"];
        const issueId = rawIssueId != null ? rawIssueId : String(resolveDefaultIssueId(db));
        const author = requireArg2(args, "author");
        if (String(author).trim().toLowerCase() === HUMAN_AUTHOR) return err2(HUMAN_AUTHOR_REFUSED);
        const body = requireArg2(args, "body");
        const kind = args["kind"] ?? "note";
        const bodyBytes = Buffer.byteLength(body, "utf8");
        if (bodyBytes > MAX_BODY_BYTES) {
          return err2(`body exceeds 64KB limit (${bodyBytes} bytes); truncate before calling discussion_append`);
        }
        if (!ALLOWED_KINDS.has(kind)) {
          return err2(
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
          if (task.issue_id !== issue.id) {
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
        const row = db.get("SELECT * FROM discussions WHERE id = ?", [id]);
        return ok2(row);
      })
    ),
    discussion_list: wrapHandler2(async (args) => {
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
          return err2(`Unknown fields: ${unknown.join(", ")}. Allowed: ${[...ALLOWED_DISCUSSION_FIELDS].join(", ")}`);
        }
      }
      function projectRow(row) {
        if (!fieldsArg) return row;
        const out = {};
        for (const f of fieldsArg) out[f] = row[f];
        return out;
      }
      const issue = db.get("SELECT id FROM issues WHERE id = ?", [issueId]);
      if (!issue) {
        return ok2({ discussions: [], warning: "issue not found" });
      }
      if (limitArg === void 0 || limitArg === null) {
        const offset = Math.max(0, rawOffset);
        const rows2 = db.all(
          `SELECT * FROM discussions WHERE issue_id = ? ORDER BY created_at ASC LIMIT 200 OFFSET ?`,
          [issueId, offset]
        );
        return ok2(rows2.map(projectRow));
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
      return ok2({ rows: rows.map(projectRow), next_cursor });
    }),
    issue_get_with_discussions: wrapHandler2(async (args) => {
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
        return ok2({ issue: redactedIssue, discussions: discussions2, tasks: tasks2 });
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
      return ok2({
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
function parseHandlerResult(result) {
  const first = result.content[0];
  const text = first && first.type === "text" ? first.text : "{}";
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: "unparseable_result", message: text };
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
    const noop = () => {
    };
    const db = new TrajectoryDB(
      this.dbPath,
      { pluginVersion: null, serverLog: noop, sqlLog: noop }
    );
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
    const dbVersion = schemaVersion(this.readDb);
    if (dbVersion !== TARGET_SCHEMA_VERSION) {
      return fail(
        409,
        "schema_version_mismatch",
        `The DB is at schema version ${dbVersion ?? "unknown"} and this dashboard writes version ${TARGET_SCHEMA_VERSION}. Open a Claude Code session with the current plugin, then restart the dashboard.`,
        { db_version: dbVersion, dashboard_version: TARGET_SCHEMA_VERSION }
      );
    }
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
    const row = this.open().db.get("SELECT updated_at FROM issues WHERE id = ?", [issueId]);
    return row ? row.updated_at : null;
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
    insertAudit(this.open().db, {
      issue_id: issueId,
      from_node: "dashboard",
      event_type: "issue_updated",
      summary: `the Human ran ${tool} on issue ${issueId} from the dashboard (${fields.join(", ")})`,
      content_json: JSON.stringify({ actor: "human", source: "dashboard", tool, issue_id: issueId, fields, ...extra }),
      created_at: nowISO()
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
    const text = body["body"];
    if (typeof text !== "string" || text.trim() === "") {
      return fail(400, "invalid_fields", "body must be a non-empty string");
    }
    const res = await this.call("discussion_append", {
      issue_id: String(issueId),
      author: "dashboard",
      kind: "note",
      body: text
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

// server/main.ts
setEmbeddingLoader(noEmbeddings);
var HOST2 = "127.0.0.1";
var DEFAULT_PORT = 7477;
var WEB_ROOT = fileURLToPath2(new URL("./web/", import.meta.url));
var MAX_BODY_BYTES2 = 2 * 1024 * 1024;
var TOKEN_HEADER = "x-tmb-token";
var CHANGELOG = process.env["TMB_DASHBOARD_CHANGELOG"] || fileURLToPath2(new URL("../../CHANGELOG.md", import.meta.url));
var RELEASES = loadReleases(CHANGELOG);
var INTERNAL_ERROR = { error: "internal_error", message: "the dashboard server hit an error; its terminal has the details" };
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
  return new DatabaseSync3(path, { readOnly: true });
}
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function clampLimit(raw) {
  const n = Number(raw ?? 100);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), 1e3) : 100;
}
function handleApi(db, url, res) {
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
      case "audit":
        return sendJson(res, 200, audit(db, clampLimit(url.searchParams.get("limit"))));
      case "version":
        return sendJson(res, 200, { data_version: dataVersion(db) });
      case "insights": {
        const filter = insightFilter(url.searchParams);
        return "error" in filter ? sendJson(res, 400, filter) : sendJson(res, 200, insights(db, filter));
      }
      case "world-model": {
        const p = url.searchParams;
        return sendJson(res, 200, worldModel(db, p.get("repo") || null, p.get("path") ?? "", clampDepth(p.get("depth"))));
      }
    }
  }
  if (parts.length === 2 && resource === "insights" && id === "explore") {
    const filter = insightFilter(url.searchParams);
    const body = "error" in filter ? filter : explore(db, filter, url.searchParams, RELEASES);
    return sendJson(res, "error" in body ? 400 : 200, body);
  }
  if (parts.length === 2 && resource === "insights" && id === "compare") {
    const query = compareQuery(url.searchParams);
    return "error" in query ? sendJson(res, 400, query) : sendJson(res, 200, compare(db, query.filter, query.p1, query.p2));
  }
  if (parts.length === 2 && resource === "world-model" && id === "search") {
    const p = url.searchParams;
    return sendJson(res, 200, worldModelSearch(db, p.get("q") ?? "", clampHits(p.get("limit"))));
  }
  if (parts.length === 2 && resource === "world-model" && id === "graph") {
    return sendJson(res, 200, graph(db, url.searchParams.get("repo") || null));
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
  let file = join8(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT) || rel.split(sep3).includes("..")) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync3(file) || !statSync2(file).isFile()) file = join8(WEB_ROOT, "index.html");
  if (!existsSync3(file)) {
    res.writeHead(500, { "content-type": "text/plain" }).end("dashboard web bundle missing; run `bun run build` in dashboard/");
    return;
  }
  if (file.endsWith("index.html")) {
    const html = readFileSync5(file, "utf8").replace(
      "</head>",
      `<meta name="tmb-token" content="${ctx.token}" />
  </head>`
    );
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
    res.end(html);
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync5(file));
}
function tokenMatches(expected, given) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
function readBody(req) {
  return new Promise((resolve3, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES2) {
        req.off("data", onData);
        req.resume();
        resolve3(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve3(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function handleWrite(ctx, req, url, res) {
  const origin = `http://${ctx.host}`;
  if (req.headers.origin !== origin) {
    return sendJson(res, 403, { error: "forbidden_origin", message: `writes are accepted only from ${origin}/` });
  }
  if (!tokenMatches(ctx.token, req.headers[TOKEN_HEADER])) {
    return sendJson(res, 403, { error: "bad_token", message: "missing or wrong dashboard token; reload the page" });
  }
  const match = /^\/api\/issues\/([1-9]\d*)\/([a-z]+)$/.exec(url.pathname);
  const action = match?.[2];
  if (!match || action === void 0 || !isWriteAction(action)) return sendJson(res, 404, { error: "unknown endpoint" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return sendJson(res, 415, { error: "unsupported_media_type", message: "send application/json" });
  }
  const raw = await readBody(req);
  if (raw === null) {
    res.setHeader("connection", "close");
    return sendJson(res, 413, { error: "body_too_large", message: `the body is over ${MAX_BODY_BYTES2} bytes` });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "invalid_json" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return sendJson(res, 400, { error: "invalid_json", message: "body must be a JSON object" });
  }
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
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) handleApi(ctx.db, url, res);
    else serveStatic(ctx, url.pathname, res);
  } catch (err3) {
    console.error("dashboard request failed:", err3);
    if (res.headersSent) res.end();
    else sendJson(res, 500, INTERNAL_ERROR);
  }
}
function main() {
  const dbPath = resolveClaudeDbPath();
  const db = openDb(dbPath);
  const ctx = { db, writer: new IssueWriter(dbPath, db), token: randomBytes(32).toString("hex"), host: "" };
  const server = createServer((req, res) => void handle(ctx, req, res));
  server.on("error", (err3) => {
    console.error(`dashboard server failed: ${err3.message}`);
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
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
try {
  main();
} catch (err3) {
  console.error(err3 instanceof Error ? err3.message : String(err3));
  process.exit(1);
}
