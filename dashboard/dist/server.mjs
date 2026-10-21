// server/main.ts
import { createServer } from "node:http";
import { existsSync as existsSync2, readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
import { extname, join as join2, normalize, sep as sep2 } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// ../mcp/trajectory-server/src/platform.ts
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  basename,
  dirname,
  isAbsolute,
  join,
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
      readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")
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
function resolveClaudeProjectRoot(env = process.env) {
  const root = env["CLAUDE_PROJECT_DIR"];
  return root && root.trim().length > 0 ? root : null;
}
function resolveClaudeDbPath(opts) {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();
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
  return join(root, CLAUDE_STATE_HOST_DIR, pluginName, "trajectory.db");
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
  return existsSync(join(dirname(dbPath), CLAUDE_STANDALONE_MARKER));
}
function walkClaudeDbs(start, pluginName, opts) {
  const home = opts?.home ?? homedir();
  const probe = opts?.probe ?? probeClaudeDb;
  const found = [];
  for (let dir = start; dirname(dir) !== dir; dir = dirname(dir)) {
    if (dir === home && start !== home) break;
    const candidate = claudeDbLocation(dir, pluginName);
    if (!existsSync(candidate) || probe(candidate) === "stale") continue;
    found.push(candidate);
    if (isStandaloneClaudeDb(candidate)) break;
  }
  return { resolved: found.length === 0 ? null : found[found.length - 1], candidates: found };
}
function findExistingClaudeDbUp(startDir, pluginName, opts) {
  const env = opts?.env ?? process.env;
  const override = env["TRAJECTORY_DB_PATH"];
  if (override && override.trim().length > 0) {
    return existsSync(override) ? override : null;
  }
  const projectRoot = opts?.projectRoot !== void 0 ? opts.projectRoot : resolveClaudeProjectRoot(env);
  return walkClaudeDbs(projectRoot ?? startDir, pluginName, opts).resolved;
}
function freezePlugin(plugin) {
  return Object.freeze(plugin);
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
function issues(db) {
  return all(
    db,
    `SELECT i.id, i.objective, i.status, i.repo, i.milestone, i.gh_iid, i.gl_iid,
            i.created_at, i.updated_at, i.closed_at,
            (SELECT COUNT(*) FROM tasks t WHERE t.issue_id = i.id) AS task_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.issue_id = i.id
               AND t.status IN ('completed','closed')) AS tasks_done
       FROM issues i
      WHERE i.id > 0
      ORDER BY i.status = 'open' DESC, i.updated_at DESC`
  );
}
function issueDetail(db, id) {
  const issue = one(db, `SELECT * FROM issues WHERE id = ?`, id);
  if (!issue) return null;
  return {
    issue,
    discussions: all(
      db,
      `SELECT id, author, kind, body, created_at FROM discussions
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
            t.completed_at
       FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
      ORDER BY t.id DESC LIMIT ?`,
    RECENT_LIMIT * 5
  );
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
  return { available: true, repos, nodes };
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
  return { available: true, hits };
}

// server/main.ts
var HOST = "127.0.0.1";
var DEFAULT_PORT = 7477;
var WEB_ROOT = fileURLToPath(new URL("./web/", import.meta.url));
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
  if (path === ":memory:" || !existsSync2(path)) {
    throw new Error(
      `No trajectory DB at ${path}. Run from an onboarded project or set TRAJECTORY_DB_PATH.`
    );
  }
  return new DatabaseSync2(path, { readOnly: true });
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
      case "world-model": {
        const p = url.searchParams;
        return sendJson(res, 200, worldModel(db, p.get("repo") || null, p.get("path") ?? "", clampDepth(p.get("depth"))));
      }
    }
  }
  if (parts.length === 2 && resource === "world-model" && id === "search") {
    const p = url.searchParams;
    return sendJson(res, 200, worldModelSearch(db, p.get("q") ?? "", clampHits(p.get("limit"))));
  }
  if (parts.length === 2 && resource === "issues" && /^-?\d+$/.test(id)) {
    const detail = issueDetail(db, Number(id));
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "issue not found" });
  }
  sendJson(res, 404, { error: "unknown endpoint" });
}
function serveStatic(pathname, res) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join2(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT) || rel.split(sep2).includes("..")) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync2(file) || !statSync2(file).isFile()) file = join2(WEB_ROOT, "index.html");
  if (!existsSync2(file)) {
    res.writeHead(500, { "content-type": "text/plain" }).end("dashboard web bundle missing; run `bun run build` in dashboard/");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync2(file));
}
function handle(db, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  try {
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) handleApi(db, url, res);
    else serveStatic(url.pathname, res);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
function main() {
  const dbPath = resolveClaudeDbPath();
  const db = openDb(dbPath);
  const server = createServer((req, res) => handle(db, req, res));
  server.on("error", (err) => {
    console.error(`dashboard server failed: ${err.message}`);
    process.exit(1);
  });
  server.listen(parsePort(process.env["TMB_DASHBOARD_PORT"]), HOST, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : DEFAULT_PORT;
    console.log(`TMB dashboard (read-only) on ${dbPath}`);
    console.log(`http://${HOST}:${port}/`);
  });
  const shutdown = () => {
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
