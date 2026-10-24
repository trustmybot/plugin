/**
 * Where the MCP server's external runtime dependency, @huggingface/transformers,
 * is installed once per data dir (GH 1695): `$CLAUDE_PLUGIN_DATA/deps/<key>/`,
 * keyed on the pinned version, platform and arch. esbuild inlines this module
 * into each bundle that imports it; it is never shipped as its own file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const TRANSFORMERS_VERSION = '3.8.1';
export const TRANSFORMERS_PACKAGE = '@huggingface/transformers';

export function runtimeDepsKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${TRANSFORMERS_VERSION}-${platform}-${arch}`;
}

export function runtimeDepsRoot(
  dataDir: string | undefined = process.env.CLAUDE_PLUGIN_DATA,
  key: string = runtimeDepsKey(),
): string | undefined {
  return dataDir ? join(dataDir, 'deps', key) : undefined;
}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readPackageJson(pkgDir: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The `"."` entry of an exports map; a map with no subpath keys is that entry itself. */
function rootExport(exportsField: unknown): unknown {
  if (!isObject(exportsField)) return exportsField;
  const subpaths = Object.keys(exportsField).some((k) => k.startsWith('.'));
  return subpaths ? exportsField['.'] : exportsField;
}

function nodeImportDefault(entry: unknown): string | undefined {
  if (!isObject(entry)) return undefined;
  const node = entry['node'];
  if (!isObject(node)) return undefined;
  const imp = node['import'];
  if (typeof imp === 'string') return imp;
  if (!isObject(imp)) return undefined;
  const target = imp['default'];
  return typeof target === 'string' ? target : undefined;
}

export function transformersPackageDir(root: string): string {
  return join(root, 'node_modules', TRANSFORMERS_PACKAGE);
}

/** The `version` of the transformers package installed under `root`, or undefined. */
export function transformersVersion(root: string): string | undefined {
  const version = readPackageJson(transformersPackageDir(root))?.['version'];
  return typeof version === 'string' ? version : undefined;
}

/**
 * Absolute path of the transformers ESM entry under `root` — the package's
 * `exports["."].node.import.default` — or undefined when the package, the
 * field or the file is missing.
 */
export function transformersEsmEntry(root: string): string | undefined {
  const pkgDir = transformersPackageDir(root);
  const target = nodeImportDefault(rootExport(readPackageJson(pkgDir)?.['exports']));
  if (!target) return undefined;
  const entry = resolve(pkgDir, target);
  return existsSync(entry) ? entry : undefined;
}
