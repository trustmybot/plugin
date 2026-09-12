#!/usr/bin/env node

// Independent build-time integrity oracle. Do not import the runtime being checked.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_PATHS = Object.freeze([
  "adapters/codex/hooks/dispatcher.mjs",
  "adapters/codex/hooks/repo-policy.mjs",
  "adapters/codex/hooks/branch-policy.mjs",
  "adapters/codex/hooks/restricted-runner.mjs",
  "adapters/codex/hooks/restricted-profile.mjs",
  "adapters/codex/hooks/forge-binding.mjs",
  "adapters/codex/tool-names.mjs",
]);
const MANIFEST_PATH = "hooks/codex/hooks.json";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function assertUniqueKeys(source) {
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

function hasOnly(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function normalizeManifest(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 256 * 1024) {
    throw new Error("Hook manifest is missing or oversized");
  }
  const manifest = JSON.parse(source);
  assertUniqueKeys(source);
  if (!hasOnly(manifest, ["hooks"]) || !hasOnly(manifest.hooks, ["PreToolUse"])) {
    throw new Error("Hook manifest has an unknown shape");
  }
  const entries = manifest.hooks.PreToolUse;
  if (!Array.isArray(entries) || entries.length !== 1 || !hasOnly(entries[0], ["matcher", "hooks"])
    || entries[0].matcher !== "" || !Array.isArray(entries[0].hooks) || entries[0].hooks.length !== 1) {
    throw new Error("Hook manifest must contain one unconditional PreToolUse command");
  }
  const hook = entries[0].hooks[0];
  if (!hasOnly(hook, ["type", "command", "timeout"]) || hook.type !== "command"
    || typeof hook.command !== "string" || !Number.isSafeInteger(hook.timeout) || hook.timeout <= 0) {
    throw new Error("Hook command has an unknown shape");
  }
  const matches = [...hook.command.matchAll(/(^|\s)--policy-sha256 ([a-f0-9]{64})(?=$|[\s;])/gu)];
  if (matches.length !== 1 || hook.command.split("--policy-sha256").length !== 2) {
    throw new Error("Hook command must contain exactly one valid policy digest");
  }
  const expectedDigest = matches[0][2];
  hook.command = hook.command.replace(matches[0][0], `${matches[0][1]}--policy-sha256 ${"0".repeat(64)}`);
  return { normalized: JSON.stringify(manifest), expectedDigest };
}

export function readDigestState(pluginRoot) {
  const manifestPath = resolve(pluginRoot, MANIFEST_PATH);
  const source = readFileSync(manifestPath, "utf8");
  const { normalized, expectedDigest } = normalizeManifest(source);
  const hash = createHash("sha256");
  for (const [index, path] of RUNTIME_PATHS.entries()) {
    if (index > 0) hash.update("\0");
    hash.update(readFileSync(resolve(pluginRoot, path)));
  }
  const actualDigest = hash.update("\0").update(normalized).digest("hex");
  return { actualDigest, expectedDigest, manifestPath, source };
}

function main(argv) {
  let pluginRoot = resolve(dirname(SCRIPT_PATH), "..", "..");
  let mode = "--check";
  let explicitMode = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root" && typeof argv[index + 1] === "string") {
      pluginRoot = resolve(argv[++index]);
    } else if (["--check", "--print", "--write", "--manifest-check"].includes(argv[index]) && !explicitMode) {
      mode = argv[index];
      explicitMode = true;
    } else {
      throw new Error("Usage: update-codex-hook-digest.mjs [--check|--print|--write|--manifest-check] [--root PATH]");
    }
  }
  if (mode === "--manifest-check") {
    normalizeManifest(readFileSync(resolve(pluginRoot, MANIFEST_PATH), "utf8"));
    return;
  }
  const { actualDigest, expectedDigest, manifestPath, source } = readDigestState(pluginRoot);
  if (mode === "--write") {
    // Preserve launcher bytes and human formatting; normalization is only for hashing.
    const needle = `--policy-sha256 ${expectedDigest}`;
    if (source.split(needle).length !== 2) throw new Error("Manifest digest must use one literal unescaped argument");
    writeFileSync(manifestPath, source.replace(needle, `--policy-sha256 ${actualDigest}`));
  } else if (mode === "--check" && actualDigest !== expectedDigest) {
    throw new Error(`manifest digest mismatch (expected ${expectedDigest}, actual ${actualDigest})`);
  }
  process.stdout.write(`${actualDigest}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`codex-hook-digest: ${error.message}`); process.exitCode = 1; }
}
