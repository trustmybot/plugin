#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

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

function preparePolicyInput(raw, expectedDigest) {
  let actualDigest;
  try {
    actualDigest = actualRuntimeDigest();
  } catch {
    return { output: denyOutput("runtime policy files cannot be read") };
  }
  if (!digestMatches(expectedDigest, actualDigest)) {
    return { output: denyOutput("runtime policy digest mismatch") };
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { output: denyOutput("hook input is not valid JSON") };
  }

  return {
    input,
    policyUrl: `${pathToFileURL(POLICY_PATH).href}?sha256=${actualDigest}`,
  };
}

function workerResultOutput(result) {
  if (result?.decision === "allow") {
    return "";
  }
  if (result?.decision === "deny" && typeof result.reason === "string" && result.reason.length > 0) {
    return denyOutput(result.reason);
  }
  return denyOutput("policy returned no auditable decision");
}

function repoAttestationFromEnv() {
  const attestation = {
    root: process.env.TMB_CODEX_HOOK_ROOT,
    gitDir: process.env.TMB_CODEX_HOOK_GIT_DIR,
    commonDir: process.env.TMB_CODEX_HOOK_COMMON_DIR,
  };
  const values = Object.values(attestation);
  return values.every((value) => typeof value === "string" && value.length > 0)
    ? attestation
    : undefined;
}

function policyOptions() {
  return {
    pluginRoot: process.env.PLUGIN_ROOT || FALLBACK_PLUGIN_ROOT,
    pluginData: process.env.PLUGIN_DATA || null,
    repoAttestation: repoAttestationFromEnv(),
  };
}

async function runAttestedPolicy(input, policyUrl, options) {
  const originalExit = process.exit;
  process.exit = (code) => {
    throw new Error(`policy requested process exit ${String(code ?? 0)}`);
  };
  try {
    const policy = await import(policyUrl);
    if (typeof policy.evaluatePreToolUse !== "function") {
      return {
        output: denyOutput("policy returned no auditable decision"),
        retryUnattested: false,
      };
    }
    const result = await policy.evaluatePreToolUse(input, options);
    return {
      output: workerResultOutput(result),
      retryUnattested: result?.decision === "deny"
        && result.reason === "TMB-CODEX-HOOK: tool call is not attached to a branch-backed Git checkout",
    };
  } catch {
    return {
      output: denyOutput("policy evaluation crashed"),
      retryUnattested: false,
    };
  } finally {
    process.exit = originalExit;
  }
}

function runPolicyWorker(input, policyUrl, options) {
  return new Promise((resolveWorker) => {
    let settled = false;
    const worker = new Worker(new URL(policyUrl), {
      workerData: {
        mode: "evaluate-pre-tool-use",
        input,
        options,
      },
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

    worker.once("message", (result) => {
      settle(workerResultOutput(result));
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

  const prepared = preparePolicyInput(raw, expectedDigest);
  if (prepared.output !== undefined) {
    process.stdout.write(prepared.output);
    return;
  }

  const options = policyOptions();
  let output;
  if (options.repoAttestation === undefined) {
    output = await runPolicyWorker(prepared.input, prepared.policyUrl, options);
  } else {
    const attestedResult = await runAttestedPolicy(prepared.input, prepared.policyUrl, options);
    output = attestedResult.retryUnattested
      ? await runPolicyWorker(prepared.input, prepared.policyUrl, {
          ...options,
          repoAttestation: undefined,
        })
      : attestedResult.output;
  }
  if (output === "") {
    return;
  }
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

try {
  const expectedDigest = expectedDigestFromArgs(process.argv.slice(2));
  if (!expectedDigest) {
    process.stdout.write(denyOutput("runtime policy digest is missing or malformed"));
  } else {
    await supervisorMain(expectedDigest);
  }
} catch {
  process.stdout.write(denyOutput("dispatcher failed closed"));
}
