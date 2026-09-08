import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { RUNTIME_RELATIVE_PATHS, calculateRuntimeDigest } from "../../adapters/codex/hooks/dispatcher.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST = "hooks/codex/hooks.json";
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function executable(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${source}\n`, { mode: 0o755 });
}

function fixture(t, { repoName = "repo", pluginName = "plugin", separateGitDir = false, linked = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tmb-launcher-alias-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let repo = join(root, repoName);
  const plugin = join(root, pluginName);
  const hostHome = join(root, "host home");
  const metadata = separateGitDir ? join(root, "metadata") : join(repo, ".git");
  mkdirSync(repo);
  mkdirSync(hostHome);
  const init = spawnSync("/usr/bin/git", ["init", "-q", "-b", "main", ...(separateGitDir ? ["--separate-git-dir", metadata] : []), repo], {
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  let gitDir = metadata;
  if (linked) {
    repo = join(root, "linked worktree");
    gitDir = join(metadata, "worktrees/fixture");
    mkdirSync(repo);
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(repo, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feature/fixture\n");
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    writeFileSync(join(gitDir, "gitdir"), `${join(repo, ".git")}\n`);
    const context = spawnSync("/usr/bin/git", ["-C", repo, "rev-parse", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"], {
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8",
    });
    assert.equal(context.status, 0, context.stderr);
    assert.equal(context.stdout, `${gitDir}\n${metadata}\n`);
  }
  writeFileSync(join(repo, "readme.txt"), "fixture\n");
  for (const path of [...RUNTIME_RELATIVE_PATHS, MANIFEST, ".codex-plugin/plugin.json"]) {
    mkdirSync(dirname(join(plugin, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(plugin, path));
  }
  const manifest = JSON.parse(readFileSync(join(plugin, MANIFEST), "utf8"));
  const hook = manifest.hooks.PreToolUse[0].hooks[0];
  hook.command = hook.command.replace(/--policy-sha256 [a-f0-9]{64}/u, `--policy-sha256 ${calculateRuntimeDigest(plugin)}`);
  writeFileSync(join(plugin, MANIFEST), JSON.stringify(manifest));
  const trustedBin = join(root, "host node/.nvm/versions/node/fixture/bin");
  const trustedMarker = join(root, "trusted-node-ran");
  executable(join(trustedBin, "node"), `printf selected > ${quote(trustedMarker)}\nexec ${quote(process.execPath)} "$@"`);
  const launch = (firstPath, env = {}) => spawnSync("/bin/sh", ["-c", hook.command], {
    cwd: repo,
    env: { PATH: `${firstPath}:${trustedBin}:/usr/bin:/bin`, PLUGIN_ROOT: plugin, HOME: hostHome, ...env },
    input: JSON.stringify({ hook_event_name: "PreToolUse", permission_mode: "default", cwd: repo, tool_name: "Read", tool_input: { file_path: "readme.txt" } }),
    encoding: "utf8", timeout: 5_500,
  });
  return { root, repo, plugin, metadata, gitDir, hostHome, trustedBin, trustedMarker, launch };
}

function assertAllowed(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", result.stderr);
}

function aliases(path, alternate) {
  if (!existsSync(alternate)) return false;
  const left = statSync(path);
  const right = statSync(alternate);
  return left.dev === right.dev && left.ino === right.ino;
}

for (const [label, key, name, alternate] of [
  ["worktree case", "repo", "repo", "REPO"],
  ["worktree Unicode", "repo", "repo-é", "repo-e\u0301"],
  ["plugin case", "plugin", "plugin", "PLUGIN"],
  ["plugin Unicode", "plugin", "plugin-é", "plugin-e\u0301"],
]) {
  test(`launcher rejects ${label} aliases before selecting Node`, (t) => {
    const f = fixture(t, { [`${key}Name`]: name });
    const alternateRoot = join(f.root, alternate);
    if (!aliases(f[key], alternateRoot)) return t.skip("filesystem does not expose this alias");
    const marker = join(f.root, "untrusted-node-ran");
    executable(join(f[key], "bin/node"), `printf intercepted > ${quote(marker)}\nexec ${quote(process.execPath)} "$@"`);
    assertAllowed(f.launch(join(alternateRoot, "bin")));
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(f.trustedMarker), true);
  });
}

test("launcher rejects an executable inside an external Git metadata directory", (t) => {
  const f = fixture(t, { separateGitDir: true });
  const marker = join(f.root, "git-node-ran");
  executable(join(f.metadata, "bin/node"), `printf intercepted > ${quote(marker)}\nexec ${quote(process.execPath)} "$@"`);
  assertAllowed(f.launch(join(f.metadata, "bin")));
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(f.trustedMarker), true);
});

test("linked worktree launcher rejects both its Git directory and the distinct common directory", (t) => {
  const f = fixture(t, { separateGitDir: true, linked: true });
  for (const [name, directory] of [["git-dir", f.gitDir], ["common-dir", f.metadata]]) {
    const marker = join(f.root, `${name}-node-ran`);
    executable(join(directory, "bin/node"), `printf intercepted > ${quote(marker)}\nexec ${quote(process.execPath)} "$@"`);
    assertAllowed(f.launch(join(directory, "bin")));
    assert.equal(existsSync(marker), false, name);
  }
  assert.equal(existsSync(f.trustedMarker), true);
});

test("version-manager lookup clears Node preloads and uses the host default outside the checkout", (t) => {
  const f = fixture(t);
  const shimBin = join(f.root, ".asdf/shims");
  const marker = join(f.root, "preload-ran");
  const observed = join(f.root, "shim-environment");
  const preload = join(f.repo, "preload.cjs");
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "intercepted");`);
  executable(join(shimBin, "node"), `printf "%s\\n%s\\n%s\\n%s\\n%s" "$PWD" "$HOME" "$PATH" "\${NODE_OPTIONS-unset}" "\${BASH_ENV-unset}" > ${quote(observed)}\nexec ${quote(process.execPath)} "$@"`);
  assertAllowed(f.launch(shimBin, { NODE_OPTIONS: `--require=${preload}`, BASH_ENV: preload }));
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(observed, "utf8"), `/\n${f.hostHome}\n/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin\nunset\nunset`);
});

test("version-manager targets are checked again against filesystem identities", (t) => {
  const f = fixture(t, { separateGitDir: true });
  const shimBin = join(f.root, ".mise/shims");
  const marker = join(f.root, "git-node-ran");
  executable(join(f.metadata, "bin/node"), `printf intercepted > ${quote(marker)}\nexec ${quote(process.execPath)} "$@"`);
  executable(join(shimBin, "node"), `printf "%s\\n" ${quote(join(f.metadata, "bin/node"))}`);
  assertAllowed(f.launch(shimBin));
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(f.trustedMarker), true);
});

test("version-manager lookup skips malformed, missing, and protected HOME paths", (t) => {
  const f = fixture(t, { separateGitDir: true, repoName: "repo-é" });
  const shimBin = join(f.root, ".asdf/shims");
  const marker = join(f.root, "shim-ran");
  executable(join(shimBin, "node"), `printf consulted > ${quote(marker)}\nprintf "%s\\n" ${quote(process.execPath)}`);
  const homes = ["", "relative-home", join(f.root, "missing"), join(f.repo, "readme.txt"), f.repo, f.plugin, f.metadata];
  for (const path of [join(f.root, "REPO-É"), join(f.root, "repo-e\u0301"), join(f.root, "PLUGIN"), join(f.root, "METADATA")]) {
    if (existsSync(path)) homes.push(path);
  }
  for (const HOME of homes) {
    assertAllowed(f.launch(shimBin, { HOME }));
    assert.equal(existsSync(marker), false, `unsafe HOME: ${HOME}`);
  }
  assert.equal(existsSync(f.trustedMarker), true);
});
