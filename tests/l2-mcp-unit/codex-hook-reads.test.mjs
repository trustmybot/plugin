import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { MAX_COMMAND_BYTES, evaluatePreToolUse } from "../../adapters/codex/hooks/repo-policy.mjs";

let fixtureRoot;
let checkout;
let outside;

before(() => {
  fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "tmb-codex-read-boundary-")));
  checkout = join(fixtureRoot, "checkout");
  outside = join(fixtureRoot, "outside");
  mkdirSync(join(checkout, "src"), { recursive: true });
  mkdirSync(join(checkout, "src", "nested"));
  mkdirSync(outside);
  writeFileSync(join(checkout, "src", "sample.txt"), "seed\nsecond line\n");
  writeFileSync(join(checkout, "src", "nested", "sample.txt"), "seed\n");
  writeFileSync(join(checkout, "src", "patterns.txt"), "seed\n");
  writeFileSync(join(checkout, "src", "ignore.txt"), "nothing-to-ignore\n");
  writeFileSync(join(checkout, "src", "filter.jq"), ".value\n");
  writeFileSync(join(checkout, "sample.json"), '{"value":"seed"}\n');
  writeFileSync(join(outside, "sample.txt"), "OUTSIDE_TEST_MARKER\n");
  symlinkSync(outside, join(checkout, "outside-link"));
  symlinkSync(join(outside, "sample.txt"), join(checkout, "outside-file"));
  symlinkSync(join(checkout, "src"), join(checkout, "inside-link"));
  execFileSync("mkfifo", [join(checkout, "src", "pipe")]);
  execFileSync("git", ["init", "-q", "-b", "main", checkout], { stdio: "pipe" });
});

after(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

// These cases exercise read parsing and path checks after host qualification.
async function decision(command, cwd = checkout) {
  return evaluatePreToolUse({
    cwd,
    hook_event_name: "PreToolUse",
    permission_mode: "default",
    session_id: "read-boundary-test",
    tool_name: "Bash",
    tool_input: { command },
    execution_context: {
      kind: "exec_command", argv: ["/bin/sh", "-c", command], cwd,
      tty: false, login: false, environment_id: "local-read-test", is_remote: false, shell_mode: "direct",
    },
  }, { pluginRoot: join(fixtureRoot, "plugin-cache"), pluginData: join(fixtureRoot, "plugin-data") });
}

test("reviewed shell metadata and content operands stay in the checkout", async () => {
  for (const program of ["cat", "head", "tail", "wc", "stat", "file", "realpath", "readlink", "ls", "du", "test -f"]) {
    for (const target of [join(outside, "sample.txt"), "../outside/sample.txt", "outside-file", "outside-link/sample.txt", "inside-link/sample.txt", "src/pipe", "/dev/zero"]) {
      assert.equal((await decision(`${program} ${target}`)).decision, "deny", `${program} ${target}`);
    }
  }
  for (const command of [
    "wc --files0-from=../outside/sample.txt src/sample.txt",
    "wc --files0-from src/pipe src/sample.txt",
    "ls -L src", "ls -RH .", "ls --dereference .",
    "du -L .", "du --dereference .", "du --files0-from=src/pipe src",
    "jq --rawfile value ../outside/sample.txt . sample.json",
    "jq -f src/pipe sample.json", "jq . outside-file",
    "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv --no-index src/sample.txt ../outside/sample.txt",
  ]) assert.equal((await decision(command)).decision, "deny", command);
});

test("common finite reads, directory metadata, and diagnostics remain available", async () => {
  for (const command of [
    "ls", "ls -lat src", "ls -R src", "ls -- src", "du", "du -sh src",
    "cat -- src/sample.txt", "head -n 1 src/sample.txt", "head -c4 src/sample.txt",
    "tail --lines=1 -- src/sample.txt", "wc -lw -- src/sample.txt", "stat src", "file src/sample.txt",
    "realpath src", "readlink src/sample.txt", "dirname /arbitrary/string", "basename /arbitrary/string",
    "jq -r .value sample.json", "jq --arg value seed . sample.json", "jq -f src/filter.jq sample.json",
    "test -f src/sample.txt", "test -d src", "test -n anything", "test 1 -eq 1", "true", "false", "pwd",
  ]) {
    const result = await decision(command);
    assert.equal(result.decision, "allow", `${command}: ${result.reason ?? ""}`);
  }
});

test("jq rejects inline and file-backed module loads before opening implicit module paths", async () => {
  writeFileSync(join(outside, "outside.jq"), '"OUTSIDE_MODULE_MARKER"\n');
  execFileSync("mkfifo", [join(outside, "waiting.jq")]);
  const moduleSearch = JSON.stringify(outside);
  const filters = [
    `import "outside" as $outside {search: ${moduleSearch}}; $outside`,
    `include "outside" {search: ${moduleSearch}}; .`,
    `import\t"waiting"\nas $waiting {search: ${moduleSearch}}; $waiting`,
    `include\n\t"waiting" {search: ${moduleSearch}}; .`,
    '"import"', '"include"', '.value # import in a comment', '# include in a comment\n.value',
  ];
  for (let index = 0; index < filters.length; index += 1) {
    const source = filters[index];
    const filterPath = `src/rejected-module-${index}.jq`;
    writeFileSync(join(checkout, filterPath), source);
    for (const command of [`jq '${source}' sample.json`, `jq -f ${filterPath} sample.json`, `jq --from-file ${filterPath} sample.json`]) {
      assert.equal((await decision(command)).decision, "deny", command);
    }
  }
});

test("jq file-backed filters must be contained regular files within the byte limit", async () => {
  const oversize = "src/oversize-filter.jq";
  const maximum = "src/maximum-filter.jq";
  writeFileSync(join(checkout, oversize), ".value".padEnd(MAX_COMMAND_BYTES + 1, " "));
  writeFileSync(join(checkout, maximum), ".value".padEnd(MAX_COMMAND_BYTES, " "));
  for (const directory of [".claude", ".tmb", ".git"]) {
    mkdirSync(join(checkout, directory), { recursive: true });
    writeFileSync(join(checkout, directory, "filter.jq"), ".value");
    assert.equal((await decision(`jq -f ${directory}/filter.jq sample.json`)).decision, "deny", "Hook must not load protected state as filter source");
  }
  for (const path of [oversize, "src/pipe", "src/missing-filter.jq", "src", "../outside/outside.jq", join(outside, "outside.jq"), "outside-link/outside.jq"]) {
    assert.equal((await decision(`jq -f ${path} sample.json`)).decision, "deny", path);
  }
  assert.equal((await decision(`jq -f ${maximum} sample.json`)).decision, "allow");
});

test("jq keeps complex filters without modules usable and executes them normally", async () => {
  const source = 'def doubled: . * 2; {name: (.value | ascii_upcase), sizes: ([.value | length] | map(doubled)), imported_count: 0, included: "importantly"}';
  const filterPath = "src/complex-filter.jq";
  writeFileSync(join(checkout, filterPath), source);
  for (const args of [[source, "sample.json"], ["-f", filterPath, "sample.json"]]) {
    const command = args[0] === "-f" ? `jq -f ${filterPath} sample.json` : `jq '${source}' sample.json`;
    assert.equal((await decision(command)).decision, "allow", command);
    const result = spawnSync("jq", args, { cwd: checkout, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.error, undefined, result.error?.message ?? "");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { name: "SEED", sizes: [8], imported_count: 0, included: "importantly" });
  }
});

test("ripgrep parses patterns, flags, and paths without treating option values as operands", async () => {
  for (const command of [
    "rg --no-config --no-ignore -n seed src",
    "rg --no-config --no-ignore -n -g '*.txt' seed src",
    "rg --no-config --glob='*.txt' --max-count=1 seed src/sample.txt",
    "rg --no-config --no-ignore -nC1 -g'*.txt' seed src",
    "rg --no-config -e seed src/sample.txt",
    "rg --no-config --regexp=seed --regexp=second src/sample.txt",
    "rg --no-config --no-ignore -neseed src",
    "rg --no-config -f src/patterns.txt src/sample.txt",
    "rg --no-config --no-ignore --file=src/patterns.txt --ignore-file src/ignore.txt src",
    "rg --no-config --no-ignore --files", "rg --no-config --no-ignore --files --hidden -g '*.txt' src",
    "rg --no-config --no-ignore --files -- src", "rg --no-config -- -pattern src/sample.txt",
  ]) {
    const result = await decision(command);
    assert.equal(result.decision, "allow", `${command}: ${result.reason ?? ""}`);
  }
  for (const command of [
    "rg --no-config --no-ignore seed", "rg --no-config --no-ignore -g '*.txt' seed", "rg --no-config --no-ignore -e seed",
    "rg --no-ignore --regexp --no-config seed src", "rg --no-ignore -e --no-config seed src",
    "rg --no-config --no-ignore -g '*.txt' seed -", "rg --no-config --no-ignore -f - src", "rg --no-config --no-ignore --file=src/pipe src",
    "rg --no-config --no-ignore -f ../outside/sample.txt src", "rg --no-config --no-ignore --ignore-file=src/pipe seed src",
    "rg --no-config --no-ignore --ignore-file outside-file seed src",
    "rg --no-config --no-ignore -L seed .", "rg --no-config --no-ignore -nL seed .", "rg --no-config --no-ignore --follow seed .",
    "rg --no-config --no-ignore --files -L .", "rg --no-config --no-ignore --pre=cat seed src",
    "rg --no-config --no-ignore --search-zip seed src", "rg --no-config --no-ignore -nz seed src",
    "rg --no-config --no-ignore --hostname-bin=cat seed src", "rg --no-config --no-ignore --unknown-option seed src",
  ]) assert.equal((await decision(command)).decision, "deny", command);
});

test("ripgrep rejects explicit FIFO, devices, escaping paths, and symlinks before execution", async () => {
  for (const target of ["src/pipe", "/dev/zero", "../outside", outside, "outside-file", "outside-link", "inside-link"]) {
    for (const command of [`rg --no-config --no-ignore seed ${target}`, `rg --no-config --no-ignore --files ${target}`, `rg --no-config --no-ignore -e seed ${target}`]) {
      const result = await decision(command);
      assert.equal(result.decision, "deny", command);
    }
  }
  assert.equal((await decision("rg --no-config seed sample.txt", join(checkout, "src"))).decision, "allow");
  assert.equal((await decision("rg --no-config seed ../../outside/sample.txt", join(checkout, "src"))).decision, "deny");
});

test("allowed ripgrep directory traversal finishes and skips FIFO and links", async () => {
  for (const args of [["--no-config", "--no-ignore", "-n", "seed", "src"], ["--no-config", "--no-ignore", "--files", "."]]) {
    const command = ["rg", ...args].join(" ");
    assert.equal((await decision(command)).decision, "allow", command);
    const result = spawnSync("rg", args, { cwd: checkout, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.error, undefined, `${command}: ${result.error?.message ?? ""}`);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /OUTSIDE_TEST_MARKER|outside-file|outside-link|inside-link|src\/pipe/u);
  }
});

test("ripgrep requires parsed ignore-disable flags for directory walks and gives an actionable denial", async () => {
  for (const command of [
    "rg --no-config seed src", "rg --no-config --files", "rg --no-config --files src/sample.txt",
    "rg --no-config -u seed src", "rg --no-config -e --no-ignore src", "rg --no-config -- seed src --no-ignore",
  ]) {
    const result = await decision(command);
    assert.equal(result.decision, "deny", command);
    assert.match(result.reason, /rg --no-config --no-ignore/u, command);
  }
  for (const flag of ["--ignore", "--ignore-dot", "--ignore-exclude", "--ignore-global", "--ignore-parent", "--ignore-vcs"]) {
    for (const options of [`--no-ignore ${flag}`, `${flag} --no-ignore`]) {
      assert.equal((await decision(`rg --no-config ${options} seed src`)).decision, "deny", options);
    }
  }
});

test("allowed rg searches cannot block on implicit ignore FIFOs in parents or nested directories", async () => {
  for (const directory of [fixtureRoot, checkout, join(checkout, "src"), join(checkout, "src", "nested")]) {
    for (const name of [".ignore", ".gitignore", ".rgignore"]) {
      const fifo = join(directory, name);
      execFileSync("mkfifo", [fifo]);
      try {
        assert.equal((await decision("rg --no-config seed src")).decision, "deny", fifo);
        for (const args of [
          ["--no-config", "--no-ignore", "seed", "src"],
          ["--no-config", "--no-ignore", "--files", "."],
          ["--no-config", "--no-ignore", "--ignore-file", "src/ignore.txt", "seed", "src"],
          ["--no-config", "seed", "src/sample.txt", "src/nested/sample.txt"],
        ]) {
          const command = ["rg", ...args].join(" ");
          assert.equal((await decision(command)).decision, "allow", `${fifo}: ${command}`);
          const result = spawnSync("rg", args, { cwd: checkout, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"] });
          assert.equal(result.error, undefined, `${fifo}: ${command}: ${result.error?.message ?? ""}`);
          assert.equal(result.status, 0, `${fifo}: ${command}: ${result.stderr}`);
        }
      } finally {
        rmSync(fifo);
      }
    }
  }
});
