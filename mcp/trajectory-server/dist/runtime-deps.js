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
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export function runtimeDepsKey(platform = process.platform, arch = process.arch, version = TRANSFORMERS_VERSION) {
    return `${version}-${platform}-${arch}`;
}
export function runtimeDepsRoot(dataDir = process.env.CLAUDE_PLUGIN_DATA, key = runtimeDepsKey()) {
    return dataDir ? join(dataDir, 'deps', key) : undefined;
}
function isObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function readPackageJson(pkgDir) {
    try {
        const parsed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
        return isObject(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * The exact transformers version the runtime-deps manifest in `manifestDir`
 * pins, or undefined when the manifest can't be read or the pin is not one
 * exact version.
 */
export function pinnedTransformersVersion(manifestDir) {
    const deps = readPackageJson(manifestDir)?.['dependencies'];
    const pin = isObject(deps) ? deps[TRANSFORMERS_PACKAGE] : undefined;
    return typeof pin === 'string' && EXACT_VERSION.test(pin) ? pin : undefined;
}
/** The `"."` entry of an exports map; a map with no subpath keys is that entry itself. */
function rootExport(exportsField) {
    if (!isObject(exportsField))
        return exportsField;
    const subpaths = Object.keys(exportsField).some((k) => k.startsWith('.'));
    return subpaths ? exportsField['.'] : exportsField;
}
function nodeImportDefault(entry) {
    if (!isObject(entry))
        return undefined;
    const node = entry['node'];
    if (!isObject(node))
        return undefined;
    const imp = node['import'];
    if (typeof imp === 'string')
        return imp;
    if (!isObject(imp))
        return undefined;
    const target = imp['default'];
    return typeof target === 'string' ? target : undefined;
}
export function transformersPackageDir(root) {
    return join(root, 'node_modules', TRANSFORMERS_PACKAGE);
}
/** The `version` of the transformers package installed under `root`, or undefined. */
export function transformersVersion(root) {
    const version = readPackageJson(transformersPackageDir(root))?.['version'];
    return typeof version === 'string' ? version : undefined;
}
/**
 * Absolute path of the transformers ESM entry under `root` — the package's
 * `exports["."].node.import.default` — or undefined when the package, the
 * field or the file is missing.
 */
export function transformersEsmEntry(root) {
    const pkgDir = transformersPackageDir(root);
    const target = nodeImportDefault(rootExport(readPackageJson(pkgDir)?.['exports']));
    if (!target)
        return undefined;
    const entry = resolve(pkgDir, target);
    return existsSync(entry) ? entry : undefined;
}
//# sourceMappingURL=runtime-deps.js.map