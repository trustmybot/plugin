import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createForgeBindingForTests, prepareForgeInvocation, resolveOriginTarget } from "../../adapters/codex/hooks/forge-binding.mjs";

const TOKEN = "fixture_token_that_is_not_a_real_credential";
const GIT_ENV = {
  PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
};

function fixture(t, url = "https://github.com/fixture/project.git") {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tmb-forge-binding-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo");
  const hostHome = join(base, "host-home");
  const executable = join(base, "trusted-forge");
  mkdirSync(root);
  mkdirSync(hostHome);
  writeFileSync(executable, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  execFileSync("/usr/bin/git", ["init", "-q", "-b", "feature/forge"], { cwd: root, env: GIT_ENV, stdio: "ignore" });
  const context = { root, cwd: root, gitDir: join(root, ".git"), commonDir: join(root, ".git"), branch: "feature/forge" };
  const config = (...args) => execFileSync("/usr/bin/git", ["config", "--local", ...args], { cwd: root, env: GIT_ENV, stdio: "ignore" });
  if (url !== null) config("remote.origin.url", url);
  const options = () => ({ scratch: mkdtempSync(join(base, "scratch-")), executable, hostHome });
  return { base, root, context, config, options, executable, hostHome };
}

function injectedBinding(token = TOKEN) {
  const calls = [];
  const binding = createForgeBindingForTests((file, args, options) => {
    if (file === "/usr/bin/git") return execFileSync(file, args, options);
    assert.equal(file, "/usr/bin/sandbox-exec");
    calls.push({ file, args, options });
    assert.match(args[1], /\(deny file-write\*\).*\(deny network\*\)/u);
    if (token instanceof Error) throw token;
    return `${token}\n`;
  }, { platform: "darwin" });
  return { ...binding, calls };
}

function scratchFiles(path) {
  return readdirSync(path).flatMap((name) => {
    const file = join(path, name);
    return statSync(file).isDirectory() ? scratchFiles(file) : [file];
  });
}

test("origin resolution normalizes supported HTTPS and SSH URLs without executing forge CLIs", (t) => {
  const f = fixture(t);
  for (const [url, provider, host, repository] of [
    ["https://github.com/fixture/project.git", "gh", "github.com", "fixture/project"],
    ["git@github.com:fixture/project", "gh", "github.com", "fixture/project"],
    ["HTTPS://GITHUB.COM/fixture/project.git", "gh", "github.com", "fixture/project"],
    ["https://gitlab.com/group/nested/project.git", "glab", "gitlab.com", "group/nested/project"],
    ["git@gitlab.com:group/nested/project.git", "glab", "gitlab.com", "group/nested/project"],
  ]) {
    f.config("remote.origin.url", url);
    assert.deepEqual(resolveOriginTarget(f.context), { provider, host, repository, url: `https://${host}/${repository}.git` });
  }
});

test("origin resolution rejects URL ambiguity, other hosts, helpers, and credentials in URLs", (t) => {
  const f = fixture(t);
  for (const url of [
    "https://github.example/fixture/project", "http://github.com/fixture/project",
    "https://github.com:fixture/project", "HTTPS://GITHUB.COM:fixture/project",
    "git@github.com/fixture/project", "ssh://git@github.com/fixture/project",
    "https://user@github.com/fixture/project", "https://github.com:443/fixture/project",
    "https://github.com/fixture/project?x=1", "https://github.com/fixture/project#fragment",
    "https://github.com/fixture/%70roject", "https://github.com/fixture/project/",
    "https://github.com/fixture/../project", "https://github.com/fixture/sub/project",
    "https://gitlab.com/group//project", "https://gitlab.com/group/project\n",
    "ext::sh -c fixture", "/tmp/fixture.git", "file:///tmp/fixture.git",
  ]) {
    f.config("remote.origin.url", url);
    assert.throws(() => resolveOriginTarget(f.context), /origin/u, url);
  }
});

test("only one exact origin and a matching optional push URL are accepted", (t) => {
  const f = fixture(t, null);
  f.config("remote.ORIGIN.url", "https://github.com/fixture/project.git");
  assert.throws(() => resolveOriginTarget(f.context), /exactly one URL/u);
  f.config("remote.origin.url", "https://github.com/fixture/project.git");
  f.config("remote.upstream.url", "https://github.com/outside/project.git");
  f.config("remote.upstream.gh-resolved", "base");
  f.config("remote.origin.pushurl", "git@github.com:fixture/project.git");
  assert.equal(resolveOriginTarget(f.context).repository, "fixture/project");
  f.config("remote.origin.pushurl", "https://github.com/outside/project.git");
  assert.throws(() => resolveOriginTarget(f.context), /same repository/u);
  f.config("remote.origin.pushurl", "https://github.com/fixture/project.git");
  f.config("--add", "remote.origin.pushurl", "https://github.com/fixture/project.git");
  assert.throws(() => resolveOriginTarget(f.context), /at most one/u);
  f.config("--unset-all", "remote.origin.pushurl");
  f.config("--add", "remote.origin.url", "https://github.com/fixture/project.git");
  assert.throws(() => resolveOriginTarget(f.context), /exactly one/u);
});

test("routing configuration and implicit push options fail before any credential read", (t) => {
  const f = fixture(t);
  for (const [key, value] of [
    ["url.https://outside.example/.insteadOf", "https://github.com/"],
    ["url.https://outside.example/.pushInsteadOf", "https://github.com/"],
    ["http.proxy", "http://localhost:1"], ["http.https://github.com/.proxy", "http://localhost:1"],
    ["http.extraHeader", "fixture"], ["credential.helper", "fixture-helper"],
    ["remote.origin.proxy", "http://localhost:1"], ["remote.origin.vcs", "fixture-helper"],
    ["remote.origin.receivepack", "fixture-helper"], ["remote.origin.uploadpack", "fixture-helper"],
    ["core.gitproxy", "fixture-helper"], ["core.sshcommand", "fixture-helper"],
    ["remote.origin.push", "HEAD:refs/heads/outside"], ["remote.origin.mirror", "true"],
    ["push.pushOption", "merge_request.create"],
  ]) {
    f.config(key, value);
    const binding = injectedBinding();
    assert.throws(() => binding.resolveOriginTarget(f.context), /does not accept/u, key);
    assert.equal(binding.calls.length, 0);
    f.config("--unset-all", key);
  }
  const include = join(f.base, "include-fifo");
  execFileSync("/usr/bin/mkfifo", [include]);
  f.config("include.path", include);
  assert.throws(() => resolveOriginTarget(f.context), /does not accept/u);
});

test("worktree configuration is inspected and malformed or nonordinary config is rejected", (t) => {
  const f = fixture(t);
  f.config("extensions.worktreeConfig", "true");
  const worktreeConfig = join(f.context.gitDir, "config.worktree");
  writeFileSync(worktreeConfig, "[url \"https://outside.example/\"]\n\tinsteadOf = https://github.com/\n");
  assert.throws(() => resolveOriginTarget(f.context), /does not accept/u);
  writeFileSync(worktreeConfig, "[core]\n\tfilemode = false\n");
  assert.equal(resolveOriginTarget(f.context).repository, "fixture/project");
  writeFileSync(worktreeConfig, "[remote \"origin\"]\n\turl = https://github.com/fixture/project.git\n");
  assert.throws(() => resolveOriginTarget(f.context), /exactly one/u);
  rmSync(worktreeConfig);
  execFileSync("/usr/bin/mkfifo", [worktreeConfig]);
  assert.throws(() => resolveOriginTarget(f.context), /configuration cannot be read safely/u);
  rmSync(worktreeConfig);
  const configPath = join(f.context.commonDir, "config");
  const contents = readFileSync(configPath);
  rmSync(configPath);
  const outside = join(f.base, "external-config");
  writeFileSync(outside, contents);
  symlinkSync(outside, configPath);
  assert.throws(() => resolveOriginTarget(f.context), /configuration cannot be read safely/u);
  rmSync(configPath);
  writeFileSync(configPath, Buffer.alloc(256 * 1024 + 1));
  assert.throws(() => resolveOriginTarget(f.context), /configuration cannot be read safely/u);
  writeFileSync(configPath, "[broken\n");
  assert.throws(() => resolveOriginTarget(f.context), /could not be inspected/u);
});

test("bound forge reads use an explicit origin and scratch cwd with an isolated environment", (t) => {
  const f = fixture(t);
  const binding = injectedBinding();
  const target = binding.resolveOriginTarget(f.context);
  const options = f.options();
  const result = binding.prepareForgeInvocation(["gh", "pr", "view", "1183", "--comments", "--json", "number,title"], target, f.context, options);
  assert.deepEqual(result.args, ["pr", "view", "--repo", "github.com/fixture/project", "1183", "--comments", "--json", "number,title"]);
  assert.equal(result.cwd, options.scratch);
  assert.equal(result.env.GH_TOKEN, TOKEN);
  assert.equal(result.env.GH_HOST, "github.com");
  assert.equal(result.env.HOME, join(options.scratch, "forge-home"));
  assert.equal(result.env.GLAB_CONFIG_DIR, join(result.env.HOME, ".config", "glab-cli"));
  assert.equal(readFileSync(join(result.env.GLAB_CONFIG_DIR, "config.yml"), "utf8"), "{}\n");
  for (const name of ["GH_REPO", "GLAB_REPO", "GITLAB_REPO", "GITLAB_GROUP", "GITLAB_API_HOST", "GITLAB_HEAD_REPO", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "GH_DEBUG", "GLAB_DEBUG_HTTP", "GIT_TRACE", "GIT_DIR", "GIT_WORK_TREE"]) {
    assert.equal(result.env[name], undefined, name);
  }
  const call = binding.calls[0];
  assert.deepEqual(call.args.slice(2), [f.executable, "auth", "token", "--hostname", "github.com"]);
  assert.equal(call.options.env.HOME, f.hostHome);
  assert.equal(call.options.cwd, options.scratch);
  assert.equal(call.options.env.GH_TOKEN, undefined);
  assert.equal(call.options.env.GH_CONFIG_DIR, undefined);
  assert.equal(call.options.env.GLAB_CONFIG_DIR, undefined);
  assert.equal(call.options.timeout, 3000);
  for (const file of scratchFiles(options.scratch)) assert.equal(readFileSync(file).includes(TOKEN), false);
  assert.equal(JSON.stringify(result.args).includes(TOKEN), false);
});

test("numeric and current-branch selectors never consult a default remote", (t) => {
  const f = fixture(t);
  const binding = injectedBinding();
  const target = binding.resolveOriginTarget(f.context);
  for (const tokens of [
    ["gh", "pr", "view"], ["gh", "pr", "checks", "--json", "name,state"],
    ["gh", "pr", "diff", "--color=never"], ["gh", "pr", "edit", "--body", "fixture"],
    ["gh", "pr", "ready"],
  ]) {
    const result = binding.prepareForgeInvocation(tokens, target, f.context, f.options());
    assert.deepEqual(result.args.slice(0, 5), [...tokens.slice(1, 3), "--repo", "github.com/fixture/project", "feature/forge"]);
  }
  const repo = binding.prepareForgeInvocation(["gh", "repo", "view", "--json", "nameWithOwner"], target, f.context, f.options());
  assert.deepEqual(repo.args, ["repo", "view", "github.com/fixture/project", "--json", "nameWithOwner"]);
  const auth = binding.prepareForgeInvocation(["gh", "auth", "status"], target, f.context, f.options());
  assert.deepEqual(auth.args, ["auth", "status", "--hostname", "github.com"]);
  const create = ["gh", "pr", "create", "--base", "dev", "--head", "feature/forge", "--title", "fixture", "--body", "fixture"];
  assert.deepEqual(binding.prepareForgeInvocation(create, target, f.context, f.options()).args,
    ["pr", "create", "--repo", "github.com/fixture/project", ...create.slice(3)]);
});

test("GitLab binds nested namespaces, current branches, pipelines, and a fixed token lookup", (t) => {
  const f = fixture(t, "git@gitlab.com:group/nested/project.git");
  const binding = injectedBinding();
  const target = binding.resolveOriginTarget(f.context);
  const view = binding.prepareForgeInvocation(["glab", "mr", "view", "--output", "json"], target, f.context, f.options());
  assert.deepEqual(view.args, ["mr", "view", "--repo", "gitlab.com/group/nested/project", "feature/forge", "--output", "json"]);
  assert.equal(view.env.GITLAB_HOST, "https://gitlab.com");
  assert.equal(view.env.GITLAB_TOKEN, TOKEN);
  assert.equal(view.env.GH_TOKEN, undefined);
  assert.deepEqual(binding.calls[0].args.slice(2), [f.executable, "config", "get", "token", "--global", "--host", "gitlab.com"]);
  for (const action of ["status", "get"]) {
    assert.deepEqual(binding.prepareForgeInvocation(["glab", "ci", action], target, f.context, f.options()).args,
      ["ci", action, "--repo", "gitlab.com/group/nested/project", "--branch", "feature/forge"]);
  }
  assert.deepEqual(binding.prepareForgeInvocation(["glab", "ci", "get", "--pipeline-id", "10"], target, f.context, f.options()).args,
    ["ci", "get", "--repo", "gitlab.com/group/nested/project", "--pipeline-id", "10"]);
});

test("formatters, routing overrides, foreign selectors, and changed origins fail before credentials", (t) => {
  const f = fixture(t);
  const binding = injectedBinding();
  const target = binding.resolveOriginTarget(f.context);
  for (const args of [
    ["--json", "number", "--jq", "env.GH_TOKEN"], ["--jq=env.GH_TOKEN"], ["-qenv.GH_TOKEN"],
    ["--template", "{{.number}}"], ["--template={{.number}}"], ["-t{{.number}}"],
    ["--repo", "other/repo"], ["--repo=other/repo"], ["-Rother/repo"],
    ["--hostname", "outside.example"], ["--host=outside.example"],
    ["https://github.com/other/repo/pull/1"], ["other:feature"],
  ]) assert.throws(() => binding.prepareForgeInvocation(["gh", "pr", "view", ...args], target, f.context, f.options()));
  assert.throws(() => binding.prepareForgeInvocation(["glab", "mr", "view", "1"], target, f.context, f.options()), /origin provider/u);
  assert.throws(() => binding.prepareForgeInvocation(["gh", "auth", "status", "--show-token"], target, f.context, f.options()), /no caller options/u);
  assert.throws(() => binding.prepareForgeInvocation(["gh", "pr", "view"], target, { ...f.context, branch: "owner:feature" }, f.options()), /current branch/u);
  assert.throws(() => binding.prepareForgeInvocation(["gh", "pr", "ready"], target, { ...f.context, branch: "1183" }, f.options()), /unambiguously/u);
  f.config("remote.origin.url", "https://github.com/other/project.git");
  assert.throws(() => binding.prepareForgeInvocation(["gh", "pr", "view", "1"], target, f.context, f.options()), /origin changed/u);
  assert.equal(binding.calls.length, 0);
});

test("credential failures are bounded and redacted, without fallback to ambient tokens", (t) => {
  const f = fixture(t);
  const target = resolveOriginTarget(f.context);
  for (const token of ["", "line1\nline2", "x".repeat(4097), "space token", new Error(`failed with ${TOKEN}`)]) {
    const binding = injectedBinding(token);
    assert.throws(() => binding.prepareForgeInvocation(["gh", "pr", "view", "1"], target, f.context, f.options()), (error) => {
      assert.equal(error.message, "a host-bound stored forge credential could not be read safely");
      assert.equal(String(error).includes(TOKEN), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("poisoned ambient target, credential, config, and proxy environments are never forwarded", (t) => {
  const f = fixture(t);
  const binding = injectedBinding();
  const poison = {
    GH_REPO: "outside/project", GH_HOST: "outside.example", GH_TOKEN: "ambient_fake_token",
    GITHUB_TOKEN: "ambient_fake_token", GITLAB_TOKEN: "ambient_fake_token", GH_CONFIG_DIR: f.root,
    GLAB_CONFIG_DIR: f.root, GITLAB_API_HOST: "outside.example", GITLAB_GROUP: "outside",
    HTTPS_PROXY: "http://localhost:1", ALL_PROXY: "http://localhost:1", GH_DEBUG: "api",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.url", GIT_CONFIG_VALUE_0: "https://github.com/outside/project.git",
    GIT_DIR: "/tmp/not-a-repo", GIT_WORK_TREE: "/tmp/not-a-repo",
  };
  const saved = new Map(Object.keys(poison).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, poison);
    const target = binding.resolveOriginTarget(f.context);
    assert.equal(target.repository, "fixture/project");
    const result = binding.prepareForgeInvocation(["gh", "pr", "view", "1"], target, f.context, f.options());
    assert.equal(result.env.GH_TOKEN, TOKEN);
    assert.equal(result.env.GH_HOST, "github.com");
    for (const key of Object.keys(poison)) {
      assert.notEqual(result.env[key], poison[key], key);
      assert.equal(binding.calls[0].options.env[key], undefined, key);
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("unsafe executable, home, and scratch paths are rejected before credential export", (t) => {
  const f = fixture(t);
  const target = resolveOriginTarget(f.context);
  const binding = injectedBinding();
  const inRepo = join(f.root, "fake-forge");
  writeFileSync(inRepo, "#!/bin/sh\n", { mode: 0o700 });
  const link = join(f.base, "forge-link");
  symlinkSync(f.executable, link);
  for (const executable of [inRepo, link, join(f.base, "missing")]) {
    assert.throws(() => binding.prepareForgeInvocation(["gh", "pr", "view", "1"], target, f.context, { ...f.options(), executable }), /trusted canonical CLI/u);
  }
  assert.throws(() => binding.prepareForgeInvocation(["gh", "pr", "view", "1"], target, f.context, { ...f.options(), hostHome: f.root }), /trusted canonical CLI/u);
  const options = f.options();
  chmodSync(options.scratch, 0o755);
  assert.throws(() => binding.prepareForgeInvocation(["gh", "pr", "view", "1"], target, f.context, options), /private scratch/u);
  assert.equal(binding.calls.length, 0);
});

test("push preparation keeps credentials only in scoped Git environment and disables redirects and helpers", (t) => {
  const f = fixture(t);
  const binding = injectedBinding();
  const target = binding.resolveOriginTarget(f.context);
  const options = f.options();
  const result = binding.prepareGitPushInvocation(target, f.context, options);
  assert.equal(result.url, "https://github.com/fixture/project.git");
  assert.equal(result.url.includes(TOKEN), false);
  assert.equal(result.env.GH_TOKEN, undefined);
  const settings = new Map(Array.from({ length: Number(result.env.GIT_CONFIG_COUNT) }, (_, index) => [result.env[`GIT_CONFIG_KEY_${index}`], result.env[`GIT_CONFIG_VALUE_${index}`]]));
  assert.equal(settings.get("credential.helper"), "");
  assert.equal(settings.get("core.hooksPath"), "/dev/null");
  assert.equal(settings.get("http.followRedirects"), "false");
  assert.equal(settings.get("http.sslVerify"), "true");
  assert.equal(settings.get("protocol.allow"), "never");
  assert.equal(settings.get("protocol.https.allow"), "always");
  const header = settings.get(`http.${target.url}.extraHeader`);
  assert.equal(header, `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
  const actual = execFileSync("/usr/bin/git", ["config", "--get-urlmatch", "http.extraheader", target.url], { cwd: f.root, env: result.env, encoding: "utf8" });
  assert.equal(actual.trim(), header);
  const foreign = execFileSync("/usr/bin/git", ["config", "--get-urlmatch", "http.extraheader", "https://github.com/outside/project.git"], { cwd: f.root, env: result.env, encoding: "utf8" });
  assert.equal(foreign.trim(), "");
  for (const file of scratchFiles(options.scratch)) assert.equal(readFileSync(file).includes(TOKEN), false);
});

let installedGh;
try { installedGh = realpathSync(execFileSync("/usr/bin/which", ["gh"], { encoding: "utf8" }).trim()); } catch { /* Explicitly skipped below when unavailable. */ }

test("real gh exports only a fixture stored token under a read-only no-network sandbox", {
  skip: process.platform !== "darwin" ? "macOS credential sandbox unavailable" : !installedGh ? "gh CLI unavailable" : false,
}, (t) => {
  const f = fixture(t);
  const configDir = join(f.hostHome, ".config", "gh");
  mkdirSync(configDir, { recursive: true });
  const hostsFile = join(configDir, "hosts.yml");
  const configFile = join(configDir, "config.yml");
  writeFileSync(configFile, "version: 1\n", { mode: 0o600 });
  const contents = `github.com:\n    oauth_token: ${TOKEN}\n    git_protocol: https\n    user: fixture\n    users:\n        fixture:\n            oauth_token: ${TOKEN}\n`;
  writeFileSync(hostsFile, contents, { mode: 0o600 });
  const options = { ...f.options(), executable: installedGh };
  const result = prepareForgeInvocation(["gh", "pr", "view", "1183", "--json", "number"], resolveOriginTarget(f.context), f.context, options);
  assert.equal(result.env.GH_TOKEN, TOKEN);
  assert.equal(readFileSync(hostsFile, "utf8"), contents);
  assert.equal(readFileSync(configFile, "utf8"), "version: 1\n");
  for (const file of scratchFiles(options.scratch)) assert.equal(readFileSync(file).includes(TOKEN), false);
});
