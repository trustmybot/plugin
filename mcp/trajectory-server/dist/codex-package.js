import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Resolve package identity from the installed module location, never from the
 * session cwd or host-provided environment variables.
 */
export function readCodexPackageMetadata(moduleUrl = import.meta.url) {
    let directory = dirname(fileURLToPath(moduleUrl));
    for (let depth = 0; depth < 6; depth += 1) {
        const manifestPath = join(directory, '.codex-plugin', 'plugin.json');
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            if (typeof manifest.name !== 'string' ||
                manifest.name.trim().length === 0 ||
                typeof manifest.version !== 'string' ||
                manifest.version.trim().length === 0) {
                throw new Error('manifest name and version must be non-empty strings');
            }
            return Object.freeze({
                root: realpathSync(directory),
                name: manifest.name,
                version: manifest.version,
            });
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error(`Invalid Codex plugin manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const parent = dirname(directory);
        if (parent === directory)
            break;
        directory = parent;
    }
    throw new Error('Unable to locate .codex-plugin/plugin.json from the installed module');
}
//# sourceMappingURL=codex-package.js.map