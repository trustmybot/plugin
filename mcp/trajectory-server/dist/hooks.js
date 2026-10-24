// src/hooks/index.ts
import { readFileSync as readFileSync3 } from "node:fs";

// src/hooks/ensure-mcp-deps-installed.ts
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync as readFileSync2,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, isAbsolute, join as join2, relative, resolve as resolve2, sep } from "node:path";
import { pathToFileURL } from "node:url";

// src/hooks/gate.ts
var ALLOW = Object.freeze({ stdout: "", code: 0 });

// src/runtime-deps.ts
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
var TRANSFORMERS_VERSION = "3.8.1";
var TRANSFORMERS_PACKAGE = "@huggingface/transformers";
function runtimeDepsKey(platform = process.platform, arch = process.arch) {
  return `${TRANSFORMERS_VERSION}-${platform}-${arch}`;
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
function transformersVersion(root) {
  const version = readPackageJson(transformersPackageDir(root))?.["version"];
  return typeof version === "string" ? version : void 0;
}
function transformersEsmEntry(root) {
  const pkgDir = transformersPackageDir(root);
  const target = nodeImportDefault(rootExport(readPackageJson(pkgDir)?.["exports"]));
  if (!target) return void 0;
  const entry = resolve(pkgDir, target);
  return existsSync(entry) ? entry : void 0;
}

// src/hooks/ensure-mcp-deps-installed.ts
var GATE_NAME = "ensure-mcp-deps-installed";
var INSTALL_FLAG = "--install";
var MCP_REL = join2("mcp", "trajectory-server");
var LOCK_STALE_DEFAULT_MIN = 15;
var STAGING_STALE_MS = 60 * 60 * 1e3;
var INSTALLED_AT = ".installed-at";
var STAGING_PREFIX = ".staging-";
var LEGACY_INSTALLERS = [
  { name: "bun", args: ["install", "--production", "--ignore-scripts", "--no-save"] },
  { name: "npm", args: ["install", "--omit=dev", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund"] }
];
var DATA_INSTALLERS = [
  { name: "bun", args: ["install", "--frozen-lockfile", "--production", "--ignore-scripts"] },
  { name: "npm", args: ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"] }
];
function context(env) {
  if (env.TMB_SKIP_MCP_DEPS_INSTALL === "1") return void 0;
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (!root) return void 0;
  const mcpDir = join2(root, MCP_REL);
  if (!isFile(join2(mcpDir, "package.json"))) return void 0;
  const dataDir = env.CLAUDE_PLUGIN_DATA ?? "";
  const legacyReason = process.platform === "win32" ? "win32 has no symlink bridge yet" : dataDir === "" ? "CLAUDE_PLUGIN_DATA is unset" : "";
  return { env, root, mcpDir, legacy: legacyReason !== "", legacyReason, dataDir };
}
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function isRealDir(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function onPath(name2, env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join2(dir, name2);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return void 0;
}
function findInstaller(env, installers) {
  for (const installer of installers) {
    const path = onPath(installer.name, env);
    if (path) return { ...installer, path };
  }
  return void 0;
}
function commandLine(installer) {
  return [installer.name, ...installer.args].join(" ");
}
function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function bareSpecifierVersion(mcpDir) {
  let resolved;
  try {
    resolved = createRequire(join2(mcpDir, "package.json")).resolve(TRANSFORMERS_PACKAGE);
  } catch {
    return void 0;
  }
  for (let dir = dirname(resolved); dirname(dir) !== dir; dir = dirname(dir)) {
    const pkg = readJson(join2(dir, "package.json"));
    if (pkg?.["name"] === TRANSFORMERS_PACKAGE) {
      return typeof pkg["version"] === "string" ? pkg["version"] : void 0;
    }
  }
  return void 0;
}
function isValidInstall(dir) {
  return isFile(join2(dir, INSTALLED_AT)) && transformersVersion(dir) === TRANSFORMERS_VERSION && transformersEsmEntry(dir) !== void 0;
}
function depsDir(dataDir) {
  return join2(dataDir, "deps");
}
function swapSymlink(target, link) {
  const tmp = `${link}.tmb-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}
function pointCurrent(dataDir, key) {
  const link = join2(depsDir(dataDir), "current");
  let existing;
  try {
    existing = readlinkSync(link);
  } catch {
    existing = void 0;
  }
  if (existing !== key) swapSymlink(key, link);
}
function ensureBridge(root, dataDir, rule = "any-symlink") {
  const link = join2(root, "node_modules", TRANSFORMERS_PACKAGE);
  const target = join2(depsDir(dataDir), "current", "node_modules", TRANSFORMERS_PACKAGE);
  let existing;
  try {
    const st = lstatSync(link);
    if (!st.isSymbolicLink()) return false;
    existing = readlinkSync(link);
  } catch {
    existing = void 0;
  }
  if (existing === target) return true;
  if (existing !== void 0 && rule === "own-symlink" && !isWithin(resolve2(depsDir(dataDir)), resolve2(dirname(link), existing))) {
    return false;
  }
  mkdirSync(dirname(link), { recursive: true });
  swapSymlink(target, link);
  return true;
}
function staleMinutes(env) {
  const raw = env.TMB_MCP_DEPS_LOCK_STALE_MIN ?? "";
  return /^[0-9]+$/.test(raw) ? Number(raw) : LOCK_STALE_DEFAULT_MIN;
}
function takeLock(lock, staleMin) {
  try {
    if (Date.now() - statSync(lock).mtimeMs > staleMin * 6e4) rmdirSync(lock);
  } catch {
  }
  try {
    mkdirSync(dirname(lock), { recursive: true });
    mkdirSync(lock);
    return true;
  } catch {
    return false;
  }
}
function releaseLock(lock) {
  try {
    rmdirSync(lock);
  } catch {
  }
}
function lockPath(ctx) {
  return ctx.legacy ? join2(ctx.mcpDir, ".deps-install.lock") : join2(depsDir(ctx.dataDir), ".install.lock");
}
function pluginName(root) {
  const name2 = readJson(join2(root, ".claude-plugin", "plugin.json"))?.["name"];
  return typeof name2 === "string" && name2 !== "" ? name2 : "tmb";
}
function probeDb(db, env) {
  if (!isFile(db)) return "stale";
  const sqlite = onPath("sqlite3", env);
  if (!sqlite) return "current";
  const r = spawnSync(sqlite, ["-readonly", "-cmd", ".timeout 1500", db, "SELECT name FROM pragma_table_info('tasks');"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (r.status !== 0) return "error";
  return r.stdout.includes("prompt_bearing") ? "current" : "stale";
}
function resolveDb(env, root) {
  const override = env.TRAJECTORY_DB_PATH;
  if (override) return isFile(override) ? override : void 0;
  const name2 = pluginName(root);
  const location = (dir) => join2(dir, ".claude", name2, "trajectory.db");
  if (env.TMB_FORBID_LIVE_SYNC === "1" || env.TMB_TEST_RUN_ID) {
    if (!env.CLAUDE_PROJECT_DIR) return void 0;
    const candidate = location(env.CLAUDE_PROJECT_DIR);
    return isFile(candidate) ? candidate : void 0;
  }
  const start = env.CLAUDE_PROJECT_DIR || process.cwd();
  const home = env.HOME;
  let outermost;
  for (let dir = start; dir !== "" && dirname(dir) !== dir; dir = dirname(dir)) {
    if (dir === home && start !== home) break;
    const candidate = location(dir);
    if (!isFile(candidate) || probeDb(candidate, env) === "stale") continue;
    outermost = candidate;
    if (isFile(join2(dirname(candidate), "standalone")) || isRealDir(join2(dirname(candidate), "standalone"))) break;
  }
  return outermost;
}
function installLog(ctx) {
  const db = resolveDb(ctx.env, ctx.root);
  if (!db) return { env: ctx.env };
  const state = dirname(db);
  try {
    mkdirSync(join2(state, "logs"), { recursive: true });
  } catch {
    return { env: ctx.env };
  }
  return {
    path: join2(state, "logs", "mcp-deps-install.log"),
    env: {
      ...ctx.env,
      BUN_INSTALL_CACHE_DIR: ctx.env.BUN_INSTALL_CACHE_DIR || join2(state, "cache", "bun"),
      npm_config_cache: ctx.env.npm_config_cache || join2(state, "cache", "npm")
    }
  };
}
function notice(message) {
  const out = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message } };
  return { stdout: `${JSON.stringify(out)}
`, code: 0 };
}
function noInstallerNotice(ctx, hooksEntry) {
  const manual = ctx.legacy ? `cd "${ctx.mcpDir}" && ${commandLine(LEGACY_INSTALLERS[0])}` : `CLAUDE_PLUGIN_ROOT="${ctx.root}" CLAUDE_PLUGIN_DATA="${ctx.dataDir}" node "${hooksEntry}" ${GATE_NAME} ${INSTALL_FLAG} (it installs into ${runtimeDepsRoot(ctx.dataDir)})`;
  return notice(`\u{1F4E6} Semantic search is degraded: the MCP server's @huggingface/transformers is not installed and neither bun nor npm is on PATH. Install one and restart Claude Code, or run: ${manual}`);
}
function startWorker(hooksEntry, log) {
  const fd = log.path ? openSync(log.path, "a") : void 0;
  const stdio = fd === void 0 ? "ignore" : ["ignore", fd, fd];
  try {
    const child = spawn(process.execPath, [hooksEntry, GATE_NAME, INSTALL_FLAG], {
      detached: true,
      stdio,
      env: log.env
    });
    child.on("error", () => void 0);
    child.unref();
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function ensureDeps(env) {
  const ctx = context(env);
  if (!ctx) return ALLOW;
  const key = runtimeDepsKey();
  const installDir = ctx.legacy ? void 0 : runtimeDepsRoot(ctx.dataDir, key);
  if (bareSpecifierVersion(ctx.mcpDir) === TRANSFORMERS_VERSION) {
    if (installDir && isValidInstall(installDir)) ensureBridge(ctx.root, ctx.dataDir, "own-symlink");
    return ALLOW;
  }
  if (installDir && isValidInstall(installDir)) {
    pointCurrent(ctx.dataDir, key);
    ensureBridge(ctx.root, ctx.dataDir);
    return ALLOW;
  }
  const hooksEntry = resolve2(process.argv[1] ?? "");
  const installer = findInstaller(env, ctx.legacy ? LEGACY_INSTALLERS : DATA_INSTALLERS);
  if (!installer) return noInstallerNotice(ctx, hooksEntry);
  const lock = lockPath(ctx);
  if (!takeLock(lock, staleMinutes(env))) return ALLOW;
  const log = installLog(ctx);
  try {
    startWorker(hooksEntry, log);
  } catch {
    releaseLock(lock);
  }
  const logNote = log.path ? ` Log: ${log.path}` : "";
  return notice(`\u{1F4E6} Installing the MCP server's @huggingface/transformers in the background (${installer.name}); semantic search runs on FTS until then and embeddings go live on the next Claude Code restart.${logNote}`);
}
var ensureMcpDepsInstalled = (_payload, env) => {
  try {
    return ensureDeps(env);
  } catch {
    return ALLOW;
  }
};
function stdoutLogger(message) {
  writeSync(1, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${GATE_NAME}: ${message}
`);
}
function treeBytes(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name2) => sum + treeBytes(join2(path, name2)), 0);
}
function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function packageDir(nodeModules, name2) {
  try {
    return realpathSync(join2(nodeModules, name2));
  } catch {
    return void 0;
  }
}
function removeAllBut(dir, keep) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name2 of names) {
    if (!keep.includes(name2)) rmSync(join2(dir, name2), { recursive: true, force: true });
  }
}
function removePackage(nodeModules, name2) {
  const real = packageDir(nodeModules, name2);
  if (real) rmSync(real, { recursive: true, force: true });
  rmSync(join2(nodeModules, name2), { recursive: true, force: true });
}
function pruneRuntimeDeps(root, platform, arch) {
  const nodeModules = join2(root, "node_modules");
  const ort = packageDir(nodeModules, "onnxruntime-node");
  if (ort) {
    const napi = join2(ort, "bin", "napi-v3");
    removeAllBut(napi, [platform]);
    removeAllBut(join2(napi, platform), [arch]);
  }
  removePackage(nodeModules, "onnxruntime-web");
  const transformers = packageDir(nodeModules, TRANSFORMERS_PACKAGE);
  if (transformers) {
    removeAllBut(join2(transformers, "dist"), ["transformers.node.mjs", "transformers.node.cjs"]);
    rmSync(join2(transformers, "src"), { recursive: true, force: true });
    rmSync(join2(transformers, "types"), { recursive: true, force: true });
  }
}
function writeSharpStub(root) {
  const sharp = join2(root, "node_modules", "sharp");
  rmSync(sharp, { recursive: true, force: true });
  mkdirSync(sharp, { recursive: true });
  for (const file of ["package.json", "index.js"]) copyFileSync(join2(root, "sharp-stub", file), join2(sharp, file));
}
function installProblem(dir, env, stdio) {
  const entry = transformersEsmEntry(dir);
  if (!entry) return `${TRANSFORMERS_PACKAGE} has no ESM entry under ${dir}`;
  const version = transformersVersion(dir);
  if (version !== TRANSFORMERS_VERSION) return `${TRANSFORMERS_PACKAGE} is ${version}, expected ${TRANSFORMERS_VERSION}`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(entry).href)});`], {
    env,
    stdio
  });
  if (r.error) return `import check failed: ${r.error.message}`;
  return r.status === 0 ? void 0 : `import check exited ${r.status ?? r.signal}`;
}
function installedAtMs(dir) {
  try {
    const ms = Date.parse(readFileSync2(join2(dir, INSTALLED_AT), "utf8").trim());
    return Number.isNaN(ms) ? 0 : ms;
  } catch {
    return 0;
  }
}
function promote(staging, final) {
  const aside = `${staging}-old`;
  const hadFinal = isRealDir(final);
  if (hadFinal) renameSync(final, aside);
  try {
    renameSync(staging, final);
  } catch (err) {
    if (hadFinal) renameSync(aside, final);
    throw err;
  }
  if (hadFinal) rmSync(aside, { recursive: true, force: true });
}
function collectGarbage(deps, key, log) {
  const entries = readdirSync(deps, { withFileTypes: true });
  const others = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== key).map((e) => ({ name: e.name, at: installedAtMs(join2(deps, e.name)) })).sort((a, b) => b.at - a.at);
  for (const old of others.slice(1)) {
    rmSync(join2(deps, old.name), { recursive: true, force: true });
    log(`removed old key ${old.name}`);
  }
  for (const e of entries) {
    if (!e.name.startsWith(STAGING_PREFIX)) continue;
    const path = join2(deps, e.name);
    try {
      if (Date.now() - lstatSync(path).mtimeMs <= STAGING_STALE_MS) continue;
    } catch {
      continue;
    }
    rmSync(path, { recursive: true, force: true });
    log(`removed stale ${e.name}`);
  }
}
function cacheParent(root) {
  const parent = dirname(resolve2(root));
  const cache = dirname(dirname(parent));
  return basename(cache) === "cache" && basename(dirname(cache)) === "plugins" ? parent : void 0;
}
function cleanupSiblings(root, dataDir, log) {
  const parent = cacheParent(root);
  if (!parent) return;
  const self = basename(resolve2(root));
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === self) continue;
    const version = join2(parent, entry.name);
    let replaced = false;
    for (const nodeModules of [join2(version, "node_modules"), join2(version, MCP_REL, "node_modules")]) {
      if (!isRealDir(nodeModules)) continue;
      rmSync(nodeModules, { recursive: true, force: true });
      log(`removed ${nodeModules}`);
      replaced = true;
    }
    if (replaced && ensureBridge(version, dataDir)) log(`bridged ${version}`);
  }
}
function installRuntimeDeps(opts) {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const log = opts.log ?? stdoutLogger;
  const stdio = ["ignore", opts.stdio ?? "inherit", opts.stdio ?? "inherit"];
  const key = runtimeDepsKey(platform, arch);
  const deps = depsDir(opts.dataDir);
  const staging = join2(deps, `${STAGING_PREFIX}${key}-${process.pid}`);
  const manifest = join2(opts.root, MCP_REL, "runtime-deps");
  let rc = 1;
  try {
    mkdirSync(deps, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    cpSync(manifest, staging, { recursive: true });
    log(`staged ${manifest} in ${staging}`);
    const installer = findInstaller(opts.env, DATA_INSTALLERS);
    if (!installer) throw new Error("neither bun nor npm is on PATH");
    log(`${commandLine(installer)} in ${staging}`);
    const r = spawnSync(installer.path, installer.args, { cwd: staging, env: opts.env, stdio });
    log(`${installer.name} exit ${r.status ?? r.signal}`);
    if (r.error || r.status !== 0) throw new Error(`${installer.name} install failed${r.error ? `: ${r.error.message}` : ""}`);
    writeSharpStub(staging);
    log(`wrote the sharp stub; node_modules ${megabytes(treeBytes(join2(staging, "node_modules")))} before prune`);
    pruneRuntimeDeps(staging, platform, arch);
    log(`pruned to ${platform}/${arch}; node_modules ${megabytes(treeBytes(join2(staging, "node_modules")))}`);
    const problem = installProblem(staging, opts.env, stdio);
    if (problem) throw new Error(problem);
    log(`checked ${TRANSFORMERS_PACKAGE}@${TRANSFORMERS_VERSION}`);
    writeFileSync(join2(staging, INSTALLED_AT), `${(opts.now ?? (() => /* @__PURE__ */ new Date()))().toISOString()}
`);
    promote(staging, join2(deps, key));
    log(`installed ${join2(deps, key)}`);
    pointCurrent(opts.dataDir, key);
    log(`current \u2192 ${key}`);
    collectGarbage(deps, key, log);
    if (ensureBridge(opts.root, opts.dataDir)) log(`bridged ${opts.root}`);
    cleanupSiblings(opts.root, opts.dataDir, log);
    rc = 0;
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    rmSync(staging, { recursive: true, force: true });
  }
  log(`exit ${rc}`);
  return rc;
}
function legacyInstall(ctx, log) {
  log(`${ctx.legacyReason}: installing into ${ctx.mcpDir}`);
  const installer = findInstaller(ctx.env, LEGACY_INSTALLERS);
  if (!installer) {
    log("neither bun nor npm is on PATH");
    return 1;
  }
  log(`${commandLine(installer)} in ${ctx.mcpDir}`);
  const r = spawnSync(installer.path, installer.args, { cwd: ctx.mcpDir, env: ctx.env, stdio: ["ignore", "inherit", "inherit"] });
  const rc = r.status ?? 1;
  log(`exit ${rc}`);
  return rc;
}
function runInstallWorker(env) {
  const ctx = context(env);
  if (!ctx) return 0;
  const lock = lockPath(ctx);
  try {
    return ctx.legacy ? legacyInstall(ctx, stdoutLogger) : installRuntimeDeps({ root: ctx.root, dataDir: ctx.dataDir, env });
  } finally {
    releaseLock(lock);
  }
}

// src/hooks/askuserquestion-length-lint.ts
import { existsSync as existsSync2 } from "node:fs";
var LABEL_MAX_WORDS = 5;
var DESC_MAX_WORDS = 15;
var PREVIEW_MAX_LINES = 4;
var JqError = class extends Error {
};
function isObject2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function jqField(v, key) {
  if (v === null) return null;
  if (!isObject2(v)) throw new JqError(`cannot index ${typeof v} with "${key}"`);
  return Object.hasOwn(v, key) ? v[key] : null;
}
function jqAlt(v, fallback) {
  return v === null || v === false ? fallback : v;
}
function jqEach(v) {
  if (Array.isArray(v)) return v;
  if (isObject2(v)) return Object.values(v);
  throw new JqError(`cannot iterate over ${typeof v}`);
}
function jqItems(get) {
  try {
    return jqEach(get());
  } catch (err) {
    if (err instanceof JqError) return [];
    throw err;
  }
}
function jqRaw(v) {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}
function shellCapture(text) {
  return text.replace(/\0/g, "").replace(/\n+$/, "");
}
function fieldText(option, key) {
  try {
    return shellCapture(jqRaw(jqAlt(jqField(option, key), "")));
  } catch (err) {
    if (err instanceof JqError) return "";
    throw err;
  }
}
function ctypeLocale(env) {
  return env.LC_ALL || env.LC_CTYPE || env.LANG || "C";
}
function splitsOnNbsp(env) {
  const locale = ctypeLocale(env);
  return /\.utf-8$/i.test(locale) && !locale.includes("/") && existsSync2(`/usr/share/locale/${locale}/LC_CTYPE`);
}
function wordCount(text, nbsp) {
  const separators = nbsp ? /[ \t\n\v\f\r ]+/ : /[ \t\n\v\f\r]+/;
  return text.split(separators).filter((word) => word !== "").length;
}
function lineCount(text) {
  return text === "" ? 0 : text.split("\n").length;
}
function toolName(payload) {
  try {
    return shellCapture(jqRaw(jqAlt(jqField(payload, "tool_name"), "")));
  } catch (err) {
    if (err instanceof JqError) return "";
    throw err;
  }
}
function parsePayload(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return void 0;
  }
}
var askuserquestionLengthLint = (payload, env) => {
  const input = parsePayload(payload);
  if (input === void 0 || toolName(input) !== "AskUserQuestion") return ALLOW;
  const nbsp = splitsOnNbsp(env);
  const warnings = [];
  const questions = jqItems(() => jqAlt(jqField(jqField(input, "tool_input"), "questions"), []));
  questions.forEach((question, q) => {
    const options = jqItems(() => jqAlt(jqField(question, "options"), []));
    options.forEach((option, o) => {
      const labelWords = wordCount(fieldText(option, "label"), nbsp);
      const descWords = wordCount(fieldText(option, "description"), nbsp);
      const previewLines = lineCount(fieldText(option, "preview"));
      if (labelWords > LABEL_MAX_WORDS) {
        warnings.push(`q${q}.opt${o} label is ${labelWords} words (target \u2264${LABEL_MAX_WORDS})`);
      }
      if (descWords > DESC_MAX_WORDS) {
        warnings.push(`q${q}.opt${o} description is ${descWords} words (target \u2264${DESC_MAX_WORDS})`);
      }
      if (previewLines > PREVIEW_MAX_LINES) {
        warnings.push(`q${q}.opt${o} preview is ${previewLines} lines (target \u2264${PREVIEW_MAX_LINES})`);
      }
    });
  });
  if (warnings.length === 0) return ALLOW;
  const message = [
    "AskUserQuestion brevity violations (per feedback_ask_user_question.md):",
    ...warnings.map((w) => `  - ${w}`)
  ].join("\n") + "\n\nTargets: label <=5 words, description <=15 words, preview <=4 lines. See #96.";
  const output = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message } };
  return { stdout: `${JSON.stringify(output)}
`, code: 0 };
};

// src/hooks/registry.ts
var GATES = /* @__PURE__ */ new Map([
  ["askuserquestion-length-lint", askuserquestionLengthLint],
  ["ensure-mcp-deps-installed", ensureMcpDepsInstalled]
]);
function findGate(name2) {
  return GATES.get(name2);
}

// src/hooks/index.ts
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}
function main(name2) {
  if (name2 === GATE_NAME && process.argv[3] === INSTALL_FLAG) return runInstallWorker(process.env);
  const gate = findGate(name2);
  if (!gate) {
    process.stderr.write(`TMB hooks: unknown gate '${oneLine(name2)}' \u2014 not run
`);
    return 1;
  }
  const result = gate(readFileSync3(0, "utf8"), process.env);
  process.stdout.write(result.stdout);
  return result.code;
}
var name = process.argv[2] ?? "";
try {
  process.exitCode = main(name);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`TMB hooks: gate '${oneLine(name)}' failed: ${oneLine(detail)}
`);
  process.exitCode = 1;
}
//# sourceMappingURL=hooks.js.map
