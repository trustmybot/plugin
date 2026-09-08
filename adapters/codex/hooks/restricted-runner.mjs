#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { calculateRuntimeDigest } from "./dispatcher.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const PREFLIGHT_TIMEOUT_MS = 5_000;
const MAX_SCAN_ENTRIES = 200_000;
const PROTECTED_NAMES = new Set([".git", ".tmb", ".claude", ".codex"]);
const SYSTEM_READ_ROOTS = ["/System", "/usr", "/bin", "/sbin", "/opt/homebrew", "/Library/Developer/CommandLineTools", "/Applications/Xcode.app"];

function fail(message) { throw new Error(`TMB-CODEX-RUNNER: ${message}`); }
function within(root, path) {
  const rel = relative(root.normalize("NFC").toLowerCase(), path.normalize("NFC").toLowerCase());
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function canonicalDirectory(path) {
  const canonical = realpathSync(path);
  if (!lstatSync(canonical).isDirectory() || /[\x00-\x1f\x7f]/u.test(canonical)) fail("runtime directory is not a canonical ordinary path");
  return canonical;
}
function executable(program, context) {
  const candidates = program === "git" ? ["/usr/bin/git"] : process.env.PATH.split(delimiter).map((dir) => resolve(dir, program));
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      const stats = lstatSync(real);
      // Apple's immutable /usr/bin/git launcher shares its inode with other
      // system launchers. User-installed executables must have one link.
      if (!stats.isFile() || program !== "git" && stats.nlink > 1 || [context.root, context.gitDir, context.commonDir, PLUGIN_ROOT].some((root) => within(root, real))) continue;
      accessSync(real, constants.X_OK);
      return real;
    } catch { /* A missing host candidate is not an execution fallback. */ }
  }
  fail("reviewed command has no ordinary executable outside the checkout and plugin");
}
function isProtected(root, candidate, pluginRoot) {
  const rel = relative(root, candidate);
  const first = rel.split(sep)[0]?.normalize("NFC").toLowerCase();
  return PROTECTED_NAMES.has(first) || within(pluginRoot, candidate);
}
export function rejectWritableAliases(root, { pluginRoot = PLUGIN_ROOT, skipProtected = false } = {}) {
  const deadline = Date.now() + PREFLIGHT_TIMEOUT_MS;
  const pending = [root];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++count > MAX_SCAN_ENTRIES || Date.now() > deadline) fail("writable-tree alias inspection exceeded its bounded budget");
      const candidate = resolve(directory, entry.name);
      if (skipProtected && isProtected(root, candidate, pluginRoot)) continue;
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) pending.push(candidate);
      else if (!stats.isFile() || stats.nlink !== 1) fail("writable tree contains a hard-link alias or special file");
    }
  }
}
function readRoots(binary) {
  const roots = [];
  for (const root of SYSTEM_READ_ROOTS) {
    try { roots.push(canonicalDirectory(root)); } catch { /* Optional installed toolchains. */ }
  }
  for (const path of [binary, process.execPath]) {
    const bin = dirname(realpathSync(path));
    roots.push(bin.endsWith("/bin") ? dirname(bin) : bin);
  }
  return [...new Set(roots)];
}
function cleanEnvironment(scratch) {
  return {
    PATH: process.env.PATH, HOME: resolve(scratch, "home"), TMPDIR: resolve(scratch, "tmp"),
    XDG_CACHE_HOME: resolve(scratch, "cache"), XDG_CONFIG_HOME: resolve(scratch, "config"),
    XDG_DATA_HOME: resolve(scratch, "data"), LC_ALL: "C", LANG: "C", CI: "1", TERM: "dumb",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat",
    npm_config_cache: resolve(scratch, "npm-cache"), npm_config_userconfig: "/dev/null",
    npm_config_audit: "false", npm_config_fund: "false", PIP_NO_INPUT: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
}
function gitPrefix(context) {
  return ["--no-pager", `--git-dir=${context.gitDir}`, `--work-tree=${context.root}`,
    "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
}
function assertNoGitHooks(context) {
  const env = { PATH: "/usr/bin:/bin", HOME: homedir(), LC_ALL: "C" };
  const privatePaths = [resolve(context.root, ".claude"), resolve(homedir(), ".claude")];
  const preflightProfile = `(version 1) (allow default) (deny file-write* (require-not (literal "/dev/null"))) (deny network*)
    (deny file-read* ${privatePaths.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ")})`;
  const result = execFileSync("/usr/bin/sandbox-exec", ["-p", preflightProfile,
    "/usr/bin/git", "--git-dir", context.gitDir, "config", "--null", "--list"], {
    cwd: "/", env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1_000, maxBuffer: 256 * 1024,
  });
  // These operations cannot honor custom helper semantics inside a no-fork
  // sandbox. Refuse them explicitly, rather than silently skipping hooks.
  const entries = result.split("\0").map((entry) => entry.split("\n", 1)[0].toLowerCase());
  if (entries.some((key) => key === "core.hookspath" || key.startsWith("filter.") || key === "commit.gpgsign" || key.startsWith("gpg."))) {
    fail("local Git delivery with configured hooks, filters, or signing is not qualified");
  }
  const hookNames = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-checkout", "post-index-change", "reference-transaction", "pre-push", "post-rewrite"];
  for (const name of hookNames) {
    try {
      accessSync(resolve(context.commonDir, "hooks", name), constants.X_OK);
      fail("local Git delivery with executable repository hooks is not qualified");
    } catch (error) {
      if (error?.message?.startsWith("TMB-CODEX-RUNNER:")) throw error;
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error?.code)) throw error;
    }
  }
  const identity = new Map();
  for (const entry of result.split("\0")) {
    const split = entry.indexOf("\n");
    const key = entry.slice(0, split).toLowerCase();
    if (["user.name", "user.email"].includes(key)) {
      const value = entry.slice(split + 1);
      if (!value || value.length > 512 || /[\x00-\x1f\x7f]/u.test(value)) fail("Git author identity is not a bounded ordinary value");
      identity.set(key, value);
    }
  }
  return [...identity].flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}
function transportExecutables() {
  const git = realpathSync("/usr/bin/git");
  const path = execFileSync(git, ["--exec-path"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 1_000 }).trim();
  const root = canonicalDirectory(path);
  if (!root.startsWith("/usr/") && !root.startsWith("/Library/Developer/CommandLineTools/") && !root.startsWith("/Applications/Xcode.app/")) fail("system Git transport directory is not trusted");
  const helpers = ["git-remote-https", "git-remote-http", "git-send-pack", "git-pack-objects"].map((name) => realpathSync(resolve(root, name)));
  return [...new Set([git, ...helpers])];
}
function stopGroup(child, signal = "SIGKILL") {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
}
async function execute(profile, binary, args, cwd, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, binary, ...args], {
      cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let outputBytes = 0;
    let failure;
    let forcedCode;
    let exitTimer;
    let stopTimer;
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      clearTimeout(stopTimer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      try { stopGroup(child); } catch { failure ??= "process-group cleanup failed"; }
      child.stdout.destroy();
      child.stderr.destroy();
      if (failure) process.stderr.write(`TMB-CODEX-RUNNER: ${failure}\n`);
      resolveRun(forcedCode ?? (failure ? 125 : code));
    };
    const requestStop = (signal, code, message) => {
      failure = message;
      forcedCode = code;
      stopGroup(child, signal);
      stopTimer ??= setTimeout(() => { stopGroup(child); finish(code); }, 500);
    };
    const interrupt = () => requestStop("SIGINT", 130, "command interrupted");
    const terminate = () => requestStop("SIGTERM", 143, "command terminated");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const timer = setTimeout(() => { failure = "command exceeded its ten minute deadline"; forcedCode = 124; stopGroup(child); finish(124); }, COMMAND_TIMEOUT_MS);
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) { failure = "command output exceeded 8 MiB"; stopGroup(child); finish(125); }
        else destination.write(chunk);
      });
    }
    child.once("error", (error) => { clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); reject(error); });
    // Normally close drains both pipes. Bound the drain after exit because a
    // detached descendant can retain them; its inherited sandbox still applies.
    child.once("exit", (code, signal) => {
      const result = code ?? (signal === "SIGINT" ? 130 : 125);
      child.once("close", () => finish(result));
      exitTimer = setTimeout(() => finish(result), 100);
    });
  });
}

export async function restrictedMain(argv) {
  if (argv.length !== 6 || argv[0] !== "--policy-sha256" || !/^[a-f0-9]{64}$/u.test(argv[1]) || argv[2] !== "--cwd" || argv[4] !== "--command") fail("runner accepts only the pinned digest, canonical cwd, and reviewed command");
  if (process.platform !== "darwin") fail("this host does not provide the qualified macOS sandbox");
  // CoreFoundation adds its encoding hint during Node startup even after env -i.
  if (process.execArgv.length || Object.keys(process.env).some((key) => !["PATH", "TMB_CODEX_PLUGIN_DATA", "__CF_USER_TEXT_ENCODING"].includes(key))) fail("start the runner through the exact env -i wrapper before Node loads");
  if (calculateRuntimeDigest(PLUGIN_ROOT) !== argv[1]) fail("installed runtime or Hook definition digest mismatch");
  const cwd = canonicalDirectory(argv[3]);
  if (cwd !== argv[3]) fail("cwd must already be canonical");
  const { resolveRepoContext, classifyRestrictedCommand, canonicalFutureDirectory } = await import("./repo-policy.mjs");
  const pluginData = process.env.TMB_CODEX_PLUGIN_DATA ? canonicalFutureDirectory(process.env.TMB_CODEX_PLUGIN_DATA) : null;
  if (process.env.TMB_CODEX_PLUGIN_DATA && (!pluginData || pluginData !== process.env.TMB_CODEX_PLUGIN_DATA)) {
    fail("plugin data path must already identify a canonical existing or future directory");
  }
  const context = resolveRepoContext(cwd);
  if (!["primary", "linked"].includes(context.kind)) fail("a branch-backed checkout is required");
  const classification = await classifyRestrictedCommand(argv[5], context, { pluginRoot: PLUGIN_ROOT, pluginData });
  if (classification.decision !== "allow") fail(classification.reason);
  const { mode, tokens } = classification;
  if (mode === "read") fail("ordinary finite reads do not require this execution entry");
  const binary = executable(tokens[0], context);
  const scratch = mkdtempSync("/private/tmp/tmb-codex-run-");
  chmodSync(scratch, 0o700);
  try {
    for (const dir of ["home", "tmp", "cache", "config", "data", "npm-cache"]) mkdirSync(resolve(scratch, dir), { mode: 0o700 });
    let env = cleanEnvironment(scratch);
    let args = tokens.slice(1);
    let executionCwd = cwd;
    let identity = [];
    let executables = [binary];
    if (mode === "validation") rejectWritableAliases(context.root, { skipProtected: true });
    if (mode === "git-local" || mode === "git-push") {
      for (const directory of new Set([context.gitDir, context.commonDir])) rejectWritableAliases(directory);
      identity = assertNoGitHooks(context);
    }
    if (mode === "git-read") args = [...gitPrefix(context), ...args];
    if (mode === "git-local") args = [...gitPrefix(context), ...identity, ...args];
    if (mode === "forge" || mode === "git-push") {
      const binding = await import("./forge-binding.mjs");
      const target = binding.resolveOriginTarget(context);
      const credentialBinary = mode === "forge" ? binary : executable(target.provider, context);
      const options = { scratch, executable: credentialBinary, hostHome: homedir() };
      if (mode === "forge") {
        const prepared = await binding.prepareForgeInvocation(tokens, target, context, options);
        args = prepared.args;
        env = { ...env, ...prepared.env };
        executionCwd = prepared.cwd;
        executables.push(realpathSync("/usr/bin/git"));
      } else {
        const prepared = await binding.prepareGitPushInvocation(target, context, options);
        env = { ...env, ...prepared.env };
        args = [...gitPrefix(context), "-c", "core.hooksPath=/dev/null", "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", "--signed=false", prepared.url, `HEAD:refs/heads/${context.branch}`];
        executables = transportExecutables();
      }
    }
    const { buildRestrictedProfile } = await import("./restricted-profile.mjs");
    const profile = buildRestrictedProfile({ mode, ...context, pluginRoot: realpathSync(PLUGIN_ROOT), pluginData,
      scratch, readRoots: readRoots(binary), executables });
    // The actual child starts only through sandbox-exec. An application error
    // returns a failure; there is deliberately no unsandboxed fallback.
    const result = await execute(profile, binary, args, executionCwd, env);
    if (result === 0 && mode === "git-push" && (tokens.includes("-u") || tokens.includes("--set-upstream"))) {
      const localProfile = buildRestrictedProfile({ mode: "git-local", ...context, pluginRoot: realpathSync(PLUGIN_ROOT),
        pluginData, scratch, readRoots: readRoots(binary), executables: [binary] });
      for (const [key, value] of [[`branch.${context.branch}.remote`, "origin"], [`branch.${context.branch}.merge`, `refs/heads/${context.branch}`]]) {
        const configured = await execute(localProfile, binary, [...gitPrefix(context), "config", "--local", key, value], cwd, cleanEnvironment(scratch));
        if (configured !== 0) fail("push succeeded, but local upstream tracking could not be configured; do not repeat the push");
      }
    }
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

let entry = false;
try { entry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* Imported for bounded unit checks. */ }
if (entry) {
  try { process.exitCode = await restrictedMain(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "TMB-CODEX-RUNNER: restricted execution failed"}\n`); process.exitCode = 125; }
}
