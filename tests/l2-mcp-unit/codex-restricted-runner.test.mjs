import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { calculateRuntimeDigest } from "../../adapters/codex/hooks/dispatcher.mjs";
import { rejectWritableAliases } from "../../adapters/codex/hooks/restricted-runner.mjs";

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
    for(const operation of [()=>fs.readFileSync(${JSON.stringify(marker)}),()=>fs.writeFileSync(${JSON.stringify(marker)},'changed')]) {
      assert.throws(operation,e=>['EPERM','EACCES'].includes(e.code));
    }`);
  ok(run(f, "node --test probe.test.mjs", { env: { PATH, TMB_CODEX_PLUGIN_DATA: data } }));
  assert.equal(readFileSync(marker, "utf8"), "private-before");
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
