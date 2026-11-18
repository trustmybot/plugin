/**
 * Prints the registered gate names, sorted, one per line: the build pipes this
 * into dist/hooks-gates.txt, the gates `node dist/hooks.js <gate>` runs.
 */
import { gateNames } from './registry.js';
process.stdout.write(gateNames().map((name) => `${name}\n`).join(''));
//# sourceMappingURL=manifest.js.map