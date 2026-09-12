import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { evaluatePreToolUse } from "../../adapters/codex/hooks/repo-policy.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let fixtureRoot;
let checkout;

function git(...args) {
  return execFileSync("git", args, {
    cwd: checkout,
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
  });
}

before(() => {
  fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "tmb-codex-branches-")));
  checkout = join(fixtureRoot, "checkout");
  mkdirSync(checkout);
  git("init", "-b", "main");
  writeFileSync(join(checkout, "source.txt"), "original\n");
  git("add", "source.txt");
  git("commit", "-m", "test: initialize fixture");
});

after(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

async function patchDecision() {
  return evaluatePreToolUse({
    cwd: checkout,
    hook_event_name: "PreToolUse",
    permission_mode: "default",
    tool_name: "apply_patch",
    tool_input: {
      command: "*** Begin Patch\n*** Update File: source.txt\n@@\n-original\n+updated\n*** End Patch",
    },
  });
}

test("every core task branch prefix accepts a contained patch", async (t) => {
  const source = readFileSync(join(REPO_ROOT, "mcp", "trajectory-server", "src", "tools", "tasks.ts"), "utf8");
  const declaration = source.match(/export const BRANCH_ID_RE\s*=\s*\/\^\(([^)]+)\)/u);
  assert.ok(declaration, "core branch-prefix contract must remain inspectable");
  const prefixes = declaration[1].split("|");
  assert.ok(prefixes.length > 0);
  for (const prefix of prefixes) {
    await t.test(prefix, async () => {
      git("switch", "-c", `${prefix}/hook-compatibility`);
      assert.equal((await patchDecision()).decision, "allow", `core prefix ${prefix} must be accepted`);
    });
  }
});

test("existing Codex branch-prefix extensions remain accepted", async (t) => {
  for (const prefix of ["bugfix", "codex", "feature", "hotfix"]) {
    await t.test(prefix, async () => {
      git("switch", "-c", `${prefix}/hook-compatibility`);
      assert.equal((await patchDecision()).decision, "allow");
    });
  }
});

test("fixed protected branches and unknown prefixes still reject patches", async (t) => {
  for (const branch of ["main", "master", "dev", "develop", "development", "trunk", "release/shared"]) {
    await t.test(branch, async () => {
      if (branch === "main") git("switch", branch);
      else git("switch", "-c", branch);
      assert.equal((await patchDecision()).decision, "deny");
    });
  }
});
