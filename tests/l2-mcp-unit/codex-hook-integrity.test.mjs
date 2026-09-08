import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { RUNTIME_RELATIVE_PATHS, calculateRuntimeDigest, normalizeHookManifest } from "../../adapters/codex/hooks/dispatcher.mjs";
import { RUNTIME_PATHS, normalizeManifest, readDigestState } from "../../scripts/maintenance/update-codex-hook-digest.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DISPATCHER = "adapters/codex/hooks/dispatcher.mjs";
const MANIFEST = "hooks/codex/hooks.json";
const MAINTENANCE = join(ROOT, "scripts/maintenance/update-codex-hook-digest.mjs");
const ORIGINAL_MANIFEST = readFileSync(join(ROOT, MANIFEST), "utf8");

function manifestWith(change) {
  const manifest = JSON.parse(ORIGINAL_MANIFEST);
  change(manifest, manifest.hooks.PreToolUse[0].hooks[0]);
  return JSON.stringify(manifest);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tmb-codex-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of RUNTIME_RELATIVE_PATHS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    // Deliberate inert fixture modules: this suite tests integrity before policy imports.
    writeFileSync(join(root, path), `// fixture for ${path}\n`);
  }
  copyFileSync(join(ROOT, DISPATCHER), join(root, DISPATCHER));
  writeFileSync(join(root, "adapters/codex/hooks/repo-policy.mjs"), `
    import { parentPort, workerData } from "node:worker_threads";
    export function evaluatePreToolUse() { return { decision: "allow" }; }
    if (workerData?.mode === "evaluate-pre-tool-use") parentPort?.postMessage(evaluatePreToolUse());
  `);
  mkdirSync(dirname(join(root, MANIFEST)), { recursive: true });
  writeFileSync(join(root, MANIFEST), ORIGINAL_MANIFEST);
  return root;
}

function dispatch(root, digest) {
  return spawnSync(process.execPath, [join(root, DISPATCHER), "--policy-sha256", digest], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    input: JSON.stringify({ cwd: root, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }),
    timeout: 5_000,
  });
}

function assertDeny(result, reason) {
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, reason);
}

test("dispatcher imports expose integrity functions without starting its Hook entry", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const runtime = await import(${JSON.stringify(pathToFileURL(join(ROOT, DISPATCHER)).href)});
    console.log(typeof runtime.calculateRuntimeDigest);
  `], { input: "{malformed input", encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "function\n");
  assert.equal(result.stderr, "");
});

test("runtime and independent build oracle pin the same seven modules and manifest bytes", (t) => {
  assert.deepEqual(RUNTIME_RELATIVE_PATHS, RUNTIME_PATHS);
  assert.equal(new Set(RUNTIME_PATHS).size, 7);
  const root = fixture(t);
  assert.equal(calculateRuntimeDigest(root), readDigestState(root).actualDigest);
  const result = dispatch(root, calculateRuntimeDigest(root));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("manifest normalization removes only the sole digest value and JSON whitespace", () => {
  const altered = manifestWith((_manifest, hook) => {
    hook.command = hook.command.replace(/--policy-sha256 [a-f0-9]{64}/u, `--policy-sha256 ${"a".repeat(64)}`);
  });
  const expected = normalizeHookManifest(ORIGINAL_MANIFEST);
  assert.equal(normalizeHookManifest(altered), expected);
  assert.equal(normalizeHookManifest(JSON.stringify(JSON.parse(altered), null, 4)), expected);
  assert.equal(normalizeManifest(altered).normalized, expected);
  const normalized = JSON.parse(expected);
  const original = JSON.parse(ORIGINAL_MANIFEST);
  assert.equal(normalized.hooks.PreToolUse[0].hooks[0].timeout, original.hooks.PreToolUse[0].hooks[0].timeout);
  assert.equal(normalized.hooks.PreToolUse[0].hooks[0].command,
    original.hooks.PreToolUse[0].hooks[0].command.replace(/--policy-sha256 [a-f0-9]{64}/u, `--policy-sha256 ${"0".repeat(64)}`));
});

test("manifest shape rejects ambiguous command cardinality, unknown fields, and invalid digests", () => {
  const cases = [
    manifestWith((manifest) => { manifest.hooks.PreToolUse = []; }),
    manifestWith((manifest) => { manifest.hooks.PreToolUse.push(manifest.hooks.PreToolUse[0]); }),
    manifestWith((manifest) => { manifest.hooks.PreToolUse[0].hooks = []; }),
    manifestWith((manifest, hook) => { manifest.hooks.PreToolUse[0].hooks.push(hook); }),
    manifestWith((manifest) => { manifest.extra = true; }),
    manifestWith((manifest) => { manifest.hooks.PostToolUse = []; }),
    manifestWith((manifest) => { manifest.hooks.PreToolUse[0].matcher = "Bash"; }),
    manifestWith((manifest) => { manifest.hooks.PreToolUse[0].extra = true; }),
    manifestWith((_manifest, hook) => { hook.extra = true; }),
    manifestWith((_manifest, hook) => { hook.type = "prompt"; }),
    ...[0, -1, 1.5, "5", null].map((timeout) => manifestWith((_manifest, hook) => { hook.timeout = timeout; })),
    manifestWith((_manifest, hook) => { hook.command = "node dispatcher.mjs"; }),
    manifestWith((_manifest, hook) => { hook.command += ` --policy-sha256 ${"0".repeat(64)}`; }),
    manifestWith((_manifest, hook) => { hook.command += " --policy-sha256 invalid"; }),
    manifestWith((_manifest, hook) => { hook.command = hook.command.replace(/--policy-sha256 [a-f0-9]{64}/u, "--policy-sha256 malformed"); }),
    manifestWith((_manifest, hook) => { hook.command = hook.command.replace(/(--policy-sha256 [a-f0-9]{64})/u, "$1f"); }),
    ORIGINAL_MANIFEST.replace('"timeout": 5', '"timeout": 5, "timeout": 5'),
    ORIGINAL_MANIFEST.replace('"timeout": 5', '"timeout": 5, "time\\u006fut": 5'),
    " ".repeat(256 * 1024) + ORIGINAL_MANIFEST,
  ];
  for (const [index, source] of cases.entries()) {
    assert.throws(() => normalizeHookManifest(source), undefined, `runtime case ${index}`);
    assert.throws(() => normalizeManifest(source), undefined, `oracle case ${index}`);
  }
});

test("timeout, environment cleanup, and watchdog launcher changes invalidate the artifact digest", (t) => {
  const root = fixture(t);
  const digest = calculateRuntimeDigest(root);
  const variants = [
    manifestWith((_manifest, hook) => { hook.timeout = 6; }),
    manifestWith((_manifest, hook) => { hook.command = hook.command.replace("/usr/bin/env -i", "/usr/bin/env"); }),
    manifestWith((_manifest, hook) => { hook.command = hook.command.replace("/bin/sleep 4", "/bin/sleep 40"); }),
  ];
  for (const source of variants) {
    assert.notEqual(source, ORIGINAL_MANIFEST);
    writeFileSync(join(root, MANIFEST), source);
    assert.notEqual(calculateRuntimeDigest(root), digest);
    assert.equal(calculateRuntimeDigest(root), readDigestState(root).actualDigest);
    assertDeny(dispatch(root, digest), /digest mismatch/u);
  }
});

test("mutation of each pinned module denies before policy evaluation", (t) => {
  const root = fixture(t);
  const digest = calculateRuntimeDigest(root);
  for (const path of RUNTIME_RELATIVE_PATHS) {
    const original = readFileSync(join(root, path));
    writeFileSync(join(root, path), Buffer.concat([original, Buffer.from("\n// integrity mutation\n")]));
    assert.notEqual(calculateRuntimeDigest(root), digest, path);
    assertDeny(dispatch(root, digest), /digest mismatch/u);
    writeFileSync(join(root, path), original);
  }
});

test("a malformed or duplicate-key manifest denies before policy evaluation", (t) => {
  const root = fixture(t);
  const digest = calculateRuntimeDigest(root);
  for (const source of ["{}", ORIGINAL_MANIFEST.replace('"timeout": 5', '"timeout": 5, "timeout": 5')]) {
    writeFileSync(join(root, MANIFEST), source);
    assertDeny(dispatch(root, digest), /policy files cannot be read/u);
  }
});

test("maintenance write updates only the embedded digest and check detects later drift", (t) => {
  const root = fixture(t);
  const digest = calculateRuntimeDigest(root);
  const run = (...args) => spawnSync(process.execPath, [MAINTENANCE, ...args, "--root", root], {
    encoding: "utf8", timeout: 5_000,
  });
  const written = run("--write");
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.stdout.trim(), digest);
  assert.equal(readFileSync(join(root, MANIFEST), "utf8"),
    ORIGINAL_MANIFEST.replace(/--policy-sha256 [a-f0-9]{64}/u, `--policy-sha256 ${digest}`));
  assert.equal(calculateRuntimeDigest(root), digest);
  assert.equal(run("--check").status, 0);
  writeFileSync(join(root, "adapters/codex/tool-names.mjs"), "// changed pure metadata\n");
  const stale = run("--check");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /manifest digest mismatch/u);
  assert.equal(run("--print").stdout.trim(), calculateRuntimeDigest(root));
});
