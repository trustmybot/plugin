var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err2) => function __init() {
  if (err2) throw err2[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err2 = [e], e;
  }
};
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};

// src/hooks/lib/jq-key-order.ts
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
  const order2 = [...shape.fields.keys()];
  for (const [key, field2] of shape.fields) remember(value[key], field2);
  if (Object.keys(value).some((key, i) => key !== order2[i])) {
    inputOrder.set(value, order2);
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
var INTEGER_LIKE_KEY, inputOrder, anyReordered, isRawJson;
var init_jq_key_order = __esm({
  "src/hooks/lib/jq-key-order.ts"() {
    "use strict";
    INTEGER_LIKE_KEY = /"(?:\d|\\u003\d)+"\s*:/;
    inputOrder = /* @__PURE__ */ new WeakMap();
    anyReordered = false;
    isRawJson = (value) => JSON.isRawJSON?.(value) ?? false;
  }
});

// src/hooks/lib/project-env.ts
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
var TMB_STATE_HOST_DIR, TMB_DB_FILENAME, DEFAULT_PLUGIN_NAME;
var init_project_env = __esm({
  "src/hooks/lib/project-env.ts"() {
    "use strict";
    init_jq_key_order();
    TMB_STATE_HOST_DIR = ".claude";
    TMB_DB_FILENAME = "trajectory.db";
    DEFAULT_PLUGIN_NAME = "tmb";
  }
});

// src/hooks/lib/jq.ts
function jqSurrogateEscapes(json2) {
  if (!ANY_SURROGATE_ESCAPE.test(json2)) return json2;
  return json2.replace(ESCAPE_OR_SURROGATE_PAIR, (escape) => {
    if (LONE_HIGH_SURROGATE_ESCAPE.test(escape)) throw new SyntaxError(`Lone high-surrogate escape ${escape}`);
    return LONE_LOW_SURROGATE_ESCAPE.test(escape) ? "\\ufffd" : escape;
  });
}
function parseJqValue(json2, reviver) {
  return parseKeepingKeyOrder(jqSurrogateEscapes(json2), reviver);
}
function jsonStream(text) {
  const values = [];
  let i = text.startsWith("\uFEFF") ? 1 : 0;
  for (; ; ) {
    while (i < text.length && /[ \t\n\r]/.test(text[i])) i += 1;
    if (i >= text.length) return { values, complete: true };
    const end = valueEnd(text, i);
    if (end < 0) return { values, complete: false };
    try {
      values.push(parseJqValue(text.slice(i, end)));
    } catch {
      return { values, complete: false };
    }
    i = end;
  }
}
function jqCompact(value) {
  return stringifyInOrder(value).replace(/\x7f/g, "\\u007f");
}
var ANY_SURROGATE_ESCAPE, ESCAPE_OR_SURROGATE_PAIR, LONE_HIGH_SURROGATE_ESCAPE, LONE_LOW_SURROGATE_ESCAPE, rawJson;
var init_jq = __esm({
  "src/hooks/lib/jq.ts"() {
    "use strict";
    init_jq_key_order();
    init_project_env();
    ANY_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F]/;
    ESCAPE_OR_SURROGATE_PAIR = /\\(?:u[dD][89abAB][0-9a-fA-F]{2}(?:\\u[dD][c-fC-F][0-9a-fA-F]{2})?|u[dD][c-fC-F][0-9a-fA-F]{2}|[\s\S])/g;
    LONE_HIGH_SURROGATE_ESCAPE = /^\\u[dD][89abAB][0-9a-fA-F]{2}$/;
    LONE_LOW_SURROGATE_ESCAPE = /^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/;
    rawJson = JSON.rawJSON;
  }
});

// src/hooks/lib/deny.ts
function fixedReason(reason, fix) {
  const text = reason.replace(/\s+$/, "");
  return fix === "policy" ? `${text}${POLICY_ENDING}` : `${text}${ALLOWED_FORM}${fix.allowed}`;
}
function preToolUseDeny(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}
function denyJson(reason, fix) {
  return jqCompact(preToolUseDeny(fixedReason(reason, fix)));
}
var ALLOWED_FORM, POLICY_ENDING;
var init_deny = __esm({
  "src/hooks/lib/deny.ts"() {
    "use strict";
    init_jq();
    ALLOWED_FORM = " Allowed form: ";
    POLICY_ENDING = " This is policy: stop and report.";
  }
});

// src/hooks/lib/role.ts
var init_role = __esm({
  "src/hooks/lib/role.ts"() {
    "use strict";
    init_jq();
  }
});

// src/hooks/lib/deadline.ts
import { AsyncLocalStorage } from "node:async_hooks";
function msLeft(at, now2) {
  return Math.max(1, Math.ceil(at - now2()));
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
var MAX_TIMER_MS, scopes;
var init_deadline = __esm({
  "src/hooks/lib/deadline.ts"() {
    "use strict";
    MAX_TIMER_MS = 2 ** 31 - 1;
    scopes = new AsyncLocalStorage();
  }
});

// src/hooks/lib/sqlite-shell.ts
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { performance as performance2 } from "node:perf_hooks";
function isSqliteExperimentalWarning(warning, rest) {
  const message3 = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  const opt = rest[0];
  const type = typeof opt === "string" ? opt : opt !== null && typeof opt === "object" && typeof opt.type === "string" ? opt.type : warning instanceof Error ? warning.name : "";
  return type === "ExperimentalWarning" && /sqlite/i.test(message3);
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
  const err2 = e;
  const ext = err2 && typeof err2.errcode === "number" ? err2.errcode : 1;
  return {
    code: ext & 255 || 1,
    message: err2 && typeof err2.message === "string" ? err2.message : String(e)
  };
}
function withCode(f) {
  return f.code > 1 ? `${f.message} (${f.code})` : f.message;
}
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
var KILLED_CODE, NOT_FOUND_CODE, MAX_BUFFER, nodeSqlite, TOKEN_COLUMN, COMPLETE_TRANS, Killed, ShellSession, QSS_START, BACKSLASH_ESCAPES;
var init_sqlite_shell = __esm({
  "src/hooks/lib/sqlite-shell.ts"() {
    "use strict";
    init_deadline();
    KILLED_CODE = 124;
    NOT_FOUND_CODE = 127;
    MAX_BUFFER = 64 * 1024 * 1024;
    TOKEN_COLUMN = {
      semi: 0,
      ws: 1,
      other: 2,
      explain: 3,
      create: 4,
      temp: 5,
      trigger: 6,
      end: 7
    };
    COMPLETE_TRANS = [
      [1, 0, 2, 3, 4, 2, 2, 2],
      [1, 1, 2, 3, 4, 2, 2, 2],
      [1, 2, 2, 2, 2, 2, 2, 2],
      [1, 3, 3, 2, 4, 2, 2, 2],
      [1, 4, 2, 2, 2, 4, 5, 2],
      [6, 5, 5, 5, 5, 5, 5, 5],
      [6, 6, 5, 5, 5, 5, 5, 7],
      [1, 7, 5, 5, 5, 5, 5, 5]
    ];
    Killed = class extends Error {
    };
    ShellSession = class {
      db;
      deadline;
      parameters = /* @__PURE__ */ new Map();
      busyMs;
      stdout = "";
      stderr = "";
      constructor(db, timeoutMs, killAfterMs) {
        this.db = db;
        this.busyMs = timeoutMs;
        this.deadline = killAfterMs === void 0 ? Infinity : performance2.now() + killAfterMs;
        this.applyTimeout(timeoutMs);
      }
      applyTimeout(ms) {
        this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(ms))}`);
      }
      checkDeadline() {
        if (performance2.now() >= this.deadline) throw new Killed();
      }
      setTimeout(ms) {
        this.busyMs = ms;
        this.applyTimeout(ms);
      }
      beforeStatement() {
        this.checkDeadline();
        if (this.deadline !== Infinity) {
          this.applyTimeout(Math.min(this.busyMs, Math.ceil(this.deadline - performance2.now())));
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
    QSS_START = { wait: "", dark: false, semi: false };
    BACKSLASH_ESCAPES = {
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
  }
});

// src/hooks/lib/db.ts
import { accessSync as accessSync2, closeSync, constants as constants2, existsSync as existsSync2, openSync, readFileSync as readFileSync2, readSync, realpathSync as realpathSync2, statSync as statSync2 } from "node:fs";
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
function repoPathAbs(db, path) {
  if (path.startsWith("/")) return path;
  const root = dbProjectRoot(db);
  return `${root || posixDirname(db)}/${path}`;
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
var GATE_READ_ERROR, DEFAULT_READ_TIMEOUT_MS, SQLITE_RO_TIMEOUT_MS, CANTOPEN, dbPathCache, DB_RETRY_FIX;
var init_db = __esm({
  "src/hooks/lib/db.ts"() {
    "use strict";
    init_project_env();
    init_deny();
    init_jq();
    init_role();
    init_sqlite_shell();
    init_sqlite_shell();
    GATE_READ_ERROR = "__ERR__";
    DEFAULT_READ_TIMEOUT_MS = 1500;
    SQLITE_RO_TIMEOUT_MS = 500;
    CANTOPEN = 14;
    dbPathCache = /* @__PURE__ */ new WeakMap();
    DB_RETRY_FIX = { allowed: "the same call again, once the trajectory DB reads" };
  }
});

// src/platform.ts
import {
  existsSync as existsSync4,
  readdirSync,
  readFileSync as readFileSync3,
  realpathSync as realpathSync3
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  basename,
  dirname,
  isAbsolute as isAbsolute2,
  join as join2,
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
      readFileSync3(join2(root, ".claude-plugin", "plugin.json"), "utf8")
    );
    const name2 = typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : "tmb";
    const version = typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : null;
    return freezePlugin({ root, name: name2, version });
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
  const home = opts?.home ?? homedir();
  const pluginName2 = resolveClaudePluginName(env);
  return resolveClaudeDbPathForPlugin(pluginName2, { env, cwd, home });
}
function resolveClaudeDbPathForPlugin(pluginName2, opts) {
  const { env, cwd, home } = opts;
  const override = env["TRAJECTORY_DB_PATH"];
  if (override && override.trim().length > 0) return override;
  const projectRoot2 = resolveClaudeProjectRoot(env);
  const found = findExistingClaudeDbUp(cwd, pluginName2, { home, env, projectRoot: projectRoot2 });
  if (found) return found;
  return claudeDbLocation(projectRoot2 ?? cwd, pluginName2);
}
function claudeDbLocation(root, pluginName2) {
  return join2(root, CLAUDE_STATE_HOST_DIR, pluginName2, "trajectory.db");
}
function claudeLogDirFor(trajectoryDb, pluginName2) {
  if (trajectoryDb === ":memory:") return join2(tmpdir(), `${pluginName2}-memory-logs`);
  return join2(dirname(trajectoryDb), "logs");
}
function resolveClaudeLogDir(opts) {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();
  const pluginName2 = resolveClaudePluginName(env);
  return claudeLogDirFor(resolveClaudeDbPathForPlugin(pluginName2, { env, cwd, home }), pluginName2);
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
function isStandaloneClaudeDb(dbPath2) {
  return existsSync4(join2(dirname(dbPath2), CLAUDE_STANDALONE_MARKER));
}
function walkClaudeDbs(start, pluginName2, opts) {
  const home = opts?.home ?? homedir();
  const probe = opts?.probe ?? probeClaudeDb;
  const found = [];
  for (let dir = start; dirname(dir) !== dir; dir = dirname(dir)) {
    if (dir === home && start !== home) break;
    const candidate = claudeDbLocation(dir, pluginName2);
    if (!existsSync4(candidate) || probe(candidate) === "stale") continue;
    found.push(candidate);
    if (isStandaloneClaudeDb(candidate)) break;
  }
  return { resolved: found.length === 0 ? null : found[found.length - 1], candidates: found };
}
function claudeProjectRootOfDb(dbPath2) {
  if (!dbPath2 || dbPath2 === ":memory:") return null;
  const hostDir = dirname(dirname(dbPath2));
  return basename(hostDir) === CLAUDE_STATE_HOST_DIR ? dirname(hostDir) : null;
}
function canonicalExisting(path) {
  try {
    return realpathSync3(path);
  } catch {
    return path;
  }
}
function isPathWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute2(rel);
}
function countRows(conn, table) {
  try {
    const row = conn.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id > 0`).get();
    return row === void 0 ? null : Number(row.n);
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
function claudeDbsBelow(root, pluginName2, maxDepth, probe) {
  const found = [];
  let level = [root];
  for (let depth = 1; depth <= maxDepth && level.length > 0; depth += 1) {
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const child = join2(dir, entry.name);
        const candidate = claudeDbLocation(child, pluginName2);
        if (existsSync4(candidate) && isStandaloneClaudeDb(candidate)) continue;
        next.push(child);
        if (existsSync4(candidate) && probe(candidate) !== "stale") found.push(candidate);
      }
    }
    level = next;
  }
  return found;
}
function otherClaudeDbs(dbPath2, opts) {
  const root = claudeProjectRootOfDb(dbPath2);
  if (root === null) return null;
  const pluginName2 = basename(dirname(dbPath2));
  const probe = opts.probe ?? probeClaudeDb;
  const seen = /* @__PURE__ */ new Set([canonicalExisting(dbPath2)]);
  const paths = [];
  const add = (path) => {
    const key = canonicalExisting(path);
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(path);
  };
  if (isPathWithin(canonicalExisting(root), canonicalExisting(opts.sessionDir))) {
    walkClaudeDbs(opts.sessionDir, pluginName2, { home: opts.home, probe }).candidates.forEach(add);
  }
  claudeDbsBelow(root, pluginName2, STRAY_DB_MAX_DEPTH, probe).forEach(add);
  return paths.map((path) => {
    const { issues, tasks } = claudeDbCounts(path);
    return { path, issues, tasks, empty: issues === 0 && tasks === 0 };
  });
}
function findExistingClaudeDbUp(startDir, pluginName2, opts) {
  const env = opts?.env ?? process.env;
  const override = env["TRAJECTORY_DB_PATH"];
  if (override && override.trim().length > 0) {
    return existsSync4(override) ? override : null;
  }
  const projectRoot2 = opts?.projectRoot !== void 0 ? opts.projectRoot : resolveClaudeProjectRoot(env);
  return walkClaudeDbs(projectRoot2 ?? startDir, pluginName2, opts).resolved;
}
function freezePlugin(plugin) {
  return Object.freeze(plugin);
}
var CLAUDE_STATE_HOST_DIR, CLAUDE_STANDALONE_MARKER, STRAY_DB_MAX_DEPTH;
var init_platform = __esm({
  "src/platform.ts"() {
    "use strict";
    CLAUDE_STATE_HOST_DIR = ".claude";
    CLAUDE_STANDALONE_MARKER = "standalone";
    STRAY_DB_MAX_DEPTH = 4;
  }
});

// src/logger.ts
import {
  appendFileSync,
  closeSync as closeSync3,
  constants as constants3,
  lstatSync,
  mkdirSync,
  openSync as openSync3
} from "node:fs";
import { join as join3 } from "node:path";
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
  const serverLogPath = join3(opts.logDir, "mcp-server.log");
  const sqlLogPath = join3(opts.logDir, "sql.log");
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
var defaultLogger;
var init_logger = __esm({
  "src/logger.ts"() {
    "use strict";
    init_platform();
    defaultLogger = null;
  }
});

// src/audit-events.ts
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
var AUDIT_EVENT_TYPES, KNOWN, WRITERS;
var init_audit_events = __esm({
  "src/audit-events.ts"() {
    "use strict";
    AUDIT_EVENT_TYPES = [
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
    KNOWN = new Set(AUDIT_EVENT_TYPES.map((e) => e.type));
    WRITERS = new Map(AUDIT_EVENT_TYPES.map((e) => [e.type, e.writers]));
  }
});

// src/utils/classify-url.ts
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
var init_classify_url = __esm({
  "src/utils/classify-url.ts"() {
    "use strict";
  }
});

// src/repos/remotes.ts
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
    entries = Object.entries(parsed).map(([name2, url]) => ({ name: name2, url, provider: void 0 }));
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
    const name2 = typeof e.name === "string" && e.name.trim() !== "" ? e.name.trim() : i === 0 ? "origin" : `remote-${i}`;
    if (seen.has(name2)) {
      dropped++;
      return;
    }
    seen.add(name2);
    remotes.push({ name: name2, url: e.url.trim(), provider: typeof e.provider === "string" ? e.provider : null });
  });
  return { ok: true, entries: remotes, dropped };
}
var init_remotes = __esm({
  "src/repos/remotes.ts"() {
    "use strict";
    init_classify_url();
  }
});

// src/utils/test-paths.ts
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
var TEST_SEGMENTS, TEST_BASENAMES;
var init_test_paths = __esm({
  "src/utils/test-paths.ts"() {
    "use strict";
    TEST_SEGMENTS = /* @__PURE__ */ new Set(["test", "tests", "__tests__", "spec", "e2e", "fixtures"]);
    TEST_BASENAMES = [
      /\.(?:test|spec|suite)\./,
      /_test\.go$/,
      /^test_.*\.py$/,
      /_test\.py$/,
      /_spec\.rb$/,
      /^conftest\.py$/
    ];
  }
});

// src/db.ts
var db_exports = {};
__export(db_exports, {
  TARGET_SCHEMA_VERSION: () => TARGET_SCHEMA_VERSION,
  TrajectoryDB: () => TrajectoryDB,
  nowISO: () => nowISO,
  resolveDbPath: () => resolveDbPath,
  resolvePluginName: () => resolvePluginName,
  resolvePluginVersion: () => resolvePluginVersion,
  resolveRepoByPath: () => resolveRepoByPath
});
import { readFileSync as readFileSync4, readdirSync as readdirSync2 } from "node:fs";
import { basename as basename2, join as join4, dirname as dirname2 } from "node:path";
import { fileURLToPath } from "node:url";
import { performance as performance3 } from "node:perf_hooks";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
function resolvePluginName(env = process.env) {
  return resolveClaudePluginName(env);
}
function resolvePluginVersion(env = process.env) {
  return resolveClaudePluginVersion(env);
}
function resolveDbPath(opts) {
  return resolveClaudeDbPath(opts);
}
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
function resolveRepoByPath(db, gitRoot) {
  const row = db.get(
    `SELECT * FROM repos WHERE path = ? LIMIT 1`,
    [gitRoot]
  );
  return row ?? null;
}
function isBusyError(err2) {
  if (!(err2 instanceof Error)) return false;
  const errcode = err2.errcode;
  return typeof errcode === "number" && (errcode & 255) === SQLITE_BUSY || err2.message.includes("database is locked");
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
  const deadline = performance3.now() + BUSY_TIMEOUT_MS;
  for (; ; ) {
    try {
      db.exec(sql);
      return;
    } catch (err2) {
      if (!isBusyError(err2) || performance3.now() >= deadline) throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
function backupDbBeforeMigration(dbPath2, targetVersion) {
  if (!dbPath2 || dbPath2 === ":memory:") return;
  const dir = dirname2(dbPath2);
  const base = basename2(dbPath2);
  const prefix = `${base}.pre-v${targetVersion}.`;
  try {
    const existing = readdirSync2(dir).some(
      (f) => f.startsWith(prefix) && f.endsWith(".bak")
    );
    if (existing) return;
  } catch {
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath2}.pre-v${targetVersion}.${timestamp}.bak`;
  const snapshot2 = new DatabaseSync2(dbPath2);
  try {
    snapshot2.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    snapshot2.prepare("VACUUM INTO ?").run(backupPath);
  } finally {
    snapshot2.close();
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
function deleteBuiltinCheatcodeAttachments(db, name2) {
  if (!tableExists(db, "cheatcode_attachments")) return;
  db.prepare(
    // LINT-ALLOW: mirrors the ON DELETE CASCADE that foreign_keys OFF suppresses during migration (GH 1624).
    `DELETE FROM cheatcode_attachments
      WHERE cheatcode_id IN (SELECT id FROM cheatcodes WHERE name = ? AND origin = 'builtin')`
  ).run(name2);
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
  const select = columns.map(([name2, fallback]) => hasColumn(db, table, name2) ? name2 : `${fallback} AS ${name2}`).join(", ");
  const seqRow = tableExists(db, "sqlite_sequence") ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) : void 0;
  db.exec(`DROP TABLE IF EXISTS ${scratch}`);
  db.exec(`CREATE TABLE ${scratch} (${createBody})`);
  db.exec(
    `INSERT INTO ${scratch} (${columns.map(([name2]) => name2).join(", ")}) SELECT ${select} FROM ${table}`
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
function migrateV14toV15(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "cheatcodes") && !hasColumn(db, "cheatcodes", "scope")) {
      db.exec("ALTER TABLE cheatcodes ADD COLUMN scope TEXT NOT NULL DEFAULT 'local'");
    }
    commitTransaction(db);
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
function migrateV15toV16(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS rule_invocations");
    db.exec("DROP TABLE IF EXISTS rules");
    commitTransaction(db);
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
function migrateV16toV17(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS commands");
    commitTransaction(db);
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
function migrateV58toV59(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs") && !hasColumn(db, "agent_runs", "hook_block_tokens")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN hook_block_tokens INTEGER");
    }
    commitTransaction(db);
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
function migrateV62toV63(db) {
  beginImmediate(db);
  try {
    db.exec(WM_FRESHNESS_DDL);
    commitTransaction(db);
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
function migrateV63toV64(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "wm_directories") && !hasColumn(db, "wm_directories", "readme_review_pending")) {
      db.exec("ALTER TABLE wm_directories ADD COLUMN readme_review_pending INTEGER NOT NULL DEFAULT 0");
    }
    commitTransaction(db);
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
function migrateV64toV65(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "validation_attempts") && !hasColumn(db, "validation_attempts", "reviewed_sha")) {
      db.exec("ALTER TABLE validation_attempts ADD COLUMN reviewed_sha TEXT");
    }
    commitTransaction(db);
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
function migrateV67toV68(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "validation_attempts") && !hasColumn(db, "validation_attempts", "probes_json")) {
      db.exec("ALTER TABLE validation_attempts ADD COLUMN probes_json TEXT");
    }
    commitTransaction(db);
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
function migrateV71toV72(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "tasks") && !hasColumn(db, "tasks", "no_code_class")) {
      db.exec("ALTER TABLE tasks ADD COLUMN no_code_class TEXT CHECK (no_code_class IS NULL OR no_code_class IN ('docs','prompts'))");
    }
    commitTransaction(db);
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
      const issueCol = (name2, expr = name2) => hasColumn(db, "issues", name2) ? expr : `NULL AS ${name2}`;
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
      const taskCol = (name2, fallback) => hasColumn(db, "tasks", name2) ? name2 : `${fallback} AS ${name2}`;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
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
      const stale = [
        "size_bytes",
        "last_commit_sha",
        "language",
        "last_change_type",
        "last_change_at",
        "imports_json",
        "exports_json",
        "metadata_json"
      ];
      const hasStale = stale.some((c) => hasColumn(db, "file_registry", c));
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
  } catch (err2) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err2;
  }
}
var TARGET_SCHEMA_VERSION, BUSY_TIMEOUT_MS, TrajectoryDB, transactionDepth, SQLITE_BUSY, backoffCell, ISO_NOW_DEFAULT, TIMESTAMP_COLUMNS, OWN_MCP_SERVER_NAME, ISO_NOW_SQL, OLD_REVIEWER, OLD_REVIEWER_TITLE, REVIEWER, REVIEWER_JSON_RENAMES, WM_FRESHNESS_DDL;
var init_db2 = __esm({
  "src/db.ts"() {
    "use strict";
    init_logger();
    init_platform();
    init_audit_events();
    init_remotes();
    init_test_paths();
    TARGET_SCHEMA_VERSION = 72;
    BUSY_TIMEOUT_MS = 5e3;
    TrajectoryDB = class {
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
      constructor(dbPath2, dependencies, options = {}) {
        const resolvedDependencies = resolveDependencies(dependencies);
        this.dbPath = dbPath2;
        this.pluginVersion = resolvedDependencies.pluginVersion;
        this.serverLog = resolvedDependencies.serverLog;
        this.sqlLog = resolvedDependencies.sqlLog;
        this.migrate = options.migrate === true;
        this.db = new DatabaseSync2(dbPath2);
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
        const sql = readFileSync4(join4(schemaDir, "schema.sql"), "utf8");
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
            const evalSql = readFileSync4(join4(schemaDir, "schema-eval.sql"), "utf8");
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
        } catch (err2) {
          this.serverLog({
            kind: "plugin_version_sync_failed",
            level: "error",
            db_path: this.dbPath,
            target,
            plugin_version: this.pluginVersion,
            message: err2 instanceof Error ? err2.message : String(err2)
          });
          throw err2;
        }
      }
      run(sql, params) {
        const start = performance3.now();
        try {
          const stmt = this.db.prepare(sql);
          const result = stmt.run(...params ?? []);
          const out = { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
          this.sqlLog({
            kind: "run",
            sql,
            params: params ?? [],
            duration_ms: Math.round(performance3.now() - start),
            rows_affected: out.changes,
            ok: true
          });
          return out;
        } catch (err2) {
          this.sqlLog({
            kind: "run",
            sql,
            params: params ?? [],
            duration_ms: Math.round(performance3.now() - start),
            ok: false,
            error_message: err2 instanceof Error ? err2.message : String(err2)
          });
          throw err2;
        }
      }
      get(sql, params) {
        const start = performance3.now();
        try {
          const stmt = this.db.prepare(sql);
          const row = stmt.get(...params ?? []);
          this.sqlLog({
            kind: "get",
            sql,
            params: params ?? [],
            duration_ms: Math.round(performance3.now() - start),
            row_count: row === void 0 ? 0 : 1,
            ok: true
          });
          return row;
        } catch (err2) {
          this.sqlLog({
            kind: "get",
            sql,
            params: params ?? [],
            duration_ms: Math.round(performance3.now() - start),
            ok: false,
            error_message: err2 instanceof Error ? err2.message : String(err2)
          });
          throw err2;
        }
      }
      all(sql, params) {
        const start = performance3.now();
        try {
          const stmt = this.db.prepare(sql);
          const rows = stmt.all(...params ?? []);
          this.sqlLog({
            kind: "all",
            sql,
            params: params ?? [],
            duration_ms: Math.round(performance3.now() - start),
            row_count: rows.length,
            ok: true
          });
          return rows;
        } catch (err2) {
          this.sqlLog({
            kind: "all",
            sql,
            params: params ?? [],
            duration_ms: Math.round(performance3.now() - start),
            ok: false,
            error_message: err2 instanceof Error ? err2.message : String(err2)
          });
          throw err2;
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
    transactionDepth = /* @__PURE__ */ new WeakMap();
    SQLITE_BUSY = 5;
    backoffCell = new Int32Array(new SharedArrayBuffer(4));
    ISO_NOW_DEFAULT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
    TIMESTAMP_COLUMNS = [
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
    OWN_MCP_SERVER_NAME = "trajectory-server";
    ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
    OLD_REVIEWER = "pr-reviewer";
    OLD_REVIEWER_TITLE = "PR-reviewer";
    REVIEWER = "code-reviewer";
    REVIEWER_JSON_RENAMES = {
      [OLD_REVIEWER]: REVIEWER,
      [`tmb:${OLD_REVIEWER}`]: `tmb:${REVIEWER}`
    };
    WM_FRESHNESS_DDL = `CREATE TABLE IF NOT EXISTS wm_freshness (
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
  }
});

// src/middleware/agent-scope.ts
function normalizeAgent(name2) {
  if (typeof name2 !== "string") return "unknown";
  const lower = name2.toLowerCase().replace(/^tmb:/, "");
  if (!lower) return "unknown";
  if (FIRST_CLASS_ROLES.has(lower)) return lower;
  if (/^[a-z][a-z0-9_-]*$/.test(lower)) return "consultant";
  return "unknown";
}
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
var FIRST_CLASS_ROLES, VALID_AGENTS, gatedRoles;
var init_agent_scope = __esm({
  "src/middleware/agent-scope.ts"() {
    "use strict";
    FIRST_CLASS_ROLES = /* @__PURE__ */ new Set(["bro", "swe", "code-reviewer"]);
    VALID_AGENTS = ["bro", "swe", "code-reviewer", "consultant slug matching ^[a-z][a-z0-9_-]*$"];
    gatedRoles = /* @__PURE__ */ new WeakMap();
  }
});

// src/runtime-deps.ts
import { existsSync as existsSync5, readFileSync as readFileSync5 } from "node:fs";
import { join as join5, resolve } from "node:path";
function runtimeDepsKey(platform = process.platform, arch = process.arch, version = TRANSFORMERS_VERSION) {
  return `${version}-${platform}-${arch}`;
}
function runtimeDepsRoot(dataDir = process.env.CLAUDE_PLUGIN_DATA, key = runtimeDepsKey()) {
  return dataDir ? join5(dataDir, "deps", key) : void 0;
}
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function readPackageJson(pkgDir) {
  try {
    const parsed = JSON.parse(readFileSync5(join5(pkgDir, "package.json"), "utf8"));
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
  return join5(root, "node_modules", TRANSFORMERS_PACKAGE);
}
function transformersEsmEntry(root) {
  const pkgDir = transformersPackageDir(root);
  const target = nodeImportDefault(rootExport(readPackageJson(pkgDir)?.["exports"]));
  if (!target) return void 0;
  const entry = resolve(pkgDir, target);
  return existsSync5(entry) ? entry : void 0;
}
var TRANSFORMERS_VERSION, TRANSFORMERS_PACKAGE;
var init_runtime_deps = __esm({
  "src/runtime-deps.ts"() {
    "use strict";
    TRANSFORMERS_VERSION = "3.8.1";
    TRANSFORMERS_PACKAGE = "@huggingface/transformers";
  }
});

// src/embeddings/model.ts
import { homedir as homedir2 } from "node:os";
import { join as join6 } from "node:path";
import { pathToFileURL } from "node:url";
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
      failures.push(`${specifier}: ${message2(e)}`);
    }
  }
  throw new Error(`${TRANSFORMERS_PACKAGE} did not load (${failures.join("; ")})`);
}
async function defaultLoader() {
  const { pipeline, env } = await importTransformers();
  env.cacheDir = TMB_MODEL_CACHE_DIR;
  return await pipeline("feature-extraction", MODEL_REPO, { dtype: MODEL_DTYPE });
}
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
function message2(e) {
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
    d.reason = `re-attempt failed: ${message2(e)}`;
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
    enterDegraded(`model load failed: ${message2(e)}`);
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
      enterDegraded(`${consecutiveFailures} consecutive embed failures: ${message2(e)}`);
    }
    return null;
  }
}
function embeddingStatus() {
  if (degraded) {
    return {
      state: "degraded",
      since: degraded.since,
      reason: degraded.reason,
      consecutive_failures: consecutiveFailures,
      ...retrying ? {} : { next_retry_at: new Date(degraded.nextRetryAt).toISOString() }
    };
  }
  if (readySince) return { state: "ready", since: readySince, consecutive_failures: consecutiveFailures };
  if (pipePromise) return { state: "loading", since: loadingSince ?? void 0, consecutive_failures: consecutiveFailures };
  return { state: "disabled", consecutive_failures: consecutiveFailures };
}
var TMB_MODEL_CACHE_DIR, MODEL_REPO, MODEL_DTYPE, MODEL_ID, EMBED_RETRY_SCHEDULE_MS, EMBED_FAIL_THRESHOLD_DEFAULT, now, loader, pipePromise, loadingSince, readySince, consecutiveFailures, degraded, retrying, listeners;
var init_model = __esm({
  "src/embeddings/model.ts"() {
    "use strict";
    init_runtime_deps();
    TMB_MODEL_CACHE_DIR = process.env["TMB_MODEL_CACHE_DIR"] ?? process.env["HF_HOME"] ?? join6(homedir2(), ".cache", "huggingface");
    MODEL_REPO = "Xenova/bge-small-en-v1.5";
    MODEL_DTYPE = "q8";
    MODEL_ID = `${MODEL_REPO}@${MODEL_DTYPE}`;
    EMBED_RETRY_SCHEDULE_MS = [6e4, 3e5, 6e5];
    EMBED_FAIL_THRESHOLD_DEFAULT = 5;
    now = Date.now;
    loader = defaultLoader;
    pipePromise = null;
    loadingSince = null;
    readySince = null;
    consecutiveFailures = 0;
    degraded = null;
    retrying = false;
    listeners = /* @__PURE__ */ new Set();
  }
});

// src/embeddings/store.ts
function packEmbedding(v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function auditEmbedText(summary, contentJson) {
  return contentJson && contentJson !== "{}" ? `${summary} ${contentJson}` : summary;
}
async function embedAndStore(db, table, rowid, text) {
  const v = await embed(text);
  if (v === null || !db.isOpen) return;
  const sql = INSERT_SQL[table];
  db.run(sql, [rowid, packEmbedding(v), MODEL_ID, (/* @__PURE__ */ new Date()).toISOString()]);
}
var INSERT_SQL;
var init_store = __esm({
  "src/embeddings/store.ts"() {
    "use strict";
    init_model();
    INSERT_SQL = {
      discussions: "INSERT OR REPLACE INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)",
      audit: "INSERT OR REPLACE INTO audit_embeddings (audit_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)",
      wm_directories: "INSERT OR REPLACE INTO wm_directories_embeddings (dir_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)",
      wm_files: "INSERT OR REPLACE INTO wm_files_embeddings (file_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)"
    };
  }
});

// src/hooks/gate.ts
var ALLOW;
var init_gate = __esm({
  "src/hooks/gate.ts"() {
    "use strict";
    ALLOW = Object.freeze({ stdout: "", code: 0 });
  }
});

// src/hooks/ensure-mcp-deps-installed.ts
import { basename as basename3, delimiter, dirname as dirname3, isAbsolute as isAbsolute3, join as join7, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";
var MCP_REL, STAGING_STALE_MS;
var init_ensure_mcp_deps_installed = __esm({
  "src/hooks/ensure-mcp-deps-installed.ts"() {
    "use strict";
    init_gate();
    init_runtime_deps();
    MCP_REL = join7("mcp", "trajectory-server");
    STAGING_STALE_MS = 60 * 60 * 1e3;
  }
});

// src/embeddings/backfill.ts
var MISSING_WHERE, MISSING_SQL;
var init_backfill = __esm({
  "src/embeddings/backfill.ts"() {
    "use strict";
    init_ensure_mcp_deps_installed();
    init_store();
    init_model();
    init_logger();
    MISSING_WHERE = {
      discussions: "id NOT IN (SELECT discussion_id FROM discussions_embeddings WHERE model_id = ?)",
      audit: "id NOT IN (SELECT audit_id FROM audit_embeddings WHERE model_id = ?)",
      wm_directories: "id NOT IN (SELECT dir_id FROM wm_directories_embeddings WHERE model_id = ?)",
      wm_files: "purpose <> '' AND id NOT IN (SELECT file_id FROM wm_files_embeddings WHERE model_id = ?)"
    };
    MISSING_SQL = {
      discussions: `SELECT id, body AS text FROM discussions WHERE ${MISSING_WHERE.discussions} ORDER BY id DESC LIMIT ?`,
      audit: `SELECT id, summary AS text, content_json FROM audit WHERE ${MISSING_WHERE.audit} ORDER BY id DESC LIMIT ?`,
      wm_directories: `SELECT id, CASE WHEN path = '' THEN repo ELSE path END AS text, summary AS body FROM wm_directories WHERE ${MISSING_WHERE.wm_directories} ORDER BY id DESC LIMIT ?`,
      wm_files: `SELECT id, path AS text, purpose AS body FROM wm_files WHERE ${MISSING_WHERE.wm_files} ORDER BY id DESC LIMIT ?`
    };
  }
});

// src/fts-query.ts
var init_fts_query = __esm({
  "src/fts-query.ts"() {
    "use strict";
  }
});

// src/tools/audit.ts
function resolveIssueRepo(db, issueId) {
  return db.get("SELECT repo FROM issues WHERE id = ?", [issueId])?.repo ?? null;
}
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
var AuditWriterError;
var init_audit = __esm({
  "src/tools/audit.ts"() {
    "use strict";
    init_db2();
    init_agent_scope();
    init_store();
    init_backfill();
    init_fts_query();
    init_audit_events();
    AuditWriterError = class extends Error {
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
  }
});

// src/tools/containment.ts
import { isAbsolute as isAbsolute4, join as join8, parse, relative as relative3, sep as sep3 } from "node:path";
function projectRootFromDbPath(dbPath2) {
  if (!dbPath2 || dbPath2 === ":memory:") return null;
  const segments = dbPath2.split(sep3);
  const idx = segments.lastIndexOf(".claude");
  if (idx <= 0) return null;
  return segments.slice(0, idx).join(sep3) || sep3;
}
var init_containment = __esm({
  "src/tools/containment.ts"() {
    "use strict";
  }
});

// src/tools/agent-runs.ts
var SWE_ORPHAN_AFTER_MS, NO_USAGE_SQL, UNMEASURED_IF_NO_USAGE_SQL;
var init_agent_runs = __esm({
  "src/tools/agent-runs.ts"() {
    "use strict";
    init_containment();
    SWE_ORPHAN_AFTER_MS = 10 * 60 * 1e3;
    NO_USAGE_SQL = "COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0 AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0";
    UNMEASURED_IF_NO_USAGE_SQL = `usage_source = COALESCE(usage_source, CASE WHEN ${NO_USAGE_SQL} THEN 'unmeasured' END)`;
  }
});

// src/review-sql.ts
function newestVerdictPassSql(alias) {
  return `COALESCE((SELECT v.verdict FROM validation_attempts v WHERE v.task_id = ${alias}.id ORDER BY v.id DESC LIMIT 1), '') = 'pass'`;
}
var LEGACY_CHAIN_HOPS, jsonSql, integrateRowSql, carriesAnchorSql, legacyIntegrateSql, LEGACY_CHAIN_ANCHOR_SQL, REVIEW_ANCHOR_AT_SQL, HAS_PASS_SQL, reviewSkipAuthoredSql, GATE_SKIP_RECORDED_SQL;
var init_review_sql = __esm({
  "src/review-sql.ts"() {
    "use strict";
    LEGACY_CHAIN_HOPS = 10;
    jsonSql = (fn, alias, path) => `CASE WHEN json_valid(${alias}.content_json) THEN ${fn}(${alias}.content_json, '${path}') END`;
    integrateRowSql = (alias) => `${alias}.event_type = 'task_integrated' AND ${alias}.from_node = 'hook:integrate'`;
    carriesAnchorSql = (alias) => `${integrateRowSql(alias)} AND ${jsonSql("json_type", alias, "$.review_anchor_at")} = 'text'`;
    legacyIntegrateSql = (alias) => `${integrateRowSql(alias)} AND ${jsonSql("json_type", alias, "$.review_anchor_at")} IS NOT 'text'
          AND ${jsonSql("json_type", alias, "$.reviewed_sha")} = 'text'`;
    LEGACY_CHAIN_ANCHOR_SQL = `(WITH RECURSIVE chain(sha, hops) AS (
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
    REVIEW_ANCHOR_AT_SQL = `(SELECT MIN(CASE
      WHEN ${carriesAnchorSql("a")}
      THEN json_extract(a.content_json, '$.review_anchor_at')
      WHEN ${legacyIntegrateSql("a")}
      THEN COALESCE(${LEGACY_CHAIN_ANCHOR_SQL}, a.created_at)
      ELSE a.created_at END) FROM audit a
    WHERE a.event_type IN ('review_handoff', 'bro_verification_pass', 'task_integrated') AND json_valid(a.content_json)
      AND json_extract(a.content_json, '$.task_id') = t.id
      AND json_extract(a.content_json, '$.commit_sha') = t.commit_sha)`;
    HAS_PASS_SQL = `(EXISTS (SELECT 1 FROM validation_attempts va
  WHERE va.task_id = t.id AND va.verdict = 'pass' AND va.created_at >= ${REVIEW_ANCHOR_AT_SQL})
  AND ${newestVerdictPassSql("t")})`;
    reviewSkipAuthoredSql = (alias) => `((${alias}.event_type = 'review_gate_waived' AND ${alias}.from_node = 'bro')
      OR (${alias}.event_type = 'review_gate_bypassed' AND ${alias}.from_node IN ('bro', 'hook:close-issue-on-merge')))`;
    GATE_SKIP_RECORDED_SQL = `EXISTS (SELECT 1 FROM audit g
  WHERE ${reviewSkipAuthoredSql("g")}
    AND json_valid(g.content_json)
    AND json_extract(g.content_json, '$.task_id') = t.id
    AND COALESCE(json_extract(g.content_json, '$.commit_sha'), '') = COALESCE(t.commit_sha, ''))`;
  }
});

// src/tools/lifecycle.ts
var LIVE_TASK_STATUSES, LIVE_IN, STALE_RUNNING_HOURS_DEFAULT;
var init_lifecycle = __esm({
  "src/tools/lifecycle.ts"() {
    "use strict";
    init_audit();
    init_agent_runs();
    init_review_sql();
    LIVE_TASK_STATUSES = ["pending", "running", "needs_validation", "completed"];
    LIVE_IN = LIVE_TASK_STATUSES.map((s) => `'${s}'`).join(", ");
    STALE_RUNNING_HOURS_DEFAULT = 6;
  }
});

// src/utils/timeouts.ts
var SUBPROCESS_TIMEOUT_MS, WORKTREE_SETUP_COMMAND_TIMEOUT_MS, WORKTREE_DEPS_INSTALL_TIMEOUT_MS;
var init_timeouts = __esm({
  "src/utils/timeouts.ts"() {
    "use strict";
    SUBPROCESS_TIMEOUT_MS = 5e3;
    WORKTREE_SETUP_COMMAND_TIMEOUT_MS = 10 * 60 * 1e3;
    WORKTREE_DEPS_INSTALL_TIMEOUT_MS = 10 * 60 * 1e3;
  }
});

// src/utils/git-run.ts
var init_git_run = __esm({
  "src/utils/git-run.ts"() {
    "use strict";
    init_timeouts();
  }
});

// src/utils/git-refs.ts
var init_git_refs = __esm({
  "src/utils/git-refs.ts"() {
    "use strict";
    init_timeouts();
    init_git_run();
  }
});

// src/utils/repo-paths.ts
import { dirname as dirname4, isAbsolute as isAbsolute5, resolve as resolve3 } from "node:path";
function repoRowPath(db, path) {
  if (isAbsolute5(path)) return path;
  const base = db.dbPath === ":memory:" ? process.cwd() : projectRootFromDbPath(db.dbPath) ?? dirname4(db.dbPath);
  return resolve3(base, path);
}
function resolveSoleRepo(db, name2) {
  if (name2) {
    const repoRow = db.get(
      `SELECT path FROM repos WHERE name = ?`,
      [name2]
    );
    return repoRow?.path ? { name: name2, path: repoRowPath(db, repoRow.path) } : void 0;
  }
  const repos = db.all(
    `SELECT name, path FROM repos`
  );
  return repos.length === 1 ? { name: repos[0].name, path: repoRowPath(db, repos[0].path) } : void 0;
}
var init_repo_paths = __esm({
  "src/utils/repo-paths.ts"() {
    "use strict";
    init_containment();
    init_git_refs();
  }
});

// src/tools/config.ts
var SWE_DEFAULT_EFFORT_KEY, REVIEWER_EFFORT_KEY, EFFORT_DEFAULTS;
var init_config = __esm({
  "src/tools/config.ts"() {
    "use strict";
    init_agent_scope();
    init_audit();
    init_test_paths();
    SWE_DEFAULT_EFFORT_KEY = "swe_default_effort";
    REVIEWER_EFFORT_KEY = "reviewer_effort";
    EFFORT_DEFAULTS = {
      [SWE_DEFAULT_EFFORT_KEY]: "medium",
      [REVIEWER_EFFORT_KEY]: "medium"
    };
  }
});

// src/task-rework.ts
var init_task_rework = __esm({
  "src/task-rework.ts"() {
    "use strict";
  }
});

// src/tools/stats.ts
var init_stats = __esm({
  "src/tools/stats.ts"() {
    "use strict";
    init_agent_scope();
    init_task_rework();
  }
});

// src/effort-ab-report.ts
var init_effort_ab_report = __esm({
  "src/effort-ab-report.ts"() {
    "use strict";
    init_stats();
  }
});

// src/effort-ab.ts
var init_effort_ab = __esm({
  "src/effort-ab.ts"() {
    "use strict";
    init_config();
    init_audit();
    init_effort_ab_report();
  }
});

// src/parsing/loader.ts
var init_loader = __esm({
  "src/parsing/loader.ts"() {
    "use strict";
  }
});

// src/parsing/extract.ts
var SH_BUILTINS, STOPWORDS;
var init_extract = __esm({
  "src/parsing/extract.ts"() {
    "use strict";
    init_test_paths();
    SH_BUILTINS = new Set(
      "echo printf local export declare readonly return exit set unset shift cd test [ [[ true false read eval exec trap wait source . if then else fi for do done while case esac cat grep sed awk tr cut head tail sort uniq wc mkdir rm cp mv ln chmod touch date sleep command type jq git basename dirname xargs find tee env mktemp pwd kill ps sqlite3 node bash sh python3 curl gh".split(
        " "
      )
    );
    STOPWORDS = new Set(
      "a an the and or of to in on for with by is are was were be been when where what which who how why does do did it its this that these those from as at into per not no than then there their them our we you i set get".split(
        " "
      )
    );
  }
});

// src/hooks/router/table.ts
var init_table = __esm({
  "src/hooks/router/table.ts"() {
    "use strict";
  }
});

// src/parsing/hooks.ts
var init_hooks = __esm({
  "src/parsing/hooks.ts"() {
    "use strict";
    init_table();
    init_extract();
  }
});

// src/parsing/runners.ts
var init_runners = __esm({
  "src/parsing/runners.ts"() {
    "use strict";
    init_extract();
  }
});

// src/env/text.ts
var init_text = __esm({
  "src/env/text.ts"() {
    "use strict";
  }
});

// src/env/readers/cargo-toml.ts
var init_cargo_toml = __esm({
  "src/env/readers/cargo-toml.ts"() {
    "use strict";
    init_text();
  }
});

// src/env/yaml.ts
var init_yaml = __esm({
  "src/env/yaml.ts"() {
    "use strict";
    init_text();
  }
});

// src/env/readers/ci.ts
var init_ci = __esm({
  "src/env/readers/ci.ts"() {
    "use strict";
    init_text();
    init_yaml();
  }
});

// src/env/readers/go-mod.ts
var init_go_mod = __esm({
  "src/env/readers/go-mod.ts"() {
    "use strict";
    init_text();
  }
});

// src/env/readers/make.ts
var init_make = __esm({
  "src/env/readers/make.ts"() {
    "use strict";
    init_text();
    init_yaml();
  }
});

// src/env/readers/package-json.ts
var init_package_json = __esm({
  "src/env/readers/package-json.ts"() {
    "use strict";
    init_text();
  }
});

// src/env/readers/pyproject.ts
var init_pyproject = __esm({
  "src/env/readers/pyproject.ts"() {
    "use strict";
    init_text();
  }
});

// src/env/collect.ts
var init_collect = __esm({
  "src/env/collect.ts"() {
    "use strict";
    init_cargo_toml();
    init_ci();
    init_go_mod();
    init_make();
    init_package_json();
    init_pyproject();
  }
});

// src/symbol-index.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var EXTRACTOR_VERSION, execFileAsync, FAILED_SUFFIX, TABLE_EDGES, TABLE_EDGES_JSON, NAME_ONLY_EDGES, NAME_ONLY_JSON;
var init_symbol_index = __esm({
  "src/symbol-index.ts"() {
    "use strict";
    init_loader();
    init_extract();
    init_hooks();
    init_runners();
    init_collect();
    init_test_paths();
    EXTRACTOR_VERSION = 16;
    execFileAsync = promisify(execFile);
    FAILED_SUFFIX = ":failed";
    TABLE_EDGES = /* @__PURE__ */ new Set(["reads_table", "writes_table", "indexes", "triggers_on"]);
    TABLE_EDGES_JSON = JSON.stringify([...TABLE_EDGES]);
    NAME_ONLY_EDGES = /* @__PURE__ */ new Set(["reads_config", "covers"]);
    NAME_ONLY_JSON = JSON.stringify([...NAME_ONLY_EDGES]);
  }
});

// src/utils/untrusted.ts
var init_untrusted = __esm({
  "src/utils/untrusted.ts"() {
    "use strict";
  }
});

// src/brief-locations.ts
var init_brief_locations = __esm({
  "src/brief-locations.ts"() {
    "use strict";
    init_symbol_index();
    init_test_paths();
    init_untrusted();
  }
});

// src/effort-inputs.ts
var init_effort_inputs = __esm({
  "src/effort-inputs.ts"() {
    "use strict";
    init_brief_locations();
    init_symbol_index();
    init_config();
    init_audit();
    init_repo_paths();
    init_test_paths();
    init_effort_ab_report();
  }
});

// src/commit-subject.ts
var TYPES, PICTOGRAPH, EMOJI, SUBJECT_RE;
var init_commit_subject = __esm({
  "src/commit-subject.ts"() {
    "use strict";
    TYPES = "feat|fix|improvement|refactor|docs|test|perf|chore|build|ci|style|revert|research";
    PICTOGRAPH = String.raw`\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?`;
    EMOJI = String.raw`(?::[a-z0-9_+-]+:|${PICTOGRAPH}(?:\u{200D}${PICTOGRAPH})*)`;
    SUBJECT_RE = new RegExp(`^${EMOJI} (?:${TYPES})(?:\\([a-z0-9._/-]+\\))?: \\S`, "u");
  }
});

// src/success-criteria.ts
var init_success_criteria = __esm({
  "src/success-criteria.ts"() {
    "use strict";
    init_commit_subject();
  }
});

// src/checkpoint.ts
var init_checkpoint = __esm({
  "src/checkpoint.ts"() {
    "use strict";
  }
});

// src/tools/discussions.ts
var init_discussions = __esm({
  "src/tools/discussions.ts"() {
    "use strict";
    init_db2();
    init_agent_scope();
    init_store();
    init_backfill();
    init_audit();
    init_fts_query();
  }
});

// src/tools/reopen.ts
var init_reopen = __esm({
  "src/tools/reopen.ts"() {
    "use strict";
    init_task_rework();
    init_audit();
    init_config();
    init_discussions();
  }
});

// src/tools/review-probes.ts
function parseProbes(verdict, raw) {
  const absent = raw === void 0 || raw === null;
  if (!absent && !Array.isArray(raw)) {
    throw new ProbesError("probes_invalid", `probes must be an array of ${PROBE_SHAPE}; got ${typeof raw}`);
  }
  const list = absent ? [] : raw;
  if (verdict === "pass" && list.length === 0) {
    throw new ProbesError(
      "probes_required",
      `a pass verdict needs a non-empty probes[], one ${PROBE_SHAPE} per check run in the reviewed checkout: the dependent or behavior it checks, the command, and what it showed.`
    );
  }
  return list.map((item, i) => parseProbe(item, i));
}
function parseProbe(item, i) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new ProbesError("probes_invalid", `probes[${i}] must be an object ${PROBE_SHAPE}`);
  }
  const entry = item;
  const unknown = Object.keys(entry).filter((k) => !PROBE_KEYS.has(k));
  if (unknown.length > 0) {
    throw new ProbesError("probes_invalid", `probes[${i}] has unknown field(s) ${unknown.join(", ")}. Allowed: ${PROBE_FIELDS.join(", ")}`);
  }
  const text = (field2) => {
    const v = entry[field2];
    if (typeof v !== "string" || v.trim() === "") {
      throw new ProbesError("probes_invalid", `probes[${i}].${field2} must be a non-empty string`);
    }
    return v.trim();
  };
  return { target: text("target"), probe_cmd: text("probe_cmd"), observed: text("observed") };
}
function probesJson(probes) {
  return probes.length > 0 ? JSON.stringify(probes) : null;
}
var PROBE_FIELDS, PROBE_KEYS, PROBE_SHAPE, ProbesError;
var init_review_probes = __esm({
  "src/tools/review-probes.ts"() {
    "use strict";
    PROBE_FIELDS = ["target", "probe_cmd", "observed"];
    PROBE_KEYS = new Set(PROBE_FIELDS);
    PROBE_SHAPE = "{target, probe_cmd, observed}";
    ProbesError = class extends Error {
      constructor(code, detail) {
        super(`${code}: ${detail}`);
        this.code = code;
        this.detail = detail;
      }
      code;
      detail;
    };
  }
});

// src/tools/verification-runs.ts
function passRunRefusal(taskId, commitSha, run2) {
  if (run2 && run2.at_sha === 1 && run2.exit_code === 0 && run2.timed_out === 0) return null;
  let found;
  if (commitSha === null || commitSha === "") found = "no commit recorded for the task";
  else if (!run2) found = "no verification run for the task";
  else if (run2.at_sha !== 1) found = `only a run at another commit (${run2.commit_sha || "none recorded"})`;
  else if (run2.timed_out !== 0) found = "a run that timed out";
  else found = `a failed run (exit_code=${run2.exit_code ?? "null"})`;
  return `a pass needs the gate's passing verification run (exit_code 0, not timed out) for task ${taskId} at ${commitSha || "its commit"}; found ${found}.`;
}
var PASS_RUN_SQL, VERIFICATION_RUN_REQUIRED;
var init_verification_runs = __esm({
  "src/tools/verification-runs.ts"() {
    "use strict";
    PASS_RUN_SQL = `
  SELECT commit_sha, exit_code, timed_out,
         CASE WHEN ?2 <> '' AND commit_sha <> ''
                   AND (substr(lower(commit_sha), 1, length(?2)) = ?2 OR substr(?2, 1, length(commit_sha)) = lower(commit_sha))
              THEN 1 ELSE 0 END AS at_sha
    FROM verification_runs
   WHERE task_id = ?1
   ORDER BY at_sha DESC, started_at DESC, id DESC
   LIMIT 1`;
    VERIFICATION_RUN_REQUIRED = "verification_run_required";
  }
});

// src/tools/validation.ts
var init_validation = __esm({
  "src/tools/validation.ts"() {
    "use strict";
    init_db2();
    init_agent_scope();
    init_audit();
    init_reopen();
    init_review_probes();
    init_verification_runs();
    init_success_criteria();
  }
});

// src/world-model/concepts.ts
var SYMBOL_REF_SCHEMA, CLAIM_ARGS_SCHEMA;
var init_concepts = __esm({
  "src/world-model/concepts.ts"() {
    "use strict";
    init_db2();
    init_symbol_index();
    init_extract();
    init_timeouts();
    init_success_criteria();
    init_review_sql();
    init_audit();
    SYMBOL_REF_SCHEMA = {
      type: "object",
      properties: { path: { type: "string" }, qualified_name: { type: "string" } },
      required: ["path", "qualified_name"]
    };
    CLAIM_ARGS_SCHEMA = {
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
  }
});

// src/hooks/lib/git.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
import { spawn } from "node:child_process";
import { statSync as statSync4 } from "node:fs";
function codedError(message3, code) {
  return Object.assign(new Error(message3), { code });
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
  return new Promise((resolve4) => {
    const child = spawn("git", ["-C", dir, ...args], { env, stdio: ["pipe", "pipe", stderr], signal });
    const out = collector();
    const err2 = collector();
    let cut;
    let done = false;
    const dropOutput = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finish = (code, killedBy, failure2) => {
      if (done) return;
      done = true;
      const overflow = out.over() || err2.over() ? codedError(`git ${args[0] ?? ""} passed its output limit`, "ENOBUFS") : void 0;
      const error = failure2 ?? cut ?? overflow;
      noteSpawn(limit, { error, signal: killedBy });
      resolve4({ code: error || code === null ? -1 : code, stdout: out.bytes(), stderr: err2.bytes(), error });
    };
    const take = (into, chunk) => {
      into.add(chunk);
      if (!into.over()) return;
      dropOutput();
      child.kill();
    };
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on("error", () => void 0);
    child.stdout?.on("data", (chunk) => take(out, chunk));
    child.stderr?.on("data", (chunk) => take(err2, chunk));
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
  const conclude = (keep2) => {
    entry.settled = true;
    if (!keep2 && memo.entries.get(key) === entry) memo.entries.delete(key);
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
async function untilOwnDeadline(run2, signal) {
  if (signal === void 0) return await run2;
  let onAbort = () => void 0;
  const aborted = new Promise((resolve4) => {
    onAbort = () => resolve4(OWN_DEADLINE);
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
async function gitOk(dir, args, env = process.env, stderr = "ignore") {
  return (await gitRun(dir, args, env, "", stderr)).code === 0;
}
function isDir(path) {
  if (path === "") return false;
  try {
    return statSync4(path).isDirectory();
  } catch {
    return false;
  }
}
function cdPwd(path, pwd) {
  if (!isDir(path === "" ? "." : path)) return "";
  const abs = path.startsWith("/") ? path : `${pwd.replace(/\/$/, "")}/${path}`;
  const out = [];
  for (const part of abs.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}
var GIT_MAX_BUFFER, memos, READ_SUBCOMMANDS, WALK_SUBCOMMANDS, WRITES_A_FILE, SYMBOLIC_REF_READ_FLAGS, OWN_DEADLINE;
var init_git = __esm({
  "src/hooks/lib/git.ts"() {
    "use strict";
    init_deadline();
    GIT_MAX_BUFFER = 256 * 1024 * 1024;
    memos = new AsyncLocalStorage2();
    READ_SUBCOMMANDS = /* @__PURE__ */ new Set(["rev-parse", "show-ref", "merge-base", "cat-file", "status"]);
    WALK_SUBCOMMANDS = /* @__PURE__ */ new Set(["log", "rev-list"]);
    WRITES_A_FILE = /^--ou/;
    SYMBOLIC_REF_READ_FLAGS = /* @__PURE__ */ new Set(["--short", "-q", "--quiet"]);
    OWN_DEADLINE = /* @__PURE__ */ Symbol("own-deadline");
  }
});

// src/hooks/cmd-analysis/path.ts
var init_path = __esm({
  "src/hooks/cmd-analysis/path.ts"() {
    "use strict";
  }
});

// src/hooks/lib/repo.ts
import { statSync as statSync5 } from "node:fs";
import { basename as basename4 } from "node:path";
function isFile3(path) {
  if (path === "") return false;
  try {
    return statSync5(path).isFile();
  } catch {
    return false;
  }
}
function firstLine(text) {
  const nl = text.indexOf("\n");
  return nl < 0 ? text : text.slice(0, nl);
}
function readable(db, env) {
  return isFile3(db) && haveSqlite(env);
}
async function commonDirWorktree(target, common, env) {
  const worktree = await gitOut(target, ["--git-dir", common, "config", "--local", "--get", "core.worktree"], env);
  if (worktree === "") return "";
  return cdPwd(worktree.startsWith("/") ? worktree : `${common}/${worktree}`, shellPwd(env));
}
async function repoGitRoot(target, env = process.env) {
  if (target === "") return "";
  while (!isDir(target) && target !== "/" && target !== ".") target = posixDirname(target);
  if (!isDir(target)) return "";
  const common = await gitOut(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env);
  if (common !== "") {
    if (basename4(common) === ".git") return cdPwd(posixDirname(common), shellPwd(env));
    const checkout = await commonDirWorktree(target, common, env);
    if (checkout !== "") return checkout;
  }
  return await gitOut(target, ["rev-parse", "--show-toplevel"], env);
}
function repoNameForRoot(db, root, env = process.env) {
  if (!readable(db, env) || root === "") return "";
  const name2 = firstLine(sqliteRo(db, `SELECT name FROM repos WHERE path = '${sqlQuote(root)}' LIMIT 1;`, env));
  if (name2 !== "") return name2;
  const want = realdir(root);
  for (const row of sqliteRo(db, "SELECT name || '|' || path FROM repos ORDER BY name;", env).split("\n")) {
    if (row === "") continue;
    const bar = row.indexOf("|");
    const rname = bar < 0 ? row : row.slice(0, bar);
    const rpath = bar < 0 ? row : row.slice(bar + 1);
    if (rpath === "") continue;
    if (realdir(repoPathAbs(db, rpath)) === want) return rname;
  }
  return "";
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
var init_repo = __esm({
  "src/hooks/lib/repo.ts"() {
    "use strict";
    init_path();
    init_db();
    init_git();
    init_project_env();
  }
});

// src/hooks/lib/agent-context.ts
var init_agent_context = __esm({
  "src/hooks/lib/agent-context.ts"() {
    "use strict";
    init_jq();
    init_db();
    init_role();
  }
});

// src/hooks/lib/target-task.ts
var init_target_task = __esm({
  "src/hooks/lib/target-task.ts"() {
    "use strict";
    init_agent_context();
    init_db();
    init_git();
    init_jq();
    init_project_env();
  }
});

// src/hooks/cmd-analysis/surface.ts
var init_surface = __esm({
  "src/hooks/cmd-analysis/surface.ts"() {
    "use strict";
    init_db();
    init_git();
    init_repo();
    init_target_task();
    init_path();
  }
});

// src/tools/tasks.ts
var SPEC_BODY_MAX_BYTES;
var init_tasks = __esm({
  "src/tools/tasks.ts"() {
    "use strict";
    init_db2();
    init_agent_scope();
    init_logger();
    init_audit();
    init_lifecycle();
    init_agent_runs();
    init_timeouts();
    init_repo_paths();
    init_git_refs();
    init_config();
    init_effort_ab();
    init_effort_inputs();
    init_success_criteria();
    init_checkpoint();
    init_validation();
    init_concepts();
    init_task_rework();
    init_surface();
    SPEC_BODY_MAX_BYTES = (() => {
      const raw = process.env["TMB_SPEC_BODY_MAX_BYTES"];
      if (raw === void 0) return 8e3;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 8e3;
    })();
  }
});

// src/utils/live-cli-guard.ts
var init_live_cli_guard = __esm({
  "src/utils/live-cli-guard.ts"() {
    "use strict";
  }
});

// src/sync/backend.ts
var init_backend = __esm({
  "src/sync/backend.ts"() {
    "use strict";
    init_timeouts();
    init_live_cli_guard();
    init_classify_url();
  }
});

// src/sync/issue_sync.ts
var init_issue_sync = __esm({
  "src/sync/issue_sync.ts"() {
    "use strict";
    init_timeouts();
    init_live_cli_guard();
    init_platform();
  }
});

// src/sync/issue-reconcile.ts
var init_issue_reconcile = __esm({
  "src/sync/issue-reconcile.ts"() {
    "use strict";
    init_db2();
    init_timeouts();
    init_repo_paths();
    init_remotes();
    init_audit();
    init_lifecycle();
    init_backend();
    init_issue_sync();
  }
});

// src/sync/pr-sync.ts
var PR_SYNC_MAX_BUFFER;
var init_pr_sync = __esm({
  "src/sync/pr-sync.ts"() {
    "use strict";
    init_db2();
    init_backend();
    init_issue_sync();
    init_issue_reconcile();
    PR_SYNC_MAX_BUFFER = 64 * 1024 * 1024;
  }
});

// src/tools/issues.ts
var init_issues = __esm({
  "src/tools/issues.ts"() {
    "use strict";
    init_repo_paths();
    init_containment();
    init_remotes();
    init_db2();
    init_agent_scope();
    init_backend();
    init_issue_sync();
    init_issue_reconcile();
    init_pr_sync();
    init_logger();
    init_audit();
    init_lifecycle();
  }
});

// src/sync/milestone_sync.ts
var init_milestone_sync = __esm({
  "src/sync/milestone_sync.ts"() {
    "use strict";
    init_timeouts();
    init_issue_sync();
  }
});

// src/tools/milestones.ts
var init_milestones = __esm({
  "src/tools/milestones.ts"() {
    "use strict";
    init_agent_scope();
    init_backend();
    init_issue_sync();
    init_milestone_sync();
    init_repo_paths();
    init_remotes();
    init_audit();
  }
});

// src/utils/git-objects.ts
var TREE_MAX_BUFFER;
var init_git_objects = __esm({
  "src/utils/git-objects.ts"() {
    "use strict";
    init_git_run();
    TREE_MAX_BUFFER = 256 * 1024 * 1024;
  }
});

// src/graph.ts
var init_graph = __esm({
  "src/graph.ts"() {
    "use strict";
    init_fts_query();
    init_symbol_index();
    init_test_paths();
  }
});

// src/hooks/lib/host.ts
import { accessSync as accessSync3, constants as constants4, statSync as statSync6 } from "node:fs";
function commandOnPath(name2, env = process.env) {
  for (const dir of (env.PATH ?? "").split(":")) {
    const candidate = `${dir === "" ? "." : dir}/${name2}`;
    try {
      if (!statSync6(candidate).isFile()) continue;
      accessSync3(candidate, constants4.X_OK);
      return true;
    } catch {
    }
  }
  return false;
}
function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
var init_host = __esm({
  "src/hooks/lib/host.ts"() {
    "use strict";
  }
});

// src/utils/index-target.ts
var init_index_target = __esm({
  "src/utils/index-target.ts"() {
    "use strict";
    init_git_refs();
    init_git_objects();
  }
});

// src/tools/cheatcode-runtime.ts
var init_cheatcode_runtime = __esm({
  "src/tools/cheatcode-runtime.ts"() {
    "use strict";
  }
});

// src/tools/scan-walk.ts
var init_scan_walk = __esm({
  "src/tools/scan-walk.ts"() {
    "use strict";
    init_db2();
    init_host();
    init_git_objects();
    init_index_target();
    init_audit();
    init_cheatcode_runtime();
  }
});

// src/file-purpose.ts
var init_file_purpose = __esm({
  "src/file-purpose.ts"() {
    "use strict";
    init_test_paths();
  }
});

// src/symbol-purpose.ts
var init_symbol_purpose = __esm({
  "src/symbol-purpose.ts"() {
    "use strict";
    init_db2();
    init_file_purpose();
  }
});

// src/readme-drift.ts
var HISTORY_MAX_BUFFER;
var init_readme_drift = __esm({
  "src/readme-drift.ts"() {
    "use strict";
    init_timeouts();
    HISTORY_MAX_BUFFER = 64 * 1024 * 1024;
  }
});

// src/readme-summary.ts
var README_CLEAN_MAX_CHARS;
var init_readme_summary = __esm({
  "src/readme-summary.ts"() {
    "use strict";
    README_CLEAN_MAX_CHARS = 16 * 1024;
  }
});

// src/world-model/equivalence.ts
var init_equivalence = __esm({
  "src/world-model/equivalence.ts"() {
    "use strict";
  }
});

// src/world-model/shadow-compare.ts
var SHADOW_COMPARE_INTERVAL_MS, SHADOW_BUILD_TIMEOUT_MS;
var init_shadow_compare = __esm({
  "src/world-model/shadow-compare.ts"() {
    "use strict";
    init_db2();
    init_graph();
    init_logger();
    init_audit();
    init_scan_walk();
    init_scan();
    init_equivalence();
    init_freshness();
    SHADOW_COMPARE_INTERVAL_MS = 24 * 60 * 60 * 1e3;
    SHADOW_BUILD_TIMEOUT_MS = 10 * 60 * 1e3;
  }
});

// src/utils/scan-lock.ts
var init_scan_lock = __esm({
  "src/utils/scan-lock.ts"() {
    "use strict";
    init_db2();
  }
});

// src/tools/env.ts
var ENV_STATUSES, PROFILE_SCHEMA;
var init_env = __esm({
  "src/tools/env.ts"() {
    "use strict";
    init_db2();
    init_collect();
    init_agent_scope();
    init_repo_paths();
    ENV_STATUSES = ["ready", "detected", "missing_tool", "stale"];
    PROFILE_SCHEMA = {
      type: "object",
      properties: {
        package_path: { type: "string", description: "The env_detect package_path ('.' is the repo root)." },
        ecosystem: { type: "string" },
        package_manager: { type: "string" },
        runner_prefix: { type: ["string", "null"] },
        commands: {
          type: "object",
          description: "{install, test, lint, format_check, typecheck}: each a list of {command, source, confidence, probe, provenance {kind, urls?, fetched_at?, recheck?}}."
        },
        globs: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: [...ENV_STATUSES] },
        confirmed_by: { type: ["string", "null"] },
        detected_at: { type: "string" },
        evidence_hash: { type: "string" },
        overrides: { type: "object", description: "{category: [candidate] | null}; null drops that override." },
        waivers: { type: "array", items: { type: "object" }, description: "[{category, reason, by?, at?}]" },
        declined: { type: "array", items: { type: "object" }, description: "[{item, kind, reason, evidence_hash?, at?}]" }
      },
      required: ["package_path", "ecosystem", "package_manager", "commands", "globs", "status", "evidence_hash"]
    };
  }
});

// src/tools/verification-defaults.ts
var init_verification_defaults = __esm({
  "src/tools/verification-defaults.ts"() {
    "use strict";
    init_git_run();
    init_git_refs();
    init_repo_paths();
    init_env();
  }
});

// src/tools/scan.ts
var SCAN_TIMEOUT_MS;
var init_scan = __esm({
  "src/tools/scan.ts"() {
    "use strict";
    init_db2();
    init_agent_scope();
    init_audit();
    init_graph();
    init_file_purpose();
    init_symbol_purpose();
    init_readme_drift();
    init_readme_summary();
    init_classify_url();
    init_untrusted();
    init_logger();
    init_symbol_index();
    init_extract();
    init_concepts();
    init_freshness();
    init_shadow_compare();
    init_milestones();
    init_remotes();
    init_containment();
    init_scan_walk();
    init_scan_lock();
    init_test_paths();
    init_config();
    init_verification_defaults();
    SCAN_TIMEOUT_MS = 10 * 60 * 1e3;
  }
});

// src/world-model/freshness.ts
var REPO_REBUILD_TIMEOUT_MS, LOCK_WAIT_MS, TARGET_FETCH_TTL_MS;
var init_freshness = __esm({
  "src/world-model/freshness.ts"() {
    "use strict";
    init_db2();
    init_graph();
    init_logger();
    init_extract();
    init_symbol_index();
    init_agent_scope();
    init_audit();
    init_scan_walk();
    init_scan();
    init_git_objects();
    init_git_run();
    init_index_target();
    init_scan_lock();
    REPO_REBUILD_TIMEOUT_MS = 10 * 60 * 1e3;
    LOCK_WAIT_MS = 10 * 60 * 1e3;
    TARGET_FETCH_TTL_MS = 10 * 60 * 1e3;
  }
});

// src/utils/worktree-deps.ts
import { execFileSync, spawn as spawn2 } from "node:child_process";
import { lstatSync as lstatSync2, mkdirSync as mkdirSync2, readdirSync as readdirSync3, readFileSync as readFileSync6, realpathSync as realpathSync4, rmSync as rmSync2, statSync as statSync7, symlinkSync, unlinkSync } from "node:fs";
import { basename as basename5, dirname as dirname5, join as join9 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function isDirectory(path) {
  try {
    return statSync7(path).isDirectory();
  } catch {
    return false;
  }
}
function pathPresent(path) {
  try {
    lstatSync2(path);
    return true;
  } catch {
    return false;
  }
}
function trackedFiles(worktreePath, names) {
  const pathspecs = names.flatMap((name2) => [name2, `*/${name2}`]);
  const out = execFileSync("git", ["-C", worktreePath, "ls-files", "-z", "--", ...pathspecs], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SUBPROCESS_TIMEOUT_MS
  }).toString();
  return out.split("\0").filter(Boolean);
}
function trackedPackageDirs(worktreePath) {
  return [...new Set(trackedFiles(worktreePath, ["package.json"]).map((p) => dirname5(p)))];
}
function trackedInstallRoots(repoRoot, worktreePath) {
  const lockfiles = new Set(trackedFiles(worktreePath, LOCKFILE_NAMES));
  const dirs = [...new Set([...lockfiles].map((p) => dirname5(p)))].filter((dir) => isDirectory(join9(repoRoot, dir, "node_modules"))).sort();
  return dirs.map((dir) => {
    const [, argv2] = LOCKFILE_INSTALLS.find(([lockfile]) => lockfiles.has(join9(dir, lockfile)));
    return { dir, argv: argv2, members: [] };
  });
}
function nearestRoot(dir, rootsByDir) {
  for (let at = dir; ; at = dirname5(at)) {
    const root = rootsByDir.get(at);
    if (root !== void 0 || at === ".") return root;
  }
}
function linkWorktreeNodeModules(repoRoot, worktreePath) {
  let dirs;
  try {
    dirs = trackedPackageDirs(worktreePath);
  } catch (error) {
    return gitListingFailed(error);
  }
  return linkPackageDirs(repoRoot, worktreePath, dirs);
}
async function prepareWorktreeDeps(repoRoot, worktreePath, opts = {}) {
  let dirs;
  let roots;
  try {
    dirs = trackedPackageDirs(worktreePath);
    roots = trackedInstallRoots(repoRoot, worktreePath);
  } catch (error) {
    return gitListingFailed(error);
  }
  const rootsByDir = new Map(roots.map((root) => [root.dir, root]));
  for (const dir of dirs) nearestRoot(dir, rootsByDir)?.members.push(dir);
  const installed = [];
  const installOwned = /* @__PURE__ */ new Set();
  for (const root of roots) {
    if (manifestsMatch(repoRoot, worktreePath, root)) continue;
    const command = root.argv.join(" ");
    try {
      await (opts.runInstall ?? spawnInstall)(root.argv, join9(worktreePath, root.dir), opts.env ?? process.env);
    } catch (error) {
      return {
        linked: [],
        skipped: [],
        ...installed.length > 0 ? { installed } : {},
        install_error: `frozen install failed in ${root.dir}: ${command}: ${error.message}`
      };
    }
    installed.push({ dir: root.dir, command });
    for (const dir of root.members) installOwned.add(dir);
  }
  const result = linkPackageDirs(repoRoot, worktreePath, dirs.filter((dir) => !installOwned.has(dir)));
  return installed.length > 0 ? { ...result, installed } : result;
}
function gitListingFailed(error) {
  return { linked: [], skipped: [{ dir: ".", reason: `git ls-files failed: ${error.message}` }] };
}
function readOrNull(path) {
  try {
    return readFileSync6(path);
  } catch {
    return null;
  }
}
function sameBytes(a, b) {
  const left = readOrNull(a);
  const right = readOrNull(b);
  if (left === null || right === null) return left === right;
  return left.equals(right);
}
function manifestsMatch(repoRoot, worktreePath, root) {
  const manifests = [
    ...LOCKFILE_NAMES.map((lockfile) => join9(root.dir, lockfile)),
    ...root.members.map((dir) => join9(dir, "package.json"))
  ];
  return manifests.every((rel) => sameBytes(join9(repoRoot, rel), join9(worktreePath, rel)));
}
function outputTail(text) {
  return text.replace(/\n+$/, "").split("\n").slice(-INSTALL_TAIL_LINES).join("\n");
}
function spawnInstall(argv2, cwd, env) {
  return new Promise((resolve4, reject) => {
    let output = "";
    let timedOut2 = false;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve4();
    };
    const child = spawn2(argv2[0], argv2.slice(1), { cwd, env: { ...env, PWD: cwd }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const collect = (chunk) => {
      output = (output + chunk.toString()).slice(-INSTALL_OUTPUT_CAP);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut2 = true;
      try {
        if (child.pid !== void 0) process.kill(-child.pid, "SIGKILL");
      } catch {
      }
    }, WORKTREE_DEPS_INSTALL_TIMEOUT_MS);
    child.on("error", (error) => settle(new Error(`could not start: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (!timedOut2 && code === 0) return settle();
      const reason = timedOut2 ? `timed out after ${WORKTREE_DEPS_INSTALL_TIMEOUT_MS / 1e3}s` : `exited ${code ?? `on ${signal}`}`;
      const tail2 = outputTail(output);
      settle(new Error(tail2 ? `${reason}
Output (last ${INSTALL_TAIL_LINES} lines):
${tail2}` : reason));
    });
  });
}
function linkPackageDirs(repoRoot, worktreePath, dirs) {
  const result = { linked: [], skipped: [] };
  for (const dir of dirs) {
    const src = join9(repoRoot, dir, "node_modules");
    const dest = join9(worktreePath, dir, "node_modules");
    if (!isDirectory(src)) {
      result.skipped.push({ dir, reason: `no install at ${src}` });
      continue;
    }
    const migrate = isWholeDirLinkTo(dest, src);
    if (!migrate && pathPresent(dest)) {
      result.skipped.push({ dir, reason: `${dest} already exists` });
      continue;
    }
    try {
      if (migrate) unlinkSync(dest);
      linkEachEntry(src, dest);
      result.linked.push(dir);
    } catch (error) {
      result.skipped.push({ dir, reason: `could not link ${src}: ${error.message}` });
    }
  }
  return result;
}
function isWholeDirLinkTo(dest, src) {
  try {
    return lstatSync2(dest).isSymbolicLink() && realpathSync4(dest) === realpathSync4(src);
  } catch {
    return false;
  }
}
function isWrittenInPlace(name2) {
  return name2 === ".bin" || name2.startsWith("@");
}
function linkEachEntry(src, dest) {
  mkdirSync2(dest);
  try {
    for (const name2 of readdirSync3(src)) {
      if (NPM_REGENERATED_ENTRIES.has(name2)) continue;
      const entrySrc = join9(src, name2);
      const entryDest = join9(dest, name2);
      if (isWrittenInPlace(name2) && isDirectory(entrySrc)) linkChildren(entrySrc, entryDest);
      else symlinkSync(entrySrc, entryDest);
    }
  } catch (error) {
    rmSync2(dest, { recursive: true, force: true });
    throw error;
  }
}
function linkChildren(src, dest) {
  mkdirSync2(dest);
  for (const name2 of readdirSync3(src)) symlinkSync(join9(src, name2), join9(dest, name2));
}
function isMainModule() {
  const entry = process.argv[1];
  const self = fileURLToPath2(import.meta.url);
  if (entry === void 0 || basename5(self) !== "worktree-deps.js") return false;
  try {
    return realpathSync4(entry) === realpathSync4(self);
  } catch {
    return false;
  }
}
var LOCKFILE_INSTALLS, INSTALL_TAIL_LINES, INSTALL_OUTPUT_CAP, LOCKFILE_NAMES, NPM_REGENERATED_ENTRIES;
var init_worktree_deps = __esm({
  "src/utils/worktree-deps.ts"() {
    "use strict";
    init_timeouts();
    LOCKFILE_INSTALLS = [
      ["bun.lock", ["bun", "install", "--frozen-lockfile"]],
      ["bun.lockb", ["bun", "install", "--frozen-lockfile"]],
      ["package-lock.json", ["npm", "ci"]],
      ["npm-shrinkwrap.json", ["npm", "ci"]],
      ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
      ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]]
    ];
    INSTALL_TAIL_LINES = 20;
    INSTALL_OUTPUT_CAP = 64 * 1024;
    LOCKFILE_NAMES = LOCKFILE_INSTALLS.map(([lockfile]) => lockfile);
    NPM_REGENERATED_ENTRIES = /* @__PURE__ */ new Set([".package-lock.json"]);
    if (isMainModule()) {
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
  }
});

// src/utils/worktree-setup.ts
import { spawn as spawn3 } from "node:child_process";
import { closeSync as closeSync4, mkdtempSync as mkdtempSync2, openSync as openSync4, readFileSync as readFileSync7, rmSync as rmSync3 } from "node:fs";
import { constants as osConstants, tmpdir as tmpdir2 } from "node:os";
import { join as join10 } from "node:path";
function readSetupFile(worktreePath) {
  let raw;
  try {
    raw = readFileSync7(join10(worktreePath, WORKTREE_SETUP_FILE), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    return { error: `${WORKTREE_SETUP_FILE}: cannot read: ${e.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `${WORKTREE_SETUP_FILE}: not valid JSON: ${e.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${WORKTREE_SETUP_FILE}: must be a JSON object {"version":1,"commands":[...]}` };
  }
  const { version, commands } = parsed;
  if (version !== 1) return { error: `${WORKTREE_SETUP_FILE}: version must be 1, got ${JSON.stringify(version) ?? "none"}` };
  if (!Array.isArray(commands) || commands.length === 0 || !commands.every((c) => typeof c === "string" && c.trim() !== "")) {
    return { error: `${WORKTREE_SETUP_FILE}: commands must be a non-empty array of non-empty strings` };
  }
  return { commands };
}
function seconds(ms) {
  return Math.round(ms / 1e3);
}
function tail(text) {
  return text.replace(/\n+$/, "").split("\n").slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
}
function runCommand(command, cwd, env, timeoutMs, outPath) {
  return new Promise((done) => {
    const fd = openSync4(outPath, "w");
    let timedOut2 = false;
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ exitCode, timedOut: timedOut2 });
    };
    const child = spawn3("bash", ["-c", command], { cwd, env: { ...env, PWD: cwd }, stdio: ["ignore", fd, fd], detached: true });
    closeSync4(fd);
    const timer = setTimeout(() => {
      timedOut2 = true;
      try {
        if (child.pid !== void 0) process.kill(-child.pid, "SIGKILL");
      } catch {
      }
    }, timeoutMs);
    child.on("error", () => finish(127));
    child.on("exit", (code, signal) => {
      if (timedOut2) finish(TIMED_OUT_CODE);
      else finish(code ?? 128 + (signal !== null ? signals[signal] ?? 0 : 0));
    });
  });
}
async function runWorktreeSetup(worktreePath, opts = {}) {
  let parsed;
  try {
    parsed = readSetupFile(worktreePath);
  } catch (e) {
    parsed = { error: `${WORKTREE_SETUP_FILE}: ${e.message}` };
  }
  if (parsed === null) return { ran: false, commands: [] };
  if ("error" in parsed) return { ran: false, commands: [], error: parsed.error };
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? WORKTREE_SETUP_COMMAND_TIMEOUT_MS;
  const total = opts.totalTimeoutMs;
  const totalStart = Date.now();
  const result = { ran: false, commands: [] };
  let scratch;
  try {
    scratch = mkdtempSync2(join10(tmpdir2(), "tmb-worktree-setup-"));
  } catch (e) {
    return { ran: false, commands: [], error: `worktree setup: cannot create a scratch dir: ${e.message}` };
  }
  try {
    for (const [i, command] of parsed.commands.entries()) {
      const outPath = join10(scratch, `out-${i + 1}`);
      const left = total === void 0 ? Infinity : total - (Date.now() - totalStart);
      if (left <= 0) {
        result.commands.push({ command, exit_code: TIMED_OUT_CODE, timed_out: true, elapsed_ms: 0 });
        result.error = `worktree setup ran out of its ${seconds(total ?? 0)}s budget before command ${i + 1}/${parsed.commands.length}: ${command}`;
        return result;
      }
      const budgetBound = left < timeoutMs;
      const started = Date.now();
      let run2;
      try {
        run2 = await runCommand(command, worktreePath, env, budgetBound ? left : timeoutMs, outPath);
      } catch (e) {
        result.commands.push({ command, exit_code: 127, timed_out: false, elapsed_ms: Date.now() - started });
        result.error = `worktree setup command failed to start: ${command}: ${e.message}`;
        return result;
      }
      result.ran = true;
      result.commands.push({ command, exit_code: run2.exitCode, timed_out: run2.timedOut, elapsed_ms: Date.now() - started });
      if (run2.exitCode === 0) continue;
      let out = "";
      try {
        out = readFileSync7(outPath, "utf8");
      } catch {
      }
      if (!run2.timedOut) result.error = `worktree setup command exited ${run2.exitCode}: ${command}`;
      else if (budgetBound) result.error = `worktree setup command timed out: its ${seconds(total ?? 0)}s budget ran out: ${command}`;
      else result.error = `worktree setup command timed out after ${seconds(timeoutMs)}s: ${command}`;
      result.output_tail = tail(out);
      return result;
    }
    return result;
  } finally {
    rmSync3(scratch, { recursive: true, force: true });
  }
}
function describeSetupFailure(r) {
  const lines = [r.error ?? "worktree setup failed"];
  if (r.output_tail) lines.push(`Output (last ${TAIL_LINES} lines):
${r.output_tail}`);
  return lines.join("\n");
}
var WORKTREE_SETUP_FILE, TAIL_LINES, TAIL_CHARS, TIMED_OUT_CODE, signals;
var init_worktree_setup = __esm({
  "src/utils/worktree-setup.ts"() {
    "use strict";
    init_timeouts();
    WORKTREE_SETUP_FILE = ".config/tmb/worktree-setup.json";
    TAIL_LINES = 20;
    TAIL_CHARS = 4e3;
    TIMED_OUT_CODE = 124;
    signals = osConstants.signals;
  }
});

// src/hooks/lib/audit.ts
import { accessSync as accessSync4, constants as constants5, readFileSync as readFileSync8, statSync as statSync8 } from "node:fs";
import { performance as performance4 } from "node:perf_hooks";
import { fileURLToPath as fileURLToPath3 } from "node:url";
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
    return statSync8(path).isFile();
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
  const start = performance4.now();
  const left = () => budget - (spentMs.get(env) ?? 0) - (performance4.now() - start);
  let code = BUDGET_SPENT_CODE;
  let err2 = "";
  let stdout = "";
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const remaining = left();
    if (remaining <= 0) {
      err2 = `run budget spent (TMB_DB_WRITE_RUN_BUDGET_MS=${budget})${err2 ? `; last error: ${err2}` : ""}`;
      code = BUDGET_SPENT_CODE;
      break;
    }
    const waitMs = Math.min(busy, Math.ceil(remaining));
    const r = sqliteRun({ target: db, readonly: false, timeoutMs: waitMs, script, bail: true }, env);
    stdout += r.stdout;
    code = r.code;
    err2 = stripTrailingNewlines(r.stderr);
    if (code === 0) break;
    if (!BUSY_PATTERN.test(err2)) break;
    if (attempt < WRITE_ATTEMPTS && left() > BACKOFF_MS) sleepMs(BACKOFF_MS);
  }
  spentMs.set(env, (spentMs.get(env) ?? 0) + (performance4.now() - start));
  if (code === 0) return { ok: true, code: 0, stdout, error: "" };
  const detail = (err2 || `sqlite3 exited ${code}`).split("\n")[0];
  return { ok: false, code, stdout, error: `tmb_db_write: ${caller}: ${detail}` };
}
function fromNodeValid(fromNode) {
  return fromNode === "system" || /^hook:[a-z0-9-]+$/.test(fromNode);
}
function auditWriter(fromNode) {
  if (fromNode.startsWith("hook:")) return "hook";
  return fromNode === "system" ? "server" : "";
}
function auditEventsFile(env = process.env) {
  const here = posixDirname(fileURLToPath3(import.meta.url));
  const root = installRoot(here) ?? env.CLAUDE_PLUGIN_ROOT ?? here;
  return `${root}/${AUDIT_EVENTS_REL}`;
}
function eventWriters(file, eventType) {
  if (eventType === "") return null;
  let text;
  try {
    text = readFileSync8(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const trimmed = line.replace(/^\t+/, "").replace(/\t+$/, "");
    const tab = trimmed.indexOf("	");
    const ev = tab < 0 ? trimmed : trimmed.slice(0, tab);
    if (ev === eventType) return tab < 0 ? "" : trimmed.slice(tab).replace(/^\t+/, "");
  }
  return null;
}
function readable2(file) {
  try {
    accessSync4(file, constants5.R_OK);
    return true;
  } catch {
    return false;
  }
}
function auditWriterCheck(label, eventType, writer, opts = {}) {
  const file = opts.eventsFile ?? auditEventsFile(opts.env);
  if (!readable2(file)) {
    return {
      code: 2,
      error: `${label}: audit event list missing or unreadable: ${file} (run npm run build in mcp/trajectory-server)`
    };
  }
  const writers = eventWriters(file, eventType);
  if (writers === null) {
    return {
      code: 2,
      error: `${label}: unknown event_type '${eventType}' (not in ${file}; add it to mcp/trajectory-server/src/audit-events.ts and rebuild)`
    };
  }
  if (`,${writers},`.includes(`,${writer},`)) return { code: 0, error: "" };
  return {
    code: 2,
    error: `${label}: audit_event_not_writable_by_role: '${writer}' may not write '${eventType}' (writers: ${writers})`
  };
}
function auditSql(row, guardSql = "", opts = {}) {
  const caller = opts.caller ?? defaultCaller();
  const label = `tmb_audit_append: ${caller}`;
  if (!fromNodeValid(row.fromNode)) {
    return { code: INVALID_CODE, sql: "", error: `${label}: invalid from_node '${row.fromNode}' (want hook:<name> or system)` };
  }
  const check = auditWriterCheck(label, row.eventType, auditWriter(row.fromNode), opts);
  if (check.code !== 0) return { code: INVALID_CODE, sql: "", error: check.error };
  const issue = row.issueId === "-1" ? "-1" : sqlInt(row.issueId);
  if (issue === "") return { code: INVALID_CODE, sql: "", error: `${label}: invalid issue_id '${row.issueId}'` };
  const branch = row.branchId === "" ? "NULL" : `'${sqlQuote(row.branchId)}'`;
  const where = guardSql === "" ? "" : ` WHERE ${guardSql}`;
  const sql = `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at) SELECT ${issue}, ${branch}, '${sqlQuote(row.fromNode)}', '${sqlQuote(row.eventType)}', '${sqlQuote(row.summary)}', '${sqlQuote(row.contentJson || "{}")}', (SELECT repo FROM issues WHERE id = ${issue}), '${opts.now ?? nowIso()}'${where};`;
  return { code: 0, sql, error: "" };
}
var WRITE_ATTEMPTS, BACKOFF_MS, DEFAULT_BUSY_MS, DEFAULT_RUN_BUDGET_MS, BUDGET_SPENT_CODE, INVALID_CODE, AUDIT_EVENTS_REL, spentMs, BUSY_PATTERN;
var init_audit2 = __esm({
  "src/hooks/lib/audit.ts"() {
    "use strict";
    init_db();
    init_project_env();
    init_sqlite_shell();
    WRITE_ATTEMPTS = 2;
    BACKOFF_MS = 200;
    DEFAULT_BUSY_MS = 1500;
    DEFAULT_RUN_BUDGET_MS = 3500;
    BUDGET_SPENT_CODE = 5;
    INVALID_CODE = 2;
    AUDIT_EVENTS_REL = "scripts/hooks/lib/audit-events.txt";
    spentMs = /* @__PURE__ */ new WeakMap();
    BUSY_PATTERN = /database is locked|SQLITE_BUSY|database is busy/;
  }
});

// src/hooks/lib/doc-checks.ts
async function gitText(repo, args, env) {
  const r = await gitSpawn(repo, args, { env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, stderr: "pipe", timeoutMs: GIT_TIMEOUT_MS });
  return { code: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") || (r.error?.message ?? "") };
}
var GIT_TIMEOUT_MS;
var init_doc_checks = __esm({
  "src/hooks/lib/doc-checks.ts"() {
    "use strict";
    init_git();
    GIT_TIMEOUT_MS = 1e4;
  }
});

// src/hooks/lib/git-refs.ts
async function refResolves(repoPath, ref, env) {
  return await gitOk(repoPath, ["rev-parse", "--verify", "--quiet", ref], env);
}
async function gitOutput(repoPath, args, env) {
  const r = await gitRun(repoPath, args, env);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}
async function normalizeBase2(repoPath, base, env) {
  if (!base.startsWith("origin/") || await refResolves(repoPath, `refs/heads/${base}`, env)) return base;
  return base.slice("origin/".length);
}
async function resolveBaseRef(repoPath, rawBase, env) {
  const base = await normalizeBase2(repoPath, rawBase, env);
  if (await refResolves(repoPath, `origin/${base}`, env)) return `origin/${base}`;
  if (await refResolves(repoPath, `refs/heads/${base}`, env)) return base;
  return null;
}
async function resolveRepoDefaultBranch2(repoPath, env) {
  const originHead = await gitOutput(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], env);
  if (originHead) return originHead.replace(/^origin\//, "");
  for (const candidate of ["main", "master", "dev"]) {
    if (await refResolves(repoPath, `refs/heads/${candidate}`, env)) return candidate;
  }
  return await gitOutput(repoPath, ["symbolic-ref", "--short", "HEAD"], env) ?? "main";
}
async function prTargetRef(repoPath, targetBranch, parentBranch, env) {
  for (const candidate of [targetBranch, parentBranch]) {
    if (candidate === "") continue;
    const ref = await resolveBaseRef(repoPath, candidate, env);
    if (ref) return ref;
  }
  return await resolveBaseRef(repoPath, await resolveRepoDefaultBranch2(repoPath, env), env);
}
var init_git_refs2 = __esm({
  "src/hooks/lib/git-refs.ts"() {
    "use strict";
    init_git();
  }
});

// src/hooks/lib/lint-fingerprint.ts
import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
function maskDots(s) {
  return s.replace(/(^|\/)\./g, `$1${DOT_MASK}`);
}
function matchesInput(path, glob) {
  return matchesGlob(path, glob) || matchesGlob(maskDots(path), maskDots(glob));
}
async function lintFingerprint(repoPath, commitSha, inputs, env = process.env) {
  if (commitSha === "" || commitSha.startsWith("-")) return null;
  const r = await gitRun(repoPath, ["ls-tree", "-r", "--full-tree", "-z", commitSha], env);
  if (r.code !== 0) return null;
  const entries = [];
  try {
    for (const record of r.stdout.split("\0")) {
      const tab = record.indexOf("	");
      if (tab < 0) continue;
      const [, type, oid] = record.slice(0, tab).split(" ");
      const path = record.slice(tab + 1);
      if (type !== "blob" || oid === void 0) continue;
      if (path === CLOSE_LINTS_PATH || inputs.some((glob) => matchesInput(path, glob))) entries.push({ path, oid });
    }
  } catch {
    return null;
  }
  return fingerprintDigest(entries);
}
function fingerprintDigest(entries) {
  const sorted = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const hash = createHash("sha256");
  for (const e of sorted) hash.update(`${e.path}\0${e.oid}
`);
  return `v1:${hash.digest("hex")}`;
}
var CLOSE_LINTS_PATH, DOT_MASK;
var init_lint_fingerprint = __esm({
  "src/hooks/lib/lint-fingerprint.ts"() {
    "use strict";
    init_git();
    CLOSE_LINTS_PATH = ".config/tmb/close-lints.json";
    DOT_MASK = "";
  }
});

// src/hooks/lib/verification-runs.ts
function shellLength(s, env) {
  return ctypeUtf8(env) ? [...s].length : Buffer.byteLength(s);
}
function shellTail(s, n, env) {
  if (ctypeUtf8(env)) return [...s].slice(-n).join("");
  const bytes = Buffer.from(s);
  return bytes.subarray(Math.max(0, bytes.length - n)).toString("utf8");
}
function capTail(output, env) {
  const rawCap = env.TMB_VERIFICATION_TAIL_CHARS || String(DEFAULT_TAIL_CHARS);
  const cap = /^[0-9]+$/.test(rawCap) ? Number(rawCap) : DEFAULT_TAIL_CHARS;
  return cap > 0 && shellLength(output, env) > cap ? shellTail(output, cap, env) : output;
}
function invalid(caller, message3) {
  return { code: 2, sql: "", error: `tmb_verification_run: ${caller}: ${message3}` };
}
function runStartSql(taskId, sha, budgetS, source, now2 = nowIso()) {
  return `UPDATE verification_runs SET finished_at = '${now2}', exit_code = 137, timed_out = 0
 WHERE finished_at IS NULL
   AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) < strftime('%Y-%m-%dT%H:%M:%fZ', '${now2}', '-' || (budget_s + 60) || ' seconds');
INSERT INTO verification_runs (task_id, commit_sha, source, started_at, budget_s) VALUES (${taskId}, '${sqlQuote(sha)}', '${source}', '${now2}', ${budgetS});
SELECT last_insert_rowid();`;
}
function runCommandSql(caller, runId, ordinal, command, rc, elapsed, output, env) {
  if (!/^[0-9]+$/.test(runId)) return invalid(caller, `invalid run_id '${runId}'`);
  const tail2 = capTail(output, env);
  return {
    code: 0,
    sql: `INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (${runId}, ${ordinal}, '${sqlQuote(command)}', ${rc}, ${elapsed}, '${sqlQuote(tail2)}');`,
    error: ""
  };
}
function runFinishSql(caller, runId, rc, timedOut2, now2 = nowIso()) {
  if (!/^[0-9]+$/.test(runId)) return invalid(caller, `invalid run_id '${runId}'`);
  return {
    code: 0,
    sql: `UPDATE verification_runs SET finished_at = '${now2}', exit_code = ${rc}, timed_out = ${timedOut2} WHERE id = ${runId};`,
    error: ""
  };
}
var DEFAULT_TAIL_CHARS;
var init_verification_runs2 = __esm({
  "src/hooks/lib/verification-runs.ts"() {
    "use strict";
    init_audit2();
    init_db();
    init_project_env();
    DEFAULT_TAIL_CHARS = 4e3;
  }
});

// src/hooks/lib/lint-runs.ts
function nonEmpty(v) {
  return typeof v === "string" && v.trim() !== "";
}
function parseCloseLints(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return `not valid JSON: ${e.message}`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return 'must be a JSON object {"lints":[...],"fingerprint_inputs":[...]}';
  }
  const { lints, fingerprint_inputs: inputs } = parsed;
  if (!Array.isArray(lints)) return 'lints must be an array of {"name":"<non-empty>","command":"<non-empty>"}';
  const names = /* @__PURE__ */ new Set();
  for (const [i, l] of lints.entries()) {
    if (l === null || typeof l !== "object" || Array.isArray(l)) return `lints[${i}] must be an object {"name","command"}`;
    const { name: name2, command } = l;
    if (!nonEmpty(name2)) return `lints[${i}].name must be a non-empty string`;
    if (!nonEmpty(command)) return `lints[${i}].command must be a non-empty string`;
    if (names.has(name2)) return `lints[${i}].name '${name2}' is a duplicate`;
    names.add(name2);
  }
  if (!Array.isArray(inputs) || !inputs.every(nonEmpty)) return "fingerprint_inputs must be an array of non-empty glob strings";
  return {
    lints: lints.map((l) => ({ name: l.name, command: l.command })),
    fingerprint_inputs: [...inputs]
  };
}
function invalid2(caller, message3) {
  return { code: 2, sql: "", error: `tmb_lint_run: ${caller}: ${message3}` };
}
function ok(sql) {
  return { code: 0, sql, error: "" };
}
function lintRunStartSql(taskId, sha, baseSha, fingerprint, source, now2 = nowIso()) {
  if (!INT_RE.test(taskId)) return invalid2("lintRunStartSql", `invalid task_id '${taskId}'`);
  if (!LINT_RUN_SOURCES.includes(source)) return invalid2("lintRunStartSql", `invalid source '${source}'`);
  return ok(`UPDATE lint_runs SET finished_at = '${now2}', exit_code = 137
 WHERE finished_at IS NULL
   AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) < strftime('%Y-%m-%dT%H:%M:%fZ', '${now2}', '-${LINT_RUN_STALE_S} seconds');
INSERT INTO lint_runs (task_id, commit_sha, base_sha, fingerprint, source, started_at) VALUES (${taskId}, '${sqlQuote(sha)}', '${sqlQuote(baseSha)}', '${sqlQuote(fingerprint)}', '${source}', '${now2}');
SELECT last_insert_rowid();`);
}
function lintRunResultSql(runId, ordinal, name2, rc, elapsed, output, env) {
  if (!INT_RE.test(runId)) return invalid2("lintRunResultSql", `invalid run_id '${runId}'`);
  if (!Number.isInteger(ordinal) || ordinal < 1) return invalid2("lintRunResultSql", `invalid ordinal '${ordinal}'`);
  if (!Number.isInteger(rc)) return invalid2("lintRunResultSql", `invalid exit code '${rc}'`);
  if (!Number.isFinite(elapsed)) return invalid2("lintRunResultSql", `invalid elapsed '${elapsed}'`);
  return ok(
    `INSERT INTO lint_run_results (run_id, ordinal, name, exit_code, elapsed_s, output_tail) VALUES (${runId}, ${ordinal}, '${sqlQuote(name2)}', ${rc}, ${elapsed}, '${sqlQuote(capTail(output, env))}');`
  );
}
function lintRunFinishSql(runId, rc, now2 = nowIso()) {
  if (!INT_RE.test(runId)) return invalid2("lintRunFinishSql", `invalid run_id '${runId}'`);
  if (!Number.isInteger(rc)) return invalid2("lintRunFinishSql", `invalid exit code '${rc}'`);
  return ok(`UPDATE lint_runs SET finished_at = '${now2}', exit_code = ${rc} WHERE id = ${runId};`);
}
var LINT_RUN_STALE_S, LINT_RUN_SOURCES, INT_RE;
var init_lint_runs = __esm({
  "src/hooks/lib/lint-runs.ts"() {
    "use strict";
    init_audit2();
    init_db();
    init_verification_runs2();
    LINT_RUN_STALE_S = 3600;
    LINT_RUN_SOURCES = ["gate", "integrate"];
    INT_RE = /^[0-9]+$/;
  }
});

// src/hooks/lib/close-lints.ts
import { spawn as spawn4 } from "node:child_process";
import { closeSync as closeSync5, mkdtempSync as mkdtempSync3, openSync as openSync5, readFileSync as readFileSync9, rmSync as rmSync4 } from "node:fs";
import { constants as osConstants2, tmpdir as tmpdir3 } from "node:os";
import { join as join11 } from "node:path";
async function readCloseLints(repo, sha, env) {
  const listed = await gitText(repo, ["ls-tree", "--name-only", sha, "--", CLOSE_LINTS_PATH], env);
  if (listed.code !== 0) return `git ls-tree ${sha} failed: ${listed.stderr.trim()}`;
  if (listed.stdout.trim() === "") return null;
  const shown = await gitText(repo, ["show", `${sha}:${CLOSE_LINTS_PATH}`], env);
  if (shown.code !== 0) return `git show ${sha}:${CLOSE_LINTS_PATH} failed: ${shown.stderr.trim()}`;
  const parsed = parseCloseLints(shown.stdout);
  return typeof parsed === "string" ? `${CLOSE_LINTS_PATH} at ${sha.slice(0, 12)}: ${parsed}` : parsed;
}
async function closeLintsPlan(repo, sha, env) {
  const config = await readCloseLints(repo, sha, env);
  if (typeof config === "string") return config;
  const fingerprint = await lintFingerprint(repo, sha, config?.fingerprint_inputs ?? [], env);
  if (fingerprint === null) return `the close-lint fingerprint of ${sha} could not be computed (git ls-tree failed or a fingerprint_inputs glob does not apply)`;
  return { config, fingerprint };
}
async function lintBaseSha(repo, db, taskId, sha, env) {
  if (!/^[0-9]+$/.test(taskId)) return "";
  const row = gateRead(
    db,
    `SELECT COALESCE((SELECT target_branch FROM repos WHERE name = t.repo), '') || '|' || COALESCE(t.parent_branch_id, '') FROM tasks t WHERE t.id = ${taskId};`,
    env
  );
  const line = row === GATE_READ_ERROR ? "" : row.split("\n")[0];
  const bar = line.indexOf("|");
  const target = bar < 0 ? "" : line.slice(0, bar);
  const parent = bar < 0 ? "" : line.slice(bar + 1);
  const ref = await prTargetRef(repo, target, parent, env);
  if (ref === null) return "";
  const base = await gitText(repo, ["merge-base", ref, sha], env);
  return base.code === 0 ? base.stdout.trim() : "";
}
function tailLines(text, n = FAILURE_TAIL_LINES) {
  return text.replace(/\n+$/, "").split("\n").slice(-n).join("\n");
}
function write(db, sql, env) {
  const r = dbWrite(db, sql, { caller: "close-lints", env: { ...env, ...RECORD_ENV } });
  if (!r.ok && r.error !== "") process.stderr.write(`${r.error}
`);
  return r;
}
function execute(command, cwd, env, seconds3, outPath) {
  return new Promise((done) => {
    const fd = openSync5(outPath, "w");
    let fired = false;
    let settled = false;
    const finish = (rc) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(rc);
    };
    const child = spawn4("bash", ["-c", command], { cwd, env: { ...env, PWD: cwd }, stdio: ["ignore", fd, fd], detached: true });
    closeSync5(fd);
    const timer = setTimeout(() => {
      fired = true;
      try {
        if (child.pid !== void 0) process.kill(-child.pid, "SIGKILL");
      } catch {
      }
    }, seconds3 * 1e3);
    child.on("error", () => finish(127));
    child.on("exit", (code, signal) => {
      if (fired) finish(LINT_TIMED_OUT);
      else finish(code ?? 128 + (signal !== null ? signals2[signal] ?? 0 : 0));
    });
  });
}
function seconds2(ms) {
  return Math.round(ms / 100) / 10;
}
async function runCloseLints(repo, sha, baseSha, budgetS, env, target) {
  const plan = await closeLintsPlan(repo, sha, env);
  if (typeof plan === "string") return plan;
  const start = lintRunStartSql(target.taskId, sha, baseSha, plan.fingerprint, target.source);
  if (start.code !== 0) return start.error;
  const started = write(target.db, start.sql, env);
  const id = started.ok ? started.stdout.trim().split("\n").at(-1) ?? "" : "";
  const runId = /^[0-9]+$/.test(id) ? id : "";
  if (runId === "") process.stderr.write(`close-lints: the lint run start could not be recorded in ${target.db}; the lints run unrecorded
`);
  const results = [];
  const record = (r) => {
    results.push(r);
    if (runId === "") return;
    const s = lintRunResultSql(runId, results.length, r.name, r.exitCode, r.elapsedS, r.output, env);
    if (s.code !== 0) process.stderr.write(`${s.error}
`);
    else write(target.db, s.sql, env);
  };
  const scratch = mkdtempSync3(join11(tmpdir3(), "tmb-close-lints-"));
  try {
    const budgetStart = Date.now();
    for (const [i, lint] of (plan.config?.lints ?? []).entries()) {
      const left = budgetS - (Date.now() - budgetStart) / 1e3;
      if (left <= 0) {
        record({ name: lint.name, exitCode: LINT_TIMED_OUT, elapsedS: 0, output: `the ${budgetS}s close-lint budget ran out before \`${lint.command}\` started` });
        continue;
      }
      const outPath = join11(scratch, `out-${i + 1}`);
      const t0 = Date.now();
      const rc = await execute(lint.command, repo, env, left, outPath);
      const elapsedS = seconds2(Date.now() - t0);
      let output = "";
      try {
        output = readFileSync9(outPath, "utf8");
      } catch {
      }
      if (rc === LINT_TIMED_OUT) {
        const killed = `killed at the ${budgetS}s close-lint budget after ${elapsedS}s`;
        const printed = output.replace(/\n+$/, "");
        output = printed === "" ? killed : `${printed}
${killed}`;
      }
      record({ name: lint.name, exitCode: rc, elapsedS, output });
    }
  } finally {
    rmSync4(scratch, { recursive: true, force: true });
  }
  const failures = results.filter((r) => r.exitCode !== 0);
  const exitCode = failures[0]?.exitCode ?? 0;
  if (runId !== "") {
    const finish = lintRunFinishSql(runId, exitCode);
    let finished = false;
    for (let attempt = 1; attempt <= FINISH_ATTEMPTS && !finished; attempt += 1) finished = write(target.db, finish.sql, env).ok;
    if (!finished) process.stderr.write(`close-lints: lint run #${runId} finish write failed ${FINISH_ATTEMPTS} times; it stays unfinished
`);
  }
  return { runId, exitCode, fingerprint: plan.fingerprint, results, failures };
}
function runLabel(run2) {
  return run2.runId === "" ? "an unrecorded lint run (the trajectory DB write failed)" : `lint run #${run2.runId}`;
}
function describeFailures(run2) {
  return run2.failures.map((f) => {
    const shown = tailLines(f.output);
    const why = f.exitCode === LINT_TIMED_OUT ? " (timed out)" : "";
    return `Lint ${f.name} exited ${f.exitCode}${why}.${shown === "" ? " It printed nothing." : `
Output (last ${FAILURE_TAIL_LINES} lines):
${shown}`}`;
  }).join("\n\n");
}
var LINT_TIMED_OUT, FAILURE_TAIL_LINES, RECORD_ENV, FINISH_ATTEMPTS, signals2;
var init_close_lints = __esm({
  "src/hooks/lib/close-lints.ts"() {
    "use strict";
    init_audit2();
    init_db();
    init_doc_checks();
    init_git_refs2();
    init_lint_fingerprint();
    init_lint_runs();
    LINT_TIMED_OUT = 124;
    FAILURE_TAIL_LINES = 15;
    RECORD_ENV = { TMB_DB_WRITE_TIMEOUT_MS: "3000", TMB_DB_WRITE_RUN_BUDGET_MS: "3000" };
    FINISH_ATTEMPTS = 3;
    signals2 = osConstants2.signals;
  }
});

// src/path-classes.ts
var init_path_classes = __esm({
  "src/path-classes.ts"() {
    "use strict";
    init_lint_fingerprint();
    init_git_run();
  }
});

// src/hooks/lib/leak-scan.ts
var init_leak_scan = __esm({
  "src/hooks/lib/leak-scan.ts"() {
    "use strict";
    init_doc_checks();
  }
});

// src/hooks/lib/lint-shell.ts
var init_lint_shell = __esm({
  "src/hooks/lib/lint-shell.ts"() {
    "use strict";
    init_jq();
    init_project_env();
  }
});

// src/hooks/lib/jq-raw.ts
var init_jq_raw = __esm({
  "src/hooks/lib/jq-raw.ts"() {
    "use strict";
    init_jq();
    init_jq_key_order();
    init_lint_shell();
  }
});

// src/hooks/lib/verification-carry.ts
import { realpathSync as realpathSync5 } from "node:fs";
import { basename as basename6, matchesGlob as matchesGlob2 } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";
function refuse(reason, source = null) {
  return { source_run: source?.id ?? null, source_sha: source?.sha ?? null, carry: [], refused: reason, commands: [] };
}
function parseCommands(json2) {
  try {
    const parsed = JSON.parse(json2);
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
    const touched = declared[0].inputs.some((glob) => changed.some((path) => matchesGlob2(path, glob)));
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
function isMainModule2() {
  const entry = process.argv[1];
  const self = fileURLToPath4(import.meta.url);
  if (entry === void 0 || basename6(self) !== "verification-carry.js") return false;
  try {
    return realpathSync5(entry) === realpathSync5(self);
  } catch {
    return false;
  }
}
var VERIFICATION_INPUTS_PATH, VERIFICATION_INPUTS_VERSION, SHA_RE, PROBE_PREFIX;
var init_verification_carry = __esm({
  async "src/hooks/lib/verification-carry.ts"() {
    "use strict";
    init_db();
    init_git();
    VERIFICATION_INPUTS_PATH = ".config/tmb/verification-inputs.json";
    VERIFICATION_INPUTS_VERSION = 1;
    SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
    PROBE_PREFIX = "[probe ";
    if (isMainModule2()) {
      const [db = "", taskId = "", worktree = "", head = "", commandsJson = ""] = process.argv.slice(2);
      process.stdout.write(`${JSON.stringify(await planCarrySafe({ db, taskId, worktree, head, commandsJson }))}
`);
    }
  }
});

// src/hooks/swe-brief-gate.ts
var init_swe_brief_gate = __esm({
  "src/hooks/swe-brief-gate.ts"() {
    "use strict";
    init_gate();
    init_agent_context();
    init_audit2();
    init_db();
    init_deny();
    init_jq();
    init_project_env();
    init_role();
  }
});

// src/suite-lock.ts
var init_suite_lock = __esm({
  "src/suite-lock.ts"() {
    "use strict";
  }
});

// src/hooks/swe-verification-gate.ts
import { spawn as spawn5, spawnSync as spawnSync2 } from "node:child_process";
import { accessSync as accessSync5, closeSync as closeSync6, constants as constants6, mkdirSync as mkdirSync3, mkdtempSync as mkdtempSync4, openSync as openSync6, readFileSync as readFileSync10, rmSync as rmSync5, statSync as statSync9, writeFileSync } from "node:fs";
import { constants as osConstants3, tmpdir as tmpdir4 } from "node:os";
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
  const r = spawnSync2(cmd, args, { cwd: dir, encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
  return r.stdout ?? "";
}
function toolchainDirs(env, worktree) {
  const home = env.HOME ?? "";
  const out = [];
  const miseData = env.MISE_DATA_DIR || `${env.XDG_DATA_HOME || `${home}/.local/share`}/mise`;
  if (isDir(`${miseData}/shims`)) out.push(`${miseData}/shims`);
  const mise = [env.MISE_INSTALL_PATH ?? "", "/opt/homebrew/bin/mise", "/usr/local/bin/mise", `${home}/.local/bin/mise`].find(executable);
  if (mise !== void 0) out.push(...capture(mise, ["bin-paths"], worktree, env).split("\n"));
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(executable);
  const brewPrefix = brew === void 0 ? "" : commandSubstitution(capture(brew, ["--prefix"], worktree, env));
  const brewDirs = brewPrefix !== "" ? [`${brewPrefix}/bin`, `${brewPrefix}/sbin`] : ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
  out.push(...brewDirs.filter(isDir));
  if (home !== "" && isDir(`${home}/.local/bin`)) out.push(`${home}/.local/bin`);
  if (home !== "") {
    for (const dir of [`${home}/Library/Application Support/reflex/bun/bin`, `${home}/.bun/bin`]) {
      if (isDir(dir) && executable(`${dir}/bun`)) out.push(dir);
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
var GATE_NAME, VERIFICATION_DEFAULT_S, VERIFICATION_MAX_S, signals3, DB_UNAVAILABLE_DENY, WAIVER_UNRECORDED_DENY;
var init_swe_verification_gate = __esm({
  async "src/hooks/swe-verification-gate.ts"() {
    "use strict";
    init_gate();
    init_audit2();
    init_close_lints();
    init_deny();
    init_db();
    init_doc_checks();
    init_path_classes();
    init_git();
    init_leak_scan();
    init_git_refs2();
    init_host();
    init_jq();
    init_jq_raw();
    init_lint_fingerprint();
    init_project_env();
    init_repo();
    init_role();
    await init_verification_carry();
    init_verification_runs2();
    init_swe_brief_gate();
    init_suite_lock();
    init_worktree_setup();
    GATE_NAME = "swe-verification-gate";
    VERIFICATION_DEFAULT_S = 900;
    VERIFICATION_MAX_S = 1800;
    signals3 = osConstants3.signals;
    DB_UNAVAILABLE_DENY = `${denyJson(
      "BLOCKED: trajectory DB unavailable \u2014 the verification gate could not read the task row, so it refuses to fail open. Check the trajectory DB (sqlite3 error on read).",
      DB_RETRY_FIX
    )}
`;
    WAIVER_UNRECORDED_DENY = `${denyJson(
      "BLOCKED: trajectory DB unavailable \u2014 the verification-gate waiver could not be recorded, so it cannot be honoured.",
      { allowed: "the same call again, once the trajectory DB is writable" }
    )}
`;
  }
});

// src/tools/env-gate.ts
var init_env_gate = __esm({
  async "src/tools/env-gate.ts"() {
    "use strict";
    await init_swe_verification_gate();
    init_git_objects();
    init_git_run();
    init_timeouts();
    init_worktree_deps();
    init_worktree_setup();
    init_freshness();
  }
});

// src/tools/verification-paths.ts
var LS_TREE_MAX_BUFFER;
var init_verification_paths = __esm({
  "src/tools/verification-paths.ts"() {
    "use strict";
    init_git_run();
    init_test_paths();
    LS_TREE_MAX_BUFFER = 64 * 1024 * 1024;
  }
});

// src/hooks/code-reviewer-spawn-note.ts
var ANCHORS, ANCHOR_RE;
var init_code_reviewer_spawn_note = __esm({
  "src/hooks/code-reviewer-spawn-note.ts"() {
    "use strict";
    init_gate();
    init_deny();
    init_jq();
    init_role();
    init_success_criteria();
    ANCHORS = ["task_id", "commit_sha", "branch_id", "repo", "repo_path", "attempt_n", "subagent_session_id"];
    ANCHOR_RE = new RegExp(`\\b(?:${ANCHORS.join("|")})\\s*=\\s*(?:'[^']*'|"[^"]*"|\`[^\`]*\`|\\S+)`, "g");
  }
});

// src/reviewer-effort.ts
var init_reviewer_effort = __esm({
  "src/reviewer-effort.ts"() {
    "use strict";
    init_code_reviewer_spawn_note();
    init_audit();
    init_config();
  }
});

// src/world-model/needs-review.ts
var init_needs_review = __esm({
  "src/world-model/needs-review.ts"() {
    "use strict";
    init_agent_scope();
  }
});

// src/tools/world_model.ts
var PATCH_ID_MAX_BUFFER, TREE_FIELDS, FILE_FIELDS, VALID_FIELDS, REPO_RESOLUTION_DOC, REPO_DEFAULT_DOC, REPO_ALL_DOC;
var init_world_model = __esm({
  "src/tools/world_model.ts"() {
    "use strict";
    init_agent_scope();
    init_audit();
    init_graph();
    init_store();
    init_backfill();
    init_repo_paths();
    init_git_refs();
    init_git_run();
    init_timeouts();
    init_untrusted();
    init_git_objects();
    init_test_paths();
    init_logger();
    init_freshness();
    init_needs_review();
    init_symbol_index();
    init_concepts();
    PATCH_ID_MAX_BUFFER = 256 * 1024 * 1024;
    TREE_FIELDS = [
      "path",
      "summary",
      "summary_source",
      "summary_updated_at",
      "file_count",
      "summary_sha",
      "commits_behind",
      "dead_refs",
      "trust",
      "covered_by",
      "covered_by_truncated",
      "children",
      "files"
    ];
    FILE_FIELDS = ["path", "purpose", "purpose_source", "content_md5"];
    VALID_FIELDS = /* @__PURE__ */ new Set([...TREE_FIELDS, ...FILE_FIELDS]);
    REPO_RESOLUTION_DOC = "Omitted, it defaults to the registered repo whose path contains the server's cwd (the deepest one), else the sole registered repo; repo_source in the result says which ('arg', 'cwd' or 'sole').";
    REPO_DEFAULT_DOC = `${REPO_RESOLUTION_DOC} With two or more repos and no match, returns warning 'repo-unspecified' with available_repos.`;
    REPO_ALL_DOC = `${REPO_RESOLUTION_DOC} With two or more repos and no match, it searches every repo, with repo_source 'all'.`;
  }
});

// src/tools/composites.ts
function resolveRepoPath(db, repoValue) {
  const name2 = repoValue && repoValue.length > 0 ? repoValue : resolveSoleRepo(db)?.name ?? null;
  if (!name2) return null;
  const reposRow = db.get(`SELECT path FROM repos WHERE name = ?`, [name2]);
  if (!reposRow) return name2;
  return repoRowPath(db, reposRow.path);
}
function taskWorktreePath(repoPath, branchId) {
  return `${repoPath}/.claude/worktrees/${branchId.replace(/^[^/]+\//, "")}`;
}
function taskWorktreeDir(repoPath, task) {
  return task.worktree_path ? task.worktree_path : taskWorktreePath(repoPath, task.branch_id);
}
var init_composites = __esm({
  async "src/tools/composites.ts"() {
    "use strict";
    init_db2();
    init_agent_scope();
    init_tasks();
    init_discussions();
    init_audit();
    init_agent_runs();
    init_containment();
    init_lifecycle();
    init_issues();
    init_issue_sync();
    init_milestones();
    init_timeouts();
    init_git_refs();
    init_git_objects();
    init_logger();
    init_freshness();
    init_repo_paths();
    init_worktree_deps();
    init_worktree_setup();
    await init_swe_verification_gate();
    await init_env_gate();
    init_verification_runs();
    init_verification_defaults();
    init_verification_paths();
    init_checkpoint();
    init_success_criteria();
    init_config();
    init_reopen();
    init_task_rework();
    init_effort_ab();
    init_reviewer_effort();
    init_effort_inputs();
    init_brief_locations();
    init_world_model();
  }
});

// src/tools/agent-runs-backfill.ts
var agent_runs_backfill_exports = {};
__export(agent_runs_backfill_exports, {
  agentRunsBackfill: () => agentRunsBackfill,
  agentRunsBackfillTools: () => agentRunsBackfillTools,
  defaultTranscriptsDir: () => defaultTranscriptsDir,
  spawnStats: () => spawnStats,
  taskIdFromTranscript: () => taskIdFromTranscript2
});
import { existsSync as existsSync6, readdirSync as readdirSync4, readFileSync as readFileSync11, statSync as statSync10 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { basename as basename7, join as join12 } from "node:path";
function readRecords(path) {
  let text;
  try {
    text = readFileSync11(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
    } catch {
      continue;
    }
  }
  return out;
}
function messageOf(r) {
  const m = r["message"];
  return m && typeof m === "object" && !Array.isArray(m) ? m : null;
}
function taskIdFromTranscript2(path) {
  let text;
  try {
    text = readFileSync11(path, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return null;
    }
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return null;
    const msg = rec["message"];
    if (msg !== void 0 && msg !== null && (typeof msg !== "object" || Array.isArray(msg))) return null;
    const raw = msg ? msg["content"] : void 0;
    const content = raw === void 0 || raw === null || raw === false ? [] : raw;
    const s = typeof content === "string" ? content : JSON.stringify(content);
    const m = /task_id=([0-9]+)/.exec(s);
    if (m) return Number(m[1]);
  }
  return null;
}
function isoMs(v) {
  if (typeof v !== "string") return null;
  const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.([0-9]+))?Z$/.exec(v);
  if (!m) return null;
  return `${m[1]}.${((m[3] ?? "") + "000").slice(0, 3)}Z`;
}
function nonNegInt(v) {
  return typeof v === "number" && v >= 0 ? Math.floor(v) : 0;
}
function modelId(v) {
  if (typeof v !== "string" || v.startsWith("<")) return "";
  return v.replace(/[^A-Za-z0-9._:@/[\]-]/g, "");
}
function toolUseCount(r) {
  const content = messageOf(r)?.["content"];
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b && typeof b === "object" && b["type"] === "tool_use").length;
}
function usageOf(u) {
  const o = u && typeof u === "object" ? u : {};
  return {
    ti: nonNegInt(o["input_tokens"]),
    to: nonNegInt(o["output_tokens"]),
    cr: nonNegInt(o["cache_read_input_tokens"]),
    cc: nonNegInt(o["cache_creation_input_tokens"])
  };
}
function usageTotal(u) {
  return u.ti + u.to + u.cr + u.cc;
}
function messageKey(r, i) {
  const id = messageOf(r)?.["id"] ?? r["uuid"];
  return id === void 0 || id === null || id === false ? `line-${i}` : String(id);
}
function dominantModel(msgs) {
  const byModel = /* @__PURE__ */ new Map();
  for (const x of msgs) {
    if (x.m === "") continue;
    byModel.set(x.m, (byModel.get(x.m) ?? 0) + usageTotal(x.u));
  }
  const ranked = [...byModel].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return ranked[0]?.[0] ?? null;
}
function spawnStats(records) {
  const stamps = records.map((r) => isoMs(r["timestamp"])).filter((s) => s !== null).sort();
  const groups = /* @__PURE__ */ new Map();
  records.forEach((r, i) => {
    const msg = messageOf(r);
    if (!msg || msg["usage"] === void 0 || msg["usage"] === null) return;
    groups.set(messageKey(r, i), { u: usageOf(msg["usage"]), m: modelId(msg["model"]) });
  });
  const msgs = [...groups.values()];
  const sum = (k) => msgs.reduce((a, x) => a + x.u[k], 0);
  const first = stamps[0] ?? null;
  const last = stamps[stamps.length - 1] ?? null;
  return {
    ti: sum("ti"),
    to: sum("to"),
    cr: sum("cr"),
    cc: sum("cc"),
    tool_uses: records.reduce((a, r) => a + toolUseCount(r), 0),
    duration_ms: stamps.length < 2 ? 0 : Date.parse(last) - Date.parse(first),
    first_ts: first,
    last_ts: last,
    model: dominantModel(msgs)
  };
}
function normalizeRole2(v) {
  return typeof v === "string" && v !== "" ? v.slice(v.indexOf(":") + 1) : null;
}
function sessionSpawnTypes(records) {
  const byToolUse = /* @__PURE__ */ new Map();
  const out = /* @__PURE__ */ new Map();
  for (const r of records) {
    const content = messageOf(r)?.["content"];
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.["type"] === "tool_use" && typeof b["id"] === "string") {
        const t = b["input"]?.["subagent_type"];
        if (typeof t === "string") byToolUse.set(b["id"], t);
      }
    }
  }
  for (const r of records) {
    const agentId = r["toolUseResult"]?.["agentId"];
    const content = messageOf(r)?.["content"];
    if (typeof agentId !== "string" || !Array.isArray(content)) continue;
    for (const b of content) {
      const t = typeof b?.["tool_use_id"] === "string" ? byToolUse.get(b["tool_use_id"]) : void 0;
      if (t) out.set(agentId, t);
    }
  }
  return out;
}
function defaultTranscriptsDir(projectRoot2) {
  const configDir2 = process.env["CLAUDE_CONFIG_DIR"] || join12(homedir3(), ".claude");
  return join12(configDir2, "projects", projectRoot2.replace(/[^A-Za-z0-9]/g, "-"));
}
function listTranscripts(dir) {
  const sessions = [];
  const subagents = [];
  for (const name2 of readdirSync4(dir).sort()) {
    const p = join12(dir, name2);
    if (name2.endsWith(".jsonl")) {
      sessions.push(p);
      continue;
    }
    const sub = join12(p, "subagents");
    if (!existsSync6(sub) || !statSync10(sub).isDirectory()) continue;
    for (const f of readdirSync4(sub).sort()) {
      if (/^agent-.+\.jsonl$/.test(f)) subagents.push({ path: join12(sub, f), session: name2 });
    }
  }
  return { sessions, subagents };
}
function spawnAgentType(path, sessionTypes) {
  const meta = path.replace(/\.jsonl$/, ".meta.json");
  if (existsSync6(meta)) {
    try {
      const t = normalizeRole2(JSON.parse(readFileSync11(meta, "utf8"))["agentType"]);
      if (t) return t;
    } catch {
    }
  }
  return normalizeRole2(sessionTypes?.get(agentIdOf(path)));
}
function agentIdOf(path) {
  return basename7(path).replace(/^agent-/, "").replace(/\.jsonl$/, "");
}
function isMeasured(r) {
  if (r.usage_source !== null && MEASURED_SOURCES.has(r.usage_source)) return true;
  if (r.usage_source === "unmeasured") return false;
  return (r.tokens_in ?? 0) + (r.tokens_out ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_creation_tokens ?? 0) > 0;
}
function exitReasonFor(status) {
  if (status === "completed" || status === "closed" || status === "needs_validation") return "completed";
  if (status === "escalated") return "escalated";
  return "failed";
}
function agentRunsBackfill(db, opts) {
  const { sessions, subagents } = listTranscripts(opts.transcriptsDir);
  const report = {
    dry_run: opts.dryRun,
    transcripts_dir: opts.transcriptsDir,
    transcripts_seen: 0,
    sessions_seen: 0,
    bound: 0,
    unbound: { count: 0, first: [] },
    rows_inserted: 0,
    rows_updated: 0,
    rows_skipped_measured: 0,
    tokens_total_added: 0
  };
  const writes = [];
  const unbound = (path, reason) => {
    report.unbound.count++;
    if (report.unbound.first.length < UNBOUND_SAMPLE) report.unbound.first.push({ path, reason });
  };
  const sessionRecords = /* @__PURE__ */ new Map();
  for (const p of sessions) sessionRecords.set(basename7(p, ".jsonl"), readRecords(p));
  const spawnTypes = /* @__PURE__ */ new Map();
  const claimedRunIds = /* @__PURE__ */ new Set();
  for (const { path, session } of subagents) {
    const records = readRecords(path);
    const stats = spawnStats(records);
    if (opts.since && (stats.last_ts === null || stats.last_ts < opts.since)) continue;
    report.transcripts_seen++;
    if (!spawnTypes.has(session)) spawnTypes.set(session, sessionSpawnTypes(sessionRecords.get(session) ?? []));
    const agentType = spawnAgentType(path, spawnTypes.get(session));
    if (!agentType || !BACKFILL_AGENTS.has(agentType)) {
      unbound(path, `subagent_type ${agentType ?? "unknown"} is not swe or code-reviewer`);
      continue;
    }
    const taskId = taskIdFromTranscript2(path);
    if (taskId === null) {
      unbound(path, "no task_id=<N> in the spawn prompt");
      continue;
    }
    const task = db.get(
      "SELECT id, issue_id, branch_id, status, repo, worktree_path FROM tasks WHERE id = ?",
      [taskId]
    );
    if (!task) {
      unbound(path, `task_id=${taskId} has no task row`);
      continue;
    }
    if (stats.first_ts === null || stats.last_ts === null) {
      unbound(path, "transcript carries no timestamps");
      continue;
    }
    report.bound++;
    const keyed = db.get(
      "SELECT " + RUN_COLS + " FROM agent_runs WHERE task_id = ? AND spawn_id IN (?, ?) ORDER BY id LIMIT 1",
      [task.id, path, agentIdOf(path)]
    );
    const inWindow = keyed ? [] : db.all(
      "SELECT " + RUN_COLS + ` FROM agent_runs
              WHERE task_id = ? AND agent_type = ? AND spawn_id IS NULL
                AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-2 seconds') AND started_at <= ?
              ORDER BY id DESC`,
      [task.id, agentType, stats.first_ts, stats.last_ts]
    ).filter((r) => !claimedRunIds.has(r.id));
    const target = keyed ?? inWindow.find((r) => !isMeasured(r)) ?? inWindow[0];
    if (target && isMeasured(target)) {
      report.rows_skipped_measured++;
      continue;
    }
    const tokens = usageTotal(stats);
    report.tokens_total_added += tokens;
    const repoPath = resolveRepoPath(db, task.repo);
    const rootDir = repoPath?.startsWith("/") ? taskWorktreeDir(repoPath, task) : null;
    if (target) {
      claimedRunIds.add(target.id);
      report.rows_updated++;
      writes.push({
        kind: "update_spawn",
        id: target.id,
        values: [
          stats.ti,
          stats.to,
          stats.cr,
          stats.cc,
          stats.tool_uses,
          stats.duration_ms,
          stats.first_ts,
          stats.last_ts,
          path,
          session,
          stats.model,
          rootDir,
          exitReasonFor(task.status),
          target.id
        ]
      });
    } else {
      report.rows_inserted++;
      writes.push({
        kind: "insert",
        values: [
          task.id,
          task.issue_id,
          agentType,
          stats.ti,
          stats.to,
          stats.cr,
          stats.cc,
          stats.tool_uses,
          stats.duration_ms,
          stats.first_ts,
          stats.last_ts,
          task.repo,
          path,
          session,
          stats.model,
          rootDir,
          exitReasonFor(task.status)
        ]
      });
    }
  }
  for (const records of sessionRecords.values()) {
    const stamps = records.map((r) => isoMs(r["timestamp"])).filter((s) => s !== null).sort();
    const last = stamps[stamps.length - 1];
    if (last !== void 0 && (!opts.since || last >= opts.since)) report.sessions_seen++;
  }
  if (!opts.dryRun) {
    db.transaction(() => {
      applyWrites(db, writes);
      insertAudit(db, {
        issue_id: -1,
        from_node: "bro",
        event_type: "agent_runs_backfilled",
        summary: `agent_runs backfill: ${report.rows_inserted} inserted, ${report.rows_updated} updated from ${report.transcripts_seen} transcripts`,
        content_json: JSON.stringify(report),
        created_at: opts.now
      });
    });
  }
  return report;
}
function applyWrites(db, writes) {
  for (const w of writes) {
    if (w.kind === "insert") {
      db.run(
        `INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens,
                                 cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at, repo,
                                 spawn_id, session_id, usage_source, model, host, root_dir, exit_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill', ?, 'claude', ?, ?)`,
        w.values
      );
    } else {
      db.run(
        `UPDATE agent_runs
            SET tokens_in = ?, tokens_out = ?, cache_read_tokens = ?, cache_creation_tokens = ?,
                tool_uses = ?, duration_ms = ?,
                started_at = COALESCE(started_at, ?), completed_at = ?,
                spawn_id = COALESCE(spawn_id, ?), session_id = COALESCE(session_id, ?),
                usage_source = 'backfill', model = COALESCE(?, model), host = COALESCE(host, 'claude'),
                root_dir = COALESCE(root_dir, ?), exit_reason = COALESCE(exit_reason, ?)
          WHERE id = ?`,
        w.values
      );
    }
  }
}
function okResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
function errResult(message3) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message3 }) }], isError: true };
}
function agentRunsBackfillTools(db, dbPath2) {
  const definitions = [
    {
      name: "agent_runs_backfill",
      description: "Recover swe/code-reviewer agent_runs from Claude Code transcripts on disk as usage_source='backfill'; leaves bro rows and measured rows alone; idempotent.",
      inputSchema: {
        type: "object",
        properties: {
          dry_run: { type: "boolean", description: "Report only, write nothing (default true)." },
          since: { type: "string", description: "ISO timestamp: skip transcripts whose last message is older." },
          transcripts_dir: { type: "string", description: "Override ~/.claude/projects/<project-slug>." }
        }
      }
    }
  ];
  const handlers = {
    agent_runs_backfill: requireRoles("agent_runs_backfill", ["bro"], async (args) => {
      try {
        const dryRun2 = args["dry_run"] !== false;
        const sinceArg = args["since"];
        let since = null;
        if (sinceArg !== void 0 && sinceArg !== null) {
          const t = typeof sinceArg === "string" ? Date.parse(sinceArg) : NaN;
          if (Number.isNaN(t)) return errResult("since must be an ISO timestamp");
          since = new Date(t).toISOString();
        }
        let dir = typeof args["transcripts_dir"] === "string" && args["transcripts_dir"] !== "" ? args["transcripts_dir"] : null;
        if (dir === null) {
          const root = projectRootFromDbPath(dbPath2 || db.dbPath);
          if (!root) return errResult("no project root for this DB; pass transcripts_dir");
          dir = defaultTranscriptsDir(root);
        }
        if (!existsSync6(dir) || !statSync10(dir).isDirectory()) return errResult(`transcripts_dir not found: ${dir}`);
        return okResult(agentRunsBackfill(db, { dryRun: dryRun2, since, transcriptsDir: dir, now: (/* @__PURE__ */ new Date()).toISOString() }));
      } catch (e) {
        return errResult(e.message);
      }
    })
  };
  return { definitions, handlers };
}
var UNBOUND_SAMPLE, BACKFILL_AGENTS, RUN_COLS, MEASURED_SOURCES;
var init_agent_runs_backfill = __esm({
  async "src/tools/agent-runs-backfill.ts"() {
    "use strict";
    init_agent_scope();
    init_audit();
    init_containment();
    await init_composites();
    UNBOUND_SAMPLE = 20;
    BACKFILL_AGENTS = /* @__PURE__ */ new Set(["swe", "code-reviewer"]);
    RUN_COLS = "id, task_id, agent_type, started_at, completed_at, spawn_id, session_id, usage_source, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens";
    MEASURED_SOURCES = /* @__PURE__ */ new Set(["transcript", "subagent_stop", "backfill"]);
  }
});

// src/prose-files.ts
function isProseFile(path) {
  return PROSE_SUFFIX.test(path);
}
var PROSE_SUFFIX;
var init_prose_files = __esm({
  "src/prose-files.ts"() {
    "use strict";
    PROSE_SUFFIX = /\.(md|markdown|txt|rst)$/i;
  }
});

// src/utils/plugin-installs.ts
import { readFileSync as readFileSync18, realpathSync as realpathSync6 } from "node:fs";
import { join as join15 } from "node:path";
function claudeConfigDir(env) {
  return env["CLAUDE_CONFIG_DIR"] || join15(env["HOME"] || "", ".claude");
}
function installedPluginsJsonPath(env = process.env) {
  return env["TMB_INSTALLED_JSON"] || join15(claudeConfigDir(env), "plugins", "installed_plugins.json");
}
function canonicalDir2(dir) {
  try {
    return realpathSync6(dir);
  } catch {
    return dir;
  }
}
function readJsonObject(path) {
  try {
    const parsed = JSON.parse(readFileSync18(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function enabledMap(project, env) {
  const files = [
    join15(claudeConfigDir(env), "settings.json"),
    join15(project, ".claude", "settings.json"),
    join15(project, ".claude", "settings.local.json")
  ];
  const merged = {};
  for (const file of files) {
    const plugins = readJsonObject(file)?.["enabledPlugins"];
    if (plugins !== null && typeof plugins === "object" && !Array.isArray(plugins)) Object.assign(merged, plugins);
  }
  return merged;
}
function enabledPluginCopies(env = process.env) {
  const projectRoot2 = resolveClaudeProjectRoot(env);
  if (projectRoot2 === null) return { skipped: "CLAUDE_PROJECT_DIR is unset" };
  const registryPath = installedPluginsJsonPath(env);
  const registry = readJsonObject(registryPath);
  if (registry === null) return { skipped: `cannot read ${registryPath}` };
  const project = canonicalDir2(projectRoot2);
  const enabled = enabledMap(project, env);
  const prefix = `${resolveClaudePluginName(env)}@`;
  const plugins = registry["plugins"];
  const copies = [];
  if (plugins === null || typeof plugins !== "object") return { copies };
  for (const [key, entries] of Object.entries(plugins)) {
    if (!key.startsWith(prefix) || enabled[key] !== true || !Array.isArray(entries)) continue;
    let chosen = null;
    for (const raw of entries) {
      if (raw === null || typeof raw !== "object") continue;
      const e = raw;
      const scope = str(e["scope"]) ?? "user";
      let rank = 1;
      if (scope === "project" || scope === "local") {
        const projectPath = str(e["projectPath"]);
        if (projectPath === null || canonicalDir2(projectPath) !== project) continue;
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
var str;
var init_plugin_installs = __esm({
  "src/utils/plugin-installs.ts"() {
    "use strict";
    init_platform();
    str = (v) => typeof v === "string" && v !== "" ? v : null;
  }
});

// src/data-contracts.ts
import { readdirSync as readdirSync7 } from "node:fs";
import { dirname as dirname6, join as join16 } from "node:path";
function singleTmbPluginEnabled(env) {
  const result = enabledPluginCopies(env);
  if ("skipped" in result) return { skipped: result.skipped };
  return { actual: result.copies.length, sample: result.copies.map((c) => ({ ...c })) };
}
function noOtherTrajectoryDbs(env, ctx) {
  const dbPath2 = ctx.dbPath;
  if (dbPath2 === void 0 || claudeProjectRootOfDb(dbPath2) === null) {
    return { skipped: "the checked DB is not a <project>/.claude/<plugin>/trajectory.db file" };
  }
  const others = otherClaudeDbs(dbPath2, {
    sessionDir: env["CLAUDE_PROJECT_DIR"] || process.cwd(),
    ...env["HOME"] ? { home: env["HOME"] } : {}
  });
  if (others === null) return { skipped: "the checked DB has no project root" };
  return {
    actual: others.length,
    sample: others.map((o) => ({ path: o.path, issues: o.issues, tasks: o.tasks }))
  };
}
function scratchNoProse(_env, ctx) {
  if (ctx.dbPath === void 0) return { skipped: "the checked DB has no file behind it" };
  const scratch = join16(dirname6(ctx.dbPath), "scratch");
  let entries;
  try {
    entries = readdirSync7(scratch, { recursive: true, withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return { actual: 0, sample: [] };
    return { skipped: `the scratch folder cannot be read: ${e.message}` };
  }
  const prose = entries.filter((e) => !e.isDirectory() && isProseFile(e.name)).map((e) => join16(e.parentPath, e.name)).sort();
  return { actual: prose.length, sample: prose.slice(0, SCRATCH_PROSE_SAMPLE).map((path) => ({ path })) };
}
function populatedContract(c) {
  const where = [
    `${ts(c.created_column)} >= ${daysAgo(30)}`,
    ...c.writer_since ? [`${ts(c.created_column)} >= ${c.writer_since.sql}`] : [],
    ...c.table === "agent_runs" ? [NOT_PER_TASK_BRO_ROW] : [],
    ...c.scope ? [c.scope] : []
  ].join(" AND ");
  const since = c.writer_since ? ` and not before ${c.writer_since.label}` : "";
  const excluded2 = c.table === "agent_runs" ? ", per-task bro rows excluded" : "";
  const minSchema = Math.max(c.min_schema, c.writer_since?.min_schema ?? 0);
  return {
    id: `populated_${c.table}_${c.column}`,
    severity: "warn",
    description: `${c.table}.${c.column} NULL rate over ${c.scope_label ?? "rows"} created in the last 30 days${since}${excluded2} stays at or under ${c.floor}`,
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
var SCRATCH_PROSE_SAMPLE, daysAgo, hoursAgo, ts, auditTaskId, auditCommitSha, SPEC_SHAPE_WAIVER_NOT_READ_BY_GATE, REVIEW_GRACE_HOURS_DEFAULT, UNREVIEWED_CLOSED_TASK, NOT_AGILE_TASK, runMatchesTaskCommit, V36_RECORDING_SINCE, VERIFIED_CLOSE_SCOPE, UNCONSUMED_STALE_OBSERVATION, LIVE_TASK_STATUSES2, CONCEPTS_SCHEMA, COMPLETION_REPORT_SCHEMA, PENDING_PROPOSAL_DAYS, CONCEPTS_MIN_SYMBOLS, SYMBOLS_SCHEMA, UNINDEXED_SAMPLE_CAP, IN_SYMBOL_SCOPE_SQL, UNINDEXED_FILES, auditField, PENDING_PROPOSALS, CONCEPT_AREA_MIN_FAN_IN_DEFAULT, areaOf, notTestPath, UNCOVERED_HOT_AREAS, UNCONCEPTUALIZED_REPOS, FIXTURE_INVENTORY_ROW, V33_RUN_WRITERS_SINCE, NOT_PER_TASK_BRO_ROW, BRO_SESSION_ROW, POPULATED_COLUMNS, DATA_CONTRACTS, DATA_CONTRACTS_SCHEMA_VERSION;
var init_data_contracts = __esm({
  "src/data-contracts.ts"() {
    "use strict";
    init_audit_events();
    init_review_sql();
    init_lifecycle();
    init_platform();
    init_prose_files();
    init_plugin_installs();
    init_symbol_index();
    SCRATCH_PROSE_SAMPLE = 10;
    daysAgo = (days) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${days} days')`;
    hoursAgo = (hours) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${hours} hours')`;
    ts = (column) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column})`;
    auditTaskId = (alias) => `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.task_id') END`;
    auditCommitSha = (alias) => `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.commit_sha') END`;
    SPEC_SHAPE_WAIVER_NOT_READ_BY_GATE = (alias) => `${alias}.event_type = 'spec_shape_gate_waived'
               AND (NOT EXISTS (SELECT 1 FROM tasks t
                                 WHERE t.id = CAST(${auditTaskId(alias)} AS INTEGER)
                                   AND CAST(CAST(${auditTaskId(alias)} AS INTEGER) AS TEXT) = CAST(${auditTaskId(alias)} AS TEXT))
                    OR COALESCE(CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.gate') END, '') <> 'spec_shape')`;
    REVIEW_GRACE_HOURS_DEFAULT = 24;
    UNREVIEWED_CLOSED_TASK = (alias) => `${alias}.status = 'closed' AND ${ts(`${alias}.updated_at`)} >= ${daysAgo(30)}
               AND ${ts(`${alias}.updated_at`)} < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-' || :grace_hours || ' hours')
               AND NOT EXISTS (SELECT 1 FROM validation_attempts v WHERE v.task_id = ${alias}.id AND v.verdict = 'pass')
               AND NOT EXISTS (SELECT 1 FROM audit a WHERE ${reviewSkipAuthoredSql("a")}
                                AND ${auditTaskId("a")} = ${alias}.id)`;
    NOT_AGILE_TASK = (alias) => `COALESCE(${alias}.workflow_mode, 'truest') <> 'agile'`;
    runMatchesTaskCommit = (run2, task) => `${run2}.task_id = ${task}.id AND substr(${run2}.commit_sha, 1, length(${task}.commit_sha)) = ${task}.commit_sha`;
    V36_RECORDING_SINCE = `(SELECT MIN(${ts("started_at")}) FROM verification_runs)`;
    VERIFIED_CLOSE_SCOPE = `t.status = 'closed' AND ${ts("t.updated_at")} >= ${daysAgo(7)}
               AND ${ts("t.updated_at")} >= ${V36_RECORDING_SINCE}
               AND COALESCE(t.commit_sha, '') <> '' AND COALESCE(t.verification, '[]') NOT IN ('', '[]')
               AND NOT EXISTS (SELECT 1 FROM audit w WHERE w.event_type = 'verification_gate_waived' AND ${auditTaskId("w")} = t.id)`;
    UNCONSUMED_STALE_OBSERVATION = (alias) => `${alias}.event_type = 'reviewer_identity_observed' AND ${ts(`${alias}.created_at`)} < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hours')
               AND COALESCE(CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.consumed') END, 0) = 0
               AND COALESCE(CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.superseded') END, 0) = 0`;
    LIVE_TASK_STATUSES2 = "'pending','running','needs_validation','completed'";
    CONCEPTS_SCHEMA = 45;
    COMPLETION_REPORT_SCHEMA = 48;
    PENDING_PROPOSAL_DAYS = 7;
    CONCEPTS_MIN_SYMBOLS = 100;
    SYMBOLS_SCHEMA = 44;
    UNINDEXED_SAMPLE_CAP = 20;
    IN_SYMBOL_SCOPE_SQL = `NOT (path GLOB 'dist/*' OR path GLOB '*/dist/*' OR path GLOB '*.map'
               OR path GLOB 'build/*' OR path GLOB '*/build/*'
               OR path GLOB 'node_modules/*' OR path GLOB '*/node_modules/*'
               OR path GLOB 'vendor/*' OR path GLOB '*/vendor/*' OR path GLOB '*.min.js'
               OR path = 'package-lock.json' OR path GLOB '*/package-lock.json'
               OR path GLOB '*.lock' OR path GLOB '*.lockb')`;
    UNINDEXED_FILES = `wm_files WHERE ${IN_SYMBOL_SCOPE_SQL}
               AND symbols_md5 IS NOT content_md5 || ':' || '${EXTRACTOR_VERSION}'`;
    auditField = (alias, field2) => `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.${field2}') END`;
    PENDING_PROPOSALS = `tasks t,
               json_each(CASE WHEN json_valid(t.completion_report) THEN t.completion_report ELSE '{}' END, '$.concepts') c
             WHERE t.status = 'closed' AND ${ts("t.updated_at")} < ${daysAgo(PENDING_PROPOSAL_DAYS)}
               AND ${HAS_PASS_SQL}
               AND NOT EXISTS (SELECT 1 FROM audit p
                                WHERE p.event_type IN ('concept_proposal_applied','concept_proposal_rejected')
                                  AND ${auditField("p", "task_id")} = t.id
                                  AND ${auditField("p", "name")} = json_extract(c.value, '$.name'))`;
    CONCEPT_AREA_MIN_FAN_IN_DEFAULT = 50;
    areaOf = (path) => `rtrim(${path}, replace(${path}, '/', ''))`;
    notTestPath = (path) => `${path} NOT LIKE '%test/%' AND ${path} NOT LIKE '%.test.%'`;
    UNCOVERED_HOT_AREAS = `(SELECT d.repo AS repo, ${areaOf("d.path")} AS area, COUNT(*) AS fan_in
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
    UNCONCEPTUALIZED_REPOS = `(SELECT repo, COUNT(*) AS symbols FROM wm_symbols GROUP BY repo HAVING COUNT(*) >= ${CONCEPTS_MIN_SYMBOLS}) s
             WHERE NOT EXISTS (SELECT 1 FROM wm_concepts k WHERE k.repo = s.repo AND k.status <> 'retired')`;
    FIXTURE_INVENTORY_ROW = (alias) => `${alias}.kind IN ('plugin','mcp')
               AND (${alias}.name IN ('alpha','beta','alpha-server')
                    OR ${alias}.name GLOB 'fixture-*' OR ${alias}.name GLOB 'test-plugin*'
                    OR COALESCE(${alias}.source_url, '') LIKE '%@tmb-test-market')`;
    V33_RUN_WRITERS_SINCE = {
      sql: `(SELECT MIN(${ts("started_at")}) FROM agent_runs WHERE root_dir IS NOT NULL)`,
      label: "the first run carrying a root_dir",
      min_schema: 33
    };
    NOT_PER_TASK_BRO_ROW = "NOT (agent_type = 'bro' AND task_id IS NOT NULL)";
    BRO_SESSION_ROW = "agent_type = 'bro' AND task_id IS NULL";
    POPULATED_COLUMNS = [
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
    DATA_CONTRACTS = buildDataContracts(AUDIT_EVENT_TYPES.map((e) => e.type));
    DATA_CONTRACTS_SCHEMA_VERSION = Math.max(0, ...DATA_CONTRACTS.map((c) => c.min_schema ?? 0));
  }
});

// src/tools/trajectory-doctor.ts
var trajectory_doctor_exports = {};
__export(trajectory_doctor_exports, {
  STATEMENT_TIMEOUT_MS_DEFAULT: () => STATEMENT_TIMEOUT_MS_DEFAULT,
  checkTrajectoryDbFile: () => checkTrajectoryDbFile,
  runDataContracts: () => runDataContracts,
  selectContracts: () => selectContracts,
  statementTimeoutMs: () => statementTimeoutMs,
  trajectoryDbReader: () => trajectoryDbReader,
  trajectoryDoctorTools: () => trajectoryDoctorTools,
  wmFeedbackCounts: () => wmFeedbackCounts
});
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";
function wmFeedbackCounts(db) {
  const row = db.get(
    `SELECT COUNT(*) AS reports,
            COALESCE(SUM(TRIM(COALESCE(json_extract(content_json, '$.missed'), '')) <> ''), 0) AS missed,
            COALESCE(SUM(TRIM(COALESCE(json_extract(content_json, '$.wrong'), '')) <> ''), 0) AS wrong
       FROM audit WHERE event_type = 'wm_feedback' AND json_valid(content_json)`
  );
  return { reports: Number(row?.reports ?? 0), missed: Number(row?.missed ?? 0), wrong: Number(row?.wrong ?? 0) };
}
function trajectoryDbReader(db) {
  return {
    get: (sql, params) => db.get(sql, bind(params)),
    all: (sql, params) => db.all(sql, bind(params))
  };
}
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
function firstNumber(row) {
  if (row === void 0) return null;
  const value = Object.values(row)[0];
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
function openReadOnly(dbPath2, timeoutMs) {
  if (!dbPath2 || dbPath2 === ":memory:") return null;
  for (const readOnly of [true, false]) {
    let conn = null;
    try {
      conn = new DatabaseSync3(dbPath2, { readOnly });
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
function checkTrajectoryDbFile(dbPath2, contracts = DATA_CONTRACTS, opts = {}) {
  const timeoutMs = statementTimeoutMs(opts.env);
  const conn = openReadOnly(dbPath2, timeoutMs);
  if (!conn) throw new Error(`cannot open ${dbPath2} read-only`);
  try {
    return runDataContracts(sqliteReader(conn), contracts, { statementTimeoutMs: timeoutMs, env: opts.env, dbPath: dbPath2 });
  } finally {
    conn.close();
  }
}
function ok2(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
function err(message3, extra = {}) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message3, ...extra }) }], isError: true };
}
function trajectoryDoctorTools(db) {
  const definitions = [
    {
      name: "trajectory_doctor",
      description: "Check the trajectory DB against its data contracts. Returns {healthy, violations, skipped, embeddings, wm_feedback {reports, missed, wrong}}: counts of wm_feedback audit rows and of those with a non-empty missed / wrong.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          record: { type: "boolean", description: "Write one trajectory_doctor_run audit row with the report. Default false." },
          ids: { type: "array", items: { type: "string" }, description: "Run only these contract ids." }
        },
        required: ["agent"]
      }
    }
  ];
  const handler = async (args) => {
    const record = args["record"] === true;
    const selected = selectContracts(args["ids"]);
    if ("error" in selected) {
      const { error, ...extra } = selected;
      return err(error, extra);
    }
    const contracts = selected.contracts;
    const timeoutMs = statementTimeoutMs();
    const ro = openReadOnly(db.dbPath, timeoutMs);
    let report;
    try {
      report = runDataContracts(ro ? sqliteReader(ro) : trajectoryDbReader(db), contracts, {
        statementTimeoutMs: timeoutMs,
        dbPath: db.dbPath
      });
    } finally {
      ro?.close();
    }
    report.embeddings = embeddingStatus();
    report.wm_feedback = wmFeedbackCounts(db);
    if (!record) return ok2(report);
    const auditId = insertAudit(db, {
      issue_id: -1,
      from_node: "bro",
      event_type: "trajectory_doctor_run",
      summary: report.healthy ? `trajectory_doctor: healthy (${report.violations.length} warn violation(s), ${report.skipped.length} skipped)` : `trajectory_doctor: unhealthy \u2014 ${report.violations.length} violation(s), ${report.skipped.length} skipped`,
      content_json: JSON.stringify(report)
    });
    return ok2({ ...report, audit_id: auditId });
  };
  return {
    definitions,
    handlers: {
      trajectory_doctor: requireRoles("trajectory_doctor", ["bro"], async (args) => {
        try {
          return await handler(args);
        } catch (e) {
          return err(e.message);
        }
      })
    }
  };
}
var STATEMENT_TIMEOUT_MS_DEFAULT, bind;
var init_trajectory_doctor = __esm({
  "src/tools/trajectory-doctor.ts"() {
    "use strict";
    init_db2();
    init_agent_scope();
    init_audit();
    init_model();
    init_data_contracts();
    STATEMENT_TIMEOUT_MS_DEFAULT = 2e3;
    bind = (params) => Object.keys(params).length > 0 ? [params] : [];
  }
});

// src/cli/assert-sql.ts
init_db();
init_sqlite_shell();
import { closeSync as closeSync2, existsSync as existsSync3, mkdtempSync, openSync as openSync2, readSync as readSync2, rmSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";

// src/cli/fallback-db.ts
init_db();
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
  const err2 = e;
  const text = err2 && typeof err2.message === "string" ? err2.message : String(e);
  const code = err2 && typeof err2.errcode === "number" ? err2.errcode & 255 : 0;
  return code > 1 ? `${text} (${code})` : text;
}
function openSnapshot(db, env) {
  const { DatabaseSync: DatabaseSync4 } = loadNodeSqlite();
  const src = !existsSync3(`${db}-wal`) && walModeHeader(db) ? `file:${uriPath(db)}?immutable=1` : db;
  const dir = mkdtempSync(`${(env.TMPDIR || "/tmp").replace(/\/+$/, "")}/assert-sql.`);
  try {
    const snap = `${dir}/ref.db`;
    const source = new DatabaseSync4(src, { readOnly: true, timeout: SNAPSHOT_TIMEOUT_MS });
    try {
      source.prepare("VACUUM INTO ?").run(snap);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync4(snap);
    try {
      copy.exec("PRAGMA journal_mode=DELETE;");
    } finally {
      copy.close();
    }
    return new DatabaseSync4(snap, { readOnly: true });
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
  const ok3 = compare(op, out, expected);
  if (ok3 === null) {
    io2.out(`assert-sql: FAIL --op ${op} needs numbers, got '${out}' vs '${expected}': ${sql}
`);
    return 1;
  }
  if (ok3) {
    io2.out(`assert-sql: PASS '${out}' ${op} '${expected}': ${sql}
`);
    return 0;
  }
  io2.out(`assert-sql: FAIL got '${out}', want ${op} '${expected}': ${sql}
`);
  return 1;
}

// src/cli/backfill-agent-runs.ts
import { existsSync as existsSync7 } from "node:fs";
var USAGE2 = `Recover agent_runs rows from the Claude Code transcripts still on disk \u2014 a
terminal wrapper over the trajectory server's agent_runs_backfill tool,
called as bro. Transcripts are read, never written; the only write is to the
project's trajectory DB, and only with --apply.

Usage (from the project directory, or with TRAJECTORY_DB_PATH set):
  node --experimental-sqlite <plugin>/mcp/trajectory-server/dist/cli.js backfill-agent-runs [--apply] [--since <ISO>] [--transcripts-dir <dir>]

Without --apply it is a dry run: prints the report, writes nothing.
--transcripts-dir overrides ~/.claude/projects/<project-slug>.
Exits 2 with this usage when no trajectory DB exists (nothing is created),
1 when the tool reports an error.
`;
async function backfillAgentRuns(argv2, env, io2) {
  let dryRun2 = true;
  let since = "";
  let transcriptsDir = "";
  for (let i = 0; i < argv2.length; i += 1) {
    const arg = argv2[i];
    if (arg === "--apply") dryRun2 = false;
    else if (arg === "--since" || arg === "--transcripts-dir") {
      const value = argv2[i + 1] ?? "";
      if (value === "") {
        io2.err(`backfill-agent-runs: ${arg} needs ${arg === "--since" ? "an ISO timestamp" : "a path"}
`);
        return 2;
      }
      if (arg === "--since") since = value;
      else transcriptsDir = value;
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      io2.out(USAGE2);
      return 0;
    } else {
      io2.err(`backfill-agent-runs: unknown argument: ${arg}
`);
      return 2;
    }
  }
  const { TrajectoryDB: TrajectoryDB2, resolveDbPath: resolveDbPath2 } = await Promise.resolve().then(() => (init_db2(), db_exports));
  const dbPath2 = resolveDbPath2({ env });
  if (dbPath2 === ":memory:" || !existsSync7(dbPath2)) {
    io2.err(`backfill-agent-runs: no trajectory DB at ${dbPath2}; run from the project or set TRAJECTORY_DB_PATH

${USAGE2}`);
    return 2;
  }
  const { agentRunsBackfillTools: agentRunsBackfillTools2 } = await init_agent_runs_backfill().then(() => agent_runs_backfill_exports);
  const db = new TrajectoryDB2(dbPath2);
  const args = { agent: "bro", dry_run: dryRun2 };
  if (since) args.since = since;
  if (transcriptsDir) args.transcripts_dir = transcriptsDir;
  const res = await agentRunsBackfillTools2(db, dbPath2).handlers.agent_runs_backfill(args);
  db.close();
  const first = res.content[0];
  const body2 = JSON.parse(first.type === "text" ? first.text : "");
  io2.out(`${JSON.stringify(body2, null, 2)}
`);
  return res.isError ? 1 : 0;
}

// src/cli/bro-sqlite-readonly.ts
init_db();
init_project_env();
init_sqlite_shell();
import { appendFileSync as appendFileSync2, existsSync as existsSync8, mkdirSync as mkdirSync4, mkdtempSync as mkdtempSync5, rmSync as rmSync6 } from "node:fs";

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
function errorJson(message3) {
  return `{"error":${pyDumps(message3)}}
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
    const src = existsSync8(`${this.dbPath}-wal`) ? this.dbPath : `file:${uriPath2(this.dbPath)}?immutable=1`;
    try {
      this.snapDir = mkdtempSync5(`${this.env.TMPDIR || "/tmp"}/bro-sqlite-readonly.`);
      const { DatabaseSync: DatabaseSync4 } = sqlite();
      const snap = `${this.snapDir}/snap.db`;
      const source = new DatabaseSync4(src, { readOnly: true, timeout: SNAPSHOT_TIMEOUT_MS2 });
      try {
        source.prepare("VACUUM INTO ?").run(snap);
      } finally {
        source.close();
      }
      const copy = new DatabaseSync4(snap, { timeout: SNAPSHOT_TIMEOUT_MS2 });
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
      const { DatabaseSync: DatabaseSync4 } = sqlite();
      const timeout = digitsOr2(this.env.TMB_DB_WRITE_TIMEOUT_MS || void 0, 1500);
      this.db = new DatabaseSync4(this.readDb, { readOnly: true, timeout });
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
    if (this.snapDir !== "") rmSync6(this.snapDir, { recursive: true, force: true });
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
      const countRows2 = s.rows(
        "SELECT COUNT(*) as tasks_total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as tasks_completed, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as tasks_failed FROM tasks WHERE issue_id = ?;",
        [id]
      );
      const counts = countRows2[0] ?? /* @__PURE__ */ new Map();
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
    mkdirSync4(logDir, { recursive: true });
    const ts2 = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, ".000Z");
    appendFileSync2(`${logDir}/mcp-health.log`, `{"ts":"${ts2}","kind":"fallback","tool":"${tool}","agent":"bro"}
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

// src/cli/heal-mcp-cache.ts
import {
  chmodSync,
  copyFileSync,
  lstatSync as lstatSync3,
  readdirSync as readdirSync6,
  readFileSync as readFileSync14,
  readSync as readSync3,
  renameSync,
  rmSync as rmSync7,
  statSync as statSync13,
  utimesSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { homedir as homedir4 } from "node:os";

// src/cli/health.ts
init_db();
init_host();
import { spawnSync as spawnSync3 } from "node:child_process";
import { existsSync as existsSync9, readdirSync as readdirSync5, readFileSync as readFileSync13, statSync as statSync12 } from "node:fs";
import { constants as constants7 } from "node:os";
import { fileURLToPath as fileURLToPath5 } from "node:url";

// src/hooks/lib/install.ts
init_db();
init_host();
init_jq();
init_project_env();
import { readFileSync as readFileSync12, statSync as statSync11 } from "node:fs";
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
function isDir2(path) {
  try {
    return statSync11(path).isDirectory();
  } catch {
    return false;
  }
}
function readText(path) {
  try {
    return readFileSync12(path, "utf8");
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
function isObject2(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function enabledPlugins(here, env) {
  const merged = {};
  for (const file of [`${configDir(env)}/settings.json`, `${here}/.claude/settings.json`, `${here}/.claude/settings.local.json`]) {
    for (const part of jqRows(file, (doc, push) => {
      let v = index(doc, "enabledPlugins");
      if (v === null || v === false) v = {};
      push(isObject2(v) ? v : {});
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
var LEGACY_USER_HOOKS_DOC = "docs/architecture/INSTALL.md#upgrading-into-v110--remove-leftover-user-wide-hooks";
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
  if (!isObject2(hooks)) return [];
  const out = [];
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, i) => {
      if (!isObject2(group)) return;
      const inner = group.hooks;
      if (!Array.isArray(inner)) return;
      inner.forEach((hook, j) => {
        if (isObject2(hook) && leftover(hook)) out.push(["hooks", ev, i, "hooks", j]);
      });
    });
  }
  return out;
}
function commandPaths(value, at = [], out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => commandPaths(v, [...at, i], out));
  } else if (isObject2(value)) {
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
    text = readFileSync12(settings, "utf8");
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
    if (!isDir2(p)) continue;
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
init_project_env();
var SCOPE_DOC = "docs/architecture/INSTALL.md#recommended-scope-project-or-local";
var DB_READ_TIMEOUT_MS = "500";
var MEMORY = ":memory:";
function isFile5(path) {
  try {
    return statSync12(path).isFile();
  } catch {
    return false;
  }
}
function isDir3(path) {
  try {
    return statSync12(path).isDirectory();
  } catch {
    return false;
  }
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync13(path, "utf8"));
  } catch {
    return void 0;
  }
}
function isObject3(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function jqField(doc, key, fallback) {
  if (!isObject3(doc)) return fallback;
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
  return installRoot(posixDirname(fileURLToPath5(import.meta.url))) ?? "";
}
function manifestName2(root) {
  const manifest = `${root}/.claude-plugin/plugin.json`;
  if (!isFile5(manifest)) return "tmb";
  return jqField(readJson(manifest), "name", "tmb");
}
function installEntry(installed, name2, root) {
  if (!isFile5(installed)) return null;
  const doc = readJson(installed);
  if (!isObject3(doc) || !isObject3(doc.plugins)) return null;
  const entries = [];
  for (const [key, value] of Object.entries(doc.plugins)) {
    if (!key.startsWith(`${name2}@`)) continue;
    const first = Array.isArray(value) ? value[0] ?? null : value === null ? null : void 0;
    if (first === void 0) return null;
    if (first !== null && !isObject3(first)) return null;
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
  const r = spawnSync3("pgrep", ["-f", pattern], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const signal = r.signal ? constants7.signals[r.signal] ?? 0 : 0;
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
    if (!isFile5(f)) continue;
    let text;
    try {
      text = readFileSync13(f, "utf8");
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
  if (wsRoot === "" || !isDir3(dir)) return [];
  let names;
  try {
    names = readdirSync5(dir);
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith(".") && isDir3(`${dir}/${n}`)).sort(byteCompare).map((n) => `${dir}/${n}/`);
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
  let serverLog2 = env.TMB_HEALTH_SERVER_LOG ?? "";
  if (serverLog2 === "") {
    if (db === MEMORY) {
      serverLog2 = `${(env.TMPDIR || "/tmp").replace(/\/+$/, "")}/${name2}-memory-logs/mcp-server.log`;
    } else if (db !== "") {
      serverLog2 = `${posixDirname(db)}/logs/mcp-server.log`;
    }
  }
  r.line("== TMB health-check ==");
  r.line(`db:        ${db || "<unresolved>"}`);
  r.line(`cache:     ${cacheDir || "<unresolved>"}`);
  r.line(`server-log:${serverLog2 || "<unresolved>"}`);
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
      `Forensics: tail -n 50 ${serverLog2 || `<project>/.claude/${name2}/logs/mcp-server.log`}`
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
  if (legacyGraph !== "" && existsSync9(legacyGraph)) {
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
    }
  }
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT ?? "";
  const devManifest = `${pluginRoot}/.claude-plugin/plugin.json`;
  const driftVersion = pluginRoot !== "" && isFile5(devManifest) ? jqField(readJson(devManifest), "version", "") : "";
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
      `Check the embeddings_state lines in ${serverLog2 || "mcp-server.log"}; trajectory_doctor reports the live state.`
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

// src/cli/heal-mcp-cache.ts
var PLUGIN_NAME = "tmb";
var MCP_SERVER_KEY = "plugin:tmb:trajectory-server";
var SCOPE_DOC2 = "docs/architecture/INSTALL.md#recommended-scope-project-or-local";
var EndOfInput = class extends Error {
};
function isObject4(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFile6(path) {
  try {
    return statSync13(path).isFile();
  } catch {
    return false;
  }
}
function isDir4(path) {
  try {
    return statSync13(path).isDirectory();
  } catch {
    return false;
  }
}
function readJson2(path) {
  try {
    return { ok: true, doc: JSON.parse(readFileSync14(path, "utf8")) };
  } catch {
    return { ok: false };
  }
}
function rawText(v) {
  return typeof v === "string" ? v : JSON.stringify(v);
}
function stdinLines() {
  let pending = Buffer.alloc(0);
  let ended = false;
  const chunk = Buffer.alloc(4096);
  return () => {
    for (; ; ) {
      const nl = pending.indexOf(10);
      if (nl >= 0) {
        const line = pending.subarray(0, nl).toString("utf8");
        pending = pending.subarray(nl + 1);
        return line;
      }
      if (ended) throw new EndOfInput();
      let n = 0;
      try {
        n = readSync3(0, chunk, 0, chunk.length, null);
      } catch (e) {
        if (e.code === "EAGAIN") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          continue;
        }
        n = 0;
      }
      if (n === 0) ended = true;
      else pending = Buffer.concat([pending, chunk.subarray(0, n)]);
    }
  };
}
function isAlpha(c) {
  return /^[A-Za-z]$/.test(c);
}
function isDigit(c) {
  return c !== void 0 && c >= "0" && c <= "9";
}
function filePrefixLen(s) {
  const n = s.length;
  let prefixLen = 0;
  for (let i = 0; ; ) {
    if (i === n) return prefixLen;
    i += 1;
    prefixLen = i;
    while (i + 1 < n && s[i] === "." && (isAlpha(s[i + 1]) || s[i + 1] === "~")) {
      for (i += 2; i < n && (/^[A-Za-z0-9]$/.test(s[i]) || s[i] === "~"); i += 1) ;
    }
  }
}
function order(s, pos, len) {
  if (pos === len) return -1;
  const c = s[pos];
  if (isDigit(c)) return 0;
  if (isAlpha(c)) return c.charCodeAt(0);
  if (c === "~") return -2;
  return c.charCodeAt(0) + 256;
}
function verrevcmp(s1, len1, s2, len2) {
  let p1 = 0;
  let p2 = 0;
  while (p1 < len1 || p2 < len2) {
    let firstDiff = 0;
    while (p1 < len1 && !isDigit(s1[p1]) || p2 < len2 && !isDigit(s2[p2])) {
      const c1 = order(s1, p1, len1);
      const c2 = order(s2, p2, len2);
      if (c1 !== c2) return c1 - c2;
      p1 += 1;
      p2 += 1;
    }
    while (p1 < len1 && s1[p1] === "0") p1 += 1;
    while (p2 < len2 && s2[p2] === "0") p2 += 1;
    while (p1 < len1 && p2 < len2 && isDigit(s1[p1]) && isDigit(s2[p2])) {
      if (firstDiff === 0) firstDiff = s1.charCodeAt(p1) - s2.charCodeAt(p2);
      p1 += 1;
      p2 += 1;
    }
    if (p1 < len1 && isDigit(s1[p1])) return 1;
    if (p2 < len2 && isDigit(s2[p2])) return -1;
    if (firstDiff !== 0) return firstDiff;
  }
  return 0;
}
function versionCompare(a, b) {
  if (a === b) return 0;
  if (a === "") return -1;
  if (b === "") return 1;
  const aPrefix = filePrefixLen(a);
  const bPrefix = filePrefixLen(b);
  let result = verrevcmp(a, aPrefix, b, bPrefix);
  if (result === 0 && !(aPrefix === a.length && bPrefix === b.length)) result = verrevcmp(a, a.length, b, b.length);
  if (result !== 0) return result;
  return a < b ? -1 : 1;
}
function subdirs(dir, followLinks) {
  let names;
  try {
    names = readdirSync6(dir);
  } catch {
    return [];
  }
  return names.filter((name2) => {
    if (followLinks && name2.startsWith(".")) return false;
    try {
      return (followLinks ? statSync13(`${dir}/${name2}`) : lstatSync3(`${dir}/${name2}`)).isDirectory();
    } catch {
      return false;
    }
  }).sort((a, b) => Buffer.compare(Buffer.from(`${a}/`), Buffer.from(`${b}/`)));
}
function installedChannels(installedJson2) {
  if (!isFile6(installedJson2)) return [];
  const read = readJson2(installedJson2);
  if (!read.ok || !isObject4(read.doc) || !isObject4(read.doc.plugins)) return [];
  return Object.keys(read.doc.plugins).sort().filter((key) => key.startsWith("tmb@"));
}
function parseArgs2(argv2) {
  let channel = "";
  let dryRun2 = false;
  for (let i = 0; i < argv2.length; i += 1) {
    const arg = argv2[i];
    if (arg.startsWith("--channel=")) channel = arg.slice("--channel=".length);
    else if (arg === "--channel") {
      i += 1;
      if (i < argv2.length) channel = argv2[i];
    } else if (arg === "--dry-run") dryRun2 = true;
  }
  return { channel, dryRun: dryRun2 };
}
function disabledProjects(config) {
  if (!isObject4(config)) return [];
  const projects = config.projects;
  if (!isObject4(projects)) return [];
  const hits = [];
  for (const [path, value] of Object.entries(projects)) {
    if (value !== null && !isObject4(value)) return [];
    const list = isObject4(value) ? value.disabledMcpServers : void 0;
    if (Array.isArray(list) && list.includes(MCP_SERVER_KEY)) hits.push(path);
  }
  return hits;
}
function utcStamp() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
function writeJsonAtomically(path, doc) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync2(tmp, `${JSON.stringify(doc, null, 2)}
`);
  renameSync(tmp, path);
}
function stepA(io2, ask, ccConfig, dryRun2) {
  io2.out("--- Step A: per-project disabledMcpServers flags in ~/.claude.json ---\n\n");
  if (!isFile6(ccConfig)) {
    io2.out(`  ${ccConfig} not found \u2014 skipping Step A.

`);
    return;
  }
  const read = readJson2(ccConfig);
  if (!read.ok || !isObject4(read.doc) || !Object.hasOwn(read.doc, "projects")) {
    io2.out(`  No .projects key in ${ccConfig} \u2014 skipping Step A.

`);
    return;
  }
  const projects = disabledProjects(read.doc);
  if (projects.length === 0) {
    io2.out(`  No projects have ${MCP_SERVER_KEY} in disabledMcpServers.
`);
    io2.out("  No disabled-MCP flags to clear; skipping.\n\n");
    return;
  }
  io2.out("  Projects with trajectory-server disabled:\n");
  for (const p of projects) io2.out(`    ${p}
`);
  io2.out(`
  Would: for each above, remove "${MCP_SERVER_KEY}" from .projects."<path>".disabledMcpServers
`);
  io2.out("         (preserves every other disabled server + other keys).\n\n");
  if (dryRun2) {
    io2.out(
      `  [dry-run] Step A would: back up ${ccConfig} to ${ccConfig}.bak.<timestamp>, then remove "${MCP_SERVER_KEY}" from .projects."<path>".disabledMcpServers for:
`
    );
    for (const p of projects) io2.out(`    ${p}
`);
    io2.out("\n");
    return;
  }
  const answer = ask("  Proceed with Step A? (Y/n) ");
  if (["n", "N", "no", "NO"].includes(answer)) {
    io2.out("  Skipped Step A.\n\n");
    return;
  }
  const backup = `${ccConfig}.bak.${utcStamp()}`;
  const st = statSync13(ccConfig);
  copyFileSync(ccConfig, backup);
  chmodSync(backup, st.mode & 4095);
  utimesSync(backup, st.atime, st.mtime);
  io2.out(`  Backup: ${backup}
`);
  for (const p of projects) {
    const doc = JSON.parse(readFileSync14(ccConfig, "utf8"));
    const current = doc.projects[p].disabledMcpServers;
    doc.projects[p].disabledMcpServers = (Array.isArray(current) ? current : []).filter((s) => s !== MCP_SERVER_KEY);
    writeJsonAtomically(ccConfig, doc);
    io2.out(`  Cleaned: ${p}
`);
  }
  io2.out("\n");
}
function activeVersion(installedJson2, entry) {
  if (!isFile6(installedJson2)) return "";
  const read = readJson2(installedJson2);
  if (!read.ok || !isObject4(read.doc) || !isObject4(read.doc.plugins)) return "";
  const records = read.doc.plugins[entry];
  if (!Array.isArray(records)) return "";
  for (const r of records) {
    const v = isObject4(r) ? r.version : void 0;
    if (v === void 0 || v === null || v === "unknown") continue;
    return v === false ? "" : rawText(v);
  }
  return "";
}
function stepC(io2, ask, versionsDir, installedJson2, entry, dryRun2) {
  io2.out("--- Step C: cache GC \u2014 prune stale cached versions (keep active + previous) ---\n\n");
  let active = activeVersion(installedJson2, entry);
  if (!isDir4(versionsDir)) {
    io2.out(`  No version cache at ${versionsDir} \u2014 nothing to GC.

`);
    return;
  }
  const sorted = subdirs(versionsDir, false).filter((name2) => isDigit(name2[0])).sort(versionCompare);
  if (sorted.length === 0) {
    io2.out(`  No semver version dirs under ${versionsDir} \u2014 nothing to GC.

`);
    return;
  }
  if (active === "") {
    active = sorted[sorted.length - 1];
    io2.out(`  (no active version in installed_plugins \u2014 treating highest cached ${active} as active)
`);
  }
  let previous = "";
  for (const v of sorted) if (v !== active && versionCompare(v, active) < 0) previous = v;
  const prune = sorted.filter((v) => v !== active && v !== previous);
  io2.out(`  cache dir:        ${versionsDir}
`);
  io2.out(`  cached versions:  ${sorted.join(" ")}
`);
  io2.out(`  active (keep):    ${active}
`);
  io2.out(`  previous (keep):  ${previous || "(none)"}
`);
  if (prune.length === 0) {
    io2.out("  Nothing to prune \u2014 only active + previous are cached.\n\n");
    return;
  }
  io2.out(`
  Would remove ${prune.length} stale version(s):
`);
  for (const v of prune) io2.out(`    rm -rf ${versionsDir}/${v}
`);
  if (dryRun2) {
    io2.out(`
  [dry-run] Step C would: rm -rf${prune.map((v) => ` ${versionsDir}/${v}`).join("")}

`);
    return;
  }
  const answer = ask("\n  Proceed with Step C prune? (Y/n) ");
  if (["n", "N", "no", "NO"].includes(answer)) {
    io2.out("  Skipped Step C.\n\n");
    return;
  }
  for (const v of prune) {
    if (v === active || v === "") continue;
    rmSync7(`${versionsDir}/${v}`, { recursive: true, force: true });
    io2.out(`  Removed ${versionsDir}/${v}
`);
  }
  io2.out("\n");
}
function reinstallHint(io2, entry, installScope) {
  io2.out(`  1. From the project root: claude plugin install ${entry} --scope ${installScope}
`);
  io2.out(`     (scope rule: ${SCOPE_DOC2})
`);
  io2.out("  2. Launch Claude Code.\n");
  io2.out(`  3. Verify with: tail -1 <project>/.claude/${PLUGIN_NAME}/logs/mcp-health.log
`);
  io2.out("     (expect mcp_alive:true)\n");
}
function jqLength(v) {
  if (Array.isArray(v) || typeof v === "string") return v.length;
  if (isObject4(v)) return Object.keys(v).length;
  if (typeof v === "number") return Math.abs(v);
  return 0;
}
function stepB(io2, ask, env, paths, entry, installScope, dryRun2) {
  const { cacheDir, installedJson: installedJson2 } = paths;
  io2.out("--- Step B: plugin cache + installed_plugins.json ---\n\n");
  const cacheExists = isDir4(cacheDir);
  const manifestExists = isFile6(installedJson2);
  let total = 0;
  let matching = 0;
  let recordedScope = "";
  if (manifestExists) {
    const read = readJson2(installedJson2);
    const plugins = read.ok && isObject4(read.doc) ? read.doc.plugins : void 0;
    total = jqLength(plugins);
    if (isObject4(plugins) && Object.hasOwn(plugins, entry)) {
      matching = 1;
      const records = plugins[entry];
      if (Array.isArray(records)) {
        const scope = records.map((r) => isObject4(r) ? r.scope : void 0).find((s) => s !== void 0 && s !== null && s !== false);
        if (scope !== void 0) recordedScope = rawText(scope);
      }
    }
  }
  const uninstallScope = recordedScope === "project" || recordedScope === "local" ? recordedScope : installScope;
  io2.out("Discovered state:\n");
  io2.out(`  cache dir:           ${cacheDir} (${cacheExists ? "yes" : "no"})
`);
  if (manifestExists) {
    io2.out(`  installed_plugins:   ${installedJson2}
`);
    io2.out(`  total entries:       ${total}
`);
    io2.out(`  matching "${entry}": ${matching}
`);
  } else {
    io2.out(`  installed_plugins:   ${installedJson2} (missing)
`);
  }
  if (cacheExists) {
    io2.out(`
Cache subdirectories under ${cacheDir}:
`);
    for (const name2 of subdirs(cacheDir, true)) {
      const versions = subdirs(`${cacheDir}/${name2}`, true);
      io2.out(`  ${name2}: ${versions.length > 0 ? versions.join(" ") : "(empty)"}
`);
    }
  }
  const { count } = pgrepProbe(env);
  io2.out(count === "-1" ? "\ntrajectory-server processes: unknown (pgrep missing)\n" : `
trajectory-server processes: ${count}
`);
  if (!cacheExists && matching === 0) {
    io2.out(`
  Nothing to nuke \u2014 cache dir already gone and no ${entry} entry in installed_plugins.json.
`);
    io2.out("  Skipping Step B.\n\n");
    io2.out("Done. To reinstall:\n");
    reinstallHint(io2, entry, installScope);
    return 0;
  }
  const jqDel = `jq "del(.plugins["${entry}"])" ${installedJson2}`;
  io2.out("\nDry-run \u2014 would remove:\n");
  if (cacheExists) io2.out(`  rm -rf ${cacheDir}
`);
  if (matching > 0) io2.out(`  ${jqDel}   (${matching} entries)
`);
  if (dryRun2) {
    io2.out(`
[dry-run] Step B would:${cacheExists ? ` rm -rf ${cacheDir};` : ""}${matching > 0 ? ` ${jqDel}` : ""}
`);
    io2.out("\n--dry-run: nothing was changed. Re-run without --dry-run to apply.\n");
    return 0;
  }
  const answer = ask("\nProceed with Step B (cache nuke)? (y/N) ");
  if (!["y", "Y", "yes", "YES"].includes(answer)) {
    io2.out("\nSkipped Step B. Manual recovery options:\n");
    io2.out("  1. claude --plugin-dir <plugin-source-path>   (cache-bust via inline)\n");
    io2.out(
      `  2. From the project root: claude plugin uninstall ${entry} --scope ${uninstallScope}, then reinstall with: claude plugin install ${entry} --scope ${installScope}
`
    );
    io2.out(`     (scope rule: ${SCOPE_DOC2})
`);
    io2.out("  3. Re-run this script and answer y to Step B.\n");
    return 0;
  }
  if (cacheExists) {
    rmSync7(cacheDir, { recursive: true, force: true });
    io2.out(`Removed ${cacheDir}
`);
  }
  if (matching > 0) {
    const doc = JSON.parse(readFileSync14(installedJson2, "utf8"));
    delete doc.plugins[entry];
    writeJsonAtomically(installedJson2, doc);
    io2.out(`Removed ${matching} entries from ${installedJson2}
`);
  }
  io2.out("\nDone. To reinstall:\n");
  reinstallHint(io2, entry, installScope);
  return 0;
}
function healMcpCache(argv2, env, io2) {
  if ((env.CLAUDE_PROJECT_DIR ?? "") !== "" || (env.CLAUDE_PLUGIN_ROOT ?? "") !== "") {
    io2.err("Refusing to run inside Claude Code: this script edits ~/.claude.json\n");
    io2.err("(which Claude Code reads on every prompt) and the plugins cache.\n");
    io2.err("Quit Claude Code first, then run it from a regular terminal.\n");
    return 1;
  }
  const home = env.HOME ?? homedir4();
  const installedJson2 = `${home}/.claude/plugins/installed_plugins.json`;
  const ccConfig = `${home}/.claude.json`;
  const detected = installedChannels(installedJson2);
  const { channel, dryRun: dryRun2 } = parseArgs2(argv2);
  let entry;
  if (channel !== "") {
    if (channel === "stable") entry = "tmb@trustmybot";
    else if (channel === "rc" || channel === "dev") entry = `tmb@trustmybot-${channel}`;
    else {
      io2.err(`Unknown channel: ${channel}
`);
      io2.err("Pass --channel stable|rc|dev.\n");
      return 2;
    }
  } else if (detected.length === 1) {
    entry = detected[0];
  } else if (detected.length > 1) {
    io2.err(`Multiple tmb channels installed: ${detected.join(" ")}
`);
    io2.err("Pass --channel stable|rc|dev to choose.\n");
    return 2;
  } else {
    io2.err(`No tmb installation found in ${installedJson2}
`);
    io2.err("Pass --channel stable|rc|dev to specify explicitly.\n");
    return 1;
  }
  const owner = entry.slice(entry.indexOf("@") + 1);
  const cacheDir = `${home}/.claude/plugins/cache/${owner}`;
  const installScope = owner === "trustmybot" ? "project" : "local";
  const readLine = stdinLines();
  const ask = (prompt) => {
    io2.out(prompt);
    return readLine().replace(/^[ \t]+|[ \t]+$/g, "");
  };
  io2.out("=== TMB MCP-cache heal \u2014 issue #2888 ===\n\n");
  try {
    stepA(io2, ask, ccConfig, dryRun2);
    stepC(io2, ask, `${cacheDir}/${PLUGIN_NAME}`, installedJson2, entry, dryRun2);
    return stepB(io2, ask, env, { cacheDir, installedJson: installedJson2 }, entry, installScope, dryRun2);
  } catch (e) {
    if (e instanceof EndOfInput) return 1;
    throw e;
  }
}

// src/cli/hook-lib.ts
init_db();
var USAGE3 = "usage: cli.js hook-lib <db-path>\n";
function hookLib(argv2, env, io2) {
  const [mode] = argv2;
  if (mode === "db-path") {
    const db = dbPath(env, (line) => io2.err(`${line}
`));
    if (db === null) return 1;
    io2.out(`${db}
`);
    return 0;
  }
  io2.err(mode === void 0 ? USAGE3 : `hook-lib: unknown mode '${mode}'
${USAGE3}`);
  return 2;
}

// src/cli/integrate.ts
init_audit2();
init_db();
init_close_lints();
import { spawn as spawn6, spawnSync as spawnSync4 } from "node:child_process";
import { closeSync as closeSync7, mkdirSync as mkdirSync5, mkdtempSync as mkdtempSync6, openSync as openSync7, readFileSync as readFileSync15, rmdirSync, rmSync as rmSync8 } from "node:fs";
import { constants as osConstants4, tmpdir as tmpdir5 } from "node:os";
import { join as join13 } from "node:path";

// src/hooks/lib/downstream.ts
init_config();
init_test_paths();
init_audit2();
init_db();
var CALL_EDGES = "'calls', 'instantiates', 'runs', 'sources'";
function jsonRows(db, sql, env) {
  const out = gateRead(db, sql, env);
  if (out === GATE_READ_ERROR) return null;
  if (out.trim() === "") return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function idList(ids) {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].join(", ");
}
var SYMBOL_JSON = "json_group_array(json_object('id', id, 'qualified_name', qualified_name, 'kind', kind, 'path', path, 'line', start_line))";
function pathList(paths) {
  return [...new Set(paths)].map((p) => `'${sqlQuote(p)}'`).join(", ");
}
function symbolsInFiles(db, repo, paths, env = process.env) {
  if (paths.length === 0) return [];
  return jsonRows(
    db,
    `SELECT ${SYMBOL_JSON} FROM (SELECT * FROM wm_symbols WHERE repo = '${sqlQuote(repo)}' AND path IN (${pathList(paths)}) ORDER BY path, start_line, id);`,
    env
  );
}
function inTestLane(h) {
  return h.lane === null || h.lane === void 0 ? isDefaultTestPath(h.path) : h.lane === "test";
}
function directDownstream(db, repo, symbolIds, env = process.env, skipPaths = []) {
  const ids = idList(symbolIds);
  if (ids === "") return { refs: [], total: 0 };
  const sql = `WITH t AS (SELECT id, kind FROM wm_symbols WHERE repo = '${sqlQuote(repo)}' AND id IN (${ids})),
tables AS (
  SELECT e.dst_id AS id FROM wm_edges e JOIN t ON t.id = e.src_id JOIN wm_symbols tb ON tb.id = e.dst_id
   WHERE e.kind = 'writes_table' AND tb.kind = 'sql_table'
  UNION SELECT id FROM t WHERE kind = 'sql_table'
),
hits AS (
  SELECT o.id, o.qualified_name, o.kind, o.path, o.start_line AS line, 'caller' AS via, s.qualified_name AS of_name
    FROM wm_edges e JOIN t ON t.id = e.dst_id JOIN wm_symbols s ON s.id = e.dst_id JOIN wm_symbols o ON o.id = e.src_id
   WHERE e.kind IN (${CALL_EDGES}) AND o.id NOT IN (SELECT id FROM t)
  UNION
  SELECT o.id, o.qualified_name, o.kind, o.path, o.start_line, 'reader', tb.qualified_name
    FROM wm_edges e JOIN tables ON tables.id = e.dst_id JOIN wm_symbols tb ON tb.id = e.dst_id JOIN wm_symbols o ON o.id = e.src_id
   WHERE e.kind = 'reads_table' AND o.id NOT IN (SELECT id FROM t)
)
SELECT json_group_array(json_object('id', id, 'qualified_name', qualified_name, 'kind', kind, 'path', path, 'line', line, 'via', via, 'of', of_name, 'lane', lane))
  FROM (SELECT h.*, f.lane FROM hits h LEFT JOIN wm_files f ON f.repo = '${sqlQuote(repo)}' AND f.path = h.path
         ORDER BY h.path, h.line, h.id, h.via, h.of_name);`;
  const hits = jsonRows(db, sql, env);
  if (hits === null) return null;
  const skip = new Set(skipPaths);
  const merged = /* @__PURE__ */ new Map();
  for (const h of hits) {
    if (typeof h.path !== "string" || inTestLane(h) || skip.has(h.path)) continue;
    const key = `${h.via}:${h.id}`;
    const entry = merged.get(key) ?? { ref: { id: h.id, qualified_name: h.qualified_name, kind: h.kind, path: h.path, line: h.line, via: h.via }, of: [] };
    if (!entry.of.includes(h.of)) entry.of.push(h.of);
    merged.set(key, entry);
  }
  const refs = [...merged.values()].map(({ ref, of }) => ({ ...ref, of }));
  return { refs, total: refs.length };
}
function importingFiles(db, repo, paths, env = process.env) {
  if (paths.length === 0) return [];
  const r = `'${sqlQuote(repo)}'`;
  const list = pathList(paths);
  const rows = jsonRows(
    db,
    `SELECT json_group_array(json_object('path', path, 'lane', lane)) FROM (
  SELECT DISTINCT o.path, f.lane FROM wm_edges e JOIN wm_symbols d ON d.id = e.dst_id JOIN wm_symbols o ON o.id = e.src_id
    LEFT JOIN wm_files f ON f.repo = o.repo AND f.path = o.path
   WHERE e.kind = 'imports' AND d.repo = ${r} AND d.path IN (${list}) AND o.repo = ${r} AND o.path NOT IN (${list})
   ORDER BY o.path);`,
    env
  );
  return rows === null ? null : rows.filter((row) => typeof row.path === "string" && !inTestLane(row)).map((row) => row.path);
}
function fileDependents(db, repo, paths, env = process.env) {
  const symbols = symbolsInFiles(db, repo, paths, env);
  if (symbols === null) return null;
  const downstream = directDownstream(db, repo, symbols.map((s) => s.id), env, paths);
  const importers = importingFiles(db, repo, paths, env);
  if (downstream === null || importers === null) return null;
  return [.../* @__PURE__ */ new Set([...downstream.refs.map((ref) => ref.path), ...importers])].sort();
}

// src/cli/integrate.ts
init_git();
init_jq_key_order();
init_jq();
init_project_env();
init_repo();
init_verification_runs2();
await init_swe_verification_gate();
init_review_sql();
init_worktree_deps();
init_worktree_setup();
var FINISH_ATTEMPTS2 = 3;
var TAIL_LINES2 = 20;
var TIMED_OUT_CODE2 = 124;
var UNCARRIED_CODE = 5;
var FETCH_TIMEOUT_MS = 6e4;
var RECORD_ENV2 = { TMB_DB_WRITE_TIMEOUT_MS: "5000", TMB_DB_WRITE_RUN_BUDGET_MS: "10000" };
var MAX_BUFFER2 = 256 * 1024 * 1024;
var OVERLAP_SHOWN = 10;
var signals4 = osConstants4.signals;
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
function sleepS(seconds3) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds3 * 1e3);
}
function verificationCommands(json2) {
  const { values, complete } = jsonStream(json2);
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
  issueId = "";
  base = "";
  branch = "";
  reviewedSha = "";
  reviewAnchorAt = "";
  commitSha = "";
  baseSha = "";
  baseLabel = "";
  repoRoot = "";
  repoName = "";
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
      maxBuffer: MAX_BUFFER2,
      timeout: opts.timeoutMs
    });
    const timedOut2 = r.error !== void 0 && "code" in r.error && r.error.code === "ETIMEDOUT";
    return { ok: r.status === 0, out: commandSubstitution(r.stdout ?? ""), err: r.stderr ?? "", timedOut: timedOut2 };
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
    const r = dbWrite(this.db, sql, { caller: "integrate", env: { ...this.env, ...RECORD_ENV2 } });
    if (!r.ok && r.error !== "") this.io.err(`${r.error}
`);
    return { ok: r.ok, stdout: r.stdout };
  }
  /**
   * Points tasks.commit_sha at <newSha> and, when the pass carries, writes its
   * task_integrated anchor, both or neither; false when the task moved off the
   * reviewed SHA. With no anchor row no pass covers <newSha>.
   */
  recordIntegrated(newSha, carry) {
    const now2 = nowIso();
    const pointAtNewSha = `UPDATE tasks SET commit_sha = '${sqlQuote(newSha)}', updated_at = '${now2}' WHERE id = ${this.taskId} AND commit_sha = '${sqlQuote(this.reviewedSha)}';`;
    if (!carry) {
      const r2 = this.record(`${pointAtNewSha}
SELECT changes();`);
      return r2.ok && commandSubstitution(r2.stdout) === "1";
    }
    const content = JSON.stringify({
      task_id: Number(this.taskId),
      reviewed_sha: this.reviewedSha,
      review_anchor_at: this.reviewAnchorAt,
      commit_sha: newSha,
      base: this.base,
      run_id: Number(this.runId)
    });
    const audit = auditSql(
      {
        issueId: this.issueId,
        branchId: this.branch,
        fromNode: "hook:integrate",
        eventType: "task_integrated",
        summary: `task ${this.taskId} integrated onto ${this.base}: ${this.reviewedSha} -> ${newSha}`,
        contentJson: content
      },
      "changes() = 1",
      { caller: "integrate", env: this.env, now: now2 }
    );
    if (audit.code !== 0) {
      this.io.err(`${audit.error}
`);
      return false;
    }
    const r = this.record(
      `${pointAtNewSha}
${audit.sql}
SELECT changes();`
    );
    return r.ok && commandSubstitution(r.stdout) === "1";
  }
  finish(rc, timedOut2) {
    for (let attempt = 1; attempt <= FINISH_ATTEMPTS2; attempt += 1) {
      const s = runFinishSql("integrate", this.runId, rc, timedOut2);
      if (s.code !== 0) {
        this.io.err(`${s.error}
`);
        return false;
      }
      if (this.record(s.sql).ok) {
        this.runOpen = false;
        return true;
      }
      sleepS(attempt);
    }
    return false;
  }
  recordCommand(ordinal, command, rc, elapsed, output) {
    const s = runCommandSql("integrate", this.runId, ordinal, command, rc, String(elapsed), output, this.env);
    if (s.code !== 0) {
      this.io.err(`${s.error}
`);
      return false;
    }
    return this.record(s.sql).ok;
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
    if (this.scratch !== "") rmSync8(this.scratch, { recursive: true, force: true });
    this.scratch = "";
    if (this.wt === "") return;
    if (!this.g(["worktree", "remove", "--force", this.wt]).ok) {
      rmSync8(this.wt, { recursive: true, force: true });
      this.g(["worktree", "prune"]);
    }
    this.wt = "";
  }
  /** Runs <cmd> in the worktree, output captured, killed with its process group after <seconds>. */
  execute(cmd, seconds3, env) {
    if (this.scratch === "") this.scratch = mkdtempSync6(join13(this.env.TMPDIR || tmpdir5(), "tmb-integrate-"));
    const outPath = join13(this.scratch, "out");
    return new Promise((done) => {
      const fd = openSync7(outPath, "w");
      let fired = false;
      let settled = false;
      const settle = (rc) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = null;
        let out = "";
        try {
          out = commandSubstitution(readFileSync15(outPath, "utf8"));
        } catch {
        }
        rmSync8(outPath, { force: true });
        done({ rc, fired, out });
      };
      const child = spawn6(cmd[0], cmd.slice(1), { cwd: this.wt, env: { ...env, PWD: this.wt }, stdio: ["ignore", fd, fd], detached: true });
      this.child = child;
      closeSync7(fd);
      const timer = setTimeout(() => {
        fired = true;
        try {
          if (child.pid !== void 0) process.kill(-child.pid, "SIGKILL");
        } catch {
        }
      }, seconds3 * 1e3);
      child.on("error", () => settle(127));
      child.on("exit", (code, signal) => {
        if (fired) settle(TIMED_OUT_CODE2);
        else settle(code ?? 128 + (signal !== null ? signals4[signal] ?? 0 : 0));
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
  fetchBase(remote, branch) {
    const override = Number(this.env.TMB_INTEGRATE_FETCH_TIMEOUT_MS);
    const timeoutMs = Number.isInteger(override) && override > 0 ? override : FETCH_TIMEOUT_MS;
    const r = this.git(this.repoRoot, ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=5", "fetch", "-q", remote, branch], {
      env: { ...this.env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs
    });
    if (r.timedOut) {
      this.die(4, `fetch of base '${this.base}' (${remote} ${branch}) timed out after ${timeoutMs} ms; ${this.branch} and the DB are unchanged`);
    }
    if (!r.ok) {
      this.die(4, `fetch of base '${this.base}' (${remote} ${branch}) failed; ${this.branch} and the DB are unchanged: ${r.err.trim()}`);
    }
  }
  hasRef(ref) {
    return this.g(["show-ref", "--verify", "-q", ref]).ok;
  }
  /** The base sha: a local branch with an upstream is fetched and loses to its upstream unless equal or ahead; a remote-tracking ref is fetched; anything else resolves as given. Sets baseLabel. */
  resolveBase() {
    this.baseLabel = this.base;
    const local = `refs/heads/${this.base}`;
    if (this.hasRef(local)) {
      const upstream = this.g(["rev-parse", "--symbolic-full-name", `${this.base}@{upstream}`]);
      const remote = this.g(["config", "--get", `branch.${this.base}.remote`]).out;
      const merge = this.g(["config", "--get", `branch.${this.base}.merge`]).out;
      if (!upstream.ok || upstream.out === "" || remote === "" || merge === "") return this.revParse(this.repoRoot, `${local}^{commit}`);
      if (remote !== ".") this.fetchBase(remote, merge.replace(/^refs\/heads\//, ""));
      const localSha = this.revParse(this.repoRoot, `${local}^{commit}`);
      const upstreamSha = this.revParse(this.repoRoot, `${upstream.out}^{commit}`);
      if (upstreamSha === "" || localSha === upstreamSha || this.g(["merge-base", "--is-ancestor", upstreamSha, localSha]).ok) return localSha;
      this.say(`${local} (${localSha}) is behind or diverged from ${upstream.out} (${upstreamSha}); rebasing onto ${upstream.out}`);
      this.baseLabel = upstream.out.replace(/^refs\/remotes\//, "");
      return upstreamSha;
    }
    const tracking = `refs/remotes/${this.base}`;
    if (this.hasRef(tracking)) {
      const remote = this.g(["remote"]).out.split("\n").filter((name2) => name2 !== "" && this.base.startsWith(`${name2}/`)).sort((a, b) => b.length - a.length)[0];
      if (remote !== void 0) this.fetchBase(remote, this.base.slice(remote.length + 1));
      return this.revParse(this.repoRoot, `${tracking}^{commit}`);
    }
    return this.revParse(this.repoRoot, `${this.base}^{commit}`);
  }
  rebasePicks(sha) {
    return this.git(this.wt, ["rev-list", "--reverse", "--no-merges", "--cherry-pick", "--right-only", `${this.baseSha}...${sha}`]).out.split("\n").filter((pick) => pick !== "");
  }
  /** What a rebase keeps of a commit: author name, email, raw date and raw message; null when git cannot read it. */
  rebaseIdentity(sha) {
    const r = spawnSync4("git", ["-C", this.wt, "show", "-s", "--date=raw", "--format=%an%x00%ae%x00%ad%x00%B", sha], {
      encoding: "utf8",
      env: this.env,
      maxBuffer: MAX_BUFFER2
    });
    return r.status === 0 ? r.stdout : null;
  }
  /**
   * The picks of commit_sha the rebase to <newSha> kept, in order. A pick no
   * rebased pick shares an identity with was dropped as already in the base,
   * as a squash-merged parent branch's commits are (GH 3114); a pick whose
   * identity git cannot read counts as kept.
   */
  keptPicks(newSha) {
    const rebased = /* @__PURE__ */ new Map();
    for (const pick of this.rebasePicks(newSha)) {
      const identity = this.rebaseIdentity(pick);
      if (identity !== null) rebased.set(identity, (rebased.get(identity) ?? 0) + 1);
    }
    return this.rebasePicks(this.commitSha).filter((pick) => {
      const identity = this.rebaseIdentity(pick);
      if (identity === null) return true;
      const left = rebased.get(identity) ?? 0;
      if (left === 0) return false;
      rebased.set(identity, left - 1);
      return true;
    });
  }
  patchIds(picks) {
    const diff = spawnSync4("git", ["-C", this.wt, "diff-tree", "--stdin", "-p", "-r", "--root"], {
      encoding: "utf8",
      env: this.env,
      input: picks.length === 0 ? "" : `${picks.join("\n")}
`,
      maxBuffer: MAX_BUFFER2
    });
    const ids = this.git(this.wt, ["patch-id", "--stable"], { input: diff.stdout ?? "" });
    return commandSubstitution(
      ids.out.split("\n").map((line) => line.split(" ")[0]).join("\n")
    );
  }
  /** The NUL-separated paths a `git -z` listing prints, read raw because this.git drops NULs; null when git fails. */
  pathList(args, input = "") {
    const r = spawnSync4("git", ["-C", this.wt, ...args], { encoding: "utf8", env: this.env, input, maxBuffer: MAX_BUFFER2 });
    return r.status === 0 ? r.stdout.split("\0").filter((path) => path !== "") : null;
  }
  /** The world-model dependents of <paths>, or why the world model cannot name them. */
  worldModelDependents(paths) {
    if (this.repoName === "") return { unavailable: `no repos row names ${this.repoRoot}` };
    const indexed = gateRead(this.db, `SELECT EXISTS (SELECT 1 FROM wm_symbols WHERE repo = '${sqlQuote(this.repoName)}');`, this.env);
    if (indexed === GATE_READ_ERROR) return { unavailable: "the wm_symbols read failed" };
    if (indexed !== "1") return { unavailable: `no wm_symbols rows for repo '${this.repoName}'` };
    return fileDependents(this.db, this.repoName, paths, this.env) ?? { unavailable: "the wm_symbols or wm_edges read failed" };
  }
  /**
   * Why the reviewed commit's pass does not carry to its rebase (GH 3108): the
   * paths the base commits it was rebased over change that the task's own
   * commits (the <kept> picks) or their world-model dependents hold, and a
   * world model that cannot name the dependents; '' when it carries.
   */
  uncarriedReason(kept) {
    const oldBase = this.git(this.wt, ["merge-base", this.commitSha, this.baseSha]).out;
    const baseFiles = oldBase === "" ? null : this.pathList(["diff", "--name-only", "--no-renames", "-z", oldBase, this.baseSha]);
    const diffFiles = this.pathList(
      ["diff-tree", "--stdin", "-r", "--root", "--no-commit-id", "--name-only", "--no-renames", "-z"],
      kept.length === 0 ? "" : `${kept.join("\n")}
`
    );
    if (baseFiles === null || diffFiles === null) return "git could not list the files the base or the task changed";
    const dependents = this.worldModelDependents(diffFiles);
    const held = /* @__PURE__ */ new Set([...diffFiles, ...Array.isArray(dependents) ? dependents : []]);
    const overlap = [...new Set(baseFiles)].filter((path) => held.has(path)).sort();
    const reasons = [];
    if (!Array.isArray(dependents)) reasons.push(`world model unavailable (${dependents.unavailable})`);
    if (overlap.length > 0) {
      const more = overlap.length > OVERLAP_SHOWN ? ` and ${overlap.length - OVERLAP_SHOWN} more` : "";
      reasons.push(`the base commits it was rebased over change ${overlap.length} path(s) the task's diff or its dependents hold: ${overlap.slice(0, OVERLAP_SHOWN).join(", ")}${more}`);
    }
    return reasons.join("; ");
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
      `SELECT 'task' || char(10) || COALESCE(repo, '') || char(10) || COALESCE(branch_id, '') || char(10) || COALESCE(commit_sha, '') || char(10) || issue_id || char(10) || COALESCE(${REVIEW_ANCHOR_AT_SQL}, '') || char(10) || ${HAS_PASS_SQL}
  FROM tasks t WHERE t.id = ${this.taskId};`,
      this.env
    );
    if (row === GATE_READ_ERROR) this.die(4, `trajectory DB read failed: ${db}`);
    if (row === "") this.die(4, `no task ${this.taskId}`);
    const [, taskRepo = "", branch = "", commitSha = "", issueId = "", reviewAnchorAt = "", hasPass = ""] = row.split("\n");
    this.reviewAnchorAt = reviewAnchorAt;
    this.branch = branch;
    this.issueId = issueId;
    this.reviewedSha = commitSha;
    if (branch === "") this.die(4, `task ${this.taskId} has no branch_id`);
    if (commitSha === "") this.die(3, `task ${this.taskId} has no commit_sha, so no reviewed commit`);
    if (hasPass !== "1") this.die(3, `task ${this.taskId} has no passing code-reviewer verdict for commit ${commitSha}`);
    const wsRoot = posixDirname(posixDirname(posixDirname(db)));
    const repoDir = taskRepo !== "" ? repoPathByName(db, taskRepo, this.env) || `${wsRoot}/${taskRepo}` : repoSinglePath(db, this.env) || wsRoot;
    this.repoRoot = await repoGitRoot(repoDir, this.env);
    if (this.repoRoot === "" || !isDir(repoDir)) this.die(4, `task ${this.taskId}'s repo is not a git checkout: ${repoDir || "<unresolved>"}`);
    this.repoName = taskRepo || repoNameForRoot(db, this.repoRoot, this.env);
    this.commitSha = this.revParse(this.repoRoot, `${commitSha}^{commit}`);
    if (this.commitSha === "") this.die(4, `commit_sha of task ${this.taskId} is not a commit in ${this.repoRoot}`);
    this.baseSha = this.resolveBase();
    if (this.baseSha === "") this.die(4, `base '${this.base}' is not a commit in ${this.repoRoot}`);
    if (this.g(["merge-base", "--is-ancestor", this.baseSha, this.commitSha]).ok) {
      this.say(`${this.baseLabel} is already an ancestor of task ${this.taskId}'s commit; nothing to rebase`);
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
      mkdirSync5(`${this.repoRoot}/.claude/worktrees`, { recursive: true });
    } catch {
      this.die(4, `cannot create ${this.repoRoot}/.claude/worktrees`);
    }
    try {
      this.wt = mkdtempSync6(`${this.repoRoot}/.claude/worktrees/integrate-${this.taskId}.`);
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
    this.say(`rebasing task ${this.taskId} (${this.commitSha}) onto ${this.baseLabel} (${this.baseSha}) in ${this.wt}`);
    if (!this.gitLoud(this.wt, ["-c", "merge.renames=false", "rebase", "-q", this.baseSha], { ...this.env, GIT_EDITOR: "true" })) {
      this.git(this.wt, ["rebase", "--abort"]);
      this.die(2, `rebase of task ${this.taskId} onto ${this.baseLabel} conflicted; aborted, ${branch} and the DB are unchanged`);
    }
    const newSha = this.revParse(this.wt, "HEAD");
    if (newSha === "") this.die(4, "cannot read the rebased HEAD");
    const toolchainPath = joinToolchainPath(toolchainDirs(this.env, this.wt), this.env.PATH ?? "");
    const budgetRaw = this.env.TMB_VERIFICATION_TIMEOUT_S || sqliteRo(db, "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key = 'verification_timeout_s';", this.env);
    const timeoutS = parseBudget(budgetRaw).timeoutS;
    const rebased = this.rebasePicks(newSha);
    if (rebased.length === 0) {
      this.die(2, `task ${this.taskId}'s patch is already in ${this.baseLabel}; nothing to integrate, ${branch} and the DB are unchanged`);
    }
    const kept = this.keptPicks(newSha);
    if (kept.length !== rebased.length || this.patchIds(kept) !== this.patchIds(rebased)) {
      this.die(
        2,
        `the rebase changed task ${this.taskId}'s source patches (patch-id of ${this.baseLabel}..reviewed differs from ${this.baseLabel}..rebased); ${branch} and the DB are unchanged`
      );
    }
    const uncarried = this.uncarriedReason(kept);
    const deps = await prepareWorktreeDeps(this.repoRoot, this.wt, { env: { ...this.env, PATH: toolchainPath } });
    for (const s of deps.skipped) this.io.err(`worktree-deps: ${s.dir}: ${s.reason}
`);
    if (deps.install_error !== void 0) {
      this.io.err(`${deps.install_error}
`);
      this.die(1, `worktree setup failed on ${newSha}; no verification run recorded, ${branch} unmoved`);
    }
    const setup = await runWorktreeSetup(this.wt, { env: { ...this.env, PATH: toolchainPath } });
    if (setup.error !== void 0) {
      this.io.err(`${describeSetupFailure(setup)}
`);
      this.die(1, `worktree setup failed on ${newSha}; no verification run recorded, ${branch} unmoved`);
    }
    const started = this.record(runStartSql(this.taskId, newSha, timeoutS, "manual"));
    this.runId = started.ok ? commandSubstitution(started.stdout) : "";
    if (this.runId === "") this.die(4, `could not record a verification run for ${newSha}; ${branch} unmoved`);
    this.runOpen = true;
    const commandEnv = { ...this.env, ...RECORD_ENV2, PATH: toolchainPath };
    const lines = commands.split("\n");
    const total = lines.filter((line) => line !== "").length;
    const startS = nowS();
    for (const [i, cmd] of lines.entries()) {
      const ordinal = i + 1;
      const remaining = timeoutS - (nowS() - startS);
      if (remaining <= 0) {
        this.recordCommand(ordinal, cmd, TIMED_OUT_CODE2, 0, "budget spent before the command started");
        if (!this.finish(TIMED_OUT_CODE2, 1)) this.say(`run #${this.runId} finish write failed`);
        this.die(1, `verification budget (${timeoutS}s) spent before command ${ordinal}/${total}: ${cmd}; recorded as run #${this.runId}; ${branch} unmoved`);
      }
      const cmdStart = nowS();
      const { rc, fired, out } = await this.execute(["bash", "-c", cmd], remaining, commandEnv);
      const elapsed = nowS() - cmdStart;
      const tail2 = lastLines(out, TAIL_LINES2);
      const timedOut2 = rc === TIMED_OUT_CODE2 && fired ? 1 : 0;
      if (!this.recordCommand(ordinal, cmd, rc, elapsed, tail2)) this.say(`run #${this.runId}: command ${ordinal} row not recorded`);
      if (rc !== 0) {
        if (!this.finish(rc, timedOut2)) this.say(`run #${this.runId} finish write failed`);
        this.say(`verification failed on ${newSha}: command ${ordinal}/${total} exited ${rc} after ${elapsed}s: ${cmd}`);
        this.io.err(`${tail2}
`);
        this.die(1, `recorded as run #${this.runId}; ${branch} unmoved`);
      }
    }
    if (!this.finish(0, 0)) {
      this.die(4, `run #${this.runId} passed but its finish write failed, so the push guard will not count it; ${branch} unmoved`);
    }
    const lintBase = await lintBaseSha(this.wt, db, this.taskId, newSha, this.env) || this.baseSha;
    const lints = await runCloseLints(this.wt, newSha, lintBase, timeoutS - (nowS() - startS), { ...this.env, PATH: toolchainPath }, {
      db,
      taskId: this.taskId,
      source: "integrate"
    });
    if (typeof lints === "string") this.die(1, `close lints did not run on ${newSha}: ${lints}; ${branch} unmoved`);
    if (lints.exitCode !== 0) {
      this.io.err(`${describeFailures(lints)}
`);
      this.die(1, `close lints failed on ${newSha} (${runLabel(lints)}); ${branch} unmoved`);
    }
    const oldTip = this.tip;
    if (!this.branchMovable()) {
      this.die(4, `verification passed (run #${this.runId}) but ${branch} cannot be moved; the rebased commit is ${newSha}`);
    }
    if (this.tip !== oldTip) this.die(4, `${branch} moved during integration (${oldTip} -> ${this.tip}); left as is`);
    if (!this.g(["update-ref", "-m", `cli.js integrate: task ${this.taskId} onto ${this.base}`, `refs/heads/${branch}`, newSha, this.tip]).ok) {
      this.die(4, `git update-ref of ${branch} failed; the rebased commit is ${newSha} (run #${this.runId})`);
    }
    if (!this.recordIntegrated(newSha, uncarried === "")) {
      this.die(
        4,
        `${branch} moved to ${newSha} (run #${this.runId} passed), but recording it on task ${this.taskId} failed; tasks.commit_sha still names the reviewed ${this.reviewedSha}, so code-reviewer-preflight denies a review of ${newSha} until it is recorded`
      );
    }
    this.say(`${branch} -> ${newSha} (verification run #${this.runId} passed)`);
    this.io.out(`${newSha}
`);
    if (uncarried === "") return 0;
    this.say(`the review of ${this.reviewedSha} does not carry to ${newSha}: ${uncarried}; a new code-reviewer pass is needed for ${newSha}`);
    return UNCARRIED_CODE;
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
import { readFileSync as readFileSync16 } from "node:fs";
var USAGE4 = "usage: cli.js prompt-author-lint <path-to-md-file>\n";
var COMMENT_LINE = /^[ \t\n\v\f\r]*(#|\/\/|--)/;
var PAIRED_ALTERNATIVE = /\b(instead|rather than|unless|only when|only if|except)\b| — |;|, but\b/i;
var HARD_LIMIT = /\bNEVER\b|\bMUST NOT\b|LOAD-BEARING-SAFETY/;
var CHECKS = [
  {
    name: "bare-negation",
    match: /^(Don't|Never|Do not) |\bdo not\b|\bdon't\b|\bnever\b/,
    skip: (text) => COMMENT_LINE.test(text) || PAIRED_ALTERNATIVE.test(text) || HARD_LIMIT.test(text)
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
    io2.err(USAGE4);
    return 0;
  }
  const lines = body(readFileSync16(file, "utf8"));
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

// src/cli/stale-docs.ts
import { spawnSync as spawnSync5 } from "node:child_process";
import { readFileSync as readFileSync17 } from "node:fs";
import { join as join14, posix } from "node:path";
import { parseArgs as parseArgs3 } from "node:util";
var USAGE5 = "usage: cli.js stale-docs <base> [--head <sha>] [--max-hits <n>]\n";
var DEFAULT_MAX_HITS = 15;
var MIN_TOKEN_LENGTH = 6;
var MIN_KEBAB_LENGTH = 8;
var COMMENT_EXTENSIONS = /* @__PURE__ */ new Set([".ts", ".sh", ".sql", ".mjs"]);
var COMMENT_LINE2 = /^\s*(\/\/|#|--|\*|\/\*)/;
var GENERATED_DOCS = /* @__PURE__ */ new Set(["docs/contributing/ENUMS.md"]);
var EXCLUDED_SEGMENTS = ["changelog.d", "dist", "node_modules"];
var EXCLUDED_PATHSPECS = EXCLUDED_SEGMENTS.map((segment) => `:(exclude,glob)**/${segment}/**`);
var COMMON_WORDS = /* @__PURE__ */ new Set([
  "console_log",
  "forEach",
  "hasOwnProperty",
  "toString",
  "toLowerCase",
  "toUpperCase",
  "startsWith",
  "endsWith",
  "indexOf",
  "readFileSync",
  "writeFileSync",
  "existsSync",
  "spawnSync",
  "execFileSync",
  "mkdtempSync",
  "JSON_EXTRACT",
  "CURRENT_TIMESTAMP",
  "PRIMARY_KEY",
  "NOT_NULL",
  "node_modules",
  "README.md",
  "index.ts",
  "package.json"
]);
var WORD = /[A-Za-z0-9_]+/g;
var KEBAB = /\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g;
var GitError = class extends Error {
};
function git(cwd, args) {
  const r = spawnSync5("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw new GitError(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new GitError(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}
function isDoc(path) {
  return path.endsWith(".md");
}
function excluded(path) {
  if (GENERATED_DOCS.has(path) || posix.basename(path) === "CHANGELOG.md") return true;
  return path.split("/").some((segment) => EXCLUDED_SEGMENTS.includes(segment));
}
function parseDiff(text) {
  const files = [];
  let file;
  let newLine = 0;
  let hunkRemoved = /* @__PURE__ */ new Set();
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { paths: [], added: [], removed: [], touched: /* @__PURE__ */ new Map() };
      files.push(file);
      inHunk = false;
    } else if (!file) {
      continue;
    } else if (line.startsWith("@@")) {
      newLine = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
      hunkRemoved = /* @__PURE__ */ new Set();
      inHunk = true;
    } else if (!inHunk) {
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        const path = line.slice(4);
        if (path !== "/dev/null") file.paths.push(path.replace(/^[ab]\//, ""));
      } else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
        file.paths.push(line.replace(/^rename (from|to) /, ""));
      }
    } else if (line.startsWith("+")) {
      file.added.push(line.slice(1));
      file.touched.set(newLine++, hunkRemoved);
    } else if (line.startsWith("-")) {
      file.removed.push(line.slice(1));
      for (const span of spans(line.slice(1))) hunkRemoved.add(span);
    }
  }
  for (const f of files) f.paths = [...new Set(f.paths)];
  return files;
}
function keep(token) {
  return token.length >= MIN_TOKEN_LENGTH && !COMMON_WORDS.has(token);
}
function identifiers(files) {
  const tokens = /* @__PURE__ */ new Set();
  for (const file of files) {
    if (file.paths.some((p) => isDoc(p) || excluded(p))) continue;
    for (const p of file.paths) if (keep(posix.basename(p))) tokens.add(posix.basename(p));
    for (const line of [...file.added, ...file.removed]) {
      for (const word of line.match(WORD) ?? []) {
        const token = word.replace(/^_+|_+$/g, "");
        if ((token.includes("_") || /[a-z][A-Z]/.test(token)) && /[A-Za-z]/.test(token) && keep(token)) tokens.add(token);
      }
      for (const token of line.match(KEBAB) ?? []) if (token.length >= MIN_KEBAB_LENGTH && keep(token)) tokens.add(token);
    }
  }
  return tokens;
}
function isDocLine(path, text) {
  if (excluded(path)) return false;
  if (isDoc(path)) return true;
  return COMMENT_EXTENSIONS.has(posix.extname(path)) && COMMENT_LINE2.test(text);
}
function spans(text) {
  const out = /* @__PURE__ */ new Set();
  for (const run2 of text.match(/[A-Za-z0-9_.-]+/g) ?? []) {
    const parts = run2.split(/([.-])/);
    for (let i = 0; i < parts.length; i += 2) {
      if (parts[i] === "") continue;
      let span = parts[i];
      out.add(span);
      for (let j = i + 2; j < parts.length && parts[j] !== ""; j += 2) {
        span += parts[j - 1] + parts[j];
        out.add(span);
      }
    }
  }
  return out;
}
function docFiles(root, head) {
  const listed = git(root, head ? ["ls-tree", "-r", "-z", "--name-only", head] : ["ls-files", "-z"]).split("\0");
  const paths = listed.filter((p) => p !== "" && !excluded(p) && (isDoc(p) || COMMENT_EXTENSIONS.has(posix.extname(p))));
  if (!head) {
    return paths.flatMap((path) => {
      try {
        return [{ path, text: readFileSync17(join14(root, path), "utf8") }];
      } catch {
        return [];
      }
    });
  }
  const r = spawnSync5("git", ["cat-file", "--batch"], { cwd: root, input: paths.map((p) => `${head}:${p}
`).join(""), maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new GitError(`git cat-file failed: ${r.stderr.toString().trim()}`);
  const out = r.stdout;
  const files = [];
  let at = 0;
  for (const path of paths) {
    const eol = out.indexOf(10, at);
    const header = out.subarray(at, eol).toString().split(" ");
    const size = Number(header[2]);
    if (header[1] !== "blob") throw new GitError(`git cat-file: no blob for ${path}`);
    files.push({ path, text: out.subarray(eol + 1, eol + 1 + size).toString("utf8") });
    at = eol + 1 + size + 1;
  }
  return files;
}
function parseCount(raw) {
  if (raw === void 0) return DEFAULT_MAX_HITS;
  return /^\d+$/.test(raw) ? Number(raw) : void 0;
}
function staleDocs(argv2, _env, io2) {
  let base;
  let head;
  let maxHits;
  try {
    const { values, positionals } = parseArgs3({
      args: [...argv2],
      allowPositionals: true,
      options: { head: { type: "string" }, "max-hits": { type: "string" } }
    });
    if (positionals.length !== 1) throw new Error("expected one <base>");
    base = positionals[0];
    head = values.head;
    maxHits = parseCount(values["max-hits"]);
    if (maxHits === void 0) throw new Error("--max-hits takes a non-negative integer");
  } catch (e) {
    io2.err(`stale-docs: ${e.message}
${USAGE5}`);
    return 2;
  }
  try {
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const mergeBase = git(root, ["merge-base", base, head ?? "HEAD"]).trim();
    const files = parseDiff(
      git(root, ["diff", "--no-color", "--no-ext-diff", "-M", "--unified=0", mergeBase, ...head ? [head] : [], "--", ".", ...EXCLUDED_PATHSPECS])
    );
    const touched = /* @__PURE__ */ new Map();
    for (const f of files) touched.set(f.paths[f.paths.length - 1] ?? "", f.touched);
    const tokens = identifiers(files);
    if (tokens.size === 0) return 0;
    const hits = /* @__PURE__ */ new Map();
    for (const { path, text } of docFiles(root, head)) {
      if (text.includes("\0")) continue;
      text.split("\n").forEach((lineText, i) => {
        const line = i + 1;
        if (!isDocLine(path, lineText)) return;
        const kept = touched.get(path)?.get(line);
        for (const span of spans(lineText)) {
          if (!tokens.has(span) || kept && !kept.has(span)) continue;
          const list = hits.get(span) ?? [];
          list.push({ path, line });
          hits.set(span, list);
        }
      });
    }
    const flagged = /* @__PURE__ */ new Map();
    for (const [token, list] of hits) {
      if (list.length > maxHits) continue;
      for (const { path, line } of list) {
        const key = `${path}\0${line}`;
        const entry = flagged.get(key) ?? { path, line, tokens: [] };
        entry.tokens.push(token);
        flagged.set(key, entry);
      }
    }
    const rows = [...flagged.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line);
    io2.out(rows.map((r) => `${r.path}:${r.line}: ${r.tokens.sort().join(", ")}
`).join(""));
    return 0;
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    io2.err(`stale-docs: ${e.message}
`);
    return 2;
  }
}

// src/cli/trajectory-doctor.ts
import { existsSync as existsSync10 } from "node:fs";
var HELP = `Check a trajectory DB against its data contracts. Prints the JSON report.
The check opens the DB file on a query-only connection \u2014 never as the
server does \u2014 so it applies no schema and runs no migration: an older DB is
reported as it is. --record adds one trajectory_doctor_run audit row through
the trajectory server's trajectory_doctor tool, called as bro, and only on a
DB already at the server's schema version.

Usage (from the project directory, or with --db / TRAJECTORY_DB_PATH):
  node --experimental-sqlite <plugin>/mcp/trajectory-server/dist/cli.js trajectory-doctor [--db <path>] [--ids <id,id,...>] [--record]

Exits 0 when healthy, 1 when an error-severity contract fails or cannot run,
2 when the DB schema is older than the contracts need (start the trajectory
server to migrate), on a usage error, a missing DB, or a tool error.

`;
var json = (value) => `${JSON.stringify(value, null, 2)}
`;
async function trajectoryDoctor(argv2, env, io2) {
  let record = false;
  let idList2 = "";
  const runEnv = { ...env };
  for (let i = 0; i < argv2.length; i += 1) {
    const arg = argv2[i];
    if (arg === "--record") record = true;
    else if (arg === "--ids" || arg === "--db") {
      const value = argv2[i + 1] ?? "";
      if (value === "") {
        io2.err(`trajectory-doctor: ${arg} needs ${arg === "--ids" ? "a comma-separated id list" : "a path"}
`);
        return 2;
      }
      if (arg === "--ids") idList2 = value;
      else runEnv.TRAJECTORY_DB_PATH = value;
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      io2.out(HELP);
      return 0;
    } else {
      io2.err(`trajectory-doctor: unknown argument: ${arg}
`);
      return 2;
    }
  }
  const { resolveDbPath: resolveDbPath2 } = await Promise.resolve().then(() => (init_db2(), db_exports));
  const dbPath2 = resolveDbPath2({ env: runEnv });
  if (dbPath2 === ":memory:" || !existsSync10(dbPath2)) {
    io2.err(`trajectory-doctor: no trajectory DB at ${dbPath2}; run from the project or pass --db
`);
    return 2;
  }
  const { checkTrajectoryDbFile: checkTrajectoryDbFile2, selectContracts: selectContracts2, trajectoryDoctorTools: trajectoryDoctorTools2 } = await Promise.resolve().then(() => (init_trajectory_doctor(), trajectory_doctor_exports));
  const ids = idList2 ? idList2.split(",").map((s) => s.trim()).filter(Boolean) : void 0;
  const selected = selectContracts2(ids);
  if ("error" in selected) {
    io2.out(json(selected));
    return 2;
  }
  let report = checkTrajectoryDbFile2(dbPath2, selected.contracts);
  if (!report.schema.current) {
    io2.out(json(report));
    io2.err(
      `trajectory-doctor: unchecked (schema v${report.schema.stored} < v${report.schema.required} \u2014 start the trajectory server to migrate)
`
    );
    return 2;
  }
  if (record) {
    const { TrajectoryDB: TrajectoryDB2, TARGET_SCHEMA_VERSION: TARGET_SCHEMA_VERSION2 } = await Promise.resolve().then(() => (init_db2(), db_exports));
    if (report.schema.stored !== TARGET_SCHEMA_VERSION2) {
      io2.out(json(report));
      io2.err(
        `trajectory-doctor: --record needs the server schema v${TARGET_SCHEMA_VERSION2} (DB is v${report.schema.stored}) \u2014 start the trajectory server to migrate; nothing recorded
`
      );
      return 2;
    }
    const db = new TrajectoryDB2(dbPath2);
    const args = { agent: "bro", record: true };
    if (ids) args.ids = ids;
    const res = await trajectoryDoctorTools2(db).handlers.trajectory_doctor(args);
    db.close();
    const first = res.content[0];
    report = JSON.parse(first.type === "text" ? first.text : "");
    if (res.isError) {
      io2.out(json(report));
      return 2;
    }
  }
  io2.out(json(report));
  return report.healthy ? 0 : 1;
}

// src/cli/validation-record-fallback.ts
init_audit2();
init_db();
init_sqlite_shell();
init_review_probes();
init_verification_runs();
var USAGE6 = '{"error":"usage","message":"validation-record-fallback <task_id> <attempt_n> <verdict> <feedback> <subagent_session_id> [<findings_json>] [<probes_json>]"}\n';
var WS = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
var FINDING_SHAPE = "{criterion_id?, probe_cmd, expected, observed, severity?, class?}";
var PASS_READ_TIMEOUT_MS = 5e3;
var ALLOWED_KEYS = "('criterion_id', 'probe_cmd', 'expected', 'observed', 'severity', 'class')";
var SEVERITIES = "('blocking', 'nit', 'pre_existing')";
var SEVERITY_SQL = "COALESCE(json_extract(e.value, '$.severity'), 'blocking')";
function badText(field2) {
  return `WHEN json_type(e.value, '$.${field2}') IS NOT 'text' OR trim(json_extract(e.value, '$.${field2}'), ${WS}) = '' THEN 'findings[' || e.key || '].${field2} must be a non-empty string'`;
}
function badOptionalText(field2) {
  return `WHEN json_type(e.value, '$.${field2}') NOT IN ('null', 'text') OR trim(json_extract(e.value, '$.${field2}'), ${WS}) = ''
      THEN 'findings[' || e.key || '].${field2} must be a non-empty string or null'`;
}
var FINDINGS_CHECK_SQL = `
WITH f(v) AS (SELECT ?1),
bad(k, msg) AS (
  SELECT e.key, CASE
    WHEN e.type <> 'object' THEN 'findings[' || e.key || '] must be an object ${FINDING_SHAPE}'
    WHEN EXISTS (SELECT 1 FROM json_each(e.value) k WHERE k.key NOT IN ${ALLOWED_KEYS})
      THEN 'findings[' || e.key || '] has unknown field(s) ' || (SELECT group_concat(k.key, ', ') FROM json_each(e.value) k WHERE k.key NOT IN ${ALLOWED_KEYS}) || '; allowed: criterion_id, probe_cmd, expected, observed, severity, class'
    ${badText("probe_cmd")}
    ${badText("expected")}
    ${badText("observed")}
    ${badOptionalText("criterion_id")}
    WHEN json_type(e.value, '$.severity') NOT IN ('null', 'text') OR json_extract(e.value, '$.severity') NOT IN ${SEVERITIES}
      THEN 'findings[' || e.key || '].severity must be one of blocking, nit, pre_existing'
    ${badOptionalText("class")}
  END
  FROM f, json_each(f.v) e
  WHERE json_valid(f.v) AND json_type(f.v) = 'array'
),
blocking(n) AS (
  SELECT COUNT(*) FROM f, json_each(f.v) e
  WHERE json_valid(f.v) AND json_type(f.v) = 'array' AND ${SEVERITY_SQL} = 'blocking'
)
SELECT CASE
  WHEN NOT json_valid(v) THEN 'invalid_findings|findings is not valid JSON'
  WHEN json_type(v) NOT IN ('array', 'null') THEN 'invalid_findings|findings must be a JSON array of ${FINDING_SHAPE}'
  WHEN ?2 = 'fail' AND COALESCE(json_array_length(v), 0) = 0 THEN 'findings_required|a fail verdict needs a non-empty findings array, one ${FINDING_SHAPE} per defect, each probe_cmd a command that exits 0 once the defect is fixed'
  WHEN EXISTS (SELECT 1 FROM bad WHERE msg IS NOT NULL) THEN (SELECT 'invalid_findings|' || msg FROM bad WHERE msg IS NOT NULL ORDER BY k LIMIT 1)
  WHEN ?2 = 'pass' AND (SELECT n FROM blocking) > 0 THEN 'findings_refused|a pass verdict records only nit or pre_existing findings (an omitted severity is blocking); send a blocking finding with verdict fail'
  WHEN ?2 = 'fail' AND (SELECT n FROM blocking) = 0 THEN 'findings_required|a fail verdict needs at least one finding with severity blocking (an omitted severity is blocking); nit and pre_existing findings alone ride on a pass'
  ELSE 'ok'
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
function probesCheck(raw, verdict) {
  let parsed;
  if (raw !== void 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new ProbesError("probes_invalid", "probes is not valid JSON");
    }
  }
  try {
    return parseProbes(verdict, parsed);
  } catch (e) {
    if (e instanceof ProbesError) return e;
    throw e;
  }
}
function passRefusal(db, taskId) {
  try {
    const sqlite2 = loadNodeSqlite();
    if (!sqlite2) throw new Error("node:sqlite is unavailable in this Node");
    const conn = new sqlite2.DatabaseSync(db, { timeout: PASS_READ_TIMEOUT_MS });
    try {
      const sha = conn.prepare("SELECT commit_sha FROM tasks WHERE id = ?").get(Number(taskId))?.commit_sha ?? null;
      const run2 = conn.prepare(PASS_RUN_SQL).get(Number(taskId), (sha ?? "").toLowerCase());
      const refusal = passRunRefusal(taskId, sha, run2);
      return refusal === null ? null : { code: VERIFICATION_RUN_REQUIRED, message: refusal };
    } finally {
      conn.close();
    }
  } catch (e) {
    return { code: "db-read-failed", message: `could not read the verification run from ${db}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
function jsonError(code, message3) {
  return `{"error":"${code}","message":"${message3.replace(/\n/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"}
`;
}
function writeSql(taskId, attemptN, verdict, feedback, session, findings, probes, createdAt) {
  const safeFindings = sqlQuote(findings);
  const stored = probesJson(probes);
  const probesValue = stored === null ? "NULL" : `'${sqlQuote(stored)}'`;
  const findingsArray = `CASE json_type('${safeFindings}') WHEN 'array' THEN json('${safeFindings}') ELSE '[]' END`;
  return `CREATE TEMP TABLE fallback_attempt AS
  SELECT CASE WHEN EXISTS (SELECT 1 FROM validation_attempts WHERE task_id = ${taskId} AND attempt_n = ${attemptN})
    THEN (SELECT MAX(attempt_n) + 1 FROM validation_attempts WHERE task_id = ${taskId})
    ELSE ${attemptN} END AS n;
INSERT INTO validation_attempts
  (task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, created_at, probes_json)
VALUES
  (${taskId}, (SELECT n FROM fallback_attempt), 'code-reviewer', '${verdict}', '${sqlQuote(feedback)}', 0, '${sqlQuote(session)}', '${createdAt}', ${probesValue});
CREATE TEMP TABLE fallback_last_finding AS
  SELECT COALESCE(MAX(CAST(substr(id, instr(id, '-') + 1) AS INTEGER)), 0) AS n
  FROM review_findings WHERE task_id = ${taskId};
INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at, severity, class)
  SELECT 'F${taskId}-' || ((SELECT n FROM fallback_last_finding) + e.key + 1), ${taskId}, (SELECT n FROM fallback_attempt),
    CASE WHEN json_type(e.value, '$.criterion_id') = 'text' THEN trim(json_extract(e.value, '$.criterion_id'), ${WS}) END,
    trim(json_extract(e.value, '$.probe_cmd'), ${WS}),
    trim(json_extract(e.value, '$.expected'), ${WS}),
    trim(json_extract(e.value, '$.observed'), ${WS}),
    'open', '${createdAt}',
    ${SEVERITY_SQL},
    CASE WHEN json_type(e.value, '$.class') = 'text' THEN trim(json_extract(e.value, '$.class'), ${WS}) END
  FROM json_each(${findingsArray}) e
  ORDER BY e.key;
SELECT n FROM fallback_attempt;
SELECT json_group_array(id) FROM (
  SELECT 'F${taskId}-' || ((SELECT n FROM fallback_last_finding) + e.key + 1) AS id
  FROM json_each(${findingsArray}) e
  ORDER BY e.key);
DROP TABLE fallback_last_finding;
DROP TABLE fallback_attempt;`;
}
function validationRecordFallback(argv2, env, io2) {
  if (argv2.length < 5 || argv2.length > 7) {
    io2.out(USAGE6);
    return 1;
  }
  const [taskId, attemptN, verdict, feedback, session] = argv2;
  const findings = argv2[5] || "[]";
  const probesArg = argv2[6] || void 0;
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
    io2.out(jsonError(code, bar < 0 ? check : check.slice(bar + 1)));
    return 1;
  }
  const probes = probesCheck(probesArg, verdict);
  if (probes instanceof ProbesError) {
    io2.out(jsonError(probes.code, probes.detail));
    return 1;
  }
  const db = fallbackDbPath(env);
  if (!isFile2(db)) {
    io2.out(dbNotFoundJson(db));
    return 1;
  }
  if (verdict === "pass") {
    const refusal = passRefusal(db, taskId);
    if (refusal) {
      io2.out(jsonError(refusal.code, refusal.message));
      return 1;
    }
  }
  const r = dbWrite(db, writeSql(taskId, attemptN, verdict, feedback, session, findings, probes, nowIso()), {
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
  const out = r.stdout.replace(/\n+$/, "").split("\n");
  const ids = out.pop() || "[]";
  const stored = out.pop() || attemptN;
  io2.out(`{"ok":true,"task_id":${taskId},"attempt_n":${stored},"verdict":"${verdict}","findings":${ids}}
`);
  return 0;
}

// src/cli/index.ts
var SUBCOMMANDS = {
  "assert-sql": assertSql,
  "backfill-agent-runs": backfillAgentRuns,
  "bro-sqlite-readonly": broSqliteReadonly,
  "heal-mcp-cache": healMcpCache,
  health,
  "hook-lib": hookLib,
  integrate,
  "prompt-author-lint": promptAuthorLint,
  "stale-docs": staleDocs,
  "trajectory-doctor": trajectoryDoctor,
  "validation-record-fallback": validationRecordFallback
};
var USAGE7 = `usage: cli.js <${Object.keys(SUBCOMMANDS).join("|")}> [args...]
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
  io.out(USAGE7);
} else if (!run) {
  io.err(name === void 0 ? USAGE7 : `cli.js: unknown subcommand '${name}'
${USAGE7}`);
  process.exitCode = 2;
} else {
  void Promise.resolve(run(argv, process.env, io)).then((code) => {
    process.exitCode = code;
  });
}
//# sourceMappingURL=cli.js.map
