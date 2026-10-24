/**
 * Prints the registered gate names, sorted, one per line: the build pipes this
 * into dist/hooks-gates.txt, the manifest dispatch.sh reads.
 */
import { gateNames } from './registry.js';

process.stdout.write(gateNames().map((name) => `${name}\n`).join(''));
