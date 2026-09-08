import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { evaluatePreToolUse, makeRestrictedCommand, classifyRestrictedCommand, resolveRepoContext } from "../../adapters/codex/hooks/repo-policy.mjs";

const PREFIX = "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null";
const DISPLAY = "--no-ext-diff --no-textconv";
let fixture;
let checkout;
let outside;

before(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "tmb-codex-git-reads-")));
  checkout = join(fixture, "repo");
  outside = join(fixture, "outside.txt");
  mkdirSync(checkout);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout });
  writeFileSync(join(checkout, "inside.txt"), "inside\n");
  writeFileSync(outside, "outside fixture\n");
  symlinkSync(outside, join(checkout, "outside-link"));
  execFileSync("mkfifo", [join(checkout, "pipe")]);
});

after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

async function decision(command) {
  const classification = await classifyRestrictedCommand(`${PREFIX} ${command}`, resolveRepoContext(checkout));
  const gate = await evaluatePreToolUse({
    cwd: checkout, hook_event_name: "PreToolUse", permission_mode: "default",
    tool_name: "functions.exec", tool_input: `text(JSON.stringify(await tools.exec_command(${JSON.stringify({
      cmd: makeRestrictedCommand(`${PREFIX} ${command}`, checkout), workdir: checkout,
      shell: "/bin/sh", login: false, tty: false,
    })})));`,
  });
  if (classification.decision === "allow" && process.platform !== "darwin") {
    assert.equal(gate.decision, "deny");
    assert.match(gate.reason, /qualified macOS sandbox/);
  } else assert.equal(gate.decision, classification.decision);
  return classification.decision;
}

test("reviewed Git query options keep normal status and history inspection available", async () => {
  for (const command of [
    "status --short", "status --porcelain=v2 --untracked-files=all -- inside.txt",
    `diff ${DISPLAY} --cached --stat`, `diff ${DISPLAY} HEAD~1..HEAD -- inside.txt`,
    `log ${DISPLAY} -n 2 --oneline --all`, `log ${DISPLAY} --format='%h %s' --max-count=2`,
    `show ${DISPLAY} --format=fuller HEAD:inside.txt`, "rev-parse --verify HEAD",
    "rev-parse --path-format=absolute --git-common-dir", "ls-files --stage -- inside.txt",
    "ls-tree -r --name-only HEAD -- inside.txt", "worktree list --porcelain",
  ]) assert.equal(await decision(command.replace("HEAD~1..HEAD", "'HEAD~1..HEAD'")), "allow", command);
});

test("Git cannot select explicit or implicit no-index paths outside the checkout", async () => {
  for (const command of [
    `diff ${DISPLAY} --no-index inside.txt ${outside}`,
    `diff ${DISPLAY} --no-ind inside.txt ${outside}`,
    `diff ${DISPLAY} inside.txt ${outside}`,
    `diff ${DISPLAY} inside.txt ${outside}:inside.txt`,
    `diff ${DISPLAY} inside.txt ../outside.txt:inside.txt`,
    `diff ${DISPLAY} -- inside.txt ../outside.txt`,
    `diff ${DISPLAY} -- inside.txt outside-link`,
    `diff ${DISPLAY} -- inside.txt pipe`,
    `show ${DISPLAY} HEAD:../outside.txt`,
    "ls-tree HEAD -- ../outside.txt",
  ]) assert.equal(await decision(command), "deny", command);
});

test("unreviewed Git option abbreviations and file/helper inputs are rejected", async () => {
  for (const command of [
    `diff ${DISPLAY} --out=inside.txt`, `diff ${DISPLAY} --ext-di`,
    "diff -- --no-ext-diff --no-textconv inside.txt",
    "diff --no-ext-diff -- --no-textconv inside.txt",
    "diff --no-textconv -- --no-ext-diff inside.txt",
    "log --format=--no-ext-diff --no-textconv",
    `show ${DISPLAY} --textc HEAD:inside.txt`, `log ${DISPLAY} --show-signat -1`,
    `log ${DISPLAY} --format='%G?'`, `log ${DISPLAY} --pretty=custom-signature-alias`,
    `log ${DISPLAY} --format=custom-signature-alias`,
    `log ${DISPLAY} --format --show-signature`,
    `ls-files --exclude-from=${outside}`, "ls-files --exclude-from=pipe",
    `ls-files --with-tree=HEAD --exclude-from=${outside}`,
    "rev-parse --parseopt", "worktree list --expire=now",
  ]) assert.equal(await decision(command), "deny", command);
});
