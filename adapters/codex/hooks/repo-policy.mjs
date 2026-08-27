import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_COMMAND_BYTES = 256 * 1024;
export const REPO_RESOLUTION_TIMEOUT_MS = 700;

const DECISION_ALLOW = Object.freeze({ decision: "allow" });
export const TMB_TOOL_NAMES = Object.freeze([
  "runtime_initialize",
  "project_inventory",
  "project_scan",
  "world_model_get",
  "world_model_search",
  "planning_label_taxonomy_get",
  "planning_label_taxonomy_set",
  "planning_issue_create",
  "planning_issue_get",
  "planning_issue_list",
  "planning_issue_resume",
  "planning_discussion_append",
  "planning_discussion_list",
  "agent_materialization_get",
  "agent_materialization_set",
]);
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
  "functions.exec",
  "code_mode",
  "js_repl",
  "javascript_repl",
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
const GIT_UNSAFE_READ_FLAGS = [
  "--help",
  "--output",
  "--ext-diff",
  "--textconv",
  "--exec",
  "--config-env",
  "--recurse-submodules",
  "--show-signature",
];
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

function runGit(cwd, args, timeout = REPO_RESOLUTION_TIMEOUT_MS) {
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

export function resolveRepoContext(cwd, options = {}) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    return { kind: "outside" };
  }

  const canonicalCwd = canonicalExistingPath(cwd);
  if (!canonicalCwd) {
    return { kind: "outside" };
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

  for (const extraRoot of [options?.pluginRoot, options?.pluginData]) {
    const canonicalExtra = canonicalExistingPath(extraRoot);
    if (canonicalExtra && isWithin(canonicalExtra, candidate)) {
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
    return deny("patch target escapes the linked worktree");
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
    return deny("patch target cannot be resolved inside the linked worktree");
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

function tokenizeSimpleCommand(command) {
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

function isGitRead(tokens) {
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
    return subcommandArgs[0] === "list";
  }
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    return false;
  }
  if (subcommandArgs.some((arg) => arg === "-h"
    || GIT_UNSAFE_READ_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) {
    return false;
  }
  if (subcommandArgs.some((arg) => arg.includes("%G"))) {
    return false;
  }
  if (["diff", "log", "show"].includes(subcommand)) {
    return subcommandArgs.includes("--no-ext-diff") && subcommandArgs.includes("--no-textconv");
  }
  return true;
}

function isForgeRead(tokens) {
  const [program, group, action] = tokens;
  if (tokens.slice(1).some((arg) => FORGE_SIDE_EFFECT_LONG_FLAGS.some(
    (flag) => arg === flag || arg.startsWith(`${flag}=`),
  ) || /^-[^-]*w/u.test(arg))) {
    return false;
  }
  if (program === "gh") {
    if (group === "auth" && action === "status") return tokens.length === 3;
    if (["issue", "pr", "release", "repo", "run", "workflow"].includes(group)) {
      return ["list", "view", "status", "diff", "checks"].includes(action);
    }
  }
  if (program === "glab") {
    if (group === "auth" && action === "status") return tokens.length === 3;
    if (["issue", "mr", "release", "repo", "ci"].includes(group)) {
      return ["list", "view", "status", "diff"].includes(action);
    }
  }
  return false;
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
      if ([candidate, canonical].some((path) => isWithin(repoContext.root, path)
        || isWithin(repoContext.gitDir, path)
        || isWithin(repoContext.commonDir, path)
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

function isFiniteRegularFile(rawPath, repoContext) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath === "-"
    || rawPath.startsWith("-") || isAbsolute(rawPath)) {
    return false;
  }
  const candidate = resolve(repoContext.cwd, rawPath);
  if (!isWithin(repoContext.root, candidate) || hasUnsafeLinkComponent(repoContext.root, candidate)) {
    return false;
  }
  try {
    return lstatSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isFiniteFileRead(program, args, repoContext) {
  if (["cat", "stat", "file", "realpath", "readlink", "dirname", "basename"].includes(program)) {
    if (program === "cat") {
      return args.length > 0 && args.every((arg) => isFiniteRegularFile(arg, repoContext));
    }
    return args.length > 0 && args.every((arg) => arg !== "-" && !arg.startsWith("-"));
  }
  if (program === "head" || program === "tail") {
    if (args.some((arg) => /^-[^-]*[fF]/u.test(arg) || arg === "--retry"
      || arg === "--follow" || arg.startsWith("--follow=") || arg === "--pid"
      || arg.startsWith("--pid="))) {
      return false;
    }
    if (args[0] === "-n" && /^\d+$/u.test(args[1] ?? "")) {
      return args.length > 2 && args.slice(2).every((arg) => isFiniteRegularFile(arg, repoContext));
    }
    return args.length > 0 && args.every((arg) => isFiniteRegularFile(arg, repoContext));
  }
  if (program === "wc") {
    const operands = args.filter((arg) => !arg.startsWith("-"));
    return operands.length > 0 && operands.every((arg) => isFiniteRegularFile(arg, repoContext));
  }
  if (program === "jq") {
    const positionals = args.filter((arg) => !arg.startsWith("-"));
    return positionals.length >= 2
      && positionals.slice(1).every((arg) => isFiniteRegularFile(arg, repoContext));
  }
  if (program === "du") {
    return args.length === 0 || args.some((arg) => arg !== "-" && !arg.startsWith("-"));
  }
  return program === "test" || program === "true" || program === "false";
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
    return true;
  }
  if (program === "rg") {
    if (!args.includes("--no-config")
      || args.some((arg) => arg === "--pre" || arg.startsWith("--pre=")
      || arg === "--pre-glob" || arg.startsWith("--pre-glob=")
      || arg === "--hostname-bin" || arg.startsWith("--hostname-bin=")
      || arg === "--search-zip" || /^-[^-]*z/u.test(arg))) {
      return false;
    }
    const positionals = args.filter((arg) => !arg.startsWith("-"));
    return args.includes("--files") || positionals.length >= 2;
  }
  if (FILE_READ_PROGRAMS.has(program)) {
    return isFiniteFileRead(program, args, repoContext);
  }
  if (program === "command") {
    return args.length === 2 && args[0] === "-v";
  }
  if (program === "git") {
    return isGitRead(tokens);
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

function isLinkedValidationCommand(tokens, repoContext) {
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
    return repoContext.cwd === repoContext.root;
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

function evaluateShell(toolInput, repoContext) {
  const command = commandFromToolInput(toolInput);
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
    return DECISION_ALLOW;
  }
  if (repoContext.kind === "linked" && isLinkedValidationCommand(tokens, repoContext)) {
    return DECISION_ALLOW;
  }
  return deny(repoContext.kind === "primary"
    ? "primary checkout permits reviewed read-only commands only"
    : "linked worktree command is not an approved non-interactive validation entrypoint");
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
  if (READ_ONLY_TOOLS.has(toolName)) {
    return DECISION_ALLOW;
  }
  if (toolName === "write_stdin") {
    return deny("follow-up stdin injection is not allowed");
  }
  if (CODE_MODE_TOOLS.has(toolName)) {
    return deny("code-mode wrappers are outside the auditable command surface");
  }
  if (DIRECT_WRITE_TOOLS.has(toolName)) {
    return deny("direct write tools are not allowed; use contained apply_patch in a linked worktree");
  }
  if (toolName === "agent" || squashedToolName.endsWith("spawnagent")) {
    return deny("subagent Hook inheritance has not been qualified for this host");
  }

  const repoContext = resolveRepoContext(input.cwd);
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
    if (repoContext.kind !== "linked") {
      return deny("apply_patch is allowed only in a linked worktree");
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
    return evaluateShell(input.tool_input, repoContext);
  }
  return deny("tool name or payload shape is not on the reviewed allowlist");
}
