import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

const MODES = new Set(["validation", "git-read", "git-local", "forge", "git-push"]);
const DYLD_PROFILE = "/System/Library/Sandbox/Profiles/dyld-support.sb";

function pathValue(value, label) {
  if (typeof value !== "string" || value === "/" || !isAbsolute(value)
    || normalize(value) !== value || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new TypeError(`${label} must be a canonical absolute path other than /`);
  }
  return value;
}

function pathList(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array of canonical paths`);
  return [...new Set(values.map((value) => pathValue(value, label)))];
}

function within(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function literal(path) {
  return `(literal ${JSON.stringify(path)})`;
}

function subpath(path) {
  return `(subpath ${JSON.stringify(path)})`;
}

// Protect actual mixed-case directory names as well as filesystem aliases.
// ASCII character classes avoid relying on an undocumented regex case flag.
function foldedPathExpression(path, descendants = true) {
  let expression = "^";
  for (const character of path) {
    if (/[a-z]/iu.test(character) && character.codePointAt(0) < 128) {
      expression += `[${character.toLowerCase()}${character.toUpperCase()}]`;
    } else {
      expression += /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
    }
  }
  return `(regex ${JSON.stringify(`${expression}${descendants ? "(/|$)" : "$"}`)})`;
}

function rule(action, operations, filters = []) {
  return `(${action} ${operations}${filters.length ? `\n  ${filters.join("\n  ")}` : ""})`;
}

function renameLocks(writableRoots, protectedRoots) {
  const locks = new Set(writableRoots);
  for (const writable of writableRoots) {
    for (const protectedRoot of protectedRoots) {
      if (!within(writable, protectedRoot)) continue;
      let cursor = dirname(protectedRoot);
      while (within(writable, cursor)) {
        locks.add(cursor);
        if (cursor === writable) break;
        cursor = dirname(cursor);
      }
    }
  }
  return [...locks];
}

/**
 * Build a profile from trusted runner input; this function performs no I/O.
 * The runner must verify real paths, executable provenance, and hard-link-free
 * writable trees before calling it. It must supply fresh scratch and close
 * inherited descriptors other than intentional pipes before target execution.
 */
export function buildRestrictedProfile({
  mode, root, gitDir, commonDir, pluginRoot, pluginData, scratch, readRoots, executables,
}) {
  if (!MODES.has(mode)) throw new TypeError("restricted process mode is not supported");
  root = pathValue(root, "root");
  gitDir = pathValue(gitDir, "gitDir");
  commonDir = pathValue(commonDir, "commonDir");
  pluginRoot = pathValue(pluginRoot, "pluginRoot");
  pluginData = pluginData == null ? null : pathValue(pluginData, "pluginData");
  scratch = pathValue(scratch, "scratch");
  readRoots = pathList(readRoots, "readRoots");
  executables = pathList(executables, "executables");
  const networked = mode === "forge" || mode === "git-push";
  const writableGit = mode === "git-local" || mode === "git-push";
  if (networked && executables.length === 0) {
    throw new TypeError("networked modes require an explicit executable allowlist");
  }

  const stateRoots = [".claude", ".tmb", ".codex"].map((name) => resolve(root, name));
  const protectedRoots = [...stateRoots, pluginRoot, ...(pluginData ? [pluginData] : [])];
  if (!writableGit) protectedRoots.push(resolve(root, ".git"), gitDir, commonDir);
  const writes = [...new Set([
    scratch,
    ...(mode === "validation" ? [root] : []),
    ...(writableGit ? [gitDir, commonDir] : []),
  ])];
  if (protectedRoots.some((path) => within(path, scratch))) {
    throw new TypeError("scratch must not be inside a protected root");
  }
  const reads = [...new Set([root, gitDir, commonDir, pluginRoot, scratch, ...readRoots])];

  const lines = [
    "(version 1)",
    "(deny default)",
    `(import ${JSON.stringify(DYLD_PROFILE)})`,
    "(allow syscall*)",
    "(allow mach-bootstrap)",
    // Go's macOS TLS verification uses SecTrust through this specific agent.
    ...(networked ? ["(allow mach-lookup (global-name \"com.apple.trustd.agent\"))"] : []),
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    "(allow file-map-executable)",
    "(allow signal (target self))",
    networked
      ? rule("allow", "process-exec", executables.map(literal))
      : "(allow process-exec)",
    mode === "git-local" ? "(deny process-fork)" : "(allow process-fork)",
    rule("allow", "file-read*", [...reads.map(subpath), ...executables.map(literal)]),
    rule("allow", "file-read* file-write*", [literal("/dev/null")]),
    rule("allow", "file-read*", [literal("/dev/random"), literal("/dev/urandom")]),
    rule("allow", "file-write*", writes.map(subpath)),
    rule("deny", "file-write*", [...new Set(protectedRoots)].map((path) => foldedPathExpression(path))),
    rule("deny", "file-write-unlink", renameLocks(writes, protectedRoots).map((path) => foldedPathExpression(path, false))),
    networked ? "(allow network*)" : "(deny network*)",
  ];
  // Git and forge helpers have no reason to read another adapter's state either.
  lines.push(rule("deny", "file-read*", [...stateRoots, ...(pluginData ? [pluginData] : [])]
    .map((path) => foldedPathExpression(path))));
  return `${lines.join("\n")}\n`;
}
