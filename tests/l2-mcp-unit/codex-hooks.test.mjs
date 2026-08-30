import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import {
  MAX_COMMAND_BYTES,
  REPO_RESOLUTION_TIMEOUT_MS,
  TMB_TOOL_NAMES,
  evaluatePreToolUse,
  parsePatchTargets,
  resolveRepoContext,
} from "../../adapters/codex/hooks/repo-policy.mjs";

let fixtureRoot;
let primary;
let linked;
let detached;
let outside;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..");
const DISPATCHER_PATH = join(REPO_ROOT, "adapters", "codex", "hooks", "dispatcher.mjs");
const POLICY_PATH = join(REPO_ROOT, "adapters", "codex", "hooks", "repo-policy.mjs");
const WORKER_POLICY_BRIDGE = `
import { parentPort, workerData } from "node:worker_threads";
if (workerData?.mode === "evaluate-pre-tool-use") {
  parentPort?.postMessage(await evaluatePreToolUse(workerData.input, workerData.options));
}
`;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "TMB Test",
      GIT_AUTHOR_EMAIL: "tmb-test@example.invalid",
      GIT_COMMITTER_NAME: "TMB Test",
      GIT_COMMITTER_EMAIL: "tmb-test@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repoAttestation(cwd) {
  const [root, gitDir, commonDir] = git(cwd,
    "rev-parse",
    "--show-toplevel",
    "--absolute-git-dir",
    "--path-format=absolute",
    "--git-common-dir").split("\n");
  return { root, gitDir, commonDir };
}

function repoAttestationEnv(cwd) {
  const { root, gitDir, commonDir } = repoAttestation(cwd);
  return {
    TMB_CODEX_HOOK_ROOT: root,
    TMB_CODEX_HOOK_GIT_DIR: gitDir,
    TMB_CODEX_HOOK_COMMON_DIR: commonDir,
  };
}

function payload(cwd, toolName, toolInput, extra = {}) {
  return {
    cwd,
    hook_event_name: "PreToolUse",
    model: "gpt-test",
    permission_mode: "default",
    session_id: "session-test",
    tool_input: toolInput,
    tool_name: toolName,
    tool_use_id: "tool-test",
    transcript_path: null,
    turn_id: "turn-test",
    ...extra,
  };
}

async function decision(cwd, toolName, toolInput, extra = {}) {
  return evaluatePreToolUse(payload(cwd, toolName, toolInput, extra), {
    pluginRoot: join(fixtureRoot, "plugin-cache"),
    pluginData: join(fixtureRoot, "plugin-data"),
  });
}

function patch(...lines) {
  return { command: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") };
}

function runtimeDigest() {
  return createHash("sha256")
    .update(readFileSync(DISPATCHER_PATH))
    .update("\0")
    .update(readFileSync(POLICY_PATH))
    .digest("hex");
}

function dispatch(input, digest = runtimeDigest(), extraEnv = {}) {
  return spawnSync(process.execPath, [DISPATCHER_PATH, "--policy-sha256", digest], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    input: typeof input === "string" ? input : JSON.stringify(input),
    maxBuffer: 12 * 1024 * 1024,
    timeout: 5_000,
  });
}

function dispatchWithPolicySource(name, policySource, extraEnv = {}) {
  const runtime = join(fixtureRoot, `${name}-runtime`);
  mkdirSync(runtime);
  const dispatcher = join(runtime, "dispatcher.mjs");
  const policy = join(runtime, "repo-policy.mjs");
  copyFileSync(DISPATCHER_PATH, dispatcher);
  writeFileSync(policy, `${policySource}${WORKER_POLICY_BRIDGE}`);
  const digest = createHash("sha256")
    .update(readFileSync(dispatcher))
    .update("\0")
    .update(readFileSync(policy))
    .digest("hex");
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [dispatcher, "--policy-sha256", digest], {
    cwd: primary,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    input: JSON.stringify(payload(primary, "Read", {})),
    timeout: 5_000,
  });
  return {
    elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    output: result.stdout === "" ? null : JSON.parse(result.stdout),
    result,
  };
}

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "tmb-codex-hooks-unit-"));
  primary = join(fixtureRoot, "repo");
  linked = join(fixtureRoot, "linked");
  detached = join(fixtureRoot, "detached");
  outside = join(fixtureRoot, "outside");

  mkdirSync(primary);
  mkdirSync(outside);
  mkdirSync(join(fixtureRoot, "plugin-cache"));
  mkdirSync(join(fixtureRoot, "plugin-data"));
  git(primary, "init", "-q", "-b", "main");
  mkdirSync(join(primary, "src"));
  writeFileSync(join(primary, "src", "tracked.txt"), "seed\n");
  writeFileSync(join(primary, "package.json"), "{}\n");
  git(primary, "add", "src/tracked.txt", "package.json");
  git(primary, "commit", "-q", "-m", "seed");
  git(primary, "worktree", "add", "-q", "-b", "feat/phase5-test", linked);
  git(primary, "worktree", "add", "-q", "--detach", detached, "HEAD");
  symlinkSync(outside, join(linked, "escape-link"));
});

after(() => {
  if (fixtureRoot?.startsWith(join(tmpdir(), "tmb-codex-hooks-unit-"))) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("resolves primary, linked, detached, and non-repository contexts", () => {
  assert.equal(resolveRepoContext(primary).kind, "primary");
  assert.equal(resolveRepoContext(join(linked, "src")).kind, "linked");
  assert.equal(resolveRepoContext(detached).kind, "detached");
  assert.equal(resolveRepoContext(outside).kind, "outside");
});

test("validated repository attestation avoids a second Git query", () => {
  const rejectGit = () => {
    throw new Error("attested resolution must not invoke Git");
  };
  assert.equal(resolveRepoContext(primary, {
    gitRunner: rejectGit,
    repoAttestation: repoAttestation(primary),
  }).kind, "primary");
  assert.equal(resolveRepoContext(join(linked, "src"), {
    gitRunner: rejectGit,
    repoAttestation: repoAttestation(linked),
  }).kind, "linked");
});

test("repository attestation fails closed when its root or common directory is inconsistent", () => {
  const attestation = repoAttestation(primary);
  assert.equal(resolveRepoContext(primary, {
    repoAttestation: { ...attestation, root: outside },
  }).kind, "outside");
  assert.equal(resolveRepoContext(primary, {
    repoAttestation: { ...attestation, commonDir: outside },
  }).kind, "outside");
});

test("repository classification ignores inherited Git routing variables", () => {
  const originalGitDir = process.env.GIT_DIR;
  const originalGitWorkTree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = join(primary, ".git");
    process.env.GIT_WORK_TREE = "/";
    const context = resolveRepoContext(primary);
    assert.equal(context.kind, "primary");
    assert.equal(context.root, realpathSync(primary));
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
    if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = originalGitWorkTree;
  }
});

test("repository classification uses one bounded Git query", () => {
  let calls = 0;
  const slowGit = (cwd, args, timeout) => {
    calls += 1;
    execFileSync("/bin/sleep", ["0.48"], { stdio: "ignore", timeout });
    return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  };
  const started = process.hrtime.bigint();
  assert.equal(resolveRepoContext(primary, { gitRunner: slowGit }).kind, "primary");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  assert.equal(calls, 1);
  assert.ok(elapsedMs < REPO_RESOLUTION_TIMEOUT_MS + 200, `resolution took ${elapsedMs.toFixed(1)}ms`);
});

test("primary checkout allows reviewed non-writing tool surfaces", async () => {
  for (const [toolName, toolInput] of [
    ["Read", { file_path: "src/tracked.txt" }],
    ["read_file", { path: "src/tracked.txt" }],
    ["view_image", { path: "diagram.png" }],
    ["update_plan", { plan: [] }],
  ]) {
    const result = await decision(primary, toolName, toolInput);
    assert.equal(result.decision, "allow", `${toolName}: ${result.reason ?? ""}`);
  }
});

test("primary checkout allows only audited TMB MCP surfaces", async () => {
  assert.equal(TMB_TOOL_NAMES.length, 15);
  for (const toolName of [
    "mcp__trajectory_server__agent_materialization_get",
    "mcp__plugin_tmb_trajectory-server__planning_issue_list",
    "mcp__plugin_tmb_trajectory_server__agent_materialization_get",
  ]) {
    const allowed = await decision(primary, toolName, { project_root: primary, status: "open" });
    assert.equal(allowed.decision, "allow", toolName);
  }

  const unknown = await decision(primary, "mcp__other__write_everything", {});
  assert.equal(unknown.decision, "deny");

  for (const spoofed of [
    "mcp__evil_trajectory-server__planning_issue_list",
    "mcp__evil_trajectory_server__agent_materialization_get",
    "MCP__TRAJECTORY_SERVER__AGENT_MATERIALIZATION_GET",
    "evil.read",
    "evil.apply_patch",
    "evil.exec_command",
  ]) {
    const result = await decision(primary, spoofed, { command: "pwd" });
    assert.equal(result.decision, "deny", spoofed);
  }

  assert.equal((await decision(
    primary,
    "mcp__plugin_tmb_trajectory-server__planning_issue_list",
    { project_root: linked },
  )).decision, "deny");
  assert.equal((await decision(
    outside,
    "mcp__plugin_tmb_trajectory-server__planning_issue_list",
    { project_root: primary },
  )).decision, "deny");

  const nestedCwd = join(primary, "src");
  assert.equal((await decision(
    nestedCwd,
    "mcp__trajectory_server__agent_materialization_get",
    { project_root: primary },
  )).decision, "allow");

  const projectCodexDir = join(primary, ".codex");
  mkdirSync(projectCodexDir);
  writeFileSync(
    join(projectCodexDir, "config.toml"),
    '[mcp_servers."trajectory-server"]\ncommand = "malicious-shadow"\n',
  );
  try {
    const shadowed = await decision(
      nestedCwd,
      "mcp__trajectory_server__agent_materialization_get",
      { project_root: primary },
    );
    assert.equal(shadowed.decision, "deny");
    assert.match(shadowed.reason, /project-local Codex configuration/u);
  } finally {
    rmSync(projectCodexDir, { recursive: true, force: true });
  }

  const nestedCodexDir = join(nestedCwd, ".codex");
  mkdirSync(nestedCodexDir);
  writeFileSync(join(nestedCodexDir, "config.toml"), "[mcp_servers.shadow]\ncommand = \"shadow\"\n");
  try {
    assert.equal((await decision(
      nestedCwd,
      "mcp__trajectory_server__agent_materialization_get",
      { project_root: primary },
    )).decision, "deny");
  } finally {
    rmSync(nestedCodexDir, { recursive: true, force: true });
  }
});

test("primary checkout allows reviewed read-only shell commands", async () => {
  for (const command of [
    "pwd",
    "ls -la src",
    "rg --no-config -n seed src",
    "cat src/tracked.txt",
    "head -n 1 src/tracked.txt",
    "tail -n 1 src/tracked.txt",
    "wc -l src/tracked.txt",
    "stat src/tracked.txt",
    "file src/tracked.txt",
    "realpath src/tracked.txt",
    "readlink src/tracked.txt",
    "dirname src/tracked.txt",
    "basename src/tracked.txt",
    "du src",
    "jq . package.json",
    "test -f src/tracked.txt",
    "true",
    "false",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null status --short",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv -- src/tracked.txt",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null log --no-ext-diff --no-textconv -1 --oneline",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null show --no-ext-diff --no-textconv --stat HEAD",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null rev-parse --show-toplevel",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null ls-files",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null ls-tree HEAD",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null worktree list --porcelain",
  ]) {
    const result = await decision(primary, "Bash", { command });
    assert.equal(result.decision, "allow", `${command}: ${result.reason ?? ""}`);
  }

  for (const command of [
    "/tmp/ls",
    "./git status",
    "src/cat src/tracked.txt",
    "wc -l",
    "stat -f src/tracked.txt",
    "du -a",
    "rg -n seed src",
  ]) {
    assert.equal((await decision(primary, "Bash", { command })).decision, "deny", command);
  }
});

test("reviewed ripgrep reads disable environment-provided helper configuration", async () => {
  const configPath = join(outside, "ripgrep.conf");
  writeFileSync(configPath, "--pre=/path/that/must/not/run\n");
  const originalConfig = process.env.RIPGREP_CONFIG_PATH;
  try {
    process.env.RIPGREP_CONFIG_PATH = configPath;
    assert.equal(
      (await decision(primary, "Bash", { command: "rg -n seed src" })).decision,
      "deny",
    );
    assert.equal(
      (await decision(primary, "Bash", { command: "rg --no-config -n seed src" })).decision,
      "allow",
    );
  } finally {
    if (originalConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = originalConfig;
  }
});

test("reviewed forge queries have positive coverage for every allowed action", async () => {
  const trustedBin = join(fixtureRoot, "trusted-forge-bin");
  mkdirSync(trustedBin);
  for (const program of ["gh", "glab"]) {
    writeFileSync(join(trustedBin, program), "#!/bin/sh\nexit 0\n");
    chmodSync(join(trustedBin, program), 0o755);
  }

  const originalHostPath = process.env.TMB_CODEX_HOOK_HOST_PATH;
  try {
    process.env.TMB_CODEX_HOOK_HOST_PATH = `${trustedBin}:/usr/bin:/bin`;
    const commands = ["gh auth status", "glab auth status"];
    for (const group of ["issue", "pr", "release", "repo", "run", "workflow"]) {
      for (const action of ["list", "view", "status", "diff", "checks"]) {
        commands.push(`gh ${group} ${action}`);
      }
    }
    for (const group of ["issue", "mr", "release", "repo", "ci"]) {
      for (const action of ["list", "view", "status", "diff"]) {
        commands.push(`glab ${group} ${action}`);
      }
    }
    for (const command of commands) {
      const result = await decision(primary, "Bash", { command });
      assert.equal(result.decision, "allow", `${command}: ${result.reason ?? ""}`);
    }
  } finally {
    if (originalHostPath === undefined) delete process.env.TMB_CODEX_HOOK_HOST_PATH;
    else process.env.TMB_CODEX_HOOK_HOST_PATH = originalHostPath;
  }
});

test("Hook-internal Git and reviewed shell commands cannot resolve to repository PATH shims", async () => {
  const shadowBin = join(primary, "shadow-bin");
  const internalGitMarker = join(primary, "internal-git-ran");
  mkdirSync(shadowBin);
  writeFileSync(
    join(shadowBin, "git"),
    `#!/bin/sh\n/usr/bin/touch ${internalGitMarker}\nexec /usr/bin/git "$@"\n`,
  );
  writeFileSync(join(shadowBin, "cat"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(shadowBin, "git"), 0o755);
  chmodSync(join(shadowBin, "cat"), 0o755);

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${shadowBin}:${originalPath}`;
    const result = await decision(primary, "Bash", { command: "cat src/tracked.txt" });
    assert.equal(result.decision, "deny");
    assert.equal(existsSync(internalGitMarker), false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("linked validation entrypoints use a narrow command and action table", async () => {
  const trustedBin = join(fixtureRoot, "trusted-validation-bin");
  const nested = join(linked, "nested-validation-cwd");
  mkdirSync(trustedBin);
  mkdirSync(nested);
  symlinkSync(outside, join(nested, "nested-escape"));
  for (const program of ["bun", "cargo", "go", "node", "npm", "pnpm", "pytest"]) {
    writeFileSync(join(trustedBin, program), "#!/bin/sh\nexit 0\n");
    chmodSync(join(trustedBin, program), 0o755);
  }
  const allowed = [
    "bash tests/run-all.sh",
    "node --test tests/l2-mcp-unit/codex-hooks.test.mjs",
    "node --experimental-sqlite --test mcp/trajectory-server/dist/test/codex-installed-cache.test.js",
    "bun test",
    "bun run test",
    "bun --bun run build",
    "npm test",
    "npm run lint",
    "pnpm test",
    "pnpm --silent run typecheck",
    "pytest -q",
    "cargo test",
    "cargo check",
    "go test ./...",
  ];
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${trustedBin}:${originalPath}`;
    for (const command of allowed) {
      const result = await decision(linked, "Bash", { command });
      assert.equal(result.decision, "allow", `${command}: ${result.reason ?? ""}`);
    }
    for (const command of [
      "bash tests/run-all.sh",
      "npm test",
      "node --test nested-escape/outside.test.mjs",
      "pytest nested-escape/test_payload.py",
      "go test ./nested-escape/...",
    ]) {
      const result = await decision(nested, "Bash", { command });
      assert.equal(result.decision, "deny", `nested cwd: ${command}`);
    }
  } finally {
    process.env.PATH = originalPath;
  }

  for (const command of [
    "bash scripts/other.sh",
    "bash tests/run-all.sh extra",
    "node --inspect --test tests/l2-mcp-unit/codex-hooks.test.mjs",
    "node --test --watch tests/l2-mcp-unit/codex-hooks.test.mjs",
    "node --test /tmp/outside.test.mjs",
    "node --test ../outside.test.mjs",
    "node --test file:///tmp/outside.test.mjs",
    "node --test escape-link/outside.test.mjs",
    "node --test --import=./tests/helper.mjs tests/l2-mcp-unit/codex-hooks.test.mjs",
    "node --experimental-sqlite --test --import=./tests/helper.mjs",
    "bun test --watch",
    "bun test --preload ./tests/helper.mjs",
    "bun --cwd /tmp/outside test",
    "npm test -- --watch",
    "npm test --prefix=/tmp/outside",
    "npm run lint --prefix=/tmp/outside",
    "pnpm --dir /tmp/outside test",
    "pytest --pdb",
    "pytest --rootdir=/tmp/outside /tmp/outside/test_payload.py",
    "pytest @/tmp/outside.args",
    "pytest escape-link/test_payload.py",
    "bun run publish",
    "npm run release",
    "pnpm exec test",
    "cargo run",
    "cargo test --manifest-path=/tmp/outside/Cargo.toml",
    "go run ./cmd/server",
    "go test all",
    "go test std",
    "go test example.com/acme/pkg",
    "go test /tmp/outside/...",
    "go test escape-link/...",
  ]) {
    const result = await decision(linked, "Bash", { command });
    assert.equal(result.decision, "deny", command);
  }
});

test("primary checkout denies every known source-write alternative", async () => {
  const commands = [
    "sed -i '' 's/seed/changed/' src/tracked.txt",
    "perl -pi -e 's/seed/changed/' src/tracked.txt",
    "tee src/tracked.txt",
    "cp /tmp/input src/tracked.txt",
    "mv /tmp/input src/tracked.txt",
    "rm src/tracked.txt",
    "dd if=/dev/null of=src/tracked.txt",
    "printf changed > src/tracked.txt",
    "printf changed >> src/tracked.txt",
    "cat <<EOF > src/tracked.txt",
    "cat <<< changed",
    "cat /tmp/input | tee src/tracked.txt",
    "pwd && touch src/new.txt",
    "python -c 'open(\"src/tracked.txt\", \"w\").write(\"x\")'",
    "node -e 'require(\"fs\").writeFileSync(\"src/tracked.txt\",\"x\")'",
    "ruby -e 'File.write(\"src/tracked.txt\", \"x\")'",
    "perl -e 'open(F, q(>), q(src/tracked.txt))'",
    "bash -c 'touch src/new.txt'",
    "sh -c 'touch src/new.txt'",
    "eval 'touch src/new.txt'",
    "./scripts/write-source.sh",
    "bun test",
    "npm test",
    "pnpm test",
  ];

  for (const command of commands) {
    const result = await decision(primary, "Bash", { command });
    assert.equal(result.decision, "deny", command);
  }
});

test("reviewed read commands reject executable and write-capable flags", async () => {
  for (const command of [
    "rg --pre cat seed src",
    "rg --pre-glob '*.txt' seed src",
    "rg --search-zip seed src",
    "rg -z seed src",
    "rg --hostname-bin=./scripts/write-source.sh '--hyperlink-format=file://{host}{path}' seed src",
    "cat",
    "head -n 1",
    "tail -f src/tracked.txt",
    "tail --follow=name src/tracked.txt",
    "wc",
    "jq .",
    "cat /dev/zero",
    "head -n 1 /dev/zero",
    "wc /dev/zero",
    "jq . /dev/zero",
    "gh pr checks --watch",
    "gh pr view --web",
    "gh pr checks -wRowner/repo",
    "gh repo view -wRowner/repo",
    "glab mr view -wRowner/repo",
    "gh auth status --show-token",
    "gh auth status -t",
    "glab auth status --show-token",
    "git --no-pager --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null status --short",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null status --help",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null status -h",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null branch --list",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv --output=changed.patch",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv --ext-diff",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null show --no-ext-diff --no-textconv --textconv HEAD:src/tracked.txt",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null log --no-ext-diff --no-textconv --exec=touch",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null status --config-env=core.fsmonitor:TMB_GIT_CONFIG",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv --recurse-submodules",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null log --no-ext-diff --no-textconv --show-signature -1",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null log --no-ext-diff --no-textconv '--format=%G?' -1",
  ]) {
    const result = await decision(primary, "Bash", { command });
    assert.equal(result.decision, "deny", command);
  }
});

test("shell parsing rejects values that Bash would expand after the Hook decision", async () => {
  for (const command of [
    `pwd\u00a0`,
    `pwd\u2003`,
    "rg seed $TMB_SEARCH_ROOT",
    "rg seed ${TMB_SEARCH_ROOT}",
    "rg seed src/*",
    "rg seed src/file?.txt",
    "rg seed src/[a-z].txt",
    "rg seed src/{a,b}.txt",
    "rg seed src/^generated",
    "rg seed !history",
    "rg seed ~/src",
    "rg seed src # trailing shell comment",
    "git --no-pager --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null status $TMB_GIT_ARGS",
    "git --no-pager --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null show --no-ext-diff --no-textconv --out\\" + "\n" + "put=/tmp/changed.patch HEAD:README.md",
  ]) {
    const result = await decision(primary, "Bash", { command });
    assert.equal(result.decision, "deny", command);
  }
});

test("all checkout types deny Git and forge mutations", async () => {
  for (const cwd of [primary, linked]) {
    for (const command of [
      "git add src/tracked.txt",
      "git commit -m changed",
      "git merge other",
      "git rebase main",
      "git reset --hard HEAD",
      "git checkout -- src/tracked.txt",
      "git switch main",
      "git push origin HEAD",
      "git branch changed",
      "git tag changed",
      "git update-ref refs/heads/changed HEAD",
      "git remote add other /tmp/other",
      "git submodule add /tmp/other vendor/other",
      "git worktree add ../other",
      "git -C . add src/tracked.txt",
      "gh issue create --title changed",
      "gh pr merge 1",
      "glab mr create",
    ]) {
      const result = await decision(cwd, "Bash", { command });
      assert.equal(result.decision, "deny", `${cwd}: ${command}`);
    }
  }
});

test("persistent command receivers are denied and lifecycle stdin is bounded", async () => {
  for (const command of [
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
    "ssh host.example",
    "sqlite3 .tmb/tmb.db",
    "psql",
    "mysql",
  ]) {
    const result = await decision(linked, "Bash", { command });
    assert.equal(result.decision, "deny", command);
  }

  for (const toolInput of [
    { session_id: 42 },
    { session_id: 42, chars: "" },
    { session_id: 42, chars: "\u0003" },
    { session_id: 42, chars: "", yield_time_ms: 5_000, max_output_tokens: 2_000 },
  ]) {
    assert.equal((await decision(linked, "write_stdin", toolInput)).decision, "allow", JSON.stringify(toolInput));
  }
  for (const toolInput of [
    { session_id: 42, chars: "git push\n" },
    { session_id: 42, chars: "\u0003\n" },
    { session_id: "42", chars: "" },
    { session_id: 42, chars: "", unexpected: true },
  ]) {
    assert.equal((await decision(linked, "write_stdin", toolInput)).decision, "deny", JSON.stringify(toolInput));
  }
});

test("audited orchestration, diagnostics, and TMB uninstall recovery remain reachable", async () => {
  for (const cwd of [primary, linked]) {
    for (const [toolName, toolInput] of [
      ["functions.exec", 'text(JSON.stringify(await tools.exec_command({"cmd":"pwd","login":false})));'],
      ["functions.wait", { cell_id: "cell-1", yield_time_ms: 1_000, max_tokens: 2_000 }],
      ["mcp__codex_app__read_thread_terminal", {}],
      ["mcp__codex_app__read_thread", { threadId: "thread-1" }],
      ["mcp__codex_app__uninstall_plugin", { plugin: "tmb@trustmybot-local" }],
    ]) {
      const result = await decision(cwd, toolName, toolInput);
      assert.equal(result.decision, "allow", `${cwd}: ${toolName}`);
    }
  }

  for (const toolInput of [
    {},
    { plugin: "another-plugin" },
    { plugin: "tmb@trustmybot-local", unexpected: true },
  ]) {
    assert.equal(
      (await decision(primary, "mcp__codex_app__uninstall_plugin", toolInput)).decision,
      "deny",
      JSON.stringify(toolInput),
    );
  }

  for (const [label, source] of [
    ["nested write", 'text(JSON.stringify(await tools.exec_command({"cmd":"touch blocked","login":false})));'],
    ["nested Git write", 'text(JSON.stringify(await tools.exec_command({"cmd":"git push origin HEAD","login":false})));'],
    ["login shell default", 'text(JSON.stringify(await tools.exec_command({"cmd":"pwd"})));'],
    ["dynamic tool lookup", 'const name = "exec_command"; text(JSON.stringify(await tools[name]({"cmd":"pwd","login":false})));'],
    ["nested lifecycle", 'text(JSON.stringify(await tools.wait({"cell_id":"cell-1"})));'],
    ["unwrapped source", "text(true);"],
  ]) {
    assert.equal(
      (await decision(primary, "functions.exec", source)).decision,
      "deny",
      `functions.exec: ${label}`,
    );
  }

  const nestedPatch = 'text(JSON.stringify(await tools.apply_patch(' + JSON.stringify(`*** Begin Patch
*** Update File: src/tracked.txt
@@
-seed
+changed
*** End Patch`) + ')));';
  assert.equal((await decision(primary, "functions.exec", nestedPatch)).decision, "deny");
  assert.equal((await decision(linked, "functions.exec", nestedPatch)).decision, "allow");

  for (const [label, toolInput] of [
    ["non-string", {}],
    ["oversize", "x".repeat(MAX_COMMAND_BYTES + 1)],
  ]) {
    assert.equal(
      (await decision(primary, "functions.exec", toolInput)).decision,
      "deny",
      `functions.exec: ${label}`,
    );
  }

  for (const toolInput of [
    {},
    { cell_id: "" },
    { cell_id: "cell-1", unexpected: true },
    { cell_id: "cell-1", yield_time_ms: 0 },
    { cell_id: "cell-1", max_tokens: -1 },
    { cell_id: "cell-1", terminate: "true" },
  ]) {
    assert.equal(
      (await decision(primary, "functions.wait", toolInput)).decision,
      "deny",
      JSON.stringify(toolInput),
    );
  }
});

test("Bash accepts only the observed exact command payload shape", async () => {
  for (const toolInput of [
    "pwd",
    ["pwd"],
    { cmd: "pwd" },
    { command: ["pwd"] },
    { command: "pwd", workdir: outside },
    { command: "pwd", env: { TMB: "1" } },
    { command: "pwd", tty: false },
  ]) {
    assert.equal((await decision(primary, "Bash", toolInput)).decision, "deny", JSON.stringify(toolInput));
  }
  for (const alias of ["exec_command", "local_shell", "container.exec", "functions.exec_command", "  Bash  ", "bash"]) {
    assert.equal((await decision(primary, alias, { command: "pwd" })).decision, "deny", alias);
  }
});

test("direct write tools and executable code-mode surfaces are denied", async () => {
  for (const cwd of [primary, linked]) {
    for (const toolName of ["Edit", "Write", "MultiEdit", "NotebookEdit", "code_mode", "js_repl", "javascript_repl"]) {
      const result = await decision(cwd, toolName, { file_path: "src/tracked.txt" });
      assert.equal(result.decision, "deny", `${cwd}: ${toolName}`);
    }
  }
});

test("observed Codex collaboration spawn surface is denied until child inheritance is proved", async () => {
  const result = await decision(primary, "collaborationspawn_agent", {
    task_name: "test",
    message: "run pwd",
  });
  assert.equal(result.decision, "deny");
  assert.match(result.reason, /inheritance has not been qualified/u);
});

test("primary apply_patch is denied", async () => {
  const result = await decision(
    primary,
    "apply_patch",
    patch("*** Update File: src/tracked.txt", "@@", "-seed", "+changed"),
  );
  assert.equal(result.decision, "deny");
});

test("linked worktree apply_patch allows canonical in-root targets", async () => {
  const result = await decision(
    linked,
    "apply_patch",
    patch(
      "*** Update File: src/tracked.txt",
      "@@",
      "-seed",
      "+changed",
      "*** Add File: src/new.txt",
      "+new",
    ),
  );
  assert.deepEqual(result, { decision: "allow" });
});

test("linked apply_patch resolves targets from the Hook cwd", async () => {
  const nested = join(linked, "nested");
  const nestedEscape = join(nested, "escape-link");
  const protectedCwd = join(linked, ".tmb");
  mkdirSync(nested);
  mkdirSync(protectedCwd);
  symlinkSync(outside, nestedEscape);

  assert.equal((await decision(
    nested,
    "apply_patch",
    patch("*** Add File: local.txt", "+local"),
  )).decision, "allow");
  assert.equal((await decision(
    nested,
    "apply_patch",
    patch("*** Add File: escape-link/changed", "+changed"),
  )).decision, "deny");
  assert.equal((await decision(
    protectedCwd,
    "apply_patch",
    patch("*** Add File: changed", "+changed"),
  )).decision, "deny");
});

test("linked apply_patch denies protected, outside, linked, absolute, and rename targets", async () => {
  const outsideHardLink = join(outside, "hard-linked.txt");
  const linkedHardLink = join(linked, "src", "hard-linked.txt");
  const existingDirectory = join(linked, "src", "existing-directory");
  const existingFifo = join(linked, "src", "existing-fifo");
  const nonDirectoryAncestor = join(linked, "src", "non-directory-ancestor");
  writeFileSync(outsideHardLink, "outside\n");
  linkSync(outsideHardLink, linkedHardLink);
  mkdirSync(existingDirectory);
  execFileSync("mkfifo", [existingFifo]);
  writeFileSync(nonDirectoryAncestor, "not a directory\n");
  const cases = [
    patch("*** Update File: .git/config", "@@", "-a", "+b"),
    patch("*** Add File: .tmb/changed", "+x"),
    patch("*** Add File: .claude/changed", "+x"),
    patch("*** Add File: .codex/config.toml", "+x"),
    patch("*** Add File: .codex/hooks.json", "+x"),
    patch("*** Add File: .TMB/changed", "+x"),
    patch("*** Add File: .CLAUDE/changed", "+x"),
    patch("*** Add File: .CODEX/Hooks.json", "+x"),
    patch("*** Add File: .codex/agents/tmb_swe.toml", "+x"),
    patch("*** Add File: ../outside/changed", "+x"),
    patch(`*** Add File: ${join(outside, "changed")}`, "+x"),
    patch("*** Add File: escape-link/changed", "+x"),
    patch("*** Update File: src/hard-linked.txt", "@@", "-outside", "+changed"),
    patch("*** Update File: src/existing-directory", "@@", "-outside", "+changed"),
    patch("*** Update File: src/existing-fifo", "@@", "-outside", "+changed"),
    patch("*** Add File: src/non-directory-ancestor/child.txt", "+changed"),
    patch("*** Update File: src/tracked.txt", "*** Move to: ../outside/moved.txt", "@@", "-seed", "+changed"),
  ];

  for (const candidate of cases) {
    const result = await decision(linked, "apply_patch", candidate);
    assert.equal(result.decision, "deny", JSON.stringify(candidate));
  }
});

test("detached linked worktree and unparseable patches fail closed", async () => {
  const candidate = patch("*** Add File: src/new.txt", "+x");
  assert.equal((await decision(detached, "apply_patch", candidate)).decision, "deny");
  assert.equal((await decision(linked, "apply_patch", { command: "not a patch" })).decision, "deny");
  assert.equal((await decision(outside, "apply_patch", candidate)).decision, "deny");
});

test("patch parser returns every source and move target", () => {
  assert.deepEqual(
    parsePatchTargets(
      patch(
        "*** Add File: src/new.txt",
        "+new",
        "*** Update File: src/old.txt",
        "*** Move to: src/moved.txt",
        "@@",
        "-old",
        "+new",
        "*** Delete File: src/delete.txt",
      ).command,
    ),
    ["src/new.txt", "src/old.txt", "src/moved.txt", "src/delete.txt"],
  );
});

test("unknown payloads, oversized commands, and bypassPermissions fail closed", async () => {
  assert.equal((await evaluatePreToolUse(null)).decision, "deny");
  for (const [mutation, reason] of [
    [{ hook_event_name: "PostToolUse" }, /unexpected hook event/u],
    [{ tool_name: undefined }, /tool name is missing/u],
    [{ tool_name: "   " }, /tool name is missing/u],
    [{ cwd: undefined }, /working directory is missing/u],
    [{ permission_mode: "future-mode" }, /permission mode is unknown/u],
  ]) {
    const result = await evaluatePreToolUse({
      ...payload(primary, "Read", { file_path: "src/tracked.txt" }),
      ...mutation,
    });
    assert.equal(result.decision, "deny");
    assert.match(result.reason, reason);
  }
  assert.equal((await decision(primary, "unknown_tool", {})).decision, "deny");
  assert.equal((await decision(primary, "Bash", {})).decision, "deny");
  assert.equal(
    (await decision(primary, "Bash", { command: "x".repeat(MAX_COMMAND_BYTES + 1) })).decision,
    "deny",
  );
  assert.equal(
    (await decision(primary, "Bash", { command: "touch src/bypass" }, { permission_mode: "bypassPermissions" })).decision,
    "deny",
  );
});

test("dispatcher is silent on allow and emits stable deny JSON", () => {
  const allowed = dispatch(payload(primary, "Read", { file_path: "src/tracked.txt" }));
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "");

  const blocked = dispatch(payload(primary, "Bash", { command: "touch src/blocked" }));
  assert.equal(blocked.status, 0, blocked.stderr);
  const output = JSON.parse(blocked.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /^TMB-CODEX-HOOK:/u);
});

test("dispatcher handles complete, incomplete, and mismatched repository attestation", () => {
  const allowed = dispatch(payload(primary, "Read", {}), runtimeDigest(), repoAttestationEnv(primary));
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "");

  const incomplete = dispatch(payload(primary, "Read", {}), runtimeDigest(), {
    TMB_CODEX_HOOK_ROOT: primary,
    TMB_CODEX_HOOK_GIT_DIR: "",
    TMB_CODEX_HOOK_COMMON_DIR: "",
  });
  assert.equal(incomplete.status, 0, incomplete.stderr);
  assert.equal(incomplete.stdout, "");

  const mismatched = dispatch(payload(primary, "Read", {}), runtimeDigest(), repoAttestationEnv(linked));
  assert.equal(mismatched.status, 0, mismatched.stderr);
  assert.equal(mismatched.stdout, "");
});

test("dispatcher uses the inline fast path only for complete repository attestation", () => {
  const policySource = `
import { isMainThread } from "node:worker_threads";
export async function evaluatePreToolUse() {
  return isMainThread
    ? { decision: "allow" }
    : { decision: "deny", reason: "TMB-CODEX-HOOK: worker path selected" };
}
`;
  const inline = dispatchWithPolicySource(
    "deterministic-inline",
    policySource,
    repoAttestationEnv(primary),
  );
  assert.equal(inline.result.status, 0, inline.result.stderr);
  assert.equal(inline.result.stdout, "");

  const worker = dispatchWithPolicySource("deterministic-worker", policySource);
  assert.equal(worker.result.status, 0, worker.result.stderr);
  assert.equal(worker.output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(worker.output.hookSpecificOutput.permissionDecisionReason, /worker path selected/u);
});

test("dispatcher routes a mismatched attestation directly to the supervised worker", () => {
  const policySource = `
import { isMainThread } from "node:worker_threads";
export async function evaluatePreToolUse() {
  return isMainThread
    ? { decision: "deny", reason: "TMB-CODEX-HOOK: mismatched attestation reached inline policy" }
    : { decision: "allow" };
}
`;
  const routed = dispatchWithPolicySource(
    "mismatched-attestation-worker",
    policySource,
    repoAttestationEnv(linked),
  );
  assert.equal(routed.result.status, 0, routed.result.stderr);
  assert.equal(routed.result.stdout, "");
});

test("dispatcher never retries after an attested policy decision", () => {
  const policySource = `
import { isMainThread } from "node:worker_threads";
export async function evaluatePreToolUse() {
  return isMainThread
    ? { decision: "deny", reason: "TMB-CODEX-HOOK: tool call is not attached to a branch-backed Git checkout" }
    : { decision: "allow" };
}
`;
  const { output, result } = dispatchWithPolicySource(
    "no-policy-retry",
    policySource,
    repoAttestationEnv(primary),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /branch-backed Git checkout/u);
});

test("attested inline policy converts process exit into a stable deny", () => {
  const { output, result } = dispatchWithPolicySource(
    "attested-exit",
    "process.exit(0); export async function evaluatePreToolUse() { return { decision: 'allow' }; }\n",
    repoAttestationEnv(primary),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /policy evaluation crashed/u);
});

test("dispatcher fails closed for malformed input and digest mismatch", () => {
  for (const result of [
    dispatch("{not-json"),
    dispatch(payload(primary, "Read", {}), "0".repeat(64)),
  ]) {
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  }
});

test("dispatcher fails closed when the digest argument or policy file is unavailable", () => {
  for (const args of [[], ["--policy-sha256", "bad"]]) {
    const result = spawnSync(process.execPath, [DISPATCHER_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: JSON.stringify(payload(primary, "Read", {})),
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /digest is missing or malformed/u);
  }

  const runtime = join(fixtureRoot, "missing-policy-runtime");
  mkdirSync(runtime);
  const dispatcher = join(runtime, "dispatcher.mjs");
  copyFileSync(DISPATCHER_PATH, dispatcher);
  const result = spawnSync(process.execPath, [dispatcher, "--policy-sha256", "0".repeat(64)], {
    cwd: primary,
    encoding: "utf8",
    input: JSON.stringify(payload(primary, "Read", {})),
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /policy files cannot be read/u);
});

test("dispatcher denies stdin beyond 8 MiB without crashing", () => {
  const result = dispatch("x".repeat(8 * 1024 * 1024 + 1));
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /8 MiB/u);
});

test("dispatcher supervisor converts a policy import crash into deny", () => {
  const { output, result } = dispatchWithPolicySource("crash", "this is not valid JavaScript\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /worker crashed/u);
});

test("dispatcher supervisor denies a hung policy before the host timeout", () => {
  const { elapsedMs, output, result } = dispatchWithPolicySource(
    "hung",
    "export async function evaluatePreToolUse() { await new Promise(() => { setInterval(() => {}, 1000); }); }\n",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /internal timeout/u);
  assert.ok(elapsedMs < 4_500, `supervisor took ${elapsedMs.toFixed(1)}ms`);
});

test("dispatcher rejects policies that return no auditable decision", () => {
  const { output, result } = dispatchWithPolicySource(
    "no-decision",
    "export async function evaluatePreToolUse() { return {}; }\n",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /no auditable decision/u);
});

test("dispatcher rejects a worker that exits cleanly without a decision", () => {
  const { output, result } = dispatchWithPolicySource(
    "clean-exit",
    "process.exit(0); export async function evaluatePreToolUse() { return { decision: 'allow' }; }\n",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /exited without a decision/u);
});
