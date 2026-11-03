// src/cli/assert-sql.ts
import { closeSync as closeSync2, existsSync as existsSync3, mkdtempSync, openSync as openSync2, readSync as readSync2, rmSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";

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
  const body2 = Array.isArray(value) ? value.map((v) => render(v, indent, inner)) : keysInOrder(value).filter((key) => record[key] !== void 0).map((key) => `${JSON.stringify(key)}:${indent === "" ? "" : " "}${render(record[key], indent, inner)}`);
  if (body2.length === 0) return `${open}${close}`;
  return indent === "" ? `${open}${body2.join(",")}${close}` : `${open}
${inner}${body2.join(`,
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
function commandSubstitution(text) {
  return text.replace(/\0/g, "").replace(/\n+$/, "");
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
function ctypeUtf8(env = process.env) {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "C";
  return /(^|\.)utf-?8$/i.test(locale) && !locale.includes("/") && existsSync(`/usr/share/locale/${locale}/LC_CTYPE`);
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
function deadlineSignal() {
  return scopes.getStore()?.signal;
}
function markDeadlineExpired() {
  const scope = scopes.getStore();
  if (scope) scope.expired = true;
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
  const message2 = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  const opt = rest[0];
  const type = typeof opt === "string" ? opt : opt !== null && typeof opt === "object" && typeof opt.type === "string" ? opt.type : warning instanceof Error ? warning.name : "";
  return type === "ExperimentalWarning" && /sqlite/i.test(message2);
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
var SQLITE_RO_TIMEOUT_MS = 500;
var CANTOPEN = 14;
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
function gateRead(db, sql, env = process.env) {
  const ms = readTimeoutMs(env);
  if (db === "" || !isFile(db)) return GATE_READ_ERROR;
  const ro = !walCold(db);
  let r = sqliteOnce(ro, ms, db, sql, env);
  if (r.code === CANTOPEN && ro) r = sqliteOnce(false, ms, db, sql, env);
  return r.code === 0 ? r.out : GATE_READ_ERROR;
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
function sqliteRo(db, sql, env = process.env) {
  const out = gateRead(db, sql, { ...env, TMB_DB_WRITE_TIMEOUT_MS: String(SQLITE_RO_TIMEOUT_MS) });
  return out === GATE_READ_ERROR ? "" : out;
}
function sqlInt(value = "") {
  return /^[0-9]+$/.test(value) ? value : "";
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

// src/cli/assert-sql.ts
var USAGE = 'usage: cli.js assert-sql <db> "<sql>" <expected> [--op eq|ge|le]\n';
var SNAPSHOT_TIMEOUT_MS = 5e3;
var NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;
var OPS = ["eq", "ge", "le"];
function parseArgs(argv2) {
  let op = "eq";
  const positional = [];
  for (let i = 0; i < argv2.length; i += 1) {
    const arg = argv2[i];
    if (arg === "--op") {
      if (i + 1 >= argv2.length) return null;
      op = argv2[i += 1];
    } else if (arg.startsWith("--op=")) {
      op = arg.slice("--op=".length);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 3 || !OPS.includes(op)) return null;
  const [db, sql, expected] = positional;
  return { db, sql, expected, op };
}
function uriPath(path) {
  return path.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23");
}
function walModeHeader(db) {
  const byte = Buffer.alloc(1);
  const fd = openSync2(db, "r");
  try {
    return readSync2(fd, byte, 0, 1, 18) === 1 && byte[0] === 2;
  } finally {
    closeSync2(fd);
  }
}
function message(e) {
  const err = e;
  const text = err && typeof err.message === "string" ? err.message : String(e);
  const code = err && typeof err.errcode === "number" ? err.errcode & 255 : 0;
  return code > 1 ? `${text} (${code})` : text;
}
function openSnapshot(db, env) {
  const { DatabaseSync } = loadNodeSqlite();
  const src = !existsSync3(`${db}-wal`) && walModeHeader(db) ? `file:${uriPath(db)}?immutable=1` : db;
  const dir = mkdtempSync(`${(env.TMPDIR || "/tmp").replace(/\/+$/, "")}/assert-sql.`);
  try {
    const snap = `${dir}/ref.db`;
    const source = new DatabaseSync(src, { readOnly: true, timeout: SNAPSHOT_TIMEOUT_MS });
    try {
      source.prepare("VACUUM INTO ?").run(snap);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(snap);
    try {
      copy.exec("PRAGMA journal_mode=DELETE;");
    } finally {
      copy.close();
    }
    return new DatabaseSync(snap, { readOnly: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function query(db, sql) {
  let out = "";
  for (const stmt of splitStatements(sql)) {
    let prepared;
    try {
      prepared = db.prepare(stmt.text);
    } catch (e) {
      throw new Error(`Error: in prepare, ${message(e)}`);
    }
    try {
      prepared.setReturnArrays(true);
      prepared.setReadBigInts(true);
      for (const row of prepared.iterate()) out += `${row.map(listValue).join("|")}
`;
    } catch (e) {
      throw new Error(`Error: stepping, ${message(e)}`);
    }
  }
  return stripTrailingNewlines(out);
}
function compare(op, got, expected) {
  if (op === "eq") return got === expected;
  if (!NUMBER.test(got) || !NUMBER.test(expected)) return null;
  return op === "ge" ? Number(got) >= Number(expected) : Number(got) <= Number(expected);
}
async function assertSql(argv2, env, io2) {
  const args = parseArgs(argv2);
  if (!args) {
    io2.err(USAGE);
    return 2;
  }
  const { db, sql, expected, op } = args;
  if (!isFile2(db)) {
    io2.out(`assert-sql: ERROR database not found: ${db}
`);
    return 2;
  }
  if (!loadNodeSqlite()) {
    io2.out("assert-sql: ERROR node:sqlite is unavailable in this Node (needs Node 22.13+)\n");
    return 2;
  }
  let reader;
  try {
    reader = openSnapshot(db, env);
  } catch (e) {
    io2.out(`assert-sql: ERROR query failed: Error: ${message(e)}
`);
    return 2;
  }
  await nextTurn();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  let out;
  try {
    out = query(reader, sql);
  } catch (e) {
    io2.out(`assert-sql: ERROR query failed: ${e.message.split("\n")[0]}
`);
    return 2;
  } finally {
    reader.close();
  }
  if (out === "") {
    io2.out(`assert-sql: FAIL got NULL or no rows, want ${op} '${expected}': ${sql}
`);
    return 1;
  }
  const rows = out.split("\n").length;
  if (rows > 1) {
    io2.out(`assert-sql: FAIL expected a single value, got ${rows} rows: ${sql}
`);
    return 1;
  }
  const ok = compare(op, out, expected);
  if (ok === null) {
    io2.out(`assert-sql: FAIL --op ${op} needs numbers, got '${out}' vs '${expected}': ${sql}
`);
    return 1;
  }
  if (ok) {
    io2.out(`assert-sql: PASS '${out}' ${op} '${expected}': ${sql}
`);
    return 0;
  }
  io2.out(`assert-sql: FAIL got '${out}', want ${op} '${expected}': ${sql}
`);
  return 1;
}

// src/cli/bro-sqlite-readonly.ts
import { appendFileSync, existsSync as existsSync4, mkdirSync, mkdtempSync as mkdtempSync2, rmSync as rmSync2 } from "node:fs";

// src/cli/py-json.ts
var PyJsonError = class extends Error {
};
var NUMBER2 = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;
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
    NUMBER2.lastIndex = this.pos;
    const m = NUMBER2.exec(t);
    if (!m) this.fail("Expecting value");
    this.pos = NUMBER2.lastIndex;
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
var SNAPSHOT_TIMEOUT_MS2 = 5e3;
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
function errorJson(message2) {
  return `{"error":${pyDumps(message2)}}
`;
}
function uriPath2(path) {
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
    const src = existsSync4(`${this.dbPath}-wal`) ? this.dbPath : `file:${uriPath2(this.dbPath)}?immutable=1`;
    try {
      this.snapDir = mkdtempSync2(`${this.env.TMPDIR || "/tmp"}/bro-sqlite-readonly.`);
      const { DatabaseSync } = sqlite();
      const snap = `${this.snapDir}/snap.db`;
      const source = new DatabaseSync(src, { readOnly: true, timeout: SNAPSHOT_TIMEOUT_MS2 });
      try {
        source.prepare("VACUUM INTO ?").run(snap);
      } finally {
        source.close();
      }
      const copy = new DatabaseSync(snap, { timeout: SNAPSHOT_TIMEOUT_MS2 });
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
    if (this.snapDir !== "") rmSync2(this.snapDir, { recursive: true, force: true });
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
import { existsSync as existsSync5, readdirSync, readFileSync as readFileSync4, statSync as statSync6 } from "node:fs";
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
  if (legacyGraph !== "" && existsSync5(legacyGraph)) {
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

// src/cli/integrate.ts
import { spawn as spawn3, spawnSync as spawnSync4 } from "node:child_process";
import { closeSync as closeSync4, existsSync as existsSync6, mkdirSync as mkdirSync3, mkdtempSync as mkdtempSync4, openSync as openSync4, readFileSync as readFileSync7, rmdirSync, rmSync as rmSync4 } from "node:fs";
import { constants as osConstants2, tmpdir as tmpdir2 } from "node:os";
import { join as join3 } from "node:path";

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

// src/hooks/lib/git.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
import { spawn } from "node:child_process";
import { statSync as statSync8 } from "node:fs";
var GIT_MAX_BUFFER = 256 * 1024 * 1024;
function codedError(message2, code) {
  return Object.assign(new Error(message2), { code });
}
function collector() {
  const chunks = [];
  let size = 0;
  return {
    add(chunk) {
      if (size <= GIT_MAX_BUFFER) chunks.push(chunk.subarray(0, GIT_MAX_BUFFER - size + 1));
      size += chunk.length;
    },
    bytes: () => Buffer.concat(chunks).subarray(0, GIT_MAX_BUFFER),
    over: () => size > GIT_MAX_BUFFER
  };
}
function timedOut(args) {
  return codedError(`git ${args[0] ?? ""} timed out`, "ETIMEDOUT");
}
async function spawnGit(dir, args, options) {
  const { env = process.env, input = "", stderr = "ignore", timeoutMs } = options;
  const limit = spawnLimit(timeoutMs);
  const signal = limit === null ? void 0 : limit.byDeadline ? deadlineSignal() : AbortSignal.timeout(limit.timeout);
  if (signal?.aborted) {
    const error = timedOut(args);
    noteSpawn(limit, { error, signal: null });
    return { code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error };
  }
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", dir, ...args], { env, stdio: ["pipe", "pipe", stderr], signal });
    const out = collector();
    const err = collector();
    let cut;
    let done = false;
    const dropOutput = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finish = (code, killedBy, failure2) => {
      if (done) return;
      done = true;
      const overflow = out.over() || err.over() ? codedError(`git ${args[0] ?? ""} passed its output limit`, "ENOBUFS") : void 0;
      const error = failure2 ?? cut ?? overflow;
      noteSpawn(limit, { error, signal: killedBy });
      resolve({ code: error || code === null ? -1 : code, stdout: out.bytes(), stderr: err.bytes(), error });
    };
    const take = (into, chunk) => {
      into.add(chunk);
      if (!into.over()) return;
      dropOutput();
      child.kill();
    };
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on("error", () => void 0);
    child.stdout?.on("data", (chunk) => take(out, chunk));
    child.stderr?.on("data", (chunk) => take(err, chunk));
    child.on("error", (failure2) => {
      if (failure2.name !== "AbortError") {
        finish(null, null, failure2);
        return;
      }
      cut = timedOut(args);
      dropOutput();
    });
    child.on("close", (code, killedBy) => finish(code, killedBy));
    child.stdin?.end(input);
  });
}
var memos = new AsyncLocalStorage2();
var READ_SUBCOMMANDS = /* @__PURE__ */ new Set(["rev-parse", "show-ref", "merge-base", "cat-file", "status"]);
var WALK_SUBCOMMANDS = /* @__PURE__ */ new Set(["log", "rev-list"]);
var WRITES_A_FILE = /^--ou/;
var SYMBOLIC_REF_READ_FLAGS = /* @__PURE__ */ new Set(["--short", "-q", "--quiet"]);
function isProvablyReadOnly(args) {
  const [subcommand, ...rest] = args;
  if (READ_SUBCOMMANDS.has(subcommand)) return true;
  if (WALK_SUBCOMMANDS.has(subcommand)) return !rest.some((arg) => WRITES_A_FILE.test(arg));
  if (subcommand === "remote") return rest[0] === "get-url";
  if (subcommand === "worktree") return rest[0] === "list";
  if (subcommand !== "symbolic-ref") return false;
  const others = rest.filter((arg) => !SYMBOLIC_REF_READ_FLAGS.has(arg));
  return others.length === 1 && !others[0].startsWith("-");
}
function isFetch(args) {
  let at = 0;
  while (args[at] === "-c" && args[at + 1]?.startsWith("http.")) at += 2;
  return args[at] === "fetch";
}
function isCut(r) {
  return r.code === -1 && r.error?.code === "ETIMEDOUT";
}
function forget(memo, settledFetches) {
  for (const [key, entry] of memo.entries) {
    if (entry.kind === "read" || settledFetches && entry.settled) memo.entries.delete(key);
  }
}
function startShared(memo, key, kind, dir, args, options) {
  const conclude = (keep) => {
    entry.settled = true;
    if (!keep && memo.entries.get(key) === entry) memo.entries.delete(key);
    if (kind === "fetch") forget(memo, false);
  };
  const entry = {
    kind,
    settled: false,
    run: spawnGit(dir, args, options).then(
      (r) => {
        conclude(kind === "read" ? r.code !== -1 : r.code === 0);
        return r;
      },
      (failure2) => {
        conclude(false);
        throw failure2;
      }
    )
  };
  memo.entries.set(key, entry);
  return entry.run;
}
var OWN_DEADLINE = /* @__PURE__ */ Symbol("own-deadline");
async function untilOwnDeadline(run2, signal) {
  if (signal === void 0) return await run2;
  let onAbort = () => void 0;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(OWN_DEADLINE);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run2, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function sharedRun(memo, kind, dir, args, options) {
  const key = JSON.stringify([dir, args, options.input ?? ""]);
  const signal = deadlineSignal();
  for (; ; ) {
    const held = memo.entries.get(key);
    if (held === void 0) return await startShared(memo, key, kind, dir, args, options);
    const r = signal?.aborted ? OWN_DEADLINE : await untilOwnDeadline(held.run, signal);
    if (r === OWN_DEADLINE) {
      markDeadlineExpired();
      return { code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: timedOut(args) };
    }
    if (!isCut(r)) return r;
  }
}
async function gitSpawn(dir, args, options = {}) {
  const memo = memos.getStore();
  if (memo === void 0) return await spawnGit(dir, args, options);
  const sharable = (options.env ?? process.env) === memo.env && (options.stderr ?? "ignore") === "ignore" && options.timeoutMs === void 0;
  if (isProvablyReadOnly(args)) return sharable ? await sharedRun(memo, "read", dir, args, options) : await spawnGit(dir, args, options);
  if (sharable && isFetch(args)) return await sharedRun(memo, "fetch", dir, args, options);
  forget(memo, true);
  try {
    return await spawnGit(dir, args, options);
  } finally {
    forget(memo, true);
  }
}
async function gitRun(dir, args, env = process.env, input = "", stderr = "ignore") {
  const r = await gitSpawn(dir, args, { env, input, stderr });
  return { code: r.code, stdout: r.stdout.toString("utf8") };
}
async function gitOut(dir, args, env = process.env, input = "") {
  return (await gitRun(dir, args, env, input)).stdout.replace(/\n+$/, "");
}
function isDir3(path) {
  if (path === "") return false;
  try {
    return statSync8(path).isDirectory();
  } catch {
    return false;
  }
}
function cdPwd(path, pwd) {
  if (!isDir3(path === "" ? "." : path)) return "";
  const abs = path.startsWith("/") ? path : `${pwd.replace(/\/$/, "")}/${path}`;
  const out = [];
  for (const part of abs.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

// src/hooks/lib/repo.ts
import { statSync as statSync9 } from "node:fs";
function isFile5(path) {
  if (path === "") return false;
  try {
    return statSync9(path).isFile();
  } catch {
    return false;
  }
}
function firstLine(text) {
  const nl = text.indexOf("\n");
  return nl < 0 ? text : text.slice(0, nl);
}
function readable(db, env) {
  return isFile5(db) && haveSqlite(env);
}
async function repoGitRoot(target, env = process.env) {
  if (target === "") return "";
  while (!isDir3(target) && target !== "/" && target !== ".") target = posixDirname(target);
  if (!isDir3(target)) return "";
  const common = await gitOut(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env);
  if (common !== "") return cdPwd(posixDirname(common), shellPwd(env));
  return await gitOut(target, ["rev-parse", "--show-toplevel"], env);
}
function repoSinglePath(db, env = process.env) {
  if (!readable(db, env)) return "";
  if (sqliteRo(db, "SELECT COUNT(*) FROM repos;", env) !== "1") return "";
  return firstLine(sqliteRo(db, "SELECT path FROM repos LIMIT 1;", env));
}
function repoPathByName(db, name2, env = process.env) {
  if (!readable(db, env) || name2 === "") return "";
  return firstLine(sqliteRo(db, `SELECT path FROM repos WHERE name = '${sqlQuote(name2)}' LIMIT 1;`, env));
}

// src/hooks/swe-verification-gate.ts
import { spawn as spawn2, spawnSync as spawnSync3 } from "node:child_process";
import { accessSync as accessSync5, closeSync as closeSync3, constants as constants6, mkdirSync as mkdirSync2, mkdtempSync as mkdtempSync3, openSync as openSync3, readFileSync as readFileSync6, rmSync as rmSync3, statSync as statSync10, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";

// src/hooks/gate.ts
var ALLOW = Object.freeze({ stdout: "", code: 0 });

// src/hooks/lib/verification-carry.ts
import { realpathSync as realpathSync3 } from "node:fs";
import { basename, matchesGlob } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var VERIFICATION_INPUTS_PATH = ".config/tmb/verification-inputs.json";
var VERIFICATION_INPUTS_VERSION = 1;
var SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
var PROBE_PREFIX = "[probe ";
function refuse(reason, source = null) {
  return { source_run: source?.id ?? null, source_sha: source?.sha ?? null, carry: [], refused: reason, commands: [] };
}
function parseCommands(json) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) && parsed.every((c) => typeof c === "string" && c !== "") ? parsed : null;
  } catch {
    return null;
  }
}
function parseInputsMap(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "map_invalid";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "map_invalid";
  const map = parsed;
  if (map.version !== VERIFICATION_INPUTS_VERSION) return "map_unknown_version";
  if (!Array.isArray(map.commands)) return "map_invalid";
  const entries = [];
  for (const entry of map.commands) {
    if (entry === null || typeof entry !== "object") return "map_invalid";
    const { match, inputs } = entry;
    if (typeof match !== "string" || match === "") return "map_invalid";
    if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((g) => typeof g === "string" && g !== "")) return "map_invalid";
    entries.push({ match, inputs });
  }
  return entries;
}
function sourceRun(db, taskId, head, env) {
  const out = gateRead(
    db,
    `SELECT json_object('id', id, 'sha', lower(commit_sha)) FROM verification_runs
      WHERE task_id = ${taskId} AND finished_at IS NOT NULL AND exit_code = 0 AND timed_out = 0
        AND lower(commit_sha) <> '${sqlQuote(head)}'
      ORDER BY finished_at DESC, id DESC LIMIT 1;`,
    env
  );
  if (out === GATE_READ_ERROR) return "error";
  if (out === "") return null;
  const row = JSON.parse(out);
  if (typeof row.id !== "number" || typeof row.sha !== "string" || !SHA_RE.test(row.sha)) return null;
  return { id: row.id, sha: row.sha };
}
function passedInSource(db, runId, env) {
  const out = gateRead(
    db,
    `SELECT COALESCE(json_group_array(command), '[]') FROM verification_run_commands WHERE run_id = ${runId} AND exit_code = 0;`,
    env
  );
  if (out === GATE_READ_ERROR) return "error";
  const commands = parseCommands(out === "" ? "[]" : out);
  return commands === null ? "error" : new Set(commands);
}
async function changedPaths(worktree, from, to, env) {
  const r = await gitRun(worktree, ["diff", "--name-only", "--no-renames", "-z", from, to, "--"], env);
  if (r.code !== 0) return null;
  return r.stdout.split("\0").filter((p) => p !== "");
}
async function planCarry(req, env = process.env) {
  const taskId = sqlInt(req.taskId);
  const head = req.head.toLowerCase();
  const commands = parseCommands(req.commandsJson);
  if (req.db === "" || taskId === "" || req.worktree === "" || !SHA_RE.test(head) || commands === null) return refuse("bad_input");
  const actualHead = await gitRun(req.worktree, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], env);
  if (actualHead.code !== 0 || actualHead.stdout.trim().toLowerCase() !== head) return refuse("head_mismatch");
  const source = sourceRun(req.db, taskId, head, env);
  if (source === "error") return refuse("db_unreadable");
  if (source === null) return refuse("no_source_run");
  if ((await gitRun(req.worktree, ["merge-base", "--is-ancestor", source.sha, head], env)).code !== 0) return refuse("not_ancestor", source);
  const merges = await gitRun(req.worktree, ["rev-list", "--merges", `${source.sha}..${head}`], env);
  if (merges.code !== 0 || merges.stdout.trim() !== "") return refuse("merge_in_range", source);
  const status = await gitRun(req.worktree, ["status", "--porcelain"], env);
  if (status.code !== 0 || status.stdout.trim() !== "") return refuse("dirty_worktree", source);
  const changed = await changedPaths(req.worktree, source.sha, head, env);
  if (changed === null) return refuse("diff_failed", source);
  if (changed.includes(VERIFICATION_INPUTS_PATH)) return refuse("map_changed", source);
  const mapText = await gitRun(req.worktree, ["show", `${head}:${VERIFICATION_INPUTS_PATH}`], env);
  if (mapText.code !== 0) return refuse("map_missing", source);
  const entries = parseInputsMap(mapText.stdout);
  if (typeof entries === "string") return refuse(entries, source);
  const passed = passedInSource(req.db, source.id, env);
  if (passed === "error") return refuse("db_unreadable", source);
  const decisions = commands.map((command, i) => {
    const decide = (reason) => ({ ordinal: i + 1, command, carried: reason === null, reason });
    if (command.startsWith(PROBE_PREFIX)) return decide("probe");
    if (!passed.has(command)) return decide("not_passed_in_source");
    const declared = entries.filter((e) => e.match === command);
    if (declared.length === 0) return decide("undeclared");
    if (declared.length > 1) return decide("ambiguous_declaration");
    const touched = declared[0].inputs.some((glob) => changed.some((path) => matchesGlob(path, glob)));
    return decide(touched ? "inputs_changed" : null);
  });
  return {
    source_run: source.id,
    source_sha: source.sha,
    carry: decisions.filter((d) => d.carried).map((d) => d.ordinal),
    refused: null,
    commands: decisions
  };
}
async function planCarrySafe(req, env = process.env) {
  try {
    return await planCarry(req, env);
  } catch {
    return refuse("error");
  }
}
function isMainModule() {
  const entry = process.argv[1];
  const self = fileURLToPath2(import.meta.url);
  if (entry === void 0 || basename(self) !== "verification-carry.js") return false;
  try {
    return realpathSync3(entry) === realpathSync3(self);
  } catch {
    return false;
  }
}
if (isMainModule()) {
  const [db = "", taskId = "", worktree = "", head = "", commandsJson = ""] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(await planCarrySafe({ db, taskId, worktree, head, commandsJson }))}
`);
}

// src/hooks/swe-verification-gate.ts
var GATE_NAME = "swe-verification-gate";
var VERIFICATION_DEFAULT_S = 900;
var VERIFICATION_MAX_S = 1800;
var signals = osConstants.signals;
function shellLength(s, env) {
  return ctypeUtf8(env) ? [...s].length : Buffer.byteLength(s);
}
function shellTail(s, n, env) {
  if (ctypeUtf8(env)) return [...s].slice(-n).join("");
  const bytes = Buffer.from(s);
  return bytes.subarray(Math.max(0, bytes.length - n)).toString("utf8");
}
function parseBudget(raw) {
  let timeoutS = VERIFICATION_DEFAULT_S;
  if (raw !== "") {
    if (!/^[0-9]+$/.test(raw)) timeoutS = null;
    else if (raw.length > 9) timeoutS = VERIFICATION_MAX_S;
    else timeoutS = Number(raw) >= 1 ? Number(raw) : null;
  }
  let warning = "";
  if (timeoutS === null) {
    warning = `${GATE_NAME}: verification_timeout_s '${raw.replaceAll("\n", " ")}' is not an integer from 1 to ${VERIFICATION_MAX_S}; using the default ${VERIFICATION_DEFAULT_S}s
`;
    timeoutS = VERIFICATION_DEFAULT_S;
  }
  return { timeoutS: Math.min(timeoutS, VERIFICATION_MAX_S), warning };
}
function executable(path) {
  if (path === "") return false;
  try {
    accessSync5(path, constants6.X_OK);
    return true;
  } catch {
    return false;
  }
}
function capture(cmd, args, dir, env) {
  const r = spawnSync3(cmd, args, { cwd: dir, encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
  return r.stdout ?? "";
}
function toolchainDirs(env, worktree) {
  const home = env.HOME ?? "";
  const out = [];
  const miseData = env.MISE_DATA_DIR || `${env.XDG_DATA_HOME || `${home}/.local/share`}/mise`;
  if (isDir3(`${miseData}/shims`)) out.push(`${miseData}/shims`);
  const mise = [env.MISE_INSTALL_PATH ?? "", "/opt/homebrew/bin/mise", "/usr/local/bin/mise", `${home}/.local/bin/mise`].find(executable);
  if (mise !== void 0) out.push(...capture(mise, ["bin-paths"], worktree, env).split("\n"));
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(executable);
  const brewPrefix = brew === void 0 ? "" : commandSubstitution(capture(brew, ["--prefix"], worktree, env));
  const brewDirs = brewPrefix !== "" ? [`${brewPrefix}/bin`, `${brewPrefix}/sbin`] : ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
  out.push(...brewDirs.filter(isDir3));
  if (home !== "" && isDir3(`${home}/.local/bin`)) out.push(`${home}/.local/bin`);
  if (home !== "") {
    for (const dir of [`${home}/Library/Application Support/reflex/bun/bin`, `${home}/.bun/bin`]) {
      if (isDir3(dir) && executable(`${dir}/bun`)) out.push(dir);
    }
  }
  return out;
}
function joinToolchainPath(dirs, base) {
  const seen = /* @__PURE__ */ new Set();
  for (const dir of [...dirs.filter((d) => d !== ""), ...base.split(":")]) {
    if (dir !== "") seen.add(dir);
  }
  return [...seen].join(":");
}

// src/review-sql.ts
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

// src/utils/worktree-deps.ts
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync as realpathSync4, statSync as statSync11, symlinkSync } from "node:fs";
import { basename as basename2, dirname, join as join2 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/utils/timeouts.ts
var SUBPROCESS_TIMEOUT_MS = 5e3;

// src/utils/worktree-deps.ts
function isDirectory(path) {
  try {
    return statSync11(path).isDirectory();
  } catch {
    return false;
  }
}
function pathPresent(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function trackedPackageDirs(worktreePath) {
  const out = execFileSync("git", ["-C", worktreePath, "ls-files", "-z", "--", "package.json", "*/package.json"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SUBPROCESS_TIMEOUT_MS
  }).toString();
  return [...new Set(out.split("\0").filter(Boolean).map((p) => dirname(p)))];
}
function linkWorktreeNodeModules(repoRoot, worktreePath) {
  const result = { linked: [], skipped: [] };
  let dirs;
  try {
    dirs = trackedPackageDirs(worktreePath);
  } catch (error) {
    result.skipped.push({ dir: ".", reason: `git ls-files failed: ${error.message}` });
    return result;
  }
  for (const dir of dirs) {
    const src = join2(repoRoot, dir, "node_modules");
    const dest = join2(worktreePath, dir, "node_modules");
    if (!isDirectory(src)) {
      result.skipped.push({ dir, reason: `no install at ${src}` });
      continue;
    }
    if (pathPresent(dest)) {
      result.skipped.push({ dir, reason: `${dest} already exists` });
      continue;
    }
    try {
      symlinkSync(src, dest);
      result.linked.push(dir);
    } catch (error) {
      result.skipped.push({ dir, reason: `could not link ${src}: ${error.message}` });
    }
  }
  return result;
}
function isMainModule2() {
  const entry = process.argv[1];
  const self = fileURLToPath3(import.meta.url);
  if (entry === void 0 || basename2(self) !== "worktree-deps.js") return false;
  try {
    return realpathSync4(entry) === realpathSync4(self);
  } catch {
    return false;
  }
}
if (isMainModule2()) {
  const [repoRoot, worktreePath] = process.argv.slice(2);
  if (!repoRoot || !worktreePath) {
    process.stderr.write("usage: node worktree-deps.js <repoRoot> <worktreePath>\n");
  } else {
    for (const s of linkWorktreeNodeModules(repoRoot, worktreePath).skipped) {
      process.stderr.write(`worktree-deps: ${s.dir}: ${s.reason}
`);
    }
  }
  process.exit(0);
}

// src/cli/integrate.ts
var FINISH_ATTEMPTS = 3;
var TAIL_LINES = 20;
var DEFAULT_TAIL_CHARS = 4e3;
var TIMED_OUT_CODE = 124;
var REGEN_ATTR = "attr:merge=tmb-regen";
var REGEN_SCRIPTS = [
  { name: "regen-generated.ts", run: ["node", "--experimental-strip-types", "--no-warnings"] },
  { name: "regen-generated.sh", run: ["bash"] }
];
var RECORD_ENV = { TMB_DB_WRITE_TIMEOUT_MS: "5000", TMB_DB_WRITE_RUN_BUDGET_MS: "10000" };
var MAX_BUFFER2 = 256 * 1024 * 1024;
var signals2 = osConstants2.signals;
var Exit2 = class extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
  code;
};
function nowS() {
  return Math.floor(Date.now() / 1e3);
}
function sleepS(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1e3);
}
function verificationCommands(json) {
  const { values, complete } = jsonStream(json);
  if (!complete) return null;
  const out = [];
  for (const value of values) {
    if (value === null || typeof value !== "object") continue;
    const items = Array.isArray(value) ? value : keysInOrder(value).map((k) => value[k]);
    for (const item of items) if (typeof item === "string" && item !== "") out.push(item);
  }
  return commandSubstitution(out.join("\n"));
}
function lastLines(text, n) {
  return text === "" ? "" : text.split("\n").slice(-n).join("\n");
}
var Integration = class {
  constructor(env, io2) {
    this.env = env;
    this.io = io2;
  }
  env;
  io;
  db = "";
  taskId = "";
  base = "";
  branch = "";
  commitSha = "";
  baseSha = "";
  repoRoot = "";
  tip = "";
  wt = "";
  runId = "";
  runOpen = false;
  child = null;
  scratch = "";
  say(text) {
    this.io.err(`integrate: ${text}
`);
  }
  die(code, text) {
    this.say(text);
    throw new Exit2(code);
  }
  git(dir, args, opts = {}) {
    const r = spawnSync4("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: opts.env ?? this.env,
      input: opts.input,
      stdio: [opts.input === void 0 ? "ignore" : "pipe", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER2
    });
    return { ok: r.status === 0, out: commandSubstitution(r.stdout ?? ""), err: r.stderr ?? "" };
  }
  /** A git command whose output goes to stderr, as the .sh's `>&2`. */
  gitLoud(dir, args, env) {
    const r = spawnSync4("git", ["-C", dir, ...args], { encoding: "utf8", env: env ?? this.env, stdio: ["ignore", "pipe", "pipe"] });
    this.io.err(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    return r.status === 0;
  }
  g(args) {
    return this.git(this.repoRoot, args);
  }
  revParse(dir, rev) {
    const r = this.git(dir, ["rev-parse", "--verify", "-q", rev]);
    return r.ok ? r.out : "";
  }
  record(sql) {
    const r = dbWrite(this.db, sql, { caller: "integrate", env: { ...this.env, ...RECORD_ENV } });
    if (!r.ok && r.error !== "") this.io.err(`${r.error}
`);
    return { ok: r.ok, stdout: r.stdout };
  }
  finish(rc, timedOut2) {
    for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt += 1) {
      if (this.record(`UPDATE verification_runs SET finished_at = '${nowIso()}', exit_code = ${rc}, timed_out = ${timedOut2} WHERE id = ${this.runId};`).ok) {
        this.runOpen = false;
        return true;
      }
      sleepS(attempt);
    }
    return false;
  }
  recordCommand(ordinal, command, rc, elapsed, output) {
    const rawCap = this.env.TMB_VERIFICATION_TAIL_CHARS || String(DEFAULT_TAIL_CHARS);
    const cap = /^[0-9]+$/.test(rawCap) ? Number(rawCap) : DEFAULT_TAIL_CHARS;
    const tail = shellLength(output, this.env) > cap ? shellTail(output, cap, this.env) : output;
    return this.record(
      `INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (${this.runId}, ${ordinal}, '${sqlQuote(command)}', ${rc}, ${elapsed}, '${sqlQuote(tail)}');`
    ).ok;
  }
  /** Finishes a run left open, kills its command and removes the temporary worktree; safe to call twice. */
  cleanup(code) {
    if (this.child?.pid !== void 0 && this.child.exitCode === null && this.child.signalCode === null) {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {
      }
    }
    if (this.runOpen) {
      const rc = code === 0 ? 1 : code;
      if (!this.finish(rc, 0)) this.say(`run #${this.runId} finish write failed on exit ${rc}`);
    }
    if (this.scratch !== "") rmSync4(this.scratch, { recursive: true, force: true });
    this.scratch = "";
    if (this.wt === "") return;
    if (!this.g(["worktree", "remove", "--force", this.wt]).ok) {
      rmSync4(this.wt, { recursive: true, force: true });
      this.g(["worktree", "prune"]);
    }
    this.wt = "";
  }
  /** Runs <cmd> in the worktree, output captured, killed with its process group after <seconds>. */
  execute(cmd, seconds, env) {
    if (this.scratch === "") this.scratch = mkdtempSync4(join3(this.env.TMPDIR || tmpdir2(), "tmb-integrate-"));
    const outPath = join3(this.scratch, "out");
    return new Promise((done) => {
      const fd = openSync4(outPath, "w");
      let fired = false;
      let settled = false;
      const settle = (rc) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = null;
        let out = "";
        try {
          out = commandSubstitution(readFileSync7(outPath, "utf8"));
        } catch {
        }
        rmSync4(outPath, { force: true });
        done({ rc, fired, out });
      };
      const child = spawn3(cmd[0], cmd.slice(1), { cwd: this.wt, env: { ...env, PWD: this.wt }, stdio: ["ignore", fd, fd], detached: true });
      this.child = child;
      closeSync4(fd);
      const timer = setTimeout(() => {
        fired = true;
        try {
          if (child.pid !== void 0) process.kill(-child.pid, "SIGKILL");
        } catch {
        }
      }, seconds * 1e3);
      child.on("error", () => settle(127));
      child.on("exit", (code, signal) => {
        if (fired) settle(TIMED_OUT_CODE);
        else settle(code ?? 128 + (signal !== null ? signals2[signal] ?? 0 : 0));
      });
    });
  }
  branchHolder() {
    let wt = "";
    for (const line of this.g(["worktree", "list", "--porcelain"]).out.split("\n")) {
      if (line.startsWith("worktree ")) wt = line.slice("worktree ".length);
      if (line === `branch refs/heads/${this.branch}`) return wt;
    }
    return "";
  }
  /** True when no worktree holds the branch and its tip is commit_sha, a verified rebase of it, or absent; sets tip. */
  branchMovable() {
    const holder = this.branchHolder();
    if (holder !== "") {
      this.say(`${this.branch} is checked out at ${holder}; remove that worktree (or switch it off the branch) and run cli.js integrate again`);
      return false;
    }
    this.tip = this.revParse(this.repoRoot, `refs/heads/${this.branch}^{commit}`);
    if (this.tip === "" || this.tip === this.commitSha) return true;
    const runs = gateRead(
      this.db,
      `SELECT COUNT(*) FROM verification_runs
    WHERE task_id = ${this.taskId} AND commit_sha = '${sqlQuote(this.tip)}' AND exit_code = 0 AND timed_out = 0;`,
      this.env
    );
    if (runs === "" || runs === GATE_READ_ERROR || runs === "0") {
      this.say(`${this.branch} is at ${this.tip}, which is neither task ${this.taskId}'s reviewed commit nor a verified integration of it; refusing to move it`);
      return false;
    }
    return true;
  }
  rebasePicks(sha) {
    return this.git(this.wt, ["rev-list", "--reverse", "--no-merges", "--cherry-pick", "--right-only", `${this.baseSha}...${sha}`]).out;
  }
  patchIds(sha) {
    const picks = this.rebasePicks(sha);
    const diff = spawnSync4("git", ["-C", this.wt, "diff-tree", "--stdin", "-p", "-r", "--root", "--", ".", `:(exclude,${REGEN_ATTR})`], {
      encoding: "utf8",
      env: this.env,
      input: picks === "" ? "" : `${picks}
`,
      maxBuffer: MAX_BUFFER2
    });
    const ids = this.git(this.wt, ["patch-id", "--stable"], { input: diff.stdout ?? "" });
    return commandSubstitution(
      ids.out.split("\n").map((line) => line.split(" ")[0]).join("\n")
    );
  }
  regenTouched() {
    return [`${this.baseSha}...${this.commitSha}`, `${this.commitSha}...${this.baseSha}`].some(
      (side) => this.git(this.wt, ["diff", "--name-only", side, "--", `:(${REGEN_ATTR})`]).out !== ""
    );
  }
  async run(argv2) {
    if (argv2.length !== 2) this.die(4, "usage: cli.js integrate <task_id> <base>");
    this.taskId = sqlInt(argv2[0]);
    this.base = argv2[1];
    if (this.taskId === "") this.die(4, `task_id must be a number, got '${argv2[0]}'`);
    if (this.base === "") this.die(4, "base is empty");
    const db = dbPath(this.env);
    if (db === null) this.die(4, "no trajectory DB resolved (set TRAJECTORY_DB_PATH or CLAUDE_PROJECT_DIR)");
    this.db = db;
    const row = gateRead(
      db,
      `SELECT 'task' || char(10) || COALESCE(repo, '') || char(10) || COALESCE(branch_id, '') || char(10) || COALESCE(commit_sha, '') || char(10) || ${HAS_PASS_SQL}
  FROM tasks t WHERE t.id = ${this.taskId};`,
      this.env
    );
    if (row === GATE_READ_ERROR) this.die(4, `trajectory DB read failed: ${db}`);
    if (row === "") this.die(4, `no task ${this.taskId}`);
    const [, taskRepo = "", branch = "", commitSha = "", hasPass = ""] = row.split("\n");
    this.branch = branch;
    if (branch === "") this.die(4, `task ${this.taskId} has no branch_id`);
    if (commitSha === "") this.die(3, `task ${this.taskId} has no commit_sha, so no reviewed commit`);
    if (hasPass !== "1") this.die(3, `task ${this.taskId} has no passing code-reviewer verdict for commit ${commitSha}`);
    const wsRoot = posixDirname(posixDirname(posixDirname(db)));
    const repoDir = taskRepo !== "" ? repoPathByName(db, taskRepo, this.env) || `${wsRoot}/${taskRepo}` : repoSinglePath(db, this.env) || wsRoot;
    this.repoRoot = await repoGitRoot(repoDir, this.env);
    if (this.repoRoot === "" || !isDir3(repoDir)) this.die(4, `task ${this.taskId}'s repo is not a git checkout: ${repoDir || "<unresolved>"}`);
    this.commitSha = this.revParse(this.repoRoot, `${commitSha}^{commit}`);
    if (this.commitSha === "") this.die(4, `commit_sha of task ${this.taskId} is not a commit in ${this.repoRoot}`);
    this.baseSha = this.revParse(this.repoRoot, `${this.base}^{commit}`);
    if (this.baseSha === "") this.die(4, `base '${this.base}' is not a commit in ${this.repoRoot}`);
    if (this.g(["merge-base", "--is-ancestor", this.baseSha, this.commitSha]).ok) {
      this.say(`${this.base} is already an ancestor of task ${this.taskId}'s commit; nothing to rebase`);
      this.io.out(`${this.commitSha}
`);
      return 0;
    }
    const verification = gateRead(db, `SELECT COALESCE(verification, '[]') FROM tasks WHERE id = ${this.taskId};`, this.env);
    if (verification === GATE_READ_ERROR) this.die(4, `trajectory DB read failed: ${db}`);
    const commands = verificationCommands(verification);
    if (commands === null) this.die(4, `task ${this.taskId}'s verification[] is not a JSON array`);
    if (commands === "") this.die(4, `task ${this.taskId} has no verification[]; there is nothing to re-verify the rebased commit with`);
    if (!this.branchMovable()) throw new Exit2(4);
    try {
      mkdirSync3(`${this.repoRoot}/.claude/worktrees`, { recursive: true });
    } catch {
      this.die(4, `cannot create ${this.repoRoot}/.claude/worktrees`);
    }
    try {
      this.wt = mkdtempSync4(`${this.repoRoot}/.claude/worktrees/integrate-${this.taskId}.`);
    } catch {
      this.die(4, "cannot create a temporary worktree dir");
    }
    if (!this.gitLoud(this.repoRoot, ["worktree", "add", "-q", "--detach", this.wt, this.commitSha])) {
      try {
        rmdirSync(this.wt);
      } catch {
      }
      this.wt = "";
      this.die(4, "git worktree add failed");
    }
    this.say(`rebasing task ${this.taskId} (${this.commitSha}) onto ${this.base} (${this.baseSha}) in ${this.wt}`);
    if (!this.gitLoud(this.wt, ["rebase", "-q", this.baseSha], { ...this.env, GIT_EDITOR: "true" })) {
      this.git(this.wt, ["rebase", "--abort"]);
      this.die(2, `rebase of task ${this.taskId} onto ${this.base} conflicted; aborted, ${branch} and the DB are unchanged`);
    }
    let newSha = this.revParse(this.wt, "HEAD");
    if (newSha === "") this.die(4, "cannot read the rebased HEAD");
    try {
      for (const s of linkWorktreeNodeModules(this.repoRoot, this.wt).skipped) this.io.err(`worktree-deps: ${s.dir}: ${s.reason}
`);
    } catch {
      this.say("node_modules linking failed");
    }
    const budgetRaw = this.env.TMB_VERIFICATION_TIMEOUT_S || sqliteRo(db, "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key = 'verification_timeout_s';", this.env);
    const timeoutS = parseBudget(budgetRaw).timeoutS;
    const toolchainPath = joinToolchainPath(toolchainDirs(this.env, this.wt), this.env.PATH ?? "");
    const regen = REGEN_SCRIPTS.find((s) => existsSync6(`${this.wt}/scripts/maintenance/${s.name}`));
    if (newSha !== this.baseSha && regen !== void 0 && this.regenTouched()) {
      const script = `scripts/maintenance/${regen.name}`;
      this.say(`regenerating generated files with ${script}`);
      const r = await this.execute([...regen.run, script], timeoutS, { ...this.env, PATH: toolchainPath });
      if (r.out !== "") this.io.err(`${r.out}
`);
      if (r.rc !== 0) this.die(2, `${script} exited ${r.rc} in the rebased worktree; ${branch} and the DB are unchanged`);
      if (this.git(this.wt, ["status", "--porcelain", "--untracked-files=no"]).out !== "") {
        if (!this.gitLoud(this.wt, ["add", "-u"]) || !this.gitLoud(this.wt, ["commit", "-q", "--amend", "--no-edit"])) {
          this.die(4, `could not amend the regenerated files into the rebased commit; ${branch} and the DB are unchanged`);
        }
        newSha = this.revParse(this.wt, "HEAD");
        if (newSha === "") this.die(4, "cannot read the amended HEAD");
      }
    }
    if (this.rebasePicks(newSha) === "") {
      this.die(2, `task ${this.taskId}'s patch is already in ${this.base}; nothing to integrate, ${branch} and the DB are unchanged`);
    }
    if (this.patchIds(this.commitSha) !== this.patchIds(newSha)) {
      this.die(
        2,
        `the rebase changed task ${this.taskId}'s source patches (patch-id of ${this.base}..reviewed differs from ${this.base}..rebased); ${branch} and the DB are unchanged`
      );
    }
    const now = nowIso();
    const started = this.record(
      `UPDATE verification_runs SET finished_at = '${now}', exit_code = 137, timed_out = 0
 WHERE finished_at IS NULL
   AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) < strftime('%Y-%m-%dT%H:%M:%fZ', '${now}', '-' || (budget_s + 60) || ' seconds');
INSERT INTO verification_runs (task_id, commit_sha, source, started_at, budget_s) VALUES (${this.taskId}, '${sqlQuote(newSha)}', 'manual', '${now}', ${timeoutS});
SELECT last_insert_rowid();`
    );
    this.runId = started.ok ? commandSubstitution(started.stdout) : "";
    if (this.runId === "") this.die(4, `could not record a verification run for ${newSha}; ${branch} unmoved`);
    this.runOpen = true;
    const commandEnv = { ...this.env, ...RECORD_ENV, PATH: toolchainPath };
    const lines = commands.split("\n");
    const total = lines.filter((line) => line !== "").length;
    const startS = nowS();
    for (const [i, cmd] of lines.entries()) {
      const ordinal = i + 1;
      const remaining = timeoutS - (nowS() - startS);
      if (remaining <= 0) {
        this.recordCommand(ordinal, cmd, TIMED_OUT_CODE, 0, "budget spent before the command started");
        if (!this.finish(TIMED_OUT_CODE, 1)) this.say(`run #${this.runId} finish write failed`);
        this.die(1, `verification budget (${timeoutS}s) spent before command ${ordinal}/${total}: ${cmd}; recorded as run #${this.runId}; ${branch} unmoved`);
      }
      const cmdStart = nowS();
      const { rc, fired, out } = await this.execute(["bash", "-c", cmd], remaining, commandEnv);
      const elapsed = nowS() - cmdStart;
      const tail = lastLines(out, TAIL_LINES);
      const timedOut2 = rc === TIMED_OUT_CODE && fired ? 1 : 0;
      if (!this.recordCommand(ordinal, cmd, rc, elapsed, tail)) this.say(`run #${this.runId}: command ${ordinal} row not recorded`);
      if (rc !== 0) {
        if (!this.finish(rc, timedOut2)) this.say(`run #${this.runId} finish write failed`);
        this.say(`verification failed on ${newSha}: command ${ordinal}/${total} exited ${rc} after ${elapsed}s: ${cmd}`);
        this.io.err(`${tail}
`);
        this.die(1, `recorded as run #${this.runId}; ${branch} unmoved`);
      }
    }
    if (!this.finish(0, 0)) {
      this.die(4, `run #${this.runId} passed but its finish write failed, so the push guard will not count it; ${branch} unmoved`);
    }
    const oldTip = this.tip;
    if (!this.branchMovable()) {
      this.die(4, `verification passed (run #${this.runId}) but ${branch} cannot be moved; the rebased commit is ${newSha}`);
    }
    if (this.tip !== oldTip) this.die(4, `${branch} moved during integration (${oldTip} -> ${this.tip}); left as is`);
    if (!this.g(["update-ref", "-m", `cli.js integrate: task ${this.taskId} onto ${this.base}`, `refs/heads/${branch}`, newSha, this.tip]).ok) {
      this.die(4, `git update-ref of ${branch} failed; the rebased commit is ${newSha} (run #${this.runId})`);
    }
    this.say(`${branch} -> ${newSha} (verification run #${this.runId} passed)`);
    this.io.out(`${newSha}
`);
    return 0;
  }
};
async function integrate(argv2, env, io2) {
  const integration = new Integration(env, io2);
  const onExit = (code2) => integration.cleanup(code2);
  process.on("exit", onExit);
  let code = 1;
  try {
    code = await integration.run(argv2);
  } catch (e) {
    if (!(e instanceof Exit2)) throw e;
    code = e.code;
  } finally {
    process.off("exit", onExit);
    integration.cleanup(code);
  }
  return code;
}

// src/cli/prompt-author-lint.ts
import { readFileSync as readFileSync8 } from "node:fs";
var USAGE2 = "usage: cli.js prompt-author-lint <path-to-md-file>\n";
var COMMENT_LINE = /^[ \t\n\v\f\r]*(#|\/\/|--)/;
var CHECKS = [
  { name: "pink-elephant", match: /^(Don't|Never|Do not) / },
  {
    name: "pink-elephant-mid",
    match: /MUST NOT|\bdo not\b|\bdon't\b|\bnever\b/,
    skip: (text) => COMMENT_LINE.test(text) || text.includes("LOAD-BEARING-SAFETY")
  },
  { name: "issue-number", match: /#[0-9]{1,5}\b|\(#[A-Z]+[0-9]+\)|\[bro #[0-9]+\]/ },
  { name: "memory-path", match: /feedback_[a-z_-]+\.md|~\/\.claude\/projects\// },
  { name: "origin-attribution", match: /caught in|prior incident|regression during|2× during|2x during/i },
  { name: "date", match: /\b20[0-9]{2}-[0-9]{2}-[0-9]{2}\b/ },
  { name: "pr-url", match: /![0-9]+|gitlab\.com\/[^ \t\n\v\f\r]*\/merge_requests\// }
];
function body(text) {
  const lines = text.split("\n");
  const open = lines.indexOf("---");
  if (open === -1) return [];
  const close = lines.indexOf("---", open + 1);
  return close === -1 ? [] : lines.slice(close + 1);
}
function promptAuthorLint(argv2, _env, io2) {
  const file = argv2[0] ?? "";
  if (!isFile2(file)) {
    io2.err(USAGE2);
    return 0;
  }
  const lines = body(readFileSync8(file, "utf8"));
  let out = "";
  for (const { name: name2, match, skip } of CHECKS) {
    lines.forEach((text, i) => {
      if (match.test(text) && !skip?.(text)) out += `[${name2}] ${i + 1}:${text}
`;
    });
  }
  io2.out(out);
  return 0;
}

// src/cli/validation-record-fallback.ts
var USAGE3 = '{"error":"usage","message":"validation-record-fallback <task_id> <attempt_n> <verdict> <feedback> <subagent_session_id> [<findings_json>]"}\n';
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
    io2.out(USAGE3);
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
    const message2 = (bar < 0 ? check : check.slice(bar + 1)).replace(/\n/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    io2.out(`{"error":"${code}","message":"${message2}"}
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
  "assert-sql": assertSql,
  "bro-sqlite-readonly": broSqliteReadonly,
  health,
  integrate,
  "prompt-author-lint": promptAuthorLint,
  "validation-record-fallback": validationRecordFallback
};
var USAGE4 = `usage: cli.js <${Object.keys(SUBCOMMANDS).join("|")}> [args...]
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
  io.out(USAGE4);
} else if (!run) {
  io.err(name === void 0 ? USAGE4 : `cli.js: unknown subcommand '${name}'
${USAGE4}`);
  process.exitCode = 2;
} else {
  void Promise.resolve(run(argv, process.env, io)).then((code) => {
    process.exitCode = code;
  });
}
//# sourceMappingURL=cli.js.map
