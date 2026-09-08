import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";

import { buildRestrictedProfile } from "../../adapters/codex/hooks/restricted-profile.mjs";

const NODE = realpathSync(process.execPath);
const SYSTEM_READ_ROOTS = ["/System", "/usr", "/bin", "/sbin", "/Library/Developer/CommandLineTools", "/opt/homebrew", dirname(NODE)]
  .filter(existsSync).map((path) => realpathSync(path));
let fixtures;
let serial = 0;
let sandboxUnavailable;

before(() => {
  fixtures = realpathSync(mkdtempSync(join(tmpdir(), "tmb-codex-restricted-profile-")));
  if (process.platform !== "darwin") {
    sandboxUnavailable = "restricted-profile integration requires macOS Seatbelt";
    return;
  }
  const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", NODE, "-e", "process.stdout.write('sandbox-ready')"], {
    encoding: "utf8", timeout: 5_000,
  });
  if (probe.status !== 0 || probe.stdout !== "sandbox-ready") {
    sandboxUnavailable = `macOS sandbox is unavailable: ${probe.stderr?.trim() || probe.error?.message || probe.status}`;
  }
});

after(() => { if (fixtures) rmSync(fixtures, { recursive: true, force: true }); });

function requireSandbox(t) {
  if (!sandboxUnavailable) return true;
  t.skip(sandboxUnavailable);
  return false;
}

function project() {
  const base = join(fixtures, String(++serial));
  const root = join(base, "checkout");
  const gitDir = join(root, ".git");
  const commonDir = join(base, "common-git");
  const pluginRoot = join(root, "src", "vendor", "plugin");
  const pluginData = join(base, "plugin-data");
  const scratch = join(base, "scratch");
  const privateRoots = [join(root, ".TMB"), join(root, ".ClAuDe"), join(root, ".CoDeX"), pluginData];
  const protectedRoots = [...privateRoots, gitDir, commonDir, pluginRoot];
  for (const path of [root, gitDir, commonDir, pluginRoot, pluginData, scratch, ...privateRoots]) mkdirSync(path, { recursive: true });
  const source = join(root, "src", "source.txt");
  writeFileSync(source, "source-before\n");
  const markers = protectedRoots.map((path) => join(path, "marker.txt"));
  for (const path of markers) writeFileSync(path, "protected-before\n");
  return { base, root, gitDir, commonDir, pluginRoot, pluginData, scratch, privateRoots, protectedRoots, source, markers };
}

function profile(fixture, mode, executables = [NODE]) {
  return buildRestrictedProfile({
    mode, root: fixture.root, gitDir: fixture.gitDir, commonDir: fixture.commonDir,
    pluginRoot: fixture.pluginRoot, pluginData: fixture.pluginData, scratch: fixture.scratch,
    readRoots: SYSTEM_READ_ROOTS, executables,
  });
}

function run(fixture, mode, source, executables = [NODE]) {
  return spawnSync("/usr/bin/sandbox-exec", ["-p", profile(fixture, mode, executables), NODE, "-e", source], {
    cwd: fixture.root, encoding: "utf8", timeout: 8_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: fixture.scratch, TMPDIR: fixture.scratch, LC_ALL: "C" },
  });
}

function result(fixture, mode, source, executables) {
  const child = run(fixture, mode, source, executables);
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, `sandbox target failed: ${child.stderr}\n${child.stdout}`);
  return JSON.parse(child.stdout);
}

const ATTEMPT = `function attempt(fn) { try { fn(); return "allowed"; } catch (error) { return error.code; } }`;

function assertDenied(value, message) {
  assert.ok(["EPERM", "EACCES"].includes(value), `${message}: expected permission denial, got ${value}`);
}

function unchanged(fixture, except = []) {
  for (const path of fixture.markers) {
    if (!except.includes(path)) assert.equal(readFileSync(path, "utf8"), "protected-before\n", path);
  }
}

test("profile rejects an unknown execution mode", () => {
  const fixture = project();
  assert.throws(() => profile(fixture, "unknown"));
});

test("only networked modes request the exact TLS trust-agent Mach service", () => {
  const fixture = project();
  for (const mode of ["validation", "git-read", "git-local", "forge", "git-push"]) {
    const source = profile(fixture, mode);
    const services = [...source.matchAll(/\(global-name "([^"]+)"\)/gu)].map((match) => match[1]);
    assert.deepEqual(services, ["forge", "git-push"].includes(mode) ? ["com.apple.trustd.agent"] : [], mode);
    assert.doesNotMatch(source, /\(allow mach-lookup\s*\)|global-name-prefix/u, mode);
    if (["validation", "git-read", "git-local"].includes(mode)) assert.match(source, /\(deny network\*\)/u, mode);
  }
});

test("Seatbelt grants the trust-agent lookup only to networked modes and denies other security services", (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const source = join(fixture.scratch, "mach-lookup.c");
  const executable = join(fixture.scratch, "mach-lookup");
  writeFileSync(source, `
    #include <stdio.h>
    #include <mach/mach.h>
    #include <servers/bootstrap.h>
    int main(int argc, char **argv) {
      if (argc != 2) return 2;
      mach_port_t port = MACH_PORT_NULL;
      kern_return_t result = bootstrap_look_up(bootstrap_port, argv[1], &port);
      printf("%d\\n", result);
      if (result == KERN_SUCCESS) mach_port_deallocate(mach_task_self(), port);
      return 0;
    }
  `);
  const compiled = spawnSync("/usr/bin/clang", ["-Wno-deprecated-declarations", source, "-o", executable], {
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(compiled.status, 0, `Mach lookup fixture compilation failed: ${compiled.stderr}`);
  const available = spawnSync(executable, ["com.apple.trustd.agent"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(available.status, 0, available.stderr);
  assert.equal(available.stdout.trim(), "0", "the host trust-agent service must be available for this regression");
  for (const mode of ["validation", "git-read", "git-local", "forge", "git-push"]) {
    for (const service of ["com.apple.trustd.agent", "com.apple.trustd", "com.apple.securityd.xpc"]) {
      const child = spawnSync("/usr/bin/sandbox-exec", ["-p", profile(fixture, mode, [executable]), executable, service], {
        cwd: fixture.root, encoding: "utf8", timeout: 5_000,
        env: { PATH: "/usr/bin:/bin", HOME: fixture.scratch, TMPDIR: fixture.scratch },
      });
      assert.equal(child.status, 0, `${mode}: ${service}: ${child.stderr}`);
      if (["forge", "git-push"].includes(mode) && service === "com.apple.trustd.agent") {
        assert.equal(child.stdout.trim(), "0", `${mode}: TLS trust evaluation service`);
      } else {
        assert.notEqual(child.stdout.trim(), "0", `${mode}: unexpected Mach service access to ${service}`);
        assert.match(child.stdout.trim(), /^\d+$/u);
      }
    }
  }
});

test("every execution mode denies reads of other adapter and pinned plugin state", t => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  for (const mode of ["validation", "git-read", "git-local", "forge", "git-push"]) {
    const reads = result(fixture, mode, `const fs=require('node:fs'); ${ATTEMPT}
      console.log(JSON.stringify(${JSON.stringify(fixture.privateRoots)}.map(root=>attempt(()=>fs.readFileSync(root+'/marker.txt')))));`);
    reads.forEach(value => assertDenied(value, mode));
  }
  unchanged(fixture);
});

test("validation permits ordinary source and private scratch writes", (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const scratchFile = join(fixture.scratch, "output.txt");
  const actual = result(fixture, "validation", `
    const fs = require("node:fs"); ${ATTEMPT}
    console.log(JSON.stringify([
      attempt(() => fs.writeFileSync(${JSON.stringify(fixture.source)}, "source-after\\n")),
      attempt(() => fs.writeFileSync(${JSON.stringify(scratchFile)}, "scratch-output\\n"))
    ]));
  `);
  assert.deepEqual(actual, ["allowed", "allowed"]);
  assert.equal(readFileSync(fixture.source, "utf8"), "source-after\n");
  assert.equal(readFileSync(scratchFile, "utf8"), "scratch-output\n");
  unchanged(fixture);
});

test("validation denies mixed-case governance state reads and every protected write", (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const privateMarkers = fixture.privateRoots.map((path) => join(path, "marker.txt"));
  const actual = result(fixture, "validation", `
    const fs = require("node:fs"); ${ATTEMPT}
    console.log(JSON.stringify({
      writes: ${JSON.stringify(fixture.markers)}.map(path => attempt(() => fs.writeFileSync(path, "changed"))),
      reads: ${JSON.stringify(privateMarkers)}.map(path => attempt(() => fs.readFileSync(path)))
    }));
  `);
  actual.writes.forEach((value, index) => assertDenied(value, fixture.markers[index]));
  actual.reads.forEach((value, index) => assertDenied(value, privateMarkers[index]));
  unchanged(fixture);
});

test("validation protects case aliases of existing Git and plugin directories", (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const aliases = [join(fixture.root, ".GIT", "marker.txt"), join(fixture.root, "src", "VENDOR", "PLUGIN", "marker.txt")];
  const original = [join(fixture.gitDir, "marker.txt"), join(fixture.pluginRoot, "marker.txt")];
  if (!aliases.every((path, index) => existsSync(path) && lstatSync(path).ino === lstatSync(original[index]).ino)) {
    t.skip("fixture volume does not resolve case aliases to the same files");
    return;
  }
  const actual = result(fixture, "validation", `
    const fs = require("node:fs"); ${ATTEMPT}
    console.log(JSON.stringify(${JSON.stringify(aliases)}.map(path => attempt(() => fs.writeFileSync(path, "changed")))));
  `);
  actual.forEach((value, index) => assertDenied(value, aliases[index]));
  unchanged(fixture);
});

test("validation denies new hard links from protected files into writable source", (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const links = fixture.markers.map((_, index) => join(fixture.root, "src", `hardlink-${index}`));
  const actual = result(fixture, "validation", `
    const fs = require("node:fs"); ${ATTEMPT}
    const files = ${JSON.stringify(fixture.markers)}, links = ${JSON.stringify(links)};
    console.log(JSON.stringify(files.map((path, index) => attempt(() => fs.linkSync(path, links[index])))));
  `);
  actual.forEach((value, index) => assertDenied(value, fixture.markers[index]));
  for (const path of links) assert.equal(existsSync(path), false, path);
  unchanged(fixture);
});

test("validation denies renaming protected roots and their writable repository ancestors", (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const sources = [...fixture.protectedRoots, dirname(fixture.pluginRoot), join(fixture.root, "src"), fixture.root];
  const destinations = sources.map((_, index) => join(fixture.scratch, `relocated-${index}`));
  const actual = result(fixture, "validation", `
    const fs = require("node:fs"); ${ATTEMPT}
    const sources = ${JSON.stringify(sources)}, destinations = ${JSON.stringify(destinations)};
    console.log(JSON.stringify(sources.map((path, index) => attempt(() => fs.renameSync(path, destinations[index])))));
  `);
  actual.forEach((value, index) => assertDenied(value, sources[index]));
  for (const path of sources) assert.equal(existsSync(path), true, path);
  for (const path of destinations) assert.equal(existsSync(path), false, path);
  unchanged(fixture);
});

test("ordinary Node subprocesses inherit validation write restrictions", (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const output = join(fixture.scratch, "child-output.txt");
  const childSource = `
    const fs = require("node:fs"); ${ATTEMPT}
    console.log(JSON.stringify({
      source: attempt(() => fs.writeFileSync(${JSON.stringify(fixture.source)}, "child-source\\n")),
      scratch: attempt(() => fs.writeFileSync(${JSON.stringify(output)}, "child-output\\n")),
      protected: ${JSON.stringify(fixture.markers)}.map(path => attempt(() => fs.writeFileSync(path, "changed")))
    }));
  `;
  const actual = result(fixture, "validation", `
    const { execFileSync } = require("node:child_process");
    process.stdout.write(execFileSync(${JSON.stringify(NODE)}, ["-e", ${JSON.stringify(childSource)}], { encoding: "utf8" }));
  `);
  assert.equal(actual.source, "allowed");
  assert.equal(actual.scratch, "allowed");
  actual.protected.forEach((value, index) => assertDenied(value, fixture.markers[index]));
  assert.equal(readFileSync(fixture.source, "utf8"), "child-source\n");
  assert.equal(readFileSync(output, "utf8"), "child-output\n");
  unchanged(fixture);
});

test("git-read permits scratch writes but denies checkout and Git metadata writes", (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const scratchFile = join(fixture.scratch, "git-read-output.txt");
  const paths = [fixture.source, ...fixture.markers];
  const actual = result(fixture, "git-read", `
    const fs = require("node:fs"); ${ATTEMPT}
    console.log(JSON.stringify({
      scratch: attempt(() => fs.writeFileSync(${JSON.stringify(scratchFile)}, "scratch-output\\n")),
      writes: ${JSON.stringify(paths)}.map(path => attempt(() => fs.writeFileSync(path, "changed")))
    }));
  `);
  assert.equal(actual.scratch, "allowed");
  actual.writes.forEach((value, index) => assertDenied(value, paths[index]));
  assert.equal(readFileSync(fixture.source, "utf8"), "source-before\n");
  unchanged(fixture);
});

test("git-local writes Git metadata but cannot alter checkout or start a subprocess", (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const metadata = [join(fixture.gitDir, "marker.txt"), join(fixture.commonDir, "marker.txt")];
  const forbidden = [fixture.source, ...fixture.markers.filter((path) => !metadata.includes(path))];
  const actual = result(fixture, "git-local", `
    const fs = require("node:fs"), { spawnSync } = require("node:child_process"); ${ATTEMPT}
    const child = spawnSync(${JSON.stringify(NODE)}, ["-e", "process.stdout.write('unexpected-child')"], { encoding: "utf8" });
    console.log(JSON.stringify({
      metadata: ${JSON.stringify(metadata)}.map(path => attempt(() => fs.writeFileSync(path, "metadata-after\\n"))),
      forbidden: ${JSON.stringify(forbidden)}.map(path => attempt(() => fs.writeFileSync(path, "changed"))),
      child: { code: child.error?.code, status: child.status, stdout: child.stdout }
    }));
  `);
  assert.deepEqual(actual.metadata, ["allowed", "allowed"]);
  actual.forbidden.forEach((value, index) => assertDenied(value, forbidden[index]));
  assertDenied(actual.child.code, "git-local subprocess creation");
  assert.notEqual(actual.child.stdout, "unexpected-child");
  for (const path of metadata) assert.equal(readFileSync(path, "utf8"), "metadata-after\n");
  assert.equal(readFileSync(fixture.source, "utf8"), "source-before\n");
  unchanged(fixture, metadata);
});

test("forge permits only the fixed executable set and leaves checkout and Git metadata read-only", (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const allowed = realpathSync("/usr/bin/true");
  const forbidden = realpathSync("/usr/bin/false");
  const paths = [fixture.source, ...fixture.markers];
  const actual = result(fixture, "forge", `
    const fs = require("node:fs"), { spawnSync } = require("node:child_process"); ${ATTEMPT}
    const allowed = spawnSync(${JSON.stringify(allowed)}, [], { encoding: "utf8" });
    const forbidden = spawnSync(${JSON.stringify(forbidden)}, [], { encoding: "utf8" });
    console.log(JSON.stringify({
      allowed: { code: allowed.error?.code, status: allowed.status },
      forbidden: { code: forbidden.error?.code, status: forbidden.status },
      writes: ${JSON.stringify(paths)}.map(path => attempt(() => fs.writeFileSync(path, "changed")))
    }));
  `, [NODE, allowed]);
  assert.deepEqual(actual.allowed, { status: 0 });
  assertDenied(actual.forbidden.code, "unlisted forge executable");
  actual.writes.forEach((value, index) => assertDenied(value, paths[index]));
  unchanged(fixture);
});

test("git-push permits Git metadata and scratch writes while preserving checkout state", (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const metadata = [join(fixture.gitDir, "marker.txt"), join(fixture.commonDir, "marker.txt")];
  const forbidden = [fixture.source, ...fixture.markers.filter((path) => !metadata.includes(path))];
  const scratchFile = join(fixture.scratch, "push-output.txt");
  const actual = result(fixture, "git-push", `
    const fs = require("node:fs"); ${ATTEMPT}
    console.log(JSON.stringify({
      allowed: ${JSON.stringify([...metadata, scratchFile])}.map(path => attempt(() => fs.writeFileSync(path, "metadata-after\\n"))),
      forbidden: ${JSON.stringify(forbidden)}.map(path => attempt(() => fs.writeFileSync(path, "changed")))
    }));
  `);
  assert.deepEqual(actual.allowed, ["allowed", "allowed", "allowed"]);
  actual.forbidden.forEach((value, index) => assertDenied(value, forbidden[index]));
  assert.equal(readFileSync(fixture.source, "utf8"), "source-before\n");
  unchanged(fixture, metadata);
});

test("local modes deny loopback connections while forge and git-push can connect", async (t) => {
  if (!requireSandbox(t)) return;
  const fixture = project();
  const server = createServer((socket) => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address().port;
    const source = `
      const socket = require("node:net").createConnection({ host: "127.0.0.1", port: ${port} });
      let finished = false;
      function finish(value) { if (finished) return; finished = true; console.log(JSON.stringify(value)); socket.destroy(); }
      socket.on("connect", () => finish("connected"));
      socket.on("error", error => finish(error.code));
      socket.setTimeout(2_000, () => finish("timed-out"));
    `;
    for (const mode of ["validation", "git-read", "git-local"]) assertDenied(result(fixture, mode, source), `${mode} loopback connection`);
    for (const mode of ["forge", "git-push"]) assert.equal(result(fixture, mode, source), "connected", `${mode} loopback connection`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
