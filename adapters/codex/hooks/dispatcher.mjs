#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 3_500;
const DISPATCHER_PATH = fileURLToPath(import.meta.url);
const POLICY_PATH = resolve(dirname(DISPATCHER_PATH), "repo-policy.mjs");
const FALLBACK_PLUGIN_ROOT = resolve(dirname(DISPATCHER_PATH), "..", "..", "..");

function denyOutput(reason) {
  const stableReason = reason.startsWith("TMB-CODEX-HOOK:")
    ? reason
    : `TMB-CODEX-HOOK: ${reason}`;
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: stableReason,
    },
  })}\n`;
}

function expectedDigestFromArgs(argv) {
  const index = argv.indexOf("--policy-sha256");
  if (index < 0 || index + 1 >= argv.length) {
    return null;
  }
  const digest = argv[index + 1];
  return /^[a-f0-9]{64}$/u.test(digest) ? digest : null;
}

function actualRuntimeDigest() {
  return createHash("sha256")
    .update(readFileSync(DISPATCHER_PATH))
    .update("\0")
    .update(readFileSync(POLICY_PATH))
    .digest("hex");
}

function digestMatches(expected, actual) {
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(actual, "hex");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) {
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function evaluateRawInput(raw, expectedDigest) {
  let actualDigest;
  try {
    actualDigest = actualRuntimeDigest();
  } catch {
    return denyOutput("runtime policy files cannot be read");
  }
  if (!digestMatches(expectedDigest, actualDigest)) {
    return denyOutput("runtime policy digest mismatch");
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return denyOutput("hook input is not valid JSON");
  }

  const policyUrl = `${pathToFileURL(POLICY_PATH).href}?sha256=${actualDigest}`;
  const { evaluatePreToolUse } = await import(policyUrl);
  const result = await evaluatePreToolUse(input, {
    pluginRoot: process.env.PLUGIN_ROOT || FALLBACK_PLUGIN_ROOT,
    pluginData: process.env.PLUGIN_DATA || null,
  });
  if (result?.decision === "allow") {
    return "";
  }
  return denyOutput(
    typeof result?.reason === "string" && result.reason.length > 0
      ? result.reason
      : "policy returned no auditable decision",
  );
}

function isValidWorkerDeny(output) {
  try {
    const parsed = JSON.parse(output);
    const specific = parsed?.hookSpecificOutput;
    return specific?.hookEventName === "PreToolUse"
      && specific?.permissionDecision === "deny"
      && typeof specific?.permissionDecisionReason === "string"
      && specific.permissionDecisionReason.startsWith("TMB-CODEX-HOOK:");
  } catch {
    return false;
  }
}

function runPolicyWorker(raw, expectedDigest) {
  return new Promise((resolveWorker) => {
    let settled = false;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { mode: "policy", raw, expectedDigest },
    });
    worker.unref();

    const settle = (output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveWorker(output);
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      settle(denyOutput("policy worker crashed or exceeded its internal timeout"));
    }, WORKER_TIMEOUT_MS);

    worker.once("message", (output) => {
      if (typeof output !== "string" || (output !== "" && !isValidWorkerDeny(output))) {
        settle(denyOutput("policy worker returned invalid output"));
        return;
      }
      settle(output);
    });
    worker.once("error", () => {
      settle(denyOutput("policy worker crashed or exceeded its internal timeout"));
    });
    worker.once("exit", (code) => {
      if (!settled) {
        settle(denyOutput(code === 0
          ? "policy worker exited without a decision"
          : "policy worker crashed or exceeded its internal timeout"));
      }
    });
  });
}

async function supervisorMain(expectedDigest) {
  const raw = await readStdin();
  if (raw === null) {
    process.stdout.write(denyOutput("hook input exceeds the 8 MiB limit"));
    return;
  }

  const output = await runPolicyWorker(raw, expectedDigest);
  if (output === "") {
    return;
  }
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

try {
  if (!isMainThread && workerData?.mode === "policy") {
    const output = await evaluateRawInput(workerData.raw, workerData.expectedDigest);
    parentPort?.postMessage(output);
  } else {
    const expectedDigest = expectedDigestFromArgs(process.argv.slice(2));
    if (!expectedDigest) {
      process.stdout.write(denyOutput("runtime policy digest is missing or malformed"));
    } else {
      await supervisorMain(expectedDigest);
    }
  }
} catch {
  if (!isMainThread) {
    parentPort?.postMessage(denyOutput("policy worker crashed or exceeded its internal timeout"));
  } else {
    process.stdout.write(denyOutput("dispatcher failed closed"));
  }
}
