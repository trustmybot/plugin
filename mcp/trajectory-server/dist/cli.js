// src/cli/bro-sqlite-readonly.ts
import { appendFileSync, existsSync as existsSync3, mkdirSync, mkdtempSync, rmSync } from "node:fs";

// src/hooks/lib/db.ts
import { accessSync as accessSync2, closeSync, constants as constants2, existsSync as existsSync2, openSync, readFileSync as readFileSync2, readSync, realpathSync as realpathSync2, statSync as statSync2 } from "node:fs";

// src/hooks/lib/project-env.ts
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// src/hooks/lib/jq-key-order.ts
var INTEGER_LIKE_KEY = /"(?:\d|\\u003\d)+"\s*:/;
var inputOrder = /* @__PURE__ */ new WeakMap();
var anyReordered = false;
var isRawJson = (value) => JSON.isRawJSON?.(value) ?? false;
function valueEnd(text, start) {
  const first = text[start];
  if (first === '"') {
    let i2 = start + 1;
    while (i2 < text.length) {
      if (text[i2] === "\\") i2 += 2;
      else if (text[i2] === '"') return i2 + 1;
      else i2 += 1;
    }
    return -1;
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    let i2 = start;
    while (i2 < text.length) {
      const ch = text[i2];
      if (ch === '"') {
        const end = valueEnd(text, i2);
        if (end < 0) return -1;
        i2 = end;
        continue;
      }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return i2 + 1;
      }
      i2 += 1;
    }
    return -1;
  }
  let i = start;
  while (i < text.length && !/[\s{}[\]",]/.test(text[i])) i += 1;
  return i === start ? -1 : i;
}
function skipSpace(text, start) {
  let i = start;
  while (/\s/.test(text[i] ?? "")) i += 1;
  return i;
}
function scan(text, start) {
  const open = text[start];
  if (open !== "{" && open !== "[") return { end: valueEnd(text, start) };
  const fields = /* @__PURE__ */ new Map();
  const items = [];
  let i = skipSpace(text, start + 1);
  while (text[i] !== "}" && text[i] !== "]") {
    if (open === "{") {
      const keyEnd = valueEnd(text, i);
      const child = scan(text, skipSpace(text, skipSpace(text, keyEnd) + 1));
      fields.set(JSON.parse(text.slice(i, keyEnd)), child);
      i = child.end;
    } else {
      const child = scan(text, i);
      items.push(child);
      i = child.end;
    }
    i = skipSpace(text, i);
    if (text[i] === ",") i = skipSpace(text, i + 1);
  }
  return open === "{" ? { end: i + 1, fields } : { end: i + 1, items };
}
function remember(value, shape) {
  if (value === null || typeof value !== "object") return;
  if (shape.items) shape.items.forEach((item, i) => remember(value[i], item));
  if (!shape.fields) return;
  const order = [...shape.fields.keys()];
  for (const [key, field2] of shape.fields) remember(value[key], field2);
  if (Object.keys(value).some((key, i) => key !== order[i])) {
    inputOrder.set(value, order);
    anyReordered = true;
  }
}
function parseKeepingKeyOrder(text, reviver) {
  const value = JSON.parse(text, reviver);
  if (!INTEGER_LIKE_KEY.test(text)) return value;
  try {
    remember(value, scan(text, 0));
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
  return value;
}
function keysInOrder(value) {
  return inputOrder.get(value) ?? Object.keys(value);
}
function render(value, indent, at) {
  if (value === null || typeof value !== "object" || isRawJson(value)) return JSON.stringify(value) ?? "null";
  const inner = at + indent;
  const record = value;
  const [open, close] = Array.isArray(value) ? "[]" : "{}";
  const body = Array.isArray(value) ? value.map((v) => render(v, indent, inner)) : keysInOrder(value).filter((key) => record[key] !== void 0).map((key) => `${JSON.stringify(key)}:${indent === "" ? "" : " "}${render(record[key], indent, inner)}`);
  if (body.length === 0) return `${open}${close}`;
  return indent === "" ? `${open}${body.join(",")}${close}` : `${open}
${inner}${body.join(`,
${inner}`)}
${at}${close}`;
}
function stringifyInOrder(value, indent = 0) {
  return anyReordered ? render(value, " ".repeat(indent), "") : JSON.stringify(value, null, indent);
}

// src/hooks/lib/project-env.ts
var TMB_STATE_HOST_DIR = ".claude";
var TMB_DB_FILENAME = "trajectory.db";
var DEFAULT_PLUGIN_NAME = "tmb";
function posixDirname(path) {
  if (path === "") return ".";
  let p = path.replace(/\/+$/, "");
  if (p === "") return "/";
  const slash = p.lastIndexOf("/");
  if (slash < 0) return ".";
  p = p.slice(0, slash).replace(/\/+$/, "");
  return p === "" ? "/" : p;
}
function posixBasename(path) {
  if (path === "") return "";
  const p = path.replace(/\/+$/, "");
  if (p === "") return "/";
  return p.slice(p.lastIndexOf("/") + 1);
}
function jqRawText(value) {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return stringifyInOrder(value, 2);
  return String(value);
}
function pluginName(env = process.env) {
  const root = env.CLAUDE_PLUGIN_ROOT ?? "";
  return root === "" ? DEFAULT_PLUGIN_NAME : manifestName(`${root}/.claude-plugin/plugin.json`);
}
function manifestName(manifest) {
  let text;
  try {
    if (!statSync(manifest).isFile()) return DEFAULT_PLUGIN_NAME;
    text = readFileSync(manifest, "utf8");
  } catch {
    return DEFAULT_PLUGIN_NAME;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_PLUGIN_NAME;
    const name2 = parsed.name;
    return name2 === void 0 || name2 === null || name2 === false ? DEFAULT_PLUGIN_NAME : jqRawText(name2);
  } catch {
    return DEFAULT_PLUGIN_NAME;
  }
}
function claudeProjectDir(env = process.env) {
  return env.CLAUDE_PROJECT_DIR ?? "";
}
function homeDir(env = process.env) {
  return env.HOME ?? "";
}
function sameDir(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
function shellPwd(env = process.env) {
  const cwd = process.cwd();
  const pwd = env.PWD ?? "";
  return pwd !== "" && isAbsolute(pwd) && sameDir(pwd, cwd) ? pwd : cwd;
}
function installRoot(fromDir) {
  let dir = fromDir;
  for (; ; ) {
    try {
      if (statSync(join(dir, ".claude-plugin", "plugin.json")).isFile()) return dir;
    } catch {
    }
    const parent = posixDirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// src/hooks/lib/jq.ts
function jsonStream(text) {
  const values = [];
  let i = 0;
  for (; ; ) {
    while (i < text.length && /[ \t\n\r]/.test(text[i])) i += 1;
    if (i >= text.length) return { values, complete: true };
    const end = valueEnd(text, i);
    if (end < 0) return { values, complete: false };
    try {
      values.push(parseKeepingKeyOrder(text.slice(i, end)));
    } catch {
      return { values, complete: false };
    }
    i = end;
  }
}
var rawJson = JSON.rawJSON;

// src/hooks/lib/sqlite-shell.ts
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { performance } from "node:perf_hooks";

// src/hooks/lib/deadline.ts
import { AsyncLocalStorage } from "node:async_hooks";
var MAX_TIMER_MS = 2 ** 31 - 1;
var scopes = new AsyncLocalStorage();
function msLeft(at, now) {
  return Math.max(1, Math.ceil(at - now()));
}
function spawnLimit(ownMs, killSignal = "SIGTERM") {
  const scope = scopes.getStore();
  const left = scope ? msLeft(scope.at, scope.now) : void 0;
  if (left === void 0 || ownMs !== void 0 && ownMs < left) {
    return ownMs === void 0 ? null : { timeout: ownMs, killSignal, byDeadline: false };
  }
  return { timeout: left, killSignal, byDeadline: true };
}
function spawnOptions(limit) {
  return limit ? { timeout: limit.timeout, killSignal: limit.killSignal } : {};
}
function noteSpawn(limit, r) {
  const cut = r.error?.code === "ETIMEDOUT" || r.signal !== null;
  const scope = scopes.getStore();
  if (cut && limit?.byDeadline && scope) scope.expired = true;
  return cut;
}

// src/hooks/lib/sqlite-shell.ts
var KILLED_CODE = 124;
var NOT_FOUND_CODE = 127;
var MAX_BUFFER = 64 * 1024 * 1024;
var nodeSqlite;
function isSqliteExperimentalWarning(warning, rest) {
  const message = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  const opt = rest[0];
  const type = typeof opt === "string" ? opt : opt !== null && typeof opt === "object" && typeof opt.type === "string" ? opt.type : warning instanceof Error ? warning.name : "";
  return type === "ExperimentalWarning" && /sqlite/i.test(message);
}
function loadNodeSqlite() {
  if (nodeSqlite !== void 0) return nodeSqlite;
  const original = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    return original.call(process, warning, ...rest);
  };
  try {
    const get = process.getBuiltinModule;
    const mod = typeof get === "function" ? get.call(process, "node:sqlite") : void 0;
    nodeSqlite = mod && typeof mod.DatabaseSync === "function" && typeof mod.StatementSync?.prototype?.setReturnArrays === "function" ? mod : null;
  } catch {
    nodeSqlite = null;
  } finally {
    process.emitWarning = original;
  }
  return nodeSqlite;
}
function sqliteBackend(env = process.env) {
  return env.TMB_HOOKS_SQLITE === "cli" || loadNodeSqlite() === null ? "cli" : "node";
}
function onPath(command, env) {
  for (const dir of (env.PATH ?? "").split(":")) {
    try {
      accessSync(`${dir === "" ? "." : dir}/${command}`, constants.X_OK);
      return true;
    } catch {
    }
  }
  return false;
}
function haveSqlite(env = process.env) {
  return sqliteBackend(env) === "node" || onPath("sqlite3", env);
}
function sqliteRun(call, env = process.env) {
  const sqlite2 = sqliteBackend(env) === "node" ? loadNodeSqlite() : null;
  return sqlite2 ? runNode(sqlite2, call) : runCli(call, env);
}
function cliArgs(call) {
  const args = [];
  if (call.bail) args.push("-bail");
  if (call.readonly) args.push("-readonly");
  args.push("-cmd", `.timeout ${call.timeoutMs}`, call.target);
  if (call.sql !== void 0) args.push(call.sql);
  return args;
}
function runCli(call, env) {
  const limit = spawnLimit(call.killAfterMs, "SIGKILL");
  const r = spawnSync("sqlite3", cliArgs(call), {
    env,
    input: call.sql === void 0 ? call.script ?? "" : void 0,
    stdio: [call.sql === void 0 ? "pipe" : "ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    ...spawnOptions(limit)
  });
  noteSpawn(limit, r);
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const errno = r.error?.code;
  if (errno === "ENOENT") return { code: NOT_FOUND_CODE, stdout: "", stderr: "sqlite3: command not found\n" };
  if (errno === "ETIMEDOUT" || r.signal === "SIGKILL") return { code: KILLED_CODE, stdout, stderr: "" };
  if (r.error) return { code: 1, stdout, stderr: stderr || `${r.error.message}
` };
  return { code: r.status ?? 1, stdout, stderr };
}
var TOKEN_COLUMN = {
  semi: 0,
  ws: 1,
  other: 2,
  explain: 3,
  create: 4,
  temp: 5,
  trigger: 6,
  end: 7
};
var COMPLETE_TRANS = [
  [1, 0, 2, 3, 4, 2, 2, 2],
  [1, 1, 2, 3, 4, 2, 2, 2],
  [1, 2, 2, 2, 2, 2, 2, 2],
  [1, 3, 3, 2, 4, 2, 2, 2],
  [1, 4, 2, 2, 2, 4, 5, 2],
  [6, 5, 5, 5, 5, 5, 5, 5],
  [6, 6, 5, 5, 5, 5, 5, 7],
  [1, 7, 5, 5, 5, 5, 5, 5]
];
function isIdChar(ch) {
  if (ch === void 0) return false;
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 128;
}
function keywordKind(word) {
  switch (word.toLowerCase()) {
    case "create":
      return "create";
    case "trigger":
      return "trigger";
    case "temp":
    case "temporary":
      return "temp";
    case "end":
      return "end";
    case "explain":
      return "explain";
    default:
      return "other";
  }
}
function scanSql(sql) {
  const tokens = [];
  let unterminated = false;
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const ch = sql[i];
    if (ch === ";") {
      tokens.push({ kind: "semi", start, end: ++i });
    } else if (ch === " " || ch === "	" || ch === "\n" || ch === "\f" || ch === "\r") {
      tokens.push({ kind: "ws", start, end: ++i });
    } else if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close < 0) {
        unterminated = true;
        i = sql.length;
      } else {
        i = close + 2;
      }
      tokens.push({ kind: "ws", start, end: i });
    } else if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
      tokens.push({ kind: "ws", start, end: i });
    } else if (ch === "[" || ch === "`" || ch === '"' || ch === "'") {
      const close = sql.indexOf(ch === "[" ? "]" : ch, i + 1);
      if (close < 0) {
        unterminated = true;
        i = sql.length;
      } else {
        i = close + 1;
      }
      tokens.push({ kind: "other", start, end: i });
    } else if ((ch === ":" || ch === "@") && isIdChar(sql[i + 1])) {
      i += 1;
      while (isIdChar(sql[i])) i += 1;
      tokens.push({ kind: "other", start, end: i, param: sql.slice(start, i) });
    } else if (isIdChar(ch)) {
      while (isIdChar(sql[i])) i += 1;
      const word = sql.slice(start, i);
      tokens.push(
        word.startsWith("$") && word.length > 1 ? { kind: "other", start, end: i, param: word } : { kind: keywordKind(word), start, end: i }
      );
    } else {
      tokens.push({ kind: "other", start, end: ++i });
    }
  }
  return { tokens, unterminated };
}
function sqlComplete(sql) {
  const { tokens, unterminated } = scanSql(sql);
  if (unterminated) return false;
  let state = 0;
  for (const t of tokens) state = COMPLETE_TRANS[state][TOKEN_COLUMN[t.kind]];
  return state === 1;
}
function splitStatements(sql) {
  const { tokens } = scanSql(sql);
  const out = [];
  let state = 0;
  let begin = 0;
  let dark = false;
  let params = /* @__PURE__ */ new Set();
  const flush = (end) => {
    if (dark) out.push({ text: sql.slice(begin, end), params: [...params] });
    begin = end;
    dark = false;
    params = /* @__PURE__ */ new Set();
  };
  for (const t of tokens) {
    const next = COMPLETE_TRANS[state][TOKEN_COLUMN[t.kind]];
    if (t.kind !== "ws" && t.kind !== "semi") dark = true;
    if (t.param) params.add(t.param);
    state = next;
    if (t.kind === "semi" && next === 1) flush(t.end);
  }
  flush(sql.length);
  return out;
}
function formatReal(x) {
  if (x === 0) return "0.0";
  if (Number.isNaN(x)) return "";
  if (!Number.isFinite(x)) return x > 0 ? "Inf" : "-Inf";
  const [mantissa, expText] = x.toExponential(14).split("e");
  const exp = Number(expText);
  const trim = (digits) => {
    if (!digits.includes(".")) return `${digits}.0`;
    const t = digits.replace(/0+$/, "");
    return t.endsWith(".") ? `${t}0` : t;
  };
  if (exp < -4 || exp >= 15) {
    return `${trim(mantissa)}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return trim(x.toFixed(14 - exp));
}
function cutAtNul(text) {
  const nul = text.indexOf("\0");
  return nul < 0 ? text : text.slice(0, nul);
}
function listValue(v) {
  if (v === null || v === void 0) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return formatReal(v);
  if (typeof v === "string") return cutAtNul(v);
  if (v instanceof Uint8Array) return cutAtNul(Buffer.from(v).toString("utf8"));
  return String(v);
}
function failure(e) {
  const err = e;
  const ext = err && typeof err.errcode === "number" ? err.errcode : 1;
  return {
    code: ext & 255 || 1,
    message: err && typeof err.message === "string" ? err.message : String(e)
  };
}
function withCode(f) {
  return f.code > 1 ? `${f.message} (${f.code})` : f.message;
}
var Killed = class extends Error {
};
var ShellSession = class {
  db;
  deadline;
  parameters = /* @__PURE__ */ new Map();
  busyMs;
  stdout = "";
  stderr = "";
  constructor(db, timeoutMs, killAfterMs) {
    this.db = db;
    this.busyMs = timeoutMs;
    this.deadline = killAfterMs === void 0 ? Infinity : performance.now() + killAfterMs;
    this.applyTimeout(timeoutMs);
  }
  applyTimeout(ms) {
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(ms))}`);
  }
  checkDeadline() {
    if (performance.now() >= this.deadline) throw new Killed();
  }
  setTimeout(ms) {
    this.busyMs = ms;
    this.applyTimeout(ms);
  }
  beforeStatement() {
    this.checkDeadline();
    if (this.deadline !== Infinity) {
      this.applyTimeout(Math.min(this.busyMs, Math.ceil(this.deadline - performance.now())));
    }
  }
  /** Runs one statement; null on success, else where and why it failed. */
  run(stmt) {
    this.beforeStatement();
    let prepared;
    try {
      prepared = this.db.prepare(stmt.text);
    } catch (e) {
      this.checkDeadline();
      return { phase: "prepare", failure: failure(e) };
    }
    try {
      prepared.setReturnArrays(true);
      prepared.setReadBigInts(true);
      const bound = {};
      for (const name2 of stmt.params) {
        if (this.parameters.has(name2)) bound[name2] = this.parameters.get(name2) ?? null;
      }
      const rows = Object.keys(bound).length > 0 ? prepared.iterate(bound) : prepared.iterate();
      let out = "";
      for (const row of rows) {
        this.checkDeadline();
        const values = Array.isArray(row) ? row : Object.values(row);
        out += `${values.map(listValue).join("|")}
`;
      }
      this.checkDeadline();
      this.stdout += out;
    } catch (e) {
      this.checkDeadline();
      return { phase: "step", failure: failure(e) };
    }
    return null;
  }
  evalParameter(value) {
    try {
      const prepared = this.db.prepare(`SELECT ${value}`);
      prepared.setReturnArrays(true);
      prepared.setReadBigInts(true);
      const rows = prepared.all();
      if (rows.length === 1 && rows[0].length === 1) return rows[0][0];
    } catch {
    }
    return value;
  }
  setParameter(name2, value) {
    this.parameters.set(name2, this.evalParameter(value));
  }
  clearParameters() {
    this.parameters.clear();
  }
};
function openSession(sqlite2, call) {
  try {
    const db = new sqlite2.DatabaseSync(call.target, {
      readOnly: call.readonly,
      enableDoubleQuotedStringLiterals: true,
      enableForeignKeyConstraints: false
    });
    return new ShellSession(db, call.timeoutMs, call.killAfterMs);
  } catch (e) {
    return failure(e);
  }
}
function closeSession(session) {
  try {
    session.db.close();
  } catch {
  }
}
function runNode(sqlite2, call) {
  const opened = openSession(sqlite2, call);
  if (!(opened instanceof ShellSession)) {
    return {
      code: call.sql !== void 0 ? opened.code : 1,
      stdout: "",
      stderr: `Error: unable to open database "${call.target}": ${opened.message}
`
    };
  }
  try {
    const code = call.sql !== void 0 ? runArgMode(opened, call.sql) : runStdinMode(opened, call.script ?? "", !!call.bail);
    return { code, stdout: opened.stdout, stderr: opened.stderr };
  } catch (e) {
    if (e instanceof Killed) return { code: KILLED_CODE, stdout: opened.stdout, stderr: "" };
    throw e;
  } finally {
    closeSession(opened);
  }
}
function runArgMode(session, sql) {
  for (const stmt of splitStatements(sql)) {
    const failed = session.run(stmt);
    if (failed) {
      session.stderr += `Error: ${failed.phase === "prepare" ? "in prepare" : "stepping"}, ${withCode(failed.failure)}
`;
      return failed.failure.code;
    }
  }
  return 0;
}
var QSS_START = { wait: "", dark: false, semi: false };
function isSpace(ch) {
  return ch === " " || ch === "	" || ch === "\n" || ch === "\v" || ch === "\f" || ch === "\r";
}
function quickscan(line, prev) {
  const q = { ...prev };
  let i = 0;
  for (; ; ) {
    if (q.wait === "") {
      let jumped = false;
      while (i < line.length) {
        const ch = line[i++];
        if (isSpace(ch)) continue;
        if (ch === "-" && line[i] === "-") return q;
        if (ch === ";") {
          q.semi = true;
          continue;
        }
        if (ch === "/" && line[i] === "*") {
          i += 1;
          q.wait = "*";
          jumped = true;
          break;
        }
        if (ch === "[" || ch === "`" || ch === "'" || ch === '"') {
          q.wait = ch === "[" ? "]" : ch;
          q.dark = true;
          q.semi = false;
          jumped = true;
          break;
        }
        q.semi = false;
        q.dark = true;
      }
      if (!jumped) return q;
    } else {
      let jumped = false;
      while (i < line.length) {
        const ch = line[i++];
        if (ch !== q.wait) continue;
        if (q.wait === "*") {
          if (line[i] !== "/") continue;
          i += 1;
        } else if (q.wait !== "]" && line[i] === q.wait) {
          i += 1;
          continue;
        }
        q.wait = "";
        jumped = true;
        break;
      }
      if (!jumped) return q;
    }
  }
}
function plainWhite(q) {
  return q.wait === "" && !q.dark;
}
function semiTerminated(q) {
  return q.wait === "" && q.semi;
}
function inputLines(script) {
  if (script === "") return [];
  const lines = script.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => l.endsWith("\r") ? l.slice(0, -1) : l);
}
var BACKSLASH_ESCAPES = {
  a: "\x07",
  b: "\b",
  t: "	",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  '"': '"',
  "'": "'",
  "\\": "\\"
};
function resolveBackslashes(text) {
  return text.replace(/\\([0-7]{1,3}|.)/gs, (all, esc) => {
    if (/^[0-7]/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    return BACKSLASH_ESCAPES[esc] ?? all;
  });
}
function metaArgs(line) {
  const args = [];
  let i = 1;
  while (i < line.length) {
    while (i < line.length && isSpace(line[i])) i += 1;
    if (i >= line.length) break;
    const delim = line[i];
    if (delim === "'" || delim === '"') {
      i += 1;
      const start = i;
      while (i < line.length && line[i] !== delim) {
        if (line[i] === "\\" && delim === '"' && i + 1 < line.length) i += 1;
        i += 1;
      }
      const word = line.slice(start, i);
      if (i < line.length) i += 1;
      args.push(delim === '"' ? resolveBackslashes(word) : word);
    } else {
      const start = i;
      while (i < line.length && !isSpace(line[i])) i += 1;
      args.push(line.slice(start, i));
    }
  }
  return args;
}
function integerValue(text) {
  const m = /^\s*([+-]?\d+)/.exec(text);
  return m ? Number(m[1]) : 0;
}
function runMeta(session, line) {
  const args = metaArgs(line);
  const cmd = args[0] ?? "";
  if (cmd === "timeout") {
    session.setTimeout(args.length >= 2 ? integerValue(args[1]) : 0);
    return 0;
  }
  if (cmd === "parameter" || cmd === "param") {
    const sub = args[1] ?? "";
    if ((sub === "clear" || sub === "init") && args.length === 2) {
      if (sub === "clear") session.clearParameters();
      return 0;
    }
    if (sub === "set" && args.length === 4) {
      session.setParameter(args[2], args[3]);
      return 0;
    }
  }
  session.stderr += `Error: unknown command or invalid arguments:  "${cmd}". Enter ".help" for help
`;
  return 1;
}
function runChunk(session, sql, startLine) {
  for (const stmt of splitStatements(sql)) {
    const failed = session.run(stmt);
    if (failed) {
      const type = failed.phase === "prepare" ? "Parse error" : "Runtime error";
      session.stderr += `${type} near line ${startLine}: ${withCode(failed.failure)}
`;
      return 1;
    }
  }
  return 0;
}
function runStdinMode(session, script, bail) {
  let errors = 0;
  let qss = QSS_START;
  let sql = "";
  let startLine = 0;
  let lineNo = 0;
  for (const line of inputLines(script)) {
    if (errors > 0 && bail) break;
    lineNo += 1;
    qss = quickscan(line, qss);
    if (plainWhite(qss) && sql === "") {
      qss = QSS_START;
      continue;
    }
    if ((line[0] === "." || line[0] === "#") && sql === "") {
      if (line[0] === ".") errors += runMeta(session, line);
      qss = QSS_START;
      continue;
    }
    if (sql === "") {
      sql = line.replace(/^[ \t\n\v\f\r]+/, "");
      startLine = lineNo;
    } else {
      sql += `
${line}`;
    }
    if (sql !== "" && semiTerminated(qss) && sqlComplete(sql)) {
      errors += runChunk(session, sql, startLine);
      sql = "";
      qss = QSS_START;
    } else if (sql !== "" && plainWhite(qss)) {
      sql = "";
      qss = QSS_START;
    }
  }
  if (sql !== "") errors += runChunk(session, sql, startLine);
  return errors > 0 ? 1 : 0;
}

// src/hooks/lib/db.ts
var GATE_READ_ERROR = "__ERR__";
var DEFAULT_READ_TIMEOUT_MS = 1500;
function stripTrailingNewlines(text) {
  return text.replace(/\n+$/, "");
}
function isFile(path) {
  try {
    return statSync2(path).isFile();
  } catch {
    return false;
  }
}
function digitsOr(value, fallback) {
  return value !== void 0 && /^[0-9]+$/.test(value) ? Number(value) : fallback;
}
function readTimeoutMs(env) {
  const raw = env.TMB_DB_WRITE_TIMEOUT_MS;
  return digitsOr(raw === "" ? void 0 : raw, DEFAULT_READ_TIMEOUT_MS);
}
function dbLocation(root, env = process.env) {
  return `${root}/${TMB_STATE_HOST_DIR}/${pluginName(env)}/${TMB_DB_FILENAME}`;
}
function walCold(db) {
  if (existsSync2(`${db}-shm`)) return false;
  let fd;
  try {
    fd = openSync(db, "r");
    const buf = Buffer.alloc(2);
    const n = readSync(fd, buf, 0, 2, 18);
    return [...buf.subarray(0, n)].join("") === "22";
  } catch {
    return false;
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function sqliteOnce(ro, ms, target, sql, env) {
  const r = sqliteRun({ target, readonly: ro, timeoutMs: ms, sql }, env);
  return { code: r.code, out: stripTrailingNewlines(r.stdout) };
}
function immutableUri(db, env = process.env) {
  let p = db.startsWith("/") ? db : `${shellPwd(env).replace(/\/$/, "")}/${db}`;
  p = p.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23");
  return `file:${p}?immutable=1`;
}
function dbReadRo(db, sql, env = process.env) {
  const ms = readTimeoutMs(env);
  if (db === "" || !isFile(db)) return GATE_READ_ERROR;
  let r;
  if (sqliteBackend(env) === "node" && walCold(db)) {
    r = sqliteOnce(true, ms, immutableUri(db, env), sql, env);
  } else {
    r = sqliteOnce(true, ms, db, sql, env);
    if (r.code !== 0 && walCold(db)) r = sqliteOnce(true, ms, immutableUri(db, env), sql, env);
  }
  return r.code === 0 ? r.out : GATE_READ_ERROR;
}
function dbProbe(db, env = process.env) {
  if (db === "" || !isFile(db)) return 1;
  if (!haveSqlite(env)) return 0;
  const cols = dbReadRo(db, "SELECT name FROM pragma_table_info('tasks');", env);
  if (cols === GATE_READ_ERROR) return 2;
  return cols.includes("prompt_bearing") ? 0 : 1;
}
function testFlag(env = process.env) {
  if (env.TMB_FORBID_LIVE_SYNC === "1") return "TMB_FORBID_LIVE_SYNC";
  if ((env.TMB_TEST_RUN_ID ?? "") !== "") return "TMB_TEST_RUN_ID";
  return null;
}
function dbResolve(env = process.env) {
  const explicit = env.TRAJECTORY_DB_PATH ?? "";
  if (explicit !== "") return { path: isFile(explicit) ? explicit : null, warning: "" };
  const flag = testFlag(env);
  if (flag) {
    const project = claudeProjectDir(env);
    if (project !== "") {
      const candidate = dbLocation(project, env);
      return { path: isFile(candidate) ? candidate : null, warning: "" };
    }
    return {
      path: null,
      warning: `tmb: trajectory DB unresolved: ${flag} is set and neither TRAJECTORY_DB_PATH nor CLAUDE_PROJECT_DIR is (walk-up discovery disabled)`
    };
  }
  const start = claudeProjectDir(env) || shellPwd(env);
  const home = homeDir(env);
  let outermost = "";
  let dir = start;
  while (dir !== "" && dir !== "/") {
    if (dir === home && start !== home) break;
    const candidate = dbLocation(dir, env);
    if (isFile(candidate) && dbProbe(candidate, env) !== 1) {
      outermost = candidate;
      if (existsSync2(`${posixDirname(candidate)}/standalone`)) break;
    }
    const parent = posixDirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { path: outermost === "" ? null : outermost, warning: "" };
}
var dbPathCache = /* @__PURE__ */ new WeakMap();
function dbPath(env = process.env, onWarning) {
  const cached = dbPathCache.get(env);
  if (cached !== void 0) return cached;
  const r = dbResolve(env);
  if (r.warning !== "" && onWarning) onWarning(r.warning);
  if (r.path !== null) dbPathCache.set(env, r.path);
  return r.path;
}
function realdir(dir) {
  if (dir === "") return "";
  try {
    if (statSync2(dir).isDirectory()) {
      accessSync2(dir, constants2.X_OK);
      return realpathSync2.native(dir);
    }
  } catch {
  }
  return stripTrailingNewlines(dir);
}
function dbProjectRoot(db) {
  if (db === "") return "";
  const host = posixDirname(posixDirname(db));
  return posixBasename(host) === TMB_STATE_HOST_DIR ? posixDirname(host) : "";
}
function projectRoot(env = process.env) {
  const db = dbPath(env);
  const root = db !== null ? dbProjectRoot(db) : "";
  return root || claudeProjectDir(env);
}
function sqlQuote(value = "") {
  return stripTrailingNewlines(value.replace(/'/g, "''"));
}

// src/cli/fallback-db.ts
import { statSync as statSync3 } from "node:fs";
function isFile2(path) {
  if (path === "") return false;
  try {
    return statSync3(path).isFile();
  } catch {
    return false;
  }
}
function fallbackDbPath(env) {
  const resolved = dbResolve(env).path;
  if (resolved !== null) return resolved;
  if ((env.TRAJECTORY_DB_PATH ?? "") !== "") return env.TRAJECTORY_DB_PATH;
  if ((env.CLAUDE_PROJECT_DIR ?? "") !== "") return dbLocation(env.CLAUDE_PROJECT_DIR, env);
  return "";
}
function dbNotFoundJson(db) {
  return `{"error":"db-not-found","path":"${db || "unresolved"}","hint":"Set CLAUDE_PROJECT_DIR to the project root (or TRAJECTORY_DB_PATH to the DB)."}
`;
}
function digitsOr2(value, fallback) {
  return value !== void 0 && /^[0-9]+$/.test(value) ? Number(value) : fallback;
}

// src/cli/py-json.ts
var PyJsonError = class extends Error {
};
var NUMBER = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;
var WHITESPACE = /[ \t\n\r]*/y;
var SHORT_ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "	" };
var Parser = class {
  constructor(text) {
    this.text = text;
  }
  text;
  pos = 0;
  fail(what) {
    throw new PyJsonError(`${what} at char ${this.pos}`);
  }
  skip() {
    WHITESPACE.lastIndex = this.pos;
    WHITESPACE.exec(this.text);
    this.pos = WHITESPACE.lastIndex;
  }
  value() {
    const t = this.text;
    const ch = t[this.pos];
    if (ch === '"') return this.string();
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    for (const [word, v] of [
      ["null", null],
      ["true", true],
      ["false", false],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY]
    ]) {
      if (t.startsWith(word, this.pos)) {
        this.pos += word.length;
        return v;
      }
    }
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(t);
    if (!m) this.fail("Expecting value");
    this.pos = NUMBER.lastIndex;
    if (m[2] === void 0 && m[3] === void 0) return BigInt(m[1]);
    return Number(m[0]);
  }
  string() {
    const t = this.text;
    let out = "";
    this.pos += 1;
    for (; ; ) {
      if (this.pos >= t.length) this.fail("Unterminated string");
      const ch = t[this.pos];
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch.charCodeAt(0) < 32) this.fail("Invalid control character");
      if (ch !== "\\") {
        out += ch;
        this.pos += 1;
        continue;
      }
      const esc = t[this.pos + 1];
      if (esc === "u") {
        const hex = t.slice(this.pos + 2, this.pos + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("Invalid \\u escape");
        out += String.fromCharCode(parseInt(hex, 16));
        this.pos += 6;
      } else if (esc !== void 0 && esc in SHORT_ESCAPES) {
        out += SHORT_ESCAPES[esc];
        this.pos += 2;
      } else {
        this.fail("Invalid \\escape");
      }
    }
  }
  array() {
    const items = [];
    this.pos += 1;
    this.skip();
    if (this.text[this.pos] === "]") {
      this.pos += 1;
      return items;
    }
    for (; ; ) {
      this.skip();
      items.push(this.value());
      this.skip();
      const ch = this.text[this.pos];
      this.pos += 1;
      if (ch === "]") return items;
      if (ch !== ",") this.fail("Expecting ',' delimiter");
    }
  }
  object() {
    const dict = /* @__PURE__ */ new Map();
    this.pos += 1;
    this.skip();
    if (this.text[this.pos] === "}") {
      this.pos += 1;
      return dict;
    }
    for (; ; ) {
      this.skip();
      if (this.text[this.pos] !== '"') this.fail("Expecting property name enclosed in double quotes");
      const key = this.string();
      this.skip();
      if (this.text[this.pos] !== ":") this.fail("Expecting ':' delimiter");
      this.pos += 1;
      this.skip();
      dict.set(key, this.value());
      this.skip();
      const ch = this.text[this.pos];
      this.pos += 1;
      if (ch === "}") return dict;
      if (ch !== ",") this.fail("Expecting ',' delimiter");
    }
  }
};
function pyLoads(text) {
  const p = new Parser(text);
  p.skip();
  const v = p.value();
  p.skip();
  if (p.pos !== text.length) p.fail("Extra data");
  return v;
}
function pyFloatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Number.POSITIVE_INFINITY) return "inf";
  if (x === Number.NEGATIVE_INFINITY) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantissa, expText] = Math.abs(x).toExponential().split("e");
  const exp = Number(expText);
  const digits = mantissa.replace(".", "");
  const sign = x < 0 ? "-" : "";
  if (exp < -4 || exp >= 16) {
    const frac2 = digits.length > 1 ? `.${digits.slice(1)}` : "";
    const e = String(Math.abs(exp)).padStart(2, "0");
    return `${sign}${digits[0]}${frac2}e${exp < 0 ? "-" : "+"}${e}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  const whole = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
  const frac = digits.slice(exp + 1);
  return `${sign}${whole}.${frac === "" ? "0" : frac}`;
}
function dumpFloat(x) {
  if (Number.isNaN(x)) return "NaN";
  if (x === Number.POSITIVE_INFINITY) return "Infinity";
  if (x === Number.NEGATIVE_INFINITY) return "-Infinity";
  return pyFloatRepr(x);
}
var DUMP_ESCAPES = { "\\": "\\\\", '"': '\\"', "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "	": "\\t" };
function dumpString(s) {
  return `"${s.replace(/[\\"]|[^ -~]/g, (c) => DUMP_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}
function pyDumps(v) {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return dumpFloat(v);
  if (typeof v === "string") return dumpString(v);
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  return `{${[...v].map(([k, item]) => `${dumpString(k)}: ${pyDumps(item)}`).join(", ")}}`;
}
function reprString(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0;
    if (c === "\\" || c === quote) out += `\\${c}`;
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "	") out += "\\t";
    else if (code < 32 || code === 127) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += c;
  }
  return `${quote}${out}${quote}`;
}
function pyRepr(v) {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return pyFloatRepr(v);
  if (typeof v === "string") return reprString(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return `{${[...v].map(([k, item]) => `${reprString(k)}: ${pyRepr(item)}`).join(", ")}}`;
}
function pyStr(v) {
  return typeof v === "string" ? v : pyRepr(v);
}

// src/cli/bro-sqlite-readonly.ts
var SUPPORTED_READ_TOOLS = [
  "issue_resume",
  "issue_get",
  "issue_get_phase",
  "task_get",
  "task_first_actionable",
  "config_get",
  "config_list"
];
var KNOWN_WRITE_TOOLS = [
  "issue_create",
  "issue_close",
  "issue_list",
  "task_create_batch",
  "task_update_status",
  "config_set",
  "discussion_append",
  "audit_append",
  "validation_record"
];
var SNAPSHOT_TIMEOUT_MS = 5e3;
var ISSUE_SQL = "SELECT id, objective, description, status, created_at, updated_at, closed_at, remote_kind, gh_iid, gl_iid FROM issues WHERE id = ?;";
var ISSUE_FULL_SQL = "SELECT * FROM issues WHERE id = ?;";
var FIRST_ACTIONABLE_SQL = "SELECT * FROM tasks WHERE issue_id = ? AND status IN ('pending','failed') ORDER BY branch_id ASC LIMIT 1;";
var Exit = class extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
  code;
};
var ReadFailure = class extends Error {
};
var ToolError = class extends Error {
};
function refusalJson(tool) {
  return `{"error":"degraded-mode-readonly","requested":"${tool}","recovery":"MCP is dead. Kill zombie: pkill -f 'trajectory-server/dist/index.js' then restart Claude Code."}
`;
}
function errorJson(message) {
  return `{"error":${pyDumps(message)}}
`;
}
function uriPath(path) {
  return path.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23");
}
function errorText(e) {
  return e instanceof Error ? e.message : String(e);
}
function sqlite() {
  const mod = loadNodeSqlite();
  if (!mod) throw new ReadFailure("node:sqlite is unavailable in this Node (needs Node 22.13+ with node:sqlite)");
  return mod;
}
function toPy(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "bigint" || typeof value === "string") return value;
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
}
var ReadSession = class {
  constructor(dbPath2, env) {
    this.dbPath = dbPath2;
    this.env = env;
  }
  dbPath;
  env;
  db = null;
  snapDir = "";
  readDb = "";
  /** prepare_read_db: the file the queries read; throws Exit(1) when the snapshot fails. */
  prepare(io2) {
    this.readDb = this.dbPath;
    if (!walCold(this.dbPath)) return;
    const src = existsSync3(`${this.dbPath}-wal`) ? this.dbPath : `file:${uriPath(this.dbPath)}?immutable=1`;
    try {
      this.snapDir = mkdtempSync(`${this.env.TMPDIR || "/tmp"}/bro-sqlite-readonly.`);
      const { DatabaseSync } = sqlite();
      const snap = `${this.snapDir}/snap.db`;
      const source = new DatabaseSync(src, { readOnly: true, timeout: SNAPSHOT_TIMEOUT_MS });
      try {
        source.prepare("VACUUM INTO ?").run(snap);
      } finally {
        source.close();
      }
      const copy = new DatabaseSync(snap, { timeout: SNAPSHOT_TIMEOUT_MS });
      try {
        copy.exec("PRAGMA journal_mode=DELETE;");
      } finally {
        copy.close();
      }
      this.readDb = snap;
    } catch (e) {
      io2.err(`bro-sqlite-readonly: snapshot of ${this.dbPath} failed: ${errorText(e)}
`);
      throw new Exit(1);
    }
  }
  open() {
    if (!this.db) {
      const { DatabaseSync } = sqlite();
      const timeout = digitsOr2(this.env.TMB_DB_WRITE_TIMEOUT_MS || void 0, 1500);
      this.db = new DatabaseSync(this.readDb, { readOnly: true, timeout });
    }
    return this.db;
  }
  /** The rows of <sql> as the dicts Python reads from `sqlite3 -json`. */
  rows(sql, params = []) {
    try {
      const stmt = this.open().prepare(sql);
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      const names = stmt.columns().map((c) => c.name);
      return stmt.all(...params).map((row) => {
        const dict = /* @__PURE__ */ new Map();
        names.forEach((name2, i) => dict.set(name2, toPy(row[i])));
        return dict;
      });
    } catch (e) {
      throw new ReadFailure(errorText(e));
    }
  }
  close() {
    try {
      this.db?.close();
    } catch {
    }
    this.db = null;
    if (this.snapDir !== "") rmSync(this.snapDir, { recursive: true, force: true });
    this.snapDir = "";
  }
};
function parseJsonField(args, field2) {
  let parsed;
  try {
    parsed = pyLoads(args);
  } catch {
    return null;
  }
  if (!(parsed instanceof Map)) return null;
  const v = parsed.get(field2);
  if (v === void 0 || v === null) return null;
  return pyStr(v).replace(/\n+$/, "");
}
function rawPrefix(value) {
  return Array.from(typeof value === "string" ? value : pyStr(value ?? null)).slice(0, 200).join("");
}
function loadsOr(value, fallback) {
  try {
    return pyLoads(typeof value === "string" ? value : pyStr(value ?? null));
  } catch {
    return fallback(rawPrefix(value));
  }
}
function runTool(tool, args, s) {
  const required = (field2) => {
    const v = parseJsonField(args, field2);
    if (v === null) throw new ToolError(`Missing required arg: ${field2}`);
    return v;
  };
  const first = (rows) => rows[0] ?? null;
  switch (tool) {
    case "issue_resume": {
      const id = required("issue_id");
      const issue = s.rows(ISSUE_SQL, [id]);
      if (issue.length === 0) throw new ToolError(`Not found: ${id}`);
      const task = s.rows(FIRST_ACTIONABLE_SQL, [id]);
      const result = /* @__PURE__ */ new Map([
        ["issue", first(issue)],
        ["next_task", first(task)]
      ]);
      return { out: pyDumps(result), code: 0 };
    }
    case "issue_get": {
      const id = required("issue_id");
      const include = parseJsonField(args, "include_description") ?? "false";
      const full = include === "True" || include === "true" || include === "1";
      const rows = s.rows(full ? ISSUE_FULL_SQL : ISSUE_SQL, [id]);
      if (rows.length === 0) throw new ToolError(`Not found: ${id}`);
      return { out: pyDumps(first(rows)), code: 0 };
    }
    case "issue_get_phase": {
      const id = required("issue_id");
      const issueRows = s.rows("SELECT id, status FROM issues WHERE id = ?;", [id]);
      if (issueRows.length === 0) throw new ToolError(`Not found: ${id}`);
      const countRows = s.rows(
        "SELECT COUNT(*) as tasks_total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as tasks_completed, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as tasks_failed FROM tasks WHERE issue_id = ?;",
        [id]
      );
      const counts = countRows[0] ?? /* @__PURE__ */ new Map();
      const count = (key) => counts.get(key) ?? 0n;
      const total = count("tasks_total");
      const completed = count("tasks_completed");
      const status = issueRows[0].get("status") ?? "";
      const phase = status === "closed" ? "done" : Number(total) === 0 ? "discussion" : Number(completed) < Number(total) ? "tasks" : "blueprint";
      const result = /* @__PURE__ */ new Map([
        ["phase", phase],
        [
          "counts",
          /* @__PURE__ */ new Map([
            ["tasks_total", total],
            ["tasks_completed", completed],
            ["tasks_failed", count("tasks_failed")]
          ])
        ]
      ]);
      return { out: pyDumps(result), code: 0 };
    }
    case "task_get": {
      const id = required("task_id");
      const rows = s.rows("SELECT * FROM tasks WHERE id = ?;", [id]);
      if (rows.length === 0) throw new ToolError(`Not found: ${id}`);
      return { out: pyDumps(first(rows)), code: 0 };
    }
    case "task_first_actionable": {
      const id = required("issue_id");
      return { out: pyDumps(first(s.rows(FIRST_ACTIONABLE_SQL, [id]))), code: 0 };
    }
    case "config_get": {
      const key = required("key");
      const rows = s.rows("SELECT key, value_json FROM plugin_config WHERE key = ?;", [key]);
      if (rows.length === 0) return { out: "null", code: 0 };
      const value = loadsOr(
        rows[0].get("value_json"),
        (raw) => /* @__PURE__ */ new Map([
          ["error", "stored value is not valid JSON"],
          ["raw", raw]
        ])
      );
      return { out: pyDumps(value), code: 0 };
    }
    case "config_list": {
      const result = /* @__PURE__ */ new Map();
      for (const row of s.rows("SELECT key, value_json FROM plugin_config ORDER BY key;")) {
        result.set(
          pyStr(row.get("key") ?? null),
          loadsOr(
            row.get("value_json"),
            (raw) => /* @__PURE__ */ new Map([
              ["error", "not valid JSON"],
              ["raw", raw]
            ])
          )
        );
      }
      return { out: pyDumps(result), code: 0 };
    }
  }
}
function appendLog(db, tool) {
  try {
    const logDir = `${posixDirname(db)}/logs`;
    mkdirSync(logDir, { recursive: true });
    const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, ".000Z");
    appendFileSync(`${logDir}/mcp-health.log`, `{"ts":"${ts}","kind":"fallback","tool":"${tool}","agent":"bro"}
`);
  } catch {
  }
}
function dryRun(env, io2) {
  const db = fallbackDbPath(env);
  if (!isFile2(db)) {
    io2.out(dbNotFoundJson(db));
    return 1;
  }
  const s = new ReadSession(db, env);
  try {
    s.prepare(io2);
    let count = "-1";
    try {
      const v = s.rows("SELECT COUNT(*) FROM issues;")[0]?.values().next().value;
      if (v !== void 0 && v !== null) count = pyStr(v);
    } catch {
      count = "-1";
    }
    io2.out(`{"ok":true,"db_path":"${db}","issues_count":${count}}
`);
    return 0;
  } finally {
    s.close();
  }
}
function isReadTool(tool) {
  return SUPPORTED_READ_TOOLS.includes(tool);
}
function main(argv2, env, io2) {
  const first = argv2[0] ?? "";
  if (first === "--dry-run") return dryRun(env, io2);
  if (first === "--list") {
    io2.out(`${pyDumps(/* @__PURE__ */ new Map([["supported_read_tools", [...SUPPORTED_READ_TOOLS]]]))}
`);
    return 0;
  }
  const tool = first;
  const args = argv2[1] || "{}";
  if (tool === "") {
    io2.out('{"error":"usage","message":"bro-sqlite-readonly <tool_name> [json_args] | --dry-run | --list"}\n');
    return 1;
  }
  if (KNOWN_WRITE_TOOLS.includes(tool) || !isReadTool(tool)) {
    io2.out(refusalJson(tool));
    return 1;
  }
  const db = fallbackDbPath(env);
  if (!isFile2(db)) {
    io2.out(dbNotFoundJson(db));
    return 1;
  }
  appendLog(db, tool);
  const s = new ReadSession(db, env);
  try {
    s.prepare(io2);
    const { out, code } = runTool(tool, args, s);
    io2.out(`${out}
`);
    return code;
  } catch (e) {
    if (e instanceof ToolError) {
      io2.out(errorJson(e.message));
      return 1;
    }
    if (e instanceof ReadFailure) {
      io2.err(`bro-sqlite-readonly: ${tool} failed: ${e.message}
`);
      return 1;
    }
    throw e;
  } finally {
    s.close();
  }
}
function broSqliteReadonly(argv2, env, io2) {
  try {
    return main(argv2, env, io2);
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
}

// src/cli/health.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync4, readdirSync, readFileSync as readFileSync4, statSync as statSync6 } from "node:fs";
import { constants as constants4 } from "node:os";
import { fileURLToPath } from "node:url";

// src/hooks/lib/host.ts
import { accessSync as accessSync3, constants as constants3, statSync as statSync4 } from "node:fs";
function commandOnPath(name2, env = process.env) {
  for (const dir of (env.PATH ?? "").split(":")) {
    const candidate = `${dir === "" ? "." : dir}/${name2}`;
    try {
      if (!statSync4(candidate).isFile()) continue;
      accessSync3(candidate, constants3.X_OK);
      return true;
    } catch {
    }
  }
  return false;
}
function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// src/hooks/lib/install.ts
import { readFileSync as readFileSync3, statSync as statSync5 } from "node:fs";
var DEFAULT_NAME = "tmb";
var JqError = class extends Error {
};
function installPluginName(env = process.env) {
  return stripTrailingNewlines(pluginName(env)) || DEFAULT_NAME;
}
function configDir(env) {
  return env.CLAUDE_CONFIG_DIR || `${homeDir(env)}/.claude`;
}
function installedJson(env = process.env) {
  return env.TMB_INSTALLED_JSON || `${configDir(env)}/plugins/installed_plugins.json`;
}
function canonicalDir(dir) {
  return realdir(dir);
}
function isDir(path) {
  try {
    return statSync5(path).isDirectory();
  } catch {
    return false;
  }
}
function readText(path) {
  try {
    return readFileSync3(path, "utf8");
  } catch {
    return null;
  }
}
function index(value, key) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new JqError(`Cannot index with ${key}`);
  const v = value[key];
  return v === void 0 ? null : v;
}
function field(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}
function tsvEscape(text) {
  return text.replace(/[\\\t\n\r]/g, (c) => ({ "\\": "\\\\", "	": "\\t", "\n": "\\n", "\r": "\\r" })[c] ?? c);
}
function* pluginEntries(doc, prefix) {
  let plugins = index(doc, "plugins");
  if (plugins === null || plugins === false) plugins = {};
  if (Array.isArray(plugins)) {
    if (plugins.length > 0) throw new JqError("startswith on a number");
    return;
  }
  if (typeof plugins !== "object") throw new JqError("has no keys");
  for (const [key, value] of Object.entries(plugins)) {
    if (key.startsWith(prefix)) yield [key, value];
  }
}
function elements(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return Object.values(value);
  return [];
}
function jqRows(path, rows) {
  const text = readText(path);
  if (text === null) return [];
  const out = [];
  for (const doc of jsonStream(text).values) {
    try {
      rows(doc, (row) => out.push(row));
    } catch (e) {
      if (!(e instanceof JqError)) throw e;
    }
  }
  return out;
}
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function enabledPlugins(here, env) {
  const merged = {};
  for (const file of [`${configDir(env)}/settings.json`, `${here}/.claude/settings.json`, `${here}/.claude/settings.local.json`]) {
    for (const part of jqRows(file, (doc, push) => {
      let v = index(doc, "enabledPlugins");
      if (v === null || v === false) v = {};
      push(isObject(v) ? v : {});
    })) {
      for (const [k, v] of Object.entries(part)) {
        delete merged[k];
        merged[k] = v;
      }
    }
  }
  return merged;
}
function duplicateInstalls(project, env = process.env) {
  if (project === "") return [];
  const name2 = installPluginName(env);
  const here = canonicalDir(project);
  const on = enabledPlugins(here, env);
  const prefix = `${name2}@`;
  const raw = jqRows(installedJson(env), (doc, push) => {
    for (const [key, value] of pluginEntries(doc, prefix)) {
      if (on[key] !== true) continue;
      for (const e of elements(value)) {
        push([
          key,
          field(index(e, "scope"), "user"),
          field(index(e, "projectPath"), "-"),
          field(index(e, "installPath"), "-"),
          field(index(e, "version"), "-")
        ].map(tsvEscape));
      }
    }
  });
  const ranked = [];
  for (const [key, scope, proj, install, version] of raw) {
    let rank = 1;
    if (scope === "project" || scope === "local") {
      if (proj === "-" || canonicalDir(proj) !== here) continue;
      rank = 0;
    }
    const at = key.indexOf("@");
    const mkt = at < 0 ? key : key.slice(at + 1);
    ranked.push({
      line: [mkt, String(rank), version, install, scope].join("	"),
      mkt,
      rank,
      row: { marketplace: mkt, version, install, scope }
    });
  }
  ranked.sort((a, b) => byteCompare(a.mkt, b.mkt) || a.rank - b.rank || byteCompare(a.line, b.line));
  const seen = /* @__PURE__ */ new Set();
  const rows = ranked.filter((r) => !seen.has(r.mkt) && seen.add(r.mkt)).map((r) => r.row);
  return rows.length > 1 ? rows : [];
}
function duplicateNames(rows) {
  return rows.map((r) => `${r.marketplace}@${r.version}`).join(", ");
}
function duplicateDisableCmds(rows, env = process.env) {
  const name2 = installPluginName(env);
  return rows.map((r) => `claude plugin disable ${name2}@${r.marketplace} --scope ${r.scope}`).join("; ");
}
function userSettingsJson(env = process.env) {
  return `${configDir(env)}/settings.json`;
}
var LEGACY_USER_HOOKS_DOC = "docs/reference/UPGRADE.md#upgrading-into-v110--remove-leftover-user-wide-hooks";
var HOOK_NAME = /--hook[ \t]+([A-Za-z0-9._-]+)/;
function leftover(hook) {
  return hook._tmb_managed === true || typeof hook.command === "string" && hook.command.includes("resolve-hook.sh");
}
function hookName(command) {
  if (typeof command !== "string") return "?";
  const text = command.includes("resolve-hook.sh") ? command.split("resolve-hook.sh")[1] ?? "" : command;
  return HOOK_NAME.exec(text)?.[1] ?? "?";
}
function leftoverPaths(doc) {
  let hooks = index(doc, "hooks");
  if (hooks === null || hooks === false) hooks = {};
  if (!isObject(hooks)) return [];
  const out = [];
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, i) => {
      if (!isObject(group)) return;
      const inner = group.hooks;
      if (!Array.isArray(inner)) return;
      inner.forEach((hook, j) => {
        if (isObject(hook) && leftover(hook)) out.push(["hooks", ev, i, "hooks", j]);
      });
    });
  }
  return out;
}
function commandPaths(value, at = [], out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => commandPaths(v, [...at, i], out));
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === "command") out.push([...at, k]);
      commandPaths(v, [...at, k], out);
    }
  }
  return out;
}
function getPath(value, path) {
  let v = value;
  for (const key of path) v = v[key];
  return v;
}
function versionPart(text) {
  const t = text.trim();
  if (/^[+-]?inf(inity)?$/i.test(t)) return t.startsWith("-") ? -Number.MAX_VALUE : Number.MAX_VALUE;
  return /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(t) ? Number(t) : -1;
}
function belowV110(version) {
  const parts = (version.split("-")[0] ?? "").split(".").map(versionPart);
  const floor = [1, 1, 0];
  for (let i = 0; i < Math.min(parts.length, floor.length); i += 1) {
    if (parts[i] !== floor[i]) return parts[i] < floor[i];
  }
  return parts.length < floor.length;
}
function legacyHookRows(settings) {
  let text;
  try {
    text = readFileSync3(settings, "utf8");
  } catch {
    return null;
  }
  const stream = jsonStream(text);
  if (!stream.complete) return null;
  const want = /* @__PURE__ */ new Map();
  let n = 0;
  let orphans = 0;
  try {
    for (const doc of stream.values) {
      const left = leftoverPaths(doc);
      if (left.length === 0) continue;
      const keys = new Set(left.map((p) => JSON.stringify(p)));
      for (const path of commandPaths(doc)) {
        n += 1;
        const owner = path.slice(0, -1);
        if (keys.has(JSON.stringify(owner))) want.set(n, hookName(getPath(doc, owner).command));
      }
      for (const p of left) if (!Object.hasOwn(getPath(doc, p), "command")) orphans += 1;
    }
  } catch (e) {
    if (e instanceof JqError) return null;
    throw e;
  }
  if (n === 0 && orphans === 0) return [];
  const rows = [];
  let k = 0;
  text.split("\n").forEach((line, i) => {
    for (const _ of line.matchAll(/"command"[ \t]*:/g)) {
      k += 1;
      const name2 = want.get(k);
      if (name2 !== void 0) rows.push({ line: String(i + 1), name: name2 });
    }
  });
  for (let i = k + 1; i <= n; i += 1) {
    const name2 = want.get(i);
    if (name2 !== void 0) rows.push({ line: "?", name: name2 });
  }
  for (let i = 0; i < orphans; i += 1) rows.push({ line: "?", name: "?" });
  return rows;
}
function legacyUserHooks(project, env = process.env) {
  const none = { hooks: [], projects: [] };
  const hooks = legacyHookRows(userSettingsJson(env));
  if (hooks === null || hooks.length === 0) return none;
  const here = project === "" ? "" : canonicalDir(project);
  const prefix = `${installPluginName(env)}@`;
  const raw = jqRows(installedJson(env), (doc, push) => {
    for (const [, value] of pluginEntries(doc, prefix)) {
      for (const e of elements(value)) {
        const p = index(e, "projectPath");
        const v = index(e, "version");
        if (typeof p !== "string" || p === "" || typeof v !== "string") continue;
        if (belowV110(v)) push([tsvEscape(p), tsvEscape(v)]);
      }
    }
  });
  const projects = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [p, v] of raw) {
    if (!isDir(p)) continue;
    const path = canonicalDir(p);
    if (path === here || seen.has(path)) continue;
    seen.add(path);
    projects.push({ path, version: v });
  }
  return { hooks, projects };
}
function legacyHookEntries(hooks) {
  return hooks.map((h) => `line ${h.line} ${h.name}`).join(", ");
}
function legacyHookProjects(projects) {
  return projects.map((p) => `${p.path} (${p.version})`).join(", ");
}

// src/cli/health.ts
var SCOPE_DOC = "docs/reference/INSTALL.md#recommended-scope-project-or-local";
var DB_READ_TIMEOUT_MS = "500";
var MEMORY = ":memory:";
function isFile3(path) {
  try {
    return statSync6(path).isFile();
  } catch {
    return false;
  }
}
function isDir2(path) {
  try {
    return statSync6(path).isDirectory();
  } catch {
    return false;
  }
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync4(path, "utf8"));
  } catch {
    return void 0;
  }
}
function isObject2(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function jqField(doc, key, fallback) {
  if (!isObject2(doc)) return fallback;
  const v = doc[key];
  return v === void 0 || v === null || v === false ? fallback : jqRawText(v);
}
function jqInterp(v) {
  if (typeof v === "string") return v;
  if (v === void 0 || v === null) return "null";
  return JSON.stringify(v);
}
function selfRoot(env) {
  if ((env.CLAUDE_PLUGIN_ROOT ?? "") !== "") return env.CLAUDE_PLUGIN_ROOT;
  return installRoot(posixDirname(fileURLToPath(import.meta.url))) ?? "";
}
function manifestName2(root) {
  const manifest = `${root}/.claude-plugin/plugin.json`;
  if (!isFile3(manifest)) return "tmb";
  return jqField(readJson(manifest), "name", "tmb");
}
function installEntry(installed, name2, root) {
  if (!isFile3(installed)) return null;
  const doc = readJson(installed);
  if (!isObject2(doc) || !isObject2(doc.plugins)) return null;
  const entries = [];
  for (const [key, value] of Object.entries(doc.plugins)) {
    if (!key.startsWith(`${name2}@`)) continue;
    const first = Array.isArray(value) ? value[0] ?? null : value === null ? null : void 0;
    if (first === void 0) return null;
    if (first !== null && !isObject2(first)) return null;
    entries.push({ ...first ?? {}, key });
  }
  const picked = entries.find((e) => e.installPath === root) ?? entries[0];
  if (picked === void 0) return null;
  return {
    version: jqInterp(picked.version),
    installPath: jqInterp(picked.installPath),
    key: jqInterp(picked.key),
    scope: jqField(picked, "scope", "")
  };
}
function pgrepProbe(env) {
  if (!commandOnPath("pgrep", env)) return { count: "-1", rc: 0 };
  const root = env.CLAUDE_PLUGIN_ROOT ?? "";
  const pattern = root !== "" ? `${root}/mcp/trajectory-server/dist/index.js` : "trajectory-server/dist/index.js";
  const r = spawnSync2("pgrep", ["-f", pattern], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const signal = r.signal ? constants4.signals[r.signal] ?? 0 : 0;
  const rc = r.status ?? (signal > 0 ? 128 + signal : 1);
  const count = (r.stdout ?? "").split("\n").filter((line) => line !== "").length;
  return { count: String(count), rc };
}
function bashInt(text) {
  return /^\s*[+-]?[0-9]+\s*$/.test(text) ? Number(text) : null;
}
function targetSchema(cacheDir) {
  if (cacheDir === "") return "";
  for (const f of [`${cacheDir}/mcp/trajectory-server/src/db.ts`, `${cacheDir}/mcp/trajectory-server/dist/db.js`]) {
    if (!isFile3(f)) continue;
    let text;
    try {
      text = readFileSync4(f, "utf8");
    } catch {
      continue;
    }
    const m = /TARGET_SCHEMA_VERSION[ \t\v\f\r]*=[ \t\v\f\r]*([0-9]+)/.exec(text);
    if (m) return m[1];
  }
  return "";
}
function labelCount(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? String(parsed.length) : "0";
  } catch {
    return "0";
  }
}
function worktreeDirs(wsRoot) {
  const dir = `${wsRoot}/.claude/worktrees`;
  if (wsRoot === "" || !isDir2(dir)) return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith(".") && isDir2(`${dir}/${n}`)).sort(byteCompare).map((n) => `${dir}/${n}/`);
}
var Report = class {
  constructor(io2) {
    this.io = io2;
  }
  io;
  failed = 0;
  degraded = 0;
  line(text) {
    this.io.out(`${text}
`);
  }
  pass(text) {
    this.line(`PASS  ${text}`);
  }
  fail(text) {
    this.failed += 1;
    this.line(`FAIL  ${text}`);
  }
  remediate(...lines) {
    for (const l of lines) this.line(`      -> ${l}`);
  }
};
function health(_argv, env, io2) {
  const r = new Report(io2);
  const self = selfRoot(env);
  const name2 = manifestName2(self);
  const projectDir = env.CLAUDE_PROJECT_DIR ?? "";
  const sqliteOk = haveSqlite(env);
  const roEnv = { ...env, TMB_DB_WRITE_TIMEOUT_MS: DB_READ_TIMEOUT_MS };
  const db = env.TRAJECTORY_DB_PATH === MEMORY ? MEMORY : dbPath(env) ?? "";
  const dbRead = (sql) => {
    const out = dbReadRo(db, sql, roEnv);
    return out === GATE_READ_ERROR ? "" : out;
  };
  const installed = env.TMB_HEALTH_INSTALLED_JSON || `${env.HOME ?? ""}/.claude/plugins/installed_plugins.json`;
  let intended = env.TMB_HEALTH_INTENDED_VERSION ?? "";
  let cacheDir = env.TMB_HEALTH_CACHE_DIR ?? "";
  let installKey = "";
  let installScope = "";
  const entry = installEntry(installed, name2, self);
  if (entry) {
    if (projectDir !== "" || entry.installPath === self) {
      if (intended === "") intended = entry.version;
      if (cacheDir === "") cacheDir = entry.installPath;
    }
    installKey = entry.key;
    installScope = entry.scope;
  }
  if (cacheDir === "" && projectDir === "") cacheDir = self;
  let updateCmd;
  if (installKey !== "") {
    if (installScope !== "project" && installScope !== "local") {
      installScope = installKey.endsWith("@trustmybot") ? "project" : "local";
    }
    updateCmd = `claude plugin update ${installKey} --scope ${installScope}`;
  } else {
    updateCmd = `claude plugin update ${name2}@<marketplace> --scope project (stable) or --scope local (rc/dev)`;
  }
  let serverLog = env.TMB_HEALTH_SERVER_LOG ?? "";
  if (serverLog === "") {
    if (db === MEMORY) {
      serverLog = `${(env.TMPDIR || "/tmp").replace(/\/+$/, "")}/${name2}-memory-logs/mcp-server.log`;
    } else if (db !== "") {
      serverLog = `${posixDirname(db)}/logs/mcp-server.log`;
    }
  }
  r.line("== TMB health-check ==");
  r.line(`db:        ${db || "<unresolved>"}`);
  r.line(`cache:     ${cacheDir || "<unresolved>"}`);
  r.line(`server-log:${serverLog || "<unresolved>"}`);
  r.line("");
  let pgrepCount = env.TMB_HEALTH_PGREP_COUNT ?? "";
  let pgrepRc = 0;
  if (pgrepCount === "") ({ count: pgrepCount, rc: pgrepRc } = pgrepProbe(env));
  const alive = bashInt(pgrepCount);
  if (pgrepRc >= 2) {
    r.line(
      `UNVERIFIED  server-reachable: pgrep exited ${pgrepRc} \u2014 the process table cannot be listed here (e.g. the Claude Code sandbox)`
    );
    r.remediate("Re-run outside the sandbox to probe the server, or check that trajectory-server MCP tools respond.");
  } else if (pgrepCount === "-1") {
    r.pass("server-reachable: pgrep unavailable \u2014 cannot probe (assuming reachable)");
  } else if (alive !== null && alive > 0) {
    r.pass(`server-reachable: trajectory-server process alive (${pgrepCount})`);
  } else {
    r.fail("server-reachable: NO trajectory-server process found");
    r.remediate(
      "Fully quit Claude Code (Cmd-Q) and relaunch \u2014 a dead MCP server needs a full restart.",
      "If it does not come back after relaunch, see skills/tmb_recovery (CC plugin MCP-config cache bug).",
      `Forensics: tail -n 50 ${serverLog || `<project>/.claude/${name2}/logs/mcp-server.log`}`
    );
  }
  const dbPluginVersion = db !== "" && sqliteOk ? dbRead("SELECT plugin_version FROM plugin_meta WHERE id = 1;") : "";
  if (intended === "") {
    r.pass("cache-version: intended version unknown \u2014 skipping (no installed_plugins.json)");
  } else if (dbPluginVersion === "") {
    r.fail(`cache-version: DB plugin_version unreadable (intended=${intended})`);
    r.remediate(`Cannot read plugin_meta \u2014 is the DB present/queryable? db=${db || "<unresolved>"}`);
  } else if (dbPluginVersion === intended) {
    r.pass(`cache-version: DB matches installed version (${intended})`);
  } else {
    r.fail(`cache-version: server booted ${dbPluginVersion} but ${intended} is installed`);
    r.remediate(
      `From the project root, run ${updateCmd}; then fully quit + relaunch Claude Code so the server reboots on the new cache.`,
      `Scope rule: ${SCOPE_DOC}`,
      "Only a full restart picks up the new server \u2014 the MCP process is long-lived."
    );
  }
  const dbSchema = db !== "" && sqliteOk ? dbRead("SELECT schema_version FROM plugin_meta WHERE id = 1;") : "";
  const target = targetSchema(cacheDir);
  if (target === "") {
    r.pass("schema-version: target schema unknown \u2014 skipping (no cache db source)");
  } else if (dbSchema === "") {
    r.fail(`schema-version: DB schema_version unreadable (target=${target})`);
    r.remediate(`Cannot read plugin_meta.schema_version \u2014 is the DB present/queryable? db=${db || "<unresolved>"}`);
  } else if (dbSchema === target) {
    r.pass(`schema-version: DB at current schema (v${dbSchema})`);
  } else {
    r.fail(`schema-version: DB at v${dbSchema} but installed server targets v${target}`);
    r.remediate("Fully quit + relaunch Claude Code \u2014 the migration runs on the next SERVER start.");
  }
  let wmTableCount = "";
  let wmCounts = "";
  if (db !== "" && db !== MEMORY && sqliteOk) {
    wmTableCount = dbReadRo(
      db,
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('wm_directories','wm_files');",
      env
    );
    if (wmTableCount === "2") {
      wmCounts = dbReadRo(db, "SELECT (SELECT COUNT(*) FROM wm_directories) || ' ' || (SELECT COUNT(*) FROM wm_files);", env);
    }
  }
  const space = wmCounts.indexOf(" ");
  const wmDirs = space < 0 ? wmCounts : wmCounts.slice(0, space);
  const wmFiles = wmCounts.slice(wmCounts.lastIndexOf(" ") + 1);
  if (db === "") {
    r.pass("world-model: trajectory DB unresolved \u2014 skipping");
  } else if (db === MEMORY) {
    r.pass("world-model: in-memory trajectory DB \u2014 nothing on disk to probe");
  } else if (!sqliteOk) {
    r.pass("world-model: sqlite3 unavailable \u2014 skipping");
  } else if (wmTableCount === GATE_READ_ERROR || wmCounts === GATE_READ_ERROR || wmTableCount === "") {
    r.fail("world-model: cannot read the world-model tables");
    r.remediate(`Is the DB present/queryable? db=${db}`);
  } else if (wmTableCount !== "2") {
    r.fail("world-model: wm_directories / wm_files missing from the trajectory DB");
    r.remediate(
      "Fully quit + relaunch Claude Code \u2014 the server creates the tables when it migrates the DB on start.",
      "Then build the world model: run /scan."
    );
  } else if (wmDirs === "0") {
    r.pass("world-model: tables present");
    r.line("WARN  world-model: empty \u2014 no directories scanned yet");
    r.remediate("Build the world model: run /scan.");
  } else {
    r.pass(`world-model: ${wmDirs} directories, ${wmFiles} files`);
  }
  let legacyGraph = "";
  if (db !== "" && db !== MEMORY) {
    legacyGraph = db.slice(db.lastIndexOf("/") + 1) === TMB_DB_FILENAME ? `${db.slice(0, -TMB_DB_FILENAME.length)}world-model.kuzu` : `${db}.world-model.kuzu`;
  }
  if (legacyGraph !== "" && existsSync4(legacyGraph)) {
    r.line(
      `INFO  world-model: ${legacyGraph} is an unused leftover from the old graph store \u2014 TMB no longer reads it; you may delete it (and any ${legacyGraph.slice(legacyGraph.lastIndexOf("/") + 1)}.* files beside it).`
    );
  }
  const labelsRaw = db !== "" && sqliteOk ? dbRead("SELECT value_json FROM plugin_config WHERE key = 'issue_classification_labels';") : "";
  const labels = labelsRaw === "" ? "0" : labelCount(labelsRaw);
  if (labelsRaw === "" || labels === "0") {
    r.fail("label-config: issue_classification_labels is unset/empty");
    r.remediate(
      "Set it via /onboard, or with the config_set MCP tool (key=issue_classification_labels).",
      "Until set, issue auto-classification falls back to the generic default."
    );
  } else {
    r.pass(`label-config: issue_classification_labels set (${labels} labels)`);
  }
  const wsRoot = db === "" ? "" : posixDirname(posixDirname(posixDirname(db)));
  const worktrees = worktreeDirs(wsRoot);
  const pending = db !== "" && sqliteOk ? dbRead(
    "SELECT id || ' [' || status || '] ' || COALESCE(branch_id,'') FROM tasks WHERE status IN ('pending','running');"
  ) : "";
  if (worktrees.length === 0 && pending === "") {
    r.pass("stale-state: no orphaned worktrees or pending/running tasks");
  } else {
    r.fail("stale-state: orphaned worktrees and/or pending|running tasks present");
    if (pending !== "") {
      r.remediate("Pending/running tasks (recover or close):");
      for (const t of pending.split("\n")) if (t !== "") r.remediate(`    task ${t}`);
    }
    if (worktrees.length > 0) {
      r.remediate(`Worktrees under ${wsRoot}/.claude/worktrees/ (clean up once the task is done):`);
      for (const w of worktrees) r.remediate(`    ${w}`);
      r.remediate("Cleanup helper: scripts/maintenance/cleanup-stale-worktrees.sh");
    }
  }
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT ?? "";
  const devManifest = `${pluginRoot}/.claude-plugin/plugin.json`;
  const driftVersion = pluginRoot !== "" && isFile3(devManifest) ? jqField(readJson(devManifest), "version", "") : "";
  if (driftVersion === "" || intended === "") {
    r.pass("hook-cache-drift: no dev checkout vs cache comparison available");
  } else if (pluginRoot === cacheDir) {
    r.pass("hook-cache-drift: running directly from the cache (no drift)");
  } else if (driftVersion === intended) {
    r.pass(`hook-cache-drift: dev checkout version matches the installed cache (${intended})`);
  } else {
    r.fail(`hook-cache-drift: dev checkout is ${driftVersion} but the cache runs ${intended}`);
    r.remediate(
      "Your edits to hooks/skills/agents/commands are NOT live until the cache updates.",
      `Once the cache is at your version (from the project root: ${updateCmd}), fully quit + relaunch Claude Code to load the new hook/skill/agent/command definitions.`
    );
  }
  const onDisk = db !== "" && db !== MEMORY && sqliteOk;
  const embDegraded = onDisk ? dbReadRo(
    db,
    `SELECT d.created_at || ' ' || COALESCE(json_extract(d.content_json, '$.reason'), '')
      FROM audit d
     WHERE d.event_type = 'embeddings_degraded'
       AND strftime('%Y-%m-%dT%H:%M:%fZ', d.created_at) >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 days')
       AND NOT EXISTS (SELECT 1 FROM audit r WHERE r.event_type = 'embeddings_recovered' AND r.id > d.id)
     ORDER BY d.id DESC LIMIT 1;`,
    roEnv
  ) : "";
  if (!onDisk) {
    r.pass("embeddings: no on-disk trajectory DB to read \u2014 skipping");
  } else if (embDegraded === GATE_READ_ERROR) {
    r.pass("embeddings: audit table unreadable \u2014 skipping");
  } else if (embDegraded !== "") {
    r.degraded += 1;
    r.line(`WARN  embeddings: degraded since ${embDegraded} \u2014 semantic search is falling back to FTS`);
    r.remediate(
      "The embedding model failed to load or kept failing; the server re-attempts on its own (1 min, 5 min, then every 10 min).",
      `Check the embeddings_state lines in ${serverLog || "mcp-server.log"}; trajectory_doctor reports the live state.`
    );
  } else {
    r.pass("embeddings: no unrecovered embeddings_degraded event in the last 24 h");
  }
  const libEnv = { ...env, TMB_INSTALLED_JSON: installed };
  const dupProject = projectDir !== "" || db !== MEMORY ? projectRoot(env) : "";
  if (dupProject === "") {
    r.line("WARN  duplicate-plugin: skipped \u2014 no project resolves (no CLAUDE_PROJECT_DIR and no trajectory DB)");
    r.remediate("Run from a Claude Code session in the project, or set CLAUDE_PROJECT_DIR (or TRAJECTORY_DB_PATH) to it.");
  }
  const dups = dupProject === "" ? [] : duplicateInstalls(dupProject, libEnv);
  if (dups.length > 0) {
    r.line(`WARN  duplicate-plugin: ${dups.length} enabled ${name2} copies for ${dupProject}: ${duplicateNames(dups)}`);
    r.remediate(
      "Claude Code registers the hooks of only one of them (which one is not documented) and skips the other's with a plugin load error \u2014 TMB's gates may be missing while its MCP tools still work.",
      `Keep one copy and disable the others from the project root, one of: ${duplicateDisableCmds(dups, libEnv)}`,
      "Then fully quit + relaunch Claude Code."
    );
  }
  const legacy = legacyUserHooks(dupProject, libEnv);
  if (legacy.hooks.length > 0) {
    r.line(
      `WARN  legacy-user-hooks: ${userSettingsJson(env)} holds ${legacy.hooks.length} pre-1.1.0 TMB hook(s): ${legacyHookEntries(legacy.hooks)}`
    );
    r.remediate(
      "They run in every project, so a pre-1.1.0 gate can deny what this version allows. TMB does not edit that file.",
      `Remove them by hand: ${LEGACY_USER_HOOKS_DOC}`
    );
    if (legacy.projects.length > 0) r.remediate(`Projects on TMB < 1.1.0 lose them too: ${legacyHookProjects(legacy.projects)}`);
  }
  r.line("");
  if (r.failed === 0 && r.degraded > 0) {
    r.line(`== no check FAILED, ${r.degraded} degraded (see WARN above) ==`);
    return 0;
  }
  if (r.failed === 0) {
    r.line("== all checks passed ==");
    return 0;
  }
  r.line(`== ${r.failed} check(s) FAILED ==`);
  return 1;
}

// src/hooks/lib/audit.ts
import { accessSync as accessSync4, constants as constants5, readFileSync as readFileSync5, statSync as statSync7 } from "node:fs";
import { performance as performance2 } from "node:perf_hooks";
var WRITE_ATTEMPTS = 2;
var BACKOFF_MS = 200;
var DEFAULT_BUSY_MS = 1500;
var DEFAULT_RUN_BUDGET_MS = 3500;
var BUDGET_SPENT_CODE = 5;
var spentMs = /* @__PURE__ */ new WeakMap();
function digitsOr3(value, fallback) {
  return value !== void 0 && /^[0-9]+$/.test(value) ? Number(value) : fallback;
}
function busyMs(env) {
  return digitsOr3(env.TMB_DB_WRITE_TIMEOUT_MS || void 0, DEFAULT_BUSY_MS);
}
function runBudgetMs(env) {
  return digitsOr3(env.TMB_DB_WRITE_RUN_BUDGET_MS || void 0, DEFAULT_RUN_BUDGET_MS);
}
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function isFile4(path) {
  try {
    return statSync7(path).isFile();
  } catch {
    return false;
  }
}
function defaultCaller() {
  const src = posixBasename(process.argv[2] ?? process.argv[1] ?? "");
  return src.endsWith(".sh") ? src.slice(0, -3) : src;
}
function nowIso(date = /* @__PURE__ */ new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}
var BUSY_PATTERN = /database is locked|SQLITE_BUSY|database is busy/;
function dbWrite(db, sql, opts = {}) {
  const env = opts.env ?? process.env;
  const caller = opts.caller ?? defaultCaller();
  if (db === "" || !isFile4(db)) {
    return { ok: false, code: 1, stdout: "", error: `tmb_db_write: ${caller}: database not found: ${db || "<empty>"}` };
  }
  const script = `${stripTrailingNewlines(`PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
${sql}
COMMIT;
`)}
`;
  const busy = busyMs(env);
  const budget = runBudgetMs(env);
  const start = performance2.now();
  const left = () => budget - (spentMs.get(env) ?? 0) - (performance2.now() - start);
  let code = BUDGET_SPENT_CODE;
  let err = "";
  let stdout = "";
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const remaining = left();
    if (remaining <= 0) {
      err = `run budget spent (TMB_DB_WRITE_RUN_BUDGET_MS=${budget})${err ? `; last error: ${err}` : ""}`;
      code = BUDGET_SPENT_CODE;
      break;
    }
    const waitMs = Math.min(busy, Math.ceil(remaining));
    const r = sqliteRun({ target: db, readonly: false, timeoutMs: waitMs, script, bail: true }, env);
    stdout += r.stdout;
    code = r.code;
    err = stripTrailingNewlines(r.stderr);
    if (code === 0) break;
    if (!BUSY_PATTERN.test(err)) break;
    if (attempt < WRITE_ATTEMPTS && left() > BACKOFF_MS) sleepMs(BACKOFF_MS);
  }
  spentMs.set(env, (spentMs.get(env) ?? 0) + (performance2.now() - start));
  if (code === 0) return { ok: true, code: 0, stdout, error: "" };
  const detail = (err || `sqlite3 exited ${code}`).split("\n")[0];
  return { ok: false, code, stdout, error: `tmb_db_write: ${caller}: ${detail}` };
}

// src/cli/validation-record-fallback.ts
var USAGE = '{"error":"usage","message":"validation-record-fallback <task_id> <attempt_n> <verdict> <feedback> <subagent_session_id> [<findings_json>]"}\n';
var WS = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
var FINDING_SHAPE = "{criterion_id?, probe_cmd, expected, observed}";
var ALLOWED_KEYS = "('criterion_id', 'probe_cmd', 'expected', 'observed')";
function badText(field2) {
  return `WHEN json_type(e.value, '$.${field2}') IS NOT 'text' OR trim(json_extract(e.value, '$.${field2}'), ${WS}) = '' THEN 'findings[' || e.key || '].${field2} must be a non-empty string'`;
}
var FINDINGS_CHECK_SQL = `
WITH f(v) AS (SELECT ?1),
bad(k, msg) AS (
  SELECT e.key, CASE
    WHEN e.type <> 'object' THEN 'findings[' || e.key || '] must be an object ${FINDING_SHAPE}'
    WHEN EXISTS (SELECT 1 FROM json_each(e.value) k WHERE k.key NOT IN ${ALLOWED_KEYS})
      THEN 'findings[' || e.key || '] has unknown field(s) ' || (SELECT group_concat(k.key, ', ') FROM json_each(e.value) k WHERE k.key NOT IN ${ALLOWED_KEYS}) || '; allowed: criterion_id, probe_cmd, expected, observed'
    ${badText("probe_cmd")}
    ${badText("expected")}
    ${badText("observed")}
    WHEN json_type(e.value, '$.criterion_id') NOT IN ('null', 'text') OR trim(json_extract(e.value, '$.criterion_id'), ${WS}) = ''
      THEN 'findings[' || e.key || '].criterion_id must be a non-empty string or null'
  END
  FROM f, json_each(f.v) e
  WHERE json_valid(f.v) AND json_type(f.v) = 'array'
)
SELECT CASE
  WHEN NOT json_valid(v) THEN 'invalid_findings|findings is not valid JSON'
  WHEN json_type(v) NOT IN ('array', 'null') THEN 'invalid_findings|findings must be a JSON array of ${FINDING_SHAPE}'
  WHEN ?2 = 'pass' AND COALESCE(json_array_length(v), 0) > 0 THEN 'findings_refused|a pass verdict records no findings; send findings only with verdict fail'
  WHEN ?2 = 'fail' AND COALESCE(json_array_length(v), 0) = 0 THEN 'findings_required|a fail verdict needs a non-empty findings array, one ${FINDING_SHAPE} per defect, each probe_cmd a command that exits 0 once the defect is fixed'
  ELSE COALESCE((SELECT 'invalid_findings|' || msg FROM bad WHERE msg IS NOT NULL ORDER BY k LIMIT 1), 'ok')
END
FROM f;`;
function findingsCheck(findings, verdict) {
  try {
    const sqlite2 = loadNodeSqlite();
    if (!sqlite2) throw new Error("node:sqlite is unavailable in this Node");
    const db = new sqlite2.DatabaseSync(":memory:");
    try {
      const stmt = db.prepare(FINDINGS_CHECK_SQL);
      stmt.setReturnArrays(true);
      const [result] = stmt.get(findings.replace(/\n+$/, ""), verdict);
      return String(result).replace(/\n+$/, "");
    } finally {
      db.close();
    }
  } catch (e) {
    return `invalid_findings|sqlite3 could not read the findings: ${e instanceof Error ? e.message : String(e)}`;
  }
}
function writeSql(taskId, attemptN, verdict, feedback, session, findings, createdAt) {
  const safeFindings = sqlQuote(findings);
  const findingsArray = `CASE json_type('${safeFindings}') WHEN 'array' THEN json('${safeFindings}') ELSE '[]' END`;
  return `INSERT INTO validation_attempts
  (task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, created_at)
VALUES
  (${taskId}, ${attemptN}, 'code-reviewer', '${verdict}', '${sqlQuote(feedback)}', 0, '${sqlQuote(session)}', '${createdAt}')
ON CONFLICT(task_id, attempt_n) DO UPDATE SET
  agent = excluded.agent,
  verdict = excluded.verdict,
  feedback = excluded.feedback,
  mcp_available = excluded.mcp_available,
  subagent_session_id = excluded.subagent_session_id,
  reviewer_agent_id = NULL,
  created_at = excluded.created_at;
CREATE TEMP TABLE fallback_last_finding AS
  SELECT COALESCE(MAX(CAST(substr(id, instr(id, '-') + 1) AS INTEGER)), 0) AS n
  FROM review_findings WHERE task_id = ${taskId};
DELETE FROM review_findings WHERE task_id = ${taskId} AND attempt_n = ${attemptN} AND status = 'open';
INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at)
  SELECT 'F${taskId}-' || ((SELECT n FROM fallback_last_finding) + e.key + 1), ${taskId}, ${attemptN},
    CASE WHEN json_type(e.value, '$.criterion_id') = 'text' THEN trim(json_extract(e.value, '$.criterion_id'), ${WS}) END,
    trim(json_extract(e.value, '$.probe_cmd'), ${WS}),
    trim(json_extract(e.value, '$.expected'), ${WS}),
    trim(json_extract(e.value, '$.observed'), ${WS}),
    'open', '${createdAt}'
  FROM json_each(${findingsArray}) e
  ORDER BY e.key;
SELECT json_group_array(id) FROM (
  SELECT 'F${taskId}-' || ((SELECT n FROM fallback_last_finding) + e.key + 1) AS id
  FROM json_each(${findingsArray}) e
  ORDER BY e.key);
DROP TABLE fallback_last_finding;`;
}
function validationRecordFallback(argv2, env, io2) {
  if (argv2.length < 5 || argv2.length > 6) {
    io2.out(USAGE);
    return 1;
  }
  const [taskId, attemptN, verdict, feedback, session] = argv2;
  const findings = argv2[5] || "[]";
  if (!/^[0-9]+$/.test(taskId)) {
    io2.out(`{"error":"invalid_task_id","value":"${taskId}"}
`);
    return 1;
  }
  if (!/^[0-9]+$/.test(attemptN)) {
    io2.out(`{"error":"invalid_attempt_n","value":"${attemptN}"}
`);
    return 1;
  }
  if (verdict !== "pass" && verdict !== "fail") {
    io2.out(`{"error":"invalid_verdict","value":"${verdict}","allowed":["pass","fail"]}
`);
    return 1;
  }
  const check = findingsCheck(findings, verdict);
  if (check !== "ok") {
    const bar = check.indexOf("|");
    const code = bar < 0 ? check : check.slice(0, bar);
    const message = (bar < 0 ? check : check.slice(bar + 1)).replace(/\n/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    io2.out(`{"error":"${code}","message":"${message}"}
`);
    return 1;
  }
  const db = fallbackDbPath(env);
  if (!isFile2(db)) {
    io2.out(dbNotFoundJson(db));
    return 1;
  }
  const r = dbWrite(db, writeSql(taskId, attemptN, verdict, feedback, session, findings, nowIso()), {
    caller: "validation-record-fallback",
    env
  });
  if (!r.ok) {
    io2.err(`${r.error}
`);
    io2.out(`{"error":"db-write-failed","path":"${db}","hint":"tmb_db_write reported the cause on stderr."}
`);
    return 1;
  }
  const ids = r.stdout.replace(/\n+$/, "").split("\n").pop() || "[]";
  io2.out(`{"ok":true,"task_id":${taskId},"attempt_n":${attemptN},"verdict":"${verdict}","findings":${ids}}
`);
  return 0;
}

// src/cli/index.ts
var SUBCOMMANDS = {
  "bro-sqlite-readonly": broSqliteReadonly,
  health,
  "validation-record-fallback": validationRecordFallback
};
var USAGE2 = `usage: cli.js <${Object.keys(SUBCOMMANDS).join("|")}> [args...]
`;
var io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text)
};
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
var [name, ...argv] = process.argv.slice(2);
var run = name !== void 0 && Object.hasOwn(SUBCOMMANDS, name) ? SUBCOMMANDS[name] : void 0;
if (name === "--help" || name === "-h") {
  io.out(USAGE2);
} else if (!run) {
  io.err(name === void 0 ? USAGE2 : `cli.js: unknown subcommand '${name}'
${USAGE2}`);
  process.exitCode = 2;
} else {
  process.exitCode = run(argv, process.env, io);
}
//# sourceMappingURL=cli.js.map
