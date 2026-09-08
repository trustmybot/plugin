#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 3_500;
const DISPATCHER_PATH = fileURLToPath(import.meta.url);
const POLICY_PATH = resolve(dirname(DISPATCHER_PATH), "repo-policy.mjs");
const FALLBACK_PLUGIN_ROOT = resolve(dirname(DISPATCHER_PATH), "..", "..", "..");
export const RUNTIME_RELATIVE_PATHS = Object.freeze([
  "adapters/codex/hooks/dispatcher.mjs",
  "adapters/codex/hooks/repo-policy.mjs",
  "adapters/codex/hooks/branch-policy.mjs",
  "adapters/codex/hooks/restricted-runner.mjs",
  "adapters/codex/hooks/restricted-profile.mjs",
  "adapters/codex/hooks/forge-binding.mjs",
  "adapters/codex/tool-names.mjs",
]);
const HOOK_MANIFEST_PATH = "hooks/codex/hooks.json";

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

function rejectDuplicateJsonKeys(source) {
  const stack = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{" || char === "[") stack.push(char === "{" ? new Set() : null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === '"') {
      const start = index++;
      for (; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === '"') break;
      }
      let next = index + 1;
      while (/\s/u.test(source[next] ?? "")) next += 1;
      if (source[next] === ":") {
        const key = JSON.parse(source.slice(start, index + 1));
        const keys = stack.at(-1);
        if (!keys || keys.has(key)) throw new Error("Hook manifest contains duplicate keys");
        keys.add(key);
      }
    }
  }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function normalizeHookManifest(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 256 * 1024) {
    throw new Error("Hook manifest is missing or oversized");
  }
  const manifest = JSON.parse(source);
  rejectDuplicateJsonKeys(source);
  if (!exactKeys(manifest, ["hooks"]) || !exactKeys(manifest.hooks, ["PreToolUse"])) {
    throw new Error("Hook manifest has an unknown shape");
  }
  const entries = manifest.hooks.PreToolUse;
  if (!Array.isArray(entries) || entries.length !== 1 || !exactKeys(entries[0], ["matcher", "hooks"])
    || entries[0].matcher !== "" || !Array.isArray(entries[0].hooks) || entries[0].hooks.length !== 1) {
    throw new Error("Hook manifest must contain one unconditional PreToolUse command");
  }
  const hook = entries[0].hooks[0];
  if (!exactKeys(hook, ["type", "command", "timeout"]) || hook.type !== "command"
    || typeof hook.command !== "string" || !Number.isSafeInteger(hook.timeout) || hook.timeout <= 0) {
    throw new Error("Hook command has an unknown shape");
  }
  const matches = [...hook.command.matchAll(/(^|\s)--policy-sha256 ([a-f0-9]{64})(?=$|[\s;])/gu)];
  if (matches.length !== 1 || hook.command.split("--policy-sha256").length !== 2) {
    throw new Error("Hook command must contain exactly one valid policy digest");
  }
  hook.command = hook.command.replace(matches[0][0], `${matches[0][1]}--policy-sha256 ${"0".repeat(64)}`);
  return JSON.stringify(manifest);
}

export function calculateRuntimeDigest(pluginRoot = FALLBACK_PLUGIN_ROOT) {
  const hash = createHash("sha256");
  for (const [index, path] of RUNTIME_RELATIVE_PATHS.entries()) {
    if (index > 0) hash.update("\0");
    hash.update(readFileSync(resolve(pluginRoot, path)));
  }
  return hash.update("\0").update(normalizeHookManifest(readFileSync(resolve(pluginRoot, HOOK_MANIFEST_PATH), "utf8"))).digest("hex");
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
    actualDigest = calculateRuntimeDigest();
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

function attestationCoversInputCwd(input, repoAttestation) {
  try {
    const root = realpathSync(repoAttestation.root);
    const cwd = realpathSync(input.cwd);
    const pathFromRoot = relative(root, cwd);
    return pathFromRoot === ""
      || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`)
        && !isAbsolute(pathFromRoot));
  } catch {
    return false;
  }
}

async function runAttestedPolicy(input, policyUrl, options) {
  const originalExit = process.exit;
  process.exit = (code) => {
    throw new Error(`policy requested process exit ${String(code ?? 0)}`);
  };
  try {
    const policy = await import(policyUrl);
    if (typeof policy.evaluatePreToolUse !== "function") {
      return denyOutput("policy returned no auditable decision");
    }
    const result = await policy.evaluatePreToolUse(input, options);
    return workerResultOutput(result);
  } catch {
    return denyOutput("policy evaluation crashed");
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
  if (options.repoAttestation === undefined
    || !attestationCoversInputCwd(prepared.input, options.repoAttestation)) {
    output = await runPolicyWorker(prepared.input, prepared.policyUrl, {
      ...options,
      repoAttestation: undefined,
    });
  } else {
    output = await runAttestedPolicy(prepared.input, prepared.policyUrl, options);
  }
  if (output === "") {
    return;
  }
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

// Importing the fixed layout and pure digest functions in tests must not start
// the Hook. Resolve existing CLI aliases without interpreting another entry's arguments.
let isDirectEntry = Boolean(process.argv[1]) && resolve(process.argv[1]) === DISPATCHER_PATH;
if (!isDirectEntry && process.argv[1]) {
  try { isDirectEntry = realpathSync(process.argv[1]) === DISPATCHER_PATH; }
  catch { /* An unrelated or unavailable entry path does not start this module. */ }
}
if (isDirectEntry) {
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
}
