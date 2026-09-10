import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { CODEX_SCOPE_4_TOOL_NAMES as TMB_TOOL_NAMES } from "../tool-names.mjs";

export { TMB_TOOL_NAMES };

const requireBuiltin = createRequire(import.meta.url);
const DEFAULT_PLUGIN_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export const MAX_COMMAND_BYTES = 256 * 1024;
export const REPO_RESOLUTION_TIMEOUT_MS = 700;

const DECISION_ALLOW = Object.freeze({ decision: "allow" });
const TMB_TOOL_NAME_SET = new Set(TMB_TOOL_NAMES);
const TMB_MCP_PREFIXES = [
  "mcp__trajectory_server__",
  "mcp__plugin_tmb_trajectory-server__",
  "mcp__plugin_tmb_trajectory_server__",
];
const READ_ONLY_TOOLS = new Set([
  "read",
  "read_file",
  "view_image",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "update_plan",
  "get_goal",
  "request_user_input",
]);
const CODEX_DIAGNOSTIC_TOOLS = new Set([
  "mcp__codex_app__get_handoff_status",
  "mcp__codex_app__list_projects",
  "mcp__codex_app__list_threads",
  "mcp__codex_app__load_workspace_dependencies",
  "mcp__codex_app__read_thread",
  "mcp__codex_app__read_thread_terminal",
  "mcp__codex_app__wait_threads",
]);
const SHELL_TOOLS = new Set([
  "bash",
]);
const TRUSTED_SHELL_BUILTINS = new Set(["command", "false", "pwd", "test", "true"]);
const UNTRUSTED_PATH_MARKERS = [
  "/node" + "_modules/.bin",
  "/.asdf/shims",
  "/.mise/shims",
  "/.pyenv/shims",
  "/.rbenv/shims",
];
const DIRECT_WRITE_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "notebook_edit",
]);
const CODE_MODE_TOOLS = new Set([
  "code_mode",
  "js_repl",
  "javascript_repl",
]);
const NESTED_LIFECYCLE_TOOLS = new Set([
  "exec",
  "functions_exec",
  "functions_wait",
  "wait",
  "write_stdin",
]);
const EXEC_COMMAND_KEYS = new Set([
  "cmd",
  "shell",
  "sandbox_permissions",
  "justification",
  "login",
  "max_output_tokens",
  "tty",
  "workdir",
  "yield_time_ms",
]);
const ORCHESTRATION_WRAPPER_PATTERN = /^\s*text\(JSON\.stringify\(await tools\.([A-Za-z][A-Za-z0-9_]*)\(([\s\S]*)\)\)\);\s*$/u;
const TMB_PLUGIN_SELECTORS = new Set([
  "tmb",
  "tmb@trustmybot",
  "tmb@trustmybot-local",
  "tmb@trustmybot-rc",
  "TrustMyBot",
]);
const PERSISTENT_PROGRAMS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "tmux",
  "screen",
  "ssh",
  "sqlite3",
  "psql",
  "mysql",
  "redis-cli",
  "irb",
]);
const FILE_READ_PROGRAMS = new Set([
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "realpath",
  "readlink",
  "dirname",
  "basename",
  "du",
  "jq",
  "test",
  "true",
  "false",
]);
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
]);
const PROTECTED_DELIVERY_BRANCHES = new Set([
  "main",
  "master",
  "dev",
  "develop",
  "development",
  "trunk",
]);
const DELIVERY_BRANCH_PREFIXES = new Set([
  "build",
  "bugfix",
  "chore",
  "ci",
  "codex",
  "docs",
  "feat",
  "feature",
  "fix",
  "hotfix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
]);
const INTERACTIVE_VALIDATION_FLAGS = new Set([
  "--hot",
  "--inspect",
  "--inspect-brk",
  "--interactive",
  "--pdb",
  "--trace",
  "--watch",
  "--watch-all",
  "--watchall",
]);
const FORGE_SIDE_EFFECT_LONG_FLAGS = ["--web", "--watch"];
const ALLOWED_VALIDATION_SIGNATURES = new Set([
  "bash\0tests/run-all.sh",
  "bun\0test",
  "bun\0run\0test",
  "bun\0--bun\0run\0build",
  "npm\0test",
  "npm\0run\0build",
  "npm\0run\0check",
  "npm\0run\0lint",
  "npm\0run\0test",
  "npm\0run\0typecheck",
  "pnpm\0test",
  "pnpm\0run\0build",
  "pnpm\0run\0check",
  "pnpm\0run\0lint",
  "pnpm\0run\0test",
  "pnpm\0run\0typecheck",
  "pnpm\0--silent\0run\0build",
  "pnpm\0--silent\0run\0check",
  "pnpm\0--silent\0run\0lint",
  "pnpm\0--silent\0run\0test",
  "pnpm\0--silent\0run\0typecheck",
  "cargo\0test",
  "cargo\0check",
]);
const SAFE_GIT_PREFIX = [
  "--no-pager",
  "--no-optional-locks",
  "--no-lazy-fetch",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
];
const PROTECTED_EXACT = new Set([
  ".codex/config.toml",
  ".codex/hooks.json",
  ".codex/agents/tmb_swe.toml",
  ".codex/agents/tmb_pr_reviewer.toml",
]);
const PROTECTED_PREFIXES = [".git", ".claude", ".tmb"];
const VALID_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
]);
const OBSERVED_TOOL_NAME_ALIASES = new Map([
  ["Bash", "bash"],
  ["Edit", "edit"],
  ["MultiEdit", "multiedit"],
  ["NotebookEdit", "notebookedit"],
  ["Read", "read"],
  ["Write", "write"],
]);

function deny(reason) {
  return { decision: "deny", reason: `TMB-CODEX-HOOK: ${reason}` };
}

function normalizeToolName(toolName) {
  return OBSERVED_TOOL_NAME_ALIASES.get(toolName) ?? toolName;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowedKeys.has(key));
}

function optionalPositiveInteger(value) {
  return value === undefined || (Number.isInteger(value) && value > 0);
}

function hasExactDataKeys(value, keys) {
  if (!isPlainObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const actualKeys = Reflect.ownKeys(value);
  return actualKeys.length === keys.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value");
  });
}

function hasControlledHostExecution(input, repoContext) {
  const context = input.execution_context;
  // This is top-level metadata from the host's prepared invocation. Requested
  // tool arguments, including nested JSON, cannot attest how a shell will start.
  if (!hasExactDataKeys(input.tool_input, ["command"])
    || !hasExactDataKeys(context, ["kind", "argv", "cwd", "tty", "login", "environment_id", "is_remote", "shell_mode"])) {
    return false;
  }
  return context.kind === "exec_command"
    && Array.isArray(context.argv) && context.argv.length === 3
    && context.argv[0] === "/bin/sh" && context.argv[1] === "-c"
    && typeof input.tool_input.command === "string" && context.argv[2] === input.tool_input.command
    && context.login === false && context.tty === false && context.is_remote === false
    && context.shell_mode === "direct"
    && typeof context.cwd === "string" && isAbsolute(context.cwd)
    && context.cwd === repoContext.cwd && canonicalExistingPath(context.cwd) === context.cwd
    && typeof context.environment_id === "string" && context.environment_id.trim().length > 0
    && Buffer.byteLength(context.environment_id, "utf8") <= 256
    && !/[\x00-\x1f\x7f]/u.test(context.environment_id);
}

function validateLifecycleTool(toolName, toolInput) {
  if (toolName === "functions.wait") {
    const allowedKeys = new Set(["cell_id", "max_tokens", "terminate", "yield_time_ms"]);
    if (!hasOnlyKeys(toolInput, allowedKeys)
      || typeof toolInput.cell_id !== "string"
      || toolInput.cell_id.length === 0
      || !optionalPositiveInteger(toolInput.max_tokens)
      || !optionalPositiveInteger(toolInput.yield_time_ms)
      || (toolInput.terminate !== undefined && typeof toolInput.terminate !== "boolean")) {
      return deny("worker wait payload is outside the bounded lifecycle surface");
    }
    return DECISION_ALLOW;
  }
  if (toolName === "write_stdin") {
    const allowedKeys = new Set(["chars", "max_output_tokens", "session_id", "yield_time_ms"]);
    if (!hasOnlyKeys(toolInput, allowedKeys)
      || !Number.isInteger(toolInput.session_id)
      || toolInput.session_id < 0
      || !optionalPositiveInteger(toolInput.max_output_tokens)
      || !optionalPositiveInteger(toolInput.yield_time_ms)
      || (toolInput.chars !== undefined && toolInput.chars !== "" && toolInput.chars !== "\u0003")) {
      return deny("follow-up process control is limited to polling or one interrupt byte");
    }
    return DECISION_ALLOW;
  }
  return null;
}

function parseOrchestrationWrapper(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_COMMAND_BYTES) {
    return null;
  }
  const match = ORCHESTRATION_WRAPPER_PATTERN.exec(source);
  if (!match) {
    return null;
  }
  try {
    return { toolName: match[1], toolInput: JSON.parse(match[2]) };
  } catch {
    return null;
  }
}

function evaluateNestedExecCommand(toolInput, repoContext, options) {
  if (!hasOnlyKeys(toolInput, EXEC_COMMAND_KEYS)
    || typeof toolInput.cmd !== "string"
    || toolInput.login !== false
    || toolInput.shell !== "/bin/sh"
    || (toolInput.sandbox_permissions !== undefined && !["use_default", "require_escalated"].includes(toolInput.sandbox_permissions))
    || (toolInput.justification !== undefined && (typeof toolInput.justification !== "string" || toolInput.justification.length > 4096))
    || toolInput.tty !== false
    || !optionalPositiveInteger(toolInput.max_output_tokens)
    || !optionalPositiveInteger(toolInput.yield_time_ms)) {
    return deny("nested exec_command payload is outside the reviewed non-login shell surface");
  }
  if (typeof toolInput.workdir !== "string"
    || toolInput.workdir !== repoContext.cwd
    || canonicalExistingPath(toolInput.workdir) !== toolInput.workdir) {
    return deny("nested exec_command workdir must match the current canonical checkout directory");
  }
  return evaluateShell({ command: toolInput.cmd }, repoContext, {
    ...options, controlledShell: true,
    requestsEscalation: toolInput.sandbox_permissions === "require_escalated",
  });
}

async function evaluateOrchestrationWrapper(input, options, repoContext) {
  const nestedCall = parseOrchestrationWrapper(input.tool_input);
  if (!nestedCall) {
    return deny("orchestration requires one canonical, statically auditable nested tool call");
  }
  if (NESTED_LIFECYCLE_TOOLS.has(nestedCall.toolName)) {
    return deny("nested orchestration and lifecycle calls are not allowed");
  }
  if (nestedCall.toolName === "exec_command") {
    return evaluateNestedExecCommand(nestedCall.toolInput, repoContext, options);
  }
  const nestedToolInput = nestedCall.toolName === "apply_patch"
    ? { command: nestedCall.toolInput }
    : nestedCall.toolInput;
  return evaluatePreToolUse({
    ...input,
    execution_context: undefined,
    tool_name: nestedCall.toolName,
    tool_input: nestedToolInput,
  }, options);
}

function validateRecoveryTool(toolName, toolInput) {
  if (toolName !== "mcp__codex_app__uninstall_plugin") {
    return null;
  }
  if (!hasOnlyKeys(toolInput, new Set(["plugin"]))
    || typeof toolInput.plugin !== "string"
    || !TMB_PLUGIN_SELECTORS.has(toolInput.plugin)) {
    return deny("plugin recovery is limited to uninstalling TrustMyBot");
  }
  return DECISION_ALLOW;
}

function runGit(cwd, args, timeout = REPO_RESOLUTION_TIMEOUT_MS) {
  const { execFileSync } = requireBuiltin("node:child_process");
  return execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
    maxBuffer: 64 * 1024,
  }).trim();
}

function canonicalExistingPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function readSmallOrdinaryFile(path) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.nlink > 1 || stats.size > 4_096) {
    return null;
  }
  return readFileSync(path, "utf8").trim();
}

function gitDirMatchesRoot(root, gitDir) {
  const dotGitPath = resolve(root, ".git");
  const stats = lstatSync(dotGitPath);
  if (stats.isDirectory()) {
    return canonicalExistingPath(dotGitPath) === gitDir;
  }
  if (!stats.isFile() || stats.nlink > 1 || stats.size > 4_096) {
    return false;
  }
  const pointer = readFileSync(dotGitPath, "utf8").trim();
  const rawGitDir = pointer.startsWith("gitdir: ") ? pointer.slice("gitdir: ".length) : "";
  if (rawGitDir.length === 0) {
    return false;
  }
  const candidate = isAbsolute(rawGitDir) ? rawGitDir : resolve(root, rawGitDir);
  return canonicalExistingPath(candidate) === gitDir;
}

function commonDirMatchesGitDir(gitDir, commonDir) {
  const commonPointerPath = resolve(gitDir, "commondir");
  try {
    const rawCommonDir = readSmallOrdinaryFile(commonPointerPath);
    if (!rawCommonDir) {
      return false;
    }
    const candidate = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(gitDir, rawCommonDir);
    return gitDir !== commonDir && canonicalExistingPath(candidate) === commonDir;
  } catch (error) {
    return error && typeof error === "object" && error.code === "ENOENT" && gitDir === commonDir;
  }
}

function resolveAttestedRepoContext(canonicalCwd, attestation) {
  try {
    if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
      return { kind: "outside" };
    }
    const { root: rawRoot, gitDir: rawGitDir, commonDir: rawCommonDir } = attestation;
    if (![rawRoot, rawGitDir, rawCommonDir]
      .every((value) => typeof value === "string" && value.length > 0)) {
      return { kind: "outside" };
    }
    if (![rawRoot, rawGitDir, rawCommonDir].every(isAbsolute)) {
      return { kind: "outside" };
    }

    const root = canonicalExistingPath(rawRoot);
    const gitDir = canonicalExistingPath(rawGitDir);
    const commonDir = canonicalExistingPath(rawCommonDir);
    if (!root || !gitDir || !commonDir || !isWithin(root, canonicalCwd)) {
      return { kind: "outside" };
    }
    if (!gitDirMatchesRoot(root, gitDir) || !commonDirMatchesGitDir(gitDir, commonDir)) {
      return { kind: "outside" };
    }
    const head = readSmallOrdinaryFile(resolve(gitDir, "HEAD"));
    const branchRef = head?.startsWith("ref: ") ? head.slice("ref: ".length) : "";
    if (!branchRef.startsWith("refs/heads/") || branchRef.length === "refs/heads/".length) {
      return { kind: "outside" };
    }

    return {
      kind: gitDir === commonDir ? "primary" : "linked",
      cwd: canonicalCwd,
      root,
      gitDir,
      commonDir,
      branch: branchRef.slice("refs/heads/".length),
    };
  } catch {
    return { kind: "outside" };
  }
}

export function resolveRepoContext(cwd, options = {}) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    return { kind: "outside" };
  }

  const canonicalCwd = canonicalExistingPath(cwd);
  if (!canonicalCwd) {
    return { kind: "outside" };
  }

  if (options.repoAttestation !== undefined) {
    return resolveAttestedRepoContext(canonicalCwd, options.repoAttestation);
  }

  try {
    const gitRunner = options.gitRunner ?? runGit;
    const deadline = Date.now() + REPO_RESOLUTION_TIMEOUT_MS;
    const remainingTime = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("repository resolution deadline exceeded");
      return remaining;
    };
    const lines = gitRunner(canonicalCwd, [
      "rev-parse",
      "--show-toplevel",
      "--absolute-git-dir",
      "--git-common-dir",
    ], remainingTime()).split("\n");
    if (lines.length !== 3) {
      return { kind: "outside" };
    }

    const root = canonicalExistingPath(lines[0]);
    const gitDir = canonicalExistingPath(lines[1]);
    const commonCandidate = isAbsolute(lines[2]) ? lines[2] : resolve(canonicalCwd, lines[2]);
    const commonDir = canonicalExistingPath(commonCandidate);
    if (!root || !gitDir || !commonDir || !isWithin(root, canonicalCwd)) {
      return { kind: "outside" };
    }

    const headPath = resolve(gitDir, "HEAD");
    const headStats = lstatSync(headPath);
    if (!headStats.isFile() || headStats.nlink > 1 || headStats.size > 4_096) {
      return { kind: "outside" };
    }
    const head = readFileSync(headPath, "utf8").trim();
    if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head)) {
      return { kind: "detached", root, gitDir, commonDir };
    }
    const branchRef = head.startsWith("ref: ") ? head.slice("ref: ".length) : "";
    if (!branchRef.startsWith("refs/heads/") || branchRef.length === "refs/heads/".length) {
      return { kind: "outside" };
    }

    return {
      kind: gitDir === commonDir ? "primary" : "linked",
      cwd: canonicalCwd,
      root,
      gitDir,
      commonDir,
      branch: branchRef.slice("refs/heads/".length),
    };
  } catch {
    return { kind: "outside" };
  }
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

// Exclusion checks must also reject aliases on case-insensitive and Unicode-
// normalizing filesystems. Do not use this relaxed comparison to grant reads.
function mayAliasWithin(root, candidate) {
  return isWithin(root.normalize("NFC").toLowerCase(), candidate.normalize("NFC").toLowerCase());
}

function hasUnsafeLinkComponent(root, candidate) {
  const rel = relative(root, candidate);
  if (!isWithin(root, candidate)) {
    return true;
  }

  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      const stats = lstatSync(cursor);
      if (stats.isSymbolicLink()
        || cursor !== candidate && !stats.isDirectory()
        || cursor === candidate && stats.isFile() && stats.nlink > 1) {
        return true;
      }
    } catch (error) {
      return !(error && typeof error === "object" && error.code === "ENOENT");
    }
  }
  return false;
}

function nearestExistingAncestor(candidate) {
  let cursor = candidate;
  for (;;) {
    const canonical = canonicalExistingPath(cursor);
    if (canonical) {
      return canonical;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }
}

// Codex supplies PLUGIN_DATA before its directory necessarily exists. Resolve
// its existing directory ancestor without creating state or following a
// dangling link as though it were a missing directory.
export function canonicalFutureDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/u.test(path)) return null;
  let cursor = resolve(path);
  const suffix = [];
  for (;;) {
    try {
      const stats = lstatSync(cursor);
      const canonical = canonicalExistingPath(cursor);
      if (!canonical || !stats.isDirectory() && !stats.isSymbolicLink()
        || !lstatSync(canonical).isDirectory()) return null;
      const result = resolve(canonical, ...suffix);
      return result !== "/" && !/[\x00-\x1f\x7f]/u.test(result) ? result : null;
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
}

function normalizedRepoPath(rawPath) {
  return rawPath.split(sep).join("/").replace(/^\.\//u, "");
}

function isProtectedPath(root, candidate, options) {
  const rel = normalizedRepoPath(relative(root, candidate)).toLowerCase();
  if (PROTECTED_EXACT.has(rel)) {
    return true;
  }
  if (PROTECTED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) {
    return true;
  }

  for (const canonicalExtra of [canonicalExistingPath(options?.pluginRoot), canonicalFutureDirectory(options?.pluginData)]) {
    if (canonicalExtra && mayAliasWithin(canonicalExtra, candidate)) {
      return true;
    }
  }
  return false;
}

function validatePatchTarget(root, cwd, rawPath, options) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) {
    return deny("patch target is missing or malformed");
  }
  if (isAbsolute(rawPath) || rawPath.includes("\\")) {
    return deny("patch target must be a repository-relative path");
  }

  const segments = rawPath.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    return deny("patch target contains an unsafe path segment");
  }

  const candidate = resolve(cwd, rawPath);
  if (!isWithin(root, candidate)) {
    return deny("patch target escapes the current checkout");
  }
  if (hasUnsafeLinkComponent(root, candidate)) {
    return deny("patch target crosses a symbolic link or aliases a hard-linked file");
  }
  try {
    if (!lstatSync(candidate).isFile()) {
      return deny("existing patch target is not a regular file");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      return deny("existing patch target cannot be inspected safely");
    }
  }

  const ancestor = nearestExistingAncestor(candidate);
  if (!ancestor || !isWithin(root, ancestor)) {
    return deny("patch target cannot be resolved inside the current checkout");
  }
  if (isProtectedPath(root, candidate, options)) {
    return deny("patch target is a protected TMB or Git path");
  }
  return DECISION_ALLOW;
}

export function parsePatchTargets(command) {
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    return null;
  }
  const lines = command.replace(/\r\n/gu, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    return null;
  }

  const targets = [];
  for (const line of lines) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/u.exec(line);
    if (match) {
      const target = match[1].trim();
      if (!target) {
        return null;
      }
      targets.push(target);
    }
  }
  return targets.length > 0 ? targets : null;
}

export function tokenizeSimpleCommand(command) {
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    return null;
  }

  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  let hasToken = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      if (char === "\n" || char === "\r") {
        return null;
      }
      token += char;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        hasToken = true;
        continue;
      }
      if (quote === '"' && (char === "`" || char === "$")) {
        return null;
      }
      token += char;
      hasToken = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }
    if ("$*?[]{}~()#^!".includes(char)) {
      return null;
    }
    if (char === " " || char === "\t") {
      if (hasToken) {
        tokens.push(token);
        token = "";
        hasToken = false;
      }
      continue;
    }
    if (/\p{Z}|\p{Cc}|\p{Cf}/u.test(char)) {
      return null;
    }
    if ("|&;<>`".includes(char) || (char === "$" && next === "(")) {
      return null;
    }
    token += char;
    hasToken = true;
  }

  if (escaped || quote) {
    return null;
  }
  if (hasToken) {
    tokens.push(token);
  }
  return tokens.length > 0 ? tokens : null;
}

function commandFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return null;
  }
  const keys = Object.keys(toolInput);
  if (keys.length !== 1 || keys[0] !== "command") {
    return null;
  }
  return typeof toolInput.command === "string" ? toolInput.command : null;
}

function isGitRead(tokens, repoContext) {
  let args = tokens.slice(1);
  if (!SAFE_GIT_PREFIX.every((value, index) => args[index] === value)) {
    return false;
  }
  args = args.slice(SAFE_GIT_PREFIX.length);
  if (args.length === 0 || args[0].startsWith("-")) {
    return false;
  }

  const subcommand = args[0];
  const subcommandArgs = args.slice(1);
  if (subcommand === "worktree") {
    return subcommandArgs[0] === "list"
      && subcommandArgs.slice(1).every((arg) => ["--porcelain", "-z", "-v", "--verbose"].includes(arg));
  }
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    return false;
  }
  // Exact options avoid Git's long-option abbreviations opening unreviewed
  // file inputs, helper execution, or no-index filesystem comparisons.
  const flagsByCommand = {
    status: ["--short", "-s", "--branch", "-b", "--porcelain", "--long", "--show-stash", "-z", "--no-renames"],
    "rev-parse": ["--show-toplevel", "--show-prefix", "--absolute-git-dir", "--git-common-dir", "--git-dir",
      "--is-inside-work-tree", "--is-bare-repository", "--is-inside-git-dir", "--show-object-format",
      "--abbrev-ref", "--symbolic-full-name", "--verify", "--quiet", "-q", "--short", "--end-of-options"],
    "ls-files": ["--cached", "-c", "--stage", "-s", "--modified", "-m", "--deleted", "-d", "--others", "-o",
      "--unmerged", "-u", "--killed", "-k", "--error-unmatch", "--full-name", "--deduplicate", "--debug", "--sparse", "--eol", "-z"],
    "ls-tree": ["-r", "-t", "-d", "-z", "-l", "--long", "--name-only", "--name-status", "--full-name", "--full-tree"],
  };
  const displayFlags = ["--no-ext-diff", "--no-textconv", "--stat", "--shortstat", "--numstat", "--name-only",
    "--name-status", "--check", "--summary", "--patch", "-p", "--no-patch", "-s", "--raw", "--binary",
    "--full-index", "--exit-code", "--quiet", "--no-renames", "--no-color", "--color", "--word-diff",
    "--ignore-space-at-eol", "--ignore-space-change", "-b", "--ignore-all-space", "-w", "--ignore-blank-lines",
    "--ignore-cr-at-eol", "--minimal", "--patience", "--histogram", "--no-prefix", "--relative", "-z"];
  const historyFlags = ["--oneline", "--decorate", "--no-decorate", "--graph", "--all", "--branches", "--tags",
    "--remotes", "--first-parent", "--no-merges", "--merges", "--reverse", "--topo-order", "--date-order",
    "--author-date-order", "--no-walk", "--walk", "--follow", "--no-notes"];
  const flags = new Set(flagsByCommand[subcommand] ?? [
    ...displayFlags,
    ...(subcommand === "diff" ? ["--cached", "--staged", "--merge-base"] : historyFlags),
  ]);
  const values = new Set(["diff", "log", "show"].includes(subcommand)
    ? ["--unified", "--diff-filter", "--find-renames", "--find-copies", "--abbrev", "--src-prefix", "--dst-prefix",
      "--line-prefix", "--inter-hunk-context", "--stat-width", "--stat-name-width", "--stat-count",
      ...(subcommand === "diff" ? [] : ["--max-count", "--skip", "--since", "--until", "--after", "--before",
        "--author", "--committer", "--grep", "--format", "--pretty", "--date"])] : []);
  const enumValues = {
    "--color": ["always", "auto", "never"], "--word-diff": ["color", "plain", "porcelain", "none"],
    "--decorate": ["short", "full", "auto", "no"], "--porcelain": ["1", "2", "v1", "v2"],
    "--untracked-files": ["no", "normal", "all"], "--path-format": ["absolute", "relative"],
  };
  let pathsOnly = false;
  let noExternalDiff = false;
  let noTextConversion = false;
  for (let index = 0; index < subcommandArgs.length; index += 1) {
    const arg = subcommandArgs[index];
    if (!pathsOnly && arg === "--") {
      pathsOnly = true;
      continue;
    }
    if (!pathsOnly && arg.startsWith("-")) {
      if (flags.has(arg)) {
        if (arg === "--no-ext-diff") noExternalDiff = true;
        if (arg === "--no-textconv") noTextConversion = true;
        continue;
      }
      const equals = arg.indexOf("=");
      const flag = equals < 0 ? arg : arg.slice(0, equals);
      if (values.has(flag)) {
        const value = equals < 0 ? subcommandArgs[++index] : arg.slice(equals + 1);
        if (!value || value.startsWith("-") || value.includes("%G")) return false;
        if (["--format", "--pretty"].includes(flag)
          && !["oneline", "short", "medium", "full", "fuller", "reference", "email", "raw"].includes(value)
          && !value.startsWith("format:") && !value.startsWith("tformat:") && !value.includes("%")) return false;
        continue;
      }
      if (equals > 0 && enumValues[flag]?.includes(arg.slice(equals + 1))
        && (flags.has(flag) || subcommand === "status" && flag === "--untracked-files"
          || subcommand === "rev-parse" && flag === "--path-format")) continue;
      if (["log", "show"].includes(subcommand) && /^-\d+$/u.test(arg)) continue;
      if (["diff", "log", "show"].includes(subcommand) && /^-[UMC]\d+$/u.test(arg)) continue;
      if (["log", "show"].includes(subcommand) && arg === "-n" && /^\d+$/u.test(subcommandArgs[++index] ?? "")) continue;
      if (subcommand === "rev-parse" && /^--short=\d+$/u.test(arg)) continue;
      return false;
    }
    // Revision ranges and repo-relative paths are accepted, but neither
    // explicit nor implicit no-index reads may name a path outside this root.
    const operands = pathsOnly || !arg.includes(":") ? [arg] : [arg, arg.slice(arg.indexOf(":") + 1)];
    for (const filePart of operands) {
      if (!filePart || isAbsolute(filePart) || filePart.includes("\\")
        || filePart.split("/").includes("..")) return false;
      const candidate = resolve(repoContext.cwd, filePart);
      if (!isWithin(repoContext.root, candidate) || hasUnsafeLinkComponent(repoContext.root, candidate)) return false;
      try {
        const stats = lstatSync(candidate);
        if (!stats.isFile() && !stats.isDirectory()) return false;
      } catch (error) {
        if (!(error && typeof error === "object" && error.code === "ENOENT")) return false;
      }
    }
  }
  return !["diff", "log", "show"].includes(subcommand) || noExternalDiff && noTextConversion;
}

const GH_READ_FORMAT = "--json";
const GLAB_READ_FORMAT = "--output -F";
const GLAB_READ_PAGE = "--page -p --per-page -P";
export const FORGE_TARGET_ENV_NAMES = Object.freeze([
  "GH_REPO", "GH_HOST", "GLAB_REPO", "GITLAB_REPO", "GLAB_HOST", "GITLAB_HOST",
  "GITLAB_URI", "GL_HOST", "REMOTE_ALIAS", "GIT_REMOTE_URL_VAR", "GIT_REMOTE_ALIAS",
  "REMOTE_NICKNAME", "GIT_REMOTE_NICKNAME",
]);

function forgeTargetEnvironmentOverride() {
  if (process.env.TMB_CODEX_HOOK_FORGE_TARGET_ENV) return "launcher-reported target overrides";
  return FORGE_TARGET_ENV_NAMES.find((name) => Boolean(process.env[name]));
}

// Exact command grammars, checked against gh 2.96.0 help and the GitLab CLI
// reference. Repository/host/group overrides and raw GitHub search are absent.
// repo list spans repositories; glab ci view is an interactive mutation UI.
const FORGE_READ_FORMS = new Map(Object.entries({
  "gh pr list": { flags: "--draft -d", values: `${GH_READ_FORMAT} --app --assignee -a --author -A --base -B --head -H --label -l --limit -L --state -s` },
  "gh pr view": { flags: "--comments -c", values: GH_READ_FORMAT, target: "id" },
  "gh pr status": { flags: "--conflict-status -c", values: GH_READ_FORMAT },
  "gh pr diff": { flags: "--name-only --patch", values: "--color --exclude -e", target: "id" },
  "gh pr checks": { flags: "--required", values: GH_READ_FORMAT, target: "id" },
  "gh issue list": { values: `${GH_READ_FORMAT} --app --assignee -a --author -A --label -l --limit -L --mention --milestone -m --state -s --type` },
  "gh issue view": { flags: "--comments -c", values: GH_READ_FORMAT, target: "id", required: true },
  "gh issue status": { values: GH_READ_FORMAT },
  "gh release list": { flags: "--exclude-drafts --exclude-pre-releases", values: `${GH_READ_FORMAT} --limit -L --order -O` },
  "gh release view": { values: GH_READ_FORMAT, target: "name" },
  "gh repo view": { values: `${GH_READ_FORMAT} --branch -b` },
  "gh run list": { flags: "--all -a", values: `${GH_READ_FORMAT} --branch -b --commit -c --created --event -e --limit -L --status -s --user -u --workflow -w` },
  "gh run view": { flags: "--exit-status --log --log-failed --verbose -v", values: `${GH_READ_FORMAT} --attempt -a --job -j`, target: "id", required: true },
  "gh workflow list": { flags: "--all -a", values: `${GH_READ_FORMAT} --limit -L` },
  "gh workflow view": { flags: "--yaml -y", values: "--ref -r", target: "name", required: true },
  "glab issue list": { flags: "--all -A --closed -c --confidential -C", values: `${GLAB_READ_PAGE} --output -O --output-format -F --assignee -a --author --in --issue-type -t --iteration -i --label -l --milestone -m --not-assignee --not-author --not-label --order --search --sort -s` },
  "glab issue view": { flags: "--comments -c --system-logs -s", values: `${GLAB_READ_FORMAT} ${GLAB_READ_PAGE}`, target: "id", required: true },
  "glab mr list": { flags: "--all -A --closed -c --draft -d --merged -M --not-draft", values: `${GLAB_READ_FORMAT} ${GLAB_READ_PAGE} --assignee -a --author --created-after --created-before --deployed-after --deployed-before --environment --label -l --milestone -m --not-label --order -o --reviewer -r --search --sort -S --source-branch -s --target-branch -t` },
  "glab mr view": { flags: "--comments -c --resolved --system-logs -s --unresolved", values: `${GLAB_READ_FORMAT} ${GLAB_READ_PAGE}`, target: "id" },
  "glab mr diff": { flags: "--raw", values: "--color", target: "id" },
  "glab release list": { values: `${GLAB_READ_FORMAT} ${GLAB_READ_PAGE}` },
  "glab release view": { values: GLAB_READ_FORMAT, target: "name" },
  "glab repo view": { values: `${GLAB_READ_FORMAT} --branch -b` },
  "glab ci list": { flags: "--yaml-errors -y", values: `${GLAB_READ_FORMAT} ${GLAB_READ_PAGE} --name -n --order -o --ref -r --scope --sha --sort --source --status -s --updated-after -a --updated-before -b --username -u` },
  "glab ci status": { flags: "--compact -c", values: `${GLAB_READ_FORMAT} --branch -b` },
  "glab ci get": { flags: "--with-job-details -d", values: `${GLAB_READ_FORMAT} --branch -b --merge-request --pipeline-id -p --status -s` },
}));

function parseForgeReadArguments(args, form) {
  const flags = new Set((form.flags ?? "").split(" "));
  const values = new Set((form.values ?? "").split(" "));
  const supplied = new Map();
  const positionals = [];
  let endedOptions = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!endedOptions && argument === "--") {
      endedOptions = true;
    } else if (!endedOptions && argument.startsWith("-")) {
      if (flags.has(argument)) continue;
      const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
      const flag = argument.startsWith("--")
        ? equals < 0 ? argument : argument.slice(0, equals)
        : argument.slice(0, 2);
      if (!values.has(flag)) return null;
      const attached = argument.startsWith("--")
        ? equals < 0 ? null : argument.slice(equals + 1)
        : argument.length === 2 ? null : argument.slice(2).replace(/^=/u, "");
      const value = attached ?? args[++index];
      if (!value || value.startsWith("-") || /[\x00-\x1f\x7f]/u.test(value)) return null;
      if (["--job", "-j"].includes(flag) && !/^[0-9]+$/u.test(value)) return null;
      supplied.set(flag, value);
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length > (form.target ? 1 : 0)) return null;
  const target = positionals[0];
  if (target !== undefined && (form.target === "id"
    ? !/^[0-9]+$/u.test(target)
    : !/^[\p{L}\p{N}_][\p{L}\p{N}_. -]*$/u.test(target))) return null;
  return { supplied, target };
}

function isForgeRead(tokens) {
  const [program, group, action, ...args] = tokens;
  if (!["gh", "glab"].includes(program)) return false;
  if (forgeTargetEnvironmentOverride()) return false;
  if (group === "auth" && action === "status") return args.length === 0;
  const key = `${program} ${group} ${action}`;
  const form = FORGE_READ_FORMS.get(key);
  if (!form) return false;
  const parsed = parseForgeReadArguments(args, form);
  if (!parsed) return false;
  const job = parsed.supplied.get("--job") ?? parsed.supplied.get("-j");
  if (key === "gh run view" && job !== undefined && !/^[0-9]+$/u.test(job)) return false;
  return !form.required || parsed.target !== undefined || key === "gh run view" && job !== undefined;
}

export function forgeReadFailureReason(tokens) {
  const [program, group, action] = tokens;
  if (!["gh", "glab"].includes(program) || isForgeRead(tokens)) return null;
  if (!["list", "view", "status", "diff", "checks", "get", "ls", "show"].includes(action)
    && !group?.startsWith("-") && !action?.startsWith("-")) return null;
  const environment = forgeTargetEnvironmentOverride();
  if (environment) return `forge reads cannot use ${environment}; unset forge repository, host, and remote-selection environment overrides before querying the current checkout`;
  return "forge reads require reviewed current-checkout commands without repository, host, group, URL, or raw GitHub search overrides; use numeric PR/MR/issue IDs, repo view without a target, and ci get/status/list instead of interactive ci view";
}

function isSafeBranchName(branch) {
  return typeof branch === "string"
    && branch.length > 0
    && branch.length <= 255
    && !branch.startsWith("-")
    && !branch.startsWith("/")
    && !branch.endsWith("/")
    && !branch.endsWith(".")
    && !branch.endsWith(".lock")
    && !branch.includes("..")
    && !branch.includes("@{")
    && !branch.includes("//")
    && !/[\s~^:?*[\\\x00-\x1f\x7f]/u.test(branch);
}

function isDeliveryBranch(branch, repoContext) {
  if (!isSafeBranchName(branch) || PROTECTED_DELIVERY_BRANCHES.has(branch.toLowerCase())
    || repoContext?.protectedBranches?.has(branch.normalize("NFC").toLowerCase())) {
    return false;
  }
  const separator = branch.indexOf("/");
  return separator > 0 && DELIVERY_BRANCH_PREFIXES.has(branch.slice(0, separator).toLowerCase());
}

async function withConfiguredBranchPolicy(repoContext, options) {
  try {
    const pluginRoot = canonicalExistingPath(options.pluginRoot ?? DEFAULT_PLUGIN_ROOT);
    if (!pluginRoot) return { denied: deny("Codex plugin identity cannot be resolved for branch policy") };
    const manifestPath = resolve(pluginRoot, ".codex-plugin", "plugin.json");
    if (hasUnsafeLinkComponent(pluginRoot, manifestPath)) {
      return { denied: deny("Codex plugin identity must not contain aliased paths") };
    }
    const manifest = JSON.parse(readSmallOrdinaryFile(manifestPath));
    if (typeof manifest?.name !== "string") {
      return { denied: deny("Codex plugin manifest has no valid name for branch policy") };
    }
    const { readProtectedBranchPolicy } = await import("./branch-policy.mjs");
    const policy = readProtectedBranchPolicy(repoContext.root, manifest.name);
    if (!policy.ok) return { denied: deny(policy.reason) };
    // Ref names can alias by case or Unicode normalization on macOS. Protect
    // those variants even on filesystems that distinguish their spellings.
    return { context: { ...repoContext, protectedBranches: new Set(policy.protectedBranches.map((branch) => branch.normalize("NFC").toLowerCase())) } };
  } catch {
    return { denied: deny("Codex plugin identity or configured branch policy is unavailable") };
  }
}

function validateDeliveryPath(rawPath, repoContext, options) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.startsWith("-")
    || isAbsolute(rawPath) || rawPath.includes("\\")
    || "*?[]{}~".split("").some((char) => rawPath.includes(char))) {
    return deny("delivery paths must be explicit repository-relative paths");
  }
  const segments = rawPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return deny("delivery path contains an unsafe path segment");
  }
  const candidate = resolve(repoContext.cwd, rawPath);
  if (!isWithin(repoContext.root, candidate) || hasUnsafeLinkComponent(repoContext.root, candidate)) {
    return deny("delivery path escapes or aliases the current checkout");
  }
  if (isProtectedPath(repoContext.root, candidate, options)) {
    return deny("delivery path is protected TMB or Git state");
  }
  try {
    if (lstatSync(candidate).isDirectory()) {
      return deny("delivery staging requires explicit file paths, not directories");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      return deny("delivery path cannot be inspected safely");
    }
  }
  const ancestor = nearestExistingAncestor(candidate);
  if (!ancestor || !isWithin(repoContext.root, ancestor)) {
    return deny("delivery path cannot be resolved inside the checkout");
  }
  return DECISION_ALLOW;
}

function validateDeliveryPaths(paths, repoContext, options) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return deny("delivery staging requires at least one explicit file path");
  }
  for (const path of paths) {
    const result = validateDeliveryPath(path, repoContext, options);
    if (result.decision === "deny") return result;
  }
  return DECISION_ALLOW;
}

function protectedBranchDeny(branch) {
  return deny(`delivery is blocked on protected branch ${branch}; create a feature branch with git switch -c codex/<name>`);
}

function evaluateGitDelivery(tokens, repoContext, options) {
  if (!isTrustedExecutable("git", repoContext)) {
    return deny("Git delivery executable is not trusted");
  }
  const args = tokens.slice(1);
  const [subcommand] = args;

  const createsDeliveryBranch = args.length === 3
    && ((subcommand === "switch" && ["-c", "--create"].includes(args[1]))
      || (subcommand === "checkout" && args[1] === "-b"));
  if (createsDeliveryBranch) {
    return isDeliveryBranch(args[2], repoContext)
      ? DECISION_ALLOW
      : deny("new delivery branch name is missing, protected, or malformed");
  }

  if (subcommand === "restore" && args[1] === "--staged" && args[2] === "--") {
    return validateDeliveryPaths(args.slice(3), repoContext, options);
  }

  if (!isDeliveryBranch(repoContext.branch, repoContext)) {
    return protectedBranchDeny(repoContext.branch);
  }

  if (subcommand === "add") {
    const pathMarker = args.indexOf("--");
    if (pathMarker < 1 || pathMarker > 2) {
      return deny("git add requires explicit file paths after --");
    }
    if (pathMarker === 2 && !["-u", "--update"].includes(args[1])) {
      return deny("git add option is outside the bounded delivery lane");
    }
    return validateDeliveryPaths(args.slice(pathMarker + 1), repoContext, options);
  }

  if (subcommand === "commit") {
    return args.length === 3
      && ["-m", "--message"].includes(args[1])
      && typeof args[2] === "string"
      && args[2].trim().length > 0
      ? DECISION_ALLOW
      : deny("git commit is limited to one explicit -m/--message value without amend or bypass flags");
  }

  if (subcommand === "push") {
    let cursor = 1;
    if (["-u", "--set-upstream"].includes(args[cursor])) cursor += 1;
    const remote = args[cursor];
    const refspec = args[cursor + 1];
    const allowedRefspecs = new Set([
      repoContext.branch,
      "HEAD",
      `HEAD:${repoContext.branch}`,
    ]);
    return args.length === cursor + 2
      && remote === "origin"
      && allowedRefspecs.has(refspec)
      ? DECISION_ALLOW
      : deny("git push is limited to the current feature branch on origin without force or extra refspecs");
  }

  return deny("Git mutation is outside the bounded feature-branch delivery lane");
}

function parseForgeOptions(args, valueFlags, booleanFlags, positionalLimit = 0) {
  const values = new Map();
  const booleans = new Set();
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      if (positionals.length > positionalLimit) return null;
      continue;
    }
    const equals = token.indexOf("=");
    const flag = equals < 0 ? token : token.slice(0, equals);
    if (booleanFlags.has(flag)) {
      if (equals >= 0 || booleans.has(flag)) return null;
      booleans.add(flag);
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag)) return null;
    const value = equals >= 0 ? token.slice(equals + 1) : args[index += 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) return null;
    values.set(flag, value);
  }
  return { booleans, positionals, values };
}

function numericPrTarget(value) {
  return value === undefined || /^\d+$/u.test(value);
}

function evaluateGhDelivery(tokens, repoContext) {
  const [, group, action, ...args] = tokens;
  if (group !== "pr") return deny("GitHub writes are limited to pull-request delivery");

  if (action === "create") {
    const parsed = parseForgeOptions(
      args,
      new Set(["--base", "--head", "--title", "--body"]),
      new Set(["--draft", "--no-maintainer-edit"]),
    );
    const base = parsed?.values.get("--base");
    const head = parsed?.values.get("--head");
    return parsed
      && isSafeBranchName(base)
      && base !== head
      && head === repoContext.branch
      ? DECISION_ALLOW
      : deny("gh pr create requires explicit --base and --head matching the current feature branch");
  }

  if (action === "edit") {
    const parsed = parseForgeOptions(
      args,
      new Set(["--title", "--body"]),
      new Set(),
      1,
    );
    return parsed
      && numericPrTarget(parsed.positionals[0])
      && (parsed.values.has("--title") || parsed.values.has("--body"))
      ? DECISION_ALLOW
      : deny("gh pr edit is limited to title or body updates on the current or a numeric pull request");
  }

  if (action === "ready") {
    return args.length <= 1 && numericPrTarget(args[0])
      ? DECISION_ALLOW
      : deny("gh pr ready accepts only the current or a numeric pull request");
  }

  return deny("GitHub pull-request mutation is outside create, edit, or ready delivery");
}

function evaluateGlabDelivery(tokens, repoContext) {
  const [, group, action, ...args] = tokens;
  if (group !== "mr" || action !== "create") {
    return deny("GitLab writes are limited to merge-request creation");
  }
  const parsed = parseForgeOptions(
    args,
    new Set(["--target-branch", "--source-branch", "--title", "--description"]),
    new Set(["--draft", "--yes"]),
  );
  const base = parsed?.values.get("--target-branch");
  const head = parsed?.values.get("--source-branch");
  return parsed
    && isSafeBranchName(base)
    && base !== head
    && head === repoContext.branch
    ? DECISION_ALLOW
    : deny("glab mr create requires explicit target and source matching the current feature branch");
}

function evaluateDeliveryCommand(tokens, repoContext, options) {
  const program = tokens[0];
  if (!["git", "gh", "glab"].includes(program)) return null;
  if (program === "git") return evaluateGitDelivery(tokens, repoContext, options);
  if (!isTrustedExecutable(program, repoContext)) {
    return deny("forge delivery executable is not trusted");
  }
  if (!isDeliveryBranch(repoContext.branch, repoContext)) return protectedBranchDeny(repoContext.branch);
  return program === "gh"
    ? evaluateGhDelivery(tokens, repoContext)
    : evaluateGlabDelivery(tokens, repoContext);
}

function isTrustedExecutable(program, repoContext) {
  if (TRUSTED_SHELL_BUILTINS.has(program)) {
    return true;
  }
  const hostPath = process.env.TMB_CODEX_HOOK_HOST_PATH ?? process.env.PATH ?? "";
  for (const rawEntry of hostPath.split(delimiter)) {
    const pathDirectory = rawEntry.length === 0
      ? repoContext.cwd
      : isAbsolute(rawEntry) ? resolve(rawEntry) : resolve(repoContext.cwd, rawEntry);
    const candidate = resolve(pathDirectory, program);
    try {
      accessSync(candidate, constants.X_OK);
      const canonical = realpathSync(candidate);
      if (!lstatSync(canonical).isFile()) {
        return false;
      }
      if ([candidate, canonical].some((path) => mayAliasWithin(repoContext.root, path)
        || mayAliasWithin(repoContext.gitDir, path)
        || mayAliasWithin(repoContext.commonDir, path)
        || UNTRUSTED_PATH_MARKERS.some((marker) => path.includes(marker)))) {
        return false;
      }
      if (program === "git" && canonical !== realpathSync("/usr/bin/git")) {
        return false;
      }
      return true;
    } catch (error) {
      if (error && typeof error === "object" && ["EACCES", "ENOENT", "ENOTDIR"].includes(error.code)) {
        continue;
      }
      return false;
    }
  }
  return false;
}

function isFiniteRegularFile(rawPath, repoContext, allowDirectory = false) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath === "-"
    || rawPath.startsWith("-") || isAbsolute(rawPath)) {
    return false;
  }
  const candidate = resolve(repoContext.cwd, rawPath);
  if (!isWithin(repoContext.root, candidate) || hasUnsafeLinkComponent(repoContext.root, candidate)) {
    return false;
  }
  try {
    const stats = lstatSync(candidate);
    return stats.isFile() || allowDirectory && stats.isDirectory();
  } catch {
    return false;
  }
}

function isFiniteFileRead(program, args, repoContext) {
  if (["dirname", "basename"].includes(program)) {
    return args.length > 0 && args.every((arg) => arg !== "-" && !arg.startsWith("-"));
  }
  if (["cat", "stat", "file", "realpath", "readlink"].includes(program)) {
    const operands = args[0] === "--" ? args.slice(1) : args;
    return operands.length > 0 && operands.every((arg) =>
      isFiniteRegularFile(arg, repoContext, program !== "cat"));
  }
  if (program === "head" || program === "tail") {
    let cursor = 0;
    while (args[cursor]?.startsWith("-") && args[cursor] !== "--") {
      const flag = args[cursor++];
      if (["-n", "-c", "--lines", "--bytes"].includes(flag)) {
        if (!/^[+-]?\d+$/u.test(args[cursor++] ?? "")) return false;
      } else if (!/^-(?:n|c)[+-]?\d+$/u.test(flag)
        && !/^--(?:lines|bytes)=[+-]?\d+$/u.test(flag)
        && !["-q", "-v", "--quiet", "--verbose"].includes(flag)) {
        return false;
      }
    }
    if (args[cursor] === "--") cursor += 1;
    return args.length > cursor && args.slice(cursor).every((arg) => isFiniteRegularFile(arg, repoContext));
  }
  if (program === "wc") {
    const operands = [];
    let endedOptions = false;
    for (const arg of args) {
      if (!endedOptions && arg === "--") endedOptions = true;
      else if (!endedOptions && arg.startsWith("-")) {
        if (!/^-[clmwL]+$/u.test(arg)
          && !["--bytes", "--chars", "--lines", "--words", "--max-line-length"].includes(arg)) return false;
      } else operands.push(arg);
    }
    return operands.length > 0 && operands.every((arg) => isFiniteRegularFile(arg, repoContext));
  }
  if (program === "jq") {
    const positionals = [];
    let endedOptions = false;
    let fileFilter = false;
    let filterPath;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!endedOptions && arg === "--") endedOptions = true;
      else if (!endedOptions && ["-f", "--from-file"].includes(arg)) {
        const sourcePath = args[++index];
        if (fileFilter || typeof sourcePath !== "string") return false;
        filterPath = resolve(repoContext.cwd, sourcePath);
        // The Hook must not inspect another adapter's state as filter source.
        if (isProtectedPath(repoContext.root, filterPath)
          || !isFiniteRegularFile(sourcePath, repoContext)) return false;
        fileFilter = true;
      } else if (!endedOptions && ["--arg", "--argjson"].includes(arg)) {
        if (args[index + 1] === undefined || args[index + 2] === undefined) return false;
        index += 2;
      } else if (!endedOptions && arg.startsWith("-")) {
        if (!/^-[acCejMnRrsS]+$/u.test(arg)
          && !["--ascii-output", "--compact-output", "--exit-status", "--join-output",
            "--monochrome-output", "--null-input", "--raw-input", "--raw-output", "--slurp", "--sort-keys"].includes(arg)) return false;
      } else positionals.push(arg);
    }
    const operands = fileFilter ? positionals : positionals.slice(1);
    if (operands.length === 0 || !operands.every((arg) => isFiniteRegularFile(arg, repoContext))) return false;
    let filterSource = positionals[0];
    if (fileFilter) {
      try {
        const stats = lstatSync(filterPath);
        if (!stats.isFile() || stats.size > MAX_COMMAND_BYTES) return false;
        filterSource = readFileSync(filterPath, "utf8");
        if (Buffer.byteLength(filterSource, "utf8") > MAX_COMMAND_BYTES) return false;
      } catch {
        return false;
      }
    }
    // Modules can open extra paths or FIFOs. Conservatively reject these words
    // even inside strings/comments instead of maintaining a partial jq parser.
    return typeof filterSource === "string" && !/\b(?:import|include)\b/u.test(filterSource);
  }
  if (program === "du") {
    const operands = [];
    let endedOptions = false;
    for (const arg of args) {
      if (!endedOptions && arg === "--") endedOptions = true;
      else if (!endedOptions && arg.startsWith("-")) {
        if (!/^-[achkmPsx]+$/u.test(arg)
          && !["--all", "--human-readable", "--summarize", "--total", "--one-file-system", "--no-dereference"].includes(arg)) return false;
      } else operands.push(arg);
    }
    if (args.length === 0) operands.push(".");
    return operands.length > 0 && operands.every((arg) => isFiniteRegularFile(arg, repoContext, true));
  }
  if (program === "test") {
    if (args.length <= 1) return true;
    if (args.length === 2 && ["-n", "-z"].includes(args[0])) return true;
    if (args.length === 2 && ["-d", "-e", "-f", "-r", "-s", "-w", "-x"].includes(args[0])) {
      return isFiniteRegularFile(args[1], repoContext, true);
    }
    return args.length === 3 && ["=", "!=", "-eq", "-ne", "-gt", "-ge", "-lt", "-le"].includes(args[1]);
  }
  return program === "true" || program === "false";
}

function isReviewedReadCommand(tokens, repoContext) {
  const program = tokens[0];
  if (program.includes("/") || program.includes("\\") || !isTrustedExecutable(program, repoContext)) {
    return false;
  }
  const args = tokens.slice(1);
  if (program === "pwd") {
    return args.every((arg) => arg === "-L" || arg === "-P");
  }
  if (program === "ls") {
    const operands = [];
    let endedOptions = false;
    for (const arg of args) {
      if (!endedOptions && arg === "--") endedOptions = true;
      else if (!endedOptions && arg.startsWith("-")) {
        // Never follow links, including links encountered by recursive listings.
        if (!/^-[1AaBCcdfFghiklmnpqRrSstUux]+$/u.test(arg)
          && !["--all", "--almost-all", "--directory", "--human-readable", "--inode", "--numeric-uid-gid", "--recursive", "--size"].includes(arg)
          && !/^--color=(?:always|auto|never)$/u.test(arg)) return false;
      } else operands.push(arg);
    }
    if (operands.length === 0) operands.push(".");
    return operands.every((arg) => isFiniteRegularFile(arg, repoContext, true));
  }
  if (program === "rg") {
    const booleanFlags = new Set([
      "--no-config", "--files", "--hidden", "--no-hidden", "--no-ignore", "--no-ignore-vcs",
      "--no-ignore-dot", "--no-ignore-parent", "--no-ignore-global", "--no-require-git",
      "--line-number", "--no-line-number", "--with-filename", "--no-filename",
      "--ignore-case", "--case-sensitive", "--smart-case", "--fixed-strings", "--word-regexp", "--line-regexp",
      "--invert-match", "--count", "--count-matches", "--files-with-matches", "--files-without-match",
      "--only-matching", "--quiet", "--text", "--binary", "--multiline", "--multiline-dotall", "--pcre2",
      "--json", "--heading", "--no-heading", "--column", "--no-column", "--byte-offset", "--null",
      "--null-data", "--crlf", "--trim", "--stats", "--no-messages", "--no-ignore-messages",
      "--no-follow", "--no-mmap", "--mmap", "--one-file-system", "--debug", "--trace",
    ]);
    const valueFlags = new Set([
      "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--type-clear",
      "--max-count", "--max-depth", "--max-filesize", "--max-columns", "--threads", "--context",
      "--before-context", "--after-context", "--context-separator", "--field-match-separator",
      "--field-context-separator", "--color", "--colors", "--sort", "--sortr", "--encoding", "--engine",
      "--replace", "--ignore-file", "--regex-size-limit", "--dfa-size-limit",
    ]);
    const shortValues = new Map(Object.entries({
      e: "--regexp", f: "--file", g: "--glob", t: "--type", T: "--type-not", m: "--max-count",
      M: "--max-columns", j: "--threads", C: "--context", B: "--before-context", A: "--after-context",
      E: "--encoding", r: "--replace",
    }));
    const positionals = [];
    let endedOptions = false;
    let noConfig = false;
    let noIgnore = false;
    let files = false;
    let explicitPattern = false;
    const acceptValue = (flag, value) => {
      if (typeof value !== "string" || value.length === 0) return false;
      if (["--file", "--ignore-file"].includes(flag) && !isFiniteRegularFile(value, repoContext)) return false;
      if (["--regexp", "--file"].includes(flag)) explicitPattern = true;
      return true;
    };
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!endedOptions && arg === "--") endedOptions = true;
      else if (!endedOptions && arg.startsWith("--")) {
        const equals = arg.indexOf("=");
        const flag = equals < 0 ? arg : arg.slice(0, equals);
        if (booleanFlags.has(flag) && equals < 0) {
          if (flag === "--no-config") noConfig = true;
          if (flag === "--no-ignore") noIgnore = true;
          if (flag === "--files") files = true;
        } else if (valueFlags.has(flag)) {
          if (!acceptValue(flag, equals < 0 ? args[++index] : arg.slice(equals + 1))) return false;
        } else return false;
      } else if (!endedOptions && arg.startsWith("-") && arg !== "-") {
        for (let offset = 1; offset < arg.length; offset += 1) {
          const flag = shortValues.get(arg[offset]);
          if (flag) {
            if (!acceptValue(flag, arg.slice(offset + 1) || args[++index])) return false;
            break;
          }
          if (!"nNHiIsSwxvFlcouUaPbq0".includes(arg[offset])) return false;
        }
      } else positionals.push(arg);
    }
    if (!noConfig) return false;
    const paths = files || explicitPattern ? positionals : positionals.slice(1);
    // Explicit paths prevent rg from auto-detecting a waiting stdin stream.
    // Directory traversal skips special entries, but ignore files are opened
    // separately and could be FIFOs. Disable implicit ignore reads for walks.
    if (files && paths.length === 0) paths.push(".");
    return paths.length > 0
      && paths.every((path) => isFiniteRegularFile(path, repoContext, true))
      && (noIgnore || !files && paths.every((path) => isFiniteRegularFile(path, repoContext)));
  }
  if (FILE_READ_PROGRAMS.has(program)) {
    return isFiniteFileRead(program, args, repoContext);
  }
  if (program === "command") {
    return args.length === 2 && args[0] === "-v";
  }
  if (program === "git") {
    return isGitRead(tokens, repoContext);
  }
  if (program === "gh" || program === "glab") {
    return isForgeRead(tokens);
  }
  return false;
}

function isSafeValidationPath(rawPath, cwd, root) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.startsWith("-")
    || rawPath.startsWith("@")
    || rawPath.includes("\\") || "*?[]{}".split("").some((char) => rawPath.includes(char))
    || isAbsolute(rawPath)) {
    return false;
  }
  const pathOnly = rawPath.split("::", 1)[0];
  if (pathOnly.includes(":")) {
    return false;
  }
  const segments = pathOnly.split("/");
  if (!segments.every((segment, index) => segment !== ".." && segment !== "" && (segment !== "." || index === 0))) {
    return false;
  }
  const candidate = resolve(cwd, pathOnly);
  return isWithin(root, candidate) && !hasUnsafeLinkComponent(root, candidate);
}

function isApprovedValidationCommand(tokens, repoContext) {
  const program = tokens[0];
  if (program.includes("/") || program.includes("\\") || !isTrustedExecutable(program, repoContext)) {
    return false;
  }
  const args = tokens.slice(1);
  if (args.some((arg) => {
    const normalized = arg.toLowerCase();
    return INTERACTIVE_VALIDATION_FLAGS.has(normalized)
      || [...INTERACTIVE_VALIDATION_FLAGS].some((flag) => normalized.startsWith(`${flag}=`));
  })) {
    return false;
  }
  if (ALLOWED_VALIDATION_SIGNATURES.has(tokens.join("\0"))) {
    return repoContext.cwd === repoContext.root
      && (program !== "bash" || isFiniteRegularFile(args[0], repoContext));
  }
  if (program === "node") {
    const testPathArgs = args[0] === "--test"
      ? args.slice(1)
      : args[0] === "--experimental-sqlite" && args[1] === "--test"
        ? args.slice(2)
        : null;
    return testPathArgs !== null && testPathArgs.every((path) =>
      isSafeValidationPath(path, repoContext.cwd, repoContext.root));
  }
  if (program === "pytest") {
    const testPathArgs = args[0] === "-q" ? args.slice(1) : args;
    return testPathArgs.every((path) =>
      isSafeValidationPath(path, repoContext.cwd, repoContext.root));
  }
  if (program === "go" && args[0] === "test") {
    return args.length > 1 && args.slice(1).every((path) =>
      (path === "." || path.startsWith("./"))
      && isSafeValidationPath(path, repoContext.cwd, repoContext.root));
  }
  return false;
}

export async function classifyRestrictedCommand(command, repoContext, options = {}) {
  if (command === null) {
    return deny("shell payload has no auditable command");
  }
  const commandBytes = Buffer.byteLength(command, "utf8");
  if (commandBytes > MAX_COMMAND_BYTES) {
    return deny("shell command exceeds the 256 KiB limit");
  }

  const tokens = tokenizeSimpleCommand(command);
  if (!tokens || tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    return deny("shell command is compound, redirected, or cannot be parsed safely");
  }

  const program = tokens[0];
  if (PERSISTENT_PROGRAMS.has(program) && tokens.length === 1) {
    return deny("persistent command receivers are not allowed");
  }
  if (PERSISTENT_PROGRAMS.has(program) && ["-i", "--interactive"].some((flag) => tokens.includes(flag))) {
    return deny("interactive interpreters are not allowed");
  }
  if (isReviewedReadCommand(tokens, repoContext)) {
    return { decision: "allow", mode: program === "git" ? "git-read" : ["gh", "glab"].includes(program) ? "forge" : "read", tokens, repoContext };
  }
  const forgeReadFailure = forgeReadFailureReason(tokens);
  if (forgeReadFailure) return deny(forgeReadFailure);
  if (program === "rg") {
    return deny("rg requires --no-config and explicit checkout paths; directory searches and --files also require --no-ignore. Use rg --no-config --no-ignore <pattern> <path> (or --files <path>), without symlink-following, helper, or implicit-ignore flags");
  }
  const validation = isApprovedValidationCommand(tokens, repoContext);
  if (validation || ["git", "gh", "glab"].includes(program)) {
    const configured = await withConfiguredBranchPolicy(repoContext, options);
    if (configured.denied) return configured.denied;
    repoContext = configured.context;
  }
  if (isDeliveryBranch(repoContext.branch, repoContext) && validation) {
    return { decision: "allow", mode: "validation", tokens, repoContext };
  }
  const deliveryDecision = evaluateDeliveryCommand(tokens, repoContext, options);
  if (deliveryDecision) {
    if (deliveryDecision.decision !== "allow") return deliveryDecision;
    return { decision: "allow", tokens, repoContext, mode: program === "git" ? tokens[1] === "push" ? "git-push" : "git-local" : "forge" };
  }
  return deny(isDeliveryBranch(repoContext.branch, repoContext)
    ? "feature-branch command is outside reviewed reads, contained patches, validation, or delivery"
    : "protected checkout permits reviewed read-only commands and feature-branch creation only");
}


export function restrictedHostPath(repoContext) {
  const candidates = (process.env.TMB_CODEX_HOOK_HOST_PATH ?? process.env.PATH ?? "").split(delimiter);
  candidates.push(dirname(process.execPath), "/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin");
  return [...new Set(candidates.filter((candidate) => {
    if (!isAbsolute(candidate) || /[\x00-\x1f\x7f]/u.test(candidate)) return false;
    const canonical = canonicalExistingPath(candidate);
    if (!canonical || !lstatSync(canonical).isDirectory()) return false;
    return ![repoContext.root, repoContext.gitDir, repoContext.commonDir].some((root) => root && mayAliasWithin(root, canonical))
      && !UNTRUSTED_PATH_MARKERS.some((marker) => canonical.includes(marker));
  }))].join(delimiter);
}

function runnerArguments(command, repoContext, options) {
  const pluginRoot = canonicalExistingPath(options.pluginRoot ?? DEFAULT_PLUGIN_ROOT);
  const node = canonicalExistingPath(process.execPath);
  if (!pluginRoot || !node || [repoContext.root, repoContext.gitDir, repoContext.commonDir, pluginRoot]
    .some((root) => mayAliasWithin(root, node))) throw new Error("restricted runner has no trusted interpreter");
  const manifest = JSON.parse(readFileSync(resolve(pluginRoot, "hooks/codex/hooks.json"), "utf8"));
  const definition = manifest?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
  const matches = typeof definition === "string" ? [...definition.matchAll(/--policy-sha256 ([a-f0-9]{64})/gu)] : [];
  if (matches.length !== 1) throw new Error("restricted runner has no pinned bundle digest");
  const pluginData = options.pluginData ? canonicalFutureDirectory(options.pluginData) : "";
  if (options.pluginData && !pluginData) throw new Error("restricted runner plugin data path is unavailable");
  return ["/usr/bin/env", "-i", `PATH=${restrictedHostPath(repoContext)}`, `TMB_CODEX_PLUGIN_DATA=${pluginData}`, node,
    resolve(pluginRoot, "adapters/codex/hooks/restricted-runner.mjs"),
    "--policy-sha256", matches[0][1], "--cwd", repoContext.cwd, "--command", command];
}

export function makeRestrictedCommand(command, cwd, options = {}) {
  const context = resolveRepoContext(cwd, options);
  if (!["primary", "linked"].includes(context.kind)) throw new Error("restricted runner requires a branch-backed checkout");
  const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  return runnerArguments(command, context, options).map(quote).join(" ");
}

async function evaluateShell(toolInput, repoContext, options = {}) {
  const command = commandFromToolInput(toolInput);
  const tokens = tokenizeSimpleCommand(command);
  if (tokens?.[0] === "/usr/bin/env") {
    if (!options.controlledShell) return deny("restricted execution requires an attested local /bin/sh invocation or nested exec_command with shell /bin/sh, login false, and tty false");
    if (tokens.length !== 12) return deny("restricted runner arguments are not canonical");
    let expected;
    try { expected = runnerArguments(tokens[11], repoContext, options); }
    catch { return deny("restricted runner identity or bundle manifest is unavailable"); }
    if (!tokens.every((token, index) => token === expected[index])) return deny("restricted runner identity, environment, cwd, or digest differs from the installed bundle");
    if (process.platform !== "darwin") return deny("restricted command execution currently requires the qualified macOS sandbox");
    const result = await classifyRestrictedCommand(tokens[11], repoContext, options);
    return result.decision === "allow" ? DECISION_ALLOW : result;
  }
  if (options.requestsEscalation) return deny("outer sandbox escalation is accepted only for the exact pinned restricted runner");
  const result = await classifyRestrictedCommand(command, repoContext, options);
  if (result.decision === "allow" && result.mode !== "read") {
    let recovery = "See the installed RESTRICTED_EXECUTION.md for the required exec_command wrapper.";
    if (process.platform === "darwin" && command.length <= 8_192) {
      try {
        recovery = `Use functions.exec with this single static call: text(JSON.stringify(await tools.exec_command(${JSON.stringify({
          cmd: makeRestrictedCommand(command, repoContext.cwd, options), workdir: repoContext.cwd,
          shell: "/bin/sh", login: false, tty: false,
        })})));`;
      } catch { /* A missing or malformed installed bundle has no executable recovery. */ }
    }
    return deny(`Git, forge, and validation commands require the installed restricted runner; raw execution can run helpers outside the protected-path boundary. ${recovery}`);
  }
  return result.decision === "allow" ? DECISION_ALLOW : result;
}

function isTmbMcpTool(toolName) {
  const prefix = TMB_MCP_PREFIXES.find((candidate) => toolName.startsWith(candidate));
  return Boolean(prefix) && TMB_TOOL_NAME_SET.has(toolName.slice(prefix.length));
}

function hasProjectCodexConfig(repoContext) {
  let cursor = repoContext.cwd;
  for (;;) {
    try {
      lstatSync(resolve(cursor, ".codex", "config.toml"));
      return true;
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) {
        return true;
      }
    }
    if (cursor === repoContext.root) {
      return false;
    }
    const parent = dirname(cursor);
    if (parent === cursor || !isWithin(repoContext.root, parent)) {
      return true;
    }
    cursor = parent;
  }
}

function isApplyPatchTool(toolName) {
  return toolName === "apply_patch";
}

function isShellTool(toolName, observedToolName) {
  return SHELL_TOOLS.has(toolName) && observedToolName === "Bash";
}

export async function evaluatePreToolUse(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return deny("hook input must be a JSON object");
  }
  if (input.hook_event_name !== "PreToolUse") {
    return deny("unexpected hook event");
  }
  if (typeof input.tool_name !== "string" || input.tool_name.trim().length === 0) {
    return deny("tool name is missing");
  }
  if (typeof input.cwd !== "string" || input.cwd.length === 0) {
    return deny("working directory is missing");
  }
  if (!VALID_PERMISSION_MODES.has(input.permission_mode)) {
    return deny("permission mode is unknown");
  }

  const toolName = normalizeToolName(input.tool_name);
  const squashedToolName = toolName.replace(/[^a-z0-9]/gu, "");
  let repoContext;
  if (options.repoAttestation !== undefined) {
    repoContext = resolveRepoContext(input.cwd, options);
    if (repoContext.kind === "outside" || repoContext.kind === "detached") {
      return deny("tool call is not attached to a branch-backed Git checkout");
    }
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    return DECISION_ALLOW;
  }
  if (CODEX_DIAGNOSTIC_TOOLS.has(toolName)) {
    return DECISION_ALLOW;
  }
  if (toolName === "functions.exec") {
    repoContext ??= resolveRepoContext(input.cwd, options);
    if (repoContext.kind === "outside" || repoContext.kind === "detached") {
      return deny("tool call is not attached to a branch-backed Git checkout");
    }
    return evaluateOrchestrationWrapper(input, options, repoContext);
  }
  const lifecycleDecision = validateLifecycleTool(toolName, input.tool_input);
  if (lifecycleDecision) {
    return lifecycleDecision;
  }
  const recoveryDecision = validateRecoveryTool(toolName, input.tool_input);
  if (recoveryDecision) {
    return recoveryDecision;
  }
  if (CODE_MODE_TOOLS.has(toolName)) {
    return deny("code-mode wrappers are outside the auditable command surface");
  }
  if (DIRECT_WRITE_TOOLS.has(toolName)) {
    return deny("direct write tools are not allowed; use contained apply_patch on a feature branch");
  }
  if (toolName === "agent" || squashedToolName.endsWith("spawnagent")) {
    return deny("subagent Hook inheritance has not been qualified for this host");
  }

  repoContext ??= resolveRepoContext(input.cwd, options);
  if (repoContext.kind === "outside" || repoContext.kind === "detached") {
    return deny("tool call is not attached to a branch-backed Git checkout");
  }
  if (isTmbMcpTool(toolName)) {
    if (hasProjectCodexConfig(repoContext)) {
      return deny("TMB MCP calls are disabled when project-local Codex configuration could shadow the bundled server");
    }
    const requestedRoot = canonicalExistingPath(input.tool_input?.project_root);
    if (!requestedRoot || requestedRoot !== repoContext.root) {
      return deny("TMB MCP project_root must match the current canonical checkout");
    }
    return DECISION_ALLOW;
  }
  if (isApplyPatchTool(toolName)) {
    const configured = await withConfiguredBranchPolicy(repoContext, options);
    if (configured.denied) return configured.denied;
    repoContext = configured.context;
    if (!isDeliveryBranch(repoContext.branch, repoContext)) {
      return protectedBranchDeny(repoContext.branch);
    }
    const command = commandFromToolInput(input.tool_input);
    if (typeof command !== "string") {
      return deny("apply_patch payload is not a patch string");
    }
    const targets = parsePatchTargets(command);
    if (!targets) {
      return deny("apply_patch payload cannot be parsed");
    }
    for (const target of targets) {
      const result = validatePatchTarget(repoContext.root, repoContext.cwd, target, options);
      if (result.decision === "deny") {
        return result;
      }
    }
    return DECISION_ALLOW;
  }
  if (isShellTool(toolName, input.tool_name)) {
    if (!hasControlledHostExecution(input, repoContext)) {
      return deny("Bash requires qualified host execution metadata matching the actual local /bin/sh command and cwd, with login false and tty false. Command-only CLI payloads are not supported; the existing static functions.exec path remains available only on hosts that expose it.");
    }
    return evaluateShell(input.tool_input, repoContext, {
      ...options,
      controlledShell: true,
    });
  }
  return deny("tool name or payload shape is not on the reviewed allowlist");
}

if (!isMainThread && workerData?.mode === "evaluate-pre-tool-use") {
  parentPort?.postMessage(await evaluatePreToolUse(workerData.input, workerData.options));
}
