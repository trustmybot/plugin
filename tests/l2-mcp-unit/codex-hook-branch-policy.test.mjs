import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";

import { BRANCH_POLICY_TIMEOUT_MS, readProtectedBranchPolicy } from "../../adapters/codex/hooks/branch-policy.mjs";
import { evaluatePreToolUse, makeRestrictedCommand } from "../../adapters/codex/hooks/repo-policy.mjs";
import { RUNTIME_RELATIVE_PATHS } from "../../adapters/codex/hooks/dispatcher.mjs";

let fixtures;
let serial = 0;
let sandboxUnavailable;

before(() => {
  fixtures = realpathSync(mkdtempSync(join(tmpdir(), "tmb-codex-branch-policy-")));
  if (process.platform !== "darwin") {
    sandboxUnavailable = "the branch-policy OS integration requires macOS";
    return;
  }
  const probe = spawnSync("/usr/bin/sandbox-exec", [
    "-p", "(version 1) (allow default) (deny file-write*) (deny network*)",
    "/usr/bin/sqlite3", "-init", "/dev/null", ":memory:", "SELECT 1;",
  ], { encoding: "utf8", timeout: 1_000 });
  if (probe.status !== 0) sandboxUnavailable = `macOS read-only sandbox is unavailable: ${probe.stderr?.trim() || probe.error?.message}`;
});

after(() => { if (fixtures) rmSync(fixtures, { recursive: true, force: true }); });

function project(name = "project") {
  const root = join(fixtures, `${++serial}-${name}`);
  mkdirSync(root);
  return root;
}

function dbPath(root, plugin = "tmb") {
  return join(root, ".tmb", plugin, "trajectory.db");
}

function seed(root, options = {}) {
  const path = options.path ?? dbPath(root);
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  if (options.pageSize) db.exec(`PRAGMA page_size=${options.pageSize};`);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE repos(name TEXT PRIMARY KEY, path TEXT NOT NULL, target_branch TEXT, protected_branches TEXT${options.legacy ? ", pr_target TEXT" : ""});
    CREATE TABLE tasks(repo TEXT, parent_branch_id TEXT);`);
  db.prepare("INSERT INTO repos(name,path,target_branch,protected_branches) VALUES (?,?,?,?)")
    .run("current", options.registeredPath ?? root, options.target ?? null, options.protected ?? null);
  return db;
}

function stateSnapshot(root) {
  const directory = join(root, ".tmb", "tmb");
  return Object.fromEntries(readdirSync(directory).sort().map((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path, { bigint: true });
    return [name, {
      inode: `${stat.dev}:${stat.ino}`, bytes: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
    }];
  }));
}

function inspectWithoutWrites(root) {
  const before = stateSnapshot(root);
  const result = readProtectedBranchPolicy(root, "tmb");
  assert.deepEqual(stateSnapshot(root), before, "policy reads must neither create nor alter state files");
  return result;
}

function requireSandbox(t) {
  if (!sandboxUnavailable) return true;
  t.skip(sandboxUnavailable);
  return false;
}

const FIXTURE_PLUGIN_NAME = "branch-policy-fixture";

function git(root, ...args) {
  return execFileSync("/usr/bin/git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "TMB Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "TMB Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();
}

function governedProject(branch = "feature/work") {
  const root = project("governed");
  git(root, "init", "-b", branch);
  writeFileSync(join(root, "source.txt"), "before\n");
  writeFileSync(join(root, "candidate.test.mjs"), "// isolated validation fixture\n");
  const pluginRoot = project("plugin");
  mkdirSync(join(pluginRoot, ".codex-plugin"));
  writeFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: FIXTURE_PLUGIN_NAME }));
  for (const path of [...RUNTIME_RELATIVE_PATHS, "hooks/codex/hooks.json"]) {
    const destination = join(pluginRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), destination);
  }
  return { root, pluginRoot, branch };
}

function configured(fixture, options = {}, mutation = "") {
  const db = seed(fixture.root, { ...options, path: dbPath(fixture.root, FIXTURE_PLUGIN_NAME) });
  if (mutation) db.exec(mutation);
  db.close();
}

function gate(fixture, tool_name, tool_input) {
  if (tool_name === "Bash" && tool_input.command !== "pwd") {
    tool_name = "functions.exec";
    tool_input = `text(JSON.stringify(await tools.exec_command(${JSON.stringify({
      cmd: makeRestrictedCommand(tool_input.command, fixture.root, { pluginRoot: fixture.pluginRoot }),
      workdir: fixture.root, shell: "/bin/sh", login: false, tty: false,
    })})));`;
  }
  return evaluatePreToolUse({
    cwd: fixture.root, hook_event_name: "PreToolUse", permission_mode: "default", tool_name, tool_input,
    ...(tool_name === "Bash" ? { execution_context: {
      kind: "exec_command", argv: ["/bin/sh", "-c", tool_input.command], cwd: fixture.root,
      tty: false, login: false, environment_id: "local-branch-policy-test", is_remote: false, shell_mode: "direct",
    } } : {}),
  }, { pluginRoot: fixture.pluginRoot });
}

function writeCandidates(branch) {
  return [
    ["apply_patch", { command: "*** Begin Patch\n*** Update File: source.txt\n@@\n-before\n+after\n*** End Patch" }],
    ["Bash", { command: "node --test candidate.test.mjs" }],
    ["Bash", { command: "git add -- source.txt" }],
    ["Bash", { command: "git commit -m changed" }],
    ["Bash", { command: `git push origin ${branch}` }],
    ["Bash", { command: `gh pr create --base main --head ${branch} --draft --title changed --body details` }],
    ["Bash", { command: `glab mr create --target-branch main --source-branch ${branch} --draft --title changed --description details` }],
  ];
}

async function withTrustedForge(callback) {
  const bin = project("forge-bin");
  for (const name of ["gh", "glab"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  const original = process.env.TMB_CODEX_HOOK_HOST_PATH;
  try {
    process.env.TMB_CODEX_HOOK_HOST_PATH = `${bin}:${process.env.PATH}`;
    await callback();
  } finally {
    if (original === undefined) delete process.env.TMB_CODEX_HOOK_HOST_PATH;
    else process.env.TMB_CODEX_HOOK_HOST_PATH = original;
  }
}

test("all write lanes consume the manifest-namespaced protected branch union", async (t) => {
  if (!requireSandbox(t)) return;
  await withTrustedForge(async () => {
    for (const field of ["protected", "target", "legacy", "parent"]) {
      const fixture = governedProject();
      const options = field === "protected" ? { protected: JSON.stringify([fixture.branch]) }
        : field === "target" ? { target: fixture.branch } : { legacy: true };
      configured(fixture, options, field === "legacy" ? `UPDATE repos SET pr_target='${fixture.branch}';`
        : field === "parent" ? `INSERT INTO tasks VALUES ('current','${fixture.branch}');` : "");
      for (const [tool, input] of writeCandidates(fixture.branch)) {
        const result = await gate(fixture, tool, input);
        assert.equal(result.decision, "deny", `${field}: ${tool}: ${JSON.stringify(input)}`);
        assert.match(result.reason, /protected/u, `${field}: ${tool}: ${JSON.stringify(input)}`);
      }
      assert.equal((await gate(fixture, "Bash", { command: "git restore --staged -- source.txt" })).decision, "allow", "explicit index recovery remains available with valid policy");
    }
    const fixture = governedProject();
    configured(fixture, { protected: '["feature/another"]' });
    for (const [tool, input] of writeCandidates(fixture.branch)) {
      const result = await gate(fixture, tool, input);
      assert.equal(result.decision, "allow", `${tool}: ${JSON.stringify(input)}: ${result.reason}`);
    }
  });
});

test("every configured protection source covers case and Unicode variants in HEAD and branch creation", async (t) => {
  if (!requireSandbox(t)) return;
  await withTrustedForge(async () => {
    for (const [branch, protectedName] of [
      ["feature/SHARED", "feature/shared"], ["feature/shared", "FEATURE/SHARED"],
      ["feature/caf\u00e9", "feature/cafe\u0301"], ["feature/cafe\u0301", "feature/caf\u00e9"],
    ]) {
      for (const field of ["protected", "target", "legacy", "parent"]) {
        const fixture = governedProject(branch);
        git(fixture.root, "config", "core.precomposeunicode", "false");
        git(fixture.root, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
        assert.equal(git(fixture.root, "symbolic-ref", "--short", "HEAD"), branch, "exercise the exact raw HEAD spelling, including NFD");
        const options = field === "protected" ? { protected: JSON.stringify([protectedName]) }
          : field === "target" ? { target: protectedName } : { legacy: true };
        configured(fixture, options, field === "legacy" ? `UPDATE repos SET pr_target='${protectedName}';`
          : field === "parent" ? `INSERT INTO tasks VALUES (NULL,'${protectedName}');` : "");
        for (const [tool, input] of writeCandidates(branch)) {
          const result = await gate(fixture, tool, input);
          assert.equal(result.decision, "deny", `${field}: ${branch}: ${tool}`);
          assert.match(result.reason, /protected/u);
        }
        for (const command of [
          `git switch -c ${protectedName.toUpperCase().normalize("NFD")}`,
          `git switch --create ${protectedName.toLowerCase().normalize("NFC")}`,
          `git checkout -b ${protectedName.toLowerCase().normalize("NFD")}`,
        ]) {
          assert.equal((await gate(fixture, "Bash", { command })).decision, "deny", `${field}: ${command}`);
        }
        assert.equal((await gate(fixture, "Bash", { command: "git switch -c feature/unprotected" })).decision, "allow");
      }
    }
  });
});

test("main stays protected and branch creation rejects configured target names", async (t) => {
  if (!requireSandbox(t)) return;
  for (const branch of ["main", "feature/work"]) {
    const fixture = governedProject(branch);
    configured(fixture, { target: "codex/shared" });
    for (const command of ["git switch -c codex/shared", "git switch --create codex/shared", "git checkout -b codex/shared"]) {
      assert.equal((await gate(fixture, "Bash", { command })).decision, "deny", command);
    }
    assert.equal((await gate(fixture, "Bash", { command: "git switch -c codex/new" })).decision, "allow");
    assert.equal((await gate(fixture, "apply_patch", writeCandidates(branch)[0][1])).decision, branch === "main" ? "deny" : "allow");
  }
});

test("invalid existing policy blocks writes and branch recovery but leaves reads and diagnostics usable", async () => {
  for (const kind of ["corrupt", "fifo"]) {
    const fixture = governedProject();
    const path = dbPath(fixture.root, FIXTURE_PLUGIN_NAME);
    mkdirSync(join(path, ".."), { recursive: true });
    if (kind === "fifo") execFileSync("mkfifo", [path]);
    else writeFileSync(path, "corrupt database");
    for (const [tool, input] of [...writeCandidates(fixture.branch),
      ["Bash", { command: "git switch -c codex/new" }],
      ["Bash", { command: "git restore --staged -- source.txt" }],
    ]) {
      assert.equal((await gate(fixture, tool, input)).decision, "deny", `${kind}: ${tool}: ${JSON.stringify(input)}`);
    }
    for (const [tool, input] of [
      ["Read", { file_path: join(fixture.root, "source.txt") }], ["Bash", { command: "pwd" }],
      ["mcp__codex_app__list_projects", {}], ["mcp__codex_app__read_thread", { threadId: "fixture" }],
      ["mcp__codex_app__uninstall_plugin", { plugin: "tmb" }], ["write_stdin", { session_id: 1, chars: "" }],
      ["write_stdin", { session_id: 1, chars: "\u0003" }],
    ]) {
      assert.equal((await gate(fixture, tool, input)).decision, "allow", `${kind}: ${tool}`);
    }
  }
});

test("missing Codex state keeps baseline gates without creating state or borrowing another namespace", async () => {
  const fixture = governedProject();
  mkdirSync(join(fixture.root, ".tmb", "another-plugin"), { recursive: true });
  writeFileSync(dbPath(fixture.root, "another-plugin"), "corrupt unrelated database");
  assert.equal((await gate(fixture, "apply_patch", writeCandidates(fixture.branch)[0][1])).decision, "allow");
  assert.deepEqual(readdirSync(join(fixture.root, ".tmb")), ["another-plugin"]);
});

test("unavailable or unsafe Codex manifest blocks writes without blocking reads", async () => {
  for (const kind of ["missing", "invalid", "symlink"]) {
    const fixture = governedProject();
    const manifest = join(fixture.pluginRoot, ".codex-plugin", "plugin.json");
    rmSync(manifest);
    if (kind === "invalid") writeFileSync(manifest, '{"name":"../escape"}');
    if (kind === "symlink") {
      const outside = join(project("manifest"), "plugin.json");
      writeFileSync(outside, JSON.stringify({ name: FIXTURE_PLUGIN_NAME }));
      symlinkSync(outside, manifest);
    }
    assert.equal((await gate(fixture, "apply_patch", writeCandidates(fixture.branch)[0][1])).decision, "deny", kind);
    assert.equal((await gate(fixture, "Bash", { command: "pwd" })).decision, "allow", kind);
  }
});

test("linked worktrees use their own Codex database rather than primary checkout configuration", async (t) => {
  if (!requireSandbox(t)) return;
  const primary = governedProject("main");
  git(primary.root, "add", "--", "source.txt");
  git(primary.root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const linkedRoot = join(fixtures, `${++serial}-linked`);
  git(primary.root, "worktree", "add", "-b", "feature/linked", linkedRoot);
  const linked = { ...primary, root: linkedRoot, branch: "feature/linked" };
  configured(primary, { protected: '["feature/linked"]' });
  const patch = writeCandidates(linked.branch)[0][1];
  assert.equal((await gate(linked, "apply_patch", patch)).decision, "allow");
  configured(linked, { protected: '["feature/linked"]' });
  assert.equal((await gate(linked, "apply_patch", patch)).decision, "deny");
});

test("missing Codex state returns no configured branches and creates nothing", () => {
  const root = project();
  assert.deepEqual(readProtectedBranchPolicy(root, "tmb"), { ok: true, protectedBranches: [] });
  assert.deepEqual(readdirSync(root), []);
});

test("an existing database is never treated as supported on other platforms", () => {
  const root = project();
  const db = seed(root);
  db.close();
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    const result = inspectWithoutWrites(root);
    assert.equal(result.ok, false);
    assert.match(result.reason, /macOS/u);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

test("closed checkpointed DB uses a stable no-sidecar snapshot and the complete policy union", (t) => {
  if (!requireSandbox(t)) return;
  const root = project("quote'?# policy");
  const db = seed(root, { legacy: true, protected: '["feature/protected","feature/target"]', target: "feature/target" });
  db.exec("UPDATE repos SET pr_target='feature/legacy'; INSERT INTO tasks VALUES ('current','feature/parent'),(NULL,'feature/null-parent');");
  db.close();
  assert.deepEqual(readdirSync(join(root, ".tmb", "tmb")), ["trajectory.db"]);
  assert.deepEqual(inspectWithoutWrites(root), {
    ok: true, protectedBranches: ["feature/legacy", "feature/null-parent", "feature/parent", "feature/protected", "feature/target"],
  });
});

test("live WAL and SHM expose the latest committed policy without changing any state", (t) => {
  if (!requireSandbox(t)) return;
  const root = project();
  const db = seed(root, { protected: '["feature/old"]' });
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); UPDATE repos SET protected_branches='[\"feature/latest\"]';");
    assert.deepEqual(inspectWithoutWrites(root), { ok: true, protectedBranches: ["feature/latest"] });
  } finally { db.close(); }
});

test("WAL without SHM denies and never manufactures a sidecar or ignores the WAL", (t) => {
  if (!requireSandbox(t)) return;
  const root = project();
  const source = project("source");
  const db = seed(root, { path: dbPath(source), protected: '["feature/old"]' });
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); UPDATE repos SET protected_branches='[\"feature/latest\"]';");
    mkdirSync(join(root, ".tmb", "tmb"), { recursive: true });
    for (const suffix of ["", "-wal"]) copyFileSync(`${dbPath(source)}${suffix}`, `${dbPath(root)}${suffix}`);
    const result = inspectWithoutWrites(root);
    assert.equal(result.ok, false);
    assert.match(result.reason, /journal state/u);
  } finally { db.close(); }
});

test("copied DB, WAL and SHM remain byte-identical while current WAL policy is read", (t) => {
  if (!requireSandbox(t)) return;
  const root = project();
  const source = project("source");
  const db = seed(root, { path: dbPath(source), protected: '["feature/old"]' });
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); UPDATE repos SET protected_branches='[\"feature/latest\"]';");
    mkdirSync(join(root, ".tmb", "tmb"), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) copyFileSync(`${dbPath(source)}${suffix}`, `${dbPath(root)}${suffix}`);
    assert.deepEqual(inspectWithoutWrites(root), { ok: true, protectedBranches: ["feature/latest"] });
  } finally { db.close(); }
});

function updateIndexChecksum(bytes) {
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, 12);
  let first = 0;
  let second = 0;
  for (let index = 0; index < 10; index += 2) {
    first = (first + words[index] + second) >>> 0;
    second = (second + words[index + 1] + first) >>> 0;
  }
  words[10] = first;
  words[11] = second;
  bytes.copy(bytes, 48, 0, 48);
}

test("malformed WAL headers and committed frames deny instead of returning an older checkpoint", (t) => {
  if (!requireSandbox(t)) return;
  const root = project();
  const source = project("wal-source");
  const db = seed(root, { path: dbPath(source), protected: '["feature/old"]' });
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); UPDATE repos SET protected_branches='[\"feature/latest\"]';");
    mkdirSync(join(root, ".tmb", "tmb"), { recursive: true });
    const original = readFileSync(`${dbPath(source)}-wal`);
    for (const [name, mutate] of [
      ["header checksum", (bytes) => { bytes[24] ^= 1; }],
      ["first frame page", (bytes) => { bytes[32] ^= 1; }],
      ["last committed frame", (bytes) => { bytes[bytes.length - 1] ^= 1; }],
      ["generation salt", (bytes) => { bytes[40] ^= 1; }],
      ["truncated frame", (bytes) => bytes.subarray(0, bytes.length - 1)],
    ]) {
      for (const suffix of ["", "-wal", "-shm"]) copyFileSync(`${dbPath(source)}${suffix}`, `${dbPath(root)}${suffix}`);
      const bytes = Buffer.from(original);
      writeFileSync(`${dbPath(root)}-wal`, mutate(bytes) ?? bytes);
      const result = inspectWithoutWrites(root);
      assert.equal(result.ok, false, name);
      assert.match(result.reason, /WAL/u, name);
    }
  } finally { db.close(); }
});

test("WAL index headers, page mappings, hash slots and forged checkpoint claims must match", (t) => {
  if (!requireSandbox(t)) return;
  const root = project();
  const source = project("shm-source");
  const db = seed(root, { path: dbPath(source), protected: '["feature/old"]' });
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); UPDATE repos SET protected_branches='[\"feature/latest\"]';");
    mkdirSync(join(root, ".tmb", "tmb"), { recursive: true });
    const original = readFileSync(`${dbPath(source)}-shm`);
    for (const [name, mutate] of [
      ["header checksum", (bytes) => { bytes[40] ^= 1; bytes.copy(bytes, 48, 0, 48); }],
      ["duplicate header", (bytes) => { bytes[48] ^= 1; }],
      ["stale mxFrame with valid checksums", (bytes) => { new Uint32Array(bytes.buffer, bytes.byteOffset, 12)[4] = 0; updateIndexChecksum(bytes); }],
      ["nPage with valid checksums", (bytes) => { bytes[20] ^= 1; updateIndexChecksum(bytes); }],
      ["frame checksum with valid header checksums", (bytes) => { bytes[24] ^= 1; updateIndexChecksum(bytes); }],
      ["page mapping", (bytes) => { bytes[136] ^= 1; }],
      ["hash lookup", (bytes) => { bytes.fill(0, 16_384); }],
      ["forged completed checkpoint", (bytes) => { bytes.copy(bytes, 96, 16, 20); bytes.copy(bytes, 128, 16, 20); }],
    ]) {
      for (const suffix of ["", "-wal", "-shm"]) copyFileSync(`${dbPath(source)}${suffix}`, `${dbPath(root)}${suffix}`);
      const bytes = Buffer.from(original);
      mutate(bytes);
      writeFileSync(`${dbPath(root)}-shm`, bytes);
      const result = inspectWithoutWrites(root);
      assert.equal(result.ok, false, name);
      assert.match(result.reason, /WAL/u, name);
    }
  } finally { db.close(); }
});

test("valid checkpointed WAL remains readable while empty WAL and transaction tails fail closed", (t) => {
  if (!requireSandbox(t)) return;
  const root = project();
  const db = seed(root, { protected: '["feature/current"]' });
  try {
    db.exec("PRAGMA wal_checkpoint(FULL);");
    assert.deepEqual(inspectWithoutWrites(root), { ok: true, protectedBranches: ["feature/current"] });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    assert.equal(inspectWithoutWrites(root).ok, false, "empty WAL is explicitly unsupported until it is closed or rewritten");
    db.exec("UPDATE repos SET protected_branches='[\"feature/latest\"]';");
    assert.deepEqual(inspectWithoutWrites(root), { ok: true, protectedBranches: ["feature/latest"] });
    const path = `${dbPath(root)}-wal`;
    const bytes = readFileSync(path);
    const frameSize = 24 + bytes.readUInt32BE(8);
    // A stable partial frame can otherwise be silently ignored by SQLite.
    writeFileSync(path, Buffer.concat([bytes, bytes.subarray(32, 32 + frameSize - 1)]));
    assert.equal(inspectWithoutWrites(root).ok, false);
  } finally { db.close(); }
});

test("WAL verification supports small and large page sizes and multiple SHM hash groups", (t) => {
  if (!requireSandbox(t)) return;
  for (const pageSize of [512, 65_536]) {
    const root = project();
    const db = seed(root, { pageSize, protected: '["feature/current"]' });
    try {
      db.exec("PRAGMA wal_autocheckpoint=0;");
      if (pageSize === 512) {
        db.exec("CREATE TABLE padding(value BLOB); WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<4200) INSERT INTO padding SELECT zeroblob(400) FROM n;");
        assert.ok(lstatSync(`${dbPath(root)}-shm`).size > 32_768);
      }
      assert.deepEqual(inspectWithoutWrites(root), { ok: true, protectedBranches: ["feature/current"] }, `page size ${pageSize}`);
    } finally { db.close(); }
  }
});

test("unregistered projects and NULL policy fields add no protection and do not use another repo", (t) => {
  if (!requireSandbox(t)) return;
  for (const registered of [true, false]) {
    const root = project();
    const db = seed(root, { registeredPath: registered ? root : project("other"), protected: registered ? null : "invalid other repo policy" });
    db.close();
    assert.deepEqual(inspectWithoutWrites(root), { ok: true, protectedBranches: [] });
  }
});

test("multiple repositories contribute matching and NULL-repo parents, excluding other named repos", (t) => {
  if (!requireSandbox(t)) return;
  const root = project();
  const db = seed(root);
  db.prepare("INSERT INTO repos(name,path) VALUES (?,?)").run("other", project("other"));
  db.exec("INSERT INTO tasks VALUES ('current','feature/current-parent'),('other','feature/other-parent'),(NULL,'feature/null-parent');");
  db.close();
  assert.deepEqual(inspectWithoutWrites(root), { ok: true, protectedBranches: ["feature/current-parent", "feature/null-parent"] });
});

test("full core schema preserves NULL-repo shared parents before and after repository registration", async (t) => {
  if (!requireSandbox(t)) return;
  const schema = readFileSync(new URL("../../mcp/trajectory-server/src/schema.sql", import.meta.url), "utf8");
  for (const repoCount of [0, 1, 2]) {
    const fixture = governedProject("feature/shared-parent");
    const path = dbPath(fixture.root, FIXTURE_PLUGIN_NAME);
    mkdirSync(join(path, ".."), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(schema);
    db.exec("INSERT INTO issues(id,objective,created_at,updated_at) VALUES (1,'fixture','now','now');");
    db.exec("INSERT INTO tasks(issue_id,branch_id,parent_branch_id,description,created_at,updated_at) VALUES (1,'feature/child','feature/shared-parent','fixture','now','now');");
    if (repoCount >= 1) db.prepare("INSERT INTO repos(name,path) VALUES (?,?)").run("current", fixture.root);
    if (repoCount === 2) db.prepare("INSERT INTO repos(name,path) VALUES (?,?)").run("other", project("other"));
    db.close();
    assert.deepEqual(readProtectedBranchPolicy(fixture.root, FIXTURE_PLUGIN_NAME), {
      ok: true, protectedBranches: [fixture.branch],
    }, `${repoCount} registered repos`);
    const patch = await gate(fixture, "apply_patch", writeCandidates(fixture.branch)[0][1]);
    assert.equal(patch.decision, "deny", `${repoCount} registered repos`);
    assert.match(patch.reason, /protected/u);
    assert.equal((await gate(fixture, "Bash", { command: "git switch -c feature/shared-parent" })).decision, "deny");
  }
});

test("malformed registered policy, invalid parents and ambiguous registration deny", (t) => {
  if (!requireSandbox(t)) return;
  for (const raw of ["invalid JSON", "{}", "[1]", '[""]', '["bad branch"]']) {
    const root = project();
    const db = seed(root, { protected: raw });
    db.close();
    assert.equal(inspectWithoutWrites(root).ok, false, raw);
  }
  for (const mutation of [
    "INSERT INTO tasks VALUES ('current','bad parent');",
    "INSERT INTO repos(name,path) SELECT 'duplicate',path FROM repos;",
  ]) {
    const root = project();
    const db = seed(root);
    db.exec(mutation);
    db.close();
    assert.equal(inspectWithoutWrites(root).ok, false, mutation);
  }
});

test("unsafe state paths, alias roots and invalid plugin names are rejected without SQL", () => {
  const outside = project("outside");
  for (const kind of ["directory-symlink", "file-symlink", "hardlink", "fifo"]) {
    const root = project();
    if (kind === "directory-symlink") symlinkSync(outside, join(root, ".tmb"));
    else {
      mkdirSync(join(root, ".tmb", "tmb"), { recursive: true });
      if (kind === "fifo") execFileSync("mkfifo", [dbPath(root)]);
      else {
        const target = join(outside, `${kind}.db`);
        writeFileSync(target, "test fixture");
        if (kind === "file-symlink") symlinkSync(target, dbPath(root));
        else linkSync(target, dbPath(root));
      }
    }
    assert.equal(readProtectedBranchPolicy(root, "tmb").ok, false, kind);
  }
  const root = project();
  const alias = join(fixtures, "root-alias");
  symlinkSync(root, alias);
  assert.equal(readProtectedBranchPolicy(alias, "tmb").ok, false);
  for (const name of ["", ".", "..", "../other", "bad/name", "bad\\name", " bad ", "bad\0name"]) {
    assert.equal(readProtectedBranchPolicy(root, name).ok, false, name);
  }
});

test("orphaned, unsafe and rollback sidecars, corrupt DBs, and oversized state deny", (t) => {
  for (const kind of ["orphan", "fifo-wal", "rollback", "oversized"]) {
    const root = project();
    mkdirSync(join(root, ".tmb", "tmb"), { recursive: true });
    if (kind === "orphan") writeFileSync(`${dbPath(root)}-wal`, "orphan");
    else {
      writeFileSync(dbPath(root), "fixture");
      if (kind === "fifo-wal") execFileSync("mkfifo", [`${dbPath(root)}-wal`]);
      if (kind === "rollback") writeFileSync(`${dbPath(root)}-journal`, "journal");
      if (kind === "oversized") truncateSync(dbPath(root), 64 * 1024 * 1024 + 1);
    }
    assert.equal(readProtectedBranchPolicy(root, "tmb").ok, false, kind);
  }
  if (!requireSandbox(t)) return;
  const root = project();
  mkdirSync(join(root, ".tmb", "tmb"), { recursive: true });
  writeFileSync(dbPath(root), "not sqlite");
  assert.equal(inspectWithoutWrites(root).ok, false);
});

test("an unreadable existing database denies rather than using the static baseline", () => {
  const root = project();
  const db = seed(root);
  db.close();
  chmodSync(dbPath(root), 0);
  try { assert.equal(readProtectedBranchPolicy(root, "tmb").ok, false); }
  finally { chmodSync(dbPath(root), 0o600); }
});

test("missing or non-table core schema denies without migrations", (t) => {
  if (!requireSandbox(t)) return;
  for (const sql of [
    "CREATE TABLE other(value TEXT);",
    "CREATE VIEW repos AS SELECT 1 AS name; CREATE TABLE tasks(repo TEXT,parent_branch_id TEXT);",
    "CREATE VIRTUAL TABLE repos USING fts5(name); CREATE TABLE tasks(repo TEXT,parent_branch_id TEXT);",
  ]) {
    const root = project();
    mkdirSync(join(root, ".tmb", "tmb"), { recursive: true });
    const db = new DatabaseSync(dbPath(root));
    db.exec(sql);
    db.close();
    assert.equal(inspectWithoutWrites(root).ok, false);
  }
});

test("concurrent policy writes fail closed instead of returning a mixed snapshot", async (t) => {
  if (!requireSandbox(t)) return;
  const root = project();
  const db = seed(root, { protected: '["feature/before"]' });
  db.close();
  const writer = spawn(process.execPath, ["--experimental-sqlite", "--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    const update = db.prepare('UPDATE repos SET protected_branches=?');
    let counter=0;
    const timer=setInterval(() => update.run(JSON.stringify(['feature/change-'+counter++])), 1);
    update.run('["feature/started"]');
    process.stdout.write('ready\\n');
    process.on('SIGTERM', () => {clearInterval(timer);db.close();process.exit(0);});
  `, dbPath(root)], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(writer.stdout, "data");
    const started = performance.now();
    const result = readProtectedBranchPolicy(root, "tmb");
    assert.equal(result.ok, false);
    assert.ok(performance.now() - started < BRANCH_POLICY_TIMEOUT_MS + 500, "policy query stays within its bounded deadline");
  } finally {
    writer.kill("SIGTERM");
    await once(writer, "exit");
  }
});
