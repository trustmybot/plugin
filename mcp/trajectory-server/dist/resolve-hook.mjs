// src/hooks/resolve-hook.ts
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, constants as osConstants } from "node:os";
import { join } from "node:path";
var FailOpen = class extends Error {
};
function parseArgs(argv) {
  const args = { marketplace: "", hook: "", part: "", shim: false, project: "", passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--marketplace":
        args.marketplace = argv[++i] ?? "";
        break;
      case "--hook":
        args.hook = argv[++i] ?? "";
        break;
      case "--part":
        args.part = argv[++i] ?? "";
        break;
      case "--project":
        args.project = argv[++i] ?? "";
        break;
      case "--shim":
        args.shim = true;
        break;
      default:
        args.passthrough.push(arg);
    }
  }
  return args;
}
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function manifestInstallPath(claudeHome, marketplace) {
  try {
    const manifest = JSON.parse(readFileSync(join(claudeHome, "plugins", "installed_plugins.json"), "utf8"));
    const entries = manifest?.plugins?.[`tmb@${marketplace}`];
    if (!Array.isArray(entries)) return "";
    const paths = entries.map((e) => e && typeof e === "object" ? e.installPath : void 0).filter((p) => typeof p === "string" && p !== "");
    return paths.at(-1) ?? "";
  } catch {
    return "";
  }
}
function leadingNumber(field) {
  const m = /^\d+/.exec(field ?? "");
  return m ? Number(m[0]) : 0;
}
function naturalCompare(a, b) {
  const pa = a.split(/(\d+)/);
  const pb = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const numeric = i % 2 === 1;
    if (numeric) return Number(pa[i]) - Number(pb[i]) || pa[i].length - pb[i].length;
    return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}
function compareVersions(a, b) {
  const fa = a.split(".");
  const fb = b.split(".");
  for (let i = 0; i < 3; i++) {
    const d = leadingNumber(fa[i]) - leadingNumber(fb[i]);
    if (d !== 0) return d;
  }
  return naturalCompare(a, b);
}
function highestCachedVersion(claudeHome, marketplace) {
  const cacheTmb = join(claudeHome, "plugins", "cache", marketplace, "tmb");
  let names;
  try {
    names = readdirSync(cacheTmb, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return "";
  }
  const best = names.sort(compareVersions).at(-1);
  return best === void 0 ? "" : join(cacheTmb, best);
}
function physicalPath(path) {
  try {
    return isDir(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}
function signalExit(signal) {
  return 128 + (osConstants.signals[signal] ?? 0);
}
function resolveAndRun(args) {
  if (args.marketplace === "" || args.hook === "") throw new FailOpen("missing --marketplace/--hook arg");
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), ".claude");
  let versionRoot = manifestInstallPath(claudeHome, args.marketplace);
  if (versionRoot === "" || !isDir(versionRoot)) versionRoot = highestCachedVersion(claudeHome, args.marketplace);
  if (versionRoot === "" || !isDir(versionRoot)) {
    throw new FailOpen("no active tmb version resolved (manifest + cache fallback both empty)");
  }
  if (!/^[A-Z]/.test(args.hook)) {
    throw new FailOpen(`--hook ${args.hook} is not a hook event (re-run /onboard to rewrite the shim)`);
  }
  if (!/^[A-Za-z-]*$/.test(args.hook + args.part)) throw new FailOpen("invalid --hook/--part");
  const router = join(versionRoot, "mcp", "trajectory-server", "dist", "hooks.js");
  if (!isFile(router)) throw new FailOpen(`resolved version has no router at ${router}`);
  const routerArgs = [args.hook, ...args.part !== "" ? [args.part] : [], ...args.shim ? ["--shim"] : []];
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: versionRoot };
  if (args.shim) env.TMB_SHIM_PROJECT = physicalPath(args.project);
  const result = spawnSync(process.execPath, [router, ...routerArgs, ...args.passthrough], { stdio: "inherit", env });
  if (result.error) throw new FailOpen(`router failed to start: ${result.error.message}`);
  if (result.signal) return signalExit(result.signal);
  return result.status ?? 0;
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    return resolveAndRun(args);
  } catch (e) {
    const reason = e instanceof FailOpen ? e.message : `unexpected error: ${e.message}`;
    process.stderr.write(
      `TMB resolve-hook: ${reason} \u2014 failing OPEN (gate skipped) for marketplace=${args.marketplace || "?"} hook=${args.hook || "?"}
`
    );
    return 0;
  }
}
process.exitCode = main();
//# sourceMappingURL=resolve-hook.mjs.map
