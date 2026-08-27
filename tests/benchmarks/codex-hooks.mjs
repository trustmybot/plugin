import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "hooks", "codex", "hooks.json"), "utf8"));
const manifestCommand = manifest.hooks.PreToolUse[0].hooks[0].command;
const manifestTimeoutMs = manifest.hooks.PreToolUse[0].hooks[0].timeout * 1_000;
const fixture = mkdtempSync(join(tmpdir(), "tmb-codex-hook-bench-"));
const fixtureRepo = join(fixture, "repo");
mkdirSync(fixtureRepo);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fixtureRepo });
const input = JSON.stringify({
  cwd: fixtureRepo,
  hook_event_name: "PreToolUse",
  model: "gpt-test",
  permission_mode: "default",
  session_id: "benchmark-session",
  tool_input: { command: "pwd" },
  tool_name: "Bash",
  tool_use_id: "benchmark-tool",
  transcript_path: null,
  turn_id: "benchmark-turn",
});

function invoke() {
  const started = process.hrtime.bigint();
  const result = spawnSync("/bin/sh", ["-c", manifestCommand], {
    cwd: fixtureRepo,
    encoding: "utf8",
    env: {
      ...process.env,
      PLUGIN_DATA: "",
      PLUGIN_ROOT: root,
    },
    input,
    maxBuffer: 64 * 1024,
    timeout: manifestTimeoutMs,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  return elapsedMs;
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

let coldMs;
let warm;
try {
  coldMs = invoke();
  warm = Array.from({ length: 40 }, invoke).sort((left, right) => left - right);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
const medianMs = percentile(warm, 0.5);
const p95Ms = percentile(warm, 0.95);

const report = {
  schema_version: 1,
  samples: warm.length,
  cold_ms: Number(coldMs.toFixed(3)),
  warm_median_ms: Number(medianMs.toFixed(3)),
  warm_p95_ms: Number(p95Ms.toFixed(3)),
  limits_ms: {
    cold: 1_000,
    warm_median: 100,
    warm_p95: 250,
    manifest_timeout: manifestTimeoutMs,
  },
};

process.stdout.write(`${JSON.stringify(report)}\n`);
assert.ok(coldMs <= report.limits_ms.cold, `cold ${coldMs.toFixed(3)}ms exceeds 1000ms`);
assert.ok(medianMs <= report.limits_ms.warm_median, `median ${medianMs.toFixed(3)}ms exceeds 100ms`);
assert.ok(p95Ms <= report.limits_ms.warm_p95, `p95 ${p95Ms.toFixed(3)}ms exceeds 250ms`);
