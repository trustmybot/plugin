import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const TIMEOUT_MS = 1_000;
const AUTH_TIMEOUT_MS = 3_000;
const MAX_CONFIG_BYTES = 256 * 1024;
const READ_ONLY_PROFILE = "(version 1) (allow default) (deny file-write*) (deny network*)";
const CLEAN_GIT_ENV = Object.freeze({
  PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});
const FORGE_OPERATIONS = new Set([
  "gh auth status", "gh pr list", "gh pr view", "gh pr status", "gh pr diff", "gh pr checks",
  "gh issue list", "gh issue view", "gh issue status", "gh release list", "gh release view",
  "gh repo view", "gh run list", "gh run view", "gh workflow list", "gh workflow view",
  "gh pr create", "gh pr edit", "gh pr ready",
  "glab auth status", "glab issue list", "glab issue view", "glab mr list", "glab mr view",
  "glab mr diff", "glab release list", "glab release view", "glab repo view",
  "glab ci list", "glab ci status", "glab ci get", "glab mr create",
]);

function fail(message) { throw new Error(message); }
function inside(root, path) {
  const part = relative(root.normalize("NFC").toLowerCase(), path.normalize("NFC").toLowerCase());
  return part === "" || !part.startsWith("..") && !isAbsolute(part);
}
function directory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path
    || realpathSync(path) !== path || !lstatSync(path).isDirectory()) fail("forge binding requires canonical directories");
  return path;
}
function contextPaths(context) {
  try {
    return { root: directory(context.root), gitDir: directory(context.gitDir), commonDir: directory(context.commonDir) };
  } catch { fail("forge binding requires a verified canonical repository context"); }
}
function ordinaryConfig(path, optional = false) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CONFIG_BYTES || realpathSync(path) !== path) {
      fail("origin configuration must be a bounded ordinary file");
    }
    return true;
  } catch (error) {
    if (optional && error?.code === "ENOENT") return false;
    fail("origin configuration cannot be read safely");
  }
}
function parseConfig(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > MAX_CONFIG_BYTES
    || output.length > 0 && !output.endsWith("\0")) fail("origin configuration output is invalid");
  return output.split("\0").filter(Boolean).map((entry) => {
    const split = entry.indexOf("\n");
    const rawKey = split < 0 ? entry : entry.slice(0, split);
    // Git section/key names are insensitive; quoted subsection names (including
    // the remote name) are sensitive. ORIGIN must not become origin here.
    const key = rawKey.replace(/^[^.]+/u, (part) => part.toLowerCase())
      .replace(/[^.]+$/u, (part) => part.toLowerCase());
    return [key, split < 0 ? "" : entry.slice(split + 1)];
  });
}
function parseOriginUrl(value) {
  if (typeof value !== "string" || value.length > 2_048 || /[\s\x00-\x1f\x7f%?#]/u.test(value)) {
    fail("origin must use a supported GitHub.com or GitLab.com repository URL");
  }
  const match = /^https:\/\/(github\.com|gitlab\.com)\/([^:]+)$/iu.exec(value)
    ?? /^git@(github\.com|gitlab\.com):([^:]+)$/iu.exec(value);
  if (!match) {
    fail("origin must use HTTPS or git@host:path on GitHub.com or GitLab.com");
  }
  const host = match[1].toLowerCase();
  const repository = match[2].replace(/\.git$/u, "");
  const parts = repository.split("/");
  if (parts.length < 2 || host === "github.com" && parts.length !== 2
    || parts.some((part) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(part) || part.endsWith("."))) {
    fail("origin repository path is unsupported");
  }
  return Object.freeze({ provider: host === "github.com" ? "gh" : "glab", host, repository,
    url: `https://${host}/${repository}.git` });
}
function sameTarget(left, right) {
  return left && ["provider", "host", "repository", "url"].every((key) => left[key] === right[key]);
}
function privateHome(scratch, context) {
  try {
    directory(scratch);
    const stats = lstatSync(scratch);
    if ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid()
      || [context.root, context.gitDir, context.commonDir].some((root) => inside(root, scratch))) {
      fail("unsafe scratch directory");
    }
    const home = join(scratch, "forge-home");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(home, ".config"), { mode: 0o700 });
    mkdirSync(join(home, ".config", "gh"), { mode: 0o700 });
    mkdirSync(join(home, ".config", "glab-cli"), { mode: 0o700 });
    // An existing empty config prevents glab from falling through to system
    // configuration. Credentials remain in the child environment only.
    writeFileSync(join(home, ".config", "glab-cli", "config.yml"), "{}\n", { mode: 0o600, flag: "wx" });
    return home;
  } catch { fail("forge binding requires a fresh private scratch directory outside the checkout"); }
}
function scratchEnvironment(home) {
  return {
    ...CLEAN_GIT_ENV, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CONFIG_DIRS: join(home, ".config"),
    GH_CONFIG_DIR: join(home, ".config", "gh"), GLAB_CONFIG_DIR: join(home, ".config", "glab-cli"),
    GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_TELEMETRY: "false", GLAB_CHECK_UPDATE: "false", GLAB_SEND_TELEMETRY: "false",
    GLAB_ENABLE_CI_AUTOLOGIN: "false", GLAB_NO_PROMPT: "1", NO_PROMPT: "1", NO_COLOR: "1",
    GLAB_NOTIFY_SKILL_UPDATES: "false", GLAB_SHOW_WHATS_NEW: "false",
    GH_PAGER: "/bin/cat", GLAB_PAGER: "/bin/cat", PAGER: "/bin/cat",
    GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false",
  };
}
function safeBranch(branch) {
  return typeof branch === "string" && branch.length > 0 && branch.length <= 255
    && !branch.startsWith("-") && !branch.startsWith("/") && !branch.endsWith("/")
    && !branch.endsWith(".") && !branch.endsWith(".lock") && !branch.includes("..")
    && !branch.includes("@{") && !branch.includes("//") && !/[\s~^:?*[\\\x00-\x1f\x7f]/u.test(branch);
}
function selectorPositionals(args, valueFlags) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return result.concat(args.slice(index + 1));
    if (!argument.startsWith("-")) result.push(argument);
    else {
      const flag = argument.startsWith("--") ? argument.split("=", 1)[0] : argument.slice(0, 2);
      if (valueFlags.has(flag) && argument === flag) index += 1;
    }
  }
  return result;
}
function boundForgeArguments(tokens, target, context) {
  if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== "string" || !token)
    || tokens[0] !== target?.provider || !FORGE_OPERATIONS.has(tokens.slice(0, 3).join(" "))) {
    fail("forge binding requires a reviewed command for the origin provider");
  }
  const [program, group, action, ...args] = tokens;
  for (const argument of args) {
    if (/^--(?:repo|host|hostname|group)(?:=|$)/u.test(argument) || /^-R/u.test(argument)
      || group === "mr" && argument === "--head") fail("forge repository and host overrides are not accepted");
    // gh's embedded jq enables an environment loader, which would expose the
    // injected token. Keep dynamic formatters outside this version-agnostic
    // binding; JSON field selection remains available.
    if (/^--(?:jq|template)(?:=|$)/u.test(argument) || program === "gh" && /^-[qt]/u.test(argument)) {
      fail("bound forge commands do not accept jq or template formatters; use JSON field output");
    }
  }
  const qualified = `${target.host}/${target.repository}`;
  if (group === "auth") {
    if (args.length !== 0) fail("bound authentication status takes no caller options");
    return [group, action, "--hostname", target.host];
  }
  if (group === "repo") return [group, action, qualified, ...args];
  const result = [group, action, "--repo", qualified];
  if ((group === "pr" && ["view", "diff", "checks", "edit", "ready"].includes(action))
    || group === "mr" && ["view", "diff"].includes(action)) {
    const positionals = selectorPositionals(args, new Set([
      "--json", "--color", "--exclude", "-e", "--output", "-F", "--page", "-p", "--per-page", "-P", "--title", "--body",
    ]));
    if (positionals.length > 1 || positionals.some((value) => !/^\d+$/u.test(value))) {
      fail("bound pull-request queries require a numeric selector or the current branch");
    }
    if (positionals.length === 0) {
      if (!safeBranch(context.branch) || /^\d+$/u.test(context.branch)) {
        fail("the current branch cannot be used unambiguously as a forge selector; use a numeric PR/MR ID");
      }
      result.push(context.branch);
    }
  }
  if (group === "ci" && ["status", "get"].includes(action)
    && !args.some((argument) => /^(?:--(?:branch|pipeline-id|merge-request)(?:=|$)|-[bp])/u.test(argument))) {
    if (!safeBranch(context.branch)) fail("the current branch cannot be used as a pipeline selector");
    result.push("--branch", context.branch);
  }
  return result.concat(args);
}

// Dependency injection exists only on this factory. The production exports
// below close over the real child-process implementation and accept no hooks.
export function createForgeBindingForTests(run = execFileSync, { platform = process.platform } = {}) {
  function readConfig(path) {
    try {
      return parseConfig(run("/usr/bin/git", ["config", "--file", path, "--no-includes", "--null", "--list"], {
        // Git performs repository setup before handling --file/--no-includes.
        // Run outside the checkout so startup cannot load its include/worktree
        // files (including FIFOs) before this explicit bounded inspection.
        cwd: "/", env: { ...CLEAN_GIT_ENV, GIT_CEILING_DIRECTORIES: "/" },
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: TIMEOUT_MS,
        maxBuffer: MAX_CONFIG_BYTES,
      }));
    } catch { fail("origin configuration could not be inspected"); }
  }
  function resolveOriginTarget(context) {
    const paths = contextPaths(context);
    const config = join(paths.commonDir, "config");
    ordinaryConfig(config);
    const entries = readConfig(config);
    const worktree = entries.filter(([key]) => key === "extensions.worktreeconfig");
    if (worktree.some(([, value]) => !["true", "false", "yes", "no", "on", "off", "1", "0"].includes(value.toLowerCase()))) {
      fail("worktree configuration mode is unsupported");
    }
    if (worktree.some(([, value]) => ["true", "yes", "on", "1"].includes(value.toLowerCase()))) {
      const worktreeConfig = join(paths.gitDir, "config.worktree");
      if (ordinaryConfig(worktreeConfig, true)) entries.push(...readConfig(worktreeConfig));
    }
    if (entries.some(([key]) => /^(?:include(?:if)?\.|url\.|https?\.|credential\.)/u.test(key)
      || /^remote\..*\.(?:proxy|proxyauthmethod|vcs|receivepack|uploadpack)$/u.test(key)
      || ["core.gitproxy", "core.sshcommand", "remote.origin.push", "remote.origin.mirror", "push.pushoption"].includes(key))) {
      fail("origin binding does not accept include, URL rewrite, proxy, credential, or transport-helper configuration");
    }
    const urls = entries.filter(([key]) => key === "remote.origin.url").map(([, value]) => value);
    const pushUrls = entries.filter(([key]) => key === "remote.origin.pushurl").map(([, value]) => value);
    if (urls.length !== 1 || pushUrls.length > 1) fail("origin must have exactly one URL and at most one matching push URL");
    const target = parseOriginUrl(urls[0]);
    if (pushUrls.length === 1 && !sameTarget(target, parseOriginUrl(pushUrls[0]))) {
      fail("origin push URL must select the same repository as its fetch URL");
    }
    return target;
  }
  function checkedOptions(target, context, options) {
    const paths = contextPaths(context);
    if (!sameTarget(target, resolveOriginTarget(context))) fail("origin changed before forge execution");
    try {
      directory(options.hostHome);
      if ([paths.root, paths.gitDir, paths.commonDir, options.scratch].some((root) => inside(root, options.hostHome))) {
        fail("host home cannot be a checkout or scratch directory");
      }
      const executable = realpathSync(options.executable);
      const stats = lstatSync(executable);
      if (executable !== options.executable || !stats.isFile()
        || [paths.root, paths.gitDir, paths.commonDir, options.scratch].some((root) => inside(root, executable))) {
        fail("untrusted forge executable");
      }
      accessSync(executable, constants.X_OK);
    } catch { fail("forge binding requires a trusted canonical CLI executable and host home"); }
    return { ...options, home: privateHome(options.scratch, paths) };
  }
  function readToken(target, options) {
    if (platform !== "darwin") fail("credential export requires the macOS read-only sandbox");
    const env = scratchEnvironment(options.hostHome);
    // Read the trusted CLI's default stored credentials for the real home;
    // never inherit caller-controlled config locations or ambient tokens.
    for (const name of ["GH_CONFIG_DIR", "GLAB_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS"]) delete env[name];
    const args = target.provider === "gh"
      ? ["auth", "token", "--hostname", target.host]
      : ["config", "get", "token", "--global", "--host", target.host];
    try {
      const output = run("/usr/bin/sandbox-exec", ["-p", READ_ONLY_PROFILE, options.executable, ...args], {
        cwd: options.scratch, env, encoding: "utf8", timeout: AUTH_TIMEOUT_MS,
        maxBuffer: 8 * 1024, stdio: ["ignore", "pipe", "ignore"],
      });
      const token = output.trim();
      if (!/^[A-Za-z0-9_][A-Za-z0-9._~+/=-]{1,4095}$/u.test(token)) fail("invalid token");
      return token;
    } catch { fail("a host-bound stored forge credential could not be read safely"); }
  }
  // The caller must first approve tokens with repo-policy's exact command
  // grammar. Execute this result from its scratch cwd under the runner profile,
  // with no inherited environment. Never print or persist the returned env.
  function prepareForgeInvocation(tokens, target, context, options) {
    const args = boundForgeArguments(tokens, target, context);
    const checked = checkedOptions(target, context, options);
    const token = readToken(target, checked);
    return { args, cwd: checked.scratch, env: { ...scratchEnvironment(checked.home),
      ...(target.provider === "gh" ? { GH_HOST: target.host, GH_TOKEN: token }
        : { GITLAB_HOST: `https://${target.host}`, GITLAB_TOKEN: token }),
    } };
  }
  // The runner owns the explicit HEAD refspec, allowed Git executables, and
  // write profile. This helper only prepares HTTPS routing and authentication.
  function prepareGitPushInvocation(target, context, options) {
    const checked = checkedOptions(target, context, options);
    const token = readToken(target, checked);
    const username = target.provider === "gh" ? "x-access-token" : "oauth2";
    const authorization = `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
    const settings = [
      ["credential.helper", ""], ["credential.interactive", "false"], ["core.askPass", "/usr/bin/false"],
      ["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["http.proxy", ""],
      ["http.followRedirects", "false"], ["http.sslVerify", "true"], ["http.extraHeader", ""],
      [`http.${target.url}.extraHeader`, authorization], ["protocol.allow", "never"], ["protocol.https.allow", "always"],
    ];
    const env = { ...scratchEnvironment(checked.home), GIT_CONFIG_COUNT: String(settings.length) };
    settings.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    return { url: target.url, env };
  }
  return { resolveOriginTarget, prepareForgeInvocation, prepareGitPushInvocation };
}

const binding = createForgeBindingForTests();
export const { resolveOriginTarget, prepareForgeInvocation, prepareGitPushInvocation } = binding;
