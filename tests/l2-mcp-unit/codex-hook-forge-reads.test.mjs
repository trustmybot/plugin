import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { RUNTIME_RELATIVE_PATHS } from "../../adapters/codex/hooks/dispatcher.mjs";
import { classifyRestrictedCommand, evaluatePreToolUse, forgeReadFailureReason, FORGE_TARGET_ENV_NAMES, makeRestrictedCommand, resolveRepoContext } from "../../adapters/codex/hooks/repo-policy.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let fixture;
let checkout;
let trustedBin;
let marker;
let originalHostPath;
let originalTargetEnvironment;
let pluginRoot;

before(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "tmb-codex-forge-reads-")));
  checkout = join(fixture, "repo");
  trustedBin = join(fixture, "trusted-bin");
  marker = join(fixture, "forge-executed");
  pluginRoot = join(fixture, "plugin-cache");
  mkdirSync(checkout);
  mkdirSync(trustedBin);
  for (const path of [...RUNTIME_RELATIVE_PATHS, "hooks/codex/hooks.json", ".codex-plugin/plugin.json"]) {
    const destination = join(pluginRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(REPO_ROOT, path), destination);
  }
  execFileSync("/usr/bin/git", ["init", "-q", "-b", "main"], { cwd: checkout });
  for (const program of ["gh", "glab"]) {
    writeFileSync(join(trustedBin, program), `#!/bin/sh\nprintf executed > '${marker}'\n`);
    chmodSync(join(trustedBin, program), 0o755);
  }
  originalHostPath = process.env.TMB_CODEX_HOOK_HOST_PATH;
  originalTargetEnvironment = new Map([...FORGE_TARGET_ENV_NAMES, "TMB_CODEX_HOOK_FORGE_TARGET_ENV"]
    .map((name) => [name, process.env[name]]));
  for (const name of originalTargetEnvironment.keys()) delete process.env[name];
  process.env.TMB_CODEX_HOOK_HOST_PATH = `${trustedBin}:/usr/bin:/bin`;
});

after(() => {
  if (originalHostPath === undefined) delete process.env.TMB_CODEX_HOOK_HOST_PATH;
  else process.env.TMB_CODEX_HOOK_HOST_PATH = originalHostPath;
  for (const [name, value] of originalTargetEnvironment ?? []) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

async function decision(command) {
  const rawRead = command === "pwd";
  const cmd = rawRead ? command : makeRestrictedCommand(command, checkout, { pluginRoot });
  return evaluatePreToolUse({
    cwd: checkout, hook_event_name: "PreToolUse", permission_mode: "default",
    tool_name: rawRead ? "Bash" : "functions.exec",
    tool_input: rawRead ? { command } : `text(JSON.stringify(await tools.exec_command(${JSON.stringify({
      cmd, workdir: checkout, shell: "/bin/sh", login: false, tty: false,
    })})));`,
  }, { pluginRoot });
}

async function denied(command) {
  const classification = await classifyRestrictedCommand(command, resolveRepoContext(checkout), { pluginRoot });
  assert.equal(classification.decision, "deny", `classifier: ${command}`);
  const result = await decision(command);
  assert.equal(result.decision, "deny", command);
  return classification;
}

test("current-checkout PR, issue, release, repository, and CI queries remain available", async () => {
  for (const command of [
    "gh auth status", "glab auth status",
    "gh pr list --state all -L20 --label bug --label 'needs review' --author '@me'",
    "gh pr list --base dev --head feature/read --json number,title",
    "gh pr view", "gh pr view 1183 --comments --json number,reviews,comments",
    "gh pr status --conflict-status", "gh pr diff 1183 --color=never --name-only",
    "gh pr checks --required --json name,state", "gh pr checks -- 1183",
    "gh issue list --state=open --milestone 'Release 1' --type Bug",
    "gh issue view 51 -c", "gh issue status --json number,state",
    "gh release list --exclude-drafts --limit 5", "gh release view v1.0.6-rc.1",
    "gh repo view --branch feature/read --json nameWithOwner",
    "gh run list --workflow tests.yml --branch feature/read --status failure -L 5",
    "gh run list -wtests.yml --all", "gh run view 100 --log-failed --exit-status",
    "gh run view --job 123 --log", "gh run view -j123 --verbose",
    "gh workflow list --all", "gh workflow view tests.yml --yaml --ref dev",
    "gh workflow view 'Code Quality' --yaml",
    "glab issue list --all --label bug --search 'repo:other/project' --output=json",
    "glab issue view 51 --comments --output json --per-page 10",
    "glab mr list --author '@me' --source-branch feature/read --target-branch dev -Fjson",
    "glab mr view --comments", "glab mr view 42 --resolved --output=json",
    "glab mr diff 42 --color=never --raw", "glab mr diff",
    "glab release list --per-page 5 --output json", "glab release view v1.0.6-rc.1",
    "glab repo view --branch feature/read --output=json",
    "glab ci list --status=failed --ref feature/read --per-page 5",
    "glab ci status --branch dev --compact",
    "glab ci get --pipeline-id 10 --output json --with-job-details",
    "glab ci get --merge-request 42 --status failed",
  ]) {
    const classification = await classifyRestrictedCommand(command, resolveRepoContext(checkout), { pluginRoot });
    assert.equal(classification.decision, "allow", `${command}: ${classification.reason ?? ""}`);
    assert.equal(classification.mode, "forge", command);
    const result = await decision(command);
    assert.equal(result.decision, process.platform === "darwin" ? "allow" : "deny", `${command}: ${result.reason ?? ""}`);
    if (process.platform !== "darwin") assert.match(result.reason, /qualified macOS sandbox/u);
  }
});

test("repository overrides are rejected in every flag spelling and position", async () => {
  for (const program of ["gh", "glab"]) {
    const group = program === "gh" ? "pr" : "mr";
    for (const override of [
      "-R other/repo", "-Rother/repo", "-R=other/repo", "--repo other/repo",
      "--repo=other/repo", "--repo=github.example/other/repo",
      "--repo=https://forge.example/other/repo", "--repo=git@forge.example:other/repo.git",
      "--rep=other/repo", "--hostname forge.example", "--host=forge.example",
    ]) {
      for (const command of [
        `${program} ${group} view 42 ${override}`,
        `${program} ${group} view ${override} 42`,
        `${program} ${override} ${group} view 42`,
        `${program} ${group} ${override} view 42`,
      ]) await denied(command);
    }
    for (const command of [
      `${program} ${group} view -cRother/repo 42`,
      `${program} ${group} view 42 -- --repo=other/repo`,
      `${program} auth status --hostname forge.example`,
    ]) await denied(command);
  }
});

test("URL and owner/repository selectors cannot bypass the numeric target contract", async () => {
  for (const command of [
    "gh pr view https://github.com/other/repo/pull/42",
    "gh pr diff https://github.com/other/repo/pull/42 --patch",
    "gh pr checks https://github.com/other/repo/pull/42",
    "gh issue view https://github.com/other/repo/issues/42",
    "gh pr view owner/repo", "gh pr view owner:feature/read",
    "gh issue view owner/repo#42", "gh pr view -- owner/repo",
    "gh repo view owner/repo", "gh repo view github.example/owner/repo",
    "gh repo view https://github.com/owner/repo", "gh repo view -- owner/repo",
    "glab issue view https://gitlab.com/other/repo/-/issues/42",
    "glab mr view https://gitlab.com/other/repo/-/merge_requests/42",
    "glab mr diff group/project!42", "glab mr view group/project",
    "glab repo view group/subgroup/project", "glab repo view project",
    "glab repo view git@gitlab.com:group/project.git",
    "gh run view https://github.com/other/repo/actions/runs/42",
    "gh run view --job https://github.com/other/repo/actions/runs/42/job/99",
    "gh run view --job 99 -jhttps://github.com/other/repo/actions/runs/42/job/99",
    "gh workflow view other/repo", "gh release view https://github.com/other/repo/releases/tag/v1",
  ]) await denied(command);
});

test("cross-project listings, raw GitHub search, and interactive queries are rejected", async () => {
  for (const command of [
    "gh repo list", "gh repo list other", "glab repo list", "glab repo list --group other",
    "gh pr list --search 'repo:other/repo'", "gh issue list -S'repo:other/repo'",
    "gh pr list --search 'is:open OR repo:other/repo'",
    "glab issue list --group other", "glab issue list -gother", "glab issue list --epic 10",
    "glab mr list --group=other", "glab mr list -g other", "glab mr list -Agother",
    "glab ci view", "glab ci view --pipelineid 42", "glab ci status --wait",
    "glab ci status --live", "glab ci status -l", "gh run view", "gh workflow view",
    "gh pr checks --watch", "gh pr view --web", "glab mr view --web",
    "gh auth status --show-token", "glab auth status --show-token",
    "gh issue diff", "gh repo checks", "glab release status", "glab ci diff",
    "gh pr list --unknown future", "glab mr list --opened",
    "gh pr view 42 --json number --jq 'env.GH_TOKEN'", "gh pr view 42 --jq=env.GH_TOKEN",
    "gh pr view 42 -qenv.GH_TOKEN", "gh pr view 42 --template '{{.number}}'",
    "gh pr view 42 -t'{{.number}}'", "gh pr view 42 --template='{{.number}}'",
    "glab mr view 42 --output json --jq 'env.GITLAB_TOKEN'",
    "glab issue list --output json --jq=env.GITLAB_TOKEN",
  ]) await denied(command);
});

test("a rejected cross-repository call never reaches the executable", async () => {
  const result = await decision("gh pr view https://github.com/other/repo/pull/42");
  if (result.decision === "allow") execFileSync(join(trustedBin, "gh"), [], { cwd: checkout });
  assert.equal(result.decision, "deny");
  assert.equal(existsSync(marker), false);
});

test("forge refusal guidance explains supported selectors without intercepting delivery", () => {
  for (const tokens of [
    ["gh", "pr", "view", "https://github.com/other/repo/pull/42"],
    ["glab", "issue", "list", "--group", "other"],
    ["gh", "--repo=other/repo", "pr", "view", "42"],
    ["glab", "ci", "view"],
  ]) assert.match(forgeReadFailureReason(tokens), /without repository, host, group, URL.*numeric PR\/MR\/issue IDs/u);
  assert.equal(forgeReadFailureReason(["gh", "pr", "view", "42"]), null);
  assert.equal(forgeReadFailureReason(["gh", "pr", "create", "--title", "fixture"]), null);
});

test("ambient target overrides and the launcher marker block forge reads before database lookup", async () => {
  for (const name of [...FORGE_TARGET_ENV_NAMES, "TMB_CODEX_HOOK_FORGE_TARGET_ENV"]) {
    const original = process.env[name];
    try {
      process.env[name] = "fixture-override";
      for (const command of ["gh pr view 42", "glab mr view 42"]) {
        const result = await denied(command);
        assert.equal(result.decision, "deny", `${name}: ${command}`);
        assert.match(result.reason, /unset forge repository, host, and remote-selection environment overrides/u);
        assert.equal(result.reason.includes("fixture-override"), false);
      }
      assert.equal((await decision("pwd")).decision, "allow");
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  }
});
